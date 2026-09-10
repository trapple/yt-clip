import {
  getVideo,
  getVideoMeta,
  isAdPlaying,
  onReachTime,
  seekTo,
  startPlayback,
} from "@/content/player";
import { YT_SELECTORS } from "@/content/selectors";
import type { Message } from "@/shared/messages";
import { formatTime, validateRange } from "@/shared/time";
import type { ClipEvent } from "@/shared/types";

const BAR_ID = "yt-clip-bar";

let markedInSec: number | null = null;
let cancelWatch: (() => void) | null = null;

function send(event: ClipEvent): void {
  void chrome.runtime.sendMessage({
    type: "clip/event",
    event,
  } satisfies Message);
}

function setStatus(text: string): void {
  const status = document.getElementById(`${BAR_ID}-status`);
  if (status !== null) {
    status.textContent = text;
  }
}

function onMarkIn(): void {
  const video = getVideo();
  markedInSec = video.currentTime;
  send({ type: "MARK_IN", sec: markedInSec, meta: getVideoMeta() });
  setStatus(`IN ${formatTime(markedInSec)}`);
}

function onMarkOut(): void {
  if (markedInSec === null) {
    setStatus("先に IN を指定してください");
    return;
  }
  const endSec = getVideo().currentTime;
  // 範囲の妥当性はここで判定する。状態機械は遷移だけに責任を持つ
  const validation = validateRange(markedInSec, endSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }
  send({ type: "MARK_OUT", sec: endSec });
  setStatus(`${formatTime(markedInSec)} 〜 ${formatTime(endSec)}`);
}

/** 録画品質は再生解像度が上限になるため、低いときは事前に知らせる */
const MIN_RECOMMENDED_HEIGHT = 720;

/**
 * 録画の前半。IN へ seek するが再生はしない。
 * service worker が streamId 取得と offscreen 起動を終えるまで動画を進めないため。
 */
async function prepareRecording(startSec: number): Promise<void> {
  if (isAdPlaying()) {
    send({ type: "FAIL", reason: "ad-playing" });
    setStatus("広告の再生中です。終了後にやり直してください");
    return;
  }

  const video = getVideo();
  // 画質は録画してからでは上げられないので、この時点で警告する (録画は止めない)
  if (video.videoHeight > 0 && video.videoHeight < MIN_RECOMMENDED_HEIGHT) {
    setStatus(
      `再生画質が低いままです (${video.videoHeight}p)。画質を上げると綺麗に切り抜けます`,
    );
  }
  video.pause();
  try {
    await seekTo(video, startSec);
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
    return;
  }

  send({ type: "SEEK_DONE" });
  setStatus("録画の準備をしています…");
}

/**
 * 録画の後半。録画開始後に呼ばれ、再生して OUT 到達で停止する。
 */
async function runRecording(startSec: number, endSec: number): Promise<void> {
  const video = getVideo();
  try {
    await startPlayback(video);
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
    return;
  }

  setStatus(`録画中… (${Math.round(endSec - startSec)}秒)`);

  cancelWatch = onReachTime(video, endSec, () => {
    cancelWatch = null;
    video.pause();
    send({ type: "OUT_REACHED" });
    setStatus("録画を書き出しています…");
  });
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText =
    "display:flex;gap:8px;align-items:center;padding:8px 0;color:var(--yt-spec-text-primary,#fff);font-size:13px;";

  const inButton = document.createElement("button");
  inButton.textContent = "IN";
  inButton.addEventListener("click", onMarkIn);

  const outButton = document.createElement("button");
  outButton.textContent = "OUT";
  outButton.addEventListener("click", onMarkOut);

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.textContent = "IN を押して開始位置を指定";

  bar.append(inButton, outButton, status);
  return bar;
}

function mount(): void {
  if (document.getElementById(BAR_ID) !== null) return;

  const anchor = document.querySelector(YT_SELECTORS.controls);
  if (anchor === null) return; // プレイヤー未生成。次の observe で再試行する

  anchor.parentElement?.insertBefore(buildBar(), anchor.nextSibling);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type !== "state/changed") return;

  const state = message.state;
  if (state.kind === "seeking") {
    void prepareRecording(state.range.startSec);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.range.startSec, state.range.endSec);
    return;
  }
  if (state.kind === "failed" && cancelWatch !== null) {
    cancelWatch();
    cancelWatch = null;
  }
});

// YouTube は SPA 遷移するため DOM 変化を監視して再マウントする
const observer = new MutationObserver(() => mount());
observer.observe(document.body, { childList: true, subtree: true });
mount();
