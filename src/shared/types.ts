/** 動画内の再生位置 (秒)。実時刻ではないので Date と混同しないこと */
export type ClipRange = {
  startSec: number;
  endSec: number;
};

export type VideoMeta = {
  videoId: string;
  title: string;
};

/** 録画は成功したが通常の投稿フローに乗せられなかった理由 */
export type DegradedReason = "mp4-unsupported" | "x-attach-failed";

/** 明示的な失敗の理由。握り潰さず必ずユーザーに提示する */
export type FailureReason =
  | "seek-failed"
  | "playback-failed"
  | "ad-playing"
  | "tab-lost"
  | "recording-aborted"
  /** 暗号化された動画は captureStream が黒画面を返すため録画できない */
  | "drm-protected"
  /** 状態機械の不正遷移など、ユーザー起因ではない内部エラー */
  | "internal-error";

export type ClipState =
  | { kind: "idle" }
  | { kind: "ready"; range: ClipRange; meta: VideoMeta }
  | { kind: "seeking"; range: ClipRange; meta: VideoMeta }
  | { kind: "recording"; range: ClipRange; meta: VideoMeta }
  | { kind: "encoding"; range: ClipRange; meta: VideoMeta }
  | {
      kind: "preview";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
    }
  | {
      kind: "composing";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
    }
  | {
      kind: "downloadable";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
      reason: DegradedReason;
    }
  /** range / meta が null なのは、マーク確定前に起きた内部エラーの場合だけ */
  | {
      kind: "failed";
      reason: FailureReason;
      range: ClipRange | null;
      meta: VideoMeta | null;
    };

/**
 * 録画が進行中で、範囲の変更を受け付けない状態。
 * 範囲を変えると状態機械だけが戻り、録画は走り続けて取り残される。
 */
export const BUSY_KINDS: ReadonlySet<ClipState["kind"]> = new Set([
  "seeking",
  "recording",
  "encoding",
]);

export type ClipEvent =
  /** 範囲の作成。既定の長さを決めるのは content script の責務 */
  | { type: "MARK_IN"; range: ClipRange; meta: VideoMeta }
  /** 終了位置だけを今の再生位置に合わせる */
  | { type: "MARK_OUT"; sec: number }
  /** 拡大バーでのドラッグ結果。取りこぼしで両者がずれないよう常に両端を送る */
  | { type: "ADJUST_RANGE"; range: ClipRange }
  | { type: "RESET_MARKS" }
  | { type: "START_RECORDING" }
  | { type: "SEEK_DONE" }
  | { type: "OUT_REACHED" }
  | { type: "BLOB_READY"; clipId: string; mimeType: string }
  | { type: "RETAKE" }
  | { type: "POST" }
  | { type: "ATTACHED" }
  | { type: "DEGRADE"; reason: DegradedReason }
  | { type: "FAIL"; reason: FailureReason }
  | { type: "RETRY" };
