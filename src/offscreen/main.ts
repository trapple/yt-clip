import { pickMimeType } from "@/offscreen/codec";
import { startRecording, type RecorderHandle } from "@/offscreen/recorder";
import type { Message } from "@/shared/messages";

let handle: RecorderHandle | null = null;

function fail(reason: string): void {
  handle = null;
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
    startRecording(message.streamId, mimeType)
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
    handle = null;
    stopping
      .stop()
      .then(async (blob) => {
        const buffer = await blob.arrayBuffer();
        void chrome.runtime.sendMessage({
          type: "recorder/done",
          buffer,
          mimeType: blob.type,
        } satisfies Message);
      })
      .catch((error: unknown) => fail(String(error)));
  }
});
