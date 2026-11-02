import {
  defaultCaptionDeps,
  fetchOfficialTranscript,
  readDubbed,
  type OfficialResult,
} from "@/content/caption-source";
import { loadTranscript, saveTranscript } from "@/content/transcript-cache";
import type { Transcript } from "@/shared/transcript";

/**
 * 動画ごとに 1 回、文字起こしを用意する: 保存から読む → 無ければ公式字幕を取る → 保存する。
 * 段階 4・5 の取り方 (PC 内の音声認識・外部 API) はここに足す (ADR 0001)。
 *
 * **同じ動画では 1 回だけ。失敗しても勝手に繰り返さない** (youtube.ts の mount は DOM の変化のたびに呼ぶ)。
 * 取り直しは retry() で明示する (段階 1b の欄のボタン)
 */

export type TranscriptStatus =
  | { kind: "idle" }
  | { kind: "loading"; videoId: string }
  | { kind: "ready"; videoId: string; transcript: Transcript; dubbed: boolean }
  | { kind: "none"; videoId: string; dubbed: boolean }
  | { kind: "failed"; videoId: string; reason: string };

export type TranscriptLoader = {
  /** この動画の文字起こしを用意する。同じ動画をもう扱っていれば何もしない */
  load(videoId: string): void;
  /** 失敗した動画をもう一度取る。失敗していなければ何もしない */
  retry(): void;
  /** 何も扱っていない状態に戻す。走っている取得の結末は捨てる (知らせない) */
  reset(): void;
  status(): TranscriptStatus;
};

export type LoaderDeps = {
  loadCached(videoId: string): Promise<Transcript | null>;
  save(transcript: Transcript): Promise<void>;
  /** signal が中止されたら、それ以上は頼まず取りに行かない (オフにした後・別の動画へ移った後) */
  fetchOfficial(videoId: string, signal: AbortSignal): Promise<OfficialResult>;
  readDubbed(videoId: string, signal: AbortSignal): Promise<boolean>;
  onChange(status: TranscriptStatus): void;
};

export function createTranscriptLoader(deps: LoaderDeps): TranscriptLoader {
  let current: TranscriptStatus = { kind: "idle" };
  /** 走らせるたびに上げる。結末が届いたとき、自分が最新でなければ捨てる (別の動画へ移った / reset された) */
  let generation = 0;
  /** 走っている取得を止める。結末を捨てるだけでは、広告を待つ間 (最長 3 分) ブリッジに頼み続けてしまう */
  let controller: AbortController | null = null;

  const abortRunning = (): void => {
    controller?.abort(new Error("文字起こしの取得を止めました"));
    controller = null;
  };

  const set = (next: TranscriptStatus): void => {
    current = next;
    deps.onChange(next);
  };

  function run(videoId: string): void {
    abortRunning();
    generation += 1;
    const mine = generation;
    const { signal } = (controller = new AbortController());
    set({ kind: "loading", videoId });
    void (async () => {
      try {
        const cached = await deps.loadCached(videoId);
        if (mine !== generation) return;
        if (cached !== null) {
          // ※ 局所例外 (Fail Fast): 判定が読めなくても文字起こしは使える。知らせるだけの機能なので偽に倒し、理由は残す
          const dubbed = await deps.readDubbed(videoId, signal).catch((error: unknown) => {
            if (!signal.aborted) console.warn(`[yt-clip] 吹き替えの判定を読めませんでした: ${String(error)}`);
            return false;
          });
          if (mine === generation) set({ kind: "ready", videoId, transcript: cached, dubbed });
          return;
        }
        const result = await deps.fetchOfficial(videoId, signal);
        if (mine !== generation) return;
        if (result.kind === "none") {
          set({ kind: "none", videoId, dubbed: result.dubbed });
          return;
        }
        set({ kind: "ready", videoId, transcript: result.transcript, dubbed: result.dubbed });
        // ※ 局所例外 (Fail Fast): 保存できなくても取れた行は使う (保存は取り直しを省くためだけ)。理由は残す
        await deps.save(result.transcript).catch((error: unknown) => {
          console.warn(`[yt-clip] 文字起こしを保存できませんでした: ${String(error)}`);
        });
      } catch (error) {
        if (mine !== generation) return;
        set({ kind: "failed", videoId, reason: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  return {
    load(videoId) {
      if (current.kind !== "idle" && current.videoId === videoId) return;
      run(videoId);
    },
    retry() {
      if (current.kind === "failed") run(current.videoId);
    },
    reset() {
      abortRunning();
      generation += 1;
      current = { kind: "idle" };
    },
    status: () => current,
  };
}

/** 本物の依存で作る (youtube.ts の start() が呼ぶ) */
export function createDefaultTranscriptLoader(onChange: (status: TranscriptStatus) => void): TranscriptLoader {
  const captions = defaultCaptionDeps();
  return createTranscriptLoader({
    loadCached: (videoId) => loadTranscript(videoId),
    save: (transcript) => saveTranscript(transcript),
    fetchOfficial: (videoId, signal) => fetchOfficialTranscript(videoId, captions, signal),
    readDubbed: (videoId, signal) => readDubbed(videoId, captions, signal),
    onChange,
  });
}

const SOURCE_LABEL: Record<Transcript["source"], string> = {
  "youtube-manual": "公式字幕",
  "youtube-asr": "公式字幕 (自動)",
};

/** 結末をコンソールに出す 1 行。段階 1a では表示する場所が無いので、確かめる手段はこれだけ (manual-check) */
export function transcriptLogLine(status: TranscriptStatus): string | null {
  switch (status.kind) {
    case "idle":
    case "loading":
      return null;
    case "ready": {
      const dubbed = status.dubbed ? " (吹き替えの音声が流れています)" : "";
      return `[yt-clip] 文字起こし: ${SOURCE_LABEL[status.transcript.source]} ${status.transcript.lines.length} 行${dubbed}`;
    }
    case "none":
      return "[yt-clip] 文字起こし: この動画には公式字幕がありません";
    case "failed":
      return `[yt-clip] 文字起こしを取れませんでした: ${status.reason}`;
  }
}
