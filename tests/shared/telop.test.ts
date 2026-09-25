import { describe, expect, test } from "vitest";
import {
  activeTelops,
  MAX_TELOP_TEXT_LENGTH,
  assertValidTelops,
  hasRenderableTelops,
  overlapsSegments,
} from "@/shared/telop";
import type { ClipRange, Telop } from "@/shared/types";

const hello: Telop = { startSec: 10, endSec: 13, text: "こんにちは" };
const world: Telop = { startSec: 12, endSec: 15, text: "世界" };
const blank: Telop = { startSec: 10, endSec: 13, text: "  " };

describe("assertValidTelops", () => {
  test("正しいテロップは通す", () => {
    expect(() => assertValidTelops([hello, world])).not.toThrow();
  });

  test("空文字の文言は通す (まだ書いていないテロップ)", () => {
    expect(() =>
      assertValidTelops([{ startSec: 0, endSec: 1, text: "" }]),
    ).not.toThrow();
  });

  test("終了が開始以下なら弾く", () => {
    // UI のバグ。黙って直すと、思っていたのと違う時間に出るテロップが焼き込まれる
    expect(() =>
      assertValidTelops([{ startSec: 5, endSec: 5, text: "a" }]),
    ).toThrow(RangeError);
  });

  test("負の開始は弾く", () => {
    expect(() =>
      assertValidTelops([{ startSec: -1, endSec: 2, text: "a" }]),
    ).toThrow(RangeError);
  });

  test("文言は 500 文字まで通し、超えたら弾く", () => {
    // 状態ごと chrome.storage.session に保存され、毎フレーム描かれる。上限が無いと
    // 巨大な貼り付けで保存も描画も膨らむ
    expect(MAX_TELOP_TEXT_LENGTH).toBe(500);
    expect(() =>
      assertValidTelops([{ startSec: 0, endSec: 1, text: "あ".repeat(500) }]),
    ).not.toThrow();
    expect(() =>
      assertValidTelops([{ startSec: 0, endSec: 1, text: "あ".repeat(501) }]),
    ).toThrow(RangeError);
  });

  test("文言が文字列でなければ弾く", () => {
    expect(() =>
      assertValidTelops([
        { startSec: 0, endSec: 1, text: 3 } as unknown as Telop,
      ]),
    ).toThrow(TypeError);
  });
});

describe("activeTelops", () => {
  test("開始ちょうどは出し、終了ちょうどは出さない", () => {
    expect(activeTelops([hello], 10)).toEqual([hello]);
    expect(activeTelops([hello], 13)).toEqual([]);
  });

  test("空白だけの文言は出さない", () => {
    expect(activeTelops([blank], 11)).toEqual([]);
  });

  test("同時に出るものは作った順のまま返す", () => {
    // 下から積む順番がこれで決まる
    expect(activeTelops([world, hello], 12.5)).toEqual([world, hello]);
  });
});

describe("overlapsSegments", () => {
  const segments: ClipRange[] = [
    { startSec: 0, endSec: 5 },
    { startSec: 20, endSec: 30 },
  ];

  test("どれかの区間に一部でも重なれば真", () => {
    expect(overlapsSegments({ startSec: 4, endSec: 8, text: "a" }, segments)).toBe(true);
    expect(overlapsSegments({ startSec: 25, endSec: 26, text: "a" }, segments)).toBe(true);
  });

  test("区間の間にだけあれば偽", () => {
    expect(overlapsSegments({ startSec: 6, endSec: 19, text: "a" }, segments)).toBe(false);
  });

  test("端が接しているだけなら偽", () => {
    // 区間の終わりちょうどで始まるテロップは 1 フレームも出ない
    expect(overlapsSegments({ startSec: 5, endSec: 8, text: "a" }, segments)).toBe(false);
  });
});

describe("hasRenderableTelops", () => {
  const segments: ClipRange[] = [{ startSec: 10, endSec: 20 }];

  test("区間に重なる空でないテロップがあれば真", () => {
    expect(hasRenderableTelops([hello], segments)).toBe(true);
  });

  test("空白だけのテロップしか無ければ偽", () => {
    expect(hasRenderableTelops([blank], segments)).toBe(false);
  });

  test("区間外のテロップしか無ければ偽", () => {
    // canvas を挟む負荷を、録画に出ないテロップのために払わない
    expect(
      hasRenderableTelops([{ startSec: 30, endSec: 33, text: "a" }], segments),
    ).toBe(false);
  });

  test("テロップが無ければ偽", () => {
    expect(hasRenderableTelops([], segments)).toBe(false);
  });
});
