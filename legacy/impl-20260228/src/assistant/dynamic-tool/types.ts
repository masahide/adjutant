export type ToolHubInput = {
  provider?: string;
  action?: string;
  args?: Record<string, unknown>;
};

export const TOOL_HUB_MODES = ["catalog", "provider_help", "action_help", "execute"] as const;

export type ToolHubMode = (typeof TOOL_HUB_MODES)[number];

export const TOOL_HUB_ERROR_CODES = [
  "unknown_provider",
  "unknown_action",
  "validation_error",
  "execution_error",
] as const;

export type ToolHubErrorCode = (typeof TOOL_HUB_ERROR_CODES)[number];

export type ToolHubSuccess = {
  ok: true;
  mode: ToolHubMode;
  provider?: string;
  action?: string;
  data: unknown;
};

export type ToolHubError = {
  ok: false;
  code: ToolHubErrorCode;
  provider?: string;
  action?: string;
  message: string;
};

export type ToolHubResult = ToolHubSuccess | ToolHubError;
