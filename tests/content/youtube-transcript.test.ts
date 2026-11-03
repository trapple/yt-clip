// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptStatus } from "@/content/transcript-loader";
import type { Message } from "@/shared/messages";

/**
 * youtube.ts が文字起こしの loader を使うこと (段階 1a)。loader の中身は transcript-loader.test.ts で見るので、
 * ここでは偽物に差し替えて、いつ何を頼むかだけを見る
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

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
const storageListeners: StorageListener[] = [];

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setEnabled(enabled: boolean): void {
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: enabled } }, "local");
}

beforeAll(async () => {
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
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
        get: async (key?: string): Promise<Record<string, unknown>> => (key === "enabled" ? { enabled: true } : {}),
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
      onMessage: { addListener: (): void => undefined, removeListener: (): void => undefined },
      sendMessage: async (_message: Message): Promise<{ state: { kind: "idle" } }> => ({ state: { kind: "idle" } }),
    },
  });
  await import("@/content/youtube");
  await flush();
});

afterAll(async () => {
  setEnabled(false);
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("文字起こし (段階 1a)", () => {
  test("動画ページで動き出すと、その動画の文字起こしを頼む", () => {
    expect(fake.load).toHaveBeenCalledWith("video-a");
  });

  test("結末をコンソールに 1 行出す。途中は出さない", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    fake.onChange?.({ kind: "loading", videoId: "video-a" });
    fake.onChange?.({ kind: "failed", videoId: "video-a", reason: "字幕が空で返りました" });
    expect(info.mock.calls).toEqual([["[yt-clip] 文字起こしを取れませんでした: 字幕が空で返りました"]]);
    info.mockRestore();
  });

  test("オフにすると loader を止め、その後の結末は出さない", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    setEnabled(false);
    await flush();
    expect(fake.reset).toHaveBeenCalled();
    fake.onChange?.({ kind: "none", videoId: "video-a", dubbed: false });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
    setEnabled(true);
    await flush();
  });
});
