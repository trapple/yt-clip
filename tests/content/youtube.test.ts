// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { Blob as NodeBlob } from "node:buffer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { reduce } from "@/background/state";
import type { Message } from "@/shared/messages";
import {
  FAILURE_MESSAGES,
  type ClipRange,
  type ClipState,
  type VideoMeta,
} from "@/shared/types";

/**
 * content script のライフサイクル試験。
 *
 * `youtube.ts` は import した時点で listener と MutationObserver を登録する
 * ため、モジュールは 1 度だけ読み込み、状態は毎回 idle へ戻して使い回す。
 * 二重に読み込むと、前のテストの observer が同じ DOM を触りに来る。
 */

const META_A: VideoMeta = { videoId: "video-a", title: "動画 A" };
const RANGE: ClipRange = { startSec: 10, endSec: 20 };

/** content script が service worker へ送ったメッセージ */
let sent: Message[] = [];
/** service worker 役が持つ状態。応答にも state/changed にも同じものを使う */
let swState: ClipState = { kind: "idle" };
/** このメッセージ種別の送信を失敗させる (メッセージ長超過などの再現) */
let rejectMessageType: Message["type"] | null = null;
/** service worker からタブへ届くメッセージを受けるリスナーの形 */
type TabListener = (
  message: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => void;
/** youtube.ts が登録した onMessage リスナー */
let onMessage: TabListener | null = null;

/** MediaRecorder のフェイク。録画が止まったかを実際の状態で確かめる */
type FakeRecorder = {
  state: "inactive" | "recording";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
};
let recorders: FakeRecorder[] = [];
/** captureStream のトラックが解放された回数 */
let stoppedTracks = 0;

type FakeVideo = {
  element: HTMLVideoElement;
  /** pause() が呼ばれた回数 */
  pauseCount: number;
  /** 1 フレーム進めて、登録済みのコールバックへ再生位置を配る */
  advanceFrame(mediaTimeSec: number): void;
  /** 到達待ちの監視が何本残っているか */
  pendingFrames(): number;
};

let video: FakeVideo;

/** 非同期の連鎖 (seek → 再生 → 監視登録) が落ち着くまで待つ */
async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function installVideo(): FakeVideo {
  const element = document.createElement("video");
  element.className = "html5-main-video";

  let currentTime = 0;
  const frames = new Map<
    number,
    (now: number, metadata: { mediaTime: number }) => void
  >();
  let nextHandle = 1;

  const fake: FakeVideo = {
    element,
    pauseCount: 0,
    advanceFrame(mediaTimeSec: number): void {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) {
        callback(0, { mediaTime: mediaTimeSec });
      }
    },
    pendingFrames: () => frames.size,
  };

  Object.defineProperty(element, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
      // 実際の video と同じく、seek の完了は後から通知される
      setTimeout(() => element.dispatchEvent(new Event("seeked")), 0);
    },
  });
  Object.defineProperty(element, "duration", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(element, "videoHeight", {
    configurable: true,
    value: 1080,
  });

  element.pause = (): void => {
    fake.pauseCount += 1;
  };
  element.play = (): Promise<void> => {
    setTimeout(() => element.dispatchEvent(new Event("playing")), 0);
    return Promise.resolve();
  };

  Object.assign(element, {
    requestVideoFrameCallback: (
      callback: (now: number, metadata: { mediaTime: number }) => void,
    ): number => {
      const handle = nextHandle;
      nextHandle += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: (handle: number): void => {
      frames.delete(handle);
    },
    captureStream: () => ({
      getTracks: () => [
        {
          stop: (): void => {
            stoppedTracks += 1;
          },
        },
      ],
    }),
  });

  return fake;
}

function buildPage(): void {
  document.body.innerHTML = "";

  const below = document.createElement("div");
  below.id = "below";

  const title = document.createElement("h1");
  title.className = "ytd-watch-metadata";
  const titleText = document.createElement("yt-formatted-string");
  titleText.textContent = META_A.title;
  title.append(titleText);

  const progressBar = document.createElement("div");
  progressBar.className = "ytp-progress-bar";

  video = installVideo();
  document.body.append(below, title, progressBar, video.element);
}

function installGlobals(): void {
  class FakeMediaRecorder implements FakeRecorder {
    static isTypeSupported(): boolean {
      return true;
    }
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor() {
      recorders.push(this);
    }
    start(): void {
      this.state = "recording";
    }
    stop(): void {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["clip"]) });
      this.onstop?.();
    }
  }

  // jsdom の Blob は arrayBuffer() を持たない。録画結果を base64 に
  // 変換する経路を実際に通すため、Node の Blob に差し替える
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (fn: TabListener): void => {
          onMessage = fn;
        },
      },
      sendMessage: async (message: Message): Promise<{ state: ClipState }> => {
        sent.push(message);
        if (message.type === rejectMessageType) {
          throw new Error("メッセージが大きすぎます");
        }
        // 状態機械は本物を使う。応答の状態が実物と違うと、
        // content script 側の受理判定の意味が変わってしまう
        if (message.type === "clip/event") {
          const next = reduce(swState, message.event);
          // router.apply と同じく、拒まれた遷移では状態を書き換えない。
          // reduce は定義されていない遷移を internal-error の failed で表す
          const rejected =
            message.event.type !== "FAIL" &&
            next.kind === "failed" &&
            next.reason === "internal-error" &&
            !(swState.kind === "failed" && swState.reason === "internal-error");
          if (!rejected) swState = next;
        }

        const response = { state: swState };
        // 実機の応答はコンテキストをまたぐので同期では返らない。
        // ここを同期で返すと、読み込み直後の見た目を観測できなくなる
        await new Promise((resolve) => setTimeout(resolve, 0));
        return response;
      },
    },
  });
}

