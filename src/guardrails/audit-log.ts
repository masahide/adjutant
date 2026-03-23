import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GuardrailAuditRecord } from "./types.js";

export interface GuardrailAuditLogOptions {
  path: string;
  onWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export class GuardrailAuditLog {
  private readonly onWarn?: GuardrailAuditLogOptions["onWarn"];

  constructor(private readonly options: GuardrailAuditLogOptions) {
    this.onWarn = options.onWarn;
  }

  static fromStateDir(
    stateDir: string,
    options: Omit<GuardrailAuditLogOptions, "path"> = {}
  ): GuardrailAuditLog {
    return new GuardrailAuditLog({
      ...options,
      path: join(stateDir, "guardrails", "audit.jsonl"),
    });
  }

  async append(record: GuardrailAuditRecord): Promise<void> {
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      await appendFile(this.options.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.onWarn?.("failed to append guardrail audit record", {
        code,
        path: this.options.path,
      });
    }
  }
}
