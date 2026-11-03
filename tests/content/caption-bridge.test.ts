import { describe, expect, test } from "vitest";
import { answer, handleBridgeMessage, type BridgeDeps, type Player } from "@/content/caption-bridge";
import { BRIDGE_REQUEST, BRIDGE_RESPONSE, type BridgeResponse } from "@/content/caption-bridge-protocol";

const POT_URL = "https://www.youtube.com/api/timedtext?v=vid&lang=ja&pot=P0T&c=WEB&fmt=json3";

type Call = [string, ...unknown[]];

/** プレイヤーの要素の代わり。setOption で字幕を選ぶと、プレイヤーが pot 付きで取りに行ったことにする */
function setup(options: {
  videoId?: string;
  tracks?: unknown[];
  ccTrack?: unknown;
  audioId?: string;
  fetchesOnSelect?: boolean;
  ad?: boolean;
  /** 真なら、字幕を選んだ時ではなく待ちの途中 (sleep) で pot の URL を届ける (待ちのループで await を挟ませる) */
  deliverInSleep?: boolean;
  /** 字幕を選んだ回数がこれに満たない間は、pot の無い URL で取りに行く (開いた直後はトークンができていない) */
  potFromSelection?: number;
} = {}) {
  const calls: Call[] = [];
  let onUrl: ((url: string) => void) | null = null;
  let hidden = 0;
  let selections = 0;
  const player = {
    classList: { contains: (name: string) => options.ad === true && name === "ad-showing" },
    getPlayerResponse: () => ({
      videoDetails: { videoId: options.videoId ?? "vid" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: options.tracks ?? [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=ja&kind=asr", languageCode: "ja", kind: "asr", name: { simpleText: "日本語 (自動生成)" } },
          ],
        },
      },
    }),
    getOption: (module: string, option: string) => {
      calls.push(["getOption", module, option]);
      return options.ccTrack ?? {};
    },
    setOption: (module: string, option: string, value: unknown) => {
      calls.push(["setOption", module, option, value]);
      const selected = typeof value === "object" && value !== null && "languageCode" in value;
      if (!selected || options.fetchesOnSelect === false) return;
      selections += 1;
      onUrl?.(selections < (options.potFromSelection ?? 1) ? POT_URL.replace("&pot=P0T", "") : POT_URL);
    },
    loadModule: (module: string) => calls.push(["loadModule", module]),
    unloadModule: (module: string) => calls.push(["unloadModule", module]),
    getAudioTrack: () => ({ id: options.audioId ?? "251" }),
  } as unknown as Player;
  const deps: BridgeDeps = {
    player: () => player,
    observeTimedtext: (fn) => {
      onUrl = fn;
      return () => {
        onUrl = null;
      };
    },
    hideCaptions: () => {
      hidden += 1;
      return () => {
        hidden -= 1;
      };
    },
    sleep: async () => {
      await Promise.resolve();
      if (options.deliverInSleep === true) onUrl?.(POT_URL);
    },
  };
  return { calls, deps, hidden: () => hidden, observing: () => onUrl !== null };
}

