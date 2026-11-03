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

function memoryStorage(initial: Record<string, unknown> = {}, quota = Infinity, listable = true) {
  const data: Record<string, unknown> = { ...initial };
  const storage: TranscriptStorage = {
    keys: () => (listable ? Promise.resolve(Object.keys(data)) : null),
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

  test("保存のたびに、索引から漏れた文字起こしを消す (prefix の違う鍵と索引にある鍵は残す)", async () => {
    const { storage, data } = memoryStorage({
      "transcript:a": transcript("a", 1),
      "transcript:orphan": transcript("orphan", 0),
      transcriptIndex: [{ videoId: "a", savedAt: 1 }],
      windowLayout: { kept: true },
    });
    await saveTranscript(transcript("b", 2), storage);
    expect(Object.keys(data).sort()).toEqual(["transcript:a", "transcript:b", "transcriptIndex", "windowLayout"]);
  });

  test("鍵の一覧を取れない環境では掃除を飛ばす", async () => {
    const { storage, data } = memoryStorage({ "transcript:orphan": transcript("orphan", 0) }, Infinity, false);
    await saveTranscript(transcript("b", 2), storage);
    expect(data["transcript:orphan"]).toBeDefined();
  });

  test("掃除の直前に別のタブが書いた索引の鍵は消さない", async () => {
    const { storage, data } = memoryStorage({});
    const racing: TranscriptStorage = {
      ...storage,
      keys: () => {
        // 鍵を数えた直後に、別のタブが c を保存して索引に載せた
        data["transcript:c"] = transcript("c", 3);
        data.transcriptIndex = [{ videoId: "c", savedAt: 3 }, { videoId: "b", savedAt: 2 }];
        return Promise.resolve(Object.keys(data));
      },
    };
    await saveTranscript(transcript("b", 2), racing);
    expect(data["transcript:c"]).toBeDefined();
    expect(data["transcript:b"]).toBeDefined();
  });

  test("掃除に失敗しても保存は通す (warn を残す)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage, data } = memoryStorage();
    const failing: TranscriptStorage = { ...storage, keys: () => Promise.reject(new Error("boom")) };
    await saveTranscript(transcript("b", 2), failing);
    expect(data["transcript:b"]).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
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

  test("収まらない文字起こしは保存しない。前に保存したものも消す (開くたびに取る)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage, data } = memoryStorage({ "transcript:a": transcript("a", 1, 1) });
    await saveTranscript(transcript("a", 2, 100), storage, 2000);
    expect(data["transcript:a"]).toBeUndefined();
    expect(await loadTranscript("a", storage)).toBeNull();
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

  test("行の id が重なった保存 (古い版で保存した) は読まない。取り直させる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = transcript("a", 1, 2);
    const doubled: Transcript = { ...base, lines: base.lines.map((line) => ({ ...line, id: "youtube-asr:0.00" })) };
    expect(isTranscript(doubled)).toBe(false);
    const { storage } = memoryStorage({ "transcript:a": doubled });
    expect(await loadTranscript("a", storage)).toBeNull();
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
    expect(fitted?.lines).toHaveLength(3);
    expect(fitted?.lines.every((line) => line.words === undefined)).toBe(true);
  });

  test("単語の時刻を落としても収まらなければ null (行を落として保存すると、開き直したとき欄が途中で終わる)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(fitToBudget(transcript("a", 1, 100), 2000)).toBeNull();
  });
});

test("isTranscript", () => {
  expect(isTranscript(transcript("a", 1))).toBe(true);
  expect(isTranscript({ ...transcript("a", 1), source: "other" })).toBe(false);
  // 言語コードはページから届く。上限より長い保存値は読まない
  expect(isTranscript({ ...transcript("a", 1), language: "x".repeat(36) })).toBe(false);
  expect(isTranscript({ ...transcript("a", 1), language: "x".repeat(35) })).toBe(true);
  expect(isTranscript({ ...transcript("a", 1), lines: [{ id: "x", startSec: "0", endSec: 1, text: "" }] })).toBe(false);
  expect(isTranscript(null)).toBe(false);
});
