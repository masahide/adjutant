import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlackRouteClient,
  SlackRouteError,
  type SlackBrowserApiCallInput,
  type SlackBrowserApiCallResult,
  type SlackMode,
} from "../../../src/assistant/slack-api-tools/index.js";

type BrowserCall = {
  endpoint: string;
  mode: SlackMode;
  params: Record<string, string | undefined>;
};

function createClient(input: {
  mode: SlackMode;
  authTest?: {
    teamId?: string;
    enterpriseId?: string;
    url?: string;
    userId?: string;
  };
  invoke: (call: SlackBrowserApiCallInput) => Promise<SlackBrowserApiCallResult>;
}): {
  client: SlackRouteClient;
  calls: BrowserCall[];
} {
  const calls: BrowserCall[] = [];
  const client = new SlackRouteClient({
    mode: input.mode,
    authProvider: {
      resolve: () => ({
        xoxcToken: "xoxc-test",
        xoxdToken: "xoxd-test",
        workspaceKey: "TTEST",
        authTest: input.authTest,
        defaultHeaders: {
          Authorization: "Bearer xoxc-test",
          Cookie: "d=xoxd-test",
        },
      }),
    },
    browserInvoker: async (call) => {
      calls.push({
        endpoint: call.endpoint,
        mode: call.mode,
        params: { ...call.params },
      });
      return input.invoke(call);
    },
  });
  return { client, calls };
}

function ok(payload: unknown): SlackBrowserApiCallResult {
  return { status: 200, payload: { ok: true, ...(payload as object) } };
}

