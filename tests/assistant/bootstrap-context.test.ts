import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBootstrapContextFiles,
  renderProjectContext,
} from "../../src/assistant/bootstrap-context.js";
import type { WorkspaceBootstrapFile } from "../../src/assistant/workspace-bootstrap.js";

describe("bootstrap-context", () => {
  it("missing BOOTSTRAP.md は context へ含めない", () => {
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "AGENTS.md",
        path: "/tmp/workspace/AGENTS.md",
        missing: true,
      },
      {
        name: "BOOTSTRAP.md",
        path: "/tmp/workspace/BOOTSTRAP.md",
        missing: true,
      },
    ] as const;

    const contextFiles = buildBootstrapContextFiles(files);
    assert.equal(
      contextFiles.some((file) => file.path === "AGENTS.md"),
      true
    );
    assert.equal(
      contextFiles.some((file) => file.path === "BOOTSTRAP.md"),
      false
    );
  });

  it("大きいファイルは head/tail 方式でトリミングされる", () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const files: WorkspaceBootstrapFile[] = [
      {
        name: "SOUL.md",
        path: "/tmp/workspace/SOUL.md",
        content: "x".repeat(200),
        missing: false,
      },
    ];

    const contextFiles = buildBootstrapContextFiles(files, {
      maxCharsPerFile: 100,
      onWarn: (_message, meta) => {
        warnings.push(meta);
      },
    });

    assert.equal(contextFiles.length, 1);
    assert.equal(contextFiles[0]?.path, "SOUL.md");
    assert.equal(contextFiles[0]?.content.includes("[...truncated"), true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.fileName, "SOUL.md");
  });

  it("HEARTBEAT.md を含む場合は通常ターン向けの適用スコープ注意書きを出す", () => {
    const rendered = renderProjectContext([
      {
        path: "HEARTBEAT.md",
        content: "# HEARTBEAT\n...",
      },
    ]);

    assert.equal(
      rendered.includes("HEARTBEAT.md instructions apply only during heartbeat turns"),
      true
    );
    assert.equal(
      rendered.includes("For normal user turns, do not execute HEARTBEAT.md instructions."),
      true
    );
  });
});
