# フロートの窓 (spec の A) 実装プラン

> **実装者向け:** このプランは subagent-driven-development で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 右側パネルとプレイヤー直下のバー (拡大バー + 操作の行) を、画面の上に浮いた窓にする。
掴む場所 (パネルは見出し、バーは操作の行の左端のつまみ ⠿) をドラッグして動かし、右下の角で大きさを変え、
動かした位置と大きさを `chrome.storage.local` に覚える。

**Architecture:** 新しいモジュールを 2 つ足す。`src/content/window-layout.ts` は位置の保存・読み込み・検証と、
画面に詰める計算 (純粋関数) を持つ。`src/content/floating-window.ts` は窓の枠 (見出し・本体の箱・右下のつまみ・
ドラッグ・画面に詰める・重なり順) だけを持ち、中身と「いつ出すか・最初にどこへ置くか」は知らない。
`side-panel.ts` はこの枠の上に作り直し (`SidePanel` の API は変えず、枠を `frame` として足す)、`youtube.ts` は
バーの窓を 1 つ作って使い回し、出し入れ・最初の位置・覚えた位置・取り直しを配線する。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-24-floating-windows-design.md` (以下「spec」)。**この plan は spec の「A. フロートの窓」だけ。**
「B. 拡大バー上のテロップ」と、A.4 の「B を入れた後も、帯の段が最大 (2 段 + 「+N」) の状態で同じ条件を満たす」は
A の実装後に書く別の plan の範囲。

## Global Constraints

### Spec 由来 (spec から逐語コピー)

A.1 の表 (spec 20〜23 行目):

| 窓 | 中身 | 見出し | 大きさを変えられる向き |
|---|---|---|---|
| バーの窓 | 拡大バー + 操作ボタンの行 (今 `#below` の先頭にあるもの) | **見出しの行は作らない**。操作の行の左端につまみ (⠿) を置き、それを掴んで動かす | **幅だけ**。高さは中身で決まる (拡大バーは幅がそのまま精度)。右下のつまみのカーソルは `ew-resize` |
| パネルの窓 | 区間・テロップの一覧と設定 (今の右側パネル) | 「yt-clip」+ 折り畳み (今と同じ) | 幅と高さ。中身は窓の中でスクロール (今と同じ) |

- **パネルの窓は見出しの空いたところ、バーの窓は左端のつまみ**を押してドラッグすると窓が動く。見出しの中のボタン (折り畳みなど) を押したときは動かさない
- **右下の角** (16px 四方のつまみ) を押してドラッグすると大きさが変わる
- 最小の大きさ: バーの窓は幅 480px。パネルの窓は幅 280px・高さ 160px。最大は画面の大きさまで
- 窓は画面の外へ出さない。動かしたとき・大きさを変えたとき・ブラウザの大きさが変わったときに、**掴む場所 (パネルは見出し、バーはつまみ) の全体が画面の中に残る**よう位置を詰める (見失わない)
- 2 つの窓が重なったときは、最後に触った窓を上にする (z-index 2000 / 2001)
- 全画面の間は 2 つとも隠す (パネルの今の規則をバーにも広げる)
- 動画ページ以外では 2 つとも隠す
- **バーの窓の最初の位置**: プレイヤーの直下 (今と同じ見た目)。左端とプレイヤーの左端を揃え、幅はプレイヤーの幅、上端はプレイヤーの下端 + 8px。画面に収まらなければ画面の下端から 16px に詰める (このときだけプレイヤーに重なりうる。受け入れ条件の 1440x795 では重ならないこと)
- **パネルの窓の最初の位置**: 今の右側パネルと同じ (右 16px・上 68px・幅 400px・高さは中身まで、最大で画面の下 16px まで)
- **覚えた位置の読み込み (非同期) が済むまで、2 つの窓は出さない。** 最初の位置に出してから覚えた位置へ跳ぶ絵にしない
- **動かした位置と大きさは覚える** (`chrome.storage.local` の `windowLayout` キー。窓ごとに `{ left, top, width, height? }`)。端末ごとの見た目の好みなので `sync` にはしない。読み込み時に型と範囲を確かめ、合わなければ最初の位置に戻して `console.warn` を残す (既存の設定の読み込みと同じ作法)。**覚えた位置も画面に収まるよう詰めてから使う** (大きい画面で覚えた位置を小さい画面で開いたとき)
- 一度も動かしていない窓は、**`window` の `resize` と、プレイヤー (`#movie_player`) の大きさの変化 (ResizeObserver) のとき**に最初の位置を取り直す (シアターモードの切り替えなど)。**ページのスクロールでは取り直さない** (フロートなので、コメント欄を読む間も同じ画面位置に浮いたまま)。取り直す時点でページがスクロールされていても、プレイヤーの画面上の位置をそのまま使い、見出し (バーはつまみ) が画面に残るよう詰める
- **動かした窓は、ユーザーが置いた場所から動かさない** (画面の大きさが変わって外へ出るときだけ詰める)
- **掴む場所 (パネルは見出し、バーはつまみ ⠿) をダブルクリック**すると、その窓を最初の位置に戻す (覚えた位置も消す)。窓を思わぬ場所に置いてしまったときの戻し方
- **覚えた位置の読み込みが失敗 (reject) したら**、`console.warn` を残して最初の位置で出す (出さないままにしない)
- 新しいモジュール `src/content/floating-window.ts`: 窓の枠 (見出し・本体・右下のつまみ・ドラッグ・大きさ・画面内に詰める・重なり順) だけを持つ。中身と「いつ出すか」は知らない。API は spec A.3 の `WindowRect` / `FloatingWindow` (`element` / `headerActions` / `addDragHandle` / `body` / `setVisible` / `place` / `rect` / `destroy`) / `FloatingWindowOptions` (`id` / `title?` / `resize: "width" | "both"` / `minWidth` / `minHeight?` / `onUserMove(rect)` / `onResetRequest()`) / `createFloatingWindow(options)`
- ドラッグは Pointer Events (`pointerdown` + `setPointerCapture` + `pointermove` + `pointerup`)。`pointercancel` でも終える
- **2 つの窓はどちらも 1 つを作って使い回す** (右側パネルと同じ)。`buildBar` は窓の `body` の中身だけを入れ替える。`mount()` は今と同じく `#yt-clip-bar` (窓の中の中身の根) の有無で中身の作り直しを判断する。モードを変えても窓は作り直さないので、位置は変わらない
- 窓の枠は、掴む場所を外から登録できるようにする (`addDragHandle(element)`)。パネルの窓は見出し、バーの窓は操作の行のつまみを登録する。**つまみは `buildBar` が作り直す操作の行の中にあるので、`buildBar` のたびに登録し直す** (古い要素は中身ごと捨てる)。登録した要素のダブルクリックで `onResetRequest` を呼ぶ
- 右側パネル (`side-panel.ts`) はこの窓の上に作り直す。今の `SidePanel` の API (`setVisible` / `reveal` / `scrollTo` / `destroy` / `element` / `body`) は変えない。折り畳み (▶ / ◀) は見出しの右側 (`headerActions`) に置く
- バーの窓は新しく `youtube.ts` で作る。今の `buildBar` が作る中身 (拡大バー + 操作の行) を窓の本体に入れる。`#below` にはもう何も置かない (**`mount()` の「動画ページのページができたか」の目印としては `#below` を見続ける**)
- 位置と大きさの保存・読み込みは `src/content/window-layout.ts` に置く (`loadWindowLayout()` / `saveWindowRect(id, rect)` / `clearWindowRect(id)`。検証は純粋関数に切り出してテストする)
- 既存の拡大バー・一覧・設定パネルの中身は変えない
- **受け入れ条件 (A.4、B の部分を除く):** 1440x795 で、最初の位置のまま、エディットモードで区間 5 つ・テロップ 5 つ・設定を開いた状態で: バーの窓 (**窓の枠の外形。中身の根ではない**) が**プレイヤーの下端より下にあり (重ならない)**、下端が画面に収まる (`playerBottom ≤ bar.top` かつ `bar.bottom ≤ innerHeight`) / パネルの窓が画面に収まり、パネルの中身は窓の中でスクロールする / 掴む場所 (パネルは見出し、バーはつまみ) をドラッグすると窓が動き、ページを読み込み直しても同じ位置に出る / 右下をドラッグすると大きさが変わる (バーの窓は幅だけ) / 窓を画面の外へドラッグしても、掴む場所 (パネルは見出し、バーはつまみ) が画面に残る
- テスト (spec「テスト」節の A の項目): `floating-window.ts` の単体 (jsdom): 掴む場所 (`addDragHandle` で登録した要素。見出しのある窓と無い窓の両方) のドラッグで動く / 掴む場所の中のボタンでは動かない / 右下で大きさが変わる (幅だけの窓は高さが変わらない) / 最小の大きさ / 画面の外へ出しても掴む場所が残る / 最後に触った窓が上 / ダブルクリックで onResetRequest / 指を離したときに 1 回だけ onUserMove。`getBoundingClientRect` と `innerWidth` / `innerHeight` は stub。`window-layout.ts` の単体: 型違い・範囲外・欠落を捨てて warn / 画面に収まるよう詰める。`youtube.test.ts` (`chrome.storage.local` の stub を setup に足す。今は sync / session だけ): バーの窓とパネルの窓ができる / 覚えた位置を読み込むまで窓を出さない / モードを変えても窓を作り直さない (位置が変わらない) / スクロールでは最初の位置を取り直さない / `#below` に何も置かない / 全画面で 2 つとも隠れる / 覚えた位置で出る。`e2e/telop-check.spec.ts`: 受け入れ条件 (A.4 の 1440x795、窓を動かして読み込み直す) を足す。実機の確認は controller が行う。`scripts/screenshots.mjs`: バーが窓になったので 1-range.png / 2-settings.png の枠取りを見直す
- ドキュメント (spec「ドキュメント」節の A の部分): README の使い方・仕様と制約 (窓を動かせる・大きさを変えられる・**バーは幅だけ**・位置を覚える・ダブルクリックで戻す)、`docs/manual-check.md`、`docs/store-release.md` の掲載文とスクリーンショットの説明、`docs/privacy-policy.md` (**`chrome.storage.local` に窓の位置を置くので、保存するものの表に足し、「求めている権限」の `storage` の説明にも足し、最終更新の日付を改める**)、CHANGELOG

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定 (`~/.claude/CLAUDE.md`) と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 1 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C /Users/trapple/repos/github.com/trapple/yt-clip ...` を使う
- 外部プロセスを起動して待つ処理には必ず timeout を付ける。**この macOS には `timeout` コマンドが無い**。Bash ツールの `timeout` 引数 (最大 600000) か、スクリプト側の timeout で止める
- 小さく検証してから全件: 対象の単体テスト 1 ファイル → `npm run typecheck && npm test` → `npm run e2e` (smoke) → `npm run check:telop` の順に広げる
- 日付を書くときは JST (`TZ=Asia/Tokyo date +%F`) であることを明示する
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 握りつぶすなら「なぜ握りつぶしてよいか」をコメントで説明する。※ 局所例外: `loadWindowLayout()` は `chrome.storage.local` の読み込みの失敗を warn して空を返す (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で出す」。窓を出さないままにしないため)。Task 2 のコードにも理由をコメントで残す
- テストは `npm test` (vitest)、型は `npm run typecheck`。**各タスクの commit 前に両方を通す** (リポジトリの根 `/Users/trapple/repos/github.com/trapple/yt-clip` で `npm run typecheck && npm test`、Bash の timeout 600000)
- コマンドはリポジトリの根で実行する (実装担当のセッションの作業ディレクトリ)。`npx vitest run <file>` は Bash の timeout 120000 を付ける

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch 名 `feat/floating-windows` (`feat/side-panel` から分岐済み。spec は `79b6925` で commit 済み)
- 並列: SDD (1 タスクごとに新しい実装担当 + レビュー)。**同じファイルを触るタスクは依存順に 1 つずつ走らせる** (`src/content/styles.ts` と `tests/content/styles.test.ts` は Task 3・4・5、`src/content/youtube.ts` と `tests/content/youtube.test.ts` は Task 5・6)
- Task 9 は **controller (メインセッション) が実行する**。実機 (Google Chrome の起動・YouTube) を使う確認と、その結果を見て書くドキュメントの更新を含むため
- 終点: branch `feat/floating-windows` 上の commit まで。push / PR はユーザーの指示を待つ

## ファイルの構造

| ファイル | 責務 | タスク |
|---|---|---|
| `src/content/window-layout.ts` (新規) | 型 `WindowRect` / `WindowId` / `WindowLayout` / `Viewport` / `GripBox`、覚えた位置の検証 (`mergeWindowLayout`)、画面に詰める (`fitRect`)、バーの最初の位置 (`initialBarRect`)、`chrome.storage.local` への保存・読み込み | 2 |
| `src/content/floating-window.ts` (新規) | 窓の枠。見出し・本体の箱・右下のつまみ・ドラッグ・画面に詰める・重なり順 | 3 |
| `src/content/styles.ts` | `FLOATING_WINDOW_STYLE` を足す (3)、`SIDE_PANEL_STYLE` から枠の見た目を外す (4)、`BAR_STYLE.root` から縁を外し `BAR_STYLE.grip` を足す (5) | 3・4・5 |
| `src/content/side-panel.ts` | 窓の枠の上に作り直す。`initialPanelRect` を足す | 4 |
| `src/content/youtube.ts` | バーの窓・出し入れ・覚えた位置・最初の位置 (5)、取り直すきっかけ (6) | 5・6 |
| `src/content/selectors.ts` | `mountAnchor` のコメントだけ (目印としてだけ見る) | 5 |
| `e2e/telop-check.spec.ts` | 受け入れ条件と窓の操作の確認 | 7 |
| `scripts/screenshots.mjs` | 枠取り | 8 |

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (window-layout.ts) ─→ Task 3 (floating-window.ts + FLOATING_WINDOW_STYLE)
Task 3 ─→ Task 4 (side-panel.ts を窓の上に) ─→ Task 5 (youtube.ts: バーの窓と配線) ─→ Task 6 (取り直すきっかけ)
Task 6 ─→ Task 7 (E2E) ─→ Task 9 (controller: 実機で確かめる)
Task 6 ─→ Task 8 (掲載画像の枠取り) ─→ Task 9
```

## 既存テストの洗い出し (grep の結果。Task 4〜8 の前提)

`grep -n '#below\|below\|yt-clip-bar' tests/content/youtube.test.ts e2e/*.ts scripts/screenshots.mjs` の結果:

- `tests/content/youtube.test.ts`: `#below` を作っているのは `buildPage()` (200〜201 行目付近の `below.id = "below";`) だけで、**バーを `#below` の中から探しているテストは無い**。バーは id で `document` 全体から探している: `clickButton()` (426 行目付近 `"#yt-clip-bar button"`)・`statusText()` (435 行目付近)・`barElement()` (489 行目付近)・`describe("状態ごとの操作")` / `describe("録画の中止")` の `"#yt-clip-bar-actions button"` (937・964・990 行目付近)・`describe("設定")` の `settingsButton()` (1020 行目付近)・`describe("状態の文言")` (1050・1056 行目付近)・`describe("エディットモード")` の `buttonLabels()` (1179 行目付近)。**窓の中に移っても `document` から見つかるので、どれも変えない。** つまみ (⠿) は `span` なので `button` を数えるテスト (`buttonLabels()` など) には入らない
- ただし **`buildPage()` が body を空にしても、バーは作り直されなくなる** (バーは body 直下の窓の中にあり、`mount()` が窓ごと付け直すので中身が残る)。以前は `#below` と一緒に消えて `beforeEach` のたびに作り直されていた。前のテストの状態の文言・設定の開閉を持ち越さないよう、Task 5 で `beforeEach` と「作り直されたバーにも設定した上限が効く」(1144 行目付近) の `buildPage()` の前に `#yt-clip-bar` を外す行を足す。**検査は弱めない** (作り直しを起こしてから確かめる、という元の意図に戻すための変更)
- `describe("右側のパネル")` は `#yt-clip-panel` (パネルの窓の枠になる) と `#yt-clip-panel-body` (窓の本体になる) を id で探し、`panelElement().parentElement` が body であることを見ている。窓の枠の id を `yt-clip-panel` にするので変えない
- `tests/content/side-panel.test.ts` の「画面の右端に固定し、ページ本体より上に重ねる」(76〜84 行目付近) は `style.right === "16px"` を見ている。窓は `left` で置くので、Task 4 で `style.left` が `${window.innerWidth - 416}px` であること (右端から 16px と同じ意味) に書き換える。ほかの検査 (`position` / `top` / `width` / `zIndex`) はそのまま残す
- `tests/content/styles.test.ts` の `SIDE_PANEL_STYLE.root` の検査 (112・122 行目付近) は、枠の見た目が `FLOATING_WINDOW_STYLE.root` へ移るので、Task 3 で同じ検査を `FLOATING_WINDOW_STYLE.root` に足し、Task 4 で `SIDE_PANEL_STYLE.root` の方を外す
- `e2e/telop-check.spec.ts`: `const bar = page.locator("#yt-clip-bar")` (366 行目付近) はボタンを探すのに使っていて、窓の中でも見つかるので変えない。受け入れ条件の測定 `bar: rect("yt-clip-bar")` (889 行目付近) は**中身の根を測っている**ので、Task 7 で窓の枠 `yt-clip-bar-window` に替える (spec A.4「窓の枠の外形。中身の根ではない」)
- `e2e/smoke.spec.ts`: `#yt-clip-bar` が見えること (48・60 行目付近) と IN / OUT / 状態の文言だけ。覚えた位置の読み込みが済むと窓が出るので、`toBeVisible` の待ちで足りる。**変更不要**
- `scripts/screenshots.mjs`: `framePlayerAndBar` (81〜90 行目付近) がページを送ってバーを画面の下寄りに置いている。**バーの窓はスクロールに付いてこない**ので、Task 8 で書き換える

---

### Task 1: ドキュメントを先に直す (A の範囲だけ)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual-check.md`
- Modify: `docs/store-release.md`
- Modify: `docs/privacy-policy.md`

**Interfaces:**
- Consumes: なし
- Produces: なし (ドキュメントのみ)

グローバル規約「ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する」に従う。
**B (拡大バー上のテロップの帯) の文言は書かない** (B の plan で足す)。`docs/manual-check.md` の「## 確認した環境」は
実機で確かめた後に Task 9 で書く。

- [ ] **Step 1: README の「使い方」に窓の説明を足す**

`README.md` の 18 行目付近

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で右側のパネルに開く。
```

の**直後**に、空行を 1 つ挟んで次を挿入する (その後の空行と「投稿ボタンは自動では押さない。」は残す)。

```markdown
IN / OUT・録画のボタンと拡大バー (以下「バー」) と右側のパネルは、画面の上に浮いた窓に出る。
バーは操作の行の左端の **⠿**、パネルは見出しを掴んでドラッグすると、好きな場所へ動かせる。
右下の角をドラッグすると大きさが変わる (バーは幅だけ)。動かした位置と大きさは、次に開いたときも
同じになる。**⠿ や見出しをダブルクリックすると最初の位置 (バーはプレイヤーの直下、パネルは画面の右上) に戻る。**
```

- [ ] **Step 2: README のエディットモードの段落を窓に合わせる**

`README.md` の 37〜40 行目付近

```markdown
区間とテロップの一覧は、画面右側のパネルに出る。IN / OUT・録画のボタンと拡大バーは
プレイヤー直下に残るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったらパネルの中でスクロールする。パネルは見出しの **▶** で畳める
(見出しの 1 行だけが残る。**◀** で開く)。
```

を次に置き換える。

```markdown
区間とテロップの一覧は、画面右側のパネルに出る。IN / OUT・録画のボタンと拡大バーは
最初はプレイヤーの直下に浮いて出るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったらパネルの中でスクロールする。パネルは見出しの **▶** で畳める
(見出しの 1 行だけが残る。**◀** で開く)。
```

- [ ] **Step 3: README の「操作の置き場所」を窓に合わせる**

`README.md` の 142〜144 行目付近

```markdown
- **区間・テロップ・設定は画面右側のパネルに出る**。IN / OUT・録画と拡大バーはプレイヤー直下に
  残す (拡大バーは幅がそのまま精度になるため、パネルの幅には縮めない)。パネルはおすすめ動画の列の
  上に重ねるので、通常の表示では動画を隠さない
