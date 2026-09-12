# 操作をページ内へ移し、切り抜きを使い回せるようにする 実装プラン

> **実装者向け:** このプランはこのスレッドで直列に消化する。step は `- [ ]` で track する。

**Goal:** 投稿後も範囲と録画済みクリップを使い回せるようにし、操作を YouTube の
ページ内へ集約したうえで、録画を自動保存し、見た目を YouTube に馴染ませる。

**Architecture:** 状態機械に `posted` を足して投稿後の居場所を作る。操作 UI は
content script のページ内バーへ集約し、popup は状態表示だけに縮める。自動保存は
`URL.createObjectURL` が使える content script で行う。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Chrome Extension MV3

## Global Constraints

### Spec 由来 (spec から逐語コピー)

- **範囲を変えたらクリップは外す。** そのクリップは古い範囲のもので、持ち続けると
  「画面に出ている範囲」と「投稿される中身」が食い違う
- **`downloadable` → `ATTACHED` を拒む既存のガードは残す。** あれは
  「`x/failed` が二度届いて `downloadable` に落ちた後、遅れて `x/attached` が
  届く」経路を塞ぐためのもので、ここで追加する `POST` とは別の話
- **任意の絶対パスは指定できない。** 拡張からはブラウザの設定に従うのみ
- 保存に失敗しても**録画は捨てない**。理由をログに残して投稿の流れは続ける
- popup を消さないのは、**YouTube 以外のタブにいるときに状態を見る場所が
  無くなる**ため
- 変数が無くなった場合に備え、すべての色にフォールバック値を書く

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **Fail Fast**: silent skip / try-catch して続行 を禁止する。握りつぶすなら
  「なぜ握りつぶしてよいか」をコメントで説明する
  ※ 局所例外: 自動保存の失敗は握り潰して続行する。録画は実時間のコストを
  払い終えており、保存は後処理に過ぎないため (spec §3.3)
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する**
- `cd <dir> && git ...` ではなく `git -C <dir> ...` を使う
- 動画の再生位置 (秒) と壁時計時刻を混同しない
- 外部プロセス起動時は必ず timeout を設定する
- commit message の末尾に
  `Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9`

### 運用前提 (brainstorming で確定した実装方式)

- 隔離: branch のみ (worktree なし)。branch 名 `feat/in-page-controls` (作成済み)
- 並列: 直列 (SDD ではない)。このスレッドで Task 1 から順に消化する
- spec は `04d8533` で commit 済み

---

### Task 1: 状態機械に `posted` を追加する

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/background/state.ts`
- Modify: `src/popup/view.ts`
- Test: `tests/background/state.test.ts`

**Interfaces:**
- Produces: `ClipState` に `{ kind: "posted"; range; meta; clipId; mimeType }` を追加

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/state.test.ts` の末尾に追加:

```typescript
describe("投稿した後", () => {
  const posted: ClipState = {
    kind: "posted",
    range,
    meta,
    clipId: "clip-1",
    mimeType: "video/mp4",
  };

  test("添付が通ったら posted へ進み、範囲とクリップを残す", () => {
    const composing: ClipState = {
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      range,
      meta,
    };
    expect(reduce(composing, { type: "ATTACHED" })).toEqual(posted);
  });

  test("同じクリップをもう一度投稿できる", () => {
    expect(reduce(posted, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      range,
      meta,
    });
  });

  test("取り直すと範囲は残しクリップを外す", () => {
    expect(reduce(posted, { type: "RETAKE" })).toEqual({
      kind: "ready",
      range,
      meta,
    });
  });

  test("範囲を変えるとクリップを外す", () => {
    // 古い範囲のクリップを持ち続けると、画面に出ている範囲と
    // 投稿される中身が食い違う
    const moved = { startSec: 30, endSec: 45 };
    expect(reduce(posted, { type: "ADJUST_RANGE", range: moved })).toEqual({
      kind: "ready",
      range: moved,
      meta,
    });
  });

  test("OUT を打ち直してもクリップを外す", () => {
    expect(reduce(posted, { type: "MARK_OUT", sec: 40 })).toEqual({
      kind: "ready",
      range: { startSec: range.startSec, endSec: 40 },
      meta,
    });
  });

  test("新しい IN からやり直せる", () => {
    const next = { startSec: 100, endSec: 115 };
    expect(reduce(posted, { type: "MARK_IN", range: next, meta })).toEqual({
      kind: "ready",
      range: next,
      meta,
    });
  });

  test("定義していない操作は失敗として表面化させる", () => {
    expect(reduce(posted, { type: "SEEK_DONE" }).kind).toBe("failed");
  });
});

describe("添付に失敗した後", () => {
  const downloadable: ClipState = {
    kind: "downloadable",
    clipId: "clip-1",
    mimeType: "video/mp4",
    range,
    meta,
    reason: "x-attach-failed",
  };

  test("録り直さずに投稿を試し直せる", () => {
    expect(reduce(downloadable, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      mimeType: "video/mp4",
      range,
      meta,
    });
  });

  test("遅れて届いた添付完了は拒む", () => {
    // x/failed が二度届いて downloadable に落ちた後、遅れて x/attached が
    // 来る経路を塞ぐ既存のガード。上の POST とは別の話
    expect(reduce(downloadable, { type: "ATTACHED" }).kind).toBe("failed");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/state.test.ts`
