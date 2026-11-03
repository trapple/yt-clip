// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTrimPanel, type TrimPanel, type TrimView } from "@/content/trim-panel";

const VIEW: TrimView = {
  index: 1,
  count: 3,
  range: { startSec: 741.4, endSec: 749.8 },
  totalSec: 24.6,
  maxClipSec: 60,
  over: false,
  window: { startSec: 739.4, endSec: 751.8 },
  words: [
    { startSec: 740, endSec: 741, text: "（前）" },
    { startSec: 741.4, endSec: 742.2, text: "その" },
    { startSec: 749.9, endSec: 751, text: "いやほんと" },
  ],
};

const EMPTY: TrimView = { index: -1, count: 0, range: null, totalSec: 0, maxClipSec: 60, over: false, window: null, words: [] };

function mount(view: TrimView = VIEW) {
  const callbacks = { onSelect: vi.fn(), onNudge: vi.fn(), onPlayAround: vi.fn() };
  const rangeBar = document.createElement("div");
  rangeBar.id = "range";
  const panel = createTrimPanel({ rangeBar }, callbacks);
  document.body.append(panel.element);
  panel.update(view);
  panel.setEnabled(true);
  return { panel, callbacks };
}

function part(panel: TrimPanel, role: string): HTMLElement {
  const element = panel.element.querySelector<HTMLElement>(`[data-role='${role}']`);
  if (element === null) throw new Error(`${role} がありません`);
  return element;
}

function buttonOf(panel: TrimPanel, role: string): HTMLButtonElement {
  return part(panel, role) as HTMLButtonElement;
}