```

を次に置き換える。

```markdown
- **区間・テロップ・設定は画面右側のパネルに出る**。IN / OUT・録画と拡大バーは、最初はプレイヤーの直下に
  浮いた窓に出る (拡大バーは幅がそのまま精度になるため、パネルの幅には縮めない)。パネルは最初はおすすめ
  動画の列の上に重ねるので、通常の表示では動画を隠さない
```

同じ節の 151 行目付近

```markdown
- **全画面の間はパネルを出さない**
```

を次に置き換える。

```markdown
- **全画面の間と、動画の再生画面以外では、バーもパネルも出さない**
```

同じ節の最後の項目 (152 行目付近)

```markdown
- **状態の文言は 1 行に収める**。長い文言は末尾が「…」で省略され、マウスを乗せると全文が出る
```

の**直後** (`## 開発` の前の空行より前) に次を足す。

```markdown
- **バーとパネルは動かせる窓**。パネルは見出し、バーは操作の行の左端の ⠿ を掴んで動かし、右下の角で
  大きさを変える。**バーは幅だけ変えられる** (高さは中身で決まる。拡大バーは幅がそのまま精度になる)。
  最小はバーが幅 480px、パネルが幅 280px・高さ 160px。最大は画面の大きさまで。バーに見出しの行を
  付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を覆うため
- **動かした位置と大きさは端末ごとに覚える** (`chrome.storage.local`。Chrome の同期で他の端末へは運ばない。
  画面の大きさと置き場所の好みは端末ごとに違うため)。**掴む場所 (⠿ / 見出し) をダブルクリックすると最初の
  位置に戻り、覚えた位置も消える**
- **窓は見失わない**。画面の外へドラッグしても、ブラウザを小さくしても、掴む場所 (バーは ⠿、パネルは見出し) は
  画面の中に残る。大きい画面で覚えた位置を小さい画面で開いたときも同じ
- **動かしていない窓は、ブラウザの大きさやプレイヤーの大きさ (シアターモードの切り替えなど) が変わると最初の
  位置を取り直す**。ページをスクロールしても窓は同じ画面位置に浮いたまま (コメント欄を読む間も操作できる)。
  動かした窓は置いた場所から動かない
- **画面の高さが足りないとき、バーは画面の下端 (から 16px) に寄せて出す**。そのときだけプレイヤーの下端に重なる
- **2 つの窓が重なったときは、最後に触った窓が上に出る**
```

- [ ] **Step 4: README の E2E の切り分け表と設計の一覧を直す**

`README.md` の 183 行目付近

```markdown
| `#yt-clip-bar` が出ない | `YT_SELECTORS.mountAnchor` (プレイヤー直下の `#below`) が YouTube の DOM 変更で不一致 |
```

を次に置き換える。

```markdown
| `#yt-clip-bar` が出ない | `YT_SELECTORS.mountAnchor` (`#below`。バーはもうここには置かないが、動画ページができたかの目印に見ている) が YouTube の DOM 変更で不一致 |
```

同じファイルの 204 行目付近

```markdown
- [`.claude/specs/2026-09-23-edit-mode-segments-design.md`](.claude/specs/2026-09-23-edit-mode-segments-design.md) — エディットモードと複数区間の結合
```

の**直後**に次の 1 行を足す。

```markdown
- [`.claude/specs/2026-09-24-floating-windows-design.md`](.claude/specs/2026-09-24-floating-windows-design.md) — バーとパネルを動かせる窓にする
```

- [ ] **Step 5: CHANGELOG の「未リリース」に足す**

`CHANGELOG.md` の「## 未リリース」の 2 つ目の段落

```markdown
**区間・テロップ・設定を画面右側のパネルに移した。** 区間やテロップが増えても、プレイヤー直下の
IN / OUT・録画と拡大バーはページをスクロールせずに操作できる。パネルは見出しで畳める。
```

の**直後**に、空行を 1 つ挟んで次を足す。

```markdown
**バーとパネルを動かせる窓にした。** パネルは見出し、バーは左端の ⠿ を掴んで好きな場所へ動かせる。
右下の角で大きさも変えられる (バーは幅だけ)。位置と大きさは端末ごとに覚え、掴む場所をダブルクリック
すると最初の位置に戻る。
```

- [ ] **Step 6: 手動確認のチェックリストを直す**

`docs/manual-check.md` の「## 見た目」の 360 行目付近

```markdown
- [ ] 右側のパネルが、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
```

を次に置き換える。

```markdown
- [ ] 動かしていない右側のパネルが、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
```

366 行目付近

```markdown
- [ ] 全画面の間はパネルが出ず、全画面を抜けると戻る
```

を次に置き換える。

```markdown
- [ ] 全画面の間はバーの窓もパネルも出ず、全画面を抜けると戻る
```

368 行目付近

```markdown
- [ ] 別の動画へ移ると、パネルの一覧に前の動画の区間が残らない。ホームへ移るとパネルが消える
```

を次に置き換え、その**直後** (`## popup` の前の空行より前) に続けて窓の項目を足す。

```markdown
- [ ] 別の動画へ移ると、パネルの一覧に前の動画の区間が残らない。ホームへ移るとバーの窓もパネルも消える
- [ ] 最初のバーの窓は、プレイヤーの直下 (左端を揃え、幅はプレイヤーの幅、8px 空けて) に出る。読み込んだ直後に別の場所から跳んでこない
- [ ] バーの窓は操作の行の左端の ⠿、パネルは見出しの空いたところを掴むと動く。パネルの ▶ を押しても窓は動かない
- [ ] 右下の角をドラッグすると大きさが変わる。バーは幅だけ (480px より狭くならない)、パネルは幅と高さ (280x160 より小さくならない)
- [ ] 窓を画面の外へドラッグしても、⠿ と見出しは画面に残る。ブラウザの窓を小さくしても同じ
- [ ] 動かしてからページを読み込み直すと、同じ位置と大きさで出る。別のタブで同じ動画を開いても同じ
- [ ] ⠿ と見出しをダブルクリックすると最初の位置に戻る。読み込み直しても最初の位置のまま
- [ ] 動かしていない窓は、シアターモードの切り替えやブラウザの大きさの変更でプレイヤーに付いてくる。ページをスクロールしても窓は動かない
- [ ] 動かした窓は、シアターモードを切り替えても置いた場所から動かない
- [ ] 2 つの窓を重ねると、最後に触った方が上に出る。YouTube のヘッダーのメニューは窓より上に出る
- [ ] バーの窓の地が不透明で、下のページが透けない (ダーク・ライトの両方。テーマを切り替えると追従する)
```

- [ ] **Step 7: ストアの掲載文・権限の説明・スクリーンショットの説明を直す**

`docs/store-release.md` の説明文 (コードブロックの中) の 65 行目付近

```
5. 開いた投稿画面で内容を確認し、自分で投稿する
```

の**直後**に、空行を 1 つ挟んで次を足す (その後の空行と「■ 複数の場面を繋ぐ (エディットモード)」は残す)。

```
操作のバーと右側のパネルは画面の上に浮いた窓です。バーは左端の ⠿、パネルは見出しを掴んで
好きな場所へ動かせ、右下の角で大きさも変えられます (バーは幅だけ)。位置は端末ごとに覚え、
掴む場所をダブルクリックすると最初の位置に戻ります。
```

「### `storage`」の節の 125 行目付近

```markdown
> テロップの見た目 (文字サイズ・フォント・色) を保存する (`chrome.storage.sync`)。
```

の**直後**に次の 1 行を足す。

```markdown
> 操作のバーと右側のパネル (画面に浮いた窓) の位置と大きさを端末ごとに保存する (`chrome.storage.local`)。
```

「### データの取り扱い (Privacy practices)」の

```markdown
- 設定は利用者の Google アカウントに同期されるだけで、開発者を含む第三者には送られない
```

の**直後**に次の 1 行を足す。

```markdown
- 窓の位置と大きさは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

「## 4. スクリーンショット」の 165〜166 行目付近

```markdown
1. `1-range.png` — 再生画面の下に出た操作バーと拡大バー (IN/OUT を置いた状態)。
   シンプルモードで設定を閉じているので、右側のパネルは出ていない
```

を次に置き換える。

```markdown
1. `1-range.png` — プレイヤーの直下に浮いたバーの窓 (拡大バーと IN/OUT などの操作の行。IN を置いた状態)。
   シンプルモードで設定を閉じているので、右側のパネルは出ていない
```

同じ節の

```markdown
1-range.png とプレイヤーの幅が違って見えるのはこのため。
```

の**直後**に、空行を 1 つ挟んで次の段落を足す。

```markdown
**バーの窓はページのスクロールに付いてこない** (画面に浮いたまま)。そのため `scripts/screenshots.mjs` は
ページを送って枠取りを決めた後に `resize` を配り、動かしていないバーの窓に最初の位置 (プレイヤーの直下) を
取り直させてから撮る。
```

- [ ] **Step 8: プライバシーポリシーに窓の位置を足す**

日付は JST で決める: `TZ=Asia/Tokyo date +%F` (Bash の timeout 10000) の出力を `<JST の日付>` とする
(この plan を書いた時点では `2026-09-24`)。

`docs/privacy-policy.md` の 3 行目

```markdown
最終更新: 2026-09-12
```

を `最終更新: <JST の日付>` に置き換える。

「## 端末の中に置くもの」の表の 19 行目

```markdown
| 設定 (投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数、モード、テロップの見た目) | `chrome.storage.sync` | 拡張を削除したとき |
```

の**直後**に次の行を足す。

```markdown
| 窓 (操作のバーと右側のパネル) の位置と大きさ | `chrome.storage.local` | 拡張を削除したとき |
```

同じ節の最後の段落

```markdown
`chrome.storage.sync` に置いた設定は、利用者が Chrome の同期を有効にしている
場合に限り、**利用者自身の Google アカウント**を通じて利用者の端末間で同期される。
これは Chrome の機能であり、開発者はその内容を見られない。
```

の**直後**に、空行を 1 つ挟んで次を足す。

```markdown
`chrome.storage.local` に置いた窓の位置と大きさは、その端末の中にだけ残り、同期されない。
```

「## 求めている権限」の表の 40 行目

```markdown
| `storage` | 上表の設定と進行状態を端末内に置くため |
```

を次に置き換える。

```markdown
| `storage` | 上表の設定・窓の位置と大きさ・進行状態を端末内に置くため |
```

- [ ] **Step 9: B の文言が混ざっていないことを確かめる**

実行: `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff | grep '^+' | grep -n '帯\|「+N」'` (Bash の timeout 30000。足した行だけを見る)
期待: 何も出ない (テロップの帯と「+N」は B の plan で書く)

- [ ] **Step 10: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/store-release.md docs/privacy-policy.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: バーとパネルを動かせる窓にすることを先に書く

コードより先にドキュメントを合わせる。掴む場所 (バーは ⠿、パネルは
見出し) で動かし、右下で大きさを変え、位置を端末ごとに覚えて
ダブルクリックで戻す。窓の位置は chrome.storage.local に置くので、
プライバシーポリシーの保存するものの表と storage の説明にも足す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: 位置の保存・読み込み・検証と、画面に詰める計算 (`window-layout.ts`)

**Files:**
- Create: `src/content/window-layout.ts`
- Test: `tests/content/window-layout.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `export const WINDOW_LAYOUT_KEY = "windowLayout"`
  - `export type WindowId = "bar" | "panel"`
  - `export type WindowRect = { left: number; top: number; width: number; height?: number }` (Task 3 の `floating-window.ts` がそのまま re-export する。spec A.3 の型と同じ形)
  - `export type WindowLayout = Partial<Record<WindowId, WindowRect>>`
  - `export type Viewport = { width: number; height: number }`
  - `export type GripBox = { left: number; top: number; width: number; height: number }` (掴む場所の箱。窓の左上からの位置)
  - `export type SizeLimits = { minWidth: number; minHeight?: number }`
  - `export const BAR_GAP_PX = 8` / `export const SCREEN_BOTTOM_GAP_PX = 16`
  - `export function mergeWindowLayout(stored: unknown): WindowLayout` — 型違い・範囲外・欠落の窓を捨てて `console.warn`
  - `export function fitRect(rect: WindowRect, viewport: Viewport, grip: GripBox, limits: SizeLimits): WindowRect` — 大きさを最小〜画面に収め、掴む場所の全体が画面に残るよう位置を詰める
  - `export function initialBarRect(player: { left: number; bottom: number; width: number }, barHeight: number, viewport: Viewport): WindowRect`
  - `export function loadWindowLayout(): Promise<WindowLayout>` — **reject しない** (読めなければ warn して `{}`)
  - `export function saveWindowRect(id: WindowId, rect: WindowRect): Promise<void>` / `export function clearWindowRect(id: WindowId): Promise<void>` — 読んで書き戻す処理を 1 本の列で順に行う

型 `WindowRect` をここで定義するのは、`floating-window.ts` (枠) と `youtube.ts` (保存) の両方が使い、
`floating-window.ts` から import すると `window-layout.ts` → `floating-window.ts` → `window-layout.ts` の循環になるため。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/window-layout.test.ts` を作る (環境は vitest の既定の node。DOM を使わない)。

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WINDOW_LAYOUT_KEY,
  clearWindowRect,
  fitRect,
  initialBarRect,
  loadWindowLayout,
  mergeWindowLayout,
  saveWindowRect,
} from "@/content/window-layout";

/** 受け入れ条件の画面 (1440x900 のノート PC の viewport = 1440x795) */
const VIEWPORT = { width: 1440, height: 795 };
/** 掴む場所を測れないとき (隠れている窓など) */
const NO_GRIP = { left: 0, top: 0, width: 0, height: 0 };
/** パネルの窓の見出し: 窓の上端いっぱい、高さ 32 */
const HEADER = { left: 0, top: 0, width: 400, height: 32 };
/** バーの窓のつまみ: 窓の左上から (12, 54) にある 20x36 の箱 */
const GRIP = { left: 12, top: 54, width: 20, height: 36 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mergeWindowLayout", () => {
  test("何も覚えていなければ空。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("2 つの窓の位置と大きさを読む。高さは無くてよい", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      bar: { left: 24, top: 636, width: 988 },
      panel: { left: 1024, top: 68, width: 400, height: 500 },
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("型の違う窓は捨てて warn する。もう片方は使う", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = { left: 1024, top: 68, width: 400 };
    expect(
      mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel }),
    ).toEqual({ panel });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.bar");
  });

  test("欠けた窓は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ bar: { left: 24, top: 636 } })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("範囲の外の値は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = [
      { left: 0, top: 0, width: 0 },
      { left: 0, top: 0, width: -100 },
      { left: 1e9, top: 0, width: 400 },
      { left: 0, top: Number.POSITIVE_INFINITY, width: 400 },
      { left: 0, top: 0, width: Number.NaN },
      { left: 0, top: 0, width: 400, height: 0 },
    ];
    for (const rect of bad) {
      expect(mergeWindowLayout({ panel: rect })).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });

  test("窓の組でないもの (数値・null) は空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(42)).toEqual({});
    expect(mergeWindowLayout(null)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("知らない窓の名前は黙って無視する (後の版で窓が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ other: { left: 0 } })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fitRect", () => {
  const LIMITS = { minWidth: 280, minHeight: 160 };

  test("画面に収まっていればそのまま", () => {
    const rect = { left: 100, top: 100, width: 400, height: 300 };
    expect(fitRect(rect, VIEWPORT, HEADER, LIMITS)).toEqual(rect);
  });

  test("高さの無い窓に高さを足さない", () => {
    expect(fitRect({ left: 100, top: 100, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 100,
      top: 100,
      width: 400,
    });
  });

  test("最小より小さい大きさは最小にする", () => {
    expect(
      fitRect({ left: 100, top: 100, width: 10, height: 10 }, VIEWPORT, NO_GRIP, LIMITS),
    ).toEqual({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("画面より大きい大きさは画面の大きさにする", () => {
    expect(
      fitRect({ left: 0, top: 0, width: 5000, height: 5000 }, VIEWPORT, NO_GRIP, LIMITS),
    ).toEqual({ left: 0, top: 0, width: 1440, height: 795 });
  });

  test("画面が最小より狭いときは最小を採る", () => {
    expect(
      fitRect(
        { left: 0, top: 0, width: 400, height: 400 },
        { width: 200, height: 100 },
        NO_GRIP,
        LIMITS,
      ),
    ).toEqual({ left: 0, top: 0, width: 280, height: 160 });
  });

  test("見出しが右と下にはみ出さないよう詰める", () => {
    // 1440 - 400、795 - 32
    expect(fitRect({ left: 2000, top: 2000, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 1040,
      top: 763,
      width: 400,
    });
  });

  test("見出しが左と上にはみ出さないよう詰める", () => {
    expect(fitRect({ left: -500, top: -500, width: 400 }, VIEWPORT, HEADER, LIMITS)).toEqual({
      left: 0,
      top: 0,
      width: 400,
    });
  });

  test("つまみだけが残ればよい。窓の残りは画面の外へ出てよい", () => {
    const limits = { minWidth: 480 };
    // 1440 - 12 - 20、795 - 54 - 36
    expect(fitRect({ left: 5000, top: 5000, width: 1000 }, VIEWPORT, GRIP, limits)).toEqual({
      left: 1408,
      top: 705,
      width: 1000,
    });
    expect(fitRect({ left: -5000, top: -5000, width: 1000 }, VIEWPORT, GRIP, limits)).toEqual({
      left: -12,
      top: -54,
      width: 1000,
    });
  });

  test("窓より広く測れた見出しは、窓の幅までしか数えない", () => {
    // 大きさを変えている最中は、見出しが 1 つ前の広い幅で測られる。そのまま使うと
    // 右端の上限 (1440 - 1000 = 440) まで窓が引き戻される
    const wideHeader = { left: 0, top: 0, width: 1000, height: 32 };
    expect(
      fitRect({ left: 1000, top: 100, width: 400 }, VIEWPORT, wideHeader, LIMITS),
    ).toEqual({ left: 1000, top: 100, width: 400 });
  });

  test("画面が掴む場所より小さいときは、掴む場所の左上を残す", () => {
    // 画面は最小の幅 (480) より狭いので、幅は最小を採る
    expect(
      fitRect({ left: 300, top: 300, width: 600 }, { width: 10, height: 10 }, GRIP, {
        minWidth: 480,
      }),
    ).toEqual({ left: -12, top: -54, width: 480 });
  });
});

describe("initialBarRect", () => {
  test("プレイヤーの直下 8px に、左端を揃えてプレイヤーの幅で置く", () => {
    // 1440x795 の実測 (右側パネルの受け入れ確認): プレイヤーの下端 ≈ 628px
    expect(initialBarRect({ left: 24, bottom: 628, width: 988 }, 106, VIEWPORT)).toEqual({
      left: 24,
      top: 636,
      width: 988,
    });
  });

  test("画面に収まらなければ、画面の下端から 16px に詰める", () => {
    // 795 - 16 - 106
    expect(initialBarRect({ left: 0, bottom: 700, width: 1440 }, 106, VIEWPORT)).toEqual({
      left: 0,
      top: 673,
      width: 1440,
    });
  });

  test("画面より高いバーでも、上端は画面の上へ出さない", () => {
    expect(initialBarRect({ left: 0, bottom: 700, width: 1440 }, 2000, VIEWPORT).top).toBe(0);
  });
});

describe("覚えた位置の保存と読み込み", () => {
  const BAR = { left: 24, top: 636, width: 988 };
  const PANEL = { left: 1024, top: 68, width: 400, height: 500 };
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string): Promise<Record<string, unknown>> =>
            key in store ? { [key]: store[key] } : {},
          set: async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(store, items);
          },
        },
      },
    });
  });

  test("覚えた位置を読む", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR };
    expect(await loadWindowLayout()).toEqual({ bar: BAR });
  });

  test("読めなければ warn して空を返す (最初の位置で出す)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("壊れた")) } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadWindowLayout()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("1 つの窓を覚えても、もう片方の窓は残す", async () => {
    store[WINDOW_LAYOUT_KEY] = { panel: PANEL };
    await saveWindowRect("bar", BAR);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: PANEL });
  });

  test("2 つの窓を続けて覚えても、両方残る (読んで書き戻す処理を重ねない)", async () => {
    await Promise.all([saveWindowRect("bar", BAR), saveWindowRect("panel", PANEL)]);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: PANEL });
  });

  test("高さの無い窓は高さを書かない", async () => {
    await saveWindowRect("bar", { left: 1, top: 2, width: 480, height: undefined });
    const saved = (store[WINDOW_LAYOUT_KEY] as Record<string, object>).bar;
    expect(Object.keys(saved ?? {})).toEqual(["left", "top", "width"]);
  });

  test("消すのは 1 つの窓だけ", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: PANEL };
    await clearWindowRect("bar");
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ panel: PANEL });
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/content/window-layout"`)

