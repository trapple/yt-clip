import { FLOATING_WINDOW_STYLE } from "@/content/styles";
import { fitRect, type GripBox, type WindowRect } from "@/content/window-layout";

export type { WindowRect } from "@/content/window-layout";

/**
 * 画面の上に浮いた窓の枠 (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **枠だけを持つ**: 見出し・本体の箱・右下のつまみ・ドラッグで動かす・大きさを変える・
 * 画面の中に詰める・重なり順・ページの中の枠に入っている間の見た目 (`setDocked`。
 * `.claude/specs/2026-09-25-dockable-windows-design.md` C2.8)。ドラッグ中は指の位置を `onDragPoint` で
 * 外へ知らせ (落とし先の当たり判定は dock.ts が持つ)、窓の外の要素 (タブ) で始まったドラッグは
 * `beginMoveFrom` で窓の移動として続ける (C2.8)。中身と「いつ出すか・最初にどこへ置くか・
 * どの枠に入れるか」は知らない (panel-window.ts・dock.ts・youtube.ts が決める)。3 つの窓で同じ処理を
 * 何度も書かないために 1 つにしている
 */

/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は panel-window.ts の
 * 実測のコメント) より下**、ページ本体より上。窓が重なったら、**触った順が新しいほど上**
 * (Z_BASE + 触った順。窓は 3 つなので最大 2002。窓の分割の spec C1.1)。
 * 「最後に触った窓だけ 1 つ上げ、残りは同じ値」にしない: 窓が 3 つになると残り 2 つの順が
 * DOM の順で決まり、直前に触った窓がその前に触った窓の下に潜る
 */
const Z_BASE = 2000;
/**
 * 高さを決めていない「幅と高さ」の窓 (区間・テロップの窓・設定の窓) の下端と、画面の下端との間。右側パネルだったときの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/**
 * 今ある浮いた窓の枠を、下から上への順に並べたもの (末尾がいちばん上)。作った窓は**いちばん下**に
 * 入れる。まだ触っていない窓が、触った窓の上に出ないように。**ページの中の枠に入っている窓は外す** (setDocked)
 */
let stack: HTMLElement[] = [];

/**
 * target をいちばん上にし、すべての窓の z-index を並びどおりに振り直す。**毎回全部を振り直す。**
 * 上げた窓だけに値を足していくと、触るたびに値が伸びて YouTube のヘッダー (2020) を越える
 */
function raise(target: HTMLElement): void {
  stack = [...stack.filter((element) => element !== target), target];
  stack.forEach((element, index) => {
    element.style.zIndex = String(Z_BASE + index);
  });
}

/**
 * ドック中の掴む場所 (バーの ⠿。dock.ts のタブも同じ値を使う) を、これだけ動かしたら枠から引き出す (C2.4)。
 * テロップの帯の「押して離した」の 4px (telop-track.ts の TELOP_CLICK_SLOP_PX) より大きくし、タブを押すつもりの
 * 指の震えで抜けないようにする
 */
export const UNDOCK_THRESHOLD_PX = 8;

/** 画面 (viewport) の座標の点。ドラッグの指の位置 */
export type DragPoint = { x: number; y: number };
/** 窓を動かすドラッグの段階 (落とし先の当たり判定へ知らせる。C2.3) */
export type DragPhase = "start" | "move" | "end";