期待: FAIL (`posted` が `ClipState` に無いため型エラー、または `ATTACHED` が
`idle` を返して不一致)

- [ ] **Step 3: 最小実装**

`src/shared/types.ts` の `preview` の定義の直後に追加:

```typescript
  /**
   * X へ添付し終えた状態。
   *
   * 範囲とクリップを残して**使い回せる**ようにする。同じ動画から続けて
   * 切り抜きを作る / 同じクリップを投稿し直す、どちらも日常的に起きる。
   * かつては `idle` に戻しており、範囲もクリップ参照も失われていた
   */
  | {
      kind: "posted";
      range: ClipRange;
      meta: VideoMeta;
      clipId: string;
      mimeType: string;
    }
```

`src/background/state.ts` の `composing` の `ATTACHED` を差し替え:

```typescript
      if (event.type === "ATTACHED") {
        return {
          kind: "posted",
          range: state.range,
          meta: state.meta,
          clipId: state.clipId,
          mimeType: state.mimeType,
        };
      }
```

`downloadable` の case に追加 (`RETAKE` の前):

```typescript
      // X の画面構成の変化で一度失敗しても、録り直さずに試し直せる。
      // ATTACHED を拒むガード (二度目の x/failed の後に遅れて届く経路) は
      // 別の話なので、そちらはそのまま残す
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
```

`composing` の case の直後に `posted` の case を追加:

```typescript
    case "posted":
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      // ここから下はクリップを外して ready へ戻る。**範囲を変えたら
      // クリップは外すこと。** 古い範囲のクリップを持ち続けると、画面に
      // 出ている範囲と投稿される中身が食い違う。自動保存があるので
      // ファイル自体は手元に残る
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "ADJUST_RANGE") {
        return { kind: "ready", range: event.range, meta: state.meta };
      }
      if (event.type === "MARK_OUT") {
        return {
          kind: "ready",
          range: { startSec: state.range.startSec, endSec: event.sec },
          meta: state.meta,
        };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);
```

`src/popup/view.ts` の `switch` に `posted` の case を追加 (`preview` の直後):

```typescript
    case "posted":
      return {
        message: `X に添付しました (${durationOf(
          state.range.startSec,
          state.range.endSec,
        )}秒)`,
        actions: [],
        busy: false,
        showPreview: false,
        recordingSec: null,
      };
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/state.test.ts tests/popup/view.test.ts`
期待: PASS

実行: `npm run typecheck`
期待: エラーなし (網羅性チェックが `posted` の抜けを検出しないこと)

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/types.ts src/background/state.ts src/popup/view.ts tests/background/state.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
feat: 投稿した後も範囲とクリップを使い回せるようにする

ATTACHED で idle に戻していたため、範囲もクリップ参照も失われ、
YouTube に戻ったとき IN/OUT が触れなくなっていた。posted を新設して
投稿後の居場所を作る。

範囲を変えたらクリップは外す。古い範囲のクリップを持ち続けると、
画面に出ている範囲と投稿される中身が食い違う。

あわせて downloadable からも投稿を試し直せるようにした。遅れて届く
ATTACHED を拒むガードは別の話なのでそのまま残している。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

### Task 2: 録画した動画を自動保存する

**Files:**
- Create: `src/content/save.ts`
- Modify: `src/content/youtube.ts` (`finishRecording`)
- Test: `tests/content/save.test.ts`

**Interfaces:**
- Produces: `saveToDownloads(bytes, fileName, mimeType, deps?): void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/save.test.ts` を新規作成:

