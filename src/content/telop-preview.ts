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
  let frameHandle = 0;
  let resizeObserver: ResizeObserver | null = null;

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
  }

  function attach(video: VideoWithFrameCallback): boolean {
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
          if (!attach(video as VideoWithFrameCallback)) return;
        }
        if (ctx !== null) style = resolveTelopStyle(ctx, nextStyle);
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
