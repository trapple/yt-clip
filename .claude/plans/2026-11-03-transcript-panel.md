# 文字起こしの欄 (段階 1b-2) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 区間・テロップの窓の先頭に「文字起こしの欄」を出し、行を押すと区間に入る / 外れる、入った行の文字がそのままテロップになるようにする。区間はいつも動画の時間順に繋ぐ。

**Architecture:** 行の選び方から「区間とテロップの組」を計算する純粋な関数 (`transcript-selection.ts`) を置き、結果を新しいイベント `SET_CLIP` で状態機械にまとめて渡す。状態機械は区間をいつも開始の早い順に並べる (`readyWith`)。欄の見た目は `transcript-panel.ts` が持ち、渡された行を描いて押されたことを伝えるだけ (選択は状態機械の区間から決まる)。並べ替えで区間の位置 (index) が動くので、`youtube.ts` は「次に届いた状態でこの範囲の区間を選ぶ」形で選択を追い、受理の判定も位置ではなく範囲で見る。

**Tech Stack:** TypeScript、vitest (jsdom)、Playwright (e2e は触らない見込み)

## 段階 1 の分け方

| | 中身 | 状態 |
|---|---|---|
| 1a | 公式字幕の取得・保存・吹き替えの判定 | 済み |
| 1b-1 | モードの廃止 | 済み |
| **1b-2 (この plan)** | 文字起こしの欄・行で区間とテロップを作る・区間は時間順 | |
| 1c | 詰める欄・拡大バー / 帯 / 区間とテロップの一覧の撤去・文字起こしが無いときの道・欄の検索 | |

**区間の一覧とテロップの一覧は、この plan では残す** (欄の下に並ぶ)。一度に入れ替えると、テストの直しと差分が大きくなりすぎる。区間の選択・▶・✕・合計、テロップの手入力 (＋ テロップ・開始を今に・終了を今に) は、1c で詰める欄に移すまで一覧が受け持つ。欄の検索 (モックの「文字起こしを検索」) も 1c に回す。

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- ADR 0001 (`docs/adr/0001-transcript-first-editor.md`) の Decision:
  - 「文字起こしの行を選ぶと、続いた行が 1 つの区間になり、行の文字がそのままテロップになる。テロップの時刻は行の時刻を使い、人は合わせない」
  - 「区間は動画の時間順に繋ぐ (回答 2026-10-26「1ok」)」
  - 「吹き替えの音声が流れていたら知らせるだけ (回答 2026-10-26「4 知らせるだけ」)」
- 第 2 版のモック (2026-10-25 了承) の欄の操作: 行のクリックで選ぶ / 外す、Shift+クリックでまとめて選ぶ、選んだ行のダブルクリックで文字を直す、「字幕に出さない」、再生中の行に ▶、行の時刻を押すとその行から再生、取れない範囲・取れないときの案内
  - **この plan で変えるもの:** 文字を直すのはダブルクリックではなく選んだ行の ✎ (ダブルクリックは行のクリックと両立しない。自律判断ログ)
  - **この plan に入れないもの:** 「取れない範囲」は段階 4 (PC 内の音声認識は再生した所しか取れない) の案内。1b-2 の公式字幕は動画全体を一度に取るので、案内は「取っている間・字幕が無い・取れなかった」だけ
- 区間の端の余白: 頭は行の開始の 0.2 秒前、尻は行の終了の 0.3 秒後。隣の行に食い込む分は取らない (1b の検討で決めた初期値。可逆)
- 区間の長さ: 欄で作る区間も、ほかの経路と同じく 1 秒 (`MIN_CLIP_SEC`) 以上・1 区間は上限 (`maxClipSec`、既定 60 秒) 以下 (cross-review 1 回目。拡大バーのつまみは上限より長い区間で跳ぶ)
- 行の文字は信用できない入力として扱う (1a の whole-branch review): DOM には `textContent` でだけ入れ、テロップにするときは 500 文字 (`MAX_TELOP_TEXT_LENGTH`) で切る

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- 先にドキュメントを直してからコードに着手する (Task 1 が文書)
- git は `git -C <dir> ...`
- Fail Fast。UI から届いた不正な値は reduce が invalid にする (今の作法)
- コメントとコミットメッセージは日本語、Conventional Commits + Why の本文
- コミットは署名される。署名で失敗したら、署名を外さずにユーザーに伝えて止まる

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous (根拠: Auto Mode 既定)
- 隔離: branch。`feat/transcript-editor` の続き
- 実装方式: B (branch + 直列)
- 既知の失敗: `e2e/smoke.spec.ts` の「オフにすると 1 秒以内…」は `expect(extensionLogs).toEqual([])` (312 行付近) で落ちる。それ以外で落ちたらこの plan の不具合

---

## ファイル構造

| ファイル | 種別 | 責務 |
|---|---|---|
| `README.md` / `docs/manual-check.md` / `docs/store-release.md` / `CHANGELOG.md` | Modify | 文字起こしの欄の使い方、区間は時間順、窓は動画ページでいつも出る |
| `src/shared/types.ts` | Modify | `Telop.lineId`、`SET_CLIP` イベント |
| `src/shared/telop.ts` | Modify | `lineId` の検証 |
| `src/background/state.ts` | Modify | 区間を開始の早い順に並べる、`SET_CLIP` |
| `src/background/router.ts` | Modify | `SET_CLIP` も送ったタブを録画対象にする |
| `src/content/transcript-selection.ts` | Create | 行の選び方 → 区間とテロップ (純粋関数) |
| `src/content/transcript-panel.ts` | Create | 文字起こしの欄の見た目と操作 |
| `src/content/styles.ts` | Modify | 欄の見た目 (`TRANSCRIPT_STYLE`) |
| `src/content/youtube.ts` | Modify | 選択を範囲で追う、欄を組み込む |
| `tests/...` | Create / Modify | 各モジュールのテスト、時間順と窓の出し方の変化に合わせた直し |

---

### Task 1: 文書

**Files:**
- Modify: `README.md`、`docs/manual-check.md`、`docs/store-release.md`、`CHANGELOG.md`

- [ ] **Step 1: README を直す**

`README.md`:

- 「使い方」の窓の説明の「区間・テロップの窓は区間があるときだけ出る。」→「区間・テロップの窓は動画ページでいつも出る (先頭に文字起こしの欄があるため)。」
- `## 複数の場面を繋ぐ` の節の前に、次の節を足す:

```markdown
## 文字起こしの欄

区間・テロップの窓の先頭に、動画の公式字幕を発話の行にしたもの (文字起こし) が出る。行を選ぶと区間になり、
行の文字がそのままテロップになる。テロップの時刻は行の時刻を使うので、出す時間を合わせなくてよい。

- **行を押す** — その行を区間に入れる / 外す。続いた行は 1 つの区間になる (頭は行の 0.2 秒前、尻は 0.3 秒後まで)。
  途中の行を外すと区間が 2 つに割れる
- **Shift + 行を押す** — 直前に押した行からこの行までをまとめて入れる / 外す
- **区間に入った行の ✎** — テロップの文字を直す (Enter で確定、Esc で戻す、Shift + Enter で改行)
- **字幕に出さない** — 区間には残し、テロップだけ出さない (相づちなど)。もう一度押すと出す
- **行の時刻を押す** — その行の頭から再生する。再生中の行には ▶ が付く (録画中は動かさない)

行と行の間が 3 秒より空いていれば、続けて選んでも別の区間になる (曲や沈黙を挟まない)。1 秒に満たない区間は前後へ
広げて 1 秒にする。1 つの区間が上限の秒数 (設定、既定 60 秒) を超えるときは入れずに理由を出す。
**＋ 区間を追加や IN / OUT で作った区間は、欄で押した行に当たらなければ変わらない**。当たれば、その行の分だけ
伸びる・切り取られる (中のほかの行にテロップは作らない)。

文字起こしは YouTube の公式字幕 (手動の字幕があればそれ、無ければ自動字幕) から取る。取れるまで数秒かかる。
字幕の無い動画では欄は案内だけになり、これまでどおり ＋ 区間を追加と ＋ テロップで作る。
**吹き替えの音声が流れている動画では、欄にそのことを出す** (字幕は元の音声のものなので、録画の音と合わないことがある)。
```

- `### 区間の結合` の「- **区間は拾った順に繋がる**。動画の時間順に並び替えたりはしないので、\n  後ろの場面を先に置くこともできる」→「- **区間は動画の時間順に繋がる**。後から前の場面を足しても、時間順の位置に入る」
- 同じ節の「- **重なった区間はそのまま残る**。同じ場面を 2 回入れられる。」の後に「文字起こしの欄で、重なった区間の隣の行を足して繋ぐときは、繋がる区間を 1 つにまとめる。」を足す

- [ ] **Step 2: 手動確認を直す**

`docs/manual-check.md`:

- `## 複数区間の結合` の「- [ ] **拾った順に一覧が並ぶ** (動画の時間順に並び替えられない)」→「- [ ] **区間は動画の時間順に並ぶ** (後ろの区間を作ってから前で ＋ 区間を追加すると、前の位置に入り、その区間が選ばれる)」
- 「区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) に区間の一覧が出る (区間が 0 個の間はタブごと出ない)」→「区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) の文字起こしの欄の下に区間の一覧が出る (窓は区間が 0 個でも、動画ページではいつも出る)」
- `## 見た目` の「区間が無い間は、おすすめ動画の上には何も出ない」→「おすすめ動画の上には、区間が無い間も区間・テロップの窓 (文字起こしの欄) が出る」
- `## 文字起こし (公式字幕)` の節の後に、次の節を足す:

```markdown
## 文字起こしの欄

- [ ] 字幕のある動画を開くと、区間・テロップの窓の先頭に「文字起こしを取っています…」が出て、数秒で行が並ぶ。見出しに「公式字幕」か「公式字幕 (自動)」が出る
- [ ] 行を押すと区間ができ、区間の一覧とテロップの一覧に 1 つずつ増える。プレイヤーの上に行の文字がテロップとして出る
- [ ] 続いた行を押すと、区間が 1 つに伸びる。途中の行を押すと区間が 2 つに割れる。最後の行を外すと区間もテロップも消える
- [ ] Shift + 行で、直前に押した行からまとめて入る / 外れる
- [ ] 区間に入った行の ✎ で文字を直すと、テロップの一覧の文字も変わる。Esc で直す前に戻る
- [ ] 日本語の IME で直すとき、変換を確かめる Enter では確定しない (欄が閉じない)。変換を取り消す Esc で欄が閉じない
- [ ] ＋ 区間を追加で作った区間がある動画で、離れた行を押しても、その区間の端もテロップも変わらない
- [ ] 間が 3 秒より空いた 2 行を Shift でまとめて選ぶと、区間が 2 つになる。上限の秒数を超えるほど選ぶと、入らずに理由が出る
- [ ] 「字幕に出さない」でテロップが消え (一覧には空の行が残る)、もう一度押すと戻る
- [ ] 行の時刻を押すとその行から再生される。再生に合わせて ▶ が動き、欄の中だけがスクロールする (ページはスクロールしない)
- [ ] 録画中・録画した後のプレビューの間は、行を押しても区間が変わらない (欄が薄くなる)。録画中は行の時刻を押しても動画が動かない。撮り直しに戻るとすぐ押せる
- [ ] 1 時間を超える配信 (自動字幕で数千行) でも、行を押してから欄と一覧が変わるまでに引っかかりが無い
- [ ] 行を素早く続けて押しても (しばらく触らず service worker が寝た後も)、先に押した行が外れない
- [ ] 動画の最後の行を入れて録画すると、録画が終わる (動画の終わりで「録画中…」のまま止まらない)
- [ ] 直した行をダブルクリックすると、外して入れ直すことになるが、直した文字は残る
- [ ] 広告の再生中に行を押したときの振る舞いを見る (動画の長さが広告の長さになる。おかしければ 1c に回す)
- [ ] 字幕の無い動画では「この動画には公式字幕がありません」だけが出て、＋ 区間を追加と ＋ テロップで作れる
- [ ] 取れなかったとき「文字起こしを取れませんでした: …」と「もう一度取る」が出て、押すと取り直す
- [ ] 吹き替えの音声が流れている動画 (例: `5JeOw-Tt3N0` を日本語の環境で) で、欄に吹き替えの知らせが出る
- [ ] 行の文字にタグのような文字列 (`<b>` など) があっても、そのまま文字として出る
```

- [ ] **Step 3: ストアの申請文と CHANGELOG を直す**

`docs/store-release.md`:
- 「■ 複数の場面を繋ぐ」の「・区間は拾った順に繋がります。後ろの場面を先に置くこともできます」→「・区間は動画の時間順に繋がります」
- 「■ 複数の場面を繋ぐ」の節の前に足す:

```
■ 文字起こしから選ぶ

動画の公式字幕を発話の行にして並べます。行を押すとその場面が区間になり、行の文字がそのままテロップになります。
テロップの時刻を合わせる必要はありません。誤字は ✎ で直せます。
```

`CHANGELOG.md` の `## 未リリース` の先頭 (「**シンプル / エディットのモードを無くした。**」の前) に足す:

```markdown
**文字起こしの欄を足した。** 区間・テロップの窓の先頭に、動画の公式字幕を発話の行にして並べる。行を押すとその場面が
区間になり、行の文字がそのままテロップになる (時刻を合わせなくてよい)。✎ で文字を直せ、相づちは
「字幕に出さない」で外せる。吹き替えの音声が流れている動画ではそのことを出す。区間はいつも動画の時間順に繋がる
ようにした。
```

- [ ] **Step 4: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md docs/manual-check.md docs/store-release.md CHANGELOG.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
docs: 文字起こしの欄と、区間を時間順に繋ぐことを先に書く

ADR 0001 の、行を選ぶと区間になり行の文字がそのままテロップになる欄を作る前に、使い方と確かめ方を書く。区間は
拾った順ではなく動画の時間順に繋ぐ (回答 2026-10-26「1ok」)。区間・テロップの窓は、欄があるので動画ページでは
いつも出る。
EOF
```

---

### Task 2: 状態機械 (時間順・SET_CLIP・lineId)

**Files:**
- Modify: `src/shared/types.ts`、`src/shared/telop.ts`、`src/background/state.ts`、`src/background/router.ts`
- Test: `tests/background/state.test.ts`、`tests/shared/telop.test.ts`、`tests/background/router.test.ts`

**Interfaces:**
- Produces:
  - `Telop` に `lineId?: string` (どの文字起こしの行から作ったか。手で足したテロップには無い)
  - `ClipEvent` に `{ type: "SET_CLIP"; segments: ClipRange[]; telops: Telop[]; meta: VideoMeta }`
  - 状態機械が持つ `segments` は、いつも `startSec` の早い順 (同じなら元の順)

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/state.test.ts` の末尾に足す (ファイル先頭の import と fixture (`makeVideoMeta` など) は既存のものを使う。無ければ `import { makeVideoMeta } from "../helpers/fixtures";` を足す):

