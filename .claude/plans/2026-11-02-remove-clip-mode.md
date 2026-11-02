# モードの廃止 (段階 1b-1) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** シンプル / エディットのモードを無くし、いつも複数の区間を扱えるようにする (＋ 区間を追加・区間とテロップの一覧・テロップのプレビューと焼き込み)。区間が 1 つなら、これまでのシンプルと同じ流れ (IN → OUT → 録画、録り終えたら次の場面で IN) で使える。

**Architecture:** 設定 (`Settings`) から `mode` を外し、保存済みの `mode` は黙って読み飛ばす。`youtube.ts` からモードの分岐を消す。IN は 2 通りに振る舞う: **区間を組み立てている途中** (状態が `ready` で、この動画の区間がある) なら選んでいる区間の頭を今の位置に合わせ (今のエディット)、**それ以外** (区間が無い・録画した後 (preview / posted / degraded)・失敗・別の動画の区間しかない) なら今の位置から範囲を作り直す (今のシンプルの `MARK_IN`)。シンプルの楽観描画はやめ、どの操作も状態機械の答えを待って描く。拒まれたら「受け付けられませんでした」を出せるよう、区間を変える送信には受理の判定を付ける。状態機械と router は変えない。

**Tech Stack:** TypeScript、vitest (jsdom)、Playwright (e2e)

## 段階 1 の分け方 (1a の plan からの続き)

| | 中身 | 状態 |
|---|---|---|
| 1a | 公式字幕の取得・保存・吹き替えの判定 | 済み (`.claude/plans/2026-10-26-transcript-fetch.md`) |
| **1b-1 (この plan)** | モードの廃止 | |
| 1b-2 | 文字起こしの欄・行で区間とテロップを作る・区間は時間順 | 次の plan |
| 1c | 詰める欄・拡大バー / 帯 / 一覧の撤去・文字起こしが無いときの道 | |

1b を分けた理由: モードの廃止だけで `youtube.test.ts` の 15 前後の describe・e2e 3 本・README・手動確認に及ぶ。

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- ADR 0001 (`docs/adr/0001-transcript-first-editor.md`) の Decision: 「シンプル / エディットのモードを無くす。区間が 1 つならシンプルと同じ」
- 第 2 版のモック (2026-10-25 了承): バーは「＋ 区間を追加」「IN」「OUT」を持つ。モードの設定欄は popup から無くなる
- 区間を時間順に繋ぐ (回答 2026-10-26「1ok」) のは **1b-2 でやる**。この plan では区間の並び (拾った順) を変えない

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ に CLAUDE.md と `.claude/rules/` は無い。ユーザーのグローバル設定と既存コードの慣習から:

- 先にドキュメントを直してからコードに着手する (Task 1 が文書)
- git は `git -C <dir> ...`
- Fail Fast。握り潰すときは理由をコメントで書く
  - ※ 局所例外: 保存済みの `mode` は warn も出さずに読み飛ばす (前の版が書いた正しい値。出すと更新しただけで毎回コンソールに出る。覚えた配置の `"settings"` を黙って捨てたのと同じ判断。`.claude/specs/2026-10-04-settings-in-popup-design.md` §3)
- コメントとコミットメッセージは日本語、Conventional Commits + Why の本文
- コミットは署名される (セキュリティキー)。署名で失敗したら、署名を外さずにユーザーに伝えて止まる

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous (根拠: Auto Mode 既定)
- 隔離: branch。`feat/transcript-editor` の続き (1a のコミットの上)
- 実装方式: B (branch + 直列)
- 既知の失敗: `e2e/smoke.spec.ts` の test「オフにすると 1 秒以内に拡張の要素が消え…」(252 行付近) は分岐元から、`expect(extensionLogs).toEqual([])` (312 行付近) で落ちる (Chromium 153 の警告 `Unsafe attempt to load URL chrome-extension://…` を拡張のログとして数えている)。この plan では直さない。**この assertion 以外で落ちたら、この plan の不具合**

---

## ファイル構造

| ファイル | 種別 | 責務 |
|---|---|---|
| `README.md` / `docs/manual-check.md` / `docs/store-release.md` / `docs/privacy-policy.md` / `CHANGELOG.md` | Modify | モードの記述を消し、IN の 2 通りの振る舞いと「▶ 区間を見る」を書く |
| `src/shared/settings.ts` | Modify | `mode` を設定から外す |
| `src/shared/types.ts` | Modify | `MARK_IN` / `ADD_SEGMENT` の注記からモードを外す |
| `src/content/youtube.ts` | Modify | モードの分岐を消し、IN を 2 通りにし、区間を変える送信に受理の判定を付ける |
| `src/content/segment-list.ts` ほか | Modify | モードに触れたコメントだけを直す |
| `tests/shared/settings.test.ts` / `tests/content/youtube*.test.ts` | Modify | モードを前提にしたテストを直す |
| `e2e/smoke.spec.ts` / `e2e/telop-check.spec.ts` | Modify | popup のモードの欄と、前のテストが残した区間に頼った確認を直す |

---

### Task 1: 文書

**Files:**
- Modify: `README.md`、`docs/manual-check.md`、`docs/store-release.md`、`docs/privacy-policy.md`、`CHANGELOG.md`

- [ ] **Step 1: README を直す**

`README.md`:

- 13 行目「   トラックを押すとその位置から再生でき、**範囲を再生** で通しの確認もできる」→「   トラックを押すとその位置から再生でき、**▶ 区間を見る** で通しの確認もできる」
- 22 行目「スクロールする。区間・テロップの窓はエディットモードで区間があるときだけ出る。」→「スクロールする。区間・テロップの窓は区間があるときだけ出る。」
- `## モード` の見出しから、`### テロップ (エディットモード)` の見出しの行まで (両端を含む) を、次に置き換える:

```markdown
## 複数の場面を繋ぐ

同じ動画の中の複数箇所を拾って 1 本に繋げられる。区間が 1 つなら、上の「使い方」のとおり 1 つの範囲を切り抜く。

- **＋ 区間を追加** — 今の再生位置から新しい区間を作り、それを選ぶ
- **IN** — 区間を組み立てている途中なら、一覧で選んでいる区間の頭を今の位置に合わせる。それ以外 (区間が無い・
  録画した後・別の動画の区間しか無い) なら、今の位置から範囲を作り直す (区間とテロップは置き換わる)
- **OUT** — 一覧で選んでいる区間の尻を今の位置に合わせる

一覧から区間を選ぶと拡大バーがその区間に切り替わるので、ハンドルでも
調整できる。録画は区間を順に辿って 1 本のクリップにする。

区間とテロップの一覧は、区間・テロップの窓 (最初はおすすめ動画の上) に出る。IN / OUT・録画のボタンと拡大バーは
最初はプレイヤーの直下に出るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったら区間・テロップの窓の中でスクロールする。

### テロップ
```

