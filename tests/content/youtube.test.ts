// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { Blob as NodeBlob } from "node:buffer";
import { CHANNEL, makeVideoMeta } from "../helpers/fixtures";
import { buildFragmentedMp4 } from "../helpers/fragmented-mp4";
import { decodeBase64 } from "@/shared/base64";

/** 録画結果として流す、最小限の断片化 MP4 */
const RECORDED_BYTES = buildFragmentedMp4({
  fragments: [[{ data: new Uint8Array([1, 2, 3]), duration: 3000, sync: true }]],
});
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
} from "@/shared/types";

/**
 * content script のライフサイクル試験。
 *
 * `youtube.ts` は import した時点で listener と MutationObserver を登録する
 * ため、モジュールは 1 度だけ読み込み、状態は毎回 idle へ戻して使い回す。
 * 二重に読み込むと、前のテストの observer が同じ DOM を触りに来る。
 */

const META_A = makeVideoMeta({ videoId: "video-a", title: "動画 A" });
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
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
  /** 呼ばれた順。区間の繋ぎ方を順序ごと確かめる */
  calls: string[];
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
    // 実物の MediaStream と同じ 3 つのメソッドを備える。ここを欠くと
    // buildRecordingStream が音声の有無を見た時点で落ちる。
    // 音声の取り回し (ステレオへの変換) は recorder.test.ts で見るので、
    // ここでは映像だけのストリームにして寿命の検証に絞る
    captureStream: () => {
      const track = {
        kind: "video",
        stop: (): void => {
          stoppedTracks += 1;
        },
      };
      return {
        getTracks: () => [track],
        getVideoTracks: () => [track],
        getAudioTracks: () => [],
      };
    },
  });

  return fake;
}

/** 最初の tkhd の変換行列の 9 要素目を読む。0x40000000 でないと X が弾く */
function readVideoMatrixW(data: Uint8Array): number {
  for (let i = 0; i + 8 < data.length; i += 1) {
    if (
      data[i] === 0x74 &&
      data[i + 1] === 0x6b &&
      data[i + 2] === 0x68 &&
      data[i + 3] === 0x64
    ) {
      const body = i + 4;
      const version = data[body];
      const matrixAt = body + (version === 1 ? 4 + 32 + 16 : 4 + 20 + 16);
      return new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getUint32(matrixAt + 32);
    }
  }
  throw new Error("tkhd が見つかりません");
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

  // チャンネル。実機の watch ページと同じく、構造化データにハンドルが入る
  const author = document.createElement("span");
  author.setAttribute("itemprop", "author");
  const authorUrl = document.createElement("link");
  authorUrl.setAttribute("itemprop", "url");
  authorUrl.setAttribute("href", `/${META_A.channelId}`);
  const authorName = document.createElement("link");
  authorName.setAttribute("itemprop", "name");
  authorName.setAttribute("content", CHANNEL.name);
  author.append(authorUrl, authorName);

  const progressBar = document.createElement("div");
  progressBar.className = "ytp-progress-bar";

  // 広告の判定は #movie_player の ad-showing を見る (player.ts の isAdPlaying)
  const player = document.createElement("div");
  player.id = "movie_player";

  video = installVideo();
  document.body.append(
    below,
    title,
    author,
    progressBar,
    player,
    video.element,
  );
}

type StorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

/** chrome.storage.sync が返す設定。テストごとに差し替える */
let storedSettings: Record<string, unknown> = {};
let storageListener: StorageListener | null = null;

/** 別のタブで設定が変わったことを届ける */
function changeSettings(next: Record<string, unknown>): void {
  storedSettings = next;
  storageListener?.({ settings: { newValue: next } }, "sync");
}

