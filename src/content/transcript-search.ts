/**
 * 文字起こしの欄の検索の比べ方 (ADR 0004)。NFKC で揃え、英字の大小を区別しない。印を元の文字に付けるため、揃えた後の
 * 1 文字ごとに、元の文字のどこから来たかを持つ。
 *
 * **書記素ごとに揃える。** 元の文字を書記素 (見た目の 1 文字。半角の「ｶﾞ」・分解したハングルの字母・肌の色の付いた絵文字も
 * 1 つ) に割り、書記素ごとに NFKC と小文字化にかける。1 コードポイントずつだと「ｶﾞ」が「カ + 結合の濁点」になって「ガ」に
 * 当たらず、文字列ごとだと元の位置が分からない。**検索の文字も同じ関数で揃える** (文字列ごとの小文字化は語末の Σ を ς に
 * するなど、書記素ごとと結果が違う)
 */

export type NormalizedText = { text: string; starts: number[]; ends: number[] };
export type MatchRange = { start: number; end: number };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeForSearch(source: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(source)) {
    const end = index + segment.length;
    const folded = segment.normalize("NFKC").toLowerCase();
    text += folded;
    // 揃えた後の UTF-16 の 1 単位ごとに、書記素の範囲を持つ (1 つの書記素が数文字になることがある)
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(index);
      ends.push(end);
    }
  }
  return { text, starts, ends };
}

export function normalizeQuery(query: string): string {
  return normalizeForSearch(query.trim()).text;
}

export function findMatches(normalized: NormalizedText, query: string): MatchRange[] {
  if (query === "") return [];
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const at = normalized.text.indexOf(query, from);
    if (at < 0) break;
    const start = normalized.starts[at]!;
    const end = normalized.ends[at + query.length - 1]!;
    const last = ranges.at(-1);
    // 1 つの書記素が数文字に揃うと、続いた当たりが同じ元の文字を指しうる。重ねずにつなぐ
    if (last !== undefined && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    from = at + query.length;
  }
  return ranges;
}
