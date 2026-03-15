import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const DOC_KEY_PATTERN =
  /\b(?:ADJUTANT_[A-Z0-9_]+|CDP_[A-Z0-9_]+|DATA_DIR|OPENAI_API_KEY|ACP_ENABLE_LOAD_SESSION|ACP_WORKER_[A-Z0-9_]+)\b/g;
const SOURCE_ENV_PATTERN = /(?:process\.env|env)\.([A-Z0-9_]+)/g;

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "vendor", "legacy"]);

export type LiteralKind = "string" | "number" | "boolean";

export type LiteralValue = {
  kind: LiteralKind;
  value: string;
};

export type SourceEnvEntry = {
  key: string;
  refs: string[];
  defaults: LiteralValue[];
};

export type DocDefaultEntry = {
  docPath: string;
  rawDefault: string;
  literalDefault?: LiteralValue;
};

export type DocCatalog = {
  mentionedKeys: Set<string>;
  defaultsByKey: Map<string, DocDefaultEntry[]>;
};

export type DocSyncViolationReason = "missing_doc" | "default_mismatch" | "unknown_doc_key";

export type DocSyncViolation = {
  key: string;
  reason: DocSyncViolationReason;
  expected?: string;
  actual?: string;
  refs: string[];
};

export type DocSyncPolicy = {
  ignoredSourceKeyPrefixes?: string[];
  ignoredSourceKeys?: string[];
  checkUnknownDocKeys?: boolean;
};

export type VerifyConfigDocSyncOptions = {
  sourceFiles: Array<{ path: string; text: string }>;
  docFiles: Array<{ path: string; text: string }>;
  policy?: DocSyncPolicy;
};

export type VerifyConfigDocSyncWorkspaceOptions = {
  rootDir?: string;
  sourceRoots?: string[];
  docPaths?: string[];
  policy?: DocSyncPolicy;
};

export type VerifyConfigDocSyncResult = {
  sourceEntries: SourceEnvEntry[];
  docCatalog: DocCatalog;
  violations: DocSyncViolation[];
};

export const DOC_SYNC_ERROR_CODE = "DOC_SYNC_MISMATCH";

const DEFAULT_POLICY: Required<DocSyncPolicy> = {
  ignoredSourceKeyPrefixes: ["ADJUTANT_TEST_", "ACP_WORKER_"],
  ignoredSourceKeys: [
    "ACP_ENABLE_LOAD_SESSION",
    "ADJUTANT_SANDBOX_CONTAINER_PREFIX",
    "ADJUTANT_SLACK_SELF_USER_ID",
    "ADJUTANT_SUMMARY_BATCH_WATERMARK_PATH",
    "ADJUTANT_UI_VITE_MIDDLEWARE",
  ],
  checkUnknownDocKeys: false,
};

export async function verifyConfigDocSyncInWorkspace(
  options: VerifyConfigDocSyncWorkspaceOptions = {}
): Promise<VerifyConfigDocSyncResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const sourceRoots = options.sourceRoots ?? ["src", "scripts"];
  const docPaths = options.docPaths ?? [
    "README.md",
    "doc/spec/configuration.md",
    "doc/file-paths.md",
  ];

  const sourceFiles = await loadSourceFiles(rootDir, sourceRoots);
  const docFiles = await loadDocFiles(rootDir, docPaths);

  return verifyConfigDocSync({
    sourceFiles,
    docFiles,
    policy: options.policy,
  });
}

export function verifyConfigDocSync(
  options: VerifyConfigDocSyncOptions
): VerifyConfigDocSyncResult {
  const policy = resolvePolicy(options.policy);
  const sourceEntries = collectSourceEnvEntries(options.sourceFiles, policy);
  const docCatalog = collectDocCatalog(options.docFiles);

  const violations: DocSyncViolation[] = [];
  const sourceKeySet = new Set(sourceEntries.map((entry) => entry.key));

  for (const entry of sourceEntries) {
    if (!docCatalog.mentionedKeys.has(entry.key)) {
      violations.push({
        key: entry.key,
        reason: "missing_doc",
        refs: entry.refs,
      });
      continue;
    }

    const docDefaults = docCatalog.defaultsByKey.get(entry.key) ?? [];
    const mismatch = findDefaultMismatch(entry, docDefaults);
    if (mismatch !== undefined) {
      violations.push({
        key: entry.key,
        reason: "default_mismatch",
        expected: mismatch.expected,
        actual: mismatch.actual,
        refs: mismatch.refs,
      });
    }
  }

  if (policy.checkUnknownDocKeys) {
    for (const key of docCatalog.mentionedKeys) {
      if (sourceKeySet.has(key)) {
        continue;
      }
      if (isIgnoredSourceKey(key, policy)) {
        continue;
      }
      const refs = (docCatalog.defaultsByKey.get(key) ?? []).map((entry) => entry.docPath);
      violations.push({
        key,
        reason: "unknown_doc_key",
        refs: refs.length > 0 ? refs : ["doc:mentioned"],
      });
    }
  }

  violations.sort((a, b) => {
    if (a.reason !== b.reason) {
      return a.reason.localeCompare(b.reason);
    }
    return a.key.localeCompare(b.key);
  });

  return {
    sourceEntries,
    docCatalog,
    violations,
  };
}

