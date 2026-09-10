import { describe, expect, test, vi } from "vitest";
import {
  createRouter,
  type Router,
  type RouterDeps,
} from "@/background/router";
import type { StoredClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import type { ClipRange, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "abc123", title: "テスト動画" };
const range: ClipRange = { startSec: 10, endSec: 40 };

type Harness = {
  router: Router;
  sentToRuntime: Message[];
  sentToTab: Array<{ tabId: number; message: Message }>;
  saved: StoredClip[];
  deps: RouterDeps;
};

function makeHarness(
  overrides: Partial<RouterDeps> = {},
  stored?: StoredClip,
): Harness {
  const sentToRuntime: Message[] = [];
  const sentToTab: Array<{ tabId: number; message: Message }> = [];
  const saved: StoredClip[] = [];

  const deps: RouterDeps = {
    ensureOffscreen: vi.fn(async () => undefined),
    getStreamId: vi.fn(async () => "stream-abc"),
    saveClip: async (clip) => {
      saved.push(clip);
    },
    getClip: async () => {
      if (stored === undefined) throw new Error("クリップがありません");
      return stored;
    },
    sendToRuntime: (message) => {
      sentToRuntime.push(message);
    },
    sendToTab: (tabId, message) => {
      sentToTab.push({ tabId, message });
    },
    openComposeTab: async () => 99,
    loadTemplate: async () => "{title}\n\n{url}",
    now: () => Date.UTC(2026, 8, 10, 3, 0, 0),
    persist: async () => undefined,
    ...overrides,
  };

  return { router: createRouter(deps), sentToRuntime, sentToTab, saved, deps };
}

/** IN/OUT を打って録画直前まで進める */
async function markRange(router: Router, tabId = 7): Promise<void> {
  await router.handle(
    { type: "clip/event", event: { type: "MARK_IN", sec: 10, meta } },
    tabId,
  );
  await router.handle(
    { type: "clip/event", event: { type: "MARK_OUT", sec: 40 } },
    tabId,
  );
}

describe("録画の開始", () => {
  test("録画要求で offscreen を用意し streamId を取る", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    expect(h.deps.ensureOffscreen).toHaveBeenCalledTimes(1);
    expect(h.deps.getStreamId).toHaveBeenCalledWith(7);
    expect(h.router.getState().kind).toBe("seeking");
  });

  test("streamId が取れなければ理由つきで失敗する", async () => {
    const h = makeHarness({
      getStreamId: async () => {
        throw new Error("拒否されました");
      },
    });
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "capture-permission-denied",
    });
  });

  test("seek 完了だけでは recording へ進まず録画開始を指示する", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({
      type: "clip/event",
      event: { type: "SEEK_DONE" },
    });

    // 冒頭欠けを防ぐため、録画が始まるまで seeking のまま留まる
    expect(h.router.getState().kind).toBe("seeking");
    expect(h.sentToRuntime).toContainEqual({
      type: "recorder/start",
      streamId: "stream-abc",
    });
  });

  test("録画開始の通知を受けてはじめて recording へ進む", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });

    expect(h.router.getState().kind).toBe("recording");
    // content が再生を再開できるよう、録画対象タブへ状態変化を通知する
    expect(h.sentToTab).toContainEqual({
      tabId: 7,
      message: { type: "state/changed", state: h.router.getState() },
    });
  });
});

