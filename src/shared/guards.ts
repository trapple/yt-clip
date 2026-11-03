/** 保存値やメッセージなど、外から届いた値を確かめる型ガード。ファイルごとに書き直さない */

/** 組 (配列でない object) か。配列も typeof は "object" なので分ける */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 有限の数か (NaN / Infinity を弾く) */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
