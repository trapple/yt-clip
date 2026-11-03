import { describe, expect, test } from "vitest";
import { firstLineAtOrAfter, placeTranscriptItems } from "@/content/transcript-items";
import type { TranscriptLine } from "@/shared/transcript";

const line = (startSec: number, endSec: number): TranscriptLine => ({
  id: `youtube-asr:${startSec.toFixed(2)}`,
  startSec,
  endSec,
  text: `行 ${startSec}`,
});
const LINES = [line(1, 3), line(4, 6), line(7, 9), line(20, 22)];

describe("firstLineAtOrAfter", () => {
  test("その秒以上で始まる最初の行の位置。無ければ行の数", () => {
    expect(firstLineAtOrAfter(LINES, 0)).toBe(0);
    expect(firstLineAtOrAfter(LINES, 4)).toBe(1);
    expect(firstLineAtOrAfter(LINES, 4.5)).toBe(2);
    expect(firstLineAtOrAfter(LINES, 30)).toBe(4);
    expect(firstLineAtOrAfter([], 5)).toBe(0);
  });
});

describe("placeTranscriptItems", () => {
  test("区間の見出しは、区間の頭以降で始まる最初の行の前に入る", () => {
    const items = placeTranscriptItems(LINES, [{ startSec: 3.8, endSec: 9.3 }], []);
    expect(items).toEqual([{ kind: "segment", index: 0, startSec: 3.8, endSec: 9.3, before: 1 }]);
  });

  test("区間の頭より少し前に始まり、半分以上が区間に入る行は、見出しの下に入れる", () => {
    // 4〜6 の行は 4.5 から始まる区間に 1.5 / 2 秒入る (半分以上)
    const items = placeTranscriptItems(LINES, [{ startSec: 4.5, endSec: 9.3 }], []);
    expect(items[0]?.before).toBe(1);
  });

  test("半分に満たない行は見出しの上に残す", () => {
    // 4〜6 の行は 5.5 から始まる区間に 0.5 / 2 秒しか入らない
    const items = placeTranscriptItems(LINES, [{ startSec: 5.5, endSec: 9.3 }], []);
    expect(items[0]?.before).toBe(2);
  });

  test("行が無い (字幕の無い動画) ときは、全部が末尾 (0 の前) に時刻順で並ぶ", () => {
    const items = placeTranscriptItems(
      [],
      [{ startSec: 10, endSec: 20 }, { startSec: 40, endSec: 50 }],
      [{ startSec: 45, endSec: 48, text: "後" }, { startSec: 12, endSec: 15, text: "前" }],
    );
    expect(items.map((item) => [item.kind, item.startSec, item.before])).toEqual([
      ["segment", 10, 0],
      ["manual", 12, 0],
      ["segment", 40, 0],
      ["manual", 45, 0],
    ]);
  });

  test("手入力の行は lineId の無いテロップだけ。テロップの位置 (index) と、区間に入っているかを持つ", () => {
    const items = placeTranscriptItems(
      LINES,
      [{ startSec: 0.8, endSec: 3.3 }],
      [
        { startSec: 1, endSec: 3, text: "行 1", lineId: "youtube-asr:1.00" },
        { startSec: 2, endSec: 3, text: "ツッコミ" },
        { startSec: 25, endSec: 28, text: "" },
      ],
    );
    expect(items.filter((item) => item.kind === "manual")).toEqual([
      { kind: "manual", telopIndex: 1, startSec: 2, endSec: 3, text: "ツッコミ", inSegment: true, fromLine: false, before: 1 },
      { kind: "manual", telopIndex: 2, startSec: 25, endSec: 28, text: "", inSegment: false, fromLine: false, before: 4 },
    ]);
  });

  test("同じ行の前に入るものは時刻順で、同じ時刻なら見出しが先", () => {
    const items = placeTranscriptItems(
      LINES,
      [{ startSec: 10, endSec: 15 }],
      [{ startSec: 10, endSec: 12, text: "頭から" }, { startSec: 9.5, endSec: 11, text: "その前" }],
    );
    expect(items.map((item) => (item.kind === "segment" ? "見出し" : item.text))).toEqual(["その前", "見出し", "頭から"]);
  });

  test("区間から外れた字幕の行のテロップ・行が無くなったテロップも手入力の行として出す (見えないまま残さない)", () => {
    const items = placeTranscriptItems(
      LINES,
      [{ startSec: 0.8, endSec: 3.3 }],
      [
        // 行 1 は区間に入っている: 字幕の行が出すので出さない
        { startSec: 1, endSec: 3, text: "行 1", lineId: "youtube-asr:1.00" },
        // 行 20 は区間に入っていない (見出しの ✕ で区間を消した後など)
        { startSec: 20, endSec: 22, text: "行 20", lineId: "youtube-asr:20.00" },
        // 取り直して行が無くなった
        { startSec: 30, endSec: 31, text: "消えた行", lineId: "youtube-manual:30.00" },
      ],
    );
    expect(items.filter((item) => item.kind === "manual").map((item) => item.kind === "manual" && item.telopIndex)).toEqual([1, 2]);
    expect(items.every((item) => item.kind !== "manual" || item.fromLine)).toBe(true);
  });

  test("文字起こしを取っている間 (行がまだ無い) は、行から作ったテロップを手入力の行にしない (取り終わると行に戻るので、ちらつかせない)", () => {
    const items = placeTranscriptItems(
      [],
      [{ startSec: 0.8, endSec: 3.3 }],
      [
        { startSec: 1, endSec: 3, text: "行 1", lineId: "youtube-asr:1.00" },
        { startSec: 2, endSec: 3, text: "ツッコミ" },
      ],
      false,
    );
    expect(items.filter((item) => item.kind === "manual").map((item) => item.kind === "manual" && item.text)).toEqual(["ツッコミ"]);
  });
});
