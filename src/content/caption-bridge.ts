import {
  BRIDGE_RESPONSE,
  MAX_ERROR_MESSAGE_LENGTH,
  POT_WAIT_MS,
  isBridgeRequest,
  isDubbedTrackId,
  type BridgeAnswer,
  type BridgeParams,
  type BridgeResponse,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";
import { YT_SELECTORS } from "@/content/selectors";

/**
 * MAIN world で動く、公式字幕のブリッジ (ADR 0002)。
 *
 * **頼まれたときだけ動く。** オフの間も読み込まれて `message` の listener を 1 本置くが (MAIN world は chrome.storage を
 * 読めず、オン / オフを知らない)、頼むのは隔離された world のオンの間だけ。chrome API に触らないこと
 */

/** プレイヤーの要素が持つ API のうち使うもの。**公開 API ではない** (YouTube が変えたら壊れる。ADR 0002) */
export type Player = HTMLElement & {
  getPlayerResponse?(): PlayerResponse | undefined;
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
  unloadModule?(module: string): void;
  getAudioTrack?(): { id?: string } | undefined;
};

type RawTrack = {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  name?: { simpleText?: unknown; runs?: { text?: unknown }[] };
};

type PlayerResponse = {
  videoDetails?: { videoId?: unknown };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawTrack[] } };
};

export type BridgeDeps = {
  player(): Player | null;
  /** `/api/timedtext` へのリクエストの URL を知らせる。戻り値で見張りを外す */
  observeTimedtext(onUrl: (url: string) => void): () => void;
  /** 字幕の表示を隠す。戻り値で戻す */
  hideCaptions(): () => void;
  sleep(ms: number): Promise<void>;
};

const POLL_MS = 100;
const HIDE_STYLE_ID = "yt-clip-hide-captions";

function trackName(name: RawTrack["name"]): string {
  if (typeof name?.simpleText === "string") return name.simpleText;
  const first = name?.runs?.[0]?.text;
  return typeof first === "string" ? first : "";
}

function toTracks(response: PlayerResponse): CaptionTrack[] {
  const raw = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const tracks: CaptionTrack[] = [];
  for (const track of raw) {
    if (typeof track.baseUrl !== "string" || typeof track.languageCode !== "string") continue;
    tracks.push({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: track.kind === "asr" ? "asr" : "manual",
      name: trackName(track.name),
    });
  }
  return tracks;
}

function videoOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * 字幕のオン / オフ (getOption の track)。オフは未定義か空のオブジェクト、オンは言語を持つもの。
 * **それ以外の形は「分からない」**: 推し量ってオフと読むと、取った後にオンの人の字幕をオフにしてしまう
 */
function captionState(value: unknown): "on" | "off" | "unknown" {
  if (value === undefined || value === null) return "off";
  if (typeof value !== "object") return "unknown";
  if (Object.keys(value).length === 0) return "off";
  const language = (value as { languageCode?: unknown }).languageCode;
  return typeof language === "string" && language !== "" ? "on" : "unknown";
}

/**
 * プレイヤーに字幕を取りに行かせ、その URL (pot 付き) を拾う。**字幕の状態と表示は必ず戻す**:
 * オフだった人はオフに (モジュールも外す)、オンだった人は同じ字幕のまま。途中で throw しても、隠した表示と
 * 見張りはページに残さない (残ると、オフにしても読み直すまでそのタブで字幕が出ない)。
 * 字幕のオン / オフが読めない形なら取りに行かせない (null を返す)
 */
