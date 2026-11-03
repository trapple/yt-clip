/**
 * 文字起こしの欄の検索の比べ方 (ADR 0004)。NFKC で揃え、英字の大小を区別しない。印を元の文字に付けるため、揃えた後の
 * 1 文字ごとに、元の文字のどこから来たかを持つ。
 *
 * **塊ごとに揃える。** 元の文字を「基の 1 文字 + 後ろに付く結合文字 (と半角の濁点・半濁点)」の塊に割り、塊ごとに NFKC に
 * かける。1 文字ずつだと半角の「ｶﾞ」が「カ + 結合の濁点」になって「ガ」に当たらない。文字列ごとだと元の位置が分からない
 */

export type NormalizedText = { text: string; starts: number[]; ends: number[] };
export type MatchRange = { start: number; end: number };

/** 基の 1 文字と、後ろに付く結合文字・半角の濁点 (U+FF9E)・半濁点 (U+FF9F) */
const CLUSTER = /\P{M}[\p{M}ﾞﾟ]*|\p{M}+/gu;

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

export function normalizeForSearch(source: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of source.matchAll(CLUSTER)) {
    const start = match.index;
    const end = start + match[0].length;
    const folded = fold(match[0]);
    text += folded;
    // 揃えた後の UTF-16 の 1 単位ごとに、塊の範囲を持つ (1 つの塊が数文字になることがある)
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(start);
      ends.push(end);
    }
  }
  return { text, starts, ends };
}

export function normalizeQuery(query: string): string {
  return fold(query.trim());
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
    // 1 つの塊が数文字に揃うと、続いた当たりが同じ元の文字を指しうる。重ねずにつなぐ
    if (last !== undefined && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    from = at + query.length;
  }
  return ranges;
}
