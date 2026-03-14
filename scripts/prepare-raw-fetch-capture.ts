import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadCollectorSlackConfig } from "../src/collector-slack/config.js";

function resolveRawFetchLogPath(): string {
  const config = loadCollectorSlackConfig();
  const fromEnv =
    process.env.ADJUTANT_RAW_LOG_PATH?.trim() || process.env.ADJUTANT_RAW_FETCH_LOG_PATH?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  return join(config.dataDir, "_debug", "slack-debug.jsonl");
}

function main(): void {
  const config = loadCollectorSlackConfig();
  const rawLogPath = resolveRawFetchLogPath();
  mkdirSync(dirname(rawLogPath), { recursive: true });

  const recommendedEnv = {
    ADJUTANT_RAW_LOG_PATH: rawLogPath,
    ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS:
      process.env.ADJUTANT_RAW_FETCH_LOG_MAX_PAYLOAD_CHARS?.trim() || "20000",
  };

  console.log("# Raw log capture preparation");
  console.log("");
  console.log("resolved config:");
  console.log(
    JSON.stringify(
      {
        dataDir: config.dataDir,
        accountId: config.accountId,
        collectorEnabled: config.collectorEnabled,
        cdpEndpoint: config.endpoint,
        rawLogPath,
      },
      null,
      2
    )
  );
  console.log("");
  console.log("export snippet:");
  for (const [key, value] of Object.entries(recommendedEnv)) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
  console.log("");
  console.log("start command:");
  console.log("pnpm rawlog:capture");
  console.log("");
  console.log("next step:");
  console.log(
    `node --import tsx scripts/analyze-raw-fetch-log.ts --file ${shellQuote(rawLogPath)}`
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

main();
