import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { describeState, describeSwitch } from "@/popup/view";
import type { ClipRange, ClipState } from "@/shared/types";

const meta = makeVideoMeta();
const range: ClipRange = { startSec: 10, endSec: 40 };
const segments = [range];

describe("マーク前後", () => {
  test("idle では IN の指定を促す", () => {
    const view = describeState({ kind: "idle" });
    expect(view.message).toBe("YouTube の再生画面で IN を押してください");
  });

  test("ready では録画と取り消しができる", () => {
    const view = describeState({ kind: "ready", segments, telops: [], meta });
    expect(view.message).toBe("0:10 〜 0:40 (30秒) を録画できます");
  });
});

describe("録画中", () => {
  test("seeking は準備中として操作を止める", () => {
    const view = describeState({ kind: "seeking", segments, telops: [], meta });
    expect(view.message).toBe("開始位置へ移動しています…");
    expect(view.busy).toBe(true);
  });

  test("recording はクリップの長さを返し popup が残りを数える", () => {
    const view = describeState({ kind: "recording", segments, telops: [], meta });
    expect(view.message).toBe("録画中…");
    expect(view.busy).toBe(true);
    expect(view.recordingSec).toBe(30);
  });

  test("録画中以外は残り時間を数えない", () => {
    expect(describeState({ kind: "idle" }).recordingSec).toBeNull();
    expect(
      describeState({ kind: "seeking", segments, telops: [], meta }).recordingSec,
    ).toBeNull();
    expect(
      describeState({ kind: "encoding", segments, telops: [], meta }).recordingSec,
    ).toBeNull();
  });

  test("encoding は書き出し中として扱う", () => {
    const view = describeState({ kind: "encoding", segments, telops: [], meta });
    expect(view.message).toBe("録画を書き出しています…");
    expect(view.busy).toBe(true);
  });
});

describe("プレビューと投稿", () => {
  const preview: ClipState = {
    kind: "preview",
    clipId: "clip-1",
    segments,
    telops: [],
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
      segments,
      telops: [],
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
      segments,
      telops: [],
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
      segments,
      telops: [],
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
      const view = describeState({ kind: "failed", reason, segments, telops: [], meta });
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
      { kind: "ready", segments, telops: [], meta },
      { kind: "preview", segments, telops: [], meta, clipId: "c", mimeType: "video/mp4" },
      { kind: "posted", segments, telops: [], meta, clipId: "c", mimeType: "video/mp4" },
      { kind: "failed", reason: "internal-error", segments, telops: [], meta },
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
        segments,
        telops: [],
        meta,
        clipId: "c",
        mimeType: "video/mp4",
      }).message,
    ).toContain("X に添付しました");
  });
});

describe("複数区間の表示", () => {
  const two = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  test("1 区間なら今までどおり範囲で出す", () => {
    const view = describeState({ kind: "ready", segments, telops: [], meta });
    expect(view.message).toContain("0:10");
    expect(view.message).toContain("0:40");
  });

  test("複数区間なら区間数と合計で出す", () => {
    const view = describeState({ kind: "ready", segments: two, telops: [], meta });
    expect(view.message).toBe("2 区間 / 23 秒 を録画できます");
  });

  test("録画中の長さは合計で数える", () => {
    // 元動画上の幅 (242-83=159) ではない
    const view = describeState({ kind: "recording", segments: two, telops: [], meta });
    expect(view.recordingSec).toBe(23);
  });

  test("投稿後の長さも合計で数える", () => {
    const view = describeState({
      kind: "posted",
      segments: two,
      telops: [],
      meta,
      clipId: "c",
      mimeType: "video/mp4",
    });
    expect(view.message).toContain("23秒");
  });
});

describe("オン / オフのスイッチ (describeSwitch)", () => {
  const clip = { clipId: "c", mimeType: "video/mp4" };
  /** 状態機械のすべての種類 */
  const ALL_STATES: ClipState[] = [
    { kind: "idle" },
    { kind: "ready", segments, telops: [], meta },
    { kind: "seeking", segments, telops: [], meta },
    { kind: "recording", segments, telops: [], meta },
    { kind: "encoding", segments, telops: [], meta },
    { kind: "preview", segments, telops: [], meta, ...clip },
    { kind: "posted", segments, telops: [], meta, ...clip },
    { kind: "composing", segments, telops: [], meta, ...clip },
    { kind: "degraded", segments, telops: [], meta, ...clip, reason: "x-attach-failed" },
    { kind: "failed", reason: "internal-error", segments, telops: [], meta },
  ];
  const OFF = "オフです。YouTube と X のページには何も出ません";
  const CANCELLING = "オフにします。録画を中止しています…";
  const WAITING_ENCODE = "オフにします。書き出しが済んだら止まります…";
  const CLIP_KEPT = "録画したクリップは残っています (オンに戻すと続きから)";

  test("オンでは状態を出し、代わりの文言も添える 1 行も出さない", () => {
    for (const state of ALL_STATES) {
      expect(describeSwitch(true, state)).toEqual({
        checked: true,
        hint: null,
        showState: true,
        note: null,
      });
    }
  });

  test("オフでは状態を出さず「オフです。…」", () => {
    for (const kind of ["idle", "ready", "composing", "failed"] as const) {
      const state = ALL_STATES.find((candidate) => candidate.kind === kind);
      const view = describeSwitch(false, state ?? null);
      expect(view.showState).toBe(false);
      expect(view.hint).toBe(OFF);
    }
  });

  test("オフ + seeking / recording は「録画を中止しています…」、オフ + encoding は「書き出しが済んだら止まります…」", () => {
    expect(describeSwitch(false, { kind: "seeking", segments, telops: [], meta }).hint).toBe(CANCELLING);
    expect(describeSwitch(false, { kind: "recording", segments, telops: [], meta }).hint).toBe(CANCELLING);
    expect(describeSwitch(false, { kind: "encoding", segments, telops: [], meta }).hint).toBe(WAITING_ENCODE);
  });

  test("オフ + preview / posted / degraded はクリップが残っている旨を添える。ready / idle では添えない", () => {
    for (const kind of ["preview", "posted", "degraded"] as const) {
      const state = ALL_STATES.find((candidate) => candidate.kind === kind) ?? null;
      expect(describeSwitch(false, state).note).toBe(CLIP_KEPT);
    }
    for (const kind of ["ready", "idle"] as const) {
      const state = ALL_STATES.find((candidate) => candidate.kind === kind) ?? null;
      expect(describeSwitch(false, state).note).toBeNull();
    }
  });

  test("状態を取得できていなくても (null) スイッチを出せる", () => {
    expect(describeSwitch(false, null)).toEqual({ checked: false, hint: OFF, showState: false, note: null });
    expect(describeSwitch(true, null)).toEqual({ checked: true, hint: null, showState: true, note: null });
  });

  test("押せるかを持たない (disabled が無い)。checked は enabled だけで決まる (全状態 × オン / オフ。オフ + busy でも戻せる)", () => {
    for (const state of [...ALL_STATES, null]) {
      for (const enabled of [true, false]) {
        const view = describeSwitch(enabled, state);
        expect(Object.keys(view).sort()).toEqual(["checked", "hint", "note", "showState"]);
        expect(view.checked).toBe(enabled);
      }
    }
  });
});
