import type {
  ClipEvent,
  ClipRange,
  ClipState,
  VideoMeta,
} from "@/shared/types";

/** chrome.runtime を流れるメッセージ。両端がこの型だけを知る */
export type Message =
  /** popup / content → sw: 現在状態の問い合わせ */
  | { type: "state/get" }
  /** sw → popup / content: 状態変化の通知 */
  | { type: "state/changed"; state: ClipState }
  /** content / popup → sw: 状態機械へのイベント投入 */
  | { type: "clip/event"; event: ClipEvent }
  /**
   * sw → offscreen: 録画開始。使用する形式は offscreen 側が判定する。
   *
   * 保存に必要な情報を一緒に渡すのは、録画データを offscreen から直接
   * IndexedDB へ書くため。拡張のメッセージは JSON 化されるので ArrayBuffer を
   * そのまま載せると中身が失われる (`{}` になる)。
   */
  | {
      type: "recorder/start";
      streamId: string;
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
    }
  /** sw → offscreen: 録画停止 */
  | { type: "recorder/stop" }
  /** offscreen → sw: 録画が実際に始まった。これを待ってから再生を再開させる */
  | { type: "recorder/started" }
  /** offscreen → sw: 録画を保存し終えた。データ本体は IndexedDB にある */
  | { type: "recorder/done"; clipId: string; mimeType: string }
  /** offscreen → sw: 録画中の失敗 */
  | { type: "recorder/failed"; reason: string }
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
