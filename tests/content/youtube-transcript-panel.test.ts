// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { reduce } from "@/background/state";
import type { TranscriptStatus } from "@/content/transcript-loader";
import type { Message } from "@/shared/messages";
import type { ClipEvent, ClipState } from "@/shared/types";

/**
 * youtube.ts に組み込んだ文字起こしの欄 (段階 1b-2)。loader は偽物にして、状態を onChange で流す。
 * 状態機械は本物の reduce を使い、送ったイベントの答えを state/changed として流し返す (router の代わり)
 */

const fake = vi.hoisted(() => ({
  load: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  status: vi.fn(() => ({ kind: "idle" })),
  onChange: null as null | ((status: TranscriptStatus) => void),
}));

vi.mock("@/content/transcript-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/transcript-loader")>()),
  createDefaultTranscriptLoader: (onChange: (status: TranscriptStatus) => void) => {
    fake.onChange = onChange;
    return fake;
  },
}));

type MessageListener = (message: Message, sender: unknown, respond: (response?: unknown) => void) => void;
const messageListeners: MessageListener[] = [];
let state: ClipState = { kind: "idle" };
let events: ClipEvent[] = [];
let failNext = false;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function emit(next: ClipState): void {
  state = next;
  for (const listener of [...messageListeners]) listener({ type: "state/changed", state: next }, {}, () => undefined);
}

const META = { videoId: "video-a", title: "テスト動画", channelId: "" };

const LINES = [
  { id: "youtube-asr:1.00", startSec: 1, endSec: 3, text: "さあ残り 30 秒" },
  { id: "youtube-asr:4.00", startSec: 4, endSec: 6, text: "ここは絶対に右から" },
  { id: "youtube-asr:7.00", startSec: 7, endSec: 9, text: "えーと" },
];

function ready(dubbed = false): void {
  fake.onChange?.({
    kind: "ready",
    videoId: "video-a",
    dubbed,
    transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: LINES },
  });
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-role='line']")];

beforeAll(async () => {
  document.title = "テスト動画 - YouTube";
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key?: unknown): Promise<Record<string, unknown>> => (key === "enabled" ? { enabled: true } : {}),
        set: async (): Promise<void> => undefined,
      },
      sync: { get: async (): Promise<Record<string, unknown>> => ({}), set: async (): Promise<void> => undefined },
      onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
    },
    runtime: {
      onMessage: {
        addListener: (fn: MessageListener): void => {
          messageListeners.push(fn);
        },
        removeListener: (fn: MessageListener): void => {
          const index = messageListeners.indexOf(fn);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
      sendMessage: async (message: Message): Promise<{ state: ClipState }> => {
        if (failNext) {
          failNext = false;
          throw new Error("届かない");
        }
        if (message.type === "clip/event") {
          events.push(message.event);
          const next = reduce(state, message.event);
          // router と同じく、拒まれた遷移 (internal-error) は状態を変えない
          if (!(next.kind === "failed" && next.reason === "internal-error")) {
            setTimeout(() => emit(next), 0);
            return { state: next };
          }
        }
        return { state };
      },
    },
  });
  await import("@/content/youtube");
  await flush();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  emit({ kind: "idle" });
  await flush();
  events = [];
  failNext = false;
});

