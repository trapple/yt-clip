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
  afterEach,
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
  type Telop,
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
  /** 録画に渡されたストリーム */
  stream: unknown;
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

/** chrome.storage.local の windowLayout (覚えた窓の位置)。読み込み時の値は beforeAll で入れる */
let storedLayout: unknown = undefined;
/** chrome.storage.local へ書いた windowLayout。書いた順 */
let layoutWrites: unknown[] = [];
/**
 * 読み込み時の windowLayout の読み込みを止めておく。beforeAll が離す。
 * 止めている間に「窓がまだ出ていない」ことを確かめる
 */
let releaseLayout: () => void = () => undefined;
const layoutGate = new Promise<void>((resolve) => {
  releaseLayout = resolve;
});
/** 読み込み時に覚えていた窓の位置。この位置で出ることを確かめる (jsdom の画面 1024x768 に収まる値) */
const LAYOUT_AT_LOAD = {
  bar: { left: 40, top: 500, width: 700 },
  panel: { left: 300, top: 120, width: 360, height: 400 },
};

/**
 * 描ける canvas の 2D 文脈のモック。プレビューと合成が呼ぶものだけ持つ。
 *
 * **既定を null にしない。** 描けない環境ではテロップ付きの状態が届くたびに
 * プレビューが warn し、テストの出力が警告で埋まる
 */
function makeCanvasContext(
  options: { tainted?: boolean; fillText?: () => void } = {},
): CanvasRenderingContext2D {
  let font = "10px sans-serif";
  const ctx = {
    get font(): string {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    drawImage: () => undefined,
    getImageData: () => {
      if (options.tainted) throw new DOMException("tainted", "SecurityError");
      return {};
    },
    clearRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    strokeText: () => undefined,
    fillText: options.fillText ?? (() => undefined),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function spyOnGetContext() {
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext");
}

/** getContext の spy。テストが差し替えた後は `useDefaultCanvasContext` で戻す */
let getContextSpy: ReturnType<typeof spyOnGetContext> | null = null;

function useDefaultCanvasContext(): void {
  getContextSpy?.mockImplementation(() => makeCanvasContext());
}

/** ResizeObserver の stub が見ている要素と、大きさが変わったときに呼ぶもの */
const resizeObservers: { callback: () => void; targets: Set<Element> }[] = [];

/** target を見ている ResizeObserver に、大きさが変わったことを届ける */
function resizeElement(target: Element): void {
  for (const entry of resizeObservers) {
    if (entry.targets.has(target)) entry.callback();
  }
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
    readonly stream: unknown;

    constructor(stream: unknown) {
      this.stream = stream;
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
      // 窓の位置 (window-layout.ts)。読み込み時の 1 回は layoutGate が離されるまで返さない
      local: {
        get: async (): Promise<Record<string, unknown>> => {
          await layoutGate;
          return storedLayout === undefined ? {} : { windowLayout: storedLayout };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          storedLayout = items.windowLayout;
          layoutWrites.push(items.windowLayout);
        },
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

  // jsdom は Pointer Capture を持たない (窓のドラッグ floating-window.ts が呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;

  // プレビュー (telop-preview.ts) と、プレイヤーの大きさの変化で窓を置き直す (youtube.ts) ため。
  // jsdom は ResizeObserver を持たず、canvas も描けない (getContext は "Not implemented" を
  // 出して null を返す)。見ている要素を覚えておき、resizeElement で大きさの変化を起こす
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly entry: { callback: () => void; targets: Set<Element> };
      constructor(callback: () => void) {
        this.entry = { callback, targets: new Set() };
        resizeObservers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.add(target);
      }
      unobserve(target: Element): void {
        this.entry.targets.delete(target);
      }
      disconnect(): void {
        this.entry.targets.clear();
      }
    },
  );
  getContextSpy = spyOnGetContext();
  useDefaultCanvasContext();
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

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 右側のパネル。body の直下に 1 つだけある */
function panelElement(): HTMLElement {
  const element = document.getElementById("yt-clip-panel");
  if (element === null) throw new Error("パネルが見つかりません");
  return element;
}

/** パネルの中身の箱。一覧と設定はここに入る */
function panelBody(): HTMLElement {
  const element = document.getElementById("yt-clip-panel-body");
  if (element === null) throw new Error("パネルの本体が見つかりません");
  return element;
}

/** プレイヤー直下のバー */
function barElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar");
  if (element === null) throw new Error("バーが見つかりません");
  return element;
}

function collapseButton(): HTMLButtonElement {
  const button = panelElement().querySelector<HTMLButtonElement>(
    "[data-role='collapse']",
  );
  if (button === null) throw new Error("折り畳みボタンがありません");
  return button;
}

/** 設定パネルの根。最初の項目 (モード) の入力欄 → 項目の枠 → 根 */
function settingsRoot(): HTMLElement {
  const root = document.getElementById("yt-clip-setting-mode")?.parentElement
    ?.parentElement;
  if (root == null) throw new Error("設定パネルが見つかりません");
  return root;
}

/** バーの窓の枠 (外形)。中身の根 #yt-clip-bar はこの中にある */
function barWindowElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar-window");
  if (element === null) throw new Error("バーの窓が見つかりません");
  return element;
}

/** バーの窓を動かすつまみ (⠿)。操作の行の左端にある */
function barGrip(): HTMLElement {
  const grip = barElement().querySelector<HTMLElement>("[data-role='grip']");
  if (grip === null) throw new Error("つまみが見つかりません");
  return grip;
}

/** パネルの窓の見出し (掴んで動かす所) */
function panelHeader(): HTMLElement {
  const header = panelElement().querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("パネルの見出しが見つかりません");
  return header;
}

/** 位置と大きさを決め打ちした箱 (rectAt は左 0・幅 400 に固定なので別に持つ) */
function boxAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

/** (100, 100) で押し、dx / dy だけ動かして離す */
function drag(target: Element, dx: number, dy: number): void {
  pointer(target, "pointerdown", 100, 100);
  pointer(target, "pointermove", 100 + dx, 100 + dy);
  pointer(target, "pointerup", 100 + dx, 100 + dy);
}

function dblclick(target: Element): void {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

/** 窓の枠に当てた位置と大きさ */
function styleRect(element: HTMLElement): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: element.style.left,
    top: element.style.top,
    width: element.style.width,
    height: element.style.height,
  };
}

/** プレイヤーの画面上の位置とバーの窓の高さを決め打ちする。ほかの要素は 0 */
function placePlayer(
  player: { left: number; top: number; width: number; height: number },
  barHeight: number,
) {
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.id === "movie_player") {
        return boxAt(player.left, player.top, player.width, player.height);
      }
      if (this.id === "yt-clip-bar-window") return boxAt(0, 0, 0, barHeight);
      return boxAt(0, 0, 0, 0);
    });
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