```typescript
describe("区間は時間順 (ADR 0001)", () => {
  const meta = makeVideoMeta();

  test("後から前の場面を足しても、開始の早い順に並ぶ", () => {
    let state = reduce(INITIAL_STATE, { type: "ADD_SEGMENT", range: { startSec: 100, endSec: 110 }, meta });
    state = reduce(state, { type: "ADD_SEGMENT", range: { startSec: 10, endSec: 20 }, meta });
    expect(state).toMatchObject({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 100, endSec: 110 },
      ],
    });
  });

  test("頭を動かして順が入れ替わっても並び直す", () => {
    let state = reduce(INITIAL_STATE, { type: "ADD_SEGMENT", range: { startSec: 10, endSec: 20 }, meta });
    state = reduce(state, { type: "ADD_SEGMENT", range: { startSec: 30, endSec: 40 }, meta });
    state = reduce(state, { type: "ADJUST_SEGMENT", index: 1, range: { startSec: 5, endSec: 40 } });
    expect(state).toMatchObject({
      segments: [
        { startSec: 5, endSec: 40 },
        { startSec: 10, endSec: 20 },
      ],
    });
  });
});

describe("SET_CLIP (文字起こしの欄から区間とテロップをまとめて差し替える)", () => {
  const meta = makeVideoMeta();
  const telop = { startSec: 11, endSec: 14, text: "こんにちは", lineId: "youtube-asr:11.00" };

  test("idle から区間とテロップの ready になる。区間は時間順に並べる", () => {
    const state = reduce(INITIAL_STATE, {
      type: "SET_CLIP",
      segments: [
        { startSec: 50, endSec: 60 },
        { startSec: 10.8, endSec: 14.3 },
      ],
      telops: [telop],
      meta,
    });
    expect(state).toEqual({
      kind: "ready",
      segments: [
        { startSec: 10.8, endSec: 14.3 },
        { startSec: 50, endSec: 60 },
      ],
      telops: [telop],
      meta,
    });
  });

  test("区間が空なら idle に戻る (最後の行を外した)", () => {
    const ready = reduce(INITIAL_STATE, { type: "SET_CLIP", segments: [{ startSec: 1, endSec: 2 }], telops: [], meta });
    expect(reduce(ready, { type: "SET_CLIP", segments: [], telops: [], meta })).toEqual({ kind: "idle" });
  });

  test("投稿した後 (posted) からも受け、クリップは外れる", () => {
    const posted: ClipState = {
      kind: "posted",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [{ startSec: 1, endSec: 2 }],
      telops: [],
      meta,
    };
    expect(reduce(posted, { type: "SET_CLIP", segments: [{ startSec: 3, endSec: 4 }], telops: [], meta })).toEqual({
      kind: "ready",
      segments: [{ startSec: 3, endSec: 4 }],
      telops: [],
      meta,
    });
  });

  test("区間を作る前に落ちた failed からは受け、渡された区間で作り直す", () => {
    const failed: ClipState = { kind: "failed", reason: "recording-aborted", segments: [], telops: [], meta: null };
    expect(reduce(failed, { type: "SET_CLIP", segments: [{ startSec: 3, endSec: 4 }], telops: [], meta })).toEqual({
      kind: "ready",
      segments: [{ startSec: 3, endSec: 4 }],
      telops: [],
      meta,
    });
  });

  test("やり直せる区間を持つ failed は受けない (RETRY で戻れる区間とテロップを消さない)", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "recording-aborted",
      segments: [{ startSec: 1, endSec: 2 }],
      telops: [{ startSec: 1, endSec: 2, text: "手" }],
      meta,
    };
    expect(reduce(failed, { type: "SET_CLIP", segments: [{ startSec: 3, endSec: 4 }], telops: [], meta })).toMatchObject({
      kind: "failed",
      reason: "internal-error",
    });
  });

  test("録画中・録画した後 (preview) は受けない (invalid)", () => {
    const base = { segments: [{ startSec: 1, endSec: 2 }], telops: [], meta };
    for (const state of [
      { kind: "recording", ...base },
      { kind: "preview", clipId: "c", mimeType: "video/mp4", ...base },
    ] as ClipState[]) {
      expect(reduce(state, { type: "SET_CLIP", segments: [], telops: [], meta })).toMatchObject({
        kind: "failed",
        reason: "internal-error",
      });
    }
  });

  test("不正な区間は invalid にせず throw する (今の readyWith と同じ。UI のバグ)", () => {
    expect(() =>
      reduce(INITIAL_STATE, { type: "SET_CLIP", segments: [{ startSec: 5, endSec: 1 }], telops: [], meta }),
    ).toThrow();
  });
});
```

(最後のテストの期待は、今の `readyWith` が `assertValidSegments` で throw することに合わせている。既存のテストで、不正な区間の `ADJUST_SEGMENT` が throw を期待しているか invalid を期待しているかを `grep -n "assertValid\|toThrow" tests/background/state.test.ts` で確かめ、**既存と同じ期待**にする)

`tests/shared/telop.test.ts` の `assertValidTelops` の describe に足す:

```typescript
  test("lineId は文字列なら通し、文字列でなければ throw する", () => {
    expect(() => assertValidTelops([{ startSec: 1, endSec: 2, text: "a", lineId: "youtube-asr:1.00" }])).not.toThrow();
    expect(() =>
      assertValidTelops([{ startSec: 1, endSec: 2, text: "a", lineId: 3 } as unknown as Telop]),
    ).toThrow(TypeError);
  });
```
(import に `Telop` 型が無ければ `import type { Telop } from "@/shared/types";` を足す)

`tests/background/router.test.ts` の describe「区間の追加での録画対象タブ」に足す:

```typescript
  test("文字起こしの欄で区間を作った (SET_CLIP) タブが録画対象になる", async () => {
    const h = makeHarness();
    await h.router.handle(
      { type: "clip/event", event: { type: "SET_CLIP", segments: [range], telops: [], meta } },
      11,
    );
    await h.router.handle({ type: "clip/event", event: { type: "START_RECORDING" } }, 11);
    expect(h.sentToTab).toContainEqual(expect.objectContaining({ tabId: 11 }));
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/state.test.ts tests/shared/telop.test.ts tests/background/router.test.ts`
期待: typecheck の段で `SET_CLIP` / `lineId` が型に無いため FAIL (vitest は型を見ないので、実行時は SET_CLIP が invalid になって落ちる)。「後から前の場面を足しても…」「頭を動かして…」も FAIL

- [ ] **Step 3: 実装**

`src/shared/types.ts`:

`Telop` の `text` の後に足す:
```typescript
  /**
   * どの文字起こしの行から作ったか (`TranscriptLine.id`)。手で足したテロップには無い。
   * 文字起こしの欄は、これで行とテロップを結び付ける (行を外すとテロップも消え、直した文字は残る)
   */
  lineId?: string;
```

`ClipEvent` の `| { type: "REMOVE_TELOP"; index: number }` の後に足す (注記は周りの書き方に合わせる):
```typescript
  /**
   * 区間とテロップをまとめて差し替える (文字起こしの欄で行を入れた / 外した)。区間が空なら idle に戻る。
   * idle / ready / posted と、区間を持たない failed だけが受ける (posted はクリップが外れる)。区間を持つ failed は
   * RETRY で戻れる区間とテロップを持っているので受けない (画面の写しは failed では空なので、丸ごと差し替えると消える)
   */
  | { type: "SET_CLIP"; segments: ClipRange[]; telops: Telop[]; meta: VideoMeta }
```

`src/shared/telop.ts` の `assertValidTelops` の文言の型の検査の後に足す:
```typescript
    if (telop.lineId !== undefined && typeof telop.lineId !== "string") {
      throw new TypeError(`テロップの行の id が文字列ではありません: ${String(telop.lineId)}`);
    }
```

`src/background/state.ts`:

`readyWith` のコメントの「**並べ替えもマージもしない。** 拾った順がそのまま出力順になる (spec §2.3)」→「**開始の早い順に並べる** (ADR 0001: 区間は動画の時間順に繋ぐ)。マージはしない (重なった区間はそのまま残る)」。本体の先頭を次にする:

```typescript
function readyWith(
  segments: ClipRange[],
  meta: VideoMeta,
  telops: Telop[],
): ClipState {
  assertValidSegments(segments);
  assertValidTelops(telops);
  // 同じ開始なら元の順を保つ (Array.prototype.sort は安定)
  const ordered = [...segments].sort((a, b) => a.startSec - b.startSec);
```
とし、関数の残りで `segments` を使っている所 (`segments.length === 0` と `return { kind: "ready", segments, meta, telops }`) を `ordered` にする。

`reduce` の `ADD_SEGMENT` の処理の後 (`switch (state.kind)` の前) に足す:

```typescript
  if (event.type === "SET_CLIP") {
    // 録画中・録画した後 (preview / composing / degraded) と、やり直せる区間を持つ failed は受けない。
    // 文字起こしの欄も、その間は押せない (UI と同じ規則)
    const open =
      state.kind === "idle" ||
      state.kind === "ready" ||
      state.kind === "posted" ||
      (state.kind === "failed" && state.segments.length === 0);
    if (!open) {
      return invalid(state);
    }
    // 別の動画の区間は持ち越さない (渡された区間とテロップで丸ごと置き換えるので、meta も渡されたもの)
    return readyWith(event.segments, event.meta, event.telops);
  }
```

`src/background/router.ts`: `TAB_OWNING_EVENTS` に `"SET_CLIP",` を足す。

- [ ] **Step 4: 実行して通過を確認、既存のテストを直す**

実行: `npm run typecheck && npx vitest run tests`

時間順にしたことで落ちる既存のテストは、次の規則で直す (どれをどう直したかを commit の本文に列挙する):

| 規則 | 当てはまるテスト | 直し方 |
|---|---|---|
| T1. 拾った順に並ぶことを確かめている | `state.test.ts` の「並べ替えない」系、`youtube.test.ts` の describe「重なる位置での区間追加」など | 期待値を開始の早い順に変える。テスト名の「拾った順」「並べ替えない」を「時間順」に直す。後ろの場面を先に置けることを確かめているテストは、時間順に入ることを確かめる形に反転する |
| T2. 上のどれでもない | — | 落ちた理由を読み、実装の不具合なら実装を直す |

cross-review で当てた結果、この Task の後に落ちるのは `state.test.ts` の「足した区間は拾った順に並ぶ。時間順へ並べ替えない」(T1) の 1 件だけだった。`youtube.test.ts` は `emit` で状態を偽装しているので、時間順の影響を受けない (足した区間の選択は Task 3 で直す)。

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared src/background tests/shared tests/background
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(background): 区間をいつも時間順に並べ、区間とテロップをまとめて差し替えるイベントを足す

ADR 0001 で、区間は動画の時間順に繋ぐ (回答「1ok」)、文字起こしの行を選ぶと区間とテロップができる、と決めた。
状態機械が区間をいつも開始の早い順に並べ、文字起こしの欄が計算した区間とテロップの組を SET_CLIP でまとめて
渡せるようにする。テロップにはどの行から作ったか (lineId) を持たせる。SET_CLIP も送ったタブを録画対象にする。

