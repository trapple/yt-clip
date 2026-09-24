// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SIDE_PANEL_BODY_ID,
  SIDE_PANEL_ID,
  createSidePanel,
  type SidePanel,
} from "@/content/side-panel";

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function placeAt(element: HTMLElement, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectAt(top, height));
}

let panel: SidePanel | null = null;

function makePanel(): SidePanel {
  panel = createSidePanel();
  document.body.append(panel.element);
  return panel;
}

function collapseButton(target: SidePanel): HTMLButtonElement {
  const button = target.element.querySelector<HTMLButtonElement>(
    "[data-role='collapse']",
  );
  if (button === null) throw new Error("折り畳みボタンがありません");
  return button;
}

afterEach(() => {
  panel?.destroy();
  panel = null;
  vi.restoreAllMocks();
});

describe("createSidePanel", () => {
  test("作った直後は隠れている (中身が無い間は空の枠を出さない)", () => {
    const target = makePanel();
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("id で外から辿れる", () => {
    const target = makePanel();
    expect(document.getElementById(SIDE_PANEL_ID)).toBe(target.element);
    expect(document.getElementById(SIDE_PANEL_BODY_ID)).toBe(target.body);
  });

  test("setVisible で出し入れする", () => {
    const target = makePanel();

    target.setVisible(true);
    expect(target.element.hidden).toBe(false);
    expect(target.element.style.display).toBe("flex");

    target.setVisible(false);
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("画面の右端に固定し、ページ本体より上に重ねる", () => {
    const target = makePanel();
    expect(target.element.style.position).toBe("fixed");
    // ヘッダー 56px の下 12px
    expect(target.element.style.top).toBe("68px");
    expect(target.element.style.right).toBe("16px");
    expect(target.element.style.width).toBe("400px");
    expect(target.element.style.zIndex).toBe("2000");
  });

  test("見出しに yt-clip と折り畳みボタンを出す。最初は開いている", () => {
    const target = makePanel();
    expect(target.element.textContent).toContain("yt-clip");
    const button = collapseButton(target);
    expect(button.textContent).toBe("▶");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(target.body.hidden).toBe(false);
  });

  test("body に入れたものはパネルの中に出る", () => {
    const target = makePanel();
    const child = document.createElement("div");
    target.body.append(child);
    expect(target.element.contains(child)).toBe(true);
  });

  test("畳むと本体が隠れ、見出しは残る", () => {
    const target = makePanel();
    target.setVisible(true);

    collapseButton(target).click();

    expect(target.body.hidden).toBe(true);
    expect(target.body.style.display).toBe("none");
    // 見出しの 1 行は残る。パネルごと消えると、どこへ行ったか分からない
    expect(target.element.hidden).toBe(false);
    expect(collapseButton(target).isConnected).toBe(true);
    expect(collapseButton(target).textContent).toBe("◀");
    expect(collapseButton(target).getAttribute("aria-expanded")).toBe("false");
  });

  test("もう一度押すと開く", () => {
    const target = makePanel();
    collapseButton(target).click();
    collapseButton(target).click();

    expect(target.body.hidden).toBe(false);
    expect(target.body.style.display).toBe("flex");
    expect(collapseButton(target).textContent).toBe("▶");
  });

  test("畳んだまま隠して出しても、畳んだ状態を保つ", () => {
    const target = makePanel();
    collapseButton(target).click();

    target.setVisible(false);
    target.setVisible(true);

    expect(target.body.hidden).toBe(true);
    expect(target.body.style.display).toBe("none");
    expect(collapseButton(target).textContent).toBe("◀");
    expect(collapseButton(target).getAttribute("aria-expanded")).toBe("false");
  });

  test("reveal で畳んでいたら開く", () => {
    const target = makePanel();
    collapseButton(target).click();

    target.reveal();

    expect(target.body.hidden).toBe(false);
    expect(collapseButton(target).getAttribute("aria-expanded")).toBe("true");
  });

  test("reveal は開いていれば何も変えない", () => {
    const target = makePanel();
    target.reveal();
    expect(target.body.hidden).toBe(false);
    expect(collapseButton(target).textContent).toBe("▶");
  });

  test("destroy で DOM から外れる", () => {
    const target = makePanel();
    target.destroy();
    expect(target.element.isConnected).toBe(false);
    expect(document.getElementById(SIDE_PANEL_ID)).toBeNull();
  });
});

describe("scrollTo", () => {
  function panelWithRow(): { target: SidePanel; row: HTMLElement } {
    const target = makePanel();
    target.setVisible(true);
    const row = document.createElement("div");
    target.body.append(row);
    // 本体は画面の 100〜500px に見えている
    placeAt(target.body, 100, 400);
    return { target, row };
  }

  test("見える範囲より下にあれば、先頭を本体の上端に揃える", () => {
    const { target, row } = panelWithRow();
    placeAt(row, 900, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("既に送ってあれば、その分に足して揃える", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 200;
    placeAt(row, 700, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("上にはみ出していれば、先頭が見えるところまで戻す", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 500;
    placeAt(row, 40, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(440);
  });

  test("既に全部見えていれば動かさない (見ている位置を勝手に跳ねさせない)", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 30;
    placeAt(row, 150, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(30);
  });

  test("本体の外の要素には何もしない", () => {
    const { target } = panelWithRow();
    const outside = document.createElement("div");
    document.body.append(outside);
    placeAt(outside, 900, 50);

    target.scrollTo(outside);

    expect(target.body.scrollTop).toBe(0);
    outside.remove();
  });
});