```typescript
// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { saveToDownloads } from "@/content/save";

function makeDeps() {
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const revoked: string[] = [];
  return {
    anchor,
    revoked,
    deps: {
      createObjectURL: (): string => "blob:fake",
      revokeObjectURL: (url: string): void => {
        revoked.push(url);
      },
      createAnchor: () => anchor as unknown as HTMLAnchorElement,
    },
  };
}

describe("saveToDownloads", () => {
  test("ファイル名を付けて保存する", () => {
    const { anchor, deps } = makeDeps();

    saveToDownloads(
      new Uint8Array([1, 2, 3]),
      "yt-clip-abc123-10s.mp4",
      "video/mp4",
      deps,
    );

    expect(anchor.download).toBe("yt-clip-abc123-10s.mp4");
    expect(anchor.href).toBe("blob:fake");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  test("使い終わった URL を解放する", () => {
    // 解放しないと、録るたびにメモリを掴んだままになる
    const { revoked, deps } = makeDeps();

    saveToDownloads(new Uint8Array([1]), "a.mp4", "video/mp4", deps);

    expect(revoked).toEqual(["blob:fake"]);
  });

  test("保存できなくても投げない", () => {
    // 録画は実時間のコストを払い終えている。保存は後処理に過ぎないため、
    // ここで投げると録画ごと失われる
    const { deps } = makeDeps();
    const broken = {
      ...deps,
      createAnchor: () => {
        throw new Error("要素を作れません");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      saveToDownloads(new Uint8Array([1]), "a.mp4", "video/mp4", broken),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("録画を保存できませんでした"),
    );
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/save.test.ts`
期待: FAIL (`@/content/save` が存在しない)

- [ ] **Step 3: 最小実装**

`src/content/save.ts` を新規作成:

```typescript
/**
 * 録画した動画をブラウザのダウンロード先へ保存する。
 *
 * **service worker では保存できない。** MV3 の service worker は
 * `URL.createObjectURL` を持たず、Blob を指す URL を作れない。DOM のある
 * content script でアンカー要素を組み立てて保存する。
 *
 * 置き場所はブラウザの設定に従う (指定していなければ `~/Downloads`)。
 * **拡張から任意の絶対パスは指定できない。** `~/Downloads/yt-clip/` のような
 * サブフォルダを作るには offscreen document が要るため、平置きにしている。
 */

export type SaveDeps = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): HTMLAnchorElement;
};

const defaultDeps: SaveDeps = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => {
    URL.revokeObjectURL(url);
  },
  createAnchor: () => document.createElement("a"),
};

export function saveToDownloads(
  bytes: Uint8Array,
  fileName: string,
  mimeType: string,
  deps: SaveDeps = defaultDeps,
): void {
  let url: string | null = null;
  try {
    url = deps.createObjectURL(new Blob([bytes], { type: mimeType }));
    const anchor = deps.createAnchor();
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    anchor.click();
    anchor.remove();
  } catch (error) {
    // **録画は捨てない。** 実時間のコストを払い終えており、保存は後処理に
    // 過ぎない。ここで投げると録画ごと失われるので、理由だけ残して続ける
    console.warn(`[yt-clip] 録画を保存できませんでした: ${String(error)}`);
  } finally {
    if (url !== null) deps.revokeObjectURL(url);
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/save.test.ts`
期待: PASS (3 件)

- [ ] **Step 5: 録画の流れに繋ぐ**

`src/content/youtube.ts` の import に追加:

```typescript
import { saveToDownloads } from "@/content/save";
```

`finishRecording` の `notify({ type: "recorder/done", ... })` の**直前**に追加:

```typescript
    // 投稿の成否に関わらず手元に残す。添付が失敗しても録り直さずに済む
    saveToDownloads(bytes, buildClipFileName(meta.videoId, range.startSec, blob.type), blob.type);
```

`finishRecording` は範囲を引数で受け取らないが、content script は既に
`currentRange` (いま指定されている範囲) と `rangeVideoId` (その範囲を作った
動画) をモジュール変数として持っている。**新しい変数を足さず、これを使う。**
どちらかが null のときは保存を飛ばす:

```typescript
    // 範囲を作った動画が分からなければファイル名を組み立てられない。
    // 録画まで来ていれば通常は揃っているが、揃わないまま保存はしない
    if (currentRange !== null && rangeVideoId !== null) {
      saveToDownloads(
        bytes,
        buildClipFileName(rangeVideoId, currentRange.startSec, blob.type),
        blob.type,
      );
    }
```

`buildClipFileName` は `src/shared/filename.ts` から import する。

- [ ] **Step 6: 通過を確認**

