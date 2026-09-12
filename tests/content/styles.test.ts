// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyPalette, isDarkTheme } from "@/content/styles";

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
    ]) {
      expect(element.style.getPropertyValue(name)).not.toBe("");
    }
  });
});