直したテスト:
<規則 T1・T2 ごとにテスト名を列挙する>
EOF
```

---

### Task 3: youtube.ts の選択を範囲で追う

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 2 の「区間はいつも時間順」

並べ替えで、足した区間や動かした区間の位置 (index) が変わる。今の「足したら末尾を選ぶ」「受理は index の区間で見る」は成り立たない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の describe「区間を足した直後の選択」に足す (describe 内の既存のヘルパーを使う。`emit` は状態機械の代わりに答えを流す):

```typescript
  test("前の場面に足した区間は時間順の位置に入り、それが選ばれる", async () => {
    emit({ kind: "ready", segments: [{ startSec: 100, endSec: 115 }], telops: [], meta: META_A });
    await flush();
    video.element.currentTime = 10;
    sent = [];

    clickButton("＋ 区間を追加");
    await flush();
    const added = (clipEvents() as { type: string; range?: ClipRange }[]).find((event) => event.type === "ADD_SEGMENT");
    expect(added?.range?.startSec).toBe(10);
    // 状態機械は時間順に並べて返す
    emit({
      kind: "ready",
      segments: [added!.range!, { startSec: 100, endSec: 115 }],
      telops: [],
      meta: META_A,
    });
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
    expect(rows.map((row) => row.dataset.selected)).toEqual(["true", "false"]);
  });

  test("頭を動かして順が入れ替わっても、動かした区間を選んだまま", async () => {
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 30, endSec: 40 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();
    document.querySelectorAll<HTMLElement>("[data-role='segment']")[1]?.click();
    await flush();
    video.element.currentTime = 5;
    sent = [];

    clickButton("IN");
    await flush();
    expect(clipEvents()).toContainEqual({ type: "ADJUST_SEGMENT", index: 1, range: { startSec: 5, endSec: 40 } });
    emit({
      kind: "ready",
      segments: [
        { startSec: 5, endSec: 40 },
        { startSec: 10, endSec: 20 },
      ],
      telops: [],
      meta: META_A,
    });
    await flush();

    const rows = [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
    expect(rows.map((row) => row.dataset.selected)).toEqual(["true", "false"]);
    // 並び替わっても「受け付けられませんでした」にしない
    expect(statusText()).toBe("0:05 〜 0:40 (35秒)");
  });
```

`tests/content/youtube.test.ts` の describe「足した行を区間・テロップの窓の見える範囲に入れる」の「区間を足したら、…末尾の行へ送る」の後に足す (同じ describe の `placeRows` を使う):

```typescript
  test("前の場面に区間を足したら、時間順で入った行 (先頭) へ送る", async () => {
    const later: ClipRange = { startSec: 300, endSec: 315 };
    emit({ kind: "ready", segments: [later], telops: [], meta: META_A });
    await flush();
    const spy = placeRows("segment");
    try {
      video.element.currentTime = 83;
      sent = [];
      clickButton("＋ 区間を追加");
      await flush();
      const added = (clipEvents() as { type: string; range?: ClipRange }[]).find((event) => event.type === "ADD_SEGMENT")!.range!;
      emit({ kind: "ready", segments: [added, later], telops: [], meta: META_A });
      // 先頭 (1 行目: 900px) の頭を本体の上端 (100px) に揃える
      expect(listBody().scrollTop).toBe(800);
    } finally {
      spy.mockRestore();
    }
  });
```

(`ClipRange` の import が無ければ足す)

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts -t "区間を足した直後の選択"`
期待: 2 本とも FAIL (末尾が選ばれる / index 1 の区間が送った範囲でないので「受け付けられませんでした」)。続けて `npx vitest run tests/content/youtube.test.ts -t "前の場面に区間を足したら"` も FAIL (末尾の 900 へ送る)

- [ ] **Step 3: 実装**

`src/content/youtube.ts`:

(1) `selectLastOnNextState` とそのコメントを次に置き換える:

```typescript
/**
 * 次に状態が届いたとき、この範囲の区間を選ぶ。区間を足した・動かした直後は**その区間**を選ぶ。
 * 前の区間が選ばれたままだと、続けて OUT を押したときに前の区間の終端が動いて事故になる。
 * **位置ではなく範囲で覚える**: 状態機械は区間を時間順に並べるので、足した区間・動かした区間の位置は変わりうる
 */
let selectRangeOnNextState: ClipRange | null = null;
/** 次に状態が届いたとき、選んだ区間の行を区間・テロップの窓の見える範囲に入れる (区間を足した直後) */
let revealSegmentOnNextState = false;
```
(`revealLastTelopOnNextState` のコメントの「`selectLastOnNextState` と同じ形。」→「`revealSegmentOnNextState` と同じ形。」)

(2) 受理の判定 `segmentIs` を次に置き換える (呼び出しも合わせて直す):

```typescript
/**
 * 状態機械の区間に、送った範囲の区間があるか。区間を変える送信が受け付けられたかの判定に使う
 * (拒まれたら send が画面を状態機械に戻し、「受け付けられませんでした」を出す)。**位置では見ない**: 状態機械は
 * 区間を時間順に並べるので、動かした区間の位置は変わりうる
 */
function hasSegment(state: ClipState, range: ClipRange): boolean {
  return state.kind === "ready" && state.segments.some((segment) => sameRange(segment, range));
}
```
- `startOver` の判定 `state.kind === "ready" && state.segments.length === 1 && segmentIs(state, 0, range)` → `state.kind === "ready" && state.segments.length === 1 && hasSegment(state, range)`
- `onMarkSegmentStart` の `(state) => segmentIs(state, index, next)` → `(state) => hasSegment(state, next)`。その直前に `selectRangeOnNextState = next;` を足す
- `onMarkOut` の `(state) => segmentIs(state, index, next)` → `(state) => hasSegment(state, next)`。その直前に `selectRangeOnNextState = next;` を足す
- `onRangeCommitted` の `(state) => segmentIs(state, index, range)` → `(state) => hasSegment(state, range)`。その直前に `selectRangeOnNextState = range;` を足す
- `const index = selectedIndex;` が送信以外で使われなくなったら、`send` の中で `selectedIndex` を直接使い、変数を消す (noUnusedLocals)

(3) `onAddSegment` の `selectLastOnNextState = true;` → 次の 2 行:
```typescript
  selectRangeOnNextState = range;
  revealSegmentOnNextState = true;
```
そのすぐ上のコメント「足した区間を選ぶ。前の区間が選ばれたままだと、続けて IN/OUT を押したとき\n  // 別の区間が動く」はそのまま。

(4) `applyStateToDisplay` の選択の決め方:

```typescript
  // **並べ替えないので index は動かない。** 足した直後だけ末尾へ移し、
  // それ以外は今の位置を保つ。削除で数が減ったときだけ範囲内へ詰める
  if (liveSegments.length === 0) {
    selectedIndex = -1;
  } else if (selectLastOnNextState || selectedIndex < 0) {
    selectedIndex = liveSegments.length - 1;
  } else {
```
→
```typescript
  // 足した・動かした直後は、その範囲の区間を選ぶ (状態機械が時間順に並べるので位置は変わりうる)。
  // それ以外は今の位置を保ち、削除で数が減ったときだけ範囲内へ詰める
  const wanted = selectRangeOnNextState;
  const wantedIndex =
    wanted === null ? -1 : liveSegments.findIndex((segment) => sameRange(segment, wanted));
  if (liveSegments.length === 0) {
    selectedIndex = -1;
  } else if (wantedIndex >= 0) {
    selectedIndex = wantedIndex;
  } else if (selectedIndex < 0) {
    selectedIndex = liveSegments.length - 1;
  } else {
```
と、その少し後の
```typescript
  const revealSegment = selectLastOnNextState;
  const revealTelop = revealLastTelopOnNextState;
  selectLastOnNextState = false;
```
→
```typescript
  const revealSegment = revealSegmentOnNextState;
  const revealTelop = revealLastTelopOnNextState;
  selectRangeOnNextState = null;
  revealSegmentOnNextState = false;
```

(5) `resetModuleState` の `selectLastOnNextState = false;` → `selectRangeOnNextState = null;` と `revealSegmentOnNextState = false;`

(6) 足した区間の行へ送る。`revealLastRow` を、送る行の位置を受け取る形にする:
```typescript
/** 一覧の行を区間・テロップの窓の見える範囲に入れる。index を渡さなければ末尾の行 */
function revealRow(list: HTMLElement | undefined, role: "segment" | "telop", index?: number): void {
  if (list === undefined || listWindow.element.hidden) return;
  const rows = list.querySelectorAll<HTMLElement>(`[data-role='${role}']`);
  const row = rows[index ?? rows.length - 1];
  if (row === undefined) return;
  if (isDockedInPage("list")) {
    dockManager.activate("list");
    return;
  }
  listWindow.scrollTo(row);
}
```
`applyStateToDisplay` の `if (revealSegment) revealLastRow(segmentList?.element, "segment");` → `if (revealSegment) revealRow(segmentList?.element, "segment", selectedIndex);`、`revealLastRow(telopList?.element, "telop")` → `revealRow(telopList?.element, "telop")` (テロップは足した順に積むので末尾のまま)

(7) 古くなるコメントを直す:
- `youtube.ts` の `selectedIndex` の doc「並べ替えもマージもしないので index は動かず、数が変わったときだけ詰める」→「状態機械は区間を時間順に並べるので、足した・動かした直後は範囲で引き直す (selectRangeOnNextState)。それ以外は数が変わったときだけ詰める」
- `applyStateToDisplay` の「**並べ替えとマージで index は動く。** …」(previous の上) はそのまま (時間順の並べ替えでも成り立つ)
- `onMarkSegmentStart` の「並べ替えないので、頭を動かしても選択はその場に留まる」→「頭を動かすと時間順の位置が変わりうる。選択は範囲で追う (selectRangeOnNextState)」
- `src/background/state.ts` の 47 行付近 (readyWith の doc) は Task 2 で直した。`src/shared/timeline.ts` の `assertValidSegments` の doc「**並べ替えもマージもしない。** 拾った順がそのまま出力順になる。…」の 1 文目を「**ここでは並べ替えもマージもしない** (時間順に並べるのは状態機械の readyWith)。」にし、続く経緯の文は残す
- `src/shared/timeline.ts` の `assertValidSegments` の doc の 2 段目 (拾った順のままなら index が動かない…代償は録画中の巻き戻しシーク) は、時間順にした後は成り立たない。「区間は状態機械が時間順に並べる (ADR 0001)。重なった区間はマージしないので、録画中の巻き戻しシークは重なった区間でだけ起きる」に直す
- `tests/content/youtube.test.ts` の「並べ替えないので、足した区間は必ず末尾に来る」(2052 行付近) →「状態機械の答えを偽装しているので、足した区間は末尾に置いてある」
- `onTranscriptStatus` の doc「段階 1a では表示する欄がまだ無いので、…」は Task 6 で直す

(8) 確かめ: `grep -n "selectLastOnNextState\|segmentIs\|revealLastRow" src/content/youtube.ts` が 0 件

- [ ] **Step 4: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 全 PASS (Task 2 の規則 T2 で直したものを含む)

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
fix(content): 区間を時間順に並べても、足した・動かした区間を選び続ける

状態機械が区間を時間順に並べるようにしたので、足した区間は末尾に来るとは限らず、頭を動かすと位置が入れ替わる。
「足したら末尾を選ぶ」と「受理は index の区間で見る」のままだと、前の場面に足した区間ではなく後ろの区間が選ばれ、
位置が入れ替わった OUT は「受け付けられませんでした」になる。次に選ぶ区間を範囲で覚え、受理も範囲で見る。
EOF
```

---

### Task 4: 行の選び方 → 区間とテロップ (純粋関数)

**Files:**
- Create: `src/content/transcript-selection.ts`
- Modify: `src/shared/transcript.ts` (行の id を重ねない)、`src/content/transcript-cache.ts` (id が重なった保存は読まない)
- Test: `tests/content/transcript-selection.test.ts` (Create)、`tests/shared/transcript.test.ts`、`tests/content/transcript-cache.test.ts`

**Interfaces:**
- Consumes: `TranscriptLine` (`src/shared/transcript.ts`)、`ClipRange` / `Telop`、`MAX_TELOP_TEXT_LENGTH` (`src/shared/telop.ts`)、`MIN_CLIP_SEC` (`src/shared/time.ts`)
- Produces:
  - `const HEAD_PAD_SEC = 0.2`、`const TAIL_PAD_SEC = 0.3`、`const JOIN_GAP_SEC = 3`
  - `type Clip = { segments: ClipRange[]; telops: Telop[] }`
  - `function isLineInSegments(line: TranscriptLine, segments: ClipRange[]): boolean`
  - `function lineIdsBetween(lines: TranscriptLine[], fromId: string, toId: string): string[]`
  - `function setLinesSelected(clip: Clip, lines: TranscriptLine[], lineIds: string[], selected: boolean, durationSec?: number): Clip` (`durationSec` は動画の長さ。区間は動画の終わりを越えない。分からなければ省く)
  - `function toggleTelopHidden(clip: Clip, line: TranscriptLine): Clip | null`
  - `TranscriptLine.id` は 1 つの文字起こしの中で重ならない (同じ開始の行には `#2`、`#3` を付ける)

**規則 (cross-review 1 回目で決め直した。手で作った区間と行の選択が混ざっても、押した行のまわりしか変えない):**

- 行が区間に「入っている」= 行の長さの半分以上が、どれか 1 つの区間に重なる
- **入れる:** 行 1 つの既定の区間 (頭は行の 0.2 秒前、尻は 0.3 秒後。隣の行に食い込まない。1 秒 (`MIN_CLIP_SEC`) に満たなければ前後へ広げる) を作る。次のどれかに当たる区間とは 1 つにまとめる (まとめた区間の端は、いちばん外側を取る。詰めた端はそのまま残る):
  - この既定の区間に重なる区間
  - 隣の行 (並びの前後) が入っている区間。ただし行の間が `JOIN_GAP_SEC` (3 秒) より空いていればまとめない (曲や沈黙を挟まない)
- **外す:** 行を、前の行の尻の 0.3 秒後から、次の行の頭の 0.2 秒前まで切り取る (前後の行が無ければ行の端まで)。切った残りが 1 秒に満たないとき、その中にまだ入っている行があれば外側へ広げて 1 秒にし、無ければ捨てる (cross-review 2 回目: 短い隣の行まで外れ、テロップだけが残った)
- **区間は動画の終わりを越えない** (cross-review 2 回目: 尻の余白で動画の長さを越えると、録画が終端を待ち続ける)。1 秒は丸めた長さで比べる (浮動小数で 0.9999… 秒にしない)
- **ほかの区間は触らない** (押した行に当たらない区間は、重なっていても、手で作ったものでもそのまま)
- **テロップは押した行の分だけ変える:** 入れた行にテロップが無ければ、行の文字 (500 文字まで) で末尾に足す。外した行のテロップは消す。ほかのテロップ (手で足したもの・前から入っていた行のもの) は、順も中身もそのまま
- 区間は開始の早い順に返す (状態機械も並べるが、テストで比べやすくする)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/transcript-selection.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  isLineInSegments,
  lineIdsBetween,
  setLinesSelected,
  toggleTelopHidden,
  type Clip,
} from "@/content/transcript-selection";
import type { TranscriptLine } from "@/shared/transcript";

/** 2 秒ずつ、1 秒の間を空けて並ぶ行 (0-2, 3-5, 6-8, …, 57-59) */
const lines: TranscriptLine[] = Array.from({ length: 20 }, (_, i) => ({
  id: `l${i}`,
  startSec: i * 3,
  endSec: i * 3 + 2,
  text: `行 ${i}`,
}));
const empty: Clip = { segments: [], telops: [] };
const pick = (clip: Clip, ids: string[], on = true): Clip => setLinesSelected(clip, lines, ids, on);
const tight: TranscriptLine[] = [
  { id: "a", startSec: 0, endSec: 2, text: "a" },
  { id: "b", startSec: 2.1, endSec: 4, text: "b" },
  { id: "c", startSec: 4.1, endSec: 6, text: "c" },
];
const lineIds = (clip: Clip): (string | undefined)[] => clip.telops.map((telop) => telop.lineId);

describe("isLineInSegments", () => {
  test("行の半分以上が区間に重なれば入っている", () => {
    expect(isLineInSegments(lines[1]!, [{ startSec: 3.9, endSec: 10 }])).toBe(true);
    expect(isLineInSegments(lines[1]!, [{ startSec: 4.1, endSec: 10 }])).toBe(false);
  });
});

describe("setLinesSelected: 入れる", () => {
  test("行を 1 つ入れると、頭 0.2 秒・尻 0.3 秒の余白の区間と、行の文字のテロップができる", () => {
    expect(pick(empty, ["l1"])).toEqual({
      segments: [{ startSec: 2.8, endSec: 5.3 }],
      telops: [{ startSec: 3, endSec: 5, text: "行 1", lineId: "l1" }],
    });
  });

  test("余白は隣の行に食い込まない", () => {
    expect(setLinesSelected(empty, tight, ["b"], true).segments).toEqual([{ startSec: 2, endSec: 4.1 }]);
  });

  test("1 秒に満たない区間は、前後へ広げて 1 秒にする", () => {
    const short: TranscriptLine[] = [{ id: "s", startSec: 10, endSec: 10.3, text: "はい" }];
    expect(setLinesSelected(empty, short, ["s"], true).segments).toEqual([{ startSec: 9.7, endSec: 10.7 }]);
  });

  test("隣の行を入れると 1 つの区間に伸びる。間を埋めると 2 つが 1 つになる", () => {
    const two = pick(pick(empty, ["l1"]), ["l3"]);
    expect(two.segments).toHaveLength(2);
    const joined = pick(two, ["l2"]);
    expect(joined.segments).toEqual([{ startSec: 2.8, endSec: 11.3 }]);
    // テロップは足した順に末尾へ積む (テロップの一覧の並びを動かさない)
    expect(lineIds(joined)).toEqual(["l1", "l3", "l2"]);
  });

  test("行の間が 3 秒より空いていれば、隣の行でも別の区間にする", () => {
    const gap: TranscriptLine[] = [
      { id: "a", startSec: 0, endSec: 2, text: "a" },
      { id: "b", startSec: 10, endSec: 12, text: "b" },
    ];
    expect(setLinesSelected(empty, gap, ["a", "b"], true).segments).toEqual([
      { startSec: 0, endSec: 2.3 },
      { startSec: 9.8, endSec: 12.3 },
    ]);
  });

  test("直したテロップの文字は、行を入れたままなら残る", () => {
    const one = pick(empty, ["l1"]);
    const edited: Clip = { ...one, telops: [{ ...one.telops[0]!, text: "直した" }] };
    expect(pick(edited, ["l4"]).telops.find((telop) => telop.lineId === "l1")?.text).toBe("直した");
  });

  test("詰めた区間は、離れた行を足しても触らない。隣の行を足しても詰めた頭は残る", () => {
    const trimmed: Clip = { segments: [{ startSec: 3.1, endSec: 4.9 }], telops: [] };
    expect(pick(trimmed, ["l4"]).segments[0]).toEqual({ startSec: 3.1, endSec: 4.9 });
    expect(pick(trimmed, ["l2"]).segments).toEqual([{ startSec: 3.1, endSec: 8.3 }]);
  });

  test("行に重ならない区間 (＋ 区間を追加で作った) と、手で足したテロップはそのまま残す", () => {
    const manual: Clip = {
      segments: [{ startSec: 100, endSec: 115 }],
      telops: [{ startSec: 101, endSec: 104, text: "手で足した" }],
    };
    const next = pick(manual, ["l0"]);
    expect(next.segments).toEqual([
      { startSec: 0, endSec: 2.3 },
      { startSec: 100, endSec: 115 },
    ]);
    expect(next.telops[0]).toEqual({ startSec: 101, endSec: 104, text: "手で足した" });
  });

  test("行に重なる手作りの区間も、押した行に当たらなければ触らない。中の行にテロップを作らない", () => {
    const manual: Clip = {
      segments: [
        { startSec: 10, endSec: 25 },
        { startSec: 25, endSec: 40 },
      ],
      telops: [{ startSec: 12, endSec: 14, text: "手" }],
    };
    const next = pick(manual, ["l18"]);
    expect(next.segments).toEqual([
      { startSec: 10, endSec: 25 },
      { startSec: 25, endSec: 40 },
      { startSec: 53.8, endSec: 56.3 },
    ]);
    expect(next.telops.map((telop) => telop.text)).toEqual(["手", "行 18"]);
  });

  test("重ねた区間は、離れた行を押しても両方残る", () => {
    const twice: Clip = {
      segments: [
        { startSec: 2.8, endSec: 5.3 },
        { startSec: 2.8, endSec: 5.3 },
      ],
      telops: [],
    };
    expect(pick(twice, ["l4"]).segments).toHaveLength(3);
  });

  test("詰めて半分を割った行のテロップは、関係の無い行を押しても消えない", () => {
    const clip: Clip = {
      segments: [{ startSec: 4.5, endSec: 5.3 }],
      telops: [{ startSec: 3, endSec: 5, text: "直した", lineId: "l1" }],
    };
    expect(pick(clip, ["l4"]).telops[0]).toEqual({ startSec: 3, endSec: 5, text: "直した", lineId: "l1" });
  });

  test("区間は動画の終わりを越えない。越える行は終わりから 1 秒にする", () => {
    expect(setLinesSelected(empty, lines, ["l19"], true, 59.1).segments).toEqual([{ startSec: 56.8, endSec: 59.1 }]);
    const over: TranscriptLine[] = [{ id: "z", startSec: 58.5, endSec: 61, text: "z" }];
    expect(setLinesSelected(empty, over, ["z"], true, 59).segments).toEqual([{ startSec: 58, endSec: 59 }]);
  });

  test("1 秒に広げた区間は、丸めても 1 秒を割らない", () => {
    for (let ms = 0; ms < 3000; ms += 10) {
      const start = ms / 1000;
      const short: TranscriptLine[] = [{ id: "s", startSec: start, endSec: start + 0.3, text: "s" }];
      const [segment] = setLinesSelected(empty, short, ["s"], true).segments;
      expect(Math.round((segment!.endSec - segment!.startSec) * 100)).toBeGreaterThanOrEqual(100);
    }
  });

  test("テロップの文字は 500 文字で切る", () => {
    const long: TranscriptLine[] = [{ id: "x", startSec: 0, endSec: 2, text: "あ".repeat(600) }];
    expect(setLinesSelected(empty, long, ["x"], true).telops[0]?.text).toHaveLength(500);
  });

  test("知らない行の id は無視する", () => {
    expect(pick(empty, ["nope"])).toEqual(empty);
  });
});