実行: `npm run typecheck && npx vitest run tests/content`
期待: エラーなし / PASS

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/save.ts src/content/youtube.ts tests/content/save.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
feat: 録画した動画を自動で保存する

録画が終わった時点で保存する。投稿の成否に関わらず手元に残るので、
添付に失敗しても録り直さずに済む。

service worker では保存できない。MV3 の service worker は
URL.createObjectURL を持たず Blob を指す URL を作れないため、DOM のある
content script で行う。

保存に失敗しても録画は捨てない。実時間のコストを払い終えており、
保存は後処理に過ぎない。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

### Task 3: 操作ボタンをページ内バーへ移す

**Files:**
- Create: `src/content/actions.ts`
- Modify: `src/content/youtube.ts`
- Test: `tests/content/actions.test.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 1 の `posted`
- Produces: `actionsFor(kind): BarAction[]`、`ACTION_LABELS`、`ACTION_EVENTS`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/actions.test.ts` を新規作成:

```typescript
import { describe, expect, test } from "vitest";
import { ACTION_EVENTS, ACTION_LABELS, actionsFor } from "@/content/actions";

describe("actionsFor", () => {
  test("範囲ができたら録画できる", () => {
    expect(actionsFor("ready")).toEqual(["record"]);
  });

  test("進行中は操作を出さない", () => {
    // 押しても状態機械に拒まれるだけなので、出さない
    expect(actionsFor("seeking")).toEqual([]);
    expect(actionsFor("recording")).toEqual([]);
    expect(actionsFor("encoding")).toEqual([]);
  });

  test("録画できたら投稿か取り直し", () => {
    expect(actionsFor("preview")).toEqual(["post", "retake"]);
  });

  test("投稿した後はもう一度投稿できる", () => {
    expect(actionsFor("posted")).toEqual(["repost", "retake"]);
  });

  test("添付に失敗した後も投稿を試し直せる", () => {
    expect(actionsFor("downloadable")).toEqual(["repost", "retake"]);
  });

  test("投稿待ちからは抜けられる", () => {
    expect(actionsFor("composing")).toEqual(["retake"]);
  });

  test("失敗したら再試行", () => {
    expect(actionsFor("failed")).toEqual(["retry"]);
  });

  test("何も指定していなければ操作は出さない", () => {
    expect(actionsFor("idle")).toEqual([]);
  });
});

describe("操作の定義", () => {
  test("すべての操作に文言と送るイベントがある", () => {
    const all = new Set(
      (
        [
          "idle",
          "ready",
          "seeking",
          "recording",
          "encoding",
          "preview",
          "composing",
          "posted",
          "downloadable",
          "failed",
        ] as const
      ).flatMap((kind) => actionsFor(kind)),
    );

    for (const action of all) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(ACTION_EVENTS[action]).toBeTruthy();
    }
  });

  test("再投稿は投稿と同じイベントを送る", () => {
    // 状態機械から見れば同じ POST。文言だけが違う
    expect(ACTION_EVENTS.repost).toEqual(ACTION_EVENTS.post);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/actions.test.ts`
期待: FAIL (`@/content/actions` が存在しない)

- [ ] **Step 3: 最小実装**

`src/content/actions.ts` を新規作成:

```typescript
import type { ClipEvent, ClipState } from "@/shared/types";

/**
 * ページ内バーに出す操作。
 *
 * IN / OUT / 範囲を見る は状態に関わらず常に出ている別枠なので、ここには
 * 含めない。ここに並ぶのは「いまの状態でだけ意味を持つ操作」。
 */
export type BarAction = "record" | "post" | "repost" | "retake" | "retry";

export const ACTION_LABELS: Record<BarAction, string> = {
  record: "● 録画",
  post: "X に投稿",
  repost: "X にもう一度投稿",
  retake: "取り直す",
  retry: "再試行",
};

/** 状態機械から見れば repost も post も同じ POST。文言だけが違う */
export const ACTION_EVENTS: Record<BarAction, ClipEvent> = {
  record: { type: "START_RECORDING" },
  post: { type: "POST" },
  repost: { type: "POST" },
  retake: { type: "RETAKE" },
  retry: { type: "RETRY" },
};

/** その状態で出す操作。網羅性は switch で保証する */
export function actionsFor(kind: ClipState["kind"]): BarAction[] {
  switch (kind) {
    case "idle":
      return [];
    case "ready":
      return ["record"];
    // 進行中は押しても状態機械に拒まれるだけなので出さない
    case "seeking":
    case "recording":
    case "encoding":
      return [];
    case "preview":
      return ["post", "retake"];
    case "composing":
      return ["retake"];
    case "posted":
      return ["repost", "retake"];
    case "downloadable":
      return ["repost", "retake"];
    case "failed":
      return ["retry"];
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/actions.test.ts`
期待: PASS (10 件)