- [ ] **Step 3: 実装する**

`src/content/window-layout.ts` を作る。

```typescript
/**
 * フロートの窓 (バーの窓・パネルの窓) の位置と大きさ
 * (`.claude/specs/2026-09-24-floating-windows-design.md` A.2 / A.3)。
 *
 * 覚えた位置の保存・読み込み・検証と、画面に詰める計算を持つ。計算は純粋関数にして、
 * DOM を持たないテストで確かめる。
 *
 * **`chrome.storage.local` に置く (sync にしない)。** 画面の大きさと窓の置き場所の好みは
 * 端末ごとに違う。sync で運ぶと、大きい画面で置いた位置が小さい画面の端末へ届く
 */

export const WINDOW_LAYOUT_KEY = "windowLayout";

export type WindowId = "bar" | "panel";
const WINDOW_IDS: readonly WindowId[] = ["bar", "panel"];

/** 画面 (viewport) の座標で、窓の左上と大きさ。height が無い窓は高さを中身に任せる */
export type WindowRect = { left: number; top: number; width: number; height?: number };
export type WindowLayout = Partial<Record<WindowId, WindowRect>>;
export type Viewport = { width: number; height: number };
/** 掴む場所 (パネルは見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };

/** バーの窓の最初の位置: プレイヤーの下端との間 (spec A.2) */
export const BAR_GAP_PX = 8;
/** 画面の下端との間。画面に収まらないバーの窓はここまで詰める (spec A.2) */
export const SCREEN_BOTTOM_GAP_PX = 16;
/**
 * どんな画面よりも大きい値。壊れた値 (1e9 など) を弾くためだけの上限。
 * 画面より大きいだけの値は弾かない (fitRect が詰める。大きい画面で覚えた位置を
 * 小さい画面で開いたとき)
 */
const MAX_COORD_PX = 100_000;

function isCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORD_PX;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COORD_PX;
}

/** 高さが無い窓は、高さのキーごと持たない (保存にも undefined を書かない) */
function toRect(left: number, top: number, width: number, height: number | undefined): WindowRect {
  return height === undefined ? { left, top, width } : { left, top, width, height };
}

function parseRect(value: unknown): WindowRect | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!isCoord(source.left) || !isCoord(source.top) || !isSize(source.width)) return null;
  if (source.height !== undefined && !isSize(source.height)) return null;
  return toRect(source.left, source.top, source.width, source.height);
}

/**
 * 覚えた位置を読む。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて最初の位置に戻す。握りつぶさず理由は残す
 * (設定の mergeSettings と同じ作法)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return {};
  if (stored === null || typeof stored !== "object") {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の位置を使います: ${String(stored)}`,
    );
    return {};
  }
  const source = stored as Record<string, unknown>;
  const layout: WindowLayout = {};
  for (const id of WINDOW_IDS) {
    const value = source[id];
    if (value === undefined) continue;
    const rect = parseRect(value);
    if (rect === null) {
      console.warn(
        `[yt-clip] 保存された windowLayout.${id} が使えないため最初の位置を使います: ${JSON.stringify(value)}`,
      );
      continue;
    }
    layout[id] = rect;
  }
  return layout;
}

/**
 * value を min〜max に収める。**範囲が逆転する (画面が掴む場所より小さい) ときは min を採る。**
 * 掴む場所の左上を画面に残す方を選ぶ
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 窓の位置と大きさを画面に詰める (spec A.1)。
 *
 * - 大きさは最小〜画面の大きさ。画面が最小より狭いときは最小を採る
 * - 位置は**掴む場所の全体が画面に残る**ところまで詰める。窓の残りは画面の外へ出てよい
 *   (バーの窓はつまみが左端にあるので、右へ寄せると窓の大半が画面の外へ出る)。
 *   窓全体を画面に入れる案は採らない: 幅いっぱいのバーの窓が一切動かせなくなる
 */
export function fitRect(
  rect: WindowRect,
  viewport: Viewport,
  grip: GripBox,
  limits: SizeLimits,
): WindowRect {
  const width = clamp(rect.width, limits.minWidth, viewport.width);
  const minHeight = limits.minHeight ?? 0;
  const height =
    rect.height === undefined ? undefined : clamp(rect.height, minHeight, viewport.height);
  // 窓からはみ出す分の掴む場所は数えない。大きさを変えている最中は、見出しが 1 つ前の
  // 広い幅で測られる
  const gripWidth = Math.max(0, Math.min(grip.width, width - grip.left));
  const gripHeight =
    height === undefined ? grip.height : Math.max(0, Math.min(grip.height, height - grip.top));
  // 下限は `0 - grip.left` と書く。`-grip.left` だと grip.left が 0 のとき -0 になり、
  // テストの toEqual (Object.is で比べる) が 0 と区別して落ちる
  const left = clamp(rect.left, 0 - grip.left, viewport.width - grip.left - gripWidth);
  const top = clamp(rect.top, 0 - grip.top, viewport.height - grip.top - gripHeight);
  return toRect(left, top, width, height);
}

/**
 * バーの窓の最初の位置 (spec A.2)。プレイヤーの直下に、左端を揃えてプレイヤーの幅で置く。
 * 画面に収まらなければ画面の下端から SCREEN_BOTTOM_GAP_PX に詰める (このときだけプレイヤーに
 * 重なりうる)。上端は画面の上へ出さない。
 *
 * player は**画面上の位置** (getBoundingClientRect)。ページがスクロールされていても、そのまま使う
 */
export function initialBarRect(
  player: { left: number; bottom: number; width: number },
  barHeight: number,
  viewport: Viewport,
): WindowRect {
  const below = player.bottom + BAR_GAP_PX;
  const lowest = viewport.height - SCREEN_BOTTOM_GAP_PX - barHeight;
  return { left: player.left, top: Math.max(0, Math.min(below, lowest)), width: player.width };
}

/**
 * 保存を 1 本の列にする。**2 つの窓をすぐ続けて動かすと、読んで書き戻す処理が重なり、
 * 先の書き込みが後の書き込みで消える** (どちらも古い値を読んでから書くため)
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // 1 つが失敗しても後ろの保存は続ける。失敗は呼び出し側 (run) に返す
  queue = run.catch(() => undefined);
  return run;
}

/** 保存されている組をそのまま読む (書き戻す用)。検証しないのは、使えない窓も消さずに残すため */
async function readStored(): Promise<Record<string, unknown>> {
  const stored = (await chrome.storage.local.get(WINDOW_LAYOUT_KEY))[WINDOW_LAYOUT_KEY];
  return stored !== null && typeof stored === "object"
    ? { ...(stored as Record<string, unknown>) }
    : {};
}

/**
 * 覚えた位置を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残して空を返し、2 つの窓は
 * 最初の位置で出る (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で
 * 出す」)。投げると、呼び出し側が窓を出さないままにする経路を作りうる
 */
export async function loadWindowLayout(): Promise<WindowLayout> {
  try {
    const stored = await chrome.storage.local.get(WINDOW_LAYOUT_KEY);
    return mergeWindowLayout(stored[WINDOW_LAYOUT_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] 窓の位置を読めないため最初の位置を使います: ${String(error)}`);
    return {};
  }
}

/** 1 つの窓の位置と大きさを覚える。もう片方の窓は残す */
export function saveWindowRect(id: WindowId, rect: WindowRect): Promise<void> {
  return serialize(async () => {
    const current = await readStored();
    current[id] = toRect(rect.left, rect.top, rect.width, rect.height);
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: current });
  });
}

/** 1 つの窓の覚えた位置を消す (掴む場所のダブルクリックで最初の位置に戻したとき) */
export function clearWindowRect(id: WindowId): Promise<void> {
  return serialize(async () => {
    const current = await readStored();
    delete current[id];
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: current });
  });
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: PASS (26 件)

- [ ] **Step 5: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/window-layout.ts tests/content/window-layout.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓の位置を覚えて読み込み、画面に詰める計算を足す

フロートの窓の位置と大きさは端末ごとの好みなので chrome.storage.local
に置く。読み込みでは型と範囲を確かめ、合わない窓は warn して最初の
位置に戻す。画面に詰めるのは掴む場所が残るところまでにし、窓の残り
は画面の外へ出てよい (幅いっぱいのバーの窓を動かせなくしないため)。
2 つの窓を続けて覚えても消し合わないよう、保存は 1 本の列にする。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: 窓の枠 (`floating-window.ts`)

**Files:**
- Create: `src/content/floating-window.ts`
- Modify: `src/content/styles.ts` (末尾に `FLOATING_WINDOW_STYLE` を足す)
- Test: `tests/content/floating-window.test.ts`
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes: `fitRect` / `WindowRect` / `GripBox` (Task 2)
- Produces:
  - `export type { WindowRect } from "@/content/window-layout"`
  - `export type FloatingWindow = { element: HTMLElement; headerActions: HTMLElement | null; addDragHandle(element: HTMLElement): void; body: HTMLElement; setVisible(visible: boolean): void; place(rect: WindowRect): void; rect(): WindowRect; destroy(): void }`
  - `export type FloatingWindowOptions = { id: string; title?: string; resize: "width" | "both"; minWidth: number; minHeight?: number; onUserMove(rect: WindowRect): void; onResetRequest(): void }`
  - `export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindow`
  - DOM: 窓の枠は `id = options.id`・`position:fixed`。見出しは `[data-role='window-header']` (title を渡したときだけ。自動で掴む場所に登録する)、右下のつまみは `[data-role='window-resize']`
  - 作った直後は隠れている (`element.hidden === true`・`style.display === "none"`)。`setVisible(true)` で `display: flex`
  - 重なり順: 下の窓 `z-index: 2000`、最後に触った窓 `2001`
  - 振る舞い: `place` は求められた位置 (`requested`) を覚えて画面に詰めて当てる。`window` の `resize` で `requested` から詰め直す (ブラウザを戻せば置いた場所に戻る)。`setVisible(true)` は**隠れていた窓を出すときだけ**詰め直す。本体 (`body`) を `hidden` にした窓は、`place` のときに高さを持たず右下のつまみも隠す。高さを決めていない `resize: "both"` の窓は `max-height` を「画面の下端から 16px まで (最小の高さは残す)」にする
  - `export const FLOATING_WINDOW_STYLE` (styles.ts): `root` / `header` / `title` / `headerActions` / `resizeGrip`

**jsdom の制約:** jsdom は `setPointerCapture` / `releasePointerCapture` と `PointerEvent` を持たない。テストでは
`Element.prototype` に空の関数を足し、ポインタの操作は `new MouseEvent("pointerdown", …)` で配る
(既存の `tests/content/youtube.test.ts` の `dragOutToEnd` と同じ作法)。そのため `event.pointerId` は `undefined` になるが、
実装はそれを捕捉の関数に渡すだけなので構わない。

- [ ] **Step 1: 見た目のテストを足す**

`tests/content/styles.test.ts` の 3 行目

```typescript
import { BAR_STYLE, SIDE_PANEL_STYLE, applyPalette, isDarkTheme } from "@/content/styles";
```

を次に置き換える。

```typescript
import {
  BAR_STYLE,
  FLOATING_WINDOW_STYLE,
  SIDE_PANEL_STYLE,
  applyPalette,
  isDarkTheme,
} from "@/content/styles";
```

ファイルの末尾に次を足す。

```typescript
describe("フロートの窓", () => {
  test("画面に固定し、地はパネル用の色で塗る (下のページが透けない)", () => {
    expect(FLOATING_WINDOW_STYLE.root).toContain("position:fixed");
    expect(FLOATING_WINDOW_STYLE.root).toContain("background:var(--ytc-panel)");
  });

  test("display は持たない (出し入れは floating-window.ts が決める)", () => {
    expect(FLOATING_WINDOW_STYLE.root).not.toContain("display:");
    expect(FLOATING_WINDOW_STYLE.resizeGrip).not.toContain("display:");
  });

  test("見出しは掴めることが分かるカーソルで、文字を選ばせない", () => {
    expect(FLOATING_WINDOW_STYLE.header).toContain("cursor:move");
    expect(FLOATING_WINDOW_STYLE.header).toContain("user-select:none");
  });

  test("右下のつまみは 16px 四方", () => {
    expect(FLOATING_WINDOW_STYLE.resizeGrip).toContain("width:16px");
    expect(FLOATING_WINDOW_STYLE.resizeGrip).toContain("height:16px");
  });
});
```

- [ ] **Step 2: 窓の枠の失敗するテストを書く**

`tests/content/floating-window.test.ts` を作る。

```typescript
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createFloatingWindow,
  type FloatingWindow,
  type FloatingWindowOptions,
} from "@/content/floating-window";

/** jsdom の画面の既定。テストが変えたら afterEach で戻す */
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
}

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function boxAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
}

/** (100, 100) で押し、dx / dy だけ動かして離す */
function drag(target: Element, dx: number, dy: number): void {
  pointer(target, "pointerdown", 100, 100);
  pointer(target, "pointermove", 100 + dx, 100 + dy);
  pointer(target, "pointerup", 100 + dx, 100 + dy);
}

function dblclick(target: Element): void {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

let created: FloatingWindow[] = [];

/** 作って body に付け、出しておく。既定はパネルの窓と同じ (見出しあり・幅と高さ) */
function makeWindow(overrides: Partial<FloatingWindowOptions> = {}) {
  const onUserMove = vi.fn();
  const onResetRequest = vi.fn();
  const frame = createFloatingWindow({
    id: `win-${created.length}`,
    title: "見出し",
    resize: "both",
    minWidth: 280,
    minHeight: 160,
    onUserMove,
    onResetRequest,
    ...overrides,
  });
  created.push(frame);
  document.body.append(frame.element);
  frame.setVisible(true);
  return { frame, onUserMove, onResetRequest };
}

/** バーの窓と同じ形 (見出し無し・幅だけ・つまみを登録) */
function makeBarLikeWindow() {
  const made = makeWindow({ title: undefined, resize: "width", minWidth: 480, minHeight: undefined });
  const grip = document.createElement("span");
  made.frame.body.append(grip);
  made.frame.addDragHandle(grip);
  return { ...made, grip };
}

function headerOf(frame: FloatingWindow): HTMLElement {
  const header = frame.element.querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("見出しがありません");
  return header;
}

function resizeGripOf(frame: FloatingWindow): HTMLElement {
  const grip = frame.element.querySelector<HTMLElement>("[data-role='window-resize']");
  if (grip === null) throw new Error("右下のつまみがありません");
  return grip;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

afterEach(() => {
  for (const frame of created) frame.destroy();
  created = [];
  vi.restoreAllMocks();
  setViewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe("createFloatingWindow", () => {
  test("作った直後は隠れている (中身が入るまで空の枠を出さない)", () => {
    const frame = createFloatingWindow({
      id: "win-hidden",
      resize: "width",
      minWidth: 480,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    created.push(frame);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("id で辿れ、画面に固定してページ本体より上に重ねる", () => {
    const { frame } = makeWindow({ id: "yt-clip-test-window" });
    expect(document.getElementById("yt-clip-test-window")).toBe(frame.element);
    expect(frame.element.style.position).toBe("fixed");
    expect(frame.element.style.zIndex).toBe("2000");
  });

  test("setVisible で出し入れする", () => {
    const { frame } = makeWindow();
    expect(frame.element.hidden).toBe(false);
    expect(frame.element.style.display).toBe("flex");
    frame.setVisible(false);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("見出しのある窓は、見出しの文言と右側の部品の箱を持つ", () => {
    const { frame } = makeWindow({ title: "yt-clip" });
    const header = headerOf(frame);
    expect(header.textContent).toContain("yt-clip");
    expect(frame.headerActions).not.toBeNull();
    expect(header.contains(frame.headerActions)).toBe(true);
    expect(frame.element.contains(frame.body)).toBe(true);
  });

  test("見出しの無い窓は見出しの行を作らない", () => {
    const { frame } = makeWindow({ title: undefined });
    expect(frame.element.querySelector("[data-role='window-header']")).toBeNull();
    expect(frame.headerActions).toBeNull();
  });

  test("place で位置と大きさを置き、rect で読める", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 50, width: 400, height: 300 });
    expect(frame.element.style.left).toBe("100px");
    expect(frame.element.style.top).toBe("50px");
    expect(frame.element.style.width).toBe("400px");
    expect(frame.element.style.height).toBe("300px");
    expect(frame.element.style.maxHeight).toBe("");
    expect(frame.rect()).toEqual({ left: 100, top: 50, width: 400, height: 300 });
  });

  test("高さを決めていない「幅と高さ」の窓は、画面の下端から 16px までに抑える", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 68, width: 400 });
    expect(frame.element.style.height).toBe("");
    // 768 - 68 - 16
    expect(frame.element.style.maxHeight).toBe("684px");
  });

  test("「幅だけ」の窓は高さを抑えず、覚えた高さが混ざっていても使わない", () => {
    const { frame } = makeBarLikeWindow();
    frame.place({ left: 100, top: 68, width: 600, height: 300 });
    expect(frame.element.style.height).toBe("");
    expect(frame.element.style.maxHeight).toBe("");
    expect(frame.rect()).toEqual({ left: 100, top: 68, width: 600 });
  });

  test("destroy で DOM から外れる", () => {
    const { frame } = makeWindow({ id: "yt-clip-test-window" });
    frame.destroy();
    expect(frame.element.isConnected).toBe(false);
    expect(document.getElementById("yt-clip-test-window")).toBeNull();
    // 外した後に画面の大きさが変わっても落ちない
    window.dispatchEvent(new Event("resize"));
  });
});

describe("ドラッグで動かす", () => {
  test("見出しをドラッグすると動き、指を離したときに 1 回だけ知らせる", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 10, 10);
    pointer(header, "pointermove", 40, 30);
    pointer(header, "pointermove", 60, 50);
    // 動かしている間は知らせない (保存を何度も走らせない)
    expect(onUserMove).not.toHaveBeenCalled();
    expect(frame.element.style.left).toBe("150px");
    expect(frame.element.style.top).toBe("140px");

    pointer(header, "pointerup", 60, 50);
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 150, top: 140, width: 400, height: 300 });
    expect(frame.rect()).toEqual({ left: 150, top: 140, width: 400, height: 300 });
  });

  test("見出しの中のボタンを押してドラッグしても動かない", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const button = document.createElement("button");
    frame.headerActions?.append(button);

    pointer(button, "pointerdown", 10, 10);
    pointer(button, "pointermove", 60, 50);
    pointer(headerOf(frame), "pointermove", 60, 50);
    pointer(button, "pointerup", 60, 50);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("見出しの無い窓は、addDragHandle で登録した要素で動く", () => {
    const { frame, grip, onUserMove } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });

    drag(grip, 30, 20);

    expect(frame.rect()).toEqual({ left: 130, top: 120, width: 600 });
    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 600 });
  });

  test("押して動かさずに離したら知らせない (クリックで「動かした窓」にしない)", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    drag(headerOf(frame), 0, 0);
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("主ボタン以外では動かない", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);
    pointer(header, "pointerdown", 100, 100, 2);
    pointer(header, "pointermove", 150, 150, 2);
    pointer(header, "pointerup", 150, 150, 2);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("pointercancel でもドラッグを終える", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(frame);

    pointer(header, "pointerdown", 0, 0);
    pointer(header, "pointermove", 20, 10);
    pointer(header, "pointercancel", 20, 10);
    expect(onUserMove).toHaveBeenCalledTimes(1);

    // 終えた後の動きには付いていかない
    pointer(header, "pointermove", 200, 200);
    expect(frame.rect()).toEqual({ left: 120, top: 110, width: 400 });
  });
});

