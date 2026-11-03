import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSwitchDriver, type SwitchDriver } from "@/content/switch-driver";

/** chrome.storage.onChanged の listener の形 */
type Listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

let listeners: Listener[] = [];
/** chrome.storage.local.get の応答を離す。離すまで最初の読みは返らない */
let releaseGet: (stored: Record<string, unknown>) => void = () => undefined;
let driver: SwitchDriver | null = null;

beforeEach(() => {
  listeners = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (): Promise<Record<string, unknown>> =>
          new Promise((resolve) => {
            releaseGet = resolve;
          }),
      },
      onChanged: {
        addListener: (fn: Listener): void => {
          listeners.push(fn);
        },
        removeListener: (fn: Listener): void => {
          listeners = listeners.filter((listener) => listener !== fn);
        },
      },
    },
  });
});

afterEach(() => {
  driver?.destroy();
  driver = null;
  vi.unstubAllGlobals();
});

/** 別の場所 (popup・DevTools) で enabled が書き換わった */
function change(enabled: unknown): void {
  for (const listener of [...listeners]) listener({ enabled: { newValue: enabled } }, "local");
}

/** 最初の読みの Promise の連鎖を流す */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

/** 呼ばれた回数を数える hooks。canStop は state.canStop を返す */
function makeHooks(canStop = true) {
  const state = { canStop };
  const hooks = {
    start: vi.fn(),
    stop: vi.fn(),
    canStop: vi.fn(() => state.canStop),
    onStopDeferred: vi.fn(),
  };
  return { hooks, state };
}

describe("最初の読み", () => {
  test("オンなら start を 1 回呼ぶ。読みが返るまでは何も呼ばない", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    expect(hooks.start).not.toHaveBeenCalled();

    releaseGet({ enabled: true });
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
    expect(hooks.stop).not.toHaveBeenCalled();
  });

  test("キーが無ければオン (既定)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
  });

  test("オフなら何も呼ばない", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({ enabled: false });
    await settle();
    expect(hooks.start).not.toHaveBeenCalled();
    expect(hooks.stop).not.toHaveBeenCalled();
  });
});

describe("onChanged", () => {
  test("オフで stop、オンで start", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(2);
  });

  test("同じ値の onChanged では呼ばない (start / stop を二度続けて呼ばない)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(1);
    change(false);
    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });

  test("最初の読みが返る前に onChanged が来たら、最後の値だけが効く (start は二度走らない)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(1);
    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);

    // 読みが後から古い値 (オン) を返しても、onChanged の値 (オフ) のまま
    releaseGet({ enabled: true });
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stop を待つ (canStop)", () => {
  test("canStop が偽なら stop を待ち、onStopDeferred を 1 回だけ呼ぶ。真になってから reconcile で stop", async () => {
    const { hooks, state } = makeHooks(false);
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    expect(hooks.stop).not.toHaveBeenCalled();
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(1);
    // 状態の通知のたびに reconcile されても、中止を送り直させない
    driver.reconcile();
    driver.reconcile();
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(1);
    expect(hooks.stop).not.toHaveBeenCalled();

    state.canStop = true;
    driver.reconcile();
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });

  test("stop を待っている間にオンへ戻したら stop を呼ばない (start も呼び直さない)。次にオフにすると、また 1 回知らせる", async () => {
    const { hooks, state } = makeHooks(false);
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    change(true);
    state.canStop = true;
    driver.reconcile();
    expect(hooks.stop).not.toHaveBeenCalled();
    expect(hooks.start).toHaveBeenCalledTimes(1);

    state.canStop = false;
    change(false);
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(2);
  });

  test("canStop を省くと、いつでもその場で止める", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    driver = createSwitchDriver({ start, stop });
    releaseGet({});
    await settle();

    change(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("destroy", () => {
  test("onChanged を外し、以後は何も呼ばない (読みが後から返っても)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    driver.destroy();
    expect(listeners).toHaveLength(0);

    releaseGet({ enabled: true });
    await settle();
    change(false);
    expect(hooks.start).not.toHaveBeenCalled();
    expect(hooks.stop).not.toHaveBeenCalled();
  });
});
