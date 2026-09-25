// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createFloatingWindow,
  type FloatingWindow,
  type FloatingWindowOptions,
} from "@/content/floating-window";

/** jsdom の画面の既定。テストが変えたら afterEach で戻す */
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
}

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function boxAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る。
 * `pointerId` は 2 本目の指の区別を確かめるテストのためだけに指定できる
 * (省くと undefined のまま。実装は捕捉の関数に渡すだけなので、既存のテストは変わらない)
 */
function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  button = 0,
  pointerId?: number,
): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button });
  if (pointerId !== undefined) Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

/** (100, 100) で押し、dx / dy だけ動かして離す */
function drag(target: Element, dx: number, dy: number): void {
  pointer(target, "pointerdown", 100, 100);
  pointer(target, "pointermove", 100 + dx, 100 + dy);
  pointer(target, "pointerup", 100 + dx, 100 + dy);
}

function dblclick(target: Element): void {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

let created: FloatingWindow[] = [];

/** 作って body に付け、出しておく。既定はパネルの窓と同じ (見出しあり・幅と高さ) */
function makeWindow(overrides: Partial<FloatingWindowOptions> = {}) {
  const onUserMove = vi.fn();
  const onResetRequest = vi.fn();
  const frame = createFloatingWindow({
    id: `win-${created.length}`,
    title: "見出し",
    resize: "both",
    minWidth: 280,
    minHeight: 160,
    onUserMove,
    onResetRequest,
    ...overrides,
  });
  created.push(frame);
  document.body.append(frame.element);
  frame.setVisible(true);
  return { frame, onUserMove, onResetRequest };
}

/** バーの窓と同じ形 (見出し無し・幅だけ・つまみを登録) */
function makeBarLikeWindow() {
  const made = makeWindow({ title: undefined, resize: "width", minWidth: 480, minHeight: undefined });
  const grip = document.createElement("span");
  made.frame.body.append(grip);
  made.frame.addDragHandle(grip);
  return { ...made, grip };
}

function headerOf(frame: FloatingWindow): HTMLElement {
  const header = frame.element.querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("見出しがありません");
  return header;
}

function resizeGripOf(frame: FloatingWindow): HTMLElement {
  const grip = frame.element.querySelector<HTMLElement>("[data-role='window-resize']");
  if (grip === null) throw new Error("右下のつまみがありません");
  return grip;
}

/** 窓の枠に当てた位置と大きさ */
function styleOf(frame: FloatingWindow): { left: string; top: string; width: string; height: string } {
  const { left, top, width, height } = frame.element.style;
  return { left, top, width, height };
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

afterEach(() => {
  for (const frame of created) frame.destroy();
  created = [];
  vi.restoreAllMocks();
  setViewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe("createFloatingWindow", () => {
  test("作った直後は隠れている (中身が入るまで空の枠を出さない)", () => {
    const frame = createFloatingWindow({
      id: "win-hidden",
      resize: "width",
      minWidth: 480,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    created.push(frame);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("id で辿れ、画面に固定してページ本体より上に重ねる", () => {
    const { frame } = makeWindow({ id: "yt-clip-test-window" });
    expect(document.getElementById("yt-clip-test-window")).toBe(frame.element);
    expect(frame.element.style.position).toBe("fixed");
    expect(frame.element.style.zIndex).toBe("2000");
  });

  test("setVisible で出し入れする", () => {
    const { frame } = makeWindow();
    expect(frame.element.hidden).toBe(false);
    expect(frame.element.style.display).toBe("flex");
    frame.setVisible(false);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("見出しのある窓は、見出しの文言を持つ", () => {
    const { frame } = makeWindow({ title: "yt-clip" });
    const header = headerOf(frame);
    expect(header.textContent).toBe("yt-clip");
    expect(frame.element.contains(frame.body)).toBe(true);
  });

  test("見出しの無い窓は見出しの行を作らない", () => {
    const { frame } = makeWindow({ title: undefined });
    expect(frame.element.querySelector("[data-role='window-header']")).toBeNull();
  });

  test("place で位置と大きさを置き、rect で読める", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 60, width: 400, height: 300 });
    expect(frame.element.style.left).toBe("100px");
    expect(frame.element.style.top).toBe("60px");
    expect(frame.element.style.width).toBe("400px");
    expect(frame.element.style.height).toBe("300px");
    expect(frame.element.style.maxHeight).toBe("");
    expect(frame.rect()).toEqual({ left: 100, top: 60, width: 400, height: 300 });
  });

  test("高さを決めていない「幅と高さ」の窓は、画面の下端から 16px までに抑える", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 68, width: 400 });
    expect(frame.element.style.height).toBe("");
    // 768 - 68 - 16
    expect(frame.element.style.maxHeight).toBe("684px");
  });

  test("「幅だけ」の窓は高さを抑えず、覚えた高さが混ざっていても使わない", () => {
    const { frame } = makeBarLikeWindow();
    frame.place({ left: 100, top: 68, width: 600, height: 300 });
    expect(frame.element.style.height).toBe("");
    expect(frame.element.style.maxHeight).toBe("");
    expect(frame.rect()).toEqual({ left: 100, top: 68, width: 600 });
  });

  test("destroy で DOM から外れ、window の resize も聞かなくなる", () => {
    const { frame } = makeWindow({ id: "yt-clip-test-window" });
    frame.place({ left: 900, top: 100, width: 400 });
    frame.destroy();
    expect(frame.element.isConnected).toBe(false);
    expect(document.getElementById("yt-clip-test-window")).toBeNull();

    const leftBeforeResize = frame.element.style.left;
    // listener を外していないと、画面が小さくなったときに詰め直しが起きて left が変わる
    setViewport(500, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.element.style.left).toBe(leftBeforeResize);
  });
});

describe("ドラッグで動かす", () => {
  test("見出しをドラッグすると動き、指を離したときに 1 回だけ知らせる", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 10, 10);
    pointer(header, "pointermove", 40, 30);
    pointer(header, "pointermove", 60, 50);
    // 動かしている間は知らせない (保存を何度も走らせない)
    expect(onUserMove).not.toHaveBeenCalled();
    expect(frame.element.style.left).toBe("150px");
    expect(frame.element.style.top).toBe("140px");

    pointer(header, "pointerup", 60, 50);
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 150, top: 140, width: 400, height: 300 });
    expect(frame.rect()).toEqual({ left: 150, top: 140, width: 400, height: 300 });
  });

  test("見出しの中のボタンを押してドラッグしても動かない", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const button = document.createElement("button");
    headerOf(frame).append(button);

    pointer(button, "pointerdown", 10, 10);
    pointer(button, "pointermove", 60, 50);
    pointer(headerOf(frame), "pointermove", 60, 50);
    pointer(button, "pointerup", 60, 50);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("見出しの無い窓は、addDragHandle で登録した要素で動く", () => {
    const { frame, grip, onUserMove } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });

    drag(grip, 30, 20);

    expect(frame.rect()).toEqual({ left: 130, top: 120, width: 600 });
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 600 });
  });

  test("押して動かさずに離したら知らせない (クリックで「動かした窓」にしない)", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    drag(headerOf(frame), 0, 0);
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("主ボタン以外では動かない", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);
    pointer(header, "pointerdown", 100, 100, 2);
    pointer(header, "pointermove", 150, 150, 2);
    pointer(header, "pointerup", 150, 150, 2);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("pointercancel でもドラッグを終える", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 0, 0);
    pointer(header, "pointermove", 20, 10);
    pointer(header, "pointercancel", 20, 10);
    expect(onUserMove).toHaveBeenCalledTimes(1);

    // 終えた後の動きには付いていかない
    pointer(header, "pointermove", 200, 200);
    expect(frame.rect()).toEqual({ left: 120, top: 110, width: 400 });
  });

  test("捕捉が外れても (要素が DOM から外れるなど) そこまで動いた位置で確定する", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 0, 0);
    pointer(header, "pointermove", 20, 10);
    // pointerup は来ない (要素が外れたときなど)。lostpointercapture だけでも終える
    header.dispatchEvent(new Event("lostpointercapture", { bubbles: true }));
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(frame.rect()).toEqual({ left: 120, top: 110, width: 400 });

    // 終えた後の動きには付いていかない
    pointer(header, "pointermove", 200, 200);
    expect(frame.rect()).toEqual({ left: 120, top: 110, width: 400 });
  });

  test("同じ要素を addDragHandle で 2 回登録しても、2 重に反応しない", () => {
    const { frame, grip, onUserMove } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });
    frame.addDragHandle(grip);

    drag(grip, 30, 20);

    expect(frame.rect()).toEqual({ left: 130, top: 120, width: 600 });
    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  test("ドラッグを始めた指と違う pointerId の pointermove では動かない (2 本目の指に反応しない)", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 0, 0, 0, 1);
    // 別の指 (別の pointerId) の pointermove
    pointer(header, "pointermove", 20, 10, 0, 2);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });

    // 元の指なら動く
    pointer(header, "pointermove", 20, 10, 0, 1);
    pointer(header, "pointerup", 20, 10, 0, 1);
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(frame.rect()).toEqual({ left: 120, top: 110, width: 400 });
  });
});

