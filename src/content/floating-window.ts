import { FLOATING_WINDOW_STYLE } from "@/content/styles";
import { fitRect, type GripBox, type WindowRect } from "@/content/window-layout";

export type { WindowRect } from "@/content/window-layout";

/**
 * 画面の上に浮いた窓の枠 (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **枠だけを持つ**: 見出し・本体の箱・右下のつまみ・ドラッグで動かす・大きさを変える・
 * 画面の中に詰める・重なり順。中身と「いつ出すか・最初にどこへ置くか」は知らない
 * (side-panel.ts と youtube.ts が決める)。パネルの窓とバーの窓で同じ処理を 2 回書かないために
 * 1 つにしている
 */

/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は side-panel.ts の
 * 実測のコメント) より下**、ページ本体より上。2 つの窓が重なったら、最後に触った窓を 1 つ上げる
 * (spec A.1)
 */
const Z_BACK = 2000;
const Z_FRONT = 2001;
/**
 * 高さを決めていない「幅と高さ」の窓 (パネル) の下端と、画面の下端との間。右側パネルの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/** 今ある窓の枠。最後に触った窓を上げるとき、ほかの窓を下げるのに使う */
const liveWindows = new Set<HTMLElement>();

function bringToFront(target: HTMLElement): void {
  for (const element of liveWindows) {
    element.style.zIndex = String(element === target ? Z_FRONT : Z_BACK);
  }
}

/**
 * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (折り畳みの ▶ を
 * 押したら畳むだけ。spec A.1)
 */
function isOnControl(target: EventTarget | null, handle: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, input, textarea, select, a");
  return control !== null && handle.contains(control);
}

