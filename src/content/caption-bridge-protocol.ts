import { isRecord } from "@/shared/guards";

/**
 * 隔離された world (youtube.ts) と MAIN world (caption-bridge) の間で `window.postMessage` に載せる形 (ADR 0002)。
 *
 * **両方の world から import する。chrome API に触らないこと** (MAIN world には chrome.runtime が無い)。
 * `window.postMessage` はページの他のスクリプトからも届くので、受け手は必ず判定 (isBridge…) を通す。
 * **頼みの id は秘密ではない** (ページのどのスクリプトも読める)。応答の中身はページが偽れる前提で、取りに行く URL の
 * 検査 (caption-source の isTimedtextUrl) と保存値の検証 (transcript-cache の isTranscript) で守る
 */

export const BRIDGE_REQUEST = "yt-clip/captions-request" as const;
export const BRIDGE_RESPONSE = "yt-clip/captions-response" as const;
/**
 * プレイヤーが pot 付きで字幕を取りに行くのを待つ上限。頼む側の待ちはこれより長くする。開いた直後は PO トークンが
 * まだ無く、できるまで (実機で 2.5 秒ほど) 選び直して待つ
 */
export const POT_WAIT_MS = 8000;
/** 失敗の理由の文字数の上限。応答はページの他のスクリプトも偽れるので、巨大な文字列を受け取らない */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

export type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind: "asr" | "manual";
  /** 表示名 (「日本語 (自動生成)」など) */
  name: string;
};

export type BridgeParams = {
  videoId: string;
  /** 偽なら字幕の一覧と吹き替えの判定だけを返す (プレイヤーに字幕を取りに行かせない。保存から読めたとき) */
  wantPot: boolean;
};

export type BridgeRequest = BridgeParams & { type: typeof BRIDGE_REQUEST; id: string };

export type BridgeAnswer =
  | { ok: true; tracks: CaptionTrack[]; potUrl: string | null; dubbed: boolean }
  /**
   * no-player: プレイヤーがまだ無い。video-mismatch: プレイヤーの動画がまだ切り替わっていない (SPA 遷移の直後)。
   * ad-showing: 広告が流れている (広告の間はプレイヤーの動画も字幕も本編のものにならない)
   */
  | { ok: false; reason: "no-player" | "video-mismatch" | "ad-showing" }
  /** ページの中で throw した (YouTube の非公開 API が変わったなど)。頼み直さずに理由を出す */
  | { ok: false; reason: "error"; message: string };

export type BridgeResponse = BridgeAnswer & { type: typeof BRIDGE_RESPONSE; id: string };

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    isRecord(value) &&
    value.type === BRIDGE_REQUEST &&
    typeof value.id === "string" &&
    typeof value.videoId === "string" &&
    typeof value.wantPot === "boolean"
  );
}

function isCaptionTrack(value: unknown): value is CaptionTrack {
  return (
    isRecord(value) &&
    typeof value.baseUrl === "string" &&
    typeof value.languageCode === "string" &&
    (value.kind === "asr" || value.kind === "manual") &&
    typeof value.name === "string"
  );
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value) || value.type !== BRIDGE_RESPONSE || typeof value.id !== "string") return false;
  if (value.ok === true) {
    return (
      Array.isArray(value.tracks) &&
      value.tracks.every(isCaptionTrack) &&
      (value.potUrl === null || typeof value.potUrl === "string") &&
      typeof value.dubbed === "boolean"
    );
  }
  if (value.ok !== false) return false;
  if (value.reason === "error") {
    return typeof value.message === "string" && value.message.length <= MAX_ERROR_MESSAGE_LENGTH;
  }
  return value.reason === "no-player" || value.reason === "video-mismatch" || value.reason === "ad-showing";
}

/**
 * いま流れている音声トラックが YouTube の自動吹き替えか。
 *
 * プレイヤーの `getAudioTrack().id` は `251;<base64url>` の形で、後半を開くと `acont` と `dubbed-auto`
 * (オリジナルは `original`) が入っている (2026-10-26 に実機で確認)。音声トラックが 1 つの動画は後半が無い。
 * **読めなければ偽** (知らせるだけの機能なので、読めないときに止めない)
 */
export function isDubbedTrackId(id: string | undefined): boolean {
  const tags = id?.split(";")[1];
  if (tags === undefined || tags === "") return false;
  try {
    const base64 = tags.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return decoded.includes("acont") && decoded.includes("dubbed");
  } catch {
    return false;
  }
}
