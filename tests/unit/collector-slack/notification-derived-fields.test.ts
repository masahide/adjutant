import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveIsDirectMention,
  deriveMessageTs,
  deriveSlackNotificationFields,
  deriveSlackPermalink,
  deriveThreadTs,
  extractMentionTargetUserIds,
  extractMentionTargetUserIdsFromBlocks,
  extractMentionTargetUserIdsFromText,
} from "../../../src/collector-slack/notification-derived-fields.js";

test("messageTs は payload.ts から派生できる", () => {
  assert.equal(deriveMessageTs({ ts: "1773477181.004799" }), "1773477181.004799");
});

test("messageTs は activity payload の entry.item.message.ts から派生できる", () => {
  assert.equal(
    deriveMessageTs({
      entry: {
        item: {
          message: {
            ts: "1773482514.221889",
          },
        },
      },
    }),
    "1773482514.221889"
  );
});

test("threadTs は payload.thread_ts から派生できる", () => {
  assert.equal(deriveThreadTs({ thread_ts: "1773477000.000001" }), "1773477000.000001");
});

test("mention target は text の <@UID> から抽出できる", () => {
  assert.deepEqual(extractMentionTargetUserIdsFromText("<@U1ABCDEF> hi <@WTEST0002>"), [
    "U1ABCDEF",
    "WTEST0002",
  ]);
});

test("mention target は blocks の user node から抽出できる", () => {
  assert.deepEqual(
    extractMentionTargetUserIdsFromBlocks([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "user", user_id: "U1ABCDEF" },
              { type: "text", text: " hello" },
            ],
          },
        ],
      },
    ]),
    ["U1ABCDEF"]
  );
});

test("mention target は blocks と text を重複排除して抽出できる", () => {
  assert.deepEqual(
    extractMentionTargetUserIds({
      text: "<@U1ABCDEF> hello",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "U1ABCDEF" },
                { type: "text", text: " hello" },
              ],
            },
          ],
        },
      ],
    }),
    ["U1ABCDEF"]
  );
});

test("direct mention は selfUserIds のいずれかが一致すると true", () => {
  assert.equal(deriveIsDirectMention(["WTEST0002"], ["U1SELF123", "WTEST0002"]), true);
});

test("permalink は workspace host, channelId, messageTs から生成できる", () => {
  assert.equal(
    deriveSlackPermalink({
      workspaceHost: "workspace-alpha.slack.com",
      channelId: "DTESTDM001",
      messageTs: "1773477181.004799",
    }),
    "https://workspace-alpha.slack.com/archives/DTESTDM001/p1773477181004799"
  );
});

test("permalink は threadTs がある場合 query を付ける", () => {
  assert.equal(
    deriveSlackPermalink({
      workspaceHost: "workspace-alpha.slack.com",
      channelId: "C123",
      messageTs: "1773477181.004799",
      threadTs: "1773477000.000001",
    }),
    "https://workspace-alpha.slack.com/archives/C123/p1773477181004799?thread_ts=1773477000.000001&cid=C123"
  );
});

test("notification fields は live 観測に近い raw_ws payload から派生できる", () => {
  const fields = deriveSlackNotificationFields(
    {
      type: "message",
      subtype: "bot_message",
      channel: "CTESTCHN02",
      text: "<@WTEST0002> テスト2",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "WTEST0002" },
                { type: "text", text: " テスト2" },
              ],
            },
          ],
        },
      ],
      bot_profile: { team_id: "TBA5B5CF8" },
      team: "TBA5B5CF8",
      event_ts: "1773482514.221889",
      ts: "1773482514.221889",
    },
    {
      selfUserIds: ["U1SELF123", "WTEST0002"],
      workspaceHost: "app.slack.com",
    }
  );

  assert.equal(fields.teamId, "TBA5B5CF8");
  assert.equal(fields.channelId, "CTESTCHN02");
  assert.equal(fields.messageTs, "1773482514.221889");
  assert.equal(fields.mentionTargetUserId, "WTEST0002");
  assert.equal(fields.isDirectMention, true);
  assert.equal(fields.permalink, "https://app.slack.com/archives/CTESTCHN02/p1773482514221889");
});

test("notification fields は team ごとの workspace host override を優先して permalink を生成する", () => {
  const fields = deriveSlackNotificationFields(
    {
      channel: "CTESTCHN01",
      team: "TTEAM0001",
      ts: "1773481739.636659",
      text: "<@UTEST0001> テスト",
    },
    {
      selfUserIds: ["UTEST0001"],
      workspaceHost: "app.slack.com",
      workspaceHostsByTeam: {
        TTEAM0001: "workspace-alpha.slack.com",
      },
    }
  );

  assert.equal(
    fields.permalink,
    "https://workspace-alpha.slack.com/archives/CTESTCHN01/p1773481739636659"
  );
});
