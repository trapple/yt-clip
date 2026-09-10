import { saveClip } from "@/background/storage";
import { pickMimeType } from "@/offscreen/codec";
import { startRecording, type RecorderHandle } from "@/offscreen/recorder";
import type { Message } from "@/shared/messages";
import type { ClipRange, VideoMeta } from "@/shared/types";

let handle: RecorderHandle | null = null;
/** 録画中のクリップの保存先。recorder/start で受け取る */
let pending: { clipId: string; range: ClipRange; meta: VideoMeta } | null = null;

function fail(reason: string): void {
  handle = null;
  pending = null;
  void chrome.runtime.sendMessage({
    type: "recorder/failed",
    reason,
  } satisfies Message);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "recorder/start") {
    let mimeType: string;
    try {
      // MediaRecorder を持つのは offscreen だけなので形式判定もここで行う
      mimeType = pickMimeType().mimeType;
    } catch (error) {
      fail(String(error));
      return;
    }
    pending = {
      clipId: message.clipId,
      range: message.range,
      meta: message.meta,
    };
    startRecording(message.streamId, mimeType, {
      // 録画が途中で死んだ場合、stop() を待たずに sw へ知らせる
      onUnexpectedStop: (error) => fail(error.message),
    })
      .then((started) => {
        handle = started;
        // 録画が始まったことを知らせる。sw はこれを待ってから再生を再開させる
        void chrome.runtime.sendMessage({
          type: "recorder/started",
        } satisfies Message);
      })
      .catch((error: unknown) => fail(String(error)));
    return;
  }

  if (message.type === "recorder/stop") {
    if (handle === null) {
      fail("録画が開始されていません");
      return;
    }
    const stopping = handle;
    const target = pending;
    handle = null;
    pending = null;

    if (target === null) {
      fail("保存先が分かりません");
      return;
    }

    stopping
      .stop()
      .then(async (blob) => {
        // ここで直接 IndexedDB に書く。拡張のメッセージは JSON 化されるため、
        // 録画データを service worker へ渡すことはできない
        await saveClip({
          id: target.clipId,
          blob,
          mimeType: blob.type,
          range: target.range,
          meta: target.meta,
          createdAt: Date.now(),
        });
        void chrome.runtime.sendMessage({
          type: "recorder/done",
          clipId: target.clipId,
          mimeType: blob.type,
        } satisfies Message);
      })
      .catch((error: unknown) => fail(String(error)));
  }
});
