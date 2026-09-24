/**
 * 動画とテロップを canvas で合成し、録画に使う映像トラックを作る。
 *
 * **テロップがあるときだけ使う。** 無いときは今の `video.captureStream()` の経路の
 * まま (canvas を挟むと描画の負荷とフレーム落ちの可能性が増える。テロップ spec §4.1)
 */

import type { VideoOverride } from "@/content/recorder";
import { drawTelops, resolveTelopStyle } from "@/content/telop-render";
import type { TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

export type Compositor = VideoOverride;

export type CompositorDeps = {
  createCanvas(): HTMLCanvasElement;
};

export type CompositorOptions = {
  /** 録画中にタブが隠れた。呼ばれるのは release の前だけ */
  onHidden(): void;
};

const defaultDeps: CompositorDeps = {
  createCanvas: () => document.createElement("canvas"),
};

/** テロップを描く canvas に動画を描けない。録画を始める前に弾く */
export class TelopRenderError extends Error {
  constructor(detail: string) {
    super(`テロップを動画に描けませんでした: ${detail}`);
    this.name = "TelopRenderError";
  }
}

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};
type CanvasCaptureTrack = MediaStreamTrack & { requestFrame(): void };

type Surface = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
};

/**
 * 動画の大きさの canvas を用意して 1 フレーム描き、読み出せるか確かめる。
 *
 * 読み出せない (汚染されている) canvas を録っても映像は出ない。**失敗を投げる。**
 * テロップなしで録って続行すると、実時間を払った後で気付くことになる
 */
function prepareSurface(video: HTMLVideoElement, deps: CompositorDeps): Surface {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    throw new TelopRenderError("動画の大きさがまだ分かりません");
  }

  const canvas = deps.createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new TelopRenderError("canvas の描画の文脈を取れません");
  }

  ctx.drawImage(video, 0, 0, width, height);
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (error) {
    throw new TelopRenderError(String(error));
  }
  return { canvas, ctx, width, height };
}

/**
 * 録画を始める前の検査。`prepareRecording` から呼ぶ。
 *
 * **`beginRecording` で初めて気付かない。** そこの失敗は router が理由を問わず
 * `recording-aborted` に落とすので、専用の文言が出ない (テロップ spec §4.3)
 */
export function assertTelopRenderable(
  video: HTMLVideoElement,
  deps: CompositorDeps = defaultDeps,
): void {
  // 1 区間の録画でも合成は rVFC に乗る (区間の繋ぎ目の検査は 2 区間以上でしか走らない)
  const request = (video as Partial<VideoWithFrameCallback>).requestVideoFrameCallback;
  if (typeof request !== "function") {
    throw new TelopRenderError("この環境では動画のフレームに合わせて描けません");
  }
  prepareSurface(video, deps);
}

/**
 * 合成を始める。返したトラックを録画に渡し、`release` を録画の解放に繋ぐこと。
 *
 * - canvas の大きさは**開始時の動画の大きさで固定する**。録画中に画質が変わっても
 *   変えず、`drawImage` で引き伸ばす (MediaRecorder は途中の解像度変更を想定しない)
 * - **動画の新しいフレームが来るたびに描いて 1 フレーム送る** (`captureStream(0)` +
 *   `requestFrame`)。タイマーで描くと動画とずれ、同じ絵が 2 回出たり飛んだりする
 * - 描く時刻は rVFC の `mediaTime`。`currentTime` は描画時点で先へ進んでいることがある
 * - 録画の pause 中も描き続けてよい (pause 中のフレームは記録されない)
 */
export function startCompositor(
  video: HTMLVideoElement,
  telops: Telop[],
  style: TelopStyle,
  deps: CompositorDeps = defaultDeps,
  options?: CompositorOptions,
): Compositor {
  const { canvas, ctx, width, height } = prepareSurface(video, deps);
  const resolved = resolveTelopStyle(ctx, style);

  const track = canvas.captureStream(0).getVideoTracks()[0] as
    | CanvasCaptureTrack
    | undefined;
  if (track === undefined) {
    throw new TelopRenderError("canvas から映像のトラックを取れません");
  }

  const target = video as VideoWithFrameCallback;
  let handle = 0;
  let released = false;

  const paint = (sourceSec: number): void => {
    ctx.drawImage(video, 0, 0, width, height);
    drawTelops(ctx, telops, sourceSec, resolved, width, height);
    track.requestFrame();
  };
  const tick: FrameCallback = (_now, metadata) => {
    if (released) return;
    paint(metadata.mediaTime);
    handle = target.requestVideoFrameCallback(tick);
  };

  // 最初のフレームは今の位置で描いておく。録画の先頭が空の映像にならないように
  paint(video.currentTime);
  handle = target.requestVideoFrameCallback(tick);

  // **監視は release で外す。** 外し忘れると、録画が終わった後にタブを切り替えた
  // だけで FAIL が飛ぶ
  const onVisibilityChange = (): void => {
    if (!released && document.hidden) options?.onHidden();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    track,
    release(): void {
      if (released) return;
      released = true;
      target.cancelVideoFrameCallback(handle);
      track.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