/** 覚えた位置を読み込む前の窓 (設定を開いてパネルに中身がある状態) */
let windowsBeforeLayout = { barHidden: false, panelHidden: false };
/** 覚えた位置を読み込んだ後の窓 */
let windowsAfterLayout = {
  barHidden: true,
  panelHidden: true,
  bar: { left: "", top: "", width: "", height: "" },
  panel: { left: "", top: "", width: "", height: "" },
};

beforeAll(async () => {
  buildPage();
  installGlobals();
  // 読み込み時点で service worker が範囲を持っている場面を再現する
  // (録画中でないタブのリロード。状態は content script に残っていない)
  swState = { kind: "ready", segments: [RANGE], telops: [], meta: META_A };
  // 前に動かした窓の位置を覚えている場面を再現する
  storedLayout = LAYOUT_AT_LOAD;

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

  // 覚えた窓の位置の読み込みは layoutGate で止めてある。設定を開いてパネルに中身が
  // ある状態にしても、読み込みが済むまではどちらの窓も出ない (最初の位置から跳ぶ絵にしない)
  clickButton("⚙");
  windowsBeforeLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
  };
  releaseLayout();
  await flush();
  windowsAfterLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
    bar: styleRect(barWindowElement()),
    panel: styleRect(panelElement()),
  };
  // 設定を閉じて、以降のテストを閉じた状態から始める
  clickButton("⚙");
});

/**
 * ダウンロードされたファイル名。**常に空でなければならない。**
 * 自動ダウンロードは廃止した (`.claude/specs/2026-09-12-drop-auto-save-design.md`)
 */
let saved: string[] = [];

beforeEach(async () => {
  history.pushState({}, "", "/watch?v=video-a");
  // バーの中身は body 直下の窓の中にあり、buildPage で body を空にしても窓ごと付け直されて
  // 残る (以前は #below と一緒に消えていた)。前のテストの状態の文言・設定の開閉を持ち越さない
  // よう、中身の根を外して作り直させる
  document.getElementById("yt-clip-bar")?.remove();
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
  // パネルはタブを開いている間 1 つを使い回す (畳んだ状態を覚えるため)。
  // 前のテストで畳んだまま・送ったままにしない
  const collapse = document.querySelector<HTMLButtonElement>(
    "#yt-clip-panel [data-role='collapse']",
  );
  if (collapse?.getAttribute("aria-expanded") === "false") collapse.click();
  const panelBodyElement = document.getElementById("yt-clip-panel-body");
  if (panelBodyElement !== null) panelBodyElement.scrollTop = 0;
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
  // 空にした body を mount() が拾って 2 つの窓 (バーとパネル) を付け直す。jsdom は破棄の
  // ときに body.innerHTML = "" をするので、窓が残っているとその DOM 変化が破棄後に
  // 配られる。窓を外すだけだと mount() がまた付け直すので、observer が見て
  // いない空の body に差し替えて、破棄のときに外すものを無くす
  document.documentElement.replaceChild(
    document.createElement("body"),
    document.body,
  );
  await flush();
});

describe("範囲再生の監視", () => {
  test("範囲を変えた後は、前の範囲の監視で録画が止まらない", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });

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
    emit({ kind: "seeking", segments: [recording], telops: [], meta: META_A });
    await flush();
    emit({ kind: "recording", segments: [recording], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    clickButton("▶ 範囲を見る");
    await flush();
    expect(video.pendingFrames()).toBe(1);

    emit({ kind: "seeking", segments: [RANGE], telops: [], meta: META_A });
    await flush();

    expect(video.pendingFrames()).toBe(0);
    // 録画の準備自体は進んでいる
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });
  });
});

