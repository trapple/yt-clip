import { describe, expect, test, vi } from "vitest";
import {
  drawTelops,
  layoutTelops,
  resolveTelopStyle,
} from "@/content/telop-render";
import { TELOP_FONT_PRESETS, type TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};

/**
 * CanvasRenderingContext2D のモック。呼ばれた順を記録する。
 *
 * `font` は実物と同じく、**不正な指定の代入を黙って無視する** (ここでは "BROKEN" を
 * 含むものを不正とみなす)。読み戻しは正規化した値を返すので、代入した文字列とは
 * 一致しないことも再現する
 */
function makeContext() {
  const calls: string[] = [];
  let font = "10px sans-serif";
  const ctx = {
    calls,
    get font(): string {
      return font;
    },
    set font(value: string) {
      if (value.includes("BROKEN")) return;
      font = `normalized(${value})`;
    },
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    lineWidth: 0,
    fillStyle: "",
    strokeStyle: "",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    strokeText: (text: string, x: number, y: number) =>
      calls.push(`stroke:${text}@${x},${y}`),
    fillText: (text: string, x: number, y: number) =>
      calls.push(`fill:${text}@${x},${y}`),
  };
  return ctx;
}

describe("layoutTelops", () => {
  test("1 行は下中央、下端から高さの 8% 空けた位置に置く", () => {
    expect(layoutTelops(["a"], 1920, 1080, 64)).toEqual([
      { text: "a", x: 960, y: 1080 - 1080 * 0.08 },
    ]);
  });

  test("改行で行を分け、行間は文字サイズの 1.2 倍", () => {
    const lines = layoutTelops(["上\n下"], 1920, 1080, 100);
    const bottom = 1080 - 1080 * 0.08;
    expect(lines).toEqual([
      { text: "上", x: 960, y: bottom - 120 },
      { text: "下", x: 960, y: bottom },
    ]);
  });

  test("複数のテロップは作った順に下から積む", () => {
    const lines = layoutTelops(["先", "後"], 1920, 1080, 100);
    const bottom = 1080 - 1080 * 0.08;
    expect(lines).toEqual([
      { text: "先", x: 960, y: bottom },
      { text: "後", x: 960, y: bottom - 120 },
    ]);
  });

  test("大きさは動画の高さに比例する (1080 基準)", () => {
    // 540p では 1080p の半分の大きさで、見た目の比率が同じになる
    const lines = layoutTelops(["上\n下"], 960, 540, 100);
    const bottom = 540 - 540 * 0.08;
    expect(lines[0]?.y).toBeCloseTo(bottom - 60);
  });
});

describe("resolveTelopStyle", () => {
  test("受け付けられた指定はそのまま使う", () => {
    // 読み戻しが代入した文字列と一致しなくても (正規化されても) 採用する
    const ctx = makeContext();
    const resolved = resolveTelopStyle(
      ctx as unknown as CanvasRenderingContext2D,
      { ...STYLE, fontFamily: '"Klee One", sans-serif' },
    );
    expect(resolved.fontFamily).toBe('"Klee One", sans-serif');
  });

  test("無視された指定はゴシックに倒して理由を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = makeContext();
    const resolved = resolveTelopStyle(
      ctx as unknown as CanvasRenderingContext2D,
      { ...STYLE, fontFamily: "BROKEN" },
    );
    expect(resolved.fontFamily).toBe(TELOP_FONT_PRESETS[0].family);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("drawTelops", () => {
  const telop: Telop = { startSec: 10, endSec: 13, text: "こんにちは" };

  test("縁取りを先に、文字を後に描く", () => {
    // 逆にすると文字の内側が縁に食われる
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080);
    const drawn = ctx.calls.filter((call) => call !== "save" && call !== "restore");
    expect(drawn[0]).toMatch(/^stroke:こんにちは/u);
    expect(drawn[1]).toMatch(/^fill:こんにちは/u);
  });

  test("線の太さは縁取りの 2 倍 × 倍率、角は丸める", () => {
    // 線は輪郭の両側に乗るので 2 倍
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 960, 540);
    expect(ctx.lineWidth).toBe(8 * 2 * 0.5);
    expect(ctx.lineJoin).toBe("round");
  });

  test("縁取りの太さが 0 なら縁取りを描かない", () => {
    const ctx = makeContext();
    drawTelops(
      ctx as unknown as CanvasRenderingContext2D,
      [telop],
      11,
      { ...STYLE, strokeWidthPx: 0 },
      1920,
      1080,
    );
    expect(ctx.calls.some((call) => call.startsWith("stroke:"))).toBe(false);
  });

  test("出す時間でなければ何も描かない", () => {
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 20, STYLE, 1920, 1080);
    expect(ctx.calls).toEqual([]);
  });

  test("描いた後は ctx の設定を戻す", () => {
    // 録画ではこの後に次のフレームの drawImage が来る。設定を残すと影響する
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080);
    expect(ctx.calls[0]).toBe("save");
    expect(ctx.calls.at(-1)).toBe("restore");
  });
});
