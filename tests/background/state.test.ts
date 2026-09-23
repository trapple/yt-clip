import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { INITIAL_STATE, reduce } from "@/background/state";
import type { ClipRange, ClipState } from "@/shared/types";

const meta = makeVideoMeta();
const range: ClipRange = { startSec: 10, endSec: 40 };
const segments = [range];

const ready: ClipState = { kind: "ready", segments, meta };
const preview: ClipState = {
  kind: "preview",
  clipId: "clip-1",
  segments,
  meta,
  mimeType: "video/mp4",
};

describe("マーク操作", () => {
  test("初期状態は idle", () => {
    expect(INITIAL_STATE).toEqual({ kind: "idle" });
  });

  test("IN を打つと範囲つきで ready へ進む", () => {
    expect(
      reduce(INITIAL_STATE, { type: "MARK_IN", range, meta }),
    ).toEqual(ready);
  });

  test("ready からでも IN を打ち直せる", () => {
    const next: ClipRange = { startSec: 20, endSec: 50 };
    expect(reduce(ready, { type: "MARK_IN", range: next, meta })).toEqual({
      kind: "ready",
      segments: [next],
      meta,
    });
  });

  test("OUT は終了位置だけを更新する", () => {
    expect(reduce(ready, { type: "MARK_OUT", index: 0, sec: 55 })).toEqual({
      kind: "ready",
      segments: [{ startSec: 10, endSec: 55 }],
      meta,
    });
  });

  test("ドラッグ結果は範囲をまるごと置き換える", () => {
    const dragged: ClipRange = { startSec: 12.5, endSec: 38.25 };
    expect(reduce(ready, { type: "ADJUST_SEGMENT", index: 0, range: dragged })).toEqual({
      kind: "ready",
      segments: [dragged],
      meta,
    });
  });

  test("録画中は 3 つの操作すべてを拒否する", () => {
    // 状態機械だけが範囲を戻し、録画が走り続ける事態を防ぐ。
    // UI と router にも同じ制約があるが、そちらが漏れたときに
    // 防御が一枚も残らないのは避ける
    const other: ClipRange = { startSec: 0, endSec: 5 };

    for (const kind of ["seeking", "recording", "encoding"] as const) {
      const busy: ClipState = { kind, segments, meta };

      expect(
        reduce(busy, { type: "MARK_IN", range: other, meta }),
      ).toMatchObject({ kind: "failed", reason: "internal-error" });
      expect(reduce(busy, { type: "MARK_OUT", index: 0, sec: 5 })).toMatchObject({
        kind: "failed",
        reason: "internal-error",
      });
      expect(
        reduce(busy, { type: "ADJUST_SEGMENT", index: 0, range: other }),
      ).toMatchObject({ kind: "failed", reason: "internal-error" });
    }
  });

  test("RESET_MARKS で idle に戻る", () => {
    expect(reduce(ready, { type: "RESET_MARKS" })).toEqual({ kind: "idle" });
  });
});

describe("録画フロー", () => {
  test("録画開始で seeking へ進む", () => {
    expect(reduce(ready, { type: "START_RECORDING" })).toEqual({
      kind: "seeking",
      segments,
      meta,
    });
  });

  test("seek 完了で recording へ進む", () => {
    const seeking = reduce(ready, { type: "START_RECORDING" });
    expect(reduce(seeking, { type: "SEEK_DONE" })).toEqual({
      kind: "recording",
      segments,
      meta,
    });
  });

  test("OUT 到達で encoding へ進む", () => {
    const recording: ClipState = { kind: "recording", segments, meta };
    expect(reduce(recording, { type: "OUT_REACHED" })).toEqual({
      kind: "encoding",
      segments,
      meta,
    });
  });

  test("Blob 確定で preview へ進む", () => {
    const encoding: ClipState = { kind: "encoding", segments, meta };
    expect(
      reduce(encoding, {
        type: "BLOB_READY",
        clipId: "clip-1",
        mimeType: "video/mp4",
      }),
    ).toEqual(preview);
  });

  test("取り直しで ready に戻る", () => {
    expect(reduce(preview, { type: "RETAKE" })).toEqual(ready);
  });
});

