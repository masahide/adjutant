import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SlackMode, SlackRouteStore, WorkspaceRoutePin } from "./types.js";

type PersistedPins = {
  schema: "adjutant.slack.workspace-route-pin.v1";
  updatedAt: string;
  pins: WorkspaceRoutePin[];
};

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asMode(value: unknown): SlackMode | undefined {
  if (value === "team" || value === "enterprise") {
    return value;
  }
  return undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

export type WorkspaceRoutePinStoreOptions = {
  filePath: string;
  now?: () => Date;
};

export class WorkspaceRoutePinStore implements SlackRouteStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private loaded = false;
  private readonly pins = new Map<string, WorkspaceRoutePin>();

  constructor(options: WorkspaceRoutePinStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
  }

  async get(workspaceKey: string): Promise<WorkspaceRoutePin | null> {
    await this.loadIfNeeded();
    const key = asString(workspaceKey);
    if (!key) {
      return null;
    }
    return this.pins.get(key) ?? null;
  }

  async set(pin: WorkspaceRoutePin): Promise<void> {
    await this.loadIfNeeded();
    const workspaceKey = asString(pin.workspaceKey);
    const mode = asMode(pin.mode);
    const decidedAt = asTimestamp(pin.decidedAt);
    if (!workspaceKey || !mode || decidedAt === undefined) {
      return;
    }

    this.pins.set(workspaceKey, { workspaceKey, mode, decidedAt });
    await this.persist();
  }

  private async loadIfNeeded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { pins?: unknown };
      const pins = Array.isArray(parsed.pins) ? parsed.pins : [];
      for (const item of pins) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        const record = item as Record<string, unknown>;
        const workspaceKey = asString(record.workspaceKey);
        const mode = asMode(record.mode);
        const decidedAt = asTimestamp(record.decidedAt);
        if (!workspaceKey || !mode || decidedAt === undefined) {
          continue;
        }
        this.pins.set(workspaceKey, {
          workspaceKey,
          mode,
          decidedAt,
        });
      }
    } catch {
      // no-op
    }
  }

  private async persist(): Promise<void> {
    const payload: PersistedPins = {
      schema: "adjutant.slack.workspace-route-pin.v1",
      updatedAt: this.now().toISOString(),
      pins: [...this.pins.values()],
    };

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // no-op
    }
  }
}
