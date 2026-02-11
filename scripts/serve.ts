import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureSlackWithCdp } from "./lib/slackCdp.js";

type CliOptions = {
  skipSlackHelper: boolean;
  runBrowser: boolean;
  configPath: string;
  help: boolean;
  openBrowser: boolean;
};

type RuntimeConfig = {
  timezone?: string;
  dataDir?: string;
  slack?: { enabled?: boolean };
};

type ProcessRestartPolicy = {
  maxRestarts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type ProcessSpec = {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile: string;
  restart?: ProcessRestartPolicy;
};

type ManagedProcess = {
  name: string;
  stop: () => Promise<void>;
};

type Logger = (level: "info" | "warn" | "error", message: string) => void;

const DEFAULT_CONFIG_PATH = "reaclog.config.json";
const STOP_TIMEOUT_MS = 5000;

function createLogger(scope: string): Logger {
  return (level, message) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}][${scope}][${level.toUpperCase()}] ${message}`;
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const logger = createLogger("serve");
  const slackLogger = createLogger("slack-helper");

  const configPath = resolve(process.cwd(), options.configPath);
  const runtimeConfig = loadRuntimeConfig(configPath, logger);

  const logsDir = join(process.cwd(), "logs", "runtime");
  mkdirSync(logsDir, { recursive: true });

  const host = process.env.CDP_HOST ?? "127.0.0.1";
  const port = Number(process.env.CDP_PORT ?? "9222");

  if (!options.skipSlackHelper) {
    logger("info", "Slack の CDP 利用可否を確認します。");
    await ensureSlackWithCdp({ host, port }, { logger: slackLogger, autoRestart: true });
  } else {
    logger("warn", "Slack CDP ヘルパーをスキップします (--skip-slack-helper)。");
  }

  const backendEntry = resolve(process.cwd(), "dist", "backend", "index.js");
  if (!existsSync(backendEntry)) {
    throw new Error(
      `バックエンドのビルド成果物が見つかりません: ${backendEntry}\n` +
        "先に `pnpm run build:backend` を実行してください。"
    );
  }

  const browserEntry = resolve(process.cwd(), "apps", "browser", "build", "index.js");
  if (options.runBrowser && !existsSync(browserEntry)) {
    throw new Error(
      `フロントエンドのビルド成果物が見つかりません: ${browserEntry}\n` +
        "先に `pnpm --filter browser build` を実行してください。\n" +
        "一時的にフロントエンドを省略する場合は `--no-browser` を指定できます。"
    );
  }

  const envBase: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
  };

  const resolvedDataDir = runtimeConfig.dataDir
    ? resolve(process.cwd(), runtimeConfig.dataDir)
    : undefined;

  if (resolvedDataDir) {
    envBase.DATA_DIR = resolvedDataDir;
    envBase.REACLOG_DATA_DIR = resolvedDataDir;
  }
  if (runtimeConfig.timezone) {
    envBase.REACLOG_TZ = runtimeConfig.timezone;
  }

  const managedProcesses: ManagedProcess[] = [];
  let shuttingDown = false;
  let fatalError: Error | null = null;

  const onFatal = async (name: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (shuttingDown) {
      return;
    }
    fatalError = new Error(`${name} プロセスが異常終了しました (code=${code}, signal=${signal}).`);
    await shutdown(1);
  };

  const backendSpec: ProcessSpec = {
    name: "backend",
    command: "node",
    args: [backendEntry],
    env: envBase,
    logFile: "backend.log",
    restart: {
      maxRestarts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
    },
  };
  managedProcesses.push(createManagedProcess(backendSpec, logsDir, logger, onFatal));

  if (options.runBrowser) {
    const browserSpec: ProcessSpec = {
      name: "browser",
      command: "node",
      args: [browserEntry],
      env: envBase,
      logFile: "browser.log",
    };
    managedProcesses.push(createManagedProcess(browserSpec, logsDir, logger, onFatal));
    if (options.openBrowser) {
      const host = envBase.HOST ?? process.env.HOST ?? "127.0.0.1";
      const portRaw = envBase.PORT ?? process.env.PORT ?? "3000";
      const port = Number.parseInt(portRaw, 10);
      const targetPort = Number.isFinite(port) ? port : 3000;
      void waitForBrowserAndOpen({
        host,
        port: targetPort,
        logger,
        shouldStop: () => shuttingDown,
      });
    }
  } else {
    logger("info", "フロントエンド起動はスキップされました (--no-browser)。");
    if (options.openBrowser) {
      logger("warn", "--open オプションは --no-browser と併用できません。");
    }
  }

  const handleSignal = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    logger("warn", `${signal} を受信したためシャットダウンします。`);
    await shutdown(0);
  };

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger("info", "子プロセスを停止しています...");
    for (const proc of managedProcesses) {
      try {
        await proc.stop();
      } catch (error) {
        logger(
          "error",
          `${proc.name} の停止に失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (fatalError) {
      logger("error", fatalError.message);
    }
    process.exit(exitCode);
  }

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  process.once("SIGHUP", handleSignal);

  process.on("uncaughtException", async (error) => {
    logger("error", `未処理の例外: ${error.message}`);
    fatalError = error;
    await shutdown(1);
  });

  process.on("unhandledRejection", async (reason) => {
    logger(
      "error",
      `未処理の Promise 拒否: ${reason instanceof Error ? reason.message : String(reason)}`
    );
    fatalError =
      reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
    await shutdown(1);
  });
}