describe("setLinesSelected: 外す", () => {
  test("途中の行を外すと 2 つに割れ、外した行のテロップだけ消える", () => {
    const three = pick(empty, ["l1", "l2", "l3"]);
    expect(three.segments).toEqual([{ startSec: 2.8, endSec: 11.3 }]);
    const split = pick(three, ["l2"], false);
    expect(split.segments).toEqual([
      { startSec: 2.8, endSec: 5.3 },
      { startSec: 8.8, endSec: 11.3 },
    ]);
    expect(lineIds(split)).toEqual(["l1", "l3"]);
  });

  test("最後の行を外すと区間もテロップも無くなる。まとめて外しても同じ", () => {
    expect(pick(pick(empty, ["l1"]), ["l1"], false)).toEqual(empty);
    expect(pick(pick(empty, ["l1", "l2", "l3"]), ["l1", "l2", "l3"], false)).toEqual(empty);
  });

  test("外した残りが 1 秒に満たなくても、まだ入っている短い行があれば 1 秒に広げて残す", () => {
    const short: TranscriptLine[] = [
      { id: "a", startSec: 0, endSec: 2, text: "a" },
      { id: "b", startSec: 2.1, endSec: 4, text: "b" },
      { id: "c", startSec: 4.1, endSec: 4.6, text: "はい" },
    ];
    const both = setLinesSelected(empty, short, ["b", "c"], true);
    const next = setLinesSelected(both, short, ["b"], false);
    expect(next.segments).toEqual([{ startSec: 4, endSec: 5 }]);
    expect(lineIds(next)).toEqual(["c"]);
  });

  test("手作りの区間の中の行を外すと、そこだけ切り取る。外側の端は残し、残った行にテロップを作らない", () => {
    const manual: Clip = { segments: [{ startSec: 10, endSec: 25 }], telops: [{ startSec: 12, endSec: 14, text: "手" }] };
    expect(pick(manual, ["l5"], false)).toEqual({
      segments: [
        { startSec: 10, endSec: 14.3 },
        { startSec: 17.8, endSec: 25 },
      ],
      telops: [{ startSec: 12, endSec: 14, text: "手" }],
    });
  });
});

test("lineIdsBetween は並び順で両端を含む。逆向きでもよい", () => {
  expect(lineIdsBetween(lines, "l1", "l3")).toEqual(["l1", "l2", "l3"]);
  expect(lineIdsBetween(lines, "l3", "l1")).toEqual(["l1", "l2", "l3"]);
  expect(lineIdsBetween(lines, "nope", "l2")).toEqual(["l2"]);
});

describe("toggleTelopHidden", () => {
  test("文字を空にして出さない。もう一度で行の文字に戻す", () => {
    const one = pick(empty, ["l1"]);
    const hidden = toggleTelopHidden(one, lines[1]!);
    expect(hidden?.telops[0]?.text).toBe("");
    expect(hidden?.segments).toEqual(one.segments);
    expect(toggleTelopHidden(hidden!, lines[1]!)?.telops[0]?.text).toBe("行 1");
  });

  test("その行のテロップが無ければ null", () => {
    expect(toggleTelopHidden(empty, lines[1]!)).toBeNull();
  });
});
```

`tests/shared/transcript.test.ts` の `describe("parseJson3 (手動字幕)"` に足す:

```typescript
  test("同じ開始の行が 2 つあっても、id は重ねない (#2 を付ける)", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "上" }] },
          { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "下" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines.map((line) => line.id)).toEqual(["youtube-manual:1.00", "youtube-manual:1.00#2"]);
  });
```

`tests/content/transcript-cache.test.ts` の `describe("saveTranscript / loadTranscript"` の「壊れた保存値は…」の後に足す:

```typescript
  test("行の id が重なった保存 (古い版で保存した) は読まない。取り直させる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = transcript("a", 1, 2);
    const doubled: Transcript = { ...base, lines: base.lines.map((line) => ({ ...line, id: "youtube-asr:0.00" })) };
    expect(isTranscript(doubled)).toBe(false);
    const { storage } = memoryStorage({ "transcript:a": doubled });
    expect(await loadTranscript("a", storage)).toBeNull();
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-selection.test.ts tests/shared/transcript.test.ts tests/content/transcript-cache.test.ts`
期待: transcript-selection は FAIL (`Cannot find module '@/content/transcript-selection'`)。id の 2 本も FAIL

- [ ] **Step 3: 最小実装**

`src/shared/transcript.ts` の `parseJson3` を次にする:

```typescript
export function parseJson3(json: unknown, source: TranscriptSource): TranscriptLine[] {
  const events = eventsOf(json);
  return uniqueIds(source === "youtube-asr" ? parseAsr(events) : parseManual(events));
}

/**
 * 行の id を重ねない。id は開始の秒から作るので、手動字幕で同じ開始の event が 2 つあると重なる。
 * 文字起こしの欄は id で行とテロップを結ぶので、重なると別の行のテロップを動かす
 */
function uniqueIds(lines: TranscriptLine[]): TranscriptLine[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line.id) ?? 0) + 1;
    seen.set(line.id, count);
    return count === 1 ? line : { ...line, id: `${line.id}#${count}` };
  });
}
```

`src/content/transcript-cache.ts` の `isTranscript` の `value.lines.every(isLine)` を `value.lines.every(isLine) &&\n    new Set(value.lines.map((line) => line.id)).size === value.lines.length` にする (重なった保存は読まず、取り直させる)。

`src/content/transcript-selection.ts`:

```typescript
import { MAX_TELOP_TEXT_LENGTH } from "@/shared/telop";
import { MIN_CLIP_SEC } from "@/shared/time";
import type { TranscriptLine } from "@/shared/transcript";
import type { ClipRange, Telop } from "@/shared/types";

/**
 * 文字起こしの欄で行を入れた / 外したときの、区間とテロップの組を計算する (ADR 0001)。**純粋関数だけを置く**
 * (状態機械へ送るのは youtube.ts。ここは組を作るだけ)。
 *
 * **押した行のまわりしか変えない。** 区間とテロップの一覧と ＋ 区間を追加は 1c まで残るので、手で作った区間と行の
 * 選択が混ざるのが普通の使い方になる。押した行に当たらない区間とテロップは、手作りでも重なっていても触らない。
 *
 * 規則:
 * - 行が区間に「入っている」= 行の長さの半分以上が、どれか 1 つの区間に重なる
 * - 入れる: 行の既定の区間 (頭 0.2 秒・尻 0.3 秒の余白。隣の行に食い込まない。1 秒に満たなければ広げる) を作り、
 *   それに重なる区間と、隣の行が入っている区間 (行の間が 3 秒以内) を 1 つにまとめる。まとめた端は外側を取る
 * - 外す: 前の行の尻の 0.3 秒後から次の行の頭の 0.2 秒前までを切り取る。残りが 1 秒に満たなければ捨てる
 * - テロップは押した行の分だけ: 入れた行にテロップが無ければ末尾に足し、外した行のテロップは消す
 */

export const HEAD_PAD_SEC = 0.2;
export const TAIL_PAD_SEC = 0.3;
/** 隣り合う行でも、これより長く空いていれば別の区間にする (曲や沈黙を挟まない) */
export const JOIN_GAP_SEC = 3;
/** 行の長さのうち、これ以上が区間に重なれば「入っている」 */
const MIN_OVERLAP_RATIO = 0.5;

export type Clip = { segments: ClipRange[]; telops: Telop[] };

const round2 = (sec: number): number => Math.round(sec * 100) / 100;

function overlapSec(a: ClipRange, b: ClipRange): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

export function isLineInSegments(line: TranscriptLine, segments: ClipRange[]): boolean {
  const length = line.endSec - line.startSec;
  if (length <= 0) return false;
  return segments.some((segment) => overlapSec(line, segment) >= length * MIN_OVERLAP_RATIO);
}

/** 並び順で from から to まで (両端を含む) の id。向きは問わない。from が見つからなければ to だけ */
export function lineIdsBetween(lines: TranscriptLine[], fromId: string, toId: string): string[] {
  const from = lines.findIndex((line) => line.id === fromId);
  const to = lines.findIndex((line) => line.id === toId);
  if (to < 0) return [];
  if (from < 0) return [toId];
  const [a, b] = from <= to ? [from, to] : [to, from];
  return lines.slice(a, b + 1).map((line) => line.id);
}

/** 丸めた長さ (秒)。1 秒との比べはこれで見る (0.9999… 秒を 1 秒未満にしない) */
const lengthSec = (range: ClipRange): number => round2(range.endSec - range.startSec);

/**
 * 1 秒に満たない区間を広げる (toward の側へ。both は前後へ半分ずつ)。動画の終わりと 0 秒は越えない。
 * 端は 100 分の 1 秒に丸め、丸めた後も 1 秒を割らないよう尻を決め直す
 */
function widen(range: ClipRange, durationSec: number, toward: "both" | "start" | "end"): ClipRange {
  let { startSec, endSec } = range;
  const lack = MIN_CLIP_SEC - (endSec - startSec);
  if (lack > 0) {
    if (toward === "both") startSec -= lack / 2;
    if (toward === "start") startSec -= lack;
    startSec = Math.max(0, Math.min(startSec, durationSec - MIN_CLIP_SEC));
    endSec = Math.min(durationSec, Math.max(endSec, startSec + MIN_CLIP_SEC));
  }
  startSec = round2(startSec);
  endSec = round2(endSec);
  if (lengthSec({ startSec, endSec }) < MIN_CLIP_SEC) endSec = round2(Math.min(durationSec, startSec + MIN_CLIP_SEC));
  return { startSec, endSec };
}

/** 行 i の既定の区間。余白は隣の行に食い込ませず、動画の終わりを越えず、1 秒に満たなければ前後へ広げる */
function lineBounds(lines: TranscriptLine[], i: number, durationSec: number): ClipRange {
  const line = lines[i]!;
  const previous = lines[i - 1];
  const next = lines[i + 1];
  // 行どうしが重なっている (手動字幕で起こりうる) と、余白が行の内側に入る。行そのものより狭くしない
  const startSec = Math.min(line.startSec, Math.max(0, line.startSec - HEAD_PAD_SEC, previous?.endSec ?? 0));
  const endSec = Math.min(
    durationSec,
    Math.max(line.endSec, Math.min(line.endSec + TAIL_PAD_SEC, next?.startSec ?? Number.POSITIVE_INFINITY)),
  );
  return widen({ startSec, endSec }, durationSec, "both");
}

/** 2 つの行の間の空き (秒)。重なっていれば 0 以下 */
function gapSec(a: TranscriptLine, b: TranscriptLine): number {
  return Math.max(a.startSec, b.startSec) - Math.min(a.endSec, b.endSec);
}

function addLine(segments: ClipRange[], lines: TranscriptLine[], i: number, durationSec: number): ClipRange[] {
  const line = lines[i]!;
  const own = lineBounds(lines, i, durationSec);
  const joins = (neighbor: TranscriptLine | undefined, segment: ClipRange): boolean =>
    neighbor !== undefined && gapSec(line, neighbor) <= JOIN_GAP_SEC && isLineInSegments(neighbor, [segment]);
  const touching = segments.filter(
    (segment) => overlapSec(segment, own) > 0 || joins(lines[i - 1], segment) || joins(lines[i + 1], segment),
  );
  const merged: ClipRange = {
    startSec: Math.min(own.startSec, ...touching.map((segment) => segment.startSec)),
    endSec: Math.max(own.endSec, ...touching.map((segment) => segment.endSec)),
  };
  return [...segments.filter((segment) => !touching.includes(segment)), merged];
}

function removeLine(segments: ClipRange[], lines: TranscriptLine[], i: number, durationSec: number): ClipRange[] {
  const line = lines[i]!;
  const previous = lines[i - 1];
  const next = lines[i + 1];
  const cutStart = previous === undefined ? line.startSec : Math.min(line.startSec, round2(previous.endSec + TAIL_PAD_SEC));
  const cutEnd = next === undefined ? line.endSec : Math.max(line.endSec, round2(next.startSec - HEAD_PAD_SEC));
  return segments.flatMap((segment) => {
    if (segment.endSec <= cutStart || segment.startSec >= cutEnd) return [segment];
    const pieces: [ClipRange, "start" | "end"][] = [
      [{ startSec: segment.startSec, endSec: Math.min(segment.endSec, cutStart) }, "start"],
      [{ startSec: Math.max(segment.startSec, cutEnd), endSec: segment.endSec }, "end"],
    ];
    return pieces.flatMap(([piece, outward]) => {
      if (piece.endSec <= piece.startSec) return [];
      if (lengthSec(piece) >= MIN_CLIP_SEC) return [piece];
      // 1 秒に満たない残り: まだ入っている行 (短い相づちなど) があれば外側へ広げて残す。
      // 無ければ捨てる (行の端の余白だけが残った区間を作らない)
      const holdsLine = lines.some((other, j) => j !== i && isLineInSegments(other, [piece]));
      return holdsLine ? [widen(piece, durationSec, outward)] : [];
    });
  });
}

export function setLinesSelected(
  clip: Clip,
  lines: TranscriptLine[],
  lineIds: string[],
  selected: boolean,
  durationSec = Number.POSITIVE_INFINITY,
): Clip {
  const wanted = new Set(lineIds);
  let segments = clip.segments;
  const changed: TranscriptLine[] = [];
  lines.forEach((line, i) => {
    if (!wanted.has(line.id)) return;
    // 既に入っている行を入れ直さない / 入っていない行を外さない
    if (isLineInSegments(line, segments) === selected) return;
    segments = selected ? addLine(segments, lines, i, durationSec) : removeLine(segments, lines, i, durationSec);
    changed.push(line);
  });

  let telops = clip.telops;
  if (selected) {
    const have = new Set(telops.map((telop) => telop.lineId));
    const added = changed
      .filter((line) => !have.has(line.id))
      .map((line) => ({
        startSec: line.startSec,
        endSec: line.endSec,
        text: line.text.slice(0, MAX_TELOP_TEXT_LENGTH),
        lineId: line.id,
      }));
    telops = [...telops, ...added];
  } else {
    const removed = new Set(changed.map((line) => line.id));
    telops = telops.filter((telop) => telop.lineId === undefined || !removed.has(telop.lineId));
  }

  return { segments: [...segments].sort((a, b) => a.startSec - b.startSec), telops };
}

/**
 * 「字幕に出さない」/「字幕に出す」。行のテロップの文字を空にする / 行の文字に戻す (空の文字のテロップは描かない。
 * テロップの今の作法)。その行のテロップが無ければ null
 */
