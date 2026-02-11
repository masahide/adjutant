import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureDomSnapshot, type DomCaptureInput } from "../../src/slack/domCaptureCore.js";

type Attr = { name: string; value: string };

class FakeNode {
  nodeType = 1;
  tagName: string;
  className = "";
  innerText = "";
  textContent = "";
  dataset: Record<string, unknown> = {};
  attributes: Attr[] = [];
  private attrs: Record<string, string> = {};
  private queryOne = new Map<string, FakeNode | null>();
  private queryAll = new Map<string, FakeNode[]>();
  private closestMap = new Map<string, FakeNode | null>();

  constructor(tagName = "DIV", attrs: Record<string, string> = {}) {
    this.tagName = tagName;
    this.setAttrs(attrs);
  }

  setAttrs(attrs: Record<string, string>) {
    this.attrs = { ...attrs };
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  }

  setQuerySelector(selector: string, node: FakeNode | null) {
    this.queryOne.set(selector, node);
  }

  setQuerySelectorAll(selector: string, nodes: FakeNode[]) {
    this.queryAll.set(selector, nodes);
  }

  setClosest(selector: string, node: FakeNode | null) {
    this.closestMap.set(selector, node);
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  querySelector(selector: string): FakeNode | null {
    return this.queryOne.get(selector) ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.queryAll.get(selector) ?? [];
  }

  closest(selector: string): FakeNode | null {
    return this.closestMap.get(selector) ?? null;
  }

  cloneNode(): FakeNode {
    return this;
  }

  remove(): void {
    // noop for tests
  }

  matches(selector: string): boolean {
    return selector === "time[datetime]" && this.tagName.toLowerCase() === "time";
  }
}

class FakeDocument {
  private queryOne = new Map<string, FakeNode | null>();
  private queryAll = new Map<string, FakeNode[]>();

  setQuerySelector(selector: string, node: FakeNode | null) {
    this.queryOne.set(selector, node);
  }

  setQuerySelectorAll(selector: string, nodes: FakeNode[]) {
    this.queryAll.set(selector, nodes);
  }

  querySelector(selector: string): FakeNode | null {
    return this.queryOne.get(selector) ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.queryAll.get(selector) ?? [];
  }
}

const defaultInput = (tsList: string[]): DomCaptureInput => ({
  tsList,
  selectors: {
    root: ["[data-message-ts]"],
    body: ['[data-qa="message_content"]'],
    channel: ['[data-qa="channel_name_text"]'],
  },
  debugMode: true,
});

describe("captureDomSnapshot", () => {
  it("ts が無い場合は no-ts を返す", () => {
    const doc = new FakeDocument();
    const result = captureDomSnapshot(doc, defaultInput([]));
    assert.deepEqual(result, { status: "no-ts" });
  });

  it("対象メッセージが無い場合は no-target を返す", () => {
    const doc = new FakeDocument();
    const node = new FakeNode("DIV", { "data-message-ts": "1711112222.000100" });
    doc.setQuerySelectorAll("[data-message-ts]", [node]);

    const result = captureDomSnapshot(doc, defaultInput(["1711113333.000200"]));
    assert.equal("status" in result ? result.status : "", "no-target");
  });

  it("対象があれば text/channel/channelId/matchedTs を返す", () => {
    const doc = new FakeDocument();
    const target = new FakeNode("DIV", { "data-message-ts": "1711113333.000200" });
    const body = new FakeNode("DIV");
    body.innerText = " hello from dom ";
    body.textContent = " hello from dom ";
    const header = new FakeNode("DIV", { "data-qa-channel-id": "C123" });
    const channel = new FakeNode("SPAN");
    channel.textContent = "general";

    target.setQuerySelector('[data-qa="message_content"]', body);
    body.setClosest(
      "[data-qa='message_container'], .p-message_pane_message, .p-threads_view__thread_message",
      header
    );
    target.setClosest(
      "[data-qa='message_container'], .p-message_pane_message, .p-threads_view__thread_message",
      header
    );

    doc.setQuerySelectorAll("[data-message-ts]", [target]);
    doc.setQuerySelector('[data-qa="channel_name_text"]', channel);

    const result = captureDomSnapshot(doc, defaultInput(["1711113333.000200"]));
    assert.equal("text" in result ? result.text : "", "hello from dom");
    assert.equal("channel" in result ? result.channel : "", "general");
    assert.equal("channelId" in result ? result.channelId : "", "C123");
    assert.deepEqual("matchedTs" in result ? result.matchedTs : [], ["1711113333.000200"]);
  });
});
