import { describe, expect, test } from "vitest";
import { snapPointsIn, wordsInWindow } from "@/content/trim-words";
import type { TranscriptLine } from "@/shared/transcript";

const ASR: TranscriptLine = {
  id: "youtube-asr:10.00",
  startSec: 10,
  endSec: 13,
  text: "その一手で全部",
  words: [
    { startSec: 10, endSec: 10.6, text: "その" },
    { startSec: 10.6, endSec: 11.8, text: "一手で" },
    { startSec: 11.8, endSec: 13, text: "全部" },
  ],
};
const MANUAL: TranscriptLine = { id: "youtube-manual:20.00", startSec: 20, endSec: 24, text: "会場の声" };

describe("wordsInWindow", () => {
  test("単語を持つ行は単語ごと、持たない行は行ごとに出す", () => {
    expect(wordsInWindow([ASR, MANUAL], { startSec: 0, endSec: 30 }).map((word) => word.text)).toEqual([
      "その",
      "一手で",
      "全部",
      "会場の声",
    ]);
  });

  test("窓に一部でも入るものだけ。端が接するだけのものは入れない", () => {
    expect(wordsInWindow([ASR, MANUAL], { startSec: 11, endSec: 20 }).map((word) => word.text)).toEqual([
      "一手で",
      "全部",
    ]);
  });
});

describe("snapPointsIn", () => {
  test("単語の切れ目 (頭と尻) を重ねずに、時刻の順で返す", () => {
    expect(snapPointsIn([ASR, MANUAL], { startSec: 0, endSec: 30 })).toEqual([10, 10.6, 11.8, 13, 20, 24]);
  });

  test("窓の中の点だけ", () => {
    expect(snapPointsIn([ASR, MANUAL], { startSec: 10.5, endSec: 21 })).toEqual([10.6, 11.8, 13, 20]);
  });
});
