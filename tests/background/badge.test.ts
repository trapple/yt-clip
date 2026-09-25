import { afterEach, describe, expect, test, vi } from "vitest";
import { applyBadge, syncBadge, type BadgeAction } from "@/background/badge";

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
