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

/**
 * IN を打った位置と、そのときの動画 ID。
 * YouTube は SPA でページ遷移せずに動画が入れ替わるため、位置だけを覚えていると
 * 別の動画で OUT を打ったときに違う動画同士の範囲が組み上がってしまう。
 */
let markedIn: { sec: number; videoId: string } | null = null;
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

/**
 * クリック操作を包んで、失敗をユーザーに見える形にする。
 * 要素が見つからない・再生位置が不正といった失敗を console に流すだけでは、
 * ボタンが無反応になった理由がユーザーに伝わらない。
 */
function guard(action: () => void): () => void {
  return () => {
    try {
      action();
    } catch (error) {
      setStatus(`操作できませんでした: ${String(error)}`);
    }
  };
}

function onMarkIn(): void {
  const video = getVideo();
  const meta = getVideoMeta();
  markedIn = { sec: video.currentTime, videoId: meta.videoId };
  send({ type: "MARK_IN", sec: markedIn.sec, meta });
  setStatus(`IN ${formatTime(markedIn.sec)}`);
}

function onMarkOut(): void {
  if (markedIn === null) {
    setStatus("先に IN を指定してください");
    return;
  }

  // IN を打った後に別の動画へ移動していた場合、その範囲はもう意味を持たない。
  // ここで RESET_MARKS を送ってはいけない。録画済みで投稿待ち (preview / composing) の
  // ときに届くと状態機械が不正遷移として failed に落ち、録画したクリップへの参照ごと失う。
  // MARK_IN はどの状態からでも受理されるので、次に IN を打てば正しく上書きされる。
  if (getVideoMeta().videoId !== markedIn.videoId) {
    markedIn = null;
    setStatus("動画が変わりました。IN からやり直してください");
    return;
  }

  const endSec = getVideo().currentTime;
  // 範囲の妥当性はここで判定する。状態機械は遷移だけに責任を持つ
  const validation = validateRange(markedIn.sec, endSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }
  send({ type: "MARK_OUT", sec: endSec });
  setStatus(`${formatTime(markedIn.sec)} 〜 ${formatTime(endSec)}`);
}

/** 録画品質は再生解像度が上限になるため、低いときは事前に知らせる */
const MIN_RECOMMENDED_HEIGHT = 720;

/**
 * 録画の前半。IN へ seek するが再生はしない。
 * service worker が streamId 取得と offscreen 起動を終えるまで動画を進めないため。
 */
async function prepareRecording(startSec: number): Promise<void> {
  // 状態変化から呼ばれるため click の guard が効かない。ここで自分で包む。
  // 握り潰すと sw は seeking のまま固まり、ユーザーには準備中の表示が残り続ける。
  try {
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
    await seekTo(video, startSec);

    send({ type: "SEEK_DONE" });
    setStatus("録画の準備をしています…");
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
  }
}

/**
 * 録画の後半。録画開始後に呼ばれ、再生して OUT 到達で停止する。
 */
async function runRecording(startSec: number, endSec: number): Promise<void> {
  // prepareRecording と同じ理由で、この関数も自分で例外を拾う
  try {
    const video = getVideo();
    await startPlayback(video);

    setStatus(`録画中… (${Math.round(endSec - startSec)}秒)`);

    cancelWatch = onReachTime(video, endSec, () => {
      cancelWatch = null;
      video.pause();
      send({ type: "OUT_REACHED" });
      setStatus("録画を書き出しています…");
    });
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText =
    "display:flex;gap:8px;align-items:center;padding:8px 0;color:var(--yt-spec-text-primary,#fff);font-size:13px;";

  const inButton = document.createElement("button");
  inButton.textContent = "IN";
  inButton.addEventListener("click", guard(onMarkIn));

  const outButton = document.createElement("button");
  outButton.textContent = "OUT";
  outButton.addEventListener("click", guard(onMarkOut));

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
