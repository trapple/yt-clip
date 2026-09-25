import type { DragPoint, FloatingWindow } from "@/content/floating-window";
import { DOCK_STYLE } from "@/content/styles";
import {
  DOCK_SLOT_IDS,
  type DockSlotId,
  type DockState,
  type WindowId,
} from "@/content/window-layout";

export type { DockSlotId, DockState } from "@/content/window-layout";

/**
 * ページの中のドック枠 2 か所とタブ (`.claude/specs/2026-09-25-dockable-windows-design.md` C2)。
 * 下の枠 (#yt-clip-dock-below) は #below の先頭、右の枠 (#yt-clip-dock-side) は #secondary-inner の先頭に差し、
 * ページと一緒にスクロールする。
 *
 * 枠 (根・タブの列・窓の置き場)、入れる / 出す / 前に出す、差し直し、退避、保存用の形を持つ。**窓の中身と、
 * 窓を出す条件は知らない** (youtube.ts が決め、窓の `hidden` として見える)。浮いた窓の位置も知らない: 退避した窓は
 * onEvacuate、引き出した窓は onUndock で youtube.ts が置く
 */

/**
 * 下の枠の上の余白の補正 (px。負で詰める)。1440x795 でバーだけを下の枠に入れたとき、枠の外形が画面に収まる予算は
 * 795 − 628 (プレイヤーの下端の実測) = 167px、バーの窓は約 140px (C2.10)。#below の上の余白が 27px を超えると収まらない
 * ので、そのときは実測に合わせてここを負にする (YouTube の余白を枠の margin-top で相殺する)
 */
export const BELOW_SLOT_MARGIN_TOP_PX = 0;
/**
 * 窓が見えている枠の下の余白 (動画のタイトル・おすすめ動画との間)。**目印だけの間 (ドラッグ中の空の枠) は 0** にして、
 * 下の内容が目印の高さ (40px) だけ下がるようにする (C2.3)
 */
export const DOCK_SLOT_GAP_PX = 12;

export type DockManager = {
  /** 2 つの枠の根。配色 (applyPalette) を当てるために見せる */
  elements: Record<DockSlotId, HTMLElement>;
  /**
   * 枠を差す先に付け直す (mount・resize のたび)。差す先の中に無ければ先頭に差す。差す先が無い・幅 0 の枠は
   * 使えない (isUsable が false。中の窓は次の sync で退避)。**使えるかが変わったら true** (呼び出し側が窓を出し直す)
   */
  attach(anchors: Record<DockSlotId, Element | null>): boolean;
  isUsable(slot: DockSlotId): boolean;
  /** 覚えた枠の中身を入れる (読み込みの 1 回)。**onChange を呼ばない** (読み込みは書かない)。置くのは次の sync */
  load(state: DockState): void;
  /** 枠の末尾に入れて前に出す (C2.3)。入れられない組み合わせは throw (配線の誤り) */
  dock(id: WindowId, slot: DockSlotId): void;
  /** 枠から出して body へ戻し、浮いた窓にする。どこに置くかは呼び出し側が決める */
  undock(id: WindowId): void;
  /**
   * 最初の配置へ戻す (ダブルクリック。C2.6): options.initial で入る枠へ、最初の配置の並びの位置に入れて前に出し、onChange。
   * 既にその枠にあれば並びは変えず前に出すだけ。最初の配置で枠に入らない窓なら undock。戻す先の枠が使えなければ、記憶に
   * 入れたまま退避 (onEvacuate)
   */
  restore(id: WindowId): void;
  /** その窓のタブを前に出す。枠に入っていなければ何もしない */
  activate(id: WindowId): void;
  /** 入っている枠 (使えない枠で退避中も含む)。入っていなければ null */
  slotOf(id: WindowId): DockSlotId | null;
  /** 窓の出す条件 (hidden) が変わった後に呼ぶ。窓の置き場・タブ・枠の出し入れ・退避を合わせる */
  sync(): void;
  /** 保存用の形 (写し) */
  state(): DockState;
  destroy(): void;
};