function installGlobals(): void {
  class FakeMediaRecorder implements FakeRecorder {
    static isTypeSupported(): boolean {
      return true;
    }
    state: "inactive" | "recording" | "paused" = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onstop: (() => void) | null = null;
    readonly calls: string[] = [];

    constructor() {
      recorders.push(this);
    }
    start(): void {
      this.state = "recording";
      this.calls.push("start");
    }
    pause(): void {
      this.state = "paused";
      this.calls.push("pause");
    }
    resume(): void {
      this.state = "recording";
      this.calls.push("resume");
    }
    stop(): void {
      this.state = "inactive";
      this.calls.push("stop");
      // 表示行列を直す経路を実際に通すため、MediaRecorder が出すものと
      // 同じ断片化 MP4 を流す。中身が MP4 でないと box の走査で弾かれる
      this.ondataavailable?.({ data: new Blob([RECORDED_BYTES]) });
      this.onstop?.();
    }
  }

  // jsdom の Blob は arrayBuffer() を持たない。録画結果を base64 に
  // 変換する経路を実際に通すため、Node の Blob に差し替える
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: (): Promise<Record<string, unknown>> =>
          Promise.resolve({ settings: storedSettings }),
        set: (): Promise<void> => Promise.resolve(),
      },
      // 別のタブで設定を変えられたときに拾う経路
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListener = fn;
        },
      },
    },
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
  swState = { kind: "ready", segments: [RANGE], meta: META_A };

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

/**
 * ダウンロードされたファイル名。**常に空でなければならない。**
 * 自動ダウンロードは廃止した (`.claude/specs/2026-09-12-drop-auto-save-design.md`)
 */
let saved: string[] = [];

beforeEach(async () => {
  history.pushState({}, "", "/watch?v=video-a");
  buildPage();
  sent = [];
  recorders = [];
  stoppedTracks = 0;
  rejectMessageType = null;
  saved = [];
  storedSettings = {};

  // jsdom は Blob の URL を作れない。ダウンロードの経路が**残っていた場合に**
  // 途中で落ちずに最後まで進み、click まで観測できるようにする
  URL.createObjectURL = (): string => "blob:fake";
  URL.revokeObjectURL = (): void => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });

  // DOM を作り直したので、observer に拾わせて操作 UI を載せ直す
  document.body.append(document.createElement("div"));
  await flush();
  // モードも既定へ戻す。edit のまま次のテストに入るとバーの見た目が変わる
  changeSettings({});
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
    emit({ kind: "ready", segments: [RANGE], meta: META_A });

    // 範囲を再生する。OUT (20 秒) の到達待ちが 1 本張られる
    clickButton("▶ 範囲を見る");
    await flush();
    expect(video.pendingFrames()).toBe(1);

    // OUT に達する前に、OUT を 30 秒へ伸ばす
    video.element.currentTime = 30;
    clickButton("OUT");
    await flush();
    expect(swState).toMatchObject({
      kind: "ready",
      segments: [{ startSec: 10, endSec: 30 }],
    });
    // 旧 OUT を見ている監視は残っていない
    expect(video.pendingFrames()).toBe(0);

    const recording: ClipRange = { startSec: 10, endSec: 30 };
    emit({ kind: "seeking", segments: [recording], meta: META_A });
    await flush();
    emit({ kind: "recording", segments: [recording], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    clickButton("▶ 範囲を見る");
    await flush();
    expect(video.pendingFrames()).toBe(1);

    emit({ kind: "seeking", segments: [RANGE], meta: META_A });
    await flush();

    expect(video.pendingFrames()).toBe(0);
    // 録画の準備自体は進んでいる
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });
  });
});

