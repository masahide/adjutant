import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const ACP_SCHEMA_VERSION = 1 as const;

export const ACP_SCHEMA_DIR = join(REPO_ROOT, "third_party", "acp-schema");
export const ACP_SCHEMA_PATH = join(ACP_SCHEMA_DIR, "schema.json");
export const ACP_SCHEMA_META_PATH = join(ACP_SCHEMA_DIR, "meta.json");
export const ACP_UNSTABLE_SCHEMA_PATH = join(ACP_SCHEMA_DIR, "schema.unstable.json");
export const ACP_UNSTABLE_SCHEMA_META_PATH = join(ACP_SCHEMA_DIR, "meta.unstable.json");

export interface AcpSchemaMeta {
  version: number;
  agentMethods: Record<string, string>;
  clientMethods: Record<string, string>;
  protocolMethods?: Record<string, string>;
}

export async function loadAcpSchemaMeta(unstable = false): Promise<AcpSchemaMeta> {
  const raw = await readFile(
    unstable ? ACP_UNSTABLE_SCHEMA_META_PATH : ACP_SCHEMA_META_PATH,
    "utf8"
  );
  return JSON.parse(raw) as AcpSchemaMeta;
}