describe("受け付けられないメッセージで状態を壊さない", () => {
  const clip: StoredClip = {
    id: "clip-1",
    blob: new Blob(["動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    range,
    meta,
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };

  /** 録画を完走させて composing まで進める */
  async function reachComposing(h: Harness): Promise<void> {
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });
  }

  test("添付失敗が二重に届いても録画済みクリップへの参照を失わない", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/failed", reason: "セレクタ不一致" });
    // 二度目。downloadable は DEGRADE を受理しないので拒まれる遷移になる
    await h.router.handle({ type: "x/failed", reason: "セレクタ不一致" });

    const state = h.router.getState();
    expect(state.kind).toBe("downloadable");
    // failed に落ちると clipId ごと失われ、録画した動画を取り出せなくなる
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
  });

  test("録画開始の通知が二重に届いても recording のまま保つ", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({ type: "recorder/started" });

    expect(h.router.getState().kind).toBe("recording");
  });

  test("二度目の seek 完了を権限エラーとして報告しない", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    // 録画中に届いた重複。権限は関係ない
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });

    expect(h.router.getState().kind).toBe("recording");
  });

  test("録画中は別タブからの IN も受け付けない", async () => {
    const h = makeHarness();
    await markRange(h.router, 7);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });

    // 状態変化を受け取っていない別タブは録画中だと知らないまま IN を送りうる
    await h.router.handle(
      { type: "clip/event", event: { type: "MARK_IN", sec: 5, meta } },
      99,
    );

    // 録画対象タブを奪われると offscreen の録画が解放されないまま取り残される
    expect(h.router.getState().kind).toBe("recording");
    expect(h.sentToTab.every((sent) => sent.tabId === 7)).toBe(true);
  });
});

describe("状態が進まなかったときは副作用を出さない", () => {
  test("二度目の録画要求では録画準備をやり直さない", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    // 二度目。reduce は seeking からの START_RECORDING を受理しない
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    // 状態が failed なのに録画準備だけ進む、という食い違いを防ぐ
    expect(h.deps.ensureOffscreen).toHaveBeenCalledTimes(1);
    expect(h.deps.getStreamId).toHaveBeenCalledTimes(1);
    // 受け付けられない二度目の要求で状態が壊れないこと
    expect(h.router.getState().kind).toBe("seeking");
  });

  test("失敗後に OUT に達しても録画停止を指示しない", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    // 録画が死ぬ。ただし YouTube の再生は止まらないので OUT には到達する
    await h.router.handle({ type: "recorder/failed", reason: "デバイスエラー" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });

    expect(h.sentToRuntime).not.toContainEqual({ type: "recorder/stop" });
    // 失敗の理由が internal-error に書き換わっていないこと
    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "recording-aborted",
    });
  });
});

describe("録画の終了と保存", () => {
  async function recordUntilEncoding(h: Harness): Promise<void> {
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });
  }

  test("OUT 到達で録画停止を指示し encoding へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);

    expect(h.router.getState().kind).toBe("encoding");
    expect(h.sentToRuntime).toContainEqual({ type: "recorder/stop" });
  });

  test("MP4 を受け取ったら保存して preview へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/mp4",
    });

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      mimeType: "video/mp4",
      range,
      meta,
      createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
    });
    expect(h.router.getState()).toMatchObject({ kind: "preview" });
  });

  test("WebM を受け取ったら保存した上で downloadable へ退避する", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/webm",
    });

    // 録画は成功しているので成果物は捨てない
    expect(h.saved).toHaveLength(1);
    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "mp4-unsupported",
    });
  });

  test("録画側の失敗は握り潰さず failed にする", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/failed",
      reason: "デバイスエラー",
    });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "recording-aborted",
    });
  });
});

describe("X への受け渡し", () => {
  const clip: StoredClip = {
    id: "clip-1",
    blob: new Blob(["動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    range,
    meta,
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };

  async function reachComposing(h: Harness): Promise<void> {
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });
  }

  test("投稿タブの準備完了で本文とファイルを送る", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });

    const payload = h.sentToTab.find(
      (sent) => sent.message.type === "x/payload",
    );
    expect(payload?.tabId).toBe(99);
    expect(payload?.message).toMatchObject({
      type: "x/payload",
      mimeType: "video/mp4",
      fileName: "yt-clip-abc123-10s.mp4",
      text: "テスト動画\n\nhttps://youtu.be/abc123?t=10",
    });
  });

  test("添付完了で idle に戻る", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/attached" });

    expect(h.router.getState()).toEqual({ kind: "idle" });
  });

  test("添付失敗でも成果物は捨てず downloadable へ退避する", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/failed", reason: "セレクタ不一致" });

    const state = h.router.getState();
    expect(state).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
      mimeType: "video/mp4",
    });
    // 保存済みクリップへの参照が残っていること
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
  });
});