describe("動画の入れ替わり", () => {
  test("範囲を作った動画と違う動画では録画に入らない", async () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    expect(overlay()).not.toBeNull();

    // 関連動画へ SPA 遷移してから popup で録画を始めた場合
    history.pushState({}, "", "/watch?v=video-b");
    emit({ kind: "seeking", segments: [RANGE], meta: META_A });
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

  test("別の動画のタブでは、状態機械の範囲を取り込まない", async () => {
    // 動画 B のタブが読み込み時に問い合わせると、動画 A の範囲を持つ状態が
    // 返ってくる。取り込むと、B のステータス行に A の範囲が出るうえ、
    // 「範囲を再生」で B を A の開始位置へ飛ばしてしまう
    history.pushState({}, "", "/watch?v=video-b");
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();

    expect(statusText()).not.toContain("0:10");
    expect(rangeBarElement().style.pointerEvents).toBe("none");
    expect(overlay()).toBeNull();

    // 「範囲を再生」を押しても、この動画は動かない
    const beforeSec = video.element.currentTime;
    clickButton("▶ 範囲を見る");
    await flush();

    expect(video.element.currentTime).toBe(beforeSec);
    expect(video.pendingFrames()).toBe(0);
  });

  test("別の動画へ移ると帯が消え、拡大バーも操作できなくなる", async () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
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
      segments: [RANGE],
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
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({ kind: "seeking", segments: [RANGE], meta: META_A });
    await flush();
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });

    command("recorder/start");
    await flush();
    expect(startedRecorder().state).toBe("recording");

    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    await flush();
    // recording への遷移で録画を捨てていないこと
    expect(startedRecorder().state).toBe("recording");

    // OUT に到達 → 書き出し → 結果の送信まで通す
    video.advanceFrame(20.1);
    expect(clipEvents()).toContainEqual({ type: "OUT_REACHED" });
    emit({ kind: "encoding", segments: [RANGE], meta: META_A });
    command("recorder/stop");
    await flush();

    expect(sent.some((message) => message.type === "recorder/done")).toBe(true);

    // **ディスクに書かないこと。** 録画が成功した経路でこそ確かめる価値がある。
    // 自動ダウンロードはウェブストアへ出すために廃止したので、うっかり
    // 戻ってきたらここで気付けるようにしておく
    expect(saved).toEqual([]);

    // **送る前に表示行列を直していること。** ここが外れても他のテストは
    // 全部通ってしまう (実際に外して確認した)。#6 はこの branch でいちばん
    // 診断が困難だった不具合なので、配線そのものを固定する
    const done = sent.find((message) => message.type === "recorder/done");
    const delivered = decodeBase64(
      (done as { base64: string }).base64,
    );
    expect(readVideoMatrixW(delivered)).toBe(0x40000000);
  });

  test("録画結果を送れなかったら失敗として知らせる", async () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    command("recorder/start");
    await flush();

    emit({ kind: "encoding", segments: [RANGE], meta: META_A });
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

describe("失敗の提示", () => {
  test("失敗の理由はバーにも出す", () => {
    // 録画中にタブをリロードした場合、popup を開かない限り何が起きたのか
    // 分からない。文言は popup と同じものを使う
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({
      kind: "failed",
      reason: "recording-aborted",
      segments: [RANGE],
      meta: META_A,
    });

    expect(statusText()).toBe(FAILURE_MESSAGES["recording-aborted"]);
    // 失敗した範囲はもう操作できない。画面からも消す
    expect(overlay()).toBeNull();
    expect(rangeBarElement().style.pointerEvents).toBe("none");
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
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    expect(rangeBarElement().style.pointerEvents).not.toBe("none");

    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      meta: META_A,
    });
    // service worker は preview での範囲変更を拒む。画面もそれに合わせる
    expect(rangeBarElement().style.pointerEvents).toBe("none");
  });

  test("受け付けられなかった範囲変更は、画面を状態機械側へ戻す", async () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
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

describe("状態ごとの操作", () => {
  const labels = (): string[] =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#yt-clip-bar-actions button",
      ),
    ).map((button) => button.textContent ?? "");

  test("状態が変わると出る操作も変わる", () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    expect(labels()).toEqual(["● 録画"]);

    // 録り始めてからでも戻れる
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    expect(labels()).toEqual(["■ 中止"]);

    emit({
      kind: "posted",
      segments: [RANGE],
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
    expect(labels()).toEqual(["X にもう一度投稿", "取り直す"]);
  });

  test("操作を押すと状態機械へイベントが飛ぶ", () => {
    emit({ kind: "ready", segments: [RANGE], meta: META_A });

    document
      .querySelector<HTMLButtonElement>("#yt-clip-bar-actions button")
      ?.click();

    expect(clipEvents()).toContainEqual({ type: "START_RECORDING" });
  });

  test("投稿した後も拡大バーを触れる", () => {
    // 投稿のたびに範囲を作り直すのは使い方に合っていない
    emit({
      kind: "posted",
      segments: [RANGE],
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
    });

    expect(rangeBarElement().style.pointerEvents).not.toBe("none");
  });
});

describe("録画の中止", () => {
  test("中止を押すと状態機械へ伝わる", () => {
    emit({ kind: "recording", segments: [RANGE], meta: META_A });

    document
      .querySelector<HTMLButtonElement>("#yt-clip-bar-actions button")
      ?.click();

    expect(clipEvents()).toContainEqual({ type: "CANCEL_RECORDING" });
  });

  test("録画から離れると録画も監視も止まる", async () => {
    // 中止の停止処理は「recording から外れた」ことを見て走る。
    // 中止のためだけの後始末は足していないので、ここが唯一の担保になる
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    command("recorder/start");
    await flush();
    const recorder = startedRecorder();
    expect(recorder.state).toBe("recording");

    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();

    expect(recorder.state).toBe("inactive");
    expect(stoppedTracks).toBe(1);
    // 中止した分は送らない
    expect(sent.some((message) => message.type === "recorder/done")).toBe(false);
    expect(saved).toEqual([]);
  });
});

describe("設定", () => {
  function settingsButton(): HTMLButtonElement {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#yt-clip-bar button"),
    ).find((candidate) => candidate.textContent === "⚙");
    if (button === undefined) throw new Error("設定ボタンがありません");
    return button;
  }

  test("バーに設定ボタンが出る", () => {
    expect(settingsButton().title).toBe("設定");
  });

  test("押すとパネルが開き、もう一度押すと閉じる", () => {
    const panel = document.querySelector<HTMLElement>(
      "#yt-clip-setting-hashtags",
    )?.closest("div[style]")?.parentElement;
    if (panel == null) throw new Error("パネルがありません");
    expect(panel.hidden).toBe(true);

    settingsButton().click();
    expect(panel.hidden).toBe(false);

    settingsButton().click();
    expect(panel.hidden).toBe(true);
  });
});