function parseArgs(argv: string[]): CliOptions {
  let skipSlackHelper = false;
  let runBrowser = true;
  let configPath = DEFAULT_CONFIG_PATH;
  let help = false;
  let openBrowser = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      continue;
    }
    if (arg === "--skip-slack-helper") {
      skipSlackHelper = true;
      continue;
    }
    if (arg === "--no-browser") {
      runBrowser = false;
      continue;
    }
    if (arg === "--open" || arg === "-o") {
      openBrowser = true;
      continue;
    }
    if (arg === "--config") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--config オプションにはパスを指定してください。");
      }
      configPath = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    throw new Error(`未知のオプションです: ${arg}`);
  }

  return { skipSlackHelper, runBrowser, configPath, help, openBrowser };
}

function printHelp(): void {
  console.log(`ReacLog Serve コマンド

使用方法:
  pnpm run serve [-- --skip-slack-helper] [--no-browser] [--config <path>] [--open]

オプション:
  --skip-slack-helper   Slack の CDP 再起動ロジックをスキップします。
  --no-browser          フロントエンドを起動しません。
  --config <path>       設定ファイルのパスを指定します (既定: ${DEFAULT_CONFIG_PATH}).
  --open, -o            フロントエンド起動後に既定ブラウザでページを開きます。
  -h, --help            このヘルプを表示します。
`);
}