export function toggleTelopHidden(clip: Clip, line: TranscriptLine): Clip | null {
  const index = clip.telops.findIndex((telop) => telop.lineId === line.id);
  const telop = clip.telops[index];
  if (telop === undefined) return null;
  const text = telop.text === "" ? line.text.slice(0, MAX_TELOP_TEXT_LENGTH) : "";
  return {
    segments: clip.segments,
    telops: clip.telops.map((item, i) => (i === index ? { ...item, text } : item)),
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-selection.test.ts tests/shared/transcript.test.ts tests/content/transcript-cache.test.ts && npm run typecheck`
期待: PASS (transcript-selection は 23 tests)、型エラー無し。期待値の数値 (2.8 / 5.3 / 11.3 / 53.8 / 14.3 / 17.8 など) が浮動小数で合わないときは、`round2` の漏れを探して実装を直す。合わない期待値を勝手に `toBeCloseTo` に変えない

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-selection.ts src/shared/transcript.ts src/content/transcript-cache.ts tests/content/transcript-selection.test.ts tests/shared/transcript.test.ts tests/content/transcript-cache.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 文字起こしの行の選び方から区間とテロップの組を計算する

ADR 0001 の、行を選ぶと続いた行が 1 つの区間になり行の文字がテロップになる規則を、状態機械に送る前の純粋な関数に
する。区間とテロップの一覧と ＋ 区間を追加は 1c まで残り、手で作った区間と行の選択が混ざるので、押した行のまわり
しか変えない (手作りの区間を作り直したり、中の行にテロップを作ったりしない)。余白は頭 0.2 秒・尻 0.3 秒で隣の行に
食い込ませず、1 秒に満たなければ広げ、3 秒より空いた行はまとめない。行の id は同じ開始の行で重なりうるので
重ねないようにし、重なった古い保存は読まない。
EOF
```

---

### Task 5: 文字起こしの欄 (見た目と操作)

**Files:**
- Create: `src/content/transcript-panel.ts`
- Modify: `src/content/styles.ts`、`src/content/transcript-loader.ts` (取り方の名前を export)
- Test: `tests/content/transcript-panel.test.ts`

**Interfaces:**
- Produces:
  - `type TranscriptRow = { id: string; startSec: number; text: string; selected: boolean; hidden: boolean; hasTelop: boolean }`
  - `type TranscriptHeader = { kind: "loading" } | { kind: "none" } | { kind: "failed"; reason: string } | { kind: "ready"; label: string }`
  - `type TranscriptView = { header: TranscriptHeader; dubbed: boolean; rows: TranscriptRow[]; enabled: boolean }`
  - `type TranscriptPanelCallbacks = { onToggle(id: string, extend: boolean): void; onEditText(id: string, text: string): boolean; onToggleHidden(id: string): void; onPlay(id: string): void; onRetry(): void }`
  - `type TranscriptPanel = { element: HTMLElement; update(view: TranscriptView): void; setCurrentTime(sec: number): void }`
  - `function createTranscriptPanel(callbacks: TranscriptPanelCallbacks): TranscriptPanel`
  - `styles.ts` の `TRANSCRIPT_STYLE`
  - `transcript-loader.ts` の `SOURCE_LABEL` を `export const TRANSCRIPT_SOURCE_LABEL` に改名して export (中身は同じ。`transcriptLogLine` の参照も直す)
  - DOM の目印: 根 `transcript`、見出しの取り方 `transcript-source`、案内 `transcript-notice`、取り直し `transcript-retry`、吹き替えの知らせ `transcript-dubbed`、行の箱 `transcript-lines`、行 `line` (`data-line-id` / `data-selected` / `data-hidden` / `data-current`)、今の行の印 `line-now` (今の行だけ `▶`)、時刻 `line-time`、文字 `line-text`、直す ✎ `line-edit-button`、直す欄 `line-edit`、字幕に出さない `hide-telop`

**操作の決め方 (cross-review 1 回目で決め直した):**
- **文字を直すのは ✎ ボタンから** (モックはダブルクリックだった)。ブラウザのダブルクリックは click → click → dblclick の順に届くので、行のクリック (入れる / 外す) と同じ行の上では両立しない。1 回目の click で行が外れてテロップが消え、2 回目でまた入る
- **IME の変換中の Enter / Esc では確定も取り消しもしない** (`isComposing` / `keyCode 229`)
- **行の要素は、行の並び (id の列) が変わったときだけ作り直す。** それ以外の描き直しは、変わった行の印と文字だけを直す。3 時間の配信の自動字幕は 8000 行ほどになり、状態が届くたびに全部を作り直すと止まって見える
- 押した・✎・字幕に出さない・時刻は、行の箱 1 か所で受ける (行ごとにリスナーを付けない)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/transcript-panel.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import {
  createTranscriptPanel,
  type TranscriptPanelCallbacks,
  type TranscriptView,
} from "@/content/transcript-panel";

function setup(overrides: Partial<TranscriptPanelCallbacks> = {}) {
  const callbacks: TranscriptPanelCallbacks = {
    onToggle: vi.fn(),
    onEditText: vi.fn(() => true),
    onToggleHidden: vi.fn(),
    onPlay: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  const panel = createTranscriptPanel(callbacks);
  document.body.replaceChildren(panel.element);
  return { panel, callbacks };
}

const view = (overrides: Partial<TranscriptView> = {}): TranscriptView => ({
  header: { kind: "ready", label: "公式字幕 (自動)" },
  dubbed: false,
  enabled: true,
  rows: [
    { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: false, hidden: false, hasTelop: false },
    { id: "b", startSec: 65, text: "ここは絶対に右から", selected: true, hidden: false, hasTelop: true },
    { id: "c", startSec: 70, text: "えーと", selected: true, hidden: true, hasTelop: true },
  ],
  ...overrides,
});

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-role='line']")];
const role = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-role='${name}']`);
const part = (index: number, name: string): HTMLElement | null =>
  rows()[index]?.querySelector<HTMLElement>(`[data-role='${name}']`) ?? null;
const editor = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']");
const key = (target: Element, init: KeyboardEventInit): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
};

describe("行を描く", () => {
  test("時刻と文字を出し、選んでいる行・出さない行に印を付ける", () => {
    const { panel } = setup();
    panel.update(view());
    expect(rows().map((row) => row.dataset.lineId)).toEqual(["a", "b", "c"]);
    expect(rows().map((_, i) => part(i, "line-time")?.textContent)).toEqual(["0:01", "1:05", "1:10"]);
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "true", "true"]);
    expect(rows().map((row) => row.dataset.hidden)).toEqual(["false", "false", "true"]);
    expect(role("transcript-source")?.textContent).toBe("公式字幕 (自動)");
  });

  test("文字はタグとして解釈しない (textContent)", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "x", startSec: 0, text: "<img src=x onerror=alert(1)>", selected: false, hidden: false, hasTelop: false }] }));
    expect(document.querySelector("img")).toBeNull();
    expect(part(0, "line-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  test("選んでいる行にだけ ✎ と「字幕に出さない」があり、出さない行は「字幕に出す」", () => {
    const { panel } = setup();
    panel.update(view());
    expect(rows().map((_, i) => part(i, "hide-telop")?.textContent ?? null)).toEqual([null, "字幕に出さない", "字幕に出す"]);
    expect(rows().map((_, i) => part(i, "line-edit-button") !== null)).toEqual([false, true, true]);
  });

  test("区間に入っていてもテロップの無い行 (手で作った区間の中) には、✎ も「字幕に出さない」も出さない", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "m", startSec: 3, text: "手作りの区間の中", selected: true, hidden: false, hasTelop: false }] }));
    expect(rows()[0]?.dataset.selected).toBe("true");
    expect(part(0, "line-edit-button")).toBeNull();
    expect(part(0, "hide-telop")).toBeNull();
  });

  test("行の並びが同じなら、行の要素を作り直さずに印と文字だけ直す", () => {
    const { panel } = setup();
    panel.update(view());
    const before = rows();
    panel.update(
      view({
        rows: [
          { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: true, hidden: false, hasTelop: true },
          { id: "b", startSec: 65, text: "直した", selected: true, hidden: false, hasTelop: true },
          { id: "c", startSec: 70, text: "えーと", selected: false, hidden: false, hasTelop: false },
        ],
      }),
    );
    rows().forEach((row, i) => expect(row).toBe(before[i]));
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "true", "false"]);
    expect(part(1, "line-text")?.textContent).toBe("直した");
    expect(part(2, "hide-telop")).toBeNull();
  });
});

describe("見出しと案内", () => {
  test("取っている間・字幕が無い・取れなかった、をそれぞれ出す。取れなかったときは取り直せる", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ header: { kind: "loading" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe("文字起こしを取っています…");
    panel.update(view({ header: { kind: "none" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe("この動画には公式字幕がありません");
    panel.update(view({ header: { kind: "failed", reason: "字幕が空で返りました" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toContain("文字起こしを取れませんでした: 字幕が空で返りました");
    role("transcript-retry")?.click();
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
  });

  test("吹き替えの音声が流れていれば知らせる", () => {
    const { panel } = setup();
    panel.update(view({ dubbed: true }));
    expect(role("transcript-dubbed")?.textContent).toContain("吹き替えの音声が流れています");
    panel.update(view({ dubbed: false }));
    expect(role("transcript-dubbed")).toBeNull();
  });
});

describe("操作", () => {
  test("行を押すと入れる / 外すを伝える。Shift 付きはまとめて", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    rows()[0]?.click();
    part(1, "line-text")?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(callbacks.onToggle).toHaveBeenNthCalledWith(1, "a", false);
    expect(callbacks.onToggle).toHaveBeenNthCalledWith(2, "b", true);
  });

  test("時刻を押すとその行から再生を伝え、行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(0, "line-time")?.click();
    expect(callbacks.onPlay).toHaveBeenCalledWith("a");
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("「字幕に出さない」を押すと伝え、行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "hide-telop")?.click();
    expect(callbacks.onToggleHidden).toHaveBeenCalledWith("b");
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("✎ で直す欄になり、Enter で確定、Esc で戻す。行の選択は動かさない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    expect(editor()?.value).toBe("ここは絶対に右から");
    editor()!.value = "ここは絶対に右から回るべきだった";
    key(editor()!, { key: "Enter" });
    expect(callbacks.onEditText).toHaveBeenCalledWith("b", "ここは絶対に右から回るべきだった");
    expect(editor()).toBeNull();

    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(callbacks.onEditText).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("直す欄を押しても、行の入れる / 外すにしない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    editor()?.click();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("IME の変換中の Enter と Esc では、確定も取り消しもしない", () => {
    const { panel, callbacks } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Enter", isComposing: true });
    key(editor()!, { key: "Escape", isComposing: true });
    key(editor()!, { key: "Enter", keyCode: 229 });
    expect(callbacks.onEditText).not.toHaveBeenCalled();
    expect(editor()).not.toBeNull();
  });

  test("確定を拒まれたら (長すぎる) 直す欄を閉じない", () => {
    const { panel } = setup({ onEditText: vi.fn(() => false) });
    panel.update(view());
    part(1, "line-edit-button")?.click();
    key(editor()!, { key: "Enter" });
    expect(editor()).not.toBeNull();
  });

  test("直している間に描き直されても、直す欄と書きかけを残す (input が来ていなくても)", () => {
    const { panel } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    editor()!.value = "書きかけ";
    panel.update(view());
    expect(editor()?.value).toBe("書きかけ");
  });

  test("直している行が区間から外れたら、直す欄を閉じる", () => {
    const { panel } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    panel.update(
      view({
        rows: [
          { id: "a", startSec: 1, text: "さあ残り 30 秒", selected: false, hidden: false, hasTelop: false },
          { id: "b", startSec: 65, text: "ここは絶対に右から", selected: false, hidden: false, hasTelop: false },
        ],
      }),
    );
    expect(editor()).toBeNull();
  });

  test("押せない間 (enabled: false) は入れる / 外す・直す・出さないを伝えない。再生は伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ enabled: false }));
    rows()[0]?.click();
    part(1, "hide-telop")?.click();
    part(1, "line-edit-button")?.click();
    part(0, "line-time")?.click();
    expect(callbacks.onToggle).not.toHaveBeenCalled();
    expect(callbacks.onToggleHidden).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(callbacks.onPlay).toHaveBeenCalledWith("a");
  });
});

test("setCurrentTime で、再生位置を含む行 (その位置より前で最後に始まる行) に ▶ を付ける", () => {
  const { panel } = setup();
  panel.update(view());
  const marks = (): string[] => rows().map((row) => `${row.dataset.current}:${row.querySelector("[data-role='line-now']")?.textContent ?? ""}`);
  panel.setCurrentTime(66);
  expect(marks()).toEqual(["false:", "true:▶", "false:"]);
  panel.setCurrentTime(0.5);
  expect(marks()).toEqual(["false:", "false:", "false:"]);
  panel.setCurrentTime(100);
  expect(marks()).toEqual(["false:", "false:", "true:▶"]);
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts`
期待: FAIL (`Cannot find module '@/content/transcript-panel'`)

- [ ] **Step 3: 実装**

`src/content/transcript-loader.ts`: `const SOURCE_LABEL: Record<Transcript["source"], string>` を `export const TRANSCRIPT_SOURCE_LABEL: Record<Transcript["source"], string>` に改名し、`transcriptLogLine` の `SOURCE_LABEL[...]` も `TRANSCRIPT_SOURCE_LABEL[...]` にする (欄の見出しとログで同じ名前を出す)。

`src/content/styles.ts` の `TELOP_STYLE` の後に足す:

```typescript
/**
 * 文字起こしの欄 (`transcript-panel.ts`)。区間とテロップの一覧の上に並ぶので見た目を揃える。
 * **行の箱だけがスクロールする** (欄の下の一覧に手が届くよう、高さに上限を持つ)。
 * 行は文字を選べなくする (Shift + クリックで文字が選ばれて、まとめて選ぶ操作の邪魔をしない)
 */
const TRANSCRIPT_ROW =
  "display:grid;grid-template-columns:12px 40px 1fr auto;gap:4px;align-items:start;padding:3px 6px;border-radius:6px;cursor:pointer;user-select:none;";
const TRANSCRIPT_TIME = `border:none;background:transparent;font-family:${FONT};font-size:11px;padding:2px 0;cursor:pointer;text-align:left;font-variant-numeric:tabular-nums;`;
const TRANSCRIPT_TEXT = "font-size:12px;white-space:pre-wrap;word-break:break-word;";
export const TRANSCRIPT_STYLE = {
  root: "display:flex;flex-direction:column;gap:6px;",
  header: "display:flex;align-items:center;gap:8px;",
  title: "color:var(--ytc-text);font-size:12px;font-weight:600;flex:1;",
  source: "color:var(--ytc-text-sub);font-size:11px;",
  notice: "color:var(--ytc-text-sub);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;",
  dubbed: "color:var(--ytc-text);font-size:11px;padding:4px 8px;border-radius:6px;background:var(--ytc-surface);",
  lines: "position:relative;display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;",
  row: `${TRANSCRIPT_ROW}background:transparent;border-left:3px solid transparent;`,
  rowSelected: `${TRANSCRIPT_ROW}background:var(--ytc-surface);border-left:3px solid var(--ytc-accent);`,
  now: "color:var(--ytc-accent);font-size:10px;padding-top:3px;",
  time: `${TRANSCRIPT_TIME}color:var(--ytc-text-sub);`,
  timeCurrent: `${TRANSCRIPT_TIME}color:var(--ytc-accent);font-weight:600;`,
  text: `${TRANSCRIPT_TEXT}color:var(--ytc-text);`,
  textHidden: `${TRANSCRIPT_TEXT}color:var(--ytc-text-sub);text-decoration:line-through;`,
  actions: "display:flex;gap:4px;",
  edit: `${TELOP_STYLE.textarea}user-select:text;`,
  textButton: TELOP_STYLE.textButton,
} as const;
```

`src/content/transcript-panel.ts`:

```typescript
import { TRANSCRIPT_STYLE } from "@/content/styles";
import { formatTime } from "@/shared/time";

/**
 * 文字起こしの欄 (ADR 0001)。区間・テロップの窓の先頭に出す。
 *
 * **選択は持たない。** 行が区間に入っているかは状態機械の区間から決まり、youtube.ts が計算して渡す
 * (区間の一覧と同じ作法)。この欄は渡された行を描き、押されたことを伝えるだけ。
 * **文字は textContent でだけ入れる** (字幕の文字はページから届く。タグとして解釈しない)。
 * **行の要素は、行の並びが変わったときだけ作り直す** (長い配信では 8000 行ほどになる。状態が届くたびに全部を
 * 作り直すと止まって見える)。それ以外は、変わった行の印と文字だけを直す
 */

export type TranscriptRow = {
  id: string;
  startSec: number;
  /** 出す文字。区間に入っていて直した行は、直した文字 */
  text: string;
  /** 区間に入っている */
  selected: boolean;
  /** 区間に入っているが、テロップには出さない */
  hidden: boolean;
  /**
   * この行から作ったテロップがある。✎ と「字幕に出さない」はこれがあるときだけ出す
   * (手で作った区間の中の行は、区間に入っていてもテロップが無い。押しても何も起きないボタンを出さない)
   */
  hasTelop: boolean;
};

export type TranscriptHeader =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; label: string };

export type TranscriptView = {
  header: TranscriptHeader;
  dubbed: boolean;
  rows: TranscriptRow[];
  /** 入れる / 外す・直す・出さないを受け付けるか (録画中・録画した後は false)。再生は欄では止めない (youtube.ts が見る) */
  enabled: boolean;
};

export type TranscriptPanelCallbacks = {
  onToggle(id: string, extend: boolean): void;
  /** 文字の確定。送らなかったら false (直す欄を閉じない) */
  onEditText(id: string, text: string): boolean;
  onToggleHidden(id: string): void;
  onPlay(id: string): void;
  onRetry(): void;
};

export type TranscriptPanel = {
  element: HTMLElement;
  update(view: TranscriptView): void;
  /** 再生位置。毎フレーム呼ばれる: 印を付け替えるのは、印を付ける行が変わったときだけ */
  setCurrentTime(sec: number): void;
};

/** 手でスクロールした後、自動で追わない時間 (ミリ秒) */
const FOLLOW_PAUSE_MS = 5000;

const DUBBED_TEXT =
  "吹き替えの音声が流れています。字幕は元の音声のものなので、録画の音と合わないことがあります";

/** 行 1 つ分の要素。描いた中身 (`row`) を覚えておき、変わったところだけ直す */
type RowParts = {
  element: HTMLElement;
  now: HTMLElement;
  time: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  row: TranscriptRow | null;
};

function sameIds(parts: RowParts[], rows: TranscriptRow[]): boolean {
  return parts.length === rows.length && rows.every((row, i) => parts[i]?.element.dataset.lineId === row.id);
}

export function createTranscriptPanel(callbacks: TranscriptPanelCallbacks): TranscriptPanel {
  const element = document.createElement("div");
  element.dataset.role = "transcript";
  element.style.cssText = TRANSCRIPT_STYLE.root;

  const header = document.createElement("div");
  header.style.cssText = TRANSCRIPT_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = TRANSCRIPT_STYLE.title;
  title.textContent = "文字起こし";
  const source = document.createElement("span");
  source.dataset.role = "transcript-source";
  source.style.cssText = TRANSCRIPT_STYLE.source;
  header.append(title, source);

  const notice = document.createElement("div");
  notice.dataset.role = "transcript-notice";
  notice.style.cssText = TRANSCRIPT_STYLE.notice;

  const dubbedBox = document.createElement("div");
  const list = document.createElement("div");
  list.dataset.role = "transcript-lines";
  list.style.cssText = TRANSCRIPT_STYLE.lines;

  element.append(header, notice, dubbedBox, list);

  let view: TranscriptView = { header: { kind: "loading" }, dubbed: false, rows: [], enabled: true };
  /** 直している行と書きかけ。描き直しても残す */
  let editing: { id: string; draft: string } | null = null;
  let editor: HTMLTextAreaElement | null = null;
  let currentIndex = -1;
  let parts: RowParts[] = [];
  let userScrolledAt = Number.NEGATIVE_INFINITY;
  let scrollingByUs = false;

  list.addEventListener("scroll", () => {
    if (scrollingByUs) {
      scrollingByUs = false;
      return;
    }
    userScrolledAt = Date.now();
  });

  // 押されたものは行の箱 1 か所で受ける (8000 行に 1 つずつリスナーを付けない)
  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-role='line-edit']") !== null) return;
    const rowElement = target.closest<HTMLElement>("[data-role='line']");
    const id = rowElement?.dataset.lineId;
    if (id === undefined) return;
    const action = target.closest<HTMLElement>(
      "[data-role='line-time'], [data-role='hide-telop'], [data-role='line-edit-button']",
    )?.dataset.role;
    if (action === "line-time") {
      callbacks.onPlay(id);
      return;
    }
    if (!view.enabled) return;
    if (action === "hide-telop") callbacks.onToggleHidden(id);
    else if (action === "line-edit-button") startEdit(id);
    else callbacks.onToggle(id, event.shiftKey);
  });

  function renderHeader(): void {
    const h = view.header;
    source.textContent = h.kind === "ready" ? h.label : "";
    notice.replaceChildren();
    notice.hidden = h.kind === "ready";
    if (h.kind === "loading") notice.textContent = "文字起こしを取っています…";
    if (h.kind === "none") notice.textContent = "この動画には公式字幕がありません";
    if (h.kind === "failed") {
      const reason = document.createElement("span");
      reason.textContent = `文字起こしを取れませんでした: ${h.reason}`;
      const retry = document.createElement("button");
      retry.dataset.role = "transcript-retry";
      retry.textContent = "もう一度取る";
      retry.style.cssText = TRANSCRIPT_STYLE.textButton;
      retry.addEventListener("click", () => callbacks.onRetry());
      notice.append(reason, retry);
    }
    dubbedBox.replaceChildren();
    if (view.dubbed) {
      const box = document.createElement("div");
      box.dataset.role = "transcript-dubbed";
      box.style.cssText = TRANSCRIPT_STYLE.dubbed;
      box.textContent = DUBBED_TEXT;
      dubbedBox.append(box);
    }
  }

  function makeButton(role: string, label: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = TRANSCRIPT_STYLE.textButton;
    return button;
  }

  function makeEditor(id: string): HTMLTextAreaElement {
    const edit = document.createElement("textarea");
    edit.dataset.role = "line-edit";
    edit.style.cssText = TRANSCRIPT_STYLE.edit;
    edit.value = editing?.id === id ? editing.draft : "";
    edit.addEventListener("input", () => {
      if (editing !== null) editing.draft = edit.value;
    });
    edit.addEventListener("keydown", (event) => {
      // ページのショートカット (YouTube の k / j など) に流さない
      event.stopPropagation();
      // IME の変換を確かめる Enter / 取り消す Esc は、直す欄のものではない
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finishEdit(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finishEdit(false);
      }
    });
    return edit;
  }

  function startEdit(id: string): void {
    const row = view.rows.find((item) => item.id === id);
    if (row === undefined || !row.selected || !row.hasTelop) return;
    editing = { id, draft: row.text };
    patchRows();
    editor?.focus();
  }

  function finishEdit(commit: boolean): void {
    if (editing === null) return;
    if (editor !== null) editing.draft = editor.value;
    if (commit && !callbacks.onEditText(editing.id, editing.draft)) return;
    editing = null;
    patchRows();
  }

  function buildRow(): RowParts {
    const rowElement = document.createElement("div");
    rowElement.dataset.role = "line";
    const now = document.createElement("span");
    now.dataset.role = "line-now";
    now.style.cssText = TRANSCRIPT_STYLE.now;
    const time = document.createElement("button");
    time.dataset.role = "line-time";
    time.title = "この行から再生";
    const body = document.createElement("span");
    const actions = document.createElement("span");
    actions.style.cssText = TRANSCRIPT_STYLE.actions;
    rowElement.append(now, time, body, actions);
    return { element: rowElement, now, time, body, actions, row: null };
  }

  function paintCurrent(part: RowParts, current: boolean): void {
    part.element.dataset.current = current ? "true" : "false";
    part.now.textContent = current ? "▶" : "";
    part.time.style.cssText = current ? TRANSCRIPT_STYLE.timeCurrent : TRANSCRIPT_STYLE.time;
  }

  /** 1 行を描く。前に描いた中身と同じ (直す欄の出し入れも無い) なら何もしない */
  function paintRow(part: RowParts, row: TranscriptRow): void {
    const before = part.row;
    const isEditing = editing?.id === row.id;
    const wasEditing = part.body.dataset.role === "line-edit";
    if (
      before !== null &&
      before.selected === row.selected &&
      before.hidden === row.hidden &&
      before.text === row.text &&
      before.hasTelop === row.hasTelop &&
      isEditing === wasEditing
    ) {
      if (isEditing) editor = part.body as HTMLTextAreaElement;
      return;
    }
    part.row = row;
    part.element.dataset.lineId = row.id;
    part.element.dataset.selected = row.selected ? "true" : "false";
    part.element.dataset.hidden = row.hidden ? "true" : "false";
    part.element.style.cssText = row.selected ? TRANSCRIPT_STYLE.rowSelected : TRANSCRIPT_STYLE.row;
    if (before === null || before.startSec !== row.startSec) part.time.textContent = formatTime(row.startSec);

    if (isEditing) {
      if (!wasEditing) {
        const edit = makeEditor(row.id);
        part.body.replaceWith(edit);
        part.body = edit;
      }
      editor = part.body as HTMLTextAreaElement;
    } else {
      if (wasEditing) {
        const span = document.createElement("span");
        part.body.replaceWith(span);
        part.body = span;
      }
      part.body.dataset.role = "line-text";
      part.body.textContent = row.text;
      part.body.style.cssText = row.hidden ? TRANSCRIPT_STYLE.textHidden : TRANSCRIPT_STYLE.text;
    }

    part.actions.replaceChildren();
    if (row.selected && row.hasTelop) {
      part.actions.append(
        makeButton("line-edit-button", "✎", "テロップの文字を直す"),
        makeButton("hide-telop", row.hidden ? "字幕に出す" : "字幕に出さない", "区間に残したまま、テロップだけ出さない / 出す"),
      );
    }
  }

  /** 行の並び (id の列) が変わったときだけ作り直す。ほかは paintRow が変わった行だけを直す */
  function patchRows(): void {
    if (!sameIds(parts, view.rows)) {
      parts = view.rows.map(() => buildRow());
      list.replaceChildren(...parts.map((part) => part.element));
      for (const part of parts) paintCurrent(part, false);
      currentIndex = -1;
    }
    editor = null;
    view.rows.forEach((row, i) => paintRow(parts[i]!, row));
  }

  /** 行の箱の中だけをスクロールして、今の行を見える所に入れる (scrollIntoView はページまで動かす) */
  function follow(): void {
    const row = parts[currentIndex]?.element;
    if (row === undefined || Date.now() - userScrolledAt < FOLLOW_PAUSE_MS) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
    const before = list.scrollTop;
    list.scrollTop = Math.max(0, top - list.clientHeight / 3);
    // 端まで行っていて値が変わらないと scroll が来ない。旗を立てたままだと、次の手のスクロールを見落とす
    if (list.scrollTop !== before) scrollingByUs = true;
  }

  return {
    element,
    update(next): void {
      // 書きかけは input を待たずに取り込む (IME の途中や、input が来ないまま描き直されたとき)
      if (editing !== null && editor !== null) editing.draft = editor.value;
      view = next;
      // 直している行が区間から外れたら、直す欄を閉じる
      if (editing !== null && !next.rows.some((row) => row.id === editing?.id && row.selected && row.hasTelop)) editing = null;
      element.style.opacity = next.enabled ? "1" : "0.5";
      renderHeader();
      patchRows();
    },
    setCurrentTime(sec): void {
      // 行は開始の早い順。sec より前で最後に始まる行
      let low = 0;
      let high = view.rows.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (view.rows[mid]!.startSec <= sec) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (found === currentIndex) return;
      const previous = parts[currentIndex];
      if (previous !== undefined) paintCurrent(previous, false);
      currentIndex = found;
      const now = parts[currentIndex];
      if (now !== undefined) {
        paintCurrent(now, true);
        follow();
      }
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts tests/content/transcript-loader.test.ts && npm run typecheck`
期待: PASS (transcript-panel は 18 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-panel.ts src/content/styles.ts src/content/transcript-loader.ts tests/content/transcript-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 文字起こしの欄の見た目と操作を作る

ADR 0001 の欄を、渡された行を描いて押されたことを伝えるだけの部品にする (選択は状態機械の区間から決まる)。行の
クリックで入れる / 外す、Shift でまとめて、✎ で文字を直す、字幕に出さない、時刻で再生、再生中の行の ▶、取っている
間・字幕が無い・取れなかったときの案内と取り直し、吹き替えの知らせを持つ。

文字を直すのはモックのダブルクリックではなく ✎ にする。ダブルクリックは click 2 回の後に届くので、同じ行のクリック
(入れる / 外す) と両立しない。IME の変換中の Enter と Esc では確定しない。長い配信は 8000 行ほどになるので、行の
要素は行の並びが変わったときだけ作り直し、ほかは変わった行だけを直す。字幕の文字はページから届くので textContent
でだけ入れる。今の行への追従は欄の中だけをスクロールする (ページは動かさない)。
EOF
```

---

### Task 6: youtube.ts に欄を組み込む

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube-transcript-panel.test.ts` (Create)、`tests/content/youtube.test.ts` / `tests/content/youtube-dock-load.test.ts` (窓の出し方の変化に合わせた直し)

**Interfaces:**
- Consumes: Task 4 の `isLineInSegments` / `lineIdsBetween` / `setLinesSelected` / `toggleTelopHidden`、Task 5 の `createTranscriptPanel` ほか、1a の `TranscriptStatus` / `TranscriptLine`、Task 2 の `SET_CLIP`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube-transcript-panel.test.ts`:

```typescript
// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { reduce } from "@/background/state";
import type { TranscriptStatus } from "@/content/transcript-loader";
import type { Message } from "@/shared/messages";
import type { ClipEvent, ClipState } from "@/shared/types";

/**
 * youtube.ts に組み込んだ文字起こしの欄 (段階 1b-2)。loader は偽物にして、状態を onChange で流す。
 * 状態機械は本物の reduce を使い、送ったイベントの答えを state/changed として流し返す (router の代わり)
 */

const fake = vi.hoisted(() => ({
  load: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  status: vi.fn(() => ({ kind: "idle" })),
  onChange: null as null | ((status: TranscriptStatus) => void),
}));

vi.mock("@/content/transcript-loader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/transcript-loader")>()),
  createDefaultTranscriptLoader: (onChange: (status: TranscriptStatus) => void) => {
    fake.onChange = onChange;
    return fake;
  },
}));

