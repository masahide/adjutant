import type { ToolHubError, ToolHubErrorCode, ToolHubMode, ToolHubSuccess } from "./types.js";

export function createToolHubSuccess(params: {
  mode: ToolHubMode;
  data: unknown;
  provider?: string;
  action?: string;
}): ToolHubSuccess {
  return {
    ok: true,
    mode: params.mode,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.action !== undefined ? { action: params.action } : {}),
    data: params.data,
  };
}

export function createToolHubError(params: {
  code: ToolHubErrorCode;
  message: string;
  provider?: string;
  action?: string;
}): ToolHubError {
  return {
    ok: false,
    code: params.code,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.action !== undefined ? { action: params.action } : {}),
    message: params.message,
  };
}
