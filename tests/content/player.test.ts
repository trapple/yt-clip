// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ElementNotFoundError,
  getVideo,
  onReachTime,
  parseVideoId,
  seekTo,
} from "@/content/player";
import { YT_SELECTORS } from "@/content/selectors";

describe("parseVideoId", () => {
  test("watch URL から videoId を取り出す", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  test("他のクエリが付いていても取り出せる", () => {
    expect(
      parseVideoId("https://www.youtube.com/watch?v=abc123&list=PL1&index=2"),
    ).toBe("abc123");
  });

  test("videoId が無い URL は throw する", () => {
    expect(() => parseVideoId("https://www.youtube.com/")).toThrow(
      "URL から videoId を取得できません",
    );
  });
});

describe("getVideo", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("video 要素を返す", () => {
    const video = document.createElement("video");
    video.className = "html5-main-video";
    document.body.appendChild(video);

    expect(getVideo()).toBe(video);
  });

  test("見つからなければ握り潰さず throw する", () => {
    expect(() => getVideo()).toThrow(ElementNotFoundError);
  });

  test("セレクタは selectors.ts に集約されている", () => {
    expect(YT_SELECTORS.video).toBe("video.html5-main-video");
  });
});

describe("seekTo", () => {
  test("seeked が来たら解決する", async () => {
    const video = document.createElement("video");
    const promise = seekTo(video, 42);
    video.dispatchEvent(new Event("seeked"));

    await expect(promise).resolves.toBeUndefined();
  });

  test("seeked が来なければタイムアウトで reject する", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const promise = seekTo(video, 42, 5000);
    const assertion = expect(promise).rejects.toThrow(
      "seek がタイムアウトしました",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("onReachTime", () => {
  /** requestVideoFrameCallback を手動で駆動できる video を作る */
  function makeVideoWithFrames() {
    const video = document.createElement("video");
    const pending: Array<(now: number, meta: { mediaTime: number }) => void> =
      [];
    Object.assign(video, {
      requestVideoFrameCallback: (
        cb: (now: number, meta: { mediaTime: number }) => void,
      ) => {
        pending.push(cb);
        return pending.length;
      },
      cancelVideoFrameCallback: () => {
        pending.length = 0;
      },
    });
    const advanceTo = (mediaTime: number) => {
      const callbacks = [...pending];
      pending.length = 0;
      for (const cb of callbacks) cb(0, { mediaTime });
    };
    return { video, advanceTo, pending };
  }

  test("指定位置に到達したらコールバックを呼ぶ", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    onReachTime(video, 40, onReach);

    advanceTo(39.9);
    expect(onReach).not.toHaveBeenCalled();

    advanceTo(40.1);
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  test("解除するとそれ以降呼ばれない", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    const cancel = onReachTime(video, 40, onReach);

    cancel();
    advanceTo(50);

    expect(onReach).not.toHaveBeenCalled();
  });
});
