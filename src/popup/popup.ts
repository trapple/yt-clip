// popup は状態を映す。持つ操作はオン / オフのスイッチだけ (マスタースイッチの spec §6.1)。
// ほかの操作はページ内バーが持つ。オンに戻す操作はページに何も無いときに要るので、ページの外 (ここ) にしか置けない
import { describeState, describeSwitch } from "@/popup/view";
import { loadEnabled, saveEnabled, watchEnabled } from "@/shared/master-switch";
import type { Message, MessageResponse } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

const switchInput = document.getElementById("enabled") as HTMLInputElement;
const switchError = document.getElementById("switch-error") as HTMLElement;
const messageElement = document.getElementById("message") as HTMLElement;
const noteElement = document.getElementById("note") as HTMLElement;
const progressArea = document.getElementById("progress-area") as HTMLElement;
const progressElement = document.getElementById(
  "progress",
) as HTMLProgressElement;
const remainElement = document.getElementById("remain") as HTMLElement;

/** 保存されているオン / オフ。読むまでは null (スイッチは HTML の既定 = オンのまま) */
let enabled: boolean | null = null;
/** service worker から最後に届いた状態。取れていなければ null */
let state: ClipState | null = null;
/** 状態を取得できなかった理由。取れたら null */
let stateError: string | null = null;

/** 残り時間を数えるタイマー。render の呼び出しごとに stopCountdown で必ず止めてから張り直す */
let countdownTimer: number | null = null;

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
 * スイッチと状態を描く。オン / オフと状態のどちらが変わっても呼ぶ。
 * **スイッチは service worker が居なくても出す** (状態を取得できなかったときも。壊れたときに止められる、がスイッチの価値)
 */
function render(): void {
  if (enabled === null) return;
  const view = describeSwitch(enabled, state);
  switchInput.checked = view.checked;
  noteElement.textContent = view.note ?? "";
  noteElement.hidden = view.note === null;

  if (!view.showState) {
    stopCountdown();
    messageElement.textContent = view.hint;
    return;
  }
  if (state === null) {
    stopCountdown();
    messageElement.textContent =
      stateError === null ? "" : `状態を取得できませんでした: ${stateError}`;
    return;
  }
  const stateView = describeState(state);
  messageElement.textContent = stateView.message;
  if (stateView.recordingSec !== null) {
    startCountdown(stateView.recordingSec);
  } else {
    stopCountdown();
  }
}

// 押した瞬間に書く。**表示の確定は onChanged で行う** (自分の書き込みでも来る。DevTools や別の popup で変えたときも
// 同じ経路で追従する)。書けなかったら理由を出し、チェックを保存されている値に戻す (書けたつもりにしない)
switchInput.addEventListener("change", () => {
  const next = switchInput.checked;
  switchError.hidden = true;
  void saveEnabled(next).catch((error: unknown) => {
    switchError.textContent = `切り替えを保存できませんでした: ${String(error)}`;
    switchError.hidden = false;
    switchInput.checked = enabled ?? true;
  });
});

watchEnabled((value) => {
  enabled = value;
  switchError.hidden = true;
  render();
});

// loadEnabled は reject しない (読めなければオン)。読みより先に onChanged が来ていたら、そちらが新しい
void loadEnabled().then((value) => {
  if (enabled === null) enabled = value;
  render();
});

// 状態はオフの間も取り続ける (待っている間の文言とクリップが残る旨に要る)
chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    state = message.state;
    stateError = null;
    render();
  }
});

chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => {
    state = response.state;
    stateError = null;
    render();
  })
  .catch((error: unknown) => {
    stateError = String(error);
    render();
  });
