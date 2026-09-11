import { MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

/** IN を押したときに作られる範囲の長さ (秒) */
export const DEFAULT_CLIP_SEC = 15;

/** 拡大バーが表示する最小の時間幅 (秒)。短い範囲でも調整の余地を残す */
export const MIN_WINDOW_SEC = 30;

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

/** 指定した幅の区間を、0 から duration の中に収める */
function fitWithin(
  centerSec: number,
  widthSec: number,
  durationSec: number,
): TimeWindow {
  // 動画自体が幅より短いなら、動画全体を見せるほかない
  if (durationSec <= widthSec) {
    return { startSec: 0, endSec: durationSec };
  }

  let startSec = centerSec - widthSec / 2;
  // 端から溢れた分は反対側へ回す。幅を縮めると調整の余地が減るため
  if (startSec < 0) startSec = 0;
  if (startSec + widthSec > durationSec) startSec = durationSec - widthSec;

  return { startSec, endSec: startSec + widthSec };
}

/**
 * IN を押した位置から既定の長さの範囲を作る。
 * 動画の末尾に近い場合は、最小の長さを確保できるところまで開始位置を手前へずらす。
 */
export function makeDefaultRange(
  startSec: number,
  videoDurationSec: number,
): ClipRange {
  assertSeconds(startSec, "開始位置");
  assertSeconds(videoDurationSec, "動画の長さ");

  const endSec = Math.min(startSec + DEFAULT_CLIP_SEC, videoDurationSec);
  if (endSec - startSec >= MIN_CLIP_SEC) {
    return { startSec, endSec };
  }

  // 末尾ぎりぎりで押された。最小の長さを確保できる位置まで戻す
  return {
    startSec: Math.max(0, videoDurationSec - MIN_CLIP_SEC),
    endSec: videoDurationSec,
  };
}

/**
 * 拡大バーが映す時間帯を決める。
 * 範囲の前後に余裕を持たせて、ハンドルを動かせる余地を残す。
 */
export function computeWindow(
  range: ClipRange,
  videoDurationSec: number,
): TimeWindow {
  assertRange(range);
  assertSeconds(videoDurationSec, "動画の長さ");

  const rangeSec = range.endSec - range.startSec;
  const widthSec = Math.max(rangeSec * 2, MIN_WINDOW_SEC);
  const centerSec = (range.startSec + range.endSec) / 2;

  return fitWithin(centerSec, widthSec, videoDurationSec);
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
    const lowest = Math.max(window.startSec, range.endSec - MAX_CLIP_SEC);
    const highest = range.endSec - MIN_CLIP_SEC;
    return {
      startSec: Math.min(highest, Math.max(lowest, desiredSec)),
      endSec: range.endSec,
    };
  }

  const lowest = range.startSec + MIN_CLIP_SEC;
  const highest = Math.min(window.endSec, range.startSec + MAX_CLIP_SEC);
  return {
    startSec: range.startSec,
    endSec: Math.max(lowest, Math.min(highest, desiredSec)),
  };
}