describe("answer", () => {
  test("プレイヤーが無ければ no-player", async () => {
    const { deps } = setup();
    expect(await answer({ videoId: "vid", wantPot: true }, { ...deps, player: () => null })).toEqual({
      ok: false,
      reason: "no-player",
    });
  });

  test("広告が流れている間は ad-showing (字幕を取りに行かせない)", async () => {
    const { deps, calls } = setup({ ad: true });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({ ok: false, reason: "ad-showing" });
    expect(calls).toEqual([]);
  });

  test("プレイヤーの動画が頼まれた動画でなければ video-mismatch (SPA 遷移の直後)", async () => {
    const { deps } = setup({ videoId: "old" });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({ ok: false, reason: "video-mismatch" });
  });

  test("wantPot が偽なら一覧と吹き替えの判定だけ。プレイヤーに字幕を取りに行かせない", async () => {
    const { deps, calls } = setup();
    expect(await answer({ videoId: "vid", wantPot: false }, deps)).toEqual({
      ok: true,
      tracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=ja&kind=asr", languageCode: "ja", kind: "asr", name: "日本語 (自動生成)" },
      ],
      potUrl: null,
      dubbed: false,
    });
    expect(calls.filter(([name]) => name === "setOption")).toEqual([]);
  });

  test("字幕の無い動画は空の一覧で、取りに行かせない", async () => {
    const { deps, calls } = setup({ tracks: [] });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({
      ok: true,
      tracks: [],
      potUrl: null,
      dubbed: false,
    });
    expect(calls).toEqual([]);
  });

  test("字幕がオフの人: 隠して取りに行かせ、pot 付きの URL を返し、オフに戻す", async () => {
    const { deps, calls, hidden, observing } = setup();
    const result = await answer({ videoId: "vid", wantPot: true }, deps);
    expect(result).toMatchObject({ ok: true, potUrl: POT_URL });
    expect(calls).toEqual([
      ["getOption", "captions", "track"],
      ["loadModule", "captions"],
      ["setOption", "captions", "track", {}],
      ["setOption", "captions", "track", { languageCode: "ja", kind: "asr" }],
      ["setOption", "captions", "track", {}],
      ["unloadModule", "captions"],
    ]);
    expect(hidden()).toBe(0);
    expect(observing()).toBe(false);
  });

  test("字幕がオンの人: 同じ字幕を選び直して取りに行かせ、オンのまま残す", async () => {
    const previous = { languageCode: "en", kind: "", displayName: "英語" };
    const { deps, calls } = setup({ ccTrack: previous });
    await answer({ videoId: "vid", wantPot: true }, deps);
    expect(calls).toEqual([
      ["getOption", "captions", "track"],
      ["loadModule", "captions"],
      ["setOption", "captions", "track", {}],
      ["setOption", "captions", "track", previous],
    ]);
  });

  test("上限まで待っても拾えなければ potUrl は null。表示と字幕は戻す", async () => {
    const { deps, calls, hidden } = setup({ fetchesOnSelect: false });
    const result = await answer({ videoId: "vid", wantPot: true }, deps);
    expect(result).toMatchObject({ ok: true, potUrl: null });
    expect(calls.slice(-2)).toEqual([
      ["setOption", "captions", "track", {}],
      ["unloadModule", "captions"],
    ]);
    expect(hidden()).toBe(0);
  });

  test("プレイヤーが pot 無しで取りに行ったら (開いた直後)、選び直して pot 付きで取らせる", async () => {
    const { deps, calls } = setup({ potFromSelection: 3 });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toMatchObject({ ok: true, potUrl: POT_URL });
    const selects = calls.filter(([name, , , value]) => name === "setOption" && typeof value === "object" && value !== null && "languageCode" in value);
    expect(selects).toHaveLength(3);
  });

  test("pot の無い timedtext の URL は拾わない", async () => {
    const { deps } = setup({ fetchesOnSelect: false });
    const noisy: BridgeDeps = {
      ...deps,
      observeTimedtext: (fn) => {
        fn("https://www.youtube.com/api/timedtext?v=vid&lang=ja");
        return () => undefined;
      },
    };
    expect(await answer({ videoId: "vid", wantPot: true }, noisy)).toMatchObject({ potUrl: null });
  });

  test("別の動画 (v=) の timedtext の URL は拾わない", async () => {
    const { deps } = setup({ fetchesOnSelect: false });
    const other: BridgeDeps = {
      ...deps,
      observeTimedtext: (fn) => {
        fn("https://www.youtube.com/api/timedtext?v=other&lang=ja&pot=P0T");
        return () => undefined;
      },
    };
    expect(await answer({ videoId: "vid", wantPot: true }, other)).toMatchObject({ potUrl: null });
  });

  test("字幕の状態を読む getOption が throw しても、字幕の表示と見張りを残さない (ページに style を残さない)", async () => {
    const { deps, hidden, observing } = setup();
    const player = deps.player() as Player;
    const broken: BridgeDeps = {
      ...deps,
      player: () =>
        Object.assign(Object.create(player) as Player, {
          getOption: () => {
            throw new Error("getOption の形が変わった");
          },
        }),
    };
    await expect(answer({ videoId: "vid", wantPot: true }, broken)).rejects.toThrow("getOption の形が変わった");
    expect(hidden()).toBe(0);
    expect(observing()).toBe(false);
  });

  test("字幕を戻す setOption が throw しても、字幕の表示は戻す", async () => {
    const { deps, hidden } = setup();
    const player = deps.player() as Player;
    let calls = 0;
    const broken: BridgeDeps = {
      ...deps,
      player: () =>
        Object.assign(Object.create(player) as Player, {
          setOption: (module: string, option: string, value: unknown) => {
            calls += 1;
            // 3 本目 (取った後にオフへ戻す) で throw する
            if (calls === 3) throw new Error("setOption の形が変わった");
            player.setOption?.(module, option, value);
          },
        }),
    };
    await expect(answer({ videoId: "vid", wantPot: true }, broken)).rejects.toThrow("setOption の形が変わった");
    expect(hidden()).toBe(0);
  });

  test("字幕のオン / オフが読めない形なら、取りに行かせない (オンの人の字幕をオフにしない)", async () => {
    const { deps, calls, hidden } = setup({ ccTrack: { trackName: "形が変わった" } });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toMatchObject({ ok: true, potUrl: null });
    expect(calls).toEqual([["getOption", "captions", "track"]]);
    expect(hidden()).toBe(0);
  });

  test("吹き替えの音声が流れていれば dubbed", async () => {
    const { deps } = setup({ audioId: "251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoKCgRsYW5nEgJqYQ" });
    expect(await answer({ videoId: "vid", wantPot: false }, deps)).toMatchObject({ dubbed: true });
  });

  test("baseUrl か languageCode の無い字幕は一覧から落とす。手動は kind 'manual'", async () => {
    const { deps } = setup({
      tracks: [
        { languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=en", languageCode: "en", name: { runs: [{ text: "英語" }] } },
      ],
    });
    const result = await answer({ videoId: "vid", wantPot: false }, deps);
    expect(result).toMatchObject({
      tracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=en", languageCode: "en", kind: "manual", name: "英語" }],
    });
  });
});

