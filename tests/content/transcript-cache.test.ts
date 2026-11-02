import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_CACHED_TRANSCRIPTS,
  TRANSCRIPT_INDEX_KEY,
  fitToBudget,
  isTranscript,
  loadTranscript,
  saveTranscript,
  type TranscriptStorage,
} from "@/content/transcript-cache";
import type { Transcript } from "@/shared/transcript";

afterEach(() => {
  vi.restoreAllMocks();
});

function memoryStorage(initial: Record<string, unknown> = {}, quota = Infinity) {
  const data: Record<string, unknown> = { ...initial };
  const storage: TranscriptStorage = {
    get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (items) => {
      const next = { ...data, ...items };
      const transcripts = Object.keys(next).filter((key) => key.startsWith("transcript:")).length;
      if (transcripts > quota) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(data, items);
    },
    remove: async (keys) => {
      for (const key of keys) delete data[key];
    },
  };
  return { data, storage };
}

function transcript(videoId: string, savedAt: number, lines = 1): Transcript {
  return {
    videoId,
    source: "youtube-asr",
    language: "ja",
    savedAt,
    lines: Array.from({ length: lines }, (_, i) => ({
      id: `youtube-asr:${i}.00`,
      startSec: i,
      endSec: i + 1,
      text: `行 ${i}`,
      words: [{ startSec: i, endSec: i + 1, text: `行 ${i}` }],
    })),
  };
}

describe("saveTranscript / loadTranscript", () => {
  test("保存したものを読める。索引は新しい順", async () => {
    const { storage, data } = memoryStorage();
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    expect(await loadTranscript("a", storage)).toEqual(transcript("a", 1));
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "b", savedAt: 2 },
      { videoId: "a", savedAt: 1 },
    ]);
  });

  test("同じ動画を保存し直すと索引の先頭へ移り、重ならない", async () => {
    const { storage, data } = memoryStorage();
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    await saveTranscript(transcript("a", 3), storage);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "a", savedAt: 3 },
      { videoId: "b", savedAt: 2 },
    ]);
  });

  test(`${MAX_CACHED_TRANSCRIPTS + 1} 本目で最も古いものを消す`, async () => {
    const { storage, data } = memoryStorage();
    for (let i = 0; i <= MAX_CACHED_TRANSCRIPTS; i += 1) await saveTranscript(transcript(`v${i}`, i), storage);
    expect(data["transcript:v0"]).toBeUndefined();
    expect(data["transcript:v1"]).toBeDefined();
    expect(data[TRANSCRIPT_INDEX_KEY]).toHaveLength(MAX_CACHED_TRANSCRIPTS);
  });

  test("容量が足りなければ古いものから消して入れ直す", async () => {
    const { storage, data } = memoryStorage({}, 2);
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    await saveTranscript(transcript("c", 3), storage);
    expect(Object.keys(data).filter((key) => key.startsWith("transcript:")).sort()).toEqual([
      "transcript:b",
      "transcript:c",
    ]);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "c", savedAt: 3 },
      { videoId: "b", savedAt: 2 },
    ]);
  });

  test("容量以外の失敗では、古いものを消さずにそのまま throw する", async () => {
    const { storage, data } = memoryStorage();
    await saveTranscript(transcript("a", 1), storage);
    const failing: TranscriptStorage = {
      ...storage,
      set: async () => {
        throw new Error("Extension context invalidated.");
      },
    };
    await expect(saveTranscript(transcript("b", 2), failing)).rejects.toThrow("Extension context invalidated.");
    expect(data["transcript:a"]).toBeDefined();
  });

  test("消せるものが無くても入らなければ throw する", async () => {
    const { storage } = memoryStorage({}, 0);
    await expect(saveTranscript(transcript("a", 1), storage)).rejects.toThrow("QUOTA");
  });

  test("無いものは null", async () => {
    const { storage } = memoryStorage();
    expect(await loadTranscript("nothing", storage)).toBeNull();
  });

  test("壊れた保存値は warn を残して null (取り直す)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage } = memoryStorage({ "transcript:a": { videoId: "a", lines: "broken" } });
    expect(await loadTranscript("a", storage)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("保存された文字起こしが読めない"));
  });

  test("索引が壊れていても保存できる (索引を作り直す)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage, data } = memoryStorage({ [TRANSCRIPT_INDEX_KEY]: "broken" });
    await saveTranscript(transcript("a", 1), storage);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([{ videoId: "a", savedAt: 1 }]);
  });
});

describe("fitToBudget", () => {
  test("収まるならそのまま", () => {
    const value = transcript("a", 1, 3);
    expect(fitToBudget(value, 1_000_000)).toBe(value);
  });

  test("収まらなければ単語の時刻を落とす", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = transcript("a", 1, 3);
    const withoutWordsSize = new TextEncoder().encode(
      JSON.stringify({ ...value, lines: value.lines.map(({ id, startSec, endSec, text }) => ({ id, startSec, endSec, text })) }),
    ).length;
    const fitted = fitToBudget(value, withoutWordsSize);
    expect(fitted.lines).toHaveLength(3);
    expect(fitted.lines.every((line) => line.words === undefined)).toBe(true);
  });

  test("それでも収まらなければ後ろの行を落とす", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fitted = fitToBudget(transcript("a", 1, 100), 2000);
    expect(fitted.lines.length).toBeGreaterThan(0);
    expect(fitted.lines.length).toBeLessThan(100);
    expect(fitted.lines[0]?.id).toBe("youtube-asr:0.00");
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(2000);
  });
});

test("isTranscript", () => {
  expect(isTranscript(transcript("a", 1))).toBe(true);
  expect(isTranscript({ ...transcript("a", 1), source: "other" })).toBe(false);
  expect(isTranscript({ ...transcript("a", 1), lines: [{ id: "x", startSec: "0", endSec: 1, text: "" }] })).toBe(false);
  expect(isTranscript(null)).toBe(false);
});
