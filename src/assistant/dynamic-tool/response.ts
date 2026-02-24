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
    provider: params.provider,
    action: params.action,
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
    provider: params.provider,
    action: params.action,
    message: params.message,
  };
}
