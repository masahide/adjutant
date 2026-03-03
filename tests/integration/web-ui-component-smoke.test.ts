import assert from "node:assert/strict";
import nodeTest, { type TestContext } from "node:test";

const TEST_TIMEOUT_MS = 30_000;

const test = (name: string, fn: (t: TestContext) => Promise<void> | void): void => {
  nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
};

import { fireEvent, render, waitFor, cleanup } from "@testing-library/react";
import { JSDOM } from "jsdom";
import { createElement, type ComponentType } from "react";

import type {
  PermissionSummary,
  ToolEventRecord,
} from "../../src/control-plane/contracts/http-api.js";
import { ControlPlaneConsole } from "../../src/ui/components/control-plane-console.js";
import { ToolFallback } from "../../src/ui/components/assistant-ui/tool-fallback.js";

function installDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1",
  });

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousEvent = globalThis.Event;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame:
      dom.window.requestAnimationFrame?.bind(dom.window) ??
      ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16)),
    cancelAnimationFrame:
      dom.window.cancelAnimationFrame?.bind(dom.window) ?? ((id: number) => clearTimeout(id)),
  });

  return () => {
    cleanup();
    dom.window.close();
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      HTMLElement: previousHTMLElement,
      Event: previousEvent,
      getComputedStyle: previousGetComputedStyle,
      requestAnimationFrame: previousRequestAnimationFrame,
      cancelAnimationFrame: previousCancelAnimationFrame,
    });
  };
}

test("ControlPlaneConsole smoke: send, tool history, pending permissions", async (t) => {
  const restoreDom = installDom();
  t.after(() => {
    restoreDom();
  });

  const calls: Array<{ sessionKey: string; message: string }> = [];
  const toolEventsByRun: Record<string, ToolEventRecord[]> = {
    "session:sess_1:run:1": [
      {
        runId: "session:sess_1:run:1",
        sessionId: "sess_1",
        toolCallId: "call_1",
        status: "completed",
        updatedAt: "2026-02-28T10:00:00.000Z",
      },
    ],
  };
  const pendingPermissions: PermissionSummary[] = [
    {
      requestId: "perm_1",
      sessionId: "sess_1",
      title: "Allow bash",
      requestedAt: "2026-02-28T10:00:01.000Z",
    },
  ];

  const view = render(
    createElement(ControlPlaneConsole, {
      onSend: async (input) => {
        calls.push(input);
        return {
          runId: "session:sess_1:run:1",
          sessionRecoveryMode: "fallback_new_session",
          sessionRecoveryReason: "INVALID_RECORD",
        };
      },
      toolEventsByRun,
      pendingPermissions,
    })
  );

  const historyText = view.getByLabelText("tool-history").textContent ?? "";
  assert.equal(historyText.includes("call_1"), true);
  assert.equal(historyText.includes("completed"), true);

  const permissionText = view.getByLabelText("pending-permissions").textContent ?? "";
  assert.equal(permissionText.includes("Allow bash"), true);

  const sessionInput = view.getByRole("textbox", { name: "Session" }) as HTMLInputElement;
  const messageInput = view.getByRole("textbox", { name: "Message" }) as HTMLInputElement;

  fireEvent.change(sessionInput, {
    target: { value: "main" },
  });
  fireEvent.change(messageInput, {
    target: { value: "hello-ui" },
  });
  assert.equal(messageInput.value, "hello-ui");
  await waitFor(() => {
    assert.equal(
      (view.getByRole("textbox", { name: "Message" }) as HTMLInputElement).value,
      "hello-ui"
    );
  });
  fireEvent.click(view.getByRole("button", { name: "Send" }));

  await waitFor(() => {
    assert.equal(calls.length, 1);
  });
  assert.deepEqual(calls[0], { sessionKey: "main", message: "hello-ui" });

  await waitFor(() => {
    assert.equal(view.getByTestId("last-run-id").textContent, "session:sess_1:run:1");
  });
  await waitFor(() => {
    assert.equal(
      (view.getByTestId("session-recovery-message").textContent ?? "").includes(
        "new session fallback"
      ),
      true
    );
  });
});

test("ToolFallback smoke: collapsible shows args/result and closes with state transition", async (t) => {
  const restoreDom = installDom();
  t.after(() => {
    restoreDom();
  });

  const view = render(
    createElement(ToolFallback as unknown as ComponentType<Record<string, unknown>>, {
      type: "tool-call",
      toolCallId: "call_smoke_1",
      toolName: "bash",
      args: {},
      argsText: '{"cmd":"echo hi"}',
      result: { stdout: "hi" },
      status: { type: "complete" },
    })
  );
  const trigger = view.getByText("Used tool:", { exact: false }).closest("button");
  const content = view.container.querySelector('[data-slot="tool-fallback-content"]');
  if (!trigger || !content) {
    throw new Error("ToolFallback の trigger/content が見つかりません");
  }

  await waitFor(() => {
    assert.notEqual(view.queryByText("Result:"), null);
  });
  assert.notEqual(view.queryByText('{"cmd":"echo hi"}'), null);
  assert.notEqual(view.queryByText(/"stdout"\s*:\s*"hi"/), null);
  assert.equal(trigger.getAttribute("data-state"), "open");
  assert.equal(content.getAttribute("data-state"), "open");

  fireEvent.click(trigger);

  await waitFor(() => {
    assert.equal(trigger.getAttribute("data-state"), "closed");
    assert.equal(content.getAttribute("data-state"), "closed");
  });
  assert.notEqual(view.queryByText("Result:"), null);
  assert.notEqual(view.queryByText('{"cmd":"echo hi"}'), null);
});