describe("大きさを変える", () => {
  test("「幅と高さ」の窓は右下をドラッグすると幅と高さが変わる", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });

    drag(resizeGripOf(frame), 50, 40);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 450, height: 340 });
    expect(frame.element.style.width).toBe("450px");
    expect(frame.element.style.height).toBe("340px");
    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  test("高さを決めていない窓は、今の見た目の高さから広げる", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 400, 250));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 400, 32));

    drag(resizeGripOf(frame), 0, 30);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 400, height: 280 });
  });

  test("「幅だけ」の窓は高さが変わらない", () => {
    const { frame } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });

    drag(resizeGripOf(frame), 50, 40);

    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 650 });
    expect(frame.element.style.height).toBe("");
  });

  test("最小の大きさより小さくならない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    drag(resizeGripOf(frame), -1000, -1000);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("画面の大きさより大きくならない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    drag(resizeGripOf(frame), 5000, 5000);
    expect(frame.rect()).toEqual({ left: 100, top: 100, width: 1024, height: 768 });
  });

  test("右下のつまみのカーソルは向きで変える (幅だけは ew-resize)", () => {
    expect(resizeGripOf(makeWindow().frame).style.cursor).toBe("nwse-resize");
    expect(resizeGripOf(makeBarLikeWindow().frame).style.cursor).toBe("ew-resize");
  });

  test("本体を隠した窓は高さを持たず、右下のつまみも隠す。出し直すと高さが戻る", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });

    frame.body.hidden = true;
    frame.place(frame.rect());
    expect(frame.element.style.height).toBe("");
    expect(resizeGripOf(frame).hidden).toBe(true);

    frame.body.hidden = false;
    frame.place(frame.rect());
    expect(frame.element.style.height).toBe("300px");
    expect(resizeGripOf(frame).hidden).toBe(false);
  });
});

describe("画面の中に詰める", () => {
  test("見出しは画面の外へ出しきれない", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    // 見出しは窓の上端いっぱい (幅 400・高さ 32)
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 32));

    drag(headerOf(frame), 5000, 5000);
    // 1024 - 400、768 - 32
    expect(frame.rect()).toEqual({ left: 624, top: 736, width: 400 });

    drag(headerOf(frame), -5000, -5000);
    expect(frame.rect()).toEqual({ left: 0, top: 0, width: 400 });
  });

  test("つまみの窓は、つまみが画面に残るところまで出せる", () => {
    const { frame, grip } = makeBarLikeWindow();
    frame.place({ left: 100, top: 100, width: 600 });
    // つまみは窓の左上から (12, 54) にある 20x36 の箱
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(100, 100, 600, 106));
    vi.spyOn(grip, "getBoundingClientRect").mockReturnValue(boxAt(112, 154, 20, 36));

    drag(grip, 5000, 5000);
    // 1024 - 12 - 20、768 - 54 - 36
    expect(frame.rect()).toEqual({ left: 992, top: 678, width: 600 });

    drag(grip, -5000, -5000);
    // 窓の左上は画面の外へ出てよい。つまみは画面の中に残る
    expect(frame.rect()).toEqual({ left: -12, top: -54, width: 600 });
  });

  test("ブラウザが小さくなったら詰め、大きく戻したら置いた場所に戻す", () => {
    const { frame } = makeWindow();
    vi.spyOn(frame.element, "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 300));
    vi.spyOn(headerOf(frame), "getBoundingClientRect").mockReturnValue(boxAt(0, 0, 400, 32));
    frame.place({ left: 600, top: 100, width: 400 });

    setViewport(900, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.rect()).toEqual({ left: 500, top: 100, width: 400 });

    setViewport(1024, 768);
    window.dispatchEvent(new Event("resize"));
    expect(frame.rect()).toEqual({ left: 600, top: 100, width: 400 });
  });

  test("隠れている間に置いた窓は、出すときに掴む場所を測って詰め直す", () => {
    const frame = createFloatingWindow({
      id: "win-hidden",
      resize: "width",
      minWidth: 480,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    created.push(frame);
    document.body.append(frame.element);
    const grip = document.createElement("span");
    frame.body.append(grip);
    frame.addDragHandle(grip);
    // 隠れている間は寸法が 0 (実機の display:none と同じ)
    vi.spyOn(frame.element, "getBoundingClientRect").mockImplementation(() =>
      frame.element.hidden ? boxAt(0, 0, 0, 0) : boxAt(100, 100, 600, 106),
    );
    vi.spyOn(grip, "getBoundingClientRect").mockImplementation(() =>
      frame.element.hidden ? boxAt(0, 0, 0, 0) : boxAt(112, 154, 20, 36),
    );

    frame.place({ left: 1000, top: 700, width: 600 });
    // つまみを測れないので、窓の左上だけを画面に入れている
    expect(frame.rect()).toEqual({ left: 1000, top: 700, width: 600 });

    frame.setVisible(true);
    expect(frame.rect()).toEqual({ left: 992, top: 678, width: 600 });
  });
});

describe("重なり順とダブルクリック", () => {
  test("最後に触った窓が上に来る", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;

    pointer(a.body, "pointerdown", 0, 0);
    expect(a.element.style.zIndex).toBe("2001");
    expect(b.element.style.zIndex).toBe("2000");

    pointer(b.body, "pointerdown", 0, 0);
    expect(b.element.style.zIndex).toBe("2001");
    expect(a.element.style.zIndex).toBe("2000");
  });

  test("見出しのダブルクリックで onResetRequest を呼ぶ。見出しの中のボタンでは呼ばない", () => {
    const { frame, onResetRequest } = makeWindow();
    const button = document.createElement("button");
    frame.headerActions?.append(button);

    dblclick(button);
    expect(onResetRequest).not.toHaveBeenCalled();

    dblclick(headerOf(frame));
    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });

  test("addDragHandle で登録した要素のダブルクリックでも onResetRequest を呼ぶ", () => {
    const { grip, onResetRequest } = makeBarLikeWindow();
    dblclick(grip);
    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/content/floating-window"`、styles は `FLOATING_WINDOW_STYLE` が undefined)

- [ ] **Step 4: 見た目を足す**

`src/content/styles.ts` の末尾 (`SIDE_PANEL_STYLE` の定義の後) に次を足す。

```typescript
/**
 * フロートの窓の枠 (`floating-window.ts`)。バーの窓とパネルの窓で同じものを使う。
 *
 * **`root` と `resizeGrip` は display を持たない。** 出し入れは `floating-window.ts` が
 * `style.display` で行う。ここに display を書くと、`hidden` を立てても inline の display が
 * 勝って出たままになる。位置・大きさ・重なり順も `floating-window.ts` が決める
 */
export const FLOATING_WINDOW_STYLE = {
  /** 下のページが透けると読めないので、不透明な地と影を付ける */
  root: `position:fixed;flex-direction:column;box-sizing:border-box;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:${FONT};font-size:13px;`,
  /**
   * 見出し。空いたところを掴んで動かす。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  header:
    "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;user-select:none;touch-action:none;",
  title: "flex:1;color:var(--ytc-text);font-size:13px;font-weight:600;",
  /** 見出しの右側の部品の箱。ボタンの上では窓を動かさないので、掴めそうなカーソルを出さない */
  headerActions: "display:flex;align-items:center;gap:4px;cursor:default;",
  /**
   * 右下の角のつまみ (16px 四方。spec A.1)。カーソルは窓の向き (幅だけ / 幅と高さ) で
   * `floating-window.ts` が足す
   */
  resizeGrip:
    "position:absolute;right:0;bottom:0;width:16px;height:16px;touch-action:none;background:linear-gradient(135deg,transparent 50%,var(--ytc-border) 50%);",
} as const;
```

- [ ] **Step 5: 窓の枠を実装する**

`src/content/floating-window.ts` を作る。

```typescript
import { FLOATING_WINDOW_STYLE } from "@/content/styles";
import { fitRect, type GripBox, type WindowRect } from "@/content/window-layout";

export type { WindowRect } from "@/content/window-layout";

/**
 * 画面の上に浮いた窓の枠 (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **枠だけを持つ**: 見出し・本体の箱・右下のつまみ・ドラッグで動かす・大きさを変える・
 * 画面の中に詰める・重なり順。中身と「いつ出すか・最初にどこへ置くか」は知らない
 * (side-panel.ts と youtube.ts が決める)。パネルの窓とバーの窓で同じ処理を 2 回書かないために
 * 1 つにしている
 */

/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は side-panel.ts の
 * 実測のコメント) より下**、ページ本体より上。2 つの窓が重なったら、最後に触った窓を 1 つ上げる
 * (spec A.1)
 */
const Z_BACK = 2000;
const Z_FRONT = 2001;
/**
 * 高さを決めていない「幅と高さ」の窓 (パネル) の下端と、画面の下端との間。右側パネルの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/** 今ある窓の枠。最後に触った窓を上げるとき、ほかの窓を下げるのに使う */
const liveWindows = new Set<HTMLElement>();

function bringToFront(target: HTMLElement): void {
  for (const element of liveWindows) {
    element.style.zIndex = String(element === target ? Z_FRONT : Z_BACK);
  }
}

/**
 * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (折り畳みの ▶ を
 * 押したら畳むだけ。spec A.1)
 */
function isOnControl(target: EventTarget | null, handle: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, input, textarea, select, a");
  return control !== null && handle.contains(control);
}

function sameRect(a: WindowRect, b: WindowRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export type FloatingWindow = {
  element: HTMLElement;
  /** 見出しの右側に置く部品 (折り畳みボタンなど) の箱。見出しの無い窓では null */
  headerActions: HTMLElement | null;
  /** この要素を押してドラッグすると窓が動く (中のボタンを押したときは動かさない) */
  addDragHandle(element: HTMLElement): void;
  /** 中身の箱。見た目 (余白・スクロール・出し入れ) は中身を入れる側が決める */
  body: HTMLElement;
  setVisible(visible: boolean): void;
  /** 位置と大きさを置く。画面に収まるよう詰める */
  place(rect: WindowRect): void;
  /** 今の位置と大きさ (詰めた後) */
  rect(): WindowRect;
  destroy(): void;
};

export type FloatingWindowOptions = {
  id: string;
  /** 見出しの文言。省くと見出しの行を作らない (バーの窓) */
  title?: string;
  resize: "width" | "both";
  minWidth: number;
  minHeight?: number;
  /** ユーザーがドラッグで動かした・大きさを変えたとき (指を離した時点で 1 回) */
  onUserMove(rect: WindowRect): void;
  /** 掴む場所 (addDragHandle で登録した要素) のダブルクリック */
  onResetRequest(): void;
};

export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindow {
  const element = document.createElement("div");
  element.id = options.id;
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BACK};`;

  let header: HTMLElement | null = null;
  let headerActions: HTMLElement | null = null;
  if (options.title !== undefined) {
    header = document.createElement("div");
    header.dataset.role = "window-header";
    header.style.cssText = FLOATING_WINDOW_STYLE.header;
    const title = document.createElement("span");
    title.style.cssText = FLOATING_WINDOW_STYLE.title;
    title.textContent = options.title;
    headerActions = document.createElement("div");
    headerActions.style.cssText = FLOATING_WINDOW_STYLE.headerActions;
    header.append(title, headerActions);
    element.append(header);
  }

  const body = document.createElement("div");
  const resizeGrip = document.createElement("div");
  resizeGrip.dataset.role = "window-resize";
  resizeGrip.title = options.resize === "width" ? "ドラッグで幅を変える" : "ドラッグで大きさを変える";
  // 幅だけの窓 (バー) は横向きのカーソル。高さは中身で決まり、変えられないことを見せる
  resizeGrip.style.cssText = `${FLOATING_WINDOW_STYLE.resizeGrip}cursor:${options.resize === "width" ? "ew-resize" : "nwse-resize"};`;
  element.append(body, resizeGrip);

  /** 掴む場所。後から登録したものほど新しい (バーのつまみは作り直すたびに登録し直される) */
  let handles: HTMLElement[] = [];
  /**
   * 最後に place で求められた位置と大きさ。**詰めた後の位置とは別に持つ。** ブラウザを
   * 小さくして詰めた窓は、大きく戻したときに置いた場所へ戻る
   */
  let requested: WindowRect = { left: 0, top: 0, width: options.minWidth };
  /** 今の位置と大きさ (画面に詰めた後) */
  let current: WindowRect = requested;

  /**
   * 掴む場所の箱 (窓の左上から)。登録した中で窓の中にある、いちばん新しいもの。
   * 隠れている窓では寸法が 0 になるので、出すときに測り直す (setVisible)
   */
  function gripBox(): GripBox {
    const handle = [...handles].reverse().find((candidate) => element.contains(candidate));
    if (handle === undefined) return { left: 0, top: 0, width: 0, height: 0 };
    const frame = element.getBoundingClientRect();
    const box = handle.getBoundingClientRect();
    return {
      left: box.left - frame.left,
      top: box.top - frame.top,
      width: box.width,
      height: box.height,
    };
  }

  /** 位置と大きさを画面に詰めて当てる */
  function apply(rect: WindowRect): void {
    // 幅だけの窓は高さを持たない (覚えた位置に高さが混ざっていても使わない)。高さは中身で決まる
    const source: WindowRect =
      options.resize === "width" ? { left: rect.left, top: rect.top, width: rect.width } : rect;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const fitted = fitRect(source, viewport, gripBox(), {
      minWidth: options.minWidth,
      minHeight: options.minHeight,
    });
    current = fitted;
    element.style.left = `${fitted.left}px`;
    element.style.top = `${fitted.top}px`;
    element.style.width = `${fitted.width}px`;
    // 本体を隠した (畳んだ) 窓は見出しだけにする。高さを残すと空の枠が残る
    const bodyShown = !body.hidden;
    if (fitted.height !== undefined && bodyShown) {
      element.style.height = `${fitted.height}px`;
      element.style.maxHeight = "";
    } else {
      element.style.height = "";
      // 高さを決めていない「幅と高さ」の窓は中身の高さまで伸び、画面の下端から
      // BOTTOM_GAP_PX で止まる。超えた分は本体の中でスクロールする (右側パネルと同じ)。
      // 下へ動かした窓でも最小の高さは残す (0 に潰れて中身が見えなくならないように)
      element.style.maxHeight =
        options.resize === "both"
          ? `${Math.max(options.minHeight ?? 0, viewport.height - fitted.top - BOTTOM_GAP_PX)}px`
          : "";
    }
    resizeGrip.hidden = !bodyShown;
    resizeGrip.style.display = bodyShown ? "block" : "none";
  }

  /**
   * ドラッグを始める。**Pointer Events と捕捉を使う** (spec A.3)。捕捉すると、指が窓の外へ
   * 出ても pointermove が掴んだ要素に届き続ける
   */
  function beginDrag(source: HTMLElement, kind: "move" | "resize", event: PointerEvent): void {
    // 主ボタン以外 (右クリックのメニューなど) では動かさない
    if (event.button !== 0) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = current;
    // 高さを決めていない窓を縦に広げるときは、今の見た目の高さから始める
    const startHeight = start.height ?? element.getBoundingClientRect().height;
    source.setPointerCapture(event.pointerId);

    /** ドラッグを終わらせる。捕捉とリスナをまとめて解く (range-bar.ts の拡大バーと同じ作法) */
    const finish = (pointerId: number): void => {
      source.releasePointerCapture(pointerId);
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointerup", onUp);
      source.removeEventListener("pointercancel", onUp);
    };

    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (kind === "move") {
        apply({ ...start, left: start.left + dx, top: start.top + dy });
      } else if (options.resize === "both") {
        apply({ ...start, width: start.width + dx, height: startHeight + dy });
      } else {
        apply({ ...start, width: start.width + dx });
      }
    };

    // pointercancel (タッチの横取りなど) でも終える。そこまでに動かした位置は、画面に
    // 出ているとおりに確定する (拡大バーのハンドルと同じ)
    const onUp = (up: PointerEvent): void => {
      finish(up.pointerId);
      requested = current;
      // 押して離しただけ (クリックやダブルクリックの 1 回目) は知らせない。知らせると
      // 「動かした窓」になり、最初の位置を取り直さなくなる
      if (sameRect(start, current)) return;
      options.onUserMove({ ...current });
    };

    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onUp);
    source.addEventListener("pointercancel", onUp);
  }

  function addDragHandle(handle: HTMLElement): void {
    // 窓から外れた古い掴む場所 (作り直したバーの前のつまみ) は捨てる。持ち続けると溜まる
    handles = handles.filter((candidate) => element.contains(candidate));
    handles.push(handle);
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      if (isOnControl(event.target, handle)) return;
      beginDrag(handle, "move", event);
    });
    // 掴む場所のダブルクリックで最初の位置に戻す (spec A.2)。中のボタンの連打では戻さない
    handle.addEventListener("dblclick", (event: MouseEvent) => {
      if (isOnControl(event.target, handle)) return;
      options.onResetRequest();
    });
  }

  // 窓のどこを押しても、その窓を上にする (最後に触った窓が上。spec A.1)。捕捉の段階で
  // 拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため
  element.addEventListener("pointerdown", () => bringToFront(element), true);
  resizeGrip.addEventListener("pointerdown", (event: PointerEvent) => {
    beginDrag(resizeGrip, "resize", event);
  });
  if (header !== null) addDragHandle(header);

  /**
   * ブラウザの大きさが変わったら、掴む場所が画面に残るよう詰め直す。**詰めた後の位置ではなく
   * 置いた場所 (requested) から詰める** (小さくしてから戻すと、置いた場所に戻る)
   */
  const onResize = (): void => apply(requested);
  window.addEventListener("resize", onResize);
  liveWindows.add(element);

  apply(requested);
  // 中身が入り、出す判断がされるまでは出さない。空の枠だけを出さない
  element.hidden = true;
  element.style.display = "none";

  return {
    element,
    headerActions,
    body,
    addDragHandle,

    setVisible(visible: boolean): void {
      const wasHidden = element.hidden;
      // 出し入れは hidden と style.display の両方で行う。root は flex で並べるので display を
      // 持ち、inline の display は UA の [hidden] { display: none } に勝つ。hidden は外から
      // 「出ているか」を読むために残す
      element.hidden = !visible;
      element.style.display = visible ? "flex" : "none";
      // 隠れている間は掴む場所の寸法が 0 で、詰め方を測れていない。出した直後に詰め直す。
      // **出ている間は置き直さない** (ドラッグ中に状態の通知で呼ばれても、指の下の窓を戻さない)
      if (visible && wasHidden) apply(requested);
    },

    place(rect: WindowRect): void {
      requested = { ...rect };
      apply(requested);
    },

    rect(): WindowRect {
      return { ...current };
    },

    destroy(): void {
      window.removeEventListener("resize", onResize);
      liveWindows.delete(element);
      element.remove();
    },
  };
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: PASS (floating-window 29 件、styles は既存に 4 件増えて全件)

- [ ] **Step 7: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/floating-window.ts src/content/styles.ts tests/content/floating-window.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 画面に浮いた窓の枠を足す

右側パネルとバーの両方を動かせる窓にするため、枠 (見出し・右下の
つまみ・ドラッグ・画面に詰める・重なり順) を 1 つのモジュールにする。
中身といつ出すかは知らない。掴む場所は外から登録でき、中のボタンを
押したときは動かさない。指を離したときに 1 回だけ知らせ、押して
離しただけでは知らせない (動かした窓として扱わないため)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: 右側パネルを窓の枠の上に作り直す

**Files:**
- Modify: `src/content/side-panel.ts` (全体を置き換える)
- Modify: `src/content/styles.ts` (`SIDE_PANEL_STYLE` から枠の見た目を外す)
- Test: `tests/content/side-panel.test.ts`
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes: `createFloatingWindow` / `FloatingWindow` / `WindowRect` (Task 3)、`Viewport` (Task 2)、`FLOATING_WINDOW_STYLE` (Task 3)
- Produces:
  - `SidePanel` の既存の API (`element` / `body` / `setVisible` / `reveal` / `scrollTo` / `destroy`) は**変えない**。`element` は窓の枠 (`id = "yt-clip-panel"`)、`body` は窓の本体 (`id = "yt-clip-panel-body"`)
  - 足すもの: `SidePanel.frame: FloatingWindow` (位置と大きさを youtube.ts が置くため)
  - `export type SidePanelOptions = { onUserMove?(rect: WindowRect): void; onResetRequest?(): void }`、`export function createSidePanel(options: SidePanelOptions = {}): SidePanel` (引数を省いた既存の呼び出しはそのまま通る)
  - `export function initialPanelRect(viewport: Viewport): WindowRect` — `{ left: viewport.width - 416, top: 68, width: 400 }` (高さは持たない)
  - 見出しの行は `[data-role='window-header']` (窓の枠が作る)。折り畳みボタン `[data-role='collapse']` は見出しの右側 (`frame.headerActions`) に入る
  - `SIDE_PANEL_STYLE` は `collapseButton` と `body` だけになる (`root` / `header` / `title` は `FLOATING_WINDOW_STYLE` へ移った)

`youtube.ts` はこのタスクでは変えない (`createSidePanel()` を引数なしで呼び続け、`sidePanel.element` / `body` /
`setVisible` / `reveal` / `scrollTo` を使うだけなので、そのまま動く)。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/side-panel.test.ts` の 2〜8 行目

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SIDE_PANEL_BODY_ID,
  SIDE_PANEL_ID,
  createSidePanel,
  type SidePanel,
} from "@/content/side-panel";
```

