# UI の右側パネル化 実装プラン

> **実装者向け:** このプランは subagent-driven-development で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 区間の一覧・テロップの一覧・設定を画面右側の固定パネルへ移し、1440x795 でもプレイヤー直下の
拡大バーと操作の行 (IN / OUT / 録画) がスクロールせずに画面に収まるようにする。

**Architecture:** 新しいモジュール `src/content/side-panel.ts` がパネルの枠 (見出し・折り畳み・中身の箱) だけを持つ。
`youtube.ts` の `buildBar` はバー (拡大バー → 操作の行) だけを作り、一覧と設定はパネルの `body` に入れ直す。
パネルを出すかの理由 (中身が無い / 全画面 / 動画ページ以外) は `youtube.ts` の `refreshSidePanel()` 1 箇所で計算する。
区間・テロップ・設定の各部品 (`segment-list.ts` / `telop-list.ts` / `settings-panel.ts`) は中身を変えない。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-24-side-panel-design.md` (以下「spec」)

## Global Constraints

### Spec 由来 (spec から逐語コピー)

- 拡大バーと操作ボタンの行は、幅が要るのでプレイヤー直下に残す (並びは今のまま: 拡大バー → 操作の行)
- **受け入れ条件:** 画面 1440x900 のノート PC 相当 (viewport 1440x795) で、エディットモードで区間 5 つ・テロップ 5 つがあっても、プレイヤー直下のバーの下端が画面内に収まり、スクロールせずに IN / OUT / 録画と拡大バーを操作できる。区間とテロップの一覧はパネルの中でスクロールして届く
- `position: fixed`。画面の右端から 16px、上端は YouTube のヘッダー (56px) の下 12px
- 幅 400px。高さは中身に合わせ、最大で画面の下端から 16px まで。**超えた分はパネルの中だけでスクロールする**
- 不透明な背景と影を付ける。**パネルの地の色をパレットに 1 つ足す** (`--ytc-panel`: light `#ffffff` / dark `#212121`)。テーマの切り替えにも追従する
- 重なり順 (`z-index`) は 2000。YouTube のヘッダーのメニュー類より下、ページ本体より上
- ヘッダーの高さ (56px)・おすすめ列の幅 (402px 前後)・ヘッダーのメニューの重なり順は実機の値。**実装時に DevTools で確かめ、`side-panel.ts` のコメントに出所を書く**
- `document.body` の直下に置く。**`mount()` で、パネルが body から外れていたら付け直す** (バーの有無を見ているのと同じ場所)
- **全画面の間 (`document.fullscreenElement != null`) はパネルを隠す** (`fullscreenchange` で切り替える)。`!== null` にしない: jsdom は `fullscreenElement` を持たず `undefined` を返すので、テストで常に全画面扱いになる
- **状態の文言は 1 行に収め、はみ出した分は省略記号 (…) にする**。全文はマウスを乗せると出る (`title`)。`#yt-clip-bar-status` (`span`、flex の子) に `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` を当てる
- いつ出すか: エディットモードで区間が 1 つ以上ある → 出す / ⚙ で設定を開いている (モードに関わらず) → 出す / シンプルモードで設定を閉じている → 出さない / エディットモードで区間が 0 個、設定も閉じている → 出さない / 動画ページ以外 → 出さない
- 中身が 1 つも無いときは、パネルごと隠す。空の枠だけを出さない
- ⚙ は今どおりプレイヤー直下の行に置き、押すと設定をパネルに開閉する
- パネルの見出し (「yt-clip」) に折り畳みボタン (▶ / ◀) を置く。畳むと、見出しの 1 行だけが残る
- **自動では畳まない**
- 畳んだ状態は、そのタブを開いている間だけ覚える (保存しない)
- 設定を開いたとき (⚙) と区間・テロップを足したときは、畳んでいても開く
- 設定を開いたら設定の先頭へ、区間・テロップを足したら足した行へ、パネルの中だけをスクロールする。**`scrollIntoView` は使わない**。パネルの本体の `scrollTop` を自前で合わせ、対象の先頭をパネルの上端に揃える (対象が既に全部見えていれば動かさない)。計算は `side-panel.ts` の `scrollTo(target)` に置く
- `SidePanel` の型は spec §4 のとおり (`element` / `body` / `setVisible` / `reveal` / `scrollTo` / `destroy`)、`createSidePanel(): SidePanel`
- 区間の一覧 (`segment-list.ts`)・テロップの一覧 (`telop-list.ts`)・設定パネル (`settings-panel.ts`) は **中身を変えない**
- バーを作り直す (`applyMode` / `mount`) ときは、パネルの中身も入れ直す (古い一覧を残さない)
- 「中身があるか」は各部品の `hidden` から決める (区間の一覧・テロップの一覧・設定パネルの 3 つのうち 1 つでも見えていれば出す)
- **別の動画へ SPA 遷移したら、一覧とパネルの表示を今の動画に合わせ直す。** observer の href の分岐で、区間の写しと同じ規則 (別の動画では空) で一覧を描き直す
- **順序:** 必ず `setVisible(true)` → `reveal()` → `scrollTo(target)` の順に呼ぶ
- `scrollTo` の計算は `getBoundingClientRect()` の差で行う
- 区間・テロップを足した行へのスクロールは、クリック時ではなく状態機械の応答を描いた後 (`applyStateToDisplay`) に行う。区間の `selectLastOnNextState` と同じ形の「足した直後の 1 回だけ末尾へ」フラグをテロップにも置く
- 状態の文言に `flex:1` を当てると、⚙ の `margin-left:auto` は要らなくなる。消して意図を 1 つにする
- 設定パネルの開閉は `settingsPanel.toggle()` のまま (中身を変えない)。開いたかどうかは `settingsPanel.element.hidden` で読む
- **受け入れ条件の確認を `npm run check:telop` に足す:** 既存の 1920x1080 の確認がすべて済んだ後に viewport を 1440x795 に切り替え (最後に元へ戻す)、エディットモードで区間 5 つ・テロップ 5 つ・**設定も開いた** 状態で測る: `#yt-clip-bar` の下端が `innerHeight` 以内 / パネルの下端も `innerHeight` 以内 / パネルの中身が溢れていてパネルの中でスクロールできる (`scrollHeight > clientHeight`)。スクリーンショットを残す
- 掲載画像 (2-settings.png) はパネルの中を設定の先頭までスクロールした状態で撮る (末尾は切れてよい)。おすすめ列を隠す既存の CSS は残す
- パネル内の「閉じる」ボタンは作らない (設定は今どおり ⚙ で閉じる)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定 (`~/.claude/CLAUDE.md`) と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 1 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C /Users/trapple/repos/github.com/trapple/yt-clip ...` を使う
- 外部プロセスを起動して待つ処理には必ず timeout を付ける。**この macOS には `timeout` コマンドが無い**。Bash ツールの `timeout` 引数 (最大 600000) か、スクリプト側の timeout で止める
- 小さく検証してから全件: 単体テスト → `npm run e2e` (smoke) → `npm run check:telop` の順に広げる
- 日付を書くときは JST (`TZ=Asia/Tokyo date +%F`) であることを明示する
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 握りつぶすなら「なぜ握りつぶしてよいか」をコメントで説明する
- テストは `npm test` (vitest)、型は `npm run typecheck`。**各タスクの commit 前に両方を通す** (`npm run typecheck && npm test`、Bash の timeout 600000)

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch 名 `feat/side-panel` (`feat/telop-phase1` から分岐済み。spec は `aa445b5` で commit 済み)
- 並列: SDD (1 タスクごとに新しい実装担当 + レビュー)。**同じファイルを触るタスク (Task 2・4・5 の `youtube.ts` と `tests/content/youtube.test.ts`) と、前のタスクの定義を使うタスク (Task 3 は Task 2 の `SIDE_PANEL_STYLE` を使う) は、依存順に 1 つずつ走らせる**
- Task 8 は **controller (メインセッション) が実行する**。実機 (Chrome の起動・YouTube) を使う確認と、その結果を見て書くコメント・ドキュメントの更新を含むため
- 終点: branch `feat/side-panel` 上の commit まで。push / PR はユーザーの指示を待つ

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (styles.ts: パネルの色と見た目・状態の文言の省略) ─→ Task 3 (side-panel.ts)
Task 3 ─→ Task 4 (youtube.ts の配線) ─→ Task 5 (足した行へ送る)
Task 5 ─→ Task 6 (E2E と受け入れ確認のコード) ─→ Task 8 (controller: 実機で確かめる)
Task 5 ─→ Task 7 (掲載画像の撮り方)          ─→ Task 8
```

## 既存テストの洗い出し (grep の結果。Task 4・6 の前提)

- `tests/content/youtube.test.ts` で `#yt-clip-bar` の中を探しているのは `clickButton()` (426 行付近)・`describe("設定")` の `settingsButton()` (951 行付近)・`describe("エディットモード")` の `buttonLabels()` (1091 行付近) の 3 つで、**どれも操作の行のボタン (IN / OUT / ▶ 範囲を見る / ＋ 区間を追加 / ⚙) を探している**。これらはバーに残るので変えない。一覧 (`[data-role='segment']` / `[data-role='telop']` / `[data-role='add-telop']`) と設定 (`#yt-clip-setting-*`) は **すべて `document` 全体から探している**ので、パネルが body に付いていれば見つかる。その代わり「バーではなくパネルに入っている」ことはどの既存テストも見ていないので、Task 4 のテストで固定する
- `e2e/telop-check.spec.ts` は一覧と ＋ テロップを `bar.locator(...)` で探している (370〜371 行付近・491 行付近・781 行付近・798〜799 行付近)。**パネルへ移すとどれも見つからなくなる**。特に 798〜799 行付近の `toBeHidden` は、見つからない要素でも通ってしまう (検査が空振りする) ので、Task 6 で数を確かめてから隠れていることを見る形に直す
- `e2e/smoke.spec.ts` は `#yt-clip-bar` の IN / OUT / ● 録画 と `#yt-clip-bar-status` だけを見ている。**変更不要**

---

### Task 1: ドキュメントを先に直す

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/store-release.md`
- Modify: `docs/manual-check.md`

**Interfaces:**
- Consumes: なし
- Produces: なし (ドキュメントのみ)

グローバル規約「ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する」に従う。
`scripts/screenshots.mjs` は spec §6 に載っているがコードなので Task 7 で行う。

- [ ] **Step 1: README の「使い方」の後の 1 文を直す**

`README.md` の 18 行目付近、

```markdown
操作は YouTube のページ内で完結する。設定は同じバーの **⚙** から開く。
```

を次に置き換える。「プレイヤー下の拡大バー」(12 行目付近) は据え置く。

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で右側のパネルに開く。
```

