import {
  BRIDGE_REQUEST,
  MAX_LANGUAGE_CODE_LENGTH,
  MAX_TRACK_NAME_LENGTH,
  POT_WAIT_MS,
  isBridgeResponse,
  type BridgeAnswer,
  type BridgeParams,
  type BridgeRequest,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";
import { parseJson3, type Transcript, type TranscriptSource } from "@/shared/transcript";

/**
 * 隔離された world から公式字幕を取る (ADR 0002)。MAIN world のブリッジに一覧と pot 付きの URL を頼み、
 * 選んだ字幕の URL に pot を写して json3 を取り、行にする
 */

/** ブリッジに頼み直す回数。SPA 遷移の直後はプレイヤーの動画がまだ前の動画のことがある */
export const BRIDGE_RETRIES = 6;
export const BRIDGE_RETRY_MS = 500;
/** 広告が流れている間、頼み直すまでの間隔と、待つ上限。広告の間は回数 (BRIDGE_RETRIES) に数えない */
export const AD_WAIT_MS = 2000;
export const AD_MAX_WAIT_MS = 180_000;
/** 字幕の取得の上限 */
export const FETCH_TIMEOUT_MS = 10_000;
/** 一覧だけを頼むときの応答の上限。pot を頼むときはプレイヤーを待つ分 (POT_WAIT_MS) を足す */
const LIST_TIMEOUT_MS = 2000;
const POT_TIMEOUT_MS = POT_WAIT_MS + 3000;

/** pot を使い回すときに写す引数。検証 V1 で、これを写せば同じ動画の別の字幕も取れた */
const POT_PARAMS = [
  "pot",
  "potc",
  "c",
  "cver",
  "cplayer",
  "cos",
  "cosver",
  "cplatform",
  "cbr",
  "cbrver",
  "cbrand",
  "xorb",
  "xobt",
  "xovt",
] as const;

export class CaptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionError";
  }
}

export class BridgeTimeoutError extends CaptionError {
  constructor() {
    super("ページからの応答がありません");
    this.name = "BridgeTimeoutError";
  }
}

export type OfficialResult =
  | { kind: "ready"; transcript: Transcript; dubbed: boolean }
  | { kind: "none"; dubbed: boolean };

export type CaptionDeps = {
  request(params: BridgeParams): Promise<BridgeAnswer>;
  fetchText(url: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** UTC epoch ミリ秒 */
  now(): number;
};

const REASON_TEXT: Record<string, string> = {
  "no-player": "プレイヤーが見つかりません",
  "video-mismatch": "プレイヤーの動画が切り替わりませんでした",
  timeout: "ページからの応答がありません",
};

/** YouTube の字幕の URL か。**ページから届いた URL で、別の所へ取りに行かない** */
export function isTimedtextUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.youtube.com" && parsed.pathname === "/api/timedtext";
  } catch {
    return false;
  }
}

/** 字幕の URL に、プレイヤーが取りに行った URL の pot ほかの引数を写す */
export function withPot(baseUrl: string, potUrl: string): string {
  if (!isTimedtextUrl(baseUrl) || !isTimedtextUrl(potUrl)) {
    throw new CaptionError(`字幕の URL ではありません: ${baseUrl}`);
  }
  const target = new URL(baseUrl);
  const source = new URL(potUrl);
  for (const key of POT_PARAMS) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  target.searchParams.set("fmt", "json3");
  return target.toString();
}

const baseLanguage = (code: string): string => code.split("-")[0] ?? code;

/**
 * 使う字幕を選ぶ。**手動の字幕 → 自動字幕の順** (第 2 版のモックの設定)。話している言語は自動字幕の言語で見る
 * (手動字幕は翻訳のことがある)。自動字幕が無ければ最初の手動字幕
 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const asr = tracks.find((track) => track.kind === "asr");
  const manual = tracks.filter((track) => track.kind === "manual");
  if (asr === undefined) return manual[0] ?? null;
  return manual.find((track) => baseLanguage(track.languageCode) === baseLanguage(asr.languageCode)) ?? asr;
}

async function ask(
  params: BridgeParams,
  deps: CaptionDeps,
  signal: AbortSignal | undefined,
): Promise<Extract<BridgeAnswer, { ok: true }>> {
  let lastReason = "";
  let attempt = 0;
  let adWaited = 0;
  while (attempt < BRIDGE_RETRIES) {
    // オフにされたら、それ以上は頼まない (広告を待っている間も)。頼むのはオンの間だけ (ADR 0002)
    signal?.throwIfAborted();
    try {
      const answer = await deps.request(params);
      if (answer.ok) return answer;
      // ページの中で throw した (非公開 API が変わったなど)。頼み直しても同じなので、理由をそのまま出す
      if (answer.reason === "error") throw new CaptionError(`ページの中で失敗しました: ${answer.message}`);
      if (answer.reason === "ad-showing") {
        // 広告は数十秒〜数分続く。回数に数えずに明けるまで待つ (上限あり)
        if (adWaited >= AD_MAX_WAIT_MS) throw new CaptionError("広告が終わらないため字幕を取れませんでした");
        adWaited += AD_WAIT_MS;
        await deps.sleep(AD_WAIT_MS);
        signal?.throwIfAborted();
        continue;
      }
      lastReason = answer.reason;
    } catch (error) {
      // 上限まで応答が無い = ブリッジがまだ居ない (読み込みの順は保証されない) かもしれない。それ以外の失敗は頼み直さない
      if (!(error instanceof BridgeTimeoutError)) throw error;
      lastReason = "timeout";
    }
    signal?.throwIfAborted();
    attempt += 1;
    if (attempt < BRIDGE_RETRIES) await deps.sleep(BRIDGE_RETRY_MS);
  }
  throw new CaptionError(REASON_TEXT[lastReason] ?? lastReason);
}

/** 字幕の本文を JSON として読む。読めなければ、何が起きたか分かる理由にする (素の SyntaxError では分からない) */
function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new CaptionError(`字幕 (json3) を読めませんでした: ${String(error)}`);
  }
}

