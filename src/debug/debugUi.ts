import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SlackIdentityProbe, type SlackRequestWillBeSentPayload } from "./slackIdentityProbe.js";

export type DebugUiEvent = {
  source: string;
  kind: string;
  at: string;
  payload: unknown;
};

type DebugUiServerOptions = {
  port: number;
  host?: string;
  maxEvents?: number;
  channelCachePath?: string;
  userCachePath?: string;
  runSlackAuthTestViaCdp?: (input: { workspaceKey?: string }) => Promise<unknown>;
  runSlackChannelsListViaCdp?: (input: { workspaceKey?: string }) => Promise<unknown>;
  listSlackWorkspaces?: () =>
    | Promise<Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>>
    | Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>;
};

type SseClient = {
  id: number;
  res: ServerResponse<IncomingMessage>;
};

const DEFAULT_MAX_EVENTS = 500;
const MAX_JSON_BODY_BYTES = 1_000_000;

export class DebugUiServer {
  private readonly port: number;
  private readonly host: string;
  private readonly maxEvents: number;
  private readonly events: DebugUiEvent[] = [];
  private readonly slackIdentityProbe: SlackIdentityProbe;
  private runSlackAuthTestViaCdp?: (input: { workspaceKey?: string }) => Promise<unknown>;
  private runSlackChannelsListViaCdp?: (input: { workspaceKey?: string }) => Promise<unknown>;
  private listSlackWorkspaces?: () =>
    | Promise<Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>>
    | Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>;
  private readonly clients = new Map<number, SseClient>();
  private nextClientId = 1;
  private server = createServer((req, res) => this.handleRequest(req, res));

  constructor(options: DebugUiServerOptions) {
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.slackIdentityProbe = new SlackIdentityProbe({
      channelCachePath: options.channelCachePath,
      userCachePath: options.userCachePath,
    });
    this.runSlackAuthTestViaCdp = options.runSlackAuthTestViaCdp;
    this.runSlackChannelsListViaCdp = options.runSlackChannelsListViaCdp;
    this.listSlackWorkspaces = options.listSlackWorkspaces;
  }

  setSlackAuthTestExecutor(runner?: (input: { workspaceKey?: string }) => Promise<unknown>): void {
    this.runSlackAuthTestViaCdp = runner;
  }

  setSlackChannelsListExecutor(
    runner?: (input: { workspaceKey?: string }) => Promise<unknown>
  ): void {
    this.runSlackChannelsListViaCdp = runner;
  }

