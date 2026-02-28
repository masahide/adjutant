export const ACP_AGENT_METHODS = {
  AUTHENTICATE: "authenticate",
  INITIALIZE: "initialize",
  SESSION_CANCEL: "session/cancel",
  SESSION_LOAD: "session/load",
  SESSION_NEW: "session/new",
  SESSION_PROMPT: "session/prompt",
  SESSION_SET_CONFIG_OPTION: "session/set_config_option",
  SESSION_SET_MODE: "session/set_mode",
} as const;

export const ACP_UNSTABLE_AGENT_METHODS = {
  SESSION_FORK: "session/fork",
  SESSION_LIST: "session/list",
  SESSION_RESUME: "session/resume",
  SESSION_SET_MODEL: "session/set_model",
} as const;

export const ACP_CLIENT_METHODS = {
  FS_READ_TEXT_FILE: "fs/read_text_file",
  FS_WRITE_TEXT_FILE: "fs/write_text_file",
  SESSION_REQUEST_PERMISSION: "session/request_permission",
  SESSION_UPDATE: "session/update",
  TERMINAL_CREATE: "terminal/create",
  TERMINAL_KILL: "terminal/kill",
  TERMINAL_OUTPUT: "terminal/output",
  TERMINAL_RELEASE: "terminal/release",
  TERMINAL_WAIT_FOR_EXIT: "terminal/wait_for_exit",
} as const;

export type AcpAgentMethod = (typeof ACP_AGENT_METHODS)[keyof typeof ACP_AGENT_METHODS];
export type AcpUnstableAgentMethod =
  (typeof ACP_UNSTABLE_AGENT_METHODS)[keyof typeof ACP_UNSTABLE_AGENT_METHODS];
export type AcpClientMethod = (typeof ACP_CLIENT_METHODS)[keyof typeof ACP_CLIENT_METHODS];

export type AcpMethod = AcpAgentMethod | AcpUnstableAgentMethod | AcpClientMethod;
