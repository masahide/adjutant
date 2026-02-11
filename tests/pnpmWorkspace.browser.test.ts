import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("pnpm-workspace.yaml", () => {
  it("apps/browser パッケージを含む", () => {
    const workspacePath = resolve("pnpm-workspace.yaml");
    const content = readFileSync(workspacePath, "utf-8");
    assert.match(
      content,
      /^ {0,2}-\s*apps\/browser\s*$/m,
      "apps/browser がワークスペースに登録されていません"
    );
  });
});