/**
 * service worker からタブへメッセージを届け、**同期で応答が返ったか**を見る。
 * 応答しないと送り手の Promise は reject し、受け取って処理したことが
 * 「タブが居ない」と区別できなくなる。
 */
function deliver(message: Message): { responded: boolean } {
  const result = { responded: false };
  onMessage?.(message, {}, () => {
    result.responded = true;
  });
  return result;
}

/** service worker から状態変化を届ける */
function emit(state: ClipState): { responded: boolean } {
  swState = state;
  return deliver({ type: "state/changed", state });
}

/** service worker から content script への指示を届ける */
function command(type: "recorder/start" | "recorder/stop"): {
  responded: boolean;
} {
  return deliver({ type });
}

function clickButton(label: string): void {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("#yt-clip-bar button"),
  ].find((candidate) => candidate.textContent === label);
  if (button === undefined) {
    throw new Error(`ボタンが見つかりません: ${label}`);
  }
  button.click();
}

function statusText(): string {
  return document.getElementById("yt-clip-bar-status")?.textContent ?? "";
}

function overlay(): HTMLElement | null {
  return document.getElementById("yt-clip-overlay");
}

/** 拡大バー本体。操作を受け付けるかどうかは pointer-events で決まる */
function rangeBarElement(): HTMLElement {
  const element = document.getElementById("yt-clip-range");
  if (element === null) {
    throw new Error("拡大バーが見つかりません");
  }
  return element;
}

/** ハンドルに付く説明。今どの範囲を見せているかを外から見る手がかり */
function handleLabels(): string[] {
  return [...rangeBarElement().querySelectorAll("[aria-label]")].map(
    (element) => element.getAttribute("aria-label") ?? "",
  );
}

/** 実際に作られた MediaRecorder。無ければ録画が始まっていない */
function startedRecorder(): FakeRecorder {
  const recorder = recorders[0];
  if (recorder === undefined) {
    throw new Error("録画が始まっていません");
  }
  return recorder;
}

function clipEvents(): unknown[] {
  return sent
    .filter((message) => message.type === "clip/event")
    .map((message) => (message as { event: unknown }).event);
}

/** import 直後 (state/changed を 1 通も受け取っていない) の拡大バーの状態 */
let pointerEventsAtLoad = "";
/** 読み込み時に content script が service worker へ送ったもの */
let sentAtLoad: Message[] = [];
/** 読み込み時の問い合わせに応答が返った後の画面 */
let restoredAtLoad = {
  status: "",
  hasOverlay: false,
  pointerEvents: "",
  labels: [] as string[],
};

beforeAll(async () => {
  buildPage();
  installGlobals();
  // 読み込み時点で service worker が範囲を持っている場面を再現する
  // (録画中でないタブのリロード。状態は content script に残っていない)
  swState = { kind: "ready", range: RANGE, meta: META_A };

  // chrome を用意してから読み込む。import 時に listener と observer を張る
  await import("@/content/youtube");
  // **応答が返る前**の状態を捕まえる。実機でも service worker は遷移した
  // ときにしか通知しないので、マウント直後は何も受け取っていない
  pointerEventsAtLoad = rangeBarElement().style.pointerEvents;

  await flush();
  sentAtLoad = [...sent];
  restoredAtLoad = {
    status: statusText(),
    hasOverlay: overlay() !== null,
    pointerEvents: rangeBarElement().style.pointerEvents,
    labels: handleLabels(),
  };
});

beforeEach(async () => {
  history.pushState({}, "", "/watch?v=video-a");
  buildPage();
  sent = [];
  recorders = [];
  stoppedTracks = 0;
  rejectMessageType = null;

  // DOM を作り直したので、observer に拾わせて操作 UI を載せ直す
  document.body.append(document.createElement("div"));
  await flush();
  // 前のテストの範囲・録画・監視をすべて捨てさせる
  emit({ kind: "idle" });
  await flush();
  sent = [];
});

