import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "$lib/server/types";
import { getEventPresentation } from "$lib/presentation/event";

describe("getEventPresentation", () => {
  it("Slack reaction の元メッセージを Markdown で再現する", () => {
    const event: TimelineEvent = {
      uid: "reaction-1",
      source: "slack",
      ts: null,
      loggedAt: null,
      raw: {
        detail: {
          slack: {
            message_text: "*完了* しました",
          },
        },
      },
    } as TimelineEvent;

    const presentation = getEventPresentation(event);

    expect(presentation.text).toBe("*完了* しました");
    expect(presentation.html).toContain("<strong>完了</strong>");
  });

  it("末尾の数値のみの行を除去する", () => {
    const event: TimelineEvent = {
      uid: "reaction-2",
      source: "slack",
      ts: null,
      loggedAt: null,
      raw: {
        detail: {
          slack: {
            message_text: "本文\n1\n2",
          },
        },
      },
    } as TimelineEvent;

    const presentation = getEventPresentation(event);
    expect(presentation.text).toBe("本文");
    expect(presentation.html).not.toContain(">1<");
  });
});