function loadRuntimeConfig(configPath: string, logger: Logger): RuntimeConfig {
  if (!existsSync(configPath)) {
    logger("info", `設定ファイルが見つかりませんでした (${configPath})。既定値を使用します。`);
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw) as RuntimeConfig;
    return parsed;
  } catch (error) {
    throw new Error(
      `設定ファイル (${configPath}) の読み込みに失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function createManagedProcess(
  spec: ProcessSpec,
  logsDir: string,
  logger: Logger,
  onFatal: (name: string, code: number | null, signal: NodeJS.Signals | null) => Promise<void>
): ManagedProcess {
  const logPath = join(logsDir, spec.logFile);
  const logStream = createWriteStream(logPath, { flags: "a" });
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  const writeLines = (data: Buffer, target: NodeJS.WriteStream) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const isLast = i === lines.length - 1;
      if (line.length === 0 && isLast) {
        continue;
      }
      const formatted = `[${new Date().toISOString()}][${spec.name}] ${line}\n`;
      logStream.write(formatted);
      target.write(formatted);
    }
  };

  const spawnProcess = () => {
    const env = spec.env ? { ...spec.env } : { ...process.env };
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data) => writeLines(data, process.stdout));
    child.stderr?.on("data", (data) => writeLines(data, process.stderr));

    child.on("exit", async (code, signal) => {
      const exitMessage = `[${new Date().toISOString()}][${
        spec.name
      }] exited (code=${code}, signal=${signal})\n`;
      logStream.write(exitMessage);
      process.stdout.write(exitMessage);

      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      if (stopping) {
        logStream.end();
        return;
      }

      if (spec.restart) {
        restarts += 1;
        if (restarts > spec.restart.maxRestarts) {
          logger(
            "error",
            `${spec.name} が最大リスタート回数を超えました (${spec.restart.maxRestarts})。`
          );
          await onFatal(spec.name, code, signal);
          return;
        }

        const delay = Math.min(
          spec.restart.baseDelayMs * 2 ** (restarts - 1),
          spec.restart.maxDelayMs
        );
        logger(
          "warn",
          `${spec.name} を ${delay}ms 後に再起動します (${restarts}/${spec.restart.maxRestarts}).`
        );
        restartTimer = setTimeout(() => {
          restartTimer = null;
          spawnProcess();
        }, delay);
        return;
      }

      await onFatal(spec.name, code, signal);
    });

    child.on("error", async (error) => {
      logger(
        "error",
        `${spec.name} の起動に失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!stopping) {
        await onFatal(spec.name, child?.exitCode ?? null, null);
      }
    });

    logger("info", `${spec.name} プロセスを起動しました: ${spec.command} ${spec.args.join(" ")}`);
  };

  spawnProcess();

  const stop = async (): Promise<void> => {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = child;
    if (!current) {
      logStream.end();
      return;
    }
    if (current.exitCode !== null || current.signalCode) {
      logStream.end();
      return;
    }

    current.kill("SIGTERM");
    const completed = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (current.killed) {
          resolve();
          return;
        }
        current.kill("SIGKILL");
      }, STOP_TIMEOUT_MS);
      current.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await completed;
    logStream.end();
  };

  return { name: spec.name, stop };
}

type BrowserOpenContext = {
  host: string;
  port: number;
  logger: Logger;
  shouldStop: () => boolean;
};

async function waitForBrowserAndOpen({
  host,
  port,
  logger,
  shouldStop,
}: BrowserOpenContext): Promise<void> {
  const normalizedHost = normalizeHost(host);
  const hostForUrl = needsBracket(normalizedHost)
    ? `[${normalizedHost.replace(/^\[|\]$/g, "")}]`
    : normalizedHost;
  const url = `http://${hostForUrl}:${port}`;
  logger("info", `フロントエンドの起動を待機し、準備が整い次第ブラウザを開きます (--open): ${url}`);

  const ready = await waitForHttpReady({
    url,
    retries: 30,
    delayMs: 1000,
    shouldStop,
  });

  if (!ready) {
    logger("warn", `ブラウザ自動起動に必要な応答を確認できませんでした: ${url}`);
    return;
  }

  try {
    await launchSystemBrowser(url);
    logger("info", `既定ブラウザを起動しました: ${url}`);
  } catch (error) {
    logger(
      "error",
      `ブラウザ自動起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeHost(host: string): string {
  if (!host || host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]" || host === "::1") {
    return "127.0.0.1";
  }
  return host;
}

function needsBracket(host: string): boolean {
  return host.includes(":") && !host.startsWith("[");
}

type WaitForHttpOptions = {
  url: string;
  retries: number;
  delayMs: number;
  shouldStop: () => boolean;
};

async function waitForHttpReady({
  url,
  retries,
  delayMs,
  shouldStop,
}: WaitForHttpOptions): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (shouldStop()) {
      return false;
    }
    try {
      await fetch(url, { method: "GET" });
      return true;
    } catch {
      // retry
    }
    await sleep(delayMs);
  }
  return false;
}

async function launchSystemBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  await new Promise<void>((resolve, reject) => {
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

await main().catch((error) => {
  const logger = createLogger("serve");
  logger(
    "error",
    `致命的なエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
