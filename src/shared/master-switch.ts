/**
 * 全機能のオン / オフ (マスタースイッチ。`.claude/specs/2026-09-25-master-switch-design.md` §3)。
 *
 * **`chrome.storage.local` の `enabled` に置く (sync の settings に入れない)。** 理由は 2 つ:
 * 1. 端末ごとの操作である。「いま、この端末で止めたい」が同期で別の端末へ届くと、向こうでは拡張が黙って消える
 *    (窓の位置を local にしたのと同じ理由)
 * 2. settings の保存は組ごとの読み書き (saveSettings は読んで `{ ...current, ...patch }` を書く) なので、設定パネルの
 *    保存と popup のスイッチが同時に走ると片方が消える。別のキーなら互いに触らない
 *
 * 既定は**オン** (キーが無い = true)。popup・content script・service worker の 3 つが読む
 */

export const MASTER_SWITCH_KEY = "enabled";

/**
 * 保存された値を読む。
 *
 * ※ 局所例外 (Fail Fast): **boolean でない値は throw せず、warn してオン** (mergeSettings / mergeWindowLayout と
 * 同じ作法)。オフに倒すと、壊れた値で拡張が黙って消える。オフにしたかった人は popup で分かる
 */
export function readEnabled(stored: unknown): boolean {
  if (stored === undefined) return true;
  if (typeof stored === "boolean") return stored;
  console.warn(`[yt-clip] 保存されたオン / オフが読めないため、オンとして扱います: ${String(stored)}`);
  return true;
}

/**
 * 保存された値を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残してオン (loadWindowLayout と同じ判断:
 * 読めないときに拡張が黙って消えるより、今までどおり出る方がよい)
 */
export async function loadEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(MASTER_SWITCH_KEY);
    return readEnabled(stored[MASTER_SWITCH_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] オン / オフを読めないため、オンとして扱います: ${String(error)}`);
    return true;
  }
}

/** 書く。**失敗は握り潰さず reject する** (popup が理由を出し、チェックを保存されている値に戻す。書けたつもりにしない) */
export async function saveEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [MASTER_SWITCH_KEY]: value });
}

/**
 * 変わるのを見張る。`local` の `enabled` だけを拾う (windowLayout の書き込みや sync の settings では呼ばない)。
 * **自分の書き込みでも来る** (popup はこれで表示を確定する)。戻り値を呼ぶと外す
 */
export function watchEnabled(onChange: (enabled: boolean) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[MASTER_SWITCH_KEY];
    if (change === undefined) return;
    onChange(readEnabled(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
