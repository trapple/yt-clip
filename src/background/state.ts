import {
  BUSY_KINDS,
  type ClipEvent,
  type ClipRange,
  type ClipState,
  type VideoMeta,
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

  if (event.type === "MARK_IN") {
    // 録画中に範囲を作り直させない。状態機械だけが戻って録画が走り続ける。
    // router と UI にも同じガードがあるが、そちらが漏れたときに
    // 防御が一枚も残らないのは避ける
    if (BUSY_KINDS.has(state.kind)) return invalid(state);
    return { kind: "ready", range: event.range, meta: event.meta };
  }

  switch (state.kind) {
    case "idle":
      return invalid(state);

    case "ready":
      if (event.type === "MARK_OUT") {
        return {
          kind: "ready",
          range: { startSec: state.range.startSec, endSec: event.sec },
          meta: state.meta,
        };
      }
      if (event.type === "ADJUST_RANGE") {
        return { kind: "ready", range: event.range, meta: state.meta };
      }
      if (event.type === "START_RECORDING") {
        return { kind: "seeking", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "seeking":
      if (event.type === "SEEK_DONE") {
        return { kind: "recording", range: state.range, meta: state.meta };
      }
      if (event.type === "CANCEL_RECORDING") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      return invalid(state);

    case "recording":
      if (event.type === "OUT_REACHED") {
        return { kind: "encoding", range: state.range, meta: state.meta };
      }
      // 範囲は残す。そのまま録り直せる。録画の停止は content script が
      // 「recording から外れた」ことを見て行う
      if (event.type === "CANCEL_RECORDING") {
        return { kind: "ready", range: state.range, meta: state.meta };
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
      // 範囲とクリップを残して使い回せるようにする。かつては idle に戻して
      // おり、YouTube に戻ったとき IN/OUT が触れなくなっていた
      if (event.type === "ATTACHED") {
        return {
          kind: "posted",
          range: state.range,
          meta: state.meta,
          clipId: state.clipId,
          mimeType: state.mimeType,
        };
      }
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

    case "posted":
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      // ここから下はクリップを外して ready へ戻る。**範囲を変えたら
      // クリップは外すこと。** 古い範囲のクリップを持ち続けると、画面に
      // 出ている範囲と投稿される中身が食い違う。自動保存があるので
      // ファイル自体は手元に残る
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "ADJUST_RANGE") {
        return { kind: "ready", range: event.range, meta: state.meta };
      }
      if (event.type === "MARK_OUT") {
        return {
          kind: "ready",
          range: { startSec: state.range.startSec, endSec: event.sec },
          meta: state.meta,
        };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "downloadable":
      // X の画面構成の変化で一度失敗しても、録り直さずに試し直せる。
      // ATTACHED を拒むガード (二度目の x/failed の後に遅れて届く経路) は
      // 別の話なので、そちらはそのまま残す
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
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
