import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import {
  TELOP_FONT_PRESETS,
  expandFontFamily,
  telopStyleOf,
} from "@/shared/telop-style";

describe("expandFontFamily", () => {
  test("プリセットの表示名は font-family に展開する", () => {
    const gothic = TELOP_FONT_PRESETS[0];
    expect(gothic?.label).toBe("ゴシック");
    expect(expandFontFamily("ゴシック")).toBe(gothic?.family);
    expect(expandFontFamily("明朝")).toContain("serif");
  });

  test("それ以外はフォント名として引用符で囲み、ゴシック系に落とす", () => {
    expect(expandFontFamily("Klee One")).toBe('"Klee One", sans-serif');
  });

  test("前後の空白は落とす", () => {
    expect(expandFontFamily("  Klee One ")).toBe('"Klee One", sans-serif');
  });

  test("カンマは区切りとして、名前ごとに引用符で囲む", () => {
    // 全体を 1 組の引用符で囲むと "Arial, Meiryo" という 1 つの名前として探され、どちらも使われない
    expect(expandFontFamily("Arial, Meiryo")).toBe('"Arial", "Meiryo", sans-serif');
  });

  test("空の名前は捨てる", () => {
    expect(expandFontFamily("Arial,, Meiryo ,")).toBe('"Arial", "Meiryo", sans-serif');
    expect(expandFontFamily(" , ")).toBe("sans-serif");
  });
});

describe("telopStyleOf", () => {
  test("既定の設定から既定の見た目を作る", () => {
    expect(telopStyleOf(DEFAULT_SETTINGS)).toEqual({
      fontSizePx: 64,
      fontFamily: TELOP_FONT_PRESETS[0]?.family,
      fillColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidthPx: 8,
    });
  });
});
