import { spawn } from "node:child_process";
import { parseBooleanEnv, parsePositiveIntEnv, parseStringEnv } from "../runtime/env-parsers.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SERVICE = "slack-rpc-gateway";

type SpawnedProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on: {
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "close", listener: (code: number | null) => void): unknown;
  };
};

export type SlackRpcGatewaySpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: readonly ["ignore", "pipe", "pipe"] }
) => SpawnedProcess;

type SleepFn = (ms: number) => Promise<void>;

export type SlackRpcGatewayBootstrapConfig = {
  enabled: boolean;
  autoStart: boolean;
  baseUrl: string;
  startupTimeoutMs: number;
  healthcheckIntervalMs: number;
  composeService: string;
  composeFile?: string;
};

export type EnsureSlackRpcGatewayReadyOptions = {
  config: SlackRpcGatewayBootstrapConfig;
  fetchFn?: typeof fetch;
  spawnFn?: SlackRpcGatewaySpawnFn;
  sleep?: SleepFn;
  cwd?: string;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
};

export type StopSlackRpcGatewayOptions = {
  config: SlackRpcGatewayBootstrapConfig;
  spawnFn?: SlackRpcGatewaySpawnFn;
  cwd?: string;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
};

export function resolveSlackRpcGatewayBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env
): SlackRpcGatewayBootstrapConfig {
  const composeFile = env.ADJUTANT_SLACK_RPC_COMPOSE_FILE?.trim();
  return {
    enabled: parseBooleanEnv(env.ADJUTANT_SLACK_RPC_ENABLED, true),
    autoStart: parseBooleanEnv(env.ADJUTANT_SLACK_RPC_AUTO_START, true),
    baseUrl: parseStringEnv(env.ADJUTANT_SLACK_RPC_BASE_URL, DEFAULT_BASE_URL),
    startupTimeoutMs: parsePositiveIntEnv(env.ADJUTANT_SLACK_RPC_STARTUP_TIMEOUT_MS, 20_000),
    healthcheckIntervalMs: parsePositiveIntEnv(env.ADJUTANT_SLACK_RPC_HEALTHCHECK_INTERVAL_MS, 500),
    composeService: parseStringEnv(env.ADJUTANT_SLACK_RPC_COMPOSE_SERVICE, DEFAULT_SERVICE),
    composeFile: composeFile ? composeFile : undefined,
  };
}

