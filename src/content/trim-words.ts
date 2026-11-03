/**
 * 詰める欄に並べる単語と、ハンドルの吸い付き先 (第 2 版のモック)。
 *
 * 単語を持つ行 (自動字幕。段階 4・5 の音声認識も) は単語ごと、持たない行 (手動字幕) は行を 1 つの単語として扱う。
 * 行は時刻の順 (transcript.ts が並べる) だが、ここでは順を前提にしない (窓の中の数百件を舐めるだけ)
 */

import type { TimeWindow } from "@/content/range-math";
import type { TranscriptLine } from "@/shared/transcript";

export type TrimWord = { startSec: number; endSec: number; text: string };

function wordsOf(line: TranscriptLine): TrimWord[] {
  return line.words !== undefined && line.words.length > 0
    ? line.words
    : [{ startSec: line.startSec, endSec: line.endSec, text: line.text }];
}

/** 窓に一部でも入る単語。端が接するだけのものは入れない (半開区間) */
export function wordsInWindow(lines: readonly TranscriptLine[], window: TimeWindow): TrimWord[] {
  const words: TrimWord[] = [];
  for (const line of lines) {
    if (line.endSec <= window.startSec || window.endSec <= line.startSec) continue;
    for (const word of wordsOf(line)) {
      if (word.startSec < window.endSec && window.startSec < word.endSec) words.push(word);
    }
  }
  return words;
}

/** 窓の中の単語の切れ目 (頭と尻)。重ねずに時刻の順 */
export function snapPointsIn(lines: readonly TranscriptLine[], window: TimeWindow): number[] {
  const points = new Set<number>();
  for (const word of wordsInWindow(lines, window)) {
    for (const sec of [word.startSec, word.endSec]) {
      if (window.startSec <= sec && sec <= window.endSec) points.add(sec);
    }
  }
  return [...points].sort((a, b) => a - b);
}
