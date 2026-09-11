import { describe, expect, test } from "vitest";
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
  /** 保存された StoredClip。saveClip がフェイクへ積んだ結果 */
  saved: StoredClip[];
  /** 登録済みのタイマーをまとめて発火させる */
  fireTimers: () => void;
  /** 取り消し漏れがないかを確認するための、登録済みタイマー数 */
  pendingTimerCount: () => number;
};

function makeHarness(
  overrides: Partial<RouterDeps> = {},
  stored?: StoredClip,
): Harness {
  const sentToRuntime: Message[] = [];
  const sentToTab: Array<{ tabId: number; message: Message }> = [];
  const saved: StoredClip[] = [];
  /** startTimer で登録された処理。テストから任意に発火させる */
  const timers: Array<() => void> = [];

  const deps: RouterDeps = {
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
    sendToTab: async (tabId, message) => {
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
    saved,
    fireTimers: () => {
      const pending = [...timers];
      timers.length = 0;
      for (const onFire of pending) onFire();
    },
    pendingTimerCount: () => timers.length,
  };
}

/** IN/OUT を打って録画直前まで進める */
async function markRange(router: Router, tabId = 7): Promise<void> {
  await router.handle(
    { type: "clip/event", event: { type: "MARK_IN", range, meta } },
    tabId,
  );
  await router.handle(
    { type: "clip/event", event: { type: "MARK_OUT", sec: 40 } },
    tabId,
  );
}

describe("録画の開始", () => {
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
    // 録画するのは content script なので、指示はタブ宛に送る
    expect(h.sentToTab).toContainEqual({
      tabId: 7,
      message: { type: "recorder/start" },
    });
  });

  test("seek 完了を受けたら録画対象のタブへ開始を指示する", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });

    // 録画するのは content script なので、指示はタブ宛に送る
    expect(h.sentToTab).toContainEqual({
      tabId: 7,
      message: { type: "recorder/start" },
    });
  });

  test("録画対象のタブが分からなければ失敗として提示する", async () => {
    const h = makeHarness();
    // タブ ID を持たない経路 (popup から直接) で範囲を作る
    await h.router.handle({
      type: "clip/event",
      event: { type: "MARK_IN", range, meta },
    });
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "tab-lost",
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
      base64: "AAECAw==",
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

    // clipId は保存時に service worker 側で採番するため、値そのものではなく
    // 存在することだけを確認する
    const state = h.router.getState();
    expect(state).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
    });
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
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

    // clipId は保存時に service worker 側で採番するため、値そのものではなく
    // 存在することだけを確認する
    const state = h.router.getState();
    expect(state).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
    });
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
  });

  test("添付完了が届けば張り替えたタイマーも取り消される", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });
    expect(h.pendingTimerCount()).toBe(1);

    await h.router.handle({ type: "x/attached" });

    // x/attached 後は idle なので DEGRADE は拒まれる遷移になり、タイマーを
    // 取り消し忘れても fireTimers で状態は動かない。だからこそタイマーが
    // 実際に片付いていることを直接確認する
    expect(h.pendingTimerCount()).toBe(0);
    expect(h.router.getState()).toEqual({ kind: "idle" });
  });
});

describe("投稿待ちから離れたらタイマーを始末する", () => {
  const clip: StoredClip = {
    id: "clip-1",
    blob: new Blob(["動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    range,
    meta,
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };

  test("取り直しで抜けた後は古いタイマーが発火しても影響しない", async () => {
    const h = makeHarness({}, clip);
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
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });

    // 投稿画面が開かないので取り直しで抜ける
    await h.router.handle({ type: "clip/event", event: { type: "RETAKE" } });
    expect(h.router.getState().kind).toBe("ready");

    // 残っていたタイマーが後から発火しても、関係ない場面を壊さない
    h.fireTimers();
    await Promise.resolve();

    expect(h.router.getState().kind).toBe("ready");
  });

  // brief 記載のテストに加えて追加した回帰テスト。上のテストは RETAKE 直後の
  // "ready" でタイマーを発火させるが、"ready" は DEGRADE を受理しないため
  // 拒まれる遷移になり、タイマーを取り消していなくても偶然通ってしまう
  // (実際に確認済み)。実害が出るのは "preview" (DEGRADE を受理する) まで
  // 進んでから発火した場合なので、そこまで再現してから検証する。
  test("取り直しで抜けた後、録り直した preview を古いタイマーが壊さない", async () => {
    const h = makeHarness({}, clip);
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
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });
    await h.router.handle({ type: "clip/event", event: { type: "RETAKE" } });

    // 30 秒以内に録り直して preview まで進む。ここで古いタイマーが残っていると、
    // 全く無関係なこの場面が「X の画面構成が変わった」という誤った理由で
    // downloadable に落ちてしまう
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
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });
    expect(h.router.getState().kind).toBe("preview");

    h.fireTimers();
    await Promise.resolve();

    expect(h.router.getState().kind).toBe("preview");
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
      base64: "AAECAw==",
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
      {
        type: "clip/event",
        event: { type: "MARK_IN", range: { startSec: 5, endSec: 20 }, meta },
      },
      99,
    );

    // 録画対象タブを奪われると、録画中の content script への指示が届かなくなる
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
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });

    // 録画済みクリップを抱えたまま failed にすると clipId ごと失われる。
    // 保存済みのものは必ず回収できる形に倒す
    // clipId は保存時に service worker 側で採番するため、値そのものではなく
    // 存在することだけを確認する
    const state = h.router.getState();
    expect(state).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
    });
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
  });

  test("クリップを持たない状態の例外は内部エラーとして提示する", async () => {
    // catch-all (handle 側) を確実に踏ませるため、どの経路にも
    // try/catch のない persist の失敗を注入する
    let shouldFailPersist = false;
    const h = makeHarness({
      persist: async () => {
        if (shouldFailPersist) {
          throw new Error("永続化に失敗しました");
        }
      },
    });
    await markRange(h.router);

    // preview/composing のようにクリップを抱えていない状態 (ready →
    // seeking への遷移中) で例外を起こす
    shouldFailPersist = true;
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "internal-error",
    });
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

    expect(h.sentToTab).not.toContainEqual({
      tabId: 7,
      message: { type: "recorder/stop" },
    });
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
    // 録画を止めさせるのも content script なので、指示はタブ宛に送る
    expect(h.sentToTab).toContainEqual({
      tabId: 7,
      message: { type: "recorder/stop" },
    });
  });

  test("録画の完了を受けたら preview へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });

    // clipId は保存時に service worker 側で採番するため、値そのものではなく
    // 存在することだけを確認する
    const state = h.router.getState();
    expect(state).toMatchObject({ kind: "preview", mimeType: "video/mp4" });
    expect(state.kind === "preview" && state.clipId).toBeTruthy();
  });

  test("受け取った base64 を復元して保存する", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    // "AAECAw==" は 0x00 0x01 0x02 0x03 の 4 バイト
    await h.router.handle({
      type: "recorder/done",
      base64: "AAECAw==",
      mimeType: "video/mp4",
    });

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ mimeType: "video/mp4", range, meta });
    expect(await h.saved[0]!.blob.arrayBuffer()).toEqual(
      new Uint8Array([0, 1, 2, 3]).buffer,
    );
  });

  test("WebM を受け取ったら downloadable へ退避する", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      base64: "AAECAw==",
      mimeType: "video/webm",
    });

    // 録画は成功しているので成果物は捨てない
    const state = h.router.getState();
    expect(state).toMatchObject({ kind: "downloadable", reason: "mp4-unsupported" });
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
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
      base64: "AAECAw==",
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
