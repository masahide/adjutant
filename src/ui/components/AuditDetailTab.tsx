import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from "lucide-react";
import { cn } from "../lib/utils.js";

type AuditToolSummary = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  resultSummary?: unknown;
  status?: "ok" | "error";
  durationMs?: number;
  truncated?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
};

type RunAuditResponse = {
  runId: string;
  origin?: "user" | "pipeline" | "system";
  runEnded: boolean;
  tools: AuditToolSummary[];
};

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ContentBlock = { type?: string; text?: string };

/** Extract readable text from result shapes like { content: [{ type:"text", text:"..." }] } */
function extractContentText(value: unknown): string | null {
  if (value == null) return null;

  // JSON string: try parsing to extract content blocks
  if (typeof value === "string") {
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        const extracted = extractContentFromObject(parsed);
        if (extracted != null) return extracted;
      } catch {
        // not valid JSON – return as plain string
      }
    }
    return value;
  }

  return extractContentFromObject(value);
}

function extractContentFromObject(value: unknown): string | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;

  // { content: [{ type: "text", text: "..." }, ...] }
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as ContentBlock[])
      .filter((b) => typeof b === "object" && b !== null && typeof b.text === "string")
      .map((b) => b.text!);
    if (texts.length > 0) return texts.join("\n");
  }

  // { _truncated: true, preview: "..." }
  if (obj._truncated === true && typeof obj.preview === "string") {
    return obj.preview;
  }

  return null;
}

/** Check if value is a flat key-value object suitable for labeled rendering */
function isFlatObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function ToolAccordion({ tool }: { tool: AuditToolSummary }) {
  const [expanded, setExpanded] = useState(true);

  const statusColor =
    tool.status === "ok"
      ? "text-green-400"
      : tool.status === "error"
        ? "text-red-400"
        : "text-muted-foreground";

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent/30 transition-colors"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span className="font-medium text-foreground">{tool.toolName}</span>
        {tool.durationMs != null && (
          <span className="text-muted-foreground">{formatDuration(tool.durationMs)}</span>
        )}
        {tool.status && (
          <span className={cn("ml-auto text-[10px] uppercase font-bold", statusColor)}>
            {tool.status}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-2 text-xs space-y-1.5">
          {tool.startedAt && (
            <DetailRow label="started" value={new Date(tool.startedAt).toLocaleTimeString()} />
          )}
          {tool.endedAt && (
            <DetailRow label="ended" value={new Date(tool.endedAt).toLocaleTimeString()} />
          )}
          {tool.args != null && <ArgsBlock value={tool.args} />}
          {tool.resultSummary != null && <ResultBlock value={tool.resultSummary} />}
          {tool.error && (
            <div className="text-destructive">
              <span className="font-medium">error:</span> {tool.error}
            </div>
          )}
          {tool.truncated && (
            <div className="text-muted-foreground italic">出力は切り詰められています</div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-muted-foreground">
      <span className="font-medium">{label}:</span> {value}
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground font-medium">{label}:</div>
      <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-2 py-1 text-[11px] text-foreground/80 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
        {value}
      </pre>
    </div>
  );
}

function ArgsBlock({ value }: { value: unknown }) {
  if (value == null) return null;

  if (typeof value === "string") {
    return <DetailBlock label="args" value={value} />;
  }

  if (isFlatObject(value)) {
    const entries = Object.entries(value);
    return (
      <div>
        <div className="text-muted-foreground font-medium">args:</div>
        <div className="mt-0.5 space-y-1">
          {entries.map(([key, val]) => (
            <div key={key}>
              <span className="text-muted-foreground/70 text-[10px]">{key}:</span>
              <pre className="mt-0.5 overflow-x-auto rounded bg-muted px-2 py-1 text-[11px] text-foreground/80 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {typeof val === "string" ? val : formatValue(val)}
              </pre>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <DetailBlock label="args" value={formatValue(value)} />;
}

function ResultBlock({ value }: { value: unknown }) {
  if (value == null) return null;

  const text = extractContentText(value);
  if (text != null) {
    return <DetailBlock label="result" value={text} />;
  }

  return <DetailBlock label="result" value={formatValue(value)} />;
}

type Props = {
  runId: string | null;
};

export function AuditDetailTab({ runId }: Props) {
  const [data, setData] = useState<RunAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedRunId = useRef<string | null>(null);

  const fetchAudit = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/runs/${encodeURIComponent(id)}/audit`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setData(null);
        return;
      }
      const body = (await res.json()) as RunAuditResponse;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!runId) {
      setData(null);
      lastFetchedRunId.current = null;
      return;
    }
    if (runId !== lastFetchedRunId.current) {
      lastFetchedRunId.current = runId;
      void fetchAudit(runId);
    }
  }, [runId, fetchAudit]);

  if (!runId) {
    return (
      <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
        メッセージの ▶ N tools をクリックして詳細を表示
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
        エラー: {error}
      </div>
    );
  }

  if (!data || data.tools.length === 0) {
    return (
      <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
        実行詳細はありません
      </div>
    );
  }

  return (
    <div className="flex flex-col text-xs">
      {/* Run header */}
      <div className="border-b border-border px-3 py-2 flex items-center gap-2">
        <span className="text-muted-foreground">Run:</span>
        <span className="font-mono text-foreground/80 truncate">{data.runId}</span>
        {data.origin && (
          <span className="text-muted-foreground text-[10px] uppercase">({data.origin})</span>
        )}
      </div>

      {/* Running indicator */}
      {!data.runEnded && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-amber-400 border-b border-border">
          <LoaderIcon className="size-3 animate-spin" />
          <span>実行中...</span>
        </div>
      )}

      {/* Tool list */}
      {data.tools.map((tool, i) => (
        <ToolAccordion key={tool.toolCallId ?? `${tool.toolName}-${i}`} tool={tool} />
      ))}
    </div>
  );
}
