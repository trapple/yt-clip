/**
 * 拡大バーの下に出すテロップの帯の段 (`.claude/specs/2026-09-24-floating-windows-design.md` B)。
 *
 * **時間の軸は持たない。** 拡大バー (range-bar.ts) が映している窓を受け取り、同じ軸で帯を置く。
 * 段の割り当て・窓に入るテロップ・掴んだ場所・ドラッグの計算は純粋関数に切り出してある
 * (DOM を組まずに境界を確かめるため)。
 *
 * 帯を動かして変えるのは**出す時間**だけ。文言は一覧 (telop-list.ts) で直す
 */

import type { TimeWindow } from "@/content/range-math";

/** 段の数の上限 (spec B.1)。3 段 (48px〜) だと 1440x795 でバーがプレイヤーの下端を覆う */
export const MAX_TELOP_LANES = 2;
/** 段の高さと段の間 (spec B.1)。2 段で 30px、拡大バーのトラックとの間 4px を足して 34px */
export const TELOP_LANE_HEIGHT_PX = 14;
export const TELOP_LANE_GAP_PX = 2;
/** 帯のドラッグで作れる最短の長さ (秒。spec B.2) */
export const MIN_TELOP_DRAG_SEC = 0.5;
/** 帯の端として掴める幅の上限 (px)。実際の幅は帯の幅の 1/3 との小さい方 (spec B.2) */
export const TELOP_EDGE_MAX_PX = 6;
/** これ未満しか動かさずに離したら、ドラッグではなくクリック (spec B.2) */
export const TELOP_CLICK_SLOP_PX = 4;

/** 帯のどこを掴んだか。中 = 長さを保って動かす、端 = 開始か終了だけを動かす */
export type TelopDragKind = "move" | "start" | "end";

/** 時刻だけを見る計算の入力と出力。文言は要らない */
export type TelopSpan = { startSec: number; endSec: number };

/**
 * 窓に一部でも入るテロップの位置 (index。元の並び)。**空の文言も入れる** (まだ書いていない
 * テロップも帯で動かせるように。spec B.1)。端が接するだけのものは入れない (テロップは半開区間。
 * `overlapsSegments` と同じ判定)
 */
export function telopsInWindow(telops: readonly TelopSpan[], window: TimeWindow): number[] {
  const indices: number[] = [];
  telops.forEach((telop, index) => {
    if (telop.startSec < window.endSec && window.startSec < telop.endSec) {
      indices.push(index);
    }
  });
  return indices;
}

/**
 * 時間が重なるテロップを段に分ける (spec B.1「前から順に、空いている段に置く」)。
 * 戻り値は入力と同じ並びで、各テロップの段 (0 始まり)。**どの段にも入らないものは -1** で、帯は
 * 出さず「+N」で数だけ出す (重ねて置くと、重なった帯をうっかり掴んで別のテロップを動かす)。
 *
 * 開始の早い順 (同じ開始なら作った順) に、いちばん若い空いた段へ置く。作った順に置くと、後から
 * 足した早いテロップが 2 段目に回り、時間の流れと段の並びが食い違って読みにくい
 */
export function assignLanes(telops: readonly TelopSpan[], maxLanes: number): number[] {
  if (!Number.isInteger(maxLanes) || maxLanes < 1) {
    throw new RangeError(`段の数が不正です: ${maxLanes}`);
  }
  const order = telops
    .map((telop, index) => ({ telop, index }))
    .sort((a, b) => a.telop.startSec - b.telop.startSec || a.index - b.index);
  /** 段ごとの、いま置いてある最後のテロップの終了 */
  const laneEnds: number[] = [];
  const lanes = telops.map(() => -1);
  for (const { telop, index } of order) {
    // 半開区間なので、前のテロップの終了ちょうどに始まるなら同じ段に置ける
    const free = laneEnds.findIndex((end) => end <= telop.startSec);
    if (free >= 0) {
      laneEnds[free] = telop.endSec;
      lanes[index] = free;
    } else if (laneEnds.length < maxLanes) {
      lanes[index] = laneEnds.length;
      laneEnds.push(telop.endSec);
    }
    // どの段にも入らないものは -1 のまま。段を塞がないので、後のテロップは空いた段に入れる
  }
  return lanes;
}

/**
 * 帯のどこを掴んだか。端の幅は「帯の幅の 1/3、最大 6px」(spec B.2)。細い帯でも中を掴めるように
 * 1/3 で頭打ちにする。ちょうど境目は中。幅が測れない (0) ときも中
 */
export function grabKindAt(offsetPx: number, widthPx: number): TelopDragKind {
  const edge = Math.min(TELOP_EDGE_MAX_PX, widthPx / 3);
  if (offsetPx < edge) return "start";
  if (offsetPx > widthPx - edge) return "end";
  return "move";
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

/**
 * 帯を動かした結果の時刻 (spec B.2)。
 *
 * 動かせる範囲は拡大バーの窓の中。**ただし、もともと窓からはみ出している分はそのまま認める**
 * (下限は min(窓の開始, 今の開始)、上限は max(窓の終了, 今の終了))。窓の端をまたぐテロップを
 * 少し動かしただけで、窓の端へ跳ばないようにする。
 *
 * 長さの下限は 0.5 秒。**今の長さが 0.5 秒未満なら今の長さを下限にする** (一覧で短くしたものを、
 * 帯で掴んだだけで勝手に伸ばさない)
 */
export function dragTelop(
  kind: TelopDragKind,
  startSec: number,
  endSec: number,
  deltaSec: number,
  window: TimeWindow,
): TelopSpan {
  if (!Number.isFinite(deltaSec)) {
    throw new RangeError(`動かした量が不正です: ${deltaSec}`);
  }
  // NaN もここで弾く (比較が偽になる)
  if (!(endSec > startSec)) {
    throw new RangeError(`テロップの終了が開始以下です: ${startSec}-${endSec}`);
  }
  const lowest = Math.min(window.startSec, startSec);
  const highest = Math.max(window.endSec, endSec);
  const length = endSec - startSec;
  const minLength = Math.min(MIN_TELOP_DRAG_SEC, length);

  if (kind === "move") {
    const next = clamp(startSec + deltaSec, lowest, highest - length);
    return { startSec: next, endSec: next + length };
  }
  if (kind === "start") {
    return { startSec: clamp(startSec + deltaSec, lowest, endSec - minLength), endSec };
  }
  return { startSec, endSec: clamp(endSec + deltaSec, startSec + minLength, highest) };
}