- [ ] **Step 5: バーに繋ぐ**

`src/content/youtube.ts` の `buildBar` に、操作ボタンを入れる箱を足す:

```typescript
  const actionsRow = document.createElement("div");
  actionsRow.id = `${BAR_ID}-actions`;
  actionsRow.style.cssText = "display:flex;gap:8px;align-items:center;";
```

`row.append(inButton, outButton, playButton, status);` を
`row.append(inButton, outButton, playButton, actionsRow, status);` に変える。

`applyStateToDisplay` の中で、状態に応じて中身を作り直す:

```typescript
  // 操作は状態ごとに変わる。押せない操作を出して拒まれるより、出さない
  const actions = document.getElementById(`${BAR_ID}-actions`);
  if (actions !== null) {
    actions.replaceChildren(
      ...actionsFor(state.kind).map((action) => {
        const button = document.createElement("button");
        button.textContent = ACTION_LABELS[action];
        button.addEventListener("click", guard(() => send(ACTION_EVENTS[action])));
        return button;
      }),
    );
  }
```

import を追加:

```typescript
import { ACTION_EVENTS, ACTION_LABELS, actionsFor } from "@/content/actions";
```

- [ ] **Step 6: 出し分けのテストを足す**

`tests/content/youtube.test.ts` に追加:

```typescript
  test("状態ごとに出る操作が変わる", () => {
    const labels = (): string[] =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>("#yt-clip-bar-actions button"),
      ).map((button) => button.textContent ?? "");

    emit({ kind: "ready", range: RANGE, meta: META_A });
    expect(labels()).toEqual(["● 録画"]);

    emit({ kind: "recording", range: RANGE, meta: META_A });
    expect(labels()).toEqual([]);

    emit({
      kind: "posted",
      range: RANGE,
      meta: META_A,
      clipId: "clip-1",
      mimeType: "video/mp4",
    });
    expect(labels()).toEqual(["X にもう一度投稿", "取り直す"]);
  });

  test("操作を押すと状態機械へイベントが飛ぶ", () => {
    emit({ kind: "ready", range: RANGE, meta: META_A });
    document
      .querySelector<HTMLButtonElement>("#yt-clip-bar-actions button")
      ?.click();

    expect(clipEvents()).toContainEqual({ type: "START_RECORDING" });
  });
```

- [ ] **Step 7: 通過を確認**

実行: `npm run typecheck && npx vitest run`
期待: エラーなし / 全件 PASS

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/actions.ts src/content/youtube.ts tests/content/actions.test.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
feat: 操作ボタンをページ内バーへ移す

録画・投稿・取り直し・再試行を YouTube のページ内で完結させる。
状態ごとに出す操作を切り替え、押しても拒まれるだけの操作は出さない。

状態機械から見れば「もう一度投稿」も「投稿」も同じ POST で、
文言だけが違う。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

### Task 4: popup を状態表示だけにする

**Files:**
- Modify: `src/popup/view.ts`
- Modify: `src/popup/popup.ts`
- Modify: `src/popup/popup.html`
- Test: `tests/popup/view.test.ts`

**Interfaces:**
- Produces: `PopupView` から `actions` と `showPreview` を削除

- [ ] **Step 1: 失敗するテストを書く**

`tests/popup/view.test.ts` の既存の `actions` / `showPreview` への参照を消し、
末尾に追加:

```typescript
describe("popup は操作を持たない", () => {
  test("どの状態でも操作を返さない", () => {
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
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/popup/view.test.ts`
期待: FAIL (`actions` プロパティが残っている)

- [ ] **Step 3: 最小実装**

`src/popup/view.ts`:

- `PopupAction` 型と `actions` フィールドを削除
- `showPreview` フィールドを削除
- 全 case から `actions: [...]` と `showPreview: ...` の行を削除

`PopupView` は以下になる:

```typescript
export type PopupView = {
  message: string;
  /** 進行中で操作を受け付けない状態か。文言に「…」を添えるかの判断に使う */
  busy: boolean;
  recordingSec: number | null;
};
```

`src/popup/popup.ts`:

- `ACTION_LABELS` / `ACTION_EVENTS` / `actionsElement` / `setActionsDisabled` /
  `download` / `send` を削除