describe("handleBridgeMessage", () => {
  test("同じ window からの形の合う頼みにだけ、id を付けて答える", async () => {
    const { deps } = setup();
    const self = {};
    const replies: BridgeResponse[] = [];
    const request = { type: BRIDGE_REQUEST, id: "r1", videoId: "vid", wantPot: false };
    handleBridgeMessage({ source: {}, data: request }, self, deps, (r) => replies.push(r));
    handleBridgeMessage({ source: self, data: { type: "other" } }, self, deps, (r) => replies.push(r));
    handleBridgeMessage({ source: self, data: request }, self, deps, (r) => replies.push(r));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: BRIDGE_RESPONSE, id: "r1", ok: true, potUrl: null });
  });

  test("答える途中で throw したら、理由を付けて返事をする (応答なしに化けさせない)", async () => {
    const { deps } = setup();
    const broken: BridgeDeps = {
      ...deps,
      player: () =>
        ({
          getPlayerResponse: () => {
            throw new TypeError("captionTracks の形が変わった");
          },
        }) as unknown as Player,
    };
    const self = {};
    const replies: BridgeResponse[] = [];
    handleBridgeMessage(
      { source: self, data: { type: BRIDGE_REQUEST, id: "e1", videoId: "vid", wantPot: false } },
      self,
      broken,
      (r) => replies.push(r),
    );
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toEqual([
      { type: BRIDGE_RESPONSE, id: "e1", ok: false, reason: "error", message: "captionTracks の形が変わった" },
    ]);
  });

  test("pot の頼みが 2 本重なっても 1 本ずつ答える (後の頼みが、前の頼みで選んだ字幕を「元はオン」と読まない)", async () => {
    // pot は待ちの途中で届く。字幕を選んだ時に同期で届くと、1 本目が await を挟まずに終わり、順番を見張れない
    const { deps, calls } = setup({ fetchesOnSelect: false, deliverInSleep: true });
    const self = {};
    const replies: BridgeResponse[] = [];
    for (const id of ["p1", "p2"]) {
      handleBridgeMessage(
        { source: self, data: { type: BRIDGE_REQUEST, id, videoId: "vid", wantPot: true } },
        self,
        deps,
        (r) => replies.push(r),
      );
    }
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies.map((r) => r.id)).toEqual(["p1", "p2"]);
    // 2 本とも「字幕はオフだった」として扱い、最後にオフへ戻している
    expect(calls.filter(([name]) => name === "unloadModule")).toHaveLength(2);
    const getOptions = calls.map(([name], i) => (name === "getOption" ? i : -1)).filter((i) => i >= 0);
    const firstUnload = calls.findIndex(([name]) => name === "unloadModule");
    expect(getOptions[1]).toBeGreaterThan(firstUnload);
  });
});
