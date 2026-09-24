import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WINDOW_LAYOUT_KEY,
  clearWindowRect,
  fitRect,
  initialBarRect,
  loadWindowLayout,
  mergeWindowLayout,
  saveWindowRect,
} from "@/content/window-layout";

/** 受け入れ条件の画面 (1440x900 のノート PC の viewport = 1440x795) */
const VIEWPORT = { width: 1440, height: 795 };
/** 掴む場所を測れないとき (隠れている窓など) */
const NO_GRIP = { left: 0, top: 0, width: 0, height: 0 };
/** パネルの窓の見出し: 窓の上端いっぱい、高さ 32 */
const HEADER = { left: 0, top: 0, width: 400, height: 32 };
/** バーの窓のつまみ: 窓の左上から (12, 54) にある 20x36 の箱 */
const GRIP = { left: 12, top: 54, width: 20, height: 36 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mergeWindowLayout", () => {
  test("何も覚えていなければ空。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("2 つの窓の位置と大きさを読む。高さは無くてよい", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      bar: { left: 24, top: 636, width: 988 },
      panel: { left: 1024, top: 68, width: 400, height: 500 },
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("型の違う窓は捨てて warn する。もう片方は使う", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = { left: 1024, top: 68, width: 400 };
    expect(
      mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel }),
    ).toEqual({ panel });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.bar");
  });

  test("欠けた窓は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ bar: { left: 24, top: 636 } })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("範囲の外の値は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = [
      { left: 0, top: 0, width: 0 },
      { left: 0, top: 0, width: -100 },
      { left: 1e9, top: 0, width: 400 },
      { left: 0, top: Number.POSITIVE_INFINITY, width: 400 },
      { left: 0, top: 0, width: Number.NaN },
      { left: 0, top: 0, width: 400, height: 0 },
    ];
    for (const rect of bad) {
      expect(mergeWindowLayout({ panel: rect })).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });

  test("窓の組でないもの (数値・null) は空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(42)).toEqual({});
    expect(mergeWindowLayout(null)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("知らない窓の名前は黙って無視する (後の版で窓が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ other: { left: 0 } })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fitRect", () => {
  const LIMITS = { minWidth: 280, minHeight: 160 };

  test("画面に収まっていればそのまま", () => {
    const rect = { left: 100, top: 100, width: 400, height: 300 };
    expect(fitRect(rect, VIEWPORT, HEADER, LIMITS)).toEqual(rect);
  });

  test("高さの無い窓に高さを足さない", () => {
    expect(fitRect({ left: 100, top: 100, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 100,
      top: 100,
      width: 400,
    });
  });

  test("最小より小さい大きさは最小にする", () => {
    expect(
      fitRect({ left: 100, top: 100, width: 10, height: 10 }, VIEWPORT, NO_GRIP, LIMITS),
    ).toEqual({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("画面より大きい大きさは画面の大きさにする", () => {
    expect(
      fitRect({ left: 0, top: 0, width: 5000, height: 5000 }, VIEWPORT, NO_GRIP, LIMITS),
    ).toEqual({ left: 0, top: 0, width: 1440, height: 795 });
  });

  test("画面が最小より狭いときは最小を採る", () => {
    expect(
      fitRect(
        { left: 0, top: 0, width: 400, height: 400 },
        { width: 200, height: 100 },
        NO_GRIP,
        LIMITS,
      ),
    ).toEqual({ left: 0, top: 0, width: 280, height: 160 });
  });

  test("見出しが右と下にはみ出さないよう詰める", () => {
    // 1440 - 400、795 - 32
    expect(fitRect({ left: 2000, top: 2000, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 1040,
      top: 763,
      width: 400,
    });
  });

  test("見出しが左と上にはみ出さないよう詰める", () => {
    expect(fitRect({ left: -500, top: -500, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 0,
      top: 0,
      width: 400,
    });
  });

  test("つまみだけが残ればよい。窓の残りは画面の外へ出てよい", () => {
    const limits = { minWidth: 480 };
    // 1440 - 12 - 20、795 - 54 - 36
    expect(fitRect({ left: 5000, top: 5000, width: 1000 }, VIEWPORT, GRIP, limits)).toEqual({
      left: 1408,
      top: 705,
      width: 1000,
    });
    expect(fitRect({ left: -5000, top: -5000, width: 1000 }, VIEWPORT, GRIP, limits)).toEqual({
      left: -12,
      top: -54,
      width: 1000,
    });
  });

  test("窓より広く測れた見出しは、窓の幅までしか数えない", () => {
    // 大きさを変えている最中は、見出しが 1 つ前の広い幅で測られる。そのまま使うと
    // 右端の上限 (1440 - 1000 = 440) まで窓が引き戻される
    const wideHeader = { left: 0, top: 0, width: 1000, height: 32 };
    expect(
      fitRect({ left: 1000, top: 100, width: 400 }, VIEWPORT, wideHeader, LIMITS),
    ).toEqual({ left: 1000, top: 100, width: 400 });
  });

  test("画面が掴む場所より小さいときは、掴む場所の左上を残す", () => {
    // 画面は最小の幅 (480) より狭いので、幅は最小を採る
    expect(
      fitRect({ left: 300, top: 300, width: 600 }, { width: 10, height: 10 }, GRIP, {
        minWidth: 480,
      }),
    ).toEqual({ left: -12, top: -54, width: 480 });
  });
});

describe("initialBarRect", () => {
  test("プレイヤーの直下 8px に、左端を揃えてプレイヤーの幅で置く", () => {
    // 1440x795 の実測 (右側パネルの受け入れ確認): プレイヤーの下端 ≈ 628px
    expect(initialBarRect({ left: 24, bottom: 628, width: 988 }, 106, VIEWPORT)).toEqual({
      left: 24,
      top: 636,
      width: 988,
    });
  });

  test("画面に収まらなければ、画面の下端から 16px に詰める", () => {
    // 795 - 16 - 106
    expect(initialBarRect({ left: 0, bottom: 700, width: 1440 }, 106, VIEWPORT)).toEqual({
      left: 0,
      top: 673,
      width: 1440,
    });
  });

  test("画面より高いバーでも、上端は画面の上へ出さない", () => {
    expect(initialBarRect({ left: 0, bottom: 700, width: 1440 }, 2000, VIEWPORT).top).toBe(0);
  });
});

describe("覚えた位置の保存と読み込み", () => {
  const BAR = { left: 24, top: 636, width: 988 };
  const PANEL = { left: 1024, top: 68, width: 400, height: 500 };
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string): Promise<Record<string, unknown>> =>
            key in store ? { [key]: store[key] } : {},
          set: async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(store, items);
          },
        },
      },
    });
  });

  test("覚えた位置を読む", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR };
    expect(await loadWindowLayout()).toEqual({ bar: BAR });
  });

  test("読めなければ warn して空を返す (最初の位置で出す)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("壊れた")) } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadWindowLayout()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("1 つの窓を覚えても、もう片方の窓は残す", async () => {
    store[WINDOW_LAYOUT_KEY] = { panel: PANEL };
    await saveWindowRect("bar", BAR);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: PANEL });
  });

  test("2 つの窓を続けて覚えても、両方残る (読んで書き戻す処理を重ねない)", async () => {
    await Promise.all([saveWindowRect("bar", BAR), saveWindowRect("panel", PANEL)]);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: PANEL });
  });

  test("高さの無い窓は高さを書かない", async () => {
    await saveWindowRect("bar", { left: 1, top: 2, width: 480, height: undefined });
    const saved = (store[WINDOW_LAYOUT_KEY] as Record<string, object>).bar;
    expect(Object.keys(saved ?? {})).toEqual(["left", "top", "width"]);
  });

  test("消すのは 1 つの窓だけ", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: PANEL };
    await clearWindowRect("bar");
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ panel: PANEL });
  });
});
