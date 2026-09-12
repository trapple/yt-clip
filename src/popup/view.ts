import { formatTime } from "@/shared/time";
// 文言は content script (YouTube ページのバー) とも共有する
import { FAILURE_MESSAGES, type ClipState } from "@/shared/types";

export type PopupAction =
  | "record"
  | "retake"
  | "post"
  | "download"
  | "retry"
  | "reset";

export type PopupView = {
  message: string;
  actions: PopupAction[];
  /** 進行中で操作を受け付けない状態か */
  busy: boolean;
  /** 録画済みクリップの再生欄を出すか */
  showPreview: boolean;
  /**
   * 録画中のみ、クリップの長さ (秒)。
   * 残り時間の表示は popup が自分で数える。状態機械は録画の開始時刻を
   * 持たないため、ここで返せるのは長さだけ。
   */
  recordingSec: number | null;
};

const DEGRADED_MESSAGES = {
  "mp4-unsupported":
    "この環境では X に直接添付できません。変換してご利用ください",
  "x-attach-failed":
    "X の画面構成が変わったため自動添付できませんでした。ファイルをダウンロードして手動で添付してください",
} as const;

function durationOf(startSec: number, endSec: number): number {
  return Math.round(endSec - startSec);
}

export function describeState(state: ClipState): PopupView {
  switch (state.kind) {
    case "idle":
      return {
        message: "YouTube の再生画面で IN を押してください",
        actions: [],
        busy: false,
        showPreview: false,
        recordingSec: null,
      };

    case "ready":
      return {
        message: `${formatTime(state.range.startSec)} 〜 ${formatTime(state.range.endSec)} (${durationOf(state.range.startSec, state.range.endSec)}秒) を録画できます`,
        actions: ["record", "reset"],
        busy: false,
        showPreview: false,
        recordingSec: null,
      };

    case "seeking":
      return {
        message: "開始位置へ移動しています…",
        actions: [],
        busy: true,
        showPreview: false,
        recordingSec: null,
      };

    case "recording":
      // 録画は実時間かかるため、残り時間を popup 側で数えて見せる
      return {
        message: "録画中…",
        actions: [],
        busy: true,
        showPreview: false,
        recordingSec: durationOf(state.range.startSec, state.range.endSec),
      };

    case "encoding":
      return {
        message: "録画を書き出しています…",
        actions: [],
        busy: true,
        showPreview: false,
        recordingSec: null,
      };

    case "preview":
      return {
        message: "録画できました。内容を確認してください",
        actions: ["post", "retake"],
        busy: false,
        showPreview: true,
        recordingSec: null,
      };

    case "composing":
      // 投稿画面が開かないまま戻ってきたときに詰まないよう、抜ける道を必ず残す
      return {
        message: "X の投稿画面で内容を確認して投稿してください",
        actions: ["retake"],
        busy: false,
        showPreview: true,
        recordingSec: null,
      };

    case "downloadable":
      return {
        message: DEGRADED_MESSAGES[state.reason],
        actions: ["download", "retake"],
        busy: false,
        showPreview: true,
        recordingSec: null,
      };

    case "failed":
      return {
        message: FAILURE_MESSAGES[state.reason],
        actions: ["retry"],
        busy: false,
        showPreview: false,
        recordingSec: null,
      };
  }
}
