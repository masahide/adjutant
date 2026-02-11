import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import SummaryEditorShell from "$lib/components/summary/SummaryEditorShell.svelte";
import { createSummaryDraft } from "../helpers/summaryEditor";

describe("SummaryEditorShell キーボード操作", () => {
  const user = userEvent.setup();

  it("Cmd/Ctrl+S で保存イベントを発火する", async () => {
    const onSave = vi.fn();
    const draft = createSummaryDraft({ content: "初期" });
    const { component } = render(SummaryEditorShell, { draft });
    component.$on("save", (event) => onSave(event.detail.content));

    const textarea = screen.getByLabelText("サマリ本文");
    await user.type(textarea, " 更新");

    await fireEvent.keyDown(textarea, { key: "s", metaKey: true });
    await fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });

    expect(onSave).toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter で保存イベントを発火する", async () => {
    const onSave = vi.fn();
    const draft = createSummaryDraft({ content: "行1" });
    const { component } = render(SummaryEditorShell, { draft });
    component.$on("save", (event) => onSave(event.detail.content));

    const textarea = screen.getByLabelText("サマリ本文");
    await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSave).toHaveBeenCalled();
  });

  it("500ms デバウンス後に入力イベントをフラッシュする", async () => {
    vi.useFakeTimers();
    const onInput = vi.fn();
    const draft = createSummaryDraft({ content: "ベース" });
    const { component } = render(SummaryEditorShell, { draft });
    component.$on("input", (event) => onInput(event.detail.content));

    const textarea = screen.getByLabelText("サマリ本文");
    await fireEvent.input(textarea, { target: { value: "途中入力" } });

    expect(onInput).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(500);
    await tick();
    expect(onInput).toHaveBeenCalledWith("途中入力");
    vi.useRealTimers();
  });
});
