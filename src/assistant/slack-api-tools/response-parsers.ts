export type JsonRecord = Record<string, unknown>;

export type SlackApiSchemaDiagnostic = {
  endpoint: string;
  requiredKey: string;
  actualType: string;
};

export class SlackApiSchemaError extends Error {
  readonly endpoint: string;
  readonly requiredKey: string;
  readonly actualType: string;

  constructor(input: SlackApiSchemaDiagnostic) {
    super(
      `schema mismatch endpoint=${input.endpoint} key=${input.requiredKey} actual=${input.actualType}`
    );
    this.name = "SlackApiSchemaError";
    this.endpoint = input.endpoint;
    this.requiredKey = input.requiredKey;
    this.actualType = input.actualType;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeType(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function throwSchemaError(endpoint: string, requiredKey: string, actual: unknown): never {
  throw new SlackApiSchemaError({
    endpoint,
    requiredKey,
    actualType: describeType(actual),
  });
}

function requireArray(endpoint: string, key: string, value: unknown): unknown[] {
  const array = asArray(value);
  if (!array) {
    throwSchemaError(endpoint, key, value);
  }
  return array;
}

function requireRecord(endpoint: string, key: string, value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) {
    throwSchemaError(endpoint, key, value);
  }
  return record;
}

function optionalArray(endpoint: string, key: string, value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  const array = asArray(value);
  if (!array) {
    throwSchemaError(endpoint, key, value);
  }
  return array;
}

export function parseUsersList(payload: JsonRecord): {
  members: unknown[];
  nextCursor?: string;
} {
  const endpoint = "users.list";
  const members = requireArray(endpoint, "members", payload.members);
  const responseMetadata = asRecord(payload.response_metadata);
  const nextCursor = asString(responseMetadata?.next_cursor);
  return {
    members,
    nextCursor,
  };
}

export function parseUserInfo(payload: JsonRecord): {
  user: JsonRecord;
} {
  const endpoint = "users.info";
  return {
    user: requireRecord(endpoint, "user", payload.user),
  };
}

export function parseConversationsList(payload: JsonRecord): {
  channels: unknown[];
  nextCursor?: string;
} {
  const endpoint = "conversations.list";
  const channels = requireArray(endpoint, "channels", payload.channels);
  const responseMetadata = asRecord(payload.response_metadata);
  const nextCursor = asString(responseMetadata?.next_cursor);
  return {
    channels,
    nextCursor,
  };
}

export function parseConversationInfo(payload: JsonRecord): {
  channel: JsonRecord;
} {
  const endpoint = "conversations.info";
  return {
    channel: requireRecord(endpoint, "channel", payload.channel),
  };
}

export function parseConversationsGenericInfo(payload: JsonRecord): {
  channels: unknown[];
  unchangedChannelIds: unknown[];
} {
  const endpoint = "conversations.genericInfo";
  return {
    channels: requireArray(endpoint, "channels", payload.channels),
    unchangedChannelIds: optionalArray(
      endpoint,
      "unchanged_channel_ids",
      payload.unchanged_channel_ids
    ),
  };
}

export function parseSearchMessages(payload: JsonRecord): {
  matches: unknown[];
  pagination: JsonRecord | null;
} {
  const endpoint = "search.messages";
  const messages = requireRecord(endpoint, "messages", payload.messages);
  const matches = requireArray(endpoint, "messages.matches", messages.matches);
  return {
    matches,
    pagination: asRecord(messages.pagination),
  };
}

export function parseSearchModulesChannels(payload: JsonRecord): {
  items: unknown[];
  nextCursor?: string;
} {
  const endpoint = "search.modules.channels";
  const items = requireArray(endpoint, "items", payload.items);
  const pagination = asRecord(payload.pagination);
  const nextCursor = asString(pagination?.next_cursor);
  return {
    items,
    nextCursor,
  };
}

export function parseImList(payload: JsonRecord): {
  ims: unknown[];
  nextCursor?: string;
} {
  const endpoint = "im.list";
  const ims = requireArray(endpoint, "ims", payload.ims);
  const responseMetadata = asRecord(payload.response_metadata);
  const nextCursor = asString(responseMetadata?.next_cursor);
  return {
    ims,
    nextCursor,
  };
}

export function parseClientCounts(payload: JsonRecord): {
  mpims: unknown[];
  channels: unknown[];
  ims: unknown[];
} {
  const endpoint = "client.counts";
  return {
    mpims: requireArray(endpoint, "mpims", payload.mpims),
    channels: optionalArray(endpoint, "channels", payload.channels),
    ims: optionalArray(endpoint, "ims", payload.ims),
  };
}

export function parsePostMessage(payload: JsonRecord): {
  channel: string;
  ts: string;
} {
  const endpoint = "chat.postMessage";
  const channel = asString(payload.channel);
  if (!channel) {
    throwSchemaError(endpoint, "channel", payload.channel);
  }

  const message = asRecord(payload.message);
  const ts = asString(payload.ts) ?? asString(message?.ts);
  if (!ts) {
    throwSchemaError(endpoint, "ts|message.ts", {
      ts: payload.ts,
      messageTs: message?.ts,
    });
  }

  return {
    channel,
    ts,
  };
}

export function parseClientUserBoot(payload: JsonRecord): {
  channels: unknown[];
  ims: unknown[];
} {
  const endpoint = "client.userBoot";
  return {
    channels: requireArray(endpoint, "channels", payload.channels),
    ims: optionalArray(endpoint, "ims", payload.ims),
  };
}