/**
 * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (バーの操作の行のボタンを
 * 押したら、そのボタンの操作だけ。spec A.1)
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
  /** この要素を押してドラッグすると窓が動く (中のボタンを押したときは動かさない) */
  addDragHandle(element: HTMLElement): void;
  /** 中身の箱。見た目 (余白・スクロール・出し入れ) は中身を入れる側が決める */
  body: HTMLElement;
  setVisible(visible: boolean): void;
  /** 位置と大きさを置く。画面に収まるよう詰める。**ページの中の枠に入っている間は当てずに覚えるだけ** */
  place(rect: WindowRect): void;
  /** 今の位置と大きさ (詰めた後)。枠に入っている間は、最後に place で求められた位置と大きさ */
  rect(): WindowRect;
  /**
   * 最後に place (またはドラッグ) で置いた位置と大きさから、画面に詰め直す (テロップの帯の段が出る・消えて窓の
   * 高さが変わったとき)。place(rect()) で代えない: 詰めた後の位置で置いた場所を上書きし、ブラウザを大きく戻しても
   * 戻らない
   */
  refit(): void;
  /**
   * この窓をいちばん上に出す (窓のどこかを押したときと同じ)。押していないのに前に出したいとき
   * (⚙ で設定の窓を開いたとき) に youtube.ts が呼ぶ。枠に入っている間は何もしない
   */
  bringToFront(): void;
  /**
   * ページの中の枠に入れる (true) / 出す (false) (C2.8)。入れている間は `position: static`・幅いっぱい・影なしで
   * ページの流れに任せ、見出しの行 (文言はタブが持つ) と右下のつまみ (大きさは枠が決める) を隠し、重なり順にも
   * 加わらない。place / refit / resize では位置を当てず、求められた位置と大きさ (requested) だけを覚える。
   * 出すと浮いた窓の見た目に戻り、requested から詰めて置き、いちばん上に出す (引き出した窓はいま触っている窓)。
   * **枠のどこに置くか (DOM の親) は dock.ts が決める**
   */
  setDocked(docked: boolean): void;
  /**
   * 窓の外の要素 (dock.ts のタブ) で始まったドラッグを、窓の移動として続ける (C2.8)。捕捉と listener は source に
   * 付ける。event はその時点の pointermove、origin はドラッグの開始点 (タブを押した点。落とし先の距離の起点。C2.3)。
   * **浮いた窓でだけ呼ぶ** (枠に入っている間は throw。先に setDocked(false) で引き出す)。この続きのドラッグは、
   * 動かさずに離しても置いた場所を onUserMove で知らせる (引き出した窓を「動かしていない窓」にしない)。
   * **source を document に残すのは呼ぶ側の責任**: source が外れる (document から切り離される) と
   * Pointer Events の捕捉が解けて `lostpointercapture` が届き、ドラッグはその時点で終わる
   * (whole-branch review M1。C2.4 の「掴んだタブの要素だけは指を離すまで DOM に残す」も同じ理由)
   */
  beginMoveFrom(source: HTMLElement, event: PointerEvent, origin: DragPoint): void;
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
  /**
   * 窓を動かすドラッグの指の位置 (C2.3)。**落とし先の当たり判定は dock.ts が持つ** (窓の枠は枠を知らない)。
   * start は動かし始めたとき (押して離しただけでは呼ばない) に開始点で、move は動くたびに、end は**終わったとき**
   * (指を離した・pointercancel・lostpointercapture。終わり方は区別しない。取り消しでも画面に出ている状態で確定する
   * 既存方針と揃える。whole-branch review M2) に呼ぶ。end で true を返したら (枠に引き取った) onUserMove を呼ばない
   */
  onDragPoint?(phase: DragPhase, point: DragPoint): boolean;
  /**
   * 枠に入っている間に、掴む場所 (バーの ⠿) を UNDOCK_THRESHOLD_PX 動かした (C2.8)。grab は窓の左上から見た押した点。
   * 呼ばれた側が窓を枠から出し (setDocked(false))、指の下に place する。その後のドラッグはこの窓が続ける
   */
  onUndockRequest?(point: DragPoint, grab: DragPoint): void;
};

