// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTelopPreview } from "@/content/telop-preview";
import type { TelopStyle } from "@/shared/telop-style";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};
const TELOP = { startSec: 10, endSec: 13, text: "見える" };

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

let texts: string[] = [];
let clears = 0;

function makeVideo() {
  const parent = document.createElement("div");
  const video = document.createElement("video");
  video.style.left = "10px";
  video.style.top = "20px";
  video.style.width = "640px";
  video.style.height = "360px";
  Object.defineProperty(video, "clientWidth", { value: 640 });
  Object.defineProperty(video, "clientHeight", { value: 360 });
  let current = 11;
  Object.defineProperty(video, "currentTime", {
    get: () => current,
    set: (value: number) => {
      current = value;
    },
  });
  const callbacks = new Map<number, FrameCallback>();
  let next = 1;
  Object.assign(video, {
    requestVideoFrameCallback: (callback: FrameCallback) => {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: (handle: number) => callbacks.delete(handle),
  });
  parent.append(video);
  document.body.append(parent);
  return {
    video,
    parent,
    frame(mediaTime: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0, { mediaTime });
    },
    pending: () => callbacks.size,
  };
}

beforeEach(() => {
  texts = [];
  clears = 0;
  const ctx = {
    font: "10px sans-serif",
    clearRect: () => {
      clears += 1;
    },
    save: () => undefined,
    restore: () => undefined,
    strokeText: () => undefined,
    fillText: (text: string) => texts.push(text),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("createTelopPreview", () => {
  test("video と同じ親に、video の矩形に合わせて canvas を置く", () => {
    // レターボックスは video の外にできるので、video の矩形に合わせれば黒帯に乗らない
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    const canvas = fake.parent.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.style.left).toBe("10px");
    expect(canvas?.style.top).toBe("20px");
    expect(canvas?.style.width).toBe("640px");
    expect(canvas?.style.pointerEvents).toBe("none");
    preview.destroy();
  });

  test("更新したその場で今の位置を描く (一時停止中でも見える)", () => {
    // rVFC は再生中しか発火しない。止めて文言を打つ間も描き直す
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    expect(texts).toContain("見える");
    preview.destroy();
  });

  test("再生中はフレームごとに描き直す", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    const before = clears;
    fake.frame(11.5);
    expect(clears).toBeGreaterThan(before);
    preview.destroy();
  });

  test("シークしたら描き直す", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    texts = [];
    fake.video.currentTime = 12;
    fake.video.dispatchEvent(new Event("seeked"));
    expect(texts).toContain("見える");
    preview.destroy();
  });

  test("テロップが無くなれば canvas を外してループを止める", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    preview.update(fake.video, [], STYLE);
    expect(fake.parent.querySelector("canvas")).toBeNull();
    expect(fake.pending()).toBe(0);
    preview.destroy();
  });

  test("描けない環境では warn だけ残して続ける", () => {
    // プレビューは目安。描けないことは操作を止める理由にならない
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = makeVideo();
    const preview = createTelopPreview();
    expect(() => preview.update(fake.video, [TELOP], STYLE)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    preview.destroy();
  });
});
