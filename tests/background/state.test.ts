import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { INITIAL_STATE, reduce } from "@/background/state";
import type { ClipRange, ClipState, Telop } from "@/shared/types";

const meta = makeVideoMeta();
const range: ClipRange = { startSec: 10, endSec: 40 };
const segments = [range];

const ready: ClipState = { kind: "ready", segments, telops: [], meta };
const preview: ClipState = {
  kind: "preview",
  clipId: "clip-1",
  segments,
  telops: [],
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
      telops: [],
      meta,
    });
  });

  test("OUT は終了位置だけを更新する", () => {
    expect(reduce(ready, { type: "MARK_OUT", index: 0, sec: 55 })).toEqual({
      kind: "ready",
      segments: [{ startSec: 10, endSec: 55 }],
      telops: [],
      meta,
    });
  });

  test("ドラッグ結果は範囲をまるごと置き換える", () => {
    const dragged: ClipRange = { startSec: 12.5, endSec: 38.25 };
    expect(reduce(ready, { type: "ADJUST_SEGMENT", index: 0, range: dragged })).toEqual({
      kind: "ready",
      segments: [dragged],
      telops: [],
      meta,
    });
  });

  test("録画中は 3 つの操作すべてを拒否する", () => {
    // 状態機械だけが範囲を戻し、録画が走り続ける事態を防ぐ。
    // UI と router にも同じ制約があるが、そちらが漏れたときに
    // 防御が一枚も残らないのは避ける
    const other: ClipRange = { startSec: 0, endSec: 5 };

    for (const kind of ["seeking", "recording", "encoding"] as const) {
      const busy: ClipState = { kind, segments, telops: [], meta };

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
      telops: [],
      meta,
    });
  });

  test("seek 完了で recording へ進む", () => {
    const seeking = reduce(ready, { type: "START_RECORDING" });
    expect(reduce(seeking, { type: "SEEK_DONE" })).toEqual({
      kind: "recording",
      segments,
      telops: [],
      meta,
    });
  });

  test("OUT 到達で encoding へ進む", () => {
    const recording: ClipState = { kind: "recording", segments, telops: [], meta };
    expect(reduce(recording, { type: "OUT_REACHED" })).toEqual({
      kind: "encoding",
      segments,
      telops: [],
      meta,
    });
  });

  test("Blob 確定で preview へ進む", () => {
    const encoding: ClipState = { kind: "encoding", segments, telops: [], meta };
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
      telops: [],
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
      telops: [],
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
      telops: [],
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
    const recording: ClipState = { kind: "recording", segments, telops: [], meta };
    expect(reduce(recording, { type: "FAIL", reason: "tab-lost" })).toEqual({
      kind: "failed",
      reason: "tab-lost",
      segments,
      telops: [],
      meta,
    });
  });

  test("RETRY で ready に戻る", () => {
    const failed = reduce(
      { kind: "seeking", segments, telops: [], meta },
      { type: "FAIL", reason: "seek-failed" },
    );
    expect(reduce(failed, { type: "RETRY" })).toEqual(ready);
  });

  test("範囲を持たない failed からの RETRY は idle に戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      segments: [],
      telops: [],
      meta: null,
    };
    expect(reduce(failed, { type: "RETRY" })).toEqual({ kind: "idle" });
  });

  test("定義されていない遷移は internal-error として明示的に失敗する", () => {
    expect(reduce(INITIAL_STATE, { type: "OUT_REACHED" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments: [],
      telops: [],
      meta: null,
    });
  });

  test("遷移に失敗しても直前の範囲は失われない", () => {
    expect(reduce(ready, { type: "SEEK_DONE" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      telops: [],
      meta,
    });
  });
});

