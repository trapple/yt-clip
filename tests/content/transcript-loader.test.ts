import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createTranscriptLoader,
  transcriptLogLine,
  type LoaderDeps,
  type TranscriptStatus,
} from "@/content/transcript-loader";
import type { OfficialResult } from "@/content/caption-source";
import type { Transcript } from "@/shared/transcript";

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const transcript = (videoId: string): Transcript => ({
  videoId,
  source: "youtube-asr",
  language: "ja",
  savedAt: 1,
  lines: [{ id: "youtube-asr:1.00", startSec: 1, endSec: 2, text: "こんにちは" }],
});

/** 手で解決できる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<LoaderDeps> = {}) {
  const statuses: TranscriptStatus[] = [];
  const saved: Transcript[] = [];
  const fetchOfficial = vi.fn(
    async (videoId: string): Promise<OfficialResult> => ({ kind: "ready", transcript: transcript(videoId), dubbed: false }),
  );
  const deps: LoaderDeps = {
    loadCached: async () => null,
    save: async (value) => {
      saved.push(value);
    },
    fetchOfficial,
    readDubbed: async () => true,
    onChange: (status) => statuses.push(status),
    ...overrides,
  };
  return { loader: createTranscriptLoader(deps), statuses, saved, fetchOfficial };
}

describe("createTranscriptLoader", () => {
  test("保存に無ければ取りに行き、ready にして保存する", async () => {
    const { loader, statuses, saved } = setup();
    loader.load("a");
    await flush();
    expect(statuses).toEqual([
      { kind: "loading", videoId: "a" },
      { kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false },
    ]);
    expect(saved).toEqual([transcript("a")]);
  });

  test("保存にあればそれを使い、吹き替えの判定だけ読む", async () => {
    const { loader, statuses, fetchOfficial } = setup({ loadCached: async (id) => transcript(id) });
    loader.load("a");
    await flush();
    expect(fetchOfficial).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: true });
  });

  test("保存から読めたら、吹き替えの判定を待たずに ready を出し、判定が返ったら出し直す", async () => {
    const dubbed = deferred<boolean>();
    const { loader, statuses } = setup({ loadCached: async (id) => transcript(id), readDubbed: () => dubbed.promise });
    loader.load("a");
    await flush();
    expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false });
    dubbed.resolve(true);
    await flush();
    expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: true });
  });

  test("保存から読めて吹き替えでなければ、ready は 1 回だけ", async () => {
    const { loader, statuses } = setup({ loadCached: async (id) => transcript(id), readDubbed: async () => false });
    loader.load("a");
    await flush();
    expect(statuses.filter((status) => status.kind === "ready")).toHaveLength(1);
  });

  test("判定を待つ間に別の動画へ移ったら、前の動画の判定で出し直さない", async () => {
    const dubbed = deferred<boolean>();
    const { loader, statuses } = setup({
      loadCached: async (id) => transcript(id),
      readDubbed: (id) => (id === "a" ? dubbed.promise : Promise.resolve(false)),
    });
    loader.load("a");
    await flush();
    loader.load("b");
    await flush();
    dubbed.resolve(true);
    await flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", videoId: "b", dubbed: false });
  });

  test("保存から読んだとき、吹き替えの判定が読めなければ偽にし、warn を残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader, statuses } = setup({
      loadCached: async (id) => transcript(id),
      readDubbed: async () => {
        throw new Error("no player");
      },
    });
    loader.load("a");
    await flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", dubbed: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("吹き替えの判定を読めませんでした: Error: no player"));
  });

  test("同じ動画で何度呼ばれても 1 回だけ (mount は DOM の変化のたびに呼ばれる)。失敗しても繰り返さない", async () => {
    const failing = vi.fn(async (): Promise<OfficialResult> => {
      throw new Error("字幕が空で返りました");
    });
    const { loader } = setup({ fetchOfficial: failing });
    loader.load("a");
    loader.load("a");
    await flush();
    loader.load("a");
    await flush();
    expect(loader.status()).toEqual({ kind: "failed", videoId: "a", reason: "字幕が空で返りました" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  test("retry は失敗した動画をもう一度取る", async () => {
    let fail = true;
    const { loader, statuses } = setup({
      fetchOfficial: async (videoId) => {
        if (fail) throw new Error("x");
        return { kind: "ready", transcript: transcript(videoId), dubbed: false };
      },
    });
    loader.load("a");
    await flush();
    fail = false;
    loader.retry();
    await flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", videoId: "a" });
  });

  test("字幕が無ければ none (保存しない)", async () => {
    const { loader, statuses, saved } = setup({ fetchOfficial: async () => ({ kind: "none", dubbed: true }) });
    loader.load("a");
    await flush();
    expect(statuses.at(-1)).toEqual({ kind: "none", videoId: "a", dubbed: true });
    expect(saved).toEqual([]);
  });

  test("取っている間に別の動画へ移ったら、前の動画の結末は捨てる", async () => {
    const first = deferred<OfficialResult>();
    const { loader, statuses } = setup({
      fetchOfficial: async (videoId) =>
        videoId === "a" ? first.promise : { kind: "ready", transcript: transcript(videoId), dubbed: false },
    });
    loader.load("a");
    await flush();
    loader.load("b");
    await flush();
    first.resolve({ kind: "ready", transcript: transcript("a"), dubbed: false });
    await flush();
    expect(statuses.map((status) => ("videoId" in status ? `${status.kind}:${status.videoId}` : status.kind))).toEqual([
      "loading:a",
      "loading:b",
      "ready:b",
    ]);
  });

  test("reset と別の動画への移動は、走っている取得を中止する (signal が aborted)", async () => {
    const signals: AbortSignal[] = [];
    const { loader } = setup({
      fetchOfficial: (_videoId, signal) => {
        signals.push(signal);
        return new Promise<OfficialResult>(() => undefined);
      },
    });
    loader.load("a");
    await flush();
    loader.load("b");
    await flush();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    loader.reset();
    expect(signals[1]?.aborted).toBe(true);
  });

  test("reset の後に届いた結末は捨て、知らせない", async () => {
    const first = deferred<OfficialResult>();
    const { loader, statuses } = setup({ fetchOfficial: async () => first.promise });
    loader.load("a");
    await flush();
    loader.reset();
    first.resolve({ kind: "ready", transcript: transcript("a"), dubbed: false });
    await flush();
    expect(statuses).toEqual([{ kind: "loading", videoId: "a" }]);
    expect(loader.status()).toEqual({ kind: "idle" });
  });

  test("保存に失敗しても ready のまま。warn を残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader } = setup({
      save: async () => {
        throw new Error("QUOTA");
      },
    });
    loader.load("a");
    await flush();
    expect(loader.status()).toMatchObject({ kind: "ready" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("文字起こしを保存できませんでした"));
  });
});

describe("transcriptLogLine", () => {
  test("結末ごとの 1 行。途中 (idle / loading) は出さない", () => {
    expect(transcriptLogLine({ kind: "idle" })).toBeNull();
    expect(transcriptLogLine({ kind: "loading", videoId: "a" })).toBeNull();
    expect(transcriptLogLine({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false })).toBe(
      "[yt-clip] 文字起こし: 公式字幕 (自動) 1 行",
    );
    expect(
      transcriptLogLine({ kind: "ready", videoId: "a", transcript: { ...transcript("a"), source: "youtube-manual" }, dubbed: true }),
    ).toBe("[yt-clip] 文字起こし: 公式字幕 1 行 (吹き替えの音声が流れています)");
    expect(transcriptLogLine({ kind: "none", videoId: "a", dubbed: false })).toBe(
      "[yt-clip] 文字起こし: この動画には公式字幕がありません",
    );
    expect(transcriptLogLine({ kind: "failed", videoId: "a", reason: "字幕が空で返りました" })).toBe(
      "[yt-clip] 文字起こしを取れませんでした: 字幕が空で返りました",
    );
  });
});