describe("SlackRouteClient contract", () => {
  it("Enterprise channels_list は順次フローで呼び出し、重複排除と archived 除外を行う", async () => {
    const { client, calls } = createClient({
      mode: "enterprise",
      authTest: { teamId: "TTEAM", enterpriseId: "EENTER" },
      invoke: async (call) => {
        if (call.endpoint === "client.userBoot") {
          return ok({
            channels: [
              { id: "C001", name: "general", is_archived: false },
              { id: "C999", name: "archived", is_archived: true },
            ],
            ims: [],
          });
        }
        if (call.endpoint === "im.list") {
          return ok({
            ims: [{ id: "D001", user: "U001", is_im: true, is_archived: false }],
            response_metadata: { next_cursor: "" },
          });
        }
        if (call.endpoint === "search.modules.channels") {
          return ok({
            items: [
              { id: "C001", name: "general", is_archived: false },
              { id: "C002", name: "eng", is_archived: false },
            ],
            pagination: { next_cursor: "" },
          });
        }
        if (call.endpoint === "client.counts") {
          return ok({
            channels: [{ id: "C003", name: "ops", is_archived: false }],
            ims: [{ id: "D001", user: "U001", is_im: true, is_archived: false }],
            mpims: [{ id: "G001" }, { id: "C002" }],
          });
        }
        if (call.endpoint === "conversations.genericInfo") {
          assert.equal(typeof call.params.updated_channels, "string");
          assert.deepEqual(JSON.parse(call.params.updated_channels as string), { G001: 0 });
          return ok({
            channels: [
              { id: "G001", name: "mpim-1", is_mpim: true, is_archived: false },
              { id: "C999", name: "archived", is_archived: true },
            ],
            unchanged_channel_ids: [],
          });
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    });

    const channels = await client.listChannels("TTEAM");
    assert.deepEqual(
      channels.map((channel) => channel.id),
      ["C001", "D001", "C002", "C003", "G001"]
    );
    assert.deepEqual(
      calls.map((call) => call.endpoint),
      [
        "client.userBoot",
        "im.list",
        "search.modules.channels",
        "client.counts",
        "conversations.genericInfo",
      ]
    );
  });

  it("Non-Enterprise channels_list は conversations.list 契約で取得する", async () => {
    const { client, calls } = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint !== "conversations.list") {
          throw new Error(`unexpected endpoint: ${call.endpoint}`);
        }
        return ok({
          channels: [{ id: "C001", name: "general", is_archived: false }],
          response_metadata: { next_cursor: "" },
        });
      },
    });

    const channels = await client.listChannels("TTEAM");
    assert.equal(channels.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endpoint, "conversations.list");
    assert.equal(calls[0]?.params.types, "public_channel,private_channel,im,mpim");
    assert.equal(calls[0]?.params.limit, "200");
    assert.equal(calls[0]?.params.exclude_archived, "true");
  });

  it("search_messages は search.messages(query,count,page) 契約を使う", async () => {
    const { client, calls } = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint !== "search.messages") {
          throw new Error(`unexpected endpoint: ${call.endpoint}`);
        }
        return ok({
          messages: {
            matches: [{ channel: { id: "C001" }, ts: "1.23", text: "hello" }],
          },
        });
      },
    });

    const result = await client.searchMessages("hello", 25, "TTEAM");
    assert.equal(result.messages.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.params.query, "hello");
    assert.equal(calls[0]?.params.count, "25");
    assert.equal(calls[0]?.params.page, "1");
    assert.equal(calls[0]?.params.sort, undefined);
    assert.equal(calls[0]?.params.sort_dir, undefined);
  });

  it("post_message は as_user を送らず message.ts フォールバックで ts を解決する", async () => {
    const { client, calls } = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint !== "chat.postMessage") {
          throw new Error(`unexpected endpoint: ${call.endpoint}`);
        }
        return ok({
          channel: "C001",
          message: { ts: "1710000000.000200", text: "done" },
        });
      },
    });

    const result = await client.postMessage("C001", "done", "TTEAM");
    assert.equal(result.channelId, "C001");
    assert.equal(result.ts, "1710000000.000200");
    assert.equal(calls[0]?.params.as_user, undefined);
  });

  it("必須キー欠落時は api_error として endpoint/key/type が識別できる", async () => {
    const { client } = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint === "users.list") {
          return ok({ response_metadata: { next_cursor: "" } });
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    });

    await assert.rejects(
      async () => client.listUsers("TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.kind, "api_error");
        assert.equal(routeError.slackError, "schema_mismatch");
        assert.equal(routeError.message.includes("endpoint=users.list"), true);
        assert.equal(routeError.message.includes("key=members"), true);
        return true;
      }
    );
  });

  it("Enterprise フローの必須キー欠落(client.counts.mpims)も api_error 化する", async () => {
    const { client } = createClient({
      mode: "enterprise",
      authTest: { teamId: "TTEAM", enterpriseId: "EENTER" },
      invoke: async (call) => {
        if (call.endpoint === "client.userBoot") {
          return ok({ channels: [], ims: [] });
        }
        if (call.endpoint === "im.list") {
          return ok({ ims: [], response_metadata: { next_cursor: "" } });
        }
        if (call.endpoint === "search.modules.channels") {
          return ok({ items: [], pagination: { next_cursor: "" } });
        }
        if (call.endpoint === "client.counts") {
          return ok({ channels: [], ims: [] });
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    });

    await assert.rejects(
      async () => client.listChannels("TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.kind, "api_error");
        assert.equal(routeError.slackError, "schema_mismatch");
        assert.equal(routeError.message.includes("endpoint=client.counts"), true);
        assert.equal(routeError.message.includes("key=mpims"), true);
        return true;
      }
    );
  });

  it("その他 endpoint の必須キー欠落も api_error 化する", async () => {
    const usersInfoClient = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint === "users.info") {
          return ok({});
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    }).client;
    await assert.rejects(
      async () => usersInfoClient.getUserInfo("U001", "TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.message.includes("endpoint=users.info"), true);
        assert.equal(routeError.message.includes("key=user"), true);
        return true;
      }
    );

    const conversationInfoClient = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint === "conversations.info") {
          return ok({});
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    }).client;
    await assert.rejects(
      async () => conversationInfoClient.getChannelInfo("C001", "TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.message.includes("endpoint=conversations.info"), true);
        assert.equal(routeError.message.includes("key=channel"), true);
        return true;
      }
    );

    const searchMessagesClient = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint === "search.messages") {
          return ok({ messages: {} });
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    }).client;
    await assert.rejects(
      async () => searchMessagesClient.searchMessages("hello", 20, "TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.message.includes("endpoint=search.messages"), true);
        assert.equal(routeError.message.includes("key=messages.matches"), true);
        return true;
      }
    );

    const postMessageClient = createClient({
      mode: "team",
      authTest: { teamId: "TTEAM" },
      invoke: async (call) => {
        if (call.endpoint === "chat.postMessage") {
          return ok({ ts: "1.23" });
        }
        throw new Error(`unexpected endpoint: ${call.endpoint}`);
      },
    }).client;
    await assert.rejects(
      async () => postMessageClient.postMessage("C001", "hello", "TTEAM"),
      (error: unknown) => {
        assert.equal(error instanceof SlackRouteError, true);
        const routeError = error as SlackRouteError;
        assert.equal(routeError.message.includes("endpoint=chat.postMessage"), true);
        assert.equal(routeError.message.includes("key=channel"), true);
        return true;
      }
    );
  });
});
