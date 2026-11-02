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
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/** 本物。chrome を呼ぶのは使うときだけ (import しただけで chrome を触らない) */
export const chromeLocalStorage: TranscriptStorage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const keyOf = (videoId: string): string => `${TRANSCRIPT_KEY_PREFIX}${videoId}`;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

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
    isFiniteNumber(value.savedAt) &&
    Array.isArray(value.lines) &&
    value.lines.every(isLine)
  );
}

/** 収まらなければ単語の時刻を落とし、それでも収まらなければ後ろの行を落とす。落としたら warn を残す */
export function fitToBudget(transcript: Transcript, maxBytes: number): Transcript {
  if (byteLength(transcript) <= maxBytes) return transcript;
  const withoutWords: Transcript = {
    ...transcript,
    lines: transcript.lines.map((line) => ({ id: line.id, startSec: line.startSec, endSec: line.endSec, text: line.text })),
  };
  console.warn(`[yt-clip] 文字起こしが大きいため、単語の時刻を落として保存します: ${transcript.videoId}`);
  if (byteLength(withoutWords) <= maxBytes) return withoutWords;

  let used = byteLength({ ...withoutWords, lines: [] });
  const kept: TranscriptLine[] = [];
  for (const line of withoutWords.lines) {
    // +1 は配列の区切りの `,`
    const size = byteLength(line) + 1;
    if (used + size > maxBytes) break;
    used += size;
    kept.push(line);
  }
  console.warn(
    `[yt-clip] 文字起こしが大きいため、後ろの ${withoutWords.lines.length - kept.length} 行を落として保存します: ${transcript.videoId}`,
  );
  return { ...withoutWords, lines: kept };
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
 * 保存する。索引の先頭に入れ、30 本を超えた分を消す。容量が足りなければ古いものから 1 本ずつ消して入れ直す。
 * 消せるものが無くなっても入らなければ throw する
 */
export async function saveTranscript(
  transcript: Transcript,
  storage: TranscriptStorage = chromeLocalStorage,
): Promise<void> {
  const fitted = fitToBudget(transcript, MAX_TRANSCRIPT_BYTES);
  const index = readIndex((await storage.get([TRANSCRIPT_INDEX_KEY]))[TRANSCRIPT_INDEX_KEY]);
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
