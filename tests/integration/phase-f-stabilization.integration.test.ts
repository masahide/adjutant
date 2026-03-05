import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { verifyConfigDocSyncInWorkspace } from "../../src/runtime/config-doc-sync.js";
import {
  parseMigrationAuditMarkdown,
  validateMigrationAuditRecords,
} from "../../src/runtime/migration-audit.js";

test("Phase F integration: docs sync + CI gate + migration audit contracts stay aligned", async () => {
  const docSync = await verifyConfigDocSyncInWorkspace();
  assert.deepEqual(docSync.violations, []);

  const qaWorkflow = await readFile(resolve(process.cwd(), ".github/workflows/qa.yml"), "utf8");
  assert.match(qaWorkflow, /run: pnpm run check/);
  assert.match(qaWorkflow, /run: pnpm run verify:config-doc-sync/);
  assert.match(qaWorkflow, /\n  live-agent:\n[\s\S]*\n    needs: qa\n/);

  const auditMarkdown = await readFile(
    resolve(process.cwd(), "doc/plan/artifacts/260305-s03-phase-f-migration-audit.md"),
    "utf8"
  );
  const records = parseMigrationAuditMarkdown(auditMarkdown);
  const auditViolations = validateMigrationAuditRecords(records);

  assert.equal(records.length > 0, true);
  assert.deepEqual(auditViolations, []);
  assert.equal(
    records.some((record) => record.status === "done"),
    true
  );
  assert.equal(
    records.some((record) => record.status === "deferred"),
    true
  );
  assert.equal(
    records.some((record) => record.status === "non-scope"),
    true
  );
});
