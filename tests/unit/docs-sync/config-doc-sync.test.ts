import assert from "node:assert/strict";
import test from "node:test";

import {
  DOC_SYNC_ERROR_CODE,
  formatDocSyncViolations,
  verifyConfigDocSync,
} from "../../../src/runtime/config-doc-sync.js";

test("verifyConfigDocSync detects missing_doc violation", () => {
  const result = verifyConfigDocSync({
    sourceFiles: [
      {
        path: "src/example.ts",
        text: "const enabled = parseBoolean(process.env.ADJUTANT_PHASE_F_FLAG, true);\n",
      },
    ],
    docFiles: [
      {
        path: "README.md",
        text: "# docs\n",
      },
    ],
    policy: {
      ignoredSourceKeyPrefixes: [],
      ignoredSourceKeys: [],
      checkUnknownDocKeys: false,
    },
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.reason, "missing_doc");
  assert.equal(result.violations[0]?.key, "ADJUTANT_PHASE_F_FLAG");
});

test("verifyConfigDocSync detects default_mismatch violation", () => {
  const result = verifyConfigDocSync({
    sourceFiles: [
      {
        path: "src/example.ts",
        text: "const interval = parsePositiveInt(process.env.ADJUTANT_FLUSHER_INTERVAL_MS, 60000);\n",
      },
    ],
    docFiles: [
      {
        path: "README.md",
        text: "| 変数 | 既定値 | 用途 |\n| --- | --- | --- |\n| `ADJUTANT_FLUSHER_INTERVAL_MS` | `300000` | flusher interval |\n",
      },
    ],
    policy: {
      ignoredSourceKeyPrefixes: [],
      ignoredSourceKeys: [],
      checkUnknownDocKeys: false,
    },
  });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.reason, "default_mismatch");
  assert.equal(result.violations[0]?.expected, "number:60000");
});

test("verifyConfigDocSync passes when docs mention key and default matches", () => {
  const result = verifyConfigDocSync({
    sourceFiles: [
      {
        path: "src/example.ts",
        text: "const enabled = parseBoolean(process.env.ADJUTANT_HEARTBEAT_ENABLED, true);\n",
      },
    ],
    docFiles: [
      {
        path: "README.md",
        text: "| 変数 | 既定値 | 用途 |\n| --- | --- | --- |\n| `ADJUTANT_HEARTBEAT_ENABLED` | `1` | heartbeat |\n",
      },
    ],
    policy: {
      ignoredSourceKeyPrefixes: [],
      ignoredSourceKeys: [],
      checkUnknownDocKeys: false,
    },
  });

  assert.equal(result.violations.length, 0);
});

test("formatDocSyncViolations outputs JSON contract", () => {
  const payload = formatDocSyncViolations([
    {
      key: "ADJUTANT_SAMPLE",
      reason: "missing_doc",
      refs: ["src/sample.ts:1"],
    },
  ]);

  const parsed = JSON.parse(payload) as Array<{ key: string; reason: string; refs: string[] }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.key, "ADJUTANT_SAMPLE");
  assert.equal(parsed[0]?.reason, "missing_doc");
  assert.deepEqual(parsed[0]?.refs, ["src/sample.ts:1"]);
  assert.equal(DOC_SYNC_ERROR_CODE, "DOC_SYNC_MISMATCH");
});
