type JsonRecord = Record<string, unknown>;

export function sanitizeWorkspaceHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return new URL(value).host || undefined;
    }
  } catch {
    return undefined;
  }
  const normalized = value
    .replace(/^\/+|\/+$/g, "")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function deriveTeamIdFromPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return asString(
    findFirst(record, [
      ["team_id"],
      ["team"],
      ["bot_profile", "team_id"],
      ["message", "team_id"],
      ["message", "team"],
      ["entry", "item", "message", "team_id"],
      ["entry", "item", "message", "team"],
    ])
  );
}

export function deriveWorkspaceHostCandidateFromPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const directHost = asString(
    findFirst(record, [["urlInfo", "host"], ["urlInfo", "hostname"], ["host"]])
  );
  const fromDirect = normalizeHostCandidate(directHost);
  if (fromDirect) {
    return fromDirect;
  }

  const url = asString(findFirst(record, [["url"], ["slack_url"]]));
  if (!url) {
    return undefined;
  }
  try {
    return normalizeHostCandidate(new URL(url).host);
  } catch {
    return undefined;
  }
}

export function deriveTeamIdFromFetchPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const pathSegments = findFirst(record, [["urlInfo", "pathSegments"]]);
  if (Array.isArray(pathSegments) && pathSegments[0] === "cache") {
    const teamId = typeof pathSegments[1] === "string" ? pathSegments[1].trim() : "";
    if (teamId) {
      return teamId;
    }
  }

  const slackRoute = asString(findFirst(record, [["urlInfo", "query", "slack_route"]]));
  if (slackRoute) {
    return slackRoute;
  }

  const body = findFirst(record, [["body"]]);
  if (typeof body === "string") {
    const fromJson = parseBodyJson(body);
    const fromParsed = deriveTeamIdFromPayload(fromJson);
    if (fromParsed) {
      return fromParsed;
    }
  } else if (body && typeof body === "object") {
    const fromParsed = deriveTeamIdFromPayload(body);
    if (fromParsed) {
      return fromParsed;
    }
  }

  return deriveTeamIdFromPayload(payload);
}

export function resolveWorkspaceHostForTeam(input: {
  payload?: unknown;
  teamId?: string;
  workspaceHostsByTeam?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  fallbackHost?: string;
}): string | undefined {
  const teamId = input.teamId ?? deriveTeamIdFromPayload(input.payload);
  if (teamId) {
    const mapped = lookupWorkspaceHost(input.workspaceHostsByTeam, teamId);
    if (mapped) {
      return mapped;
    }
  }
  return sanitizeWorkspaceHost(input.fallbackHost);
}

export function maybeLearnWorkspaceHostFromFetchPayload(
  payload: unknown,
  workspaceHostsByTeam: Map<string, string>
): { teamId?: string; workspaceHost?: string; learned: boolean } {
  const teamId = deriveTeamIdFromFetchPayload(payload);
  const workspaceHost = deriveWorkspaceHostCandidateFromPayload(payload);
  if (!teamId || !workspaceHost) {
    return { teamId, workspaceHost, learned: false };
  }
  const current = workspaceHostsByTeam.get(teamId);
  if (current === workspaceHost) {
    return { teamId, workspaceHost, learned: false };
  }
  workspaceHostsByTeam.set(teamId, workspaceHost);
  return { teamId, workspaceHost, learned: true };
}

function lookupWorkspaceHost(
  source: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
  teamId: string
): string | undefined {
  if (!source) {
    return undefined;
  }
  if ("get" in source && typeof source.get === "function") {
    return sanitizeWorkspaceHost(source.get(teamId));
  }
  const record = source as Readonly<Record<string, string>>;
  return sanitizeWorkspaceHost(record[teamId]);
}

function normalizeHostCandidate(value: string | undefined): string | undefined {
  const host = sanitizeWorkspaceHost(value);
  if (!host) {
    return undefined;
  }
  if (!host.endsWith(".slack.com")) {
    return undefined;
  }
  if (host === "app.slack.com" || host === "edgeapi.slack.com" || host.startsWith("wss-")) {
    return undefined;
  }
  return host;
}

function parseBodyJson(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function findFirst(record: JsonRecord | undefined, paths: string[][]): unknown {
  for (const path of paths) {
    const value = getAtPath(record, path);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
