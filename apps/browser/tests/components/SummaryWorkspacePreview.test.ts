import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import SummaryWorkspace from "$lib/components/summary/SummaryWorkspace.svelte";
import { createSummaryDraft } from "../helpers/summaryEditor";

describe("SummaryWorkspace プレビュー更新 (RED)", () => {
  it("300ms 未満ではプレビューが更新されない", async () => {
    vi.useFakeTimers();
    try {
      const { component } = render(SummaryWorkspace, {
        draft: createSummaryDraft({ content: "# 初期" }),
        models: ["gpt-4.1-mini"],
        activeModel: "gpt-4.1-mini",
      });

      component.$set({
        draft: createSummaryDraft({ content: "# 新しい見出し" }),
      });
      await tick();

      expect(screen.queryByText("新しい見出し")).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      expect(screen.getByText("新しい見出し")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Markdown プレビュー生成後にスクロール同期を再初期化する", async () => {
    vi.useFakeTimers();
    let addSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      const { component, container } = render(SummaryWorkspace, {
        draft: createSummaryDraft({ content: "" }),
        models: ["gpt-4.1-mini"],
        activeModel: "gpt-4.1-mini",
      });

      const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      if (!textarea) {
        throw new Error("textarea not found");
      }
      addSpy = vi.spyOn(EventTarget.prototype, "addEventListener");
      const initialCallCount = addSpy.mock.calls.length;

      component.$set({
        draft: createSummaryDraft({ content: "# 新しいプレビュー" }),
      });
      await tick();
      await vi.advanceTimersByTimeAsync(300);
      await tick();

      expect(screen.getByTestId("markdown-preview")).toBeInTheDocument();
      expect(textarea.isConnected).toBe(true);
      const newCalls = addSpy.mock.calls.slice(initialCallCount);
      expect(newCalls.some((call) => call[0] === "scroll")).toBe(true);
    } finally {
      addSpy?.mockRestore();
      vi.useRealTimers();
    }
  });
});
