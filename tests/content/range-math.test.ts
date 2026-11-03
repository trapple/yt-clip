import { describe, expect, test } from "vitest";
import {
  DEFAULT_CLIP_SEC,
  TRIM_MARGIN_SEC,
  clampHandle,
  computeTrimWindow,
  makeDefaultRange,
  nudgeRange,
  ratioToTime,
  snapSec,
  timeToRatio,
} from "@/content/range-math";
import { DEFAULT_MAX_CLIP_SEC, MIN_CLIP_SEC } from "@/shared/time";

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

describe("computeTrimWindow", () => {
  test("区間の前後 2 秒を映す", () => {
    expect(computeTrimWindow({ startSec: 100, endSec: 108 }, 600)).toEqual({ startSec: 98, endSec: 110 });
    expect(TRIM_MARGIN_SEC).toBe(2);
  });

  test("動画の頭と終わりで切る", () => {
    expect(computeTrimWindow({ startSec: 1, endSec: 5 }, 600)).toEqual({ startSec: 0, endSec: 7 });
    expect(computeTrimWindow({ startSec: 595, endSec: 599 }, 600)).toEqual({ startSec: 593, endSec: 600 });
  });

  test("動画の長さが区間より短くても (広告の間など) 区間の尻までは映す", () => {
    // 窓が区間より狭いと、ハンドルが窓の外になり描けない
    expect(computeTrimWindow({ startSec: 100, endSec: 108 }, 30)).toEqual({ startSec: 98, endSec: 108 });
  });

  test("逆向きの範囲は投げる", () => {
    expect(() => computeTrimWindow({ startSec: 150, endSec: 100 }, 600)).toThrow(RangeError);
  });
});

describe("nudgeRange", () => {
  const RANGE = { startSec: 10, endSec: 20 };

  test("頭と尻を別々に動かす", () => {
    expect(nudgeRange("in", -0.1, RANGE, 600, 60)).toEqual({ startSec: 9.9, endSec: 20 });
    expect(nudgeRange("out", 0.1, RANGE, 600, 60)).toEqual({ startSec: 10, endSec: 20.1 });
  });

  test("足し算の誤差を残さない (100 分の 1 秒に丸める)", () => {
    let range = RANGE;
    for (let i = 0; i < 3; i += 1) range = nudgeRange("out", 0.1, range, 600, 60);
    expect(range.endSec).toBe(20.3);
  });

  test("動画の頭と終わりを越えない", () => {
    expect(nudgeRange("in", -0.1, { startSec: 0.05, endSec: 5 }, 600, 60)).toEqual({ startSec: 0, endSec: 5 });
    expect(nudgeRange("out", 0.1, { startSec: 590, endSec: 599.95 }, 600, 60)).toEqual({ startSec: 590, endSec: 600 });
  });

  test("丸めても 1 秒を割らず、上限を超えない (100 分の 1 秒の格子の内側へ寄せる)", () => {
    // 尻 101.126 の 1 秒手前 (100.126) で止まる。四捨五入すると 100.13 で長さ 0.996 秒になる
    const shortest = nudgeRange("in", 0.1, { startSec: 100.05, endSec: 101.126 }, 600, 60);
    expect(shortest.startSec).toBe(100.12);
    expect(shortest.endSec - shortest.startSec).toBeGreaterThanOrEqual(1);
    // 頭 10.004 から上限 60 秒 (70.004) で止まる。四捨五入すると 70.00 で 59.996 秒、上限は超えない
    const longest = nudgeRange("out", 0.1, { startSec: 10.004, endSec: 69.95 }, 600, 60);
    expect(longest.endSec - longest.startSec).toBeLessThanOrEqual(60);
  });

  test("1 秒より短くも、上限より長くもしない", () => {
    expect(nudgeRange("in", 0.1, { startSec: 10, endSec: 11 }, 600, 60)).toEqual({ startSec: 10, endSec: 11 });
    expect(nudgeRange("out", 0.1, { startSec: 10, endSec: 70 }, 600, 60)).toEqual({ startSec: 10, endSec: 70 });
  });
});

describe("snapSec", () => {
  test("許す幅の中で一番近い点に寄せる", () => {
    expect(snapSec(10.04, [9, 10, 10.1, 11], 0.08)).toBe(10);
    expect(snapSec(10.07, [9, 10, 10.1, 11], 0.08)).toBe(10.1);
  });

  test("許す幅の外なら動かさない", () => {
    expect(snapSec(10.5, [10, 11], 0.08)).toBe(10.5);
    expect(snapSec(10.5, [], 0.08)).toBe(10.5);
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
      endSec: 100 + DEFAULT_MAX_CLIP_SEC,
    });
    expect(clampHandle("in", 10, from, wide)).toEqual({
      startSec: 120 - DEFAULT_MAX_CLIP_SEC,
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

describe("最大秒数を差し替える", () => {
  const window = { startSec: 0, endSec: 300 };

  test("OUT 側は渡した上限までしか伸びない", () => {
    const range = { startSec: 100, endSec: 110 };

    expect(clampHandle("out", 290, range, window, 20)).toEqual({
      startSec: 100,
      endSec: 120,
    });
  });

  test("IN 側も渡した上限までしか下がらない", () => {
    const range = { startSec: 100, endSec: 110 };

    expect(clampHandle("in", 0, range, window, 20)).toEqual({
      startSec: 90,
      endSec: 110,
    });
  });

  test("既定の範囲も上限で頭打ちになる", () => {
    // IN を押しただけで上限を超えた範囲ができると、validateRange を
    // 通らないまま (OUT ボタンを押さずに) 録画できてしまう
    expect(makeDefaultRange(100, 600, 10)).toEqual({
      startSec: 100,
      endSec: 110,
    });
  });

  test("上限が既定の長さより長ければ既定の長さのまま", () => {
    expect(makeDefaultRange(100, 600, 120)).toEqual({
      startSec: 100,
      endSec: 115,
    });
  });
});
