export function renderMinimalUiPage(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Adjutant Control Plane</title>
  </head>
  <body>
    <h1>Adjutant Web UI (co-located)</h1>
    <form id="command-form">
      <input id="sessionKey" name="sessionKey" value="main" />
      <input id="message" name="message" placeholder="message" />
      <button type="submit">Send</button>
    </form>
    <pre id="log"></pre>
    <script>
      const log = document.getElementById("log");
      const append = (label, payload) => {
        log.textContent += "[" + label + "] " + JSON.stringify(payload) + "\\n";
      };
      const appendFallbackNote = (payload) => {
        if (payload && payload.sessionRecoveryMode === "fallback_new_session") {
          const reason = payload.sessionRecoveryReason || "session/load unavailable";
          append("session/recovery", {
            note: "new session fallback",
            reason,
            runId: payload.runId || null,
            sessionKey: payload.sessionKey || null,
          });
        }
      };
      const stream = new EventSource("/api/events/stream");
      stream.addEventListener("run/accepted", (event) => {
        const payload = JSON.parse(event.data);
        append("run/accepted", payload);
        appendFallbackNote(payload);
      });
      stream.addEventListener("run/update", (event) => append("run/update", JSON.parse(event.data)));
      stream.addEventListener("run/completed", (event) => append("run/completed", JSON.parse(event.data)));
      stream.addEventListener("run/failed", (event) => append("run/failed", JSON.parse(event.data)));
      stream.addEventListener("permission/requested", (event) => append("permission/requested", JSON.parse(event.data)));
      stream.addEventListener("permission/resolved", (event) => append("permission/resolved", JSON.parse(event.data)));

      document.getElementById("command-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const sessionKey = document.getElementById("sessionKey").value;
        const message = document.getElementById("message").value;
        const response = await fetch("/api/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionKey, message }),
        });
        const json = await response.json();
        append("accepted", json);
        appendFallbackNote(json);
      });
    </script>
  </body>
</html>`;
}
