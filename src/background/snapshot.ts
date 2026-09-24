import type { RouterSnapshot } from "@/background/router";

/**
 * 保存されていたスナップショットを今の形に揃える。
 *
 * **`chrome.storage.session` の中身は型を保証しない。** 拡張の更新前に保存された
 * 状態は `telops` を持たない。`storage.session` は更新で消える見込みだが、
 * 消えなかったときに `telops.map` で落ちると、操作がすべて止まる
 */
export function normalizeSnapshot(
  snapshot: RouterSnapshot | undefined,
): RouterSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  const state = snapshot.state;
  if (!("segments" in state) || "telops" in state) return snapshot;
  return {
    ...snapshot,
    // 型の上では telops を持つはずの値を直すので、unknown を経由して戻す
    state: {
      ...(state as Record<string, unknown>),
      telops: [],
    } as unknown as RouterSnapshot["state"],
  };
}