を次に置き換える。

```typescript
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  SIDE_PANEL_BODY_ID,
  SIDE_PANEL_ID,
  createSidePanel,
  initialPanelRect,
  type SidePanel,
  type SidePanelOptions,
} from "@/content/side-panel";
```

29〜35 行目付近の `makePanel`

```typescript
let panel: SidePanel | null = null;

function makePanel(): SidePanel {
  panel = createSidePanel();
  document.body.append(panel.element);
  return panel;
}
```

を次に置き換える。

```typescript
let panel: SidePanel | null = null;

function makePanel(options: SidePanelOptions = {}): SidePanel {
  panel = createSidePanel(options);
  document.body.append(panel.element);
  return panel;
}

function headerOf(target: SidePanel): HTMLElement {
  const header = target.element.querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("見出しがありません");
  return header;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない (窓の枠のドラッグが呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});
```

76〜84 行目付近の

```typescript
  test("画面の右端に固定し、ページ本体より上に重ねる", () => {
    const target = makePanel();
    expect(target.element.style.position).toBe("fixed");
    // ヘッダー 56px の下 12px
    expect(target.element.style.top).toBe("68px");
    expect(target.element.style.right).toBe("16px");
    expect(target.element.style.width).toBe("400px");
    expect(target.element.style.zIndex).toBe("2000");
  });
```

を次に置き換える (窓は `left` で置くので、右端から 16px を `left` で見る。ほかの検査は同じ)。

```typescript
  test("最初は画面の右上に置き、ページ本体より上に重ねる", () => {
    const target = makePanel();
    expect(target.element.style.position).toBe("fixed");
    // ヘッダー 56px の下 12px
    expect(target.element.style.top).toBe("68px");
    // 右端から 16px: 画面の幅 - 16 - 400
    expect(target.element.style.left).toBe(`${window.innerWidth - 416}px`);
    expect(target.element.style.width).toBe("400px");
    expect(target.element.style.zIndex).toBe("2000");
  });

  test("最初の位置は今の右側パネルと同じ (右 16px・上 68px・幅 400px・高さは決めない)", () => {
    expect(initialPanelRect({ width: 1440, height: 795 })).toEqual({
      left: 1024,
      top: 68,
      width: 400,
    });
  });

  test("高さは中身まで、最大で画面の下端から 16px まで", () => {
    const target = makePanel();
    expect(target.element.style.height).toBe("");
    // 768 (jsdom の画面の高さ) - 68 - 16
    expect(target.element.style.maxHeight).toBe(`${window.innerHeight - 84}px`);
  });

  test("折り畳みボタンは見出しの右側に置く", () => {
    const target = makePanel();
    expect(headerOf(target).contains(collapseButton(target))).toBe(true);
    expect(target.frame.headerActions?.contains(collapseButton(target))).toBe(true);
  });

  test("見出しをドラッグすると動き、指を離したときに知らせる", () => {
    const onUserMove = vi.fn();
    const target = makePanel({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(target);

    header.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    header.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 20 }));
    header.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 30, clientY: 20 }));

    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 400 });
  });

  test("折り畳みボタンを押してドラッグしても窓は動かない", () => {
    const onUserMove = vi.fn();
    const target = makePanel({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });
    const button = collapseButton(target);

    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 20 }));
    button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 30, clientY: 20 }));

    expect(target.frame.rect()).toEqual({ left: 100, top: 100, width: 400 });
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("見出しのダブルクリックで最初の位置に戻すよう頼む。折り畳みボタンでは頼まない", () => {
    const onResetRequest = vi.fn();
    const target = makePanel({ onResetRequest });

    collapseButton(target).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onResetRequest).not.toHaveBeenCalled();

    headerOf(target).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });

  test("高さを決めた窓も、畳むと見出しだけになる。開くと高さが戻る", () => {
    const target = makePanel();
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400, height: 500 });
    expect(target.element.style.height).toBe("500px");

    collapseButton(target).click();
    // 高さを残すと、畳んでも空の枠が 500px 残る
    expect(target.element.style.height).toBe("");

    collapseButton(target).click();
    expect(target.element.style.height).toBe("500px");
  });
```

- [ ] **Step 2: 見た目のテストを直す**

`tests/content/styles.test.ts` の `describe("右側のパネル", …)` (110〜124 行目付近)

