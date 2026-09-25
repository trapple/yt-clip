// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Message } from "@/shared/messages";

/**
 * オフのまま動画ページで読み込まれた content script (マスタースイッチの spec §1 / §2.1)。
 *
 * youtube.ts は import した時点で保存されたオン / オフを読むので、オンで読ませる youtube.test.ts とは別のファイルにする
 * (vitest はファイルごとにモジュールを読み直す)。**オフなら何も呼ばない**: 要素・listener・observer・rAF・メッセージが 0 で、
 * 残るのは chrome.storage の読み 1 回と onChanged の listener 1 本だけ
 */

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

const sent: Message[] = [];
const storageListeners: StorageListener[] = [];
let messageListeners = 0;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function ourElements(): number {
  return document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length;
}

// import の前に張る (import 時に張られたものも数える)。どれも本物へ通す
const documentAdd = vi.spyOn(document, "addEventListener");
const windowAdd = vi.spyOn(window, "addEventListener");
const observe = vi.spyOn(MutationObserver.prototype, "observe");
const frame = vi.spyOn(window, "requestAnimationFrame");

beforeAll(async () => {
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
  // jsdom は ResizeObserver を持たない。オンにした項目 (start) が作る
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key?: string): Promise<Record<string, unknown>> =>
          key === "enabled" ? { enabled: false } : {},
        set: async (): Promise<void> => undefined,
      },
      sync: {
        get: async (): Promise<Record<string, unknown>> => ({}),
        set: async (): Promise<void> => undefined,
      },
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListeners.push(fn);
        },
        removeListener: (fn: StorageListener): void => {
          const index = storageListeners.indexOf(fn);
          if (index >= 0) storageListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (): void => {
          messageListeners += 1;
        },
        removeListener: (): void => {
          messageListeners -= 1;
        },
      },
      sendMessage: async (message: Message): Promise<{ state: { kind: "idle" } }> => {
        sent.push(message);
        return { state: { kind: "idle" } };
      },
    },
  });

  await import("@/content/youtube");
  await flush();
});

afterAll(async () => {
  // オンにした項目の後始末。オフにすれば observer も listener も外れる (以前は body を差し替えて終えていた)
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: false } }, "local");
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("オフのまま読み込む", () => {
  test("ページに何も足さず、YouTube の要素の中にも何も差さない", () => {
    expect(ourElements()).toBe(0);
    expect(document.getElementById("below")?.childElementCount).toBe(0);
    expect(document.getElementById("secondary-inner")?.childElementCount).toBe(0);
    expect(document.querySelector(".ytp-progress-bar")?.childElementCount).toBe(0);
  });

  test("document / window の listener・MutationObserver・rAF を張らない", () => {
    const documentTypes = documentAdd.mock.calls.map(([type]) => type);
    const windowTypes = windowAdd.mock.calls.map(([type]) => type);
    expect(documentTypes).not.toContain("fullscreenchange");
    expect(windowTypes).not.toContain("resize");
    expect(observe).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });

  test("service worker へ何も送らず、onMessage も張らない。storage の見張りはスイッチの 1 本だけ", () => {
    expect(sent).toEqual([]);
    expect(messageListeners).toBe(0);
    expect(storageListeners).toHaveLength(1);
  });

  test("オンに書き換わると start() が走り、窓を作って content/loaded を送る", async () => {
    for (const listener of [...storageListeners]) listener({ enabled: { newValue: true } }, "local");
    await flush();

    expect(sent).toContainEqual({ type: "content/loaded" });
    expect(messageListeners).toBe(1);
    expect(document.getElementById("yt-clip-bar-window")).not.toBeNull();
    expect(document.getElementById("yt-clip-dock-below")?.parentElement?.id).toBe("below");
  });
});
