import {
  clampHandle,
  computeWindow,
  ratioToTime,
  timeToRatio,
  type HandleKind,
  type TimeWindow,
} from "@/content/range-math";
import { RANGE_STYLE } from "@/content/styles";
import { DEFAULT_MAX_CLIP_SEC, formatTime } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

export type RangeBarCallbacks = {
  /** ドラッグ中。動画をその位置へ追従させる */
  onScrub(sec: number): void;
  /** 指を離した。確定した範囲を送る */
  onCommit(range: ClipRange): void;
  /**
   * トラックが押された。その位置から再生する。
   * **範囲は変えない。** 見るための操作であって、切り抜く場所を決める操作ではない
   */
  onSeekPlay(sec: number): void;
};

export type RangeBar = {
  element: HTMLElement;
  /** 範囲と動画の長さを反映して描画し直す */
  update(range: ClipRange, videoDurationSec: number): void;
  /**
   * 操作を受け付けるかどうか。
   * **生成直後は false。** 範囲が確定するまで (spec §5.3) と、範囲を変えられない
   * 状態 (録画中・録画後のプレビュー待ち) では操作させない
   */
  setEnabled(enabled: boolean): void;
  /** 現在の再生位置を示す。窓の外や位置が分からないときは null */
  setPlayhead(sec: number | null): void;
  /**
   * 1 クリップの最大長 (秒)。設定が変わったら呼び直す。
   * **OUT ボタン側 (`validateRange`) と必ず同じ値にすること。** ずれると、
   * ドラッグでは伸ばせるのに OUT では弾かれる状態ができる
   */
  setMaxClipSec(sec: number): void;
  destroy(): void;
};


export function createRangeBar(callbacks: RangeBarCallbacks): RangeBar {
  const element = document.createElement("div");
  // 初期状態は無効。見た目 (薄さ) と実際の操作可否を最初から一致させる
  element.style.cssText = `${RANGE_STYLE.root}${RANGE_STYLE.disabled}`;

  const startLabel = document.createElement("span");
  const endLabel = document.createElement("span");

  const track = document.createElement("div");
  // テストから掴むための目印。子要素の構成が変わっても位置で数えずに済む
  track.dataset.role = "track";
  track.style.cssText = RANGE_STYLE.track;

  const selection = document.createElement("div");
  selection.style.cssText = RANGE_STYLE.selection;

  const inHandle = document.createElement("div");
  inHandle.style.cssText = RANGE_STYLE.handle;
  inHandle.title = "開始位置";

  const outHandle = document.createElement("div");
  outHandle.style.cssText = RANGE_STYLE.handle;
  outHandle.title = "終了位置";

  // 選択範囲の外側を暗くして、どこを切り抜くのかを際立たせる
  const shadeBefore = document.createElement("div");
  shadeBefore.style.cssText = RANGE_STYLE.shade;
  const shadeAfter = document.createElement("div");
  shadeAfter.style.cssText = RANGE_STYLE.shade;

  const playhead = document.createElement("div");
  playhead.dataset.role = "playhead";
  playhead.style.cssText = RANGE_STYLE.playhead;
  playhead.hidden = true;

  // ハンドルは細い芯の周りに透明な余白を持つ。狙わなくても掴めるように
  for (const handle of [inHandle, outHandle]) {
    const grip = document.createElement("div");
    grip.style.cssText = RANGE_STYLE.handleGrip;
    handle.append(grip);
  }

  // 暗幕はハンドルより先に置く。後だとハンドルが隠れる
  track.append(selection, shadeBefore, shadeAfter, playhead, inHandle, outHandle);
  element.append(startLabel, track, endLabel);

  /** 現在の範囲と窓。update で更新される */
  let range: ClipRange = { startSec: 0, endSec: 0 };
  let window_: TimeWindow = { startSec: 0, endSec: 0 };
  /**
   * 範囲が確定するまで操作させない (spec §5.3)。
   * 初期値の範囲と窓はどちらも幅 0 で、この状態でハンドルを掴めてしまうと
   * 動かせる余地が無いまま不正な範囲が生まれる。有効化は状態機械が
   * ready を知らせてから行う
   */
  let enabled = false;
  /** 1 クリップの最大長。設定から流し込まれるまでは既定値 */
  let maxClipSec = DEFAULT_MAX_CLIP_SEC;
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

    shadeBefore.style.left = "0";
    shadeBefore.style.width = `${inRatio * 100}%`;
    shadeAfter.style.left = `${outRatio * 100}%`;
    shadeAfter.style.width = `${(1 - outRatio) * 100}%`;

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
      // 予約した後に録画が始まっていることがある。ここで見ないと
      // seek 中に再生位置が書き換わり、録画の開始位置がずれる
      if (!enabled) return;
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

      /** ドラッグを終わらせる。捕捉とリスナをまとめて解く */
      const finish = (pointerId: number): void => {
        handle.releasePointerCapture(pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };

      const onMove = (moveEvent: PointerEvent): void => {
        // 録画が始まったら進行中のドラッグも打ち切る。
        // ポインタを捕捉している間はヒットテストを飛ばしてイベントが届くので、
        // pointer-events を切っただけでは止まらない。止めないと録画中に
        // 動画がシークし、録画された映像に意図しない飛びが入る
        if (!enabled) {
          finish(moveEvent.pointerId);
          return;
        }

        range = clampHandle(
          kind,
          pointerToSec(moveEvent.clientX),
          range,
          window_,
          maxClipSec,
        );
        paint();
        // 動かしている側の位置を見せる。反対側は動いていない
        requestScrub(kind === "in" ? range.startSec : range.endSec);
      };

      const onUp = (upEvent: PointerEvent): void => {
        finish(upEvent.pointerId);
        // 無効化された後に指を離した場合、その範囲は送らない
        if (!enabled) return;
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

  /**
   * トラックを押したらそこから再生する。
   *
   * **ハンドルはトラックの子**なので、掴んだときの pointerdown はここにも
   * 伝わる。発生元がハンドルなら何もしない。ハンドル側に stopPropagation を
   * 足す案は採らない。ハンドルの責務が「自分を動かす」から「親に伝えない」
   * まで広がり、親を足すたびにそちらを直すことになる。
   *
   * 受け付ける条件はドラッグと同じ (`enabled`)。false なのは「範囲が未確定」と
   * 「録画が進行中」で、後者でシークすると録画された映像に飛びが入る
   */
  track.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!enabled) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (inHandle.contains(target) || outHandle.contains(target)) return;

    event.preventDefault();
    callbacks.onSeekPlay(pointerToSec(event.clientX));
  });

  return {
    element,

    update(nextRange: ClipRange, videoDurationSec: number): void {
      range = nextRange;
      window_ = computeWindow(nextRange, videoDurationSec);
      paint();
    },

    setPlayhead(sec: number | null): void {
      if (sec === null) {
        playhead.hidden = true;
        return;
      }
      // **時刻そのもので判定すること。** timeToRatio は 0〜1 に丸めるので、
      // 比率を見ると窓の外が端に貼り付いた状態で表示されてしまう
      if (sec < window_.startSec || sec > window_.endSec) {
        playhead.hidden = true;
        return;
      }
      playhead.hidden = false;
      playhead.style.left = `${timeToRatio(sec, window_) * 100}%`;
    },

    setMaxClipSec(sec: number): void {
      maxClipSec = sec;
    },

    setEnabled(next: boolean): void {
      enabled = next;
      element.style.cssText = next
        ? RANGE_STYLE.root
        : `${RANGE_STYLE.root}${RANGE_STYLE.disabled}`;
    },

    destroy(): void {
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      element.remove();
    },
  };
}