```typescript
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

を次に置き換える。枠 (地の色・display を持たないこと) の検査は Task 3 で `describe("フロートの窓")` に移してある。

```typescript
describe("右側のパネル", () => {
  test("本体の中だけでスクロールする", () => {
    expect(SIDE_PANEL_STYLE.body).toContain("overflow-y:auto");
    // flex の子は min-height:0 が無いと中身より縮まず、パネルごと伸びる
    expect(SIDE_PANEL_STYLE.body).toContain("min-height:0");
  });

  test("本体は display を持たない (畳むときの出し入れは side-panel.ts が決める)", () => {
    expect(SIDE_PANEL_STYLE.body).not.toContain("display:");
  });

  test("枠の見た目 (地・見出し) は持たない (窓の枠が持つ)", () => {
    expect(Object.keys(SIDE_PANEL_STYLE)).toEqual(["collapseButton", "body"]);
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/side-panel.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: FAIL (`initialPanelRect` が無い、`style.left` が空、見出しが無い、`SIDE_PANEL_STYLE` のキーが 5 つ、など)

- [ ] **Step 4: `SIDE_PANEL_STYLE` から枠の見た目を外す**

`src/content/styles.ts` の 153〜172 行目付近

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
```

を次に置き換える (`body` の定義と `} as const;` はそのまま残す)。

```typescript
/**
 * 右側のパネル (`side-panel.ts`) の中身。**枠の見た目 (地・影・見出し) は
 * `FLOATING_WINDOW_STYLE` が持つ** (パネルはフロートの窓の上に作る)。位置・幅は
 * YouTube の実機の値に合わせるので、出所と一緒に `side-panel.ts` が持つ。
 *
 * **`body` は display を持たない。** 畳むときの出し入れは `side-panel.ts` が
 * `style.display` で行う。ここに display を書くと、`hidden` を立てても inline の
 * display が勝って出たままになる
 */
export const SIDE_PANEL_STYLE = {
  collapseButton: SEGMENT_STYLE.iconButton,
```

- [ ] **Step 5: `side-panel.ts` を置き換える**

`src/content/side-panel.ts` の全体を次に置き換える。位置と寸法の出所のコメント (実測の値) は今のまま引き継ぎ、
重なり順の定数 `Z_INDEX` は `floating-window.ts` の `Z_BACK` / `Z_FRONT` へ移ったので消す。

```typescript
import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import { SIDE_PANEL_STYLE } from "@/content/styles";
import type { Viewport } from "@/content/window-layout";

/**
 * 画面右側のパネル。区間の一覧・テロップの一覧・設定を入れる
 * (`.claude/specs/2026-09-24-side-panel-design.md`)。**フロートの窓 (`floating-window.ts`) の
 * 上に作る** (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **中身の箱と折り畳みだけを持つ。** 窓の枠 (見出し・ドラッグ・大きさ・画面に詰める・重なり順) は
 * floating-window.ts、何を入れるか・いつ出すか・どこへ置くかは youtube.ts が決める。
 * 出すかの理由をここにも持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる
 */

export const SIDE_PANEL_ID = "yt-clip-panel";
export const SIDE_PANEL_BODY_ID = `${SIDE_PANEL_ID}-body`;

/*
 * 最初の位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020、#secondary の幅 544px。
 * z-index は「ヘッダー (#masthead-container、z-index 2020) より下」であることだけ実測
 * (重なり順の値は floating-window.ts の Z_BACK / Z_FRONT が持つ)。
 * ヘッダーのメニュー本体は自前の z-index を持つため測っておらず、ytd-popup-container の
 * z-index auto はその根拠にならない。#secondary の幅は viewport で変わるので WIDTH_PX の
 * doc に別で書く。YouTube のレイアウトが変わったら測り直す
 */
/** YouTube のヘッダー (#masthead-container) の高さ */
const MASTHEAD_HEIGHT_PX = 56;
/** ヘッダーとの間 */
const TOP_GAP_PX = 12;
/** 画面の右端との間 (下端との間 16px は floating-window.ts の BOTTOM_GAP_PX) */
const EDGE_GAP_PX = 16;
/**
 * #secondary の幅は viewport で変わる (1920x1080 で 544px、実測)。400px は
 * 1440x795 (受け入れ条件の viewport) でもプレイヤーに重ならない幅
 * (実測: プレイヤーの右端 1012px < パネルの左端 1024px)
 */
const WIDTH_PX = 400;
/** 大きさを変えられる下限 (spec A.1)。これより小さいと一覧の 1 行が読めない */
const MIN_WIDTH_PX = 280;
const MIN_HEIGHT_PX = 160;

export type SidePanel = {
  element: HTMLElement;
  /** 中身の箱。区間の一覧・テロップの一覧・設定パネルをこの順に入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 全画面 / 動画ページ以外 /
   * 覚えた位置の読み込み前、のどれかなら隠す)。パネルは理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 畳んでいれば開く (設定を開いた・区間やテロップを足したとき) */
  reveal(): void;
  /** 本体の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
  /**
   * パネルの窓の枠。**位置と大きさ (place / rect) は youtube.ts が決める** (最初の位置・
   * 覚えた位置・取り直し)。出し入れは setVisible を使う
   */
  frame: FloatingWindow;
};

export type SidePanelOptions = {
  /** 見出しをドラッグして動かした・右下で大きさを変えた (指を離した時点で 1 回) */
  onUserMove?(rect: WindowRect): void;
  /** 見出しのダブルクリック (最初の位置に戻す) */
  onResetRequest?(): void;
};

/**
 * パネルの窓の最初の位置 (spec A.2: 今の右側パネルと同じ)。右端から EDGE_GAP_PX、ヘッダーの
 * 下 TOP_GAP_PX、幅 WIDTH_PX。**高さは決めない** (中身まで伸び、画面の下端から 16px で止まる)
 */
export function initialPanelRect(viewport: Viewport): WindowRect {
  return {
    left: viewport.width - EDGE_GAP_PX - WIDTH_PX,
    top: MASTHEAD_HEIGHT_PX + TOP_GAP_PX,
    width: WIDTH_PX,
  };
}

export function createSidePanel(options: SidePanelOptions = {}): SidePanel {
  const frame = createFloatingWindow({
    id: SIDE_PANEL_ID,
    title: "yt-clip",
    resize: "both",
    minWidth: MIN_WIDTH_PX,
    minHeight: MIN_HEIGHT_PX,
    onUserMove: (rect) => options.onUserMove?.(rect),
    onResetRequest: () => options.onResetRequest?.(),
  });
  const { element, body, headerActions } = frame;
  // 見出しのある窓は必ず見出しの箱を持つ。無ければ floating-window.ts の不具合なので隠さない
  if (headerActions === null) throw new Error("パネルの窓に見出しの箱がありません");

  body.id = SIDE_PANEL_BODY_ID;
  body.style.cssText = SIDE_PANEL_STYLE.body;

  const collapseButton = document.createElement("button");
  collapseButton.dataset.role = "collapse";
  collapseButton.style.cssText = SIDE_PANEL_STYLE.collapseButton;
  headerActions.append(collapseButton);

  // 作った直後から今の右側パネルと同じ所に置く。youtube.ts も出すときに置き直す
  frame.place(initialPanelRect({ width: window.innerWidth, height: window.innerHeight }));

  /**
   * 畳んでいるか。**タブを開いている間だけ覚える** (保存しない)。保存すると
   * 「パネルが出ない」という相談の原因になりやすく、得るものが小さい
   */
  let collapsed = false;

  /**
   * 本体の出し入れは `hidden` と `style.display` の両方で行う。**`hidden` だけに頼らない。**
   * 本体は flex で並べるので display を持つ。inline の display は UA の
   * `[hidden] { display: none }` に勝ち、`hidden` を立てても出たままになる。
   * `hidden` は外から「畳んでいるか」を読むため (と、窓の枠が高さを外すため) に残す
   */
  function show(target: HTMLElement, visible: boolean): void {
    target.hidden = !visible;
    target.style.display = visible ? "flex" : "none";
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    show(body, !next);
    // 開いているときは ▶ (押すと右へ畳む)、畳んでいるときは ◀ (押すと左へ開く)
    collapseButton.textContent = next ? "◀" : "▶";
    collapseButton.title = next ? "開く" : "畳む";
    collapseButton.setAttribute("aria-expanded", next ? "false" : "true");
    // 窓の枠は、置くときに本体の出し入れを見て高さを外す (畳んだ窓に空の枠を残さない)。
    // 高さを決めた窓でも見出しだけになるよう、今の位置のまま置き直す
    frame.place(frame.rect());
  }

  collapseButton.addEventListener("click", () => setCollapsed(!collapsed));
  setCollapsed(false);

  return {
    element,
    body,
    frame,

    setVisible(visible): void {
      frame.setVisible(visible);
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
      frame.destroy();
    },
  };
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/side-panel.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: PASS (side-panel は既存 17 件のうち 1 件を書き換え、7 件増えて 24 件)

- [ ] **Step 7: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS。`tests/content/youtube.test.ts` の「右側のパネル」「足した行をパネルの見える範囲に入れる」も
変えずに通る (パネルの `element` / `body` の id と出し入れの読み方は同じ)

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/side-panel.ts src/content/styles.ts tests/content/side-panel.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
refactor(content): 右側パネルをフロートの窓の上に作り直す

見出し・地・影・重なり順は窓の枠に任せ、パネルは中身の箱と折り畳み
だけを持つ。SidePanel の API は変えず、位置を置くための枠 (frame) と
最初の位置 (initialPanelRect) を足す。高さを決めた窓でも畳めば見出し
だけになるよう、畳むたびに置き直す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: バーを窓に移し、2 つの窓を配線する (`youtube.ts`)

**Files:**
- Modify: `src/content/youtube.ts`
- Modify: `src/content/styles.ts` (`BAR_STYLE.root` と `BAR_STYLE.grip`)
- Modify: `src/content/selectors.ts` (`mountAnchor` のコメントだけ)
- Test: `tests/content/youtube.test.ts`
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes: `createFloatingWindow` / `FloatingWindow` / `WindowRect` (Task 3)、`createSidePanel(options)` / `initialPanelRect` / `SidePanel.frame` (Task 4)、`loadWindowLayout` / `saveWindowRect` / `clearWindowRect` / `initialBarRect` / `WindowId` (Task 2)
- Produces:
  - DOM: バーの窓の枠 `#yt-clip-bar-window` (body の直下)。中身の根 `#yt-clip-bar` はその本体の中。操作の行の左端につまみ `[data-role='grip']` (文言 `⠿`)。`#below` には何も置かない
  - `youtube.ts` の内部関数 (Task 6 が使う): `placeInitial(id: WindowId): void` (動かしていない窓を最初の位置に置く。読み込み前は何もしない)、`refreshWindows(): void` (旧 `refreshSidePanel`。2 つの窓の出し入れを決める唯一の場所)
  - 覚えた位置: `chrome.storage.local` の `windowLayout` を起動時に 1 回読む。済むまで 2 つの窓を出さない。ドラッグで動かしたら保存、掴む場所のダブルクリックで最初の位置に戻して消す
  - `BAR_STYLE.grip` (styles.ts)

**このタスクで入れない:** 最初の位置を取り直すきっかけのうち、`window` の `resize` とプレイヤーの ResizeObserver は Task 6。
このタスクでは「隠れていた窓を出すとき」と「ダブルクリックで戻すとき」にだけ最初の位置へ置く。

- [ ] **Step 1: 見た目のテストを足す**

`tests/content/styles.test.ts` の末尾に次を足す。

```typescript
describe("バーの窓", () => {
  test("中身の根は縁も外の余白も持たない (窓の枠が持つ。2 重にしない)", () => {
    expect(BAR_STYLE.root).not.toContain("border:");
    expect(BAR_STYLE.root).not.toContain("margin:");
  });

  test("つまみは掴めることが分かるカーソルで、文字を選ばせない", () => {
    expect(BAR_STYLE.grip).toContain("cursor:move");
    expect(BAR_STYLE.grip).toContain("user-select:none");
    expect(BAR_STYLE.grip).toContain("touch-action:none");
  });
});
```

- [ ] **Step 2: `youtube.test.ts` の土台を窓に合わせる**

(a) `chrome.storage.local` の stub と、覚えた位置の読み込みを止めておく仕掛けを足す。247〜251 行目付近の
`changeSettings` の定義

```typescript
/** 別のタブで設定が変わったことを届ける */
function changeSettings(next: Record<string, unknown>): void {
  storedSettings = next;
  storageListener?.({ settings: { newValue: next } }, "sync");
}
```

の**直後**に次を足す。

```typescript
/** chrome.storage.local の windowLayout (覚えた窓の位置)。読み込み時の値は beforeAll で入れる */
let storedLayout: unknown = undefined;
/** chrome.storage.local へ書いた windowLayout。書いた順 */
let layoutWrites: unknown[] = [];
/**
 * 読み込み時の windowLayout の読み込みを止めておく。beforeAll が離す。
 * 止めている間に「窓がまだ出ていない」ことを確かめる
 */
let releaseLayout: () => void = () => undefined;
const layoutGate = new Promise<void>((resolve) => {
  releaseLayout = resolve;
});
/** 読み込み時に覚えていた窓の位置。この位置で出ることを確かめる (jsdom の画面 1024x768 に収まる値) */
const LAYOUT_AT_LOAD = {
  bar: { left: 40, top: 500, width: 700 },
  panel: { left: 300, top: 120, width: 360, height: 400 },
};
```

`installGlobals` の `storage:` の `sync: { … },` (339〜343 行目付近)

```typescript
      sync: {
        get: (): Promise<Record<string, unknown>> =>
          Promise.resolve({ settings: storedSettings }),
        set: (): Promise<void> => Promise.resolve(),
      },
```

の**直後**に次を足す。

```typescript
      // 窓の位置 (window-layout.ts)。読み込み時の 1 回は layoutGate が離されるまで返さない
      local: {
        get: async (): Promise<Record<string, unknown>> => {
          await layoutGate;
          return storedLayout === undefined ? {} : { windowLayout: storedLayout };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          storedLayout = items.windowLayout;
          layoutWrites.push(items.windowLayout);
        },
      },
```

`installGlobals` の中、`// プレビュー (telop-preview.ts) のため。` のコメントの**直前**に次を足す (`vi.stubGlobal("chrome", { … });` の後。`});` は複数並ぶので、このコメントを目印にする)。

```typescript

  // jsdom は Pointer Capture を持たない (窓のドラッグ floating-window.ts が呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
```

(b) 探し方の補助を足す。502〜508 行目付近の `settingsRoot()` の定義

```typescript
/** 設定パネルの根。最初の項目 (モード) の入力欄 → 項目の枠 → 根 */
function settingsRoot(): HTMLElement {
  const root = document.getElementById("yt-clip-setting-mode")?.parentElement
    ?.parentElement;
  if (root == null) throw new Error("設定パネルが見つかりません");
  return root;
}
```

の**直後**に次を足す。

```typescript
/** バーの窓の枠 (外形)。中身の根 #yt-clip-bar はこの中にある */
function barWindowElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar-window");
  if (element === null) throw new Error("バーの窓が見つかりません");
  return element;
}

/** バーの窓を動かすつまみ (⠿)。操作の行の左端にある */
function barGrip(): HTMLElement {
  const grip = barElement().querySelector<HTMLElement>("[data-role='grip']");
  if (grip === null) throw new Error("つまみが見つかりません");
  return grip;
}

/** パネルの窓の見出し (掴んで動かす所) */
function panelHeader(): HTMLElement {
  const header = panelElement().querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("パネルの見出しが見つかりません");
  return header;
}

/** 位置と大きさを決め打ちした箱 (rectAt は左 0・幅 400 に固定なので別に持つ) */
function boxAt(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

/** (100, 100) で押し、dx / dy だけ動かして離す */
function drag(target: Element, dx: number, dy: number): void {
  pointer(target, "pointerdown", 100, 100);
  pointer(target, "pointermove", 100 + dx, 100 + dy);
  pointer(target, "pointerup", 100 + dx, 100 + dy);
}

function dblclick(target: Element): void {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

/** 窓の枠に当てた位置と大きさ */
function styleRect(element: HTMLElement): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: element.style.left,
    top: element.style.top,
    width: element.style.width,
    height: element.style.height,
  };
}

/** プレイヤーの画面上の位置とバーの窓の高さを決め打ちする。ほかの要素は 0 */
function placePlayer(
  player: { left: number; top: number; width: number; height: number },
  barHeight: number,
) {
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.id === "movie_player") {
        return boxAt(player.left, player.top, player.width, player.height);
      }
      if (this.id === "yt-clip-bar-window") return boxAt(0, 0, 0, barHeight);
      return boxAt(0, 0, 0, 0);
    });
}
```

(c) 読み込み時の窓を捕まえる。535 行目付近の

```typescript
/** 読み込み時の問い合わせに応答が返った後の画面 */
let restoredAtLoad = {
  status: "",
  hasOverlay: false,
  pointerEvents: "",
  labels: [] as string[],
};
```

の**直後**に次を足す。

```typescript
/** 覚えた位置を読み込む前の窓 (設定を開いてパネルに中身がある状態) */
let windowsBeforeLayout = { barHidden: false, panelHidden: false };
/** 覚えた位置を読み込んだ後の窓 */
let windowsAfterLayout = {
  barHidden: true,
  panelHidden: true,
  bar: { left: "", top: "", width: "", height: "" },
  panel: { left: "", top: "", width: "", height: "" },
};
```

`beforeAll` (537〜558 行目付近) の

```typescript
  swState = { kind: "ready", segments: [RANGE], telops: [], meta: META_A };

  // chrome を用意してから読み込む。import 時に listener と observer を張る
  await import("@/content/youtube");
```

を次に置き換える。

```typescript
  swState = { kind: "ready", segments: [RANGE], telops: [], meta: META_A };
  // 前に動かした窓の位置を覚えている場面を再現する
  storedLayout = LAYOUT_AT_LOAD;

  // chrome を用意してから読み込む。import 時に listener と observer を張る
  await import("@/content/youtube");
```

同じ `beforeAll` の末尾

```typescript
  restoredAtLoad = {
    status: statusText(),
    hasOverlay: overlay() !== null,
    pointerEvents: rangeBarElement().style.pointerEvents,
    labels: handleLabels(),
  };
});
```

を次に置き換える。

```typescript
  restoredAtLoad = {
    status: statusText(),
    hasOverlay: overlay() !== null,
    pointerEvents: rangeBarElement().style.pointerEvents,
    labels: handleLabels(),
  };

  // 覚えた窓の位置の読み込みは layoutGate で止めてある。設定を開いてパネルに中身が
  // ある状態にしても、読み込みが済むまではどちらの窓も出ない (最初の位置から跳ぶ絵にしない)
  clickButton("⚙");
  windowsBeforeLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
  };
  releaseLayout();
  await flush();
  windowsAfterLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
    bar: styleRect(barWindowElement()),
    panel: styleRect(panelElement()),
  };
  // 設定を閉じて、以降のテストを閉じた状態から始める
  clickButton("⚙");
});
```

(d) テストごとにバーを作り直させる。`beforeEach` (566〜568 行目付近) の

```typescript
beforeEach(async () => {
  history.pushState({}, "", "/watch?v=video-a");
  buildPage();
```

を次に置き換える。

```typescript
beforeEach(async () => {
  history.pushState({}, "", "/watch?v=video-a");
  // バーの中身は body 直下の窓の中にあり、buildPage で body を空にしても窓ごと付け直されて
  // 残る (以前は #below と一緒に消えていた)。前のテストの状態の文言・設定の開閉を持ち越さない
  // よう、中身の根を外して作り直させる
  document.getElementById("yt-clip-bar")?.remove();
  buildPage();
```

`describe("最大秒数の設定")` の「作り直されたバーにも設定した上限が効く」(1142〜1145 行目付近) の

```typescript
    // 再描画を起こしてバーを作り直させる
    buildPage();
```

を次に置き換える。

```typescript
    // 再描画を起こしてバーを作り直させる。バーの中身は body 直下の窓の中にあり、
    // body を作り直しても窓ごと付け直されて残るので、中身の根を外しておく
    barElement().remove();
    buildPage();
```

(e) `afterAll` のコメント (611〜614 行目付近)

```typescript
  // 空にした body を mount() が拾ってパネルを付け直す。jsdom は破棄のときに
  // body.innerHTML = "" をするので、パネルが残っているとその DOM 変化が破棄後に
  // 配られる。パネルを外すだけだと mount() がまた付け直すので、observer が見て
  // いない空の body に差し替えて、破棄のときに外すものを無くす
```

を次に置き換える (コードは変えない)。

```typescript
  // 空にした body を mount() が拾って 2 つの窓 (バーとパネル) を付け直す。jsdom は破棄の
  // ときに body.innerHTML = "" をするので、窓が残っているとその DOM 変化が破棄後に
  // 配られる。窓を外すだけだと mount() がまた付け直すので、observer が見て
  // いない空の body に差し替えて、破棄のときに外すものを無くす
```

- [ ] **Step 3: 窓の失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾 (`describe("足した行をパネルの見える範囲に入れる", …)` の後) に次を足す。

```typescript
describe("フロートの窓", () => {
  // 読み込み時に覚えた位置 (LAYOUT_AT_LOAD) で出ているので、最初の位置に戻してから始める
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
    layoutWrites = [];
  });

  test("バーの窓とパネルの窓が body の直下に 1 つずつある", () => {
    expect(barWindowElement().parentElement).toBe(document.body);
    expect(panelElement().parentElement).toBe(document.body);
    expect(document.querySelectorAll("#yt-clip-bar-window").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-panel").length).toBe(1);
    // バーの中身 (拡大バーと操作の行) は窓の中
    expect(barWindowElement().contains(barElement())).toBe(true);
  });

  test("#below には何も置かない", () => {
    const below = document.getElementById("below");
    if (below === null) throw new Error("#below がありません");
    expect(below.children.length).toBe(0);
  });

  test("覚えた位置を読み込むまで、設定を開いていても窓を出さない", () => {
    expect(windowsBeforeLayout).toEqual({ barHidden: true, panelHidden: true });
  });

  test("覚えた位置で出る", () => {
    expect(windowsAfterLayout).toEqual({
      barHidden: false,
      panelHidden: false,
      bar: { left: "40px", top: "500px", width: "700px", height: "" },
      panel: { left: "300px", top: "120px", width: "360px", height: "400px" },
    });
  });

  test("バーの窓の最初の位置はプレイヤーの直下 (左端を揃え、幅はプレイヤーの幅、8px 空ける)", () => {
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 450 }, 106);
    try {
      dblclick(barGrip());
      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("画面に収まらなければ、バーの窓を画面の下端から 16px に詰める", () => {
    // jsdom の画面は 1024x768。下端 700 のプレイヤーの下には 106px のバーが入らない
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 620 }, 106);
    try {
      dblclick(barGrip());
      // 768 - 16 - 106
      expect(barWindowElement().style.top).toBe("646px");
    } finally {
      spy.mockRestore();
    }
  });

  test("パネルの窓の最初の位置は右上 (右端から 16px・上 68px・幅 400px)", () => {
    expect(styleRect(panelElement())).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
      height: "",
    });
  });

  test("つまみをドラッグすると動き、指を離したときに 1 回だけ覚える", async () => {
    const frame = barWindowElement();
    const left = parseFloat(frame.style.left);
    const top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width);
    const grip = barGrip();

    pointer(grip, "pointerdown", 100, 100);
    pointer(grip, "pointermove", 130, 120);
    pointer(grip, "pointermove", 150, 130);
    await flush();
    // 動かしている間は覚えない
    expect(layoutWrites).toEqual([]);

    pointer(grip, "pointerup", 150, 130);
    await flush();
    expect(frame.style.left).toBe(`${left + 50}px`);
    expect(frame.style.top).toBe(`${top + 30}px`);
    expect(layoutWrites).toEqual([{ bar: { left: left + 50, top: top + 30, width } }]);
  });

  test("パネルの窓は見出しをドラッグすると動き、位置を覚える", async () => {
    clickButton("⚙");
    const frame = panelElement();
    const left = parseFloat(frame.style.left);

    drag(panelHeader(), -100, 20);
    await flush();

    expect(frame.style.left).toBe(`${left - 100}px`);
    expect(frame.style.top).toBe("88px");
    expect(layoutWrites).toEqual([{ panel: { left: left - 100, top: 88, width: 400 } }]);
  });

  test("つまみ・見出しをダブルクリックすると最初の位置に戻り、覚えた位置を消す", async () => {
    const spy = placePlayer({ left: 24, top: 80, width: 800, height: 450 }, 106);
    try {
      dblclick(barGrip());
      drag(barGrip(), 100, 50);
      drag(panelHeader(), -100, 20);
      await flush();
      expect(storedLayout).toEqual({
        bar: { left: 124, top: 588, width: 800 },
        panel: { left: window.innerWidth - 516, top: 88, width: 400 },
      });

      dblclick(barGrip());
      dblclick(panelHeader());
      await flush();

      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });
      expect(panelElement().style.left).toBe(`${window.innerWidth - 416}px`);
      expect(panelElement().style.top).toBe("68px");
      expect(storedLayout).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  test("モードを変えても窓を作り直さず、位置も変わらない。作り直したつまみでも動かせる", async () => {
    const frame = barWindowElement();
    drag(barGrip(), 30, 20);
    await flush();
    const placed = styleRect(frame);
    const oldGrip = barGrip();

    changeSettings({ mode: "edit" });
    await flush();

    expect(barWindowElement()).toBe(frame);
    expect(styleRect(frame)).toEqual(placed);
    // 中身は作り直した (＋ 区間を追加 が増えた)。つまみも新しい要素になる
    expect(barGrip()).not.toBe(oldGrip);
    drag(barGrip(), 10, 0);
    expect(frame.style.left).toBe(`${parseFloat(placed.left) + 10}px`);
  });

  test("最後に触った窓が上に来る", () => {
    pointer(barElement(), "pointerdown", 0, 0);
    expect(barWindowElement().style.zIndex).toBe("2001");
    expect(panelElement().style.zIndex).toBe("2000");

    pointer(panelBody(), "pointerdown", 0, 0);
    expect(panelElement().style.zIndex).toBe("2001");
    expect(barWindowElement().style.zIndex).toBe("2000");
  });

  test("全画面の間は 2 つとも隠し、抜けたら戻す", () => {
    clickButton("⚙");
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(barWindowElement().hidden).toBe(true);
      expect(panelElement().hidden).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);
  });

  test("動画ページ以外では 2 つとも隠す。戻れば出す", async () => {
    clickButton("⚙");

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();
    expect(barWindowElement().hidden).toBe(true);
    expect(panelElement().hidden).toBe(true);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();
    expect(barWindowElement().hidden).toBe(false);
    expect(panelElement().hidden).toBe(false);
  });

  test("隠れていた窓を出すときは、最初の位置を取り直す", () => {
    let playerBottom = 530;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(24, playerBottom - 450, 800, 450);
        return boxAt(0, 0, 0, 0);
      });
    try {
      dblclick(barGrip());
      expect(barWindowElement().style.top).toBe("538px");

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => video.element,
      });
      try {
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(barWindowElement().hidden).toBe(true);
        // 全画面の間にプレイヤーの位置が変わった
        playerBottom = 400;
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement");
      }
      document.dispatchEvent(new Event("fullscreenchange"));

      expect(barWindowElement().hidden).toBe(false);
      expect(barWindowElement().style.top).toBe("408px");
    } finally {
      spy.mockRestore();
    }
  });

  test("動かした窓は、出し直しても置いた場所のまま", async () => {
    let playerBottom = 530;
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(24, playerBottom - 450, 800, 450);
        return boxAt(0, 0, 0, 0);
      });
    try {
      dblclick(barGrip());
      drag(barGrip(), 30, -100);
      await flush();
      const placed = styleRect(barWindowElement());
      expect(placed.top).toBe("438px");

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => video.element,
      });
      try {
        document.dispatchEvent(new Event("fullscreenchange"));
        playerBottom = 400;
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement");
      }
      document.dispatchEvent(new Event("fullscreenchange"));

      expect(styleRect(barWindowElement())).toEqual(placed);
    } finally {
      spy.mockRestore();
    }
  });

  test("テーマを切り替えるとバーの窓の配色も変わる", async () => {
    // バーの窓は body の直下でページの外にある。配色は自分で持つ
    document.documentElement.setAttribute("dark", "");
    try {
      await flush();
      expect(barWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
    } finally {
      document.documentElement.removeAttribute("dark");
    }
    await flush();
    expect(barWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
  });
});
```

- [ ] **Step 4: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/styles.test.ts` (Bash の timeout 180000)
期待: FAIL。`beforeAll` の `barWindowElement()` が「バーの窓が見つかりません」で落ち、全件が失敗する
(styles は `BAR_STYLE.grip` が undefined、`BAR_STYLE.root` に `border:` がある)

- [ ] **Step 5: バーの見た目を直す**

`src/content/styles.ts` の 75〜77 行目付近

```typescript
export const BAR_STYLE = {
  root: `display:flex;flex-direction:column;gap:10px;padding:12px;margin:8px 0;border:1px solid var(--ytc-border);border-radius:12px;color:var(--ytc-text);font-family:${FONT};font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
```

を次に置き換える。

```typescript
export const BAR_STYLE = {
  /**
   * バーの中身の根 (#yt-clip-bar)。**縁・角・外の余白は持たない。** バーの窓
   * (floating-window.ts) の枠が持つ。ここにも縁を付けると枠が 2 重になる
   */
  root: `display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--ytc-text);font-family:${FONT};font-size:13px;`,
  row: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;",
  /**
   * 窓を動かすつまみ (⠿)。操作の行の左端に置く (spec A.1: バーの窓は見出しの行を作らない)。
   * 行の高さはボタン (36px) に揃える。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  grip: "cursor:move;user-select:none;touch-action:none;color:var(--ytc-text-sub);font-size:18px;line-height:36px;padding:0 2px;",
```

- [ ] **Step 6: `#below` のコメントを直す**

`src/content/selectors.ts` の 8〜13 行目

```typescript
  /**
   * 操作 UI を差し込む位置。プレイヤーの直下にあり、動画ページの間は残り続ける。
   * プレイヤー内部の操作列 (.ytp-right-controls) に入れると、列の高さに収まらず、
   * さらにマウスを外したときプレイヤーの UI ごと隠れてしまう
   */
  mountAnchor: "#below",
```

を次に置き換える。

```typescript
  /**
   * 動画ページのページができたかの目印。プレイヤーの直下にあり、動画ページの間は残り続ける。
   * **操作 UI はもうここに差し込まない** (body 直下のフロートの窓に入れる。
   * `.claude/specs/2026-09-24-floating-windows-design.md` A.3)。これが無い間に操作 UI を作ると、
   * タイトルもプレイヤーも読めないまま IN を押せてしまう
   */
  mountAnchor: "#below",
```

- [ ] **Step 7: `youtube.ts` を配線する**

(a) import。35 行目

```typescript
import { createSidePanel } from "@/content/side-panel";
```

を次に置き換える。

```typescript
import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import { createSidePanel, initialPanelRect } from "@/content/side-panel";
```

44 行目の `} from "@/content/telop-compositor";` の**直後**に次を足す。

```typescript
import {
  clearWindowRect,
  initialBarRect,
  loadWindowLayout,
  saveWindowRect,
  type WindowId,
} from "@/content/window-layout";
```

(b) 定数。74 行目の `const OVERLAY_ID = "yt-clip-overlay";` の**直後**に次を足す。

```typescript
/** バーの窓の枠。中身の根 (BAR_ID) はこの中に入れる */
const BAR_WINDOW_ID = "yt-clip-bar-window";
/** バーの窓の最小の幅 (spec A.1)。これより狭いと拡大バーの精度が出ず、操作の行も折り返す */
const BAR_MIN_WIDTH_PX = 480;
```

(c) 窓を作る。113〜122 行目

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
```

を次に置き換える。

```typescript
/**
 * 覚えた位置 (chrome.storage.local) の読み込みが済んだか。**済むまで 2 つの窓を出さない**
 * (spec A.2)。最初の位置に出してから覚えた位置へ跳ぶ絵にしない。読めなかったときも済んだ
 * 扱いにする (最初の位置で出す。出さないままにしない)
 */
let layoutReady = false;
/**
 * ユーザーが動かした (か、覚えた位置で出した) 窓。**動かした窓は最初の位置を取り直さない**
 * (spec A.2: 置いた場所から動かさない)。掴む場所のダブルクリックで戻すと外れる
 */
const movedWindows = new Set<WindowId>();
/**
 * 右側のパネル (パネルの窓)。区間の一覧・テロップの一覧・設定を入れる。
 *
 * **1 つを使い回す。** 畳んだ状態はタブを開いている間だけ覚える (右側パネルの spec §3) うえ、
 * 窓の位置も持つので、バーを作り直すたびに作り直さない。中身の入れ替えは `buildBar`、body への
 * 付け直しは `mount`、出すかの判定は `refreshWindows` が行う
 */
const sidePanel = createSidePanel({
  onUserMove: (rect) => rememberWindowRect("panel", rect),
  onResetRequest: () => resetWindow("panel"),
});
// パネルは body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
applyPalette(sidePanel.element, isDarkTheme());
/**
 * バーの窓。拡大バーと操作の行 (中身の根 #yt-clip-bar) を入れる。
 *
 * **1 つを使い回す** (spec A.3)。モードを変えてバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
 * (見出しの行ぶん高くなると、1440x795 でプレイヤーの下端を覆うため。spec A.1)
 */
const barWindow = createFloatingWindow({
  id: BAR_WINDOW_ID,
  resize: "width",
  minWidth: BAR_MIN_WIDTH_PX,
  onUserMove: (rect) => rememberWindowRect("bar", rect),
  onResetRequest: () => resetWindow("bar"),
});
// バーの窓も body の直下にあり、ページの配色は継がれない
applyPalette(barWindow.element, isDarkTheme());
```

(d) 出し入れと最初の位置。880〜895 行目の

```typescript
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
```

を次に置き換える。

```typescript
/** 窓の枠。id で引く (覚えた位置の鍵と同じ名前) */
function windowOf(id: WindowId): FloatingWindow {
  return id === "bar" ? barWindow : sidePanel.frame;
}

/**
 * 窓の最初の位置 (spec A.2)。バーはプレイヤーの直下、パネルは画面の右上。
 * プレイヤーがまだ無ければ null (出たときに取り直す)。
 *
 * **プレイヤーの画面上の位置をそのまま使う。** ページがスクロールされていても、今見えている
 * 位置の直下に置く (窓は画面に固定なので、ページの座標に直さない)。バーの高さは出ている窓で
 * 測る (隠れている窓は 0 になる。そのため出した直後に取り直す: refreshWindows)
 */
function initialWindowRect(id: WindowId): WindowRect | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (id === "panel") return initialPanelRect(viewport);
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === null) return null;
  const box = player.getBoundingClientRect();
  return initialBarRect(
    { left: box.left, bottom: box.bottom, width: box.width },
    barWindow.element.getBoundingClientRect().height,
    viewport,
  );
}

/** 動かしていない窓を最初の位置に置く。覚えた位置の読み込みが済む前は何もしない (まだ出さない) */
function placeInitial(id: WindowId): void {
  if (!layoutReady || movedWindows.has(id)) return;
  const rect = initialWindowRect(id);
  if (rect !== null) windowOf(id).place(rect);
}

/** ユーザーが窓を動かした・大きさを変えた (指を離した時点で 1 回)。次に開いたときも同じ位置に出す */
function rememberWindowRect(id: WindowId, rect: WindowRect): void {
  movedWindows.add(id);
  void saveWindowRect(id, rect).catch((error: unknown) => {
    // 覚えられないだけで、今の画面の窓は置いた場所にある。次に開くと最初の位置に戻る
    console.warn(`窓の位置を保存できませんでした: ${String(error)}`);
  });
}

/** 掴む場所のダブルクリック。最初の位置に戻し、覚えた位置も消す (spec A.2) */
function resetWindow(id: WindowId): void {
  movedWindows.delete(id);
  placeInitial(id);
  void clearWindowRect(id).catch((error: unknown) => {
    // 消せないと、次に開いたときに戻す前の位置で出る。今の画面の窓は戻っている
    console.warn(`窓の位置を消せませんでした: ${String(error)}`);
  });
}

/**
 * 2 つの窓 (バーの窓・パネルの窓) を出すか隠すかを決める。**`setVisible` を呼ぶのはここだけ**
 * (右側パネルの spec §4 を 2 つの窓へ広げた。spec A.1)。
 *
 * どちらも隠すのは、覚えた位置を読み込む前 / 全画面 / 動画ページ以外。パネルはさらに中身が
 * 無いときも隠す。中身があるかは各部品の `hidden` で見る (一覧は区間が無いと自分で隠れ、
 * 設定は ⚙ で開閉する)。バーは中身の根 (BAR_ID) がまだ無い間は出さない
 */
function refreshWindows(): void {
  const parts = [segmentList?.element, telopList?.element, settingsPanel?.element];
  const hasContent = parts.some((part) => part !== undefined && !part.hidden);
  // **`!= null` にする。** jsdom は fullscreenElement を持たず undefined を返すので、
  // `!== null` だとテストで常に全画面扱いになる。body 直下の fixed 要素は全画面の
  // 動画の上に残りうるので、全画面では出さない
  const fullscreen = document.fullscreenElement != null;
  const onVideoPage = currentVideoId() !== null;
  // 覚えた位置を読む前に出すと、最初の位置に出てから覚えた位置へ跳ぶ絵になる (spec A.2)
  const canShow = layoutReady && !fullscreen && onVideoPage;

  const barWasHidden = barWindow.element.hidden;
  const panelWasHidden = sidePanel.element.hidden;
  barWindow.setVisible(canShow && document.getElementById(BAR_ID) !== null);
  sidePanel.setVisible(canShow && hasContent);
  // 隠れていた窓は寸法が 0 で、最初の位置 (バーの高さで画面の下端に詰める) を測れていない。
  // **出した直後にだけ**取り直す。出ている間に状態が届くたびに取り直すと、ページを
  // スクロールした後に IN を押しただけで、バーがプレイヤーを追って跳ぶ (spec A.2)
  if (barWasHidden && !barWindow.element.hidden) placeInitial("bar");
  if (panelWasHidden && !sidePanel.element.hidden) placeInitial("panel");
}
```

(e) 呼び出し側の名前を替える。`refreshLists` (901〜908 行目付近) の最後の行

```typescript
  telopList?.update(telops, segments);
  refreshSidePanel();
}
```

を次に置き換える。

```typescript
  telopList?.update(telops, segments);
  refreshWindows();
}
```

`revealLastRow` の doc (914 行目付近)

```typescript
 * パネルが隠れている (全画面など) ときは何もしない。出す判断は `refreshSidePanel` のもの
```

を次に置き換える。

```typescript
 * パネルが隠れている (全画面など) ときは何もしない。出す判断は `refreshWindows` のもの
```

`applyMode` のコメント (451 行目付近)

```typescript
  // 開いていたなら、⚙ と同じ経路 (開く → refreshSidePanel → reveal → scrollTo)
```

を次に置き換える。

```typescript
  // 開いていたなら、⚙ と同じ経路 (開く → refreshWindows → reveal → scrollTo)
```

`onToggleSettings` (1409〜1410 行目付近) の

```typescript
  settingsPanel.toggle();
  refreshSidePanel();
```

を次に置き換える。

```typescript
  settingsPanel.toggle();
  refreshWindows();
```

(f) つまみ。`buildBar` の 1423〜1424 行目付近

```typescript
  const row = document.createElement("div");
  row.style.cssText = BAR_STYLE.row;
```

の**直後**に次を足す。

```typescript

  // 窓を動かすつまみ。**見出しの行は作らない** (バーが高くなるとプレイヤーを覆う。spec A.1)。
  // 操作の行は作り直すたびに新しくなるので、ここで毎回窓に登録し直す (古いつまみは行ごと捨てる)
  const grip = document.createElement("span");
  grip.dataset.role = "grip";
  grip.textContent = "⠿";
  grip.title = "ドラッグで動かす (ダブルクリックで最初の位置へ)";
  grip.style.cssText = BAR_STYLE.grip;
  barWindow.addDragHandle(grip);
```

同じ `buildBar` の 1458〜1460 行目付近

```typescript
  // 「追加してから頭と尻を決める」順に並べる
  if (addButton !== null) row.append(addButton);
  row.append(inButton, outButton, playButton, actions, status, settingsButton);
```

を次に置き換える。

```typescript
  // つまみは左端。その後は「追加してから頭と尻を決める」順に並べる
  row.append(grip);
  if (addButton !== null) row.append(addButton);
  row.append(inButton, outButton, playButton, actions, status, settingsButton);
```

同じ `buildBar` の 1507〜1509 行目付近のコメント

```typescript
  // バーは拡大バー → 操作の行だけ。拡大バーは幅がそのまま精度になるので、
  // プレイヤー直下に残す (spec §1)
  bar.append(rangeBar.element, row);
```

を次に置き換える。

```typescript
  // バーは拡大バー → 操作の行だけ。拡大バーは幅がそのまま精度になるので、パネルの幅には
  // 縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の spec A.1)
  bar.append(rangeBar.element, row);
```

(g) `mount`。1540〜1560 行目付近

```typescript
function mount(): void {
  // パネルは body の直下に置く (#below の中だと YouTube の再描画でバーと一緒に外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられるとパネルだけが外れる
  if (sidePanel.element.parentElement !== document.body) {
    document.body.append(sidePanel.element);
  }
  if (document.getElementById(BAR_ID) !== null) return;

  const anchor = document.querySelector(YT_SELECTORS.mountAnchor);
  if (anchor === null) return; // 動画ページ未生成。次の observe で再試行する

  // 前のバーが YouTube の再描画で外されていることがある。参照だけ差し替えると
  // rAF とリスナを抱えた古いインスタンスが解放されないまま残る
  const previousBar = rangeBar;
  // buildBar が rangeBar を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();

  // 先頭に入れてプレイヤーのすぐ下に置く。タイトルより下だと、操作するたびに
  // 画面をスクロールして動画と往復することになる
  anchor.insertBefore(bar, anchor.firstChild);
```

を次に置き換える (その後の「// 監視は 1 度だけ張る。」から関数の終わりまでは変えない)。

```typescript
function mount(): void {
  // 2 つの窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられると窓だけが外れる
  for (const frame of [barWindow.element, sidePanel.element]) {
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
  if (document.getElementById(BAR_ID) !== null) return;

  // #below にはもう何も置かないが、「動画ページのページができたか」の目印として見続ける
  // (spec A.3)。まだ無い間にバーを作ると、タイトルもプレイヤーも読めないまま IN を押せる
  const anchor = document.querySelector(YT_SELECTORS.mountAnchor);
  if (anchor === null) return; // 動画ページ未生成。次の observe で再試行する

  // 前のバーが外されていることがある (モードの切り替え)。参照だけ差し替えると
  // rAF とリスナを抱えた古いインスタンスが解放されないまま残る
  const previousBar = rangeBar;
  // buildBar が rangeBar を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();

  // 窓の中身だけを入れ替える。窓は作り直さないので、位置も大きさも変わらない (spec A.3)
  barWindow.body.replaceChildren(bar);
```

(h) 覚えた位置の読み込み。1692〜1702 行目付近の `loadInitialSettings` の定義の**直後**に次を足す。

```typescript

/**
 * 起動時に覚えた窓の位置を読む。**済むまで窓を出さない** (refreshWindows が layoutReady を見る)。
 *
 * 覚えた位置も画面に収まるよう詰めてから使う (place が詰める。大きい画面で覚えた位置を
 * 小さい画面で開いたとき)。読めなくても最初の位置で出す (loadWindowLayout は失敗を warn して
 * 空を返す。spec A.2)
 */
function loadInitialLayout(): void {
  void loadWindowLayout()
    .then((layout) => {
      for (const id of ["bar", "panel"] as const) {
        const rect = layout[id];
        if (rect === undefined) continue;
        movedWindows.add(id);
        windowOf(id).place(rect);
      }
    })
    .catch((error: unknown) => {
      // 窓を置けないのは想定外。それでも出さないままにはしない (spec A.2)
      console.warn(`覚えた窓の位置を使えませんでした: ${String(error)}`);
    })
    .finally(() => {
      layoutReady = true;
      refreshWindows();
    });
}
```

(i) テーマ。1724〜1730 行目付近

```typescript
const themeObserver = new MutationObserver(() => {
  const dark = isDarkTheme();
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // パネルは body の直下でバーの外にある。バーの配色は継がれない
  applyPalette(sidePanel.element, dark);
});
```

を次に置き換える。

```typescript
const themeObserver = new MutationObserver(() => {
  const dark = isDarkTheme();
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // 2 つの窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(sidePanel.element, dark);
});
```

(j) 全画面。1736〜1737 行目付近

```typescript
// 全画面の間はパネルを隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
document.addEventListener("fullscreenchange", refreshSidePanel);
```

を次に置き換える。

```typescript
// 全画面の間は 2 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
document.addEventListener("fullscreenchange", refreshWindows);
```

(k) SPA 遷移のコメント。1749〜1751 行目付近

```typescript
    // 一覧も同じ規則で描き直す。固定のパネルに A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、パネルごと隠れる (refreshSidePanel)
    refreshLists();
```

を次に置き換える。

```typescript
    // 一覧も同じ規則で描き直す。固定のパネルに A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、2 つの窓ごと隠れる (refreshWindows)
    refreshLists();
```

(l) 起動。ファイルの末尾

```typescript
mount();
loadInitialSettings();
recoverFromState();
```

を次に置き換える。

```typescript
mount();
loadInitialSettings();
loadInitialLayout();
recoverFromState();
```

(m) 名前の置き換え漏れを確かめる。

実行: `grep -n 'refreshSidePanel\|anchor.insertBefore' src/content/youtube.ts` (Bash の timeout 30000)
期待: 何も出ない

- [ ] **Step 8: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/styles.test.ts` (Bash の timeout 180000)
期待: PASS (youtube は既存の全件と「フロートの窓」の 17 件)

- [ ] **Step 9: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 10: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts src/content/styles.ts src/content/selectors.ts tests/content/youtube.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): バーを動かせる窓に移し、窓の位置を覚える

拡大バーと操作の行を body 直下のバーの窓に入れ、#below には何も
置かない (動画ページができたかの目印としてだけ見る)。操作の行の左端の
つまみで動かし、位置は chrome.storage.local に覚えて、掴む場所の
ダブルクリックで最初の位置に戻す。覚えた位置の読み込みが済むまで
窓を出さず、最初の位置は隠れていた窓を出すときにだけ取り直す (状態が
届くたびに取り直すと、スクロールした後にバーが跳ぶため)。全画面と
動画ページ以外では 2 つの窓とも隠す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: 動かしていない窓の最初の位置を取り直すきっかけ (resize とプレイヤーの大きさ)

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `placeInitial(id: WindowId)` (Task 5)、`YT_SELECTORS.player` (`#movie_player`)
- Produces: `window` の `resize` と `#movie_player` の大きさの変化 (ResizeObserver) で、動かしていない 2 つの窓を最初の位置に置き直す。
  **スクロールでは置き直さない。** プレイヤーの要素が替わったら (SPA 遷移・再描画) 新しい要素を見直す

- [ ] **Step 1: ResizeObserver の stub を、見ている要素を覚える形にする**

`tests/content/youtube.test.ts` の `installGlobals` の 385〜393 行目付近

```typescript
  // プレビュー (telop-preview.ts) のため。jsdom は ResizeObserver を持たず、
  // canvas も描けない (getContext は "Not implemented" を出して null を返す)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
```

を次に置き換える。

```typescript
  // プレビュー (telop-preview.ts) と、プレイヤーの大きさの変化で窓を置き直す (youtube.ts) ため。
  // jsdom は ResizeObserver を持たず、canvas も描けない (getContext は "Not implemented" を
  // 出して null を返す)。見ている要素を覚えておき、resizeElement で大きさの変化を起こす
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly entry: { callback: () => void; targets: Set<Element> };
      constructor(callback: () => void) {
        this.entry = { callback, targets: new Set() };
        resizeObservers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.add(target);
      }
      unobserve(target: Element): void {
        this.entry.targets.delete(target);
      }
      disconnect(): void {
        this.entry.targets.clear();
      }
    },
  );
```

`installGlobals` の定義 (`function installGlobals(): void {`) の**直前**に次を足す。

```typescript
/** ResizeObserver の stub が見ている要素と、大きさが変わったときに呼ぶもの */
const resizeObservers: { callback: () => void; targets: Set<Element> }[] = [];

/** target を見ている ResizeObserver に、大きさが変わったことを届ける */
function resizeElement(target: Element): void {
  for (const entry of resizeObservers) {
    if (entry.targets.has(target)) entry.callback();
  }
}
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾 (Task 5 で足した `describe("フロートの窓", …)` の後) に次を足す。

```typescript
describe("動かしていない窓の最初の位置を取り直す", () => {
  /** プレイヤーの画面上の位置を、テストの途中で変えられるように決め打ちする */
  function stubPlayer(initial: { left: number; top: number; width: number; height: number }) {
    const box = { ...initial };
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "movie_player") return boxAt(box.left, box.top, box.width, box.height);
        if (this.id === "yt-clip-bar-window") return boxAt(0, 0, 0, 106);
        return boxAt(0, 0, 0, 0);
      });
    return { box, spy };
  }

  function player(): HTMLElement {
    const element = document.getElementById("movie_player");
    if (element === null) throw new Error("プレイヤーが見つかりません");
    return element;
  }

  // 読み込み時に覚えた位置 (LAYOUT_AT_LOAD) で出ているので、最初の位置に戻してから始める
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
  });

  test("ブラウザの大きさが変わると取り直す", () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(styleRect(barWindowElement())).toEqual({
        left: "24px",
        top: "538px",
        width: "800px",
        height: "",
      });

      box.left = 0;
      box.width = 900;
      box.height = 500;
      window.dispatchEvent(new Event("resize"));
      // 80 + 500 + 8
      expect(styleRect(barWindowElement())).toEqual({
        left: "0px",
        top: "588px",
        width: "900px",
        height: "",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("パネルの窓も画面の幅に合わせて取り直す", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    try {
      window.dispatchEvent(new Event("resize"));
      // 1440 - 16 - 400
      expect(panelElement().style.left).toBe("1024px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1024,
      });
      window.dispatchEvent(new Event("resize"));
    }
    expect(panelElement().style.left).toBe("608px");
  });

  test("プレイヤーの大きさが変わると取り直す (シアターモードの切り替えなど)", () => {
    // beforeEach の buildPage で作り直したプレイヤーを見ている (mount のたびに見直す)
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(barWindowElement().style.top).toBe("538px");

      box.height = 500;
      resizeElement(player());
      expect(barWindowElement().style.top).toBe("588px");
    } finally {
      spy.mockRestore();
    }
  });

  test("ページのスクロールでは取り直さない (窓は同じ画面位置に浮いたまま)", () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      expect(barWindowElement().style.top).toBe("538px");

      // ページを 200px 送った: プレイヤーは画面の上へ動く
      box.top = -120;
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
      expect(barWindowElement().style.top).toBe("538px");

      // 状態が届いても取り直さない (出ている間は置き直さない)
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(barWindowElement().style.top).toBe("538px");
    } finally {
      spy.mockRestore();
    }
  });

  test("スクロールした後に取り直すときは、プレイヤーの画面上の位置をそのまま使う", () => {
    // ページを 200px 送った状態 (プレイヤーの上端が画面の上へ 120px 出ている)
    const { spy } = stubPlayer({ left: 24, top: -120, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      // -120 + 450 + 8。ページの座標に直さない (窓は画面に固定)
      expect(barWindowElement().style.top).toBe("338px");
    } finally {
      spy.mockRestore();
    }
  });

  test("動かした窓は、ブラウザやプレイヤーの大きさが変わっても置いた場所のまま", async () => {
    const { box, spy } = stubPlayer({ left: 24, top: 80, width: 800, height: 450 });
    try {
      window.dispatchEvent(new Event("resize"));
      drag(barGrip(), 30, -100);
      await flush();
      const placed = styleRect(barWindowElement());
      expect(placed.top).toBe("438px");

      box.height = 500;
      window.dispatchEvent(new Event("resize"));
      resizeElement(player());

      expect(styleRect(barWindowElement())).toEqual(placed);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 180000)
期待: FAIL (取り直すきっかけが無いので、最初の `resize` の後もバーの窓の `top` は beforeEach で戻した `8px` のまま、
パネルの窓の `left` は `608px` のまま。6 件とも最初の検査で落ちる)

- [ ] **Step 4: 取り直すきっかけを足す**

`src/content/youtube.ts` の `function mount(): void {` の**直前**に次を足す。

```typescript
/**
 * 動かしていない窓を最初の位置に置き直す。**`window` の resize とプレイヤーの大きさの変化で
 * だけ呼ぶ** (spec A.2)。ページのスクロールでは呼ばない: 窓は画面に浮いたまま、コメント欄を
 * 読む間も同じ位置で操作できるようにする
 */
function placeUnmovedWindows(): void {
  placeInitial("bar");
  placeInitial("panel");
}

/** 大きさを見ているプレイヤー。**SPA 遷移や再描画で要素が替わる**ので、mount のたびに確かめる */
let observedPlayer: Element | null = null;
/** プレイヤーの大きさの変化 (シアターモードの切り替えなど) を拾う */
const playerObserver = new ResizeObserver(() => placeUnmovedWindows());

function watchPlayerSize(): void {
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === observedPlayer) return;
  playerObserver.disconnect();
  observedPlayer = player;
  if (player !== null) playerObserver.observe(player);
}
```

`mount` の冒頭 (Task 5 で置き換えた部分) の

```typescript
  for (const frame of [barWindow.element, sidePanel.element]) {
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
  if (document.getElementById(BAR_ID) !== null) return;
```

を次に置き換える。

```typescript
  for (const frame of [barWindow.element, sidePanel.element]) {
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
  // **バーの有無より先に見る。** バーを作り直さなくても、プレイヤーの要素だけが替わることがある
  watchPlayerSize();
  if (document.getElementById(BAR_ID) !== null) return;
```

Task 5 で書き換えた全画面の行

```typescript
// 全画面の間は 2 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
document.addEventListener("fullscreenchange", refreshWindows);
```

の**直後**に次を足す。

```typescript

// ブラウザの大きさが変わったら、動かしていない窓の最初の位置を取り直す (spec A.2)。
// 動かした窓は置いた場所のまま (画面の外へ出る分は窓の枠が自分で詰める)
window.addEventListener("resize", placeUnmovedWindows);
```

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 180000)
期待: PASS (「動かしていない窓の最初の位置を取り直す」の 6 件を含む全件)

- [ ] **Step 6: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 動かしていない窓はブラウザとプレイヤーの大きさで置き直す

シアターモードの切り替えやブラウザの大きさの変更でプレイヤーが動くと、
最初の位置のままのバーの窓がプレイヤーから離れる。window の resize と
プレイヤーの ResizeObserver で取り直す。スクロールでは取り直さない
(窓は画面に浮いたまま、コメント欄を読む間も操作できるようにする)。
動かした窓は置いた場所のまま。プレイヤーの要素が替わったら見直す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: E2E に受け入れ条件と窓の操作の確認を足す

**Files:**
- Modify: `e2e/telop-check.spec.ts`

**Interfaces:**
- Consumes: `#yt-clip-bar-window` / `[data-role=grip]` (Task 5)、`#yt-clip-panel` / `[data-role=window-header]` / `[data-role=window-resize]` (Task 3・4)、`chrome.storage.local` の `windowLayout` (Task 2)、最初の位置の決め方 (プレイヤーの下端 + 8px、収まらなければ画面の下端から 16px。パネルは右 16px・上 68px・幅 400px)
- Produces: `npm run check:telop` の結果 (`test-results/telop-check/results.json`) の項目が 17 → 21 になる
  - 書き換え: `受け入れ条件 1440x795: バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする` (旧 `受け入れ条件 1440x795: バーとパネルが画面に収まり、パネルの中でスクロールする`)
  - 追加: `窓を動かすと、読み込み直しても同じ位置に出る` / `右下をドラッグすると大きさが変わる (バーの窓は幅だけ)` /
    `窓を画面の外へドラッグしても、掴む場所が画面に残る` / `掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える`

**このタスクの実装担当は `npm run check:telop` を走らせない。** 実機 (Google Chrome の起動と YouTube) で 15 分かかりうるので、
Task 9 で controller が走らせて結果を見る。ここでは型が通るところまで。

既存の項目で変えるのは受け入れ条件の 1 項目だけ (「既存テストの洗い出し」参照)。`bar` (`#yt-clip-bar`) はボタンを探すのに使い続ける。
新しい項目は**受け入れ条件の後** (1920x1080 に戻した後) に置く。動かした位置は `chrome.storage.local` に残るので、
最後の項目でダブルクリックして最初の位置へ戻し、覚えた位置も消す。

- [ ] **Step 1: import に Locator を足す**

`e2e/telop-check.spec.ts` の 1〜8 行目

```typescript
import {
  chromium,
  type Browser,
  expect,
  test,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
```

を次に置き換える。

```typescript
import {
  chromium,
  type Browser,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Worker,
} from "@playwright/test";
```

- [ ] **Step 2: 受け入れ条件を窓の枠で測る**

849〜911 行目付近 (`// --- 受け入れ条件 (spec の冒頭): 1440x795 …` から、その `await check(…);` の閉じまで)

```typescript
  // --- 受け入れ条件 (spec の冒頭): 1440x795 でバーが画面に収まり、一覧はパネルの中で届く ---
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  await check(
    "受け入れ条件 1440x795: バーとパネルが画面に収まり、パネルの中でスクロールする",
    async () => {
      await page.setViewportSize({ width: 1440, height: 795 });
      try {
```

から

```typescript
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

までを、次に置き換える。

```typescript
  // --- 受け入れ条件 (フロートの窓の spec A.4): 1440x795 で、最初の位置のままのバーの窓が
  // プレイヤーの下に重ならずに収まり、一覧はパネルの窓の中で届く -----------------------------
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  await check(
    "受け入れ条件 1440x795: バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする",
    async () => {
      // **先にページを先頭へ戻す。** 動かしていない窓は viewport が変わったときのプレイヤーの
      // 画面上の位置で最初の位置を取り直し、スクロールでは取り直さない (spec A.2)
      await page.evaluate(() => window.scrollTo(0, 0));
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
          const player = document.getElementById("movie_player");
          if (player === null) throw new Error("#movie_player がありません");
          const p = player.getBoundingClientRect();
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollY: window.scrollY,
            // **窓の枠の外形で測る。** 中身の根 (#yt-clip-bar) ではない (spec A.4)
            bar: rect("yt-clip-bar-window"),
            panel: rect("yt-clip-panel"),
            playerBottom: p.bottom,
            // 合否には入れない。パネルが動画に重なっていないかを人が見る材料
            playerRight: p.right,
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
          };
        });
        const file = join(OUT_DIR, "layout-1440x795.png");
        await page.screenshot({ path: file });
        record(
          "受け入れ条件 1440x795: バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする",
          measured.scrollY === 0 &&
            measured.playerBottom <= measured.bar.top &&
            measured.bar.bottom <= measured.innerHeight &&
            measured.panel.top >= 0 &&
            measured.panel.left >= 0 &&
            measured.panel.right <= measured.innerWidth &&
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

- [ ] **Step 3: 窓の操作の確認を足す**

Step 2 で置き換えた `await check(…);` の**直後** (913 行目付近の `await writeResults();` の前) に次を足す。

```typescript

  // --- フロートの窓 (spec A.4): 動かす・大きさを変える・画面の外へ出しきれない・戻す ---------
  // 1920x1080 に戻した後に行う。受け入れ条件の確認で足した区間 5 つと、開いた設定が残っている
  const barWindow = page.locator("#yt-clip-bar-window");
  const barGrip = bar.locator("[data-role=grip]");
  const panelHeader = panel.locator("[data-role=window-header]");

  type Box = { x: number; y: number; width: number; height: number };
  async function boxOf(locator: Locator): Promise<Box> {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("要素が画面に出ていません");
    return box;
  }
  const centerOf = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;

  /** from を押して to まで動かして離す。途中も刻んで動かし、pointermove を届ける */
  async function dragFromTo(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    // 覚える (chrome.storage.local への保存) のは指を離した後に非同期で走る
    await page.waitForTimeout(500);
  }

  /** 拡張が覚えた窓の位置 (何も覚えていなければ null) */
  async function readWindowLayout(): Promise<Record<string, unknown> | null> {
    const worker = await getWorker();
    return worker.evaluate(async () => {
      const stored = await chrome.storage.local.get("windowLayout");
      return (stored.windowLayout as Record<string, unknown> | undefined) ?? null;
    });
  }

  await check("窓を動かすと、読み込み直しても同じ位置に出る", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const barStart = await boxOf(barWindow);
    const panelStart = await boxOf(panel);

    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: grip.x + 80, y: grip.y + 40 });
    const header = await boxOf(panelHeader);
    // 見出しの左寄り (「yt-clip」の文字の上) を掴む。右端の折り畳みボタンでは窓は動かない。
    // 左へは少しだけ動かす (大きく動かすと、次の項目でバーの窓の右下の角に重なる)
    const headerAt = { x: header.x + 40, y: header.y + header.height / 2 };
    await dragFromTo(headerAt, { x: headerAt.x - 60, y: headerAt.y + 40 });
    const barMoved = await boxOf(barWindow);
    const panelMoved = await boxOf(panel);
    const saved = await readWindowLayout();

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await waitNoAd();
    // エディットで区間があるのでパネルも出る (受け入れ条件の確認で足した区間が状態機械に残っている)
    await expect(segmentRows).toHaveCount(LAYOUT_SEGMENT_STARTS.length, { timeout: 30_000 });
    await expect(panel).toBeVisible();
    const barAfter = await boxOf(barWindow);
    const panelAfter = await boxOf(panel);

    const samePlace = (a: Box, b: Box) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width);
    record(
      "窓を動かすと、読み込み直しても同じ位置に出る",
      near(barMoved.x, barStart.x + 80) &&
        near(barMoved.y, barStart.y + 40) &&
        near(panelMoved.x, panelStart.x - 60) &&
        near(panelMoved.y, panelStart.y + 40) &&
        samePlace(barAfter, barMoved) &&
        samePlace(panelAfter, panelMoved) &&
        saved !== null &&
        "bar" in saved &&
        "panel" in saved,
      { barStart, barMoved, barAfter, panelStart, panelMoved, panelAfter, saved },
    );
  });

  await check("右下をドラッグすると大きさが変わる (バーの窓は幅だけ)", async () => {
    // バーの窓を上にしておく (右下の角がパネルの窓の下に潜っていても掴めるように)。
    // 押して離すだけなので、位置は変わらず覚え直しもしない
    await barGrip.click();
    const barBefore = await boxOf(barWindow);
    const barCorner = centerOf(await boxOf(barWindow.locator("[data-role=window-resize]")));
    await dragFromTo(barCorner, { x: barCorner.x - 200, y: barCorner.y + 50 });
    const barAfter = await boxOf(barWindow);

    const panelBefore = await boxOf(panel);
    const panelCorner = centerOf(await boxOf(panel.locator("[data-role=window-resize]")));
    await dragFromTo(panelCorner, { x: panelCorner.x - 60, y: panelCorner.y - 100 });
    const panelAfter = await boxOf(panel);

    record(
      "右下をドラッグすると大きさが変わる (バーの窓は幅だけ)",
      near(barAfter.width, barBefore.width - 200, 2) &&
        near(barAfter.height, barBefore.height) &&
        near(barAfter.x, barBefore.x) &&
        near(panelAfter.width, panelBefore.width - 60, 2) &&
        near(panelAfter.height, panelBefore.height - 100, 2),
      { barBefore, barAfter, panelBefore, panelAfter },
    );
  });

  await check("窓を画面の外へドラッグしても、掴む場所が画面に残る", async () => {
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("viewport が取れません");
    // 掴んだ点を画面の隅まで運ぶ。掴む場所の残りは画面の外へ出ようとするが、詰められて残る。
    // 画面の外の座標へはマウスを運べない (ページにイベントが届かない) ので、隅で止める。
    // バーのつまみは右下、パネルの見出しは左下へ。反対の隅へ送るのは、次の項目で
    // ダブルクリックするときに 2 つの窓が重ならないようにするため
    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: viewport.width - 1, y: viewport.height - 1 });
    const header = await boxOf(panelHeader);
    const headerAt = { x: header.x + 40, y: header.y + header.height / 2 };
    await dragFromTo(headerAt, { x: 1, y: viewport.height - 1 });

    const gripBox = await boxOf(barGrip);
    const headerBox = await boxOf(panelHeader);
    const inside = (b: Box) =>
      b.x >= -0.5 &&
      b.y >= -0.5 &&
      b.x + b.width <= viewport.width + 0.5 &&
      b.y + b.height <= viewport.height + 0.5;
    record(
      "窓を画面の外へドラッグしても、掴む場所が画面に残る",
      inside(gripBox) && inside(headerBox),
      { viewport, gripBox, headerBox },
    );
  });

  await check("掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える", async () => {
    // バーを先に戻す。パネルを先に右上へ戻すと、高さが画面の下まで伸びて右下のつまみに被さる
    await barGrip.dblclick();
    const header = await boxOf(panelHeader);
    await panelHeader.dblclick({ position: { x: 40, y: header.height / 2 } });
    await page.waitForTimeout(500);

    const measured = await page.evaluate(() => {
      const box = (id: string) => {
        const element = document.getElementById(id);
        if (element === null) throw new Error(`#${id} がありません`);
        const b = element.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      };
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        player: box("movie_player"),
        bar: box("yt-clip-bar-window"),
        panel: box("yt-clip-panel"),
      };
    });
    const saved = await readWindowLayout();
    // バーの最初の位置: プレイヤーの下端 + 8px。収まらなければ画面の下端から 16px
    // (window-layout.ts の initialBarRect)。パネルは右 16px・上 68px・幅 400px (side-panel.ts)
    const expectedBarTop = Math.max(
      0,
      Math.min(measured.player.bottom + 8, measured.innerHeight - 16 - measured.bar.height),
    );
    record(
      "掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える",
      near(measured.bar.left, measured.player.left) &&
        near(measured.bar.width, measured.player.width) &&
        near(measured.bar.top, expectedBarTop) &&
        near(measured.panel.right, measured.innerWidth - 16) &&
        near(measured.panel.top, 68) &&
        near(measured.panel.width, 400) &&
        saved !== null &&
        !("bar" in saved) &&
        !("panel" in saved),
      { ...measured, expectedBarTop, saved },
    );
  });
