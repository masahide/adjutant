import assert from "node:assert/strict";
import test from "node:test";

import {
  connectToSlackPage,
  isSlackPageTarget,
  selectSlackPageTarget,
} from "../../../src/collector-slack/connect-to-slack-page.js";

test("isSlackPageTarget は Slack ページ URL を判定する", () => {
  assert.equal(
    isSlackPageTarget({
      type: "page",
      url: "https://app.slack.com/client/T000/C000",
    }),
    true
  );
  assert.equal(
    isSlackPageTarget({
      type: "page",
      url: "https://example.com",
    }),
    false
  );
});

test("selectSlackPageTarget は最初の Slack ページ target を返す", () => {
  const target = selectSlackPageTarget([
    { type: "page", url: "https://example.com" },
    { type: "page", url: "https://app.slack.com/client/T000/C000" },
    { type: "page", url: "https://app.slack.com/client/T001/C001" },
  ]);
  assert.equal(target?.url, "https://app.slack.com/client/T000/C000");
});

test("connectToSlackPage は target がない場合にエラー", async () => {
  await assert.rejects(
    () =>
      connectToSlackPage({
        listTargets: async () => [{ type: "page", url: "https://example.com" }],
        connect: async () => ({ close: async () => {} }),
      }),
    /Slack page target not found/
  );
});
