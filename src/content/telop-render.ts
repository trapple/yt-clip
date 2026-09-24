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
 * 自動折り返しはしない。日本語の禁則まで含めると重く、Phase 1 では手で改行してもらう
 */
export function layoutTelops(
  texts: string[],
  width: number,
  height: number,
  fontSizePx: number,
): TelopLine[] {
  const lineHeight = fontSizePx * (height / TELOP_BASE_HEIGHT) * LINE_HEIGHT_RATIO;
  const x = width / 2;
  let bottom = height - height * BOTTOM_MARGIN_RATIO;
  const lines: TelopLine[] = [];

  for (const text of texts) {
    const rows = text.split("\n");
    rows.forEach((row, index) => {
      lines.push({
        text: row,
        x,
        y: bottom - (rows.length - 1 - index) * lineHeight,
      });
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
  );
  for (const line of lines) {
    if (style.strokeWidthPx > 0) ctx.strokeText(line.text, line.x, line.y);
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}
