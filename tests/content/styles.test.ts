// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BAR_STYLE, SIDE_PANEL_STYLE, applyPalette, isDarkTheme } from "@/content/styles";

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
  test("地はパネル用の色で塗る", () => {
    expect(SIDE_PANEL_STYLE.root).toContain("background:var(--ytc-panel)");
  });

  test("本体の中だけでスクロールする", () => {
    expect(SIDE_PANEL_STYLE.body).toContain("overflow-y:auto");
    // flex の子は min-height:0 が無いと中身より縮まず、パネルごと伸びる
    expect(SIDE_PANEL_STYLE.body).toContain("min-height:0");
  });

  test("display は持たない (出し入れは side-panel.ts が決める)", () => {
    expect(SIDE_PANEL_STYLE.root).not.toContain("display:");
    expect(SIDE_PANEL_STYLE.body).not.toContain("display:");
  });
});