describe("動画の入れ替わり", () => {
  test("範囲を作った動画と違う動画では録画に入らない", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    expect(overlay()).not.toBeNull();

    // 関連動画へ SPA 遷移してから popup で録画を始めた場合
    history.pushState({}, "", "/watch?v=video-b");
    emit({ kind: "seeking", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
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
      telops: [],
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "seeking", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(clipEvents()).toContainEqual({ type: "SEEK_DONE" });

    command("recorder/start");
    await flush();
    expect(startedRecorder().state).toBe("recording");

    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    // recording への遷移で録画を捨てていないこと
    expect(startedRecorder().state).toBe("recording");

    // OUT に到達 → 書き出し → 結果の送信まで通す
    video.advanceFrame(20.1);
    expect(clipEvents()).toContainEqual({ type: "OUT_REACHED" });
    emit({ kind: "encoding", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    command("recorder/start");
    await flush();

    emit({ kind: "encoding", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({
      kind: "failed",
      reason: "recording-aborted",
      segments: [RANGE],
      telops: [],
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    expect(rangeBarElement().style.pointerEvents).not.toBe("none");

    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      telops: [],
      meta: META_A,
    });
    // service worker は preview での範囲変更を拒む。画面もそれに合わせる
    expect(rangeBarElement().style.pointerEvents).toBe("none");
  });

  test("受け付けられなかった範囲変更は、画面を状態機械側へ戻す", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      telops: [],
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    expect(labels()).toEqual(["● 録画"]);

    // 録り始めてからでも戻れる
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    expect(labels()).toEqual(["■ 中止"]);

    emit({
      kind: "posted",
      segments: [RANGE],
      telops: [],
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
    expect(labels()).toEqual(["X にもう一度投稿", "取り直す"]);
  });

  test("操作を押すと状態機械へイベントが飛ぶ", () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });

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
      telops: [],
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
    });

    expect(rangeBarElement().style.pointerEvents).not.toBe("none");
  });
});

describe("録画の中止", () => {
  test("中止を押すと状態機械へ伝わる", () => {
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });

    document
      .querySelector<HTMLButtonElement>("#yt-clip-bar-actions button")
      ?.click();

    expect(clipEvents()).toContainEqual({ type: "CANCEL_RECORDING" });
  });

  test("録画から離れると録画も監視も止まる", async () => {
    // 中止の停止処理は「recording から外れた」ことを見て走る。
    // 中止のためだけの後始末は足していないので、ここが唯一の担保になる
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    command("recorder/start");
    await flush();
    const recorder = startedRecorder();
    expect(recorder.state).toBe("recording");

    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
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

describe("状態の文言", () => {
  test("全文を title にも入れる (1 行に省略して出すため)", async () => {
    clickButton("IN");
    await flush();

    const status = document.getElementById("yt-clip-bar-status");
    expect(status?.textContent).not.toBe("");
    expect(status?.title).toBe(status?.textContent);
  });

  test("⚙ は状態の文言のすぐ後ろ (右端) に置く", () => {
    const status = document.getElementById("yt-clip-bar-status");
    const next = status?.nextElementSibling;
    expect(next?.textContent).toBe("⚙");
    // 右端へは状態の文言の flex:1 で寄せる。margin-left:auto と意図を 2 つ持たない
    expect(next instanceof HTMLElement ? next.style.marginLeft : "missing").toBe("");
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

    // 再描画を起こしてバーを作り直させる。バーの中身は body 直下の窓の中にあり、
    // body を作り直しても窓ごと付け直されて残るので、中身の根を外しておく
    barElement().remove();
    buildPage();
    document.body.append(document.createElement("div"));
    await flush();

    video.element.currentTime = 100;
    clickButton("IN");
    await flush();
    // 実機では service worker が state/changed を配る。それで拡大バーが有効になる
    emit({ kind: "ready", segments: [{ startSec: 100, endSec: 115 }], telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();

    expect(segmentRows()).toEqual([]);
  });

  test("エディットでは追加ボタンが増える。IN は消えない", async () => {
    changeSettings({ mode: "edit" });
    await flush();

    // IN を追加ボタンに置き換えると、一度作った区間の頭を詰められなくなる
    expect(buttonLabels()).toContain("＋ 区間を追加");
    expect(buttonLabels()).toContain("IN");
    expect(buttonLabels()).toContain("OUT");
  });

  test("追加ボタンは区間を足すイベントを送る", async () => {
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
      telops: [],
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
      telops: [],
      meta: META_A,
    });
    await flush();

    segmentRows()[1]?.click();
    await flush();

    expect(statusText()).toContain("4:02");
  });

  test("モードが変わると作りかけの区間を消す", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
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
    emit({ kind: "recording", segments: TWO, telops: [], meta: META_A });
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
    emit({ kind: "seeking", segments: TWO, telops: [], meta: META_A });
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
    emit({ kind: "ready", segments: TWO, telops: [], meta: META_A });
    await flush();

    // pause 中に中止されてもストリームを掴んだままにしない
    expect(recorder.state).toBe("inactive");
  });

  test("区間の間で中止した後、シークが完了しても失敗にしない", async () => {
    await startTwoSegments();

    video.advanceFrame(98);
    await flush();
    emit({ kind: "ready", segments: TWO, telops: [], meta: META_A });
    await flush();
    sent = [];

    // 中止を待っている間にシークと再生が完了する。止まった recorder に
    // resume を投げると throw し、ready に戻ったはずの状態が failed に落ちる
    video.advanceFrame(242);
    await flush();

    expect(clipEvents()).toEqual([]);
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
      telops: [],
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

describe("エディットモードの OUT", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("選んでいる区間の index を送る", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    // 2 番目を選んでから OUT を押す
    segmentRows()[1]?.click();
    await flush();
    video.element.currentTime = 246;
    sent = [];
    clickButton("OUT");
    await flush();

    // index 0 を送ると先頭区間が 83-246 に伸び、全区間がマージされて
    // 「OUT を押したら区間が全部 1 つに溶けた」ことになる
    expect(clipEvents()).toContainEqual({
      type: "MARK_OUT",
      index: 1,
      sec: 246,
    });
  });
});

describe("進行中のモード変更", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("録画が終わってから切り替わる", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();
    // 状態機械だけが戻ると、録画が走り続けて取り残される
    expect(clipEvents()).toEqual([]);

    // 録画が終わったら追いつく。storage の変更通知は次に保存するまで来ないので、
    // ここで拾わないとタブは開き直すまでエディットのままになる
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "RESET_MARKS" });
  });

  test("録画済みクリップを持つ間は切り替えない", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "degraded",
      segments: [RANGE],
      telops: [],
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();

    // RESET_MARKS は idle へ落とす。実時間を払った録画への参照ごと失う
    expect(clipEvents()).toEqual([]);
    expect(segmentRows().length).toBe(1);
  });
});

describe("区間を足した直後の選択", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("足した区間が選ばれる", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [{ startSec: 83, endSec: 98 }], telops: [], meta: META_A });
    await flush();

    video.element.currentTime = 300;
    clickButton("＋ 区間を追加");
    await flush();
    // 状態機械が並べ替えた結果を返す
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 300, endSec: 315 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    // 「IN → OUT」の癖で OUT を押したとき、前の区間の終端が動くと事故になる
    expect(segmentRows()[1]?.dataset.selected).toBe("true");
  });
});

