import { describe, expect, test } from "vitest";
import { describeState } from "@/popup/view";
import type { ClipRange, ClipState, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "abc123", title: "テスト動画" };
const range: ClipRange = { startSec: 10, endSec: 40 };

describe("マーク前後", () => {
  test("idle では IN の指定を促す", () => {
    const view = describeState({ kind: "idle" });
    expect(view.message).toBe("YouTube の再生画面で IN を押してください");
    expect(view.actions).toEqual([]);
  });

  test("marking では OUT の指定を促す", () => {
    const view = describeState({ kind: "marking", startSec: 10, meta });
    expect(view.message).toBe("0:10 から開始。OUT を押してください");
    expect(view.actions).toEqual([]);
  });

  test("ready では録画と取り消しができる", () => {
    const view = describeState({ kind: "ready", range, meta });
    expect(view.message).toBe("0:10 〜 0:40 (30秒) を録画できます");
    expect(view.actions).toEqual(["record", "reset"]);
  });
});

describe("録画中", () => {
  test("seeking は準備中として操作を止める", () => {
    const view = describeState({ kind: "seeking", range, meta });
    expect(view.message).toBe("開始位置へ移動しています…");
    expect(view.busy).toBe(true);
    expect(view.actions).toEqual([]);
  });

  test("recording はクリップの長さを返し popup が残りを数える", () => {
    const view = describeState({ kind: "recording", range, meta });
    expect(view.message).toBe("録画中…");
    expect(view.busy).toBe(true);
    expect(view.recordingSec).toBe(30);
  });

  test("録画中以外は残り時間を数えない", () => {
    expect(describeState({ kind: "idle" }).recordingSec).toBeNull();
    expect(
      describeState({ kind: "seeking", range, meta }).recordingSec,
    ).toBeNull();
    expect(
      describeState({ kind: "encoding", range, meta }).recordingSec,
    ).toBeNull();
  });

  test("encoding は書き出し中として扱う", () => {
    const view = describeState({ kind: "encoding", range, meta });
    expect(view.message).toBe("録画を書き出しています…");
    expect(view.busy).toBe(true);
  });
});

describe("プレビューと投稿", () => {
  const preview: ClipState = {
    kind: "preview",
    clipId: "clip-1",
    range,
    meta,
    mimeType: "video/mp4",
  };

  test("preview では投稿と取り直しができる", () => {
    const view = describeState(preview);
    expect(view.showPreview).toBe(true);
    expect(view.actions).toEqual(["post", "retake"]);
  });

  test("composing は投稿画面側の操作を促す", () => {
    const view = describeState({
      kind: "composing",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
    });
    expect(view.message).toBe("X の投稿画面で内容を確認して投稿してください");
    expect(view.actions).toEqual([]);
  });
});

describe("degraded path", () => {
  test("MP4 非対応は spec の文言でダウンロードへ誘導する", () => {
    const view = describeState({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/webm",
      reason: "mp4-unsupported",
    });
    expect(view.message).toBe(
      "この環境では X に直接添付できません。変換してご利用ください",
    );
    expect(view.actions).toEqual(["download", "retake"]);
    expect(view.showPreview).toBe(true);
  });

  test("添付失敗は spec の文言で手動添付へ誘導する", () => {
    const view = describeState({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
    expect(view.message).toBe(
      "X の画面構成が変わったため自動添付できませんでした。ファイルをダウンロードして手動で添付してください",
    );
    expect(view.actions).toEqual(["download", "retake"]);
  });
});

describe("失敗", () => {
  test("失敗理由ごとに日本語で提示する", () => {
    const cases = [
      ["capture-permission-denied", "タブの録画が許可されませんでした"],
      ["seek-failed", "開始位置へ移動できませんでした"],
      ["playback-failed", "再生を開始できませんでした"],
      ["ad-playing", "広告の再生中です。終了後にやり直してください"],
      ["tab-lost", "録画対象のタブが見つかりません"],
      ["recording-aborted", "録画が中断されました"],
      ["internal-error", "内部エラーが発生しました"],
    ] as const;

    for (const [reason, message] of cases) {
      const view = describeState({ kind: "failed", reason, range, meta });
      expect(view.message).toBe(message);
      expect(view.actions).toEqual(["retry"]);
    }
  });
});
