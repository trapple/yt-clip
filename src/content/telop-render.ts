/**
 * テロップを canvas に描く。
 *
 * **プレビューも録画もこの関数で描く。** 画面では CSS、録画では canvas と別の手段で
 * 描くと、縁取りの付き方や行間が微妙に違い、プレビューで見たものと違うクリップができる
 * (テロップ spec §3.1)
 */

import { activeTelops } from "@/shared/telop";
import { TELOP_FONT_PRESETS, type TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

/** 大きさの基準にする動画の高さ。設定の px はこの高さで見たときの大きさ */
export const TELOP_BASE_HEIGHT = 1080;
/** 下端から空ける割合 (高さに対して) */
const BOTTOM_MARGIN_RATIO = 0.08;
/** 行間 (文字サイズに対して) */
const LINE_HEIGHT_RATIO = 1.2;
/** テロップとして読める太さ。細字を選ぶ要望は無いので固定する */
const FONT_WEIGHT = 700;
/** 折り返すときに左右に空ける割合 (幅に対して。片側) */
export const SIDE_MARGIN_RATIO = 0.05;

/**
 * 行の頭に来てはいけない文字 (行頭禁則)。折り返した先の頭に来るなら前の行に付けたままにする
 * (その 1 文字だけ右へはみ出しうる。追い出して前の文字ごと送るより単純で、はみ出しは縁の分ほど)
 */
const NO_LINE_START = new Set([..."、。，．,.！？!?）)」』】〉》〕］]｝}ー～…‥・：:；;ゃゅょっぁぃぅぇぉャュョッァィゥェォ"]);

/** 折り返しの単位。英数字の続きは 1 つ (単語の途中で切らない)、空白の続きも 1 つ、ほかは 1 文字ずつ */
const TOKEN = /[\p{Script=Latin}\p{Nd}'’\-]+|\s+|./gsu;

/** 文字の幅を測る (`ctx.measureText(text).width`。いまの font で) */
export type MeasureText = (text: string) => number;

/**
 * 測った幅の覚え。**drawTelops は毎フレーム呼ばれる** (録画は 30〜60fps) ので、折り返しのために同じ文字を
 * 毎フレーム測り直さない。鍵は font と文字。増えすぎたら丸ごと捨てる (テロップの数は少なく、すぐ溜まり直す)
 */
const measuredWidths = new Map<string, number>();
const MEASURED_WIDTHS_LIMIT = 4000;

function measureCached(ctx: CanvasRenderingContext2D, text: string): number {
  const key = `${ctx.font}\u0000${text}`;
  const known = measuredWidths.get(key);
  if (known !== undefined) return known;
  if (measuredWidths.size >= MEASURED_WIDTHS_LIMIT) measuredWidths.clear();
  const width = ctx.measureText(text).width;
  measuredWidths.set(key, width);
  return width;
}

/**
 * 1 行 (改行を含まない) を maxWidth に収まるように折り返す。
 *
 * - 日本語は文字の間、英語は単語の間で折り返す。行の頭と尻の空白は落とす
 * - 1 単語だけで幅を超えるときは、その単語を文字の間で切る
 * - 行頭禁則の文字は前の行に付けたままにする (`NO_LINE_START`)
 */
export function wrapRow(row: string, maxWidth: number, measure: MeasureText): string[] {
  if (measure(row) <= maxWidth) return [row];
  const lines: string[] = [];
  let current = "";
  const push = (): void => {
    const trimmed = current.trimEnd();
    if (trimmed !== "") lines.push(trimmed);
    current = "";
  };

  for (const token of row.match(TOKEN) ?? []) {
    const candidate = current + token;
    if (measure(candidate) <= maxWidth || current === "" || NO_LINE_START.has(token)) {
      // 空の行に置く単語が幅を超えるなら、文字の間で切る
      if (current === "" && measure(token) > maxWidth && token.length > 1) {
        for (const char of token) {
          if (current !== "" && measure(current + char) > maxWidth) push();
          current += char;
        }
        continue;
      }
      current = candidate;
      continue;
    }
    push();
    // 折り返した先の頭の空白は落とす
    current = /^\s+$/u.test(token) ? "" : token;
    if (measure(current) > maxWidth && current.length > 1) {
      const word = current;
      current = "";
      for (const char of word) {
        if (current !== "" && measure(current + char) > maxWidth) push();
        current += char;
      }
    }
  }
  push();
  return lines.length === 0 ? [""] : lines;
}

export type TelopLine = {
  text: string;
  /** 行の中央 */
  x: number;
  /** 行の下端 (`textBaseline = "bottom"`) */
  y: number;
};

function fontOf(family: string, sizePx: number): string {
  return `${FONT_WEIGHT} ${sizePx}px ${family}`;
}

/**
 * 行の位置を決める。**作った順に下から積む。** 1 つのテロップの中の行は上から下。
 *
 * **`measure` を渡すと、幅に収まらない行を折り返す** (左右に幅の 5% ずつ空ける。`wrapRow`)。改行は改行のまま。
 * 文字起こしの行から作るテロップには改行を入れる機会が無く、長い行が画面の外で切れていた。
 *
 * **canvas の上に完全に出た行 (下端が 0 以下) は返さない。** 改行だらけの文言でも
 * 描く行数が「高さ ÷ 行間」で頭打ちになり、毎フレームの太字の縁取りが膨らまない。
 * 下へは積まないので、下にはみ出す行は出ない
 */
export function layoutTelops(
  texts: string[],
  width: number,
  height: number,
  fontSizePx: number,
  measure?: MeasureText,
): TelopLine[] {
  const maxWidth = width * (1 - SIDE_MARGIN_RATIO * 2);
  const lineHeight = fontSizePx * (height / TELOP_BASE_HEIGHT) * LINE_HEIGHT_RATIO;
  const x = width / 2;
  let bottom = height - height * BOTTOM_MARGIN_RATIO;
  const lines: TelopLine[] = [];

  for (const text of texts) {
    // ここから上に積むものは全部画面の外
    if (bottom <= 0) break;
    const rows = text
      .split("\n")
      .flatMap((row) => (measure === undefined ? [row] : wrapRow(row, maxWidth, measure)));
    rows.forEach((row, index) => {
      const y = bottom - (rows.length - 1 - index) * lineHeight;
      if (y > 0) lines.push({ text: row, x, y });
    });
    bottom -= rows.length * lineHeight;
  }
  return lines;
}

/**
 * font の指定が受け付けられるか確かめ、駄目ならゴシックに倒す。
 *
 * **代入した文字列と読み戻しの一致では判定しない。** `ctx.font` は正規化した値を
 * 返すので必ず不一致になる。代入前に既知の値を入れ、代入後に**それから変わったか**
 * で見る (不正な指定は例外を出さずに無視され、値が変わらない)。
 *
 * 呼ぶのは録画開始時とプレビューのスタイル更新時の 1 回だけ。フレームごとに呼ばない
 */
export function resolveTelopStyle(
  ctx: CanvasRenderingContext2D,
  style: TelopStyle,
): TelopStyle {
  ctx.font = "1px serif";
  const before = ctx.font;
  ctx.font = fontOf(style.fontFamily, style.fontSizePx);
  if (ctx.font !== before) return style;

  console.warn(
    `[yt-clip] テロップのフォント指定が使えないためゴシックで描きます: ${style.fontFamily}`,
  );
  return { ...style, fontFamily: TELOP_FONT_PRESETS[0].family };
}

/**
 * `sourceSec` (元動画の秒) の時点のテロップを描く。`style` は `resolveTelopStyle` を
 * 通したものを渡すこと。
 *
 * 縁取りを先に、文字を後に描く (文字の内側が縁に食われない)。線は輪郭の両側に
 * 乗るので太さの 2 倍、角は丸める (トゲにならない)
 */
export function drawTelops(
  ctx: CanvasRenderingContext2D,
  telops: Telop[],
  sourceSec: number,
  style: TelopStyle,
  width: number,
  height: number,
): void {
  const active = activeTelops(telops, sourceSec);
  if (active.length === 0) return;

  const scale = height / TELOP_BASE_HEIGHT;
  ctx.save();
  // 途中で投げても設定を戻す。録画ではこの ctx に次のフレームの drawImage が来る
  try {
    ctx.font = fontOf(style.fontFamily, style.fontSizePx * scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.lineWidth = style.strokeWidthPx * 2 * scale;
    ctx.strokeStyle = style.strokeColor;
    ctx.fillStyle = style.fillColor;

    const lines = layoutTelops(
      active.map((telop) => telop.text),
      width,
      height,
      style.fontSizePx,
      // 縁取りは輪郭の外にも乗るので、その分も幅に入れて測る
      (text) => measureCached(ctx, text) + ctx.lineWidth,
    );
    for (const line of lines) {
      if (style.strokeWidthPx > 0) ctx.strokeText(line.text, line.x, line.y);
      ctx.fillText(line.text, line.x, line.y);
    }
  } finally {
    ctx.restore();
  }
}