- 同じ節の末尾の「**モードを変えると作りかけの区間は消える。** 録画中は変えられない。」の行を消す
- `### 区間の結合 (エディットモード)` → `### 区間の結合`
- 282 行目付近のリンクの説明「— エディットモードと複数区間の結合」→「— 複数区間の結合 (当時はエディットモード)」

- [ ] **Step 2: 手動確認を直す**

`docs/manual-check.md`:

- 37 行目「- [ ] 「範囲を再生」で IN から OUT まで再生され、OUT で止まる」→「- [ ] 「▶ 区間を見る」で IN から OUT まで再生され、OUT で止まる」
- 188 行目の「「範囲を再生」を連打」→「「▶ 区間を見る」を連打」
- 469 行目の「B で「範囲を再生」を押しても」→「B で「▶ 区間を見る」を押しても」
- `## エディットモード (複数区間の結合)` → `## 複数区間の結合`
- 「- [ ] popup の設定でモードをエディットに変えて区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) に区間の一覧が出る (区間が 0 個の間はタブごと出ない)」→「- [ ] 区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) に区間の一覧が出る (区間が 0 個の間はタブごと出ない)」
- 「- [ ] 区間が 1 つも無いとき、IN と OUT は「先に区間を追加してください」と出す」→ 次の 3 行に置き換える:
  ```
  - [ ] 区間が 1 つも無いとき、OUT は「先に区間を追加してください」と出す
  - [ ] **区間が 1 つも無いときに IN を押すと、今の位置から 15 秒の範囲ができる** (これまでのシンプルと同じ)
  - [ ] **録画した後 (プレビュー・投稿後) に IN を押すと、今の位置から範囲を作り直す** (前の区間とテロップは置き換わる。次の切り抜きをすぐ始められる)
  ```
- 「- [ ] **モードをシンプルに戻すと一覧が消え、区間も消える**」と「- [ ] **録画中はモードを変えられない**」の 2 行を消す
- `## テロップ (エディットモード)` → `## テロップ`
- 「- [ ] シンプルモードと、テロップが 1 つも無いエディットモードでは、帯の段が出ず、バーの高さが変わらない」→「- [ ] テロップが 1 つも無いときは、帯の段が出ず、バーの高さが変わらない」
- `## 設定` の「popup でモード・テロップの見た目を保存すると」→「popup でテロップの見た目を保存すると」。同じ節の末尾に足す: 「- [ ] popup の設定にモードの欄が無い。前の版でエディットにしていた人も、更新後に区間とテロップの一覧が今までどおり出る」
- `## 見た目` の「シンプルモードでは、おすすめ動画の上には何も出ない」→「区間が無い間は、おすすめ動画の上には何も出ない」、「最初の配置のままエディットモードで区間 5 つ」→「最初の配置のまま区間 5 つ」
- `## 全体フロー` の「録画済みでプレビュー待ち…IN を押すと、新しい範囲の ready に戻る」は**そのまま** (IN は録画した後は作り直すので、今も成り立つ)
- `## 確認した環境` の過去の記録 (2026-09-24 の「テロップ (エディットモード) 節」、「シンプルモードで出ないことは単体テストでだけ」) は**直さない** (その時点の記録)

- [ ] **Step 3: ストアの申請文を直す**

`docs/store-release.md`:

- 62 行目の「「範囲を見る」で通しの確認もできます」→「「▶ 区間を見る」で通しの確認もできます」
- 「■ 複数の場面を繋ぐ (エディットモード)」→「■ 複数の場面を繋ぐ」
- その直下の 2 行「設定の「モード」をエディットに変えると、同じ動画の中の複数箇所を拾って」「1 本のクリップに繋げられます。」→ 1 行「同じ動画の中の複数箇所を拾って 1 本のクリップに繋げられます。区間が 1 つなら 1 つの範囲の切り抜きです。」
- 「■ 設定」の「・モード — シンプル (1 区間を切り抜く) / エディット (複数区間を結合する)」の行を消す
- `### \`storage\`` の 2 行「> 投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数、」「> 切り抜きのモード (シンプル / エディット) を保存する (`chrome.storage.sync`)。」→ 1 行「> 投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数を保存する (`chrome.storage.sync`)。」
- 掲載画像の 1 の 2 行目「   シンプルモードなので、おすすめ動画の上の枠は出ていない」→「   区間が 1 つあるので、おすすめ動画の上に区間・テロップの窓が出ている」 (`scripts/screenshots.mjs` は IN を押した直後に撮る。区間があれば窓は出る)
- 掲載画像の節の末尾に足す: 「モードを無くした版 (段階 1b-1) から、2 枚とも撮り直すこと (1 枚目は区間・テロップの窓が写り、2 枚目からモードの欄が消える)」

- [ ] **Step 4: プライバシーポリシーと CHANGELOG を直す**

`docs/privacy-policy.md`:
- 表の 1 行目「| 設定 (投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数、モード、テロップの見た目) | `chrome.storage.sync` | 拡張を削除したとき |」から「モード、」を消す
- 「最終更新: 2026-10-26」→「最終更新: 2026-11-02」

`CHANGELOG.md` の `## 未リリース` (同じ版の変更点の中で食い違わないよう、既存の項目も直す):
- 「モード・最大秒数・ハッシュタグ・テロップの見た目は popup で変える。」→「最大秒数・ハッシュタグ・テロップの見た目は popup で変える。」
- 「**エディットモードにテロップを足した。**」→「**テロップを足した。**」
- 「**拡大バーの下にテロップを帯で出した (エディットモード)。**」→「**拡大バーの下にテロップを帯で出した。**」
- 既存の最初の項目 (「**設定をツールバーの拡張アイコン (popup) へ移した。**…」) の**前**に、同じ太字の段落の形で足す:

```markdown
**シンプル / エディットのモードを無くした。** いつも複数の区間を足せて、区間が 1 つならこれまでのシンプルと同じ。
IN は、区間を組み立てている途中なら選んでいる区間の頭を合わせ、それ以外 (区間が無い・録画した後など) は今の位置から
範囲を作り直す。再生のボタンは「▶ 区間を見る」になった。popup の設定からモードの欄が消えた。
```

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md docs/manual-check.md docs/store-release.md docs/privacy-policy.md CHANGELOG.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
docs: モードを無くし、いつも複数の区間を扱えることを先に書く

