// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDockManager, type DockManager } from "@/content/dock";
import { createFloatingWindow, type FloatingWindow } from "@/content/floating-window";
import { acceptsDock, initialDocks, type DockSlotId, type WindowId } from "@/content/window-layout";

/** タブの文言 (youtube.ts と同じ) */
const TITLES = { bar: "バー", list: "区間・テロップ", settings: "設定" } as const;
/** 差す先の箱 (jsdom はレイアウトを持たない)。帯 (目印 40px / タブの列 28px) は枠の上端に置く */
const BELOW = { left: 0, top: 600, width: 800 };
const SIDE = { left: 840, top: 60, width: 400 };

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

/** 右の枠の差す先の幅。0 にすると使えない枠になる */
let sideWidth = SIDE.width;

/**
 * 差す先と、枠の中の帯・タブ・置き場の位置を決め打ちする。ほかの要素は 0。
 * タブは枠の左端から 8px の所に幅 100px で並べる (どのタブも同じ箱。当たり判定には使わない)
 */
function stubLayout() {
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.id === "below") return boxAt(BELOW.left, BELOW.top, BELOW.width, 0);
      if (this.id === "secondary-inner") return boxAt(SIDE.left, SIDE.top, sideWidth, 0);
      const box =
        this.closest("#yt-clip-dock-below") !== null
          ? BELOW
          : this.closest("#yt-clip-dock-side") !== null
            ? SIDE
            : null;
      const role = this instanceof HTMLElement ? this.dataset.role : undefined;
      if (box !== null && role === "dock-marker") return boxAt(box.left, box.top, box.width, 40);
      if (box !== null && role === "dock-tabs") return boxAt(box.left, box.top, box.width, 28);
      if (box !== null && role === "dock-tab") return boxAt(box.left + 8, box.top, 100, 28);
      if (box !== null && role === "dock-content") return boxAt(box.left, box.top + 28, box.width, 300);
      return boxAt(0, 0, 0, 0);
    });
}

type Setup = {
  manager: DockManager;
  windows: Record<WindowId, FloatingWindow>;
  below: HTMLElement;
  side: HTMLElement;
  onChange: ReturnType<typeof vi.fn>;
  onEvacuate: ReturnType<typeof vi.fn>;
  onUndock: ReturnType<typeof vi.fn>;
  onTabDoubleClick: ReturnType<typeof vi.fn>;
};

let made: Setup | null = null;