describe("大きさを変える", () => {
  test("「幅と高さ」の窓は右下をドラッグすると幅と高さが変わる", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });

    drag(resizeGripOf(frame), 50, 40);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 450, height: 340 });
    expect(frame.element.style.width).toBe("450px");
    expect(frame.element.style.height).toBe("340px");
    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  test("高さを決めていない窓は、今の見た目の高さから広げる", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 400, 250));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 400, 32));

    drag(resizeGripOf(frame), 0, 30);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400, height: 280 });
  });

  test("高さを決めていない窓は、動かさずに押して離しただけでは高さが決まらない", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });

    // 移動量 0 の pointermove だけが来て離れる (クリックの取りこぼしなど)
    drag(resizeGripOf(frame), 0, 0);

    expect(frame.element.style.height).toBe("");
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("「幅だけ」の窓は高さが変わらない", () => {
    const { frame } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });

    drag(resizeGripOf(frame), 50, 40);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 650 });
    expect(frame.element.style.height).toBe("");
  });

  test("最小の大きさより小さくならない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    drag(resizeGripOf(frame), -1000, -1000);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("画面の大きさより大きくならない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    drag(resizeGripOf(frame), 5000, 5000);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 1024, height: 768 });
  });

  test("右下のつまみのカーソルは向きで変える (幅だけは ew-resize)", () => {
    expect(resizeGripOf(makeWindow().frame).style.cursor).toBe("nwse-resize");
    expect(resizeGripOf(makeBarLikeWindow().frame).style.cursor).toBe("ew-resize");
  });
});