- [ ] **Step 2: README のエディットモードの節にパネルを足す**

`README.md` の 34〜35 行目付近の段落

```markdown
一覧から区間を選ぶと拡大バーがその区間に切り替わるので、ハンドルでも
調整できる。録画は区間を順に辿って 1 本のクリップにする。
```

の**直後** (空行を 1 つ挟んで、`### テロップ (エディットモード)` の見出しの前) に次を挿入する。

```markdown
区間とテロップの一覧は、画面右側のパネルに出る。IN / OUT・録画のボタンと拡大バーは
プレイヤー直下に残るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったらパネルの中でスクロールする。パネルは見出しの **▶** で畳める
(見出しの 1 行だけが残る。**◀** で開く)。
```

同じ README の 39 行目付近、

```markdown
区間の一覧の下に **テロップ** の一覧が出る。
```

を次に置き換える。

```markdown
パネルの区間の一覧の下に **テロップ** の一覧が出る。
```

- [ ] **Step 3: README の「仕様と制約」の「操作の置き場所」に足す**

`README.md` の `### 操作の置き場所` の節 (133〜135 行目付近) の既存の項目

```markdown
- **操作は YouTube のページ内で完結する**。拡張のポップアップは状態を映す
  だけで、ボタンは持たない。ポップアップを残しているのは、YouTube 以外の
  タブにいるときに状態を見る場所が無くなるため
```

の**直後** (`## 開発` の見出しの前) に次を足す。

```markdown
- **区間・テロップ・設定は画面右側のパネルに出る**。IN / OUT・録画と拡大バーはプレイヤー直下に
  残す (拡大バーは幅がそのまま精度になるため、パネルの幅には縮めない)。パネルはおすすめ動画の列の
  上に重ねるので、通常の表示では動画を隠さない
- **シアターモードや狭い画面 (YouTube が 1 列表示に切り替わる幅) では、パネルが動画の右側に重なる**。
  そのときは見出しの ▶ で畳む。畳んでも見出しの 1 行は動画の右上に残る。自動では畳まない
  (重なるかどうかの判定は YouTube のレイアウトに依存し、外れると勝手に消えたように見えるため)
- **畳んだ状態はタブを開いている間だけ覚える**。開き直すと開いた状態に戻る (保存すると
  「パネルが出ない」の原因になりやすいため)。⚙ で設定を開いたときと、区間・テロップを足したときは、
  畳んでいても開く
- **全画面の間はパネルを出さない**
- **状態の文言は 1 行に収める**。長い文言は末尾が「…」で省略され、マウスを乗せると全文が出る
```

- [ ] **Step 4: CHANGELOG の「未リリース」に 1 項目足す**

`CHANGELOG.md` の「## 未リリース」の既存の段落 (「**エディットモードにテロップを足した。**」で始まり「確かめられる。」で終わる) の**直後**に、空行を 1 つ挟んで次を足す。

```markdown
**区間・テロップ・設定を画面右側のパネルに移した。** 区間やテロップが増えても、プレイヤー直下の
IN / OUT・録画と拡大バーはページをスクロールせずに操作できる。パネルは見出しで畳める。
```

- [ ] **Step 5: ストア掲載文とスクリーンショットの説明を直す**

`docs/store-release.md` の 72 行目付近、

```text
・「＋ 区間を追加」で区間を増やし、一覧から選んで IN / OUT や拡大バーで調整します
```

の**直後**に次の 1 行を足す。

```text
・区間とテロップの一覧は画面右側のパネルに出ます。見出しで畳めます
```

同じファイルの 81 行目付近の `■ 設定 (⚙)` の見出しと、その下の空行の**後** (「・モード — シンプル…」の行の前) に、次の 1 行と空行を足す。

```text
⚙ を押すと画面右側のパネルに開きます。

```

同じファイルの 162〜163 行目付近、

```markdown
1. `1-range.png` — 再生画面の下に出た操作バーと拡大バー (IN/OUT を置いた状態)
2. `2-settings.png` — 設定パネルを開いた状態
```

を次に置き換える。

```markdown
1. `1-range.png` — 再生画面の下に出た操作バーと拡大バー (IN/OUT を置いた状態)。
   シンプルモードで設定を閉じているので、右側のパネルは出ていない
2. `2-settings.png` — ⚙ で設定を右側のパネルに開いた状態。パネルの中を設定の先頭まで送って撮る。
   1280x800 ではパネルに全項目が収まらず末尾が切れる (パネルの中でスクロールすることが分かる絵にしてある)
```

- [ ] **Step 6: 手動確認のチェックリストを直す**

`docs/manual-check.md` の 70 行目付近、

```markdown
- [ ] ⚙ でモードをエディットに変えると、バーに区間の一覧が出る
```

を次に置き換える。

```markdown
- [ ] ⚙ でモードをエディットに変えて区間を足すと、画面右側のパネルに区間の一覧が出る (区間が 0 個の間はパネルごと出ない)
```

同じファイルの「## 設定」の節の先頭の項目 (276 行目付近)、

```markdown
- [ ] バーの右端に ⚙ が出て、押すとパネルが開く。もう一度押すと閉じる
```

を次に置き換える。

```markdown
- [ ] バーの右端に ⚙ が出て、押すと右側のパネルに設定が開く。もう一度押すと閉じる
```

同じファイルの「## 見た目」の節の最後の項目 (356 行目付近)、

```markdown
- [ ] 全画面表示やシアターモードに切り替えてもバーが壊れない
```

の**直後** (`## popup` の見出しの前) に次を足す。

```markdown
- [ ] 右側のパネルが、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
- [ ] パネルの地が不透明で、下のおすすめ動画が透けない (ダーク・ライトの両方。テーマを切り替えるとパネルも追従する)
- [ ] 区間とテロップを増やすと、**パネルの中だけ**がスクロールする (ページはスクロールしない)。パネルの下端は画面の下から 16px で止まる
- [ ] 見出しの ▶ で畳むと見出しの 1 行だけが残り、◀ で開く。畳んだまま ⚙ を押すと開いて設定が見える。＋ 区間を追加・＋ テロップを押すと開いて足した行が見える
- [ ] 区間とテロップが多いときに ⚙ を押すと、パネルの中が設定の先頭まで送られる (ページは動かない)
- [ ] シアターモードではパネルが動画の右側に重なる (仕様)。畳めば見出しの 1 行だけが動画の右上に残る
- [ ] 全画面の間はパネルが出ず、全画面を抜けると戻る
- [ ] 状態の文言が長いときは 1 行で省略され (…)、マウスを乗せると全文が出る
- [ ] 別の動画へ移ると、パネルの一覧に前の動画の区間が残らない。ホームへ移るとパネルが消える
```

- [ ] **Step 7: 差分を見直す**

実行: `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff --stat`
期待: `README.md` / `CHANGELOG.md` / `docs/store-release.md` / `docs/manual-check.md` の 4 ファイルだけが変わっている

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/store-release.md docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 区間・テロップ・設定を右側のパネルに移すことを先に書く

エディットモードで区間とテロップが増えると、プレイヤー直下の操作まで
スクロールしないと届かなくなっていた。コードより先に、利用者から見た
置き場所と、シアターモードで重なるといった正直な制約を固めておく。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: パネルの色と見た目・状態の文言の省略表示

**Files:**
- Modify: `src/content/styles.ts`
- Modify: `src/content/youtube.ts` (`setStatus` 211 行目付近 / `buildBar` の状態の文言 1330 行目付近と ⚙ 1340〜1344 行目付近)
- Test: `tests/content/styles.test.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `Palette` に `panel: string` を足す。`applyPalette(element, dark)` が `--ytc-panel` も流し込む (light `#ffffff` / dark `#212121`)
  - `SIDE_PANEL_STYLE: { root: string; header: string; title: string; collapseButton: string; body: string }` (`as const`)。**`root` と `body` は `display` を含まない** (出し入れは `side-panel.ts` が `style.display` で行う)
  - `BAR_STYLE.status` が `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` を含む
  - `setStatus(text)` が `#yt-clip-bar-status` の `title` にも `text` を入れる

- [ ] **Step 1: 失敗するテストを書く (styles)**

`tests/content/styles.test.ts` の import を次に置き換える。

```typescript
import { BAR_STYLE, SIDE_PANEL_STYLE, applyPalette, isDarkTheme } from "@/content/styles";
```

同じファイルの `describe("applyPalette", ...)` の中の `test("必要な色をすべて流し込む", ...)` の配列に `"--ytc-panel",` を足す (`"--ytc-on-accent",` の次の行)。

同じ `describe("applyPalette", ...)` の最後 (`test("必要な色をすべて流し込む", ...)` の後、`describe` を閉じる `});` の前) に次を足す。

```typescript
  test("パネルの地は light #ffffff / dark #212121", () => {
    const element = document.createElement("div");

    applyPalette(element, false);
    expect(element.style.getPropertyValue("--ytc-panel")).toBe("#ffffff");

    applyPalette(element, true);
    expect(element.style.getPropertyValue("--ytc-panel")).toBe("#212121");
  });

  test("パネルの地は面の色と違う", () => {
    // 面 (--ytc-surface) はテロップ行・選択中の区間行・設定の背景。地と同じだと溶ける
    const element = document.createElement("div");
    for (const dark of [false, true]) {
      applyPalette(element, dark);
      expect(element.style.getPropertyValue("--ytc-panel")).not.toBe(
        element.style.getPropertyValue("--ytc-surface"),
      );
    }
  });
```

同じファイルの末尾に次を足す。

