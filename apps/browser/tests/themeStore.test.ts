import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { createThemeController } from "../src/lib/client/theme";

type MediaListener = (event: MediaQueryListEvent) => void;

describe("theme controller", () => {
  const listeners: MediaListener[] = [];
  const matchMedia = vi.fn((query: string) => {
    const isDarkQuery = query.includes("dark");
    return {
      matches: isDarkQuery,
      media: query,
      addEventListener: (_event: string, listener: MediaListener) => {
        listeners.push(listener);
      },
      removeEventListener: (_event: string, listener: MediaListener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      },
      addListener: (listener: MediaListener) => {
        if (!listeners.includes(listener)) {
          listeners.push(listener);
        }
      },
      removeListener: (listener: MediaListener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      },
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });

  beforeEach(() => {
    listeners.length = 0;
    matchMedia.mockClear();
  });

  it("SSR 初期テーマとブラウザの prefers-color-scheme を同期する", () => {
    const storage = createMemoryStorage();
    const applyTheme = vi.fn();

    const controller = createThemeController({
      initialTheme: "system",
      storage,
      matchMedia,
      applyTheme,
    });

    controller.connect();

    expect(get(controller.theme)).toBe("dark");
    expect(applyTheme).toHaveBeenLastCalledWith("dark", "system");

    controller.setTheme("light");

    expect(get(controller.theme)).toBe("light");
    expect(applyTheme).toHaveBeenLastCalledWith("light", "light");
    expect(storage.getItem("reaclog:theme")).toBe("light");
  });
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}
