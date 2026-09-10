import { formatTime } from "@/shared/time";
import type { ClipState, FailureReason } from "@/shared/types";

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
};

const FAILURE_MESSAGES: Record<FailureReason, string> = {
  "capture-permission-denied": "タブの録画が許可されませんでした",
  "seek-failed": "開始位置へ移動できませんでした",
  "playback-failed": "再生を開始できませんでした",
  "ad-playing": "広告の再生中です。終了後にやり直してください",
  "tab-lost": "録画対象のタブが見つかりません",
  "recording-aborted": "録画が中断されました",
  "internal-error": "内部エラーが発生しました",
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
      };

    case "marking":
      return {
        message: `${formatTime(state.startSec)} から開始。OUT を押してください`,
        actions: [],
        busy: false,
        showPreview: false,
      };

    case "ready":
      return {
        message: `${formatTime(state.range.startSec)} 〜 ${formatTime(state.range.endSec)} (${durationOf(state.range.startSec, state.range.endSec)}秒) を録画できます`,
        actions: ["record", "reset"],
        busy: false,
        showPreview: false,
      };

    case "seeking":
      return {
        message: "開始位置へ移動しています…",
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "recording":
      // 録画は実時間かかるため、待ち時間を明示する
      return {
        message: `録画中… 残り ${durationOf(state.range.startSec, state.range.endSec)} 秒`,
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "encoding":
      return {
        message: "録画を書き出しています…",
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "preview":
      return {
        message: "録画できました。内容を確認してください",
        actions: ["post", "retake"],
        busy: false,
        showPreview: true,
      };

    case "composing":
      return {
        message: "X の投稿画面で内容を確認して投稿してください",
        actions: [],
        busy: false,
        showPreview: true,
      };

    case "downloadable":
      return {
        message: DEGRADED_MESSAGES[state.reason],
        actions: ["download", "retake"],
        busy: false,
        showPreview: true,
      };

    case "failed":
      return {
        message: FAILURE_MESSAGES[state.reason],
        actions: ["retry"],
        busy: false,
        showPreview: false,
      };
  }
}