```typescript
describe("状態の文言", () => {
  test("1 行に収めてはみ出しを省略する", () => {
    // min-width:0 が無いと flex の子は中身より縮まず、行が 2 段に折り返す
    for (const declaration of [
      "flex:1",
      "min-width:0",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "white-space:nowrap",
    ]) {
      expect(BAR_STYLE.status).toContain(declaration);
    }
  });
});

describe("右側のパネル", () => {
  test("地はパネル用の色で塗る", () => {
    expect(SIDE_PANEL_STYLE.root).toContain("background:var(--ytc-panel)");
  });

  test("本体の中だけでスクロールする", () => {
    expect(SIDE_PANEL_STYLE.body).toContain("overflow-y:auto");
    // flex の子は min-height:0 が無いと中身より縮まず、パネルごと伸びる
    expect(SIDE_PANEL_STYLE.body).toContain("min-height:0");
  });

  test("display は持たない (出し入れは side-panel.ts が決める)", () => {
    expect(SIDE_PANEL_STYLE.root).not.toContain("display:");
    expect(SIDE_PANEL_STYLE.body).not.toContain("display:");
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (youtube)**

`tests/content/youtube.test.ts` の `describe("設定", ...)` の閉じ (974 行目付近の `});`、`describe("最大秒数の設定", ...)` の直前) の後に次を足す。

```typescript
describe("状態の文言", () => {
  test("全文を title にも入れる (1 行に省略して出すため)", async () => {
    clickButton("IN");
    await flush();

    const status = document.getElementById("yt-clip-bar-status");
    expect(status?.textContent).not.toBe("");
    expect(status?.title).toBe(status?.textContent);
  });

  test("⚙ は状態の文言のすぐ後ろ (右端) に置く", () => {
    const status = document.getElementById("yt-clip-bar-status");
    const next = status?.nextElementSibling;
    expect(next?.textContent).toBe("⚙");
    // 右端へは状態の文言の flex:1 で寄せる。margin-left:auto と意図を 2 つ持たない
    expect(next instanceof HTMLElement ? next.style.marginLeft : "missing").toBe("");
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/styles.test.ts tests/content/youtube.test.ts` (Bash の timeout 600000)
期待: FAIL。`SIDE_PANEL_STYLE` が undefined、`--ytc-panel` が空、`title` が空、`marginLeft` が `"auto"`

- [ ] **Step 4: `styles.ts` を直す**

`src/content/styles.ts` の冒頭のコメント (8〜9 行目付近)

```typescript
 * 配色は自前の変数 (`--ytc-*`) としてバーの根に置く。テーマが切り替わったら
 * その 6 個を差し替えるだけで全体が追従する。
```

を次に置き換える。

```typescript
 * 配色は自前の変数 (`--ytc-*`) としてバーと右側のパネルの根に置く。テーマが
 * 切り替わったらその 7 個を差し替えるだけで全体が追従する。
```

`Palette` 型 (12〜19 行目付近) を次に置き換える。

```typescript
export type Palette = {
  text: string;
  textSub: string;
  surface: string;
  border: string;
  accent: string;
  onAccent: string;
  /**
   * 右側のパネルの地。**`surface` とは別に持つ。** `surface` はテロップ行・選択中の
   * 区間行・設定の背景に使っており、それを地にすると行と設定が地に溶ける
   */
  panel: string;
};
```

`LIGHT` の `onAccent: "#ffffff",` の次の行に `panel: "#ffffff",` を、`DARK` の `onAccent: "#0f0f0f",` の次の行に `panel: "#212121",` を足す。

`applyPalette` の `element.style.setProperty("--ytc-on-accent", palette.onAccent);` の次の行に次を足す。

```typescript
  element.style.setProperty("--ytc-panel", palette.panel);
```

`BAR_STYLE.status` (70 行目付近)

```typescript
  status: "color:var(--ytc-text-sub);font-size:12px;",
```

を次に置き換える。

```typescript
  /**
   * 状態の文言。**1 行に収めて、はみ出しは … にする。** 長い文言 (「テロップが N 件
   * 残っています…」など) で行が 2 段に折り返すと、バーが伸びて動画と操作が 1 画面に
   * 収まらなくなる。全文は title で出す。`min-width:0` が無いと flex の子は中身より
   * 縮まず折り返す。`flex:1` で残りの幅を取るので、後ろの ⚙ は右端に来る
   */
  status:
    "color:var(--ytc-text-sub);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
```

ファイルの末尾 (`TELOP_STYLE` の後) に次を足す。

```typescript
/**
 * 右側のパネル (`side-panel.ts`)。位置・幅・重なり順は YouTube の実機の値に合わせる
 * ので、出所と一緒に `side-panel.ts` が持つ。
 *
 * **`root` と `body` は display を持たない。** 出し入れは `side-panel.ts` が
 * `style.display` で行う。ここに display を書くと、`hidden` を立てても inline の
 * display が勝って出たままになる
 */
export const SIDE_PANEL_STYLE = {
  /** 下のおすすめ動画が透けると読めないので、不透明な地と影を付ける */
  root: `flex-direction:column;box-sizing:border-box;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:${FONT};font-size:13px;`,
  header: "display:flex;align-items:center;gap:8px;padding:8px 12px;",
  title: "flex:1;color:var(--ytc-text);font-size:13px;font-weight:600;",
  collapseButton: SEGMENT_STYLE.iconButton,
  /**
   * 中身の箱。**超えた分はここだけでスクロールする。** `min-height:0` が無いと
   * flex の子は中身より縮まず、パネルごと画面の下へ伸びる
   */
  body: "flex-direction:column;gap:12px;padding:0 12px 12px;overflow-y:auto;min-height:0;flex:1 1 auto;",
} as const;
```

- [ ] **Step 5: `youtube.ts` の状態の文言と ⚙ を直す**

`src/content/youtube.ts` の `setStatus` (211〜216 行目付近)

```typescript
function setStatus(text: string): void {
  const status = document.getElementById(`${BAR_ID}-status`);
  if (status !== null) {
    status.textContent = text;
  }
}
```

を次に置き換える。

```typescript
function setStatus(text: string): void {
  const status = document.getElementById(`${BAR_ID}-status`);
  if (status !== null) {
    status.textContent = text;
    // 1 行に省略して出すので、全文はマウスを乗せたときに読めるようにする
    status.title = text;
  }
}
```

`buildBar` の状態の文言 (1330〜1333 行目付近)

```typescript
  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.style.cssText = BAR_STYLE.status;
  status.textContent = "IN を押して開始位置を指定";
```

を次に置き換える。

```typescript
  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.style.cssText = BAR_STYLE.status;
  status.textContent = "IN を押して開始位置を指定";
  status.title = status.textContent;
```

`buildBar` の ⚙ (1340〜1344 行目付近)

```typescript
  const settingsPanel = createSettingsPanel({ getContext: readChannelContext });
  const settingsButton = makeButton("⚙", false, () => settingsPanel.toggle());
  settingsButton.title = "設定";
  // 右端へ寄せる。操作の並びから外して、押し間違いを減らす
  settingsButton.style.cssText += "margin-left:auto;";
```

を次に置き換える。

```typescript
  const settingsPanel = createSettingsPanel({ getContext: readChannelContext });
  // 状態の文言 (flex:1) が残りの幅を取るので、⚙ は右端に来る。操作の並びから
  // 外して、押し間違いを減らす
  const settingsButton = makeButton("⚙", false, () => settingsPanel.toggle());
  settingsButton.title = "設定";
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (失敗 0)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/styles.ts src/content/youtube.ts tests/content/styles.test.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(styles): パネルの地の色を足し、状態の文言を 1 行に収める

右側のパネルは下のおすすめ動画が透けると読めないので、不透明な地を
パレットに足す。既存の面の色を地にすると、テロップ行や設定が地に溶ける。
状態の文言は長いと 2 段に折り返してバーを伸ばすので、1 行に省略して
全文は title で出す。⚙ は文言の flex:1 で右端に来るので、margin-left:auto
と寄せ方を 2 つ持たない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: パネルの枠を `side-panel.ts` に作る

**Files:**
- Create: `src/content/side-panel.ts`
- Test: `tests/content/side-panel.test.ts`

**Interfaces:**
- Consumes: `SIDE_PANEL_STYLE` (Task 2)
- Produces:
  - `export const SIDE_PANEL_ID = "yt-clip-panel"` / `export const SIDE_PANEL_BODY_ID = "yt-clip-panel-body"`
  - `export type SidePanel = { element: HTMLElement; body: HTMLElement; setVisible(visible: boolean): void; reveal(): void; scrollTo(target: HTMLElement): void; destroy(): void }`
  - `export function createSidePanel(): SidePanel`
  - 折り畳みボタンは `[data-role='collapse']`。開いているとき文言 `▶`・`aria-expanded="true"`、畳んでいるとき `◀`・`aria-expanded="false"`
  - 出ているかは `element.hidden`、畳んでいるかは `body.hidden` で外から読める
  - 作った直後は隠れている (`element.hidden === true`)。開いている (畳んでいない)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/side-panel.test.ts` を作る。

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SIDE_PANEL_BODY_ID,
  SIDE_PANEL_ID,
  createSidePanel,
  type SidePanel,
} from "@/content/side-panel";

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function placeAt(element: HTMLElement, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectAt(top, height));
}

let panel: SidePanel | null = null;

function makePanel(): SidePanel {
  panel = createSidePanel();
  document.body.append(panel.element);
  return panel;
}

function collapseButton(target: SidePanel): HTMLButtonElement {
  const button = target.element.querySelector<HTMLButtonElement>(
    "[data-role='collapse']",
  );
  if (button === null) throw new Error("折り畳みボタンがありません");
  return button;
}

afterEach(() => {
  panel?.destroy();
  panel = null;
  vi.restoreAllMocks();
});

describe("createSidePanel", () => {
  test("作った直後は隠れている (中身が無い間は空の枠を出さない)", () => {
    const target = makePanel();
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("id で外から辿れる", () => {
    const target = makePanel();
    expect(document.getElementById(SIDE_PANEL_ID)).toBe(target.element);
    expect(document.getElementById(SIDE_PANEL_BODY_ID)).toBe(target.body);
  });

  test("setVisible で出し入れする", () => {
    const target = makePanel();

    target.setVisible(true);
    expect(target.element.hidden).toBe(false);
    expect(target.element.style.display).toBe("flex");

    target.setVisible(false);
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("画面の右端に固定し、ページ本体より上に重ねる", () => {
    const target = makePanel();
    expect(target.element.style.position).toBe("fixed");
    // ヘッダー 56px の下 12px
    expect(target.element.style.top).toBe("68px");
    expect(target.element.style.right).toBe("16px");
    expect(target.element.style.width).toBe("400px");
    expect(target.element.style.zIndex).toBe("2000");
  });

  test("見出しに yt-clip と折り畳みボタンを出す。最初は開いている", () => {
    const target = makePanel();
    expect(target.element.textContent).toContain("yt-clip");
    const button = collapseButton(target);
    expect(button.textContent).toBe("▶");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(target.body.hidden).toBe(false);
  });

  test("body に入れたものはパネルの中に出る", () => {
    const target = makePanel();
    const child = document.createElement("div");
    target.body.append(child);
    expect(target.element.contains(child)).toBe(true);
  });

  test("畳むと本体が隠れ、見出しは残る", () => {
    const target = makePanel();
    target.setVisible(true);

    collapseButton(target).click();

    expect(target.body.hidden).toBe(true);
    expect(target.body.style.display).toBe("none");
    // 見出しの 1 行は残る。パネルごと消えると、どこへ行ったか分からない
    expect(target.element.hidden).toBe(false);
    expect(collapseButton(target).isConnected).toBe(true);
    expect(collapseButton(target).textContent).toBe("◀");
    expect(collapseButton(target).getAttribute("aria-expanded")).toBe("false");
  });

  test("もう一度押すと開く", () => {
    const target = makePanel();
    collapseButton(target).click();
    collapseButton(target).click();

    expect(target.body.hidden).toBe(false);
    expect(target.body.style.display).toBe("flex");
    expect(collapseButton(target).textContent).toBe("▶");
  });

  test("reveal で畳んでいたら開く", () => {
    const target = makePanel();
    collapseButton(target).click();

    target.reveal();

    expect(target.body.hidden).toBe(false);
    expect(collapseButton(target).getAttribute("aria-expanded")).toBe("true");
  });

  test("reveal は開いていれば何も変えない", () => {
    const target = makePanel();
    target.reveal();
    expect(target.body.hidden).toBe(false);
    expect(collapseButton(target).textContent).toBe("▶");
  });

  test("destroy で DOM から外れる", () => {
    const target = makePanel();
    target.destroy();
    expect(target.element.isConnected).toBe(false);
    expect(document.getElementById(SIDE_PANEL_ID)).toBeNull();
  });
});

describe("scrollTo", () => {
  function panelWithRow(): { target: SidePanel; row: HTMLElement } {
    const target = makePanel();
    target.setVisible(true);
    const row = document.createElement("div");
    target.body.append(row);
    // 本体は画面の 100〜500px に見えている
    placeAt(target.body, 100, 400);
    return { target, row };
  }

  test("見える範囲より下にあれば、先頭を本体の上端に揃える", () => {
    const { target, row } = panelWithRow();
    placeAt(row, 900, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("既に送ってあれば、その分に足して揃える", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 200;
    placeAt(row, 700, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("上にはみ出していれば、先頭が見えるところまで戻す", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 500;
    placeAt(row, 40, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(440);
  });

  test("既に全部見えていれば動かさない (見ている位置を勝手に跳ねさせない)", () => {
    const { target, row } = panelWithRow();
    target.body.scrollTop = 30;
    placeAt(row, 150, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(30);
  });

  test("本体の外の要素には何もしない", () => {
    const { target } = panelWithRow();
    const outside = document.createElement("div");
    document.body.append(outside);
    placeAt(outside, 900, 50);

    target.scrollTo(outside);

    expect(target.body.scrollTop).toBe(0);
    outside.remove();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/side-panel.test.ts` (Bash の timeout 600000)
期待: FAIL (`Failed to resolve import "@/content/side-panel"` など)

- [ ] **Step 3: 実装する**

`src/content/side-panel.ts` を作る。

```typescript
import { SIDE_PANEL_STYLE } from "@/content/styles";

/**
 * 画面右側に固定するパネル。区間の一覧・テロップの一覧・設定を入れる
 * (`.claude/specs/2026-09-24-side-panel-design.md`)。
 *
 * **枠 (見出し・折り畳み・中身の箱) だけを持つ。** 何を入れるか、いつ出すかは知らない。
 * 出すかの理由 (中身が無い / 全画面 / 動画ページ以外) は youtube.ts の 1 箇所で決める。
 * ここにも理由を持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる
 */

export const SIDE_PANEL_ID = "yt-clip-panel";
export const SIDE_PANEL_BODY_ID = `${SIDE_PANEL_ID}-body`;

/*
 * 位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: spec §1 の想定値 (YouTube の通常のレイアウト)。実測は `npm run check:telop` の
 * 「パネルの位置の出所 (YouTube の実測)」で残し、ここに書き写す
 */
/** YouTube のヘッダー (#masthead-container) の高さ */
const MASTHEAD_HEIGHT_PX = 56;
/** ヘッダーとの間 */
const TOP_GAP_PX = 12;
/** 画面の右端・下端との間 */
const EDGE_GAP_PX = 16;
/** おすすめ動画の列 (#secondary、402px 前後) の上に収まる幅 */
const WIDTH_PX = 400;
/** YouTube のヘッダーのメニュー類より下、ページ本体より上 */
const Z_INDEX = 2000;

export type SidePanel = {
  element: HTMLElement;
  /** 中身の箱。区間の一覧・テロップの一覧・設定パネルをこの順に入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 全画面 / 動画ページ以外、の
   * どれかなら隠す)。パネルは理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 畳んでいれば開く (設定を開いた・区間やテロップを足したとき) */
  reveal(): void;
  /** 本体の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
};

export function createSidePanel(): SidePanel {
  const top = MASTHEAD_HEIGHT_PX + TOP_GAP_PX;
  const element = document.createElement("div");
  element.id = SIDE_PANEL_ID;
  // 高さは中身に合わせ、最大で画面の下端から EDGE_GAP_PX まで。超えた分は本体だけが
  // スクロールする (body の overflow-y)
  element.style.cssText = `${SIDE_PANEL_STYLE.root}position:fixed;top:${top}px;right:${EDGE_GAP_PX}px;width:${WIDTH_PX}px;max-height:calc(100vh - ${top + EDGE_GAP_PX}px);z-index:${Z_INDEX};`;

  const header = document.createElement("div");
  header.style.cssText = SIDE_PANEL_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = SIDE_PANEL_STYLE.title;
  title.textContent = "yt-clip";
  const collapseButton = document.createElement("button");
  collapseButton.dataset.role = "collapse";
  collapseButton.style.cssText = SIDE_PANEL_STYLE.collapseButton;
  header.append(title, collapseButton);

  const body = document.createElement("div");
  body.id = SIDE_PANEL_BODY_ID;
  body.style.cssText = SIDE_PANEL_STYLE.body;

  element.append(header, body);

  /**
   * 畳んでいるか。**タブを開いている間だけ覚える** (保存しない)。保存すると
   * 「パネルが出ない」という相談の原因になりやすく、得るものが小さい
   */
  let collapsed = false;

  /**
   * 出し入れは `hidden` と `style.display` の両方で行う。**`hidden` だけに頼らない。**
   * 根と本体は flex で並べるので display を持つ。inline の display は UA の
   * `[hidden] { display: none }` に勝ち、`hidden` を立てても出たままになる。
   * `hidden` は外から「出ているか / 畳んでいるか」を読むために残す
   */
  function show(target: HTMLElement, visible: boolean): void {
    target.hidden = !visible;
    target.style.display = visible ? "flex" : "none";
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    show(body, !next);
    // 畳むと右へ引っ込む向き (▶)、開くと左へ出てくる向き (◀)
    collapseButton.textContent = next ? "◀" : "▶";
    collapseButton.title = next ? "開く" : "畳む";
    collapseButton.setAttribute("aria-expanded", next ? "false" : "true");
  }

  collapseButton.addEventListener("click", () => setCollapsed(!collapsed));
  setCollapsed(false);
  // 中身が入るまでは出さない。空の枠だけを出さない
  show(element, false);

  return {
    element,
    body,

    setVisible(visible): void {
      show(element, visible);
    },

    reveal(): void {
      if (collapsed) setCollapsed(false);
    },

    scrollTo(target): void {
      // 本体の外 (まだ入れていない・別の場所へ移った) なら送る先が無い
      if (!body.contains(target)) return;
      // **offsetTop ではなく画面上の位置の差で測る。** テロップの行は一覧の中の
      // 入れ子なので、offsetTop の基準の祖先が本体とずれる。
      // **scrollIntoView は使わない。** ページまで動かして動画の位置がずれうる
      const view = body.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      // 既に全部見えていれば動かさない。見ている位置が勝手に跳ねない
      if (rect.top >= view.top && rect.bottom <= view.bottom) return;
      body.scrollTop += rect.top - view.top;
    },

    destroy(): void {
      element.remove();
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/side-panel.test.ts` (Bash の timeout 600000)
期待: PASS (16 件)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/side-panel.ts tests/content/side-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 右側に固定するパネルの枠を作る

区間・テロップ・設定を入れる先。枠は見出し・折り畳み・中身の箱だけを
持ち、何をいつ出すかは知らない (理由を 2 箇所に持つと食い違う)。
中身の中だけを送る計算は画面上の位置の差で行う。テロップの行は入れ子で
offsetTop の基準がずれ、scrollIntoView はページまで動かしてしまう。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: 一覧と設定をパネルへ移し、出し入れを 1 箇所で決める

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `createSidePanel` / `SidePanel` / `SIDE_PANEL_ID` / `SIDE_PANEL_BODY_ID` (Task 3)、`applyPalette` の `--ytc-panel` (Task 2)
- Produces (youtube.ts の中の関数。Task 5 が使う):
  - `const sidePanel: SidePanel` (モジュールに 1 つ)
  - `let settingsPanel: SettingsPanel | null`
  - `function listedItems(): { segments: ClipRange[]; telops: Telop[] }`
  - `function refreshLists(): void` (一覧を描き直し、`refreshSidePanel()` を呼ぶ)
  - `function refreshSidePanel(): void` (`setVisible` を呼ぶ唯一の場所)
  - `function onToggleSettings(): void`
- Produces (テストの helper。Task 5 が使う): `rectAt(top, height): DOMRect` / `panelElement(): HTMLElement` / `panelBody(): HTMLElement` / `barElement(): HTMLElement` / `collapseButton(): HTMLButtonElement` / `settingsRoot(): HTMLElement`

- [ ] **Step 1: テストの helper と beforeEach の後始末を足す**

`tests/content/youtube.test.ts` の `handleLabels()` (452〜456 行目付近) の直後に次を足す。

```typescript
/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 右側のパネル。body の直下に 1 つだけある */
function panelElement(): HTMLElement {
  const element = document.getElementById("yt-clip-panel");
  if (element === null) throw new Error("パネルが見つかりません");
  return element;
}

/** パネルの中身の箱。一覧と設定はここに入る */
function panelBody(): HTMLElement {
  const element = document.getElementById("yt-clip-panel-body");
  if (element === null) throw new Error("パネルの本体が見つかりません");
  return element;
}

/** プレイヤー直下のバー */
function barElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar");
  if (element === null) throw new Error("バーが見つかりません");
  return element;
}

function collapseButton(): HTMLButtonElement {
  const button = panelElement().querySelector<HTMLButtonElement>(
    "[data-role='collapse']",
  );
  if (button === null) throw new Error("折り畳みボタンがありません");
  return button;
}

/** 設定パネルの根。最初の項目 (モード) の入力欄 → 項目の枠 → 根 */
function settingsRoot(): HTMLElement {
  const root = document.getElementById("yt-clip-setting-mode")?.parentElement
    ?.parentElement;
  if (root == null) throw new Error("設定パネルが見つかりません");
  return root;
}
```

同じファイルの `beforeEach` の中、`document.body.append(document.createElement("div"));` と続く `await flush();` (535〜536 行目付近) の**直後**に次を足す。

```typescript
  // パネルはタブを開いている間 1 つを使い回す (畳んだ状態を覚えるため)。
  // 前のテストで畳んだまま・送ったままにしない
  const collapse = document.querySelector<HTMLButtonElement>(
    "#yt-clip-panel [data-role='collapse']",
  );
  if (collapse?.getAttribute("aria-expanded") === "false") collapse.click();
  const panelBodyElement = document.getElementById("yt-clip-panel-body");
  if (panelBodyElement !== null) panelBodyElement.scrollTop = 0;
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に次を足す。

```typescript
describe("右側のパネル", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  async function showEdit(telops: Telop[] = []): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops, meta: META_A });
    await flush();
  }

  test("body を作り直しても、パネルを body の直下に付け直す", async () => {
    // buildPage は body を空にする。付け直さないと、以降はパネルが DOM に無く
    // 一覧も設定も操作できない
    buildPage();
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelElement().parentElement).toBe(document.body);
    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
  });

  test("一覧と設定はパネルに入り、バーには拡大バーと操作の行だけが残る", async () => {
    await showEdit([TELOP]);

    const body = panelBody();
    // 区間の一覧 → テロップの一覧 → 設定の順
    expect(body.children.length).toBe(3);
    expect(body.children[0]?.querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(body.children[1]?.querySelector("[data-role='add-telop']")).not.toBeNull();
    expect(body.children[1]?.querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(body.children[2]).toBe(settingsRoot());

    const bar = barElement();
    expect(bar.querySelector("[data-role='segment']")).toBeNull();
    expect(bar.querySelector("[data-role='add-telop']")).toBeNull();
    expect(bar.querySelector("#yt-clip-setting-mode")).toBeNull();
    // 並びは今のまま: 拡大バー → 操作の行
    expect(bar.children.length).toBe(2);
    expect(bar.firstElementChild?.id).toBe("yt-clip-range");
    expect(
      bar.lastElementChild?.contains(document.getElementById("yt-clip-bar-status")),
    ).toBe(true);
  });

  test("エディットで区間があるとパネルを出す", async () => {
    await showEdit();
    expect(panelElement().hidden).toBe(false);
  });

  test("エディットでも区間が 0 個で設定を閉じていれば出さない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    expect(panelElement().hidden).toBe(true);
  });

  test("シンプルでは ⚙ で設定を開いている間だけ出す", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(panelElement().hidden).toBe(true);

    clickButton("⚙");
    expect(panelElement().hidden).toBe(false);
    expect(settingsRoot().hidden).toBe(false);
    expect(panelBody().contains(settingsRoot())).toBe(true);

    clickButton("⚙");
    expect(settingsRoot().hidden).toBe(true);
    expect(panelElement().hidden).toBe(true);
  });

  test("畳んでいても ⚙ で設定を開くとパネルが開く", async () => {
    await showEdit();
    collapseButton().click();
    expect(panelBody().hidden).toBe(true);
    // 見出しは残る
    expect(panelElement().hidden).toBe(false);

    clickButton("⚙");

    expect(panelBody().hidden).toBe(false);
    expect(settingsRoot().hidden).toBe(false);
  });

  test("隠れて畳まれたパネルでも、⚙ で出して開いてから設定の先頭へ送る", () => {
    // シンプルで設定を閉じている (パネルは隠れている) うえに畳んである
    collapseButton().click();
    const body = panelBody();
    const target = settingsRoot();
    // 隠れている間は寸法が 0 になる実機の振る舞いを写す。出す → 開く → 送る
    // の順が崩れると、0 同士で測って送らない
    const shown = (): boolean =>
      !panelElement().hidden && !body.hidden && !target.hidden;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return shown() ? rectAt(100, 400) : rectAt(0, 0);
        if (this === target) return shown() ? rectAt(900, 300) : rectAt(0, 0);
        return rectAt(0, 0);
      });
    try {
      clickButton("⚙");

      expect(panelElement().hidden).toBe(false);
      expect(body.hidden).toBe(false);
      // 設定の先頭を本体の上端に揃える: 900 - 100
      expect(body.scrollTop).toBe(800);
    } finally {
      spy.mockRestore();
    }
  });

  test("⚙ で閉じるときは送らない", async () => {
    await showEdit();
    const body = panelBody();
    const target = settingsRoot();
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return rectAt(100, 400);
        if (this === target) return rectAt(900, 300);
        return rectAt(0, 0);
      });
    try {
      clickButton("⚙");
      expect(body.scrollTop).toBe(800);

      body.scrollTop = 0;
      clickButton("⚙");
      expect(body.scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("モードを変えてバーを作り直しても、一覧と設定が 2 重にならない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    changeSettings({ mode: "simple" });
    await flush();
    changeSettings({ mode: "edit" });
    await flush();

    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
    expect(panelBody().children.length).toBe(3);
    expect(document.querySelectorAll("[data-role='add-telop']").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-setting-mode").length).toBe(1);

    // 入っているのは今の一覧。状態が届けば行が出る
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
  });

  test("バーを作り直しても、手元の区間で一覧を描き直す", async () => {
    await showEdit([TELOP]);

    // YouTube の再描画でバーが外れた場面。次の状態通知を待たずに一覧を戻す
    barElement().remove();
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(panelBody().querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(panelElement().hidden).toBe(false);
  });

  test("全画面の間はパネルを隠し、抜けたら戻す", async () => {
    await showEdit();
    expect(panelElement().hidden).toBe(false);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(panelElement().hidden).toBe(true);

      // 全画面の間に状態が届いても出さない
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(panelElement().hidden).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(panelElement().hidden).toBe(false);
  });

  test("別の動画へ移ると一覧を空にしてパネルを隠す。戻れば出す", async () => {
    await showEdit([TELOP]);
    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);

    // 固定のパネルでは、動画 B の画面に A の区間が出続けると目立つ
    history.pushState({}, "", "/watch?v=video-b");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(0);
    expect(panelBody().querySelectorAll("[data-role='telop']").length).toBe(0);
    expect(panelElement().hidden).toBe(true);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(panelElement().hidden).toBe(false);
  });

  test("動画ページ以外ではパネルを出さない", async () => {
    clickButton("⚙");
    expect(panelElement().hidden).toBe(false);

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();

    expect(panelElement().hidden).toBe(true);
  });

  test("テーマを切り替えるとパネルの配色も変わる", async () => {
    // パネルは body の直下でバーの外にある。バーの配色は継がれない
    document.documentElement.setAttribute("dark", "");
    try {
      await flush();
      expect(panelElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
    } finally {
      document.documentElement.removeAttribute("dark");
    }
    await flush();
    expect(panelElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 600000)
期待: FAIL。`パネルが見つかりません` (まだパネルを作っていない) で「右側のパネル」の各テストが落ちる。既存のテストは通る

- [ ] **Step 4: import とモジュールの状態を足す**

`src/content/youtube.ts` の 24 行目付近

```typescript
import { createSettingsPanel } from "@/content/settings-panel";
```

を次に置き換える。

```typescript
import { createSettingsPanel, type SettingsPanel } from "@/content/settings-panel";
```

34 行目付近の `import { createSegmentList, type SegmentList } from "@/content/segment-list";` の**次の行**に次を足す。

```typescript
import { createSidePanel } from "@/content/side-panel";
```

110〜111 行目付近

```typescript
/** プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため) */
const telopPreview = createTelopPreview();
```

の**直後**に次を足す。

```typescript
/**
 * 右側のパネル。区間の一覧・テロップの一覧・設定を入れる。
 *
 * **1 つを使い回す。** 畳んだ状態はタブを開いている間だけ覚える (spec §3) ので、
 * バーを作り直すたびに作り直さない。中身の入れ替えは `buildBar`、body への
 * 付け直しは `mount`、出すかの判定は `refreshSidePanel` が行う
 */
const sidePanel = createSidePanel();
// パネルは body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
applyPalette(sidePanel.element, isDarkTheme());
/** 設定パネル。⚙ の開閉と、パネルを出すかの判定の両方が読む。`buildBar` が作る */
let settingsPanel: SettingsPanel | null = null;
```

- [ ] **Step 5: 一覧の描き直しとパネルの出し入れを 1 箇所にまとめる**

`src/content/youtube.ts` の `renderActions` の閉じ (831 行目付近の `}`) と、続く `function applyStateToDisplay(state: ClipState): void {` (833 行目付近) の**間**に次を足す。

```typescript
/**
 * 一覧に出す区間とテロップ。**エディットモードで、範囲を作った動画を見ているときだけ。**
 *
 * シンプルで使っている人に、関係のない概念を見せない。別の動画の区間は出さない
 * (帯・プレビューと同じ規則)。固定のパネルに出すので、SPA で動画 B へ移ったのに
 * 動画 A の区間が出続けると目立つ (spec §4)
 */
function listedItems(): { segments: ClipRange[]; telops: Telop[] } {
  if (mode !== "edit" || rangeVideoId !== currentVideoId()) {
    return { segments: [], telops: [] };
  }
  return { segments: currentSegments, telops: currentTelops };
}

/**
 * パネルを出すか隠すかを決める。**`setVisible` を呼ぶのはここだけ** (spec §4)。
 *
 * 隠すのは、中身が無い / 全画面 / 動画ページ以外、のどれか。中身があるかは
 * 各部品の `hidden` で見る (一覧は区間が無いと自分で隠れ、設定は ⚙ で開閉する)
 */
function refreshSidePanel(): void {
  const parts = [segmentList?.element, telopList?.element, settingsPanel?.element];
  const hasContent = parts.some((part) => part !== undefined && !part.hidden);
  // **`!= null` にする。** jsdom は fullscreenElement を持たず undefined を返すので、
  // `!== null` だとテストで常に全画面扱いになる。body 直下の fixed 要素は全画面の
  // 動画の上に残りうるので、全画面では出さない
  const fullscreen = document.fullscreenElement != null;
  const onVideoPage = currentVideoId() !== null;
  sidePanel.setVisible(hasContent && !fullscreen && onVideoPage);
}

/**
 * 一覧を手元の写しに合わせて描き直し、パネルを出すかを決め直す。
 * 状態の通知・バーの作り直し (`mount`)・SPA 遷移の 3 箇所から呼ぶ
 */
function refreshLists(): void {
  const { segments, telops } = listedItems();
  segmentList?.setEnabled(!busy);
  segmentList?.update(segments, selectedIndex, maxClipSec);
  telopList?.setEnabled(canEditTelops());
  telopList?.update(telops, segments);
  refreshSidePanel();
}
```

`applyStateToDisplay` の中の 922〜934 行目付近

```typescript
  // 一覧はエディットモードでだけ出す。シンプルで使っている人に、関係のない
  // 概念を見せない
  segmentList?.setEnabled(!busy);
  segmentList?.update(
    mode === "edit" ? currentSegments : [],
    selectedIndex,
    maxClipSec,
  );
  telopList?.setEnabled(canEditTelops());
  telopList?.update(
    mode === "edit" ? currentTelops : [],
    mode === "edit" ? currentSegments : [],
  );
```

を次に置き換える (直前の「拡大バーを描き直すのは、表示がずれているときだけにする。…」の 4 行のコメントは末尾の拡大バーの描き直しの説明なので、そのまま残す)。

```typescript
  refreshLists();
```

- [ ] **Step 6: ⚙ で設定をパネルに開く**

`src/content/youtube.ts` の `readChannelContext` の閉じ (1304 行目付近の `}`) と `function buildBar(): HTMLElement {` (1306 行目付近) の**間**に次を足す。

```typescript
/**
 * ⚙。設定をパネルに開閉する。**開いたら畳みを解き、設定の先頭まで送る** (spec §3)。
 * 設定は一覧の下に入るので、区間とテロップが多いと押しても見えないところで開く。
 *
 * **出す → 開く → 送る の順を崩さない。** 隠れていた・畳んでいたパネルは寸法が 0 で、
 * 先に送っても scrollTop が効かない (シンプルモードで ⚙ を押す経路で効く)
 */
function onToggleSettings(): void {
  if (settingsPanel === null) return;
  settingsPanel.toggle();
  refreshSidePanel();
  if (settingsPanel.element.hidden) return;
  sidePanel.reveal();
  sidePanel.scrollTo(settingsPanel.element);
}
```

`buildBar` の中の ⚙ (Task 2 で直した後の形。1340 行目付近)

```typescript
  const settingsPanel = createSettingsPanel({ getContext: readChannelContext });
  // 状態の文言 (flex:1) が残りの幅を取るので、⚙ は右端に来る。操作の並びから
  // 外して、押し間違いを減らす
  const settingsButton = makeButton("⚙", false, () => settingsPanel.toggle());
  settingsButton.title = "設定";
```

を次に置き換える。

```typescript
  const settings = createSettingsPanel({ getContext: readChannelContext });
  settingsPanel = settings;
  // 状態の文言 (flex:1) が残りの幅を取るので、⚙ は右端に来る。操作の並びから
  // 外して、押し間違いを減らす
  const settingsButton = makeButton("⚙", false, onToggleSettings);
  settingsButton.title = "設定";
```

`buildBar` の末尾 (1395〜1404 行目付近)

```typescript
  // 一覧を上、拡大バー、操作の順。区間を選んでからバーで調整する流れに合わせる
  bar.append(
    segmentList.element,
    telopList.element,
    rangeBar.element,
    row,
    settingsPanel.element,
  );
  return bar;
}
```

を次に置き換える。

```typescript
  // バーは拡大バー → 操作の行だけ。拡大バーは幅がそのまま精度になるので、
  // プレイヤー直下に残す (spec §1)
  bar.append(rangeBar.element, row);
  // 一覧と設定は右側のパネルへ。**中身ごと入れ替える。** 足すだけにすると、
  // バーを作り直すたびに古い一覧が残って 2 重になる
  sidePanel.body.replaceChildren(
    segmentList.element,
    telopList.element,
    settings.element,
  );
  return bar;
}
```

- [ ] **Step 7: `mount` でパネルを付け直し、一覧を描き直す**

`src/content/youtube.ts` の `mount` の先頭 (1426〜1427 行目付近)

```typescript
function mount(): void {
  if (document.getElementById(BAR_ID) !== null) return;
```

を次に置き換える。

```typescript
function mount(): void {
  // パネルは body の直下に置く (#below の中だと YouTube の再描画でバーと一緒に外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられるとパネルだけが外れる
  if (sidePanel.element.parentElement !== document.body) {
    document.body.append(sidePanel.element);
  }
  if (document.getElementById(BAR_ID) !== null) return;
```

同じ `mount` の末尾 (1462〜1464 行目付近)

```typescript
  refreshOverlay();
  refreshTelopPreview();
}
```

を次に置き換える。

```typescript
  refreshOverlay();
  refreshTelopPreview();
  // 作り直した一覧は空で隠れている。次の状態通知を待たずに手元の写しで描き直し、
  // パネルの表示も決め直す
  refreshLists();
}
```

- [ ] **Step 8: テーマ・全画面・SPA 遷移に追従する**

`src/content/youtube.ts` の `themeObserver` (1602〜1605 行目付近)

```typescript
const themeObserver = new MutationObserver(() => {
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, isDarkTheme());
});
```

を次に置き換える。

```typescript
const themeObserver = new MutationObserver(() => {
  const dark = isDarkTheme();
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // パネルは body の直下でバーの外にある。バーの配色は継がれない
  applyPalette(sidePanel.element, dark);
});
```

同じファイルの `themeObserver.observe(...)` の呼び出し (1606〜1609 行目付近) の**直後**に次を足す。

```typescript

// 全画面の間はパネルを隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
document.addEventListener("fullscreenchange", refreshSidePanel);
```

`observer` の href の分岐 (1612〜1621 行目付近)

```typescript
    rangeBar?.setEnabled(canAdjustRange());
    refreshOverlay();
    refreshTelopPreview();
  }
  mount();
```

を次に置き換える。

```typescript
    rangeBar?.setEnabled(canAdjustRange());
    refreshOverlay();
    refreshTelopPreview();
    // 一覧も同じ規則で描き直す。固定のパネルに A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、パネルごと隠れる (refreshSidePanel)
    refreshLists();
  }
  mount();
```

- [ ] **Step 9: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 600000)
期待: PASS。「右側のパネル」の 14 件と既存のテストすべて

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 10: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 区間・テロップ・設定を右側のパネルへ移す

プレイヤー直下には拡大バーと操作の行だけを残し、増えるほど伸びる
一覧と設定をパネルに入れる。出すかの理由 (中身が無い・全画面・動画
ページ以外) は 1 箇所で決める。固定のパネルでは別の動画の区間が
出続けると目立つので、SPA 遷移とバーの作り直しでも一覧を描き直す。
⚙ で開いた設定は、畳んでいても開いてから先頭まで送る。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: 区間・テロップを足したら、応答を描いた後に足した行へ送る

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `sidePanel` / `refreshLists()` (Task 4)、テストの helper `rectAt` / `panelBody` / `collapseButton` (Task 4)
- Produces:
  - `let revealLastTelopOnNextState = false` (`selectLastOnNextState` と同じ形)
  - `function revealLastRow(list: HTMLElement | undefined, role: "segment" | "telop"): void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に次を足す。

```typescript
describe("足した行をパネルの見える範囲に入れる", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  /**
   * 本体は画面の 100〜500px。行は並び順に 900px から 100px ずつ下に置く。
   * 末尾の行が選ばれたかを送り先の値で見分けられる
   */
  function placeRows(role: "segment" | "telop") {
    const body = panelBody();
    return vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return rectAt(100, 400);
        if (this instanceof HTMLElement && this.dataset.role === role) {
          const index =
            this.parentElement === null
              ? 0
              : [...this.parentElement.children].indexOf(this);
          return rectAt(900 + index * 100, 60);
        }
        return rectAt(0, 0);
      });
  }

  function addTelopButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-role='add-telop']");
    if (button === null) throw new Error("＋ テロップがありません");
    return button;
  }

  test("区間を足したら、畳んでいても開いて末尾の行へ送る", async () => {
    const first: ClipRange = { startSec: 83, endSec: 98 };
    const added: ClipRange = { startSec: 300, endSec: 315 };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [first], telops: [], meta: META_A });
    await flush();
    const spy = placeRows("segment");
    try {
      collapseButton().click();
      video.element.currentTime = 300;
      clickButton("＋ 区間を追加");
      await flush();
      // 押した時点では行がまだ無い。送るのは状態機械の答えを描いた後
      expect(panelBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });

      expect(panelBody().hidden).toBe(false);
      // 末尾 (2 行目: 1000px) の先頭を本体の上端 (100px) に揃える
      expect(panelBody().scrollTop).toBe(900);

      // 送るのは足した直後の 1 回だけ。見ている位置を勝手に戻さない
      panelBody().scrollTop = 0;
      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("テロップを足したら、畳んでいても開いて末尾の行へ送る", async () => {
    const added: Telop = { startSec: 15, endSec: 18, text: "" };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [TELOP], meta: META_A });
    await flush();
    const spy = placeRows("telop");
    try {
      collapseButton().click();
      video.element.currentTime = 15;
      await flush();
      addTelopButton().click();
      await flush();
      expect(panelBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });

      expect(panelBody().hidden).toBe(false);
      expect(panelBody().scrollTop).toBe(900);

      panelBody().scrollTop = 0;
      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("足していない状態の通知では送らない", async () => {
    changeSettings({ mode: "edit" });
    const spy = placeRows("segment");
    try {
      emit({
        kind: "ready",
        segments: [RANGE, { startSec: 30, endSec: 40 }],
        telops: [],
        meta: META_A,
      });
      await flush();
      expect(panelBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts -t "足した行をパネルの見える範囲に入れる"` (Bash の timeout 600000)
期待: FAIL。区間とテロップの 2 件で `scrollTop` が `0` のまま (`expected 0 to be 900`)、`panelBody().hidden` が `true` のまま。3 件目は通る

- [ ] **Step 3: テロップ用のフラグを足す**

`src/content/youtube.ts` の `selectLastOnNextState` の宣言 (134 行目付近の `let selectLastOnNextState = false;`) の**直後**に次を足す。

```typescript
/**
 * 次に状態が届いたとき、テロップの一覧の末尾の行をパネルの見える範囲に入れる。
 *
 * `selectLastOnNextState` と同じ形。**クリックの時点では行がまだ無い** (状態機械の
 * 答えを待って描く) ので、応答を描いた後に 1 回だけ送る
 */
let revealLastTelopOnNextState = false;
```

`onAddTelop` の末尾 (486 行目付近)

```typescript
  send({ type: "ADD_TELOP", telop: { startSec, endSec, text: "" } });
}
```

を次に置き換える。

```typescript
  // 足した行をパネルの見える範囲に入れる。畳んでいても開く (spec §3)
  revealLastTelopOnNextState = true;
  send({ type: "ADD_TELOP", telop: { startSec, endSec, text: "" } });
}
```

- [ ] **Step 4: 行へ送る関数を足す**

`src/content/youtube.ts` の `refreshLists` (Task 4 で足した) の閉じの `}` の**直後**に次を足す。

```typescript
/**
 * 足した行をパネルの見える範囲に入れる。**応答を描いた後に呼ぶ** (クリックの時点では
 * 行がまだ無い)。畳んでいても開く。押した結果が見えないと無反応に見える (spec §3)。
 *
 * パネルが隠れている (全画面など) ときは何もしない。出す判断は `refreshSidePanel` のもの
 */
function revealLastRow(
  list: HTMLElement | undefined,
  role: "segment" | "telop",
): void {
  if (list === undefined || sidePanel.element.hidden) return;
  const rows = list.querySelectorAll<HTMLElement>(`[data-role='${role}']`);
  const last = rows[rows.length - 1];
  if (last === undefined) return;
  sidePanel.reveal();
  sidePanel.scrollTo(last);
}
```

- [ ] **Step 5: `applyStateToDisplay` で描いた後に送る**

`src/content/youtube.ts` の `applyStateToDisplay` の中 (894〜895 行目付近)

```typescript
  selectLastOnNextState = false;
  removedIndexOnNextState = null;
```

を次に置き換える。

```typescript
  // 足した直後の 1 回だけ、足した行へ送る。描き終えてから送るので、ここでは覚えるだけ
  const revealSegment = selectLastOnNextState;
  const revealTelop = revealLastTelopOnNextState;
  selectLastOnNextState = false;
  revealLastTelopOnNextState = false;
  removedIndexOnNextState = null;
```

同じ `applyStateToDisplay` の中の、Task 4 で置いた 1 行

```typescript
  refreshLists();
```

を次に置き換える。

```typescript
  refreshLists();
  // 一覧とパネルの表示が決まってから送る (出す → 開く → 送る の順)
  if (revealSegment) revealLastRow(segmentList?.element, "segment");
  if (revealTelop) revealLastRow(telopList?.element, "telop");
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 600000)
期待: PASS (「足した行をパネルの見える範囲に入れる」の 3 件と既存のテストすべて)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 区間やテロップを足したら、パネルの中で足した行へ送る

一覧が長いと、足した行はパネルの下に隠れて押しても無反応に見える。
行は状態機械の答えを待って描くので、クリックの時点ではまだ無い。
区間の選択と同じく「足した直後の 1 回だけ」のフラグを置き、応答を
描いた後に畳みを解いて末尾の行へ送る。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: E2E のセレクタをパネルへ変え、受け入れ条件の確認を足す

**Files:**
- Modify: `e2e/telop-check.spec.ts`

**Interfaces:**
- Consumes: `#yt-clip-panel` / `#yt-clip-panel-body` (Task 3)、⚙ で設定を開くと設定の先頭へ送る (Task 4)
- Produces: `npm run check:telop` の結果 (`test-results/telop-check/results.json`) に 2 項目が増える
  - `パネルの位置の出所 (YouTube の実測)` — Task 8 が `side-panel.ts` のコメントに書き写す
  - `受け入れ条件 1440x795: バーとパネルが画面に収まり、パネルの中でスクロールする` と `test-results/telop-check/layout-1440x795.png`

**このタスクの実装担当は `npm run check:telop` を走らせない。** 実機 (Google Chrome の起動と YouTube) で 10 分以上かかるので、Task 8 で controller が走らせて結果を見る。ここでは型が通るところまで。

`e2e/smoke.spec.ts` は変更しない (「既存テストの洗い出し」参照)。

- [ ] **Step 1: 受け入れ確認で足す区間の頭を定数にする**

`e2e/telop-check.spec.ts` の `SEGMENTS` の定義 (42〜45 行目付近) の**直後**に次を足す。

```typescript
/**
 * 受け入れ条件の確認 (1440x795) で足す 5 区間の頭。既定の長さ (15 秒) で重ならない
 * よう 30 秒ずつ離す。合計は上限 (60 秒) を超えるが、録画はしないので構わない
 */
const LAYOUT_SEGMENT_STARTS = [200, 230, 260, 290, 320];
```

- [ ] **Step 2: 一覧と ＋ テロップをパネルから探す**

370〜371 行目付近

```typescript
  const segmentRows = bar.locator("[data-role=segment]");
  const telopRows = bar.locator("[data-role=telop]");
```

を次に置き換える。

```typescript
  // 一覧と設定は右側のパネルにある。バーには拡大バーと操作の行だけ
  const panel = page.locator("#yt-clip-panel");
  const segmentRows = panel.locator("[data-role=segment]");
  const telopRows = panel.locator("[data-role=telop]");
```

`addTelops` の中 (491 行目付近) と「テロップが残っているとき最後の区間の ✕ が止まる」の中 (781 行目付近) の 2 箇所の

```typescript
      await bar.locator("[data-role=add-telop]").click();
```

```typescript
    await bar.locator("[data-role=add-telop]").click();
```

を、それぞれ字下げを保ったまま `bar` を `panel` に替える (`await panel.locator("[data-role=add-telop]").click();`)。

- [ ] **Step 3: シンプルモードの確認を空振りしない形にする**

796〜801 行目付近

```typescript
  await check("シンプルモードでテロップの一覧が出ない", async () => {
    await writeSettings({ mode: "simple" });
    await expect(bar.locator("[data-role=add-telop]")).toBeHidden({ timeout: 10_000 });
    const visible = await bar.locator("[data-role=add-telop]").isVisible();
    record("シンプルモードでテロップの一覧が出ない", !visible, { addTelopVisible: visible });
  });
```

を次に置き換える。

```typescript
  await check("シンプルモードでテロップの一覧が出ない", async () => {
    await writeSettings({ mode: "simple" });
    const addTelop = panel.locator("[data-role=add-telop]");
    // **有ることを先に確かめる。** toBeHidden は見つからない要素でも通るので、
    // 探す場所を間違えていても素通りしてしまう
    await expect(addTelop).toHaveCount(1, { timeout: 10_000 });
    await expect(addTelop).toBeHidden({ timeout: 10_000 });
    const count = await addTelop.count();
    const visible = await addTelop.isVisible();
    record("シンプルモードでテロップの一覧が出ない", count === 1 && !visible, {
      addTelopCount: count,
      addTelopVisible: visible,
    });
  });
```

- [ ] **Step 4: パネルの位置の出所を実測する項目を足す**

「テロップが残っているとき最後の区間の ✕ が止まる」の `check(...)` の閉じ (793 行目付近の `});`) の**直後**、`// --- シンプルモードでは一覧が出ない ---` のコメントの**前**に次を足す。この時点はエディットモードで区間が 1 つあり、パネルが出ている。

```typescript
  // --- パネルの位置の出所 (spec §1: 実機の値を確かめて side-panel.ts に書く) ------
  await check("パネルの位置の出所 (YouTube の実測)", async () => {
    const measured = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const b = element.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const zIndex = (selector: string) => {
        const element = document.querySelector(selector);
        return element === null ? null : getComputedStyle(element).zIndex;
      };
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        masthead: box("#masthead-container"),
        mastheadZIndex: zIndex("#masthead-container"),
        secondary: box("#secondary"),
        popupContainerZIndex: zIndex("ytd-popup-container"),
        panel: box("#yt-clip-panel"),
        panelZIndex: zIndex("#yt-clip-panel"),
      };
    });
    // 値そのものは人が読んで side-panel.ts のコメントに書き写す。ここでは読めたかだけ見る
    record(
      "パネルの位置の出所 (YouTube の実測)",
      measured.masthead !== null && measured.secondary !== null && measured.panel !== null,
      measured,
    );
  });
```

- [ ] **Step 5: 受け入れ条件の確認を足す**

「シンプルモードでテロップの一覧が出ない」の `check(...)` (Step 3 で置き換えたもの) の閉じの `});` の**直後**、`await writeResults();` (803 行目付近) の**前**に次を足す。

```typescript
  // --- 受け入れ条件 (spec の冒頭): 1440x795 でバーが画面に収まり、一覧はパネルの中で届く ---
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  await check(
    "受け入れ条件 1440x795: バーとパネルが画面に収まり、パネルの中でスクロールする",
    async () => {
      await page.setViewportSize({ width: 1440, height: 795 });
      try {
        // 直前の項目でシンプルに切り替えたので、区間とテロップは消えている
        await writeSettings({ mode: "edit" });
        await expect(button("＋ 区間を追加")).toBeVisible({ timeout: 10_000 });
        for (const [i, startSec] of LAYOUT_SEGMENT_STARTS.entries()) {
          await seekPaused(startSec);
          await button("＋ 区間を追加").click();
          await expect(segmentRows).toHaveCount(i + 1);
        }
        for (const [i, startSec] of LAYOUT_SEGMENT_STARTS.entries()) {
          await seekPaused(startSec + 1);
          await panel.locator("[data-role=add-telop]").click();
          await expect(telopRows).toHaveCount(i + 1);
        }
        // 設定も開く。開くと必ず溢れるので、パネルの中でのスクロールを確実に見られる
        await button("⚙").click();
        await expect(page.locator("#yt-clip-setting-mode")).toBeVisible();

        // 「スクロールせずに操作できる」かを測るので、ページは先頭に戻す
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
        const measured = await page.evaluate(() => {
          const rect = (id: string) => {
            const element = document.getElementById(id);
            if (element === null) throw new Error(`#${id} がありません`);
            const b = element.getBoundingClientRect();
            return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
          };
          const body = document.getElementById("yt-clip-panel-body");
          if (body === null) throw new Error("#yt-clip-panel-body がありません");
          const player = document.getElementById("movie_player")?.getBoundingClientRect();
          return {
            innerHeight: window.innerHeight,
            scrollY: window.scrollY,
            bar: rect("yt-clip-bar"),
            panel: rect("yt-clip-panel"),
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            // 合否には入れない。パネルが動画やバーに重なっていないかを人が見る材料
            playerRight: player?.right ?? null,
          };
        });
        const file = join(OUT_DIR, "layout-1440x795.png");
        await page.screenshot({ path: file });
        record(
          "受け入れ条件 1440x795: バーとパネルが画面に収まり、パネルの中でスクロールする",
          measured.scrollY === 0 &&
            measured.bar.bottom <= measured.innerHeight &&
            measured.panel.bottom <= measured.innerHeight &&
            measured.bodyScrollHeight > measured.bodyClientHeight,
          { ...measured, file },
        );
      } finally {
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
    },
  );
