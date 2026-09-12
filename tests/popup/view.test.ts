import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { describeState } from "@/popup/view";
import type { ClipRange, ClipState } from "@/shared/types";

const meta = makeVideoMeta();
const range: ClipRange = { startSec: 10, endSec: 40 };

describe("マーク前後", () => {
  test("idle では IN の指定を促す", () => {
    const view = describeState({ kind: "idle" });
    expect(view.message).toBe("YouTube の再生画面で IN を押してください");
  });

  test("ready では録画と取り消しができる", () => {
    const view = describeState({ kind: "ready", range, meta });
    expect(view.message).toBe("0:10 〜 0:40 (30秒) を録画できます");
  });
});

describe("録画中", () => {
  test("seeking は準備中として操作を止める", () => {
    const view = describeState({ kind: "seeking", range, meta });
    expect(view.message).toBe("開始位置へ移動しています…");
    expect(view.busy).toBe(true);
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

  test("録画できたことを伝える", () => {
    // 操作はページ内バーが持つ。popup は何が起きたかだけを映す
    expect(describeState(preview).message).toContain("録画");
  });

  test("composing は投稿画面側の操作を促しつつ抜け道を残す", () => {
    const view = describeState({
      kind: "composing",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
    });
    expect(view.message).toBe("X の投稿画面で内容を確認して投稿してください");
    // 投稿画面が開かないまま戻ってきたときに詰まないよう、必ず操作を残す
  });
});

describe("degraded path", () => {
  test("MP4 非対応は行き止まりであることを伝える", () => {
    const view = describeState({
      kind: "degraded",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/webm",
      reason: "mp4-unsupported",
    });
    // **ダウンロードへ誘導しないこと。** 取り出す道はもう無い
    expect(view.message).toBe(
      "このブラウザでは X に添付できる形式で録画できません",
    );
  });

  test("添付失敗はやり直せることを伝える", () => {
    const view = describeState({
      kind: "degraded",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
    expect(view.message).toBe(
      "X への自動添付に失敗しました。「X にもう一度投稿」でやり直せます",
    );
  });
});

describe("失敗", () => {
  test("失敗理由ごとに日本語で提示する", () => {
    const cases = [
      ["seek-failed", "開始位置へ移動できませんでした"],
      ["playback-failed", "再生を開始できませんでした"],
      ["ad-playing", "広告の再生中です。終了後にやり直してください"],
      ["tab-lost", "録画対象のタブが見つかりません"],
      ["recording-aborted", "録画が中断されました"],
      ["drm-protected", "この動画は保護されているため録画できません"],
      ["video-changed", "動画が切り替わりました。IN を押し直してください"],
      ["internal-error", "内部エラーが発生しました"],
    ] as const;

    for (const [reason, message] of cases) {
      const view = describeState({ kind: "failed", reason, range, meta });
      expect(view.message).toBe(message);
    }
  });
});

describe("popup は操作を持たない", () => {
  test("どの状態でも操作のフィールドを返さない", () => {
    // 操作はページ内バーに移した。popup は YouTube 以外のタブにいるときに
    // 状態を見る場所として残している
    const states: ClipState[] = [
      { kind: "idle" },
      { kind: "ready", range, meta },
      { kind: "preview", range, meta, clipId: "c", mimeType: "video/mp4" },
      { kind: "posted", range, meta, clipId: "c", mimeType: "video/mp4" },
      { kind: "failed", reason: "internal-error", range, meta },
    ];

    for (const state of states) {
      expect(describeState(state)).not.toHaveProperty("actions");
      expect(describeState(state)).not.toHaveProperty("showPreview");
    }
  });

  test("投稿した後は添付できたことを伝える", () => {
    expect(
      describeState({
        kind: "posted",
        range,
        meta,
        clipId: "c",
        mimeType: "video/mp4",
      }).message,
    ).toContain("X に添付しました");
  });
});
