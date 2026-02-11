import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// 共有モックを初期化する際に利用するためのユーティリティをここで拡張予定。
