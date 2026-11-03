import { DEFAULT_MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/shared/time";
import { round2 } from "@/shared/transcript";
import type { ClipRange } from "@/shared/types";

/** IN を押したときに作られる範囲の長さ (秒) */
export const DEFAULT_CLIP_SEC = 15;

/** 拡大バーが映している時間帯 */
export type TimeWindow = {
  startSec: number;
  endSec: number;
};

export type HandleKind = "in" | "out";

function assertSeconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} が再生位置として不正です: ${value}`);
  }
}

/**
 * 時間の区間として筋が通っているか。値そのものだけでなく順序も見る。
 * `ClipRange` と `TimeWindow` は同じ形なので、同じ規則を同じ場所で適用する。
 * 片方にだけ順序チェックを入れると、もう片方から無意味な値が入り込む
 */
function assertInterval(
  interval: { startSec: number; endSec: number },
  label: string,
): void {
  assertSeconds(interval.startSec, `${label}の開始`);
  assertSeconds(interval.endSec, `${label}の終了`);
  if (interval.endSec < interval.startSec) {
    throw new RangeError(
      `${label}の終了が開始より前です: ${interval.startSec} → ${interval.endSec}`,
    );
  }
}

function assertRange(range: ClipRange): void {
  assertInterval(range, "範囲");
}

function assertWindow(window: TimeWindow): void {
  assertInterval(window, "窓");
}

/**
 * IN を押した位置から既定の長さの範囲を作る。
 * 動画の末尾に近い場合は、最小の長さを確保できるところまで開始位置を手前へずらす。
 */
export function makeDefaultRange(
  startSec: number,
  videoDurationSec: number,
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
): ClipRange {
  assertSeconds(startSec, "開始位置");
  assertSeconds(videoDurationSec, "動画の長さ");

  // 上限が既定の長さより短いことがある。頭打ちにしないと、IN を押しただけで
  // 上限を超えた範囲ができる。validateRange は OUT ボタンしか通らないので、
  // そのまま録画まで進んでしまう
  const widthSec = Math.min(DEFAULT_CLIP_SEC, maxClipSec);
  const endSec = Math.min(startSec + widthSec, videoDurationSec);
  if (endSec - startSec >= MIN_CLIP_SEC) {
    return { startSec, endSec };
  }

  // 末尾ぎりぎりで押された。最小の長さを確保できる位置まで戻す
  return {
    startSec: Math.max(0, videoDurationSec - MIN_CLIP_SEC),
    endSec: videoDurationSec,
  };
}

/** 詰める欄が区間の前後に映す幅 (秒。第 2 版のモック「前後 2 秒まで見せる」) */
export const TRIM_MARGIN_SEC = 2;

/**
 * 詰める欄が映す時間帯。区間の前後 2 秒で、動画の頭と終わりで切る。
 *
 * **区間の尻より手前では切らない。** 広告の間は video.duration が広告の長さになり、区間より短いことがある。
 * 窓が区間より狭いとハンドルが窓の外になる (描く場所が無い)
 */
export function computeTrimWindow(range: ClipRange, videoDurationSec: number): TimeWindow {
  assertRange(range);
  assertSeconds(videoDurationSec, "動画の長さ");
  return {
    startSec: Math.max(0, range.startSec - TRIM_MARGIN_SEC),
    endSec: Math.max(range.endSec, Math.min(videoDurationSec, range.endSec + TRIM_MARGIN_SEC)),
  };
}

/**
 * 100 分の 1 秒に丸める。丸めて lowest〜highest の外へ出たら、格子の内側へ寄せる (丸めで長さが 1 秒を割る・上限を
 * 超えるのを防ぐ。`transcript-selection.ts` も丸めた後に確かめ直している)
 */
function onGrid(sec: number, lowest: number, highest: number): number {
  const rounded = round2(sec);
  if (rounded > highest) return Math.floor(highest * 100) / 100;
  if (rounded < lowest) return Math.ceil(lowest * 100) / 100;
  return rounded;
}

/** 詰める欄の −0.1 / ＋0.1 で動かす幅 (秒) */
export const NUDGE_SEC = 0.1;

/**
 * 頭か尻だけを deltaSec 動かした範囲。動画の頭と終わり・最小の長さ・上限の長さで止める (`clampHandle` と同じ規則。
 * ただし窓では止めない: 窓は確定のたびに映し直す)。100 分の 1 秒に丸める (0.1 を足し続けた誤差を状態機械へ送らない)
 */
export function nudgeRange(
  kind: HandleKind,
  deltaSec: number,
  range: ClipRange,
  videoDurationSec: number,
  maxClipSec: number,
): ClipRange {
  if (!Number.isFinite(deltaSec)) throw new RangeError(`動かす幅が不正です: ${deltaSec}`);
  assertRange(range);
  assertSeconds(videoDurationSec, "動画の長さ");

  if (kind === "in") {
    const lowest = Math.max(0, range.endSec - maxClipSec);
    const highest = range.endSec - MIN_CLIP_SEC;
    const startSec = onGrid(Math.min(highest, Math.max(lowest, range.startSec + deltaSec)), lowest, highest);
    // 既に上限・下限の外にある範囲 (上限を設定で縮めた後など) は、押した向きと逆へ跳ばさない
    if ((deltaSec < 0 && startSec > range.startSec) || (deltaSec > 0 && startSec < range.startSec)) return range;
    return { startSec, endSec: range.endSec };
  }

  const lowest = range.startSec + MIN_CLIP_SEC;
  const highest = Math.min(Math.max(videoDurationSec, range.endSec), range.startSec + maxClipSec);
  const endSec = onGrid(Math.max(lowest, Math.min(highest, range.endSec + deltaSec)), lowest, highest);
  if ((deltaSec < 0 && endSec > range.endSec) || (deltaSec > 0 && endSec < range.endSec)) return range;
  return { startSec: range.startSec, endSec };
}

/**
 * 許す幅 (toleranceSec) の中で一番近い点に寄せる。無ければそのまま。ハンドルを単語の切れ目に吸い付かせる
 * (第 2 版のモック)。点の数は窓の中の単語の数 (数百) なので、並べ替えや二分探索はしない
 */
export function snapSec(sec: number, points: readonly number[], toleranceSec: number): number {
  let best = sec;
  let bestDistance = toleranceSec;
  for (const point of points) {
    const distance = Math.abs(point - sec);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 再生位置を窓の中の割合 (0..1) に変換する。
 * 窓の外は 0 と 1 に丸める。範囲外は「端まで動かした」という意味を持つため。
 */
export function timeToRatio(sec: number, window: TimeWindow): number {
  assertSeconds(sec, "再生位置");
  assertWindow(window);

  const widthSec = window.endSec - window.startSec;
  if (widthSec <= 0) return 0;

  const ratio = (sec - window.startSec) / widthSec;
  return Math.min(1, Math.max(0, ratio));
}

/** 窓の中の割合 (0..1) を再生位置に変換する */
export function ratioToTime(ratio: number, window: TimeWindow): number {
  // 割合は負にもなりうる (端の外へドラッグした場合) ので、有限かどうかだけ見る。
  // NaN を通すと Math.max も素通りしてしまい、黙って NaN が下流へ流れる
  if (!Number.isFinite(ratio)) {
    throw new RangeError(`割合が不正です: ${ratio}`);
  }
  assertWindow(window);

  const clamped = Math.min(1, Math.max(0, ratio));
  return window.startSec + (window.endSec - window.startSec) * clamped;
}

/**
 * ハンドルを動かした結果の範囲を返す。
 * 窓の外へは出さず、最小・最大の長さも侵さない。反対側のハンドルは動かさない。
 */
export function clampHandle(
  kind: HandleKind,
  desiredSec: number,
  range: ClipRange,
  window: TimeWindow,
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
): ClipRange {
  assertSeconds(desiredSec, "ハンドルの位置");
  assertRange(range);
  assertWindow(window);

  // 窓が最小長より狭いと、下限が上限を追い越して範囲が反転する。
  // 窓幅 0 (範囲が未確定) や、動画自体が最小長より短い場合に起きる。
  // 反転した結果は負の再生位置になり、描画側の assertSeconds が
  // pointermove の中で throw してドラッグごと固まる。
  // どのみち動かせる余地が無いので、範囲をそのまま返す
  if (window.endSec - window.startSec < MIN_CLIP_SEC) {
    return range;
  }

  if (kind === "in") {
    const lowest = Math.max(window.startSec, range.endSec - maxClipSec);
    const highest = range.endSec - MIN_CLIP_SEC;
    return {
      startSec: Math.min(highest, Math.max(lowest, desiredSec)),
      endSec: range.endSec,
    };
  }

  const lowest = range.startSec + MIN_CLIP_SEC;
  const highest = Math.min(window.endSec, range.startSec + maxClipSec);
  return {
    startSec: range.startSec,
    endSec: Math.max(lowest, Math.min(highest, desiredSec)),
  };
}
