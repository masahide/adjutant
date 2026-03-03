import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  attachUtf8LineReader,
  computeNextRestartCount,
  isUnexpectedChildExit,
} from "../../../../src/control-plane/supervisor/stdio-supervisor-utils.js";

test("attachUtf8LineReader splits utf8 chunks by newline and trims empty lines", async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  attachUtf8LineReader(stream, (line) => {
    lines.push(line);
  });

  stream.write('{"a":1}\n{"b":');
  stream.write('2}\n\n{"c":3}\n');
  stream.end();

  await new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
  });

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("isUnexpectedChildExit returns false only for clean exit while not stopping", () => {
  assert.equal(isUnexpectedChildExit(false, 0, null), false);
  assert.equal(isUnexpectedChildExit(false, 1, null), true);
  assert.equal(isUnexpectedChildExit(false, null, "SIGTERM"), true);
  assert.equal(isUnexpectedChildExit(true, 1, null), false);
});

test("computeNextRestartCount increments only while under limit", () => {
  assert.equal(computeNextRestartCount({ crashed: false, restartCount: 0, maxRestarts: 3 }), null);
  assert.equal(computeNextRestartCount({ crashed: true, restartCount: 0, maxRestarts: 3 }), 1);
  assert.equal(computeNextRestartCount({ crashed: true, restartCount: 3, maxRestarts: 3 }), null);
});