async function capturePot(
  player: Player,
  first: CaptionTrack,
  videoId: string,
  deps: BridgeDeps,
): Promise<string | null> {
  // 表示を隠す前に読む。ここで throw しても、まだページに何も足していない
  const previous = player.getOption?.("captions", "track");
  const state = captionState(previous);
  if (state === "unknown") return null;
  const wasOn = state === "on";
  let found: string | null = null;
  let stopObserving: (() => void) | undefined;
  let showCaptions: (() => void) | undefined;
  try {
    stopObserving = deps.observeTimedtext((url) => {
      // 同じ時に別の動画 (広告など) の字幕を取りに行くことがある。その pot は効かないので、頼まれた動画のものだけ
      if (found === null && /[?&]pot=/.test(url) && videoOf(url) === videoId) found = url;
    });
    showCaptions = deps.hideCaptions();
    player.loadModule?.("captions");
    // 一度外してから選ぶ。同じ字幕を選び直すだけでは、プレイヤーが取り直さない
    player.setOption?.("captions", "track", {});
    player.setOption?.(
      "captions",
      "track",
      wasOn ? previous : { languageCode: first.languageCode, kind: first.kind === "asr" ? "asr" : "" },
    );
    for (let waited = 0; found === null && waited < POT_WAIT_MS; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
    }
  } finally {
    try {
      stopObserving?.();
      if (!wasOn) {
        player.setOption?.("captions", "track", {});
        player.unloadModule?.("captions");
      }
    } finally {
      // 字幕を戻すところで throw しても、隠した表示だけは必ず戻す
      showCaptions?.();
    }
  }
  return found;
}

export async function answer(params: BridgeParams, deps: BridgeDeps): Promise<BridgeAnswer> {
  const player = deps.player();
  const response = player?.getPlayerResponse?.();
  if (player === null || response === undefined) return { ok: false, reason: "no-player" };
  // 広告の間は本編の字幕を取りに行けない。頼む側が明けるまで待つ (caption-source の ask)
  if (player.classList?.contains("ad-showing") === true) return { ok: false, reason: "ad-showing" };
  if (response.videoDetails?.videoId !== params.videoId) return { ok: false, reason: "video-mismatch" };
  const tracks = toTracks(response);
  const dubbed = isDubbedTrackId(player.getAudioTrack?.()?.id);
  const first = tracks[0];
  if (!params.wantPot || first === undefined) return { ok: true, tracks, potUrl: null, dubbed };
  return { ok: true, tracks, potUrl: await capturePot(player, first, params.videoId, deps), dubbed };
}

/**
 * 答えている途中の頼み。**頼みは 1 本ずつ順に答える**: pot を取る間はプレイヤーの字幕を切り替えるので、2 本が重なると
 * 後の 1 本が前の 1 本の選んだ字幕を「元はオン」と読み、字幕をオフにしていた人の字幕がオンのまま残る
 */
let inFlight: Promise<unknown> = Promise.resolve();

/** `window` の message を 1 通受ける。同じ window からの、形の合う頼みにだけ答える */
export function handleBridgeMessage(
  event: { source: unknown; data: unknown },
  self: unknown,
  deps: BridgeDeps,
  reply: (response: BridgeResponse) => void,
): void {
  if (event.source !== self || !isBridgeRequest(event.data)) return;
  const { id, videoId, wantPot } = event.data;
  const run = inFlight.then(() => answer({ videoId, wantPot }, deps));
  inFlight = run.catch(() => undefined);
  void run.then(
    (result) => reply({ ...result, type: BRIDGE_RESPONSE, id }),
    // 返事をしないと、頼む側は「ページからの応答がありません」で頼み直し続け、本当の理由が分からなくなる
    (error: unknown) =>
      reply({
        type: BRIDGE_RESPONSE,
        id,
        ok: false,
        reason: "error",
        message: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE_LENGTH),
      }),
  );
}

function defaultDeps(): BridgeDeps {
  return {
    player: () => document.querySelector<Player>(YT_SELECTORS.player),
    observeTimedtext: (onUrl) => {
      // 既定のリソースの記録 (getEntriesByType) は 250 件で埋まり、YouTube ではすぐ拾えなくなる。observer は件数に縛られない
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name.includes("/api/timedtext")) onUrl(entry.name);
        }
      });
      observer.observe({ type: "resource", buffered: false });
      return () => observer.disconnect();
    },
    hideCaptions: () => {
      const style = document.createElement("style");
      style.id = HIDE_STYLE_ID;
      style.textContent = ".ytp-caption-window-container{display:none!important}";
      document.head.append(style);
      return () => style.remove();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** listener を 1 本置く。戻り値で外す (MAIN world の入口は外さない。テスト用) */
export function installBridge(deps: BridgeDeps = defaultDeps()): () => void {
  const onMessage = (event: MessageEvent): void => {
    handleBridgeMessage(event, window, deps, (response) => window.postMessage(response, location.origin));
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
