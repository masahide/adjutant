import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  ensureWorkspaceBootstrapFiles,
  filterBootstrapFilesForMainSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "../../../src/assistant/workspace-bootstrap.js";

test("ensureWorkspaceBootstrapFiles strips template front matter", async () => {
  const root = await mkdtemp(join(tmpdir(), "adjutant-workspace-bootstrap-"));
  const workspaceDir = join(root, "workspace");
  const templateDir = join(root, "templates");
  try {
    await mkdir(templateDir, { recursive: true });
    await writeFile(
      join(templateDir, DEFAULT_AGENTS_FILENAME),
      ["---", 'title: "template"', "---", "", "# AGENTS", "hello"].join("\n"),
      "utf8"
    );
    await writeFile(join(templateDir, "SOUL.md"), "# SOUL\n", "utf8");
    await writeFile(join(templateDir, "TOOLS.md"), "# TOOLS\n", "utf8");
    await writeFile(join(templateDir, "IDENTITY.md"), "# IDENTITY\n", "utf8");
    await writeFile(join(templateDir, "USER.md"), "# USER\n", "utf8");
    await writeFile(join(templateDir, "HEARTBEAT.md"), "# HEARTBEAT\n", "utf8");
    await writeFile(
      join(templateDir, DEFAULT_BOOTSTRAP_FILENAME),
      ["---", 'title: "bootstrap"', "---", "", "# BOOTSTRAP"].join("\n"),
      "utf8"
    );

    await ensureWorkspaceBootstrapFiles(workspaceDir, { templateDir });

    const agents = await readFile(join(workspaceDir, DEFAULT_AGENTS_FILENAME), "utf8");
    const bootstrap = await readFile(join(workspaceDir, DEFAULT_BOOTSTRAP_FILENAME), "utf8");
    assert.equal(agents.startsWith("---"), false);
    assert.equal(agents.includes("# AGENTS"), true);
    assert.equal(bootstrap.startsWith("---"), false);
    assert.equal(bootstrap.includes("# BOOTSTRAP"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadWorkspaceBootstrapFiles does not auto-load daily memory files", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "adjutant-workspace-files-"));
  try {
    await mkdir(join(workspaceDir, "memory"), { recursive: true });
    await writeFile(join(workspaceDir, DEFAULT_MEMORY_FILENAME), "long-term\n", "utf8");
    await writeFile(join(workspaceDir, "memory", "2026-03-15.md"), "daily\n", "utf8");

    const files = await loadWorkspaceBootstrapFiles(workspaceDir);
    assert.equal(
      files.some((file) => file.path.endsWith("2026-03-15.md")),
      false
    );
    assert.equal(
      files.some((file) => file.name === DEFAULT_MEMORY_FILENAME),
      true
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("filterBootstrapFilesForMainSession keeps only supported context files", () => {
  const files: WorkspaceBootstrapFile[] = [
    { name: "AGENTS.md", path: "/tmp/AGENTS.md", content: "a", missing: false },
    { name: "MEMORY.md", path: "/tmp/MEMORY.md", content: "m", missing: false },
    { name: "memory.md", path: "/tmp/memory.md", content: "m2", missing: false },
    { name: "BOOTSTRAP.md", path: "/tmp/BOOTSTRAP.md", content: "b", missing: false },
  ];

  assert.deepEqual(
    filterBootstrapFilesForMainSession(files).map((file) => file.name),
    ["AGENTS.md", "MEMORY.md", "memory.md", "BOOTSTRAP.md"]
  );
});
