import {
  DOC_SYNC_ERROR_CODE,
  formatDocSyncViolations,
  verifyConfigDocSyncInWorkspace,
} from "../src/runtime/config-doc-sync.js";

const result = await verifyConfigDocSyncInWorkspace();

if (result.violations.length > 0) {
  process.stderr.write(`${DOC_SYNC_ERROR_CODE}: found ${result.violations.length} violation(s)\n`);
  process.stderr.write(`${formatDocSyncViolations(result.violations)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`DOC_SYNC_OK: ${result.sourceEntries.length} source keys validated\n`);
}
