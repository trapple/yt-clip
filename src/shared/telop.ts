/**
 * テロップ (元動画の秒に付いた文字) に対する計算。
 *
 * **`content/` ではなく `shared/` に置く。** 検証は `reduce` (background) が、
 * 出すかどうかの判定は録画とプレビュー (content) が使う。
 */

import { assertValidRange } from "@/shared/timeline";
import type { ClipRange, Telop } from "@/shared/types";

/**
 * 1 つのテロップの文言の上限 (UTF-16 の長さ)。
 *
 * 文言は状態ごと `chrome.storage.session` に保存され、プレビューと録画で毎フレーム
 * 描かれる。上限が無いと、巨大な貼り付けで保存が失敗したり描画が膨らんだりする
 */
export const MAX_TELOP_TEXT_LENGTH = 500;

/**
 * テロップとして成立しているか確かめる。
 *
 * **握り潰して直さない。** ここに不正な値が来るのは UI のバグであり、黙って
 * 補正すると、思っていたのと違う時間に出るテロップが焼き込まれる (区間と同じ方針)
 */
export function assertValidTelops(telops: Telop[]): void {
  for (const telop of telops) {
    assertValidRange(telop);
    if (typeof telop.text !== "string") {
      throw new TypeError(`テロップの文言が文字列ではありません: ${String(telop.text)}`);
    }
    // UI (onTelopText) が送る前に止めている。ここに来るのは UI のバグ
    if (telop.text.length > MAX_TELOP_TEXT_LENGTH) {
      throw new RangeError(
        `テロップの文言が ${MAX_TELOP_TEXT_LENGTH} 文字を超えています: ${telop.text.length} 文字`,
      );
    }
  }
}

/** 描く中身があるか。空白だけの文言は「まだ書いていない」扱い */
function hasText(telop: Telop): boolean {
  return telop.text.trim() !== "";
}

/**
 * `sourceSec` の時点で出すテロップ。作った順のまま返す (下から積む順番になる)。
 *
 * 開始ちょうどは出し、終了ちょうどは出さない。区間の `endSec` と同じ半開区間に
 * しておけば、続けて並べたテロップが 1 フレームだけ重なることがない
 */
export function activeTelops(telops: Telop[], sourceSec: number): Telop[] {
  return telops.filter(
    (telop) =>
      hasText(telop) && telop.startSec <= sourceSec && sourceSec < telop.endSec,
  );
}

/**
 * どれかの区間に一部でも重なるか。重ならなければ録画に 1 フレームも出ない。
 *
 * 端が接しているだけの場合は重ならないとみなす (半開区間なので出る瞬間が無い)
 */
export function overlapsSegments(telop: Telop, segments: ClipRange[]): boolean {
  return segments.some(
    (segment) =>
      telop.startSec < segment.endSec && segment.startSec < telop.endSec,
  );
}

/**
 * 録画に焼き込むテロップが 1 つでもあるか。
 *
 * **偽なら今の録画経路をそのまま使う。** canvas を挟むと描画の負荷とフレーム落ちの
 * 可能性が増えるので、要らないときに払わない (テロップ spec §4.1)
 */
export function hasRenderableTelops(
  telops: Telop[],
  segments: ClipRange[],
): boolean {
  return telops.some(
    (telop) => hasText(telop) && overlapsSegments(telop, segments),
  );
}
