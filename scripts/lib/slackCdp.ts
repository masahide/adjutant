import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CdpConfig = {
  host: string;
  port: number;
};

export type Logger = (level: "info" | "warn" | "error", message: string) => void;

export type EnsureSlackOptions = {
  logger?: Logger;
  promptYesNo?: (message: string, options?: PromptOptions) => Promise<boolean>;
  autoRestart?: boolean;
  nonInteractive?: boolean;
  waitForCdpRetries?: number;
  waitForCdpDelayMs?: number;
};

const defaultLogger: Logger = (level, message) => {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}][slack-helper][${level.toUpperCase()}]`;
  const output = `${prefix} ${message}`;
  if (level === "error") {
    console.error(output);
    return;
  }
  if (level === "warn") {
    console.warn(output);
    return;
  }
  console.log(output);
};

type PromptOptions = {
  defaultValue?: boolean;
};

const defaultPromptYesNo = async (
  message: string,
  options: PromptOptions = {}
): Promise<boolean> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized.length === 0 && options.defaultValue !== undefined) {
        resolve(options.defaultValue);
        return;
      }
      resolve(normalized === "y" || normalized === "yes");
    });
  });
};

export async function ensureSlackWithCdp(
  { host, port }: CdpConfig,
  options: EnsureSlackOptions = {}
): Promise<void> {
  const {
    logger = defaultLogger,
    promptYesNo = defaultPromptYesNo,
    autoRestart = false,
    nonInteractive = false,
    waitForCdpRetries = 20,
    waitForCdpDelayMs = 500,
  } = options;

  if (await isCdpAvailable(host, port)) {
    logger("info", `Slack CDP は既に利用可能です (ws://${host}:${port}).`);
    return;
  }

  const slackRunning = await isSlackRunning();
  if (slackRunning) {
    logger("warn", "Slack が CDP 無効で起動しています。");
    if (nonInteractive) {
      throw new Error(
        "Slack が CDP 無効で起動しています。自動で終了できないため手動で Slack を停止するか、--skip-slack-helper を使用してください。"
      );
    }

    const defaultYes = autoRestart === true;
    const choice = await promptYesNo(
      `Slack を終了して CDP 有効で再起動しますか？ ${defaultYes ? "[Y/n]" : "[y/N]"} `,
      { defaultValue: defaultYes }
    );

    if (!choice) {
      throw new Error("ユーザーの指示により Slack は終了せずに処理を中断します。");
    }

    logger("info", "Slack を終了します。");
    await requestSlackQuit(logger);
    await waitForSlackShutdown(logger);
  } else {
    logger("info", "Slack は未起動のため CDP 有効モードで起動します。");
  }

  await launchSlackCdp(port, logger);
  const ready = await waitForCdp({
    host,
    port,
    retries: waitForCdpRetries,
    delayMs: waitForCdpDelayMs,
    logger,
  });
  if (!ready) {
    throw new Error(`Slack CDP (${host}:${port}) がタイムアウト内に起動しませんでした。`);
  }
}

async function isCdpAvailable(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, {
      method: "GET",
    });
    if (!response.ok) {
      return false;
    }
    const data = await response.json();
    return typeof data.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

async function waitForCdp({
  host,
  port,
  retries,
  delayMs,
  logger,
}: CdpConfig & {
  retries: number;
  delayMs: number;
  logger: Logger;
}): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await isCdpAvailable(host, port)) {
      return true;
    }
    logger(
      "info",
      `Slack CDP を待機中 (${attempt + 1}/${retries})... ${delayMs}ms 後に再試行します。`
    );
    await sleep(delayMs);
  }
  return false;
}

async function isSlackRunning(): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to (name of processes) contains "Slack"',
      ]);
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-Process -Name Slack -ErrorAction SilentlyContinue) -ne $null",
      ]);
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "Slack"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function requestSlackQuit(logger: Logger): Promise<void> {
  logger("info", "Slack を停止します。");
  if (process.platform === "darwin") {
    try {
      await execFileAsync("osascript", ["-e", 'tell application "Slack" to quit']);
      return;
    } catch {
      // fall through to killall
    }
    await execFileAsync("killall", ["Slack"]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process -Name Slack -ErrorAction SilentlyContinue | Stop-Process",
    ]);
    return;
  }

  await execFileAsync("pkill", ["-f", "Slack"]);
}

async function waitForSlackShutdown(logger: Logger): Promise<void> {
  logger("info", "Slack の終了を待機します。");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isSlackRunning())) {
      logger("info", "Slack の終了を確認しました。");
      return;
    }
    await sleep(500);
  }
  logger("warn", "Slack が終了しないため次の処理へ進みます。");
}

async function launchSlackCdp(port: number, logger: Logger): Promise<void> {
  logger("info", `Slack を CDP 有効で起動します (port=${port}).`);
  const scriptPath = join(process.cwd(), "hack", "launch_slack_cdp.sh");
  await runAndLogCommand("bash", [scriptPath, String(port)], logger);
}

async function runAndLogCommand(command: string, args: string[], logger: Logger): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} がコード ${code} で終了しました`));
      }
    });
    child.on("error", (error) => {
      logger("error", `${command} の起動に失敗しました: ${error.message}`);
      reject(error);
    });
  });
}
