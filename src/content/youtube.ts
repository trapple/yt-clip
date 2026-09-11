import { pickMimeType } from "@/content/codec";
import {
  getVideo,
  getVideoMeta,
  isAdPlaying,
  onReachTime,
  seekTo,
  startPlayback,
} from "@/content/player";
import { createRangeBar, type RangeBar } from "@/content/range-bar";
import { makeDefaultRange } from "@/content/range-math";
import {
  DrmProtectedError,
  assertRecordable,
  startRecording,
  type RecorderHandle,
} from "@/content/recorder";
import { YT_SELECTORS } from "@/content/selectors";
import { encodeBase64 } from "@/shared/base64";
import type { Message } from "@/shared/messages";
import { formatTime, validateRange } from "@/shared/time";
// BUSY_KINDS は状態の性質なので types.ts で共有している
import { BUSY_KINDS, type ClipEvent, type ClipRange } from "@/shared/types";

const BAR_ID = "yt-clip-bar";
const OVERLAY_ID = "yt-clip-overlay";

/** いま指定されている範囲。service worker と同じものを持つ */
let currentRange: ClipRange | null = null;
/** 範囲を作ったときの動画。SPA で動画が変わったら無効になる */
let rangeVideoId: string | null = null;
let busy = false;
let cancelWatch: (() => void) | null = null;
let cancelPreview: (() => void) | null = null;
let rangeBar: RangeBar | null = null;
let handle: RecorderHandle | null = null;

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

/** 範囲を人が読める形にする。同じ文言を 3 箇所で使うのでここに集める */
function rangeLabel(range: ClipRange): string {
  const durationSec = Math.round(range.endSec - range.startSec);
  return `${formatTime(range.startSec)} 〜 ${formatTime(range.endSec)} (${durationSec}秒)`;
}

function applyRange(range: ClipRange, videoDurationSec: number): void {
  currentRange = range;
  rangeBar?.update(range, videoDurationSec);
  paintOverlay(range, videoDurationSec);
  setStatus(rangeLabel(range));
}

function onMarkIn(): void {
  // 録画中に打ち直されると状態機械だけが範囲を作り直し、録画は走り続けて
  // 取り残される。状態機械と router にも同じガードがあるが、ここで止めれば
  // ユーザーに理由をすぐ返せる
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }

  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの範囲をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration);

  rangeVideoId = meta.videoId;
  applyRange(range, video.duration);
  send({ type: "MARK_IN", range, meta });
}

function onMarkOut(): void {
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  if (currentRange === null) {
    setStatus("先に IN を指定してください");
    return;
  }

  // IN を打った後に別の動画へ移動していた場合、その範囲はもう意味を持たない。
  // ここで RESET_MARKS を送ってはいけない。録画済みで投稿待ちのときに届くと
  // 状態機械が不正遷移として failed に落ち、クリップへの参照ごと失う
  if (getVideoMeta().videoId !== rangeVideoId) {
    currentRange = null;
    rangeVideoId = null;
    setStatus("動画が変わりました。IN からやり直してください");
    return;
  }

  const video = getVideo();
  const next = { startSec: currentRange.startSec, endSec: video.currentTime };
  const validation = validateRange(next.startSec, next.endSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }

  applyRange(next, video.duration);
  send({ type: "MARK_OUT", sec: next.endSec });
}

/** 拡大バーでのドラッグが確定したとき */
function onRangeCommitted(range: ClipRange): void {
  if (busy) return;
  currentRange = range;
  paintOverlay(range, getVideo().duration);
  setStatus(rangeLabel(range));
  send({ type: "ADJUST_RANGE", range });
}

/** ドラッグ中の追従。動かしている側の位置を見せる */
function onScrub(sec: number): void {
  const video = getVideo();
  video.pause();
  video.currentTime = sec;
}

/** YouTube のシークバーに範囲を帯で重ねて、動画全体のどこかを示す */
function paintOverlay(range: ClipRange, videoDurationSec: number): void {
  const bar = document.querySelector<HTMLElement>(YT_SELECTORS.progressBar);
  if (bar === null || videoDurationSec <= 0) return;

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay === null) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position:absolute;top:0;bottom:0;background:#3ea6ff;opacity:0.5;pointer-events:none;z-index:1;";
    bar.appendChild(overlay);
  }

  overlay.style.left = `${(range.startSec / videoDurationSec) * 100}%`;
  overlay.style.width = `${((range.endSec - range.startSec) / videoDurationSec) * 100}%`;
}

