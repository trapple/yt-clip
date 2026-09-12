/**
 * 1 クリップの最大長 (秒) の**既定値**。設定で変えられる。
 *
 * **これは「いまの上限」ではない。** 現在値は設定から読んで引数で渡すこと。
 * ここを直接読むと、設定を変えた利用者の画面で既定値が効いてしまう
 */
export const DEFAULT_MAX_CLIP_SEC = 60;

/**
 * 設定で入れられる最大長の上限 (秒)。
 *
 * X の動画の上限に合わせる。これを超える値を保存できてしまうと、録画は通るのに
 * X で弾かれる。失敗が録画の後まで遅れるぶん、手前で止める価値がある
 */
export const MAX_SETTABLE_CLIP_SEC = 140;

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
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
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
  if (duration > maxClipSec) {
    return {
      ok: false,
      message: `クリップは ${maxClipSec} 秒までです (現在 ${Math.round(duration)} 秒)`,
    };
  }

  return { ok: true };
}