```

- [ ] **Step 6: 型を確かめる**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`e2e/` も `tsconfig.json` の include に入っている。単体テストは変わらない)

実行: `npx playwright test e2e/telop-check.spec.ts --list` (Bash の timeout 120000)
期待: `テロップの実機確認` が 1 件列挙される (構文と import が壊れていない。環境変数が無いので実行はされない)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): 一覧をパネルから探し、1440x795 の受け入れ条件を測る

一覧と ＋ テロップはバーからパネルへ移った。シンプルモードの確認は
toBeHidden だけだと見つからない要素でも通るので、有ることを先に見る。
依頼の核 (ノート PC の画面でバーがスクロールせずに収まる) を数値で
確かめる項目と、パネルの位置の元にした YouTube の値の実測を足す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: 掲載画像 (2-settings.png) をパネルに合わせて撮る

**Files:**
- Modify: `scripts/screenshots.mjs` (96〜121 行目付近)

**Interfaces:**
- Consumes: `#yt-clip-panel` / `#yt-clip-panel-body` (Task 3)、設定パネルの最初の項目 `#yt-clip-setting-mode`
- Produces: `npm run screenshots` が `release/screenshots/2-settings.png` をパネルの中を設定の先頭まで送った状態で撮る

**このタスクの実装担当は `npm run screenshots` を走らせない** (Chromium を起動して YouTube を開く)。Task 8 で controller が走らせて画像を見る。

