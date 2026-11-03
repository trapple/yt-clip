/**
 * 詰める欄 (ADR 0001・第 2 版のモック)。見出しの行 (区間 N を詰める・時刻・‹ ›・頭と尻の ±0.1・繋ぎ目の聞き直し)、
 * 拡大バー (前後 2 秒の窓) とテロップの帯、窓の中の単語を並べる。詰める操作は見出しの行に入れ、行を増やさない
 * (回答 2026-11-03「行を詰めて最小に」。1440x795 でバーの背をなるべく伸ばさないように)。
 *
 * **区間は持たない。** 何を出すかは `update` で受け取り、押されたことを伝えるだけ (状態機械に送るのは youtube.ts)。
 * 拡大バーとテロップの帯は youtube.ts が作り、要素だけをここに入れる (どちらも youtube.ts が直接更新する)
 */

import { NUDGE_SEC, timeToRatio, type HandleKind, type TimeWindow } from "@/content/range-math";
import { TRIM_STYLE } from "@/content/styles";
import type { TrimWord } from "@/content/trim-words";
import { formatTime, formatTimeCentis } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

export type TrimPanelCallbacks = {
  /** ‹ › で区間を選んだ (0 始まり) */
  onSelect(index: number): void;
  /** 頭か尻を deltaSec (±NUDGE_SEC) 動かす */
  onNudge(kind: HandleKind, deltaSec: number): void;
  /** 繋ぎ目を聞き直す。in = 頭の 2 秒前から、out = 尻をまたいで */
  onPlayAround(kind: HandleKind): void;
};

export type TrimView = {
  /** 選んでいる区間 (0 始まり)。無ければ -1 */
  index: number;
  count: number;
  /** 選んでいる区間。無ければ null */
  range: ClipRange | null;
  /** 全区間の合計 (秒) */
  totalSec: number;
  /** 拡大バーが映している窓。まだ無ければ null */
  window: TimeWindow | null;
  /** 窓に入る単語 (`wordsInWindow`) */
  words: readonly TrimWord[];
};

export type TrimPanel = {
  element: HTMLElement;
  update(view: TrimView): void;
  setEnabled(enabled: boolean): void;
  /** キーで動かす端。拡大バーのハンドルを掴んだら呼ぶ */
  setActiveEdge(kind: HandleKind): void;
};

/** 秒を 0.1 秒の桁で出す (見出しの長さと合計) */
const tenths = (sec: number): string => (Math.round(sec * 10) / 10).toFixed(1);

/** 押されたキーが文字を打つ欄の中か。打っている文字を横取りしない */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

