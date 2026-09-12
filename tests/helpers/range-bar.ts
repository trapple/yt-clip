import { createRangeBar, type RangeBar } from "@/content/range-bar";
import type { ClipRange } from "@/shared/types";

export type BarHarness = {
  bar: RangeBar;
  /** onCommit で確定した範囲 */
  committed: ClipRange[];
  /** onSeekPlay で要求された再生位置 */
  seeked: number[];
  /** バーへ流し込む最大秒数。テストから書き換えられる */
  maxClipSec: { value: number };
  track: HTMLElement;
  /** IN / OUT ハンドル */
  handles: [HTMLElement, HTMLElement];
};

export type BarOptions = {
  range?: ClipRange;
  videoDurationSec?: number;
  /** トラックの見かけ上の幅 (px)。jsdom はレイアウトを持たないので与える */
  trackWidth?: number;
  maxClipSec?: number;
  enabled?: boolean;
};

/**
 * 拡大バーをテスト用に組み立てる。
 *
 * **1 ファイルに makeBar を 4 つ書いていたので 1 つに寄せた。**
 * `RangeBarCallbacks` に項目が増えるたびに全部を直すことになっていた
 */
export function mountRangeBar(options: BarOptions = {}): BarHarness {
  const {
    range = { startSec: 30, endSec: 45 },
    videoDurationSec = 600,
    trackWidth = 100,
    maxClipSec: initialMax = 60,
    enabled = false,
  } = options;

  const committed: ClipRange[] = [];
  const seeked: number[] = [];
  const maxClipSec = { value: initialMax };

  const bar = createRangeBar({
    onScrub: () => undefined,
    onCommit: (next) => committed.push(next),
    onSeekPlay: (sec) => seeked.push(sec),
    maxClipSec: () => maxClipSec.value,
  });
  document.body.append(bar.element);
  bar.update(range, videoDurationSec);

  const track = bar.element.querySelector<HTMLElement>("[data-role=track]");
  if (track === null) throw new Error("トラックがありません");
  track.getBoundingClientRect = () =>
    ({ left: 0, width: trackWidth }) as DOMRect;

  const found = [...bar.element.querySelectorAll<HTMLElement>("[aria-label]")];
  const [inHandle, outHandle] = found;
  if (inHandle === undefined || outHandle === undefined) {
    throw new Error("ハンドルがありません");
  }
  for (const handle of [inHandle, outHandle]) {
    // jsdom の捕捉 API は pointerId を検査して投げる。見たいのはそこではない
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;
  }

  bar.setEnabled(enabled);
  return {
    bar,
    committed,
    seeked,
    maxClipSec,
    track,
    handles: [inHandle, outHandle],
  };
}

/** ハンドルに付く説明。今どの範囲を見せているかを外から見る唯一の手がかり */
export function handleLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll("[aria-label]")].map(
    (element) => element.getAttribute("aria-label") ?? "",
  );
}

/** ポインタを押す。jsdom に PointerEvent が無いので MouseEvent で代用する */
export function pressAt(target: HTMLElement, clientX: number): void {
  target.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX }),
  );
}

/**
 * ハンドルを掴んで動かす。
 *
 * **「ハンドルは `[aria-label]` を持ち、OUT が 2 番目」という前提をここだけに置く。**
 * 拡大バーの構成を変えたとき、直す場所が 1 つで済む
 */
export function dragHandle(
  handle: HTMLElement,
  clientX: number,
  fromX = 0,
): void {
  pressAt(handle, fromX);
  handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX }));
}
