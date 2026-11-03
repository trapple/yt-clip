// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { createSegmentList } from "@/content/segment-list";
import type { ClipRange } from "@/shared/types";

const segments: ClipRange[] = [
  { startSec: 83, endSec: 98 },
  { startSec: 242, endSec: 250 },
];

function makeList() {
  const calls = {
    select: [] as number[],
    play: [] as number[],
    remove: [] as number[],
  };
  const list = createSegmentList({
    onSelect: (index) => calls.select.push(index),
    onPlay: (index) => calls.play.push(index),
    onRemove: (index) => calls.remove.push(index),
  });
  document.body.append(list.element);
  return { list, calls };
}

function rows(list: { element: HTMLElement }): HTMLElement[] {
  return [...list.element.querySelectorAll<HTMLElement>("[data-role='segment']")];
}

function iconButtons(
  list: { element: HTMLElement },
  role: "play" | "remove",
): HTMLElement[] {
  return [
    ...list.element.querySelectorAll<HTMLElement>(`[data-role='${role}']`),
  ];
}

describe("区間の一覧", () => {
  test("区間ごとに行を出す", () => {
    const { list } = makeList();
    list.update(segments, 0, 60);

    const texts = rows(list).map((row) => row.textContent ?? "");
    expect(texts[0]).toContain("1:23");
    expect(texts[0]).toContain("1:38");
    expect(texts[0]).toContain("15秒");
    expect(texts[1]).toContain("4:02");
  });

  test("選択中の行に印を付ける", () => {
    const { list } = makeList();
    list.update(segments, 1, 60);

    expect(rows(list).map((row) => row.dataset.selected)).toEqual([
      "false",
      "true",
    ]);
  });

  test("行を押すと選択を伝える", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);

    rows(list)[1]?.click();

    expect(calls.select).toEqual([1]);
  });

  test("▶ と ✕ は選択と混ざらない", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);

    iconButtons(list, "play")[1]?.click();
    iconButtons(list, "remove")[0]?.click();

    expect(calls.play).toEqual([1]);
    expect(calls.remove).toEqual([0]);
    // 行のクリックまで一緒に発火すると、消そうとして選択が動く
    expect(calls.select).toEqual([]);
  });

  test("合計と上限を出す", () => {
    const { list } = makeList();
    list.update(segments, 0, 60);

    const total = list.element.querySelector("[data-role='total']");
    expect(total?.textContent).toBe("合計 23秒 / 60秒");
  });

  test("合計が上限を超えたら知らせる", () => {
    const { list } = makeList();
    list.update(segments, 0, 20);

    const total = list.element.querySelector<HTMLElement>("[data-role='total']");
    expect(total?.dataset.over).toBe("true");
  });

  test("区間が無ければ何も出さない", () => {
    const { list } = makeList();
    list.update([], -1, 60);

    expect(rows(list)).toEqual([]);
    expect(list.element.hidden).toBe(true);
  });

  test("隠すときは inline の display も none にする", () => {
    // 根は display:flex を inline で持つので、hidden だけだと UA の [hidden] に勝って出たままになる。
    // jsdom は UA の [hidden] を計算しないので style.display で測る
    const { list } = makeList();
    expect(list.element.style.display).toBe("none");
    list.update(segments, 0, 60);
    expect(list.element.style.display).toBe("flex");
    list.update([], -1, 60);
    expect(list.element.style.display).toBe("none");
  });

  test("録画中は操作を受け付けない", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);

    list.setEnabled(false);
    rows(list)[1]?.click();
    iconButtons(list, "remove")[0]?.click();

    expect(calls.select).toEqual([]);
    expect(calls.remove).toEqual([]);
  });
});
