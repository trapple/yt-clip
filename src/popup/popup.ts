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
const progressArea = document.getElementById("progress-area") as HTMLElement;
const progressElement = document.getElementById(
  "progress",
) as HTMLProgressElement;
const remainElement = document.getElementById("remain") as HTMLElement;

/** プレビュー用に発行した blob URL。差し替え・非表示時に解放する */
let previewUrl: string | null = null;
/** 残り時間を数えるタイマー。render の呼び出しごとに stopCountdown で必ず止めてから張り直す */
let countdownTimer: number | null = null;

/** 失敗を画面に出し、操作をやり直せる状態に戻す */
function showError(error: unknown): void {
  messageElement.textContent = `操作できませんでした: ${String(error)}`;
  setActionsDisabled(false);
}

function setActionsDisabled(disabled: boolean): void {
  for (const button of actionsElement.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

function send(event: ClipEvent): void {
  chrome.runtime
    .sendMessage({ type: "clip/event", event } satisfies Message)
    .catch(showError);
}

function stopCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  progressArea.hidden = true;
}

/**
 * 録画の残り時間を数える。
 * 状態機械は録画の開始時刻を持たないため、popup がこの画面を開いてからの
 * 経過で数える。閉じて開き直すと数え直しになるが、録画は最長 60 秒なので
 * 「進んでいることが分かる」という目的には足りる。
 *
 * render のたびに呼ばれるが、先頭で stopCountdown() しているため
 * setInterval が多重に走ることはない。popup がページごと破棄されれば
 * タイマーも自動的に消える。
 */
function startCountdown(totalSec: number): void {
  stopCountdown();

  const endsAt = Date.now() + totalSec * 1000;
  progressElement.max = totalSec;
  progressArea.hidden = false;

  const tick = (): void => {
    const remainSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    progressElement.value = totalSec - remainSec;
    remainElement.textContent = `残り ${remainSec} 秒`;
    if (remainSec === 0) {
      stopCountdown();
    }
  };

  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

/**
 * ダウンロードの決着を待つ。
 * 保存ダイアログを開いたまま放置されても固まらないよう打ち切る。
 *
 * @returns 決着を見届けられたら `true`、待ち時間を使い切ったら `false`
 */
function waitForDownload(id: number, timeoutMs = 300_000): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(settled);
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== id) return;
      const next = delta.state?.current;
      if (next === "complete" || next === "interrupted") {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function download(state: ClipState): Promise<void> {
  if (state.kind !== "downloadable") return;

  const clip = await getClip(state.clipId);
  const url = URL.createObjectURL(clip.blob);
  let canRelease = true;
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: buildClipFileName(
        clip.meta.videoId,
        clip.range.startSec,
        clip.mimeType,
      ),
      saveAs: true,
    });
    // 保存ダイアログを開いている間はまだ実データが読まれていないため、
    // ここで解放するとダウンロードが壊れる。決着を待ってから解放する。
    // 待ち時間を使い切った場合は読み出し中かもしれないので解放しない。
    // blob URL はこの画面のものなので、閉じれば道連れで解放される
    canRelease = await waitForDownload(downloadId);
  } finally {
    if (canRelease) {
      URL.revokeObjectURL(url);
    }
  }
}

function hidePreview(): void {
  previewElement.hidden = true;
  previewElement.removeAttribute("src");
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
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
    hidePreview();
    return;
  }

  const clip = await getClip(clipId);
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
  }
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
        setActionsDisabled(true);

        // download は ClipEvent を送らないため state/changed が届かない。
        // 自分で操作可能へ戻さないとボタンが押せないままになる
        if (action === "download") {
          void download(state)
            .then(() => setActionsDisabled(false))
            .catch(showError);
          return;
        }

        send(ACTION_EVENTS[action]);
      });
      return button;
    }),
  );

  if (view.recordingSec !== null) {
    startCountdown(view.recordingSec);
  } else {
    stopCountdown();
  }

  if (view.showPreview) {
    void showPreview(state).catch(showError);
  } else {
    hidePreview();
  }
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    render(message.state);
  }
});

chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => {
    if ("state" in response) {
      render(response.state);
    }
  })
  .catch(showError);
