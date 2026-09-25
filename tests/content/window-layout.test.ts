import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WINDOW_IDS,
  WINDOW_LAYOUT_KEY,
  acceptsDock,
  fitRect,
  initialBarRect,
  initialWindowLayout,
  loadWindowLayout,
  mergeWindowLayout,
  parseDockState,
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

/** 最初の配置 (ドック。spec C2.6): バーは下の枠、区間・テロップの窓と設定の窓は右の枠 */
const INITIAL: WindowLayout = {
  version: 2,
  float: {},
  docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"] } },
};
/** v2 で枠を空に書いてある組 (3 つとも浮いた窓の最初の位置) */
const EMPTY: WindowLayout = { version: 2, float: {}, docks: {} };

describe("mergeWindowLayout", () => {
  test("何も覚えていなければ最初の配置 (ドック)。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual(INITIAL);
    expect(initialWindowLayout()).toEqual(INITIAL);
    expect(warn).not.toHaveBeenCalled();
  });

  test("最初の配置の組は呼ぶたびに新しい (書き換えても次の組に残らない)", () => {
    const first = initialWindowLayout();
    first.docks.side?.tabs.push("bar");
    expect(initialWindowLayout()).toEqual(INITIAL);
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

  test("古い形 (v1: version が無い) は bar → float.bar、panel → float.list に読み替える。位置のある窓は浮いた窓のまま、設定の窓は最初の配置の枠", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    const panel = { left: 1024, top: 68, width: 400, height: 500 };
    expect(mergeWindowLayout({ bar, panel })).toEqual({
      version: 2,
      float: { bar, list: panel },
      docks: { side: { tabs: ["settings"] } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("v1 の空の組 (前に全部の窓を戻した) は最初の配置。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({})).toEqual(INITIAL);
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
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["settings"] } },
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

  test("組でないもの (数値・null・配列) は最初の配置にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(42)).toEqual(INITIAL);
    expect(mergeWindowLayout(null)).toEqual(INITIAL);
    expect(mergeWindowLayout([])).toEqual(INITIAL);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("読めない版 (3・1・数でない版) は最初の配置にして warn する (後の版が書いた形を推測で読まない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(mergeWindowLayout({ version: 3, float: { bar }, docks: {} })).toEqual(INITIAL);
    expect(mergeWindowLayout({ version: 1, bar })).toEqual(INITIAL);
    expect(mergeWindowLayout({ version: "2", float: { bar }, docks: {} })).toEqual(INITIAL);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("版");
  });

  test("v2 で float か docks が組でなければ、その部分だけ捨てて warn する (ほかの部分は使う)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(
      mergeWindowLayout({ version: 2, float: null, docks: { below: { tabs: ["bar"] } } }),
    ).toEqual({ version: 2, float: {}, docks: { below: { tabs: ["bar"] } } });
    expect(mergeWindowLayout({ version: 2, float: { bar }, docks: 5 })).toEqual({
      version: 2,
      float: { bar },
      docks: {},
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("v2 で float か docks が無いだけなら空として読み、warn しない (正しい float を捨てない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(mergeWindowLayout({ version: 2, float: { bar } })).toEqual({
      version: 2,
      float: { bar },
      docks: {},
    });
    expect(mergeWindowLayout({ version: 2, docks: { side: { tabs: ["list"] } } })).toEqual({
      version: 2,
      float: {},
      docks: { side: { tabs: ["list"] } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("知らない窓の名前は黙って無視する (後の版で窓が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: { other: { left: 0 } }, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ other: { left: 0 } })).toEqual(INITIAL);
    expect(warn).not.toHaveBeenCalled();
  });

  test("枠の中身 (タブの並びと前のタブ) を読む", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      version: 2,
      float: {},
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("float と docks の両方にある窓は枠に入れ、float の値も残す (引き出したときの大きさに使う)", () => {
    const list = { left: 1024, top: 68, width: 400, height: 500 };
    const stored = { version: 2, float: { list }, docks: { side: { tabs: ["list"], active: "list" } } };
    expect(mergeWindowLayout(stored)).toEqual(stored);
  });

  test("枠の中身の検証は parseDockState と同じ (右の枠のバーは捨てて warn する)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: {}, docks: { side: { tabs: ["bar", "list"] } } }),
    ).toEqual({ version: 2, float: {}, docks: { side: { tabs: ["list"] } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("acceptsDock", () => {
  test("バーは右の枠に入れない。ほかの組み合わせは入れる", () => {
    expect(acceptsDock("bar", "side")).toBe(false);
    expect(acceptsDock("bar", "below")).toBe(true);
    for (const id of ["list", "settings"] as const) {
      expect(acceptsDock(id, "below")).toBe(true);
      expect(acceptsDock(id, "side")).toBe(true);
    }
  });
});

describe("parseDockState", () => {
  test("枠ごとのタブの並びと前のタブを読む", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const docks = { below: { tabs: ["bar", "list"], active: "list" }, side: { tabs: ["settings"] } };
    expect(parseDockState(docks)).toEqual(docks);
    expect(warn).not.toHaveBeenCalled();
  });

  test("無ければ空。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState(undefined)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("組でなければ空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const value of [5, null, [], "side"]) {
      expect(parseDockState(value)).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test("組でない枠・tabs が配列でない枠は捨てて warn する。ほかの枠は使う", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ below: { tabs: "bar" }, side: { tabs: ["list"] } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(parseDockState({ below: 3 })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("同じ枠の重複は先頭を残し、別の枠にも入っている窓は below の方を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      parseDockState({ below: { tabs: ["list", "list"] }, side: { tabs: ["list", "settings"] } }),
    ).toEqual({ below: { tabs: ["list"] }, side: { tabs: ["settings"] } });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("知らない窓と、入れられない組み合わせ (右の枠のバー) は捨てて warn する。残りが無い枠は鍵ごと持たない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ below: { tabs: ["panel", "bar"] }, side: { tabs: ["bar"] } })).toEqual({
      below: { tabs: ["bar"] },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("active が tabs に無ければ無い扱いにして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ side: { tabs: ["list"], active: "settings" } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(parseDockState({ side: { tabs: ["list"], active: 7 } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("tabs が窓の数より多い巨大な配列は先頭 (窓の数ぶん) だけ見て、要素の数だけ warn しない (whole-branch review M3)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 壊れた保存値 (chrome.storage.local を直接書き換えられる人だけが作れる) を模す。
    // 打ち切らないと "bar" の重複ぶん (499 回) warn が出る
    const rawTabs = new Array(500).fill("bar");
    expect(parseDockState({ below: { tabs: rawTabs } })).toEqual({ below: { tabs: ["bar"] } });
    // 打ち切り後は WINDOW_IDS.length (3) 件のうち先頭の "bar" だけ採用、残り 2 件が重複で捨てられ、
    // 打ち切りの warn が 1 回。要素の数 (500) には比例しない
    expect(warn.mock.calls.length).toBeLessThanOrEqual(WINDOW_IDS.length + 1);
  });

  test("知らない枠の名前は黙って無視する (後の版で枠が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ top: { tabs: ["bar"] } })).toEqual({});
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
      fitRect({ left: 0, top: 56, width: 5000, height: 5000 }, VIEWPORT, NO_GRIP, LIMITS),
    ).toEqual({ left: 0, top: 56, width: 1440, height: 795 });
  });

  test("画面が最小より狭いときは最小を採る", () => {
    expect(
      fitRect(
        { left: 0, top: 56, width: 400, height: 400 },
        { width: 200, height: 100 },
        NO_GRIP,
        LIMITS,
      ),
    ).toEqual({ left: 0, top: 56, width: 280, height: 160 });
  });

  test("見出しが右と下にはみ出さないよう詰める", () => {
    // 1440 - 400、795 - 32
    expect(fitRect({ left: 2000, top: 2000, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 1040,
      top: 763,
      width: 400,
    });
  });

  test("見出しが左と上にはみ出さないよう詰める。上は YouTube のヘッダー (56px) の下まで", () => {
    // ヘッダーは窓より上 (z-index 2020) に出る。見出しがヘッダーの裏に入ると押せず、窓を
    // 動かせなくなる (実機で報告された不具合)
    expect(fitRect({ left: -500, top: -500, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 0,
      top: 56,
      width: 400,
    });
    expect(fitRect({ left: 100, top: 20, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 100,
      top: 56,
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
    // つまみの上端がヘッダーの下 (56px) に来るまで。56 - 54
    expect(fitRect({ left: -5000, top: -5000, width: 1000 }, VIEWPORT, GRIP, limits)).toEqual({
      left: -12,
      top: 2,
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

  test("画面が掴む場所より小さいときは、掴む場所の左上を残す (上はヘッダーの下)", () => {
    // 画面は最小の幅 (480) より狭いので、幅は最小を採る。上端はヘッダー (56px) の下 (56 - 54)
    expect(
      fitRect({ left: 300, top: 300, width: 600 }, { width: 10, height: 10 }, GRIP, {
        minWidth: 480,
      }),
    ).toEqual({ left: -12, top: 2, width: 480 });
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
      docks: { side: { tabs: ["settings"] } },
    });
    expect(writes).toBe(0);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: LIST });
  });

  test("読めなければ warn して最初の配置の組を返す", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("壊れた")) } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadWindowLayout()).toEqual(INITIAL);
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

  test("枠の中身も組ごと書く (タブの並びと前のタブ)", async () => {
    await saveWindowLayout({
      version: 2,
      float: { list: LIST },
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    });
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({
      version: 2,
      float: { list: LIST },
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    });
  });
});
