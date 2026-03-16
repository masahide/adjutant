import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("qa workflow keeps required qa job and gated live-agent job", async () => {
  const raw = await readFile(resolve(process.cwd(), ".github/workflows/qa.yml"), "utf8");

  assert.match(raw, /\n  qa:\n/);
  assert.match(raw, /\n  live-agent-gate:\n/);
  assert.match(raw, /\n  live-agent:\n/);
  assert.match(raw, /\n  live-agent-gate:\n[\s\S]*\n    needs: qa\n/);
  assert.match(raw, /\n  live-agent:\n[\s\S]*\n    needs:\n      - qa\n      - live-agent-gate\n/);
  assert.match(raw, /\n    if: \$\{\{ needs\.live-agent-gate\.outputs\.enabled == 'true' \}\}\n/);
});

test("qa workflow runs qa alias and config-doc sync verification in qa job", async () => {
  const raw = await readFile(resolve(process.cwd(), ".github/workflows/qa.yml"), "utf8");

  assert.match(raw, /run: pnpm run qa/);
  assert.match(raw, /run: pnpm run verify:config-doc-sync/);
});
