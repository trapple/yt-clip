import { formatTime } from "@/shared/time";
// 文言は content script (YouTube ページのバー) とも共有する
import { FAILURE_MESSAGES, type ClipState } from "@/shared/types";

/**
 * popup が出すもの。**操作は持たない。**
 *
 * 操作はページ内バーへ移した。popup を残しているのは、YouTube 以外のタブに
 * いるときに状態を見る場所が無くなるため。X の投稿画面で添付に失敗した
 * 場面が実際にこれに当たる
 */
export type PopupView = {
  message: string;
  /** 進行中で操作を受け付けない状態か */
  busy: boolean;
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
        busy: false,
        recordingSec: null,
      };

    case "ready":
      return {
        message: `${formatTime(state.range.startSec)} 〜 ${formatTime(state.range.endSec)} (${durationOf(state.range.startSec, state.range.endSec)}秒) を録画できます`,
        busy: false,
        recordingSec: null,
      };

    case "seeking":
      return {
        message: "開始位置へ移動しています…",
        busy: true,
        recordingSec: null,
      };

    case "recording":
      // 録画は実時間かかるため、残り時間を popup 側で数えて見せる
      return {
        message: "録画中…",
        busy: true,
        recordingSec: durationOf(state.range.startSec, state.range.endSec),
      };

    case "encoding":
      return {
        message: "録画を書き出しています…",
        busy: true,
        recordingSec: null,
      };

    case "preview":
      return {
        message: "録画できました。内容を確認してください",
        busy: false,
        recordingSec: null,
      };

    case "posted":
      return {
        message: `X に添付しました (${durationOf(
          state.range.startSec,
          state.range.endSec,
        )}秒)`,
        busy: false,
        recordingSec: null,
      };

    case "composing":
      // 投稿画面が開かないまま戻ってきたときに詰まないよう、抜ける道を必ず残す
      return {
        message: "X の投稿画面で内容を確認して投稿してください",
        busy: false,
        recordingSec: null,
      };

    case "downloadable":
      return {
        message: DEGRADED_MESSAGES[state.reason],
        busy: false,
        recordingSec: null,
      };

    case "failed":
      return {
        message: FAILURE_MESSAGES[state.reason],
        busy: false,
        recordingSec: null,
      };
  }
}
