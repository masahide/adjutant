import {
  buildSandboxTmpfs,
  DEFAULT_SANDBOX_CAP_DROP,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_NETWORK,
  parseBooleanEnv,
  parseCsvEnv,
  parseOptionalTrimmedString,
  parsePositiveIntEnv,
  parseSandboxMode,
  parseTrimmedString,
  resolveSandboxHome,
  resolveSandboxWorkdir,
  resolveSandboxUser,
} from "./config-helpers.js";
import type { SandboxConfig } from "./types.js";

export function resolveSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const user = resolveSandboxUser(env.ADJUTANT_SANDBOX_USER);
  const home = resolveSandboxHome(env.ADJUTANT_SANDBOX_HOME);

  return {
    mode: parseSandboxMode(env.ADJUTANT_SANDBOX_MODE),
    docker: {
      image: parseTrimmedString(env.ADJUTANT_SANDBOX_IMAGE, DEFAULT_SANDBOX_IMAGE),
      autoBuildImage: parseBooleanEnv(env.ADJUTANT_SANDBOX_AUTO_BUILD_IMAGE, true),
      containerPrefix: parseTrimmedString(
        env.ADJUTANT_SANDBOX_CONTAINER_PREFIX,
        DEFAULT_SANDBOX_CONTAINER_PREFIX
      ),
      workdir: resolveSandboxWorkdir(env.ADJUTANT_SANDBOX_WORKDIR),
      home,
      user,
      envAllowlist: parseCsvEnv(env.ADJUTANT_SANDBOX_ENV_ALLOWLIST),
      readOnlyRoot: true,
      tmpfs: buildSandboxTmpfs(home, user),
      network: parseOptionalTrimmedString(env.ADJUTANT_SANDBOX_NETWORK) ?? DEFAULT_SANDBOX_NETWORK,
      capDrop: DEFAULT_SANDBOX_CAP_DROP,
      pidsLimit: parsePositiveIntEnv(env.ADJUTANT_SANDBOX_PIDS_LIMIT, 256),
      memory: parseOptionalTrimmedString(env.ADJUTANT_SANDBOX_MEMORY),
    },
  };
}