- `render` を文言と進捗だけにする:

```typescript
function render(state: ClipState): void {
  const view = describeState(state);
  messageElement.textContent = view.message;
  updateProgress(view);
}
```

- `chrome.downloads` を使っていた処理が消えるため、`manifest.config.ts` の
  `permissions` から `"downloads"` を外す

`src/popup/popup.html`:

- `<video id="preview">` と `<div id="actions">` を削除

- [ ] **Step 4: 通過を確認**

実行: `npm run typecheck && npx vitest run`
期待: エラーなし / 全件 PASS

実行: `npm run build`
期待: 成功

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/popup manifest.config.ts tests/popup/view.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
refactor: popup を状態表示だけにする

操作はページ内バーへ移した。popup を消さないのは、YouTube 以外のタブに
いるときに状態を見る場所が無くなるため。X の投稿画面で添付に失敗した
場面が実際にこれに当たる。

クリップの再生も外す。拡張の IndexedDB はページ側から読めず、ページ内で
再生するには数 MB の再送か Blob の常駐が要る。自動保存でファイルは必ず
手元にあり、添付が通れば X の画面でも再生できる。

ダウンロード処理が消えたので downloads 権限も外す。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

### Task 5: 拡大バーの見た目と現在位置マーカー

**Files:**
- Create: `src/content/styles.ts`
- Modify: `src/content/range-bar.ts`
- Modify: `src/content/youtube.ts`
- Test: `tests/content/range-bar.test.ts`

**Interfaces:**
- Produces: `RangeBar.setPlayhead(sec: number | null): void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/range-bar.test.ts` に追加:

```typescript
describe("現在の再生位置", () => {
  test("窓の中なら位置を示す", () => {
    const bar = createRangeBar({ onScrub: () => undefined, onCommit: () => undefined });
    bar.update({ startSec: 30, endSec: 45 }, 600);

    bar.setPlayhead(37.5);

    const playhead = bar.element.querySelector<HTMLElement>("[data-role=playhead]");
    expect(playhead?.hidden).toBe(false);
    // 窓は範囲の 2 倍か 30 秒の広い方。ここでは 30 秒 (22.5〜52.5)
    expect(playhead?.style.left).toBe("50%");
  });

  test("窓の外なら隠す", () => {
    const bar = createRangeBar({ onScrub: () => undefined, onCommit: () => undefined });
    bar.update({ startSec: 30, endSec: 45 }, 600);

    bar.setPlayhead(5);

    expect(
      bar.element.querySelector<HTMLElement>("[data-role=playhead]")?.hidden,
    ).toBe(true);
  });

  test("位置が分からないときは隠す", () => {
    const bar = createRangeBar({ onScrub: () => undefined, onCommit: () => undefined });
    bar.update({ startSec: 30, endSec: 45 }, 600);

    bar.setPlayhead(null);

    expect(
      bar.element.querySelector<HTMLElement>("[data-role=playhead]")?.hidden,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/range-bar.test.ts`
期待: FAIL (`setPlayhead` が無い)

- [ ] **Step 3: 見た目の定義をまとめる**

`src/content/styles.ts` を新規作成:

```typescript
/**
 * ページ内 UI の見た目。
 *
 * YouTube の CSS 変数に寄せ、ダーク / ライトへ自動で追従させる。**すべての色に
 * フォールバック値を書くこと。** YouTube 側が変数名を変えたときに色が消えると、
 * 操作できるのに見えないという最悪の壊れ方をする。
 */

const TEXT = "var(--yt-spec-text-primary,#0f0f0f)";
const TEXT_SUB = "var(--yt-spec-text-secondary,#606060)";
const SURFACE = "var(--yt-spec-badge-chip-background,#f2f2f2)";
const ACCENT = "var(--yt-spec-call-to-action,#065fd4)";
const CALL_TO_ACTION_TEXT = "var(--yt-spec-static-brand-white,#fff)";

export const BAR_STYLE = {
  root: `display:flex;flex-direction:column;gap:10px;padding:12px 0;color:${TEXT};font-family:Roboto,"Noto Sans JP",sans-serif;font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
  status: `color:${TEXT_SUB};font-size:12px;`,
  /** 主操作。塗りつぶす */
  primaryButton: `appearance:none;border:none;border-radius:18px;height:36px;padding:0 16px;font:inherit;font-weight:500;cursor:pointer;background:${ACCENT};color:${CALL_TO_ACTION_TEXT};`,
  /** 副操作。輪郭だけ */
  secondaryButton: `appearance:none;border:1px solid ${TEXT_SUB};border-radius:18px;height:36px;padding:0 16px;font:inherit;font-weight:500;cursor:pointer;background:transparent;color:${TEXT};`,
} as const;