export type DockManagerOptions = {
  windows: Record<WindowId, FloatingWindow>;
  /** タブの文言 (窓の見出しと同じ。バーは見出しを作らないので「バー」) */
  titles: Record<WindowId, string>;
  /** 最初の配置 (window-layout.ts の initialDocks)。restore の戻し先と並び順 */
  initial: DockState;
  accepts(id: WindowId, slot: DockSlotId): boolean;
  /**
   * タブを掴んで UNDOCK_THRESHOLD_PX 動かした (C2.4)。窓はもう枠から出て body にある。呼ばれた側は窓を指の下に置く
   * (grab はタブの左上から見た押した点)。その後のドラッグの続きは dock.ts が窓の beginMoveFrom で始める
   */
  onUndock(id: WindowId, point: DragPoint, grab: DragPoint): void;
  /** タブのダブルクリック (最初の位置に戻す。C2.6) */
  onTabDoubleClick(id: WindowId): void;
  /**
   * 入っている枠が使えなくなったので、窓を body へ移して浮かせた (退避。C2.1)。呼ばれた側は最初の位置に置く。
   * ドックの記憶 (tabs) は消さない。退避している間は 1 回だけ呼ぶ
   */
  onEvacuate(id: WindowId): void;
  /** 入れた・出した・前に出した (ユーザーの操作。保存の合図) */
  onChange(state: DockState): void;
};

type Slot = {
  id: DockSlotId;
  root: HTMLElement;
  /** 隠れている枠・バーだけの枠の落とし先 (高さ 40px の点線の箱。C2.3)。ドラッグの間だけ出す */
  marker: HTMLElement;
  tabRow: HTMLElement;
  /** 窓の置き場。窓ごとの箱 (pane) を並べ、前のタブの箱だけを出す */
  content: HTMLElement;
  /** 入っている窓 (タブの並び。前から = 入れた順) */
  tabs: WindowId[];
  /**
   * ユーザーが前に出したタブ。**見えていなければ、見えているタブの先頭を出す (この値は変えない)**。窓が隠れた
   * だけで書き換えると、読み込み直後や一覧が 0 個になっただけで保存が走る
   */
  active: WindowId | undefined;
  /** 差す先があり、幅があるか (attach で測る) */
  usable: boolean;
};

function createSlot(id: DockSlotId): Slot {
  const root = document.createElement("div");
  root.id = `yt-clip-dock-${id}`;
  root.style.cssText = DOCK_STYLE.root;
  root.style.display = "none";
  const marker = document.createElement("div");
  marker.dataset.role = "dock-marker";
  marker.style.cssText = DOCK_STYLE.marker;
  marker.textContent = "ここにドック";
  marker.style.display = "none";
  const tabRow = document.createElement("div");
  tabRow.dataset.role = "dock-tabs";
  tabRow.style.cssText = DOCK_STYLE.tabRow;
  tabRow.style.display = "none";
  const content = document.createElement("div");
  content.dataset.role = "dock-content";
  // 目印は枠の先頭 (C2.3: 帯は枠の上の段だけ)。タブの列 → 置き場の順
  root.append(marker, tabRow, content);
  return { id, root, marker, tabRow, content, tabs: [], active: undefined, usable: false };
}

