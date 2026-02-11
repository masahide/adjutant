import { describe, expect, it } from "vitest";

import { synchronizeByRatio } from "../../src/lib/scroll/sync";

function createScrollable({
  scrollHeight,
  clientHeight,
  scrollTop,
}: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): HTMLElement {
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
  } as unknown as HTMLElement;
}

describe("scroll synchronize", () => {
  it("同期対象のスクロール位置を比率で合わせる", () => {
    const source = createScrollable({ scrollHeight: 400, clientHeight: 200, scrollTop: 60 });
    const target = createScrollable({ scrollHeight: 600, clientHeight: 300, scrollTop: 0 });

    synchronizeByRatio(source, target);

    expect(target.scrollTop).toBeCloseTo(90);
  });

  it("スクロール量が不足する場合は 0 に丸める", () => {
    const source = createScrollable({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    const target = createScrollable({ scrollHeight: 200, clientHeight: 150, scrollTop: 50 });

    synchronizeByRatio(source, target);

    expect(target.scrollTop).toBe(0);
  });
});
