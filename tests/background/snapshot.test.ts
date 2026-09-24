import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { normalizeSnapshot } from "@/background/snapshot";
import type { RouterSnapshot } from "@/background/router";

describe("normalizeSnapshot", () => {
  test("テロップを持たない古い状態には空配列を補う", () => {
    // 拡張の更新前に保存されたスナップショット。型検査なしで復元されるので、
    // 補わないと telops.map などで落ちる
    const old = {
      state: {
        kind: "ready",
        segments: [{ startSec: 1, endSec: 2 }],
        meta: makeVideoMeta(),
      },
      captureTabId: null,
      composeTabId: null,
    } as unknown as RouterSnapshot;

    expect(normalizeSnapshot(old)?.state).toMatchObject({ telops: [] });
  });

  test("テロップを持つ状態はそのまま", () => {
    const current: RouterSnapshot = {
      state: {
        kind: "ready",
        segments: [{ startSec: 1, endSec: 2 }],
        meta: makeVideoMeta(),
        telops: [{ startSec: 1, endSec: 2, text: "a" }],
      },
      captureTabId: null,
      composeTabId: null,
    };
    expect(normalizeSnapshot(current)).toEqual(current);
  });

  test("区間を持たない状態には足さない", () => {
    const idle: RouterSnapshot = {
      state: { kind: "idle" },
      captureTabId: null,
      composeTabId: null,
    };
    expect(normalizeSnapshot(idle)).toEqual(idle);
  });

  test("無ければ無いまま", () => {
    expect(normalizeSnapshot(undefined)).toBeUndefined();
  });
});
