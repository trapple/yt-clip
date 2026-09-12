import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  formatTime,
  toUrlSeconds,
  validateRange,
} from "@/shared/time";

describe("formatTime", () => {
  test("1 時間未満は m:ss で表示する", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9)).toBe("0:09");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(599)).toBe("9:59");
  });

  test("1 時間以上は h:mm:ss で表示する", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  test("端数は切り捨てる", () => {
    expect(formatTime(75.9)).toBe("1:15");
  });

  test("不正な値は握り潰さず throw する", () => {
    expect(() => formatTime(-1)).toThrow(RangeError);
    expect(() => formatTime(Number.NaN)).toThrow(RangeError);
    expect(() => formatTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("toUrlSeconds", () => {
  test("URL 用に整数へ切り捨てる", () => {
    expect(toUrlSeconds(75.9)).toBe(75);
    expect(toUrlSeconds(0)).toBe(0);
  });

  test("不正な値は throw する", () => {
    expect(() => toUrlSeconds(-1)).toThrow(RangeError);
  });
});

describe("validateRange", () => {
  test("妥当な範囲は ok を返す", () => {
    expect(validateRange(10, 40)).toEqual({ ok: true });
  });

  test("上限ちょうどは許可する", () => {
    expect(validateRange(0, DEFAULT_MAX_CLIP_SEC)).toEqual({ ok: true });
  });

  test("下限ちょうどは許可する", () => {
    expect(validateRange(0, MIN_CLIP_SEC)).toEqual({ ok: true });
  });

  test("終了が開始以前なら理由つきで拒否する", () => {
    const result = validateRange(40, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("終了位置は開始位置より後にしてください");
    }
  });

  test("短すぎる範囲は拒否する", () => {
    const result = validateRange(10, 10.5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("クリップは 1 秒以上必要です");
    }
  });

  test("60 秒を超える範囲は現在の長さつきで拒否する", () => {
    const result = validateRange(0, 90);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("クリップは 60 秒までです (現在 90 秒)");
    }
  });

  test("不正な値は throw する", () => {
    expect(() => validateRange(Number.NaN, 10)).toThrow(RangeError);
  });
});

describe("最大秒数を差し替える", () => {
  test("渡した上限で判定が変わる", () => {
    // 既定 (60 秒) では通らない長さが、上限を上げれば通る
    expect(validateRange(0, 70)).toMatchObject({ ok: false });
    expect(validateRange(0, 70, 80)).toEqual({ ok: true });
  });

  test("上限ちょうどは通る", () => {
    expect(validateRange(0, 10, 10)).toEqual({ ok: true });
  });

  test("文言には渡した上限が出る", () => {
    // 既定値をそのまま出すと、設定を変えた利用者には嘘になる
    const result = validateRange(0, 30, 10);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("通ってはいけない");
    expect(result.message).toContain("10 秒までです");
    expect(result.message).toContain("30 秒");
  });
});
