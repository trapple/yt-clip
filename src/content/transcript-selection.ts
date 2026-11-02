import { MAX_TELOP_TEXT_LENGTH } from "@/shared/telop";
import { MIN_CLIP_SEC } from "@/shared/time";
import type { TranscriptLine } from "@/shared/transcript";
import type { ClipRange, Telop } from "@/shared/types";

/**
 * 文字起こしの欄で行を入れた / 外したときの、区間とテロップの組を計算する (ADR 0001)。**純粋関数だけを置く**
 * (状態機械へ送るのは youtube.ts。ここは組を作るだけ)。
 *
 * **押した行のまわりしか変えない。** 区間とテロップの一覧と ＋ 区間を追加は 1c まで残るので、手で作った区間と行の
 * 選択が混ざるのが普通の使い方になる。押した行に当たらない区間とテロップは、手作りでも重なっていても触らない。
 *
 * 規則:
 * - 行が区間に「入っている」= 行の長さの半分以上が、どれか 1 つの区間に重なる
 * - 入れる: 行の既定の区間 (頭 0.2 秒・尻 0.3 秒の余白。隣の行に食い込まない。1 秒に満たなければ広げる) を作り、
 *   それに重なる区間と、隣の行が入っている区間 (行の間が 3 秒以内) を 1 つにまとめる。まとめた端は外側を取る
 * - 外す: 前の行の尻の 0.3 秒後から次の行の頭の 0.2 秒前までを切り取る。残りが 1 秒に満たなければ捨てる
 * - テロップは押した行の分だけ: 入れた行にテロップが無ければ末尾に足し、外した行のテロップは消す
 */

export const HEAD_PAD_SEC = 0.2;
export const TAIL_PAD_SEC = 0.3;
/** 隣り合う行でも、これより長く空いていれば別の区間にする (曲や沈黙を挟まない) */
export const JOIN_GAP_SEC = 3;
/** 行の長さのうち、これ以上が区間に重なれば「入っている」 */
const MIN_OVERLAP_RATIO = 0.5;

export type Clip = { segments: ClipRange[]; telops: Telop[] };

const round2 = (sec: number): number => Math.round(sec * 100) / 100;

function overlapSec(a: ClipRange, b: ClipRange): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

export function isLineInSegments(line: TranscriptLine, segments: ClipRange[]): boolean {
  const length = line.endSec - line.startSec;
  if (length <= 0) return false;
  return segments.some((segment) => overlapSec(line, segment) >= length * MIN_OVERLAP_RATIO);
}

/** 並び順で from から to まで (両端を含む) の id。向きは問わない。from が見つからなければ to だけ */
export function lineIdsBetween(lines: TranscriptLine[], fromId: string, toId: string): string[] {
  const from = lines.findIndex((line) => line.id === fromId);
  const to = lines.findIndex((line) => line.id === toId);
  if (to < 0) return [];
  if (from < 0) return [toId];
  const [a, b] = from <= to ? [from, to] : [to, from];
  return lines.slice(a, b + 1).map((line) => line.id);
}

/** 丸めた長さ (秒)。1 秒との比べはこれで見る (0.9999… 秒を 1 秒未満にしない) */
const lengthSec = (range: ClipRange): number => round2(range.endSec - range.startSec);

/**
 * 1 秒に満たない区間を広げる (toward の側へ。both は前後へ半分ずつ)。動画の終わりと 0 秒は越えない。
 * 端は 100 分の 1 秒に丸め、丸めた後も 1 秒を割らないよう尻を決め直す
 */
function widen(range: ClipRange, durationSec: number, toward: "both" | "start" | "end"): ClipRange {
  let { startSec, endSec } = range;
  const lack = MIN_CLIP_SEC - (endSec - startSec);
  if (lack > 0) {
    if (toward === "both") startSec -= lack / 2;
    if (toward === "start") startSec -= lack;
    startSec = Math.max(0, Math.min(startSec, durationSec - MIN_CLIP_SEC));
    endSec = Math.min(durationSec, Math.max(endSec, startSec + MIN_CLIP_SEC));
  }
  startSec = round2(startSec);
  endSec = round2(endSec);
  if (lengthSec({ startSec, endSec }) < MIN_CLIP_SEC) endSec = round2(Math.min(durationSec, startSec + MIN_CLIP_SEC));
  return { startSec, endSec };
}

/** 行 i の既定の区間。余白は隣の行に食い込ませず、動画の終わりを越えず、1 秒に満たなければ前後へ広げる */
function lineBounds(lines: TranscriptLine[], i: number, durationSec: number): ClipRange {
  const line = lines[i]!;
  const previous = lines[i - 1];
  const next = lines[i + 1];
  // 行どうしが重なっている (手動字幕で起こりうる) と、余白が行の内側に入る。行そのものより狭くしない
  const startSec = Math.min(line.startSec, Math.max(0, line.startSec - HEAD_PAD_SEC, previous?.endSec ?? 0));
  const endSec = Math.min(
    durationSec,
    Math.max(line.endSec, Math.min(line.endSec + TAIL_PAD_SEC, next?.startSec ?? Number.POSITIVE_INFINITY)),
  );
  return widen({ startSec, endSec }, durationSec, "both");
}

