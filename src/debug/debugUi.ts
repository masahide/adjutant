import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
};

type SseClient = {
  id: number;
  res: ServerResponse<IncomingMessage>;
};

const DEFAULT_MAX_EVENTS = 500;

export class DebugUiServer {
  private readonly port: number;
  private readonly host: string;
  private readonly maxEvents: number;
  private readonly events: DebugUiEvent[] = [];
  private readonly clients = new Map<number, SseClient>();
  private nextClientId = 1;
  private server = createServer((req, res) => this.handleRequest(req, res));

  constructor(options: DebugUiServerOptions) {
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
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

  private writeJson(res: ServerResponse<IncomingMessage>, value: unknown): void {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }

  private renderHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Adjutant Debug UI</title>
  <style>
    :root { --bg:#0b1020; --fg:#dbe4ff; --muted:#93a4d1; --line:#253055; --ok:#3ddc97; --warn:#ffb020; --raw:#6aa8ff; --danger:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin:0; height:100vh; overflow:hidden; display:flex; flex-direction:column; font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--fg); background:linear-gradient(180deg,#101833,#0b1020); }
    header { padding:12px 14px; border-bottom:1px solid var(--line); background:#0b1020; display:flex; gap:12px; align-items:center; z-index:2; }
    header strong { font-size:14px; }
    .muted { color:var(--muted); }
    main { flex:1; min-height:0; padding:10px 14px 12px; display:flex; flex-direction:column; overflow:hidden; }
    .row { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
    input, select, button { background:#101833; color:var(--fg); border:1px solid var(--line); padding:6px 8px; border-radius:6px; }
    button { cursor:pointer; }
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
    pre { margin:0; padding:10px; white-space:pre-wrap; word-break:break-word; max-height:none; overflow:visible; }
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
      <label>search: <input id="searchInput" placeholder="text filter" /></label>
      <label>exclude: <input id="excludeInput" value="type:pong, type:reconnect_url" placeholder="type:pong, type:reconnect_url, subtype:ping" /></label>
      <label><input id="excludeEnabled" type="checkbox" checked /> exclude on</label>
      <label>max: <input id="limitInput" type="number" min="10" max="5000" value="200" /></label>
      <button id="pauseBtn" type="button">pause</button>
      <button id="resetBtn" type="button">reset filters</button>
      <button id="clearBtn" type="button">clear</button>
    </div>
    <div class="hint" id="filterState"></div>
    <div class="list" id="eventList"></div>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const listEl = document.getElementById("eventList");
    const kindFilterEl = document.getElementById("kindFilter");
    const searchInputEl = document.getElementById("searchInput");
    const excludeInputEl = document.getElementById("excludeInput");
    const excludeEnabledEl = document.getElementById("excludeEnabled");
    const limitInputEl = document.getElementById("limitInput");
    const pauseBtnEl = document.getElementById("pauseBtn");
    const resetBtnEl = document.getElementById("resetBtn");
    const clearBtnEl = document.getElementById("clearBtn");
    const filterStateEl = document.getElementById("filterState");
    const events = [];
    let paused = false;
    let connected = false;
    let bufferedWhilePaused = 0;

    const escapeHtml = (s) => s.replace(/[&<>]/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[ch]));
    const normalize = (s) => String(s ?? "").trim().toLowerCase();

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

    function render() {
      const kindFilter = kindFilterEl.value;
      const search = searchInputEl.value.trim().toLowerCase();
      const excludeRules = excludeEnabledEl.checked ? parseExcludeRules(excludeInputEl.value) : [];
      const max = Math.max(10, Math.min(5000, Number(limitInputEl.value || 200)));
      const filtered = events.filter((ev) => {
        if (kindFilter && ev.kind !== kindFilter) return false;
        if (excludeRules.some((rule) => matchesExcludeRule(ev, rule))) return false;
        if (!search) return true;
        return JSON.stringify(ev).toLowerCase().includes(search);
      });
      const shown = filtered.slice(-max).reverse();
      filterStateEl.textContent =
        "total=" + events.length +
        " filtered=" + filtered.length +
        " shown=" + shown.length +
        " | kind=" + (kindFilter || "all") +
        " | search=" + (search || "-") +
        " | exclude=" + (excludeRules.length > 0 ? excludeRules.map((r) => (r.key ? r.key + ":" : "") + r.value).join(", ") : "off");
      listEl.innerHTML = shown.map((ev, idx) => {
        const body = escapeHtml(JSON.stringify(ev.payload, null, 2));
        const raw = encodeURIComponent(JSON.stringify(ev, null, 2));
        return '<article class="item">' +
          '<div class="meta">' +
          '<span class="tag kind-' + ev.kind + '">' + escapeHtml(ev.kind) + '</span>' +
          '<span>' + escapeHtml(ev.source) + '</span>' +
          '<span class="muted">' + escapeHtml(ev.at) + '</span>' +
          '<button class="copy-btn" data-copy="' + raw + '" data-idx="' + idx + '" type="button">copy</button>' +
          '</div>' +
          '<pre>' + body + '</pre>' +
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

    clearBtnEl.addEventListener("click", () => {
      events.length = 0;
      render();
    });
    kindFilterEl.addEventListener("change", render);
    searchInputEl.addEventListener("input", render);
    excludeInputEl.addEventListener("input", render);
    excludeEnabledEl.addEventListener("change", render);
    limitInputEl.addEventListener("input", render);
    pauseBtnEl.addEventListener("click", () => setPaused(!paused));
    resetBtnEl.addEventListener("click", () => {
      kindFilterEl.value = "";
      searchInputEl.value = "";
      excludeInputEl.value = "type:pong, type:reconnect_url";
      excludeEnabledEl.checked = true;
      limitInputEl.value = "200";
      render();
    });
    listEl.addEventListener("click", async (e) => {
      const t = e.target;
      if (!t || !(t instanceof HTMLElement)) return;
      const btn = t.closest(".copy-btn");
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