describe("最大秒数の設定", () => {
  /** 直近に送った MARK_IN の範囲 */
  function markedRange(): ClipRange {
    const message = [...sent]
      .reverse()
      .find(
        (item): item is Extract<Message, { type: "clip/event" }> =>
          item.type === "clip/event" && item.event.type === "MARK_IN",
      );
    if (message === undefined) throw new Error("MARK_IN が送られていません");
    if (message.event.type !== "MARK_IN") throw new Error("MARK_IN ではない");
    return message.event.range;
  }

  test("IN で送る meta にチャンネルが入る", async () => {
    // service worker はここで受け取った channelId でタグを引く
    video.element.currentTime = 100;

    clickButton("IN");
    await flush();

    const message = [...sent].find(
      (item) => item.type === "clip/event" && item.event.type === "MARK_IN",
    );
    expect(message).toMatchObject({
      event: { meta: { channelId: META_A.channelId } },
    });
  });

  test("既定では 15 秒の範囲ができる", async () => {
    video.element.currentTime = 100;

    clickButton("IN");
    await flush();

    expect(markedRange()).toEqual({ startSec: 100, endSec: 115 });
  });

  test("上限を既定の長さより短くすると、IN の範囲も短くなる", async () => {
    // IN を押しただけで上限を超えた範囲ができると、validateRange を
    // 通らないまま (OUT を押さずに) 録画できてしまう
    changeSettings({ maxClipSec: 10 });
    await flush();
    video.element.currentTime = 100;

    clickButton("IN");
    await flush();

    expect(markedRange()).toEqual({ startSec: 100, endSec: 110 });
  });

  /** 拡大バーの OUT ハンドルを窓の右端まで引っ張る */
  function dragOutToEnd(): void {
    const track = rangeBarElement().querySelector<HTMLElement>(
      "[data-role=track]",
    );
    if (track === null) throw new Error("トラックがありません");
    track.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    const handles = [...rangeBarElement().querySelectorAll<HTMLElement>("[aria-label]")];
    const outHandle = handles[1];
    if (outHandle === undefined) throw new Error("終了ハンドルがありません");
    outHandle.setPointerCapture = () => undefined;
    outHandle.releasePointerCapture = () => undefined;

    outHandle.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }),
    );
    outHandle.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 1000 }),
    );
  }

  test("作り直されたバーにも設定した上限が効く", async () => {
    // YouTube の再描画でバーは作り直される。**新しいバーは既定値で始まる**ので、
    // 作った直後に流し込まないと、そのバーでだけ上限が 60 秒に戻る
    changeSettings({ maxClipSec: 20 });
    await flush();

    // 再描画を起こしてバーを作り直させる
    buildPage();
    document.body.append(document.createElement("div"));
    await flush();

    video.element.currentTime = 100;
    clickButton("IN");
    await flush();
    // 実機では service worker が state/changed を配る。それで拡大バーが有効になる
    emit({ kind: "ready", segments: [{ startSec: 100, endSec: 115 }], meta: META_A });
    await flush();

    dragOutToEnd();

    expect(handleLabels()[1]).toBe("終了 2:00");
  });

  test("上限を超える OUT は理由を出して受け付けない", async () => {
    changeSettings({ maxClipSec: 10 });
    await flush();
    video.element.currentTime = 100;
    clickButton("IN");
    await flush();

    video.element.currentTime = 130;
    clickButton("OUT");
    await flush();

    // 既定の 60 秒ではなく、設定した 10 秒が文言に出る
    expect(statusText()).toContain("10 秒までです");
  });
});

