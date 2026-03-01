import { useMemo, useState, type FormEvent, type ReactElement } from "react";

import type { PermissionSummary, ToolEventRecord } from "../../control-plane/contracts/http-api.js";

export interface SendCommandInput {
  sessionKey: string;
  message: string;
}

export interface SendCommandResult {
  runId: string;
  sessionRecoveryMode?: string;
  sessionRecoveryReason?: string;
}

export interface ControlPlaneConsoleProps {
  onSend: (input: SendCommandInput) => Promise<SendCommandResult>;
  toolEventsByRun: Record<string, ToolEventRecord[]>;
  pendingPermissions: PermissionSummary[];
}

export function ControlPlaneConsole({
  onSend,
  toolEventsByRun,
  pendingPermissions,
}: ControlPlaneConsoleProps): ReactElement {
  const [sessionKey, setSessionKey] = useState("main");
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [lastRunId, setLastRunId] = useState<string | undefined>();
  const [lastRecoveryMessage, setLastRecoveryMessage] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const toolRows = useMemo(() => {
    return Object.entries(toolEventsByRun).flatMap(([runId, events]) =>
      events.map((event) => ({
        runId,
        toolCallId: event.toolCallId,
        status: event.status,
      }))
    );
  }, [toolEventsByRun]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSending) {
      return;
    }
    const formElements = event.currentTarget.elements;
    const submitSessionKey =
      (formElements.namedItem("sessionKey") as HTMLInputElement | null)?.value.trim() ?? "";
    const submitMessage =
      (formElements.namedItem("message") as HTMLInputElement | null)?.value.trim() ?? "";

    setErrorMessage(undefined);
    setIsSending(true);
    try {
      const result = await onSend({
        sessionKey: submitSessionKey,
        message: submitMessage,
      });
      setLastRunId(result.runId);
      if (result.sessionRecoveryMode === "fallback_new_session") {
        setLastRecoveryMessage(
          `new session fallback (${result.sessionRecoveryReason ?? "session/load unavailable"})`
        );
      } else {
        setLastRecoveryMessage(undefined);
      }
      setMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <section>
      <h2>Control Plane Console</h2>
      <form onSubmit={onSubmit} aria-label="command-form">
        <label htmlFor="session-key-input">Session</label>
        <input
          id="session-key-input"
          name="sessionKey"
          value={sessionKey}
          onChange={(event) => setSessionKey(event.target.value)}
        />
        <label htmlFor="message-input">Message</label>
        <input
          id="message-input"
          name="message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button type="submit" disabled={isSending}>
          Send
        </button>
      </form>

      <p data-testid="last-run-id">{lastRunId ?? "no-run-yet"}</p>
      <p data-testid="session-recovery-message">{lastRecoveryMessage ?? ""}</p>
      <p data-testid="send-error">{errorMessage ?? ""}</p>

      <h3>Tool History</h3>
      <ul aria-label="tool-history">
        {toolRows.map((row) => (
          <li key={`${row.runId}:${row.toolCallId}`}>
            {row.runId} {row.toolCallId} {row.status}
          </li>
        ))}
      </ul>

      <h3>Pending Permissions</h3>
      <ul aria-label="pending-permissions">
        {pendingPermissions.map((permission) => (
          <li key={permission.requestId}>
            {permission.title} ({permission.requestedAt})
          </li>
        ))}
      </ul>
    </section>
  );
}
