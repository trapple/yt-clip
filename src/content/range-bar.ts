import {
  clampHandle,
  computeWindow,
  ratioToTime,
  timeToRatio,
  type HandleKind,
  type TimeWindow,
} from "@/content/range-math";
import { formatTime } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

export type RangeBarCallbacks = {
  /** ドラッグ中。動画をその位置へ追従させる */
  onScrub(sec: number): void;
  /** 指を離した。確定した範囲を送る */
  onCommit(range: ClipRange): void;
};

export type RangeBar = {
  element: HTMLElement;
  /** 範囲と動画の長さを反映して描画し直す */
  update(range: ClipRange, videoDurationSec: number): void;
  /** 操作を受け付けるかどうか。録画中は false にする */
  setEnabled(enabled: boolean): void;
  destroy(): void;
};

const STYLE = {
  root: "display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;color:var(--yt-spec-text-secondary,#aaa);",
  track:
    "position:relative;flex:1;height:24px;background:var(--yt-spec-badge-chip-background,#272727);border-radius:4px;cursor:pointer;",
  selection:
    "position:absolute;top:0;bottom:0;background:var(--yt-spec-call-to-action,#3ea6ff);opacity:0.35;pointer-events:none;",
  handle:
    "position:absolute;top:-2px;bottom:-2px;width:12px;margin-left:-6px;background:var(--yt-spec-call-to-action,#3ea6ff);border-radius:3px;cursor:ew-resize;touch-action:none;",
  disabled: "opacity:0.4;pointer-events:none;",
} as const;

export function createRangeBar(callbacks: RangeBarCallbacks): RangeBar {
  const element = document.createElement("div");
  element.style.cssText = STYLE.root;

  const startLabel = document.createElement("span");
  const endLabel = document.createElement("span");

  const track = document.createElement("div");
  track.style.cssText = STYLE.track;

  const selection = document.createElement("div");
  selection.style.cssText = STYLE.selection;

  const inHandle = document.createElement("div");
  inHandle.style.cssText = STYLE.handle;
  inHandle.title = "開始位置";

  const outHandle = document.createElement("div");
  outHandle.style.cssText = STYLE.handle;
  outHandle.title = "終了位置";

  track.append(selection, inHandle, outHandle);
  element.append(startLabel, track, endLabel);

  /** 現在の範囲と窓。update で更新される */
  let range: ClipRange = { startSec: 0, endSec: 0 };
  let window_: TimeWindow = { startSec: 0, endSec: 0 };
  let enabled = true;
  /** 間引き用。次の描画フレームまで scrub をまとめる */
  let scrubFrame = 0;
  let pendingScrubSec: number | null = null;

  function paint(): void {
    const inRatio = timeToRatio(range.startSec, window_);
    const outRatio = timeToRatio(range.endSec, window_);

    inHandle.style.left = `${inRatio * 100}%`;
    outHandle.style.left = `${outRatio * 100}%`;
    selection.style.left = `${inRatio * 100}%`;
    selection.style.width = `${(outRatio - inRatio) * 100}%`;

    startLabel.textContent = formatTime(window_.startSec);
    endLabel.textContent = formatTime(window_.endSec);
    inHandle.setAttribute("aria-label", `開始 ${formatTime(range.startSec)}`);
    outHandle.setAttribute("aria-label", `終了 ${formatTime(range.endSec)}`);
  }

  /** ドラッグ中の追従。毎フレーム 1 回に間引く */
  function requestScrub(sec: number): void {
    pendingScrubSec = sec;
    if (scrubFrame !== 0) return;

    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      if (pendingScrubSec === null) return;
      const target = pendingScrubSec;
      pendingScrubSec = null;
      callbacks.onScrub(target);
    });
  }

  function pointerToSec(clientX: number): number {
    const box = track.getBoundingClientRect();
    // 幅が 0 のときは割合が出せない。窓の先頭に倒す
    if (box.width <= 0) return window_.startSec;
    return ratioToTime((clientX - box.left) / box.width, window_);
  }

  function beginDrag(kind: HandleKind, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (!enabled) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent): void => {
        range = clampHandle(kind, pointerToSec(moveEvent.clientX), range, window_);
        paint();
        // 動かしている側の位置を見せる。反対側は動いていない
        requestScrub(kind === "in" ? range.startSec : range.endSec);
      };

      const onUp = (upEvent: PointerEvent): void => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        // 往復を増やさないため、確定はここで 1 度だけ
        callbacks.onCommit(range);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  beginDrag("in", inHandle);
  beginDrag("out", outHandle);

  return {
    element,

    update(nextRange: ClipRange, videoDurationSec: number): void {
      range = nextRange;
      window_ = computeWindow(nextRange, videoDurationSec);
      paint();
    },

    setEnabled(next: boolean): void {
      enabled = next;
      element.style.cssText = next
        ? STYLE.root
        : `${STYLE.root}${STYLE.disabled}`;
    },

    destroy(): void {
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      element.remove();
    },
  };
}
