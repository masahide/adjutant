import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  buildSandboxCreateArgs,
  destroySandboxContainer,
  ensureDockerImage,
  ensureSandboxContainer,
  isDockerAvailable,
} from "../../src/sandbox/docker.js";
import type { SandboxDockerConfig } from "../../src/sandbox/types.js";

function inspectContainerOutput(params: { running: boolean; owner: string }): string {
  return JSON.stringify([
    {
      State: { Running: params.running },
      Config: {
        Labels: {
          "adjutant.sandbox.owner": params.owner,
        },
      },
    },
  ]);
}

const defaultDockerConfig: SandboxDockerConfig = {
  image: "adjutant-sandbox:trixie-slim",
  containerPrefix: "adjutant-sandbox",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp", "/var/tmp", "/run"],
  network: undefined,
  capDrop: ["ALL"],
  pidsLimit: 256,
  memory: undefined,
};

describe("sandbox docker", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("buildSandboxCreateArgs は owner label と user を含む", () => {
    const args = buildSandboxCreateArgs({
      name: "adjutant-sandbox-a1b2c3",
      ownerNonce: "a1b2c3",
      cfg: defaultDockerConfig,
      hostWorkspaceDir: "/tmp/workspace",
    });
    assert.equal(args.includes("--user"), true);
    assert.equal(args.includes("1000:1000"), true);
    assert.equal(args.includes("--label"), true);
    assert.equal(args.includes("adjutant.sandbox.owner=a1b2c3"), true);
    assert.equal(args.includes("sleep"), true);
    assert.equal(args.includes("infinity"), true);
  });

  it("ensureSandboxContainer: 既存なしなら create -> start する", async () => {
    const calls: string[][] = [];
    const runner = mock.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "inspect") {
        return { code: 1, stdout: "", stderr: "Error: No such object" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const name = await ensureSandboxContainer({
      cfg: defaultDockerConfig,
      hostWorkspaceDir: "/tmp/workspace",
      ownerNonce: "a1b2c3",
      runner,
    });

    assert.equal(name, "adjutant-sandbox-a1b2c3");
    assert.equal(calls[1]?.[0], "create");
    assert.equal(calls[2]?.[0], "start");
  });

  it("ensureSandboxContainer: 停止済み(自 owner)は start して再利用する", async () => {
    const calls: string[][] = [];
    const runner = mock.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "inspect") {
        return {
          code: 0,
          stdout: inspectContainerOutput({ running: false, owner: "a1b2c3" }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const name = await ensureSandboxContainer({
      cfg: defaultDockerConfig,
      hostWorkspaceDir: "/tmp/workspace",
      ownerNonce: "a1b2c3",
      runner,
    });

    assert.equal(name, "adjutant-sandbox-a1b2c3");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.[0], "start");
  });

  it("ensureSandboxContainer: 実行中(自 owner)は再利用する", async () => {
    const calls: string[][] = [];
    const runner = mock.fn(async (args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: inspectContainerOutput({ running: true, owner: "a1b2c3" }),
        stderr: "",
      };
    });

    await ensureSandboxContainer({
      cfg: defaultDockerConfig,
      hostWorkspaceDir: "/tmp/workspace",
      ownerNonce: "a1b2c3",
      runner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "inspect");
  });

  it("ensureSandboxContainer: 実行中(他 owner)はエラー", async () => {
    const runner = mock.fn(async () => {
      return {
        code: 0,
        stdout: inspectContainerOutput({ running: true, owner: "zzzzzz" }),
        stderr: "",
      };
    });
    await assert.rejects(
      ensureSandboxContainer({
        cfg: defaultDockerConfig,
        hostWorkspaceDir: "/tmp/workspace",
        ownerNonce: "a1b2c3",
        runner,
      }),
      /owner mismatch/
    );
  });

  it("isDockerAvailable は docker version の exit code を反映する", async () => {
    const ok = await isDockerAvailable({
      runner: async () => ({ code: 0, stdout: "27.0.0", stderr: "" }),
    });
    const ng = await isDockerAvailable({
      runner: async () => ({ code: 1, stdout: "", stderr: "daemon not running" }),
    });
    assert.equal(ok, true);
    assert.equal(ng, false);
  });

  it("ensureDockerImage は存在時のみ通し、不在時はエラー", async () => {
    await ensureDockerImage("exists:image", {
      runner: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    });
    await assert.rejects(
      ensureDockerImage("missing:image", {
        runner: async () => ({ code: 1, stdout: "", stderr: "No such image" }),
      }),
      /pnpm sandbox:build/
    );
  });

  it("destroySandboxContainer は owner 一致時のみ rm -f する", async () => {
    const calls: string[][] = [];
    const ownerMatchedRunner = mock.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "inspect") {
        return {
          code: 0,
          stdout: inspectContainerOutput({ running: true, owner: "a1b2c3" }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const matched = await destroySandboxContainer({
      containerName: "adjutant-sandbox-a1b2c3",
      ownerNonce: "a1b2c3",
      runner: ownerMatchedRunner,
    });
    assert.equal(matched.removed, true);
    assert.equal(calls[1]?.[0], "rm");
    assert.equal(calls[1]?.[1], "-f");

    const mismatchCalls: string[][] = [];
    const ownerMismatchRunner = mock.fn(async (args: string[]) => {
      mismatchCalls.push(args);
      return {
        code: 0,
        stdout: inspectContainerOutput({ running: true, owner: "other" }),
        stderr: "",
      };
    });
    const mismatched = await destroySandboxContainer({
      containerName: "adjutant-sandbox-a1b2c3",
      ownerNonce: "a1b2c3",
      runner: ownerMismatchRunner,
    });
    assert.equal(mismatched.removed, false);
    assert.equal(mismatched.reason, "owner-mismatch");
    assert.equal(mismatchCalls.length, 1);
  });
});
