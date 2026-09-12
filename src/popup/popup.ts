// popup は状態を映すだけ。操作はページ内バーが持つ
import { describeState } from "@/popup/view";
import type { Message, MessageResponse } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

const messageElement = document.getElementById("message") as HTMLElement;
const progressArea = document.getElementById("progress-area") as HTMLElement;
const progressElement = document.getElementById(
  "progress",
) as HTMLProgressElement;
const remainElement = document.getElementById("remain") as HTMLElement;

/** 残り時間を数えるタイマー。render の呼び出しごとに stopCountdown で必ず止めてから張り直す */
let countdownTimer: number | null = null;

/** 失敗を画面に出す。popup は操作を持たないので、伝えるだけでよい */
function showError(error: unknown): void {
  messageElement.textContent = `状態を取得できませんでした: ${String(error)}`;
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
function render(state: ClipState): void {
  const view = describeState(state);
  messageElement.textContent = view.message;

  if (view.recordingSec !== null) {
    startCountdown(view.recordingSec);
  } else {
    stopCountdown();
  }
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    render(message.state);
  }
});

chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => render(response.state))
  .catch(showError);
