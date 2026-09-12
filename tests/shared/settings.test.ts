import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  formatHashtags,
  loadSettings,
  mergeSettings,
  normalizeHashtags,
  saveSettings,
  tagsVariable,
} from "@/shared/settings";

describe("normalizeHashtags", () => {
  test("空白区切りで受け取る", () => {
    expect(normalizeHashtags("切り抜き VTuber")).toEqual(["切り抜き", "VTuber"]);
  });

  test("# は付いていても付いていなくてもよい", () => {
    expect(normalizeHashtags("#切り抜き VTuber")).toEqual([
      "切り抜き",
      "VTuber",
    ]);
  });

  test("# が重なっていても 1 つのタグとして扱う", () => {
    expect(normalizeHashtags("##切り抜き")).toEqual(["切り抜き"]);
  });

  test("全角空白と読点も区切りにする", () => {
    expect(normalizeHashtags("切り抜き　VTuber、神椿")).toEqual([
      "切り抜き",
      "VTuber",
      "神椿",
    ]);
  });

  test("同じタグは 1 つにまとめ、順序は入力のまま保つ", () => {
    expect(normalizeHashtags("b a b c")).toEqual(["b", "a", "c"]);
  });

  test("空の入力は空の配列になる", () => {
    expect(normalizeHashtags("")).toEqual([]);
    expect(normalizeHashtags("   ")).toEqual([]);
    expect(normalizeHashtags("# #")).toEqual([]);
  });
});

describe("formatHashtags", () => {
  test("# を付けて空白で繋ぐ", () => {
    expect(formatHashtags(["切り抜き", "VTuber"])).toBe("#切り抜き #VTuber");
  });

  test("空なら空文字", () => {
    expect(formatHashtags([])).toBe("");
  });
});

describe("tagsVariable", () => {
  test("タグがあれば自分で区切りを持つ", () => {
    // テンプレート側に改行を書くと、タグ未設定のとき本文が空行で終わる
    expect(tagsVariable(["切り抜き"])).toBe("\n\n#切り抜き");
  });

  test("タグが無ければ空文字", () => {
    expect(tagsVariable([])).toBe("");
  });
});

describe("mergeSettings", () => {
  test("保存が空なら既定値", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test("保存されている値を採る", () => {
    expect(mergeSettings({ hashtags: ["a"], template: "{url}" })).toEqual({
      hashtags: ["a"],
      template: "{url}",
    });
  });

  test("型が合わない値は既定値に倒す", () => {
    // 古いバージョンや別端末が書いた値でありうる。型は保証されない
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(mergeSettings({ hashtags: "切り抜き", template: 42 })).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test("配列の中身が文字列でなければ既定値に倒す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeSettings({ hashtags: ["a", 1] }).hashtags).toEqual([]);
    warn.mockRestore();
  });

  test("片方だけ壊れていても、もう片方は採る", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeSettings({ hashtags: ["a"], template: 42 })).toEqual({
      hashtags: ["a"],
      template: DEFAULT_SETTINGS.template,
    });
    warn.mockRestore();
  });

  test("空文字のテンプレートは既定値に倒す", () => {
    // 本文が空になると、投稿画面に何も入らず原因が分からなくなる
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeSettings({ template: "" }).template).toBe(
      DEFAULT_SETTINGS.template,
    );
    warn.mockRestore();
  });
});

describe("読み書き", () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: (key: string) => Promise.resolve({ [key]: stored[key] }),
          set: (patch: Record<string, unknown>) => {
            Object.assign(stored, patch);
            return Promise.resolve();
          },
        },
      },
    });
  });

  test("何も保存されていなければ既定値", async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  test("保存したものを読み出せる", async () => {
    await saveSettings({ hashtags: ["切り抜き"] });
    await expect(loadSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      hashtags: ["切り抜き"],
    });
  });

  test("一部だけ変えても他の項目は残る", async () => {
    await saveSettings({ template: "{url}" });
    await saveSettings({ hashtags: ["a"] });

    await expect(loadSettings()).resolves.toEqual({
      template: "{url}",
      hashtags: ["a"],
    });
  });
});

describe("画面に出す項目", () => {
  test("すべての項目に文言と変換がある", () => {
    for (const field of SETTINGS_FIELDS) {
      expect(field.label).toBeTruthy();
      expect(field.hint).toBeTruthy();
      expect(typeof field.toText).toBe("function");
      expect(typeof field.fromText).toBe("function");
    }
  });

  test("入力欄の文字列と設定を往復できる", () => {
    // 保存した値を入力欄に出し、そのまま保存し直しても変わらないこと
    for (const field of SETTINGS_FIELDS) {
      const settings = { ...DEFAULT_SETTINGS, hashtags: ["切り抜き", "VTuber"] };
      const text = field.toText(settings);
      const back = { ...settings, ...field.fromText(text) };

      expect(field.toText(back)).toBe(text);
    }
  });

  test("key が重複していない", () => {
    // DOM の id に使うので、重なると入力欄を取り違える
    const keys = SETTINGS_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