/** 差す先 2 つと窓 3 つ (浮いた窓で出ている) を作り、枠を差す */
function setup(): Setup {
  const below = document.createElement("div");
  below.id = "below";
  const side = document.createElement("div");
  side.id = "secondary-inner";
  document.body.append(below, side);
  const make = (id: WindowId): FloatingWindow => {
    const frame = createFloatingWindow({
      id: `win-${id}`,
      title: id === "bar" ? undefined : TITLES[id],
      resize: id === "bar" ? "width" : "both",
      minWidth: 280,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    document.body.append(frame.element);
    frame.setVisible(true);
    return frame;
  };
  const windows = { bar: make("bar"), list: make("list"), settings: make("settings") };
  const onChange = vi.fn();
  const onEvacuate = vi.fn();
  const onUndock = vi.fn();
  const onTabDoubleClick = vi.fn();
  const manager = createDockManager({
    windows,
    titles: TITLES,
    initial: initialDocks(),
    accepts: acceptsDock,
    onChange,
    onEvacuate,
    onUndock,
    onTabDoubleClick,
  });
  manager.attach({ below, side });
  made = { manager, windows, below, side, onChange, onEvacuate, onUndock, onTabDoubleClick };
  return made;
}

function slotRoot(slot: DockSlotId): HTMLElement {
  const root = document.getElementById(`yt-clip-dock-${slot}`);
  if (root === null) throw new Error(`#yt-clip-dock-${slot} がありません`);
  return root;
}

function tabRowOf(slot: DockSlotId): HTMLElement {
  const row = slotRoot(slot).querySelector<HTMLElement>("[data-role='dock-tabs']");
  if (row === null) throw new Error("タブの列がありません");
  return row;
}

/** 出ているタブの文言 (並び順) */
function tabLabels(slot: DockSlotId): string[] {
  return [...tabRowOf(slot).querySelectorAll<HTMLElement>("[data-role='dock-tab']")]
    .filter((tab) => tab.style.display !== "none")
    .map((tab) => tab.textContent ?? "");
}

function activeLabel(slot: DockSlotId): string | null {
  return (
    tabRowOf(slot).querySelector<HTMLElement>("[data-role='dock-tab'][data-active='true']")
      ?.textContent ?? null
  );
}

/** 窓を入れた箱の display (前のタブだけ block) */
function paneDisplay(frame: FloatingWindow): string {
  const pane = frame.element.parentElement;
  if (pane === null || pane.dataset.role !== "dock-pane") throw new Error("枠の置き場に入っていません");
  return pane.style.display;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない (窓のドラッグとタブの押下が呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

beforeEach(() => {
  sideWidth = SIDE.width;
  stubLayout();
});

afterEach(() => {
  if (made !== null) {
    made.manager.destroy();
    for (const frame of Object.values(made.windows)) frame.destroy();
    made.below.remove();
    made.side.remove();
    made = null;
  }
  vi.restoreAllMocks();
});

describe("入れる・出す・前に出す", () => {
  test("dock で枠の置き場に入り、窓はページの流れの中の見た目になる。枠を出し、onChange で組を知らせる", () => {
    const { manager, windows, onChange } = setup();

    manager.dock("list", "side");

    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(windows.list.element.style.position).toBe("static");
    expect(slotRoot("side").style.display).toBe("block");
    expect(slotRoot("side").parentElement?.id).toBe("secondary-inner");
    expect(manager.slotOf("list")).toBe("side");
    expect(manager.slotOf("bar")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list"], active: "list" } });
  });

  test("2 つ入れるとタブの列が出て、後から入れた方が前。前のタブの窓だけを出す (窓の出し入れは変えない)", () => {
    const { manager, windows } = setup();

    manager.dock("list", "side");
    manager.dock("settings", "side");

    expect(tabRowOf("side").style.display).toBe("flex");
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("設定");
    expect(paneDisplay(windows.list)).toBe("none");
    expect(paneDisplay(windows.settings)).toBe("block");
    expect(windows.list.element.hidden).toBe(false);
  });

  test("バーだけの枠はタブの列を出さない。区間・テロップの窓だけの枠は出す (掴む場所が要る)", () => {
    const { manager } = setup();

    manager.dock("bar", "below");
    manager.dock("list", "side");

    expect(tabRowOf("below").style.display).toBe("none");
    expect(slotRoot("below").style.display).toBe("block");
    expect(tabRowOf("side").style.display).toBe("flex");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
  });

  test("入れられない組み合わせ (右の枠のバー) は throw する", () => {
    const { manager } = setup();
    expect(() => manager.dock("bar", "side")).toThrow();
    expect(manager.slotOf("bar")).toBeNull();
  });

  test("activate で前のタブを替え、onChange で知らせる。枠に入っていない窓では何もしない", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    manager.activate("list");

    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(paneDisplay(windows.list)).toBe("block");
    expect(paneDisplay(windows.settings)).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list", "settings"], active: "list" } });

    onChange.mockClear();
    manager.activate("bar");
    manager.activate("list");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("隠れた窓のタブは出さず、前のタブが隠れたら見えているタブの先頭を出す。覚えた前のタブは変えず、保存も求めない", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    windows.settings.setVisible(false);
    manager.sync();

    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(paneDisplay(windows.list)).toBe("block");
    expect(manager.state().side?.active).toBe("settings");
    expect(onChange).not.toHaveBeenCalled();

    windows.settings.setVisible(true);
    manager.sync();
    expect(activeLabel("side")).toBe("設定");
  });

  test("見えている窓が 1 つも無い枠は、枠ごと隠す (空のタブの列でおすすめ動画を押し下げない)", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");

    windows.list.setVisible(false);
    manager.sync();

    expect(slotRoot("side").style.display).toBe("none");
  });

  test("undock で枠から出して body へ戻し、浮いた窓の見た目に戻す。元の枠は残りの窓で描き直す", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");

    manager.undock("settings");

    expect(windows.settings.element.parentElement).toBe(document.body);
    expect(windows.settings.element.style.position).toBe("fixed");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(paneDisplay(windows.list)).toBe("block");
    expect(manager.slotOf("settings")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list"] } });
  });

  test("別の枠へ入れ直すと、元の枠から外れて入れた枠の末尾に付く", () => {
    const { manager } = setup();
    manager.dock("bar", "below");
    manager.dock("list", "side");

    manager.dock("list", "below");

    expect(manager.state()).toEqual({ below: { tabs: ["bar", "list"], active: "list" } });
    expect(tabLabels("below")).toEqual(["バー", "区間・テロップ"]);
    expect(slotRoot("side").style.display).toBe("none");
  });

  test("restore は最初の配置の枠へ、最初の配置の並びの位置に入れて前に出す (浮いた窓も、別の枠の窓も)", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("settings", "side");
    manager.dock("list", "below");

    manager.restore("list");

    // 区間・テロップ → 設定 の順 (末尾に付けない)
    expect(manager.state()).toEqual({ side: { tabs: ["list", "settings"], active: "list" } });
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(slotRoot("below").style.display).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list", "settings"], active: "list" } });

    manager.restore("bar");
    expect(manager.state().below).toEqual({ tabs: ["bar"], active: "bar" });
  });

  test("restore で、既に最初の配置の枠にある窓は並びを変えずに前に出すだけ (保存も求める)", () => {
    const { manager, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    manager.restore("list");

    expect(manager.state()).toEqual({ side: { tabs: ["list", "settings"], active: "list" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("窓が見えている枠だけ下に 12px 空ける。下の枠の上の余白の補正も、窓が見えている間だけ", () => {
    const { manager, windows } = setup();
    manager.dock("bar", "below");
    expect(slotRoot("below").style.marginBottom).toBe("12px");
    expect(slotRoot("below").style.marginTop).toBe("0px");

    windows.bar.setVisible(false);
    manager.sync();
    expect(slotRoot("below").style.marginBottom).toBe("0px");
  });

  test("state は写しを返す (書き換えても枠の中身は変わらない)", () => {
    const { manager } = setup();
    manager.dock("list", "side");
    const copy = manager.state();
    copy.side?.tabs.push("settings");
    expect(manager.state()).toEqual({ side: { tabs: ["list"], active: "list" } });
  });
});

describe("差し直しと退避", () => {
  test("attach は差す先の中に無い枠を、中の窓ごと先頭に差し直す (使えるかは変わらないので false)", () => {
    const { manager, windows, below, side } = setup();
    manager.dock("list", "side");
    const root = slotRoot("side");
    const related = document.createElement("div");
    side.replaceChildren(related);
    expect(root.isConnected).toBe(false);

    expect(manager.attach({ below, side })).toBe(false);

    expect(side.firstElementChild).toBe(root);
    expect(root.contains(windows.list.element)).toBe(true);
  });

  test("差す先が幅 0 の枠は使えない。中の窓は sync で退避 (body の浮いた窓・onEvacuate を 1 回)。記憶は残し、戻ると枠に戻す", () => {
    const { manager, windows, below, side, onChange, onEvacuate } = setup();
    manager.dock("list", "side");
    onChange.mockClear();

    sideWidth = 0;
    expect(manager.attach({ below, side })).toBe(true);
    expect(manager.isUsable("side")).toBe(false);
    manager.sync();

    expect(windows.list.element.parentElement).toBe(document.body);
    expect(windows.list.element.style.position).toBe("fixed");
    expect(onEvacuate).toHaveBeenCalledWith("list");
    expect(slotRoot("side").style.display).toBe("none");
    expect(manager.slotOf("list")).toBe("side");
    expect(onChange).not.toHaveBeenCalled();

    manager.sync();
    expect(onEvacuate).toHaveBeenCalledTimes(1);

    sideWidth = SIDE.width;
    expect(manager.attach({ below, side })).toBe(true);
    manager.sync();
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(windows.list.element.style.position).toBe("static");
  });

  test("差す先が無い枠も使えない (退避する)", () => {
    const { manager, windows, below, onEvacuate } = setup();
    manager.dock("list", "side");

    expect(manager.attach({ below, side: null })).toBe(true);
    manager.sync();

    expect(windows.list.element.parentElement).toBe(document.body);
    expect(onEvacuate).toHaveBeenCalledWith("list");
  });

  test("load は onChange を呼ばずに枠の中身を入れ、sync で置く", () => {
    const { manager, windows, onChange } = setup();

    manager.load({ below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "list" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(windows.list.element.parentElement).toBe(document.body);

    manager.sync();

    expect(windows.bar.element.closest("#yt-clip-dock-below")).not.toBeNull();
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(manager.state()).toEqual({
      below: { tabs: ["bar"] },
      side: { tabs: ["list", "settings"], active: "list" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