export function createDockManager(options: DockManagerOptions): DockManager {
  const slots: Record<DockSlotId, Slot> = { below: createSlot("below"), side: createSlot("side") };
  const allSlots: Slot[] = DOCK_SLOT_IDS.map((id) => slots[id]);
  /**
   * 窓ごとの箱 (枠の置き場の中)。前のタブかどうかはこの箱の display で切り替える。**窓の要素の display は
   * youtube.ts の setVisible (出す条件) が持つ** ので、2 つの軸が同じ style.display を取り合わない (C2.8)
   */
  const panes = new Map<WindowId, HTMLElement>();
  /**
   * 窓ごとのタブ。**描き直しても作り直さない** (押している最中に状態の通知で sync が走ってタブを作り直すと、
   * 捕捉が外れて押したことが消える)。描き直すのは並びと見た目だけ
   */
  const tabElements = new Map<WindowId, HTMLElement>();
  /** 入っている枠が使えないため、浮いた窓で出している窓 (退避。C2.1)。onEvacuate を 2 度呼ばないため */
  const evacuated = new Set<WindowId>();

  function findSlot(id: WindowId): Slot | null {
    return allSlots.find((slot) => slot.tabs.includes(id)) ?? null;
  }

  function paneOf(id: WindowId): HTMLElement {
    const existing = panes.get(id);
    if (existing !== undefined) return existing;
    const pane = document.createElement("div");
    pane.dataset.role = "dock-pane";
    pane.dataset.window = id;
    panes.set(id, pane);
    return pane;
  }

  function tabOf(id: WindowId): HTMLElement {
    const existing = tabElements.get(id);
    if (existing !== undefined) return existing;
    const tab = document.createElement("div");
    tab.dataset.role = "dock-tab";
    tab.dataset.window = id;
    tab.textContent = options.titles[id];
    tab.title = "押すと前に出す。ドラッグで取り出す (ダブルクリックで最初の位置へ)";
    tabElements.set(id, tab);
    return tab;
  }

  /** 窓を body へ戻して浮いた窓にする (箱は捨てる) */
  function releaseToBody(id: WindowId): void {
    const frame = options.windows[id];
    if (frame.element.parentElement !== document.body) document.body.append(frame.element);
    frame.setDocked(false);
    panes.get(id)?.remove();
    panes.delete(id);
  }

  /** 枠に入っている窓を置く。使える枠なら置き場の箱へ、使えない枠なら退避 (body の浮いた窓) */
  function placeWindows(slot: Slot, shown: WindowId | undefined): void {
    for (const id of slot.tabs) {
      if (!slot.usable) {
        if (evacuated.has(id)) continue;
        evacuated.add(id);
        releaseToBody(id);
        options.onEvacuate(id);
        continue;
      }
      evacuated.delete(id);
      const frame = options.windows[id];
      const pane = paneOf(id);
      if (pane.parentElement !== slot.content) slot.content.append(pane);
      if (frame.element.parentElement !== pane) pane.append(frame.element);
      frame.setDocked(true);
      pane.style.display = id === shown ? "block" : "none";
    }
  }

  /**
   * タブの列を ids の並びにする。前のタブ (shown) は見た目と data-active で見分ける。**差分だけを動かす**: 要らなくなった
   * タブだけを外し、並びの違うタブだけを差し直す (押している最中のタブを付け直すと捕捉が外れる。判断メモ 36)
   */
  function renderTabs(slot: Slot, ids: WindowId[], shown: WindowId | undefined): void {
    const desired = ids.map((id) => {
      const tab = tabOf(id);
      const active = id === shown;
      tab.style.cssText = active ? DOCK_STYLE.tabActive : DOCK_STYLE.tab;
      tab.dataset.active = String(active);
      return tab;
    });
    for (const child of [...slot.tabRow.children]) {
      if (!desired.includes(child as HTMLElement)) child.remove();
    }
    desired.forEach((tab, index) => {
      const at = slot.tabRow.children[index] ?? null;
      if (at !== tab) slot.tabRow.insertBefore(tab, at);
    });
  }

  /**
   * 1 つの枠を描き直す (C2.2)。見えている窓 (hidden でない) のタブだけを出し、前のタブの窓だけを置き場に出す。
   * **枠の中の窓が 1 つでバーのときだけタブの列を出さない** (⠿ で掴めるうえ、1440x795 の高さの予算に 28px が入らない)。
   * 見えている窓が無い枠・使えない枠は枠ごと隠す
   */
  function render(slot: Slot): void {
    const visible = slot.tabs.filter((id) => !options.windows[id].element.hidden);
    const shown =
      slot.active !== undefined && visible.includes(slot.active) ? slot.active : visible[0];
    placeWindows(slot, shown);
    const showTabs = visible.length > 0 && !(visible.length === 1 && visible[0] === "bar");
    renderTabs(slot, showTabs ? visible : [], shown);
    slot.tabRow.style.display = showTabs ? "flex" : "none";
    slot.root.style.display = slot.usable && visible.length > 0 ? "block" : "none";
    applyGaps(slot, visible.length > 0);
  }

  /** 枠の余白。窓が見えている間だけ下の余白と、下の枠の上の余白の補正を当てる (判断メモ 37) */
  function applyGaps(slot: Slot, hasWindows: boolean): void {
    slot.root.style.marginBottom = `${hasWindows ? DOCK_SLOT_GAP_PX : 0}px`;
    slot.root.style.marginTop = `${hasWindows && slot.id === "below" ? BELOW_SLOT_MARGIN_TOP_PX : 0}px`;
  }

  function state(): DockState {
    const result: DockState = {};
    for (const slot of allSlots) {
      if (slot.tabs.length === 0) continue;
      result[slot.id] =
        slot.active === undefined
          ? { tabs: [...slot.tabs] }
          : { tabs: [...slot.tabs], active: slot.active };
    }
    return result;
  }

  function dock(id: WindowId, slotId: DockSlotId): void {
    // 落とし先の帯は入れられる枠にしか出さないので、ここへ来るのは配線の誤り。黙って捨てない
    if (!options.accepts(id, slotId)) {
      throw new Error(`[yt-clip] ${id} の窓は ${slotId} の枠に入れられません`);
    }
    const from = findSlot(id);
    const to = slots[slotId];
    if (from !== null) {
      from.tabs = from.tabs.filter((tab) => tab !== id);
      if (from.active === id) from.active = undefined;
    }
    // 並びは入れた順 (末尾に付く)。落とした窓を前に出す (C2.2 / C2.3)
    to.tabs = [...to.tabs, id];
    to.active = id;
    if (from !== null && from !== to) render(from);
    render(to);
    options.onChange(state());
  }

  function undock(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null) return;
    slot.tabs = slot.tabs.filter((tab) => tab !== id);
    if (slot.active === id) slot.active = undefined;
    evacuated.delete(id);
    releaseToBody(id);
    // 元の枠は残りの窓ですぐ描き直す (C2.4)
    render(slot);
    options.onChange(state());
  }

  function restore(id: WindowId): void {
    const home = allSlots.find((slot) => options.initial[slot.id]?.tabs.includes(id) === true);
    if (home === undefined) {
      undock(id);
      return;
    }
    const order = options.initial[home.id]?.tabs ?? [];
    /** 最初の配置の並びでの位置。最初の配置に無い窓は後ろ */
    const rank = (tab: WindowId): number => {
      const index = order.indexOf(tab);
      return index === -1 ? order.length : index;
    };
    const from = findSlot(id);
    if (from !== home) {
      if (from !== null) {
        from.tabs = from.tabs.filter((tab) => tab !== id);
        if (from.active === id) from.active = undefined;
      }
      // 最初の配置の並びの位置へ入れる (末尾に付けると、戻すたびに並びが操作の履歴で変わる)
      const tabs = [...home.tabs];
      const at = tabs.findIndex((tab) => rank(tab) > rank(id));
      tabs.splice(at === -1 ? tabs.length : at, 0, id);
      home.tabs = tabs;
    }
    home.active = id;
    if (from !== null && from !== home) render(from);
    render(home);
    options.onChange(state());
  }

  function activate(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null || slot.active === id) return;
    slot.active = id;
    render(slot);
    options.onChange(state());
  }

  return {
    elements: { below: slots.below.root, side: slots.side.root },

    attach(anchors: Record<DockSlotId, Element | null>): boolean {
      let changed = false;
      for (const slot of allSlots) {
        const anchor = anchors[slot.id];
        // YouTube が差す先の子を作り直すと、枠は中の窓ごとメモリに残って外れる。先頭に差し直す (C2.7)。
        // 差す先の中にあれば動かさない (YouTube が後から先頭に何かを足しても、取り合わない)
        if (anchor !== null && !anchor.contains(slot.root)) anchor.prepend(slot.root);
        // 差す先が無い (動画ページ以外・SPA の途中・1 列表示で消えた) か幅 0 なら使えない (C2.1)
        const usable = anchor !== null && anchor.getBoundingClientRect().width > 0;
        if (usable !== slot.usable) {
          slot.usable = usable;
          changed = true;
        }
      }
      return changed;
    },

    isUsable(slot: DockSlotId): boolean {
      return slots[slot].usable;
    },

    load(saved: DockState): void {
      for (const slot of allSlots) {
        const entry = saved[slot.id];
        slot.tabs = entry === undefined ? [] : [...entry.tabs];
        slot.active = entry?.active;
      }
    },

    dock,
    undock,
    restore,
    activate,

    slotOf(id: WindowId): DockSlotId | null {
      return findSlot(id)?.id ?? null;
    },

    sync(): void {
      for (const slot of allSlots) render(slot);
    },

    state,

    destroy(): void {
      for (const slot of allSlots) slot.root.remove();
    },
  };
}
