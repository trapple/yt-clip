import { describe, expect, test, vi } from "vitest";
import {
  drawTelops,
  layoutTelops,
  resolveTelopStyle,
  wrapRow,
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
    // 1 文字 100px (縁取りの太さは drawTelops が足す)
    measureText: (text: string) => ({ width: [...text].length * 100 }),
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

  test("幅を渡すと、左右に 5% ずつ空けた幅で折り返す", () => {
    // 幅 1000 の 90% = 900。1 文字 100 なら 9 文字で折り返す
    const lines = layoutTelops(["一二三四五六七八九十"], 1000, 1080, 100, (text) => [...text].length * 100);
    expect(lines.map((line) => line.text)).toEqual(["一二三四五六七八九", "十"]);
  });

  test("canvas の上に完全に出た行は返さない", () => {
    // 改行だらけの文言でも、描く行数は高さ ÷ 行間で頭打ちになる
    const text = Array.from({ length: 500 }, (_, i) => `行${i}`).join("\n");
    const lines = layoutTelops([text, "後"], 1920, 1080, 100);
    // 行間 120px、下端 993.6。y > 0 の行だけ残るので 9 行
    expect(lines.length).toBe(9);
    expect(lines.every((line) => line.y > 0)).toBe(true);
    // 残るのは文言の下の方の行。その上に積んだ「後」は画面の外に出ている
    expect(lines.map((line) => line.text)).toEqual(
      Array.from({ length: 9 }, (_, i) => `行${491 + i}`),
    );
  });
});

describe("wrapRow", () => {
  /** 1 文字 10px */
  const measure = (text: string): number => [...text].length * 10;

  test("収まる行はそのまま", () => {
    expect(wrapRow("あいう", 30, measure)).toEqual(["あいう"]);
  });

  test("日本語は文字の間で折り返す", () => {
    expect(wrapRow("あいうえおかきくけこ", 50, measure)).toEqual(["あいうえお", "かきくけこ"]);
  });

  test("英語は単語の間で折り返し、行の頭と尻の空白は落とす", () => {
    expect(wrapRow("hello world foo", 110, measure)).toEqual(["hello world", "foo"]);
    expect(wrapRow("hello world foo", 90, measure)).toEqual(["hello", "world foo"]);
  });

  test("1 単語だけで幅を超えるときは、その単語を文字の間で切る", () => {
    expect(wrapRow("abcdefghij", 50, measure)).toEqual(["abcde", "fghij"]);
    expect(wrapRow("go abcdefghij", 50, measure)).toEqual(["go", "abcde", "fghij"]);
  });

  test("句読点と閉じ括弧は行の頭に来ない (前の行に付けたまま)", () => {
    expect(wrapRow("あいうえ。かき", 40, measure)).toEqual(["あいうえ。", "かき"]);
    expect(wrapRow("「あいう」えお", 40, measure)).toEqual(["「あいう」", "えお"]);
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

  test("画面の幅に収まらない行は折り返して描く (縁取りの太さも幅に入れる)", () => {
    // 幅 1920 の 90% = 1728。1 文字 100 + 縁取り 16 なので 17 文字で 1716、18 文字で 1816 を超える
    const ctx = makeContext();
    const long: Telop = { startSec: 10, endSec: 13, text: "あ".repeat(20) };
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [long], 11, STYLE, 1920, 1080);
    const filled = ctx.calls.filter((call) => call.startsWith("fill:")).map((call) => call.split("@")[0]);
    expect(filled).toEqual([`fill:${"あ".repeat(17)}`, `fill:${"あ".repeat(3)}`]);
  });

  test("同じ文字の幅は毎フレーム測り直さない", () => {
    const ctx = makeContext();
    let measured = 0;
    const measure = ctx.measureText;
    ctx.measureText = (text: string) => {
      measured += 1;
      return measure(text);
    };
    const long: Telop = { startSec: 10, endSec: 13, text: "い".repeat(25) };
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [long], 11, STYLE, 1920, 1080);
    const first = measured;
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [long], 11.03, STYLE, 1920, 1080);
    expect(first).toBeGreaterThan(0);
    expect(measured).toBe(first);
  });

  test("出す時間でなければ何も描かない", () => {
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 20, STYLE, 1920, 1080);
    expect(ctx.calls).toEqual([]);
  });

  test("描く途中で落ちても ctx の設定を戻す", () => {
    // 録画ではこの ctx に次のフレームの drawImage が来る。設定が残ると影響する
    const ctx = makeContext();
    ctx.fillText = () => {
      throw new Error("壊れた");
    };
    expect(() =>
      drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080),
    ).toThrow("壊れた");
    expect(ctx.calls.at(-1)).toBe("restore");
  });

  test("描いた後は ctx の設定を戻す", () => {
    // 録画ではこの後に次のフレームの drawImage が来る。設定を残すと影響する
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080);
    expect(ctx.calls[0]).toBe("save");
    expect(ctx.calls.at(-1)).toBe("restore");
  });
});
