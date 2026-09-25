import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WINDOW_LAYOUT_KEY,
  emptyWindowLayout,
  fitRect,
  initialBarRect,
  loadWindowLayout,
  mergeWindowLayout,
  saveWindowLayout,
  type WindowLayout,
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

/** 何も覚えていないときの組 (3 つとも最初の位置) */
const EMPTY: WindowLayout = { version: 2, float: {}, docks: {} };

describe("mergeWindowLayout", () => {
  test("何も覚えていなければ空の組。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual(EMPTY);
    expect(emptyWindowLayout()).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("v2 の組を読む。高さは無くてよい", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      version: 2,
      float: {
        bar: { left: 24, top: 636, width: 988 },
        list: { left: 1024, top: 68, width: 400, height: 500 },
        settings: { left: 1024, top: 100, width: 400 },
      },
      docks: {},
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("古い形 (v1: version が無い) は bar → float.bar、panel → float.list に読み替える。設定の窓は無い扱い", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    const panel = { left: 1024, top: 68, width: 400, height: 500 };
    expect(mergeWindowLayout({ bar, panel })).toEqual({
      version: 2,
      float: { bar, list: panel },
      docks: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("v1 の空の組 (前に全部の窓を戻した) は空の組。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({})).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("型の違う窓は捨てて warn する。ほかの窓は使う (v2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = { left: 1024, top: 68, width: 400 };
    expect(
      mergeWindowLayout({
        version: 2,
        float: { bar: { left: "24", top: 636, width: 988 }, list },
        docks: {},
      }),
    ).toEqual({ version: 2, float: { list }, docks: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.float.bar");
  });

  test("型の違う窓は捨てて warn する。ほかの窓は使う (v1)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = { left: 1024, top: 68, width: 400 };
    expect(mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel })).toEqual({
      version: 2,
      float: { list: panel },
      docks: {},
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.bar");
  });

  test("欠けた窓は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: { bar: { left: 24, top: 636 } }, docks: {} }),
    ).toEqual(EMPTY);
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
      expect(mergeWindowLayout({ version: 2, float: { list: rect }, docks: {} })).toEqual(EMPTY);
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });

  test("組でないもの (数値・null・配列) は空の組にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(42)).toEqual(EMPTY);
    expect(mergeWindowLayout(null)).toEqual(EMPTY);
    expect(mergeWindowLayout([])).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("読めない版 (3・1・数でない版) は空の組にして warn する (後の版が書いた形を推測で読まない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(mergeWindowLayout({ version: 3, float: { bar }, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 1, bar })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: "2", float: { bar }, docks: {} })).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("版");
  });

  test("v2 で float か docks が組でなければ、組ごと空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: null, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {}, docks: 5 })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {} })).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("知らない窓の名前は黙って無視する (後の版で窓が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: { other: { left: 0 } }, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ other: { left: 0 } })).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("ドック枠の中身はまだ読まない (空で返す。枠を入れる経路がまだ無い)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: {}, docks: { below: { tabs: ["bar"] } } }),
    ).toEqual(EMPTY);
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

  test("画面より高いバーでも、上端は YouTube のヘッダーの下 (68px) より上へ出さない", () => {
    expect(initialBarRect({ left: 0, bottom: 700, width: 1440 }, 2000, VIEWPORT).top).toBe(68);
  });

  test("プレイヤーが画面の上へスクロールされて消えていても、ヘッダーの裏に潜らせない", () => {
    // コメント欄まで送ると、プレイヤーの下端は画面の上 (負) にある。上端 0 だと
    // 窓 (z-index 2000) がヘッダー (z-index 2020、高さ 56px) の裏に隠れる
    expect(initialBarRect({ left: 24, bottom: -900, width: 988 }, 106, VIEWPORT)).toEqual({
      left: 24,
      top: 68,
      width: 988,
    });
  });
});

describe("覚えた配置の保存と読み込み", () => {
  const BAR = { left: 24, top: 636, width: 988 };
  const LIST = { left: 1024, top: 68, width: 400, height: 500 };
  let store: Record<string, unknown>;
  let writes: number;

  beforeEach(() => {
    store = {};
    writes = 0;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string): Promise<Record<string, unknown>> =>
            key in store ? { [key]: store[key] } : {},
          set: async (items: Record<string, unknown>): Promise<void> => {
            writes += 1;
            Object.assign(store, items);
          },
        },
      },
    });
  });

  test("覚えた配置を読む", async () => {
    store[WINDOW_LAYOUT_KEY] = { version: 2, float: { bar: BAR }, docks: {} };
    expect(await loadWindowLayout()).toEqual({ version: 2, float: { bar: BAR }, docks: {} });
  });

  test("古い形 (v1) を読んでも書き戻さない (次に動かしたときに v2 で書く)", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: LIST };
    expect(await loadWindowLayout()).toEqual({
      version: 2,
      float: { bar: BAR, list: LIST },
      docks: {},
    });
    expect(writes).toBe(0);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: LIST });
  });

  test("読めなければ warn して空の組を返す (最初の位置で出す)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("壊れた")) } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadWindowLayout()).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("組ごと書く。前に覚えていた組は読まずに置き換える", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: LIST };
    await saveWindowLayout({ version: 2, float: { settings: LIST }, docks: {} });
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { settings: LIST }, docks: {} });
  });

  test("続けて保存すると、後に呼んだ組が残る (書き込みの順を保つ)", async () => {
    // 先の書き込みだけを遅らせる。列に並べないと、後の組が先に書かれて先の組に上書きされる
    const delays = [20, 0];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (): Promise<Record<string, unknown>> => ({}),
          set: async (items: Record<string, unknown>): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
            Object.assign(store, items);
          },
        },
      },
    });
    await Promise.all([
      saveWindowLayout({ version: 2, float: { bar: BAR }, docks: {} }),
      saveWindowLayout({ version: 2, float: { list: LIST }, docks: {} }),
    ]);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { list: LIST }, docks: {} });
  });

  test("高さの無い窓は高さを書かない", async () => {
    await saveWindowLayout({
      version: 2,
      float: { bar: { left: 1, top: 2, width: 480, height: undefined } },
      docks: {},
    });
    const saved = (store[WINDOW_LAYOUT_KEY] as WindowLayout).float.bar;
    expect(Object.keys(saved ?? {})).toEqual(["left", "top", "width"]);
  });

  test("呼んだ後に渡した組を書き換えても、書く値は呼んだ時点のまま", async () => {
    const layout: WindowLayout = { version: 2, float: { bar: { ...BAR } }, docks: {} };
    const saving = saveWindowLayout(layout);
    layout.float.list = LIST;
    const bar = layout.float.bar;
    if (bar !== undefined) bar.left = 0;
    await saving;
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { bar: BAR }, docks: {} });
  });
});