describe("合計が上限を超えた録画", () => {
  test("内部エラーではなく区間を直せる状態へ戻す", async () => {
    changeSettings({ mode: "edit", maxClipSec: 20 });
    emit({
      kind: "ready",
      segments: [
        { startSec: 0, endSec: 15 },
        { startSec: 100, endSec: 115 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();
    sent = [];

    emit({
      kind: "seeking",
      segments: [
        { startSec: 0, endSec: 15 },
        { startSec: 100, endSec: 115 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    // 合計を減らせば直せる。「内部エラーが発生しました」では手の打ちようがない
    expect(clipEvents()).toContainEqual({ type: "CANCEL_RECORDING" });
    expect(statusText()).toContain("上限");
  });
});

describe("エディットモードの IN", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  async function showTwo(): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();
  }

  test("選んでいる区間の頭だけを動かす", async () => {
    await showTwo();
    segmentRows()[1]?.click();
    await flush();
    video.element.currentTime = 246;
    sent = [];

    clickButton("IN");
    await flush();

    // 終端はそのまま。他の区間にも触らない
    expect(clipEvents()).toContainEqual({
      type: "ADJUST_SEGMENT",
      index: 1,
      range: { startSec: 246, endSec: 250 },
    });
  });

  test("シンプルの IN は今までどおり作り直す", async () => {
    changeSettings({ mode: "simple" });
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    sent = [];

    clickButton("IN");
    await flush();

    expect(clipEvents().map((event) => (event as { type: string }).type)).toContain(
      "MARK_IN",
    );
  });

  test("頭が尻を追い越したら弾く", async () => {
    await showTwo();
    segmentRows()[1]?.click();
    await flush();
    // 終端 250 より後ろ
    video.element.currentTime = 260;
    sent = [];

    clickButton("IN");
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).not.toBe("");
  });

  test("区間が無ければ先に追加するよう促す", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "idle" });
    await flush();
    sent = [];

    clickButton("IN");
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toContain("区間を追加");
  });
});

describe("重なる位置での区間追加", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("区間の中で押しても区間が増える", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [{ startSec: 83, endSec: 200 }], telops: [], meta: META_A });
    await flush();
    // 既存区間の内側
    video.element.currentTime = 90;
    sent = [];

    clickButton("＋ 区間を追加");
    await flush();

    // マージしていた頃は結果が変わらず、押しても何も起きなかった
    expect(clipEvents()).toContainEqual(
      expect.objectContaining({ type: "ADD_SEGMENT" }),
    );
  });

  test("足した区間が末尾で選ばれる", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [{ startSec: 83, endSec: 200 }], telops: [], meta: META_A });
    await flush();

    video.element.currentTime = 90;
    clickButton("＋ 区間を追加");
    await flush();
    // 並べ替えないので、足した区間は必ず末尾に来る
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 200 },
        { startSec: 90, endSec: 105 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    expect(segmentRows()[1]?.dataset.selected).toBe("true");
  });

  test("途中の区間を消しても選択が飛ばない", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 30, endSec: 40 },
        { startSec: 50, endSec: 60 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();
    // 末尾を選ぶ
    segmentRows()[2]?.click();
    await flush();

    // 先頭を消すと、選択していた区間は index 1 に詰まる
    emit({
      kind: "ready",
      segments: [
        { startSec: 30, endSec: 40 },
        { startSec: 50, endSec: 60 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    expect(segmentRows()[1]?.dataset.selected).toBe("true");
    expect(statusText()).toContain("0:50");
  });
});

describe("区間を消したときの選択", () => {
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  async function showThree(): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 30, endSec: 40 },
        { startSec: 50, endSec: 60 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();
  }

  test("選択より前を消すと 1 つ手前へずれる", async () => {
    await showThree();
    // 真ん中 (0:30) を選ぶ
    segmentRows()[1]?.click();
    await flush();

    segmentRows()[0]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    await flush();
    emit({
      kind: "ready",
      segments: [
        { startSec: 30, endSec: 40 },
        { startSec: 50, endSec: 60 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    // 選んでいた 0:30 は index 0 へ移った。index 1 のままだと別の区間を指す
    expect(segmentRows()[0]?.dataset.selected).toBe("true");
    expect(statusText()).toContain("0:30");
  });

  test("選択より後ろを消しても動かない", async () => {
    await showThree();
    segmentRows()[0]?.click();
    await flush();

    segmentRows()[2]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    await flush();
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 30, endSec: 40 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    expect(segmentRows()[0]?.dataset.selected).toBe("true");
    expect(statusText()).toContain("0:10");
  });
});

describe("テロップ付きの録画", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
  let restoreCanvas: (() => void) | null = null;

  /**
   * 録画の canvas を用意する。tainted なら getImageData が SecurityError。
   * recordingDrawThrows なら、録画に使った canvas (captureStream を呼んだもの) に
   * 文字を描くと投げる。プレビューの canvas は壊さない (壊すとプレビューが warn する)
   */
  function installCanvas(
    options: { tainted?: boolean; recordingDrawThrows?: boolean } = {},
  ) {
    const track = {
      kind: "video",
      requestFrame: () => undefined,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    const captured = new Set<HTMLCanvasElement>();
    getContextSpy?.mockImplementation(function (this: HTMLCanvasElement) {
      return makeCanvasContext({
        tainted: options.tainted,
        fillText: () => {
          if (options.recordingDrawThrows && captured.has(this)) {
            throw new Error("描画が壊れた");
          }
        },
      });
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true,
      value(this: HTMLCanvasElement) {
        captured.add(this);
        return { getVideoTracks: () => [track] };
      },
    });
    // mockRestore にしない。installGlobals の spy まで外れて jsdom の実装に戻り、
    // 以降のテストの出力に "Not implemented" が混ざる
    restoreCanvas = useDefaultCanvasContext;
    return { track };
  }

  beforeEach(() => {
    // 合成の canvas は録画開始時の動画の大きさで作る。フェイクは高さしか持たない
    Object.defineProperty(video.element, "videoWidth", {
      configurable: true,
      value: 1920,
    });
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: { kind: string }[] = []) {}
        getTracks() {
          return this.tracks;
        }
        getVideoTracks() {
          return this.tracks.filter((track) => track.kind === "video");
        }
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio");
        }
      },
    );
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
  });

  /**
   * seeking → recording → recorder/start と進める。
   *
   * **seeking を通すこと。** 経路の判定と描けるかの検査は prepareRecording
   * (seeking を受けたとき) で行うので、recording から始めると合成を通らない
   */
  async function recordWith(telops: Telop[]): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops });
    await flush();
    emit({ kind: "recording", segments: [RANGE], meta: META_A, telops });
    await flush();
    command("recorder/start");
    await flush();
  }

  test("区間に重なるテロップがあると canvas の映像で録る", async () => {
    const { track } = installCanvas();

    await recordWith([TELOP]);

    const stream = startedRecorder().stream as { getVideoTracks(): unknown[] };
    expect(stream.getVideoTracks()).toEqual([track]);
  });

  /**
   * 録画が今の経路 (video.captureStream の映像) で録っているか。
   *
   * **canvas が作られたかでは見ない。** プレビュー (Task 11) は区間外のテロップ
   * でも canvas を作るので、録画の経路とは関係なく canvas は現れる
   */
  function recordsCapturedVideo(): boolean {
    const stream = startedRecorder().stream as {
      getVideoTracks(): object[];
    };
    const tracks = stream.getVideoTracks();
    return tracks.length === 1 && !tracks.some((track) => "requestFrame" in track);
  }

  test("テロップが無ければ今の経路のまま", async () => {
    installCanvas();

    await recordWith([]);

    expect(recordsCapturedVideo()).toBe(true);
  });

  test("区間外のテロップしか無ければ今の経路のまま", async () => {
    // canvas を挟む負荷を、録画に出ないテロップのために払わない
    installCanvas();

    await recordWith([{ startSec: 100, endSec: 103, text: "外" }]);

    expect(recordsCapturedVideo()).toBe(true);
  });

  test("canvas に描けなければ録画を始めずに telop-render-failed で落とす", async () => {
    // テロップなしで録って続行すると、実時間を払った後で気付くことになる
    installCanvas({ tainted: true });
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-render-failed" });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
    expect(statusText()).toContain("テロップを動画に描けませんでした");
  });

  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    setHidden(false);
  });

  test("録画を始める前にタブが隠れていたら始めない", async () => {
    // 隠れたまま始めると、最初のフレームから映像が止まる
    installCanvas();
    setHidden(true);
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
  });

  test("seeking から recorder/start までの往復の間に隠れたら録画を始めない", async () => {
    // prepareRecording の検査は seek の await より前の 1 回だけ。その後の
    // service worker との往復の間に隠れると、監視はまだ付いていないので
    // startCompositor が始まる前に見ておかないと素通りする
    installCanvas();
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();
    // ここではまだ隠れていない (SEEK_DONE を通す)
    setHidden(true);

    emit({ kind: "recording", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();
    command("recorder/start");
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
    expect(recorders).toHaveLength(0);
  });

  test("録画中にタブが隠れたら中断する", async () => {
    installCanvas();
    await recordWith([TELOP]);
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
  });

  test("録画中に合成の描画が落ちたら telop-render-failed で中断する", async () => {
    // 描画が止まったまま録り続けると、静止した映像と進む音声が成功として書き出される
    const { track } = installCanvas({ recordingDrawThrows: true });
    await recordWith([TELOP]);
    sent = [];

    // テロップの出る時刻のフレームで初めて文字を描く
    video.advanceFrame(12);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-render-failed" });
    expect(statusText()).toContain("テロップを動画に描けませんでした");
    expect(track.stopped).toBe(true);
  });

  test("隠れていて動画の大きさも分からないときは、隠れたことを理由にする", async () => {
    // 隠れた窓では動画がデコードされず videoWidth が 0 になる。大きさの検査を
    // 先にすると「動画の大きさがまだ分かりません」が出て本当の理由が伝わらない
    installCanvas();
    Object.defineProperty(video.element, "videoWidth", { configurable: true, value: 0 });
    setHidden(true);
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
    expect(clipEvents()).not.toContainEqual({
      type: "FAIL",
      reason: "telop-render-failed",
    });
  });

  test("テロップの無い録画では隠れても中断しない", async () => {
    // 今の経路は隠れても映像が止まらない (§9.1)
    await recordWith([]);
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).not.toContainEqual(expect.objectContaining({ type: "FAIL" }));
  });
});

