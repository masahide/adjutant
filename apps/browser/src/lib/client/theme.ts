import { derived, writable, type Readable, type Writable } from "svelte/store";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeValue = "light" | "dark";

const STORAGE_KEY = "reaclog:theme";

export interface ThemeControllerOptions {
  initialTheme?: ThemeMode;
  storage?: Storage | null;
  matchMedia?: (query: string) => MediaQueryList;
  applyTheme?: (theme: ThemeValue, mode: ThemeMode) => void;
}

export interface ThemeController {
  mode: Writable<ThemeMode>;
  theme: Readable<ThemeValue>;
  connect: () => void;
  disconnect: () => void;
  setTheme: (mode: ThemeMode) => void;
  toggle: () => void;
}

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
  const globalScope: typeof globalThis | undefined =
    typeof globalThis !== "undefined" ? globalThis : undefined;

  const {
    initialTheme = "system",
    storage = resolveStorage(options.storage, globalScope),
    matchMedia = resolveMatchMedia(options.matchMedia, globalScope),
    applyTheme = defaultApplyTheme,
  } = options;

  const mode = writable<ThemeMode>(initialTheme);
  const systemPreference = writable<ThemeValue>("light");
  const theme = derived([mode, systemPreference], ([currentMode, system]) =>
    currentMode === "system" ? system : currentMode
  );

  let connected = false;
  let cleanup: Array<() => void> = [];
  let mediaCleanup: (() => void) | null = null;
  let currentMode: ThemeMode = initialTheme;
  let currentTheme: ThemeValue = initialTheme === "dark" ? "dark" : "light";

  function connect() {
    if (connected) {
      return;
    }
    connected = true;

    if (storage) {
      const stored = storage.getItem(STORAGE_KEY) as ThemeMode | null;
      if (stored === "light" || stored === "dark" || stored === "system") {
        mode.set(stored);
      }
    }

    if (matchMedia) {
      const media = matchMedia("(prefers-color-scheme: dark)");
      const updateSystem = (matches: boolean) => {
        systemPreference.set(matches ? "dark" : "light");
      };
      updateSystem(media.matches);
      const listener = (event: MediaQueryListEvent) => updateSystem(event.matches);
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", listener);
        mediaCleanup = () => media.removeEventListener("change", listener);
      } else if (typeof media.addListener === "function") {
        media.addListener(listener);
        mediaCleanup = () => media.removeListener(listener);
      }
    }

    cleanup.push(
      mode.subscribe((value) => {
        currentMode = value;
        if (!storage) {
          return;
        }
        if (value === "system") {
          storage.removeItem(STORAGE_KEY);
        } else {
          storage.setItem(STORAGE_KEY, value);
        }
      })
    );

    cleanup.push(
      theme.subscribe((value) => {
        currentTheme = value;
        applyTheme(value, currentMode);
      })
    );
  }

  function disconnect() {
    cleanup.forEach((fn) => fn());
    cleanup = [];
    if (mediaCleanup) {
      mediaCleanup();
      mediaCleanup = null;
    }
    connected = false;
  }

  function setTheme(next: ThemeMode) {
    mode.set(next);
  }

  function toggle() {
    const next = currentTheme === "dark" ? "light" : "dark";
    mode.set(next);
  }

  return {
    mode,
    theme,
    connect,
    disconnect,
    setTheme,
    toggle,
  };
}

function defaultApplyTheme(theme: ThemeValue, mode: ThemeMode) {
  const doc =
    typeof globalThis !== "undefined" && "document" in globalThis
      ? (globalThis.document as Document)
      : null;
  if (!doc) {
    return;
  }
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  root.style.setProperty("color-scheme", theme);
}

function resolveStorage(
  provided: Storage | null | undefined,
  scope: typeof globalThis | undefined
): Storage | null {
  if (typeof provided !== "undefined") {
    return provided ?? null;
  }
  if (scope && "localStorage" in scope) {
    try {
      return scope.localStorage as Storage;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveMatchMedia(
  provided: ((query: string) => MediaQueryList) | undefined,
  scope: typeof globalThis | undefined
): ((query: string) => MediaQueryList) | undefined {
  if (typeof provided !== "undefined") {
    return provided;
  }
  const candidate = scope as Window | undefined;
  if (candidate && typeof candidate.matchMedia === "function") {
    return candidate.matchMedia.bind(candidate);
  }
  return undefined;
}

export const themeController = createThemeController();
