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
const SIDE_MARGIN_RATIO = 0.05;

/**
 * 行の頭に来てはいけない文字 (行頭禁則)。折り返した先の頭に来るなら前の行に付けたままにする
 * (その 1 文字だけ右へはみ出しうる。追い出して前の文字ごと送るより単純で、はみ出しは縁の分ほど)
 */
const NO_LINE_START = new Set([..."、。，．,.！？!?）)」』】〉》〕］]｝}ー～…‥・：:；;ゃゅょっぁぃぅぇぉャュョッァィゥェォ"]);

/** 折り返しの単位。英数字の続きは 1 つ (単語の途中で切らない)、空白の続きも 1 つ、ほかは 1 文字ずつ */
const TOKEN = /[\p{Script=Latin}\p{Nd}'’\-]+|\s+|./gsu;

/** 文字の幅を測る (`ctx.measureText(text).width`。いまの font で。縁取りは含めない) */
export type MeasureText = (text: string) => number;

/**
 * 1 行 (改行を含まない) を maxWidth に収まるように折り返す。
 *
 * - 日本語は文字の間、英語は単語の間で折り返す。行の頭と尻の空白は落とす
 * - 1 単語だけで幅を超えるときは、その単語を文字の間で切る
 * - 行頭禁則の文字は前の行に付けたままにする (`NO_LINE_START`)
 *
 * 伸びていく行を毎回測り直す (文字ごとの幅を足すより、カーニングと字詰めが正しく効く)。重さは文言ごとに 1 回だけ払う
 * (`drawTelops` が結果を覚える)
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
  /** 今の行に足す。空の行に置いても幅を超える単語は、文字の間で切る */
  const place = (token: string): void => {
    if (current !== "" || token.length <= 1 || measure(token) <= maxWidth) {
      current += token;
      return;
    }
    for (const char of token) {
      if (current !== "" && measure(current + char) > maxWidth) push();
      current += char;
    }
  };

  for (const token of row.match(TOKEN) ?? []) {
    const blank = /^\s+$/u.test(token);
    // 行の頭の空白は落とす
    if (current === "" && blank) continue;
    if (current !== "" && !NO_LINE_START.has(token) && measure(current + token) > maxWidth) {
      push();
      if (blank) continue;
    }
    place(token);
  }
  push();
  return lines.length === 0 ? [""] : lines;
}

/** 折り返す幅。左右に幅の 5% ずつ空け、縁取りが輪郭の外に乗る分 (線の太さ。両側に半分ずつ) を引く */
export function wrapWidth(width: number, outlineWidth: number): number {
  return width * (1 - SIDE_MARGIN_RATIO * 2) - outlineWidth;
}

/** 文言を行に分ける。改行は改行のまま、収まらない行は折り返す */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  return text.split("\n").flatMap((row) => wrapRow(row, maxWidth, measure));
}

/**
 * 折り返した結果の覚え。**drawTelops は毎フレーム呼ばれる** (録画は 30〜60fps) ので、同じ文言を毎フレーム折り返し
 * 直さない。鍵は font・幅・文言。同時に出るテロップは数件なので、増えたら丸ごと捨てる
 */
const wrappedRows = new Map<string, string[]>();
const WRAPPED_ROWS_LIMIT = 64;

function wrapCached(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const key = `${ctx.font}\n${maxWidth}\n${text}`;
  const known = wrappedRows.get(key);
  if (known !== undefined) return known;
  if (wrappedRows.size >= WRAPPED_ROWS_LIMIT) wrappedRows.clear();
  const rows = wrapText(text, maxWidth, (part) => ctx.measureText(part).width);
  wrappedRows.set(key, rows);
  return rows;
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
 * 文言を行に分けるのは `rowsOf` (描くときは折り返した行。`wrapText`)。文字起こしの行から作るテロップには改行を
 * 入れる機会が無く、長い行が画面の外で切れていた。
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
  rowsOf: (text: string) => string[],
): TelopLine[] {
  const lineHeight = fontSizePx * (height / TELOP_BASE_HEIGHT) * LINE_HEIGHT_RATIO;
  const x = width / 2;
  let bottom = height - height * BOTTOM_MARGIN_RATIO;
  const lines: TelopLine[] = [];

  for (const text of texts) {
    // ここから上に積むものは全部画面の外
    if (bottom <= 0) break;
    const rows = rowsOf(text);
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

    const maxWidth = wrapWidth(width, ctx.lineWidth);
    const lines = layoutTelops(
      active.map((telop) => telop.text),
      width,
      height,
      style.fontSizePx,
      (text) => wrapCached(ctx, text, maxWidth),
    );
    for (const line of lines) {
      if (style.strokeWidthPx > 0) ctx.strokeText(line.text, line.x, line.y);
      ctx.fillText(line.text, line.x, line.y);
    }
  } finally {
    ctx.restore();
  }
}