- [ ] **Step 1: 設定の枠取りを差し替える**

`scripts/screenshots.mjs` の 96〜121 行目付近 (`frameWholeBar` の定義から 2-settings.png を撮るところまで)

```javascript
  /**
   * バー全体 (開いているパネルも含む) が画面に収まるよう送る。
   *
   * **上端ではなく下端を基準にする。** 設定項目が増えるとパネルは下へ伸びるので、
   * 上端を固定していると新しい項目が画面外へこぼれる (モードを足したときに
   * 「最大秒数」が切れた)
   */
  const frameWholeBar = async (bottomMarginPx) => {
    await page.evaluate((margin) => {
      const element = document.getElementById("yt-clip-bar");
      if (element === null) throw new Error("バーが見つかりません");
      const bottom = element.getBoundingClientRect().bottom + window.scrollY;
      window.scrollTo({
        top: bottom - window.innerHeight + margin,
        behavior: "instant",
      });
    }, bottomMarginPx);
    // スクロール後の再描画を待つ
    await page.waitForTimeout(500);
  };

  // 設定パネルを開く。パネルのぶん背が伸びるので枠取りを取り直す
  await bar.getByRole("button", { name: "⚙" }).click();
  await frameWholeBar(24);
  await page.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
```

を次に置き換える (`} finally {` 以降は変えない)。

