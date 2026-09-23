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
 * 区間を動画の時間順に並べ、重なり・隣接を 1 つに繋ぐ。
 *
 * **並べ替えを自動にするのは、録画中のシークを常に前進にするため。**
 * 巻き戻しシークはバッファの再読み込みが入りやすく、繋ぎ目の品質が落ちる。
 * 順序をユーザーに委ねる代わりに、繋ぎの確実さを取っている。
 *
 * **重なりをエラーにせずマージするのは、** 拡大バーのドラッグで隣の区間に
 * 触れるたびに手を止めさせないため。マージは情報を失わない (拾いたかった
 * 範囲はすべて出力に入る) ので、拒否する理由が弱い。
 */
export function normalize(segments: ClipRange[]): ClipRange[] {
  for (const segment of segments) {
    assertValidRange(segment);
  }

  // 引数の配列は呼び出し側 (状態機械の前の状態) のものなので複製してから並べる
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);

  const merged: ClipRange[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    // `<=` にして隣接 (前の終わり === 次の始まり) も繋ぐ。間に切れ目はない
    if (last !== undefined && segment.startSec <= last.endSec) {
      merged[merged.length - 1] = {
        startSec: last.startSec,
        // 内側に完全に含まれる区間を飲み込んでも終端が縮まないようにする
        endSec: Math.max(last.endSec, segment.endSec),
      };
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
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
 * その秒を含む区間の index。含む区間が無ければ -1。
 *
 * **区間に ID を振る代わりにこれを使う。** 並べ替えとマージで index は動くが、
 * UI は「いま触っていた区間の開始秒」でこれを引き直せば選択を追える。
 * マージで消えた区間を選んでいた場合もマージ先が返る。
 */
export function indexAt(segments: ClipRange[], sec: number): number {
  return segments.findIndex(
    (segment) => sec >= segment.startSec && sec <= segment.endSec,
  );
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
