import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SummaryEditorShell from "$lib/components/summary/SummaryEditorShell.svelte";
import { createSummaryDraft } from "../helpers/summaryEditor";
import { tick } from "svelte";

describe("SummaryEditorShell", () => {
  it("renders initial draft content and dispatches events", async () => {
    const draft = createSummaryDraft({
      date: "2025-11-05",
      content: "## 初期コンテンツ\n- 追加予定",
    });
    const user = userEvent.setup();

    const onCreate = vi.fn();
    const onSave = vi.fn();
    const { component } = render(SummaryEditorShell, {
      props: { draft },
    });

    component.$on("create", (event) => {
      onCreate(event.detail.date);
    });
    component.$on("save", (event) => {
      onSave(event.detail.content);
    });

    expect(screen.getByText("サマリ編集")).toBeInTheDocument();
    expect(screen.getByLabelText("サマリ本文")).toHaveValue(draft.content);

    await user.click(screen.getByRole("button", { name: "サマリを作成" }));
    expect(onCreate).toHaveBeenCalledWith("2025-11-05");

    await user.clear(screen.getByLabelText("サマリ本文"));
    await user.type(screen.getByLabelText("サマリ本文"), "## 更新後\n- 反映");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledWith("## 更新後\n- 反映");
  });

  it("reflects external draft updates when not dirty", async () => {
    const user = userEvent.setup();
    const { component } = render(SummaryEditorShell, {
      props: {
        draft: createSummaryDraft({
          content: "初期状態",
        }),
      },
    });

    const textarea = screen.getByLabelText("サマリ本文");
    expect(textarea).toHaveValue("初期状態");

    await user.clear(textarea);
    await user.type(textarea, "ローカル編集");

    component.$set({
      draft: createSummaryDraft({
        content: "外部更新",
      }),
    });
    await tick();
    expect(screen.getByLabelText("サマリ本文")).toHaveValue("外部更新");
  });
});