```

- [ ] **Step 4: 型を通す**

実行: `npm run typecheck` (Bash の timeout 600000)
期待: PASS

- [ ] **Step 5: skip されることを確かめる (実機は走らせない)**

実行: `npx playwright test e2e/telop-check.spec.ts --list` (Bash の timeout 120000)
期待: `テロップの実機確認` が 1 件だけ一覧に出る (構文と import が読めている)。`YT_CLIP_TELOP_CHECK` を付けて走らせない

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): 受け入れ条件を窓の枠で測り、窓の操作を実機で確かめる

1440x795 ではバーの窓の枠 (中身の根ではない) がプレイヤーの下端より
下にあり、画面に収まることを見る。viewport を変える前にページを先頭へ
戻すのは、動かしていない窓がそのときのプレイヤーの画面上の位置で
取り直すため。窓を動かして読み込み直す・右下で大きさを変える・画面の
外へ引っ張る・ダブルクリックで戻す、を足す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 8: 掲載画像の枠取りをバーの窓に合わせる

**Files:**
- Modify: `scripts/screenshots.mjs` (80〜90 行目付近の `framePlayerAndBar`)

**Interfaces:**
- Consumes: `#movie_player`、動かしていない窓は `window` の `resize` で最初の位置 (プレイヤーの下端 + 8px) を取り直す (Task 6)
- Produces: `npm run screenshots` の 1-range.png / 2-settings.png で、バーの窓がプレイヤーの直下に写る