describe("テロップの一覧", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  function telopRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='telop']")];
  }

  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  function addTelopButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-role='add-telop']");
    if (button === null) throw new Error("＋ テロップがありません");
    return button;
  }

  async function showReady(
    telops: Telop[],
    segments: ClipRange[] = [RANGE],
  ): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments, meta: META_A, telops });
    await flush();
    sent = [];
  }

  async function seekVideo(sec: number): Promise<void> {
    video.element.currentTime = sec;
    await flush();
  }

  test("＋ テロップで今の位置から 3 秒のテロップを送る", async () => {
    await showReady([]);
    await seekVideo(12);

    addTelopButton().click();

    expect(clipEvents().at(-1)).toEqual({
      type: "ADD_TELOP",
      telop: { startSec: 12, endSec: 15, text: "" },
    });
  });

  test("動画の終わりを超えるなら終わりを詰める", async () => {
    await showReady([]);
    await seekVideo(598);

    addTelopButton().click();

    expect(clipEvents().at(-1)).toEqual({
      type: "ADD_TELOP",
      telop: { startSec: 598, endSec: 600, text: "" },
    });
  });

  test("開始を今にで、開始が終了以上になるなら送らず理由を出す", async () => {
    await showReady([TELOP]);
    await seekVideo(20);

    telopRows()[0]?.querySelector<HTMLElement>("[data-role='set-start']")?.click();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe("開始は終了より前にしてください");
  });

  test("文言を確定すると UPDATE_TELOP を送る", async () => {
    await showReady([TELOP]);
    const textarea = telopRows()[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");

    textarea.value = "やあ\n元気";
    textarea.dispatchEvent(new Event("change"));

    expect(clipEvents().at(-1)).toEqual({
      type: "UPDATE_TELOP",
      index: 0,
      telop: { ...TELOP, text: "やあ\n元気" },
    });
  });

  test("500 文字を超える文言は送らず、理由を出して入力欄は残す", async () => {
    // 状態ごと保存され毎フレーム描かれる。上限を超えたものは状態機械に拒まれる
    await showReady([TELOP]);
    const textarea = telopRows()[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");

    textarea.value = "あ".repeat(501);
    textarea.dispatchEvent(new Event("change"));

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe("テロップは 500 文字までです (いま 501 文字)");
    // 直してもらうので消さない
    expect(textarea.value).toBe("あ".repeat(501));

    textarea.value = "あ".repeat(500);
    textarea.dispatchEvent(new Event("change"));

    expect(clipEvents().at(-1)).toEqual({
      type: "UPDATE_TELOP",
      index: 0,
      telop: { ...TELOP, text: "あ".repeat(500) },
    });
  });

  test("テロップが残っていると最後の 1 区間は消せない", async () => {
    // 区間が 0 個になると idle に戻り、手入力の文言もまとめて消える
    await showReady([TELOP]);

    segmentRows()[0]?.querySelector<HTMLElement>("[data-role='remove']")?.click();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe(
      "テロップが 1 件残っています。先にテロップを消してください",
    );
  });

  test("区間の削除でテロップが消えてしまったら知らせる", async () => {
    // 手元の写しが古くて止め損ねた場合の保険
    await showReady([TELOP], [RANGE, { startSec: 30, endSec: 40 }]);
    segmentRows()[1]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    await flush();

    emit({ kind: "idle" });
    await flush();

    expect(statusText()).toBe("テロップも消えました");
  });

  test("削除の応答待ちの間に別の動画へ移っても、テロップが消えたとは言わない", async () => {
    // 応答の状態は元の動画のもの。別の動画のタブでは取り込まないので手元の
    // テロップは空になるが、状態機械にはまだ残っている
    await showReady([TELOP], [RANGE, { startSec: 30, endSec: 40 }]);
    segmentRows()[1]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    await flush();
    history.pushState({}, "", "/watch?v=video-b");

    emit({ kind: "ready", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(statusText()).not.toBe("テロップも消えました");
  });

  test("preview では操作できない", async () => {
    // 区間の拡大バーと同じ条件。テロップだけ触れる非対称を作らない
    changeSettings({ mode: "edit" });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      meta: META_A,
      telops: [TELOP],
    });
    await flush();
    sent = [];

    telopRows()[0]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    addTelopButton().click();

    expect(clipEvents()).toEqual([]);
  });

  test("シンプルモードでは出さない", async () => {
    changeSettings({ mode: "simple" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A, telops: [] });
    await flush();

    // 一覧の箱は ＋ テロップの見出しの親
    expect(addTelopButton().parentElement?.parentElement?.hidden).toBe(true);
  });
});

