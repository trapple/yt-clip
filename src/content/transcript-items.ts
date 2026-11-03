/**
 * 文字起こしの欄の行の間に差し込むもの (区間の見出しと手入力の行。ADR 0003) の並べ方。純粋関数。
 *
 * **行の要素は使い回し、差し込むものだけを描くたびに作り直す** (行は 8000 行になりうるが、差し込むものは数個)。
 * そのために、差し込むものは「どの行の前に置くか」(`before`。行の数なら末尾) を持つ。行は開始の早い順 (transcript.ts)
 */

import { isLineInSegments } from "@/content/transcript-selection";
import { overlapsSegments } from "@/shared/telop";
import type { TranscriptLine } from "@/shared/transcript";
import type { ClipRange, Telop } from "@/shared/types";

/** 区間の見出し。`index` は状態機械の区間の位置 (時間順) */
export type SegmentHeaderItem = { kind: "segment"; index: number; startSec: number; endSec: number; before: number };

/** 手入力の行 = `lineId` の無いテロップ (ADR 0003)。`telopIndex` は状態機械のテロップの位置 */
export type ManualTelopItem = {
  kind: "manual";
  telopIndex: number;
  startSec: number;
  endSec: number;
  text: string;
  /** どれかの区間に重なる (重ならないテロップは録画に出ない) */
  inSegment: boolean;
  before: number;
};

export type TranscriptItem = SegmentHeaderItem | ManualTelopItem;

/** sec 以上で始まる最初の行の位置。無ければ行の数 */
export function firstLineAtOrAfter(lines: readonly TranscriptLine[], sec: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.startSec < sec) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function placeTranscriptItems(
  lines: readonly TranscriptLine[],
  segments: readonly ClipRange[],
  telops: readonly Telop[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  segments.forEach((segment, index) => {
    const at = firstLineAtOrAfter(lines, segment.startSec);
    const previous = lines[at - 1];
    // 行から作った区間の頭は行の 0.2 秒前。詰めて頭を行の中に入れても、半分以上が区間に入る行は見出しの下に置く
    // (欄で選んでいる行の判定 isLineInSegments と同じ規則。見出しの上に「区間に入った行」が出ない)
    const before = previous !== undefined && isLineInSegments(previous, [segment]) ? at - 1 : at;
    items.push({ kind: "segment", index, startSec: segment.startSec, endSec: segment.endSec, before });
  });
  telops.forEach((telop, telopIndex) => {
    if (telop.lineId !== undefined) return;
    items.push({
      kind: "manual",
      telopIndex,
      startSec: telop.startSec,
      endSec: telop.endSec,
      text: telop.text,
      inSegment: overlapsSegments(telop, [...segments]),
      before: firstLineAtOrAfter(lines, telop.startSec),
    });
  });
  // 同じ行の前に入るものは時刻順。同じ時刻なら見出しが先 (区間の頭から出る手入力の行を、見出しの下に置く)
  const rank = (item: TranscriptItem): number => (item.kind === "segment" ? 0 : 1);
  return items.sort((a, b) => a.before - b.before || a.startSec - b.startSec || rank(a) - rank(b));
}
