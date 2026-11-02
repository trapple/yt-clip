/**
 * 文字起こし (発話の行) の形と、YouTube の字幕 (json3) からの読み取り。
 *
 * **時刻は元動画の秒** (テロップと同じ。区間を詰めても行が発話に付いてくる)。
 * 取り方が増えても (段階 4 の PC 内の音声認識・段階 5 の外部 API) 行の形はこれ 1 つにする (ADR 0001)
 */

/** 単語。自動字幕と音声認識だけが持つ (詰める欄でハンドルを単語の切れ目に合わせる) */
export type TranscriptWord = { startSec: number; endSec: number; text: string };

export type TranscriptLine = {
  /** 取り方と開始時刻から作る。取り直しても同じ行は同じ id になり、テロップの行への参照が外れない */
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  words?: TranscriptWord[];
};

/** どこから取ったか。段階 4・5 で増える */
export type TranscriptSource = "youtube-manual" | "youtube-asr";

export type Transcript = {
  videoId: string;
  source: TranscriptSource;
  /** 字幕の言語 (YouTube の languageCode。`ja` / `en-US` など) */
  language: string;
  lines: TranscriptLine[];
  /** 保存した時刻 (UTC epoch ミリ秒)。動画の中の秒とは別物 */
  savedAt: number;
};

/** json3 の形のうち使う所だけ */
type Json3Seg = { utf8?: string; tOffsetMs?: number };
type Json3Event = { tStartMs?: number; dDurationMs?: number; segs?: Json3Seg[] };

/** 自動字幕を行に割るとき、これより長い沈黙で割る (秒) */
export const ASR_LINE_GAP_SEC = 0.8;
/** 自動字幕の 1 行の文字数の上限。句点が来なくてもここで割る (テロップの 1 行に収まる目安) */
export const ASR_LINE_MAX_CHARS = 32;
/** event の最後の単語の長さの上限 (ミリ秒)。次の単語が無いと終わりが分からない */
const LAST_WORD_MAX_MS = 1500;
/** 行の長さの下限 (秒)。単語の時刻が潰れていても、長さ 0 の行は作らない */
const MIN_LINE_SEC = 0.1;
const SENTENCE_END = /[。！？!?]$/;

const round2 = (sec: number): number => Math.round(sec * 100) / 100;
const lineId = (source: TranscriptSource, startSec: number): string => `${source}:${startSec.toFixed(2)}`;

function eventsOf(json: unknown): Json3Event[] {
  if (json === null || typeof json !== "object" || !Array.isArray((json as { events?: unknown }).events)) {
    throw new TypeError("字幕 (json3) の形ではありません: events がありません");
  }
  return (json as { events: Json3Event[] }).events;
}

/** 手動字幕: event 1 つが 1 行 (字幕を作った人の区切り)。改行は空白にする */
function parseManual(events: Json3Event[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const event of events) {
    if (event.segs === undefined || event.tStartMs === undefined) continue;
    const text = event.segs
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (text === "") continue;
    const startSec = round2(event.tStartMs / 1000);
    const endSec = round2((event.tStartMs + (event.dDurationMs ?? 0)) / 1000);
    if (endSec <= startSec) continue;
    lines.push({ id: lineId("youtube-manual", startSec), startSec, endSec, text });
  }
  return lines;
}

type Piece = { word: TranscriptWord; raw: string };

/**
 * 自動字幕: 単語に平らにしてから、句点・沈黙・文字数で行に割る。
 * event の区切りは画面に 2 行ずつ流す都合で、文と合わない (「…伝えたい。そう」のように文をまたぐ)
 */
function parseAsr(events: Json3Event[]): TranscriptLine[] {
  const pieces: Piece[] = [];
  for (const event of events) {
    const segs = event.segs;
    const base = event.tStartMs;
    if (segs === undefined || base === undefined) continue;
    const eventEndMs = base + (event.dDurationMs ?? 0);
    segs.forEach((seg, i) => {
      // 英語の単語は頭に空白を持つ (" no")。行の文字のために生の文字も残す
      const raw = (seg.utf8 ?? "").replace(/\n/g, "");
      const text = raw.trim();
      if (text === "") return;
      const startMs = base + (seg.tOffsetMs ?? 0);
      const nextOffset = segs[i + 1]?.tOffsetMs;
      const endMs =
        nextOffset !== undefined ? base + nextOffset : Math.min(eventEndMs, startMs + LAST_WORD_MAX_MS);
      pieces.push({ word: { startSec: startMs / 1000, endSec: Math.max(endMs, startMs) / 1000, text }, raw });
    });
  }
  pieces.sort((a, b) => a.word.startSec - b.word.startSec);
  // event をまたぐと、前の単語の終わりが次の単語の頭を越えうる。次の頭で止める
  pieces.forEach((piece, i) => {
    const next = pieces[i + 1];
    if (next !== undefined && piece.word.endSec > next.word.startSec) piece.word.endSec = next.word.startSec;
  });

  const lines: TranscriptLine[] = [];
  let current: Piece[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    const startSec = round2(first.word.startSec);
    lines.push({
      id: lineId("youtube-asr", startSec),
      startSec,
      endSec: Math.max(round2(last.word.endSec), round2(startSec + MIN_LINE_SEC)),
      text: current.map((piece) => piece.raw).join("").trim(),
      words: current.map((piece) => ({
        startSec: round2(piece.word.startSec),
        endSec: round2(piece.word.endSec),
        text: piece.word.text,
      })),
    });
    current = [];
  };
  for (const piece of pieces) {
    const last = current[current.length - 1];
    const length = current.reduce((sum, p) => sum + p.word.text.length, 0);
    if (
      last !== undefined &&
      (piece.word.startSec - last.word.endSec > ASR_LINE_GAP_SEC ||
        length + piece.word.text.length > ASR_LINE_MAX_CHARS)
    ) {
      flush();
    }
    current.push(piece);
    if (SENTENCE_END.test(piece.word.text)) flush();
  }
  flush();
  return lines;
}

/**
 * YouTube の字幕 (json3) を行にする。**形が違えば throw する** (字幕の URL が別のものを返した = 取り方の前提が崩れた。
 * 黙って空にすると「字幕が無い」と見分けが付かない)
 */
export function parseJson3(json: unknown, source: TranscriptSource): TranscriptLine[] {
  const events = eventsOf(json);
  return uniqueIds(source === "youtube-asr" ? parseAsr(events) : parseManual(events));
}

/**
 * 行の id を重ねない。id は開始の秒から作るので、手動字幕で同じ開始の event が 2 つあると重なる。
 * 文字起こしの欄は id で行とテロップを結ぶので、重なると別の行のテロップを動かす
 */
function uniqueIds(lines: TranscriptLine[]): TranscriptLine[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line.id) ?? 0) + 1;
    seen.set(line.id, count);
    return count === 1 ? line : { ...line, id: `${line.id}#${count}` };
  });
}
