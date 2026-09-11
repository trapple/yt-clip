import type { ClipEvent, ClipState } from "@/shared/types";

/** chrome.runtime を流れるメッセージ。両端がこの型だけを知る */
export type Message =
  /** popup / content → sw: 現在状態の問い合わせ */
  | { type: "state/get" }
  /** sw → popup / content: 状態変化の通知 */
  | { type: "state/changed"; state: ClipState }
  /** content / popup → sw: 状態機械へのイベント投入 */
  | { type: "clip/event"; event: ClipEvent }
  /**
   * sw → content: 録画開始。
   * 録画するのは content script なので、範囲も動画情報も content 側が持っている。
   * 使用する形式の判定も content 側で行う
   */
  | { type: "recorder/start" }
  /** sw → content: 録画停止 */
  | { type: "recorder/stop" }
  /** content → sw: 録画が実際に始まった。これを待ってから再生を再開させる */
  | { type: "recorder/started" }
  /**
   * content → sw: 録画結果。
   * content script は拡張の IndexedDB を読み書きできないため、
   * base64 にして渡し、保存は service worker が行う
   */
  | { type: "recorder/done"; base64: string; mimeType: string }
  /** content → sw: 録画中の失敗 */
  | { type: "recorder/failed"; reason: string }
  /**
   * content → sw: content script が読み込まれた (初回 / タブのリロード)。
   *
   * 録画中にタブをリロードすると、OUT を監視していた content script ごと消える。
   * タブ自体は生きているため `chrome.tabs.onRemoved` では気付けず、放置すると
   * `OUT_REACHED` が永久に来ない。**録画対象のタブかどうかは送り主の tabId を
   * 持つ service worker にしか判定できない**ため、判断は router に委ねる。
   */
  | { type: "content/loaded" }
  /** content(x) → sw: 投稿画面の準備完了 */
  | { type: "x/ready" }
  /**
   * sw → content(x): 添付する動画と本文。
   *
   * 動画は base64 で運ぶ。content script は拡張の IndexedDB を読めず、
   * かつ拡張のメッセージは JSON 化されるため ArrayBuffer を載せられない。
   */
  | {
      type: "x/payload";
      base64: string;
      mimeType: string;
      fileName: string;
      text: string;
    }
  /** content(x) → sw: 添付成功 */
  | { type: "x/attached" }
  /** content(x) → sw: 添付失敗 (DOM 変更など) */
  | { type: "x/failed"; reason: string };

/**
 * sw が返す応答。**常に最新の状態を返す。**
 * 受け付けられなかった操作では状態が変わらず `state/changed` も飛ばないため、
 * 送り手が結果を知る手段がこれしかない。
 */
export type MessageResponse = { state: ClipState };
