import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFileIfPresent } from "../../src/runtime/env-file-loader.js";

const TEST_ENV_KEY = "ADJUTANT_TEST_ENV_FILE_LOADER";
const originalEnvValue = process.env[TEST_ENV_KEY];

afterEach(() => {
  if (typeof originalEnvValue === "string") {
    process.env[TEST_ENV_KEY] = originalEnvValue;
  } else {
    delete process.env[TEST_ENV_KEY];
  }
});

describe("runtime/env-file-loader", () => {
  it(".env が存在する場合は環境変数を読み込む", () => {
    const dir = mkdtempSync(join(tmpdir(), "adjutant-env-loader-"));
    try {
      delete process.env[TEST_ENV_KEY];
      writeFileSync(join(dir, ".env"), `${TEST_ENV_KEY}=from-file\n`, "utf8");

      loadEnvFileIfPresent({ cwd: dir });

      assert.equal(process.env[TEST_ENV_KEY], "from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".env が存在しない場合は何もしない", () => {
    const dir = mkdtempSync(join(tmpdir(), "adjutant-env-loader-"));
    try {
      delete process.env[TEST_ENV_KEY];

      loadEnvFileIfPresent({ cwd: dir });

      assert.equal(process.env[TEST_ENV_KEY], undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既存の環境変数がある場合は .env の値で上書きしない", () => {
    const dir = mkdtempSync(join(tmpdir(), "adjutant-env-loader-"));
    try {
      process.env[TEST_ENV_KEY] = "pre-existing";
      writeFileSync(join(dir, ".env"), `${TEST_ENV_KEY}=from-file\n`, "utf8");

      loadEnvFileIfPresent({ cwd: dir });

      assert.equal(process.env[TEST_ENV_KEY], "pre-existing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
