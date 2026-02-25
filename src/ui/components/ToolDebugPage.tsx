import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ToolCatalog,
  ToolActionMeta,
  ToolExecutionResult,
  ToolHistoryEntry,
  WorkspaceSummary,
} from "../types/tool-debug.js";

const ROUTING_MODES = [
  { value: "", label: "(Default: auto_probe)" },
  { value: "auto_probe", label: "auto_probe" },
  { value: "manual_team", label: "manual_team" },
  { value: "manual_enterprise", label: "manual_enterprise" },
] as const;

const COMMON_ARG_KEYS = new Set(["routing_mode", "workspace_key"]);

type ArgsSchemaProperties = Record<string, { type?: string; description?: string }>;

function extractProperties(schema: Record<string, unknown>): ArgsSchemaProperties {
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return {};
  return props as ArgsSchemaProperties;
}

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

export function ToolDebugPage() {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [routingMode, setRoutingMode] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ToolExecutionResult | null>(null);
  const [history, setHistory] = useState<ToolHistoryEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/tools/catalog");
        if (!res.ok) {
          setCatalogError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as ToolCatalog;
        setCatalog(data);
        if (data.providers.length > 0) {
          setSelectedProvider(data.providers[0].name);
        }
      } catch (err) {
        setCatalogError(err instanceof Error ? err.message : "Failed to load catalog");
      }
    })();
    void (async () => {
      try {
        const res = await fetch("/api/tools/workspaces");
        if (res.ok) {
          const data = (await res.json()) as { workspaces: WorkspaceSummary[] };
          setWorkspaces(data.workspaces);
        }
      } catch {
        // workspaces are optional
      }
    })();
  }, []);

  const currentProvider = useMemo(() => {
    if (!catalog || !selectedProvider) return null;
    return catalog.providers.find((p) => p.name === selectedProvider) ?? null;
  }, [catalog, selectedProvider]);

  const currentAction: ToolActionMeta | null = useMemo(() => {
    if (!currentProvider || !selectedAction) return null;
    return currentProvider.actions.find((a) => a.name === selectedAction) ?? null;
  }, [currentProvider, selectedAction]);

  const dynamicFields = useMemo(() => {
    if (!currentAction) return [];
    const props = extractProperties(currentAction.argsSchema);
    return Object.entries(props)
      .filter(([key]) => !COMMON_ARG_KEYS.has(key))
      .map(([key, schema]) => ({
        key,
        type: schema.type ?? "string",
        description: schema.description ?? "",
        required: currentAction.requiredArgs.includes(key),
      }));
  }, [currentAction]);

  const handleSelectAction = useCallback((actionName: string) => {
    setSelectedAction(actionName);
    setFormValues({});
    setResult(null);
  }, []);

  const handleFieldChange = useCallback((key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleExecute = useCallback(async () => {
    if (!selectedProvider || !selectedAction) return;
    setExecuting(true);
    setResult(null);
    try {
      const args: Record<string, unknown> = {};
      if (workspaceKey) args.workspace_key = workspaceKey;
      if (routingMode) args.routing_mode = routingMode;
      for (const [key, value] of Object.entries(formValues)) {
        if (value.trim()) {
          const field = dynamicFields.find((f) => f.key === key);
          if (field?.type === "number" || field?.type === "integer") {
            const num = Number(value);
            if (Number.isFinite(num)) {
              args[key] = num;
              continue;
            }
          }
          args[key] = value.trim();
        }
      }
      const res = await fetch("/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, action: selectedAction, args }),
      });
      const data = (await res.json()) as ToolExecutionResult;
      setResult(data);
      setHistory((prev) => [
        {
          provider: selectedProvider,
          action: selectedAction,
          args,
          result: data,
          executedAt: Date.now(),
        },
        ...prev.slice(0, 49),
      ]);
    } catch (err) {
      setResult({
        ok: false,
        code: "network_error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setExecuting(false);
    }
  }, [selectedProvider, selectedAction, workspaceKey, routingMode, formValues, dynamicFields]);

  if (catalogError) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-destructive">
        Catalog load failed: {catalogError}
      </div>
    );
  }
  if (!catalog) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading catalog...
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left: Action selector */}
      <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto">
        {catalog.providers.map((provider) => (
          <div key={provider.name}>
            <div className="px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider border-b border-border bg-accent/30">
              {provider.name}
            </div>
            {provider.actions.map((action) => (
              <button
                key={action.name}
                onClick={() => {
                  setSelectedProvider(provider.name);
                  handleSelectAction(action.name);
                }}
                className={`w-full text-left px-3 py-2 text-xs border-b border-border transition-colors hover:bg-accent/50 ${
                  selectedProvider === provider.name && selectedAction === action.name
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <div className="font-medium">{action.name}</div>
                <div className="text-[10px] text-muted-foreground/70 line-clamp-1 mt-0.5">
                  {action.description}
                </div>
                {action.requiredArgs.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {action.requiredArgs.map((arg) => (
                      <span
                        key={arg}
                        className="px-1 py-0.5 rounded text-[9px] bg-amber-500/20 text-amber-400"
                      >
                        {arg}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Center: Form */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        {!currentAction ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Select an action from the left panel
          </div>
        ) : (
          <div className="max-w-lg space-y-4">
            <div>
              <h2 className="text-sm font-bold">{currentAction.name}</h2>
              <p className="text-xs text-muted-foreground mt-1">{currentAction.description}</p>
            </div>

            {/* Workspace dropdown */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Workspace
              </label>
              <select
                value={workspaceKey}
                onChange={(e) => setWorkspaceKey(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">(Auto)</option>
                {workspaces.map((ws) => (
                  <option key={ws.workspace_key} value={ws.workspace_key}>
                    {ws.workspace_key}
                    {ws.aliases.length > 0 ? ` (${ws.aliases.join(", ")})` : ""}
                    {ws.has_tokens ? "" : " [no tokens]"}
                    {ws.auth_test_status && ws.auth_test_status !== "ok"
                      ? ` [${ws.auth_test_status}]`
                      : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Routing mode */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Routing Mode
              </label>
              <select
                value={routingMode}
                onChange={(e) => setRoutingMode(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {ROUTING_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Dynamic fields */}
            {dynamicFields.map((field) => (
              <div key={field.key}>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  {field.key}
                  {field.required && <span className="text-amber-400 ml-1">*</span>}
                </label>
                <input
                  type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                  value={formValues[field.key] ?? ""}
                  onChange={(e) => handleFieldChange(field.key, e.target.value)}
                  placeholder={field.description || field.key}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-accent"
                />
                {field.description && (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">{field.description}</p>
                )}
              </div>
            ))}

            {/* Execute button */}
            <button
              onClick={() => void handleExecute()}
              disabled={executing}
              className="rounded bg-foreground text-background px-4 py-1.5 text-xs font-medium hover:bg-foreground/90 disabled:opacity-50 transition-colors"
            >
              {executing ? "Executing..." : "Execute"}
            </button>
          </div>
        )}
      </div>

      {/* Right: Result + History */}
      <div className="w-80 flex-shrink-0 border-l border-border overflow-y-auto flex flex-col">
        {/* Result */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {result ? (
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium">Result</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    result.ok ? "bg-green-600 text-white" : "bg-red-600 text-white"
                  }`}
                >
                  {result.ok ? "OK" : "ERROR"}
                </span>
                {result.code && (
                  <span className="text-[10px] text-muted-foreground">{result.code}</span>
                )}
              </div>
              <pre className="text-[11px] leading-relaxed bg-accent/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
              Execute an action to see results
            </div>
          )}
        </div>

        {/* History */}
        {history.length > 0 && (
          <div className="border-t border-border">
            <div className="px-3 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider bg-accent/30">
              History ({history.length})
            </div>
            <div className="max-h-48 overflow-y-auto">
              {history.map((entry, i) => (
                <button
                  key={`${entry.executedAt}-${i}`}
                  onClick={() => setResult(entry.result)}
                  className="w-full text-left px-3 py-1.5 text-xs border-b border-border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {formatTimestamp(entry.executedAt)}
                    </span>
                    <span
                      className={`px-1 py-0.5 rounded text-[9px] font-bold ${
                        entry.result.ok
                          ? "bg-green-600/30 text-green-400"
                          : "bg-red-600/30 text-red-400"
                      }`}
                    >
                      {entry.result.ok ? "OK" : "ERR"}
                    </span>
                    <span className="text-foreground/80 truncate">{entry.action}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