describe("文字起こしの欄 (段階 1b-2)", () => {
  test("区間・テロップの窓の先頭に欄があり、区間が無くても窓は出ている", async () => {
    ready();
    await flush();
    const list = document.getElementById("yt-clip-list");
    expect(list?.hidden).toBe(false);
    expect(document.querySelector("#yt-clip-list-body")?.firstElementChild?.getAttribute("data-role")).toBe("transcript");
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("さあ残り 30 秒"),
      expect.stringContaining("ここは絶対に右から"),
      expect.stringContaining("えーと"),
    ]);
  });

  test("行を押すと、その行の区間とテロップを SET_CLIP で送り、行が選ばれる", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(events).toEqual([
      {
        type: "SET_CLIP",
        segments: [{ startSec: 3.8, endSec: 6.3 }],
        telops: [{ startSec: 4, endSec: 6, text: "ここは絶対に右から", lineId: "youtube-asr:4.00" }],
        meta: expect.objectContaining({ videoId: "video-a" }),
      },
    ]);
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "true", "false"]);
    expect(document.querySelectorAll("[data-role='segment']")).toHaveLength(1);
  });

  test("もう一度押すと外れ、区間もテロップも無くなる (idle)", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(state).toEqual({ kind: "idle" });
    expect(rows().every((row) => row.dataset.selected === "false")).toBe(true);
  });

  test("Shift + クリックで、直前に押した行からまとめて入る", async () => {
    ready();
    await flush();
    rows()[0]?.click();
    await flush();
    rows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(state).toMatchObject({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }] });
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "true", "true"]);
  });

  test("✎ で直した文字はテロップの文字になる", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.querySelector<HTMLElement>("[data-role='line-edit-button']")?.click();
    const edit = document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']")!;
    edit.value = "ここは絶対に右から回るべきだった";
    edit.dispatchEvent(new Event("input"));
    edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "ここは絶対に右から回るべきだった", lineId: "youtube-asr:4.00" }] });
    expect(rows()[1]?.querySelector("[data-role='line-text']")?.textContent).toBe("ここは絶対に右から回るべきだった");
  });

  test("「字幕に出さない」でテロップの文字が空になり、もう一度で戻る", async () => {
    ready();
    await flush();
    rows()[2]?.click();
    await flush();
    rows()[2]?.querySelector<HTMLElement>("[data-role='hide-telop']")?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "", lineId: "youtube-asr:7.00" }] });
    expect(rows()[2]?.dataset.hidden).toBe("true");
    rows()[2]?.querySelector<HTMLElement>("[data-role='hide-telop']")?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "えーと" }] });
  });

  test("録画中は行を押しても送らず、時刻を押しても動画を動かさない", async () => {
    ready();
    await flush();
    emit({ kind: "recording", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    events = [];
    const video = document.querySelector("video")!;
    video.currentTime = 0;
    rows()[0]?.click();
    rows()[2]?.querySelector<HTMLElement>("[data-role='line-time']")?.click();
    await flush();
    expect(events).toEqual([]);
    expect(video.currentTime).toBe(0);
  });

  test("録画した後 (preview) は欄が薄く、撮り直し (ready) に戻るとすぐ押せる", async () => {
    ready();
    await flush();
    const panel = document.querySelector<HTMLElement>("[data-role='transcript']")!;
    emit({ kind: "preview", clipId: "c", mimeType: "video/mp4", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    expect(panel.style.opacity).toBe("0.5");
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    expect(panel.style.opacity).toBe("1");
    events = [];
    rows()[0]?.click();
    await flush();
    expect(events.map((event) => event.type)).toEqual(["SET_CLIP"]);
  });

  test("上限の秒数を超える区間になるなら、送らずに理由を出す", async () => {
    // 2 秒の行を 1 秒おきに 40 行 (0〜119 秒)。まとめて選ぶと 1 区間が 60 秒を超える
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, startSec: i * 3, endSec: i * 3 + 2, text: `行 ${i}` }));
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: many },
    });
    await flush();
    rows()[0]?.click();
    await flush();
    events = [];
    rows()[39]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(events).toEqual([]);
    expect(document.body.textContent).toContain("1 つの区間は 60 秒までです");
  });

  test("拒まれた Shift + クリックでは、起点を動かさない", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, startSec: i * 3, endSec: i * 3 + 2, text: `行 ${i}` }));
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: many },
    });
    await flush();
    rows()[0]?.click();
    await flush();
    rows()[39]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    rows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(state).toMatchObject({ kind: "ready", segments: [{ startSec: 0, endSec: 8.3 }] });
  });

  test("答えを待たずに続けて押しても、先に押した行は消えない", async () => {
    ready();
    await flush();
    rows()[0]?.click();
    rows()[2]?.click();
    await flush();
    expect(state).toMatchObject({
      kind: "ready",
      segments: [
        { startSec: 0.8, endSec: 3.3 },
        { startSec: 6.8, endSec: 9.3 },
      ],
    });
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "false", "true"]);
  });

  test("やり直せる区間を持つ失敗の間は、欄が薄く、押しても送らない", async () => {
    ready();
    await flush();
    emit({
      kind: "failed",
      reason: "recording-aborted",
      segments: [{ startSec: 10, endSec: 20 }],
      telops: [{ startSec: 11, endSec: 12, text: "手" }],
      meta: META,
    });
    await flush();
    events = [];
    expect(document.querySelector<HTMLElement>("[data-role='transcript']")?.style.opacity).toBe("0.5");
    rows()[0]?.click();
    await flush();
    expect(events).toEqual([]);
  });

  test("直した行を続けて 2 回押す (外して入れ直す) と、直した文字に戻る", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.querySelector<HTMLElement>("[data-role='line-edit-button']")?.click();
    const edit = document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']")!;
    edit.value = "直した";
    edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "直した", lineId: "youtube-asr:4.00" }] });
  });

  test("最後の行を外すと手で足したテロップまで消えるときは、送らずに理由を出す (見出しの ✕ と同じ)", async () => {
    ready();
    await flush();
    emit({
      kind: "ready",
      segments: [{ startSec: 3.8, endSec: 6.3 }],
      telops: [
        { startSec: 4, endSec: 6, text: "ここは絶対に右から", lineId: "youtube-asr:4.00" },
        { startSec: 4.5, endSec: 5.5, text: "手で打った大事な文言" },
      ],
      meta: META,
    });
    await flush();
    events = [];
    rows()[1]?.click();
    await flush();
    expect(events).toEqual([]);
    expect(document.body.textContent).toContain("テロップが 1 件残っています。先にテロップを消してください");
  });

  test("＋ 区間を追加で作った区間は、欄で離れた行を押しても変わらない", async () => {
    ready();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 100, endSec: 115 }], telops: [], meta: META });
    await flush();
    rows()[0]?.click();
    await flush();
    expect(state).toMatchObject({ segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 100, endSec: 115 }] });
  });

  test("取れなかったら理由と「もう一度取る」を出し、押すと取り直す", async () => {
    fake.onChange?.({ kind: "failed", videoId: "video-a", reason: "字幕が空で返りました" });
    await flush();
    expect(document.querySelector("[data-role='transcript-notice']")?.textContent).toContain("字幕が空で返りました");
    document.querySelector<HTMLElement>("[data-role='transcript-retry']")?.click();
    expect(fake.retry).toHaveBeenCalled();
  });

  test("吹き替えの音声が流れていれば欄に知らせる", async () => {
    ready(true);
    await flush();
    expect(document.querySelector("[data-role='transcript-dubbed']")?.textContent).toContain("吹き替えの音声が流れています");
  });

  test("届かなかった SET_CLIP は待たない。ほかの経路で足した区間を、欄の次の操作で消さない", async () => {
    ready();
    await flush();
    failNext = true;
    rows()[0]?.click();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 200, endSec: 215 }], telops: [], meta: META });
    await flush();
    rows()[2]?.click();
    await flush();
    expect(state).toMatchObject({
      segments: [
        { startSec: 6.8, endSec: 9.3 },
        { startSec: 200, endSec: 215 },
      ],
    });
  });
});

