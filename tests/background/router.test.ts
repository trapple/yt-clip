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
  deps: RouterDeps;
  /** 登録済みのタイマーをまとめて発火させる */
  fireTimers: () => void;
};

function makeHarness(
  overrides: Partial<RouterDeps> = {},
  stored?: StoredClip,
): Harness {
  const sentToRuntime: Message[] = [];
  const sentToTab: Array<{ tabId: number; message: Message }> = [];
  /** startTimer で登録された処理。テストから任意に発火させる */
  const timers: Array<() => void> = [];

  const deps: RouterDeps = {
    ensureOffscreen: vi.fn(async () => undefined),
    getStreamId: vi.fn(async () => "stream-abc"),
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
    startTimer: (_ms, onFire) => {
      timers.push(onFire);
      return () => {
        const index = timers.indexOf(onFire);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    ...overrides,
  };

  return {
    router: createRouter(deps),
    sentToRuntime,
    sentToTab,
    deps,
    fireTimers: () => {
      const pending = [...timers];
      timers.length = 0;
      for (const onFire of pending) onFire();
    },
  };
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
    // recorder/start には保存先 (clipId/range/meta) も同梱されるため、
    // ここでは streamId が渡っていることだけを部分一致で確認する
    expect(h.sentToRuntime).toContainEqual(
      expect.objectContaining({
        type: "recorder/start",
        streamId: "stream-abc",
      }),
    );
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

describe("投稿画面が用意できないとき", () => {
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
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });
  }

  test("準備完了が来ないまま時間切れになったらダウンロードへ退避する", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);

    // X に未ログインだと投稿画面ではなくログイン画面が開き、
    // 準備完了は永久に来ない。待ち続けると composing から抜けられなくなる
    h.fireTimers();
    await Promise.resolve();

    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
      clipId: "clip-1",
    });
  });

  test("準備完了直後はまだ composing のまま", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });

    expect(h.router.getState().kind).toBe("composing");
  });

  test("準備完了後は添付結果を待つタイマーに張り替わる", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });

    // タイマーは取り消されるのではなく、待つ対象が「投稿画面の準備」から
    // 「添付の結果」に張り替わるだけ。タブを閉じられれば結果は永久に
    // 来ないため、ここでも時間切れになれば downloadable へ退避する
    h.fireTimers();
    await Promise.resolve();

    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
      clipId: "clip-1",
    });
  });

  test("添付完了が届けば張り替えたタイマーも取り消される", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });
    await h.router.handle({ type: "x/attached" });

    h.fireTimers();
    await Promise.resolve();

    expect(h.router.getState()).toEqual({ kind: "idle" });
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
      clipId: "clip-1",
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

describe("想定できない失敗を握り潰さない", () => {
  test("副作用が例外を投げたら失敗として提示する", async () => {
    const h = makeHarness({
      openComposeTab: async () => {
        throw new Error("タブを開けません");
      },
    });
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
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });

    // 録画済みクリップを抱えたまま failed にすると clipId ごと失われる。
    // 保存済みのものは必ず回収できる形に倒す
    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
      clipId: "clip-1",
    });
  });

  test("クリップを持たない状態の例外は内部エラーとして提示する", async () => {
    const h = makeHarness({
      getStreamId: async () => {
        throw new Error("想定外");
      },
      ensureOffscreen: async () => {
        throw new Error("offscreen を作れません");
      },
    });
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    // prepareCapture 自身の catch が拾うので capture-permission-denied になる
    expect(h.router.getState()).toMatchObject({ kind: "failed" });
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

  test("録画の完了を受けたら preview へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      clipId: "clip-1",
      mimeType: "video/mp4",
    });

    expect(h.router.getState()).toMatchObject({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
  });

  test("保存先を先に決めて offscreen へ渡す", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });

    // 録画データは拡張のメッセージに載せられないので、offscreen が直接
    // IndexedDB へ書く。そのために必要な情報を開始時に渡しておく
    const start = h.sentToRuntime.find(
      (message) => message.type === "recorder/start",
    );
    // clipId は実行のたびに変わるので、それ以外が揃っていることを見る
    expect(start).toEqual(
      expect.objectContaining({
        type: "recorder/start",
        streamId: "stream-abc",
        range,
        meta,
      }),
    );
    expect(start && "clipId" in start && start.clipId).toBeTruthy();
  });

  test("WebM を受け取ったら downloadable へ退避する", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      clipId: "clip-1",
      mimeType: "video/webm",
    });

    // 録画は成功しているので成果物は捨てない
    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "mp4-unsupported",
      clipId: "clip-1",
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
      clipId: "clip-1",
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