describe("投稿した後", () => {
  const posted: ClipState = {
    kind: "posted",
    segments,
    telops: [],
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
      telops: [],
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
      telops: [],
      meta,
    });
  });

  test("取り直すと範囲は残しクリップを外す", () => {
    expect(reduce(posted, { type: "RETAKE" })).toEqual({
      kind: "ready",
      segments,
      telops: [],
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
      telops: [],
      meta,
    });
  });

  test("OUT を打ち直してもクリップを外す", () => {
    expect(reduce(posted, { type: "MARK_OUT", index: 0, sec: 40 })).toEqual({
      kind: "ready",
      segments: [{ startSec: range.startSec, endSec: 40 }],
      telops: [],
      meta,
    });
  });

  test("新しい IN からやり直せる", () => {
    const next = { startSec: 100, endSec: 115 };
    expect(reduce(posted, { type: "MARK_IN", range: next, meta })).toEqual({
      kind: "ready",
      segments: [next],
      telops: [],
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
    telops: [],
    meta,
    reason: "x-attach-failed",
  };

  test("録り直さずに投稿を試し直せる", () => {
    expect(reduce(degraded, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments,
      telops: [],
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
    const seeking: ClipState = { kind: "seeking", segments, telops: [], meta };
    expect(reduce(seeking, { type: "CANCEL_RECORDING" })).toEqual({
      kind: "ready",
      segments,
      telops: [],
      meta,
    });
  });

  test("録画中に中止すると範囲を残して戻る", () => {
    // 範囲を残すので、そのまま録り直せる
    const recording: ClipState = { kind: "recording", segments, telops: [], meta };
    expect(reduce(recording, { type: "CANCEL_RECORDING" })).toEqual({
      kind: "ready",
      segments,
      telops: [],
      meta,
    });
  });

  test("書き出し中は中止できない", () => {
    // ここで止めると、録り終えたものを捨てることになる
    const encoding: ClipState = { kind: "encoding", segments, telops: [], meta };
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
      telops: [],
      meta,
    });
  });

  test("ready に区間を足すと並んで増える", () => {
    expect(reduce(ready, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      telops: [],
      meta,
    });
  });

  test("足した区間は拾った順に並ぶ。時間順へ並べ替えない", () => {
    // 「オチを先に見せる」ような並べ方ができる
    const earlier: ClipRange = { startSec: 1, endSec: 5 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: earlier, meta })).toEqual({
      kind: "ready",
      segments: [range, earlier],
      telops: [],
      meta,
    });
  });

  test("重なる区間もそのまま残る", () => {
    // マージすると、区間の中で「追加」を押したときに無反応になる
    const overlapping: ClipRange = { startSec: 30, endSec: 60 };
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: overlapping, meta }),
    ).toEqual({
      kind: "ready",
      segments: [range, overlapping],
      telops: [],
      meta,
    });
  });

  test("完全に含まれる区間を足しても増える", () => {
    // 既存区間 10-40 の内側。マージしていた頃は結果が変わらず無反応だった
    const inside: ClipRange = { startSec: 20, endSec: 30 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: inside, meta })).toEqual({
      kind: "ready",
      segments: [range, inside],
      telops: [],
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
      telops: [],
      meta,
      clipId: "clip-1",
      mimeType: "video/mp4",
    };
    expect(reduce(posted, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      telops: [],
      meta,
    });
  });

  test("区間を消せる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], telops: [], meta };
    expect(reduce(two, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "ready",
      segments: [second],
      telops: [],
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
    const two: ClipState = { kind: "ready", segments: [range, second], telops: [], meta };
    const moved: ClipRange = { startSec: 100, endSec: 130 };
    expect(reduce(two, { type: "ADJUST_SEGMENT", index: 1, range: moved })).toEqual(
      { kind: "ready", segments: [range, moved], telops: [], meta },
    );
  });

  test("index を指して終端だけ動かせる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], telops: [], meta };
    expect(reduce(two, { type: "MARK_OUT", index: 1, sec: 130 })).toEqual({
      kind: "ready",
      segments: [range, { startSec: 100, endSec: 130 }],
      telops: [],
      meta,
    });
  });

  test("投稿後も index を指して区間を動かせる", () => {
    const posted: ClipState = {
      kind: "posted",
      segments: [range, second],
      telops: [],
      meta,
      clipId: "clip-1",
      mimeType: "video/mp4",
    };
    expect(reduce(posted, { type: "REMOVE_SEGMENT", index: 1 })).toEqual({
      kind: "ready",
      segments: [range],
      telops: [],
      meta,
    });
  });

  test("範囲外の index は握り潰さず内部エラーにする", () => {
    expect(reduce(ready, { type: "REMOVE_SEGMENT", index: 5 })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      telops: [],
      meta,
    });
    expect(reduce(ready, { type: "ADJUST_SEGMENT", index: -1, range })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      telops: [],
      meta,
    });
  });

  test("録画中は区間を足せない", () => {
    const recording: ClipState = { kind: "recording", segments, telops: [], meta };
    expect(
      reduce(recording, { type: "ADD_SEGMENT", range: second, meta }).kind,
    ).toBe("failed");
  });

  test("区間を作る前に落ちた失敗からは idle へ戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      segments: [],
      telops: [],
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
    ).toEqual({ kind: "ready", segments: [otherRange], telops: [], meta: otherMeta });
  });

  test("同じ動画なら今までどおり足す", () => {
    const second: ClipRange = { startSec: 100, endSec: 120 };
    expect(reduce(ready, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      telops: [],
      meta,
    });
  });
});

