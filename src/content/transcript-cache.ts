import { MAX_LANGUAGE_CODE_LENGTH } from "@/content/caption-bridge-protocol";
import { isFiniteNumber, isRecord } from "@/shared/guards";
import type { Transcript, TranscriptLine } from "@/shared/transcript";

/**
 * 文字起こしの保存 (`chrome.storage.local`。同期しない)。同じ動画を開き直したときに取り直さずに済ませる。
 * 段階 4・5 の取り方は再生した所しか取れないので、そちらでは特に要る (ADR 0001)。
 *
 * **新しい順に 30 本まで** (回答 2026-10-26「一旦それで」)。1 本は 300KB まで: local の既定の容量 (10MB) に
 * 30 本が収まるように。動画ごとに `transcript:<videoId>` に置き、新しい順の索引を `transcriptIndex` に置く
 */

export const TRANSCRIPT_KEY_PREFIX = "transcript:";
export const TRANSCRIPT_INDEX_KEY = "transcriptIndex";
export const MAX_CACHED_TRANSCRIPTS = 30;
export const MAX_TRANSCRIPT_BYTES = 300_000;

type IndexEntry = { videoId: string; savedAt: number };

export type TranscriptStorage = {
  /** 持っている鍵の一覧。取れない環境 (getKeys の無い Chrome) では null (索引から漏れた鍵の掃除を飛ばす) */
  keys(): Promise<string[]> | null;
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/** 本物。chrome を呼ぶのは使うときだけ (import しただけで chrome を触らない) */
export const chromeLocalStorage: TranscriptStorage = {
  // getKeys は Chrome 130 から。@types/chrome の版に無いので型を足して呼ぶ。get(null) は毎回 9MB ほど読むので使わない
  keys: () => {
    const local = chrome.storage.local as typeof chrome.storage.local & { getKeys?: () => Promise<string[]> };
    return local.getKeys !== undefined ? local.getKeys() : null;
  },
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const keyOf = (videoId: string): string => `${TRANSCRIPT_KEY_PREFIX}${videoId}`;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function isWord(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.startSec) && isFiniteNumber(value.endSec) && typeof value.text === "string";
}

function isLine(value: unknown): value is TranscriptLine {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.startSec) &&
    isFiniteNumber(value.endSec) &&
    typeof value.text === "string" &&
    (value.words === undefined || (Array.isArray(value.words) && value.words.every(isWord)))
  );
}

export function isTranscript(value: unknown): value is Transcript {
  return (
    isRecord(value) &&
    typeof value.videoId === "string" &&
    (value.source === "youtube-manual" || value.source === "youtube-asr") &&
    typeof value.language === "string" &&
    value.language.length <= MAX_LANGUAGE_CODE_LENGTH &&
    isFiniteNumber(value.savedAt) &&
    Array.isArray(value.lines) &&
    value.lines.every(isLine) &&
    new Set(value.lines.map((line) => line.id)).size === value.lines.length
  );
}

/**
 * 収まらなければ単語の時刻を落とす。**それでも収まらなければ null (保存しない)**。後ろの行を落として保存すると、
 * 開き直したとき保存から読むので、欄が途中で終わったまま取り直さない (whole-branch review で、2 時間の自動字幕が
 * 54 分で切れた)。保存しなければ、開くたびに取る
 */
export function fitToBudget(transcript: Transcript, maxBytes: number): Transcript | null {
  if (byteLength(transcript) <= maxBytes) return transcript;
  const withoutWords: Transcript = {
    ...transcript,
    lines: transcript.lines.map((line) => ({ id: line.id, startSec: line.startSec, endSec: line.endSec, text: line.text })),
  };
  if (byteLength(withoutWords) <= maxBytes) {
    console.warn(`[yt-clip] 文字起こしが大きいため、単語の時刻を落として保存します: ${transcript.videoId}`);
    return withoutWords;
  }
  console.warn(`[yt-clip] 文字起こしが大きすぎるため保存しません (開くたびに取ります): ${transcript.videoId}`);
  return null;
}

function readIndex(value: unknown): IndexEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.warn(`[yt-clip] 文字起こしの索引が読めないため作り直します: ${String(value)}`);
    return [];
  }
  return value.filter(
    (entry): entry is IndexEntry =>
      isRecord(entry) && typeof entry.videoId === "string" && isFiniteNumber(entry.savedAt),
  );
}

