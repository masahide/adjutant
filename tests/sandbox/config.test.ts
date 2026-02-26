import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSandboxConfig } from "../../src/sandbox/config.js";

describe("sandbox config", () => {
  it("未設定時は既定値を返す", () => {
    const config = resolveSandboxConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.mode, "off");
    assert.equal(config.docker.image, "adjutant-sandbox:trixie-slim");
    assert.equal(config.docker.autoBuildImage, true);
    assert.equal(config.docker.containerPrefix, "adjutant-sandbox");
    assert.equal(config.docker.workdir, "/workspace");
    assert.deepEqual(config.docker.envAllowlist, []);
    assert.equal(config.docker.readOnlyRoot, true);
    assert.deepEqual(config.docker.tmpfs, ["/tmp", "/var/tmp", "/run"]);
    assert.equal(config.docker.network, undefined);
    assert.deepEqual(config.docker.capDrop, ["ALL"]);
    assert.equal(config.docker.pidsLimit, 256);
    assert.equal(config.docker.memory, undefined);
  });

  it("環境変数オーバーライドを反映する", () => {
    const config = resolveSandboxConfig({
      ADJUTANT_SANDBOX_MODE: "all",
      ADJUTANT_SANDBOX_IMAGE: "sandbox:test",
      ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE: "false",
      ADJUTANT_SANDBOX_CONTAINER_PREFIX: "sbx",
      ADJUTANT_SANDBOX_WORKDIR: "/work",
      ADJUTANT_SANDBOX_ENV_ALLOWLIST: "OPENAI_API_KEY, AWS_REGION, OPENAI_API_KEY",
      ADJUTANT_SANDBOX_NETWORK: "none",
      ADJUTANT_SANDBOX_MEMORY: "1g",
      ADJUTANT_SANDBOX_PIDS_LIMIT: "512",
    } as NodeJS.ProcessEnv);
    assert.equal(config.mode, "all");
    assert.equal(config.docker.image, "sandbox:test");
    assert.equal(config.docker.autoBuildImage, false);
    assert.equal(config.docker.containerPrefix, "sbx");
    assert.equal(config.docker.workdir, "/work");
    assert.deepEqual(config.docker.envAllowlist, ["OPENAI_API_KEY", "AWS_REGION"]);
    assert.equal(config.docker.network, "none");
    assert.equal(config.docker.memory, "1g");
    assert.equal(config.docker.pidsLimit, 512);
  });

  it("mode は off/non-main/all 以外で off にフォールバックする", () => {
    const invalid = resolveSandboxConfig({
      ADJUTANT_SANDBOX_MODE: "unexpected",
    } as NodeJS.ProcessEnv);
    const nonMain = resolveSandboxConfig({
      ADJUTANT_SANDBOX_MODE: "non-main",
    } as NodeJS.ProcessEnv);
    assert.equal(invalid.mode, "off");
    assert.equal(nonMain.mode, "non-main");
  });

  it("空文字は既定値へフォールバックする", () => {
    const config = resolveSandboxConfig({
      ADJUTANT_SANDBOX_IMAGE: " ",
      ADJUTANT_SANDBOX_CONTAINER_PREFIX: "",
      ADJUTANT_SANDBOX_WORKDIR: " ",
      ADJUTANT_SANDBOX_ENV_ALLOWLIST: " ",
      ADJUTANT_SANDBOX_NETWORK: " ",
      ADJUTANT_SANDBOX_MEMORY: "",
      ADJUTANT_SANDBOX_PIDS_LIMIT: "0",
    } as NodeJS.ProcessEnv);
    assert.equal(config.docker.image, "adjutant-sandbox:trixie-slim");
    assert.equal(config.docker.containerPrefix, "adjutant-sandbox");
    assert.equal(config.docker.workdir, "/workspace");
    assert.deepEqual(config.docker.envAllowlist, []);
    assert.equal(config.docker.network, undefined);
    assert.equal(config.docker.memory, undefined);
    assert.equal(config.docker.pidsLimit, 256);
  });
});
