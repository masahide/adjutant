import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseMigrationAuditMarkdown,
  validateMigrationAuditRecords,
} from "../../../src/runtime/migration-audit.js";

test("migration audit validator rejects record with missing evidence", () => {
  const records = parseMigrationAuditMarkdown(`
| legacyPath | acpPath | phase | status | evidence.spec | evidence.tests | evidence.files | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy/a.ts | src/a.ts | A/B | done | doc/spec.md#14.5 | - | src/a.ts | sample |
`);

  const violations = validateMigrationAuditRecords(records);
  assert.equal(violations.length > 0, true);
  assert.equal(
    violations.some((v) => v.field === "evidence.tests" && v.reason === "missing_evidence"),
    true
  );
});

test("phase-f migration audit artifact keeps evidence and status contract", async () => {
  const artifactPath = resolve(
    process.cwd(),
    "doc/plan/artifacts/260305-s03-phase-f-migration-audit.md"
  );
  const raw = await readFile(artifactPath, "utf8");
  const records = parseMigrationAuditMarkdown(raw);

  assert.equal(records.length > 0, true);
  const violations = validateMigrationAuditRecords(records);
  assert.deepEqual(violations, []);
});
