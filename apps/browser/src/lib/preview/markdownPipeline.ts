import { writable, type Readable } from "svelte/store";
import { renderSummaryMarkdown } from "$lib/markdown";

type PipelineOptions = {
  debounce?: number;
};

export type MarkdownPipeline = Readable<string | null> & {
  update: (content: string | null) => void;
  flush: () => void;
  destroy: () => void;
};

export function createMarkdownPipeline(options: PipelineOptions = {}): MarkdownPipeline {
  const debounce = options.debounce ?? 300;
  const store = writable<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: string | null = null;

  const schedule = () => {
    cancel();
    if (debounce <= 0) {
      store.set(render(latest));
      return;
    }
    timer = setTimeout(() => {
      store.set(render(latest));
      timer = null;
    }, debounce);
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const update = (content: string | null) => {
    latest = content;
    schedule();
  };

  const flush = () => {
    cancel();
    store.set(render(latest));
  };

  const destroy = () => {
    cancel();
  };

  return {
    subscribe: store.subscribe,
    update,
    flush,
    destroy,
  };
}

function render(content: string | null): string | null {
  if (!content?.trim()) {
    return null;
  }
  return renderSummaryMarkdown(content);
}
