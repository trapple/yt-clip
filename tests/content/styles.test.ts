// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  BAR_STYLE,
  FLOATING_WINDOW_STYLE,
  SIDE_PANEL_STYLE,
  applyPalette,
  isDarkTheme,
} from "@/content/styles";

describe("isDarkTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dark");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });

  test("YouTube が dark を立てていればダーク", () => {
    document.documentElement.setAttribute("dark", "");
    expect(isDarkTheme()).toBe(true);
  });

  test("dark が無ければ OS の設定に倒す", () => {
    // YouTube 側が属性を変えても、真っ白な板が出るよりはましな方に倒れる
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(isDarkTheme()).toBe(true);
  });

  test("どちらでもなければライト", () => {
    expect(isDarkTheme()).toBe(false);
  });

  test("matchMedia が無い環境でも落ちない", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isDarkTheme()).toBe(false);
  });
});

describe("applyPalette", () => {
  test("ライトとダークで色が変わる", () => {
    const element = document.createElement("div");

    applyPalette(element, false);
    const light = element.style.getPropertyValue("--ytc-surface");
    applyPalette(element, true);
    const dark = element.style.getPropertyValue("--ytc-surface");

    expect(light).not.toBe("");
    expect(dark).not.toBe(light);
  });

  test("面の色が地の色と同じにならない", () => {
    // 白地に白い板を出して見えなくなったのが元の不具合
    const element = document.createElement("div");

    applyPalette(element, false);
    expect(element.style.getPropertyValue("--ytc-surface")).not.toBe("#ffffff");

    applyPalette(element, true);
    expect(element.style.getPropertyValue("--ytc-surface")).not.toBe("#0f0f0f");
  });

  test("必要な色をすべて流し込む", () => {
    const element = document.createElement("div");
    applyPalette(element, true);

    for (const name of [
      "--ytc-text",
      "--ytc-text-sub",
      "--ytc-surface",
      "--ytc-border",
      "--ytc-accent",
      "--ytc-on-accent",
      "--ytc-panel",
    ]) {
      expect(element.style.getPropertyValue(name)).not.toBe("");
    }
  });

  test("パネルの地は light #ffffff / dark #212121", () => {
    const element = document.createElement("div");

    applyPalette(element, false);
    expect(element.style.getPropertyValue("--ytc-panel")).toBe("#ffffff");

    applyPalette(element, true);
    expect(element.style.getPropertyValue("--ytc-panel")).toBe("#212121");
  });

  test("パネルの地は面の色と違う", () => {
    // 面 (--ytc-surface) はテロップ行・選択中の区間行・設定の背景。地と同じだと溶ける
    const element = document.createElement("div");
    for (const dark of [false, true]) {
      applyPalette(element, dark);
      expect(element.style.getPropertyValue("--ytc-panel")).not.toBe(
        element.style.getPropertyValue("--ytc-surface"),
      );
    }
  });
});

describe("状態の文言", () => {
  test("1 行に収めてはみ出しを省略する", () => {
    // min-width:0 が無いと flex の子は中身より縮まず、行が 2 段に折り返す
    for (const declaration of [
      "flex:1",
      "min-width:0",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
    ]) {
      expect(BAR_STYLE.status).toContain(declaration);
    }
  });
});

describe("右側のパネル", () => {
  test("本体の中だけでスクロールする", () => {
    expect(SIDE_PANEL_STYLE.body).toContain("overflow-y:auto");
    // flex の子は min-height:0 が無いと中身より縮まず、パネルごと伸びる
    expect(SIDE_PANEL_STYLE.body).toContain("min-height:0");
  });

  test("本体は display を持たない (畳むときの出し入れは side-panel.ts が決める)", () => {
    expect(SIDE_PANEL_STYLE.body).not.toContain("display:");
  });

  test("枠の見た目 (地・見出し) は持たない (窓の枠が持つ)", () => {
    expect(Object.keys(SIDE_PANEL_STYLE)).toEqual(["collapseButton", "body"]);
  });
});

describe("フロートの窓", () => {
  test("画面に固定し、地はパネル用の色で塗る (下のページが透けない)", () => {
    expect(FLOATING_WINDOW_STYLE.root).toContain("position:fixed");
    expect(FLOATING_WINDOW_STYLE.root).toContain("background:var(--ytc-panel)");
  });

  test("display は持たない (出し入れは floating-window.ts が決める)", () => {
    expect(FLOATING_WINDOW_STYLE.root).not.toContain("display:");
    expect(FLOATING_WINDOW_STYLE.resizeGrip).not.toContain("display:");
  });

  test("見出しは掴めることが分かるカーソルで、文字を選ばせない", () => {
    expect(FLOATING_WINDOW_STYLE.header).toContain("cursor:move");
    expect(FLOATING_WINDOW_STYLE.header).toContain("user-select:none");
  });

  test("右下のつまみは 16px 四方", () => {
    expect(FLOATING_WINDOW_STYLE.resizeGrip).toContain("width:16px");
    expect(FLOATING_WINDOW_STYLE.resizeGrip).toContain("height:16px");
  });
});

describe("バーの窓", () => {
  test("中身の根は縁も外の余白も持たない (窓の枠が持つ。2 重にしない)", () => {
    expect(BAR_STYLE.root).not.toContain("border:");
    expect(BAR_STYLE.root).not.toContain("margin:");
  });

  test("つまみは掴めることが分かるカーソルで、文字を選ばせない", () => {
    expect(BAR_STYLE.grip).toContain("cursor:move");
    expect(BAR_STYLE.grip).toContain("user-select:none");
    expect(BAR_STYLE.grip).toContain("touch-action:none");
  });
});
