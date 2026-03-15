import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ensureWorkspaceReady,
  resolveRuntimeDirectories,
  resolveWorkspaceTemplateDir,
} from "../../../src/runtime/runtime-directories.js";

test("resolveRuntimeDirectories uses ~/.adjutant/workspace by default", () => {
  const dirs = resolveRuntimeDirectories({
    env: {},
    homedirPath: "/Users/tester",
    projectRoot: "/repo/adjutant",
  });

  assert.deepEqual(dirs, {
    projectRoot: "/repo/adjutant",
    stateDir: "/Users/tester/.adjutant",
    workspaceDir: "/Users/tester/.adjutant/workspace",
  });
});

test("resolveRuntimeDirectories derives workspace from overridden stateDir", () => {
  const dirs = resolveRuntimeDirectories({
    env: {
      ADJUTANT_STATE_DIR: "/tmp/adjutant-state",
    },
    homedirPath: "/Users/tester",
    projectRoot: "/repo/adjutant",
  });

  assert.equal(dirs.stateDir, "/tmp/adjutant-state");
  assert.equal(dirs.workspaceDir, "/tmp/adjutant-state/workspace");
});

test("resolveRuntimeDirectories prefers explicit workspace dir override", () => {
  const dirs = resolveRuntimeDirectories({
    env: {
      ADJUTANT_STATE_DIR: "/tmp/adjutant-state",
      ADJUTANT_WORKSPACE_DIR: "../custom-workspace",
    },
    homedirPath: "/Users/tester",
    projectRoot: "/repo/adjutant",
  });

  assert.equal(dirs.workspaceDir, resolve("../custom-workspace"));
});

test("resolveWorkspaceTemplateDir points at vendor/openclaw templates", () => {
  assert.equal(
    resolveWorkspaceTemplateDir("/repo/adjutant"),
    "/repo/adjutant/vendor/openclaw/docs/reference/templates"
  );
});

test("ensureWorkspaceReady creates missing workspace directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-runtime-dirs-"));
  const workspaceDir = join(root, "workspace", "nested");
  try {
    await ensureWorkspaceReady(workspaceDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceReady rejects non-writable directories", async (t) => {
  if (process.platform === "win32") {
    t.skip("permission bits are not reliable on Windows");
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root bypasses permission checks");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "adjutant-runtime-dirs-readonly-"));
  const workspaceDir = join(root, "workspace");
  try {
    await ensureWorkspaceReady(workspaceDir);
    await chmod(workspaceDir, 0o500);
    await assert.rejects(async () => await ensureWorkspaceReady(workspaceDir));
  } finally {
    await chmod(workspaceDir, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