type MessageListener = (message: Message, sender: unknown, respond: (response?: unknown) => void) => void;
const messageListeners: MessageListener[] = [];
let state: ClipState = { kind: "idle" };
let events: ClipEvent[] = [];

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function emit(next: ClipState): void {
  state = next;
  for (const listener of [...messageListeners]) listener({ type: "state/changed", state: next }, {}, () => undefined);
}

const META = { videoId: "video-a", title: "テスト動画", channelId: "" };

const LINES = [
  { id: "youtube-asr:1.00", startSec: 1, endSec: 3, text: "さあ残り 30 秒" },
  { id: "youtube-asr:4.00", startSec: 4, endSec: 6, text: "ここは絶対に右から" },
  { id: "youtube-asr:7.00", startSec: 7, endSec: 9, text: "えーと" },
];

function ready(dubbed = false): void {
  fake.onChange?.({
    kind: "ready",
    videoId: "video-a",
    dubbed,
    transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: LINES },
  });
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-role='line']")];

beforeAll(async () => {
  document.title = "テスト動画 - YouTube";
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key?: unknown): Promise<Record<string, unknown>> => (key === "enabled" ? { enabled: true } : {}),
        set: async (): Promise<void> => undefined,
      },
      sync: { get: async (): Promise<Record<string, unknown>> => ({}), set: async (): Promise<void> => undefined },
      onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
    },
    runtime: {
      onMessage: {
        addListener: (fn: MessageListener): void => {
          messageListeners.push(fn);
        },
        removeListener: (fn: MessageListener): void => {
          const index = messageListeners.indexOf(fn);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
      sendMessage: async (message: Message): Promise<{ state: ClipState }> => {
        if (message.type === "clip/event") {
          events.push(message.event);
          const next = reduce(state, message.event);
          // router と同じく、拒まれた遷移 (internal-error) は状態を変えない
          if (!(next.kind === "failed" && next.reason === "internal-error")) {
            setTimeout(() => emit(next), 0);
            return { state: next };
          }
        }
        return { state };
      },
    },
  });
  await import("@/content/youtube");
  await flush();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  emit({ kind: "idle" });
  await flush();
  events = [];
});