export function createTrimPanel(
  parts: { rangeBar: HTMLElement; telopTrack: HTMLElement },
  callbacks: TrimPanelCallbacks,
): TrimPanel {
  let view: TrimView = { index: -1, count: 0, range: null, totalSec: 0, window: null, words: [] };
  let enabled = false;
  /** キーで動かす端。はじめは頭 (モック「選んでいる端を動かす」) */
  let activeEdge: HandleKind = "in";

  const element = document.createElement("div");
  element.dataset.role = "trim";
  // キーを受けるためにフォーカスを持てるようにする (ハンドルを掴んだら setActiveEdge が移す)
  element.tabIndex = -1;
  element.style.cssText = TRIM_STYLE.root;

  function button(role: string, label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.dataset.role = role;
    node.textContent = label;
    if (title !== undefined) {
      node.title = title;
      // 文字を縮めたボタンは、読み上げにも全文を渡す
      node.setAttribute("aria-label", title);
    }
    node.style.cssText = TRIM_STYLE.smallButton;
    node.addEventListener("click", () => {
      if (enabled) onClick();
    });
    return node;
  }

  /** ボタンを押したときも、その端をキーの端にする (続けてキーで詰められる) */
  function nudge(kind: HandleKind, deltaSec: number): void {
    setActive(kind);
    callbacks.onNudge(kind, deltaSec);
  }

  // --- 見出しの行 (詰める操作も入れる) ---
  const head = document.createElement("div");
  head.dataset.role = "trim-head";
  head.style.cssText = TRIM_STYLE.head;
  const title = document.createElement("span");
  title.dataset.role = "trim-title";
  title.style.cssText = TRIM_STYLE.title;
  const rangeText = document.createElement("span");
  rangeText.dataset.role = "trim-range";
  rangeText.style.cssText = TRIM_STYLE.range;
  const prev = button("trim-prev", "‹", () => callbacks.onSelect(view.index - 1));
  const nextButton = button("trim-next", "›", () => callbacks.onSelect(view.index + 1));
  const grow = document.createElement("span");
  grow.style.cssText = TRIM_STYLE.grow;

  const edgeGroup = (role: string, label: string, ...buttons: HTMLButtonElement[]): HTMLElement => {
    const box = document.createElement("span");
    box.dataset.role = role;
    box.style.cssText = TRIM_STYLE.group;
    // 印 (下線と濃い文字) は「頭」「尻」の文字だけに付ける。組に付けると中のボタンの文字にも下線が継がれる
    const name = document.createElement("span");
    name.textContent = label;
    box.append(name, ...buttons);
    return box;
  };
  const nudgeButtons = [
    button("nudge-in-minus", "−0.1", () => nudge("in", -NUDGE_SEC)),
    button("nudge-in-plus", "＋0.1", () => nudge("in", NUDGE_SEC)),
    button("nudge-out-minus", "−0.1", () => nudge("out", -NUDGE_SEC)),
    button("nudge-out-plus", "＋0.1", () => nudge("out", NUDGE_SEC)),
  ] as const;
  const inGroup = edgeGroup("trim-edge-in", "頭", nudgeButtons[0], nudgeButtons[1]);
  const outGroup = edgeGroup("trim-edge-out", "尻", nudgeButtons[2], nudgeButtons[3]);
  // 文字は短くし、全文は title に出す (1 行に収める)
  const playHead = button("play-head", "▶ 頭", () => callbacks.onPlayAround("in"), "頭の 2 秒前から再生");
  const playTail = button("play-tail", "▶ 尻", () => callbacks.onPlayAround("out"), "尻をまたいで再生 (尻の 2 秒前から 2 秒後まで)");
  head.append(title, rangeText, prev, nextButton, grow, inGroup, outGroup, playHead, playTail);

  // --- 単語の段 (拡大バーのトラックと左右を揃える) ---
  const words = document.createElement("div");
  words.dataset.role = "trim-words";
  words.style.cssText = TRIM_STYLE.words;
  const ghostStart = document.createElement("span");
  ghostStart.style.cssText = TRIM_STYLE.ghost;
  const lane = document.createElement("div");
  lane.style.cssText = TRIM_STYLE.lane;
  const ghostEnd = document.createElement("span");
  ghostEnd.style.cssText = TRIM_STYLE.ghost;
  words.append(ghostStart, lane, ghostEnd);

  element.append(head, parts.rangeBar, parts.telopTrack, words);

  /** キーで動く端の組に印を付ける (どちらが動くか見えるように) */
  function setActive(kind: HandleKind): void {
    activeEdge = kind;
    for (const [group, edge] of [[inGroup, "in"], [outGroup, "out"]] as const) {
      if (edge === kind) group.dataset.active = "true";
      else delete group.dataset.active;
      const name = group.firstElementChild as HTMLElement;
      name.style.cssText = edge === kind ? TRIM_STYLE.groupActive : "";
    }
  }
  setActive("in");

  element.addEventListener("keydown", (event) => {
    if (event.key !== "," && event.key !== ".") return;
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (view.range === null) return;
    // YouTube は , . を止めている間のコマ送りに使う。欄が受けたら渡さない (実機で、ここで止めればコマ送りが起きないことを確かめた)。
    // **受け付けない間 (録画の準備・録画中) も飲み込む。** 欄にフォーカスが残ったまま録画の頭へ止めている間に YouTube へ
    // 渡すと、止まった動画が 1 コマ進み、録画の頭がずれる
    event.preventDefault();
    event.stopPropagation();
    if (!enabled) return;
    callbacks.onNudge(activeEdge, event.key === "," ? -NUDGE_SEC : NUDGE_SEC);
  });

  function paintWords(): void {
    const window = view.window;
    const range = view.range;
    const shown = window !== null && range !== null ? view.words : [];
    // **display も切り替える。** 根の inline の display:flex は [hidden] に勝ち、空の段が背を取り続ける (telop-track と同じ作法)
    words.hidden = shown.length === 0;
    words.style.display = shown.length === 0 ? "none" : "flex";
    if (window === null || range === null) {
      lane.replaceChildren();
      return;
    }
    // 拡大バーのトラックの左右の時刻と同じ文字を見えないまま置き、幅を揃える
    ghostStart.textContent = formatTime(window.startSec);
    ghostEnd.textContent = formatTime(window.endSec);
    lane.replaceChildren(
      ...shown.map((word) => {
        const chip = document.createElement("span");
        chip.dataset.role = "trim-word";
        const middle = (word.startSec + word.endSec) / 2;
        const out = middle < range.startSec || range.endSec < middle;
        if (out) chip.dataset.out = "true";
        chip.style.cssText = out ? `${TRIM_STYLE.word}${TRIM_STYLE.wordOut}` : TRIM_STYLE.word;
        const left = timeToRatio(Math.max(word.startSec, window.startSec), window);
        const right = timeToRatio(Math.min(word.endSec, window.endSec), window);
        chip.style.left = `${left * 100}%`;
        chip.style.width = `${(right - left) * 100}%`;
        chip.textContent = word.text;
        chip.title = word.text;
        return chip;
      }),
    );
  }

  function paint(): void {
    const range = view.index >= 0 ? view.range : null;
    if (range !== null) {
      title.textContent = `区間 ${view.index + 1} を詰める`;
      const length = range.endSec - range.startSec;
      rangeText.textContent = `${formatTimeCentis(range.startSec)} – ${formatTimeCentis(range.endSec)} · ${tenths(length)} 秒 · 合計 ${tenths(view.totalSec)} 秒`;
    } else {
      title.textContent = "区間はまだありません";
      rangeText.textContent = "文字起こしの行を押すか、＋ 区間を追加 で作れます";
    }
    const hasPrev = range !== null && view.index > 0;
    const hasNext = range !== null && view.index < view.count - 1;
    // 行き先の番号を出す (モック「‹ 区間 1」「区間 3 ›」)
    prev.textContent = hasPrev ? `‹ 区間 ${view.index}` : "‹";
    nextButton.textContent = hasNext ? `区間 ${view.index + 2} ›` : "›";
    prev.disabled = !hasPrev;
    nextButton.disabled = !hasNext;
    for (const node of [...nudgeButtons, playHead, playTail]) node.disabled = range === null;
    paintWords();
  }

  return {
    element,
    update(nextView: TrimView): void {
      view = nextView;
      paint();
    },
    setEnabled(value: boolean): void {
      enabled = value;
      // 見出しの文 (何を詰めているか) は録画中も読める。押せる所だけ薄くする
      for (const node of [prev, nextButton, ...nudgeButtons, playHead, playTail]) {
        node.style.cssText = value ? TRIM_STYLE.smallButton : `${TRIM_STYLE.smallButton}${TRIM_STYLE.disabled}`;
      }
    },
    setActiveEdge(kind: HandleKind): void {
      setActive(kind);
      element.focus({ preventScroll: true });
    },
  };
}
