import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { waitFor } from "@testing-library/dom";
import { readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDayPageData } from "../helpers/dayPage";
import { createSummaryApiMock } from "./helpers/summaryApiMock";

const gotoMock = vi.hoisted(() => vi.fn());
const pageState = vi.hoisted(() => ({
  value: createPageState({ search: "?summary=edit" }),
}));

vi.mock("$app/environment", () => ({
  browser: true,
}));

vi.mock("$app/navigation", () => ({
  goto: gotoMock,
  invalidate: vi.fn(),
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
}));

vi.mock("$app/stores", () => ({
  page: readable(pageState.value, (set) => {
    set(pageState.value);
    return () => {};
  }),
}));

describe("サマリ編集フロー 回帰E2E", () => {
  const date = "2025-11-03";
  let apiMock: ReturnType<typeof createSummaryApiMock>;

  beforeEach(() => {
    pageState.value = createPageState({ search: "?summary=edit" });
    gotoMock.mockReset();
    apiMock = createSummaryApiMock(date);
  });

  afterEach(() => {
    apiMock.restore();
  });

  it("サマリ読込からLLM助言の適用・保存までの主要フローが成功する", async () => {
    const initialContent = "# 2025-11-03\n\n## Done\n- base";
    const suggestionDelta = "## Advice\n- suggestion";
    const savedAt = "2025-11-03T12:34:56+09:00";

    apiMock.setLoadResponse({
      status: 200,
      body: { content: initialContent, exists: true, updatedAt: "2025-11-02T23:00:00+09:00" },
    });
    apiMock.setSuggestionResponse({
      status: 200,
      body: {
        summaryUpdate: { mode: "append", content: suggestionDelta },
        assistantMessage: "追記案を生成しました。",
        reasoning: null,
        responseId: "resp-mock",
      },
    });
    apiMock.setSaveResponse({
      status: 200,
      body: { savedAt },
    });

    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");
    const user = userEvent.setup();

    render(DayPage, {
      props: { data: createDayPageData({ summary: initialContent }) },
    });

    await waitFor(() => {
      expect(apiMock.getLoadCount()).toBe(1);
    });

    const editor = await screen.findByLabelText("サマリ本文");
    expect(editor).toHaveValue(initialContent);

    await user.type(editor, "\n- 追記");
    await waitForDebounce();

    const promptInput = screen.getByPlaceholderText("LLM への指示を書きます");
    await user.type(promptInput, "追加ポイント");
    await user.click(screen.getByRole("button", { name: "送信" }));

    const applyButton = await screen.findByRole("button", { name: "追記" });
    await user.click(applyButton);

    const saveButton = screen.getByRole("button", { name: "保存" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(apiMock.getSavedPayloads()).toHaveLength(1);
    });

    const [saved] = apiMock.getSavedPayloads();
    expect(saved.content).toContain("- 追記");
    expect(saved.content).toContain("## Advice");
    expect(saved.content).toContain("- suggestion");

    const toast = await screen.findByText("サマリを保存しました。");
    expect(toast).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("追記案を生成しました。")).toBeInTheDocument();
    });

    const savedLabels = await screen.findAllByText(/最終保存:/);
    const editorSavedLabel = savedLabels.find((element) => element.classList.contains("status"));
    expect(editorSavedLabel?.textContent ?? "").toContain("2025/11/03");

    const [suggestionRequest] = apiMock.getSuggestionRequests();
    expect(suggestionRequest).toMatchObject({
      prompt: "追加ポイント",
      content: expect.stringContaining("- 追記"),
      previousResponseId: null,
    });
    expect(suggestionRequest.selection).toBeUndefined();
  });

  it("サマリ初期化が失敗した場合にエラー通知が表示される", async () => {
    const initialContent = "# 2025-11-03\n\n## Todo\n- empty";
    apiMock.setLoadResponse({
      status: 200,
      body: { content: initialContent, exists: true },
    });
    apiMock.setInitializeResponse({
      status: 500,
    });

    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");
    const user = userEvent.setup();

    render(DayPage, {
      props: { data: createDayPageData({ summary: initialContent }) },
    });

    await waitFor(() => {
      expect(apiMock.getLoadCount()).toBe(1);
    });

    const [createButton] = screen.getAllByRole("button", { name: "サマリを作成" });
    await user.click(createButton);

    await waitFor(() => {
      expect(apiMock.getInitializeCount()).toBe(1);
    });

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((alert) => alert.textContent?.includes("Failed to initialize summary"))
    ).toBe(true);
  });
});

type CreatePageStateOptions = {
  search?: string;
};

function createPageState(options: CreatePageStateOptions = {}) {
  const search = options.search ?? "";
  const url = new URL(`http://example.test/day/2025-11-03${search}`);
  return {
    url,
    params: { date: "2025-11-03" },
    route: { id: "/day/[date]" },
    status: 200,
    error: null,
    data: {},
    form: undefined,
  };
}

async function waitForDebounce(delayMs = 600) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
