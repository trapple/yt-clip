import { afterEach, describe, expect, test, vi } from "vitest";
import { CHANNEL } from "../helpers/fixtures";
import { readTabContext } from "@/popup/channel";
import type { Message } from "@/shared/messages";

afterEach(() => {
  vi.useRealTimers();
});

describe("readTabContext", () => {
  test("前のタブの content script が答えたチャンネルを使う", async () => {
    const sent: [number, Message][] = [];
    const context = await readTabContext({
      activeTabId: () => Promise.resolve(7),
      sendToTab: (tabId, message) => {
        sent.push([tabId, message]);
        return Promise.resolve({ channel: CHANNEL });
      },
    });

    expect(sent).toEqual([[7, { type: "channel/get" }]]);
    expect(context).toEqual({ channel: CHANNEL });
  });

  test("動画の再生画面以外 (null の応答) は null", async () => {
    const context = await readTabContext({
      activeTabId: () => Promise.resolve(7),
      sendToTab: () => Promise.resolve({ channel: null }),
    });
    expect(context).toEqual({ channel: null });
  });

  test("受け手が居ない (YouTube 以外・オフ) ときは reject せず null", async () => {
    const context = await readTabContext({
      activeTabId: () => Promise.resolve(7),
      sendToTab: () => Promise.reject(new Error("Receiving end does not exist.")),
    });
    expect(context).toEqual({ channel: null });
  });

  test("前のタブが無ければ問い合わせずに null", async () => {
    const sendToTab = vi.fn();
    const context = await readTabContext({
      activeTabId: () => Promise.resolve(undefined),
      sendToTab,
    });
    expect(sendToTab).not.toHaveBeenCalled();
    expect(context).toEqual({ channel: null });
  });

  test("応答が上限までに来なければ待ち続けずに null", async () => {
    // 待つ間は保存できない。固まった受け手で popup ごと止めない
    vi.useFakeTimers();
    const pending = readTabContext({
      activeTabId: () => Promise.resolve(7),
      sendToTab: () => new Promise(() => undefined),
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ channel: null });
  });

  test("形の違う応答 (空の id など) は null", async () => {
    for (const response of [undefined, {}, { channel: { id: "", name: "" } }, { channel: "x" }]) {
      const context = await readTabContext({
        activeTabId: () => Promise.resolve(7),
        sendToTab: () => Promise.resolve(response),
      });
      expect(context).toEqual({ channel: null });
    }
  });
});
