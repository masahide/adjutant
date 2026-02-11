import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "$lib/server/types";
import { resolveSlackPermalink } from "./slack";

const baseEvent: TimelineEvent = {
  uid: "slack:C123@1711112222.555000",
  source: "slack",
  ts: "2025-01-01T00:00:00Z",
  loggedAt: "2025-01-01T00:00:01Z",
  raw: {
    detail: {
      slack: {
        channel_id: "C123",
        message_ts: "1711112222.555000",
      },
    },
  },
};

describe("resolveSlackPermalink", () => {
  it("returns null when base url is missing", () => {
    expect(resolveSlackPermalink(baseEvent, null)).toBeNull();
    expect(resolveSlackPermalink(baseEvent, "")).toBeNull();
  });

  it("returns null for non-slack sources", () => {
    const event: TimelineEvent = { ...baseEvent, source: "github" };
    expect(resolveSlackPermalink(event, "https://workspace.slack.com")).toBeNull();
  });

  it("builds a permalink for top-level slack messages", () => {
    const url = resolveSlackPermalink(baseEvent, "https://workspace.slack.com/some/extra/path");
    expect(url).toBe("https://workspace.slack.com/archives/C123/p1711112222555000");
  });

  it("adds thread query parameters for replies", () => {
    const reply: TimelineEvent = {
      ...baseEvent,
      uid: "slack:C123@1711113333.125900",
      raw: {
        detail: {
          slack: {
            channel_id: "C123",
            message_ts: "1711113333.125900",
            thread_ts: "1711112222.555000",
          },
        },
      },
    };

    const url = resolveSlackPermalink(reply, "workspace.slack.com");
    expect(url).toBe(
      "https://workspace.slack.com/archives/C123/p1711113333125900?thread_ts=1711112222.555000&cid=C123"
    );
  });

  it("uses UID fallback when message timestamp is absent", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      raw: {
        detail: {
          slack: {
            channel_id: "C999",
          },
        },
      },
      uid: "slack:C999@1712224444.990000:eyes:added:U1",
    };

    const url = resolveSlackPermalink(event, "https://workspace.slack.com");
    expect(url).toBe("https://workspace.slack.com/archives/C999/p1712224444990000");
  });

  it("returns null when channel id is missing", () => {
    const event: TimelineEvent = {
      ...baseEvent,
      raw: {
        detail: {
          slack: {},
        },
      },
    };

    expect(resolveSlackPermalink(event, "https://workspace.slack.com")).toBeNull();
  });
});
