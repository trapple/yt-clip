import type { ClipEvent, ClipState } from "@/shared/types";

/** chrome.runtime を流れるメッセージ。両端がこの型だけを知る */
export type Message =
  /** popup / content → sw: 現在状態の問い合わせ */
  | { type: "state/get" }
  /** sw → popup / content: 状態変化の通知 */
  | { type: "state/changed"; state: ClipState }
  /** content / popup → sw: 状態機械へのイベント投入 */
  | { type: "clip/event"; event: ClipEvent }
  /** sw → offscreen: 録画開始。使用する形式は offscreen 側が判定する */
  | { type: "recorder/start"; streamId: string }
  /** sw → offscreen: 録画停止 */
  | { type: "recorder/stop" }
  /** offscreen → sw: 録画が実際に始まった。これを待ってから再生を再開させる */
  | { type: "recorder/started" }
  /** offscreen → sw: 録画結果 */
  | { type: "recorder/done"; buffer: ArrayBuffer; mimeType: string }
  /** offscreen → sw: 録画中の失敗 */
  | { type: "recorder/failed"; reason: string }
  /** content(x) → sw: 投稿画面の準備完了 */
  | { type: "x/ready" }
  /** sw → content(x): 添付する動画と本文 */
  | {
      type: "x/payload";
      buffer: ArrayBuffer;
      mimeType: string;
      fileName: string;
      text: string;
    }
  /** content(x) → sw: 添付成功 */
  | { type: "x/attached" }
  /** content(x) → sw: 添付失敗 (DOM 変更など) */
  | { type: "x/failed"; reason: string };

/** sw が返す応答。state/get のみ状態を返し、他は受領確認のみ */
export type MessageResponse = { state: ClipState } | { ok: true };
