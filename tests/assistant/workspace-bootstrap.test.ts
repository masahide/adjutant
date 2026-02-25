import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ensureWorkspaceBootstrapFiles,
  loadWorkspaceBootstrapFiles,
} from "../../src/assistant/workspace-bootstrap.js";

describe("workspace-bootstrap", () => {
  it("brand-new workspace ではテンプレート群と BOOTSTRAP.md を作成する", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-workspace-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");

    try {
      const decision = await ensureWorkspaceBootstrapFiles(workspaceDir);
      const files = await readdir(workspaceDir);

      assert.equal(decision.createdWorkspace, true);
      assert.equal(decision.isBrandNewWorkspace, true);
      assert.equal(files.includes("AGENTS.md"), true);
      assert.equal(files.includes("SOUL.md"), true);
      assert.equal(files.includes("TOOLS.md"), true);
      assert.equal(files.includes("IDENTITY.md"), true);
      assert.equal(files.includes("USER.md"), true);
      assert.equal(files.includes("HEARTBEAT.md"), true);
      assert.equal(files.includes("BOOTSTRAP.md"), true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("生成された AGENTS/HEARTBEAT テンプレートは heartbeat 適用条件を含む", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-workspace-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");

    try {
      await ensureWorkspaceBootstrapFiles(workspaceDir);
      const agents = await readFile(join(workspaceDir, "AGENTS.md"), "utf8");
      const heartbeat = await readFile(join(workspaceDir, "HEARTBEAT.md"), "utf8");

      assert.equal(
        agents.includes("HEARTBEAT.md の指示は heartbeat 実行ターンでのみ適用する"),
        true
      );
      assert.equal(heartbeat.includes("HEARTBEAT_OK"), true);
      assert.equal(heartbeat.includes("report_heartbeat_status"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("2回目以降は BOOTSTRAP.md を再生成しない", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-workspace-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");

    try {
      await ensureWorkspaceBootstrapFiles(workspaceDir);
      await rm(join(workspaceDir, "BOOTSTRAP.md"), { force: true });

      const decision = await ensureWorkspaceBootstrapFiles(workspaceDir);
      const files = await readdir(workspaceDir);

      assert.equal(decision.isBrandNewWorkspace, false);
      assert.equal(files.includes("BOOTSTRAP.md"), false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("loadWorkspaceBootstrapFiles は BOOTSTRAP.md 不在時に missing として返す", async () => {
    const rootDir = await mkdtemp(`${tmpdir()}/adjutant-workspace-bootstrap-`);
    const workspaceDir = join(rootDir, "workspace");

    try {
      await ensureWorkspaceBootstrapFiles(workspaceDir);
      await rm(join(workspaceDir, "BOOTSTRAP.md"), { force: true });
      const files = await loadWorkspaceBootstrapFiles(workspaceDir);

      const bootstrap = files.find((file) => file.name === "BOOTSTRAP.md");
      assert.ok(bootstrap);
      assert.equal(bootstrap?.missing, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