/**
 * 読む。**※ 局所例外 (Fail Fast): 壊れた保存値は throw せず、warn を残して null** (取り直せば済む。読めない保存値で
 * 文字起こしごと止めない。loadWindowLayout と同じ判断)
 */
export async function loadTranscript(
  videoId: string,
  storage: TranscriptStorage = chromeLocalStorage,
): Promise<Transcript | null> {
  const key = keyOf(videoId);
  const stored = (await storage.get([key]))[key];
  if (stored === undefined) return null;
  if (!isTranscript(stored) || stored.videoId !== videoId) {
    console.warn(`[yt-clip] 保存された文字起こしが読めないため取り直します: ${videoId}`);
    return null;
  }
  return stored;
}

/** chrome.storage の容量超過 (`QUOTA_BYTES quota exceeded`) */
function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("QUOTA_BYTES");
}

/**
 * 索引に無い `transcript:<id>` を消す。2 つのタブが同時に保存すると、後から書いた索引に先の動画が載らず、その鍵は
 * 30 本の追い出しに掛からないまま残る。**消す直前に索引を読み直し**、書いた索引 (written) とその和に無い鍵だけを消す
 * (この間に別のタブが書いた鍵を消さない)
 */
async function removeOrphans(storage: TranscriptStorage, written: readonly IndexEntry[]): Promise<void> {
  const listing = storage.keys();
  if (listing === null) return;
  const keys = await listing;
  const latest = readIndex((await storage.get([TRANSCRIPT_INDEX_KEY]))[TRANSCRIPT_INDEX_KEY]);
  const kept = new Set([...written, ...latest].map((entry) => keyOf(entry.videoId)));
  const orphans = keys.filter((key) => key.startsWith(TRANSCRIPT_KEY_PREFIX) && !kept.has(key));
  if (orphans.length > 0) await storage.remove(orphans);
}

/**
 * 保存する。索引の先頭に入れ、30 本を超えた分を消す。容量が足りなければ古いものから 1 本ずつ消して入れ直す。
 * 消せるものが無くなっても入らなければ throw する
 */
export async function saveTranscript(
  transcript: Transcript,
  storage: TranscriptStorage = chromeLocalStorage,
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): Promise<void> {
  const fitted = fitToBudget(transcript, maxBytes);
  const index = readIndex((await storage.get([TRANSCRIPT_INDEX_KEY]))[TRANSCRIPT_INDEX_KEY]);
  if (fitted === null) {
    // 前の版で後ろを落として保存したものが残っていれば消す (読むと欄が途中で終わる)
    await storage.remove([keyOf(transcript.videoId)]);
    await storage.set({ [TRANSCRIPT_INDEX_KEY]: index.filter((entry) => entry.videoId !== transcript.videoId) });
    return;
  }
  const next: IndexEntry[] = [
    { videoId: transcript.videoId, savedAt: transcript.savedAt },
    ...index.filter((entry) => entry.videoId !== transcript.videoId),
  ];
  const evicted = next.slice(MAX_CACHED_TRANSCRIPTS).map((entry) => keyOf(entry.videoId));
  if (evicted.length > 0) await storage.remove(evicted);

  let kept = next.slice(0, MAX_CACHED_TRANSCRIPTS);
  for (;;) {
    try {
      await storage.set({ [keyOf(transcript.videoId)]: fitted, [TRANSCRIPT_INDEX_KEY]: kept });
      // ※ 局所例外 (Fail Fast): 掃除に失敗しても保存は通っている (掃除は保存の目的ではない)。理由は残す
      await removeOrphans(storage, kept).catch((error: unknown) => {
        console.warn(`[yt-clip] 索引から漏れた文字起こしを消せませんでした: ${String(error)}`);
      });
      return;
    } catch (error) {
      // 古いものを消して入れ直すのは容量が足りないときだけ。ほかの失敗で消すと、30 本ぜんぶ消してから throw する
      const oldest = kept[kept.length - 1];
      if (!isQuotaError(error) || kept.length <= 1 || oldest === undefined) throw error;
      kept = kept.slice(0, -1);
      await storage.remove([keyOf(oldest.videoId)]);
    }
  }
}
