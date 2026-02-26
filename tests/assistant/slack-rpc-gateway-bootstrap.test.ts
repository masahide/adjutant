import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  ensureSlackRpcGatewayReady,
  resolveSlackRpcGatewayBootstrapConfig,
  stopSlackRpcGateway,
  type SlackRpcGatewayBootstrapConfig,
  type SlackRpcGatewaySpawnFn,
} from "../../src/assistant/slack-rpc-gateway-bootstrap.js";

type SpawnCall = {
  command: string;
  args: readonly string[];
};

function createSpawnStub(input: {
  exitCode: number;
  stderr?: string;
  stdout?: string;
  composePsStdout?: string;
}) {
  const calls: SpawnCall[] = [];
  const spawnFn: SlackRpcGatewaySpawnFn = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    setImmediate(() => {
      const isComposePs = args.includes("ps");
      const stdout = isComposePs ? input.composePsStdout ?? input.stdout : input.stdout;
      if (stdout) {
        emitter.stdout.write(stdout);
      }
      if (input.stderr) {
        emitter.stderr.write(input.stderr);
      }
      emitter.emit("close", input.exitCode);
    });
    return emitter as unknown as {
      stdout: NodeJS.ReadableStream | null;
      stderr: NodeJS.ReadableStream | null;
      on: {
        (event: "error", listener: (error: Error) => void): unknown;
        (event: "close", listener: (code: number | null) => void): unknown;
      };
    };
  };
  return { spawnFn, calls };
}

function createBaseConfig(overrides: Partial<SlackRpcGatewayBootstrapConfig> = {}) {
  return {
    enabled: true,
    autoStart: true,
    baseUrl: "http://127.0.0.1:8080",
    startupTimeoutMs: 2000,
    healthcheckIntervalMs: 10,
    composeService: "slack-rpc-gateway",
    ...overrides,
  } satisfies SlackRpcGatewayBootstrapConfig;
}