describe("詰める欄 (段階 1c-1)", () => {
  const WORD_LINES = [
    {
      id: "youtube-asr:1.00",
      startSec: 1,
      endSec: 3,
      text: "さあ残り 30 秒",
      words: [
        { startSec: 1, endSec: 1.8, text: "さあ" },
        { startSec: 1.8, endSec: 2.4, text: "残り" },
        { startSec: 2.4, endSec: 3, text: "30 秒" },
      ],
    },
  ];

  function readyWithWords(): void {
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: WORD_LINES },
    });
  }

  test("行を押すと、その区間の単語が詰める欄に並ぶ", async () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 600 });
    try {
      readyWithWords();
      await flush();
      rows()[0]?.click();
      await flush();

      const words = [...document.querySelectorAll<HTMLElement>("#yt-clip-bar [data-role='trim-word']")];
      expect(words.map((word) => word.textContent)).toEqual(["さあ", "残り", "30 秒"]);
    } finally {
      delete (video as { duration?: number }).duration;
    }
  });

  test("答えを待たずに続けて押すと、詰める欄は後に押した行の区間を開く", async () => {
    // 先に押した行の答えが、後の行を送った後に届く。その答えには後の行の区間がまだ無いが、選びたい区間を忘れない
    ready();
    await flush();
    rows()[0]?.click();
    rows()[2]?.click();
    await flush();

    const title = document.querySelector("#yt-clip-bar [data-role='trim-title']")?.textContent;
    expect(title).toBe("区間 2 を詰める");
  });
});

describe("区間の見出し (段階 1c-2)", () => {
  const headers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#yt-clip-list [data-role='segment']")];

  test("行を押すと、その行の上に区間の見出しが出て、詰めている区間に印が付く", async () => {
    ready();
    await flush();
    rows()[1]!.click();
    await flush();
    const list = document.querySelector<HTMLElement>("[data-role='transcript-lines']")!;
    const order = [...list.children].map((child) => (child as HTMLElement).dataset.role);
    expect(order).toEqual(["line", "segment", "line", "line"]);
    expect(headers()[0]?.querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1 · 詰めている");
  });

  test("見出しを押すとその区間を詰める欄で詰める", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    // 3 秒より空いていないので 1 つに繋がらないよう、離れた区間を状態で作る
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 6.8, endSec: 9.3 }],
      telops: [],
      meta: META,
    });
    await flush();
    headers()[0]!.click();
    await flush();
    expect(document.querySelector("[data-role='trim-title']")?.textContent).toBe("区間 1 を詰める");
    expect(headers()[0]?.dataset.selected).toBe("true");
    expect(headers()[1]?.dataset.selected).toBe("false");
  });

  test("見出しの ✕ でその区間を消す", async () => {
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 6.8, endSec: 9.3 }],
      telops: [],
      meta: META,
    });
    await flush();
    events = [];
    headers()[1]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    // 区間を消した後、区間から外れた行のテロップを揃える SET_CLIP が続くことがある (syncLineTelops)
    expect(events[0]).toEqual({ type: "REMOVE_SEGMENT", index: 1 });
    expect(headers()).toHaveLength(1);
  });
});

