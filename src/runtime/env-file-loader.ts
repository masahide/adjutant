import { resolve } from "node:path";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadEnvFileIfPresent(params: { cwd?: string; fileName?: string } = {}): void {
  const cwd = params.cwd ?? process.cwd();
  const fileName = params.fileName ?? ".env";
  const envFilePath = resolve(cwd, fileName);

  try {
    process.loadEnvFile(envFilePath);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return;
    }
    throw new Error(`[Adjutant] .env 読み込みに失敗しました: ${toErrorMessage(error)}`);
  }
}