export const RANGE_STYLE = {
  root: `display:flex;align-items:center;gap:10px;font-size:12px;color:${TEXT_SUB};`,
  track: `position:relative;flex:1;height:32px;background:${SURFACE};border-radius:6px;cursor:pointer;`,
  /** 選択範囲の外側。暗くして範囲を際立たせる */
  shade: "position:absolute;top:0;bottom:0;background:rgba(0,0,0,0.35);pointer-events:none;",
  selection: `position:absolute;top:0;bottom:0;background:${ACCENT};opacity:0.25;pointer-events:none;`,
  /**
   * ハンドル。見た目は細いが、透明な余白で当たり判定を広げる。
   * 掴めないと範囲を追い込めない
   */
  handle: `position:absolute;top:-3px;bottom:-3px;width:24px;margin-left:-12px;cursor:ew-resize;touch-action:none;background:transparent;display:flex;align-items:center;justify-content:center;`,
  handleGrip: `width:6px;height:100%;border-radius:3px;background:${ACCENT};box-shadow:0 0 0 1px rgba(0,0,0,0.2);`,
  playhead: `position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:${TEXT};pointer-events:none;`,
  disabled: "opacity:0.4;pointer-events:none;",
} as const;
```

- [ ] **Step 4: 最小実装**

`src/content/range-bar.ts`:

- `STYLE` を `RANGE_STYLE` の import に差し替える
- `RangeBar` 型に `setPlayhead(sec: number | null): void` を足す
- 再生位置の要素を作る:

```typescript
  const playhead = document.createElement("div");
  playhead.dataset.role = "playhead";
  playhead.style.cssText = RANGE_STYLE.playhead;
  playhead.hidden = true;
```

- 選択範囲の外側を暗くする 2 枚を作る:

```typescript
  const shadeBefore = document.createElement("div");
  shadeBefore.style.cssText = RANGE_STYLE.shade;
  const shadeAfter = document.createElement("div");
  shadeAfter.style.cssText = RANGE_STYLE.shade;
```

- `track.append(...)` に `shadeBefore` / `shadeAfter` / `playhead` を足す
  (暗幕はハンドルより先に置き、ハンドルが隠れないようにする)
- `paint()` の末尾で暗幕の幅を更新する:

```typescript
    shadeBefore.style.left = "0";
    shadeBefore.style.width = `${inRatio * 100}%`;
    shadeAfter.style.left = `${outRatio * 100}%`;
    shadeAfter.style.width = `${(1 - outRatio) * 100}%`;
```
- ハンドルは掴み代の中に芯を入れる:

```typescript
  for (const handle of [inHandle, outHandle]) {
    const grip = document.createElement("div");
    grip.style.cssText = RANGE_STYLE.handleGrip;
    handle.append(grip);
  }
```

- `setPlayhead` を実装して返り値に足す:

```typescript
    setPlayhead(sec: number | null): void {
      if (sec === null) {
        playhead.hidden = true;
        return;
      }
      const ratio = timeToRatio(sec, window_);
      // 窓の外は示しようがない。潰れた目盛りを出すより隠す
      if (ratio < 0 || ratio > 1) {
        playhead.hidden = true;
        return;
      }
      playhead.hidden = false;
      playhead.style.left = `${ratio * 100}%`;
    },
```

`src/content/youtube.ts`:

- ボタンを作る場所を 1 つにまとめ、主操作かどうかで見た目を分ける:

```typescript
/** 主操作は塗り、副操作は輪郭だけ。押してほしいものを 1 つに絞る */
const PRIMARY_ACTIONS: ReadonlySet<BarAction> = new Set(["record", "post", "repost"]);

function makeButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.style.cssText = primary
    ? BAR_STYLE.primaryButton
    : BAR_STYLE.secondaryButton;
  button.addEventListener("click", guard(onClick));
  return button;
}
```

- `buildBar` の IN / OUT / 範囲を見る も `makeButton(label, false, ...)` に
  差し替える (これらは常に出る副操作)
- Task 3 で書いた操作ボタンの組み立ても `makeButton` を使うよう直す:

```typescript
      ...actionsFor(state.kind).map((action) =>
        makeButton(ACTION_LABELS[action], PRIMARY_ACTIONS.has(action), () =>
          send(ACTION_EVENTS[action]),
        ),
      ),
