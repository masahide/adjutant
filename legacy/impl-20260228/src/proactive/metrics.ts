export type MetricName =
  | "route_llm_calls_per_hour"
  | "flusher_fire_count"
  | "agent_invocations_by_source"
  | "event_to_response_p95_ms";

export type MetricRecord = {
  schema: "adjutant.metric.v1";
  name: MetricName;
  kind: "counter" | "gauge";
  value: number;
  unit: "count" | "ms";
  ts: string;
  tags?: Record<string, string>;
};

export type MetricsEmitter = (record: MetricRecord) => void;

export type MetricsClient = {
  incrementCounter: (
    name: Extract<MetricName, "flusher_fire_count" | "agent_invocations_by_source">,
    value?: number,
    tags?: Record<string, string>
  ) => void;
  setGauge: (
    name: Extract<MetricName, "route_llm_calls_per_hour" | "event_to_response_p95_ms">,
    value: number,
    tags?: Record<string, string>
  ) => void;
};

export type ProactiveMetrics = MetricsClient & {
  recordRouteLlmCall: (input?: { sessionKey?: string }) => void;
  recordFlusherFire: (input?: { sessionKey?: string; openPostCount?: number }) => void;
  recordAgentInvocation: (input: { source: string }) => void;
  recordEventToResponse: (input: {
    durationMs: number;
    queueKey?: string;
    sessionKey?: string;
  }) => void;
};

export type ProactiveMetricsOptions = {
  now?: () => Date;
  onRecord?: MetricsEmitter;
  rollingWindowMs?: number;
};

type TimedNumber = {
  atMs: number;
  value: number;
};

function asFinitePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function computeP95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const picked = sorted[index] ?? sorted[sorted.length - 1] ?? 0;
  return picked;
}

function pruneTimestamps(timestamps: number[], minMs: number): number[] {
  return timestamps.filter((ts) => ts >= minMs);
}

function pruneTimedNumbers(samples: TimedNumber[], minMs: number): TimedNumber[] {
  return samples.filter((sample) => sample.atMs >= minMs);
}

export function createProactiveMetrics(options: ProactiveMetricsOptions = {}): ProactiveMetrics {
  const now = options.now ?? (() => new Date());
  const onRecord =
    options.onRecord ??
    ((record: MetricRecord) => {
      console.info("[ProactiveMetrics]", JSON.stringify(record));
    });
  const rollingWindowMs = asFinitePositiveInt(options.rollingWindowMs ?? 3_600_000, 3_600_000);

  let routeCallTimestamps: number[] = [];
  let flusherFireCount = 0;
  const sourceInvocationCounts = new Map<string, number>();
  let eventToResponseSamples: TimedNumber[] = [];

  const emit = (input: {
    name: MetricName;
    kind: "counter" | "gauge";
    value: number;
    unit: "count" | "ms";
    tags?: Record<string, string>;
  }): void => {
    const ts = now();
    onRecord({
      schema: "adjutant.metric.v1",
      name: input.name,
      kind: input.kind,
      value: input.value,
      unit: input.unit,
      ts: ts.toISOString(),
      tags: input.tags,
    });
  };

  const incrementCounter: MetricsClient["incrementCounter"] = (name, value = 1, tags) => {
    emit({
      name,
      kind: "counter",
      value,
      unit: "count",
      tags,
    });
  };

  const setGauge: MetricsClient["setGauge"] = (name, value, tags) => {
    emit({
      name,
      kind: "gauge",
      value,
      unit: name === "event_to_response_p95_ms" ? "ms" : "count",
      tags,
    });
  };

  const recordRouteLlmCall: ProactiveMetrics["recordRouteLlmCall"] = (input) => {
    const nowMs = now().getTime();
    routeCallTimestamps.push(nowMs);
    routeCallTimestamps = pruneTimestamps(routeCallTimestamps, nowMs - rollingWindowMs);
    setGauge("route_llm_calls_per_hour", routeCallTimestamps.length, {
      sessionKey: input?.sessionKey?.trim() || "unknown",
    });
  };

  const recordFlusherFire: ProactiveMetrics["recordFlusherFire"] = (input) => {
    flusherFireCount += 1;
    incrementCounter("flusher_fire_count", 1, {
      total: String(flusherFireCount),
      sessionKey: input?.sessionKey?.trim() || "unknown",
      openPostCount: String(Math.max(0, Math.floor(input?.openPostCount ?? 0))),
    });
  };

  const recordAgentInvocation: ProactiveMetrics["recordAgentInvocation"] = (input) => {
    const source = input.source.trim() || "unknown";
    const next = (sourceInvocationCounts.get(source) ?? 0) + 1;
    sourceInvocationCounts.set(source, next);
    incrementCounter("agent_invocations_by_source", 1, {
      source,
      total: String(next),
    });
  };

  const recordEventToResponse: ProactiveMetrics["recordEventToResponse"] = (input) => {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
      return;
    }
    const nowMs = now().getTime();
    eventToResponseSamples.push({
      atMs: nowMs,
      value: Math.max(0, input.durationMs),
    });
    eventToResponseSamples = pruneTimedNumbers(eventToResponseSamples, nowMs - rollingWindowMs);
    const p95 = computeP95(eventToResponseSamples.map((sample) => sample.value));
    setGauge("event_to_response_p95_ms", p95, {
      sampleCount: String(eventToResponseSamples.length),
      queueKey: input.queueKey?.trim() || "unknown",
      sessionKey: input.sessionKey?.trim() || "unknown",
    });
  };

  return {
    incrementCounter,
    setGauge,
    recordRouteLlmCall,
    recordFlusherFire,
    recordAgentInvocation,
    recordEventToResponse,
  };
}
