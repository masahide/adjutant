import assert from "node:assert/strict";
import test from "node:test";

import { resolveSandboxConfig } from "../../../src/sandbox/config.js";

test("resolveSandboxConfig defaults sandbox mode to all", () => {
  const config = resolveSandboxConfig({});
  assert.equal(config.mode, "all");
});

test("resolveSandboxConfig falls back to all for invalid sandbox mode", () => {
  const config = resolveSandboxConfig({
    ADJUTANT_SANDBOX_MODE: "invalid",
  } as NodeJS.ProcessEnv);
  assert.equal(config.mode, "all");
});

