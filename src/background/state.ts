import type {
  ClipEvent,
  ClipRange,
  ClipState,
  VideoMeta,
} from "@/shared/types";

export const INITIAL_STATE: ClipState = { kind: "idle" };

/** 状態が保持している範囲を取り出す。持たない状態では null */
function rangeOf(state: ClipState): ClipRange | null {
  return "range" in state ? state.range : null;
}

/** 状態が保持しているメタ情報を取り出す。持たない状態では null */
function metaOf(state: ClipState): VideoMeta | null {
  return "meta" in state ? state.meta : null;
}

/** 定義されていない遷移。バグなので握り潰さず失敗状態として表面化させる */
function invalid(state: ClipState): ClipState {
  return {
    kind: "failed",
    reason: "internal-error",
    range: rangeOf(state),
    meta: metaOf(state),
  };
}

/** 状態遷移。副作用を持たない純粋関数 */
export function reduce(state: ClipState, event: ClipEvent): ClipState {
  // 失敗はどの状態からでも受け付ける
  if (event.type === "FAIL") {
    return {
      kind: "failed",
      reason: event.reason,
      range: rangeOf(state),
      meta: metaOf(state),
    };
  }

  // IN の打ち直しはマーク済みのどの段階からでも許す
  if (event.type === "MARK_IN") {
    return { kind: "marking", startSec: event.sec, meta: event.meta };
  }

  switch (state.kind) {
    case "idle":
      return invalid(state);

    case "marking":
      if (event.type === "MARK_OUT") {
        return {
          kind: "ready",
          range: { startSec: state.startSec, endSec: event.sec },
          meta: state.meta,
        };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "ready":
      if (event.type === "START_RECORDING") {
        return { kind: "seeking", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "seeking":
      if (event.type === "SEEK_DONE") {
        return { kind: "recording", range: state.range, meta: state.meta };
      }
      return invalid(state);

    case "recording":
      if (event.type === "OUT_REACHED") {
        return { kind: "encoding", range: state.range, meta: state.meta };
      }
      return invalid(state);

    case "encoding":
      if (event.type === "BLOB_READY") {
        return {
          kind: "preview",
          clipId: event.clipId,
          mimeType: event.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      return invalid(state);

    case "preview":
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      if (event.type === "DEGRADE") {
        return {
          kind: "downloadable",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
          reason: event.reason,
        };
      }
      return invalid(state);

    case "composing":
      if (event.type === "ATTACHED") return { kind: "idle" };
      // 投稿画面が用意できないまま待たされたとき、ユーザーが自分で抜けられる道。
      // service worker は数十秒で止まるためタイマーによる退避は当てにできない
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      // 録画済みの成果物は捨てずにダウンロードへ退避させる
      if (event.type === "DEGRADE") {
        return {
          kind: "downloadable",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
          reason: event.reason,
        };
      }
      return invalid(state);

    case "downloadable":
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "failed":
      if (event.type === "RETRY") {
        if (state.range === null || state.meta === null) {
          return { kind: "idle" };
        }
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);
  }
}