describe("右側のパネル", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  async function showEdit(telops: Telop[] = []): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops, meta: META_A });
    await flush();
  }

  test("body を作り直しても、パネルを body の直下に付け直す", async () => {
    // buildPage は body を空にする。付け直さないと、以降はパネルが DOM に無く
    // 一覧も設定も操作できない
    buildPage();
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelElement().parentElement).toBe(document.body);
    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
  });

  test("一覧と設定はパネルに入り、バーには拡大バーと操作の行だけが残る", async () => {
    await showEdit([TELOP]);

    const body = panelBody();
    // 区間の一覧 → テロップの一覧 → 設定の順
    expect(body.children.length).toBe(3);
    expect(body.children[0]?.querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(body.children[1]?.querySelector("[data-role='add-telop']")).not.toBeNull();
    expect(body.children[1]?.querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(body.children[2]).toBe(settingsRoot());

    const bar = barElement();
    expect(bar.querySelector("[data-role='segment']")).toBeNull();
    expect(bar.querySelector("[data-role='add-telop']")).toBeNull();
    expect(bar.querySelector("#yt-clip-setting-mode")).toBeNull();
    // 並びは今のまま: 拡大バー → 操作の行
    expect(bar.children.length).toBe(2);
    expect(bar.firstElementChild?.id).toBe("yt-clip-range");
    expect(
      bar.lastElementChild?.contains(document.getElementById("yt-clip-bar-status")),
    ).toBe(true);
  });

  test("エディットで区間があるとパネルを出す", async () => {
    await showEdit();
    expect(panelElement().hidden).toBe(false);
  });

  test("エディットでも区間が 0 個で設定を閉じていれば出さない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    expect(panelElement().hidden).toBe(true);
  });

  test("シンプルでは ⚙ で設定を開いている間だけ出す", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(panelElement().hidden).toBe(true);

    clickButton("⚙");
    expect(panelElement().hidden).toBe(false);
    expect(settingsRoot().hidden).toBe(false);
    expect(panelBody().contains(settingsRoot())).toBe(true);

    clickButton("⚙");
    expect(settingsRoot().hidden).toBe(true);
    expect(panelElement().hidden).toBe(true);
  });

  test("畳んでいても ⚙ で設定を開くとパネルが開く", async () => {
    await showEdit();
    collapseButton().click();
    expect(panelBody().hidden).toBe(true);
    // 見出しは残る
    expect(panelElement().hidden).toBe(false);

    clickButton("⚙");

    expect(panelBody().hidden).toBe(false);
    expect(settingsRoot().hidden).toBe(false);
  });

  test("隠れて畳まれたパネルでも、⚙ で出して開いてから設定の先頭へ送る", () => {
    // シンプルで設定を閉じている (パネルは隠れている) うえに畳んである
    collapseButton().click();
    const body = panelBody();
    const target = settingsRoot();
    // 隠れている間は寸法が 0 になる実機の振る舞いを写す。出す → 開く → 送る
    // の順が崩れると、0 同士で測って送らない
    const shown = (): boolean =>
      !panelElement().hidden && !body.hidden && !target.hidden;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return shown() ? rectAt(100, 400) : rectAt(0, 0);
        if (this === target) return shown() ? rectAt(900, 300) : rectAt(0, 0);
        return rectAt(0, 0);
      });
    try {
      clickButton("⚙");

      expect(panelElement().hidden).toBe(false);
      expect(body.hidden).toBe(false);
      // 設定の先頭を本体の上端に揃える: 900 - 100
      expect(body.scrollTop).toBe(800);
    } finally {
      spy.mockRestore();
    }
  });

  test("⚙ で閉じるときは送らない", async () => {
    await showEdit();
    const body = panelBody();
    const target = settingsRoot();
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return rectAt(100, 400);
        if (this === target) return rectAt(900, 300);
        return rectAt(0, 0);
      });
    try {
      clickButton("⚙");
      expect(body.scrollTop).toBe(800);

      body.scrollTop = 0;
      clickButton("⚙");
      expect(body.scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("モードを変えてバーを作り直しても、一覧と設定が 2 重にならない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    changeSettings({ mode: "simple" });
    await flush();
    changeSettings({ mode: "edit" });
    await flush();

    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
    expect(panelBody().children.length).toBe(3);
    expect(document.querySelectorAll("[data-role='add-telop']").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-setting-mode").length).toBe(1);

    // 入っているのは今の一覧。状態が届けば行が出る
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
  });

  test("設定を開いた状態でモードを変えても、設定は開いたまま", async () => {
    // シンプルで ⚙ を開く
    clickButton("⚙");
    expect(settingsRoot().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);

    changeSettings({ mode: "edit" });
    await flush();

    // バーを作り直すと設定パネルも新しいものに替わるが、開いていたなら
    // 開き直しておく (1 つのパネルを使い回す設計で、モードを変えた瞬間に
    // 設定が消えるのは驚きが大きい)
    expect(settingsRoot().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);

    changeSettings({ mode: "simple" });
    await flush();

    expect(settingsRoot().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);
  });

  test("バーを作り直しても、手元の区間で一覧を描き直す", async () => {
    await showEdit([TELOP]);

    // YouTube の再描画でバーが外れた場面。次の状態通知を待たずに一覧を戻す
    barElement().remove();
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(panelBody().querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(panelElement().hidden).toBe(false);
  });

  test("全画面の間はパネルを隠し、抜けたら戻す", async () => {
    await showEdit();
    expect(panelElement().hidden).toBe(false);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(panelElement().hidden).toBe(true);

      // 全画面の間に状態が届いても出さない
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(panelElement().hidden).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(panelElement().hidden).toBe(false);
  });

  test("別の動画へ移ると一覧を空にしてパネルを隠す。戻れば出す", async () => {
    await showEdit([TELOP]);
    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);

    // 固定のパネルでは、動画 B の画面に A の区間が出続けると目立つ
    history.pushState({}, "", "/watch?v=video-b");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(0);
    expect(panelBody().querySelectorAll("[data-role='telop']").length).toBe(0);
    expect(panelElement().hidden).toBe(true);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(panelElement().hidden).toBe(false);
  });

  test("動画ページ以外ではパネルを出さない", async () => {
    clickButton("⚙");
    expect(panelElement().hidden).toBe(false);

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelElement().hidden).toBe(true);
  });

  test("テーマを切り替えるとパネルの配色も変わる", async () => {
    // パネルは body の直下でバーの外にある。バーの配色は継がれない
    document.documentElement.setAttribute("dark", "");
    try {
      await flush();
      expect(panelElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
    } finally {
      document.documentElement.removeAttribute("dark");
    }
    await flush();
    expect(panelElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
  });
});

describe("足した行をパネルの見える範囲に入れる", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  /**
   * 本体は画面の 100〜500px。行は並び順に 900px から 100px ずつ下に置く。
   * 末尾の行が選ばれたかを送り先の値で見分けられる
   */
  function placeRows(role: "segment" | "telop") {
    const body = panelBody();
    return vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return rectAt(100, 400);
        if (this instanceof HTMLElement && this.dataset.role === role) {
          const index =
            this.parentElement === null
              ? 0
              : [...this.parentElement.children].indexOf(this);
          return rectAt(900 + index * 100, 60);
        }
        return rectAt(0, 0);
      });
  }

  function addTelopButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-role='add-telop']");
    if (button === null) throw new Error("＋ テロップがありません");
    return button;
  }

  test("区間を足したら、畳んでいても開いて末尾の行へ送る", async () => {
    const first: ClipRange = { startSec: 83, endSec: 98 };
    const added: ClipRange = { startSec: 300, endSec: 315 };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [first], telops: [], meta: META_A });
    await flush();
    const spy = placeRows("segment");
    try {
      collapseButton().click();
      video.element.currentTime = 300;
      clickButton("＋ 区間を追加");
      await flush();
      // 押した時点では行がまだ無い。送るのは状態機械の答えを描いた後
      expect(panelBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });

      expect(panelBody().hidden).toBe(false);
      // 末尾 (2 行目: 1000px) の先頭を本体の上端 (100px) に揃える
      expect(panelBody().scrollTop).toBe(900);

      // 送るのは足した直後の 1 回だけ。見ている位置を勝手に戻さない
      panelBody().scrollTop = 0;
      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("テロップを足したら、畳んでいても開いて末尾の行へ送る", async () => {
    const added: Telop = { startSec: 15, endSec: 18, text: "" };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [TELOP], meta: META_A });
    await flush();
    const spy = placeRows("telop");
    try {
      collapseButton().click();
      video.element.currentTime = 15;
      await flush();
      addTelopButton().click();
      await flush();
      expect(panelBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });

      expect(panelBody().hidden).toBe(false);
      expect(panelBody().scrollTop).toBe(900);

      panelBody().scrollTop = 0;
      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("足していない状態の通知では送らない", async () => {
    changeSettings({ mode: "edit" });
    const spy = placeRows("segment");
    try {
      emit({
        kind: "ready",
        segments: [RANGE, { startSec: 30, endSec: 40 }],
        telops: [],
        meta: META_A,
      });
      await flush();
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("フロートの窓", () => {
  // 読み込み時に覚えた位置 (LAYOUT_AT_LOAD) で出ているので、最初の位置に戻してから始める
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
    layoutWrites = [];
  });

  test("バーの窓とパネルの窓が body の直下に 1 つずつある", () => {
    expect(barWindowElement().parentElement).toBe(document.body);
    expect(panelElement().parentElement).toBe(document.body);
    expect(document.querySelectorAll("#yt-clip-bar-window").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
    // バーの中身 (拡大バーと操作の行) は窓の中
    expect(barWindowElement().contains(barElement())).toBe(true);
  });

  test("#below には何も置かない", () => {
    const below = document.getElementById("below");
    if (below === null) throw new Error("#below がありません");
    expect(below.children.length).toBe(0);
  });

  test("覚えた位置を読み込むまで、設定を開いていても窓を出さない", () => {
    expect(windowsBeforeLayout).toEqual({ barHidden: true, panelHidden: true });
  });

  test("覚えた位置で出る", () => {
    expect(windowsAfterLayout).toEqual({
      barHidden: false,
      panelHidden: false,
      bar: { left: "40px", top: "500px", width: "700px", height: "" },
      panel: { left: "300px", top: "120px", width: "360px", height: "400px" },
    });
  });

  test("バーの窓の最初の位置はプレイヤーの直下 (左端を揃え、幅はプレイヤーの幅、8px 空ける)", () => {
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 450 }, 106);
    try {
      dblclick(barGrip());
      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("バーの窓の高さは、プレイヤーの幅を当ててから測る (最小の幅で折り返した高さで詰めない)", () => {
    // 最小の幅 (480px) では操作の行が 2 段に折り返して背が高くなる。プレイヤーの幅を
    // 当てたときだけ 1 段 (106px) になる stub。折り返した高さで測ると画面の下端に詰めて
    // プレイヤーに重なる (768 - 16 - 300 = 452 < 538)
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(24, 80, 800, 450);
        if (this.id === "yt-clip-bar-window") {
          const height = (this as HTMLElement).style.width === "800px" ? 106 : 300;
          return boxAt(0, 0, 0, height);
        }
        return boxAt(0, 0, 0, 0);
      });
    try {
      // beforeEach の戻しはプレイヤーの幅 0 で測るので、窓は最小の幅 480px のまま
      expect(barWindowElement().style.width).toBe("480px");
      dblclick(barGrip());
      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("画面に収まらなければ、バーの窓を画面の下端から 16px に詰める", () => {
    // jsdom の画面は 1024x768。下端 700 のプレイヤーの下には 106px のバーが入らない
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 620 }, 106);
    try {
      dblclick(barGrip());
      // 768 - 16 - 106
      expect(barWindowElement().style.top).toBe("646px");
    } finally {
      spy.mockRestore();
    }
  });

  test("パネルの窓の最初の位置は右上 (右端から 16px・上 68px・幅 400px)", () => {
    expect(styleRect(panelElement())).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
      height: "",
    });
  });

  test("つまみをドラッグすると動き、指を離したときに 1 回だけ覚える", async () => {
    const frame = barWindowElement();
    const left = parseFloat(frame.style.left);
    const top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width);
    const grip = barGrip();

    pointer(grip, "pointerdown", 100, 100);
    pointer(grip, "pointermove", 130, 120);
    pointer(grip, "pointermove", 150, 130);
    await flush();
    // 動かしている間は覚えない
    expect(layoutWrites).toEqual([]);

    pointer(grip, "pointerup", 150, 130);
    await flush();
    expect(frame.style.left).toBe(`${left + 50}px`);
    expect(frame.style.top).toBe(`${top + 30}px`);
    expect(layoutWrites).toEqual([{ bar: { left: left + 50, top: top + 30, width } }]);
  });

  test("パネルの窓は見出しをドラッグすると動き、位置を覚える", async () => {
    clickButton("⚙");
    const frame = panelElement();
    const left = parseFloat(frame.style.left);

    drag(panelHeader(), -100, 20);
    await flush();

    expect(frame.style.left).toBe(`${left - 100}px`);
    expect(frame.style.top).toBe("88px");
    expect(layoutWrites).toEqual([{ panel: { left: left - 100, top: 88, width: 400 } }]);
  });

  test("つまみ・見出しをダブルクリックすると最初の位置に戻り、覚えた位置を消す", async () => {
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 450 }, 106);
    try {
      dblclick(barGrip());
      drag(barGrip(), 100, 50);
      drag(panelHeader(), -100, 20);
      await flush();
      expect(storedLayout).toEqual({
        bar: { left: 124, top: 588, width: 800 },
        panel: { left: window.innerWidth - 516, top: 88, width: 400 },
      });

      dblclick(barGrip());
      dblclick(panelHeader());
      await flush();

      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });
      expect(panelElement().style.left).toBe(`${window.innerWidth - 416}px`);
      expect(panelElement().style.top).toBe("68px");
      expect(storedLayout).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  test("モードを変えても窓を作り直さず、位置も変わらない。作り直したつまみでも動かせる", async () => {
    const frame = barWindowElement();
    drag(barGrip(), 30, 20);
    await flush();
    const placed = styleRect(frame);
    const oldGrip = barGrip();

    changeSettings({ mode: "edit" });
    await flush();

    expect(barWindowElement()).toBe(frame);
    expect(styleRect(frame)).toEqual(placed);
    // 中身は作り直した (＋ 区間を追加 が増えた)。つまみも新しい要素になる
    expect(barGrip()).not.toBe(oldGrip);
    drag(barGrip(), 10, 0);
    expect(frame.style.left).toBe(`${parseFloat(placed.left) + 10}px`);
  });

  test("最後に触った窓が上に来る", () => {
    pointer(barElement(), "pointerdown", 0, 0);
    expect(barWindowElement().style.zIndex).toBe("2001");
    expect(panelElement().style.zIndex).toBe("2000");

    pointer(panelBody(), "pointerdown", 0, 0);
    expect(panelElement().style.zIndex).toBe("2001");
    expect(barWindowElement().style.zIndex).toBe("2000");
  });

  test("全画面の間は 2 つとも隠し、抜けたら戻す", () => {
    clickButton("⚙");
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(barWindowElement().hidden).toBe(true);
      expect(panelElement().hidden).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);
  });

  test("動画ページ以外では 2 つとも隠す。戻れば出す", async () => {
    clickButton("⚙");

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();
    expect(barWindowElement().hidden).toBe(true);
    expect(panelElement().hidden).toBe(true);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);
  });

  // resolution 追加 1 (Task 5 レビューの Minor): applyMode が中身の根を外した後に
  // mount が #below の無さで途中で抜けると、バーの窓が中身の無いまま出続けてしまう。
  // mount はこの経路でも refreshWindows() を呼んでからでないと抜けてはいけない
  test("#below が無い状態で中身の根が外れると、mount はバーの窓を隠してから抜ける", async () => {
    expect(barWindowElement().hidden).toBe(false);

    document.getElementById("yt-clip-bar")?.remove();
    document.getElementById("below")?.remove();
    // DOM の変化を起こして MutationObserver 経由で mount() を走らせる
    document.body.append(document.createElement("div"));
    await flush();

    expect(barWindowElement().hidden).toBe(true);
  });

  test("隠れていた窓を出すときは、最初の位置を取り直す", () => {
    let playerBottom = 530;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(24, playerBottom - 450, 800, 450);
        return boxAt(0, 0, 0, 0);
      });
    try {
      dblclick(barGrip());
      expect(barWindowElement().style.top).toBe("538px");

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => video.element,
      });
      try {
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(barWindowElement().hidden).toBe(true);
        // 全画面の間にプレイヤーの位置が変わった
        playerBottom = 400;
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement");
      }
      document.dispatchEvent(new Event("fullscreenchange"));

      expect(barWindowElement().hidden).toBe(false);
      expect(barWindowElement().style.top).toBe("408px");
    } finally {
      spy.mockRestore();
    }
  });

  test("動かした窓は、出し直しても置いた場所のまま", async () => {
    let playerBottom = 530;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(24, playerBottom - 450, 800, 450);
        return boxAt(0, 0, 0, 0);
      });
    try {
      dblclick(barGrip());
      drag(barGrip(), 30, -100);
      await flush();
      const placed = styleRect(barWindowElement());
      expect(placed.top).toBe("438px");

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => video.element,
      });
      try {
        document.dispatchEvent(new Event("fullscreenchange"));
        playerBottom = 400;
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement");
      }
      document.dispatchEvent(new Event("fullscreenchange"));

      expect(styleRect(barWindowElement())).toEqual(placed);
    } finally {
      spy.mockRestore();
    }
  });

  test("テーマを切り替えるとバーの窓の配色も変わる", async () => {
    // バーの窓は body の直下でページの外にある。配色は自分で持つ
    document.documentElement.setAttribute("dark", "");
    try {
      await flush();
      expect(barWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
    } finally {
      document.documentElement.removeAttribute("dark");
    }
    await flush();
    expect(barWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
  });
});

