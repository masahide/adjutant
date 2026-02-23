import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveDataDir } from "../../src/runtime/config.js";

const originalDataDir = process.env.DATA_DIR;
const originalStateDir = process.env.ADJUTANT_STATE_DIR;

afterEach(() => {
  if (typeof originalDataDir === "string") {
    process.env.DATA_DIR = originalDataDir;
  } else {
    delete process.env.DATA_DIR;
  }
  if (typeof originalStateDir === "string") {
    process.env.ADJUTANT_STATE_DIR = originalStateDir;
  } else {
    delete process.env.ADJUTANT_STATE_DIR;
  }
});

describe("runtime/config resolveDataDir", () => {
  it("DATA_DIR 未指定時は ADJUTANT_STATE_DIR/data を返す", () => {
    delete process.env.DATA_DIR;
    process.env.ADJUTANT_STATE_DIR = "/tmp/adjutant-state";

    assert.equal(resolveDataDir(), "/tmp/adjutant-state/data");
  });

  it("DATA_DIR 指定時は DATA_DIR を優先する", () => {
    process.env.ADJUTANT_STATE_DIR = "/tmp/adjutant-state";
    process.env.DATA_DIR = "/tmp/custom-data";

    assert.equal(resolveDataDir(), "/tmp/custom-data");
  });
});
