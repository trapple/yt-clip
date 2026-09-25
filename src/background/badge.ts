import { loadEnabled } from "@/shared/master-switch";

/**
 * ツールバーのアイコンのバッジ (マスタースイッチの spec §6.2)。オフの間は灰色の地に白で `OFF`、オンでは出さない。
 *
 * **持ち主は service worker だけ** (sw.ts が起動時と onChanged で当てる)。popup が押したときに popup 自身が当てる案は
 * 採らない: 持ち主が 2 つになり、DevTools など別の経路で書いたときに追従しない。setBadge* は action を持つ拡張なら
 * 権限なしで使える (manifest は変えない)。アイコンの絵を灰色に差し替える案も採らない (4 つの大きさの画像と
 * make-icons.mjs の手間に対して、伝わることは同じ)
 */

export const BADGE_OFF_TEXT = "OFF";
/** 地の色。警告色 (赤) にしない: オフは壊れているのではなく、自分で止めている状態 */
export const BADGE_OFF_COLOR = "#606060";
export const BADGE_TEXT_COLOR = "#ffffff";

/**
 * 使う chrome.action の部分 (Promise 版だけ)。chrome.action の型は callback 版との overload で、テストの偽物を
 * 合わせにくいので、使う 3 つだけの型を持つ
 */
export type BadgeAction = {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setBadgeTextColor(details: { color: string }): Promise<void>;
};

export async function applyBadge(
  enabled: boolean,
  action: BadgeAction = chrome.action,
): Promise<void> {
  if (enabled) {
    // 文言が空ならバッジは出ない。色は出ていないバッジには効かないので触らない
    await action.setBadgeText({ text: "" });
    return;
  }
  // 色を先に当てる (文言が出た瞬間に既定の色で見えないように)
  await action.setBadgeBackgroundColor({ color: BADGE_OFF_COLOR });
  await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  await action.setBadgeText({ text: BADGE_OFF_TEXT });
}

/**
 * 保存された値を読んでバッジを当てる。service worker が起きたとき・ブラウザの起動・拡張の入れ直しで呼ぶ
 * (バッジの文言がブラウザの再起動をまたいで残るかは実装時に確かめる。残らなくても onStartup で当て直す)
 */
export async function syncBadge(action: BadgeAction = chrome.action): Promise<void> {
  await applyBadge(await loadEnabled(), action);
}