**なぜ変えるか:** 今の `framePlayerAndBar` はページを送って `#yt-clip-bar` を画面の下寄りに置いている。
バーの窓はスクロールに付いてこない (spec A.2) ので、送るとプレイヤーだけが動き、バーの窓が取り残される。
送った後に `resize` を配り、動かしていないバーの窓に最初の位置 (その時点のプレイヤーの直下) を取り直させる。
プロファイルは毎回新しい一時ディレクトリなので、覚えた位置は無い (窓は動かしていない扱い)。

**このタスクの実装担当は `npm run screenshots` を走らせない** (Chromium を起動して YouTube を開く)。Task 9 で controller が
走らせて画像を見る。

- [ ] **Step 1: 枠取りを書き換える**

`scripts/screenshots.mjs` の 80〜90 行目付近

```javascript
  /** バーが画面の下寄りに来るよう送る。プレイヤーと操作の両方を 1 枚に収める */
  const framePlayerAndBar = async (ratio) => {
    await page.evaluate((r) => {
      const element = document.getElementById("yt-clip-bar");
      if (element === null) throw new Error("バーが見つかりません");
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top - window.innerHeight * r, behavior: "instant" });
    }, ratio);
    // スクロール後の再描画を待つ
    await page.waitForTimeout(500);
  };
```

を次に置き換える。

```javascript
  /**
   * バーの窓が画面の下寄り (上端が画面の高さの ratio) に来るよう送る。プレイヤーと操作の両方を
   * 1 枚に収める。
   *
   * **バーの窓はページのスクロールに付いてこない** (画面に浮いたまま。フロートの窓の spec A.2)。
   * 送った後に resize を配り、動かしていないバーの窓に最初の位置 (その時点のプレイヤーの
   * 下端 + 8px。youtube.ts / window-layout.ts の BAR_GAP_PX) を取り直させる
   */
  const framePlayerAndBar = async (ratio) => {
    await page.evaluate((r) => {
      const player = document.getElementById("movie_player");
      if (player === null) throw new Error("プレイヤーが見つかりません");
      const barTop = player.getBoundingClientRect().bottom + 8 + window.scrollY;
      window.scrollTo({ top: barTop - window.innerHeight * r, behavior: "instant" });
      window.dispatchEvent(new Event("resize"));
    }, ratio);
    // スクロールと置き直しの後の再描画を待つ
    await page.waitForTimeout(500);
  };
```

- [ ] **Step 2: 構文を確かめる**

実行: `node --check /Users/trapple/repos/github.com/trapple/yt-clip/scripts/screenshots.mjs` (Bash の timeout 60000)
期待: 何も出力せず終了コード 0

- [ ] **Step 3: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add scripts/screenshots.mjs
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
fix(screenshots): バーの窓をプレイヤーの直下に置き直してから撮る

バーは画面に浮いた窓になり、ページを送っても付いてこない。送った後に
resize を配って、動かしていないバーの窓に最初の位置 (その時点の
プレイヤーの直下) を取り直させる。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 9: 実機で確かめる (controller が実行)

**Files:**
- Modify: `docs/manual-check.md` (「## 確認した環境」)

**実行者: controller (メインセッション)。** 実機 (Google Chrome / 同梱の Chromium と YouTube) を使い、結果の画像を見て判断するため
subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜8 のすべて
- Produces: `test-results/telop-check/` の結果、`release/screenshots/` の掲載画像、`docs/manual-check.md` の記録

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる
(後に走らせると check:telop の結果が消える)。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: 通常の E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout 180 秒がある)
期待: `拡張がロードされ service worker が起動する` / `YouTube の再生画面に IN/OUT UI が注入される` / `IN を指定するとページ内で録画を始められる` が PASS。
`テロップの実機確認` は skip。落ちたら README の「E2E が失敗したときの切り分け」に沿って `test-results/` の trace を見る
(`#yt-clip-bar` が出ないなら、覚えた位置の読み込みが済まず窓が出ていない可能性も見る: page の console に `窓の位置を読めない` の warn があるか)

- [ ] **Step 3: `npm run check:telop` を走らせる**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分かかりうるので Bash の timeout 600000 では足りない。テスト自身が
`test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。
20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` に 21 項目 (既存 16 + 書き換えた受け入れ条件 1 + 窓の 4) があり、すべて `pass: true`

落ちたときの見方:

- `シアターモードでプレビューが動画に重なる` が `.ytp-size-button` のクリックで落ちた → シアターモードでバーの窓が画面の下端に詰められ、
  プレイヤーの操作列に被さった可能性。`preview-theater-t1.png` を見て、被さっていれば spec の `## 自律判断ログ` に
  `- [実機] 1920x1080 のシアターモードでバーの窓がプレイヤーの操作列に N px 重なる` と書き、最終報告で伝える (spec A.2 が認めた重なり)
- 受け入れ条件で `playerBottom > bar.top` → 1440x795 でバーの窓が画面の下端に詰められている。`results.json` の `bar` の高さを見て、
  spec の予算 (約 106px) を超えていないかを確かめる
- 窓の 4 項目 → `results.json` の `values` の座標と、`console.log` の `[yt-clip]` の warn を見る

- [ ] **Step 4: 画像を見て判定する**

Read で次を見る。

- `test-results/telop-check/layout-1440x795.png` — バーの窓 (拡大バー・つまみ ⠿・IN / OUT / 録画) がプレイヤーの下端の**下**に重ならずに出て、
  画面に全部見えている。右側のパネルの窓に区間・テロップの一覧と設定の先頭が見えていて、パネルの中にスクロールバーがある。
  `results.json` の `playerRight` とパネルの `left` を比べ、パネルが動画に重なっていないか
- `test-results/telop-check/preview-theater-t1.png` — シアターモードでテロップのプレビューがバーの窓やパネルに隠れていない
- 既存の画像 (`preview-*-t*.png` と `frame-*-t*.png` の見た目の一致) が前回と同じ見た目

**1440x795 でバーの窓がプレイヤーに重なっていたら、spec の受け入れ条件が崩れている。** 直さずに spec の `## 自律判断ログ` に
`- [実機] 1440x795 でバーの窓がプレイヤーに N px 重なる (playerBottom=…, bar.top=…)` と 1 行書き、最終報告でユーザーに伝える。

- [ ] **Step 5: 掲載画像を撮って見る**

実行: `npm run screenshots` (Bash の timeout 600000。スクリプト側にも起動 60 秒・遷移 60 秒・待ち 30 秒の上限がある)
期待: `release/screenshots/1-range.png` と `release/screenshots/2-settings.png` が出力される

Read で 2 枚を見る。1-range.png はバーの窓がプレイヤーの直下に浮いて写り、右側のパネルは出ていない (シンプルで設定を閉じている)。
2-settings.png はバーの窓がプレイヤーの直下にあり、右側のパネルの窓に設定の先頭 (モード) が見え、末尾が切れていてパネルの中に
スクロールバーがある。バーの窓がプレイヤーから離れて写っていたら、`framePlayerAndBar` の `resize` で置き直されていない
(Task 6 のきっかけか Task 8 の配り方を疑う)。`release/` は `.gitignore` の対象なので commit しない。

- [ ] **Step 6: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の段落の末尾 (「全画面・テーマの切り替え・ホームへの移動は単体テストでだけ確かめている。」の後) に、
空行を 1 つ挟んで次を足す (`<…>` は実際の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。

```markdown
<JST の日付> はフロートの窓を `npm run check:telop` で確かめた (21 項目すべて通過。1440x795 で最初の位置のバーの窓が
プレイヤーの下端 <playerBottom>px より下 (<bar.top>〜<bar.bottom>px) に収まる。画面は `test-results/telop-check/layout-1440x795.png`)。
「見た目」節の窓の項目のうち、テーマの切り替え・重なり順・シアターモードの切り替えで付いてくることは単体テストでだけ確かめている。
```

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (ドキュメントだけの変更だが、commit の前に通す規約に従う)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: フロートの窓を実機で確かめたことを記録する

1440x795 で最初の位置のバーの窓がプレイヤーに重ならずに収まり、窓を
動かして読み込み直す・大きさを変える・画面の外へ引っ張る・ダブル
クリックで戻す、を npm run check:telop で通したことを残す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

## 完了の条件

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke が通る
- `npm run check:telop` の 21 項目がすべて通り、`layout-1440x795.png` でバーの窓がプレイヤーの下端より下に重ならずに収まり、
  パネルの窓の中でスクロールしていることを controller が目で確かめた (Task 9)
- `release/screenshots/1-range.png` / `2-settings.png` で、バーの窓がプレイヤーの直下に写っている
- `#below` に拡張の要素が 1 つも入っていない (単体テスト「#below には何も置かない」)
- README / CHANGELOG / docs (manual-check・store-release・privacy-policy) に A の範囲の文言が入り、B (テロップの帯) の文言は入っていない
- whole-branch の cross-review (保守担当 + 攻撃者視点、別の Claude モデル) が Approved
- branch `feat/floating-windows` 上の commit で止める。push / PR はユーザーの指示を待つ。B (拡大バー上のテロップ) の plan は、この plan の完了後に別に書く
