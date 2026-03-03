import assert from "node:assert/strict";
import test from "node:test";

import { createCollectorLogger } from "../../../src/collector-slack/logger.js";

test("createCollectorLogger は JSON 行を出力する", () => {
  const lines: string[] = [];
  const logger = createCollectorLogger({
    scope: "collector-test",
    now: () => new Date("2026-03-03T12:00:00.000Z"),
    sink: (line) => {
      lines.push(line);
    },
  });

  logger({
    level: "info",
    event: "collector.connect.start",
    endpointHost: "127.0.0.1",
  });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as {
    scope?: string;
    level?: string;
    event?: string;
    endpointHost?: string;
    ts?: string;
  };
  assert.equal(parsed.scope, "collector-test");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.event, "collector.connect.start");
  assert.equal(parsed.endpointHost, "127.0.0.1");
  assert.equal(parsed.ts, "2026-03-03T12:00:00.000Z");
});
