/**
 * テロップの見た目。設定 (`Settings`) から描画側が使う形を組み立てる。
 *
 * **`shared/` の純粋関数にする。** プレビューと録画開始の両方が呼ぶ。
 * フォントが受け付けられたかの検証は canvas が要るので、描画側 (`content/`) で行う
 */

import type { Settings } from "@/shared/settings";

/** 描画側が受け取る形。フォントは展開済みの font-family */
export type TelopStyle = {
  /** 1080 px 基準。実際は動画の高さに比例させる */
  fontSizePx: number;
  fontFamily: string;
  fillColor: string;
  strokeColor: string;
  /** 1080 px 基準。0 で縁取りなし */
  strokeWidthPx: number;
};

/**
 * フォントのプリセット。**先頭が既定で、代わりのフォントにも使う。**
 *
 * Web フォントは同梱しない (日本語は 1 書体で数 MB あり、拡張が一桁重くなる)。
 * Mac / Windows の標準フォントを順に探し、無ければ総称に落とす
 */
export const TELOP_FONT_PRESETS = [
  {
    label: "ゴシック",
    family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif',
  },
  { label: "明朝", family: '"Hiragino Mincho ProN", "Yu Mincho", serif' },
  {
    label: "丸ゴシック",
    family: '"Hiragino Maru Gothic ProN", "BIZ UDGothic", sans-serif',
  },
] as const satisfies readonly { label: string; family: string }[];

/**
 * 設定のフォントを font-family にする。
 *
 * プリセットの表示名ならその font-family、それ以外はフォント名とみなして
 * ゴシック系に落とす。**名前で指定するだけなら権限は要らない** (Local Font Access
 * が要るのは列挙するときだけ)。表示名を変えると保存済みの値はフォント名扱いに
 * なるが、`sans-serif` に落ちるだけで壊れない。
 *
 * **`,` は区切り** (`parseTelopFont` が弾かない理由)。名前ごとに引用符で囲み、最後に
 * `sans-serif` を足す。全体を 1 組の引用符で囲むと `Arial, Meiryo` という 1 つの名前として
 * 探され、どちらも使われない。空の名前は捨てる
 */
export function expandFontFamily(font: string): string {
  const name = font.trim();
  const preset = TELOP_FONT_PRESETS.find((candidate) => candidate.label === name);
  if (preset !== undefined) return preset.family;
  const names = name
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return [...names.map((part) => `"${part}"`), "sans-serif"].join(", ");
}

/** `mergeSettings` を通った設定から見た目を組み立てる */
export function telopStyleOf(settings: Settings): TelopStyle {
  return {
    fontSizePx: settings.telopFontSizePx,
    fontFamily: expandFontFamily(settings.telopFont),
    fillColor: settings.telopFillColor,
    strokeColor: settings.telopStrokeColor,
    strokeWidthPx: settings.telopStrokeWidthPx,
  };
}
