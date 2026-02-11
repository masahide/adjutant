import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { createSummaryDraft } from "../helpers/summaryEditor";

describe("SummaryWorkspace 3ペイン構成 (RED)", () => {
  it("LLMチャット / 編集 / プレビューの各ペインを表示する", async () => {
    const { default: SummaryWorkspace } = await import(
      "$lib/components/summary/SummaryWorkspace.svelte"
    );

    render(SummaryWorkspace, {
      draft: createSummaryDraft(),
      models: ["gpt-4.1-mini", "gpt-4o"],
      activeModel: "gpt-4.1-mini",
    });

    expect(screen.getByRole("region", { name: "LLM チャット" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Markdown 編集" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Markdown プレビュー" })).toBeInTheDocument();
  });
});