ADR 0001 で、シンプル / エディットのモードを無くすと決めた (区間が 1 つならシンプルと同じ)。モードの切り替えと
「切り替えると作りかけが消える」を README・手動確認・ストアの申請文・プライバシーポリシー・CHANGELOG から消す。
IN は、区間を組み立てている途中なら頭を合わせ、それ以外 (区間が無い・録画した後) は作り直すことと、再生の
ボタンが「▶ 区間を見る」になることを書く。
EOF
```

---

### Task 2: 設定と youtube.ts からモードを消す

**Files:**
- Modify: `src/shared/settings.ts`、`src/shared/types.ts`、`src/content/youtube.ts`
- Modify (コメントだけ): `src/content/segment-list.ts`、`src/content/telop-list.ts`、`src/content/telop-track.ts`、`src/content/window-layout.ts`、`src/popup/view.ts`、`src/background/router.ts`、`src/background/state.ts`
- Test: `tests/shared/settings.test.ts`、`tests/content/youtube.test.ts`、`tests/content/youtube-home-load.test.ts`、`tests/content/youtube-dock-load.test.ts`、`tests/background/router.test.ts`

**Interfaces:**
- Produces: `Settings` から `mode` が消える。`ClipMode` / `parseMode` / `isClipMode` が消える。`SETTINGS_FIELDS` からモードの項目が消える

- [ ] **Step 1: 新しい振る舞いのテストを書く (先に落とす)**

`tests/shared/settings.test.ts`:
- describe「モード」(386 行付近) と describe「parseMode」(411 行付近) を消す。import から `parseMode` を消す
- 次を足す (「モード」があった場所に。import に `vi` / `SETTINGS_FIELDS` / `mergeSettings` が無ければ足す):

```typescript
describe("保存済みのモード (モードを無くす前の版が書いた値)", () => {
  test("読み飛ばし、warn も出さない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = mergeSettings({ mode: "edit", maxClipSec: 30 });
    expect(settings).not.toHaveProperty("mode");
    expect(settings.maxClipSec).toBe(30);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

test("設定の欄にモードは無い", () => {
  expect(SETTINGS_FIELDS.map((field) => field.key)).not.toContain("mode");
});
```

- 510 行付近の test「画面にはモードに関わらず 5 項目が出る」の名前を「画面には 5 項目が出る」にする (中身はそのまま)

`tests/content/youtube.test.ts` の describe「エディットモードの IN」(1854 行付近) で:
- test「区間が無ければ先に追加するよう促す」と test「シンプルの IN は今までどおり作り直す」を**消し**、同じ場所に次の 6 本を足す (describe 内の既存のヘルパー `emit` / `flush` / `clickButton` / `clipEvents` / `statusText` と、ファイル先頭の `video` / `META_A` / `RANGE` を使う):

```typescript
  test("区間が 1 つも無いときの IN は、今の位置から範囲を作る (MARK_IN)", async () => {
    emit({ kind: "idle" });
    await flush();
    video.element.currentTime = 10;
    sent = [];

    clickButton("IN");
    await flush();

    const events = clipEvents() as { type: string; range?: { startSec: number } }[];
    expect(events.map((event) => event.type)).toEqual(["MARK_IN"]);
    expect(events[0]?.range?.startSec).toBe(10);
  });

  test("録画した後 (preview) の IN は、今の位置から範囲を作り直す (次の切り抜きを始める)", async () => {
    emit({ kind: "preview", clipId: "clip-1", mimeType: "video/mp4", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    video.element.currentTime = 300;
    sent = [];

    clickButton("IN");
    await flush();

    const events = clipEvents() as { type: string; range?: { startSec: number } }[];
    expect(events.map((event) => event.type)).toEqual(["MARK_IN"]);
    expect(events[0]?.range?.startSec).toBe(300);
  });

  test("区間 1 つで OUT まで進め、録画を押せる (区間 1 つの流れ)", async () => {
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 25 }], telops: [], meta: META_A });
    await flush();
    video.element.currentTime = 20;
    sent = [];

    clickButton("OUT");
    await flush();

    expect(clipEvents()).toContainEqual({ type: "MARK_OUT", index: 0, sec: 20 });
    const record = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "● 録画",
    );
    expect(record?.disabled).toBe(false);
  });

  test("状態が届くと、選んでいる区間の範囲を状態の欄に出す (IN / OUT の後に範囲と秒数が見える)", async () => {
    emit({ kind: "idle" });
    await flush();

    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 25 }], telops: [], meta: META_A });
    await flush();
    expect(statusText()).toBe("0:10 〜 0:25 (15秒)");

    // OUT で尻が動いた答え
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 20 }], telops: [], meta: META_A });
    await flush();
    expect(statusText()).toBe("0:10 〜 0:20 (10秒)");
  });

  test("区間の尻より後ろで IN を押すと、＋ 区間を追加へ案内する", async () => {
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 25 }], telops: [], meta: META_A });
    await flush();
    video.element.currentTime = 40;
    sent = [];

    clickButton("IN");
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe("IN が区間の尻 (0:25) より後ろです。新しい区間は ＋ 区間を追加 で作れます");
  });

  test("区間を組み立てている途中で、区間が 1 つでも IN は頭を合わせる (作り直さない)", async () => {
    emit({ kind: "ready", segments: [{ startSec: 10, endSec: 25 }], telops: [], meta: META_A });
    await flush();
    video.element.currentTime = 12;
    sent = [];

    clickButton("IN");
    await flush();

    expect(clipEvents()).toEqual([
      { type: "ADJUST_SEGMENT", index: 0, range: { startSec: 12, endSec: 25 } },
    ]);
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/settings.test.ts tests/content/youtube.test.ts -t "保存済みのモード|設定の欄にモードは無い|エディットモードの IN"`
期待: 「読み飛ばし、warn も出さない」「設定の欄にモードは無い」「状態が届くと、選んでいる区間の範囲を状態の欄に出す」「区間の尻より後ろで IN を押すと、＋ 区間を追加へ案内する」「区間を組み立てている途中で、区間が 1 つでも IN は頭を合わせる」が FAIL。ほかの 3 本は今のシンプルの振る舞いでも通りうる (振る舞いを変えないことを確かめる保険)。`statusText()` の文言の形 (`0:10 〜 0:25 (15秒)`) は `rangeLabel` と `formatTime` (`src/shared/time.ts`) に合わせてある。落ちた理由が文言の形の違いなら、テストの期待値を `rangeLabel` の出力に合わせる

- [ ] **Step 3: settings.ts を直す**

`src/shared/settings.ts`:

- `ClipMode` の型とそのコメント (「切り抜きの作り方。…固定モードなら切り替えは稀な操作として扱える。」) を消す
- `Settings` の `/** 切り抜きの作り方。エディットでは複数の区間を結合できる */` と `mode: ClipMode;` の 2 行を消す
- `DEFAULT_SETTINGS` の `mode: "simple",` を消す
- `parseMode` とそのコメント (「入力欄の文字列をモードの差分にする。…」) を消す
- `isClipMode` とそのコメント (「保存されている値がモードとして読めるか」) を消す
- `mergeSettings` の次のかたまりを

```typescript
  if (isClipMode(source.mode)) {
    settings.mode = source.mode;
  } else if (source.mode !== undefined) {
    console.warn(
      `[yt-clip] 保存された mode が使えないため既定値を使います: ${String(source.mode)}`,
    );
  }
```
次のコメントに置き換える:
```typescript
  // `mode` (シンプル / エディット) はもう無い (ADR 0001)。前の版が書いた値が残っていても読み飛ばす。次に保存したとき
  // (saveSettings は読み直した設定に差分を重ねて書く) storage からも消える。
  // ※ 局所例外 (Fail Fast): warn も出さない。正しい値なので、出すと更新しただけで毎回コンソールに出る
```
- `SETTINGS_FIELDS` の先頭の `// **先頭に置く。** 他の項目の意味がモードによって変わる (最大秒数は合計に効く)` のコメントと、`{ key: "mode", … fromText: (text) => parseMode(text), },` の項目を消す
- テロップの見た目の 5 項目の hint の「エディットモードのテロップに使う」を「テロップに使う」にする (5 か所)
- 480 行付近の「モードに関わらず常に出す」の「モードに関わらず」を消す

- [ ] **Step 4: youtube.ts を直す**

(1) import から `type ClipMode,` を消す。

(2) 132 行付近の `currentSegments` のコメント「 * シンプルモードでは常に 0 個か 1 個」の行を消す。

(3) `let mode: ClipMode = "simple";` とそのコメントを消す。`let pendingMode: ClipMode | null = null;` とそのコメントを消す (`lastKind` は残す)。`barWindow` のコメント (201 行付近) の
```
 * **オンの間は 1 つを使い回す** (spec A.3)。モードを変えてバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
```
→
```
 * **オンの間は 1 つを使い回す** (spec A.3)。YouTube の再描画でバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
```
`lastKind` のコメント (263 行付近) がモードの切り替えに触れていたら、その説明を「いま状態機械がどの状態か (IN が作り直すか頭を合わせるかの判定と、録画の監視に使う)」にする。

(4) `firstMatches` とそのコメントを消す (`sameRange` は残す)。`sameRange` の直後に、受理の判定を足す:

```typescript
/**
 * 状態機械の index の区間が、送った範囲になっているか。区間を変える送信が受け付けられたかの判定に使う
 * (拒まれたら send が画面を状態機械に戻し、「受け付けられませんでした」を出す)
 */
function segmentIs(state: ClipState, index: number, range: ClipRange): boolean {
  if (state.kind !== "ready") return false;
  const segment = state.segments[index];
  return segment !== undefined && sameRange(segment, range);
}
```

(5) `applyRange` を消す。

(6) `onMarkIn` をコメントごと次に置き換える:

```typescript
/**
 * IN ボタン (ADR 0001: モードを無くし、区間が 1 つならシンプルと同じにする)。
 *
 * - **区間を組み立てている途中** (状態が ready で、この動画の区間がある): 選んでいる区間の頭だけを今の位置に動かす
 * - **それ以外** (区間が無い・録画した後・失敗・別の動画の区間しか無い): 今の位置から範囲を作り直す (`MARK_IN`。
 *   区間とテロップは置き換わる)。録り終えたら次の場面で IN、という流れを残すため。録画した後の区間は録った
 *   クリップに焼き込み済みで、頭を動かしても録り直しになるだけ
 *
 * **IN を「区間を追加」に置き換えない。** OUT があるのに IN が無い状態になり、一度作った区間の頭を詰められなくなる
 */
function onMarkIn(): void {
  // 録画中に打ち直されると状態機械だけが範囲を作り直し、録画は走り続けて取り残される。状態機械と router にも
  // 同じガードがあるが、ここで止めればユーザーに理由をすぐ返せる
  if (busy) {
    setStatus("録画中は範囲を変更できません");
    return;
  }
  const composing =
    lastKind === "ready" && currentSegments.length > 0 && rangeVideoId === currentVideoId();
  if (composing) {
    onMarkSegmentStart();
    return;
  }

  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの範囲をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration, maxClipSec);
  rangeVideoId = meta.videoId;
  // 範囲が変われば、前の範囲を見ている再生の監視は用済み (消した楽観描画が外していた)
  cancelPreviewWatch();
  // 楽観的に描かない。状態機械の答えを待ってから描く (区間 1 つの ready になり、それが選ばれる)
  send(
    { type: "MARK_IN", range, meta },
    (state) => state.kind === "ready" && state.segments.length === 1 && segmentIs(state, 0, range),
  );
}
```

(7) `applyMode` とそのコメントを消す。

(8) `onAddSegment` の `send({ type: "ADD_SEGMENT", range, meta });` の直前に `cancelPreviewWatch();` を足す (選ぶ区間が変わるので、前の区間を見ている再生の監視は用済み)。コメントを次にする:

```typescript
/**
 * 「＋ 区間を追加」。今の再生位置から新しい区間を作る。
 *
 * **楽観的に描かない。** 状態機械の答えを待ってから描く (`applyStateToDisplay` が反映する)
 */
```

(9) `onMarkSegmentStart` のコメント 1 行目「エディットモードの IN。選択中の区間の**頭だけ**を今の位置に動かす。」→「IN (区間を組み立てている途中)。選択中の区間の**頭だけ**を今の位置に動かす。」。末尾の送信:

```typescript
  // 並べ替えないので、頭を動かしても選択はその場に留まる
  send({ type: "ADJUST_SEGMENT", index: selectedIndex, range: next });
```
→
```typescript
  // 並べ替えないので、頭を動かしても選択はその場に留まる
  const index = selectedIndex;
  cancelPreviewWatch();
  send({ type: "ADJUST_SEGMENT", index, range: next }, (state) => segmentIs(state, index, next));
```

同じ関数の `const next = { startSec: video.currentTime, endSec: editing.endSec };` の直後 (`validateRange` の前) に足す。区間の尻より後ろで IN を押した人に「終了位置は開始位置より後にしてください」と出しても、何をすればよいか分からないため:

```typescript
  // 尻より後ろで押した = 新しい場面を始めたいことが多い。区間を組み立てている途中なので作り直さず、道を示す
  if (next.startSec >= editing.endSec) {
    setStatus(`IN が区間の尻 (${formatTime(editing.endSec)}) より後ろです。新しい区間は ＋ 区間を追加 で作れます`);
    return;
  }
```

(10) `onMarkOut`:

```typescript
  if (editing === null) {
    setStatus(
      mode === "edit" ? "先に区間を追加してください" : "先に IN を指定してください",
    );
    return;
  }
```
→
```typescript
  if (editing === null) {
    setStatus("先に区間を追加してください");
    return;
  }
```

と、末尾の「`// **\`applyRange\` より先に index を取る。**`」のコメントから関数の終わりまで:

```typescript
  // **`applyRange` より先に index を取る。** `applyRange` は単一区間の
  // 楽観描画なので `selectedIndex` を 0 に倒す。後で読むと、2 番目の区間を
  // 選んで OUT を押しても先頭区間が伸び、全区間がマージされて溶ける
  const index = selectedIndex;

  // エディットでは楽観的に描かない。並べ替えとマージで結果が変わるので、
  // 状態機械の答えを待ってから描く (`onMarkIn` と同じ理由)
  if (mode === "edit") {
    send({ type: "MARK_OUT", index, sec: next.endSec });
    return;
  }

  applyRange(next, video.duration);
  send(
    { type: "MARK_OUT", index, sec: next.endSec },
    (state) => state.kind === "ready" && firstMatches(state.segments, next),
  );
}
```
→
```typescript
  // 範囲が変われば、前の範囲を見ている再生の監視は用済み (消した楽観描画が外していた。外さないと、
  // 「▶ 区間を見る」の最中に尻を伸ばしても古い OUT で止まる)
  cancelPreviewWatch();
  // 楽観的に描かない。状態機械の答えを待ってから描く (`onAddSegment` と同じ)
  const index = selectedIndex;
  send({ type: "MARK_OUT", index, sec: next.endSec }, (state) => segmentIs(state, index, next));
}
```

(11) `onRangeCommitted` の

```typescript
    send(
      { type: "ADJUST_SEGMENT", index: selectedIndex, range },
      mode === "edit"
        ? undefined
        : (state) =>
            state.kind === "ready" && firstMatches(state.segments, range),
    );
```
→
```typescript
    const index = selectedIndex;
    send({ type: "ADJUST_SEGMENT", index, range }, (state) => segmentIs(state, index, range));
```

(12) `refreshTelopPreview` のコメント「 * エディットモードで、範囲を作った動画を見ているときだけ出す。別の動画の」→「 * 範囲を作った動画を見ているときだけ出す。別の動画の」。本体:
```typescript
  const visible = mode === "edit" && videoId !== null && rangeVideoId === videoId;
```
→
```typescript
  const visible = videoId !== null && rangeVideoId === videoId;
```

(13) `listedItems` のコメントと本体:
```typescript
/**
 * 一覧に出す区間とテロップ。**エディットモードで、範囲を作った動画を見ているときだけ。**
 *
 * シンプルで使っている人に、関係のない概念を見せない。別の動画の区間は出さない
```
→
```typescript
/**
 * 一覧に出す区間とテロップ。**範囲を作った動画を見ているときだけ。**
 *
 * 別の動画の区間は出さない
```
```typescript
  if (mode !== "edit" || rangeVideoId !== currentVideoId()) {
```
→
```typescript
  if (rangeVideoId !== currentVideoId()) {
```

(14) `initialWindowRect` の「(480px) のままで、エディットモードの操作の行は 2 段に折り返して背が高く測れる。」→「(480px) のままで、操作の行は 2 段に折り返して背が高く測れる。」

(15) `refreshTelopTrack` のコメントの「(`listedItems`: エディットモードで、範囲を作った動画を見ている\n * とき)」→「(`listedItems`: 範囲を作った動画を見ている\n * とき)」

(16a) `applyStateToDisplay` の末尾の `if (current !== null && (drifted || busy)) {` の直前に足す。状態の欄に範囲を書いていたのは消したシンプルの楽観描画 (`applyRange`) だったので、状態が届いたときに書く:

```typescript
  // 選んでいる区間が変わったら、範囲と秒数を状態の欄に出す (IN / OUT / ＋ 区間を追加の答え)。ready のときだけ:
  // 録画中・プレビュー・失敗などは、それぞれの文言を上で出している
  if (state.kind === "ready" && current !== null && drifted) {
    setStatus(rangeLabel(current));
  }
```

(16) `applyStateToDisplay` の末尾の次の 5 行を消す:
```typescript
  // 待たせていた切り替えを拾う。`applyMode` はバーを作り直すので、
  // 画面の更新をひととおり終えてから呼ぶ
  if (pendingMode !== null) {
    applyMode(pendingMode);
  }
```

(17) `prepareRecording`:
```typescript
    // **エディットモードのときだけ合成する。** シンプルモードでは一覧もプレビューも
    // 出ないので、状態にテロップが残っていても焼き込むと画面に無い文字がクリップに入る
    if (mode === "edit" && hasRenderableTelops(currentTelops, currentSegments)) {
```
→
```typescript
    if (hasRenderableTelops(currentTelops, currentSegments)) {
```

(18) `buildBar`:
```typescript
  const addButton =
    mode === "edit"
      ? makeButton("＋ 区間を追加", false, onAddSegment)
      : null;
  const inButton = makeButton("IN", false, onMarkIn);
  const outButton = makeButton("OUT", false, onMarkOut);
  const playButton = makeButton(
    mode === "edit" ? "▶ 区間を見る" : "▶ 範囲を見る",
    false,
    () => void playRange(),
  );
```
→
```typescript
  const addButton = makeButton("＋ 区間を追加", false, onAddSegment);
  const inButton = makeButton("IN", false, onMarkIn);
  const outButton = makeButton("OUT", false, onMarkOut);
  const playButton = makeButton("▶ 区間を見る", false, () => void playRange());
```
```typescript
  row.append(grip);
  if (addButton !== null) row.append(addButton);
  row.append(inButton, outButton, playButton, actions, status);
```
→
```typescript
  row.append(grip, addButton, inButton, outButton, playButton, actions, status);
```

(19) `mount`:
```typescript
    // applyMode が中身の根 (BAR_ID) を外した直後にここで抜けると、バーの窓が中身の無いまま
    // 出続ける。refreshWindows は中身の根が無ければバーの窓を隠すので、ここで一度呼んでおく
```
→
```typescript
    // 中身の根 (BAR_ID) が無いままここで抜けると、バーの窓が中身の無いまま出続けることがある。
    // refreshWindows は中身の根が無ければバーの窓を隠すので、ここで一度呼んでおく
```
```typescript
  // 前のバーが外されていることがある (モードの切り替え)。参照だけ差し替えると
```
→
```typescript
  // 前のバーが外されていることがある (YouTube の再描画で枠ごと外れた)。参照だけ差し替えると
```

(20) `loadInitialSettings`:
```typescript
  // 読み終えるまでにオフにしたら、バーを作り直さない (applyMode は mount を呼ぶ)
```
→
```typescript
  // 読み終えるまでにオフにしたら、読んだ値を使わない
```
と、その関数の中の `      applyMode(settings.mode);` の行を消す。`onSettingsChanged` の `  applyMode(settings.mode);` の行を消す。

(21) `resetModuleState` の `  pendingMode = null;` を消し、コメントの
```
 * **設定から読んだ値 (mode / maxClipSec / telopStyle) は戻さない** (判断メモ 8)。start() の loadInitialSettings が読み直す
 * ので値は同じになる。mode を simple に戻すと、読み直しの applyMode が「モードが変わった」としてバーを作り直し、
 * content/loaded の応答が先に届いて区間を持っていると RESET_MARKS で区間を捨てる
```
→
```
 * **設定から読んだ値 (maxClipSec / telopStyle) は戻さない** (判断メモ 8)。start() の loadInitialSettings が読み直す
 * ので値は同じになる
```

(22) 確かめ: `grep -nE "\bmode\b|pendingMode|applyMode|firstMatches|applyRange|ClipMode|シンプル|エディット|モード" src/content/youtube.ts`。出てよいのは `onMarkIn` のコメントの「シンプル」1 か所 (「区間が 1 つならシンプルと同じにする」) と、「シアターモード」だけ。ほかが出たら、その文からモードの話を消す。

`src/shared/types.ts`:
- `MARK_IN` の注記「範囲の作成 (シンプルモード)。今ある区間を置き換える」→「範囲の作成。今ある区間とテロップを置き換える (IN を、区間を組み立てている途中以外で押したとき)」
- `ADD_SEGMENT` の注記の「(エディットモード)」を消す

コメントだけ直すファイル (動作は変えない):
- `src/content/segment-list.ts:2` / `src/content/telop-list.ts:2` の「エディットモードで出す」→「区間があるときに出す」
- `src/content/telop-track.ts:149`、`src/content/window-layout.ts:74`、`src/popup/view.ts:46`、`src/background/router.ts:380` 付近、`src/background/state.ts:184` 付近のコメントの「エディットモード」「シンプルモード」に触れた語を、モードの無い言い方に直す (例: 「区間・テロップのタブはエディットモードで区間がある間だけ出る」→「区間・テロップのタブは区間がある間だけ出る」、state.ts の「シンプルモードの『区間を丸ごと置き換える』操作」→「IN の『区間を丸ごと置き換える』操作」)
- 確かめ: `grep -rnE "エディットモード|シンプルモード|ClipMode" src` が 0 件

- [ ] **Step 5: 既存のテストを流して直す**

実行: `npm run typecheck && npx vitest run tests`

まず、**落ちる・落ちないに関わらず**次を直す:
- C. `changeSettings({ mode: "edit" })` / `changeSettings({ mode: "simple" })` と、storage の stub の `{ settings: { mode: "edit" } }` (youtube.test.ts 約 45 か所、youtube-home-load.test.ts:134、youtube-dock-load.test.ts:144 / :184): `mode` を外す (`changeSettings({})`、または渡す値から `mode` を除く)。値は黙って読み飛ばされるので落ちないが、残すと意味の無い前提が残る
- 名前を挙げて消すテスト (モードの振る舞いを確かめているもので、落ちずに通ってしまうものも含む):
  - describe「エディットモード」(1400 行付近) の「simple では一覧なし」「モード変更で区間を消す」「録画中はモードを変えない」に当たるテスト
  - describe「進行中のモード変更」(1745 行付近) 全体
  - 「シンプルモードでは…今の経路のまま」(2208 行付近)、「シンプルモードでは出さない」(2516 / 2591 行付近)
  - describe「区間・テロップの窓」の「モードで作り直しても 2 重にならない」
- 名前を挙げて直すテスト:
  - describe「フロートの窓」の「覚えた位置で出る。古い形 (v1) のパネルの位置は区間・テロップの窓が継ぐ」(3038 行付近): `listHidden: true` (コメントは「シンプルモードで一覧が空」) を、区間がある前提にして `listHidden: false` に反転し、コメントを直す。v1 の配置を継ぐ確認は残す
  - describe「フロートの窓」の「モードを変えても窓を作り直さず、位置も変わらない。作り直したつまみでも動かせる」(3280 行付近): バーを作り直すきっかけを、モードの切り替えから YouTube の再描画に変えて残す (作り直したバーのつまみを登録し直す確認を失わないため)。`changeSettings({ mode: "edit" });` の 1 行を、同じファイルの test「作り直されたバーにも設定した上限が効く」(1359 行付近) と同じ再描画の起こし方に置き換える:
    ```typescript
    // YouTube の再描画でバーの中身が外れた場面。窓は作り直さず、中身 (つまみを含む) だけを作り直す
    barElement().remove();
    document.body.append(document.createElement("div"));
    ```
    テスト名を「バーを作り直しても窓は作り直さず、位置も変わらない。作り直したつまみでも動かせる」にし、コメント「中身は作り直した (＋ 区間を追加 が増えた)。つまみも新しい要素になる」→「中身は作り直した。つまみも新しい要素になる」にする。ほかの assertion はそのまま
  - 804 行付近の beforeEach のコメント「モードも既定へ戻す」の「モードも」を消す
  - モード前提の名前のまま落ちずに残るテスト・describe の名前とコメントを直す (中身は変えない): describe「エディットモード」→「複数区間」、「エディットモードの OUT」→「OUT」、「エディットモードの IN」→「IN」。test「シンプルの IN は今までどおり置き換える」(1444 行付近) →「区間が無いときの IN は区間を置き換える」、「エディットでは追加ボタンが増える。IN は消えない」→「追加ボタンと IN が並ぶ」、「エディットモードで、拡大バーの窓に入るテロップを…」(2583 行付近) の「エディットモードで、」を消す、「エディットで区間があると区間・テロップの窓を出す」→「区間があると…」、「エディットでも区間が 0 個なら…」→「区間が 0 個なら…」。ほかに 2508 / 2690 / 2695 / 3079 / 3959 行付近のテスト名とコメント、`youtube-dock-load.test.ts:184` のコメント「エディットモードで区間があるので」も同じ考え方で直す。確かめ: `grep -nE "エディット|シンプル" tests/content/youtube*.test.ts` が 0 件
  - `tests/background/router.test.ts:1125` の describe 名「エディットモードの録画対象タブ」→「区間の追加での録画対象タブ」、1127 行付近のコメント「エディットモードの最初の区間は MARK_IN ではなく…」の「エディットモードの」を消す (中身はそのまま)

そのうえで、まだ落ちるテストを次の規則で直す。**どの規則で直したかを、テスト名と一緒に commit の本文に列挙する**:

| 規則 | 当てはまるテスト | 直し方 |
|---|---|---|
| A. シンプルモードの振る舞いを確かめている (上で名前を挙げた以外) | — | 消す。同じ describe に「区間が 1 つでも一覧・帯・プレビューが出る」を確かめるテストが無ければ、消すテストの前提 (区間 1 つ) で「出る」に反転して残す |
| B. IN を押した直後に、区間が画面に描かれていることを前提にしている (シンプルの楽観描画) | 例: describe「最大秒数の設定」の「上限を超える OUT は理由を出して受け付けない」(IN の直後に OUT) | IN の後に `emit({ kind: "ready", segments: [<IN で作った範囲>], telops: [], meta: META_A })` と `await flush()` で状態を流してから次の操作をする。同じ describe の `markedRange()` ヘルパー (1288 行付近) が送った `MARK_IN` から範囲を取り出すなら、そのまま使える (IN は idle から押すと今も `MARK_IN` を送る) |
| C. (上で済ませた) | | |
| D. 「▶ 範囲を見る」の文言を探している | 再生ボタンを名前で探すテスト | 「▶ 区間を見る」に変える |
| E. 上のどれでもない | — | 落ちた理由を読み、実装の不具合ならテストではなく実装を直す |

`tests/content/segment-list.test.ts` / `telop-list.test.ts` / `telop-track.test.ts` は一覧そのものの単体テストで、モードを見ていない。落ちなければ触らない。

- [ ] **Step 6: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラー 0、全 PASS。次の 2 つも確かめる:
- `grep -rnE 'mode: "(edit|simple)"|ClipMode|parseMode' src tests` が、`tests/shared/settings.test.ts` の「読み飛ばし、warn も出さない」の `mergeSettings({ mode: "edit", maxClipSec: 30 })` の 1 行だけ
- 「拡大バーを操作できる状態 > 受け付けられなかった範囲変更は、画面を状態機械側へ戻す」(preview で OUT を押すと「受け付けられませんでした」) が PASS している (受理の判定 `segmentIs` が効いている)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src tests
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat: シンプル / エディットのモードを無くし、いつも複数の区間を扱う

ADR 0001 で、モードを無くし区間が 1 つならシンプルと同じにすると決めたため。設定から mode を外し (保存済みの値は
黙って読み飛ばす)、youtube.ts のシンプルの楽観描画とモードの切り替えを消す。IN は、区間を組み立てている途中なら
選んでいる区間の頭を合わせ、それ以外 (区間が無い・録画した後・別の動画の区間しか無い) は今の位置から範囲を
作り直す (録り終えたら次の場面で IN、を残す)。区間を変える送信には受理の判定を付け、拒まれたら理由を出す。
テロップのプレビューと焼き込みはいつも効く。

直したテスト:
<規則 A・B・D・E ごとに、テスト名を列挙する。名前を挙げて消した・直したテストも列挙する>
EOF
```

---

### Task 3: e2e

**Files:**
- Modify: `e2e/smoke.spec.ts`、`e2e/telop-check.spec.ts`

- [ ] **Step 1: smoke を直す**

`e2e/smoke.spec.ts`:

- test「popup のスイッチを押すと…ボタンは設定の保存だけ」(388 行付近) の `await expect(popup.locator("#yt-clip-setting-mode")).toBeVisible();` を `await expect(popup.locator("#yt-clip-setting-maxClipSec")).toBeVisible();` にする。**欄の id は `src/popup/settings-form.ts` の id の作り方と、`SETTINGS_FIELDS` の最大秒数の項目の `key` で確かめる** (`grep -n "key:" src/shared/settings.ts`、`grep -n "yt-clip-setting-" src/popup/settings-form.ts`)。key が `maxClipSec` でなければ、その key に合わせる
- test「設定は popup にあり、保存すると開いている YouTube のタブにすぐ効く…」(423 行付近): モードを `edit` に変えて「＋ 区間を追加」が出るのを見ていた所を、最大秒数を変えて効くのを見る形にする。**IN ではなく「＋ 区間を追加」で確かめる** (前のテストが残した区間があると、IN は頭を合わせるだけで新しい範囲を作らない。＋ 区間を追加は、区間の有無に関わらず最大秒数の長さの区間を足して選ぶ):

```typescript
    await popup.locator("#yt-clip-setting-maxClipSec").fill("10");
    // 保存できたら popup は閉じる (settings-in-popup spec §1)
    const closed = popup.waitForEvent("close", { timeout: 10_000 });
    await save.click();
    await closed;

    // 読み込み直さずに効く (sync の onChanged): ＋ 区間を追加で足す区間が 10 秒になり、選ばれて状態の欄に出る
    await bar.getByRole("button", { name: "＋ 区間を追加" }).click();
    await expect(bar.locator("#yt-clip-bar-status")).toContainText("(10秒)", { timeout: 5_000 });
```
  (`#yt-clip-bar-status` は `buildBar` の `status.id = \`${BAR_ID}-status\`` で確かめる。`(10秒)` は `rangeLabel` の形。同じファイルの test「IN を指定するとページ内で録画を始められる」の期待値 `"0:05 〜 0:20 (15秒) を録画できます"` と同じ書き方)
  - 前提のコメント「前提を自分で作る: オン・シンプル」→「前提を自分で作る: オン・設定は既定」
  - finally の `chrome.storage.sync.remove("settings")` はそのまま (最大秒数を既定に戻す)
- test「オフ → オンで、浮かせて置いた窓は…」(334 行付近) の `mode: "edit"` を書いている行から `mode` を除く (「＋ 区間を追加」はいつも出る)。書く値が空になるなら、その書き込みごと消す
- test「IN を指定するとページ内で録画を始められる」(197 行付近) は、ファイルの先頭のテストより後で走るが、その時点で状態機械は idle (ブラウザを起動した直後) なので IN は今までどおり範囲を作る。落ちたときだけ直す

- [ ] **Step 2: telop-check を直す**

`e2e/telop-check.spec.ts` (手動実行専用。`YT_CLIP_TELOP_CHECK=1` のときだけ走る):

- `writeSettings({ mode: "edit" })` の呼び出し (350 行付近) から `mode` を除く。ほかに書く値が無ければ呼び出しごと消す
- check「シンプルモードでテロップの一覧が出ない」(871 行付近) を消す
- 受け入れ条件 1440x795 (907 行付近): この確認の前提は「区間はまだ無い」で、今は直前の確認でシンプルへ切り替えた (`RESET_MARKS` で区間を捨てた) ことに頼っている。「edit に戻す」操作を消し、代わりに確認の先頭で区間とテロップを空にする。テロップを先に全部消す (最後の区間はテロップが残っていると消せない):

```typescript
    // `page.setViewportSize` の後、`try` の中の `page.reload` より前に置く (今のページに一覧が出ている間に消す。
    // reload の後だと、一覧が描かれる前に count() が 0 を返して空振りする)。そこにあるコメント「区間はまだ無い
    // (直前の項目でシンプルに切り替えた) ので reloadAndWaitList は使わない」も「区間とテロップはここで空にした」に直す。
    // 前の確認が残した区間とテロップを空にする (モードの切り替えで捨てていた分)。
    // テロップを先に消す: テロップが残っていると最後の区間は ✕ できない
    while ((await telopRows.count()) > 0) {
      const count = await telopRows.count();
      await telopRows.first().locator("[data-role=remove]").click();
      await expect(telopRows).toHaveCount(count - 1);
    }
    while ((await segmentRows.count()) > 0) {
      const count = await segmentRows.count();
      await segmentRows.first().locator("[data-role=remove]").click();
      await expect(segmentRows).toHaveCount(count - 1);
    }
```
  (787 行付近の既存のループと同じ書き方。区間の行の ✕ の `data-role` が `remove` でなければ、`src/content/segment-list.ts` の ✕ のボタンの `data-role` に合わせる)
- `saveSettingsInPopup` (488 行付近) の select を扱う分岐は、ほかの select (フォントなど) を扱っていれば残す。モードにしか使っていなければ消す
- 1089 行付近のコメントがモードに触れていれば、モードの無い言い方に直す

- [ ] **Step 3: 実行して確認**

実行: `npm run build && npx playwright test e2e/smoke.spec.ts e2e/captions.spec.ts`
期待: smoke は、既知の 1 件 (「オフにすると 1 秒以内…」が `expect(extensionLogs).toEqual([])` で落ちる) だけが落ち、他は pass。その 1 件が別の assertion で落ちていたら、この plan の不具合なので直す。captions は pass。telop-check は `npx playwright test e2e/telop-check.spec.ts` が skip で終わることだけを確かめる (手動実行専用)

- [ ] **Step 4: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
test(e2e): モードの欄が無くなった popup と、モードの切り替えに頼っていた前提を直す

popup の設定からモードの欄が消えたので、設定が開いたタブにすぐ効くことは最大秒数で確かめる。前のテストが
残した区間があると IN は頭を合わせるだけなので、＋ 区間を追加で確かめる。テロップの手動確認からシンプルモードの
確認を消し、モードの切り替えで区間を捨てていた所は、テロップと区間を ✕ で空にする。
EOF
```

---

## 完了後

1. `npm run typecheck && npm test` を実行して green を確認。e2e は Task 3 の結果
2. 1b-1 の差分 (`git -C /Users/trapple/repos/github.com/trapple/yt-clip diff <この plan の commit>..HEAD`) を新しい subagent に「保守担当」の視点で 1 回見せ、モードの消し残しと、区間 1 つの流れ (IN → OUT → 録画 → 次の場面で IN) の抜けが無いかを確かめる。whole-branch cross-review (保守担当 + 攻撃者) は 1b-2 の完了後にまとめて行う (1b-1 は振る舞いを減らすだけで、新しい入力の経路を足さない)
3. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ
4. 普段の Chrome で、拡張を再読み込みしてもらい (ユーザーの操作)、Claude in Chrome で「区間 1 つで IN → OUT」「＋ 区間を追加で 2 つ」「録画した後の IN で作り直す (録画は実時間かかるので、短い区間で)」を確かめる。popup にモードの欄が無いことは、popup をこちらから開けないのでユーザーに見てもらう
5. 掲載画像は 2 枚とも撮り直しが要る (`npm run screenshots`。`docs/store-release.md` に書いた)。撮り直しはリリースの準備のときに行う

## 自律判断ログ

- モード: autonomous (根拠: Auto Mode 既定)
- [選択] 1b を 1b-1 (モードの廃止) と 1b-2 (文字起こしの欄) に分ける — モードの廃止だけで youtube.test.ts の 15 前後の describe と e2e 3 本に及ぶ
- [選択] IN は「区間を組み立てている途中 (ready でこの動画の区間がある)」なら頭を合わせ、それ以外は作り直す (`MARK_IN`) — これまでのシンプルの「録り終えたら次の場面で IN」を残すため。録画した後の区間は焼き込み済みで、頭を動かしても録り直しになるだけ。テロップがあっても作り直しで消える (焼き込み済み) (可逆)
- [選択] シンプルの楽観描画はやめ、区間を変える送信には受理の判定 (`segmentIs`) を付ける — 判定を消すと、拒まれたときに「受け付けられませんでした」が出なくなる
- [選択] 状態機械と router は変えない — `MARK_IN` は IN の作り直しで今も使う
- [仮定] 保存済みの `mode` は warn も出さずに読み飛ばす — 前の版が書いた正しい値。覚えた配置の `"settings"` を黙って捨てたのと同じ判断。次の保存で storage からも消える
- [割り切り] 既存テストの直しは、名前の分かるものは plan に名指しし、残りは規則 (A・B・D・E) で直す — 落ちるテストは実装してみないと確定しない。どの規則で直したかを commit の本文に列挙して追えるようにする
- [review:plan/ゼロ context の実装者] 3 往復目 Approved。Recommendations: grep に当たるコメント・テスト名の言い換え、router.test.ts のコメント、telop-check のループの置き場所を取り込み。尻と同じ位置の IN を `>` にする案は不採用 (同じ位置でも ＋ 区間を追加へ案内する方が役に立つ)。上限の 3 往復に達した
- [review:plan/ゼロ context の実装者] 2 往復目 Issues 2 件 → 修正 (消した applyRange が外していた再生の監視を、OUT・IN・＋ 区間を追加の前に外す / 状態が届いたら ready で範囲を状態の欄に出す。テストを先に足す)。Recommendations: 区間の尻より後ろの IN で ＋ 区間を追加へ案内する文言・モード前提の名前のまま残るテストの名前・(3) の全文・telop-check のループの置き場所を取り込み
- [review:plan/ゼロ context の実装者] 1 往復目 Issues 9 件 → 修正 (録画した後の IN で作り直す / 受理の判定を残す / v1 の配置を継ぐテストを反転して残す / IN の直後の操作は状態を流す / grep の確かめ方と残るコメント / e2e は前のテストが残した区間に頼らない / telop-check は ✕ で空にする / 掲載画像の文と撮り直し / 文書の「範囲を再生」と CHANGELOG の既存の項目)。Recommendations: Task 2 と 3 を 1 つにまとめる・規則 C を落ちなくても全部直す・意味の無くなるテストを名指しで消す・plan の外のコメント・(18) の全文・次の保存で消えることのコメントを取り込み。「モードを変えても窓を作り直さず…」は、消さずにバーを作り直すきっかけを YouTube の再描画 (`barElement().remove()`。1359 行付近のテストと同じ起こし方) に変えて残す (作り直したつまみを登録し直す確認は、ほかのテストに無かった)
