import { formatTime } from "@/shared/time";
import { totalSec } from "@/shared/timeline";
// 文言は content script (YouTube ページのバー) とも共有する
import { FAILURE_MESSAGES, type ClipRange, type ClipState } from "@/shared/types";

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

/**
 * 録画は成功したが投稿の流れに乗せられなかった理由。
 *
 * **ダウンロードへ誘導しないこと。** 動画ファイルをディスクに書き出す経路は
 * 廃止した (`.claude/specs/2026-09-12-drop-auto-save-design.md`)
 */
const DEGRADED_MESSAGES = {
  "mp4-unsupported":
    "このブラウザでは X に添付できる形式で録画できません",
  "x-attach-failed":
    "X への自動添付に失敗しました。「X にもう一度投稿」でやり直せます",
} as const;

/** クリップの長さ (秒)。**合計で数える。元動画上の幅ではない** */
function durationOf(segments: ClipRange[]): number {
  return Math.round(totalSec(segments));
}

/**
 * 区間を人が読める形にする。
 *
 * **1 区間なら今までどおり範囲で出す。** 区間数を常に出すと、シンプルモードで
 * 使っている人に関係のない概念が見えることになる
 */
function segmentsLabel(segments: ClipRange[]): string {
  const only = segments.length === 1 ? segments[0] : undefined;
  if (only !== undefined) {
    return `${formatTime(only.startSec)} 〜 ${formatTime(only.endSec)} (${durationOf(segments)}秒)`;
  }
  return `${segments.length} 区間 / ${durationOf(segments)} 秒`;
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
        message: `${segmentsLabel(state.segments)} を録画できます`,
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
        recordingSec: durationOf(state.segments),
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
        message: `X に添付しました (${durationOf(state.segments)}秒)`,
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

    case "degraded":
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