export async function ensureSlackRpcGatewayReady(
  options: EnsureSlackRpcGatewayReadyOptions
): Promise<void> {
  const config = options.config;
  if (!config.enabled) {
    return;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const sleep = options.sleep ?? defaultSleep;
  const cwd = options.cwd ?? process.cwd();
  const onLog = options.onLog;

  onLog?.("bootstrap-start", {
    autoStart: config.autoStart,
    baseUrl: config.baseUrl,
    startupTimeoutMs: config.startupTimeoutMs,
    healthcheckIntervalMs: config.healthcheckIntervalMs,
    composeService: config.composeService,
    composeFile: config.composeFile,
  });

  if (config.autoStart) {
    onLog?.("compose-up-start", {
      service: config.composeService,
      composeFile: config.composeFile,
      cwd,
    });
    await runComposeUp({
      spawnFn,
      cwd,
      service: config.composeService,
      composeFile: config.composeFile,
    });
    onLog?.("compose-up-done", {
      service: config.composeService,
    });
    onLog?.("compose-running-check-start", {
      service: config.composeService,
      timeoutMs: config.startupTimeoutMs,
      intervalMs: config.healthcheckIntervalMs,
    });
    await waitForComposeServiceRunning({
      spawnFn,
      cwd,
      service: config.composeService,
      composeFile: config.composeFile,
      timeoutMs: config.startupTimeoutMs,
      intervalMs: config.healthcheckIntervalMs,
      sleep,
      onProgress: (meta) => {
        onLog?.("compose-running-check-wait", meta);
      },
    });
    onLog?.("compose-running-check-done", {
      service: config.composeService,
    });
  }

  onLog?.("healthcheck-start", {
    baseUrl: config.baseUrl,
    timeoutMs: config.startupTimeoutMs,
    intervalMs: config.healthcheckIntervalMs,
  });
  await waitForHealth({
    fetchFn,
    baseUrl: config.baseUrl,
    timeoutMs: config.startupTimeoutMs,
    intervalMs: config.healthcheckIntervalMs,
    sleep,
    onProgress: (meta) => {
      onLog?.("healthcheck-wait", meta);
    },
  });
  onLog?.("bootstrap-ready", {
    baseUrl: config.baseUrl,
  });
}

export async function stopSlackRpcGateway(options: StopSlackRpcGatewayOptions): Promise<void> {
  const config = options.config;
  if (!config.enabled || !config.autoStart) {
    return;
  }
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const cwd = options.cwd ?? process.cwd();
  options.onLog?.("compose-stop-start", {
    service: config.composeService,
    composeFile: config.composeFile,
    cwd,
  });
  await runComposeStop({
    spawnFn,
    cwd,
    service: config.composeService,
    composeFile: config.composeFile,
  });
  options.onLog?.("compose-stop-done", {
    service: config.composeService,
  });
}

async function runComposeUp(input: {
  spawnFn: SlackRpcGatewaySpawnFn;
  cwd: string;
  service: string;
  composeFile?: string;
}): Promise<void> {
  const args = ["compose"];
  if (input.composeFile) {
    args.push("-f", input.composeFile);
  }
  args.push("up", "--build", "-d", input.service);

  await new Promise<void>((resolve, reject) => {
    const spawnOptions: { cwd: string; stdio: readonly ["ignore", "pipe", "pipe"] } = {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"] as const,
    };
    const child = input.spawnFn("docker", args, spawnOptions);
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", (error) => {
      reject(new Error(`docker compose failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join("").trim();
      const stdout = stdoutChunks.join("").trim();
      reject(
        new Error(
          `docker compose up failed: exit_code=${String(code)} stderr=${stderr || "(empty)"} stdout=${stdout || "(empty)"}`
        )
      );
    });
  });
}

async function runComposeStop(input: {
  spawnFn: SlackRpcGatewaySpawnFn;
  cwd: string;
  service: string;
  composeFile?: string;
}): Promise<void> {
  const args = ["compose"];
  if (input.composeFile) {
    args.push("-f", input.composeFile);
  }
  args.push("stop", input.service);

  await new Promise<void>((resolve, reject) => {
    const spawnOptions: { cwd: string; stdio: readonly ["ignore", "pipe", "pipe"] } = {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"] as const,
    };
    const child = input.spawnFn("docker", args, spawnOptions);
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", (error) => {
      reject(new Error(`docker compose failed to stop: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join("").trim();
      const stdout = stdoutChunks.join("").trim();
      reject(
        new Error(
          `docker compose stop failed: exit_code=${String(code)} stderr=${stderr || "(empty)"} stdout=${stdout || "(empty)"}`
        )
      );
    });
  });
}

async function waitForComposeServiceRunning(input: {
  spawnFn: SlackRpcGatewaySpawnFn;
  cwd: string;
  service: string;
  composeFile?: string;
  timeoutMs: number;
  intervalMs: number;
  sleep: SleepFn;
  onProgress?: (meta: Record<string, unknown>) => void;
}): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  let previousReason: string | undefined;
  while (Date.now() - startedAt < input.timeoutMs) {
    attempt += 1;
    const status = await queryComposeServiceRunning({
      spawnFn: input.spawnFn,
      cwd: input.cwd,
      service: input.service,
      composeFile: input.composeFile,
    });
    const elapsedMs = Date.now() - startedAt;
    const shouldReport =
      attempt === 1 || attempt % 5 === 0 || status.reason !== previousReason || status.running;
    if (shouldReport) {
      input.onProgress?.({
        attempt,
        elapsedMs,
        running: status.running,
        reason: status.reason,
      });
      previousReason = status.reason;
    }
    if (status.running) {
      return;
    }
    await input.sleep(input.intervalMs);
  }
  input.onProgress?.({
    timedOut: true,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: input.timeoutMs,
    attempts: attempt,
  });
  throw new Error(
    `slack rpc gateway service start timeout: service=${input.service} timeout_ms=${input.timeoutMs} attempts=${attempt}`
  );
}