```javascript
  // 設定を開く。**設定は右側の固定のパネルに開き、ページのスクロールでは動かない。**
  // 枠取りは 1-range と同じ (プレイヤーとバーが下寄り) にして、パネルの中を設定の
  // 先頭まで送って撮る。1280x800 ではパネルの最大高さ (716px) に 8 項目と保存ボタンが
  // 収まらず末尾は切れるが、それでよい。パネルの中でスクロールすることが見て分かる
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-panel")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  await page.evaluate(() => {
    const body = document.getElementById("yt-clip-panel-body");
    // 設定パネルの根は、最初の項目 (モード) の入力欄 → 項目の枠 → 根
    const settings = document.getElementById("yt-clip-setting-mode")?.parentElement
      ?.parentElement;
    if (body === null || settings == null) {
      throw new Error("パネルか設定が見つかりません");
    }
    // 拡張も ⚙ で送っているが、掲載画像の絵をここで確定させる (拡張の振る舞いが
    // 変わっても、撮れる絵が変わらないように)
    body.scrollTop +=
      settings.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await framePlayerAndBar(0.72);
  await page.screenshot({ path: `${OUT_DIR}/2-settings.png` });
  console.log(`${OUT_DIR}/2-settings.png`);
```

- [ ] **Step 2: 構文を確かめる**