function key(panel: TrimPanel, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  panel.element.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("見出しの行", () => {
  test("何番目の区間か、頭と尻・長さ・合計を出す", () => {
    const { panel } = mount();
    expect(part(panel, "trim-title").textContent).toBe("区間 2 を詰める");
    expect(part(panel, "trim-range").textContent).toBe("12:21.40 – 12:29.80 · 8.4 秒 · 合計 24.6 / 60 秒");
  });

  test("合計が上限を超えたら警告の印と色を付ける (外した区間の一覧の合計の役目。判定は録画ボタンと同じ isOverLimit を受け取る)", () => {
    const { panel } = mount({ ...VIEW, totalSec: 61.2, maxClipSec: 60, over: true });
    expect(part(panel, "trim-range").textContent).toContain("合計 61.2 / 60 秒");
    expect(part(panel, "trim-range").dataset.over).toBe("true");
    expect(part(panel, "trim-range").style.cssText).toContain("font-weight: 600");

    panel.update({ ...VIEW, totalSec: 24.6, maxClipSec: 60, over: false });
    expect(part(panel, "trim-range").dataset.over).toBe("false");
  });

  test("‹ › は行き先の区間の番号を出し、押すとその区間を選ぶ", () => {
    const { panel, callbacks } = mount();
    expect(part(panel, "trim-prev").textContent).toBe("‹ 区間 1");
    expect(part(panel, "trim-next").textContent).toBe("区間 3 ›");
    part(panel, "trim-prev").click();
    part(panel, "trim-next").click();
    expect(callbacks.onSelect.mock.calls).toEqual([[0], [2]]);
  });

  test("端の区間では先が押せず、番号も出さない", () => {
    const { panel } = mount({ ...VIEW, index: 0 });
    expect(buttonOf(panel, "trim-prev").disabled).toBe(true);
    expect(part(panel, "trim-prev").textContent).toBe("‹");
    panel.update({ ...VIEW, index: 2 });
    expect(buttonOf(panel, "trim-next").disabled).toBe(true);
    expect(part(panel, "trim-next").textContent).toBe("›");
  });

  test("区間が無いときは案内だけ", () => {
    const { panel } = mount(EMPTY);
    expect(part(panel, "trim-title").textContent).toBe("区間はまだありません");
    expect(part(panel, "trim-range").textContent).toBe("文字起こしの行を押すか、＋ 区間を追加 で作れます");
    for (const role of ["trim-prev", "trim-next", "nudge-in-minus", "nudge-out-plus", "play-head", "play-tail"]) {
      expect(buttonOf(panel, role).disabled).toBe(true);
    }
  });

  test("詰める操作は見出しの行に入る (行を増やさない)", () => {
    const { panel } = mount();
    const head = part(panel, "trim-head");
    for (const role of ["trim-prev", "trim-next", "nudge-in-minus", "nudge-in-plus", "nudge-out-minus", "nudge-out-plus", "play-head", "play-tail"]) {
      expect(head.contains(part(panel, role))).toBe(true);
    }
  });
});

describe("中身の並び", () => {
  test("見出しの行 → 拡大バー → 単語", () => {
    const { panel } = mount();
    const ids = [...panel.element.children].map((child) => child.id || (child as HTMLElement).dataset.role);
    expect(ids).toEqual(["trim-head", "range", "trim-words"]);
  });
});

describe("単語の並び", () => {
  test("窓の中の位置に置き、区間の外の単語は印を付ける", () => {
    const { panel } = mount();
    const words = [...panel.element.querySelectorAll<HTMLElement>("[data-role='trim-word']")];
    expect(words.map((word) => word.textContent)).toEqual(["（前）", "その", "いやほんと"]);
    expect(words.map((word) => word.dataset.out)).toEqual(["true", undefined, "true"]);
    // 窓 739.4〜751.8 (12.4 秒) の 740 は 0.6 / 12.4
    expect(parseFloat(words[0]?.style.left ?? "")).toBeCloseTo((0.6 / 12.4) * 100, 3);
  });

  test("単語が無ければ段を出さない (display も消し、空の段に背を取らせない)", () => {
    const { panel } = mount({ ...VIEW, words: [] });
    expect(part(panel, "trim-words").hidden).toBe(true);
    expect(part(panel, "trim-words").style.display).toBe("none");
    panel.update(VIEW);
    expect(part(panel, "trim-words").style.display).toBe("flex");
  });

  test("文字は textContent で入れる", () => {
    const { panel } = mount({ ...VIEW, words: [{ startSec: 742, endSec: 743, text: "<img src=x onerror=alert(1)>" }] });
    expect(panel.element.querySelector("img")).toBeNull();
  });
});

describe("詰める操作", () => {
  test("頭と尻の −0.1 / ＋0.1", () => {
    const { panel, callbacks } = mount();
    part(panel, "nudge-in-minus").click();
    part(panel, "nudge-in-plus").click();
    part(panel, "nudge-out-minus").click();
    part(panel, "nudge-out-plus").click();
    expect(callbacks.onNudge.mock.calls).toEqual([
      ["in", -0.1],
      ["in", 0.1],
      ["out", -0.1],
      ["out", 0.1],
    ]);
  });

  test("繋ぎ目を聞き直す", () => {
    const { panel, callbacks } = mount();
    part(panel, "play-head").click();
    part(panel, "play-tail").click();
    expect(callbacks.onPlayAround.mock.calls).toEqual([["in"], ["out"]]);
  });
});

describe("キー", () => {
  test(", と . は、はじめは頭を動かす。頭の組に印が付く", () => {
    const { panel, callbacks } = mount();
    expect(part(panel, "trim-edge-in").dataset.active).toBe("true");
    expect(part(panel, "trim-edge-out").dataset.active).toBeUndefined();
    key(panel, ",");
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls).toEqual([
      ["in", -0.1],
      ["in", 0.1],
    ]);
  });

  test("掴んだ端を動かし、印も移る", () => {
    const { panel, callbacks } = mount();
    panel.setActiveEdge("out");
    expect(part(panel, "trim-edge-out").dataset.active).toBe("true");
    expect(part(panel, "trim-edge-in").dataset.active).toBeUndefined();
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls).toEqual([["out", 0.1]]);
  });

  test("印は「頭」「尻」の文字だけに付け、中のボタンの文字には下線を継がせない", () => {
    const { panel } = mount();
    const group = part(panel, "trim-edge-in");
    expect((group.firstElementChild as HTMLElement).style.textDecoration).toBe("underline");
    expect(group.style.textDecoration).toBe("");
  });

  test("±0.1 を押した端もキーの端になる", () => {
    const { panel, callbacks } = mount();
    part(panel, "nudge-out-minus").click();
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls.at(-1)).toEqual(["out", 0.1]);
    expect(part(panel, "trim-edge-out").dataset.active).toBe("true");
  });

  test("受けたキーは YouTube へ渡さない (コマ送りと取り合わない)", () => {
    const { panel } = mount();
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    const event = key(panel, ".");
    document.removeEventListener("keydown", onDocument);
    expect(event.defaultPrevented).toBe(true);
    expect(onDocument).not.toHaveBeenCalled();
  });

  test("修飾キー付きと、ほかのキーは受けない", () => {
    const { panel, callbacks } = mount();
    expect(key(panel, ".", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(panel, "k").defaultPrevented).toBe(false);
    expect(callbacks.onNudge).not.toHaveBeenCalled();
  });

  test("文字を打つ欄の中のキーは受けない", () => {
    const { panel, callbacks } = mount();
    const input = document.createElement("textarea");
    panel.element.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true }));
    expect(callbacks.onNudge).not.toHaveBeenCalled();
  });

  test("操作を受け付けない間 (録画の準備・録画中) も、キーは YouTube へ渡さない", () => {
    // 録画の頭へ止めている間に YouTube がコマ送りすると、録画の頭がずれる
    const { panel, callbacks } = mount();
    panel.setEnabled(false);
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    const event = key(panel, ".");
    document.removeEventListener("keydown", onDocument);
    expect(event.defaultPrevented).toBe(true);
    expect(onDocument).not.toHaveBeenCalled();
    expect(callbacks.onNudge).not.toHaveBeenCalled();
  });

  test("操作を受け付けない間は、ボタンもキーも効かない", () => {
    const { panel, callbacks } = mount();
    panel.setEnabled(false);
    key(panel, ".");
    part(panel, "nudge-in-plus").click();
    part(panel, "trim-next").click();
    part(panel, "play-head").click();
    expect(callbacks.onNudge).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onPlayAround).not.toHaveBeenCalled();
  });

  test("掴んだら欄にフォーカスを移す (キーが届くように)", () => {
    const { panel } = mount();
    panel.setActiveEdge("in");
    expect(document.activeElement).toBe(panel.element);
  });
});
