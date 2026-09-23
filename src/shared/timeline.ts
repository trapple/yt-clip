/**
 * 出力クリップを構成する区間列に対する計算。
 *
 * **`content/` ではなく `shared/` に置く。** `reduce` (background) が
 * `normalize` を呼ぶため。`content/range-math.ts` は拡大バーの座標計算なので
 * content のままでよい。
 */

import type { ClipRange } from "@/shared/types";

/**
 * 区間として成立しているかを確かめる。
 *
 * **握り潰して直さない。** ここに不正な値が来るのは UI のバグであり、
 * 黙って補正すると、録画に実時間を払い切った後で「思っていたのと違う範囲が
 * 録れた」と気付くことになる。
 */
function assertValidRange(range: ClipRange): void {
  const { startSec, endSec } = range;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new RangeError(
      `区間の秒が数値ではありません: ${String(startSec)}-${String(endSec)}`,
    );
  }
  if (startSec < 0) {
    throw new RangeError(`区間の開始が負です: ${startSec}`);
  }
  if (endSec <= startSec) {
    throw new RangeError(`区間の終了が開始以下です: ${startSec}-${endSec}`);
  }
}

/**
 * 区間として成立しているか確かめる。
 *
 * **並べ替えもマージもしない。** 拾った順がそのまま出力順になる。当初は
 * 時系列ソートと重なりのマージをしていたが、区間の中で「区間を追加」を押した
 * ときに無反応になり (新しい区間が既存区間に完全に含まれると結果が変わらない)、
 * 同じ場面を 2 回使うこともできなかった。
 *
 * 拾った順のままなら **index が動かない**ので、選択の同定に ID も要らない。
 * 代償は録画中の巻き戻しシークだが、繋ぎ目の品質は `waitForFreshFrame` が守る。
 */
export function assertValidSegments(segments: ClipRange[]): void {
  for (const segment of segments) {
    assertValidRange(segment);
  }
}

/**
 * 出力クリップの合計の長さ (秒)。
 *
 * **最大秒数はこれで見る。区間ごとではない。** 区間ごとに上限を見ると、
 * 10 秒の区間を 10 個作れてしまい、X の上限を超えたクリップができる。
 */
export function totalSec(segments: ClipRange[]): number {
  return segments.reduce(
    (sum, segment) => sum + (segment.endSec - segment.startSec),
    0,
  );
}

/**
 * 合計が上限を超えているか。
 *
 * **丸めてから比べる。** 画面に出す合計は `Math.round` した値なので、
 * 生の秒で比べると「一覧は 60秒 / 60秒 と出ているのに録画ボタンだけ押せない」
 * 食い違いが生まれる (OUT の秒は `currentTime` 由来で小数を持つ)。
 * 判定を 1 箇所に集めて、表示と操作の可否を必ず一致させる
 */
export function isOverLimit(segments: ClipRange[], maxClipSec: number): boolean {
  return Math.round(totalSec(segments)) > maxClipSec;
}

/**
 * 出力タイムラインの `outputSec` 秒が、元動画の何秒に当たるか。範囲外なら null。
 *
 * **この機能では使わない。それでも今のうちに置く。** 出力タイムラインという
 * 座標系を後から導入すると、テロップの時刻が元動画の秒で書かれた状態が先に
 * 出来上がってしまい、移行が要る (spec §0.1)。
 */
export function toSourceTime(
  segments: ClipRange[],
  outputSec: number,
): number | null {
  if (outputSec < 0) return null;

  let elapsed = 0;
  for (const segment of segments) {
    const length = segment.endSec - segment.startSec;
    if (outputSec < elapsed + length) {
      return segment.startSec + (outputSec - elapsed);
    }
    elapsed += length;
  }
  return null;
}
