import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function resolveDateKey(timezone: string, now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

export async function appendDailyMemory(params: {
  workspaceDir: string;
  content: string;
  timezone?: string;
  now?: Date;
}): Promise<{ path: string }> {
  const timezone = params.timezone ?? process.env.ADJUTANT_TZ ?? "Asia/Tokyo";
  const dateKey = resolveDateKey(timezone, params.now);
  const filePath = join(params.workspaceDir, "memory", `${dateKey}.md`);
  await mkdir(dirname(filePath), { recursive: true });
  const normalized = params.content.trim();
  const line = normalized.length > 0 ? `${normalized}\n` : "";
  if (line.length > 0) {
    await writeFile(filePath, line, { encoding: "utf8", flag: "a" });
  }
  return { path: `memory/${dateKey}.md` };
}

export async function updateLongTermMemory(params: {
  workspaceDir: string;
  content: string;
}): Promise<{ path: string }> {
  const filePath = join(params.workspaceDir, "MEMORY.md");
  await mkdir(dirname(filePath), { recursive: true });

  const normalized = params.content.trim();
  if (normalized.length === 0) {
    return { path: "MEMORY.md" };
  }

  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch {
    current = "";
  }
  const next = current.length > 0 ? `${current.trimEnd()}\n\n${normalized}\n` : `${normalized}\n`;
  await writeFile(filePath, next, "utf8");
  return { path: "MEMORY.md" };
}
