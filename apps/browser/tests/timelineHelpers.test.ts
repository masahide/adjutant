import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "$lib/server/types";
import {
  accumulateSource,
  computeLastTimestamp,
  insertEvent,
  parseTimelineEvent,
} from "../src/lib/client/timeline";

describe("client timeline helpers", () => {
  const baseEvent: TimelineEvent = {
    uid: "1",
    source: "slack",
    ts: "2025-11-03T10:00:00+09:00",
    loggedAt: "2025-11-03T10:00:01+09:00",
    raw: {},
  };

  it("insertEvent は UID 重複を避けつつ時刻順に整列する", () => {
    const another: TimelineEvent = {
      ...baseEvent,
      uid: "2",
      ts: "2025-11-03T09:00:00+09:00",
      loggedAt: "2025-11-03T09:00:01+09:00",
    };

    const result = insertEvent([baseEvent], another);

    expect(result).toHaveLength(2);
    expect(result[0].uid).toBe("2");
    expect(result[1].uid).toBe("1");

    const deduped = insertEvent(result, another);
    expect(deduped).toHaveLength(2);
  });

  it("computeLastTimestamp はイベントが無い場合に日付基準を返す", () => {
    expect(computeLastTimestamp([], "2025-11-03")).toBe("2025-11-03T00:00:00");
    expect(computeLastTimestamp([baseEvent], "2025-11-03")).toBe(baseEvent.loggedAt!);
  });

  it("accumulateSource は既存ソースのカウントを更新し、新規ソースを追加する", () => {
    const initial = [{ name: "slack", count: 1, selected: true }];
    const incremented = accumulateSource(initial, "slack");
    expect(incremented.options[0].count).toBe(2);
    expect(incremented.added).toBeUndefined();

    const added = accumulateSource(initial, "github");
    expect(added.options).toHaveLength(2);
    expect(added.added).toBe("github");
    expect(added.options.find((option) => option.name === "github")?.selected).toBe(true);
  });

  it("parseTimelineEvent は不正な JSON を弾く", () => {
    expect(parseTimelineEvent(JSON.stringify(baseEvent))).toMatchObject({ uid: "1" });
    expect(parseTimelineEvent("{invalid")).toBeNull();
    expect(parseTimelineEvent("{}")).toBeNull();
  });
});
