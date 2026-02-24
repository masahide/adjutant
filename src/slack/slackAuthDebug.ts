export type SlackAuthSignal = {
  detected: boolean;
  value: string | null;
  sources: string[];
};

export type SlackCookieDSignal = {
  present: boolean;
  value: string | null;
};

export type SlackAuthDebugInfo = {
  xoxc: SlackAuthSignal;
  xoxd: SlackAuthSignal;
  cookieD: SlackCookieDSignal;
};

type ExtractSlackAuthDebugInfoInput = {
  headers?: Record<string, string>;
  body?: string;
};

const XOXC_TOKEN_RE = /xoxc-[A-Za-z0-9-]+/i;
const XOXD_TOKEN_RE = /xoxd-[A-Za-z0-9%+._~-]+/i;

const createSignal = (): SlackAuthSignal => ({
  detected: false,
  value: null,
  sources: [],
});

const findHeaderValue = (
  headers: Record<string, string> | undefined,
  name: string
): string | undefined => {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
};

const pushSource = (target: SlackAuthSignal, source: string): void => {
  if (!target.sources.includes(source)) {
    target.sources.push(source);
  }
};

const detectToken = (
  signal: SlackAuthSignal,
  value: string | undefined,
  regex: RegExp,
  source: string
): void => {
  if (!value) return;
  const match = value.match(regex);
  if (!match || !match[0]) return;
  signal.detected = true;
  if (!signal.value) {
    signal.value = match[0];
  }
  pushSource(signal, source);
};

const extractCookieValue = (cookieHeader: string | undefined, key: string): string | undefined => {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";").map((item) => item.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== key) continue;
    return part.slice(idx + 1).trim();
  }
  return undefined;
};

export const extractSlackAuthDebugInfo = (
  input: ExtractSlackAuthDebugInfoInput
): SlackAuthDebugInfo => {
  const xoxc = createSignal();
  const xoxd = createSignal();
  const cookieD: SlackCookieDSignal = {
    present: false,
    value: null,
  };

  for (const [headerName, headerValue] of Object.entries(input.headers ?? {})) {
    if (!headerValue) continue;
    const source = `header:${headerName.toLowerCase()}`;
    detectToken(xoxc, headerValue, XOXC_TOKEN_RE, source);
    detectToken(xoxd, headerValue, XOXD_TOKEN_RE, source);
  }

  const cookieHeader = findHeaderValue(input.headers, "cookie");
  const dCookieValue = extractCookieValue(cookieHeader, "d");
  if (dCookieValue) {
    cookieD.present = true;
    cookieD.value = dCookieValue;
    detectToken(xoxd, dCookieValue, XOXD_TOKEN_RE, "cookie:d");
  }

  detectToken(xoxc, input.body, XOXC_TOKEN_RE, "body");
  detectToken(xoxd, input.body, XOXD_TOKEN_RE, "body");

  return { xoxc, xoxd, cookieD };
};

export const enrichSlackAuthDebugWithCookieD = (
  info: SlackAuthDebugInfo,
  dCookieValue: string,
  source = "cookie:d"
): SlackAuthDebugInfo => {
  if (!dCookieValue) return info;
  const next: SlackAuthDebugInfo = {
    xoxc: {
      detected: info.xoxc.detected,
      value: info.xoxc.value,
      sources: [...info.xoxc.sources],
    },
    xoxd: {
      detected: info.xoxd.detected,
      value: info.xoxd.value,
      sources: [...info.xoxd.sources],
    },
    cookieD: {
      present: true,
      value: dCookieValue,
    },
  };

  detectToken(next.xoxd, dCookieValue, XOXD_TOKEN_RE, source);
  return next;
};
