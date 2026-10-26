import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  isBridgeRequest,
  isBridgeResponse,
  isDubbedTrackId,
} from "@/content/caption-bridge-protocol";

/** プレイヤーの音声トラックの id の形 (`itag;<base64url の protobuf>`) を作る */
const trackId = (tags: string): string => `251;${Buffer.from(tags, "latin1").toString("base64url")}`;

describe("isDubbedTrackId", () => {
  test("実機の吹き替えの id (acont=dubbed-auto) は真", () => {
    expect(isDubbedTrackId("251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoKCgRsYW5nEgJqYQ")).toBe(true);
  });

  test("オリジナルの音声 (acont=original) は偽", () => {
    expect(isDubbedTrackId(trackId("\n\x11\n\x05acont\x12\x08original"))).toBe(false);
  });

  test("吹き替えの印を作った id も真 (base64url の詰め物なし)", () => {
    expect(isDubbedTrackId(trackId("\n\x14\n\x05acont\x12\x0bdubbed-auto"))).toBe(true);
  });

  test("音声トラックが 1 つの動画 (後半なし)・取れない・壊れた id は偽", () => {
    expect(isDubbedTrackId("251")).toBe(false);
    expect(isDubbedTrackId("251;")).toBe(false);
    expect(isDubbedTrackId(undefined)).toBe(false);
    expect(isDubbedTrackId("251;!!!")).toBe(false);
  });
});

describe("isBridgeRequest", () => {
  test("形の合う頼みだけ真", () => {
    expect(isBridgeRequest({ type: BRIDGE_REQUEST, id: "a", videoId: "v", wantPot: true })).toBe(true);
    expect(isBridgeRequest({ type: BRIDGE_REQUEST, id: "a", videoId: "v" })).toBe(false);
    expect(isBridgeRequest({ type: "other", id: "a", videoId: "v", wantPot: true })).toBe(false);
    expect(isBridgeRequest("yt-clip")).toBe(false);
  });
});

describe("isBridgeResponse", () => {
  const track = { baseUrl: "https://www.youtube.com/api/timedtext?v=v", languageCode: "ja", kind: "asr", name: "日本語" };

  test("成功の応答", () => {
    expect(
      isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [track], potUrl: null, dubbed: false }),
    ).toBe(true);
  });

  test("失敗の応答は決まった理由だけ", () => {
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "no-player" })).toBe(true);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "ad-showing" })).toBe(true);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "other" })).toBe(false);
  });

  test("字幕の形が違う・dubbed が無い応答は偽 (ページの別のスクリプトが送ったものを使わない)", () => {
    expect(
      isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [{ ...track, kind: "x" }], potUrl: null, dubbed: false }),
    ).toBe(false);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [], potUrl: null })).toBe(false);
  });
});
