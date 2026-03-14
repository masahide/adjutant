import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTeamIdFromFetchPayload,
  deriveWorkspaceHostCandidateFromPayload,
  maybeLearnWorkspaceHostFromFetchPayload,
  resolveWorkspaceHostForTeam,
} from "../../../src/collector-slack/workspace-host-resolver.js";

test("fetch payload から teamId を query.slack_route で抽出できる", () => {
  assert.equal(
    deriveTeamIdFromFetchPayload({
      urlInfo: {
        query: {
          slack_route: "TTEAM0001",
        },
      },
    }),
    "TTEAM0001"
  );
});

test("fetch payload から workspace host 候補を抽出できる", () => {
  assert.equal(
    deriveWorkspaceHostCandidateFromPayload({
      urlInfo: {
        host: "workspace-alpha.slack.com",
      },
    }),
    "workspace-alpha.slack.com"
  );
});

test("edgeapi と app.slack.com は canonical host 候補にしない", () => {
  assert.equal(
    deriveWorkspaceHostCandidateFromPayload({
      urlInfo: {
        host: "edgeapi.slack.com",
      },
    }),
    undefined
  );
  assert.equal(
    deriveWorkspaceHostCandidateFromPayload({
      urlInfo: {
        host: "app.slack.com",
      },
    }),
    undefined
  );
});

test("raw_fetch から teamId -> workspaceHost を学習できる", () => {
  const hosts = new Map<string, string>();
  const result = maybeLearnWorkspaceHostFromFetchPayload(
    {
      urlInfo: {
        host: "workspace-alpha.slack.com",
        query: {
          slack_route: "TTEAM0001",
        },
      },
    },
    hosts
  );

  assert.equal(result.learned, true);
  assert.equal(hosts.get("TTEAM0001"), "workspace-alpha.slack.com");
});

test("workspace host は team ごとの learned host を優先し、無ければ fallback を返す", () => {
  const hosts = new Map<string, string>([["TTEAM0001", "workspace-alpha.slack.com"]]);

  assert.equal(
    resolveWorkspaceHostForTeam({
      teamId: "TTEAM0001",
      workspaceHostsByTeam: hosts,
      fallbackHost: "app.slack.com",
    }),
    "workspace-alpha.slack.com"
  );

  assert.equal(
    resolveWorkspaceHostForTeam({
      teamId: "TBA5B5CF8",
      workspaceHostsByTeam: hosts,
      fallbackHost: "app.slack.com",
    }),
    "app.slack.com"
  );
});