describe("slack-rpc-gateway-bootstrap", () => {
  it("auto_start=1 のとき docker compose up を実行して health 成功で完了する", async () => {
    const { spawnFn, calls } = createSpawnStub({
      exitCode: 0,
      composePsStdout: "slack-rpc-gateway\n",
    });
    const fetchCalls: string[] = [];
    const fetchFn: typeof fetch = (async (input) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    }) as typeof fetch;

    await ensureSlackRpcGatewayReady({
      config: createBaseConfig(),
      spawnFn,
      fetchFn,
      sleep: async () => undefined,
      cwd: process.cwd(),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.command, "docker");
    assert.deepEqual(calls[0]?.args, ["compose", "up", "--build", "-d", "slack-rpc-gateway"]);
    assert.equal(calls[1]?.command, "docker");
    assert.deepEqual(calls[1]?.args, [
      "compose",
      "ps",
      "--status",
      "running",
      "--services",
      "slack-rpc-gateway",
    ]);
    assert.equal(fetchCalls.length >= 1, true);
  });

  it("auto_start=0 のとき compose を呼ばず health のみ待機する", async () => {
    const { spawnFn, calls } = createSpawnStub({ exitCode: 0 });
    const fetchFn: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false }), { status: 200 })) as typeof fetch;

    await ensureSlackRpcGatewayReady({
      config: createBaseConfig({ autoStart: false }),
      spawnFn,
      fetchFn,
      sleep: async () => undefined,
      cwd: process.cwd(),
    });

    assert.equal(calls.length, 0);
  });

  it("compose 失敗時はエラーを投げる", async () => {
    const { spawnFn } = createSpawnStub({ exitCode: 1, stderr: "compose failed" });
    const fetchFn: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    await assert.rejects(
      async () => {
        await ensureSlackRpcGatewayReady({
          config: createBaseConfig(),
          spawnFn,
          fetchFn,
          sleep: async () => undefined,
          cwd: process.cwd(),
        });
      },
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal(String((error as Error).message).includes("exit_code=1"), true);
        return true;
      }
    );
  });

  it("health check timeout で失敗する", async () => {
    const { spawnFn } = createSpawnStub({
      exitCode: 0,
      composePsStdout: "slack-rpc-gateway\n",
    });
    const fetchFn: typeof fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await ensureSlackRpcGatewayReady({
          config: createBaseConfig({ startupTimeoutMs: 30, healthcheckIntervalMs: 10 }),
          spawnFn,
          fetchFn,
          sleep: async () => undefined,
          cwd: process.cwd(),
        });
      },
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message.includes("health check timeout"), true);
        return true;
      }
    );
  });

  it("healthz が 503 でも workspace counters を返す場合は起動成功として扱う", async () => {
    const { spawnFn } = createSpawnStub({
      exitCode: 0,
      composePsStdout: "slack-rpc-gateway\n",
    });
    const fetchFn: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          workspace_total: 0,
          workspace_ready: 0,
          workspace_statuses: [],
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    await ensureSlackRpcGatewayReady({
      config: createBaseConfig({ startupTimeoutMs: 100, healthcheckIntervalMs: 10 }),
      spawnFn,
      fetchFn,
      sleep: async () => undefined,
      cwd: process.cwd(),
    });
  });

  it("healthz が 503 かつ不正レスポンスの場合は失敗する", async () => {
    const { spawnFn } = createSpawnStub({
      exitCode: 0,
      composePsStdout: "slack-rpc-gateway\n",
    });
    const fetchFn: typeof fetch = (async () =>
      new Response("temporary unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    await assert.rejects(
      async () => {
        await ensureSlackRpcGatewayReady({
          config: createBaseConfig({ startupTimeoutMs: 30, healthcheckIntervalMs: 10 }),
          spawnFn,
          fetchFn,
          sleep: async () => undefined,
          cwd: process.cwd(),
        });
      },
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message.includes("health check timeout"), true);
        return true;
      }
    );
  });

  it("env から bootstrap 設定を解決できる", () => {
    const cfg = resolveSlackRpcGatewayBootstrapConfig({
      ADJUTANT_SLACK_RPC_ENABLED: "1",
      ADJUTANT_SLACK_RPC_AUTO_START: "0",
      ADJUTANT_SLACK_RPC_BASE_URL: "http://127.0.0.1:18080",
      ADJUTANT_SLACK_RPC_STARTUP_TIMEOUT_MS: "12345",
      ADJUTANT_SLACK_RPC_HEALTHCHECK_INTERVAL_MS: "250",
      ADJUTANT_SLACK_RPC_COMPOSE_SERVICE: "custom-gateway",
      ADJUTANT_SLACK_RPC_COMPOSE_FILE: "compose.dev.yaml",
    } as NodeJS.ProcessEnv);

    assert.equal(cfg.enabled, true);
    assert.equal(cfg.autoStart, false);
    assert.equal(cfg.baseUrl, "http://127.0.0.1:18080");
    assert.equal(cfg.startupTimeoutMs, 12345);
    assert.equal(cfg.healthcheckIntervalMs, 250);
    assert.equal(cfg.composeService, "custom-gateway");
    assert.equal(cfg.composeFile, "compose.dev.yaml");
  });

  it("stopSlackRpcGateway は auto_start=1 で compose stop を実行する", async () => {
    const { spawnFn, calls } = createSpawnStub({ exitCode: 0 });

    await stopSlackRpcGateway({
      config: createBaseConfig({ composeService: "slack-rpc-gateway" }),
      spawnFn,
      cwd: process.cwd(),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "docker");
    assert.deepEqual(calls[0]?.args, ["compose", "stop", "slack-rpc-gateway"]);
  });

  it("stopSlackRpcGateway は auto_start=0 では compose stop を実行しない", async () => {
    const { spawnFn, calls } = createSpawnStub({ exitCode: 0 });

    await stopSlackRpcGateway({
      config: createBaseConfig({ autoStart: false }),
      spawnFn,
      cwd: process.cwd(),
    });

    assert.equal(calls.length, 0);
  });
});
