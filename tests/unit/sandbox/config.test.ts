import assert from "node:assert/strict";
import test from "node:test";

import { resolveSandboxConfig } from "../../../src/sandbox/config.js";

test("resolveSandboxConfig falls back to 1000:1000 when host uid/gid APIs are unavailable", () => {
  const originalGetuid = process.getuid;
  const originalGetgid = process.getgid;

  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(process, "getgid", {
    configurable: true,
    value: undefined,
  });

  try {
    const config = resolveSandboxConfig({});
    assert.equal(config.docker.user, "1000:1000");
  } finally {
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: originalGetuid,
    });
    Object.defineProperty(process, "getgid", {
      configurable: true,
      value: originalGetgid,
    });
  }
});

test("resolveSandboxConfig defaults sandbox mode to all", () => {
  const config = resolveSandboxConfig({});
  assert.equal(config.mode, "all");
  assert.equal(config.docker.home, "/home/agent");
  assert.match(config.docker.user, /^\d+:\d+$/);
  assert.equal(config.docker.network, "none");
});

test("resolveSandboxConfig falls back to off for invalid sandbox mode", () => {
  const config = resolveSandboxConfig({
    ADJUTANT_SANDBOX_MODE: "invalid",
  } as NodeJS.ProcessEnv);
  assert.equal(config.mode, "off");
});

test("resolveSandboxConfig reflects sandbox home and user overrides", () => {
  const config = resolveSandboxConfig({
    ADJUTANT_SANDBOX_HOME: "/home/custom-agent",
    ADJUTANT_SANDBOX_USER: "2001:3001",
  } as NodeJS.ProcessEnv);

  assert.equal(config.docker.home, "/home/custom-agent");
  assert.equal(config.docker.user, "2001:3001");
  assert.equal(
    config.docker.tmpfs.includes(
      "/home/custom-agent:rw,exec,nosuid,size=512m,uid=2001,gid=3001,mode=700"
    ),
    true
  );
});

test("resolveSandboxConfig rejects relative sandbox home", () => {
  assert.throws(
    () =>
      resolveSandboxConfig({
        ADJUTANT_SANDBOX_HOME: "relative/home",
      } as NodeJS.ProcessEnv),
    /sandbox home must be absolute/
  );
});

test("resolveSandboxConfig rejects invalid sandbox user", () => {
  assert.throws(
    () =>
      resolveSandboxConfig({
        ADJUTANT_SANDBOX_USER: "agent",
      } as NodeJS.ProcessEnv),
    /invalid sandbox user/
  );
});
