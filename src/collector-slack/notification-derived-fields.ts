import {
  deriveTeamIdFromPayload,
  maybeLearnWorkspaceHostFromFetchPayload,
  resolveWorkspaceHostForTeam,
  sanitizeWorkspaceHost as sanitizeWorkspaceHostInternal,
} from "./workspace-host-resolver.js";

type JsonRecord = Record<string, unknown>;

export type DeriveSlackNotificationFieldsOptions = {
  selfUserId?: string;
  selfUserIds?: readonly string[];
  workspaceHost?: string;
  workspaceHostsByTeam?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
};

export type DerivedSlackNotificationFields = {
  teamId?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  messageText?: string;
  mentionTargetUserIds: string[];
  mentionTargetUserId?: string;
  isDirectMention?: boolean;
  permalink?: string;
};

export function deriveSlackNotificationFields(
  payload: unknown,
  options: DeriveSlackNotificationFieldsOptions = {}
): DerivedSlackNotificationFields {
  const record = asRecord(payload);
  const blocks = findFirst(record, [
    ["blocks"],
    ["message", "blocks"],
    ["item", "message", "blocks"],
    ["entry", "item", "message", "blocks"],
  ]);
  const textCandidates = [
    asString(findFirst(record, [["text"]])),
    asString(findFirst(record, [["body"]])),
    asString(findFirst(record, [["message_text"]])),
    asString(findFirst(record, [["message"]])),
    asString(findFirst(record, [["preview"]])),
    fromBlocks(blocks),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const messageText = textCandidates[0];

  const mentionTargetUserIds = extractMentionTargetUserIds(payload);
  const mentionTargetUserId = mentionTargetUserIds[0];
  const explicitIsDirectMention = findBoolean(record, [
    ["is_direct_mention"],
    ["entry", "item", "is_direct_mention"],
  ]);
  const isDirectMention =
    explicitIsDirectMention ??
    deriveIsDirectMention(
      mentionTargetUserIds,
      options.selfUserIds ?? ([options.selfUserId].filter(Boolean) as string[])
    );

  const channelId = asString(
    findFirst(record, [
      ["channel_id"],
      ["channel"],
      ["message", "channel"],
      ["item", "message", "channel"],
      ["entry", "item", "message", "channel"],
    ])
  );
  const messageTs = deriveMessageTs(payload);
  const threadTs = deriveThreadTs(payload);
  const teamId = deriveTeamIdFromPayload(payload);
  const permalink =
    asString(findFirst(record, [["permalink"]])) ??
    deriveSlackPermalink({
      workspaceHost: resolveWorkspaceHostForTeam({
        payload,
        teamId,
        workspaceHostsByTeam: options.workspaceHostsByTeam,
        fallbackHost: options.workspaceHost,
      }),
      channelId,
      messageTs,
      threadTs,
    });

  return {
    teamId,
    channelId,
    messageTs,
    threadTs,
    messageText,
    mentionTargetUserIds,
    mentionTargetUserId,
    isDirectMention,
    permalink,
  };
}

export function deriveMessageTs(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return asString(
    findFirst(record, [
      ["message_ts"],
      ["ts"],
      ["message", "ts"],
      ["item", "message", "ts"],
      ["entry", "item", "message", "ts"],
    ])
  );
}

export function deriveThreadTs(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return asString(
    findFirst(record, [
      ["thread_ts"],
      ["message", "thread_ts"],
      ["item", "message", "thread_ts"],
      ["entry", "item", "message", "thread_ts"],
    ])
  );
}

export function extractMentionTargetUserIds(payload: unknown): string[] {
  const record = asRecord(payload);
  const blocksCandidates = [
    findFirst(record, [["blocks"]]),
    findFirst(record, [["message", "blocks"]]),
    findFirst(record, [["item", "message", "blocks"]]),
    findFirst(record, [["entry", "item", "message", "blocks"]]),
  ];
  const ids = new Set<string>();

  for (const blocks of blocksCandidates) {
    for (const userId of extractMentionTargetUserIdsFromBlocks(blocks)) {
      ids.add(userId);
    }
  }

  const textCandidates = [
    asString(findFirst(record, [["text"]])),
    asString(findFirst(record, [["body"]])),
    asString(findFirst(record, [["message_text"]])),
    asString(findFirst(record, [["message"]])),
    asString(findFirst(record, [["preview"]])),
    fromBlocks(blocksCandidates[0]),
  ];
  for (const text of textCandidates) {
    if (!text) {
      continue;
    }
    for (const userId of extractMentionTargetUserIdsFromText(text)) {
      ids.add(userId);
    }
  }

  return Array.from(ids);
}

export function extractMentionTargetUserIdsFromText(text: string): string[] {
  const matches = text.matchAll(/<@([A-Z0-9]+)>/g);
  const ids = new Set<string>();
  for (const match of matches) {
    const userId = match[1];
    if (userId) {
      ids.add(userId);
    }
  }
  return Array.from(ids);
}

export function extractMentionTargetUserIdsFromBlocks(blocks: unknown): string[] {
  const ids = new Set<string>();
  visitNodes(blocks, (node) => {
    if (node.type === "user") {
      const userId = asString(node.user_id);
      if (userId) {
        ids.add(userId);
      }
    }
  });
  return Array.from(ids);
}

export function deriveIsDirectMention(
  mentionTargetUserIds: readonly string[],
  selfUserIds?: readonly string[]
): boolean | undefined {
  if (mentionTargetUserIds.length === 0) {
    return false;
  }
  const normalizedSelfUserIds = (selfUserIds ?? []).filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (normalizedSelfUserIds.length === 0) {
    return undefined;
  }
  return mentionTargetUserIds.some((userId) => normalizedSelfUserIds.includes(userId));
}

export function deriveSlackPermalink(input: {
  workspaceHost?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
}): string | undefined {
  const workspaceHost = sanitizeWorkspaceHost(input.workspaceHost);
  if (!workspaceHost || !input.channelId || !input.messageTs) {
    return undefined;
  }
  const normalizedTs = input.messageTs.replace(/\./g, "");
  if (!/^\d+$/.test(normalizedTs)) {
    return undefined;
  }
  const url = new URL(`https://${workspaceHost}/archives/${input.channelId}/p${normalizedTs}`);
  if (input.threadTs) {
    url.searchParams.set("thread_ts", input.threadTs);
    url.searchParams.set("cid", input.channelId);
  }
  return url.toString();
}

export function sanitizeWorkspaceHost(value: string | undefined): string | undefined {
  return sanitizeWorkspaceHostInternal(value);
}

export {
  deriveTeamIdFromPayload,
  maybeLearnWorkspaceHostFromFetchPayload,
  resolveWorkspaceHostForTeam,
};

function findFirst(record: JsonRecord | undefined, paths: string[][]): unknown {
  for (const path of paths) {
    const value = getAtPath(record, path);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function findBoolean(record: JsonRecord | undefined, paths: string[][]): boolean | undefined {
  const value = findFirst(record, paths);
  return typeof value === "boolean" ? value : undefined;
}

function getAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonRecord)[key];
  }
  return current;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fromBlocks(blocks: unknown): string | undefined {
  const texts: string[] = [];
  visitNodes(blocks, (node) => {
    if (node.type === "text") {
      const text = asString(node.text);
      if (text) {
        texts.push(text);
      }
    }
  });
  return texts.length > 0 ? texts.join("") : undefined;
}

function visitNodes(value: unknown, visitor: (node: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitNodes(item, visitor);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as JsonRecord;
  visitor(record);
  for (const child of Object.values(record)) {
    visitNodes(child, visitor);
  }
}
