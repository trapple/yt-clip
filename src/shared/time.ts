/** 1 クリップの最大長 (秒)。ArrayBuffer 転送量を抑えるための上限 */
export const MAX_CLIP_SEC = 60;

/** 1 クリップの最小長 (秒) */
export const MIN_CLIP_SEC = 1;

export type RangeValidation = { ok: true } | { ok: false; message: string };

/** 再生位置として妥当か検査する。妥当でなければ throw (Fail Fast) */
function assertPlayableSeconds(sec: number, label: string): void {
  if (!Number.isFinite(sec) || sec < 0) {
    throw new RangeError(`${label} が再生位置として不正です: ${sec}`);
  }
}

/** 再生位置を m:ss / h:mm:ss 形式に整形する */
export function formatTime(totalSec: number): string {
  assertPlayableSeconds(totalSec, "再生位置");
  const whole = Math.floor(totalSec);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours === 0) {
    return `${minutes}:${ss}`;
  }
  return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
}

/** YouTube URL の t= に載せる整数秒へ変換する */
export function toUrlSeconds(sec: number): number {
  assertPlayableSeconds(sec, "再生位置");
  return Math.floor(sec);
}

/** IN/OUT の組が録画可能な範囲かを検査する */
export function validateRange(
  startSec: number,
  endSec: number,
): RangeValidation {
  assertPlayableSeconds(startSec, "開始位置");
  assertPlayableSeconds(endSec, "終了位置");

  if (endSec <= startSec) {
    return { ok: false, message: "終了位置は開始位置より後にしてください" };
  }

  const duration = endSec - startSec;
  if (duration < MIN_CLIP_SEC) {
    return { ok: false, message: `クリップは ${MIN_CLIP_SEC} 秒以上必要です` };
  }
  if (duration > MAX_CLIP_SEC) {
    return {
      ok: false,
      message: `クリップは ${MAX_CLIP_SEC} 秒までです (現在 ${Math.round(duration)} 秒)`,
    };
  }

  return { ok: true };
}
