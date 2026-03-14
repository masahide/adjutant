import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProjectEnv, parseDotenv } from "../../../src/runtime/load-project-env.js";

test("parseDotenv は export と quoted value を解釈する", () => {
  const parsed = parseDotenv(`
# comment
export FOO="bar"
BAZ='qux'
RAW=value
INVALID
`);

  assert.deepEqual(parsed, {
    FOO: "bar",
    BAZ: "qux",
    RAW: "value",
  });
});

test(".env.local は .env を上書きし、既存 env は保持する", () => {
  const root = mkdtempSync(join(tmpdir(), "adjutant-env-"));
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "adjutant-env-test", private: true }),
    "utf8"
  );
  writeFileSync(
    join(root, ".env"),
    ["FROM_ENV=base", "LOCAL_ONLY=from-env", "KEEP_ME=env-file"].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, ".env.local"),
    ["FROM_ENV=local", "LOCAL_ONLY=from-local"].join("\n"),
    "utf8"
  );

  const env: NodeJS.ProcessEnv = {
    KEEP_ME: "preserved",
  };
  loadProjectEnv({
    cwd: join(root, "nested"),
    env,
  });

  assert.equal(env.FROM_ENV, "local");
  assert.equal(env.LOCAL_ONLY, "from-local");
  assert.equal(env.KEEP_ME, "preserved");
});