afterAll(async () => {
  // youtube.ts の MutationObserver は解除できない。保留中の DOM 変化が
  // jsdom の破棄後に配られると location を参照できず、テストとは無関係な
  // 例外が出力に混ざる。ここで出し切ってから終わらせる
  document.body.innerHTML = "";
  await flush();
});

describe("範囲再生の監視", () => {
  test("範囲を変えた後は、前の範囲の監視で録画が止まらない", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });

    // 範囲を再生する。OUT (20 秒) の到達待ちが 1 本張られる
    clickButton("範囲を再生");
    await flush();
    expect(video.pendingFrames()).toBe(1);

    // OUT に達する前に、OUT を 30 秒へ伸ばす
    video.element.currentTime = 30;
    clickButton("OUT");
    await flush();
    expect(swState).toMatchObject({
      kind: "ready",
      range: { startSec: 10, endSec: 30 },
    });
    // 旧 OUT を見ている監視は残っていない
    expect(video.pendingFrames()).toBe(0);

    const recording: ClipRange = { startSec: 10, endSec: 30 };
    emit({ kind: "seeking", range: recording, meta: META_A });
    await flush();
    emit({ kind: "recording", range: recording, meta: META_A });
    await flush();

    const pausesBefore = video.pauseCount;
    // 旧 OUT を通過しても再生は止まらない
    video.advanceFrame(20.5);
    expect(video.pauseCount).toBe(pausesBefore);
    expect(clipEvents()).not.toContainEqual({ type: "OUT_REACHED" });

    // 新しい OUT で止まり、録画の終了が伝わる
    video.advanceFrame(30.1);
    expect(video.pauseCount).toBe(pausesBefore + 1);
    expect(clipEvents()).toContainEqual({ type: "OUT_REACHED" });
  });

  test("録画に入ると範囲再生の監視は解除される", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    clickButton("範囲を再生");
    await flush();
    expect(video.pendingFrames()).toBe(1);

    emit({ kind: "seeking", range: RANGE, meta: META_A });
    await flush();

    expect(video.pendingFrames()).toBe(0);
    // 録画の準備自体は進んでいる
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });
  });
});

describe("動画の入れ替わり", () => {
  test("範囲を作った動画と違う動画では録画に入らない", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    expect(overlay()).not.toBeNull();

    // 関連動画へ SPA 遷移してから popup で録画を始めた場合
    history.pushState({}, "", "/watch?v=video-b");
    emit({ kind: "seeking", range: RANGE, meta: META_A });
    await flush();

    expect(clipEvents()).toContainEqual({
      type: "FAIL",
      reason: "video-changed",
    });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
    // 状態機械が返す文言と同じもの。言い回しが割れると、直後に届く
    // state/changed で表示が言い換わって見える
    expect(statusText()).toBe(FAILURE_MESSAGES["video-changed"]);
    // 旧動画の範囲を示す帯も残さない
    expect(overlay()).toBeNull();
  });

  test("別の動画へ移ると帯が消え、拡大バーも操作できなくなる", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    expect(overlay()).not.toBeNull();
    expect(rangeBarElement().style.pointerEvents).not.toBe("none");

    history.pushState({}, "", "/watch?v=video-b");
    // SPA 遷移に伴う DOM 変化で気付かせる
    document.body.append(document.createElement("div"));
    await flush();

    expect(overlay()).toBeNull();
    expect(rangeBarElement().style.pointerEvents).toBe("none");
  });
});

