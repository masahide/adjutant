import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readable } from "svelte/store";
import { waitFor } from "@testing-library/dom";
import { createDayPageData } from "../helpers/dayPage";

const gotoMock = vi.hoisted(() => vi.fn());
const pageState = vi.hoisted(() => ({
  value: createPageState(),
}));
const summaryApiMocks = vi.hoisted(() => ({
  initializeSummaryDraft: vi.fn().mockResolvedValue({
    content: "",
    exists: false,
  }),
  loadSummaryDraft: vi.fn().mockResolvedValue({
    content: "# existing",
    exists: true,
  }),
  ensureSummaryEditUrl: vi.fn((url: URL) => {
    const params = new URLSearchParams(url.search);
    params.set("summary", "edit");
    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  }),
  isSummaryEditMode: vi.fn((url: URL) => url.searchParams.get("summary") === "edit"),
  saveSummaryDraft: vi.fn().mockResolvedValue({
    savedAt: "2025-11-03T12:00:00+09:00",
  }),
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

vi.mock("$lib/client/summary/api", () => summaryApiMocks);

describe("日報サマリ作成導線 (RED)", () => {
  beforeEach(() => {
    gotoMock.mockReset();
    summaryApiMocks.initializeSummaryDraft.mockClear();
    summaryApiMocks.loadSummaryDraft.mockClear();
    summaryApiMocks.saveSummaryDraft.mockClear();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("サマリ作成ボタン押下で summary API を呼び出し、編集モードへ遷移する", async () => {
    pageState.value = createPageState({ search: "" });
    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");
    const user = userEvent.setup();

    render(DayPage, {
      props: { data: createDayPageData() },
    });

    const trigger = screen.getByRole("button", { name: "サマリを作成" });
    await user.click(trigger);

    expect(summaryApiMocks.initializeSummaryDraft).toHaveBeenCalledWith("2025-11-03");

    await waitFor(() => {
      expect(gotoMock).toHaveBeenCalledWith(
        "/day/2025-11-03?summary=edit",
        expect.objectContaining({
          replaceState: true,
          keepFocus: true,
          noScroll: true,
        })
      );
    });
  });

  it("?summary=edit が付与された状態でロードすると既存サマリを取得する", async () => {
    pageState.value = createPageState({ search: "?summary=edit" });

    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");

    render(DayPage, {
      props: {
        data: createDayPageData({ summary: "# existing" }),
      },
    });

    await waitFor(() => {
      expect(summaryApiMocks.loadSummaryDraft).toHaveBeenCalledWith("2025-11-03");
    });
  });

  it("サマリファイルが空でもプレビューを表示する", async () => {
    pageState.value = createPageState({ search: "" });

    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");

    render(DayPage, {
      props: {
        data: createDayPageData({ summary: "" }),
      },
    });

    expect(await screen.findByText("Markdown サマリ")).toBeInTheDocument();
    expect(await screen.findByText("サマリがまだありません。")).toBeInTheDocument();
  });

  it("サマリ保存時にドラフトを保存 API へ送信する", async () => {
    pageState.value = createPageState({ search: "?summary=edit" });

    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");
    const user = userEvent.setup();

    render(DayPage, {
      props: {
        data: createDayPageData({ summary: "# existing" }),
      },
    });

    await waitFor(() => {
      expect(summaryApiMocks.loadSummaryDraft).toHaveBeenCalledWith("2025-11-03");
    });

    const textarea = await screen.findByLabelText("サマリ本文");
    await user.type(textarea, "\n- 追記");

    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(summaryApiMocks.saveSummaryDraft).toHaveBeenCalledWith("2025-11-03", {
      content: "# existing\n- 追記",
    });
  });

  it("LLM モデル一覧が設定ファイルの既定値で初期化される", async () => {
    pageState.value = createPageState({ search: "?summary=edit" });
    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");

    render(DayPage, {
      props: {
        data: createDayPageData({
          llm: {
            models: ["claude-3-5", "gpt-4o-mini"],
            defaultModel: "claude-3-5",
          },
        }),
      },
    });

    await waitFor(() => {
      expect(summaryApiMocks.loadSummaryDraft).toHaveBeenCalledWith("2025-11-03");
    });

    const select = await screen.findByLabelText("LLM モデル");
    const optionValues = Array.from((select as HTMLSelectElement).options).map((opt) => opt.value);
    expect(optionValues).toEqual(["claude-3-5", "gpt-4o-mini"]);
    expect((select as HTMLSelectElement).value).toBe("claude-3-5");
  });

  it("編集画面のサマリ作成ボタンから初期化フローを呼び出す", async () => {
    pageState.value = createPageState({ search: "?summary=edit" });
    const { default: DayPage } = await import("../../src/routes/day/[date]/+page.svelte");
    const user = userEvent.setup();

    render(DayPage, {
      props: { data: createDayPageData({ summary: "# existing" }) },
    });

    await waitFor(() => {
      expect(summaryApiMocks.loadSummaryDraft).toHaveBeenCalledWith("2025-11-03");
    });

    // SummaryEditorShell 内のボタンをクリックする
    const buttons = screen.getAllByRole("button", { name: "サマリを作成" });
    const editorButton = buttons[buttons.length - 1];
    await user.click(editorButton);

    await waitFor(() => {
      expect(summaryApiMocks.initializeSummaryDraft).toHaveBeenCalledWith("2025-11-03");
    });
  });
});

function createPageState(options: { search?: string } = {}) {
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
