import { describe, expect, it } from "vitest";

import { buildClipboardPayload } from "$lib/presentation/clipboard";
import type { TimelineEvent } from "$lib/server/types";

const baseEvent = (
  overrides: Partial<TimelineEvent> & { raw?: Record<string, unknown> }
): TimelineEvent => {
  return {
    uid: "event-1",
    source: "slack",
    ts: "2025-11-05T10:00:00+09:00",
    loggedAt: "2025-11-05T10:00:00+09:00",
    raw: {
      subject: "[#test] reaction",
      actor: "tester",
      meta: { channel: "#test" },
      detail: { slack: { channel_name: "#test", message_text: "本文" } },
      ...overrides.raw,
    },
    ...overrides,
  } as TimelineEvent;
};

describe("buildClipboardPayload", () => {
  it("summary とイベントを整形する", () => {
    const events: TimelineEvent[] = [
      baseEvent({
        uid: "event-post",
        source: "slack",
        raw: {
          subject: "[#test] post",
          actor: "tester",
          meta: { channel: "#test" },
          detail: { slack: { channel_name: "#test", message_text: "ポスト本文" } },
          kind: "post",
        },
      }),
      baseEvent({
        uid: "event-reaction",
        raw: {
          subject: "[#test] reaction smile",
          actor: "tester",
          meta: { channel: "#test", emoji: "smile" },
          detail: {
            slack: { channel_name: "#test", emoji: "smile", message_text: "リアクション本文" },
          },
          kind: "reaction",
        },
      }),
    ];

    const payload = buildClipboardPayload("2025-11-05", events, "まとめ");
    expect(payload).toMatch(/# ReacLog\s+2025-11-05/);
    expect(payload).toContain("## Summary");
    expect(payload).toContain("## Events");
    expect(payload).toMatch(/-\s+2025-11-05T10:00:00\+09:00\s+\*\*Slack #test post\*\* — tester/);
    expect(payload).toMatch(
      /-\s+2025-11-05T10:00:00\+09:00\s+\*\*Slack #test reaction smile\*\* — :smile:/
    );
    expect(payload).toContain("  リアクション本文");
  });

  it("カスタムテンプレートを利用できる", () => {
    const events: TimelineEvent[] = [
      baseEvent({
        uid: "event-post",
        ts: "2025-11-05T08:00:00+09:00",
        raw: {
          subject: "[#test] post",
          actor: "tester",
          meta: { channel: "#test" },
          detail: { slack: { channel_name: "#test", message_text: "本文" } },
        },
      }),
    ];

    const customTemplate = `# Custom {{date}}
{{#each events}}
- {{title}} ({{timestamp}})
{{/each}}`.trim();

    const payload = buildClipboardPayload("2025-11-05", events, null, customTemplate);
    expect(payload).toContain("# Custom 2025-11-05");
    expect(payload).toContain("- Slack #test post (2025-11-05T08:00:00+09:00)");
  });
});
