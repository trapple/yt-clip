import { getClip } from "@/background/storage";
import { describeState, type PopupAction } from "@/popup/view";
import { buildClipFileName } from "@/shared/filename";
import type { Message, MessageResponse } from "@/shared/messages";
import type { ClipEvent, ClipState } from "@/shared/types";

const ACTION_LABELS: Record<PopupAction, string> = {
  record: "録画",
  retake: "取り直し",
  post: "X に投稿",
  download: "ダウンロード",
  retry: "再試行",
  reset: "取り消し",
};

const ACTION_EVENTS: Record<Exclude<PopupAction, "download">, ClipEvent> = {
  record: { type: "START_RECORDING" },
  retake: { type: "RETAKE" },
  post: { type: "POST" },
  retry: { type: "RETRY" },
  reset: { type: "RESET_MARKS" },
};

const messageElement = document.getElementById("message") as HTMLElement;
const previewElement = document.getElementById("preview") as HTMLVideoElement;
const actionsElement = document.getElementById("actions") as HTMLElement;

/** プレビュー用に発行した blob URL。差し替え・非表示時に解放する */
let previewUrl: string | null = null;

function send(event: ClipEvent): void {
  void chrome.runtime.sendMessage({
    type: "clip/event",
    event,
  } satisfies Message);
}

function releasePreviewUrl(): void {
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

async function download(state: ClipState): Promise<void> {
  if (state.kind !== "downloadable") return;

  const clip = await getClip(state.clipId);
  const url = URL.createObjectURL(clip.blob);
  try {
    await chrome.downloads.download({
      url,
      filename: buildClipFileName(
        clip.meta.videoId,
        clip.range.startSec,
        clip.mimeType,
      ),
      saveAs: true,
    });
  } finally {
    // ダウンロード用 URL はプレビューとは別物なので、使い終えたら即解放する
    URL.revokeObjectURL(url);
  }
}

async function showPreview(state: ClipState): Promise<void> {
  const clipId =
    state.kind === "preview" ||
    state.kind === "composing" ||
    state.kind === "downloadable"
      ? state.clipId
      : null;

  if (clipId === null) {
    previewElement.hidden = true;
    return;
  }

  const clip = await getClip(clipId);
  releasePreviewUrl();
  previewUrl = URL.createObjectURL(clip.blob);
  previewElement.src = previewUrl;
  previewElement.hidden = false;
}

function render(state: ClipState): void {
  const view = describeState(state);
  messageElement.textContent = view.message;

  actionsElement.replaceChildren(
    ...view.actions.map((action) => {
      const button = document.createElement("button");
      button.textContent = ACTION_LABELS[action];
      button.disabled = view.busy;
      button.addEventListener("click", () => {
        // 二重送信防止: クリックした瞬間にこの render 内のボタンを全て無効化する。
        // 実際の状態遷移は service worker からの state/changed 通知で反映される
        for (const el of actionsElement.querySelectorAll("button")) {
          el.disabled = true;
        }
        if (action === "download") {
          void download(state);
          return;
        }
        send(ACTION_EVENTS[action]);
      });
      return button;
    }),
  );

  if (view.showPreview) {
    void showPreview(state);
  } else {
    releasePreviewUrl();
    previewElement.hidden = true;
  }
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    render(message.state);
  }
});

void chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => {
    if ("state" in response) {
      render(response.state);
    }
  });
