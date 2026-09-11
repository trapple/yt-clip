import { describe, expect, test } from "vitest";
import {
  DEFAULT_CLIP_SEC,
  MIN_WINDOW_SEC,
  clampHandle,
  computeWindow,
  makeDefaultRange,
  ratioToTime,
  timeToRatio,
} from "@/content/range-math";
import { MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/shared/time";

describe("makeDefaultRange", () => {
  test("押した位置から既定の長さの範囲を作る", () => {
    expect(makeDefaultRange(100, 600)).toEqual({
      startSec: 100,
      endSec: 100 + DEFAULT_CLIP_SEC,
    });
  });

  test("動画の末尾を越えない", () => {
    // 残り 5 秒しかない位置で押した場合
    expect(makeDefaultRange(595, 600)).toEqual({ startSec: 595, endSec: 600 });
  });

  test("末尾ぎりぎりで押しても最小の長さは確保する", () => {
    // 残りが最小長に満たないので、開始位置を手前にずらす
    expect(makeDefaultRange(599.5, 600)).toEqual({
      startSec: 600 - MIN_CLIP_SEC,
      endSec: 600,
    });
  });

  test("動画自体が既定より短い場合は動画全体になる", () => {
    expect(makeDefaultRange(0, 8)).toEqual({ startSec: 0, endSec: 8 });
  });

  test("不正な値は握り潰さず throw する", () => {
    expect(() => makeDefaultRange(-1, 600)).toThrow(RangeError);
    expect(() => makeDefaultRange(100, Number.NaN)).toThrow(RangeError);
  });
});

describe("computeWindow", () => {
  test("範囲の前後に余裕を持たせる", () => {
    // 30 秒の範囲 → 窓は 60 秒、中心は範囲の中心 (115)
    expect(computeWindow({ startSec: 100, endSec: 130 }, 600)).toEqual({
      startSec: 85,
      endSec: 145,
    });
  });

  test("短い範囲でも窓は最小幅を保つ", () => {
    // 2 秒の範囲。2 倍では狭すぎるので最小幅が効く
    const window = computeWindow({ startSec: 100, endSec: 102 }, 600);
    expect(window.endSec - window.startSec).toBe(MIN_WINDOW_SEC);
    expect((window.startSec + window.endSec) / 2).toBeCloseTo(101);
  });

  test("動画の先頭を越えない", () => {
    const window = computeWindow({ startSec: 2, endSec: 8 }, 600);
    expect(window.startSec).toBe(0);
    // 先頭で切り詰めた分は後ろへ回し、幅は保つ
    expect(window.endSec - window.startSec).toBe(MIN_WINDOW_SEC);
  });

  test("動画の末尾を越えない", () => {
    const window = computeWindow({ startSec: 592, endSec: 598 }, 600);
    expect(window.endSec).toBe(600);
    expect(window.endSec - window.startSec).toBe(MIN_WINDOW_SEC);
  });

  test("動画が窓より短い場合は動画全体が窓になる", () => {
    expect(computeWindow({ startSec: 2, endSec: 8 }, 20)).toEqual({
      startSec: 0,
      endSec: 20,
    });
  });

  test("順序が逆転した範囲は受け付けない", () => {
    expect(() => computeWindow({ startSec: 150, endSec: 100 }, 600)).toThrow(
      RangeError,
    );
  });
});

describe("timeToRatio / ratioToTime", () => {
  const window = { startSec: 100, endSec: 160 };

  test("窓の両端が 0 と 1 になる", () => {
    expect(timeToRatio(100, window)).toBe(0);
    expect(timeToRatio(160, window)).toBe(1);
  });

  test("中間は線形に対応する", () => {
    expect(timeToRatio(130, window)).toBeCloseTo(0.5);
    expect(ratioToTime(0.5, window)).toBeCloseTo(130);
  });

  test("往復しても値が保たれる", () => {
    for (const sec of [100, 117.5, 130, 159.9, 160]) {
      expect(ratioToTime(timeToRatio(sec, window), window)).toBeCloseTo(sec);
    }
  });

  test("窓の外は 0 と 1 に丸める", () => {
    expect(timeToRatio(50, window)).toBe(0);
    expect(timeToRatio(200, window)).toBe(1);
    expect(ratioToTime(-0.5, window)).toBe(100);
    expect(ratioToTime(1.5, window)).toBe(160);
  });

  test("不正な値は握り潰さず throw する", () => {
    // Math.max(0, NaN) は NaN を返すので、丸めでは防げない。
    // 黙って NaN が下流へ流れると、範囲が壊れたまま保存されうる
    expect(() => timeToRatio(Number.NaN, window)).toThrow(RangeError);
    expect(() => ratioToTime(Number.NaN, window)).toThrow(RangeError);
    expect(() =>
      timeToRatio(100, { startSec: Number.NaN, endSec: 160 }),
    ).toThrow(RangeError);
  });
});

describe("clampHandle", () => {
  const window = { startSec: 100, endSec: 160 };
  const range = { startSec: 120, endSec: 140 };

  test("IN を動かすと開始位置だけが変わる", () => {
    expect(clampHandle("in", 125, range, window)).toEqual({
      startSec: 125,
      endSec: 140,
    });
  });

  test("OUT を動かすと終了位置だけが変わる", () => {
    expect(clampHandle("out", 135, range, window)).toEqual({
      startSec: 120,
      endSec: 135,
    });
  });

  test("IN は窓の左端で止まる", () => {
    expect(clampHandle("in", 50, range, window)).toEqual({
      startSec: 100,
      endSec: 140,
    });
  });

  test("OUT は窓の右端で止まる", () => {
    expect(clampHandle("out", 500, range, window)).toEqual({
      startSec: 120,
      endSec: 160,
    });
  });

  test("IN は最小の長さを侵さない", () => {
    // OUT (140) に近づけすぎない
    expect(clampHandle("in", 139.9, range, window)).toEqual({
      startSec: 140 - MIN_CLIP_SEC,
      endSec: 140,
    });
  });

  test("OUT は最小の長さを侵さない", () => {
    expect(clampHandle("out", 120.1, range, window)).toEqual({
      startSec: 120,
      endSec: 120 + MIN_CLIP_SEC,
    });
  });

  test("最大の長さを超えない", () => {
    // 窓が十分に広い場合でも 60 秒で止まる
    const wide = { startSec: 0, endSec: 300 };
    const from = { startSec: 100, endSec: 120 };
    expect(clampHandle("out", 280, from, wide)).toEqual({
      startSec: 100,
      endSec: 100 + MAX_CLIP_SEC,
    });
    expect(clampHandle("in", 10, from, wide)).toEqual({
      startSec: 120 - MAX_CLIP_SEC,
      endSec: 120,
    });
  });

  test("不正な値は握り潰さず throw する", () => {
    expect(() => clampHandle("in", Number.NaN, range, window)).toThrow(
      RangeError,
    );
    // 範囲や窓が壊れていても、結果が NaN のまま返ることがないようにする
    expect(() =>
      clampHandle("in", 125, { startSec: 120, endSec: Number.NaN }, window),
    ).toThrow(RangeError);
    expect(() =>
      clampHandle("in", 125, range, { startSec: Number.NaN, endSec: 160 }),
    ).toThrow(RangeError);
  });

  test("順序が逆転した範囲は受け付けない", () => {
    // 呼び出し側のバグを黙って通すと、もっともらしいが無意味な結果を返す
    expect(() =>
      clampHandle("in", 125, { startSec: 150, endSec: 100 }, window),
    ).toThrow(RangeError);
  });

  test("範囲が確定する前 (窓も範囲も幅 0) は範囲を動かさない", () => {
    // mount 直後の値。ここで desiredSec を通すと
    // 上限 (endSec - MIN_CLIP_SEC) が負になり、負の再生位置が生まれる
    const zero = { startSec: 0, endSec: 0 };
    expect(clampHandle("in", 5, zero, zero)).toEqual(zero);
    expect(clampHandle("out", 5, zero, zero)).toEqual(zero);
  });

  test("動画が最小長より短いときは範囲を動かさない", () => {
    // 0.5 秒の動画。窓は動画全体になるが、最小長すら確保できない
    const short = { startSec: 0, endSec: 0.5 };
    expect(clampHandle("in", 0.4, short, short)).toEqual(short);
    expect(clampHandle("out", 0.1, short, short)).toEqual(short);
  });

  test("窓が最小長ちょうどのときは、上限と下限が一致して範囲が保たれる", () => {
    // 退化ケースの境界。ここでも負の再生位置は生まれない
    const window_ = { startSec: 10, endSec: 10 + MIN_CLIP_SEC };
    const from = { startSec: 10, endSec: 10 + MIN_CLIP_SEC };
    expect(clampHandle("in", 10.5, from, window_)).toEqual(from);
    expect(clampHandle("out", 20, from, window_)).toEqual(from);
  });

  test("長さ 0 の範囲でも、窓が足りていれば最小長を確保して動かせる", () => {
    // IN と OUT が重なった状態。窓は十分に広いので調整できる
    const collapsed = { startSec: 120, endSec: 120 };
    expect(clampHandle("in", 125, collapsed, window)).toEqual({
      startSec: 120 - MIN_CLIP_SEC,
      endSec: 120,
    });
    expect(clampHandle("out", 125, collapsed, window)).toEqual({
      startSec: 120,
      endSec: 125,
    });
  });

  test("順序が逆転した窓も受け付けない", () => {
    // 窓が壊れていると、制約の上限と下限が入れ替わって
    // 「動かせるはずのない位置」に収まった結果が返る
    expect(() =>
      clampHandle("in", 125, range, { startSec: 160, endSec: 100 }),
    ).toThrow(RangeError);
    expect(() =>
      timeToRatio(130, { startSec: 160, endSec: 100 }),
    ).toThrow(RangeError);
  });
});