async function queryComposeServiceRunning(input: {
  spawnFn: SlackRpcGatewaySpawnFn;
  cwd: string;
  service: string;
  composeFile?: string;
}): Promise<{ running: boolean; reason: string }> {
  const args = ["compose"];
  if (input.composeFile) {
    args.push("-f", input.composeFile);
  }
  args.push("ps", "--status", "running", "--services", input.service);

  const result = await runCommandCapture({
    spawnFn: input.spawnFn,
    cwd: input.cwd,
    command: "docker",
    args,
    errorPrefix: "docker compose ps failed",
  });
  if (result.exitCode !== 0) {
    return {
      running: false,
      reason: `ps_failed:${result.stderr || result.stdout || `exit_code_${String(result.exitCode)}`}`,
    };
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.includes(input.service)) {
    return { running: true, reason: "running" };
  }
  return {
    running: false,
    reason: "service_not_running",
  };
}

const defaultSpawnFn: SlackRpcGatewaySpawnFn = (command, args, options) => {
  const spawnOptions = {
    cwd: options.cwd,
    stdio: [...options.stdio] as ["ignore", "pipe", "pipe"],
  };
  return spawn(command, [...args], spawnOptions) as unknown as SpawnedProcess;
};

async function waitForHealth(input: {
  fetchFn: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  intervalMs: number;
  sleep: SleepFn;
  onProgress?: (meta: Record<string, unknown>) => void;
}): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  let previousReason: string | undefined;
  let previousStatus: number | undefined;
  while (Date.now() - startedAt < input.timeoutMs) {
    attempt += 1;
    const result = await checkHealth({
      fetchFn: input.fetchFn,
      baseUrl: input.baseUrl,
      timeoutMs: Math.min(2_000, input.timeoutMs),
    });
    const elapsedMs = Date.now() - startedAt;
    const shouldReport =
      attempt === 1 ||
      attempt % 5 === 0 ||
      result.status !== previousStatus ||
      result.reason !== previousReason;
    if (shouldReport) {
      input.onProgress?.({
        attempt,
        elapsedMs,
        status: result.status,
        reason: result.reason,
        ok: result.ok,
      });
      previousStatus = result.status;
      previousReason = result.reason;
    }
    if (result.ok) {
      return;
    }
    await input.sleep(input.intervalMs);
  }

  input.onProgress?.({
    timedOut: true,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: input.timeoutMs,
    attempts: attempt,
  });
  throw new Error(
    `slack rpc gateway health check timeout: base_url=${input.baseUrl} timeout_ms=${input.timeoutMs} attempts=${attempt}`
  );
}

async function checkHealth(input: {
  fetchFn: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchFn(`${trimTrailingSlash(input.baseUrl)}/healthz`, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, status: response.status, reason: "ok" };
    }
    if (response.status !== 503) {
      return { ok: false, status: response.status, reason: "unexpected_status" };
    }
    const bodyText = await response.text();
    const body = parseJsonObject(bodyText);
    const hasWorkspaceCounters =
      typeof body?.workspace_ready === "number" && typeof body?.workspace_total === "number";
    if (hasWorkspaceCounters) {
      // 0 workspace 起動モードでは legacy gateway が 503 を返すため、
      // readiness ではなく liveness 判定として受け入れる。
      return {
        ok: true,
        status: response.status,
        reason: "legacy_503_with_workspace_counters",
      };
    }
    return {
      ok: false,
      status: response.status,
      reason: "status_503_without_workspace_counters",
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, reason: "request_timeout" };
    }
    return { ok: false, reason: `request_failed:${toReason(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function runCommandCapture(input: {
  spawnFn: SlackRpcGatewaySpawnFn;
  cwd: string;
  command: string;
  args: readonly string[];
  errorPrefix: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const spawnOptions: { cwd: string; stdio: readonly ["ignore", "pipe", "pipe"] } = {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"] as const,
    };
    const child = input.spawnFn(input.command, input.args, spawnOptions);
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", (error) => {
      reject(new Error(`${input.errorPrefix}: ${error.message}`));
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout: stdoutChunks.join("").trim(),
        stderr: stderrChunks.join("").trim(),
      });
    });
  });
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(1, Math.floor(ms)));
  });
}

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && "name" in error) {
    return (error as { name?: unknown }).name === "AbortError";
  }
  return false;
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