export function formatDocSyncViolations(violations: DocSyncViolation[]): string {
  return JSON.stringify(violations, null, 2);
}

function resolvePolicy(policy?: DocSyncPolicy): Required<DocSyncPolicy> {
  return {
    ignoredSourceKeyPrefixes:
      policy?.ignoredSourceKeyPrefixes ?? DEFAULT_POLICY.ignoredSourceKeyPrefixes,
    ignoredSourceKeys: policy?.ignoredSourceKeys ?? DEFAULT_POLICY.ignoredSourceKeys,
    checkUnknownDocKeys: policy?.checkUnknownDocKeys ?? DEFAULT_POLICY.checkUnknownDocKeys,
  };
}

function isIgnoredSourceKey(key: string, policy: Required<DocSyncPolicy>): boolean {
  if (policy.ignoredSourceKeys.includes(key)) {
    return true;
  }
  return policy.ignoredSourceKeyPrefixes.some((prefix) => key.startsWith(prefix));
}

function collectSourceEnvEntries(
  files: Array<{ path: string; text: string }>,
  policy: Required<DocSyncPolicy>
): SourceEnvEntry[] {
  const byKey = new Map<string, { refs: Set<string>; defaults: Map<string, LiteralValue> }>();

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      SOURCE_ENV_PATTERN.lastIndex = 0;
      let match = SOURCE_ENV_PATTERN.exec(line);
      while (match !== null) {
        const key = match[1];
        if (key === undefined || isIgnoredSourceKey(key, policy)) {
          match = SOURCE_ENV_PATTERN.exec(line);
          continue;
        }
        const entry = byKey.get(key) ?? {
          refs: new Set<string>(),
          defaults: new Map<string, LiteralValue>(),
        };
        entry.refs.add(`${file.path}:${index + 1}`);

        const literalDefault = findLiteralDefaultInLine(line, key);
        if (literalDefault !== undefined) {
          entry.defaults.set(`${literalDefault.kind}:${literalDefault.value}`, literalDefault);
        }

        byKey.set(key, entry);
        match = SOURCE_ENV_PATTERN.exec(line);
      }
    }
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      refs: [...value.refs].sort(),
      defaults: [...value.defaults.values()],
    }));
}

