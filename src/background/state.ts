import {
  BUSY_KINDS,
  type ClipEvent,
  type ClipRange,
  type ClipState,
  type VideoMeta,
} from "@/shared/types";
import { normalize } from "@/shared/timeline";

export const INITIAL_STATE: ClipState = { kind: "idle" };

/** 状態が持っている区間列を取り出す。持たない状態では空配列 */
function segmentsOf(state: ClipState): ClipRange[] {
  return "segments" in state ? state.segments : [];
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
    segments: segmentsOf(state),
    meta: metaOf(state),
  };
}

/**
 * 区間を差し替えて `ready` を作る。
 *
 * **`normalize` はここを必ず通す。** 呼び出し側に任せると、router 経由の
 * 経路で漏れたときに不正な `segments` が状態に入る。`reduce` は純粋関数の
 * ままなので、ここに置いても副作用はない
 */
function readyWith(segments: ClipRange[], meta: VideoMeta): ClipState {
  const normalized = normalize(segments);
  // 区間が 0 個の ready は録画に進めない死に状態なので作らない
  if (normalized.length === 0) return { kind: "idle" };
  return { kind: "ready", segments: normalized, meta };
}

/** UI から届いた index が実在するか。実在しなければ UI のバグ */
function hasIndex(segments: ClipRange[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < segments.length;
}

/**
 * 区間を編集する 3 イベントを処理する。処理しないイベントなら null。
 *
 * `ready` と `posted` が同じ規則で受けるため 1 箇所に集める。**`posted` から
 * 受けたときもここを通る = クリップは外れる。** 古い区間のクリップを持ち
 * 続けると、画面に出ている区間と投稿される中身が食い違う
 */
function editSegments(
  segments: ClipRange[],
  meta: VideoMeta,
  event: ClipEvent,
): ClipState | null {
  if (event.type === "MARK_OUT") {
    if (!hasIndex(segments, event.index)) return null;
    return readyWith(
      segments.map((segment, index) =>
        index === event.index
          ? { startSec: segment.startSec, endSec: event.sec }
          : segment,
      ),
      meta,
    );
  }
  if (event.type === "ADJUST_SEGMENT") {
    if (!hasIndex(segments, event.index)) return null;
    return readyWith(
      segments.map((segment, index) =>
        index === event.index ? event.range : segment,
      ),
      meta,
    );
  }
  if (event.type === "REMOVE_SEGMENT") {
    if (!hasIndex(segments, event.index)) return null;
    return readyWith(
      segments.filter((_, index) => index !== event.index),
      meta,
    );
  }
  return null;
}

/** 区間を編集するイベントか。index が不正でも true (invalid に落とすため) */
function isEditEvent(event: ClipEvent): boolean {
  return (
    event.type === "MARK_OUT" ||
    event.type === "ADJUST_SEGMENT" ||
    event.type === "REMOVE_SEGMENT"
  );
}

/** 状態遷移。副作用を持たない純粋関数 */
export function reduce(state: ClipState, event: ClipEvent): ClipState {
  // 失敗はどの状態からでも受け付ける
  if (event.type === "FAIL") {
    return {
      kind: "failed",
      reason: event.reason,
      segments: segmentsOf(state),
      meta: metaOf(state),
    };
  }

  if (event.type === "MARK_IN") {
    // 録画中に範囲を作り直させない。状態機械だけが戻って録画が走り続ける。
    // router と UI にも同じガードがあるが、そちらが漏れたときに
    // 防御が一枚も残らないのは避ける
    if (BUSY_KINDS.has(state.kind)) return invalid(state);
    return readyWith([event.range], event.meta);
  }

  if (event.type === "ADD_SEGMENT") {
    if (BUSY_KINDS.has(state.kind)) return invalid(state);

    // **結合できるのは同じ動画の中だけ。** SPA 遷移で別の動画へ移ってから
    // 足すと、B の映像を A の秒で切ったクリップに A のタイトルと URL が
    // 付いて投稿される。混ぜずに作り直す (MARK_IN と同じ結果)
    const previousMeta = metaOf(state);
    if (previousMeta !== null && previousMeta.videoId !== event.meta.videoId) {
      return readyWith([event.range], event.meta);
    }

    // idle からは MARK_IN と同じ結果になる。posted からはクリップが外れる
    return readyWith([...segmentsOf(state), event.range], event.meta);
  }

  switch (state.kind) {
    case "idle":
      return invalid(state);

    case "ready":
      if (isEditEvent(event)) {
        return editSegments(state.segments, state.meta, event) ?? invalid(state);
      }
      if (event.type === "START_RECORDING") {
        return { kind: "seeking", segments: state.segments, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "seeking":
      if (event.type === "SEEK_DONE") {
        return { kind: "recording", segments: state.segments, meta: state.meta };
      }
      if (event.type === "CANCEL_RECORDING") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      return invalid(state);

    case "recording":
      if (event.type === "OUT_REACHED") {
        return { kind: "encoding", segments: state.segments, meta: state.meta };
      }
      // 区間は残す。そのまま録り直せる。録画の停止は content script が
      // 「recording から外れた」ことを見て行う
      if (event.type === "CANCEL_RECORDING") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      return invalid(state);

    case "encoding":
      if (event.type === "BLOB_READY") {
        return {
          kind: "preview",
          clipId: event.clipId,
          mimeType: event.mimeType,
          segments: state.segments,
          meta: state.meta,
        };
      }
      return invalid(state);

    case "preview":
      if (event.type === "RETAKE") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          segments: state.segments,
          meta: state.meta,
        };
      }
      if (event.type === "DEGRADE") {
        return {
          kind: "degraded",
          clipId: state.clipId,
          mimeType: state.mimeType,
          segments: state.segments,
          meta: state.meta,
          reason: event.reason,
        };
      }
      return invalid(state);

    case "composing":
      // 区間とクリップを残して使い回せるようにする。かつては idle に戻して
      // おり、YouTube に戻ったとき IN/OUT が触れなくなっていた
      if (event.type === "ATTACHED") {
        return {
          kind: "posted",
          segments: state.segments,
          meta: state.meta,
          clipId: state.clipId,
          mimeType: state.mimeType,
        };
      }
      // 投稿画面が用意できないまま待たされたとき、ユーザーが自分で抜けられる道。
      // service worker は数十秒で止まるためタイマーによる退避は当てにできない
      if (event.type === "RETAKE") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      // 録画済みの成果物は捨てずに退避させる
      if (event.type === "DEGRADE") {
        return {
          kind: "degraded",
          clipId: state.clipId,
          mimeType: state.mimeType,
          segments: state.segments,
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
          segments: state.segments,
          meta: state.meta,
        };
      }
      if (event.type === "RETAKE") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      // ここから下はクリップを外して ready へ戻る。**区間を変えたら
      // クリップは外すこと。** 古い区間のクリップを持ち続けると、画面に
      // 出ている区間と投稿される中身が食い違う
      if (isEditEvent(event)) {
        return editSegments(state.segments, state.meta, event) ?? invalid(state);
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "degraded":
      // X の画面構成の変化で一度失敗しても、録り直さずに試し直せる。
      // ATTACHED を拒むガード (二度目の x/failed の後に遅れて届く経路) は
      // 別の話なので、そちらはそのまま残す
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          segments: state.segments,
          meta: state.meta,
        };
      }
      if (event.type === "RETAKE") {
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "failed":
      if (event.type === "RETRY") {
        // 空配列が「区間を作る前に落ちた」を表す。nullable にはしない
        if (state.segments.length === 0 || state.meta === null) {
          return { kind: "idle" };
        }
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);
  }
}