  setSlackWorkspaceListProvider(
    provider?: () =>
      | Promise<
          Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>
        >
      | Array<{ workspaceKey: string; label?: string; hasXoxc?: boolean; hasXoxd?: boolean }>
  ): void {
    this.listSlackWorkspaces = provider;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  record(event: DebugUiEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    const encoded = this.toSseData(event);
    for (const client of this.clients.values()) {
      client.res.write(encoded);
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    if (url.pathname === "/api/slack/resolve-identities") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
        return;
      }
      void this.handleSlackIdentityProbeRequest(req, res);
      return;
    }
    if (url.pathname === "/api/slack/auth-test-via-cdp") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
        return;
      }
      void this.handleSlackAuthTestViaCdpRequest(req, res);
      return;
    }
    if (url.pathname === "/api/slack/workspaces") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
        return;
      }
      void this.handleSlackWorkspaceListRequest(res);
      return;
    }
    if (url.pathname === "/api/slack/channels-list-via-cdp") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
        return;
      }
      void this.handleSlackChannelsListViaCdpRequest(req, res);
      return;
    }
    if (url.pathname === "/events") {
      this.handleEvents(res);
      return;
    }
    if (url.pathname === "/snapshot") {
      this.writeJson(res, { events: this.events });
      return;
    }
    if (url.pathname === "/healthz") {
      this.writeJson(res, { ok: true });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(this.renderHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  private handleEvents(res: ServerResponse<IncomingMessage>): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    for (const event of this.events) {
      res.write(this.toSseData(event));
    }
    const id = this.nextClientId++;
    this.clients.set(id, { id, res });
    res.on("close", () => {
      this.clients.delete(id);
    });
  }

  private toSseData(event: DebugUiEvent): string {
    return `event: debug\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private async handleSlackIdentityProbeRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    try {
      const raw = await this.readRequestBody(req, MAX_JSON_BODY_BYTES);
      const parsed = this.parseJsonObject(raw);
      if (!parsed) {
        this.writeJsonWithStatus(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const requestPayload = this.asRecord(parsed.request);
      if (!requestPayload) {
        this.writeJsonWithStatus(res, 400, { ok: false, error: "request_required" });
        return;
      }

      const probeInput: SlackRequestWillBeSentPayload = {
        requestId: this.asString(requestPayload.requestId),
        method: this.asString(requestPayload.method),
        url: this.asString(requestPayload.url),
        contentType: this.asString(requestPayload.contentType),
        body: requestPayload.body,
      };
      const result = await this.slackIdentityProbe.resolve(probeInput);
      this.writeJsonWithStatus(res, 200, { ok: true, result });
    } catch (error) {
      this.writeJsonWithStatus(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "probe_failed",
      });
    }
  }

  private async handleSlackAuthTestViaCdpRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    if (!this.runSlackAuthTestViaCdp) {
      this.writeJsonWithStatus(res, 503, {
        ok: false,
        error: "cdp_auth_test_executor_unavailable",
      });
      return;
    }
    try {
      const raw = await this.readRequestBody(req, MAX_JSON_BODY_BYTES);
      const parsed = raw.trim().length > 0 ? this.parseJsonObject(raw) : {};
      if (parsed === null) {
        this.writeJsonWithStatus(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const workspaceKey = this.asString(parsed.workspaceKey);
      const result = await this.runSlackAuthTestViaCdp({ workspaceKey });
      this.writeJsonWithStatus(res, 200, { ok: true, result });
    } catch (error) {
      this.writeJsonWithStatus(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "cdp_auth_test_failed",
      });
    }
  }

  private async handleSlackChannelsListViaCdpRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    if (!this.runSlackChannelsListViaCdp) {
      this.writeJsonWithStatus(res, 503, {
        ok: false,
        error: "cdp_channels_list_executor_unavailable",
      });
      return;
    }
    try {
      const raw = await this.readRequestBody(req, MAX_JSON_BODY_BYTES);
      const parsed = raw.trim().length > 0 ? this.parseJsonObject(raw) : {};
      if (parsed === null) {
        this.writeJsonWithStatus(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const workspaceKey = this.asString(parsed.workspaceKey);
      const result = await this.runSlackChannelsListViaCdp({ workspaceKey });
      this.writeJsonWithStatus(res, 200, { ok: true, result });
    } catch (error) {
      this.writeJsonWithStatus(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "cdp_channels_list_failed",
      });
    }
  }

  private async handleSlackWorkspaceListRequest(
    res: ServerResponse<IncomingMessage>
  ): Promise<void> {
    if (!this.listSlackWorkspaces) {
      this.writeJsonWithStatus(res, 200, { ok: true, workspaces: [] });
      return;
    }
    try {
      const raw = await this.listSlackWorkspaces();
      const workspaces: Array<{
        workspaceKey: string;
        label?: string;
        hasXoxc: boolean;
        hasXoxd: boolean;
      }> = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        const workspaceKey = this.asTrimmedString(item?.workspaceKey);
        if (!workspaceKey) {
          continue;
        }
        workspaces.push({
          workspaceKey,
          label: this.asTrimmedString(item?.label),
          hasXoxc: item?.hasXoxc === true,
          hasXoxd: item?.hasXoxd === true,
        });
      }
      this.writeJsonWithStatus(res, 200, { ok: true, workspaces });
    } catch (error) {
      this.writeJsonWithStatus(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "workspace_list_failed",
      });
    }
  }

  private writeJson(res: ServerResponse<IncomingMessage>, value: unknown): void {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }

  private writeJsonWithStatus(
    res: ServerResponse<IncomingMessage>,
    status: number,
    value: unknown
  ): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }

  private async readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += part.length;
        if (size > maxBytes) {
          reject(new Error("payload_too_large"));
          req.destroy();
          return;
        }
        chunks.push(part);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
    return Buffer.concat(chunks).toString("utf8");
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private asTrimmedString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private renderHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Adjutant Debug UI</title>
  <style>
    :root { --bg:#0b1020; --fg:#dbe4ff; --muted:#93a4d1; --line:#253055; --ok:#3ddc97; --warn:#ffb020; --raw:#6aa8ff; --danger:#ff6b6b; --pane-width:420px; --pane-min-width:300px; --pane-max-width:760px; }
    * { box-sizing: border-box; }
    body { margin:0; height:100vh; overflow:hidden; display:flex; flex-direction:column; font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--fg); background:linear-gradient(180deg,#101833,#0b1020); }
    header { padding:12px 14px; border-bottom:1px solid var(--line); background:#0b1020; display:flex; gap:12px; align-items:center; z-index:2; }
    header strong { font-size:14px; }
    .muted { color:var(--muted); }
    main { flex:1; min-height:0; padding:10px 14px 12px; display:flex; flex-direction:column; overflow:hidden; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
    input, select, button { background:#101833; color:var(--fg); border:1px solid var(--line); padding:6px 8px; border-radius:6px; }
    button { cursor:pointer; }
    .layout { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 8px minmax(var(--pane-min-width), var(--pane-width)); gap:10px; overflow:hidden; }
    .left-pane { min-height:0; display:flex; flex-direction:column; overflow:hidden; }
    .pane-resizer { width:8px; min-height:0; border:1px solid var(--line); border-radius:6px; background:linear-gradient(180deg,#131c3e,#0f1633); cursor:col-resize; }
    .pane-resizer:focus-visible { outline:2px solid #7ba5ff; outline-offset:1px; }
    .right-pane { min-height:0; min-width:var(--pane-min-width); display:flex; flex-direction:column; border:1px solid var(--line); border-radius:8px; background:#101833; overflow:hidden; }
    .probe-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--line); background:#121c3f; font-size:12px; flex-wrap:wrap; }
    .probe-head > * { min-width:0; }
    .probe-head label { display:flex; align-items:center; gap:6px; flex:1 1 220px; }
    .probe-head button { white-space:nowrap; }
    #authWorkspaceSelect { width:100%; max-width:280px; min-width:0; }
    .probe-list { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding:10px; }
    .probe-item { border:1px solid var(--line); border-radius:6px; overflow:hidden; }
    .probe-meta { display:flex; gap:8px; align-items:center; padding:6px 8px; border-bottom:1px solid var(--line); background:#0f1737; font-size:12px; }
    .probe-body { padding:8px; display:flex; flex-direction:column; gap:6px; }
    .probe-pre { margin:0; padding:8px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; background:#0b1020; border:1px solid var(--line); border-radius:4px; }
    .probe-call { border:1px solid var(--line); border-radius:4px; padding:6px; background:#0d1430; }
    .probe-call-title { font-size:12px; margin-bottom:4px; }
    .status-ok { color:var(--ok); }
    .status-warn { color:var(--warn); }
    .status-error { color:var(--danger); }
    .probe-empty { color:var(--muted); padding:8px; }
    .list { display:flex; flex-direction:column; gap:8px; flex:1; min-height:0; overflow:auto; padding-right:4px; }
    .item { flex:0 0 auto; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .meta { display:flex; gap:10px; padding:8px 10px; background:#121c3f; border-bottom:1px solid var(--line); font-size:12px; align-items:center; }
    .tag { padding:1px 6px; border:1px solid var(--line); border-radius:999px; }
    .hint { color:var(--muted); font-size:12px; margin-bottom:8px; }
    .pause-on { border-color: var(--danger); color: var(--danger); }
    .copy-btn { margin-left:auto; font-size:12px; padding:4px 8px; }
    .kind-raw_ws { color:var(--raw); }
    .kind-raw_fetch { color:var(--warn); }
    .kind-normalized { color:var(--ok); }
    .tag-auth-on { color: var(--ok); border-color: rgba(61,220,151,.6); }
    .tag-auth-off { color: var(--muted); border-color: rgba(147,164,209,.5); }
    mark { background: #f6d365; color: #111; padding: 0 1px; border-radius: 2px; }
    pre { margin:0; padding:10px; white-space:pre-wrap; word-break:break-word; max-height:none; overflow:visible; }
    @media (max-width: 1280px) {
      .layout { grid-template-columns:minmax(0,1fr); }
      .pane-resizer { display:none; }
      .right-pane { max-height:260px; min-width:0; }
      #authWorkspaceSelect { max-width:100%; }
    }
  </style>
</head>
<body>
  <header>
    <strong>Adjutant Debug UI</strong>
    <span class="muted" id="status">connecting...</span>
  </header>
  <main>
    <div class="row">
      <label>kind:
        <select id="kindFilter">
          <option value="">all</option>
          <option value="raw_ws">raw_ws</option>
          <option value="raw_fetch">raw_fetch</option>
          <option value="normalized">normalized</option>
          <option value="lifecycle">lifecycle</option>
        </select>
      </label>
      <label>stage: <input id="stageFilter" placeholder="requestWillBeSent / responseReceived" /></label>
      <label>search: <input id="searchInput" placeholder="text filter" /></label>
      <label>exclude: <input id="excludeInput" value="type:pong, type:reconnect_url" placeholder="type:pong, type:reconnect_url, subtype:ping" /></label>
      <label><input id="excludeEnabled" type="checkbox" checked /> exclude on</label>
      <label>max: <input id="limitInput" type="number" min="10" max="5000" value="200" /></label>
      <button id="pauseBtn" type="button">pause</button>
      <button id="expandAllBtn" type="button">expand all</button>
      <button id="collapseAllBtn" type="button">collapse all</button>
      <button id="resetBtn" type="button">reset filters</button>
      <button id="clearBtn" type="button">clear</button>
    </div>
    <div class="hint" id="filterState"></div>
    <div class="layout" id="layoutRoot">
      <div class="left-pane">
        <div class="list" id="eventList"></div>
      </div>
      <div class="pane-resizer" id="paneResizer" role="separator" aria-label="Resize side pane" tabindex="0"></div>
      <aside class="right-pane" id="rightPane">
        <div class="probe-head">
          <strong>Probe Results</strong>
          <span class="muted" id="probeState">0 entries</span>
          <label class="muted">workspace:
            <select id="authWorkspaceSelect">
              <option value="">(auto latest)</option>
            </select>
          </label>
          <button id="refreshWorkspacesBtn" type="button">reload workspaces</button>
          <button id="authTestBtn" type="button">auth.test via CDP</button>
          <button id="channelsListBtn" type="button">channels.list x10 via CDP</button>
          <button id="clearProbeBtn" type="button">clear</button>
        </div>
        <div class="probe-list" id="probeList"></div>
      </aside>
    </div>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const listEl = document.getElementById("eventList");
    const kindFilterEl = document.getElementById("kindFilter");
    const stageFilterEl = document.getElementById("stageFilter");
    const searchInputEl = document.getElementById("searchInput");
    const excludeInputEl = document.getElementById("excludeInput");
    const excludeEnabledEl = document.getElementById("excludeEnabled");
    const limitInputEl = document.getElementById("limitInput");
    const pauseBtnEl = document.getElementById("pauseBtn");
    const expandAllBtnEl = document.getElementById("expandAllBtn");
    const collapseAllBtnEl = document.getElementById("collapseAllBtn");
    const resetBtnEl = document.getElementById("resetBtn");
    const clearBtnEl = document.getElementById("clearBtn");
    const filterStateEl = document.getElementById("filterState");
    const layoutRootEl = document.getElementById("layoutRoot");
    const rightPaneEl = document.getElementById("rightPane");
    const paneResizerEl = document.getElementById("paneResizer");
    const probeListEl = document.getElementById("probeList");
    const probeStateEl = document.getElementById("probeState");
    const authWorkspaceSelectEl = document.getElementById("authWorkspaceSelect");
    const refreshWorkspacesBtnEl = document.getElementById("refreshWorkspacesBtn");
    const authTestBtnEl = document.getElementById("authTestBtn");
    const channelsListBtnEl = document.getElementById("channelsListBtn");
    const clearProbeBtnEl = document.getElementById("clearProbeBtn");
    const events = [];
    const probeResults = [];
    const collapsedByRaw = new Set();
    let defaultCollapsed = false;
    let paused = false;
    let connected = false;
    let bufferedWhilePaused = 0;
    let resizingPane = false;
    let resizeStartX = 0;
    let resizeStartWidth = 420;
    const PANE_MIN_WIDTH = 300;
    const PANE_MAX_WIDTH = 760;

    const escapeHtml = (s) => String(s ?? "").replace(/[&<>]/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[ch]));
    const normalize = (s) => String(s ?? "").trim().toLowerCase();
    const parseSearchTerms = (value) =>
      String(value ?? "")
        .trim()
        .split(/\\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const asObject = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value;
    };
    const asAuthSignal = (value) => {
      const obj = asObject(value);
      if (!obj) return null;
      return {
        detected: obj.detected === true,
        value: typeof obj.value === "string" ? obj.value : "",
        sources: Array.isArray(obj.sources) ? obj.sources.map((v) => String(v)) : [],
      };
    };
    const asCookieSignal = (value) => {
      const obj = asObject(value);
      if (!obj) return null;
      return {
        present: obj.present === true,
        value: typeof obj.value === "string" ? obj.value : "",
      };
    };
    const renderAuthTag = (label, enabled, title) =>
      '<span class="tag ' + (enabled ? "tag-auth-on" : "tag-auth-off") + '" title="' + escapeHtml(title) + '">' +
      escapeHtml(label + ":" + (enabled ? "yes" : "no")) +
      "</span>";
    const buildAuthTags = (event) => {
      const payload = asObject(event?.payload);
      const auth = asObject(payload?.authDebug);
      if (!auth) return "";
      const xoxc = asAuthSignal(auth.xoxc);
      const xoxd = asAuthSignal(auth.xoxd);
      const cookieD = asCookieSignal(auth.cookieD);
      if (!xoxc && !xoxd && !cookieD) return "";
      const xoxcTitle = "xoxc source=" + (xoxc?.sources?.join(",") || "-") + " value=" + (xoxc?.value || "-");
      const xoxdTitle = "xoxd source=" + (xoxd?.sources?.join(",") || "-") + " value=" + (xoxd?.value || "-");
      const cookieTitle = "cookie d value=" + (cookieD?.value || "-");
      return [
        renderAuthTag("xoxc", Boolean(xoxc?.detected), xoxcTitle),
        renderAuthTag("xoxd", Boolean(xoxd?.detected), xoxdTitle),
        renderAuthTag("d", Boolean(cookieD?.present), cookieTitle),
      ].join("");
    };
    const applyHighlights = (rawText, terms) => {
      if (!terms || terms.length === 0) return escapeHtml(rawText);
      const source = String(rawText ?? "");
      const lower = source.toLowerCase();
      const sorted = [...new Set(terms.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
      if (sorted.length === 0) return escapeHtml(source);
      let out = "";
      let cursor = 0;
      while (cursor < source.length) {
        let bestIndex = -1;
        let bestTerm = "";
        for (const term of sorted) {
          const idx = lower.indexOf(term, cursor);
          if (idx < 0) continue;
          if (bestIndex < 0 || idx < bestIndex || (idx === bestIndex && term.length > bestTerm.length)) {
            bestIndex = idx;
            bestTerm = term;
          }
        }
        if (bestIndex < 0 || !bestTerm) {
          out += escapeHtml(source.slice(cursor));
          break;
        }
        if (bestIndex > cursor) {
          out += escapeHtml(source.slice(cursor, bestIndex));
        }
        out += "<mark>" + escapeHtml(source.slice(bestIndex, bestIndex + bestTerm.length)) + "</mark>";
        cursor = bestIndex + bestTerm.length;
      }
      return out;
    };

    const getByPath = (obj, path) => {
      if (!obj || typeof obj !== "object") return undefined;
      const keys = path.split(".").filter(Boolean);
      let cur = obj;
      for (const key of keys) {
        if (!cur || typeof cur !== "object" || !(key in cur)) return undefined;
        cur = cur[key];
      }
      return cur;
    };

    const parseExcludeRules = (value) =>
      value
        .split(/[,\\n;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((rule) => {
          const idx = rule.indexOf(":");
          if (idx <= 0) return { key: "", value: normalize(rule) };
          return {
            key: normalize(rule.slice(0, idx)),
            value: normalize(rule.slice(idx + 1)),
          };
        });

    const matchesExcludeRule = (ev, rule) => {
      if (!rule.value) return false;
      if (!rule.key) {
        return JSON.stringify(ev).toLowerCase().includes(rule.value);
      }
      const candidates = [];
      if (rule.key === "kind" || rule.key === "source" || rule.key === "at") {
        candidates.push(ev[rule.key]);
      }
      const fromEvent = getByPath(ev, rule.key);
      if (fromEvent !== undefined) candidates.push(fromEvent);
      const fromPayloadPath = getByPath(ev.payload, rule.key);
      if (fromPayloadPath !== undefined) candidates.push(fromPayloadPath);

      return candidates.some((v) => normalize(v) === rule.value);
    };

    const updateStatus = () => {
      if (!connected) {
        statusEl.textContent = "disconnected";
        return;
      }
      if (paused) {
        statusEl.textContent =
          bufferedWhilePaused > 0 ? "paused (" + bufferedWhilePaused + " buffered)" : "paused";
        return;
      }
      statusEl.textContent = "connected";
    };

    const setPaused = (next) => {
      paused = Boolean(next);
      pauseBtnEl.textContent = paused ? "resume" : "pause";
      pauseBtnEl.classList.toggle("pause-on", paused);
      if (!paused && bufferedWhilePaused > 0) {
        bufferedWhilePaused = 0;
        render();
      }
      updateStatus();
    };

    const isDesktopLayout = () => window.matchMedia("(min-width: 1281px)").matches;
    const toFiniteNumber = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const clampPaneWidth = (value) => {
      const viewportMax = Math.max(PANE_MIN_WIDTH, window.innerWidth - 280);
      return Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, viewportMax, Math.floor(value)));
    };
    const currentPaneWidth = () => {
      if (!rightPaneEl) {
        return 420;
      }
      return toFiniteNumber(rightPaneEl.getBoundingClientRect().width, 420);
    };
    const applyPaneWidth = (value) => {
      if (!layoutRootEl || !isDesktopLayout()) {
        return;
      }
      layoutRootEl.style.setProperty("--pane-width", String(clampPaneWidth(value)) + "px");
    };
    const beginPaneResize = (clientX) => {
      if (!isDesktopLayout()) {
        return;
      }
      resizingPane = true;
      resizeStartX = clientX;
      resizeStartWidth = currentPaneWidth();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };
    const stopPaneResize = () => {
      if (!resizingPane) {
        return;
      }
      resizingPane = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onPaneResizeMove = (clientX) => {
      if (!resizingPane) {
        return;
      }
      const delta = resizeStartX - clientX;
      applyPaneWidth(resizeStartWidth + delta);
    };

    function renderProbeResults() {
      if (!probeListEl || !probeStateEl) return;
      const shown = probeResults.slice(0, 50);
      probeStateEl.textContent = probeResults.length + " entries";
      if (shown.length === 0) {
        probeListEl.innerHTML = '<div class="probe-empty">No probe results yet.</div>';
        return;
      }
      probeListEl.innerHTML = shown.map((entry) => {
        const statusClass =
          entry.status === "ok" ? "status-ok" : (entry.status === "warn" ? "status-warn" : "status-error");
        const callBlocks =
          Array.isArray(entry.calls) && entry.calls.length > 0
            ? entry.calls
                .map((call) => {
                  return '<div class="probe-call">' +
                    '<div class="probe-call-title">' + escapeHtml(call.endpoint) + " status=" + escapeHtml(call.status) + '</div>' +
                    '<pre class="probe-pre">request: ' + escapeHtml(JSON.stringify(call.request, null, 2)) + '\\nresponse: ' + escapeHtml(JSON.stringify(call.response, null, 2)) + '</pre>' +
                  '</div>';
                })
                .join("")
            : '<div class="muted">API call trace: none</div>';
        const warnings =
          entry.warnings && entry.warnings.length > 0
            ? '<div class="muted">warnings: ' + escapeHtml(entry.warnings.join(" | ")) + '</div>'
            : "";
        const header =
          typeof entry.header === "string" && entry.header.trim().length > 0
            ? '<div class="muted">header: ' + escapeHtml(entry.header) + '</div>'
            : "";
        return '<article class="probe-item">' +
          '<div class="probe-meta">' +
          '<span class="tag ' + statusClass + '">' + escapeHtml(entry.status) + '</span>' +
          '<span class="muted">' + escapeHtml(entry.at) + '</span>' +
          '</div>' +
          '<div class="probe-body">' +
          '<div>' + escapeHtml(entry.title) + '</div>' +
          '<div class="muted">' + escapeHtml(entry.subtitle) + '</div>' +
          header +
          warnings +
          callBlocks +
          '<pre class="probe-pre">' + escapeHtml(entry.detail) + '</pre>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    function addProbeResult(entry) {
      probeResults.unshift(entry);
      if (probeResults.length > 200) probeResults.splice(200);
      renderProbeResults();
    }

    const selectedWorkspaceKey = () => {
      if (!authWorkspaceSelectEl || !("value" in authWorkspaceSelectEl)) {
        return "";
      }
      return String(authWorkspaceSelectEl.value ?? "").trim();
    };

    function formatWorkspaceLabel(item) {
      const key = String(item.workspaceKey ?? "").trim();
      const labelRaw = typeof item.label === "string" ? item.label.trim() : "";
      const label = labelRaw.length > 0 ? labelRaw : key;
      const tokenState = (item.hasXoxc ? "xoxc" : "-") + "/" + (item.hasXoxd ? "xoxd" : "-");
      return label + " [" + tokenState + "]";
    }

    function renderWorkspaceOptions(items) {
      if (!authWorkspaceSelectEl) {
        return;
      }
      const selected = selectedWorkspaceKey();
      const normalized = Array.isArray(items)
        ? items
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const workspaceKey = String(item.workspaceKey ?? "").trim();
              if (!workspaceKey) return null;
              return {
                workspaceKey,
                label: typeof item.label === "string" ? item.label.trim() : "",
                hasXoxc: item.hasXoxc === true,
                hasXoxd: item.hasXoxd === true,
              };
            })
            .filter(Boolean)
        : [];
      const optionsHtml = normalized
        .map((item) => {
          const label = formatWorkspaceLabel(item);
          const disabled = item.hasXoxc ? "" : " disabled";
          const selectedAttr = item.workspaceKey === selected ? " selected" : "";
          return (
            '<option value="' +
            escapeHtml(item.workspaceKey) +
            '"' +
            selectedAttr +
            disabled +
            ">" +
            escapeHtml(item.hasXoxc ? label : label + " (xoxc missing)") +
            "</option>"
          );
        })
        .join("");
      authWorkspaceSelectEl.innerHTML = '<option value="">(auto latest)</option>' + optionsHtml;
      if (selected.length > 0 && !normalized.some((item) => item.workspaceKey === selected)) {
        authWorkspaceSelectEl.value = "";
      }
    }

    async function reloadWorkspaceOptions() {
      if (!refreshWorkspacesBtnEl) {
        return;
      }
      const originalText = refreshWorkspacesBtnEl.textContent;
      refreshWorkspacesBtnEl.setAttribute("disabled", "true");
      refreshWorkspacesBtnEl.textContent = "loading...";
      try {
        const response = await fetch("/api/slack/workspaces");
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          addProbeResult({
            at: new Date().toISOString(),
            status: "error",
            title: "workspace list failed",
            subtitle: "debug-ui",
            warnings: [],
            calls: [],
            detail: JSON.stringify(payload ?? { ok: false, error: "invalid_response" }, null, 2),
          });
          return;
        }
        renderWorkspaceOptions(payload.workspaces);
      } catch (error) {
        addProbeResult({
          at: new Date().toISOString(),
          status: "error",
          title: "workspace list request error",
          subtitle: "debug-ui",
          warnings: [],
          calls: [],
          detail: String(error ?? "unknown_error"),
        });
      } finally {
        refreshWorkspacesBtnEl.removeAttribute("disabled");
        refreshWorkspacesBtnEl.textContent = originalText || "reload workspaces";
      }
    }


    function render() {
      const kindFilter = kindFilterEl.value;
      const stageFilter = stageFilterEl.value.trim().toLowerCase();
      const searchTerms = parseSearchTerms(searchInputEl.value);
      const search = searchTerms.join(" ").toLowerCase();
      const excludeRules = excludeEnabledEl.checked ? parseExcludeRules(excludeInputEl.value) : [];
      const max = Math.max(10, Math.min(5000, Number(limitInputEl.value || 200)));
      const filtered = events.filter((ev) => {
        if (kindFilter && ev.kind !== kindFilter) return false;
        const stage = normalize(ev?.payload?.stage);
        if (stageFilter && stage !== stageFilter) return false;
        if (excludeRules.some((rule) => matchesExcludeRule(ev, rule))) return false;
        if (searchTerms.length === 0) return true;
        const hay = JSON.stringify(ev).toLowerCase();
        return searchTerms.every((term) => hay.includes(term.toLowerCase()));
      });
      const shown = filtered.slice(-max).reverse();
      filterStateEl.textContent =
        "total=" + events.length +
        " filtered=" + filtered.length +
        " shown=" + shown.length +
        " | kind=" + (kindFilter || "all") +
        " | stage=" + (stageFilter || "all") +
        " | search=" + (search || "-") +
        " | exclude=" + (excludeRules.length > 0 ? excludeRules.map((r) => (r.key ? r.key + ":" : "") + r.value).join(", ") : "off");
      listEl.innerHTML = shown.map((ev, idx) => {
        const body = applyHighlights(JSON.stringify(ev.payload, null, 2), searchTerms);
        const raw = encodeURIComponent(JSON.stringify(ev, null, 2));
        const stage = normalize(ev?.payload?.stage);
        const authTags = buildAuthTags(ev);
        const isCollapsed = defaultCollapsed || collapsedByRaw.has(raw);
        const canProbe = ev.kind === "raw_fetch" && stage === "requestwillbesent";
        const payloadRaw = encodeURIComponent(JSON.stringify(ev.payload ?? {}));
        return '<article class="item">' +
          '<div class="meta">' +
          '<span class="tag kind-' + ev.kind + '">' + escapeHtml(ev.kind) + '</span>' +
          '<span class="tag">' + escapeHtml(stage || "-") + '</span>' +
          authTags +
          '<span>' + escapeHtml(ev.source) + '</span>' +
          '<span class="muted">' + escapeHtml(ev.at) + '</span>' +
          (canProbe ? '<button class="probe-btn" data-payload="' + payloadRaw + '" type="button">resolve names</button>' : '') +
          '<button class="toggle-btn" data-copy="' + raw + '" type="button">' + (isCollapsed ? "expand" : "collapse") + '</button>' +
          '<button class="copy-btn" data-copy="' + raw + '" data-idx="' + idx + '" type="button">copy</button>' +
          '</div>' +
          (isCollapsed ? "" : '<pre>' + body + '</pre>') +
        '</article>';
      }).join("");
    }

    function addEvent(ev) {
      events.push(ev);
      if (events.length > 5000) events.splice(0, events.length - 5000);
      if (paused) {
        bufferedWhilePaused += 1;
        updateStatus();
        return;
      }
      render();
    }

    if (paneResizerEl) {
      paneResizerEl.addEventListener("mousedown", (event) => {
        beginPaneResize(event.clientX);
        event.preventDefault();
      });
      paneResizerEl.addEventListener("keydown", (event) => {
        if (!isDesktopLayout()) {
          return;
        }
        if (event.key === "ArrowLeft") {
          applyPaneWidth(currentPaneWidth() + 24);
          event.preventDefault();
          return;
        }
        if (event.key === "ArrowRight") {
          applyPaneWidth(currentPaneWidth() - 24);
          event.preventDefault();
        }
      });
    }
    window.addEventListener("mousemove", (event) => {
      onPaneResizeMove(event.clientX);
    });
    window.addEventListener("mouseup", () => {
      stopPaneResize();
    });
    window.addEventListener("blur", () => {
      stopPaneResize();
    });
    window.addEventListener("resize", () => {
      applyPaneWidth(currentPaneWidth());
    });
    applyPaneWidth(currentPaneWidth());

    clearBtnEl.addEventListener("click", () => {
      events.length = 0;
      render();
    });
    clearProbeBtnEl.addEventListener("click", () => {
      probeResults.length = 0;
      renderProbeResults();
    });
    refreshWorkspacesBtnEl.addEventListener("click", () => {
      void reloadWorkspaceOptions();
    });
    const runCdpProbeAction = async (input) => {
      const workspaceKey = selectedWorkspaceKey();
      const body = {};
      if (workspaceKey.length > 0) {
        body.workspaceKey = workspaceKey;
      }
      const button = input.button;
      const originalText = button.textContent;
      button.setAttribute("disabled", "true");
      button.textContent = "running...";
      try {
        const response = await fetch(input.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const responseJson = await response.json().catch(() => null);
        if (!response.ok || !responseJson?.ok) {
          addProbeResult({
            at: new Date().toISOString(),
            status: "error",
            title: input.failTitle,
            subtitle:
              "workspace=" +
              (workspaceKey || "(auto)") +
              " target=" +
              "(active attached)",
            warnings: [],
            calls: [],
            detail: JSON.stringify(responseJson ?? { ok: false, error: "invalid_response" }, null, 2),
          });
          return;
        }
        const result = responseJson.result ?? {};
        const attemptCount = Array.isArray(result.attempts) ? result.attempts.length : 0;
        const channelsCount =
          Array.isArray(result.channels) ? result.channels.length : (Array.isArray(result.attempts?.[0]?.channels) ? result.attempts[0].channels.length : 0);
        const probeCalls = [];
        const attempts = Array.isArray(result.attempts) ? result.attempts : [];
        let authHeader = "";
        for (const attempt of attempts) {
          const auth = attempt && typeof attempt === "object" ? attempt.auth : null;
          if (!auth || typeof auth !== "object") {
            continue;
          }
          const teamId = typeof auth.teamId === "string" ? auth.teamId.trim() : "";
          const enterpriseId = typeof auth.enterpriseId === "string" ? auth.enterpriseId.trim() : "";
          const userId = typeof auth.userId === "string" ? auth.userId.trim() : "";
          const authUrl = typeof auth.url === "string" ? auth.url.trim() : "";
          const parts = [
            "team_id=" + (teamId || "(none)"),
            "enterprise_id=" + (enterpriseId || "(none)"),
            "user_id=" + (userId || "(none)"),
          ];
          if (authUrl) {
            parts.push("url=" + authUrl);
          }
          authHeader = parts.join(" ");
          break;
        }
        for (const attempt of attempts) {
          const apiCalls = Array.isArray(attempt?.apiCalls) ? attempt.apiCalls : [];
          for (const apiCall of apiCalls) {
            const endpoint = typeof apiCall?.endpoint === "string" ? apiCall.endpoint : "(unknown)";
            const status = apiCall?.httpStatus;
            probeCalls.push({
              endpoint,
              status: status === undefined || status === null ? "unknown" : String(status),
              request: {
                workspaceKey: result.workspaceKey || workspaceKey || "(auto)",
                targetId: result.executedTargetId || "(active attached)",
                contextId:
                  attempt?.contextId === undefined || attempt?.contextId === null
                    ? "unknown"
                    : String(attempt.contextId),
              },
              response: apiCall,
            });
          }
        }
        addProbeResult({
          at: new Date().toISOString(),
          status: result.ok ? "ok" : "warn",
          title: result.ok ? input.successTitle : input.warnTitle,
          subtitle:
            "workspace=" +
            (result.workspaceKey || workspaceKey || "(auto)") +
            " target=" +
            (result.executedTargetId || "(active attached)") +
            " context=" +
            String(result.executedContextId ?? "unknown") +
            (input.showChannelsCount ? " channels=" + String(channelsCount) : "") +
            " attempts=" +
            String(attemptCount),
          header: authHeader,
          warnings: [],
          calls: probeCalls,
          detail: JSON.stringify(result, null, 2),
        });
      } catch (error) {
        addProbeResult({
          at: new Date().toISOString(),
          status: "error",
          title: input.errorTitle,
            subtitle:
              "workspace=" +
              (workspaceKey || "(auto)") +
              " target=" +
              "(active attached)",
          warnings: [],
          calls: [],
          detail: String(error ?? "unknown_error"),
        });
      } finally {
        button.removeAttribute("disabled");
        button.textContent = originalText || input.fallbackButtonLabel;
      }
    };
    authTestBtnEl.addEventListener("click", async () => {
      await runCdpProbeAction({
        button: authTestBtnEl,
        endpoint: "/api/slack/auth-test-via-cdp",
        failTitle: "auth.test via CDP failed",
        successTitle: "auth.test via CDP success",
        warnTitle: "auth.test via CDP no success context",
        errorTitle: "auth.test via CDP request error",
        fallbackButtonLabel: "auth.test via CDP",
        showChannelsCount: false,
      });
    });
    channelsListBtnEl.addEventListener("click", async () => {
      await runCdpProbeAction({
        button: channelsListBtnEl,
        endpoint: "/api/slack/channels-list-via-cdp",
        failTitle: "channels.list via CDP failed",
        successTitle: "channels.list via CDP success",
        warnTitle: "channels.list via CDP no success context",
        errorTitle: "channels.list via CDP request error",
        fallbackButtonLabel: "channels.list x10 via CDP",
        showChannelsCount: true,
      });
    });
    kindFilterEl.addEventListener("change", render);
    stageFilterEl.addEventListener("input", render);
    searchInputEl.addEventListener("input", render);
    excludeInputEl.addEventListener("input", render);
    excludeEnabledEl.addEventListener("change", render);
    limitInputEl.addEventListener("input", render);
    pauseBtnEl.addEventListener("click", () => setPaused(!paused));
    expandAllBtnEl.addEventListener("click", () => {
      defaultCollapsed = false;
      collapsedByRaw.clear();
      render();
    });
    collapseAllBtnEl.addEventListener("click", () => {
      defaultCollapsed = true;
      collapsedByRaw.clear();
      render();
    });
    resetBtnEl.addEventListener("click", () => {
      kindFilterEl.value = "";
      stageFilterEl.value = "";
      searchInputEl.value = "";
      excludeInputEl.value = "type:pong, type:reconnect_url";
      excludeEnabledEl.checked = true;
      limitInputEl.value = "200";
      defaultCollapsed = false;
      collapsedByRaw.clear();
      render();
    });
    listEl.addEventListener("click", async (e) => {
      const t = e.target;
      if (!t || !(t instanceof HTMLElement)) return;
      const btn = t.closest(".copy-btn");
      const toggleBtn = t.closest(".toggle-btn");
      const probeBtn = t.closest(".probe-btn");
      if (probeBtn) {
        const encodedPayload = probeBtn.getAttribute("data-payload");
        if (!encodedPayload) return;
        const originalText = probeBtn.textContent;
        probeBtn.setAttribute("disabled", "true");
        probeBtn.textContent = "resolving...";
        try {
          const payload = JSON.parse(decodeURIComponent(encodedPayload));
          const response = await fetch("/api/slack/resolve-identities", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ request: payload }),
          });
          const responseJson = await response.json();
          if (!response.ok || !responseJson?.ok) {
            addProbeResult({
              at: new Date().toISOString(),
              status: "error",
              title: "probe request failed",
              subtitle: String(payload.url ?? ""),
              warnings: [],
              calls: [],
              detail: JSON.stringify(responseJson, null, 2),
            });
          } else {
            const probe = responseJson.result ?? {};
            const userName = probe?.usersInfo?.name ?? "(unknown)";
            const channelName = probe?.conversationsInfo?.name ?? "(unknown)";
            addProbeResult({
              at: new Date().toISOString(),
              status: probe?.ok ? "ok" : "warn",
              title: "user: " + userName + " / channel: " + channelName,
              subtitle:
                (probe?.requestId ? "requestId=" + probe.requestId + " " : "") +
                String(probe?.url ?? ""),
              warnings: Array.isArray(probe?.warnings) ? probe.warnings : [],
              calls: Array.isArray(probe?.apiCalls) ? probe.apiCalls.map((call) => ({
                endpoint: String(call?.endpoint ?? ""),
                status: String(call?.response?.status ?? ""),
                request: call?.request ?? {},
                response: call?.response ?? {},
              })) : [],
              detail: JSON.stringify(probe, null, 2),
            });
          }
        } catch (error) {
          addProbeResult({
            at: new Date().toISOString(),
            status: "error",
            title: "probe execution error",
            subtitle: "debug-ui",
            warnings: [],
            calls: [],
            detail: String(error ?? "unknown_error"),
          });
        } finally {
          probeBtn.removeAttribute("disabled");
          probeBtn.textContent = originalText || "resolve names";
        }
        return;
      }
      if (toggleBtn) {
        const encodedToggle = toggleBtn.getAttribute("data-copy");
        if (!encodedToggle) return;
        if (collapsedByRaw.has(encodedToggle)) {
          collapsedByRaw.delete(encodedToggle);
        } else {
          collapsedByRaw.add(encodedToggle);
        }
        render();
        return;
      }
      if (!btn) return;
      const encoded = btn.getAttribute("data-copy");
      if (!encoded) return;
      const value = decodeURIComponent(encoded);
      try {
        await navigator.clipboard.writeText(value);
        const old = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = old || "copy"; }, 900);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        const old = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = old || "copy"; }, 900);
      }
    });

    fetch("/snapshot")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.events)) {
          j.events.forEach(addEvent);
        }
      })
      .catch(() => {});
    void reloadWorkspaceOptions();
    renderProbeResults();

    const es = new EventSource("/events");
    es.addEventListener("open", () => { connected = true; updateStatus(); });
    es.addEventListener("error", () => { connected = false; updateStatus(); });
    es.addEventListener("debug", (e) => {
      try { addEvent(JSON.parse(e.data)); } catch {}
    });
  </script>
</body>
</html>`;
  }
}
