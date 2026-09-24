/**
 * プレイヤーの上にテロップを重ねて見せる。
 *
 * **録画と同じ関数 (`drawTelops`) で描く。** CSS で描くと縁取りや行間が録画とずれる。
 *
 * **描けないときは warn だけ残して続ける。** プレビューは目安であり、描けないことは
 * 操作や録画を止める理由にならない (範囲の帯と同じ扱い。テロップ spec §6)
 */

import { drawTelops, resolveTelopStyle } from "@/content/telop-render";
import type { TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

const PREVIEW_ID = "yt-clip-telop-preview";

/** 5 項目のどれかが違えば見た目が変わったとみなす */
function sameStyle(a: TelopStyle, b: TelopStyle): boolean {
  return (
    a.fontSizePx === b.fontSizePx &&
    a.fontFamily === b.fontFamily &&
    a.fillColor === b.fillColor &&
    a.strokeColor === b.strokeColor &&
    a.strokeWidthPx === b.strokeWidthPx
  );
}

export type TelopPreview = {
  /**
   * 今のテロップと見た目で描き直す。テロップが空か video が無ければ外す。
   * 状態や設定が変わるたびに呼ぶ (その場で今の位置を描く)
   */
  update(video: HTMLVideoElement | null, telops: Telop[], style: TelopStyle): void;
  destroy(): void;
};

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};

export function createTelopPreview(): TelopPreview {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let attached: VideoWithFrameCallback | null = null;
  let telops: Telop[] = [];
  let style: TelopStyle | null = null;
  /**
   * 直前に `resolveTelopStyle` へ渡した見た目。
   *
   * **font 指定が受け付けられるかの判定は、attach 直後とスタイルが変わったときの
   * 1 回だけ行う。** フレームごとに描くたびに判定すると、使えないフォント名の
   * ときに状態通知のたびに warn が繰り返される (global-constraints 参照)
   */
  let lastStyleInput: TelopStyle | null = null;
  let frameHandle = 0;
  let resizeObserver: ResizeObserver | null = null;
  /** attach に失敗した video。同じ video では再試行も warn もしない (別の video なら再試行) */
  let failedVideo: HTMLVideoElement | null = null;

  function warn(error: unknown): void {
    console.warn(`[yt-clip] テロップのプレビューを描けませんでした: ${String(error)}`);
  }

  /**
   * canvas を video の矩形に合わせる。YouTube は video に inline の left / top /
   * width / height を当てて動画のアスペクト比ぴったりに置くので、それを写せば
   * レターボックスの上に乗らない
   */
  function syncRect(): void {
    if (canvas === null || attached === null) return;
    const { left, top, width, height } = attached.style;
    canvas.style.left = left;
    canvas.style.top = top;
    canvas.style.width = width;
    canvas.style.height = height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(attached.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(attached.clientHeight * ratio));
  }

  function paint(sourceSec: number): void {
    if (canvas === null || ctx === null || style === null) return;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawTelops(ctx, telops, sourceSec, style, canvas.width, canvas.height);
    } catch (error) {
      warn(error);
    }
  }

  function paintNow(): void {
    if (attached !== null) paint(attached.currentTime);
  }

  const tick: FrameCallback = (_now, metadata) => {
    if (attached === null) return;
    paint(metadata.mediaTime);
    frameHandle = attached.requestVideoFrameCallback(tick);
  };

  /** 一時停止中は rVFC が来ない。シークの後はその場で描き直す */
  const onSeeked = (): void => paintNow();

  function detach(): void {
    if (attached !== null) {
      attached.cancelVideoFrameCallback(frameHandle);
      attached.removeEventListener("seeked", onSeeked);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    canvas?.remove();
    canvas = null;
    ctx = null;
    attached = null;
    // ctx が変われば判定のやり直しが要る。次の attach で 1 回だけ resolve する
    style = null;
    lastStyleInput = null;
  }

  function attach(video: VideoWithFrameCallback): boolean {
    // rVFC が無い環境で進めると、後の detach が cancelVideoFrameCallback を
    // 呼んで落ちる (compositor の assertFrameCallbackSupported と同じ検査だが、
    // プレビューは目安なので throw ではなく warn で続ける)
    if (typeof (video as Partial<VideoWithFrameCallback>).requestVideoFrameCallback !== "function") {
      warn(new Error("この環境では動画のフレームに合わせて描き直せません"));
      return false;
    }

    const parent = video.parentElement;
    if (parent === null) return false;

    const element = document.createElement("canvas");
    element.id = PREVIEW_ID;
    element.style.cssText = "position:absolute;pointer-events:none;z-index:10;";
    const context = element.getContext("2d");
    if (context === null) {
      warn(new Error("canvas の描画の文脈を取れません"));
      return false;
    }

    // **監視を先に用意してから状態に入れる。** 途中で落ちたときに、canvas だけ
    // 付いて監視の無い半端な状態を残さない
    // 大きさが変わったら位置も読み直す (シアターモードや全画面では同時に変わる)
    const observer = new ResizeObserver(() => {
      syncRect();
      paintNow();
    });

    parent.append(element);
    canvas = element;
    ctx = context;
    attached = video;
    resizeObserver = observer;
    syncRect();
    observer.observe(video);
    video.addEventListener("seeked", onSeeked);
    frameHandle = video.requestVideoFrameCallback(tick);
    return true;
  }

  return {
    update(video, nextTelops, nextStyle): void {
      telops = nextTelops;
      if (video === null || nextTelops.length === 0) {
        detach();
        return;
      }
      try {
        // SPA 遷移で video が差し替わったら付け直す
        if (attached !== video) {
          detach();
          // 前回 attach に失敗した video のまま。canvas を作り直して warn を
          // 繰り返さない (別の video が来たら再試行する)
          if (video === failedVideo) return;
          if (!attach(video as VideoWithFrameCallback)) {
            failedVideo = video;
            return;
          }
          failedVideo = null;
        }
        // font 指定が受け付けられるかは attach 直後とスタイルが変わったときだけ判定する
        if (ctx !== null && (lastStyleInput === null || !sameStyle(lastStyleInput, nextStyle))) {
          style = resolveTelopStyle(ctx, nextStyle);
          lastStyleInput = nextStyle;
        }
        paintNow();
      } catch (error) {
        warn(error);
      }
    },

    destroy(): void {
      detach();
    },
  };
}
