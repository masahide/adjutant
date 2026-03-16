import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACP_SCHEMA_VERSION,
  ACP_SCHEMA_META_PATH,
  ACP_SCHEMA_PATH,
  ACP_UNSTABLE_SCHEMA_PATH,
  loadAcpSchemaMeta,
} from "../../../src/contracts/acp/schema-version.js";

test("ACP schema metadata is pinned and loadable", async () => {
  await access(ACP_SCHEMA_PATH);
  await access(ACP_UNSTABLE_SCHEMA_PATH);
  await access(ACP_SCHEMA_META_PATH);

  const stableMeta = await loadAcpSchemaMeta();
  const unstableMeta = await loadAcpSchemaMeta(true);

  assert.equal(stableMeta.version, ACP_SCHEMA_VERSION);
  assert.equal(unstableMeta.version, ACP_SCHEMA_VERSION);
  assert.equal(stableMeta.agentMethods.session_new, "session/new");
  assert.equal(stableMeta.clientMethods.session_update, "session/update");
});

test("ACP stable schema JSON is present and parsable", async () => {
  const raw = await readFile(ACP_SCHEMA_PATH, "utf8");
  const schema = JSON.parse(raw) as Record<string, unknown>;

  assert.equal(typeof schema.$schema, "string");
  assert.equal(typeof schema.$defs, "object");
  assert.equal(Array.isArray(schema.anyOf), true);
});
