import fs from "node:fs";
import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");

export type CdpEndpoint = {
  host: string;
  port: number;
};

export function resolveEndpoint(): CdpEndpoint {
  const file =
    process.env.CDP_ENDPOINT_FILE || path.resolve(process.cwd(), ".reaclog/cdp-endpoint.json");

  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const host = typeof j.host === "string" && j.host ? j.host : DEFAULT_HOST;
      const port = Number.isFinite(+j.port) ? Number(j.port) : DEFAULT_PORT;
      return { host, port };
    } catch {
      // 破損時は無視して環境変数へフォールバック
    }
  }

  const host = process.env.CDP_HOST || DEFAULT_HOST;
  const port = Number(process.env.CDP_PORT || DEFAULT_PORT);
  return { host, port };
}

export function resolveDataDir(): string {
  const env = process.env.DATA_DIR;
  if (env && env.trim()) return path.resolve(env);
  return DEFAULT_DATA_DIR;
}
