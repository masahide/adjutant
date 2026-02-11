import { describe, expect, it } from "vitest";

import { diffSummary } from "../../src/lib/summary/diff";

describe("summary diff", () => {
  it("空文字列の場合は diff なし", () => {
    expect(diffSummary("", "")).toEqual([]);
  });

  it("追記された行を add として検出する", () => {
    const result = diffSummary("# Heading", "# Heading\n- item");
    expect(result).toEqual([
      { type: "context", value: "# Heading" },
      { type: "add", value: "- item" },
    ]);
  });

  it("置き換えられた行を remove + add として検出する", () => {
    const result = diffSummary("- before", "- after");
    expect(result).toEqual([
      { type: "remove", value: "- before" },
      { type: "add", value: "- after" },
    ]);
  });

  it("複数行の差分でも順序を維持する", () => {
    const before = ["# Title", "", "- keep", "- remove"].join("\n");
    const after = ["# Title", "", "- keep", "- add"].join("\n");
    expect(diffSummary(before, after)).toEqual([
      { type: "context", value: "# Title" },
      { type: "context", value: "" },
      { type: "context", value: "- keep" },
      { type: "remove", value: "- remove" },
      { type: "add", value: "- add" },
    ]);
  });
});