describe("画面の中に詰める", () => {
  test("見出しは画面の外へ出しきれない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    // 見出しは窓の上端いっぱい (幅 400・高さ 32)
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 32));

    drag(headerOf(frame), 5000, 5000);
    // 1024 - 400、768 - 32
    expect(frame.rect()).toEqual({ left: 624, top: 736, width: 400 });

    drag(headerOf(frame), -5000, -5000);
    // 上は YouTube のヘッダー (56px) の下まで。裏に入ると見出しを押せない
    expect(frame.rect()).toEqual({ left: 0, top: 56, width: 400 });
  });

  test("見出しは窓の縁まで含めて数える (右端・上端に寄せても縁が画面の外へ出ない)", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    // 見出しは 1px の縁の内側 (左上から (1, 1)・幅 398・高さ 32)
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(101, 101, 398, 32));

    drag(headerOf(frame), 5000, 5000);
    // 右端は 1024 - 400 (縁の右端が画面の右端)、下は 768 - 33 (見出しの下端まで)
    expect(frame.rect()).toEqual({ left: 624, top: 735, width: 400 });

    drag(headerOf(frame), -5000, -5000);
    // 縁の左上も画面の外へ出さない。上は YouTube のヘッダー (56px) の下まで
    expect(frame.rect()).toEqual({ left: 0, top: 56, width: 400 });
  });

  test("つまみの窓は、つまみが画面に残るところまで出せる", () => {
    const { frame, grip } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });
    // つまみは窓の左上から (12, 54) にある 20x36 の箱
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 600, 106));
    vi.spyOn(grip, "getBoundingClientRect").mockReturnValue(boxAt(112, 154, 20, 36));

    drag(grip, 5000, 5000);
    // 1024 - 12 - 20、768 - 54 - 36
    expect(frame.rect()).toEqual({ left: 992, top: 678, width: 600 });

    drag(grip, -5000, -5000);
    // 窓の左上は画面の外へ出てよい。つまみは画面の中の、ヘッダー (56px) より下に残る (56 - 54)
    expect(frame.rect()).toEqual({ left: -12, top: 2, width: 600 });
  });

  test("ブラウザが小さくなったら詰め、大きく戻したら置いた場所に戻す", () => {
    const { frame } = makeWindow();
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 32));
    frame.place({ left: 600, top: 100, width: 400 });

    setViewport(900, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.rect()).toEqual({ left: 500, top: 100, width: 400 });

    setViewport(1024, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.rect()).toEqual({ left: 600, top: 100, width: 400 });
  });

  test("refit は詰めた後の位置ではなく置いた場所から詰め直す", () => {
    const { frame } = makeWindow();
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 32));
    frame.place({ left: 600, top: 100, width: 400 });

    setViewport(900, 768);
    window.dispatchEvent(new Event("resize"));
    frame.refit();
    expect(frame.rect()).toEqual({ left: 500, top: 100, width: 400 });

    setViewport(1024, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.rect()).toEqual({ left: 600, top: 100, width: 400 });
  });

  test("隠れている間に置いた窓は、出すときに掴む場所を測って詰め直す", () => {
    const frame = createFloatingWindow({
      id: "win-hidden",
      resize: "width",
      minWidth: 480,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    created.push(frame);
    document.body.append(frame.element);
    const grip = document.createElement("span");
    frame.body.append(grip);
    frame.addDragHandle(grip);
    // 隠れている間は寸法が 0 (実機の display:none と同じ)
    vi.spyOn(frame.element, "getBoundingClientRect").mockImplementation(() =>
      frame.element.hidden ? boxAt(0, 0, 0, 0) : boxAt(100, 100, 600, 106),
    );
    vi.spyOn(grip, "getBoundingClientRect").mockImplementation(() =>
      frame.element.hidden ? boxAt(0, 0, 0, 0) : boxAt(112, 154, 20, 36),
    );

    frame.place({ left: 1000, top: 700, width: 600 });
    // つまみを測れないので、窓の左上だけを画面に入れている
    expect(frame.rect()).toEqual({ left: 1000, top: 700, width: 600 });

    frame.setVisible(true);
    expect(frame.rect()).toEqual({ left: 992, top: 678, width: 600 });
  });
});

