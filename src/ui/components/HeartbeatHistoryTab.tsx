import React, { useCallback, useEffect, useState } from "react";
import type { HeartbeatRunRecord } from "../../assistant/types.js";

type HistoryResponse = {
  records: HeartbeatRunRecord[];
  hasMore: boolean;
  nextCursor: string | null;
};

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  ran: { label: "OK", className: "bg-green-600 text-white" },
  skipped: { label: "SKIP", className: "bg-zinc-600 text-zinc-200" },
  failed: { label: "FAIL", className: "bg-red-600 text-white" },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function HeartbeatHistoryTab() {
  const [records, setRecords] = useState<HeartbeatRunRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const fetchPage = useCallback(async (cursorValue: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (cursorValue) params.set("cursor", cursorValue);
      const res = await fetch(`/api/heartbeat/history?${params}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as HistoryResponse;
      setRecords((prev) => {
        const existing = new Set(prev.map((r) => r.runAt));
        const merged = [...prev, ...data.records.filter((r) => !existing.has(r.runAt))];
        return merged;
      });
      setHasMore(data.hasMore);
      setCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialLoaded) {
      setInitialLoaded(true);
      void fetchPage(null);
    }
  }, [initialLoaded, fetchPage]);

  if (!initialLoaded || (loading && records.length === 0)) {
    return (
      <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
        読み込み中...
      </div>
    );
  }

  if (records.length === 0 && !loading) {
    return (
      <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
        {error ? `エラー: ${error}` : "履歴がありません"}
      </div>
    );
  }

  return (
    <div className="flex flex-col text-xs">
      {records.map((rec) => {
        const badge = STATUS_BADGE[rec.result.status] ?? STATUS_BADGE.ran;
        const duration =
          rec.result.status === "ran" ? formatDuration(rec.result.durationMs) : undefined;
        const reason =
          rec.result.status === "skipped" || rec.result.status === "failed"
            ? rec.result.reason
            : undefined;

        return (
          <div key={rec.runAt} className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{formatTime(rec.runAt)}</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${badge.className}`}
              >
                {badge.label}
              </span>
              {duration && <span className="text-muted-foreground">{duration}</span>}
            </div>
            {rec.preview && (
              <div className="mt-1 text-foreground/80 line-clamp-2">{rec.preview}</div>
            )}
            {reason && <div className="mt-1 text-muted-foreground italic">{reason}</div>}
          </div>
        );
      })}

      {error && <div className="px-3 py-2 text-destructive">{error}</div>}

      {hasMore && (
        <button
          onClick={() => void fetchPage(cursor)}
          disabled={loading}
          className="mx-3 my-2 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 disabled:opacity-50 transition-colors"
        >
          {loading ? "読み込み中..." : "Load more"}
        </button>
      )}
    </div>
  );
}