function sameRect(a: WindowRect, b: WindowRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export type FloatingWindow = {
  element: HTMLElement;
  /** 見出しの右側に置く部品 (折り畳みボタンなど) の箱。見出しの無い窓では null */
  headerActions: HTMLElement | null;
  /** この要素を押してドラッグすると窓が動く (中のボタンを押したときは動かさない) */
  addDragHandle(element: HTMLElement): void;
  /** 中身の箱。見た目 (余白・スクロール・出し入れ) は中身を入れる側が決める */
  body: HTMLElement;
  setVisible(visible: boolean): void;
  /** 位置と大きさを置く。画面に収まるよう詰める */
  place(rect: WindowRect): void;
  /** 今の位置と大きさ (詰めた後) */
  rect(): WindowRect;
  destroy(): void;
};

export type FloatingWindowOptions = {
  id: string;
  /** 見出しの文言。省くと見出しの行を作らない (バーの窓) */
  title?: string;
  resize: "width" | "both";
  minWidth: number;
  minHeight?: number;
  /** ユーザーがドラッグで動かした・大きさを変えたとき (指を離した時点で 1 回) */
  onUserMove(rect: WindowRect): void;
  /** 掴む場所 (addDragHandle で登録した要素) のダブルクリック */
  onResetRequest(): void;
};

export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindow {
  const element = document.createElement("div");
  element.id = options.id;
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BACK};`;

  let header: HTMLElement | null = null;
  let headerActions: HTMLElement | null = null;
  if (options.title !== undefined) {
    header = document.createElement("div");
    header.dataset.role = "window-header";
    header.style.cssText = FLOATING_WINDOW_STYLE.header;
    const title = document.createElement("span");
    title.style.cssText = FLOATING_WINDOW_STYLE.title;
    title.textContent = options.title;
    headerActions = document.createElement("div");
    headerActions.style.cssText = FLOATING_WINDOW_STYLE.headerActions;
    header.append(title, headerActions);
    element.append(header);
  }

  const body = document.createElement("div");
  const resizeGrip = document.createElement("div");
  resizeGrip.dataset.role = "window-resize";
  resizeGrip.title = options.resize === "width" ? "ドラッグで幅を変える" : "ドラッグで大きさを変える";
  // 幅だけの窓 (バー) は横向きのカーソル。高さは中身で決まり、変えられないことを見せる
  resizeGrip.style.cssText = `${FLOATING_WINDOW_STYLE.resizeGrip}cursor:${options.resize === "width" ? "ew-resize" : "nwse-resize"};`;
  element.append(body, resizeGrip);

  /** 掴む場所。後から登録したものほど新しい (バーのつまみは作り直すたびに登録し直される) */
  let handles: HTMLElement[] = [];
  /**
   * 最後に place で求められた位置と大きさ。**詰めた後の位置とは別に持つ。** ブラウザを
   * 小さくして詰めた窓は、大きく戻したときに置いた場所へ戻る
   */
  let requested: WindowRect = { left: 0, top: 0, width: options.minWidth };
  /** 今の位置と大きさ (画面に詰めた後) */
  let current: WindowRect = requested;

  /**
   * 掴む場所の箱 (窓の左上から)。登録した中で窓の中にある、いちばん新しいもの。
   * 隠れている窓では寸法が 0 になるので、出すときに測り直す (setVisible)
   */
  function gripBox(): GripBox {
    const handle = [...handles].reverse().find((candidate) => element.contains(candidate));
    if (handle === undefined) return { left: 0, top: 0, width: 0, height: 0 };
    const frame = element.getBoundingClientRect();
    const box = handle.getBoundingClientRect();
    return {
      left: box.left - frame.left,
      top: box.top - frame.top,
      width: box.width,
      height: box.height,
    };
  }

  /** 位置と大きさを画面に詰めて当てる */
  function apply(rect: WindowRect): void {
    // 幅だけの窓は高さを持たない (覚えた位置に高さが混ざっていても使わない)。高さは中身で決まる
    const source: WindowRect =
      options.resize === "width" ? { left: rect.left, top: rect.top, width: rect.width } : rect;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const fitted = fitRect(source, viewport, gripBox(), {
      minWidth: options.minWidth,
      minHeight: options.minHeight,
    });
    current = fitted;
    element.style.left = `${fitted.left}px`;
    element.style.top = `${fitted.top}px`;
    element.style.width = `${fitted.width}px`;
    // 本体を隠した (畳んだ) 窓は見出しだけにする。高さを残すと空の枠が残る
    const bodyShown = !body.hidden;
    if (fitted.height !== undefined && bodyShown) {
      element.style.height = `${fitted.height}px`;
      element.style.maxHeight = "";
    } else {
      element.style.height = "";
      // 高さを決めていない「幅と高さ」の窓は中身の高さまで伸び、画面の下端から
      // BOTTOM_GAP_PX で止まる。超えた分は本体の中でスクロールする (右側パネルと同じ)。
      // 下へ動かした窓でも最小の高さは残す (0 に潰れて中身が見えなくならないように)
      element.style.maxHeight =
        options.resize === "both"
          ? `${Math.max(options.minHeight ?? 0, viewport.height - fitted.top - BOTTOM_GAP_PX)}px`
          : "";
    }
    resizeGrip.hidden = !bodyShown;
    resizeGrip.style.display = bodyShown ? "block" : "none";
  }

  /**
   * ドラッグを始める。**Pointer Events と捕捉を使う** (spec A.3)。捕捉すると、指が窓の外へ
   * 出ても pointermove が掴んだ要素に届き続ける
   */
  function beginDrag(source: HTMLElement, kind: "move" | "resize", event: PointerEvent): void {
    // 主ボタン以外 (右クリックのメニューなど) では動かさない
    if (event.button !== 0) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = current;
    // 高さを決めていない窓を縦に広げるときは、今の見た目の高さから始める
    const startHeight = start.height ?? element.getBoundingClientRect().height;
    source.setPointerCapture(event.pointerId);

    /** ドラッグを終わらせる。捕捉とリスナをまとめて解く (range-bar.ts の拡大バーと同じ作法) */
    const finish = (pointerId: number): void => {
      source.releasePointerCapture(pointerId);
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointerup", onUp);
      source.removeEventListener("pointercancel", onUp);
    };

    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (kind === "move") {
        apply({ ...start, left: start.left + dx, top: start.top + dy });
      } else if (options.resize === "both") {
        apply({ ...start, width: start.width + dx, height: startHeight + dy });
      } else {
        apply({ ...start, width: start.width + dx });
      }
    };

    // pointercancel (タッチの横取りなど) でも終える。そこまでに動かした位置は、画面に
    // 出ているとおりに確定する (拡大バーのハンドルと同じ)
    const onUp = (up: PointerEvent): void => {
      finish(up.pointerId);
      requested = current;
      // 押して離しただけ (クリックやダブルクリックの 1 回目) は知らせない。知らせると
      // 「動かした窓」になり、最初の位置を取り直さなくなる
      if (sameRect(start, current)) return;
      options.onUserMove({ ...current });
    };

    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onUp);
    source.addEventListener("pointercancel", onUp);
  }

  function addDragHandle(handle: HTMLElement): void {
    // 窓から外れた古い掴む場所 (作り直したバーの前のつまみ) は捨てる。持ち続けると溜まる
    handles = handles.filter((candidate) => element.contains(candidate));
    handles.push(handle);
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (isOnControl(event.target, handle)) return;
      beginDrag(handle, "move", event);
    });
    // 掴む場所のダブルクリックで最初の位置に戻す (spec A.2)。中のボタンの連打では戻さない
    handle.addEventListener("dblclick", (event: MouseEvent) => {
      if (isOnControl(event.target, handle)) return;
      options.onResetRequest();
    });
  }

  // 窓のどこを押しても、その窓を上にする (最後に触った窓が上。spec A.1)。捕捉の段階で
  // 拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため
  element.addEventListener("pointerdown", () => bringToFront(element), true);
  resizeGrip.addEventListener("pointerdown", (event: PointerEvent) => {
    beginDrag(resizeGrip, "resize", event);
  });
  if (header !== null) addDragHandle(header);

  /**
   * ブラウザの大きさが変わったら、掴む場所が画面に残るよう詰め直す。**詰めた後の位置ではなく
   * 置いた場所 (requested) から詰める** (小さくしてから戻すと、置いた場所に戻る)
   */
  const onResize = (): void => apply(requested);
  window.addEventListener("resize", onResize);
  liveWindows.add(element);

  apply(requested);
  // 中身が入り、出す判断がされるまでは出さない。空の枠だけを出さない
  element.hidden = true;
  element.style.display = "none";

  return {
    element,
    headerActions,
    body,
    addDragHandle,

    setVisible(visible: boolean): void {
      const wasHidden = element.hidden;
      // 出し入れは hidden と style.display の両方で行う。root は flex で並べるので display を
      // 持ち、inline の display は UA の [hidden] { display: none } に勝つ。hidden は外から
      // 「出ているか」を読むために残す
      element.hidden = !visible;
      element.style.display = visible ? "flex" : "none";
      // 隠れている間は掴む場所の寸法が 0 で、詰め方を測れていない。出した直後に詰め直す。
      // **出ている間は置き直さない** (ドラッグ中に状態の通知で呼ばれても、指の下の窓を戻さない)
      if (visible && wasHidden) apply(requested);
    },

    place(rect: WindowRect): void {
      requested = { ...rect };
      apply(requested);
    },

    rect(): WindowRect {
      return { ...current };
    },

    destroy(): void {
      window.removeEventListener("resize", onResize);
      liveWindows.delete(element);
      element.remove();
    },
  };
}
