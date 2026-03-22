import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PersistedGuardrailPolicy } from "./types.js";

interface GuardrailPolicyFile {
  version: 1;
  policies: PersistedGuardrailPolicy[];
}

export interface GuardrailPolicyStoreOptions {
  filePath: string;
  now?: () => string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPolicy(value: unknown): value is PersistedGuardrailPolicy {
  if (!isRecord(value) || !isRecord(value.match)) {
    return false;
  }
  return (
    typeof value.policyId === "string" &&
    (value.scope === "session" || value.scope === "workspace" || value.scope === "global") &&
    (value.scope === "global" || typeof value.scopeKey === "string") &&
    (value.effect === "allow" || value.effect === "deny") &&
    typeof value.createdAt === "string" &&
    value.createdBy === "user"
  );
}

function normalizePolicies(raw: unknown): PersistedGuardrailPolicy[] {
  if (!isRecord(raw) || !Array.isArray(raw.policies)) {
    return [];
  }
  return raw.policies.filter((policy) => isValidPolicy(policy));
}

function buildFingerprint(
  policy: Pick<PersistedGuardrailPolicy, "match" | "effect" | "scope" | "scopeKey">
): string {
  return JSON.stringify({
    scope: policy.scope,
    scopeKey: policy.scopeKey,
    effect: policy.effect,
    match: policy.match,
  });
}

export class GuardrailPolicyStore {
  private readonly now: () => string;
  private readonly onWarn?: GuardrailPolicyStoreOptions["onWarn"];
  private writeQueue = Promise.resolve();

  constructor(private readonly options: GuardrailPolicyStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarn = options.onWarn;
  }

  static fromStateDir(
    stateDir: string,
    options: Omit<GuardrailPolicyStoreOptions, "filePath"> = {}
  ): GuardrailPolicyStore {
    return new GuardrailPolicyStore({
      ...options,
      filePath: join(stateDir, "guardrails", "policies.json"),
    });
  }

  async listPolicies(): Promise<PersistedGuardrailPolicy[]> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      return normalizePolicies(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      this.onWarn?.("failed to load guardrail policy store", {
        code,
        filePath: this.options.filePath,
      });
      return [];
    }
  }

  async persistPolicy(
    input: Omit<PersistedGuardrailPolicy, "policyId" | "createdAt" | "createdBy">
  ): Promise<PersistedGuardrailPolicy> {
    if (input.scope !== "global" && typeof input.scopeKey !== "string") {
      throw new Error("GUARDRAIL_POLICY_SCOPE_KEY_REQUIRED");
    }

    return await this.enqueueWrite(async () => {
      const current = await this.listPolicies();
      const fingerprint = buildFingerprint(input);
      const existing = current.find((policy) => buildFingerprint(policy) === fingerprint);
      if (existing !== undefined) {
        return existing;
      }

      const policy: PersistedGuardrailPolicy = {
        policyId: `policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: this.now(),
        createdBy: "user",
        ...input,
      };
      const payload: GuardrailPolicyFile = {
        version: 1,
        policies: [...current, policy],
      };
      await this.writePayload(payload);
      return policy;
    });
  }

  private async writePayload(payload: GuardrailPolicyFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const tempPath = `${this.options.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tempPath, this.options.filePath);
  }

  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const chained = this.writeQueue.then(task, task);
    this.writeQueue = chained.then(
      () => undefined,
      () => undefined
    );
    return await chained;
  }
}