実行: `node --check /Users/trapple/repos/github.com/trapple/yt-clip/scripts/screenshots.mjs` (Bash の timeout 60000)
期待: 何も出力せず終了コード 0

- [ ] **Step 3: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add scripts/screenshots.mjs
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
fix(screenshots): 設定の掲載画像をパネルの中で送って撮る

設定は右側の固定のパネルに移り、ページを送っても動かない。バーの
下端を基準にした枠取りは意味を失ったので、プレイヤーとバーの枠取りは
1 枚目と揃え、パネルの中を設定の先頭まで送って撮る。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 8: 実機で確かめ、実測値をコメントに書き写す (controller が実行)

**Files:**
- Modify: `src/content/side-panel.ts` (位置と寸法の出所のコメント。値が違えば定数も)
- Modify: `tests/content/side-panel.test.ts` (定数を変えたときだけ)
- Modify: `docs/manual-check.md` (「## 確認した環境」)

**実行者: controller (メインセッション)。** 実機 (Google Chrome / 同梱の Chromium と YouTube) を使い、結果の画像を見て判断するため subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜7 のすべて
- Produces: 実測に基づく `side-panel.ts` のコメント、`test-results/telop-check/` の結果、`release/screenshots/` の掲載画像

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる (後に走らせると check:telop の結果が消える)。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: 通常の E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout 180 秒がある)
期待: `拡張がロードされ service worker が起動する` / `YouTube の再生画面に IN/OUT UI が注入される` / `IN を指定するとページ内で録画を始められる` が PASS。`テロップの実機確認` は skip。落ちたら README の「E2E が失敗したときの切り分け」に沿って `test-results/` の trace を見る