export async function fetchOfficialTranscript(
  videoId: string,
  deps: CaptionDeps,
  signal?: AbortSignal,
): Promise<OfficialResult> {
  const answer = await ask({ videoId, wantPot: true }, deps, signal);
  // 言語や名前が上限より長い track は使わない (応答はページが偽れる。巨大な文字列を保存に流さない)。応答ごと捨てると
  // 無応答と見分けられず、頼み直した末に理由の分からない失敗になるので、その track だけ落とす
  const tracks = answer.tracks.filter(
    (candidate) =>
      candidate.languageCode.length <= MAX_LANGUAGE_CODE_LENGTH && candidate.name.length <= MAX_TRACK_NAME_LENGTH,
  );
  const track = pickTrack(tracks);
  if (track === null) return { kind: "none", dubbed: answer.dubbed };
  // 字幕の URL は頼んだ動画のものか (応答はページが偽れる。別の動画の字幕をこの動画の名で保存しない)
  if (!isTimedtextUrl(track.baseUrl) || new URL(track.baseUrl).searchParams.get("v") !== videoId) {
    throw new CaptionError("別の動画の字幕が返りました");
  }
  if (answer.potUrl === null) throw new CaptionError("字幕の取得に要る情報を拾えませんでした");
  signal?.throwIfAborted();
  const body = await deps.fetchText(withPot(track.baseUrl, answer.potUrl));
  // pot が効かないと 200 で空が返る (検証 V1)。字幕が無いのと見分けるため throw する
  if (body.trim() === "") throw new CaptionError("字幕が空で返りました");
  const source: TranscriptSource = track.kind === "asr" ? "youtube-asr" : "youtube-manual";
  return {
    kind: "ready",
    dubbed: answer.dubbed,
    transcript: {
      videoId,
      source,
      language: track.languageCode,
      lines: parseJson3(parseBody(body), source),
      savedAt: deps.now(),
    },
  };
}

/** 吹き替えの判定だけを読む (保存から読めたとき。プレイヤーに字幕を取りに行かせない) */
export async function readDubbed(videoId: string, deps: CaptionDeps, signal?: AbortSignal): Promise<boolean> {
  return (await ask({ videoId, wantPot: false }, deps, signal)).dubbed;
}

export type BridgeWindow = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

/** `window.postMessage` で MAIN world のブリッジに頼む。id の合う応答だけを受ける。上限で BridgeTimeoutError */
export function requestViaWindow(
  win: BridgeWindow = window,
  origin: string = location.origin,
): CaptionDeps["request"] {
  return (params) =>
    new Promise<BridgeAnswer>((resolve, reject) => {
      const id = crypto.randomUUID();
      const onMessage = (event: MessageEvent): void => {
        if (event.source !== win || !isBridgeResponse(event.data) || event.data.id !== id) return;
        clearTimeout(timer);
        win.removeEventListener("message", onMessage);
        const data = event.data;
        if (data.ok) resolve({ ok: true, tracks: data.tracks, potUrl: data.potUrl, dubbed: data.dubbed });
        else if (data.reason === "error") resolve({ ok: false, reason: "error", message: data.message });
        else resolve({ ok: false, reason: data.reason });
      };
      const timer = setTimeout(
        () => {
          win.removeEventListener("message", onMessage);
          reject(new BridgeTimeoutError());
        },
        params.wantPot ? POT_TIMEOUT_MS : LIST_TIMEOUT_MS,
      );
      win.addEventListener("message", onMessage);
      win.postMessage({ type: BRIDGE_REQUEST, id, ...params } satisfies BridgeRequest, origin);
    });
}

export function defaultCaptionDeps(): CaptionDeps {
  return {
    request: requestViaWindow(),
    fetchText: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new CaptionError(`字幕を取れませんでした: HTTP ${response.status}`);
      return response.text();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
