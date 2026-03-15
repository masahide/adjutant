import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { buildDockerRunArgs } from "../../src/sandbox/docker-bash-operations.js";

test("sandbox bind mount keeps file ownership aligned on native workspace paths", async (t) => {
  if (process.env.ADJUTANT_SANDBOX_DOCKER_OWNERSHIP_TEST !== "1") {
    t.skip("set ADJUTANT_SANDBOX_DOCKER_OWNERSHIP_TEST=1 to run docker ownership verification");
    return;
  }
  if (process.env.ADJUTANT_TEST_NO_DOCKER === "1") {
    t.skip("docker ownership verification disabled by ADJUTANT_TEST_NO_DOCKER");
    return;
  }
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    t.skip("host uid/gid APIs are unavailable");
    return;
  }

  const inspect = spawnSync("docker", ["image", "inspect", "adjutant-sandbox:trixie-slim"], {
    encoding: "utf8",
  });
  if (inspect.status !== 0) {
    t.skip("sandbox image adjutant-sandbox:trixie-slim is not available locally");
    return;
  }

  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  const workspace = await mkdtemp(join(tmpRoot, "adjutant-sandbox-owner."));

  try {
    const uid = process.getuid();
    const gid = process.getgid();
    const args = buildDockerRunArgs({
      runSpec: {
        image: "adjutant-sandbox:trixie-slim",
        hostWorkspaceDir: workspace,
        containerWorkdir: "/workspace",
        containerHome: "/home/agent",
        user: `${uid}:${gid}`,
      },
      containerCwd: "/workspace",
      command: "echo sandbox > /workspace/owned.txt",
    });

    const run = spawnSync("docker", args, {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const ownedFile = join(workspace, "owned.txt");
    const workspaceStat = await stat(workspace);
    const fileStat = await stat(ownedFile);
    assert.equal(fileStat.uid, workspaceStat.uid);
    assert.equal(fileStat.gid, workspaceStat.gid);
    assert.equal(fileStat.uid, uid);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
