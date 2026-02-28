export type DomCaptureSelectors = {
  root: string[];
  body: string[];
  channel: string[];
};

export type DomCaptureInput = {
  tsList: string[];
  selectors: DomCaptureSelectors;
  debugMode: boolean;
};

export type DomCaptureStatus = "no-ts" | "no-target" | "empty-text";

export type DomSample = {
  index: number;
  tag: string | null;
  classes: string[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  datetime: string | null;
  text: string | null;
};

export type DomCaptureSuccess = {
  text: string;
  channel?: string | null;
  channelId?: string | null;
  matchedTs?: string[];
};

export type DomCaptureFailure = {
  status: DomCaptureStatus;
  needles?: string[];
  candidateCount?: number;
  sampleTs?: string[];
  samples?: DomSample[];
  hasBody?: boolean;
  matchedTs?: string[];
};

export type DomCaptureError = {
  error: string;
};

export type DomCaptureResult = DomCaptureSuccess | DomCaptureFailure | DomCaptureError;

type DomAttrLike = {
  name: string;
  value: string;
};

type DomNodeLike = {
  nodeType?: number;
  tagName?: string;
  className?: string;
  attributes?: Iterable<DomAttrLike>;
  dataset?: Record<string, unknown>;
  innerText?: string;
  textContent?: string;
  getAttribute?: (name: string) => string | null;
  querySelectorAll?: (selector: string) => Iterable<DomNodeLike>;
  querySelector?: (selector: string) => DomNodeLike | null;
  cloneNode?: (deep: boolean) => DomNodeLike;
  remove?: () => void;
  closest?: (selector: string) => DomNodeLike | null;
  matches?: (selector: string) => boolean;
};

type DomDocumentLike = {
  querySelectorAll: (selector: string) => Iterable<DomNodeLike>;
  querySelector: (selector: string) => DomNodeLike | null;
};

export function captureDomSnapshot(
  docLike: DomDocumentLike,
  input: DomCaptureInput
): DomCaptureResult {
  try {
    const toArray = (value: unknown): unknown[] => {
      if (Array.isArray(value)) return value;
      return value == null ? [] : [value];
    };
    const needles = toArray(input.tsList)
      .map((value) => (typeof value === "string" ? value : String(value ?? "")))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (needles.length === 0) {
      return { status: "no-ts" };
    }

    const rootSelectors = Array.isArray(input.selectors?.root) ? input.selectors.root : [];
    const bodySelectors = Array.isArray(input.selectors?.body) ? input.selectors.body : [];
    const channelSelectors = Array.isArray(input.selectors?.channel) ? input.selectors.channel : [];

    const nodes: DomNodeLike[] = [];
    const seen = new Set<DomNodeLike>();
    const pushNode = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const casted = node as DomNodeLike;
      if (casted.nodeType !== 1) return;
      if (seen.has(casted)) return;
      seen.add(casted);
      nodes.push(casted);
    };

    const ensureNodes = (selector: string) => {
      if (!selector || typeof selector !== "string") return;
      try {
        for (const node of docLike.querySelectorAll(selector)) {
          pushNode(node);
        }
      } catch {
        // ignore selector errors
      }
    };

    for (const selector of rootSelectors) {
      ensureNodes(selector);
    }
    if (nodes.length === 0) {
      ensureNodes("[data-message-id]");
      ensureNodes("[data-message-ts]");
      ensureNodes(".c-message_kit__message");
      ensureNodes(".p-message_pane_message");
      ensureNodes(".c-virtual_list__item");
      ensureNodes("[data-qa='virtual-list-item']");
    }

    const attr = (element: DomNodeLike | null | undefined, name: string): string => {
      if (!element || typeof element.getAttribute !== "function") return "";
      const value = element.getAttribute(name);
      return typeof value === "string" ? value : "";
    };

    const registerValue = (set: Set<string>, value: unknown) => {
      if (typeof value === "string" && value.length > 0) {
        set.add(value);
      }
    };

    const collectTs = (element: DomNodeLike | null | undefined): string[] => {
      const values = new Set<string>();
      const queue: DomNodeLike[] = [];
      const visited = new Set<DomNodeLike>();
      if (element) queue.push(element);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== "object") continue;
        if (visited.has(current)) continue;
        visited.add(current);
        if (current.nodeType !== 1) continue;

        registerValue(values, attr(current, "data-message-ts"));
        registerValue(values, attr(current, "data-message-id"));
        registerValue(values, attr(current, "data-message-ts-normalized"));
        registerValue(values, attr(current, "data-ts"));
        registerValue(values, attr(current, "data-qa-ts"));
        registerValue(values, attr(current, "data-qa-message-id"));
        registerValue(values, attr(current, "data-sort-key"));

        if (current.dataset && typeof current.dataset === "object") {
          for (const key of Object.keys(current.dataset)) {
            registerValue(values, current.dataset[key]);
          }
        }

        if (typeof current.matches === "function" && current.matches("time[datetime]")) {
          registerValue(values, attr(current, "datetime"));
        }

        if (typeof current.querySelectorAll === "function") {
          try {
            for (const child of current.querySelectorAll(
              "[data-message-ts],[data-message-id],[data-ts],[data-qa-ts],time[datetime]"
            )) {
              queue.push(child);
            }
          } catch {
            // ignore selector errors
          }
        }
      }
      return Array.from(values);
    };

    const matchesNeedle = (value: string) => needles.some((needle) => value.includes(needle));

    const cleanupSelectors = [
      "[data-qa='message_reactions']",
      "[data-qa='message-reactions']",
      "[data-qa='message_actions']",
      "[data-qa='add-reaction']",
      "[data-qa='more_message_actions']",
      ".c-reaction",
      ".c-reaction_bar",
      ".c-message_kit__reaction",
      ".c-message_kit__reaction_bar",
      ".c-message_kit__actions",
      ".p-message_pane_message__actions",
    ];

    const sanitizeNode = (node: DomNodeLike): DomNodeLike => {
      if (!node || typeof node.cloneNode !== "function") return node;
      const clone = node.cloneNode(true);
      for (const selector of cleanupSelectors) {
        try {
          if (typeof clone.querySelectorAll === "function") {
            for (const element of clone.querySelectorAll(selector)) {
              if (typeof element.remove === "function") {
                element.remove();
              }
            }
          }
        } catch {
          // ignore selector errors
        }
      }
      return clone;
    };

    const describeNode = (node: DomNodeLike, index: number): DomSample | null => {
      if (!node || typeof node !== "object") return null;
      const tag = typeof node.tagName === "string" ? node.tagName.toLowerCase() : null;
      const classes =
        typeof node.className === "string" && node.className.length > 0
          ? node.className.split(/\s+/).filter(Boolean).slice(0, 10)
          : [];
      const attrs: Record<string, string> = {};
      if (node.attributes && typeof node.attributes === "object") {
        const list = Array.from(node.attributes).slice(0, 10);
        for (const item of list) {
          if (item && typeof item.name === "string") {
            attrs[item.name] = String(item.value ?? "").slice(0, 160);
          }
        }
      }

      const dataset: Record<string, string> = {};
      if (node.dataset && typeof node.dataset === "object") {
        const keys = Object.keys(node.dataset).slice(0, 10);
        for (const key of keys) {
          dataset[key] = String(node.dataset[key] ?? "").slice(0, 160);
        }
      }

      let datetime: string | null = null;
      if (typeof node.querySelector === "function") {
        const timeNode = node.querySelector("time[datetime]");
        if (timeNode && typeof timeNode.getAttribute === "function") {
          datetime = timeNode.getAttribute("datetime");
        }
      }

      const text =
        typeof node.innerText === "string"
          ? node.innerText.trim().slice(0, 120)
          : typeof node.textContent === "string"
            ? node.textContent.trim().slice(0, 120)
            : null;

      return {
        index,
        tag,
        classes,
        attrs,
        dataset,
        datetime,
        text,
      };
    };

    const collectSampleTs = (): string[] | undefined => {
      if (!input.debugMode) return undefined;
      const sample: string[] = [];
      for (const node of nodes) {
        for (const value of collectTs(node)) {
          if (!sample.includes(value)) sample.push(value);
          if (sample.length >= 12) break;
        }
        if (sample.length >= 12) break;
      }
      return sample;
    };

    const collectSamples = (): DomSample[] | undefined => {
      if (!input.debugMode) return undefined;
      const result: DomSample[] = [];
      const limit = Math.min(nodes.length, 5);
      for (let i = 0; i < limit; i += 1) {
        const node = nodes[i];
        const described = describeNode(node, i);
        if (described) result.push(described);
      }
      return result;
    };

    const findTarget = (): DomNodeLike | null => {
      for (const node of nodes) {
        const values = collectTs(node);
        if (values.some(matchesNeedle)) return node;
      }
      return null;
    };

    let target = findTarget();
    if (!target) {
      ensureNodes("[data-message-id]");
      ensureNodes("[data-message-ts]");
      ensureNodes("[data-qa='message']");
      ensureNodes("[data-qa='message_container']");
      ensureNodes(".c-message_kit__message");
      ensureNodes(".p-message_pane_message");
      target = findTarget();
    }

    if (!target) {
      return {
        status: "no-target",
        needles,
        candidateCount: nodes.length,
        sampleTs: collectSampleTs(),
        samples: collectSamples(),
      };
    }

    let body: DomNodeLike | null = null;
    for (const selector of bodySelectors) {
      try {
        if (typeof target.querySelector === "function") {
          const found = target.querySelector(selector);
          if (found) {
            body = found;
            if (typeof found.innerText === "string" && found.innerText.trim().length > 0) break;
          }
        }
      } catch {
        // ignore selector errors
      }
    }

    const source = body ?? target;
    const sanitized = sanitizeNode(source);
    const rawText = sanitized?.innerText ?? sanitized?.textContent ?? "";
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) {
      return {
        status: "empty-text",
        needles,
        hasBody: Boolean(body),
        matchedTs: collectTs(target),
        samples: collectSamples(),
      };
    }

    let channelName: string | null = null;
    let channelId: string | null = null;
    const headerSelector =
      "[data-qa='message_container'], .p-message_pane_message, .p-threads_view__thread_message";
    const headerNode =
      body && typeof body.closest === "function"
        ? body.closest(headerSelector)
        : typeof target.closest === "function"
          ? target.closest(headerSelector)
          : null;

    if (headerNode) {
      channelId =
        attr(headerNode, "data-qa-channel-id") || attr(headerNode, "data-qa-conversation-id");
      if (!channelId) channelId = null;
    }

    for (const selector of channelSelectors) {
      try {
        const found = docLike.querySelector(selector);
        if (found && typeof found.textContent === "string") {
          const value = found.textContent.trim();
          if (value) {
            channelName = value;
            break;
          }
        }
      } catch {
        // ignore selector errors
      }
    }

    if (!channelName) {
      try {
        const inline = docLike.querySelector(
          "[data-qa='inline_channel_entity'][data-channel-id] [data-qa='inline_channel_entity__name']"
        );
        if (inline && typeof inline.textContent === "string") {
          channelName = inline.textContent.trim();
          const owner =
            typeof inline.closest === "function"
              ? inline.closest("[data-qa='inline_channel_entity']")
              : null;
          if (owner && typeof owner.getAttribute === "function") {
            const inlineId = owner.getAttribute("data-channel-id");
            if (inlineId) {
              channelId = inlineId;
            }
          }
        }
      } catch {
        // ignore selector errors
      }
    }

    return {
      text,
      channel: channelName,
      channelId,
      matchedTs: collectTs(target),
    };
  } catch (err) {
    return {
      error: typeof err === "object" && err && "message" in err ? String(err.message) : String(err),
    };
  }
}
