import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ensureSlackWithCdp } from "./lib/slackCdp.js";

type ProcessConfig = {
  name: string;
  command: string[];
  logFileName: string;
};

type ManagedProcess = {
  child: ChildProcess;
  stop: () => void;
};

const logDir = join(process.cwd(), "logs");
mkdirSync(logDir, { recursive: true });

const processConfigs: ProcessConfig[] = [
  {
    name: "backend",
    command: ["pnpm", "start"],
    logFileName: "backend-dev.log",
  },
  {
    name: "browser",
    command: ["pnpm", "--filter", "browser", "dev", "--open"],
    logFileName: "browser-dev.log",
  },
];

function runProcess(config: ProcessConfig): ManagedProcess {
  const { name, command, logFileName } = config;
  const logFile = join(logDir, logFileName);
  const logStream = createWriteStream(logFile, { flags: "a" });

  const child = spawn(command[0]!, command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const writeLines = (data: Buffer, target: NodeJS.WriteStream) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const isLastLine = index === lines.length - 1;
      if (line.length === 0 && isLastLine) {
        continue;
      }

      const message = `[${new Date().toISOString()}][${name}] ${line}\n`;
      logStream.write(message);
      target.write(message);
    }
  };

  child.stdout.on("data", (data) => writeLines(data, process.stdout));
  child.stderr.on("data", (data) => writeLines(data, process.stderr));

  child.on("exit", (code, signal) => {
    const exitMessage = `[${new Date().toISOString()}][${name}] exited (code=${code}, signal=${signal})\n`;
    logStream.write(exitMessage);
    process.stdout.write(exitMessage);
    logStream.end();
  });

  child.on("error", (error) => {
    const errorMessage = `[${new Date().toISOString()}][${name}] failed to start (${error.message})\n`;
    logStream.write(errorMessage);
    process.stderr.write(errorMessage);
  });

  const stop = () => {
    if (!child.killed) {
      child.kill();
    }
  };

  return { child, stop };
}

function handleShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const managed of managedProcesses) {
    managed.stop();
  }
}

const managedProcesses: ManagedProcess[] = [];
let shuttingDown = false;

await main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
  handleShutdown();
});

async function main() {
  const cdpHost = process.env.CDP_HOST ?? "127.0.0.1";
  const cdpPort = Number(process.env.CDP_PORT ?? "9222");

  await ensureSlackWithCdp({ host: cdpHost, port: cdpPort });

  for (const config of processConfigs) {
    managedProcesses.push(runProcess(config));
  }

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
