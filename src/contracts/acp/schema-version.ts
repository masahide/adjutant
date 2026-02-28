import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const ACP_SCHEMA_VERSION = 1 as const;

export const ACP_VENDOR_SCHEMA_PATH = join(
  REPO_ROOT,
  "vendor/agent-client-protocol/schema/schema.json"
);
export const ACP_VENDOR_SCHEMA_META_PATH = join(
  REPO_ROOT,
  "vendor/agent-client-protocol/schema/meta.json"
);
export const ACP_VENDOR_UNSTABLE_SCHEMA_PATH = join(
  REPO_ROOT,
  "vendor/agent-client-protocol/schema/schema.unstable.json"
);
export const ACP_VENDOR_UNSTABLE_SCHEMA_META_PATH = join(
  REPO_ROOT,
  "vendor/agent-client-protocol/schema/meta.unstable.json"
);

export interface AcpSchemaMeta {
  version: number;
  agentMethods: Record<string, string>;
  clientMethods: Record<string, string>;
  protocolMethods?: Record<string, string>;
}

export async function loadAcpSchemaMeta(unstable = false): Promise<AcpSchemaMeta> {
  const raw = await readFile(
    unstable ? ACP_VENDOR_UNSTABLE_SCHEMA_META_PATH : ACP_VENDOR_SCHEMA_META_PATH,
    "utf8"
  );
  return JSON.parse(raw) as AcpSchemaMeta;
}