describe("重なり順とダブルクリック", () => {
  test("最後に触った窓が上に来る", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;

    pointer(a.body, "pointerdown", 0, 0);
    expect(a.element.style.zIndex).toBe("2001");
    expect(b.element.style.zIndex).toBe("2000");

    pointer(b.body, "pointerdown", 0, 0);
    expect(b.element.style.zIndex).toBe("2001");
    expect(a.element.style.zIndex).toBe("2000");
  });

  test("3 つの窓は触った順が新しいほど上 (2000 + 触った順)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    const zIndexes = () => [a, b, c].map((frame) => frame.element.style.zIndex);

    pointer(a.body, "pointerdown", 0, 0);
    pointer(b.body, "pointerdown", 0, 0);
    pointer(c.body, "pointerdown", 0, 0);
    expect(zIndexes()).toEqual(["2000", "2001", "2002"]);

    // a を触り直すと a がいちばん上。直前に触った c は、その前に触った b の上のまま
    // (「最後に触った窓だけ上げる」だと b と c が同じ値になり、DOM の順で c が潜りうる)
    pointer(a.body, "pointerdown", 0, 0);
    expect(zIndexes()).toEqual(["2002", "2000", "2001"]);
  });

  test("bringToFront で、押さずにいちばん上に出す", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    expect(a.element.style.zIndex).toBe("2001");

    b.bringToFront();

    expect(b.element.style.zIndex).toBe("2001");
    expect(a.element.style.zIndex).toBe("2000");
  });

  test("消した窓は重なり順から外す (残った窓の z-index が詰まる)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    pointer(b.body, "pointerdown", 0, 0);
    pointer(c.body, "pointerdown", 0, 0);

    c.destroy();
    a.bringToFront();

    expect(b.element.style.zIndex).toBe("2000");
    expect(a.element.style.zIndex).toBe("2001");
  });

  test("見出しのダブルクリックで onResetRequest を呼ぶ。見出しの中のボタンでは呼ばない", () => {
    const { frame, onResetRequest } = makeWindow();
    const button = document.createElement("button");
    headerOf(frame).append(button);

    dblclick(button);
    expect(onResetRequest).not.toHaveBeenCalled();

    dblclick(headerOf(frame));
    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });

  test("addDragHandle で登録した要素のダブルクリックでも onResetRequest を呼ぶ", () => {
    const { grip, onResetRequest } = makeBarLikeWindow();
    dblclick(grip);
    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });
});