```

- バー本体と行に `BAR_STYLE.root` / `BAR_STYLE.row`、状態の文言に
  `BAR_STYLE.status` を当てる
- 再生位置を流し込む。`timeupdate` では粗いので
  `requestVideoFrameCallback` を使い、バーが無効なときは止める:

```typescript
/** 再生位置をバーへ流し続ける。動画が変わったら張り直す */
function watchPlayhead(): void {
  let handle: number | null = null;
  const step = (): void => {
    try {
      rangeBar?.setPlayhead(getVideo().currentTime);
    } catch {
      // 動画要素はまだ無いか、差し替えの最中。次のフレームで見直す
      rangeBar?.setPlayhead(null);
    }
    handle = requestAnimationFrame(step);
  };
  if (handle === null) step();
}
```

`mount()` の最後で `watchPlayhead()` を呼ぶ。

- [ ] **Step 5: 通過を確認**

実行: `npm run typecheck && npx vitest run`
期待: エラーなし / 全件 PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content tests/content/range-bar.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
feat: 拡大バーを YouTube に馴染ませ、現在の再生位置を示す

見た目の定義を styles.ts にまとめ、YouTube の CSS 変数へ寄せた。
ダーク/ライトに自動で追従する。すべての色にフォールバック値を書いた。
変数名が変わって色が消えると、操作できるのに見えないという最悪の
壊れ方をするため。

拡大バーに現在の再生位置を出す。ハンドルは見た目を変えずに透明な余白で
当たり判定を広げた。掴めないと範囲を追い込めない。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

### Task 6: 手動確認項目を更新する

**Files:**
- Modify: `docs/manual-check.md`
- Modify: `README.md`

- [ ] **Step 1: 古くなった項目を消す**

`docs/manual-check.md` から削除する項目:

- popup の操作ボタンに関するもの (録画 / 投稿 / 取り直し / 再試行 / 取り消し)
- popup のクリップ再生に関するもの
- ダウンロードボタンに関するもの

**残すと「無くなった機能を確認しようとして混乱する」ため消す。** 削る前に
該当の処理が `src/` に無いことを grep で確かめること。

- [ ] **Step 2: 項目を足す**

```markdown
## 投稿した後の使い回し

- [ ] 投稿まで通した後、YouTube のタブに戻ると**拡大バーがそのまま操作できる**
- [ ] 「X にもう一度投稿」で、録り直さずに同じクリップを投稿できる
- [ ] ハンドルを動かすと `ready` に戻り、「録画」が出る (クリップは外れる)
- [ ] 添付に失敗した後 (`downloadable`) も「X にもう一度投稿」が出る

## 自動保存

- [ ] 録画が終わるとブラウザのダウンロード先にファイルが増える
- [ ] ファイル名が X へ添付されるものと同じ
- [ ] 投稿に失敗してもファイルは残っている
- [ ] 取り直すたびにファイルが増える (仕様。消すのは利用者に委ねる)

## 見た目

- [ ] **ダークテーマとライトテーマの両方**で、文字とボタンが読める
- [ ] YouTube のボタンと並べて浮いていない
- [ ] 拡大バーに現在の再生位置が出て、再生に追従する
- [ ] ハンドルが掴みやすい (細い芯の周りに余白があり、狙わなくても掴める)
- [ ] 全画面表示やシアターモードに切り替えてもバーが壊れない
```

- [ ] **Step 3: README を更新**

- popup の説明を「状態表示のみ」に直す
- 自動保存の節を足す (置き場所がブラウザの設定に従うこと、サブフォルダを
  作れないこと、取り直すたびに増えること)

- [ ] **Step 4: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md README.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'EOF'
docs: ページ内操作と自動保存を確認項目に反映する

popup の操作・クリップ再生・ダウンロードは無くなったので削除する。
残すと無くなった機能を確認しようとして混乱する。

投稿後の使い回し、自動保存、見た目の確認項目を足した。見た目は
ダークとライトの両方で見ることを明示している。

Claude-Session: https://claude.ai/code/session_01JrbmsmCfrB5o6c1kyhnvh9
EOF
)"
```

---

## 最後に通すゲート

全 Task 完了後に 1 度だけ:

```bash
cd /Users/trapple/repos/github.com/trapple/yt-clip
npm run typecheck && npm test && npm run e2e && npm run build
```

期待: 型エラーなし / 全件 PASS / E2E 3 件 PASS / ビルド成功

E2E は実際の YouTube に接続するため、timeout を付けて実行すること。