describe("テロップ", () => {
  const telop: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
  const withTelop: ClipState = {
    kind: "ready",
    segments,
    meta,
    telops: [telop],
  };
  const postedWithTelop: ClipState = {
    kind: "posted",
    segments,
    meta,
    telops: [telop],
    clipId: "clip-1",
    mimeType: "video/mp4",
  };

  test("ready で足すと末尾に付く", () => {
    const next: Telop = { startSec: 15, endSec: 18, text: "" };
    expect(reduce(withTelop, { type: "ADD_TELOP", telop: next })).toEqual({
      ...withTelop,
      telops: [telop, next],
    });
  });

  test("UPDATE_TELOP は指したテロップを丸ごと差し替える", () => {
    const changed: Telop = { startSec: 12, endSec: 14, text: "やあ" };
    expect(
      reduce(withTelop, { type: "UPDATE_TELOP", index: 0, telop: changed }),
    ).toEqual({ ...withTelop, telops: [changed] });
  });

  test("REMOVE_TELOP で消える", () => {
    expect(reduce(withTelop, { type: "REMOVE_TELOP", index: 0 })).toEqual({
      ...withTelop,
      telops: [],
    });
  });

  test("posted で変えるとクリップが外れて ready に戻る", () => {
    // 焼き込まれているので、古いクリップを持ち続けると画面と投稿内容が食い違う
    expect(reduce(postedWithTelop, { type: "REMOVE_TELOP", index: 0 })).toEqual({
      kind: "ready",
      segments,
      meta,
      telops: [],
    });
  });

  test("preview / degraded / idle では受けない", () => {
    // 区間の編集も受けていない状態。テロップだけ触れる非対称を作らない
    const previewWithTelop: ClipState = {
      kind: "preview",
      clipId: "clip-1",
      segments,
      meta,
      telops: [telop],
      mimeType: "video/mp4",
    };
    const degraded: ClipState = {
      kind: "degraded",
      clipId: "clip-1",
      segments,
      meta,
      telops: [telop],
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    };
    for (const state of [previewWithTelop, degraded, INITIAL_STATE]) {
      expect(reduce(state, { type: "REMOVE_TELOP", index: 0 }).kind).toBe("failed");
    }
  });

  test("不正な index は internal-error", () => {
    const next = reduce(withTelop, { type: "REMOVE_TELOP", index: 3 });
    expect(next).toMatchObject({ kind: "failed", reason: "internal-error" });
  });

  test("不正な時刻は throw する (区間と同じく握り潰さない)", () => {
    expect(() =>
      reduce(withTelop, {
        type: "ADD_TELOP",
        telop: { startSec: 5, endSec: 5, text: "" },
      }),
    ).toThrow(RangeError);
  });

  test("録画中は受けない", () => {
    const recording: ClipState = { kind: "recording", segments, meta, telops: [telop] };
    expect(reduce(recording, { type: "REMOVE_TELOP", index: 0 }).kind).toBe("failed");
  });

  test("最後の区間を消して idle に戻るとテロップも消える", () => {
    expect(reduce(withTelop, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "idle",
    });
  });

  test("区間の編集ではテロップを残す", () => {
    const next = reduce(withTelop, { type: "MARK_OUT", index: 0, sec: 50 });
    expect(next).toMatchObject({ kind: "ready", telops: [telop] });
  });

  test("同じ動画に区間を足してもテロップを残す", () => {
    const next = reduce(withTelop, {
      type: "ADD_SEGMENT",
      range: { startSec: 60, endSec: 70 },
      meta,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [telop] });
  });

  test("別の動画の区間を足すとテロップも消える", () => {
    // 元動画の秒で書いたテロップが、別の動画のクリップに焼き込まれるのを防ぐ
    const other = makeVideoMeta({ videoId: "other" });
    const next = reduce(withTelop, {
      type: "ADD_SEGMENT",
      range: { startSec: 60, endSec: 70 },
      meta: other,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [] });
  });

  test("MARK_IN は常にテロップを消す", () => {
    const next = reduce(withTelop, {
      type: "MARK_IN",
      range: { startSec: 60, endSec: 70 },
      meta,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [] });
  });

  test("RESET_MARKS で消える", () => {
    expect(reduce(withTelop, { type: "RESET_MARKS" })).toEqual({ kind: "idle" });
  });

  test("録画から preview まで持ち回る", () => {
    let state = reduce(withTelop, { type: "START_RECORDING" });
    state = reduce(state, { type: "SEEK_DONE" });
    state = reduce(state, { type: "OUT_REACHED" });
    state = reduce(state, { type: "BLOB_READY", clipId: "c", mimeType: "video/mp4" });
    expect(state).toMatchObject({ kind: "preview", telops: [telop] });
  });

  test("failed から RETRY するとテロップを引き継ぐ", () => {
    const failed = reduce(withTelop, { type: "FAIL", reason: "telop-render-failed" });
    expect(failed).toMatchObject({ kind: "failed", telops: [telop] });
    expect(reduce(failed, { type: "RETRY" })).toEqual(withTelop);
  });
});