describe("投稿と degraded path", () => {
  test("投稿すると composing へ進む", () => {
    expect(reduce(preview, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      segments,
      meta,
      mimeType: "video/mp4",
    });
  });

  test("添付完了で posted へ進む", () => {
    const composing = reduce(preview, { type: "POST" });
    // 範囲とクリップを残して使い回せるようにした
    expect(reduce(composing, { type: "ATTACHED" }).kind).toBe("posted");
  });

  test("投稿画面が用意できないときは composing から取り直せる", () => {
    const composing = reduce(preview, { type: "POST" });
    expect(reduce(composing, { type: "RETAKE" })).toEqual(ready);
  });

  test("MP4 非対応なら preview から degraded へ退避する", () => {
    expect(
      reduce(preview, { type: "DEGRADE", reason: "mp4-unsupported" }),
    ).toEqual({
      kind: "degraded",
      clipId: "clip-1",
      segments,
      meta,
      mimeType: "video/mp4",
      reason: "mp4-unsupported",
    });
  });

  test("添付失敗なら composing から degraded へ退避し成果物を保持する", () => {
    const composing = reduce(preview, { type: "POST" });
    const result = reduce(composing, {
      type: "DEGRADE",
      reason: "x-attach-failed",
    });
    expect(result).toEqual({
      kind: "degraded",
      clipId: "clip-1",
      segments,
      meta,
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
  });

  test("degraded からも取り直せる", () => {
    const degraded = reduce(preview, {
      type: "DEGRADE",
      reason: "mp4-unsupported",
    });
    expect(reduce(degraded, { type: "RETAKE" })).toEqual(ready);
  });
});

describe("失敗と復帰", () => {
  test("録画中の失敗は範囲を保持したまま failed になる", () => {
    const recording: ClipState = { kind: "recording", segments, meta };
    expect(reduce(recording, { type: "FAIL", reason: "tab-lost" })).toEqual({
      kind: "failed",
      reason: "tab-lost",
      segments,
      meta,
    });
  });

  test("RETRY で ready に戻る", () => {
    const failed = reduce(
      { kind: "seeking", segments, meta },
      { type: "FAIL", reason: "seek-failed" },
    );
    expect(reduce(failed, { type: "RETRY" })).toEqual(ready);
  });

  test("範囲を持たない failed からの RETRY は idle に戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      segments: [],
      meta: null,
    };
    expect(reduce(failed, { type: "RETRY" })).toEqual({ kind: "idle" });
  });

  test("定義されていない遷移は internal-error として明示的に失敗する", () => {
    expect(reduce(INITIAL_STATE, { type: "OUT_REACHED" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments: [],
      meta: null,
    });
  });

  test("遷移に失敗しても直前の範囲は失われない", () => {
    expect(reduce(ready, { type: "SEEK_DONE" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      meta,
    });
  });
});

describe("投稿した後", () => {
  const posted: ClipState = {
    kind: "posted",
    segments,
    meta,
    clipId: "clip-1",
    mimeType: "video/mp4",
  };

  test("添付が通ったら posted へ進み、範囲とクリップを残す", () => {
    const composing: ClipState = {
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments,
      meta,
    };
    expect(reduce(composing, { type: "ATTACHED" })).toEqual(posted);
  });

  test("同じクリップをもう一度投稿できる", () => {
    expect(reduce(posted, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments,
      meta,
    });
  });

  test("取り直すと範囲は残しクリップを外す", () => {
    expect(reduce(posted, { type: "RETAKE" })).toEqual({
      kind: "ready",
      segments,
      meta,
    });
  });

  test("範囲を変えるとクリップを外す", () => {
    // 古い範囲のクリップを持ち続けると、画面に出ている範囲と
    // 投稿される中身が食い違う
    const moved = { startSec: 30, endSec: 45 };
    expect(reduce(posted, { type: "ADJUST_SEGMENT", index: 0, range: moved })).toEqual({
      kind: "ready",
      segments: [moved],
      meta,
    });
  });

  test("OUT を打ち直してもクリップを外す", () => {
    expect(reduce(posted, { type: "MARK_OUT", index: 0, sec: 40 })).toEqual({
      kind: "ready",
      segments: [{ startSec: range.startSec, endSec: 40 }],
      meta,
    });
  });

  test("新しい IN からやり直せる", () => {
    const next = { startSec: 100, endSec: 115 };
    expect(reduce(posted, { type: "MARK_IN", range: next, meta })).toEqual({
      kind: "ready",
      segments: [next],
      meta,
    });
  });

  test("定義していない操作は失敗として表面化させる", () => {
    expect(reduce(posted, { type: "SEEK_DONE" }).kind).toBe("failed");
  });
});

describe("添付に失敗した後", () => {
  const degraded: ClipState = {
    kind: "degraded",
    clipId: "clip-1",
    mimeType: "video/mp4",
    segments,
    meta,
    reason: "x-attach-failed",
  };

  test("録り直さずに投稿を試し直せる", () => {
    expect(reduce(degraded, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments,
      meta,
    });
  });

  test("遅れて届いた添付完了は拒む", () => {
    // x/failed が二度届いて degraded に落ちた後、遅れて x/attached が
    // 来る経路を塞ぐ既存のガード。上の POST とは別の話
    expect(reduce(degraded, { type: "ATTACHED" }).kind).toBe("failed");
  });
});

describe("録画の中止", () => {
  test("シーク中に中止すると範囲を残して戻る", () => {
    const seeking: ClipState = { kind: "seeking", segments, meta };
    expect(reduce(seeking, { type: "CANCEL_RECORDING" })).toEqual({
      kind: "ready",
      segments,
      meta,
    });
  });

  test("録画中に中止すると範囲を残して戻る", () => {
    // 範囲を残すので、そのまま録り直せる
    const recording: ClipState = { kind: "recording", segments, meta };
    expect(reduce(recording, { type: "CANCEL_RECORDING" })).toEqual({
      kind: "ready",
      segments,
      meta,
    });
  });

  test("書き出し中は中止できない", () => {
    // ここで止めると、録り終えたものを捨てることになる
    const encoding: ClipState = { kind: "encoding", segments, meta };
    expect(reduce(encoding, { type: "CANCEL_RECORDING" }).kind).toBe("failed");
  });

  test("録画していないときの中止は失敗として表面化させる", () => {
    expect(reduce(ready, { type: "CANCEL_RECORDING" }).kind).toBe("failed");
  });
});

describe("複数区間", () => {
  const second: ClipRange = { startSec: 100, endSec: 120 };

  test("idle から区間を足すと ready になる", () => {
    expect(reduce(INITIAL_STATE, { type: "ADD_SEGMENT", range, meta })).toEqual({
      kind: "ready",
      segments: [range],
      meta,
    });
  });

  test("ready に区間を足すと並んで増える", () => {
    expect(reduce(ready, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      meta,
    });
  });

  test("足した区間は動画の時間順に並ぶ", () => {
    const earlier: ClipRange = { startSec: 1, endSec: 5 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: earlier, meta })).toEqual({
      kind: "ready",
      segments: [earlier, range],
      meta,
    });
  });

  test("重なる区間を足すと 1 つに繋がる", () => {
    const overlapping: ClipRange = { startSec: 30, endSec: 60 };
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: overlapping, meta }),
    ).toEqual({
      kind: "ready",
      segments: [{ startSec: 10, endSec: 60 }],
      meta,
    });
  });

  test("合計が長くなっても区間は足せる", () => {
    // 超過は録画に進めないことで示す。先に縮めてから追加、を強制しない
    const long: ClipRange = { startSec: 1000, endSec: 1200 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: long, meta }).kind).toBe(
      "ready",
    );
  });

  test("投稿後に区間を足すとクリップは外れる", () => {
    const posted: ClipState = {
      kind: "posted",
      segments,
      meta,
      clipId: "clip-1",
      mimeType: "video/mp4",
    };
    expect(reduce(posted, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      meta,
    });
  });

  test("区間を消せる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    expect(reduce(two, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "ready",
      segments: [second],
      meta,
    });
  });

  test("最後の区間を消すと idle に戻る", () => {
    // 区間が 0 個の ready は録画に進めない死に状態なので作らない
    expect(reduce(ready, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "idle",
    });
  });

  test("index を指して区間を動かせる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    const moved: ClipRange = { startSec: 100, endSec: 130 };
    expect(reduce(two, { type: "ADJUST_SEGMENT", index: 1, range: moved })).toEqual(
      { kind: "ready", segments: [range, moved], meta },
    );
  });

  test("index を指して終端だけ動かせる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    expect(reduce(two, { type: "MARK_OUT", index: 1, sec: 130 })).toEqual({
      kind: "ready",
      segments: [range, { startSec: 100, endSec: 130 }],
      meta,
    });
  });

  test("投稿後も index を指して区間を動かせる", () => {
    const posted: ClipState = {
      kind: "posted",
      segments: [range, second],
      meta,
      clipId: "clip-1",
      mimeType: "video/mp4",
    };
    expect(reduce(posted, { type: "REMOVE_SEGMENT", index: 1 })).toEqual({
      kind: "ready",
      segments: [range],
      meta,
    });
  });

  test("範囲外の index は握り潰さず内部エラーにする", () => {
    expect(reduce(ready, { type: "REMOVE_SEGMENT", index: 5 })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      meta,
    });
    expect(reduce(ready, { type: "ADJUST_SEGMENT", index: -1, range })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      meta,
    });
  });

  test("録画中は区間を足せない", () => {
    const recording: ClipState = { kind: "recording", segments, meta };
    expect(
      reduce(recording, { type: "ADD_SEGMENT", range: second, meta }).kind,
    ).toBe("failed");
  });

  test("区間を作る前に落ちた失敗からは idle へ戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      segments: [],
      meta: null,
    };
    expect(reduce(failed, { type: "RETRY" })).toEqual({ kind: "idle" });
  });
});

describe("動画をまたいだ区間の追加", () => {
  const otherMeta = makeVideoMeta({ videoId: "video-b", title: "動画 B" });
  const otherRange: ClipRange = { startSec: 5, endSec: 15 };

  test("別の動画の区間を足したら作り直す", () => {
    // 結合できるのは同じ動画の中だけ。混ぜると、B の映像を A の秒で切った
    // クリップに A のタイトルと URL が付いて投稿される
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: otherRange, meta: otherMeta }),
    ).toEqual({ kind: "ready", segments: [otherRange], meta: otherMeta });
  });

  test("同じ動画なら今までどおり足す", () => {
    const second: ClipRange = { startSec: 100, endSec: 120 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      meta,
    });
  });
});
