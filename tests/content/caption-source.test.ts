import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AD_MAX_WAIT_MS,
  AD_WAIT_MS,
  BRIDGE_RETRIES,
  BridgeTimeoutError,
  CaptionError,
  fetchOfficialTranscript,
  isTimedtextUrl,
  pickTrack,
  readDubbed,
  requestViaWindow,
  withPot,
  type BridgeWindow,
  type CaptionDeps,
} from "@/content/caption-source";
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  type BridgeAnswer,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";

afterEach(() => {
  vi.useRealTimers();
});

const track = (languageCode: string, kind: "asr" | "manual"): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=vid&lang=${languageCode}${kind === "asr" ? "&kind=asr" : ""}&exp=xpe`,
  languageCode,
  kind,
  name: languageCode,
});

const POT_URL =
  "https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=P0T&potc=1&c=WEB&cver=2.2026&fmt=srv3&xorb=2&other=keep-out";

describe("pickTrack", () => {
  test("自動字幕と同じ言語の手動字幕があればそれ", () => {
    expect(pickTrack([track("en", "manual"), track("ja", "asr"), track("ja-JP", "manual")])).toEqual(
      track("ja-JP", "manual"),
    );
  });
  test("話している言語の手動字幕が無ければ自動字幕", () => {
    expect(pickTrack([track("en", "manual"), track("ja", "asr")])).toEqual(track("ja", "asr"));
  });
  test("自動字幕が無ければ最初の手動字幕。何も無ければ null", () => {
    expect(pickTrack([track("es", "manual"), track("en", "manual")])).toEqual(track("es", "manual"));
    expect(pickTrack([])).toBeNull();
  });
});

describe("withPot / isTimedtextUrl", () => {
  test("pot ほかの引数を写し、fmt を json3 にする。関係ない引数は写さない", () => {
    const url = new URL(withPot(track("ja", "asr").baseUrl, POT_URL));
    expect(url.searchParams.get("lang")).toBe("ja");
    expect(url.searchParams.get("pot")).toBe("P0T");
    expect(url.searchParams.get("potc")).toBe("1");
    expect(url.searchParams.get("c")).toBe("WEB");
    expect(url.searchParams.get("xorb")).toBe("2");
    expect(url.searchParams.get("fmt")).toBe("json3");
    expect(url.searchParams.get("other")).toBeNull();
  });
  test("YouTube の字幕の URL 以外は使わない (ページから届いた URL で別の所へ取りに行かない)", () => {
    expect(isTimedtextUrl("https://www.youtube.com/api/timedtext?v=1")).toBe(true);
    expect(isTimedtextUrl("https://evil.example/api/timedtext?v=1")).toBe(false);
    expect(isTimedtextUrl("http://www.youtube.com/api/timedtext?v=1")).toBe(false);
    expect(isTimedtextUrl("not a url")).toBe(false);
    expect(() => withPot("https://evil.example/api/timedtext", POT_URL)).toThrow(CaptionError);
  });
});

function deps(overrides: Partial<CaptionDeps> & { answers?: (BridgeAnswer | Error)[] } = {}) {
  const answers = overrides.answers ?? [];
  const requested: unknown[] = [];
  const fetched: string[] = [];
  const result: CaptionDeps = {
    request: async (params) => {
      requested.push(params);
      const next = answers.shift();
      if (next === undefined) throw new Error("頼みが多すぎます");
      if (next instanceof Error) throw next;
      return next;
    },
    fetchText: async (url) => {
      fetched.push(url);
      return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "こんにちは" }] }] });
    },
    sleep: async () => undefined,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps: result, requested, fetched };
}

describe("fetchOfficialTranscript", () => {
  test("選んだ字幕を pot 付きで取り、行にする", async () => {
    const { deps: d, requested, fetched } = deps({
      answers: [{ ok: true, tracks: [track("ja", "manual"), track("ja", "asr")], potUrl: POT_URL, dubbed: true }],
    });
    const result = await fetchOfficialTranscript("vid", d);
    expect(requested).toEqual([{ videoId: "vid", wantPot: true }]);
    expect(new URL(fetched[0] ?? "").searchParams.get("pot")).toBe("P0T");
    expect(result).toEqual({
      kind: "ready",
      dubbed: true,
      transcript: {
        videoId: "vid",
        source: "youtube-manual",
        language: "ja",
        savedAt: 1_700_000_000_000,
        lines: [{ id: "youtube-manual:1.00", startSec: 1, endSec: 3, text: "こんにちは" }],
      },
    });
  });

  test("字幕が無ければ none", async () => {
    const { deps: d, fetched } = deps({ answers: [{ ok: true, tracks: [], potUrl: null, dubbed: false }] });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(fetched).toEqual([]);
  });

  test("プレイヤーの動画がまだ切り替わっていなければ待って頼み直す", async () => {
    const { deps: d, requested } = deps({
      answers: [
        { ok: false, reason: "video-mismatch" },
        new BridgeTimeoutError(),
        { ok: true, tracks: [], potUrl: null, dubbed: false },
      ],
    });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(requested).toHaveLength(3);
  });

  test("頼み直しても駄目なら理由を付けて throw する", async () => {
    const answers = Array.from({ length: BRIDGE_RETRIES }, (): BridgeAnswer => ({ ok: false, reason: "no-player" }));
    const { deps: d } = deps({ answers });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("プレイヤーが見つかりません");
  });

  test("広告の間は回数に数えずに待ち、明けたら取る", async () => {
    const ad: BridgeAnswer = { ok: false, reason: "ad-showing" };
    const answers: BridgeAnswer[] = [
      ...Array.from({ length: BRIDGE_RETRIES + 2 }, () => ad),
      { ok: true, tracks: [], potUrl: null, dubbed: false },
    ];
    const { deps: d, requested } = deps({ answers });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(requested).toHaveLength(BRIDGE_RETRIES + 3);
  });

  test("広告が上限まで明けなければ throw する", async () => {
    const answers = Array.from({ length: AD_MAX_WAIT_MS / AD_WAIT_MS + 1 }, (): BridgeAnswer => ({ ok: false, reason: "ad-showing" }));
    const { deps: d } = deps({ answers });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("広告が終わらないため字幕を取れませんでした");
  });

  test("ページの中で失敗したら、頼み直さずにその理由で throw する", async () => {
    const { deps: d, requested } = deps({
      answers: [{ ok: false, reason: "error", message: "captionTracks の形が変わった" }],
    });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow(
      "ページの中で失敗しました: captionTracks の形が変わった",
    );
    expect(requested).toHaveLength(1);
  });

  test("字幕が json3 でなければ、読めなかったことが分かる理由で throw する", async () => {
    const { deps: d } = deps({
      answers: [{ ok: true, tracks: [track("ja", "asr")], potUrl: POT_URL, dubbed: false }],
      fetchText: async () => "<html>not json</html>",
    });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("字幕 (json3) を読めませんでした");
  });

  test("pot を拾えなければ throw する", async () => {
    const { deps: d } = deps({ answers: [{ ok: true, tracks: [track("ja", "asr")], potUrl: null, dubbed: false }] });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("字幕の取得に要る情報を拾えませんでした");
  });

  test("空で返れば throw する (pot が効かなかった。字幕が無いのと見分ける)", async () => {
    const { deps: d } = deps({
      answers: [{ ok: true, tracks: [track("ja", "asr")], potUrl: POT_URL, dubbed: false }],
      fetchText: async () => "",
    });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("字幕が空で返りました");
  });
});

test("中止されたら、それ以降は頼まず取りに行かない (オフにした後に字幕を取りに行かない)", async () => {
  const controller = new AbortController();
  const ad: BridgeAnswer = { ok: false, reason: "ad-showing" };
  const { deps: d, requested, fetched } = deps({
    answers: [ad, ad, ad],
    sleep: async () => {
      controller.abort(new Error("止めました"));
    },
  });
  await expect(fetchOfficialTranscript("vid", d, controller.signal)).rejects.toThrow("止めました");
  expect(requested).toHaveLength(1);
  expect(fetched).toEqual([]);
});

test("readDubbed は字幕を取りに行かせずに判定だけ読む", async () => {
  const { deps: d, requested } = deps({ answers: [{ ok: true, tracks: [], potUrl: null, dubbed: true }] });
  expect(await readDubbed("vid", d)).toBe(true);
  expect(requested).toEqual([{ videoId: "vid", wantPot: false }]);
});

describe("requestViaWindow", () => {
  /** window の代わり。postMessage で受けた頼みを respond に渡し、返した値を同じ window からの message として届ける */
  function fakeWindow(respond: (request: Record<string, unknown>) => unknown) {
    const listeners = new Set<(event: MessageEvent) => void>();
    const posted: unknown[] = [];
    const win: BridgeWindow = {
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      postMessage: (message) => {
        posted.push(message);
        const reply = respond(message as Record<string, unknown>);
        if (reply === undefined) return;
        for (const fn of [...listeners]) fn({ source: win, data: reply } as unknown as MessageEvent);
      },
    };
    return { win, posted, listeners };
  }

  test("id の合う応答を答えにする。listener は外す", async () => {
    const { win, posted, listeners } = fakeWindow((request) => ({
      type: BRIDGE_RESPONSE,
      id: request.id,
      ok: true,
      tracks: [],
      potUrl: null,
      dubbed: false,
    }));
    const answer = await requestViaWindow(win, "https://www.youtube.com")({ videoId: "vid", wantPot: false });
    expect(answer).toEqual({ ok: true, tracks: [], potUrl: null, dubbed: false });
    expect(posted[0]).toMatchObject({ type: BRIDGE_REQUEST, videoId: "vid", wantPot: false });
    expect(listeners.size).toBe(0);
  });

  test("ページの中の失敗の応答は、理由ごと答えにする", async () => {
    const { win } = fakeWindow((request) => ({
      type: BRIDGE_RESPONSE,
      id: request.id,
      ok: false,
      reason: "error",
      message: "壊れた",
    }));
    const answer = await requestViaWindow(win, "https://www.youtube.com")({ videoId: "vid", wantPot: false });
    expect(answer).toEqual({ ok: false, reason: "error", message: "壊れた" });
  });

  test("id の違う応答・形の違う応答は無視し、上限で BridgeTimeoutError", async () => {
    vi.useFakeTimers();
    const { win, listeners } = fakeWindow(() => ({ type: BRIDGE_RESPONSE, id: "someone-else", ok: false, reason: "no-player" }));
    const pending = requestViaWindow(win, "https://www.youtube.com")({ videoId: "vid", wantPot: false });
    const settled = expect(pending).rejects.toBeInstanceOf(BridgeTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(listeners.size).toBe(0);
  });
});
