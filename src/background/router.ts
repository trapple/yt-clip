import { INITIAL_STATE, reduce } from "@/background/state";
import type { StoredClip } from "@/background/storage";
import { buildClipFileName } from "@/shared/filename";
import type { Message } from "@/shared/messages";
import { renderTemplate } from "@/shared/template";
import type { ClipEvent, ClipState, FailureReason } from "@/shared/types";

/** router が使う外部依存。テストではフェイクを渡す */
export type RouterDeps = {
  ensureOffscreen(): Promise<void>;
  getStreamId(tabId: number): Promise<string>;
  saveClip(clip: StoredClip): Promise<void>;
  getClip(id: string): Promise<StoredClip>;
  /** offscreen / popup 宛。受け手が居ないことは正常なので送信側では扱わない */
  sendToRuntime(message: Message): void;
  sendToTab(tabId: number, message: Message): void;
  openComposeTab(): Promise<number>;
  loadTemplate(): Promise<string>;
  /** UTC epoch ミリ秒 */
  now(): number;
  persist(snapshot: RouterSnapshot): Promise<void>;
};

/** service worker が停止しても復元できるよう保存する内容 */
export type RouterSnapshot = {
  state: ClipState;
  captureTabId: number | null;
  composeTabId: number | null;
};

export type Router = {
  getState(): ClipState;
  handle(message: Message, senderTabId?: number): Promise<void>;
};

export function createRouter(
  deps: RouterDeps,
  initial?: RouterSnapshot,
): Router {
  let state: ClipState = initial?.state ?? INITIAL_STATE;
  let captureTabId: number | null = initial?.captureTabId ?? null;
  let composeTabId: number | null = initial?.composeTabId ?? null;
  let streamId: string | null = null;

  async function commit(event: ClipEvent): Promise<void> {
    state = reduce(state, event);
    await deps.persist({ state, captureTabId, composeTabId });

    const message: Message = { type: "state/changed", state };
    deps.sendToRuntime(message);
    if (captureTabId !== null) {
      deps.sendToTab(captureTabId, message);
    }
  }

  async function fail(reason: FailureReason): Promise<void> {
    await commit({ type: "FAIL", reason });
  }

  /** 録画の下準備。動画はまだ進めない */
  async function prepareCapture(): Promise<void> {
    if (captureTabId === null) {
      await fail("tab-lost");
      return;
    }
    try {
      await deps.ensureOffscreen();
      streamId = await deps.getStreamId(captureTabId);
    } catch {
      await fail("capture-permission-denied");
    }
  }

  /** seek 完了後に録画を始めさせる。状態を進めるのは recorder/started を受けてから */
  async function beginRecording(): Promise<void> {
    if (streamId === null) {
      await fail("capture-permission-denied");
      return;
    }
    deps.sendToRuntime({ type: "recorder/start", streamId });
    streamId = null;
  }

  async function storeRecording(
    buffer: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    if (state.kind !== "encoding") {
      await fail("recording-aborted");
      return;
    }

    const clipId = `clip-${deps.now()}`;
    await deps.saveClip({
      id: clipId,
      blob: new Blob([buffer], { type: mimeType }),
      mimeType,
      range: state.range,
      meta: state.meta,
      createdAt: deps.now(),
    });
    await commit({ type: "BLOB_READY", clipId, mimeType });

    // MP4 でなければ X に添付できないが、録画済みの成果物は捨てない
    if (!mimeType.includes("mp4")) {
      await commit({ type: "DEGRADE", reason: "mp4-unsupported" });
    }
  }

  async function sendPayload(): Promise<void> {
    if (state.kind !== "composing" || composeTabId === null) return;

    const clip = await deps.getClip(state.clipId);
    const template = await deps.loadTemplate();
    deps.sendToTab(composeTabId, {
      type: "x/payload",
      buffer: await clip.blob.arrayBuffer(),
      mimeType: clip.mimeType,
      fileName: buildClipFileName(
        clip.meta.videoId,
        clip.range.startSec,
        clip.mimeType,
      ),
      text: renderTemplate(template, clip.meta, clip.range),
    });
  }

  async function handleEvent(
    event: ClipEvent,
    senderTabId?: number,
  ): Promise<void> {
    if (event.type === "MARK_IN" && senderTabId !== undefined) {
      captureTabId = senderTabId;
    }

    // seek 完了は即座に反映しない。録画が始まってから recording へ進める
    if (event.type === "SEEK_DONE") {
      await beginRecording();
      return;
    }

    await commit(event);

    if (event.type === "START_RECORDING") {
      await prepareCapture();
      return;
    }
    if (event.type === "OUT_REACHED") {
      deps.sendToRuntime({ type: "recorder/stop" });
      return;
    }
    if (event.type === "POST") {
      composeTabId = await deps.openComposeTab();
    }
  }

  return {
    getState: () => state,

    async handle(message: Message, senderTabId?: number): Promise<void> {
      switch (message.type) {
        case "clip/event":
          await handleEvent(message.event, senderTabId);
          return;
        case "recorder/started":
          await commit({ type: "SEEK_DONE" });
          return;
        case "recorder/done":
          await storeRecording(message.buffer, message.mimeType);
          return;
        case "recorder/failed":
          await fail("recording-aborted");
          return;
        case "x/ready":
          await sendPayload();
          return;
        case "x/attached":
          await commit({ type: "ATTACHED" });
          return;
        case "x/failed":
          await commit({ type: "DEGRADE", reason: "x-attach-failed" });
          return;
        default:
          // state/get と state/changed は router の処理対象外
          return;
      }
    },
  };
}