/** 指定した範囲を通しで再生して内容を確認する */
async function playRange(): Promise<void> {
  if (currentRange === null || busy) return;

  cancelPreview?.();
  cancelPreview = null;

  const video = getVideo();
  const range = currentRange;
  try {
    await seekTo(video, range.startSec);
    await startPlayback(video);
  } catch (error) {
    setStatus(`範囲を再生できませんでした: ${String(error)}`);
    return;
  }

  setStatus(`範囲を再生中… (${Math.round(range.endSec - range.startSec)}秒)`);
  cancelPreview = onReachTime(video, range.endSec, () => {
    cancelPreview = null;
    video.pause();
    setStatus(rangeLabel(range));
  });
}

/**
 * 録画の前半。IN へ seek するが再生はしない。
 * service worker が録画開始を指示し、それを受けた録画が実際に始まるまで
 * 動画を進めないため。
 */
async function prepareRecording(startSec: number): Promise<void> {
  try {
    // 保護された動画は captureStream が黒画面を返すだけで失敗しない。
    // 実時間を払い切ってから無駄と分かることのないよう、ここで弾く
    assertRecordable(getVideo());

    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus("広告の再生中です。終了後にやり直してください");
      return;
    }

    const video = getVideo();
    video.pause();
    await seekTo(video, startSec);

    send({ type: "SEEK_DONE" });
    setStatus("録画の準備をしています…");
  } catch (error) {
    if (error instanceof DrmProtectedError) {
      send({ type: "FAIL", reason: "drm-protected" });
      setStatus(error.message);
      return;
    }
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
  }
}

/** service worker からの指示で録画を始める */
async function beginRecording(): Promise<void> {
  try {
    const video = getVideo();
    const { mimeType } = pickMimeType();
    handle = await startRecording(video, mimeType, {
      onUnexpectedStop: (error) => {
        handle = null;
        notify({ type: "recorder/failed", reason: error.message });
      },
    });
    notify({ type: "recorder/started" });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

/** 録画の後半。録画開始後に呼ばれ、再生して OUT 到達で停止する */
async function runRecording(startSec: number, endSec: number): Promise<void> {
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

/** 録画を止めて結果を送る。拡張の IndexedDB は content script から触れない */
async function finishRecording(): Promise<void> {
  if (handle === null) {
    notify({ type: "recorder/failed", reason: "録画が開始されていません" });
    return;
  }

  const stopping = handle;
  handle = null;
  try {
    const blob = await stopping.stop();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    notify({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
}

function notify(message: Message): void {
  void chrome.runtime.sendMessage(message);
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText =
    "display:flex;flex-direction:column;gap:4px;padding:8px 0;color:var(--yt-spec-text-primary,#fff);font-size:13px;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;align-items:center;";

  const inButton = document.createElement("button");
  inButton.textContent = "IN";
  inButton.addEventListener("click", guard(onMarkIn));

  const outButton = document.createElement("button");
  outButton.textContent = "OUT";
  outButton.addEventListener("click", guard(onMarkOut));

  const playButton = document.createElement("button");
  playButton.textContent = "範囲を再生";
  playButton.addEventListener("click", guard(() => void playRange()));

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.textContent = "IN を押して開始位置を指定";

  row.append(inButton, outButton, playButton, status);

  rangeBar = createRangeBar({ onScrub, onCommit: onRangeCommitted });
  bar.append(row, rangeBar.element);
  return bar;
}

function mount(): void {
  if (document.getElementById(BAR_ID) !== null) return;

  const anchor = document.querySelector(YT_SELECTORS.controls);
  if (anchor === null) return; // プレイヤー未生成。次の observe で再試行する

  anchor.parentElement?.insertBefore(buildBar(), anchor.nextSibling);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "recorder/start") {
    void beginRecording();
    return;
  }
  if (message.type === "recorder/stop") {
    void finishRecording();
    return;
  }
  if (message.type !== "state/changed") return;

  const state = message.state;
  busy = BUSY_KINDS.has(state.kind);
  rangeBar?.setEnabled(!busy);

  // 無効化しただけでは、打ち切られたドラッグの見た目が最後の位置に残る。
  // 確定していない範囲が表示され続けないよう、確定済みの範囲で描き直す
  if (busy && currentRange !== null) {
    rangeBar?.update(currentRange, getVideo().duration);
  }

  if (state.kind === "seeking") {
    void prepareRecording(state.range.startSec);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.range.startSec, state.range.endSec);
    return;
  }
  if (state.kind === "failed") {
    cancelWatch?.();
    cancelWatch = null;
  }
});

// YouTube は SPA 遷移するため DOM 変化を監視して再マウントする
const observer = new MutationObserver(() => mount());
observer.observe(document.body, { childList: true, subtree: true });
mount();
