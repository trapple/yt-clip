import { afterEach, describe, expect, test, vi } from "vitest";
import { applyBadge, createBadgeQueue, syncBadge, type BadgeAction } from "@/background/badge";

/** chrome.action の偽物。呼ばれた引数を見る */
function fakeAction() {
  return {
    setBadgeText: vi.fn(async (_details: { text: string }) => undefined),
    setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => undefined),
    setBadgeTextColor: vi.fn(async (_details: { color: string }) => undefined),
  } satisfies BadgeAction;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyBadge", () => {
  test("オフでは灰色の地に白で OFF", async () => {
    const action = fakeAction();
    await applyBadge(false, action);
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "OFF" });
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#606060" });
    expect(action.setBadgeTextColor).toHaveBeenCalledWith({ color: "#ffffff" });
  });

  test("オンでは空文字 (バッジを出さない)。色は触らない", async () => {
    const action = fakeAction();
    await applyBadge(true, action);
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(action.setBadgeBackgroundColor).not.toHaveBeenCalled();
    expect(action.setBadgeTextColor).not.toHaveBeenCalled();
  });
});

describe("syncBadge", () => {
  test("保存された値を読んで当てる (オフ → OFF、キーが無い → 出さない)", async () => {
    let stored: Record<string, unknown> = { enabled: false };
    vi.stubGlobal("chrome", { storage: { local: { get: async () => stored } } });

    const off = fakeAction();
    await syncBadge(off);
    expect(off.setBadgeText).toHaveBeenCalledWith({ text: "OFF" });

    stored = {};
    const on = fakeAction();
    await syncBadge(on);
    expect(on.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});

describe("createBadgeQueue", () => {
  /** setBadge* が 1 回ごとに 1 tick かかる偽物 (IPC の往復)。最後に当たった文言を見る */
  function slowAction() {
    const texts: string[] = [];
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const action = {
      setBadgeText: vi.fn(async (details: { text: string }) => {
        await tick();
        texts.push(details.text);
      }),
      setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => tick()),
      setBadgeTextColor: vi.fn(async (_details: { color: string }) => tick()),
    } satisfies BadgeAction;
    return { action, texts };
  }

  test("オフ → オンを続けて当てると、最後に当たるのはオンの空文字 (オフの 3 回の await を追い越さない)", async () => {
    const { action, texts } = slowAction();
    const queue = createBadgeQueue(() => undefined);

    queue(() => applyBadge(false, action));
    await queue(() => applyBadge(true, action));

    expect(texts).toEqual(["OFF", ""]);
  });

  test("前の当て直しが失敗しても、次は当てる (失敗は onError へ)", async () => {
    const { action, texts } = slowAction();
    const errors: unknown[] = [];
    const queue = createBadgeQueue((error) => errors.push(error));

    queue(() => Promise.reject(new Error("当てられない")));
    await queue(() => applyBadge(true, action));

    expect(errors).toHaveLength(1);
    expect(texts).toEqual([""]);
  });
});
