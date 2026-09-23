/**
 * エディットモードで出す区間の一覧。
 *
 * **選択状態は持たない。** 選択とは「拡大バーがいま何を編集しているか」と
 * 同じものであり、拡大バーを持っているのは `youtube.ts` である。ここにも
 * 置くと同期が要る。この一覧は渡されたものを描き、押されたことを伝えるだけ。
 *
 * **拡大バーを複数対応させない代わりに置く。** 複数区間を 1 つのバーに
 * 詰め込むと、ハンドルの当たり判定と重なりの解決がバーの中に流れ込む。
 */

import { SEGMENT_STYLE } from "@/content/styles";
import { formatTime } from "@/shared/time";
import { isOverLimit, totalSec } from "@/shared/timeline";
import type { ClipRange } from "@/shared/types";

export type SegmentListCallbacks = {
  /** 行が押された。その区間を編集対象にする */
  onSelect(index: number): void;
  /** ▶ が押された。その区間だけを再生する */
  onPlay(index: number): void;
  /** ✕ が押された */
  onRemove(index: number): void;
};

export type SegmentList = {
  element: HTMLElement;
  /** 区間・選択・上限を反映して描き直す */
  update(segments: ClipRange[], selectedIndex: number, maxClipSec: number): void;
  /** 操作を受け付けるか。録画中は false */
  setEnabled(enabled: boolean): void;
};

/** 区間 1 つ分の表示。拡大バーの文言と揃える */
function segmentLabel(segment: ClipRange, index: number): string {
  const durationSec = Math.round(segment.endSec - segment.startSec);
  return `${index + 1}. ${formatTime(segment.startSec)} 〜 ${formatTime(segment.endSec)} (${durationSec}秒)`;
}

export function createSegmentList(
  callbacks: SegmentListCallbacks,
): SegmentList {
  const element = document.createElement("div");
  element.style.cssText = SEGMENT_STYLE.root;
  element.hidden = true;

  const rows = document.createElement("div");
  rows.style.cssText = SEGMENT_STYLE.root;

  const total = document.createElement("div");
  total.dataset.role = "total";
  total.style.cssText = SEGMENT_STYLE.total;

  element.append(rows, total);

  let enabled = true;

  /** 押せない間は伝えない。押せるのに何も起きない状態を作らない */
  function fire(action: () => void): (event: Event) => void {
    return (event) => {
      // 行の上のボタンが押されたとき、行の選択まで一緒に起きると
      // 「消そうとして選択が動く」ことになる
      event.stopPropagation();
      if (!enabled) return;
      action();
    };
  }

  function makeIconButton(
    role: string,
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = SEGMENT_STYLE.iconButton;
    button.addEventListener("click", fire(onClick));
    return button;
  }

  return {
    element,

    update(segments, selectedIndex, maxClipSec): void {
      // 区間が無いときは箱ごと消す。空の枠だけが残ると、何かを見落として
      // いるように見える
      element.hidden = segments.length === 0;

      rows.replaceChildren(
        ...segments.map((segment, index) => {
          const row = document.createElement("div");
          row.dataset.role = "segment";
          const selected = index === selectedIndex;
          row.dataset.selected = selected ? "true" : "false";
          row.style.cssText = selected
            ? SEGMENT_STYLE.rowSelected
            : SEGMENT_STYLE.row;

          const label = document.createElement("span");
          label.style.cssText = SEGMENT_STYLE.label;
          label.textContent = segmentLabel(segment, index);

          row.append(
            label,
            makeIconButton("play", "▶", "この区間を再生", () =>
              callbacks.onPlay(index),
            ),
            makeIconButton("remove", "✕", "この区間を消す", () =>
              callbacks.onRemove(index),
            ),
          );
          row.addEventListener("click", fire(() => callbacks.onSelect(index)));
          return row;
        }),
      );

      const sum = Math.round(totalSec(segments));
      const over = isOverLimit(segments, maxClipSec);
      total.textContent = `合計 ${sum}秒 / ${maxClipSec}秒`;
      total.dataset.over = over ? "true" : "false";
      total.style.cssText = over ? SEGMENT_STYLE.totalOver : SEGMENT_STYLE.total;
    },

    setEnabled(next): void {
      enabled = next;
      // 見た目でも押せないことを示す。押せる見た目のまま無反応にしない
      element.style.opacity = next ? "1" : "0.5";
    },
  };
}
