// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  TelopRenderError,
  assertTelopRenderable,
  startCompositor,
} from "@/content/telop-compositor";
import type { TelopStyle } from "@/shared/telop-style";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

function makeVideo(width = 1920, height = 1080) {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  Object.defineProperty(video, "currentTime", { value: 5, writable: true });
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
  return {
    video,
    frame(mediaTime: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0, { mediaTime });
    },
    pending: () => callbacks.size,
  };
}

function makeCanvas(options: { tainted?: boolean; noContext?: boolean } = {}) {
  const log = { drawn: 0, requested: 0, stopped: false, texts: [] as string[] };
  const track = {
    kind: "video",
    requestFrame: () => {
      log.requested += 1;
    },
    stop: () => {
      log.stopped = true;
    },
  };
  let font = "10px sans-serif";
  const ctx = {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    drawImage: () => {
      log.drawn += 1;
    },
    getImageData: () => {
      if (options.tainted) throw new DOMException("tainted", "SecurityError");
      return {};
    },
    save: () => undefined,
    restore: () => undefined,
    strokeText: () => undefined,
    fillText: (text: string) => log.texts.push(text),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.noContext ? null : ctx),
    captureStream: () => ({ getVideoTracks: () => [track] }),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, log, track };
}

describe("assertTelopRenderable", () => {
  test("描けるなら通す", () => {
    const { video } = makeVideo();
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).not.toThrow();
  });

  test("汚染されていたら TelopRenderError", () => {
    // テロップなしで録って続行しない。実時間を払った後で気付くことになる
    const { video } = makeVideo();
    const { canvas } = makeCanvas({ tainted: true });
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("2D の文脈が取れなければ TelopRenderError", () => {
    const { video } = makeVideo();
    const { canvas } = makeCanvas({ noContext: true });
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("フレーム単位の監視が使えなければ TelopRenderError", () => {
    // 1 区間の録画でも合成は rVFC に乗る。beginRecording で初めて落ちると
    // router が recording-aborted に化けさせ、理由が出ない
    const { video } = makeVideo();
    Object.assign(video, { requestVideoFrameCallback: undefined });
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("動画の大きさがまだ無ければ TelopRenderError", () => {
    const { video } = makeVideo(0, 0);
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });
});

describe("startCompositor", () => {
  test("canvas の大きさを録画開始時の動画の大きさで固定する", () => {
    const { video } = makeVideo(1280, 720);
    const { canvas } = makeCanvas();
    startCompositor(video, [], STYLE, { createCanvas: () => canvas });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  test("動画のフレームごとに描いて 1 フレーム送る", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    startCompositor(fake.video, [], STYLE, { createCanvas: () => canvas });
    const before = log.requested;
    fake.frame(6);
    fake.frame(6.1);
    expect(log.requested - before).toBe(2);
  });

  test("描くときの時刻は rVFC の mediaTime を使う", () => {
    // currentTime は描画時点ですでに先へ進んでいることがある
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    startCompositor(
      fake.video,
      [{ startSec: 10, endSec: 11, text: "出る" }],
      STYLE,
      { createCanvas: () => canvas },
    );
    fake.frame(10.5);
    expect(log.texts).toContain("出る");
  });

  test("release で描画ループとトラックを止める。二度呼んでも安全", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    const compositor = startCompositor(fake.video, [], STYLE, {
      createCanvas: () => canvas,
    });
    compositor.release();
    compositor.release();
    expect(log.stopped).toBe(true);
    expect(fake.pending()).toBe(0);
  });

  test("release の後に届いたフレームでは描かない", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    const compositor = startCompositor(fake.video, [], STYLE, {
      createCanvas: () => canvas,
    });
    const before = log.requested;
    compositor.release();
    fake.frame(7);
    expect(log.requested).toBe(before);
  });
});