describe("エディットモード", () => {
  /** バーに出ているボタンの文言 */
  function buttonLabels(): string[] {
    return [...document.querySelectorAll("#yt-clip-bar button")].map(
      (button) => button.textContent ?? "",
    );
  }

  /** 一覧の行 */
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("シンプルでは一覧を出さない", async () => {
    changeSettings({ mode: "simple" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();

    expect(segmentRows()).toEqual([]);
  });

  test("エディットでは IN のラベルが変わる", async () => {
    changeSettings({ mode: "edit" });
    await flush();

    // 区間を足す入口を 2 つ作らないので、IN 自体が追加ボタンになる
    expect(buttonLabels()).toContain("＋ 区間を追加");
    expect(buttonLabels()).not.toContain("IN");
  });

  test("エディットの IN は区間を足すイベントを送る", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    sent = [];

    clickButton("＋ 区間を追加");

    expect(sent.at(-1)).toMatchObject({
      type: "clip/event",
      event: { type: "ADD_SEGMENT" },
    });
  });

  test("シンプルの IN は今までどおり置き換える", async () => {
    changeSettings({ mode: "simple" });
    await flush();
    sent = [];

    clickButton("IN");

    expect(sent.at(-1)).toMatchObject({
      type: "clip/event",
      event: { type: "MARK_IN" },
    });
  });

  test("区間ごとに行が出る", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      meta: META_A,
    });
    await flush();

    expect(segmentRows().length).toBe(2);
    expect(segmentRows()[0]?.textContent).toContain("1:23");
  });

  test("行を押すとその区間が拡大バーに載る", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      meta: META_A,
    });
    await flush();

    segmentRows()[1]?.click();
    await flush();

    expect(statusText()).toContain("4:02");
  });

  test("モードが変わると作りかけの区間を消す", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();

    expect(sent.at(-1)).toMatchObject({
      type: "clip/event",
      event: { type: "RESET_MARKS" },
    });
  });

  test("録画中はモードの変更を受け付けない", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();

    // 状態機械だけが戻ると、録画が走り続けて取り残される
    expect(sent).toEqual([]);
  });
});

