import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..", "..", "..");

describe("docs consistency", () => {
  it("spec にリアルタイム更新とダークモード要件が記載されている", () => {
    const spec = readText("docs/spec.md");
    expect(spec).toContain("JSONL ファイルの追記を 1〜2 秒以内に検知");
    expect(spec).toContain("ダークモード設定に追従");
    expect(spec).toContain("Markdown 変換済みプレビュー");
  });

  it("README にブラウザの即時反映・テーマ切替・Markdown 再現を記載する", () => {
    const readme = readText("README.md");
    expect(readme).toContain("リアルタイムストリーム");
    expect(readme).toContain("テーマ切替");
    expect(readme).toContain("Markdown 記法");
  });
});

function readText(relativePath: string): string {
  const fullPath = resolve(projectRoot, relativePath);
  return readFileSync(fullPath, "utf-8");
}