describe("録画の後始末", () => {
  test("失敗に落ちたら録画を止めてストリームを解放する", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    emit({ kind: "recording", range: RANGE, meta: META_A });
    command("recorder/start");
    await flush();

    expect(recorders).toHaveLength(1);
    const recorder = startedRecorder();
    expect(recorder.state).toBe("recording");
    expect(sent).toContainEqual({ type: "recorder/started" });

    // 再生できなかった等で失敗した。OUT には永久に到達しない
    emit({
      kind: "failed",
      reason: "playback-failed",
      range: RANGE,
      meta: META_A,
    });
    await flush();

    expect(recorder.state).toBe("inactive");
    expect(stoppedTracks).toBe(1);

    // 破棄済みなので、後から停止を指示されても古い録画は返らない
    command("recorder/stop");
    await flush();
    expect(sent).toContainEqual({
      type: "recorder/failed",
      reason: "録画が開始されていません",
    });
    expect(sent.some((message) => message.type === "recorder/done")).toBe(false);
  });

  test("実機の順序 (seeking 中に録画開始が届く) で録画が生き残る", async () => {
    // service worker は seeking の state/changed を送った後、SEEK_DONE を
    // 受けて recorder/start を送り、録画開始の通知を受けてから recording へ
    // 進める。この順序で「録画から離れた状態」の後始末が誤爆しないこと
    emit({ kind: "ready", range: RANGE, meta: META_A });
    emit({ kind: "seeking", range: RANGE, meta: META_A });
    await flush();
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });

    command("recorder/start");
    await flush();
    expect(startedRecorder().state).toBe("recording");

    emit({ kind: "recording", range: RANGE, meta: META_A });
    await flush();
    // recording への遷移で録画を捨てていないこと
    expect(startedRecorder().state).toBe("recording");

    // OUT に到達 → 書き出し → 結果の送信まで通す
    video.advanceFrame(20.1);
    expect(clipEvents()).toContainEqual({ type: "OUT_REACHED" });
    emit({ kind: "encoding", range: RANGE, meta: META_A });
    command("recorder/stop");
    await flush();

    expect(sent.some((message) => message.type === "recorder/done")).toBe(true);
  });

  test("録画結果を送れなかったら失敗として知らせる", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    emit({ kind: "recording", range: RANGE, meta: META_A });
    command("recorder/start");
    await flush();

    emit({ kind: "encoding", range: RANGE, meta: META_A });
    // 60 秒 1080p の base64 がメッセージ長を超える場合を再現する
    rejectMessageType = "recorder/done";
    command("recorder/stop");
    await flush();

    expect(statusText()).toContain("拡張への送信に失敗しました");
    expect(clipEvents()).toContainEqual({
      type: "FAIL",
      reason: "recording-aborted",
    });
  });
});

describe("読み込み時の復帰", () => {
  test("読み込まれたことを service worker へ知らせる", () => {
    // 録画中にタブをリロードすると tabs.onRemoved は発火せず、OUT を監視して
    // いた content script だけが消える。録画対象のタブだったかは tabId を持つ
    // service worker にしか判定できないので、こちらは知らせるだけにする
    expect(sentAtLoad).toContainEqual({ type: "content/loaded" });
  });

  test("応答に載ってきた範囲で画面を復元する", () => {
    // service worker は遷移したときにしか通知しないため、読み込み直した
    // content script は問い合わせない限り状態を 1 度も受け取れない
    expect(restoredAtLoad.status).toBe("0:10 〜 0:20 (10秒)");
    expect(restoredAtLoad.hasOverlay).toBe(true);
    expect(restoredAtLoad.labels).toEqual(["開始 0:10", "終了 0:20"]);
    // ready なので操作もできる
    expect(restoredAtLoad.pointerEvents).not.toBe("none");
  });
});

describe("service worker への応答", () => {
  test("扱うメッセージには必ず同期で応答する", () => {
    // 応答しないと送り手の Promise は "The message port closed..." で reject し、
    // **受け取って処理したこと**が「タブが居ない」と区別できなくなる。
    // 非同期に応答する (return true) のも不可 — 送り手は直列 queue の中で待つ
    expect(emit({ kind: "idle" }).responded).toBe(true);
    expect(command("recorder/start").responded).toBe(true);
    expect(command("recorder/stop").responded).toBe(true);
  });
});

describe("拡大バーを操作できる状態", () => {
  test("読み込み直後 (状態を 1 度も受け取っていない) は操作させない", () => {
    // 実機では service worker は遷移したときにしか通知しない。
    // マウントした時点のバーが掴めてしまうと、範囲が無いまま操作できる
    expect(pointerEventsAtLoad).toBe("none");
  });

  test("範囲が確定するまでは操作させない", () => {
    // idle のまま。IN を押していないので範囲が無い
    expect(rangeBarElement().style.pointerEvents).toBe("none");
  });

  test("録画済みでポスト待ちの間は操作させない", () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    expect(rangeBarElement().style.pointerEvents).not.toBe("none");

    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      range: RANGE,
      meta: META_A,
    });
    // service worker は preview での範囲変更を拒む。画面もそれに合わせる
    expect(rangeBarElement().style.pointerEvents).toBe("none");
  });

  test("受け付けられなかった範囲変更は、画面を状態機械側へ戻す", async () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      range: RANGE,
      meta: META_A,
    });

    // ハンドルのドラッグは塞いだが、OUT ボタンは preview でも押せる
    video.element.currentTime = 50;
    clickButton("OUT");
    await flush();

    // service worker は preview の範囲変更を拒むので状態は変わらない。
    // 拒まれたことは state/changed では飛んでこないため、応答でしか分からない
    expect(swState.kind).toBe("preview");
    expect(statusText()).toContain("受け付けられませんでした");
    // 送っていない範囲 (0:50) ではなく、状態機械が持つ範囲に戻る
    expect(handleLabels()).toEqual(["開始 0:10", "終了 0:20"]);
  });
});
