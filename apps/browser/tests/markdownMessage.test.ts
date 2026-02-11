import { describe, expect, it } from "vitest";

import { renderMessageMarkdown } from "$lib/markdown";

describe("renderMessageMarkdown", () => {
  it("Slack テキストの Markdown を HTML に変換する", () => {
    const html = renderMessageMarkdown("*bold* `code`\n> quote");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<blockquote>");
  });

  it("危険なスキームを除去する", () => {
    const html = renderMessageMarkdown("[xss](javascript:alert('x'))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<a");
  });
});