describe("複数区間の録画", () => {
  const TWO: ClipRange[] = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  /** 録画が走っている状態まで進める */
  async function startTwoSegments(): Promise<FakeRecorder> {
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: TWO, meta: META_A });
    await flush();
    command("recorder/start");
    await flush();
    return startedRecorder();
  }

  /**
   * 区間の終端に到達させ、次の区間の頭で新しいフレームが出たことにする。
   *
   * **フレームを 2 回進めるのは仕様どおり。** 終端の到達で pause とシークが
   * 起き、そこから「新しいフレームが描かれた」のを見て初めて resume する
   */
  async function reachEndAndSettle(
    endSec: number,
    nextStartSec: number,
  ): Promise<void> {
    video.advanceFrame(endSec);
    await flush();
    video.advanceFrame(nextStartSec);
    await flush();
  }

  function setAd(showing: boolean): void {
    document
      .querySelector("#movie_player")
      ?.classList.toggle("ad-showing", showing);
  }

  test("最初の区間の頭へ飛ぶ", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "seeking", segments: TWO, meta: META_A });
    await flush();

    expect(video.element.currentTime).toBe(83);
  });

  test("区間の終わりで録画を止め、次の頭へ飛んでから再開する", async () => {
    const recorder = await startTwoSegments();

    await reachEndAndSettle(98, 242);

    // 止めてから飛び、映像が整ってから再開する。順序が崩れると繋ぎ目に
    // 前の場面が混入する
    expect(recorder.calls).toEqual(["start", "pause", "resume"]);
    expect(video.element.currentTime).toBe(242);
    expect(recorder.state).toBe("recording");
  });

  test("区間の間では書き出しへ進まない", async () => {
    await startTwoSegments();
    sent = [];

    video.advanceFrame(98);
    await flush();

    expect(clipEvents()).not.toContainEqual({ type: "OUT_REACHED" });
  });

  test("最後の区間の終わりで書き出しへ進む", async () => {
    await startTwoSegments();

    await reachEndAndSettle(98, 242);
    sent = [];
    video.advanceFrame(250);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "OUT_REACHED" });
  });

  test("区間の間で広告が始まったら全体を落とす", async () => {
    const recorder = await startTwoSegments();
    sent = [];
    setAd(true);

    await reachEndAndSettle(98, 242);

    // 部分的に広告が混ざったクリップを残すより、録り直させる方がましである
    expect(clipEvents()).toContainEqual({
      type: "FAIL",
      reason: "ad-playing",
    });
    expect(recorder.calls).not.toContain("resume");
    setAd(false);
  });

  test("区間の間で中止しても録画は止まる", async () => {
    const recorder = await startTwoSegments();

    video.advanceFrame(98);
    await flush();
    emit({ kind: "ready", segments: TWO, meta: META_A });
    await flush();

    // pause 中に中止されてもストリームを掴んだままにしない
    expect(recorder.state).toBe("inactive");
  });

  test("区間の進みを status に出す", async () => {
    await startTwoSegments();

    expect(statusText()).toContain("1 / 2 区間目");
  });
});

describe("シークバーの帯", () => {
  /** 帯 1 本ずつの左端 (%) */
  function bandLefts(): number[] {
    return [...(overlay()?.querySelectorAll<HTMLElement>("div") ?? [])].map(
      (band) => Number.parseFloat(band.style.left),
    );
  }

  async function showTwoSegments(): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 60, endSec: 70 },
      ],
      meta: META_A,
    });
    await flush();
  }

  test("区間の数だけ帯を描く", async () => {
    await showTwoSegments();

    // 1 本の帯で全体を覆うと、間の拾っていない部分まで切り抜くように見える
    expect(bandLefts().length).toBe(2);
  });

  test("帯は動画の時間順に並ぶ", async () => {
    await showTwoSegments();

    const lefts = bandLefts();
    expect(lefts[0]).toBeLessThan(lefts[1] ?? 0);
  });

  test("帯の幅は区間の長さに比例する", async () => {
    await showTwoSegments();

    // 動画の長さは 600 秒。10 秒の区間なので 1/60 = 約 1.67%
    const widths = [
      ...(overlay()?.querySelectorAll<HTMLElement>("div") ?? []),
    ].map((band) => Number.parseFloat(band.style.width));
    expect(widths[0]).toBeCloseTo(100 / 60, 1);
  });

  test("区間が無くなったら帯ごと消す", async () => {
    await showTwoSegments();

    emit({ kind: "idle" });
    await flush();

    expect(overlay()).toBeNull();
  });
});
