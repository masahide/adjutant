import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_DIR = join(REPO_ROOT, "third_party", "acp-schema");
const DEFAULT_REPO = "agentclientprotocol/agent-client-protocol";
const DEFAULT_REF = "main";

const SCHEMA_FILES = [
  "schema.json",
  "meta.json",
  "schema.unstable.json",
  "meta.unstable.json",
] as const;

type CliOptions = {
  repo: string;
  ref: string;
};

type SchemaManifest = {
  repo: string;
  ref: string;
  fetchedAt: string;
  files: string[];
};

function parseArgs(argv: string[]): CliOptions {
  let repo = DEFAULT_REPO;
  let ref = DEFAULT_REF;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      repo = argv[index + 1] ?? repo;
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      ref = argv[index + 1] ?? ref;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
  }

  return { repo, ref };
}

function printHelpAndExit(): never {
  console.log(
    [
      "Usage: pnpm run acp-schema:update -- [--repo owner/name] [--ref ref]",
      "",
      `Defaults: --repo ${DEFAULT_REPO} --ref ${DEFAULT_REF}`,
    ].join("\n")
  );
  process.exit(0);
}

function buildRawUrl(repo: string, ref: string, fileName: string): string {
  return `https://raw.githubusercontent.com/${repo}/${ref}/schema/${fileName}`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "adjutant-acp-schema-updater",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const fileName of SCHEMA_FILES) {
    const url = buildRawUrl(options.repo, options.ref, fileName);
    const content = await fetchText(url);
    const outputPath = join(OUTPUT_DIR, fileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
    console.log(`updated ${outputPath}`);
  }

  const manifest: SchemaManifest = {
    repo: options.repo,
    ref: options.ref,
    fetchedAt: new Date().toISOString(),
    files: [...SCHEMA_FILES],
  };
  await writeFile(join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${join(OUTPUT_DIR, "manifest.json")}`);
}

await main();