describe("文字起こしの欄 (段階 1b-2)", () => {
  test("区間・テロップの窓の先頭に欄があり、区間が無くても窓は出ている", async () => {
    ready();
    await flush();
    const list = document.getElementById("yt-clip-list");
    expect(list?.hidden).toBe(false);
    expect(document.querySelector("#yt-clip-list-body")?.firstElementChild?.getAttribute("data-role")).toBe("transcript");
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("さあ残り 30 秒"),
      expect.stringContaining("ここは絶対に右から"),
      expect.stringContaining("えーと"),
    ]);
  });

  test("行を押すと、その行の区間とテロップを SET_CLIP で送り、行が選ばれる", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(events).toEqual([
      {
        type: "SET_CLIP",
        segments: [{ startSec: 3.8, endSec: 6.3 }],
        telops: [{ startSec: 4, endSec: 6, text: "ここは絶対に右から", lineId: "youtube-asr:4.00" }],
        meta: expect.objectContaining({ videoId: "video-a" }),
      },
    ]);
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "true", "false"]);
    expect(document.querySelectorAll("[data-role='segment']")).toHaveLength(1);
  });

  test("もう一度押すと外れ、区間もテロップも無くなる (idle)", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(state).toEqual({ kind: "idle" });
    expect(rows().every((row) => row.dataset.selected === "false")).toBe(true);
  });

  test("Shift + クリックで、直前に押した行からまとめて入る", async () => {
    ready();
    await flush();
    rows()[0]?.click();
    await flush();
    rows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(state).toMatchObject({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }] });
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "true", "true"]);
  });

  test("✎ で直した文字はテロップの文字になる", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.querySelector<HTMLElement>("[data-role='line-edit-button']")?.click();
    const edit = document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']")!;
    edit.value = "ここは絶対に右から回るべきだった";
    edit.dispatchEvent(new Event("input"));
    edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "ここは絶対に右から回るべきだった", lineId: "youtube-asr:4.00" }] });
    expect(rows()[1]?.querySelector("[data-role='line-text']")?.textContent).toBe("ここは絶対に右から回るべきだった");
  });

  test("「字幕に出さない」でテロップの文字が空になり、もう一度で戻る", async () => {
    ready();
    await flush();
    rows()[2]?.click();
    await flush();
    rows()[2]?.querySelector<HTMLElement>("[data-role='hide-telop']")?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "", lineId: "youtube-asr:7.00" }] });
    expect(rows()[2]?.dataset.hidden).toBe("true");
    rows()[2]?.querySelector<HTMLElement>("[data-role='hide-telop']")?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "えーと" }] });
  });

  test("録画中は行を押しても送らず、時刻を押しても動画を動かさない", async () => {
    ready();
    await flush();
    emit({ kind: "recording", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    events = [];
    const video = document.querySelector("video")!;
    video.currentTime = 0;
    rows()[0]?.click();
    rows()[2]?.querySelector<HTMLElement>("[data-role='line-time']")?.click();
    await flush();
    expect(events).toEqual([]);
    expect(video.currentTime).toBe(0);
  });

  test("録画した後 (preview) は欄が薄く、撮り直し (ready) に戻るとすぐ押せる", async () => {
    ready();
    await flush();
    const panel = document.querySelector<HTMLElement>("[data-role='transcript']")!;
    emit({ kind: "preview", clipId: "c", mimeType: "video/mp4", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    expect(panel.style.opacity).toBe("0.5");
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META });
    await flush();
    expect(panel.style.opacity).toBe("1");
    events = [];
    rows()[0]?.click();
    await flush();
    expect(events.map((event) => event.type)).toEqual(["SET_CLIP"]);
  });

  test("上限の秒数を超える区間になるなら、送らずに理由を出す", async () => {
    // 2 秒の行を 1 秒おきに 40 行 (0〜119 秒)。まとめて選ぶと 1 区間が 60 秒を超える
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, startSec: i * 3, endSec: i * 3 + 2, text: `行 ${i}` }));
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: many },
    });
    await flush();
    rows()[0]?.click();
    await flush();
    events = [];
    rows()[39]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(events).toEqual([]);
    expect(document.body.textContent).toContain("1 つの区間は 60 秒までです");
  });

  test("拒まれた Shift + クリックでは、起点を動かさない", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, startSec: i * 3, endSec: i * 3 + 2, text: `行 ${i}` }));
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: many },
    });
    await flush();
    rows()[0]?.click();
    await flush();
    rows()[39]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    rows()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await flush();
    expect(state).toMatchObject({ kind: "ready", segments: [{ startSec: 0, endSec: 8.3 }] });
  });

  test("答えを待たずに続けて押しても、先に押した行は消えない", async () => {
    ready();
    await flush();
    rows()[0]?.click();
    rows()[2]?.click();
    await flush();
    expect(state).toMatchObject({
      kind: "ready",
      segments: [
        { startSec: 0.8, endSec: 3.3 },
        { startSec: 6.8, endSec: 9.3 },
      ],
    });
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "false", "true"]);
  });

  test("やり直せる区間を持つ失敗の間は、欄が薄く、押しても送らない", async () => {
    ready();
    await flush();
    emit({
      kind: "failed",
      reason: "recording-aborted",
      segments: [{ startSec: 10, endSec: 20 }],
      telops: [{ startSec: 11, endSec: 12, text: "手" }],
      meta: META,
    });
    await flush();
    events = [];
    expect(document.querySelector<HTMLElement>("[data-role='transcript']")?.style.opacity).toBe("0.5");
    rows()[0]?.click();
    await flush();
    expect(events).toEqual([]);
  });

  test("直した行を続けて 2 回押す (外して入れ直す) と、直した文字に戻る", async () => {
    ready();
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.querySelector<HTMLElement>("[data-role='line-edit-button']")?.click();
    const edit = document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']")!;
    edit.value = "直した";
    edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    rows()[1]?.click();
    await flush();
    rows()[1]?.click();
    await flush();
    expect(state).toMatchObject({ telops: [{ text: "直した", lineId: "youtube-asr:4.00" }] });
  });

  test("＋ 区間を追加で作った区間は、欄で離れた行を押しても変わらない", async () => {
    ready();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 100, endSec: 115 }], telops: [], meta: META });
    await flush();
    rows()[0]?.click();
    await flush();
    expect(state).toMatchObject({ segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 100, endSec: 115 }] });
  });

  test("取れなかったら理由と「もう一度取る」を出し、押すと取り直す", async () => {
    fake.onChange?.({ kind: "failed", videoId: "video-a", reason: "字幕が空で返りました" });
    await flush();
    expect(document.querySelector("[data-role='transcript-notice']")?.textContent).toContain("字幕が空で返りました");
    document.querySelector<HTMLElement>("[data-role='transcript-retry']")?.click();
    expect(fake.retry).toHaveBeenCalled();
  });

  test("吹き替えの音声が流れていれば欄に知らせる", async () => {
    ready(true);
    await flush();
    expect(document.querySelector("[data-role='transcript-dubbed']")?.textContent).toContain("吹き替えの音声が流れています");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube-transcript-panel.test.ts`
期待: FAIL (欄が無い)

- [ ] **Step 3: 実装**

`src/content/youtube.ts`:

(1) import を足す (`TRANSCRIPT_SOURCE_LABEL` は既にある `@/content/transcript-loader` の import に足す):
```typescript
import { createTranscriptPanel, type TranscriptPanel, type TranscriptView } from "@/content/transcript-panel";
import {
  isLineInSegments,
  lineIdsBetween,
  setLinesSelected,
  toggleTelopHidden,
  type Clip,
} from "@/content/transcript-selection";
import type { TranscriptLine } from "@/shared/transcript";
```
(`MAX_TELOP_TEXT_LENGTH` は既に import されている。されていなければ `@/shared/telop` から足す)

(2) `let transcriptLoader` の近くに足す:
```typescript
/** 文字起こしの欄 (区間・テロップの窓の先頭)。バーと一緒に buildBar が作り直す */
let transcriptPanel: TranscriptPanel | null = null;
/** 文字起こしの最新の状態 (loader から)。欄を描き直すときに読む */
let transcriptStatus: TranscriptStatus = { kind: "idle" };
/** 直前に押した行 (Shift + クリックの起点) */
let anchorLineId: string | null = null;
/** 欄から送ったけれど、状態機械の答えがまだ届いていない組 (clipBase の doc) */
let pendingClip: Clip | null = null;
/** 外した行のテロップの文字 (行の id ごと)。入れ直したら戻す。動画が変わったら捨てる */
const editedLineTexts = new Map<string, string>();
/** 届いた状態が failed で、RETRY で戻れる区間を持っている (欄を押せなくする) */
let failedKeepsClip = false;
```

(3) `onTranscriptStatus` を次にする (doc の「段階 1a では表示する欄がまだ無いので、結末だけをコンソールに 1 行残す」→「欄を描き直し、結末をコンソールに 1 行残す」):
```typescript
function onTranscriptStatus(status: TranscriptStatus): void {
  if (!running) return;
  transcriptStatus = status;
  const line = transcriptLogLine(status);
  if (line !== null) console.info(line);
  refreshTranscript();
}
```

(4) `onTranscriptStatus` の後に、欄まわりの関数を足す:

```typescript
/** 今の動画の文字起こしの行。今の動画のものでなければ空 */
function transcriptLines(): TranscriptLine[] {
  const status = transcriptStatus;
  return status.kind === "ready" && status.videoId === currentVideoId() ? status.transcript.lines : [];
}

/**
 * 文字起こしの欄で区間を変えてよいか。録画中・録画した後 (preview / composing / degraded) と、やり直せる区間を持つ
 * failed では変えない (状態機械の SET_CLIP と同じ規則)。**今届いた状態の種類で見る**
 * (applyStateToDisplay は refreshLists より前に lastKind と failedKeepsClip を書く)
 */
function canEditFromTranscript(): boolean {
  if (busy) return false;
  if (lastKind === "failed") return !failedKeepsClip;
  return lastKind === "idle" || lastKind === "ready" || lastKind === "posted";
}

/**
 * 欄の操作の元にする区間とテロップ。**送ったけれど答えがまだ来ていない組があれば、それを元にする。**
 * SET_CLIP は丸ごと差し替えるので、答えを待つ間にもう 1 行押したとき、手元の写しから作ると先に押した行が消える
 * (service worker が寝ていると答えまで数百 ms かかる)。描くのは今までどおり状態機械の答えが届いてから
 */
function clipBase(): Clip {
  return pendingClip ?? listedItems();
}

/** 届いた状態が、送った組そのものか (区間が空なら idle) */
function isClipOf(state: ClipState, clip: Clip): boolean {
  if (clip.segments.length === 0) return state.kind === "idle";
  return (
    state.kind === "ready" &&
    JSON.stringify(state.segments) === JSON.stringify(clip.segments) &&
    JSON.stringify(state.telops) === JSON.stringify(clip.telops)
  );
}

/**
 * 欄から組を送る。拒まれたら (別の経路で録画に入った後など) 「受け付けられませんでした」を出し、待つ組を捨てる。
 * **届かなかったときも捨てる** (残ると、＋ 区間を追加などほかの経路の結果を、欄の次の操作が上書きする)
 */
function sendClip(next: Clip): void {
  pendingClip = next;
  cancelPreviewWatch();
  const drop = (): void => {
    if (pendingClip === next) pendingClip = null;
  };
  send(
    { type: "SET_CLIP", segments: next.segments, telops: next.telops, meta: getVideoMeta() },
    (state) => {
      const ok = isClipOf(state, next);
      if (!ok) drop();
      return ok;
    },
    drop,
  );
}

/** 欄を今の状態で描き直す。区間に入っているかは状態機械の区間から決める (欄は選択を持たない) */
function refreshTranscript(): void {
  if (transcriptPanel === null) return;
  const status = transcriptStatus;
  // 前の動画の知らせ (吹き替え・字幕が無い・取れなかった) を、別の動画へ移った直後に出さない
  const forThisVideo = status.kind !== "idle" && status.videoId === currentVideoId();
  const { segments, telops } = listedItems();
  const lines = transcriptLines();
  const telopByLine = new Map(telops.filter((telop) => telop.lineId !== undefined).map((telop) => [telop.lineId, telop]));
  const header: TranscriptView["header"] = !forThisVideo
    ? { kind: "loading" }
    : status.kind === "ready"
      ? { kind: "ready", label: TRANSCRIPT_SOURCE_LABEL[status.transcript.source] }
      : status.kind === "none"
        ? { kind: "none" }
        : status.kind === "failed"
          ? { kind: "failed", reason: status.reason }
          : { kind: "loading" };
  transcriptPanel.update({
    header,
    dubbed: forThisVideo && (status.kind === "ready" || status.kind === "none") && status.dubbed,
    enabled: canEditFromTranscript(),
    rows: lines.map((line) => {
      const selected = isLineInSegments(line, segments);
      const telop = telopByLine.get(line.id);
      return {
        id: line.id,
        startSec: line.startSec,
        text: selected && telop !== undefined && telop.text !== "" ? telop.text : line.text,
        selected,
        hidden: selected && telop !== undefined && telop.text === "",
        hasTelop: selected && telop !== undefined,
      };
    }),
  });
}

/** 動画の長さ。分からなければ Infinity (区間の尻を止めない) */
function videoDurationSec(): number {
  const duration = getVideo().duration;
  return Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
}

/** 行を押した。入っていれば外し、入っていなければ入れる。Shift なら直前に押した行からまとめて */
function onToggleLine(lineId: string, extend: boolean): void {
  if (!canEditFromTranscript()) {
    // 録画中は「録画中… (N秒)」を上書きしない (欄が薄いことで押せないと分かる)
    if (!busy) setStatus("いまは区間を変えられません");
    return;
  }
  const lines = transcriptLines();
  const line = lines.find((item) => item.id === lineId);
  if (line === undefined) return;
  // 別の動画の区間は持ち越さない (listedItems は別の動画では空を返す)
  const base = clipBase();
  const selected = !isLineInSegments(line, base.segments);
  const ids = extend && anchorLineId !== null ? lineIdsBetween(lines, anchorLineId, lineId) : [lineId];
  const next = setLinesSelected(base, lines, ids, selected, videoDurationSec());
  // 1 つの区間が上限を超えるなら送らない。拡大バーは 1 区間を上限より長くできず、つまみが跳ぶ (clampHandle)
  const tooLong = next.segments.find(
    (segment) => segment.endSec - segment.startSec > maxClipSec && !base.segments.some((old) => sameRange(old, segment)),
  );
  if (tooLong !== undefined) {
    setStatus(`1 つの区間は ${maxClipSec} 秒までです。行を分けて選んでください (設定で上限を変えられます)`);
    return;
  }
  // 起点は送るときだけ動かす (拒んだ Shift + クリックで起点がずれない)
  anchorLineId = lineId;
  // 外した行の直した文字を覚え、入れ直したら戻す (続けて 2 回押すと、外して入れ直すことになる)
  const pickedIds = new Set(ids);
  if (!selected) {
    for (const telop of base.telops) {
      if (telop.lineId !== undefined && pickedIds.has(telop.lineId)) editedLineTexts.set(telop.lineId, telop.text);
    }
  }
  const telops = selected
    ? next.telops.map((telop) => {
        const remembered = telop.lineId === undefined || base.telops.includes(telop) ? undefined : editedLineTexts.get(telop.lineId);
        return remembered === undefined ? telop : { ...telop, text: remembered };
      })
    : next.telops;
  // 押した行を含む区間を選ぶ (拡大バーがその区間になる)
  const holding = next.segments.find((segment) => isLineInSegments(line, [segment]));
  if (holding !== undefined) selectRangeOnNextState = holding;
  sendClip({ segments: next.segments, telops });
}

/** 行の文字を直した。その行のテロップの文字にする (送らなかったら false。直す欄を閉じない) */
function onEditLineText(lineId: string, text: string): boolean {
  if (!canEditFromTranscript()) return false;
  if (text.length > MAX_TELOP_TEXT_LENGTH) {
    setStatus(`テロップは ${MAX_TELOP_TEXT_LENGTH} 文字までです (いま ${text.length} 文字)`);
    return false;
  }
  const base = clipBase();
  if (!base.telops.some((telop) => telop.lineId === lineId)) return false;
  sendClip({
    segments: base.segments,
    telops: base.telops.map((telop) => (telop.lineId === lineId ? { ...telop, text } : telop)),
  });
  return true;
}

/** 「字幕に出さない」/「字幕に出す」 */
function onToggleLineHidden(lineId: string): void {
  if (!canEditFromTranscript()) return;
  const line = transcriptLines().find((item) => item.id === lineId);
  if (line === undefined) return;
  const next = toggleTelopHidden(clipBase(), line);
  if (next === null) return;
  sendClip(next);
}

/**
 * 行の時刻を押した。その行の頭から再生する。**録画中は動かさない** (録画が壊れる。playTelop と同じ)。
 * 録画中は「録画中… (N秒)」を上書きしないよう、何も言わない
 */
function onPlayLine(lineId: string): void {
  if (busy) return;
  const line = transcriptLines().find((item) => item.id === lineId);
  if (line === undefined) return;
  void onSeekPlay(line.startSec);
}
```

(`onSeekPlay` は拡大バーのトラックを押したときの再生 (今あるもの)。範囲再生の監視を解いてその位置から再生する。シグネチャが `(sec: number) => Promise<void>` でなければ、その形に合わせて呼ぶ)

(4b) `send` に 3 つ目の引数 `undelivered?: () => void` (届かなかった・応答が無かったときに呼ぶ) を足す。`send` の中の 2 か所で呼ぶ:
- `if (response === undefined) {` の枝の `setStatus("拡張から応答がありませんでした");` の後に `undelivered?.();` (同じ文言は youtube.ts に 2 か所ある。直すのは `function send(` の本体の中のもの)
- `.catch((error: unknown) => {` の枝の、送信できなかったことを状態の欄に出す `setStatus(…)` の後に `undelivered?.();`

テストを `tests/content/youtube-transcript-panel.test.ts` の describe に足す (stub の `sendMessage` に 1 回だけ throw させる。ファイル先頭に `let failNext = false;` を置き、`sendMessage` の先頭で `if (failNext) { failNext = false; throw new Error("届かない"); }`、`beforeEach` で `failNext = false;`):

```typescript
  test("届かなかった SET_CLIP は待たない。ほかの経路で足した区間を、欄の次の操作で消さない", async () => {
    ready();
    await flush();
    failNext = true;
    rows()[0]?.click();
    await flush();
    emit({ kind: "ready", segments: [{ startSec: 200, endSec: 215 }], telops: [], meta: META });
    await flush();
    rows()[2]?.click();
    await flush();
    expect(state).toMatchObject({
      segments: [
        { startSec: 6.8, endSec: 9.3 },
        { startSec: 200, endSec: 215 },
      ],
    });
  });
```

(5) `buildBar` の `telopList = createTelopList({ … });` の後、`bar.append(…)` の前に足す:
```typescript
  // 文字起こしの欄 (ADR 0001)。区間・テロップの窓の先頭に置く。区間とテロップの一覧は 1c まで欄の下に残す
  transcriptPanel = createTranscriptPanel({
    onToggle: onToggleLine,
    onEditText: onEditLineText,
    onToggleHidden: onToggleLineHidden,
    onPlay: onPlayLine,
    onRetry: () => transcriptLoader?.retry(),
  });
```
と、`listWindow.body.replaceChildren(segmentList.element, telopList.element);` → `listWindow.body.replaceChildren(transcriptPanel.element, segmentList.element, telopList.element);`

(6) `refreshLists` の `refreshTelopTrack();` の前に `refreshTranscript();` を足す。

(7) `refreshWindows` の
```typescript
  const listShown = [segmentList?.element, telopList?.element].some(
    (part) => part !== undefined && !part.hidden,
  );
```
→
```typescript
  // 文字起こしの欄があるので、区間・テロップの窓は動画ページではいつも出す (区間が無くても行を選べる)
  const listShown = transcriptPanel !== null;
```

(8) `watchPlayhead` の `step` の `rangeBar?.setPlayhead(getVideo().currentTime);` を次にする:
```typescript
      const time = getVideo().currentTime;
      rangeBar?.setPlayhead(time);
      transcriptPanel?.setCurrentTime(time);
```

(9) `resetModuleState` に足す:
```typescript
  transcriptPanel = null;
  transcriptStatus = { kind: "idle" };
  anchorLineId = null;
  pendingClip = null;
  editedLineTexts.clear();
  failedKeepsClip = false;
```
`onPageMutated` の `if (location.href !== lastHref)` の枝で、**`currentVideoId()` が前と変わったときだけ** `anchorLineId = null; pendingClip = null; editedLineTexts.clear();` を行う (前の動画の行の起点と文字を持ち越さない。同じ動画で URL だけ変わったとき (`&t=` など) は捨てない。捨てると、答えを待つ間に先に押した行が消える)

(10) `applyStateToDisplay` の `lastKind = state.kind;` (`refreshLists();` と reveal の後にある) を、`busy = BUSY_KINDS.has(state.kind);` のすぐ後へ移し、その後に次を足す:
```typescript
  failedKeepsClip = state.kind === "failed" && state.segments.length > 0;
  // 欄から送った組の答えが届いたら、待つのをやめる。録画などほかの種類になっても捨てる。
  // 途中の答え (先に送った組) が届いた間は待ち続ける (後から送った組が本当の行き先)
  if (pendingClip !== null && (isClipOf(state, pendingClip) || (state.kind !== "ready" && state.kind !== "idle"))) {
    pendingClip = null;
  }
```
欄の押せる / 押せないは `refreshLists` の中で決まるので、その前に今の種類を書く。間で `lastKind` を読むものが無いことを `grep -n "lastKind" src/content/youtube.ts` で確かめる (読むのは onMarkIn・録画の監視・onPageMutated で、どれも applyStateToDisplay の外)。欄は `refreshLists` を通して描き直すので、ほかに足すものは無い。`onPageMutated` の別の動画へ移った分岐も `refreshLists` を呼んでいるので同じ。

(11) `refreshWindows` の doc の「区間・テロップの窓は一覧のどちらかが見えている間…だけ出す」を「区間・テロップの窓は、文字起こしの欄があるので動画ページではいつも出す」に直す

(12) 確かめ: `grep -n "dblclick" src/content/transcript-panel.ts` が 0 件 (直すのは ✎)

- [ ] **Step 4: 実行して通過を確認、既存のテストを直す**

実行: `npm run typecheck && npx vitest run tests`

新しいテストは PASS。窓を出す条件が「区間があるとき」から「動画ページではいつも」に変わったので、落ちる既存のテストは次の規則で直す (どれをどう直したかを commit の本文に列挙する):

| 規則 | 当てはまるテスト | 直し方 |
|---|---|---|
| W1. 区間が無いと区間・テロップの窓が隠れていることを確かめている | `youtube.test.ts` の「区間が 0 個なら区間・テロップの窓を出さない」、「別の動画へ移ると一覧を空にして区間・テロップの窓を隠す。戻れば出す」、「ドック枠とタブ > 別の動画へ移ると区間・テロップのタブが消えて右の枠が隠れ、戻ると出る」(cross-review で落ちると確かめた 3 件) | 動画ページでは出ていることを確かめる形に反転する。別の動画へ移る 2 件は「別の動画でも窓 (欄) は出て、区間とテロップの一覧は空」にする。読み込みが済む前 (layoutReady が偽) と全画面・動画ページ以外で隠れることの確認は残す |
| W2. 区間・テロップの窓の中身の数・並びを確かめている | 「一覧は区間・テロップの窓に入り、バーには…」(`body.children` が 2 つ) | 先頭に欄が来て 3 つになることを確かめる形にする |
| W3. 上のどれでもない | — | 落ちた理由を読み、実装の不具合なら実装を直す |

- [ ] **Step 5: e2e を流す**

実行: `npm run build && npx playwright test e2e/smoke.spec.ts e2e/captions.spec.ts e2e/telop-check.spec.ts e2e/draft-editor.spec.ts`
期待: 既知の 1 件 (smoke の 312 行) 以外 pass。区間・テロップの窓が初めから出ること・欄の高さ (最大 320px) で落ちるものがあれば、上の規則 W1 / W2 と同じ考え方で直す。telop-check の受け入れ条件 (1440x795 で右の枠がプレイヤーに重ならない など) が落ちたら、条件を緩めず実装 (欄の高さ) を直す。`e2e/smoke.spec.ts` のコメント「窓は区間があるときだけ出る」(336 行付近) も今の作法に直す

- [ ] **Step 6: 実機で確かめる (Gate: human)**

jsdom ではクリックの順・IME・長い字幕の重さ・録画中の操作を捕まえられない (cross-review 1 回目で、どれも jsdom を通り抜けた)。commit の前に:

1. `npm run build` の後、ユーザーに `chrome://extensions` で拡張を再読み込みしてもらう
2. Claude in Chrome で `docs/manual-check.md` の「文字起こしの欄」を上から確かめる (日本語の IME での ✎ と、1 時間を超える配信の欄の手触りを含む)
3. 合わないものがあれば直してから commit する。直したことは commit の本文に書く

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests e2e
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 区間・テロップの窓に文字起こしの欄を組み込む

ADR 0001 の、行を選ぶと区間とテロップができる欄を区間・テロップの窓の先頭に置く。行の入れ外しは選び方から区間と
テロップの組を計算して SET_CLIP で送り、直した文字と「字幕に出さない」はその行のテロップを変える。欄があるので、
窓は動画ページではいつも出す。再生位置に合わせて今の行に印を付け、取れなかったときは欄から取り直せる。
区間とテロップの一覧は 1c まで欄の下に残す。

1 つの区間が上限の秒数を超えるときは送らずに理由を出す (拡大バーは上限より長い区間のつまみを跳ばす)。録画中は
行の時刻を押しても動画を動かさない。欄の押せる / 押せないは今届いた状態の種類で決める (1 つ前の種類で決めると、
撮り直しに戻った直後に押せない)。欄の操作は答えを待っている組を元に作る (SET_CLIP は丸ごと差し替えるので、続けて押すと
先の行が消える)。やり直せる区間を持つ失敗の間は欄を押せなくする (丸ごと差し替えると RETRY で戻れる区間が消える)。

直したテスト:
<規則 W1・W2・W3 ごとにテスト名を列挙する>
EOF
```

---

## 完了後

1. `npm run typecheck && npm test` を実行して green を確認。e2e は Task 6 の結果
2. whole-branch cross-review (1a・1b-1・1b-2 をまとめて): `BASE=ef80dd8` からの diff を 1 ファイルにまとめ、新しい subagent に「保守担当 + 攻撃者」視点でレビューさせる。攻撃者の観点では特に: 字幕の文字 (タグ・巨大な文字・大量の行) が欄・テロップ・状態の保存に流れたときの壊れ方、SET_CLIP に不正な区間が来たとき、欄の操作と録画の競合
3. 実機の確かめは Task 6 の Step 6 で済ませている。whole-branch review で直したものがあれば、拡張を再読み込みしてもらい、直した所だけ Claude in Chrome で確かめ直す
4. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ

## 自律判断ログ

- モード: autonomous (根拠: Auto Mode 既定)
- [選択] 区間の一覧とテロップの一覧は 1b-2 では残し、欄をその上に足す — 一度に入れ替えると、区間の選択・▶・✕・合計・テロップの手入力の置き場所を同時に作り直すことになり、テストと差分が大きくなりすぎる。1c で詰める欄を作るときに撤去する
- [選択] 欄の検索は 1c に回す — 1b-2 は行の入れ外しと文字の直しに絞る
- [選択] 区間は状態機械の `readyWith` で開始の早い順に並べる — どの経路 (＋ 区間を追加・IN・SET_CLIP・頭の移動) でも時間順になるよう 1 か所で決める。選択と受理の判定は位置ではなく範囲で見る形にする
- [選択] 「字幕に出さない」はテロップの文字を空にして表す — 空の文字のテロップは描かない (今の作法)。テロップに新しい項目を足さずに済む。戻すと行の文字になる (直した文字は戻らない)
- [選択] 行が区間に入っているかは「行の長さの半分以上が区間に重なる」で決める — 詰めた端や手で作った区間でも、行の選択の見え方が安定する (可逆)
- [選択] (cross-review 1 回目) 欄で行を押したときは、押した行のまわりしか変えない — 一覧と ＋ 区間を追加が 1c まで残るので、手作りの区間と行の選択が混ざる。最初の案 (行が 1 つでも重なる区間を行から作り直す) では、手作りの区間がまとまる・端が戻る・重ねた区間が消える・中の行にテロップができる、が 1 クリックで起きた
- [選択] (cross-review 1 回目) 文字を直すのはダブルクリックではなく ✎ — ブラウザのダブルクリックは click 2 回の後に届き、行のクリック (入れる / 外す) と両立しない。クリックを遅らせて見分ける案は、毎回のクリックが遅れるので取らない
- [選択] (cross-review 1 回目) 行の間が 3 秒より空いていれば別の区間にする — 並びで隣り合うだけで繋ぐと、曲や長い沈黙を挟んだ区間ができる (可逆)
- [選択] (cross-review 1 回目) 1 秒未満の区間は 1 秒に広げ、上限を超える 1 区間は理由を出して入れない — ほかの経路 (IN / OUT の validateRange、拡大バーの clampHandle) と同じ長さの条件にする。合計の上限超えは今の作法どおり作れて、録画で止める
- [選択] (cross-review 1 回目 → 2 回目で絞った) SET_CLIP は区間を持たない failed からだけ受ける — 区間を持つ failed は RETRY で戻れる区間とテロップを持つが、画面の写しは failed では空なので、丸ごと差し替えると消える (ADD_SEGMENT は足すので消えない)
- [選択] (cross-review 2 回目) 欄の操作は、答えを待っている組 (pendingClip) を元に作る — SET_CLIP は丸ごと差し替えるので、手元の写しだけを元にすると続けて押した先の行が消える。描くのは今までどおり状態機械の答えが届いてから。✎ と「字幕に出さない」も同じ理由で SET_CLIP で送る (UPDATE_TELOP の index は待っている間にずれうる)
- [選択] (cross-review 2 回目) 手作りの区間の中の行 (テロップが無い) には ✎ と「字幕に出さない」を出さない — 押しても何も起きないボタンを出さない。テロップを作りたければ、行を外して入れ直す
- [選択] (cross-review 3 回目) ほかの経路 (＋ 区間を追加・✕・IN・テロップの一覧の打ち込み) の答えを待っている間に欄を押すと、SET_CLIP の丸ごと差し替えがその結果を消しうる — pendingClip を足す前からある型の競合で、人の操作の速さでは起きにくいので受け入れる
- [選択] (cross-review 2 回目) 外した行の直した文字は、この動画の間だけ覚えて入れ直したら戻す — ダブルクリック (外して入れ直す) で直した文字が消えないように
- [選択] (cross-review 1 回目) 行のテロップは足した順に末尾へ積み、並べ替えない — テロップの一覧の位置 (index) を動かさない (打ちかけの行が別のテロップに書き込まれない)
- [選択] `RESET_MARKS` と設定の select の欄 (1b-1 からの持ち越し) は、この plan でも触らない — SET_CLIP で区間を空にする道ができたので `RESET_MARKS` は要らなくなったが、消すと状態機械と router とテストに及ぶ。1c で撤去と一緒に消す

## 完了の記録 (2026-11-03)

- Task 1〜6 を commit (2c21ae4 / 6937327 / fd4c40d / 6656856 / b9524c9 / 18345b4)。Task 6 は普段の Chrome で manual-check の「文字起こしの欄」を確かめてから commit した。IME はユーザーが確かめた
- 実機で見つけて直した: 区間の尻が動画の終わりにあると録画が終わらない (2b0a5a3。rVFC は最後のフレームで duration に届かない。前からあった不具合)
- whole-branch review (ef80dd8..2b0a5a3、保守担当 + 攻撃者) で直した: 欄で最後の行を外すと手入力のテロップが消える (723ee79)、保存しきれない文字起こしの後ろを落として保存していた (保存しないで毎回取る)、手動字幕の行の並び、古いコメント、文書の食い違い

### 1c に持ち越すもの (whole-branch review と実機の確かめから)

- 保存から読めたのに、吹き替えの判定を待つ間「取っています…」のまま (広告の間は最長 3 分)。先に ready を出し、判定が返ってから出し直す
- 保存する字幕が頼んだ動画のものかを確かめていない (`baseUrl` の `v`)。`language` / `name` の長さの上限 (json3 と応答の型の検証と一緒に)
- 保存の索引の読み書きの間の割り込みで、索引から漏れた `transcript:<id>` が残る (保存のたびに索引に無いキーを消す)
- router が `apply` の前に `captureTabId` を書くので、拒まれたイベントでも録画対象が移る (前からある型。SET_CLIP が仲間に増えた)
- `isClipOf` の受理判定が `JSON.stringify` の一致 (項目ごとに比べる)
- Shift の範囲選択は 1 区間の上限しか見ない。間の空いた行を大量に選ぶと区間が数千になる (合計の上限か区間の数の上限)
- `text.slice(0, 500)` がサロゲートペアを割りうる
- 状態の欄: 録画を中止した後に「録画中… (N秒)」が残る。プレビューに入っても「録画を書き出しています…」のまま
- 広告の再生中に行を押すと、duration が広告の長さで区間が詰まる
- 別の動画で行を押すと、前の動画の区間とテロップ (手入力も) を確かめずに置き換える (MARK_IN / ADD_SEGMENT と同じ前からある作法。確かめを入れるか 1c で決める)