function findLiteralDefaultInLine(line: string, key: string): LiteralValue | undefined {
  const keyRef = `.${key}`;
  const keyIndex = line.indexOf(keyRef);
  if (keyIndex === -1) {
    return undefined;
  }
  const tail = line.slice(keyIndex);

  let match = tail.match(/\?\?\s*([^,;]+)/);
  if (match?.[1] !== undefined) {
    const parsed = parseLiteral(match[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  match = tail.match(/\|\|\s*([^,;]+)/);
  if (match?.[1] !== undefined) {
    const parsed = parseLiteral(match[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  match = line.match(/parse(?:Boolean|PositiveInt|Integer|Number|Port|String)\([^,]+,\s*([^,\)]+)/);
  if (match?.[1] !== undefined) {
    const parsed = parseLiteral(match[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function collectDocCatalog(files: Array<{ path: string; text: string }>): DocCatalog {
  const mentionedKeys = new Set<string>();
  const defaultsByKey = new Map<string, DocDefaultEntry[]>();

  for (const file of files) {
    DOC_KEY_PATTERN.lastIndex = 0;
    let keyMatch = DOC_KEY_PATTERN.exec(file.text);
    while (keyMatch !== null) {
      const key = keyMatch[0];
      if (key !== undefined) {
        mentionedKeys.add(key);
      }
      keyMatch = DOC_KEY_PATTERN.exec(file.text);
    }

    const lines = file.text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim().startsWith("|")) {
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length < 2) {
        continue;
      }
      const keyInCell = cells[0]?.match(/`([A-Z0-9_]+)`/);
      if (keyInCell?.[1] === undefined) {
        continue;
      }
      const key = keyInCell[1];
      const rawDefault = cells[1] ?? "";
      const literalDefault = parseDocDefaultLiteral(rawDefault);
      const rows = defaultsByKey.get(key) ?? [];
      rows.push({
        docPath: file.path,
        rawDefault,
        literalDefault,
      });
      defaultsByKey.set(key, rows);
      mentionedKeys.add(key);
    }
  }

  return {
    mentionedKeys,
    defaultsByKey,
  };
}

function findDefaultMismatch(
  sourceEntry: SourceEnvEntry,
  docDefaults: DocDefaultEntry[]
): { expected: string; actual: string; refs: string[] } | undefined {
  if (sourceEntry.defaults.length !== 1) {
    return undefined;
  }
  const expected = sourceEntry.defaults[0];
  if (expected === undefined) {
    return undefined;
  }

  const comparableDocDefaults = docDefaults
    .map((entry) => ({
      entry,
      literal: entry.literalDefault,
    }))
    .filter((entry) => entry.literal !== undefined);

  if (comparableDocDefaults.length === 0) {
    return undefined;
  }

  const matched = comparableDocDefaults.some((docDefault) => {
    const literal = docDefault.literal;
    if (literal === undefined) {
      return false;
    }
    return isLiteralEquivalent(expected, literal);
  });

  if (matched) {
    return undefined;
  }

  return {
    expected: `${expected.kind}:${expected.value}`,
    actual: comparableDocDefaults
      .map((docDefault) => {
        const literal = docDefault.literal;
        if (literal === undefined) {
          return `${docDefault.entry.docPath}:${docDefault.entry.rawDefault}`;
        }
        return `${docDefault.entry.docPath}:${literal.kind}:${literal.value}`;
      })
      .join(", "),
    refs: sourceEntry.refs,
  };
}

function isLiteralEquivalent(source: LiteralValue, doc: LiteralValue): boolean {
  if (source.kind === doc.kind) {
    return source.value === doc.value;
  }
  if (source.kind === "boolean" && doc.kind === "number") {
    if (doc.value === "0") {
      return source.value === "false";
    }
    if (doc.value === "1") {
      return source.value === "true";
    }
  }
  return false;
}

function parseDocDefaultLiteral(raw: string): LiteralValue | undefined {
  const trimmed = raw.replaceAll("`", "").trim();
  if (trimmed.length === 0 || trimmed === "-") {
    return undefined;
  }
  if (trimmed.includes("未設定") || trimmed.includes("組み込み既定文") || trimmed.includes("<")) {
    return undefined;
  }
  return parseLiteral(trimmed);
}

function parseLiteral(raw: string): LiteralValue | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const quoted = trimmed.match(/^"([\s\S]*)"$/) ?? trimmed.match(/^'([\s\S]*)'$/);
  if (quoted?.[1] !== undefined) {
    return {
      kind: "string",
      value: quoted[1],
    };
  }

  const normalizedLower = trimmed.toLowerCase();
  if (normalizedLower === "true" || normalizedLower === "false") {
    return {
      kind: "boolean",
      value: normalizedLower,
    };
  }

  if (/^[0-9][0-9_]*$/.test(trimmed)) {
    return {
      kind: "number",
      value: trimmed.replaceAll("_", ""),
    };
  }

  if (/^[A-Z0-9_]+$/.test(trimmed)) {
    return undefined;
  }

  if (/^[a-z][a-z0-9_\-\/.:]*$/i.test(trimmed)) {
    return {
      kind: "string",
      value: trimmed,
    };
  }

  return undefined;
}

async function loadSourceFiles(
  rootDir: string,
  sourceRoots: string[]
): Promise<Array<{ path: string; text: string }>> {
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    const absPath = resolve(rootDir, sourceRoot);
    const stats = await statOrUndefined(absPath);
    if (stats === undefined) {
      continue;
    }
    if (stats.isFile()) {
      if (isSourceFile(absPath)) {
        files.push(absPath);
      }
      continue;
    }
    const discovered = await walkFiles(absPath, isSourceFile);
    files.push(...discovered);
  }

  const loaded = await Promise.all(
    files.sort().map(async (filePath) => ({
      path: relative(rootDir, filePath),
      text: await readFile(filePath, "utf8"),
    }))
  );
  return loaded;
}

async function loadDocFiles(
  rootDir: string,
  docPaths: string[]
): Promise<Array<{ path: string; text: string }>> {
  const loaded: Array<{ path: string; text: string }> = [];
  for (const docPath of docPaths) {
    const absPath = resolve(rootDir, docPath);
    const stats = await statOrUndefined(absPath);
    if (stats === undefined || !stats.isFile()) {
      continue;
    }
    loaded.push({
      path: relative(rootDir, absPath),
      text: await readFile(absPath, "utf8"),
    });
  }
  return loaded;
}

function isSourceFile(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx");
}

async function walkFiles(
  dirPath: string,
  matcher: (filePath: string) => boolean
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      found.push(...(await walkFiles(absPath, matcher)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (matcher(absPath)) {
      found.push(absPath);
    }
  }
  return found;
}

async function statOrUndefined(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}
