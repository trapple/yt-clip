/** 動画内の再生位置 (秒)。実時刻ではないので Date と混同しないこと */
export type ClipRange = {
  startSec: number;
  endSec: number;
};

/**
 * 動画に重ねる文字。
 *
 * **時刻は元動画の秒。出力タイムラインではない。** 区間を並べ替えたり縮めたり
 * してもテロップが発話に付いてくるようにするため (テロップ spec §0.1)。
 * 自動文字起こし (Phase 2) の出力もそのまま入れられる
 */
export type Telop = {
  startSec: number;
  endSec: number;
  /** 改行を含んでよい。空文字は「まだ書いていない」テロップで、描かない */
  text: string;
};

export type VideoMeta = {
  videoId: string;
  title: string;
  /**
   * 設定 (チャンネル別のハッシュタグ) を引く鍵。
   *
   * ハンドル (`@name`) を優先し、取れなければ `UC...`。どちらも取れなければ
   * 空文字。**タイトルと違って throw しない。** タグが無いだけで投稿本文は
   * 成立するので、ここで止める理由がない。
   *
   * **表示名は持たない。** 設定パネルが出すチャンネル名はその場で画面から
   * 引く。保存すると改名で古くなるうえ、読む人が誰もいなかった
   */
  channelId: string;
};

/**
 * 録画は成功したが通常の投稿フローに乗せられなかった理由。
 *
 * **`mp4-unsupported` は行き止まり。** 自動ダウンロードを廃止したので、
 * 録れた WebM を取り出す道は無い。操作の出し分けは状態の種類だけを見ており
 * 理由までは見ないため、「X にもう一度投稿」は押せるが同じ理由でまた失敗する。
 * 起きるのはプロプライエタリコーデック無しの環境だけなので、そこに分岐を
 * 足す価値より構造を複雑にする損の方が大きいと判断した
 */
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
  /**
   * 範囲を作った動画と、いま再生している動画が違う。
   * SPA 遷移で動画が入れ替わると、範囲もタイトルも URL も別の動画のものになる
   */
  | "video-changed"
  /** 状態機械の不正遷移など、ユーザー起因ではない内部エラー */
  | "internal-error";

/**
 * 失敗理由をユーザーに見せる文言。**理由と文言は必ず対で足す。**
 *
 * popup (拡張のアイコン) と YouTube ページのバーの両方が同じ文言を出す。
 * 片方だけが理由を知っていると、popup を開かなければ何が起きたのか
 * 分からない状態ができる。型の隣に置いて、足し忘れを型で止める。
 */
export const FAILURE_MESSAGES: Record<FailureReason, string> = {
  "seek-failed": "開始位置へ移動できませんでした",
  "playback-failed": "再生を開始できませんでした",
  "ad-playing": "広告の再生中です。終了後にやり直してください",
  "tab-lost": "録画対象のタブが見つかりません",
  "recording-aborted": "録画が中断されました",
  "drm-protected": "この動画は保護されているため録画できません",
  "video-changed": "動画が切り替わりました。IN を押し直してください",
  "internal-error": "内部エラーが発生しました",
};

export type ClipState =
  | { kind: "idle" }
  | { kind: "ready"; segments: ClipRange[]; meta: VideoMeta }
  | { kind: "seeking"; segments: ClipRange[]; meta: VideoMeta }
  | { kind: "recording"; segments: ClipRange[]; meta: VideoMeta }
  | { kind: "encoding"; segments: ClipRange[]; meta: VideoMeta }
  | {
      kind: "preview";
      clipId: string;
      segments: ClipRange[];
      meta: VideoMeta;
      mimeType: string;
    }
  /**
   * X へ添付し終えた状態。
   *
   * 範囲とクリップを残して**使い回せる**ようにする。同じ動画から続けて
   * 切り抜きを作る / 同じクリップを投稿し直す、どちらも日常的に起きる。
   * かつては `idle` に戻しており、範囲もクリップ参照も失われていた
   */
  | {
      kind: "posted";
      segments: ClipRange[];
      meta: VideoMeta;
      clipId: string;
      mimeType: string;
    }
  | {
      kind: "composing";
      clipId: string;
      segments: ClipRange[];
      meta: VideoMeta;
      mimeType: string;
    }
  | {
      kind: "degraded";
      clipId: string;
      segments: ClipRange[];
      meta: VideoMeta;
      mimeType: string;
      reason: DegradedReason;
    }
  /**
   * 区間を作る前に落ちた場合は `segments` が空配列になる。
   *
   * **nullable にしない。** 空配列と `null` の両方が「区間なし」を意味する
   * 状態を作ると、判定が 2 通りに割れる
   */
  | {
      kind: "failed";
      reason: FailureReason;
      segments: ClipRange[];
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
  /** 範囲の作成 (シンプルモード)。今ある区間を置き換える */
  | { type: "MARK_IN"; range: ClipRange; meta: VideoMeta }
  /**
   * 区間の追加 (エディットモード)。
   *
   * `idle` から受けたときは `MARK_IN` と同じ結果になるので、
   * 「最初の 1 回だけ MARK_IN」という分岐は content script に要らない
   */
  | { type: "ADD_SEGMENT"; range: ClipRange; meta: VideoMeta }
  /** 指した区間の終了位置だけを今の再生位置に合わせる */
  | { type: "MARK_OUT"; index: number; sec: number }
  /** 拡大バーでのドラッグ結果。取りこぼしでずれないよう常に両端を送る */
  | { type: "ADJUST_SEGMENT"; index: number; range: ClipRange }
  | { type: "REMOVE_SEGMENT"; index: number }
  | { type: "RESET_MARKS" }
  | { type: "START_RECORDING" }
  | { type: "SEEK_DONE" }
  | { type: "OUT_REACHED" }
  /** 録り始めてから戻る。範囲は残すので、そのまま録り直せる */
  | { type: "CANCEL_RECORDING" }
  | { type: "BLOB_READY"; clipId: string; mimeType: string }
  | { type: "RETAKE" }
  | { type: "POST" }
  | { type: "ATTACHED" }
  | { type: "DEGRADE"; reason: DegradedReason }
  | { type: "FAIL"; reason: FailureReason }
  | { type: "RETRY" };