describe("手入力の行 (段階 1c-2・ADR 0003)", () => {
  const manualRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#yt-clip-list [data-role='telop']")];
  const addButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("#yt-clip-list [data-role='add-telop']")!;
  const lineEditor = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']");
  const video = (): HTMLVideoElement => document.querySelector<HTMLVideoElement>("video")!;

  test("頭を尻より後ろにして理由を出した後、正しく頭を今にすると、理由を消して区間の範囲の文言に戻す", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    const setStart = (): HTMLElement => manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-start']")!;
    const status = (): string | null => document.querySelector("#yt-clip-bar-status")?.textContent ?? null;
    video().currentTime = 9;
    setStart().click();
    expect(status()).toBe("開始は終了より前にしてください");
    video().currentTime = 6;
    setStart().click();
    expect(status()).toBe("0:00 〜 0:09 (9秒)");
    // 答え (setTimeout で届く ready) を描き終えてから次へ。残すと次のテストの idle を上書きする
    await flush();
  });

  test("区間が無いと押せない", async () => {
    ready();
    await flush();
    expect(addButton().disabled).toBe(true);
  });

  test("押すと今の位置から 3 秒のテロップを足し、行の時刻順の並びに入って文字を打つ欄が開く", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    Object.defineProperty(video(), "duration", { configurable: true, value: 600 });
    video().currentTime = 5;
    events = [];
    try {
      addButton().click();
      await flush();
    } finally {
      // 後のテストに長さを持ち越さない
      delete (video() as { duration?: number }).duration;
    }
    expect(events).toEqual([{ type: "ADD_TELOP", telop: { startSec: 5, endSec: 8, text: "" } }]);
    const list = document.querySelector<HTMLElement>("[data-role='transcript-lines']")!;
    const order = [...list.children].map((child) => {
      const el = child as HTMLElement;
      return el.dataset.role === "line" ? el.dataset.lineId : el.dataset.role;
    });
    // 5 秒は 4〜6 秒の行の後、7 秒の行の前
    expect(order).toEqual(["segment", "youtube-asr:1.00", "youtube-asr:4.00", "telop", "youtube-asr:7.00"]);
    expect(lineEditor()).not.toBeNull();
    expect(document.activeElement).toBe(lineEditor());
  });

  test("打って Enter でテロップの文字にする", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "" }], meta: META });
    await flush();
    events = [];
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='manual-edit-button']")!.click();
    lineEditor()!.value = "ここ重要";
    lineEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(events).toEqual([{ type: "UPDATE_TELOP", index: 0, telop: { startSec: 5, endSec: 8, text: "ここ重要" } }]);
  });

  test("頭を今に・尻を今に・✕", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    events = [];
    video().currentTime = 6;
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-start']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "UPDATE_TELOP", index: 0, telop: { startSec: 6, endSec: 8, text: "あ" } });
    video().currentTime = 7;
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-end']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "UPDATE_TELOP", index: 0, telop: { startSec: 6, endSec: 7, text: "あ" } });
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "REMOVE_TELOP", index: 0 });
    expect(manualRows()).toHaveLength(0);
  });

  test("文字起こしを取り直しても手入力の行は残る", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    ready();
    await flush();
    expect(manualRows()).toHaveLength(1);
  });

  test("行から作ったテロップは手入力の行にしない", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    expect(manualRows()).toHaveLength(0);
  });

  test("見出しの ✕ で区間を消すと、その行のテロップも消える (区間に入っている行 = テロップが出る)", async () => {
    ready();
    await flush();
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 6.8, endSec: 9.3 }],
      telops: [
        { startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" },
        { startSec: 7, endSec: 9, text: "えーと", lineId: "youtube-asr:7.00" },
      ],
      meta: META,
    });
    await flush();
    events = [];
    document.querySelectorAll<HTMLElement>("#yt-clip-list [data-role='segment']")[1]!
      .querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events.map((event) => event.type)).toEqual(["REMOVE_SEGMENT", "SET_CLIP"]);
    expect(events[1]).toMatchObject({ telops: [{ lineId: "youtube-asr:1.00" }] });
    expect(manualRows()).toHaveLength(0);
  });

  test("詰めて区間を広げ、隣の行が入るとテロップができ、狭めて外すと消える。直した文字は戻る", async () => {
    ready();
    await flush();
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }],
      telops: [{ startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" }],
      meta: META,
    });
    await flush();
    events = [];
    // 拡大バーのハンドルで尻を 6.3 まで広げた答え (ADJUST_SEGMENT) が描かれた
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 6.3 }],
      telops: [{ startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" }],
      meta: META,
    });
    await flush();
    expect(events).toEqual([
      expect.objectContaining({
        type: "SET_CLIP",
        telops: [
          { startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" },
          // 文字は、この動画の間に前のテストで直した文字を覚えていればそれになる (syncLineTelops の remembered)
          expect.objectContaining({ startSec: 4, endSec: 6, lineId: "youtube-asr:4.00" }),
        ],
      }),
    ]);
    expect(rows()[1]!.querySelector("[data-role='line-edit-button']")).not.toBeNull();

    // 直してから狭めて外し、また広げる
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 6.3 }],
      telops: [
        { startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" },
        { startSec: 4, endSec: 6, text: "直した", lineId: "youtube-asr:4.00" },
      ],
      meta: META,
    });
    await flush();
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }],
      telops: [
        { startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" },
        { startSec: 4, endSec: 6, text: "直した", lineId: "youtube-asr:4.00" },
      ],
      meta: META,
    });
    await flush();
    expect(state.kind === "ready" && state.telops.map((telop) => telop.lineId)).toEqual(["youtube-asr:1.00"]);
    emit({ ...state, segments: [{ startSec: 0.8, endSec: 6.3 }] } as ClipState);
    await flush();
    expect(state.kind === "ready" && state.telops.map((telop) => telop.text)).toEqual(["さあ残り 30 秒", "直した"]);
  });

  test("行を押した答えを待つ間は、手入力の行を位置で指して変えない (詰まった位置で別のテロップを書き換えない)", async () => {
    // テロップが [X (行 1 の字幕), A (手入力)]。行 1 を外す SET_CLIP が先に効くと A は位置 0 に詰まり、
    // 古い位置 1 で送った UPDATE_TELOP は後ろの別のテロップを上書きするか、状態機械を internal-error に落とす
    ready();
    await flush();
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 9.3 }],
      telops: [
        { startSec: 1, endSec: 3, text: "さあ残り 30 秒", lineId: "youtube-asr:1.00" },
        { startSec: 5, endSec: 8, text: "あ" },
      ],
      meta: META,
    });
    await flush();
    events = [];
    rows()[0]!.click();
    // 答えを待たずに押す
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-start']")!.click();
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    expect(events.map((event) => event.type)).toEqual(["SET_CLIP"]);
    expect(document.getElementById("yt-clip-bar-status")?.textContent).toBe(
      "前の操作の答えを待っています。少し待ってからもう一度押してください",
    );
    await flush();
    // 答えが描かれた後は押せる (A は位置 0 に詰まっている)
    events = [];
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events).toEqual([{ type: "REMOVE_TELOP", index: 0 }]);
  });

  test("手入力の行を変えた答えを待つ間は、行を押しても古い写しで丸ごと差し替えない", async () => {
    ready();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    events = [];
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    rows()[1]!.click();
    expect(events.map((event) => event.type)).toEqual(["REMOVE_TELOP"]);
    await flush();
    events = [];
    rows()[1]!.click();
    await flush();
    expect(events.map((event) => event.type)).toEqual(["SET_CLIP"]);
  });

  test("位置で指す操作が拒まれて通知が来なくても、待ったままにならない (別のタブで状態が先に変わっていたとき)", async () => {
    ready();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    // 別のタブでテロップが消えた。このタブには通知が届かず、描いた状態は古いまま
    state = { kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [], meta: META };
    events = [];
    // 位置 0 のテロップは router にはもう無いので拒まれ、通知は来ない
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events).toEqual([{ type: "REMOVE_TELOP", index: 0 }]);
    // 少し待っても通知が来なければ、応答の状態を描いて待つのをやめる
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await flush();
    expect(manualRows()).toHaveLength(0);
    events = [];
    rows()[1]!.click();
    await flush();
    expect(events.map((event) => event.type)).toEqual(["SET_CLIP"]);
  });
});

