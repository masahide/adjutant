export type ToolActionMeta = {
  name: string;
  description: string;
  requiredArgs: string[];
  argsSchema: Record<string, unknown>;
};

export type ToolProviderMeta = {
  name: string;
  description: string;
  actions: ToolActionMeta[];
};

export type ToolCatalog = {
  providers: ToolProviderMeta[];
};

export type WorkspaceSummary = {
  workspace_key: string;
  aliases: string[];
  account_id?: string;
  has_tokens: boolean;
  auth_test_status?: string;
  last_seen_at: number;
};

export type ToolExecutionResult = {
  ok: boolean;
  mode?: string;
  code?: string;
  provider?: string;
  action?: string;
  data?: unknown;
  message?: string;
};

export type ToolHistoryEntry = {
  provider: string;
  action: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  executedAt: number;
};