describe("動かしていない窓の最初の位置を取り直す", () => {
  /** プレイヤーの画面上の位置を、テストの途中で変えられるように決め打ちする */
  function stubPlayer(initial: { left: number; top: number; width: number; height: number }) {
    const box = { ...initial };
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(box.left, box.top, box.width, box.height);
        if (this.id === "yt-clip-bar-window") return boxAt(0, 0, 0, 106);
        return boxAt(0, 0, 0, 0);
      });
    return { box, spy };
  }

  function player(): HTMLElement {
    const element = document.getElementById("movie_player");
    if (element === null) throw new Error("プレイヤーが見つかりません");
    return element;
  }

  // 読み込み時に覚えた位置 (LAYOUT_AT_LOAD) で出ているので、最初の位置に戻してから始める
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
  });

  test("ブラウザの大きさが変わると取り直す", () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });

      box.left = 0;
      box.width = 900;
      box.height = 500;
      window.dispatchEvent(new Event("resize"));
      // 80 + 500 + 8
      expect(styleRect(barWindowElement())).toEqual({
        left: "0px",
        top: "588px",
        width: "900px",
        height: "",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("パネルの窓も画面の幅に合わせて取り直す", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    try {
      window.dispatchEvent(new Event("resize"));
      // 1440 - 16 - 400
      expect(panelElement().style.left).toBe("1024px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1024,
      });
      window.dispatchEvent(new Event("resize"));
    }
    expect(panelElement().style.left).toBe("608px");
  });

  test("プレイヤーの大きさが変わると取り直す (シアターモードの切り替えなど)", () => {
    // beforeEach の buildPage で作り直したプレイヤーを見ている (mount のたびに見直す)
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(barWindowElement().style.top).toBe("538px");

      box.height = 500;
      resizeElement(player());
      expect(barWindowElement().style.top).toBe("588px");
    } finally {
      spy.mockRestore();
    }
  });

  test("ページのスクロールでは取り直さない (窓は同じ画面位置に浮いたまま)", () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(barWindowElement().style.top).toBe("538px");

      // ページを 200px 送った: プレイヤーは画面の上へ動く
      box.top = -120;
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
      expect(barWindowElement().style.top).toBe("538px");

      // 状態が届いても取り直さない (出ている間は置き直さない)
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(barWindowElement().style.top).toBe("538px");
    } finally {
      spy.mockRestore();
    }
  });

  // resolution 追加 2 (Task 5 レビューの Minor): スクロールと並べて、状態が届くだけでは
  // 取り直さないことを別のきっかけ (プレイヤーの位置の変化) でも確かめる
  test("窓を出している間は、状態を emit しても最初の位置を取り直さない", () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(barWindowElement().style.top).toBe("538px");

      // プレイヤーの画面上の位置が変わっても、resize / ResizeObserver 以外のきっかけ
      // (状態の通知) では取り直さない
      box.top = 200;
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(barWindowElement().style.top).toBe("538px");
    } finally {
      spy.mockRestore();
    }
  });

  test("スクロールした後に取り直すときは、プレイヤーの画面上の位置をそのまま使う", () => {
    // ページを 200px 送った状態 (プレイヤーの上端が画面の上へ 120px 出ている)
    const { spy } = stubPlayer({ left: 24, top: -120, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      // -120 + 450 + 8。ページの座標に直さない (窓は画面に固定)
      expect(barWindowElement().style.top).toBe("338px");
    } finally {
      spy.mockRestore();
    }
  });

  test("動かした窓は、ブラウザやプレイヤーの大きさが変わっても置いた場所のまま", async () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      drag(barGrip(), 30, -100);
      await flush();
      const placed = styleRect(barWindowElement());
      expect(placed.top).toBe("438px");

      box.height = 500;
      window.dispatchEvent(new Event("resize"));
      resizeElement(player());

      expect(styleRect(barWindowElement())).toEqual(placed);
    } finally {
      spy.mockRestore();
    }
  });
});