/** 2 つの行の間の空き (秒)。重なっていれば 0 以下 */
function gapSec(a: TranscriptLine, b: TranscriptLine): number {
  return Math.max(a.startSec, b.startSec) - Math.min(a.endSec, b.endSec);
}

function addLine(segments: ClipRange[], lines: TranscriptLine[], i: number, durationSec: number): ClipRange[] {
  const line = lines[i]!;
  const own = lineBounds(lines, i, durationSec);
  const joins = (neighbor: TranscriptLine | undefined, segment: ClipRange): boolean =>
    neighbor !== undefined && gapSec(line, neighbor) <= JOIN_GAP_SEC && isLineInSegments(neighbor, [segment]);
  const touching = segments.filter(
    (segment) => overlapSec(segment, own) > 0 || joins(lines[i - 1], segment) || joins(lines[i + 1], segment),
  );
  const merged: ClipRange = {
    startSec: Math.min(own.startSec, ...touching.map((segment) => segment.startSec)),
    endSec: Math.max(own.endSec, ...touching.map((segment) => segment.endSec)),
  };
  return [...segments.filter((segment) => !touching.includes(segment)), merged];
}

function removeLine(segments: ClipRange[], lines: TranscriptLine[], i: number, durationSec: number): ClipRange[] {
  const line = lines[i]!;
  const previous = lines[i - 1];
  const next = lines[i + 1];
  const cutStart = previous === undefined ? line.startSec : Math.min(line.startSec, round2(previous.endSec + TAIL_PAD_SEC));
  const cutEnd = next === undefined ? line.endSec : Math.max(line.endSec, round2(next.startSec - HEAD_PAD_SEC));
  return segments.flatMap((segment) => {
    if (segment.endSec <= cutStart || segment.startSec >= cutEnd) return [segment];
    const pieces: [ClipRange, "start" | "end"][] = [
      [{ startSec: segment.startSec, endSec: Math.min(segment.endSec, cutStart) }, "start"],
      [{ startSec: Math.max(segment.startSec, cutEnd), endSec: segment.endSec }, "end"],
    ];
    return pieces.flatMap(([piece, outward]) => {
      if (piece.endSec <= piece.startSec) return [];
      if (lengthSec(piece) >= MIN_CLIP_SEC) return [piece];
      // 1 秒に満たない残り: まだ入っている行 (短い相づちなど) があれば外側へ広げて残す。
      // 無ければ捨てる (行の端の余白だけが残った区間を作らない)
      const holdsLine = lines.some((other, j) => j !== i && isLineInSegments(other, [piece]));
      return holdsLine ? [widen(piece, durationSec, outward)] : [];
    });
  });
}

export function setLinesSelected(
  clip: Clip,
  lines: TranscriptLine[],
  lineIds: string[],
  selected: boolean,
  durationSec = Number.POSITIVE_INFINITY,
): Clip {
  const wanted = new Set(lineIds);
  let segments = clip.segments;
  const changed: TranscriptLine[] = [];
  lines.forEach((line, i) => {
    if (!wanted.has(line.id)) return;
    // 既に入っている行を入れ直さない / 入っていない行を外さない
    if (isLineInSegments(line, segments) === selected) return;
    segments = selected ? addLine(segments, lines, i, durationSec) : removeLine(segments, lines, i, durationSec);
    changed.push(line);
  });

  let telops = clip.telops;
  if (selected) {
    const have = new Set(telops.map((telop) => telop.lineId));
    const added = changed
      .filter((line) => !have.has(line.id))
      .map((line) => ({
        startSec: line.startSec,
        endSec: line.endSec,
        text: line.text.slice(0, MAX_TELOP_TEXT_LENGTH),
        lineId: line.id,
      }));
    telops = [...telops, ...added];
  } else {
    const removed = new Set(changed.map((line) => line.id));
    telops = telops.filter((telop) => telop.lineId === undefined || !removed.has(telop.lineId));
  }

  return { segments: [...segments].sort((a, b) => a.startSec - b.startSec), telops };
}

/**
 * 「字幕に出さない」/「字幕に出す」。行のテロップの文字を空にする / 行の文字に戻す (空の文字のテロップは描かない。
 * テロップの今の作法)。その行のテロップが無ければ null
 */
export function toggleTelopHidden(clip: Clip, line: TranscriptLine): Clip | null {
  const index = clip.telops.findIndex((telop) => telop.lineId === line.id);
  const telop = clip.telops[index];
  if (telop === undefined) return null;
  const text = telop.text === "" ? line.text.slice(0, MAX_TELOP_TEXT_LENGTH) : "";
  return {
    segments: clip.segments,
    telops: clip.telops.map((item, i) => (i === index ? { ...item, text } : item)),
  };
}
