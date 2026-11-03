import { describe, expect, test } from "vitest";
import { ASR_LINE_MAX_CHARS, parseJson3 } from "@/shared/transcript";

describe("parseJson3 (手動字幕)", () => {
  test("event が時間順に並んでいなくても、行は開始の早い順に並べる", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: "後" }] },
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "前" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines.map((line) => line.text)).toEqual(["前", "後"]);
  });

  test("同じ開始の行が 2 つあっても、id は重ねない (#2 を付ける)", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "上" }] },
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "下" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines.map((line) => line.id)).toEqual(["youtube-manual:1.00", "youtube-manual:1.00#2"]);
  });

  test("event 1 つを 1 行にする。改行は空白、時刻は秒", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 0, dDurationMs: 200000, id: 1, wpWinPosId: 1 },
          { tStartMs: 127900, dDurationMs: 3100, segs: [{ utf8: "そう思ってる人も\n多いと思います。" }] },
          { tStartMs: 131000, dDurationMs: 7700, segs: [{ utf8: "あとは、" }, { utf8: "やっぱり" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines).toEqual([
      { id: "youtube-manual:127.90", startSec: 127.9, endSec: 131, text: "そう思ってる人も 多いと思います。" },
      { id: "youtube-manual:131.00", startSec: 131, endSec: 138.7, text: "あとは、やっぱり" },
    ]);
  });

  test("空白だけの event と長さ 0 の event は行にしない", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "\n" }] },
          { tStartMs: 2000, dDurationMs: 0, segs: [{ utf8: "長さ 0" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines).toEqual([]);
  });
});

describe("parseJson3 (自動字幕)", () => {
  const events = [
    { tStartMs: 3030, dDurationMs: 5010 },
    {
      tStartMs: 3040,
      dDurationMs: 7840,
      segs: [
        { utf8: "です" },
        { utf8: "か", tOffsetMs: 119 },
        { utf8: "はい。", tOffsetMs: 879 },
        { utf8: "今日", tOffsetMs: 1120 },
        { utf8: "は", tOffsetMs: 1319 },
      ],
    },
    { tStartMs: 7000, dDurationMs: 10, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: "11" }, { utf8: "月", tOffsetMs: 440 }] },
  ];

  test("単語に平らにして、句点・沈黙で行に割る。単語の時刻を残す", () => {
    expect(parseJson3({ events }, "youtube-asr")).toEqual([
      {
        id: "youtube-asr:3.04",
        startSec: 3.04,
        endSec: 4.16,
        text: "ですかはい。",
        words: [
          { startSec: 3.04, endSec: 3.16, text: "です" },
          { startSec: 3.16, endSec: 3.92, text: "か" },
          { startSec: 3.92, endSec: 4.16, text: "はい。" },
        ],
      },
      {
        // 「は」の後は 2 秒以上空くので割る。最後の単語は event の終わりか 1.5 秒の短い方まで
        id: "youtube-asr:4.16",
        startSec: 4.16,
        endSec: 5.86,
        text: "今日は",
        words: [
          { startSec: 4.16, endSec: 4.36, text: "今日" },
          { startSec: 4.36, endSec: 5.86, text: "は" },
        ],
      },
      {
        id: "youtube-asr:8.00",
        startSec: 8,
        endSec: 9.94,
        text: "11月",
        words: [
          { startSec: 8, endSec: 8.44, text: "11" },
          { startSec: 8.44, endSec: 9.94, text: "月" },
        ],
      },
    ]);
  });

  test("英語の単語の間の空白は行の文字に残し、単語の文字からは除く", () => {
    const [line] = parseJson3(
      {
        events: [
          {
            tStartMs: 0,
            dDurationMs: 2000,
            segs: [{ utf8: "We're" }, { utf8: " no", tOffsetMs: 300 }, { utf8: " strangers", tOffsetMs: 600 }],
          },
        ],
      },
      "youtube-asr",
    );
    expect(line?.text).toBe("We're no strangers");
    expect(line?.words?.map((word) => word.text)).toEqual(["We're", "no", "strangers"]);
  });

  test("句点が来なくても、文字数の上限を超える前で割る", () => {
    const segs = Array.from({ length: ASR_LINE_MAX_CHARS + 1 }, (_, i) => ({ utf8: "あ", tOffsetMs: i * 100 }));
    const lines = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 10000, segs }] }, "youtube-asr");
    expect(lines.map((line) => line.text.length)).toEqual([ASR_LINE_MAX_CHARS, 1]);
  });

  test("event をまたいで重なる単語は、次の単語の頭で止める", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "前" }] },
          { tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: "後" }] },
        ],
      },
      "youtube-asr",
    );
    expect(lines[0]?.words?.[0]).toEqual({ startSec: 0, endSec: 0.5, text: "前" });
  });
});

test("events の無い値は字幕ではないので throw する", () => {
  expect(() => parseJson3({}, "youtube-manual")).toThrow(TypeError);
  expect(() => parseJson3(null, "youtube-asr")).toThrow(TypeError);
});
