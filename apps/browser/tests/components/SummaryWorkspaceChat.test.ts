import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SummaryWorkspace from "$lib/components/summary/SummaryWorkspace.svelte";
import { createSummaryDraft } from "../helpers/summaryEditor";

const chatApiMock = vi.hoisted(() => ({
  requestSuggestion: vi.fn(),
}));

vi.mock("$lib/client/summary/chat", () => chatApiMock);

describe("SummaryWorkspace LLMチャット (RED)", () => {
  const user = userEvent.setup();

  beforeEach(() => {
    chatApiMock.requestSuggestion.mockReset();
  });

  it("送信ボタンでプロンプトとモデルをAPIに送信し、提案メッセージを表示する", async () => {
    chatApiMock.requestSuggestion.mockResolvedValue({
      summaryUpdate: { mode: "append", content: "- 提案テキスト" },
      assistantMessage: "箇条書きを追加しました",
      reasoning: null,
      responseId: "resp-1",
    });

    render(SummaryWorkspace, {
      draft: createSummaryDraft({ content: "初期" }),
      models: ["gpt-4.1-mini", "gpt-4o"],
      activeModel: "gpt-4.1-mini",
    });

    const textarea = screen.getByPlaceholderText("LLM への指示を書きます");
    await user.type(textarea, "箇条書きを増やして");
    await user.click(screen.getByRole("button", { name: "送信" }));

    expect(chatApiMock.requestSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1-mini",
        prompt: "箇条書きを増やして",
        content: "初期",
        date: "2025-11-03",
      })
    );
    expect(chatApiMock.requestSuggestion.mock.calls[0][0].selection).toBeUndefined();
    expect(chatApiMock.requestSuggestion.mock.calls[0][0].previousResponseId).toBeUndefined();

    expect(await screen.findByText("箇条書きを追加しました")).toBeInTheDocument();
    expect(screen.getByText("+- 提案テキスト")).toBeInTheDocument();
  });

  it("提案を適用すると summary_update.mode に応じて草稿が更新される", async () => {
    chatApiMock.requestSuggestion.mockResolvedValue({
      summaryUpdate: { mode: "replace", content: "# 新しいサマリ" },
      assistantMessage: "全文を書き換えました",
      reasoning: "要約を刷新",
      responseId: "resp-2",
    });

    render(SummaryWorkspace, {
      draft: createSummaryDraft({ content: "ベース" }),
      models: ["gpt-4.1-mini"],
      activeModel: "gpt-4.1-mini",
    });

    const textarea = screen.getByPlaceholderText("LLM への指示を書きます");
    await user.type(textarea, "追記して");
    await user.click(screen.getByRole("button", { name: "送信" }));

    const applyButton = await screen.findByRole("button", { name: "置き換え" });
    await user.click(applyButton);

    await waitFor(() => expect(screen.getByLabelText("サマリ本文")).toHaveValue("# 新しいサマリ"));
    expect(await screen.findByText("適用済み")).toBeInTheDocument();
  });

  it("別モデルを選択すると以降のリクエストで反映される", async () => {
    chatApiMock.requestSuggestion.mockResolvedValue({
      summaryUpdate: { mode: "append", content: "- 改善案" },
      assistantMessage: "改善案を追記しました",
      reasoning: null,
      responseId: "resp-3",
    });

    const { component } = render(SummaryWorkspace, {
      draft: createSummaryDraft(),
      models: ["gpt-4.1-mini", "gpt-4o"],
      activeModel: "gpt-4.1-mini",
    });

    await user.selectOptions(screen.getByLabelText("LLM モデル"), "gpt-4o");
    component.$set({ activeModel: "gpt-4o" });
    await user.type(screen.getByPlaceholderText("LLM への指示を書きます"), "要約して");
    await user.click(screen.getByRole("button", { name: "送信" }));

    expect(chatApiMock.requestSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" })
    );
  });

  it("選択範囲を送信すると selection が API へ渡される", async () => {
    chatApiMock.requestSuggestion.mockResolvedValue({
      summaryUpdate: { mode: "append", content: "- 追加" },
      assistantMessage: "追記しました",
      reasoning: null,
      responseId: "resp-4",
    });

    render(SummaryWorkspace, {
      draft: createSummaryDraft({ content: "セクションA\nセクションB" }),
      models: ["gpt-4.1-mini"],
      activeModel: "gpt-4.1-mini",
    });

    const editor = screen.getByLabelText("サマリ本文") as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 5);

    const promptBox = screen.getByPlaceholderText("LLM への指示を書きます");
    await user.type(promptBox, "選択範囲を要約して");
    await user.click(screen.getByRole("button", { name: "送信" }));

    expect(chatApiMock.requestSuggestion).toHaveBeenCalled();
    const payload = chatApiMock.requestSuggestion.mock.calls[0][0];
    expect(payload.date).toBe("2025-11-03");
    expect(payload.selection).toEqual(
      expect.objectContaining({
        start: 0,
        end: 5,
      })
    );
  });

  it("キャンセルを押すと提案が一覧から取り除かれる", async () => {
    chatApiMock.requestSuggestion.mockResolvedValue({
      summaryUpdate: { mode: "append", content: "- 追記" },
      assistantMessage: "追記しました",
      reasoning: null,
      responseId: "resp-5",
    });

    render(SummaryWorkspace, {
      draft: createSummaryDraft(),
      models: ["gpt-4.1-mini"],
      activeModel: "gpt-4.1-mini",
    });

    await user.type(screen.getByPlaceholderText("LLM への指示を書きます"), "追記して");
    await user.click(screen.getByRole("button", { name: "送信" }));

    expect(await screen.findByText("追記しました")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    await waitFor(() => expect(screen.getByText("追記しました")).toBeInTheDocument());
    expect(screen.getByText("キャンセル済み")).toBeInTheDocument();
  });

  it("前回の応答 ID を次のリクエストの previousResponseId に渡す", async () => {
    chatApiMock.requestSuggestion
      .mockResolvedValueOnce({
        summaryUpdate: { mode: "append", content: "- first" },
        assistantMessage: "first",
        reasoning: null,
        responseId: "resp-first",
      })
      .mockResolvedValueOnce({
        summaryUpdate: { mode: "append", content: "- second" },
        assistantMessage: "second",
        reasoning: null,
        responseId: "resp-second",
      });

    render(SummaryWorkspace, {
      draft: createSummaryDraft(),
      models: ["gpt-4.1-mini"],
      activeModel: "gpt-4.1-mini",
    });

    const promptInput = screen.getByPlaceholderText("LLM への指示を書きます");
    await user.type(promptInput, "first");
    await user.click(screen.getByRole("button", { name: "送信" }));
    await screen.findByText("first");

    await user.type(promptInput, "second");
    await user.click(screen.getByRole("button", { name: "送信" }));

    expect(chatApiMock.requestSuggestion.mock.calls[1][0].previousResponseId).toBe("resp-first");
  });
});