export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindow {
  const element = document.createElement("div");
  element.id = options.id;
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BASE};`;

  let header: HTMLElement | null = null;
  if (options.title !== undefined) {
    header = document.createElement("div");
    header.dataset.role = "window-header";
    header.style.cssText = FLOATING_WINDOW_STYLE.header;
    const title = document.createElement("span");
    title.style.cssText = FLOATING_WINDOW_STYLE.title;
    title.textContent = options.title;
    header.append(title);
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
   * ページの中の枠に入っているか (C2.8)。入っている間は位置を当てず (ページの流れが決める)、requested だけを覚える
   * (引き出したときの大きさを youtube.ts が覚えた float から決めるので、ここの値は使われなくてもよい)
   */
  let docked = false;

  /**
   * 掴む場所の箱 (窓の左上から)。登録した中で窓の中にある、いちばん新しいもの。
   * 隠れている窓では寸法が 0 になるので、出すときに測り直す (setVisible)
   */
  function gripBox(): GripBox {
    const handle = [...handles].reverse().find((candidate) => element.contains(candidate));
    if (handle === undefined) return { left: 0, top: 0, width: 0, height: 0 };
    const frame = element.getBoundingClientRect();
    const box = handle.getBoundingClientRect();
    // **見出しは窓の縁 (1px) まで含めて数える。** 見出しは窓の幅いっぱいで縁の内側にあるので、
    // 見出しの箱のままだと右端・上端に寄せたときに縁が 1px 画面の外へ出る (spec A.1)。
    // バーのつまみは窓の中の小さな箱なので、そのまま測る (縁まで広げると窓全体が掴む場所になる)
    if (handle === header) {
      return { left: 0, top: 0, width: frame.width, height: box.bottom - frame.top };
    }
    return {
      left: box.left - frame.left,
      top: box.top - frame.top,
      width: box.width,
      height: box.height,
    };
  }

  /**
   * 見た目 (cssText) を丸ごと置き換える。**配色の変数 (`--ytc-*`) は残す**: youtube.ts の applyPalette は同じ要素の inline の
   * custom property に配色を書くので、cssText の置き換えで消えると `var(--ytc-panel)` などが解決できず、枠から引き出した・
   * 退避した浮いた窓の地が透け、縁も消える (テーマを切り替えるまで戻らない)。`--` で始まる inline のプロパティを拾って戻す
   */
  function replaceStyle(cssText: string): void {
    const custom: [string, string][] = [];
    for (let index = 0; index < element.style.length; index += 1) {
      const name = element.style.item(index);
      if (name.startsWith("--")) custom.push([name, element.style.getPropertyValue(name)]);
    }
    element.style.cssText = cssText;
    for (const [name, value] of custom) element.style.setProperty(name, value);
  }

  /** 位置と大きさを画面に詰めて当てる。**枠に入っている間は呼ばない** (呼ぶ側が docked を見る) */
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
    if (fitted.height !== undefined) {
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
  }

  /**
   * ドラッグを始める。**Pointer Events と捕捉を使う** (spec A.3)。捕捉すると、指が窓の外へ
   * 出ても pointermove が掴んだ要素に届き続ける。
   *
   * 窓を動かすドラッグ (move) は、動かし始めてから指を離すまで onDragPoint で落とし先の当たり判定へ指の位置を
   * 知らせる (C2.3)。`continued` は窓の外の要素 (タブ) で始まったドラッグの続き (beginMoveFrom) の開始点
   */
  function beginDrag(
    source: HTMLElement,
    kind: "move" | "resize",
    event: PointerEvent,
    continued: DragPoint | null = null,
  ): void {
    // 主ボタン以外 (右クリックのメニューなど) では動かさない。続き (タブから引き出した後) は pointermove から
    // 始まり、button は -1 (押しているボタンが変わっていない) なので見ない
    if (continued === null && event.button !== 0) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();
    // このドラッグを起こした指だけを追う。**違う pointerId の move / up / cancel は無視する**
    // (2 本目の指が同じ要素に触れても、こちらの位置を横から書き換えない)
    const pointerId = event.pointerId;
    /** ドラッグの開始点。落とし先に当てる距離 (C2.3) と、枠からの引き出し (C2.8) の起点 */
    const origin: DragPoint = continued ?? { x: event.clientX, y: event.clientY };
    /** 窓の動きを測る基準の点。枠から引き出したら、その時点の指の位置に取り直す */
    let baseX = event.clientX;
    let baseY = event.clientY;
    let start = current;
    // 高さを決めていない窓を縦に広げるときは、今の見た目の高さから始める
    const startHeight = start.height ?? element.getBoundingClientRect().height;
    /**
     * 枠に入っている窓の掴む場所 (バーの ⠿) から始めたか。UNDOCK_THRESHOLD_PX 動くまで窓を動かさず、動いたら
     * onUndockRequest で枠から引き出してもらう (C2.8)
     */
    let pendingUndock = kind === "move" && docked;
    const frame = pendingUndock ? element.getBoundingClientRect() : null;
    /** 窓の左上から見た押した点 (引き出した窓を、⠿ が指の下に残るよう置くため) */
    const grab: DragPoint =
      frame === null ? { x: 0, y: 0 } : { x: origin.x - frame.left, y: origin.y - frame.top };
    /**
     * 枠から引き出した窓か。引き出した後は、動かさずに離しても置いた場所を知らせる (知らせないと float に位置が
     * 入らず「動かしていない窓」になり、次の resize で最初の位置へ跳ぶ)
     */
    let undocked = continued !== null;
    /** 落とし先へ知らせているか。押して動かさずに離した (クリック) ときは知らせない (C2.3) */
    let reporting = false;
    let last: DragPoint = { x: event.clientX, y: event.clientY };
    source.setPointerCapture(pointerId);

    const report = (phase: DragPhase, point: DragPoint): boolean =>
      options.onDragPoint?.(phase, point) === true;
    const startReporting = (): void => {
      reporting = true;
      report("start", origin);
    };
    // タブから引き出した続きは、もう動いている。開始点と今の点をすぐ知らせる
    if (continued !== null && kind === "move") {
      startReporting();
      report("move", last);
    }

    /** ドラッグを終わらせる。捕捉とリスナをまとめて解く (range-bar.ts の拡大バーと同じ作法) */
    const finish = (): void => {
      source.releasePointerCapture(pointerId);
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointerup", onSettle);
      source.removeEventListener("pointercancel", onSettle);
      source.removeEventListener("lostpointercapture", onSettle);
    };

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      last = { x: move.clientX, y: move.clientY };
      if (pendingUndock) {
        // 押すつもりの指の震えでは抜けない
        if (Math.hypot(last.x - origin.x, last.y - origin.y) < UNDOCK_THRESHOLD_PX) return;
        pendingUndock = false;
        options.onUndockRequest?.(last, grab);
        // 引き取られなかった (枠から出されなかった) ら、ここで終える。枠の中の窓は動かさない
        if (docked) {
          finish();
          return;
        }
        // 窓は枠から body へ移った。掴む場所ごと移したので捕捉が外れうる。付け直す (C2.8)
        source.setPointerCapture(pointerId);
        undocked = true;
        start = current;
        baseX = last.x;
        baseY = last.y;
        startReporting();
        report("move", last);
        return;
      }
      const dx = last.x - baseX;
      const dy = last.y - baseY;
      if (kind === "move") {
        if (!reporting && (dx !== 0 || dy !== 0)) startReporting();
        apply({ ...start, left: start.left + dx, top: start.top + dy });
        if (reporting) report("move", last);
      } else if (options.resize === "both") {
        // 高さを決めていない窓は、実際に縦へ動いた (dy !== 0) ときだけ高さを持たせる。
        // 移動量 0 の pointermove (押して動かさずに離す) だけで height が入ると、元は
        // undefined だった height が定義された値になり、sameRect が false になって
        // クリックしただけで onUserMove が呼ばれてしまう
        apply(
          start.height !== undefined || dy !== 0
            ? { ...start, width: start.width + dx, height: startHeight + dy }
            : { ...start, width: start.width + dx },
        );
      } else {
        apply({ ...start, width: start.width + dx });
      }
    };

    // pointercancel (タッチの横取りなど)・lostpointercapture (要素が DOM から外れる、
    // ほかが捕捉を奪うなど) でも終える。pointerup が来ないままドラッグが宙に浮くのを防ぐ。
    // そこまでに動かした位置は、画面に出ているとおりに確定する (拡大バーのハンドルと同じ)
    const onSettle = (settled: Event): void => {
      const settledPointerId = (settled as PointerEvent).pointerId;
      // lostpointercapture は座標を持たない。current (最後の pointermove で反映済み) を使う
      if (settledPointerId !== undefined && settledPointerId !== pointerId) return;
      // 枠から引き出すときに掴む場所ごと body へ移すと、古い捕捉が外れた知らせが後から届く。付け直した
      // 捕捉が生きていれば、ドラッグは続いている
      if (settled.type === "lostpointercapture" && source.hasPointerCapture?.(pointerId) === true) {
        return;
      }
      finish();
      // 枠に入ったまま押して離しただけ (引き出すほど動かさなかった)。何も変えない
      if (pendingUndock) return;
      requested = current;
      // 落とし先の枠に引き取られた。浮いた窓の位置は変えない (C2.3)
      if (reporting && report("end", last)) return;
      // 押して離しただけ (クリックやダブルクリックの 1 回目) は知らせない。知らせると
      // 「動かした窓」になり、最初の位置を取り直さなくなる。引き出した窓は知らせる (undocked の doc)
      if (!undocked && sameRect(start, current)) return;
      options.onUserMove({ ...current });
    };

    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onSettle);
    source.addEventListener("pointercancel", onSettle);
    source.addEventListener("lostpointercapture", onSettle);
  }

  function addDragHandle(handle: HTMLElement): void {
    // 窓から外れた古い掴む場所 (作り直したバーの前のつまみ) は捨てる。持ち続けると溜まる
    handles = handles.filter((candidate) => element.contains(candidate));
    // 同じ要素を 2 回登録しない。listener を重ねて足すと、1 回のドラッグに 2 重に反応する
    if (handles.includes(handle)) return;
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

  // 窓のどこを押しても、その窓を上にする (触った順が新しいほど上。窓の分割の spec C1.1)。捕捉の
  // 段階で拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため。
  // **枠に入っている窓は重なり順に加わらない** (押しても、ほかの浮いた窓の順を変えない。C2.8)
  element.addEventListener(
    "pointerdown",
    () => {
      if (!docked) raise(element);
    },
    true,
  );
  resizeGrip.addEventListener("pointerdown", (event: PointerEvent) => {
    beginDrag(resizeGrip, "resize", event);
  });
  if (header !== null) addDragHandle(header);

  /**
   * ブラウザの大きさが変わったら、掴む場所が画面に残るよう詰め直す。**詰めた後の位置ではなく
   * 置いた場所 (requested) から詰める** (小さくしてから戻すと、置いた場所に戻る)。枠に入っている間は
   * ページの流れが決めるので詰めない
   */
  const onResize = (): void => {
    if (!docked) apply(requested);
  };
  window.addEventListener("resize", onResize);
  stack = [element, ...stack];

  apply(requested);
  // 中身が入り、出す判断がされるまでは出さない。空の枠だけを出さない
  element.hidden = true;
  element.style.display = "none";

  return {
    element,
    body,
    addDragHandle,

    setVisible(visible: boolean): void {
      const wasHidden = element.hidden;
      // 出し入れは hidden と style.display の両方で行う。root は flex で並べるので display を
      // 持ち、inline の display は UA の [hidden] { display: none } に勝つ。hidden は外から
      // 「出ているか」を読むために残す (dock.ts もタブを出すかをこれで決める)
      element.hidden = !visible;
      element.style.display = visible ? "flex" : "none";
      // 隠れている間は掴む場所の寸法が 0 で、詰め方を測れていない。出した直後に詰め直す。
      // **出ている間は置き直さない** (ドラッグ中に状態の通知で呼ばれても、指の下の窓を戻さない)。
      // 枠に入っている間は位置を当てない
      if (visible && wasHidden && !docked) apply(requested);
    },

    place(rect: WindowRect): void {
      requested = { ...rect };
      // 枠に入っている間は覚えるだけ。位置はページの流れが決める
      if (!docked) apply(requested);
    },

    rect(): WindowRect {
      // 枠に入っている間は画面の位置を持たない。覚えている (求められた) 位置と大きさを返す
      return docked ? { ...requested } : { ...current };
    },

    refit(): void {
      if (!docked) apply(requested);
    },

    bringToFront(): void {
      if (!docked) raise(element);
    },

    setDocked(next: boolean): void {
      if (next === docked) return;
      docked = next;
      // cssText を置き換えると出し入れ (setVisible) の display も消えるので、今の出し入れを当て直す
      const display = element.hidden ? "none" : "flex";
      if (docked) {
        // 重なり順から外す。ページの流れの中の要素に z-index は効かず、押してもほかの浮いた窓の順を変えない
        stack = stack.filter((candidate) => candidate !== element);
        replaceStyle(FLOATING_WINDOW_STYLE.docked);
      } else {
        replaceStyle(FLOATING_WINDOW_STYLE.root);
        // 引き出した窓はいま触っている窓なので、いちばん上に出す (z-index もここで当て直す)
        raise(element);
      }
      element.style.display = display;
      // 見出しの文言はタブが持ち、大きさは枠が決める (C2.8)
      if (header !== null) header.style.display = docked ? "none" : "flex";
      resizeGrip.hidden = docked;
      resizeGrip.style.display = docked ? "none" : "";
      if (!docked) apply(requested);
    },

    beginMoveFrom(source: HTMLElement, event: PointerEvent, origin: DragPoint): void {
      // 枠の中のまま動かす経路は無い (位置はページの流れが決める)。先に setDocked(false) で引き出す。配線の誤り
      if (docked) throw new Error("[yt-clip] 枠に入っている窓は beginMoveFrom で動かせません");
      beginDrag(source, "move", event, origin);
    },

    destroy(): void {
      window.removeEventListener("resize", onResize);
      stack = stack.filter((candidate) => candidate !== element);
      element.remove();
    },
  };
}
