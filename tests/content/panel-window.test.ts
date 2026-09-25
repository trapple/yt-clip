// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  PANEL_HEADER_HEIGHT_PX,
  SETTINGS_CASCADE_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
  type PanelWindow,
  type PanelWindowOptions,
} from "@/content/panel-window";

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

let made: PanelWindow | null = null;

function makeWindow(options: Partial<PanelWindowOptions> = {}): PanelWindow {
  made = createPanelWindow({ id: "yt-clip-list", title: "区間・テロップ", ...options });
  document.body.append(made.element);
  return made;
}

function headerOf(target: PanelWindow): HTMLElement {
  const header = target.element.querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("見出しがありません");
  return header;
}

function resizeGripOf(target: PanelWindow): HTMLElement {
  const grip = target.element.querySelector<HTMLElement>("[data-role='window-resize']");
  if (grip === null) throw new Error("右下のつまみがありません");
  return grip;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない (窓の枠のドラッグが呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

afterEach(() => {
  made?.destroy();
  made = null;
  vi.restoreAllMocks();
});

describe("createPanelWindow", () => {
  test("作った直後は隠れている (中身が入り、出す判断がされるまで空の枠を出さない)", () => {
    const target = makeWindow();
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("窓と中身の箱を id で外から辿れる (中身の箱は `${id}-body`)", () => {
    const target = makeWindow({ id: "yt-clip-settings", title: "設定" });
    expect(document.getElementById("yt-clip-settings")).toBe(target.element);
    expect(document.getElementById("yt-clip-settings-body")).toBe(target.body);
  });

  test("見出しに中身の名前を出す。折り畳みのボタンは持たない", () => {
    const target = makeWindow({ title: "設定" });
    expect(headerOf(target).textContent).toBe("設定");
    expect(target.element.querySelector("[data-role='collapse']")).toBeNull();
  });

  test("setVisible で出し入れする", () => {
    const target = makeWindow();

    target.setVisible(true);
    expect(target.element.hidden).toBe(false);
    expect(target.element.style.display).toBe("flex");

    target.setVisible(false);
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("中身の箱は出たまま (折り畳みが無いので、本体だけを隠す経路が無い)", () => {
    const target = makeWindow();
    // 並べ方とスクロールの宣言は styles.test.ts の PANEL_WINDOW_STYLE で確かめる
    // (jsdom の style は知らない宣言を落としうるので、ここでは display だけを見る)
    expect(target.body.style.display).toBe("flex");
    expect(target.body.hidden).toBe(false);
  });

  test("最初の位置に置くと、高さは中身まで・最大で画面の下端から 16px まで", () => {
    const target = makeWindow();
    target.frame.place(initialListRect({ width: window.innerWidth, height: window.innerHeight }));
    expect(target.element.style.top).toBe("68px");
    expect(target.element.style.height).toBe("");
    // 768 (jsdom の画面の高さ) - 68 - 16
    expect(target.element.style.maxHeight).toBe(`${window.innerHeight - 84}px`);
  });

  test("見出しをドラッグすると動き、指を離したときに知らせる", () => {
    const onUserMove = vi.fn();
    const target = makeWindow({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(target);

    pointer(header, "pointerdown", 0, 0);
    pointer(header, "pointermove", 30, 20);
    pointer(header, "pointerup", 30, 20);

    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 400 });
  });

  test("大きさは幅 280px・高さ 160px より小さくならない (今のパネルと同じ下限)", () => {
    const onUserMove = vi.fn();
    const target = makeWindow({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400, height: 500 });
    const grip = resizeGripOf(target);

    pointer(grip, "pointerdown", 0, 0);
    pointer(grip, "pointermove", -1000, -1000);
    pointer(grip, "pointerup", -1000, -1000);

    expect(onUserMove).toHaveBeenCalledWith({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("見出しのダブルクリックで最初の位置に戻すよう頼む", () => {
    const onResetRequest = vi.fn();
    const target = makeWindow({ onResetRequest });

    headerOf(target).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });

  test("見出しのドラッグの指の位置を onDragPoint へそのまま渡す (落とし先の当たり判定は dock.ts)", () => {
    const onDragPoint = vi.fn<NonNullable<PanelWindowOptions["onDragPoint"]>>(() => false);
    const target = makeWindow({ onDragPoint });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });

    pointer(headerOf(target), "pointerdown", 100, 100);
    pointer(headerOf(target), "pointermove", 130, 120);
    pointer(headerOf(target), "pointerup", 130, 120);

    expect(onDragPoint.mock.calls.map(([phase]) => phase)).toEqual(["start", "move", "end"]);
  });

  test("見出しの行の高さは 32px (タブから引き出した窓を、指が見出しの中に来るよう置く)", () => {
    expect(PANEL_HEADER_HEIGHT_PX).toBe(32);
  });

  test("body に入れたものは窓の中に出る", () => {
    const target = makeWindow();
    const child = document.createElement("div");
    target.body.append(child);
    expect(target.element.contains(child)).toBe(true);
  });

  test("destroy で DOM から外れる", () => {
    const target = makeWindow();
    target.destroy();
    expect(target.element.isConnected).toBe(false);
    expect(document.getElementById("yt-clip-list")).toBeNull();
  });
});

describe("最初の位置", () => {
  test("区間・テロップの窓は今の右側パネルと同じ (右 16px・上 68px・幅 400px・高さは決めない)", () => {
    expect(initialListRect({ width: 1440, height: 795 })).toEqual({
      left: 1024,
      top: 68,
      width: 400,
    });
  });

  test("設定の窓は区間・テロップの窓から下へ 32px だけずらす (left は同じ)", () => {
    expect(SETTINGS_CASCADE_PX).toBe(32);
    expect(initialSettingsRect({ width: 1440, height: 795 })).toEqual({
      left: 1024,
      top: 100,
      width: 400,
    });
  });

  test("1440x795 で設定の窓の左端はプレイヤーの右端 (1012px、実測) より右 (受け入れ条件 C1.5)", () => {
    expect(initialSettingsRect({ width: 1440, height: 795 }).left).toBeGreaterThanOrEqual(1012);
  });
});

describe("scrollTo", () => {
  function windowWithRow(): { target: PanelWindow; row: HTMLElement } {
    const target = makeWindow();
    target.setVisible(true);
    const row = document.createElement("div");
    target.body.append(row);
    // 本体は画面の 100〜500px に見えている
    placeAt(target.body, 100, 400);
    return { target, row };
  }

  test("見える範囲より下にあれば、先頭を本体の上端に揃える", () => {
    const { target, row } = windowWithRow();
    placeAt(row, 900, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("既に送ってあれば、その分に足して揃える", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 200;
    placeAt(row, 700, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("上にはみ出していれば、先頭が見えるところまで戻す", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 500;
    placeAt(row, 40, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(440);
  });

  test("既に全部見えていれば動かさない (見ている位置を勝手に跳ねさせない)", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 30;
    placeAt(row, 150, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(30);
  });

  test("本体の外の要素には何もしない", () => {
    const { target } = windowWithRow();
    const outside = document.createElement("div");
    document.body.append(outside);
    placeAt(outside, 900, 50);

    target.scrollTo(outside);

    expect(target.body.scrollTop).toBe(0);
    outside.remove();
  });
});