- [ ] **Step 3: `npm run check:telop` を走らせる**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分かかりうるので Bash の timeout 600000 では足りない。テスト自身が `test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` に 17 項目 (既存 15 + `パネルの位置の出所 (YouTube の実測)` + `受け入れ条件 1440x795: …`) があり、すべて `pass: true`

- [ ] **Step 4: 画像を見て判定する**

Read で次を見る。

- `test-results/telop-check/layout-1440x795.png` — バー (拡大バー・IN / OUT / 録画) が画面内に全部見えている。右側のパネルに区間・テロップの一覧と、設定の先頭が見えていて、パネルの中にスクロールバーがある。`results.json` の `playerRight` とパネルの `left` を比べ、パネルが動画に重なっていないか
- `test-results/telop-check/preview-theater-t1.png` — シアターモードではパネルが動画の右側に重なる (仕様)。テロップのプレビューがパネルに隠れていない
- 既存の画像 (`preview-*-t*.png` と `frame-*-t*.png` の見た目の一致) が前回と同じ見た目

**1440x795 でパネルが動画やバーに重なっていたら、spec の前提 (「動画は隠れない」) が崩れている。** 直さずに spec の `## 自律判断ログ` に `- [実機] 1440x795 でパネルが動画に N px 重なる (playerRight=…, panel.left=…)` と 1 行書き、最終報告でユーザーに伝える。

- [ ] **Step 5: 実測値を `side-panel.ts` のコメントに書き写す**

`test-results/telop-check/results.json` の `パネルの位置の出所 (YouTube の実測)` の `values` を読み、`src/content/side-panel.ts` の

```typescript
/*
 * 位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: spec §1 の想定値 (YouTube の通常のレイアウト)。実測は `npm run check:telop` の
 * 「パネルの位置の出所 (YouTube の実測)」で残し、ここに書き写す
 */
```

を、読んだ値で次の形に置き換える (`<…>` は results.json の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。

```typescript
/*
 * 位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: <JST の日付> に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ <masthead.height>px・z-index <mastheadZIndex>、
 * #secondary の幅 <secondary.width>px、ytd-popup-container の z-index <popupContainerZIndex>。
 * YouTube のレイアウトが変わったら測り直す
 */
```

値が spec の想定と違ったとき:

- `masthead.height` が 56 でない → `MASTHEAD_HEIGHT_PX` を実測値にし、`tests/content/side-panel.test.ts` の `expect(target.element.style.top).toBe("68px");` の値とコメント「ヘッダー 56px の下 12px」を合わせる
- `secondary.width` が 400 未満 → 幅は変えない (spec の決定)。spec の `## 自律判断ログ` に `- [実機] #secondary の幅 <値>px。パネル (400px) がおすすめ列からはみ出す` と書き、最終報告で伝える
- `mastheadZIndex` / `popupContainerZIndex` が数値で 2000 以下 → ヘッダーのメニューがパネルの下に潜る。`Z_INDEX` は変えずに自律判断ログに書き、最終報告で伝える (`auto` は数値の比較をしない)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の段落の末尾 (「**それ以外の節は今回は確かめていない**。」の後) に、空行を 1 つ挟んで次を足す (`<…>` は実際の値。日付は JST)。

```markdown
<JST の日付> は右側のパネルを `npm run check:telop` で確かめた (17 項目すべて通過。1440x795 で区間 5・テロップ 5・
設定を開いた状態の画面は `test-results/telop-check/layout-1440x795.png`)。「見た目」節のパネルの項目のうち、
全画面・テーマの切り替え・ホームへの移動は単体テストでだけ確かめている。
```

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/side-panel.ts tests/content/side-panel.test.ts docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: パネルの位置の元にした YouTube の値を実測で書き留める

ヘッダーの高さ・おすすめ列の幅・メニューの重なり順は YouTube 側の
値で、変わるとパネルがずれる。想定のまま置かず、実機で測った値と
測り方をコメントに残す。受け入れ条件 (1440x795) を実機で通したことも
確認した環境に記録する。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

`tests/content/side-panel.test.ts` を変えていなければ、`git add` から外す。

- [ ] **Step 8: 掲載画像を撮って見る**

実行: `npm run screenshots` (Bash の timeout 600000。スクリプト側にも起動 60 秒・遷移 60 秒・待ち 30 秒の上限がある)
期待: `release/screenshots/1-range.png` と `release/screenshots/2-settings.png` が出力される

Read で 2 枚を見る。1-range.png は右側のパネルが出ていない (シンプルで設定を閉じている)。2-settings.png は右側のパネルに設定の先頭 (モード) が見え、末尾が切れていてパネルの中にスクロールバーがある。プレイヤーとバーも写っている。`release/` は `.gitignore` の対象なので commit しない。

---

## 完了の条件

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke が通る
- `npm run check:telop` の 17 項目がすべて通り、`layout-1440x795.png` でバーが画面に収まりパネルの中でスクロールしていることを controller が目で確かめた (Task 8)
- `side-panel.ts` の位置と寸法のコメントに、実測の値と出所が書いてある
- `release/screenshots/2-settings.png` がパネルの中を設定の先頭まで送った絵になっている
- whole-branch の cross-review (保守担当 + 攻撃者視点、別の Claude モデル) が Approved
- branch `feat/side-panel` 上の commit で止める。push / PR はユーザーの指示を待つ