describe("ページの中の枠に入れる (setDocked)", () => {
  test("setDocked(true) でページの流れの中の見た目になり、見出しと右下のつまみを隠す", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });

    frame.setDocked(true);

    expect(frame.element.style.position).toBe("static");
    expect(frame.element.style.width).toBe("100%");
    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.top).toBe("");
    expect(frame.element.style.height).toBe("");
    expect(frame.element.style.zIndex).toBe("auto");
    // 出ている窓は出たまま (出し入れは setVisible が持つ)
    expect(frame.element.style.display).toBe("flex");
    expect(headerOf(frame).style.display).toBe("none");
    expect(resizeGripOf(frame).hidden).toBe(true);
  });

  test("隠れている窓は、入れても隠れたまま", () => {
    const { frame } = makeWindow();
    frame.setVisible(false);
    frame.setDocked(true);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("ドック中の place は位置を当てず、求められた位置と大きさを覚える (rect はその値)", () => {
    const { frame } = makeWindow();
    frame.setDocked(true);

    frame.place({ left: 10, top: 60, width: 500, height: 200 });

    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.width).toBe("100%");
    expect(frame.rect()).toEqual({ left: 10, top: 60, width: 500, height: 200 });
  });

  test("ドック中は window の resize でも refit でも詰めない", () => {
    const { frame } = makeWindow();
    frame.setDocked(true);
    setViewport(300, 300);
    window.dispatchEvent(new Event("resize"));
    frame.refit();
    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.position).toBe("static");
  });

  test("setDocked(false) で浮いた窓に戻り、覚えた位置と大きさから詰めて置き、いちばん上に出す", () => {
    const other = makeWindow().frame;
    const { frame } = makeWindow();
    frame.setDocked(true);
    // 上端は 60 (fitRect は YouTube のヘッダーの下 56px より上へ詰めるので、詰められない値で測る)
    frame.place({ left: 10, top: 60, width: 500, height: 200 });
    pointer(other.body, "pointerdown", 0, 0);

    frame.setDocked(false);

    expect(frame.element.style.position).toBe("fixed");
    expect(styleOf(frame)).toEqual({ left: "10px", top: "60px", width: "500px", height: "200px" });
    expect(headerOf(frame).style.display).toBe("flex");
    expect(resizeGripOf(frame).hidden).toBe(false);
    expect(Number(frame.element.style.zIndex)).toBeGreaterThan(Number(other.element.style.zIndex));
  });

  test("ドック中の窓は重なり順に加わらない (押しても bringToFront でも、ほかの浮いた窓の順を変えない)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    c.setDocked(true);
    pointer(a.body, "pointerdown", 0, 0);
    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);

    pointer(c.body, "pointerdown", 0, 0);
    c.bringToFront();

    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);
    expect(c.element.style.zIndex).toBe("auto");
  });

  test("入れても出しても、窓に当てた配色の変数 (--ytc-*) は残す (消えると浮いた窓の地と縁が透ける)", () => {
    const { frame } = makeWindow();
    // youtube.ts の applyPalette と同じく、窓の要素の inline の custom property に配色を書く
    frame.element.style.setProperty("--ytc-panel", "#212121");
    frame.element.style.setProperty("--ytc-border", "#5a5a5a");

    frame.setDocked(true);
    expect(frame.element.style.getPropertyValue("--ytc-panel")).toBe("#212121");

    frame.setDocked(false);
    expect(frame.element.style.getPropertyValue("--ytc-panel")).toBe("#212121");
    expect(frame.element.style.getPropertyValue("--ytc-border")).toBe("#5a5a5a");
    expect(frame.element.style.position).toBe("fixed");
  });

  test("同じ値で呼んでも何もしない (浮いた窓に setDocked(false) で、重なり順を変えない)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    b.setDocked(false);
    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);
  });
});
