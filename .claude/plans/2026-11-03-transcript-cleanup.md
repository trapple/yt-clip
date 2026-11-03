# 撤去と欄への統合 (段階 1c-2) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 区間の一覧・テロップの一覧・拡大バーの下のテロップの帯・`RESET_MARKS` を外し、その役目を文字起こしの欄 (区間の見出しと手入力の行) と詰める欄 (合計と上限) に移す。字幕の無い動画でも、IN / OUT で区間を作り、欄の「＋ ここに字幕を足す」でテロップを足せるようにする。

**Architecture:** 欄の行 (字幕の行。8000 行になりうる) の要素はこれまでどおり使い回し、行の間に「差し込むもの」(区間の見出し・手入力の行。数個) を描くたびに作り直して差し込む。どの行の前に置くかは純粋関数 `placeTranscriptItems` (新しい `transcript-items.ts`) が決める。手入力の行は `lineId` の無いテロップそのもの (ADR 0003) で、保存先は増やさない。外す一覧が持っていた操作は、欄の見出し (選ぶ・✕)、手入力の行 (✎・頭を今に・尻を今に・▶・✕)、詰める欄の見出し (合計と上限) に移す。**新しい要素は外す一覧と同じ `data-role` (`segment` / `telop` / `remove` / `add-telop` / `set-start` / `set-end`) を使う** (今の単体テストと e2e が一覧をこの名前で探しているので、移し替えを小さくする)。

**Tech Stack:** TypeScript、vitest (jsdom)、Playwright (`npm run check:telop`)

## 段階 1c の分け方 (2026-11-03 回答「詰める欄 → 撤去 → 検索 (推奨)」)

| | 中身 | 状態 |
|---|---|---|
| 1c-1 | 詰める欄 | 済 (PR #9) |
| **1c-2 (この plan)** | 区間とテロップの一覧・帯・`RESET_MARKS` の撤去、欄の区間の見出し、字幕の無い動画の道 (手入力の行。ADR 0003) | |
| 1c-3 | 欄の検索、残った持ち越しの不具合 | |

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- ADR 0003 (`docs/adr/0003-manual-telop-as-transcript-row.md`) の Decision:
  - 「文字起こしの欄に「＋ ここに字幕を足す」を置き、今の再生位置に手入力の行を作る。行は字幕の行と同じ並びに入り、✎ で文字を直す」
  - 「手入力の行の時刻は、その行の「頭を今に」「尻を今に」で直す」
  - 「区間は IN / OUT と ＋ 区間を追加で作る (時間で区間を作る道)」
- ADR 0003 の Consequences: 「**`lineId` の無いテロップそのものを行にする**」「保存先は増やさない」「寿命はクリップと同じ。IN で作り直すと、行から作ったテロップと一緒に消える」「区間が無いと「＋ ここに字幕を足す」は押せず、字幕の無い動画では IN / OUT で区間を作ってから足す」
- 第 2 版のモック (artifact `c2a6c8ad-fb19-4f7b-a655-be4d05c9abaf`。https://claude.ai/code/artifact/c2a6c8ad-fb19-4f7b-a655-be4d05c9abaf、Artifact ツールの read で読める) の欄: 見出し「区間 1」「12:01.2 – 12:13.6」、詰めている区間は「区間 2 · 詰めている」
- 1c-1 の持ち越し (`.claude/plans/2026-11-03-trim-panel.md` 末尾) のうち、この plan で扱うもの:
  - 「1440x795 で 9.25px はみ出す。帯の段 (34px) を外した後に check:telop の 2 判定で確かめる」(Task 7)
  - 「有効・無効の決め方が重なっている (`refreshTrimPanel` の中と `rangeBar.setEnabled` の隣) / `refreshLists` が `refreshTrimPanel` を 2 回通る。一覧を外すときに有効の決め方ごと見直す」(Task 4 Step 3)
- `.claude/plans/2026-11-03-transcript-panel.md` 末尾 (1b-2 から) の持ち越しの振り分け。**この plan ではどれも扱わず 1c-3 に回す** (撤去と手入力の行が前からの作法を変えないもの):
  - 保存から読めたのに吹き替えの判定を待つ間「取っています…」のまま → 1c-3
  - 保存する字幕が頼んだ動画のものかの確かめ・`language` / `name` の長さの上限 → 1c-3
  - 保存の索引の割り込みで漏れたキーが残る → 1c-3
  - router が `apply` の前に `captureTabId` を書く → 1c-3
  - `isClipOf` の受理判定が `JSON.stringify` → 1c-3
  - Shift の範囲選択で区間が数千になる → 1c-3
  - `text.slice(0, 500)` がサロゲートペアを割る → 1c-3 (手入力の行は slice せず上限で止めるので増えない)
  - 状態の欄の「録画中… (N秒)」「書き出しています…」が残る → 1c-3
  - 広告の再生中に行を押すと duration が広告の長さ → 1c-3 (＋ ここに字幕を足すも同じ。今の ＋ テロップと同じ作法)
  - 別の動画で行を押すと前の動画の区間とテロップ (手入力も) を確かめずに置き換える → 1c-3 (MARK_IN / ADD_SEGMENT と同じ前からの作法。手入力の行が欄に出ても、置き換わる量は今のテロップの一覧のときと同じ)
- `.claude/plans/2026-11-03-trim-panel.md` 末尾の「テロップの帯のドラッグ・OUT など、区間の範囲以外を送った直後の往復の間に ±0.1 を押すと巻き戻りうる」は、帯を外すと OUT (と手入力の行の頭を今に / 尻を今に) だけが残る → 1c-3
- 行・テロップの文字は信用できない入力: DOM には `textContent` でだけ入れる (1a の whole-branch review)
- テロップの文字は 500 文字まで (`MAX_TELOP_TEXT_LENGTH`)。上限を超えた文字は送らずに理由を出し、直す欄は閉じない (今のテロップの一覧と同じ)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- 先にドキュメントを直してからコードに着手する (Task 1 が文書)
- git は `git -C <dir> ...`、gh は `gh ... -R trapple/yt-clip`
- Fail Fast。状態機械は不正なイベントを throw する (UI は送る前に止めて理由を出す)
- コメントとコミットメッセージは日本語、Conventional Commits + Why の本文
- コミットは署名される。署名で失敗したら、署名を外さずにユーザーに伝えて止まる
- 外部プロセスにはタイムアウトを付ける (`npx vitest run` は Bash の timeout 300000、e2e は 600000)

### 運用前提 (brainstorming で確定した実装方式)

- モード: guarded (設計の分かれ目 2 つを AskUserQuestion で回答済み: 手入力の行の持ち方「テロップそのものを行に (推奨)」、時刻の直し方「行に「頭を今に / 尻を今に」 (推奨)」)
- 隔離: branch。`feat/transcript-cleanup` (develop から切った。PR は develop へ)
- 実装方式: B (branch + 直列)
- 既知の失敗: `e2e/smoke.spec.ts` の「オフにすると 1 秒以内…」は `expect(extensionLogs).toEqual([])` で落ちる。それ以外で落ちたらこの plan の不具合

---

## ファイル構造

| ファイル | 種別 | 責務 |
|---|---|---|
| `README.md` / `docs/manual-check.md` / `CHANGELOG.md` | Modify | 一覧と帯の記述を欄の見出し・手入力の行に置き換える |
| `src/shared/time.ts` | Modify | `formatSecTenths` (0.1 秒の桁。詰める欄と欄の見出しで共有) |
| `src/content/transcript-items.ts` | Create | 欄の行の間に差し込むもの (区間の見出し・手入力の行) の並べ方 (純粋関数) |
| `src/content/transcript-panel.ts` | Modify | 見出し・手入力の行・「＋ ここに字幕を足す」を描く、押されたことを伝える、足した行を見せる |
| `src/content/trim-panel.ts` | Modify | 合計と上限を出す (区間の一覧の合計の役目を引き継ぐ)。帯の段を抱えない |
| `src/content/styles.ts` | Modify | 欄の見出しと手入力の行の見た目。`SEGMENT_STYLE` / `TELOP_STYLE` / `TELOP_TRACK_STYLE` を外す |
| `src/content/youtube.ts` | Modify | 欄の見出しと手入力の行を繋ぐ。一覧と帯を外す |
| `src/content/segment-list.ts` / `telop-list.ts` / `telop-track.ts` | Delete | 外す |
| `src/shared/types.ts` / `src/background/state.ts` | Modify | `RESET_MARKS` を外す |
| `tests/...` / `e2e/telop-check.spec.ts` | Create / Modify / Delete | 上に合わせる |

---

### Task 1: 文書

**Files:**
- Modify: `README.md`、`docs/manual-check.md`、`CHANGELOG.md`

- [ ] **Step 0: ADR 0003 の Consequences を補う**

`docs/adr/0003-manual-telop-as-transcript-row.md` の「- テロップの置き場所が欄の 1 か所にまとまる。手入力のテロップも ✎・字幕に出さない・▶ が字幕の行と同じになる」→

```markdown
- テロップの置き場所が欄の 1 か所にまとまる。手入力のテロップも ✎・▶ が字幕の行と同じになる。**「字幕に出さない」は
  手入力の行には置かない** (字幕の行の「出さない」は文字を空にする作法で、手入力の行の空は「まだ書いていない」と
  見分けられない。手入力の行は出すために足すものなので、出さないなら ✕ で消す。1c-2 の計画で決めた)
```

(Step 9 の commit に `docs/adr/0003-manual-telop-as-transcript-row.md` も入れる。)

- [ ] **Step 1: README の「使い方」の窓の説明を直す**

`README.md` の「IN / OUT・録画のボタンと詰める欄 (以下まとめて「バー」)、区間とテロップの一覧は、2 つの窓 (**バー** / **区間・テロップ**) に出る。」→

```markdown
IN / OUT・録画のボタンと詰める欄 (以下まとめて「バー」)、文字起こしの欄 (区間の見出しとテロップもここに出る) は、2 つの窓 (**バー** / **区間・テロップ**) に出る。
```

- [ ] **Step 2: README の「## 文字起こしの欄」に見出しと手入力の行を足す**

「- **行の時刻を押す** — その行の頭から再生する。再生中の行には ▶ が付く (録画中は動かさない)」の直後に足す:

```markdown
- **区間の見出し** — 区間の頭の行の上に「区間 1」と頭と尻 (100 分の 1 秒まで)・長さが出る。押すとその区間を詰める欄で
  詰める (見出しに「· 詰めている」が付く)。**✕** でその区間を消す
- **＋ ここに字幕を足す** — 今の再生位置から 3 秒のテロップ (手入力の行) を足し、文字を打つ欄を開く (Enter で確定)。
  手入力の行は字幕の行と同じ並びに、点線の印付きで入る。✎ で文字を直し、**頭を今に / 尻を今に** で出す時間を今の
  再生位置に合わせ、時刻を押すと頭から再生し、✕ で消す。区間が無いときは押せない (先に行を押すか IN / OUT で区間を作る)
```

同じ節の「字幕の無い動画では欄は案内だけになり、これまでどおり ＋ 区間を追加と ＋ テロップで作る。」→

```markdown
字幕の無い動画では、IN / OUT や ＋ 区間を追加で区間を作り、＋ ここに字幕を足す でテロップを足す (欄には区間の見出しと
手入力の行だけが並ぶ)。
```

- [ ] **Step 3: README の「## 詰める欄」と「## 複数の場面を繋ぐ」を直す**

「バーの上の方が「詰める欄」になる。選んでいる区間 (文字起こしの欄で押した行の区間、または区間の一覧で選んだ区間) の」→「バーの上の方が「詰める欄」になる。選んでいる区間 (文字起こしの欄で押した行か区間の見出しの区間) の」

「- **見出しの行** — 「区間 2 を詰める」と、区間の頭と尻 (100 分の 1 秒まで)・長さ・全区間の合計。」→「- **見出しの行** — 「区間 2 を詰める」と、区間の頭と尻 (100 分の 1 秒まで)・長さ・全区間の合計と上限 (「合計 24.6 / 60 秒」。上限を超えると警告色)。」

「## 複数の場面を繋ぐ」の中:

- 「テロップがあるときは、一覧で選んでいる区間の頭を今の位置に合わせる。」→「テロップがあるときは、選んでいる区間 (詰める欄の区間) の頭を今の位置に合わせる。」
- 「- **OUT** — 一覧で選んでいる区間の尻を今の位置に合わせる」→「- **OUT** — 選んでいる区間の尻を今の位置に合わせる」
- 「一覧から区間を選ぶと拡大バーがその区間に切り替わるので、ハンドルでも\n調整できる。」→「欄の区間の見出しや詰める欄の ‹ › で区間を選ぶと、詰める欄がその区間に切り替わる。」
- 「区間とテロップの一覧は、区間・テロップの窓 (最初はおすすめ動画の上) に出る。IN / OUT・録画のボタンと拡大バーは\n最初はプレイヤーの直下に出るので、区間が増えてもページをスクロールせずに操作できる。\n一覧が長くなったら区間・テロップの窓の中でスクロールする。」→

```markdown
区間の見出しは、区間・テロップの窓 (最初はおすすめ動画の上) の文字起こしの欄に出る。IN / OUT・録画のボタンと詰める欄は
最初はプレイヤーの直下に出るので、区間が増えてもページをスクロールせずに操作できる。
```

- [ ] **Step 4: README の「### テロップ」を置き換える**

「### テロップ」から「縁取りの太さ) は popup の設定で決める。全テロップ共通。」までを次に置き換える:

```markdown
### テロップ

テロップは文字起こしの欄で作る。字幕の行を区間に入れるとその行の文字がテロップになり、行に無い文言 (補足・ツッコミ) は
**＋ ここに字幕を足す** で手入力の行として足す (上の「文字起こしの欄」)。

テロップはプレイヤーの上に、録画と同じ見た目で重なって見える。録画すると
動画に焼き込まれる。見た目 (文字サイズ・フォント・文字の色・縁取りの色・
縁取りの太さ) は popup の設定で決める。全テロップ共通。
```

- [ ] **Step 5: README の「### テロップの制約」を直す**

- 「- **どの区間にも入らないテロップは録画に出ない**。一覧に「(区間外)」と出る。」→「- **どの区間にも入らないテロップは録画に出ない**。手入力の行に「(区間外)」と出る。」
- 「**帯は拡大バーの範囲の中でだけ動かせる**」から「- **録画中と、録画した後のプレビューの間は、帯は薄く出て動かせない** (区間の拡大バーと同じ)」までの 4 項目 (帯の範囲・帯の段・帯で縮められる長さ・録画中の帯) を消す
- 「- **テロップが残っている間は、最後の 1 区間を消せない**。」の項目の直後に足す:

```markdown
- **手入力の行はクリップと一緒に消える**。IN で範囲を作り直すと、行から作ったテロップと一緒に消える (文字起こしを
  取り直しても消えない)。出す時間は「頭を今に / 尻を今に」で合わせる (詰める欄で詰めるのは区間の頭と尻だけ)
```

- [ ] **Step 6: README の「### 操作の置き場所」を直す**

- 「- **区間・テロップは区間・テロップの窓に出る**。最初はバーがプレイヤーの直下、区間・テロップが\n  おすすめ動画の上に入っている (ページの中なので動画を隠さない)。拡大バーは幅がそのまま精度になるため、一覧の窓の\n  幅には縮めない」→

```markdown
- **区間の見出しとテロップは、区間・テロップの窓の文字起こしの欄に出る**。最初はバーがプレイヤーの直下、区間・テロップが
  おすすめ動画の上に入っている (ページの中なので動画を隠さない)。詰める欄は幅がそのまま精度になるため、区間・テロップの
  窓の幅には縮めない
```

- 「(ページの中ならスクロールで届く。帯の段を文字起こしの欄に置き換えて外すときに見直す)」→ Task 7 の実測で書き換える (この step では触らない。Task 7 Step 5 を見る)

- [ ] **Step 7: manual-check を直す**

`docs/manual-check.md` の「## 文字起こしの欄」:

- 「- [ ] 行を押すと区間ができ、区間の一覧とテロップの一覧に 1 つずつ増える。プレイヤーの上に行の文字がテロップとして出る」→「- [ ] 行を押すと区間ができ、行の上に「区間 1」の見出しが出る。プレイヤーの上に行の文字がテロップとして出る」
- 「ただし手で足したテロップが残っているときは、外れずに理由が出る (区間の一覧の ✕ と同じ)」→「ただし手入力の行が残っているときは、外れずに理由が出る (見出しの ✕ と同じ)」
- 「- [ ] 区間に入った行の ✎ で文字を直すと、テロップの一覧の文字も変わる。Esc で直す前に戻る」→「- [ ] 区間に入った行の ✎ で文字を直すと、プレイヤーの上のテロップの文字も変わる。Esc で直す前に戻る」
- 「- [ ] 「字幕に出さない」でテロップが消え (一覧には空の行が残る)、もう一度押すと戻る」→「- [ ] 「字幕に出さない」でテロップが消え (行に取り消し線が付く)、もう一度押すと戻る」
- 「行を押してから欄と一覧が変わるまでに」→「行を押してから欄が変わるまでに」
- 「- [ ] 字幕の無い動画では「この動画には公式字幕がありません」だけが出て、＋ 区間を追加と ＋ テロップで作れる」→「- [ ] 字幕の無い動画では「この動画には公式字幕がありません」と、IN / OUT で区間を作ってから ＋ ここに字幕を足す で足せる案内が出る。IN を押すと欄に「区間 1」の見出しが出て、＋ ここに字幕を足す で手入力の行が入る」

同じ節の末尾 (「- [ ] 行の文字にタグのような文字列…」の後) に足す:

```markdown
- [ ] 区間の見出しを押すと、詰める欄がその区間になり、見出しに「· 詰めている」が付く。見出しの ✕ でその区間が消える (手入力の行が残っていて最後の区間なら、消えずに理由が出る)
- [ ] 区間が無いとき「＋ ここに字幕を足す」は押せない。区間があると、押した再生位置に手入力の行が入り、文字を打つ欄が開く。Enter でプレイヤーの上に出る
- [ ] 手入力の行の「頭を今に」「尻を今に」で出す時間が変わる (頭を尻より後ろにすると理由が出て変わらない)。時刻を押すと頭から再生する。✕ で消える
- [ ] 手入力の行は、字幕の行の時刻順の並びに入る。区間の外の手入力の行には「(区間外)」が付き、薄く出る
- [ ] 文字起こしを取り直しても (「もう一度取る」・読み込み直し)、手入力の行は残る
- [ ] 区間・テロップの窓がページの中 (おすすめ動画の上) にあるとき、＋ ここに字幕を足す を押してもページがスクロールしない (タブが前に出て、欄の中が足した行まで送られる)
```

「## 詰める欄」の末尾に足す:

```markdown
- [ ] 見出しの行に「合計 N / 60 秒」が出る。合計が上限を超えると警告色になる
```

「## 複数区間の結合」→「### 区間の指定」:

- 「- [ ] 区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) の文字起こしの欄の下に区間の一覧が出る (窓は区間が 0 個でも、動画ページではいつも出る)」→「- [ ] 区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) の文字起こしの欄に区間の見出しが出る (窓は区間が 0 個でも、動画ページではいつも出る)」
- 「- [ ] 「＋ 区間を追加」を押すたびに一覧へ行が増える」→「- [ ] 「＋ 区間を追加」を押すたびに欄の区間の見出しが増える」
- 「- [ ] 行を選ぶと拡大バーがその区間に切り替わる」→「- [ ] 見出しを押すと詰める欄がその区間に切り替わる」
- 「- [ ] **重なる区間がそのまま 2 行として残る**」→「- [ ] **重なる区間がそのまま 2 つの見出しとして残る**」
- 「- [ ] ✕ で区間を消せる。全部消すと一覧が消えて IN の前の状態に戻る」→「- [ ] 見出しの ✕ で区間を消せる。全部消すと見出しが消えて IN の前の状態に戻る」
- 「- [ ] 合計が最大秒数を超えると合計の表示が警告色になり、録画が押せない」→「- [ ] 合計が最大秒数を超えると詰める欄の合計が警告色になり、録画が押せない」

「## テロップ」:

- 「- [ ] 一時停止したまま文言や時刻を変えると、プレビューがその場で描き直される」はそのまま
- 「- [ ] テロップが残っているとき、最後の 1 区間の ✕ が止まり理由が出る」→「- [ ] 手入力の行が残っているとき、最後の 1 区間の見出しの ✕ が止まり理由が出る」
- 「- [ ] 入力欄で文字を打っても YouTube のショートカット (スペース・`f` など) が発火しない」→「- [ ] 手入力の行の文字を打つ欄で文字を打っても YouTube のショートカット (スペース・`f` など) が発火しない」
- 「- [ ] 区間を選ぶと、その拡大バーの範囲に入るテロップが…」から「- [ ] テロップが 1 つも無いときは、帯の段が出ず、バーの高さが変わらない」までの帯の 7 項目を消す

「## 見た目」:

- 「区間 5 つ・テロップ 5 つを足すと」→「区間 5 つ・手入力の行 5 つを足すと」
- 「＋ 区間を追加・＋ テロップを押すと、浮いた区間・テロップの窓は中が足した行まで送られ」→「＋ 区間を追加・＋ ここに字幕を足すを押すと、浮いた区間・テロップの窓は中が足した見出しや行まで送られ」

「## 設定」の「更新後に区間とテロップの一覧が今までどおり出る」→「更新後に欄の区間の見出しと手入力の行が今までどおり出る」

- [ ] **Step 8: CHANGELOG を書く**

`CHANGELOG.md` の「## 未リリース」の直後 (「**長いテロップを…」の段落の前) に足す:

```markdown
**区間とテロップの一覧と、拡大バーの下のテロップの帯をなくし、文字起こしの欄にまとめた。** 区間は欄の見出し
(「区間 1」) で選び、✕ で消す。字幕の行に無い文言は欄の **＋ ここに字幕を足す** で手入力の行として足し、✎ で文字を、
「頭を今に / 尻を今に」で出す時間を直す。字幕の無い動画でも、IN / OUT で区間を作ってから同じように足せる。全区間の合計と
上限は詰める欄の見出しに出る (「合計 24.6 / 60 秒」)。
```

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md docs/manual-check.md CHANGELOG.md docs/adr/0003-manual-telop-as-transcript-row.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "docs: 区間とテロップの一覧と帯を外し、文字起こしの欄の見出しと手入力の行にまとめる、と書く

Why: 段階 1c-2 の撤去。一覧と帯が持っていた操作の行き先 (欄の見出し・手入力の行・詰める欄の合計) を、
コードより先に文書で決める (ADR 0003)"
```

---

### Task 2: 欄の部品 (差し込むものの並べ方と、欄に描く)

**Files:**
- Modify: `src/shared/time.ts`、`src/content/trim-panel.ts:47-48,208`
- Create: `src/content/transcript-items.ts`
- Modify: `src/content/transcript-panel.ts`、`src/content/styles.ts` (`TRANSCRIPT_STYLE`)、`src/content/youtube.ts` (`refreshTranscript` と `createTranscriptPanel` の呼び出しだけ。型を通す仮の値)
- Test: `tests/shared/time.test.ts`、`tests/content/transcript-items.test.ts` (Create)、`tests/content/transcript-panel.test.ts`

**Interfaces:**
- Produces:
  - `formatSecTenths(sec: number): string` (`src/shared/time.ts`。`8.36` → `"8.4"`)
  - `src/content/transcript-items.ts`:
    ```ts
    export type SegmentHeaderItem = { kind: "segment"; index: number; startSec: number; endSec: number; before: number };
    export type ManualTelopItem = { kind: "manual"; telopIndex: number; startSec: number; endSec: number; text: string; inSegment: boolean; before: number };
    export type TranscriptItem = SegmentHeaderItem | ManualTelopItem;
    export function firstLineAtOrAfter(lines: readonly TranscriptLine[], sec: number): number;
    export function placeTranscriptItems(lines: readonly TranscriptLine[], segments: readonly ClipRange[], telops: readonly Telop[]): TranscriptItem[];
    ```
  - `TranscriptView` に `items: TranscriptItem[]`、`trimmingIndex: number`、`canAddManual: boolean`
  - `TranscriptPanelCallbacks` に `onSelectSegment(index)`、`onRemoveSegment(index)`、`onAddManual()`、`onManualEdge(telopIndex, edge: "start" | "end")`、`onManualText(telopIndex, text): boolean`、`onRemoveManual(telopIndex)`、`onPlayManual(telopIndex)`
  - `TranscriptPanel` に `editManual(telopIndex: number): void`、`reveal(target: RevealTarget): HTMLElement | null` (`RevealTarget = { kind: "segment"; index: number } | { kind: "manual"; telopIndex: number }`)
  - 要素: 見出しは `div[data-role=segment][data-index][data-selected]` (中に `segment-title`・`segment-range`・`button[data-role=remove]`)。手入力の行は `div[data-role=telop][data-telop-index][data-in-segment]` (中に `manual-time`・`manual-text` (空なら `data-empty=true`) か直す欄 `textarea[data-role=line-edit]`・`telop-outside`・`manual-edit-button`・`set-start`・`set-end`・`remove`)。「＋ ここに字幕を足す」は `button[data-role=add-telop]` (欄の見出しの行)

- [ ] **Step 1: `formatSecTenths` の失敗するテストを書く**

`tests/shared/time.test.ts` の末尾に足す (import に `formatSecTenths` を足す):

```ts
describe("formatSecTenths", () => {
  test("0.1 秒の桁で出す", () => {
    expect(formatSecTenths(8.36)).toBe("8.4");
    expect(formatSecTenths(24.6)).toBe("24.6");
    expect(formatSecTenths(3)).toBe("3.0");
    expect(formatSecTenths(0.04)).toBe("0.0");
  });
});
```

- [ ] **Step 2: 失敗を確認**

実行: `npx vitest run tests/shared/time.test.ts` (timeout 300000)
期待: FAIL (`formatSecTenths` が export されていない)

- [ ] **Step 3: 実装し、詰める欄の `tenths` を置き換える**

`src/shared/time.ts` の `formatTimeCentis` の後に足す:

```ts
/** 秒を 0.1 秒の桁で出す (`8.36` → `"8.4"`)。詰める欄の長さと合計、欄の区間の見出しの長さ */
export function formatSecTenths(sec: number): string {
  return (Math.round(sec * 10) / 10).toFixed(1);
}
```

`src/content/trim-panel.ts` の `/** 秒を 0.1 秒の桁で出す (見出しの長さと合計) */` と `const tenths = ...` の 2 行を消し、`tenths(` を `formatSecTenths(` に置き換える (2 か所)。import に `formatSecTenths` を足す (`import { formatTime, formatTimeCentis } from "@/shared/time";` → `import { formatSecTenths, formatTime, formatTimeCentis } from "@/shared/time";`)。

- [ ] **Step 4: 通過を確認**

実行: `npx vitest run tests/shared/time.test.ts tests/content/trim-panel.test.ts` (timeout 300000)
期待: PASS

- [ ] **Step 5: `placeTranscriptItems` の失敗するテストを書く**

`tests/content/transcript-items.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { firstLineAtOrAfter, placeTranscriptItems } from "@/content/transcript-items";
import type { TranscriptLine } from "@/shared/transcript";

const line = (startSec: number, endSec: number): TranscriptLine => ({
  id: `youtube-asr:${startSec.toFixed(2)}`,
  startSec,
  endSec,
  text: `行 ${startSec}`,
});
const LINES = [line(1, 3), line(4, 6), line(7, 9), line(20, 22)];

describe("firstLineAtOrAfter", () => {
  test("その秒以上で始まる最初の行の位置。無ければ行の数", () => {
    expect(firstLineAtOrAfter(LINES, 0)).toBe(0);
    expect(firstLineAtOrAfter(LINES, 4)).toBe(1);
    expect(firstLineAtOrAfter(LINES, 4.5)).toBe(2);
    expect(firstLineAtOrAfter(LINES, 30)).toBe(4);
    expect(firstLineAtOrAfter([], 5)).toBe(0);
  });
});

describe("placeTranscriptItems", () => {
  test("区間の見出しは、区間の頭以降で始まる最初の行の前に入る", () => {
    const items = placeTranscriptItems(LINES, [{ startSec: 3.8, endSec: 9.3 }], []);
    expect(items).toEqual([{ kind: "segment", index: 0, startSec: 3.8, endSec: 9.3, before: 1 }]);
  });

  test("区間の頭より少し前に始まり、半分以上が区間に入る行は、見出しの下に入れる", () => {
    // 4〜6 の行は 4.5 から始まる区間に 1.5 / 2 秒入る (半分以上)
    const items = placeTranscriptItems(LINES, [{ startSec: 4.5, endSec: 9.3 }], []);
    expect(items[0]?.before).toBe(1);
  });

  test("半分に満たない行は見出しの上に残す", () => {
    // 4〜6 の行は 5.5 から始まる区間に 0.5 / 2 秒しか入らない
    const items = placeTranscriptItems(LINES, [{ startSec: 5.5, endSec: 9.3 }], []);
    expect(items[0]?.before).toBe(2);
  });

  test("行が無い (字幕の無い動画) ときは、全部が末尾 (0 の前) に時刻順で並ぶ", () => {
    const items = placeTranscriptItems(
      [],
      [{ startSec: 10, endSec: 20 }, { startSec: 40, endSec: 50 }],
      [{ startSec: 45, endSec: 48, text: "後" }, { startSec: 12, endSec: 15, text: "前" }],
    );
    expect(items.map((item) => [item.kind, item.startSec, item.before])).toEqual([
      ["segment", 10, 0],
      ["manual", 12, 0],
      ["segment", 40, 0],
      ["manual", 45, 0],
    ]);
  });

  test("手入力の行は lineId の無いテロップだけ。テロップの位置 (index) と、区間に入っているかを持つ", () => {
    const items = placeTranscriptItems(
      LINES,
      [{ startSec: 0.8, endSec: 3.3 }],
      [
        { startSec: 1, endSec: 3, text: "行 1", lineId: "youtube-asr:1.00" },
        { startSec: 2, endSec: 3, text: "ツッコミ" },
        { startSec: 25, endSec: 28, text: "" },
      ],
    );
    expect(items.filter((item) => item.kind === "manual")).toEqual([
      { kind: "manual", telopIndex: 1, startSec: 2, endSec: 3, text: "ツッコミ", inSegment: true, before: 1 },
      { kind: "manual", telopIndex: 2, startSec: 25, endSec: 28, text: "", inSegment: false, before: 4 },
    ]);
  });

  test("同じ行の前に入るものは時刻順で、同じ時刻なら見出しが先", () => {
    const items = placeTranscriptItems(
      LINES,
      [{ startSec: 10, endSec: 15 }],
      [{ startSec: 10, endSec: 12, text: "頭から" }, { startSec: 9.5, endSec: 11, text: "その前" }],
    );
    expect(items.map((item) => (item.kind === "segment" ? "見出し" : item.text))).toEqual(["その前", "見出し", "頭から"]);
  });
});
```

- [ ] **Step 6: 失敗を確認**

実行: `npx vitest run tests/content/transcript-items.test.ts` (timeout 300000)
期待: FAIL (`@/content/transcript-items` が無い)

- [ ] **Step 7: 実装**

`src/content/transcript-items.ts`:

```ts
/**
 * 文字起こしの欄の行の間に差し込むもの (区間の見出しと手入力の行。ADR 0003) の並べ方。純粋関数。
 *
 * **行の要素は使い回し、差し込むものだけを描くたびに作り直す** (行は 8000 行になりうるが、差し込むものは数個)。
 * そのために、差し込むものは「どの行の前に置くか」(`before`。行の数なら末尾) を持つ。行は開始の早い順 (transcript.ts)
 */

import { isLineInSegments } from "@/content/transcript-selection";
import { overlapsSegments } from "@/shared/telop";
import type { TranscriptLine } from "@/shared/transcript";
import type { ClipRange, Telop } from "@/shared/types";

/** 区間の見出し。`index` は状態機械の区間の位置 (時間順) */
export type SegmentHeaderItem = { kind: "segment"; index: number; startSec: number; endSec: number; before: number };

/** 手入力の行 = `lineId` の無いテロップ (ADR 0003)。`telopIndex` は状態機械のテロップの位置 */
export type ManualTelopItem = {
  kind: "manual";
  telopIndex: number;
  startSec: number;
  endSec: number;
  text: string;
  /** どれかの区間に重なる (重ならないテロップは録画に出ない) */
  inSegment: boolean;
  before: number;
};

export type TranscriptItem = SegmentHeaderItem | ManualTelopItem;

/** sec 以上で始まる最初の行の位置。無ければ行の数 */
export function firstLineAtOrAfter(lines: readonly TranscriptLine[], sec: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.startSec < sec) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function placeTranscriptItems(
  lines: readonly TranscriptLine[],
  segments: readonly ClipRange[],
  telops: readonly Telop[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  segments.forEach((segment, index) => {
    const at = firstLineAtOrAfter(lines, segment.startSec);
    const previous = lines[at - 1];
    // 行から作った区間の頭は行の 0.2 秒前。詰めて頭を行の中に入れても、半分以上が区間に入る行は見出しの下に置く
    // (欄で選んでいる行の判定 isLineInSegments と同じ規則。見出しの上に「区間に入った行」が出ない)
    const before = previous !== undefined && isLineInSegments(previous, [segment]) ? at - 1 : at;
    items.push({ kind: "segment", index, startSec: segment.startSec, endSec: segment.endSec, before });
  });
  telops.forEach((telop, telopIndex) => {
    if (telop.lineId !== undefined) return;
    items.push({
      kind: "manual",
      telopIndex,
      startSec: telop.startSec,
      endSec: telop.endSec,
      text: telop.text,
      inSegment: overlapsSegments(telop, [...segments]),
      before: firstLineAtOrAfter(lines, telop.startSec),
    });
  });
  // 同じ行の前に入るものは時刻順。同じ時刻なら見出しが先 (区間の頭から出る手入力の行を、見出しの下に置く)
  const rank = (item: TranscriptItem): number => (item.kind === "segment" ? 0 : 1);
  return items.sort((a, b) => a.before - b.before || a.startSec - b.startSec || rank(a) - rank(b));
}
```

`overlapsSegments` の引数の型が `ClipRange[]` (readonly でない) なので `[...segments]` で渡す。`isLineInSegments(line: TranscriptLine, segments: ClipRange[])` も同じ (`[segment]` は新しい配列なので通る)。

- [ ] **Step 8: 通過を確認**

実行: `npx vitest run tests/content/transcript-items.test.ts` (timeout 300000)
期待: PASS

- [ ] **Step 9: 欄の失敗するテストを書く**

`tests/content/transcript-panel.test.ts` の `setup` の callbacks に足す:

```ts
    onSelectSegment: vi.fn(),
    onRemoveSegment: vi.fn(),
    onAddManual: vi.fn(),
    onManualEdge: vi.fn(),
    onManualText: vi.fn(() => true),
    onRemoveManual: vi.fn(),
    onPlayManual: vi.fn(),
```

`view` の既定値に足す (`rows: [...]` の後):

```ts
  items: [],
  trimmingIndex: -1,
  canAddManual: false,
```

ファイルの末尾に足す:

```ts
describe("区間の見出しと手入力の行 (段階 1c-2)", () => {
  const SEGMENT = { kind: "segment", index: 0, startSec: 64.8, endSec: 73.3, before: 1 } as const;
  const MANUAL = { kind: "manual", telopIndex: 2, startSec: 66, endSec: 69, text: "ここ重要", inSegment: true, before: 2 } as const;
  const listChildren = (): string[] =>
    [...(role("transcript-lines")?.children ?? [])].map((child) => {
      const el = child as HTMLElement;
      return el.dataset.role === "line" ? `line:${el.dataset.lineId}` : `${el.dataset.role}`;
    });
  const header = (): HTMLElement => document.querySelector<HTMLElement>("[data-role='segment']")!;
  const manual = (): HTMLElement => document.querySelector<HTMLElement>("[data-role='telop']")!;
  const inManual = (name: string): HTMLElement | null => manual().querySelector<HTMLElement>(`[data-role='${name}']`);

  test("見出しと手入力の行は、指した行の前に入る", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(listChildren()).toEqual(["line:a", "segment", "line:b", "telop", "line:c"]);
  });

  test("行の数を指すものは末尾に入る。行が無くても並ぶ (字幕の無い動画)", () => {
    const { panel } = setup();
    panel.update(view({ header: { kind: "none" }, rows: [], items: [{ ...SEGMENT, before: 0 }, { ...MANUAL, before: 0 }] }));
    expect(listChildren()).toEqual(["segment", "telop"]);
  });

  test("見出しに区間の番号・頭と尻・長さを出し、詰めている区間には「· 詰めている」", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT], trimmingIndex: -1 }));
    expect(header().querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1");
    expect(header().querySelector("[data-role='segment-range']")?.textContent).toBe("1:04.80 – 1:13.30 · 8.5 秒");
    expect(header().dataset.selected).toBe("false");

    panel.update(view({ items: [SEGMENT], trimmingIndex: 0 }));
    expect(header().querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1 · 詰めている");
    expect(header().dataset.selected).toBe("true");
  });

  test("見出しを押すと選び、✕ で消す (✕ は選ばない)", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [SEGMENT] }));
    header().click();
    expect(callbacks.onSelectSegment).toHaveBeenCalledWith(0);
    header().querySelector<HTMLElement>("[data-role='remove']")!.click();
    expect(callbacks.onRemoveSegment).toHaveBeenCalledWith(0);
    expect(callbacks.onSelectSegment).toHaveBeenCalledTimes(1);
    // 見出しを押しても行の入れ外しにはならない
    expect(callbacks.onToggle).not.toHaveBeenCalled();
  });

  test("手入力の行は時刻と文字を出し、空の文字は「まだ書いていません」", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    expect(manual().dataset.telopIndex).toBe("2");
    expect(inManual("manual-time")?.textContent).toBe("1:06");
    expect(inManual("manual-text")?.textContent).toBe("ここ重要");
    expect(inManual("manual-text")?.dataset.empty).toBe("false");

    panel.update(view({ items: [{ ...MANUAL, text: "" }] }));
    expect(inManual("manual-text")?.textContent).toBe("（まだ書いていません）");
    expect(inManual("manual-text")?.dataset.empty).toBe("true");
  });

  test("手入力の行の文字はタグとして解釈しない", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, text: "<img src=x onerror=alert(1)>" }] }));
    expect(document.querySelector("img")).toBeNull();
  });

  test("区間の外の手入力の行には「(区間外)」が付く", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, inSegment: false }] }));
    expect(manual().dataset.inSegment).toBe("false");
    expect(inManual("telop-outside")?.textContent).toBe("(区間外)");
    panel.update(view({ items: [MANUAL] }));
    expect(inManual("telop-outside")).toBeNull();
  });

  test("頭を今に・尻を今に・✕・時刻を押すと、テロップの位置で伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("set-start")!.click();
    inManual("set-end")!.click();
    inManual("manual-time")!.click();
    inManual("remove")!.click();
    expect(callbacks.onManualEdge).toHaveBeenNthCalledWith(1, 2, "start");
    expect(callbacks.onManualEdge).toHaveBeenNthCalledWith(2, 2, "end");
    expect(callbacks.onPlayManual).toHaveBeenCalledWith(2);
    expect(callbacks.onRemoveManual).toHaveBeenCalledWith(2);
  });

  test("押せない間 (録画中など) は手入力の行を変えないが、時刻からの再生は伝える", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL], enabled: false }));
    inManual("set-start")!.click();
    inManual("remove")!.click();
    inManual("manual-edit-button")!.click();
    inManual("manual-time")!.click();
    expect(callbacks.onManualEdge).not.toHaveBeenCalled();
    expect(callbacks.onRemoveManual).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    expect(callbacks.onPlayManual).toHaveBeenCalledWith(2);
  });

  test("✎ で直す欄が開き、Enter でテロップの位置と文字を伝えて閉じる", () => {
    const { panel, callbacks } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    expect(editor()?.value).toBe("ここ重要");
    editor()!.value = "ここ大事";
    key(editor()!, { key: "Enter" });
    expect(callbacks.onManualText).toHaveBeenCalledWith(2, "ここ大事");
    expect(editor()).toBeNull();
  });

  test("送らなかった (上限を超えた) ときは直す欄を閉じない", () => {
    const { panel } = setup({ onManualText: vi.fn(() => false) });
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    editor()!.value = "あ".repeat(501);
    key(editor()!, { key: "Enter" });
    expect(editor()?.value).toBe("あ".repeat(501));
  });

  test("直している間に状態が届いても、書きかけとフォーカスを残す", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    editor()!.value = "書きかけ";
    // ほかの操作 (別の行の入れ外し) の答え。手入力の行の並びは同じ
    panel.update(view({ items: [MANUAL], trimmingIndex: 0 }));
    expect(editor()?.value).toBe("書きかけ");
    expect(document.activeElement).toBe(editor());
  });

  test("手入力の行の数が変わったら直す欄を閉じる (位置がずれて別のテロップに書き込まない)", () => {
    const { panel } = setup();
    panel.update(view({ items: [MANUAL] }));
    inManual("manual-edit-button")!.click();
    panel.update(view({ items: [{ ...MANUAL, telopIndex: 1, startSec: 60 }, MANUAL] }));
    expect(editor()).toBeNull();
  });

  test("数が同じでも位置が詰まったら閉じる (前の字幕の行を外して、行のテロップが消えたとき)", () => {
    // テロップが [行 L0, 手 M1, 手 M2] のとき M1 を直し始め、L0 の行を外すと [M1 (0), M2 (1)] になる。
    // manual:1 はまだあり数も 2 のままだが、閉じないと Enter で M2 を上書きする
    const { panel } = setup();
    const m1 = { ...MANUAL, telopIndex: 1, startSec: 66 };
    const m2 = { ...MANUAL, telopIndex: 2, startSec: 68, text: "二つ目" };
    panel.update(view({ items: [m1, m2] }));
    document.querySelector<HTMLElement>("[data-telop-index='1'] [data-role='manual-edit-button']")!.click();
    expect(editor()).not.toBeNull();
    panel.update(view({ items: [{ ...m1, telopIndex: 0 }, { ...m2, telopIndex: 1 }] }));
    expect(editor()).toBeNull();
  });

  test("editManual で直す欄を開く (足した直後)", () => {
    const { panel } = setup();
    panel.update(view({ items: [{ ...MANUAL, text: "" }] }));
    panel.editManual(2);
    expect(editor()?.value).toBe("");
    expect(document.activeElement).toBe(editor());
  });

  test("「＋ ここに字幕を足す」は区間があって押せるときだけ押せる", () => {
    const { panel, callbacks } = setup();
    const add = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-role='add-telop']")!;
    panel.update(view({ canAddManual: false }));
    expect(add().textContent).toBe("＋ ここに字幕を足す");
    expect(add().disabled).toBe(true);
    expect(add().title).toBe("先に区間を作ってください (行を押す・IN / OUT・＋ 区間を追加)");

    panel.update(view({ canAddManual: true, enabled: false }));
    expect(add().disabled).toBe(true);

    panel.update(view({ canAddManual: true }));
    expect(add().disabled).toBe(false);
    add().click();
    expect(callbacks.onAddManual).toHaveBeenCalledTimes(1);
  });

  test("字幕の無い動画の案内は、区間を作ってから足す道を出す", () => {
    const { panel } = setup();
    panel.update(view({ header: { kind: "none" }, rows: [] }));
    expect(role("transcript-notice")?.textContent).toBe(
      "この動画には公式字幕がありません。IN / OUT で区間を作り、＋ ここに字幕を足す でテロップを足せます",
    );
  });

  test("reveal は差し込んだ要素を返し、欄の中をそこまで送る", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(panel.reveal({ kind: "segment", index: 0 })).toBe(header());
    expect(panel.reveal({ kind: "manual", telopIndex: 2 })).toBe(manual());
    expect(panel.reveal({ kind: "manual", telopIndex: 9 })).toBeNull();
  });

  test("差し込むものが同じなら作り直さない", () => {
    const { panel } = setup();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    const before = header();
    panel.update(view({ items: [SEGMENT, MANUAL] }));
    expect(header()).toBe(before);
  });
});
```

既存のテストのうち、字幕の無い動画の案内の文言を確かめているもの (`grep -n "公式字幕がありません" tests/content/*.test.ts`) は、上の新しい文言に合わせる。

- [ ] **Step 10: 失敗を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts` (timeout 300000)
期待: FAIL (新しい describe の各テスト。型も通らない)

- [ ] **Step 11: 見た目を足す**

`src/content/styles.ts` の `const TRANSCRIPT_TEXT = ...` の後に足す:

```ts
/** 手入力の行。時刻・印・文字の 3 列で、操作は次の段 (2 列目から) に折り返して並べる */
const TRANSCRIPT_MANUAL =
  "display:grid;grid-template-columns:12px 40px 1fr;gap:4px;align-items:start;padding:3px 6px;border-radius:6px;user-select:none;";
```

`TRANSCRIPT_STYLE` の `actions: "display:flex;gap:4px;",` の後に足す:

```ts
  /** 区間の見出し。押せる (その区間を詰める)。区間の境目が分かるよう上に線を引く */
  segment:
    "display:flex;gap:8px;align-items:center;padding:6px 6px 2px;margin-top:4px;border-top:1px solid var(--ytc-border);cursor:pointer;user-select:none;font-size:11px;",
  segmentTitle: "color:var(--ytc-accent);font-weight:700;white-space:nowrap;",
  segmentRange:
    "color:var(--ytc-text-sub);font-variant-numeric:tabular-nums;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  /** 手入力の行。字幕の行と見分けるため、左の線を点線にする。区間の外は薄く */
  manual: `${TRANSCRIPT_MANUAL}background:var(--ytc-surface);border-left:3px dashed var(--ytc-accent);`,
  manualOutside: `${TRANSCRIPT_MANUAL}background:transparent;border-left:3px dashed var(--ytc-border);opacity:0.7;`,
  manualMark: "color:var(--ytc-accent);font-size:10px;padding-top:3px;",
  manualEmpty: `${TRANSCRIPT_TEXT}color:var(--ytc-text-sub);font-style:italic;`,
  manualActions: "grid-column:2 / -1;display:flex;gap:4px;flex-wrap:wrap;align-items:center;",
  outside: "color:var(--ytc-text-sub);font-size:11px;",
```

- [ ] **Step 12: 欄に描く**

`src/content/transcript-panel.ts`:

import を直す:

```ts
import { TRANSCRIPT_STYLE } from "@/content/styles";
import type { ManualTelopItem, SegmentHeaderItem, TranscriptItem } from "@/content/transcript-items";
import { formatSecTenths, formatTime, formatTimeCentis } from "@/shared/time";
```

`TranscriptView` に足す (`enabled: boolean;` の後):

```ts
  /** 行の間に差し込む区間の見出しと手入力の行 (`placeTranscriptItems`) */
  items: TranscriptItem[];
  /** 詰める欄で詰めている区間 (0 始まり)。無ければ -1 */
  trimmingIndex: number;
  /** 「＋ ここに字幕を足す」を押せるか (区間があり、テロップを変えられる)。押せる / 押せないは enabled も見る */
  canAddManual: boolean;
```

`TranscriptPanelCallbacks` に足す (`onRetry(): void;` の前):

```ts
  /** 区間の見出しを押した。その区間を詰める */
  onSelectSegment(index: number): void;
  /** 区間の見出しの ✕ */
  onRemoveSegment(index: number): void;
  /** 「＋ ここに字幕を足す」 */
  onAddManual(): void;
  /** 手入力の行の「頭を今に」「尻を今に」 */
  onManualEdge(telopIndex: number, edge: "start" | "end"): void;
  /** 手入力の行の文字の確定。送らなかったら false (直す欄を閉じない) */
  onManualText(telopIndex: number, text: string): boolean;
  onRemoveManual(telopIndex: number): void;
  /** 手入力の行の時刻を押した。その頭から再生する */
  onPlayManual(telopIndex: number): void;
```

`TranscriptPanel` に足す (`setCurrentTime` の後):

```ts
  /** 手入力の行の直す欄を開く (足した直後に文字を打てるように) */
  editManual(telopIndex: number): void;
  /** 見出しか手入力の行を欄の中で見える所へ送り、その要素を返す (無ければ null)。窓のスクロールは youtube.ts が決める */
  reveal(target: RevealTarget): HTMLElement | null;
```

`export type TranscriptPanel` の前に足す:

```ts
export type RevealTarget = { kind: "segment"; index: number } | { kind: "manual"; telopIndex: number };
```

定数 (`DUBBED_TEXT` の後) に足す:

```ts
const NONE_TEXT = "この動画には公式字幕がありません。IN / OUT で区間を作り、＋ ここに字幕を足す でテロップを足せます";
const EMPTY_MANUAL_TEXT = "（まだ書いていません）";
const ADD_MANUAL_TITLE = "今の再生位置から 3 秒の字幕 (テロップ) を足す";
const ADD_MANUAL_BLOCKED_TITLE = "先に区間を作ってください (行を押す・IN / OUT・＋ 区間を追加)";

/** 手入力の行を直しているときの editing.id。字幕の行の id (`youtube-asr:1.00` など) と混ざらない */
const manualId = (telopIndex: number): string => `manual:${telopIndex}`;
const manualIndexOf = (id: string): number | null => (id.startsWith("manual:") ? Number(id.slice("manual:".length)) : null);
const manualOrder = (items: readonly TranscriptItem[]): string =>
  JSON.stringify(items.flatMap((item) => (item.kind === "manual" ? [item.telopIndex] : [])));
```

`createTranscriptPanel` の中:

`header.append(title, source);` を次に置き換える:

```ts
  const addManual = document.createElement("button");
  addManual.dataset.role = "add-telop";
  addManual.textContent = "＋ ここに字幕を足す";
  addManual.style.cssText = TRANSCRIPT_STYLE.textButton;
  addManual.addEventListener("click", () => {
    if (view.enabled && view.canAddManual) callbacks.onAddManual();
  });
  header.append(title, source, addManual);
```

`let view: TranscriptView = { ... }` の初期値に `items: [], trimmingIndex: -1, canAddManual: false` を足す。その後に足す:

```ts
  /** 行の間に差し込んだ要素 (見出しと手入力の行)。描くたびに作り直す (数個しかない) */
  let extras: HTMLElement[] = [];
  /** 前に差し込んだときの中身。同じなら作り直さない (直す欄の書きかけとフォーカスを残す) */
  let extrasKey = "";
  let manualEditor: HTMLTextAreaElement | null = null;
  /**
   * 手入力の行を直し始めたときの、手入力の行の telopIndex の並び。変わったら位置がずれうるので閉じる
   * (別の手入力の行の ✕ だけでなく、字幕の行を外して行のテロップが消えても、後ろの index は詰まる)
   */
  let editingManualOrder = "";
```

クリックの受け口 (`list.addEventListener("click", ...)`) の `if (target.closest("[data-role='line-edit']") !== null) return;` の直後に足す:

```ts
    const headerElement = target.closest<HTMLElement>("[data-role='segment']");
    if (headerElement !== null) {
      // 見出しは録画中でも伝える (選べるかは youtube.ts が決める。区間の一覧と同じ)
      const index = Number(headerElement.dataset.index);
      if (target.closest("[data-role='remove']") !== null) callbacks.onRemoveSegment(index);
      else callbacks.onSelectSegment(index);
      return;
    }
    const manualElement = target.closest<HTMLElement>("[data-role='telop']");
    if (manualElement !== null) {
      const index = Number(manualElement.dataset.telopIndex);
      const manualAction = target.closest<HTMLElement>(
        "[data-role='manual-time'], [data-role='manual-edit-button'], [data-role='set-start'], [data-role='set-end'], [data-role='remove']",
      )?.dataset.role;
      if (manualAction === "manual-time") {
        callbacks.onPlayManual(index);
        return;
      }
      if (!view.enabled) return;
      if (manualAction === "manual-edit-button") startEdit(manualId(index));
      else if (manualAction === "set-start") callbacks.onManualEdge(index, "start");
      else if (manualAction === "set-end") callbacks.onManualEdge(index, "end");
      else if (manualAction === "remove") callbacks.onRemoveManual(index);
      return;
    }
```

`renderHeader` の `if (h.kind === "none") notice.textContent = "この動画には公式字幕がありません";` を `if (h.kind === "none") notice.textContent = NONE_TEXT;` にする。`renderHeader` の末尾に足す:

```ts
    addManual.disabled = !(view.enabled && view.canAddManual);
    addManual.title = view.canAddManual ? ADD_MANUAL_TITLE : ADD_MANUAL_BLOCKED_TITLE;
```

`startEdit` を置き換える:

```ts
  function startEdit(id: string): void {
    const manual = manualIndexOf(id);
    if (manual !== null) {
      const item = view.items.find((it): it is ManualTelopItem => it.kind === "manual" && it.telopIndex === manual);
      if (item === undefined) return;
      editing = { id, draft: item.text };
      editingManualOrder = manualOrder(view.items);
    } else {
      const row = view.rows.find((item) => item.id === id);
      if (row === undefined || !row.selected || !row.hasTelop) return;
      editing = { id, draft: row.text };
    }
    patchRows();
    // ページは動かさない (足した直後に開くとき、窓がページの中にあるとブラウザがページごと送る)。
    // 欄の中で見せるのは reveal、窓の中で見せるのは youtube.ts の revealInWindow の役目
    editor?.focus({ preventScroll: true });
  }
```

`finishEdit` を置き換える:

```ts
  function finishEdit(commit: boolean): void {
    if (editing === null) return;
    if (editor !== null) editing.draft = editor.value;
    if (commit) {
      const manual = manualIndexOf(editing.id);
      const sent =
        manual === null ? callbacks.onEditText(editing.id, editing.draft) : callbacks.onManualText(manual, editing.draft);
      if (!sent) return;
    }
    editing = null;
    patchRows();
  }
```

`patchRows` の前に足す:

```ts
  function buildSegmentHeader(item: SegmentHeaderItem): HTMLElement {
    const element = document.createElement("div");
    element.dataset.role = "segment";
    element.dataset.index = String(item.index);
    const trimming = item.index === view.trimmingIndex;
    element.dataset.selected = trimming ? "true" : "false";
    element.style.cssText = TRANSCRIPT_STYLE.segment;
    element.title = "この区間を詰める";
    const title = document.createElement("span");
    title.dataset.role = "segment-title";
    title.style.cssText = TRANSCRIPT_STYLE.segmentTitle;
    title.textContent = trimming ? `区間 ${item.index + 1} · 詰めている` : `区間 ${item.index + 1}`;
    const range = document.createElement("span");
    range.dataset.role = "segment-range";
    range.style.cssText = TRANSCRIPT_STYLE.segmentRange;
    range.textContent = `${formatTimeCentis(item.startSec)} – ${formatTimeCentis(item.endSec)} · ${formatSecTenths(item.endSec - item.startSec)} 秒`;
    element.append(title, range, makeButton("remove", "✕", "この区間を消す"));
    return element;
  }

  function buildManualRow(item: ManualTelopItem): HTMLElement {
    const element = document.createElement("div");
    element.dataset.role = "telop";
    element.dataset.telopIndex = String(item.telopIndex);
    element.dataset.inSegment = item.inSegment ? "true" : "false";
    element.style.cssText = item.inSegment ? TRANSCRIPT_STYLE.manual : TRANSCRIPT_STYLE.manualOutside;
    const mark = document.createElement("span");
    mark.style.cssText = TRANSCRIPT_STYLE.manualMark;
    mark.textContent = "＋";
    mark.title = "手で足した字幕";
    const time = document.createElement("button");
    time.dataset.role = "manual-time";
    time.title = "このテロップの頭から再生";
    time.style.cssText = TRANSCRIPT_STYLE.time;
    time.textContent = formatTime(item.startSec);
    let body: HTMLElement;
    if (editing?.id === manualId(item.telopIndex)) {
      manualEditor = makeEditor(manualId(item.telopIndex));
      body = manualEditor;
    } else {
      body = document.createElement("span");
      body.dataset.role = "manual-text";
      body.dataset.empty = item.text === "" ? "true" : "false";
      body.textContent = item.text === "" ? EMPTY_MANUAL_TEXT : item.text;
      body.style.cssText = item.text === "" ? TRANSCRIPT_STYLE.manualEmpty : TRANSCRIPT_STYLE.text;
    }
    const actions = document.createElement("span");
    actions.style.cssText = TRANSCRIPT_STYLE.manualActions;
    if (!item.inSegment) {
      const outside = document.createElement("span");
      outside.dataset.role = "telop-outside";
      outside.style.cssText = TRANSCRIPT_STYLE.outside;
      outside.textContent = "(区間外)";
      actions.append(outside);
    }
    actions.append(
      makeButton("manual-edit-button", "✎", "テロップの文字を直す"),
      makeButton("set-start", "頭を今に", "出し始めを今の再生位置に合わせる"),
      makeButton("set-end", "尻を今に", "出し終わりを今の再生位置に合わせる"),
      makeButton("remove", "✕", "このテロップを消す"),
    );
    element.append(mark, time, body, actions);
    return element;
  }

  /**
   * 見出しと手入力の行を、指した行の前に差し込む。中身が前と同じで、まだ欄の中にあれば何もしない
   * (行を作り直すと list.replaceChildren で外れるので、そのときは差し込み直す)
   */
  function placeExtras(): void {
    const key = JSON.stringify([view.items, view.trimmingIndex, editing?.id ?? null]);
    if (key === extrasKey && extras.every((element) => element.parentElement === list)) {
      if (manualEditor !== null) editor = manualEditor;
      return;
    }
    const hadFocus = manualEditor !== null && document.activeElement === manualEditor;
    extrasKey = key;
    for (const element of extras) element.remove();
    // buildManualRow が .map の中で書き換える。TS はそれを追わず null に絞るので、型を広げておく
    manualEditor = null as HTMLTextAreaElement | null;
    extras = view.items.map((item) => (item.kind === "segment" ? buildSegmentHeader(item) : buildManualRow(item)));
    // 同じ行の前に入るものは、並びの順に同じ行の前へ足していくと順が保たれる
    view.items.forEach((item, i) => list.insertBefore(extras[i]!, parts[item.before]?.element ?? null));
    if (manualEditor !== null) {
      editor = manualEditor;
      if (hadFocus) manualEditor.focus({ preventScroll: true });
    }
  }
```

`patchRows` の末尾 (`view.rows.forEach((row, i) => paintRow(parts[i]!, row));` の後) に `placeExtras();` を足す。

`update` の「直している行が区間から外れたら、直す欄を閉じる」の 1 行を置き換える:

```ts
      // 直している行が区間から外れたら、直す欄を閉じる。手入力の行は、手入力の行の telopIndex の並びが変わった
      // (位置がずれて別のテロップに書き込みうる) ら閉じる
      if (editing !== null) {
        const manual = manualIndexOf(editing.id);
        const keep =
          manual === null
            ? next.rows.some((row) => row.id === editing?.id && row.selected && row.hasTelop)
            : manualOrder(next.items) === editingManualOrder;
        if (!keep) editing = null;
      }
```

返す object の `setCurrentTime` の後に足す:

```ts
    editManual(telopIndex): void {
      startEdit(manualId(telopIndex));
    },
    reveal(target): HTMLElement | null {
      const selector =
        target.kind === "segment"
          ? `[data-role='segment'][data-index='${target.index}']`
          : `[data-role='telop'][data-telop-index='${target.telopIndex}']`;
      const found = list.querySelector<HTMLElement>(selector);
      if (found === null) return null;
      const before = list.scrollTop;
      list.scrollTop = Math.max(0, found.offsetTop - list.clientHeight / 3);
      if (list.scrollTop !== before) scrollingByUs = true;
      // 再生位置を追う動き (follow) で、見せた所から引き戻さない
      userScrolledAt = Date.now();
      return found;
    },
```

`target.index` と `target.telopIndex` は number (型で決まる) なので、セレクタに入れても文字列の注入にならない。

- [ ] **Step 13: youtube.ts の型を通す (仮の値)**

`src/content/youtube.ts` の `refreshTranscript` の `transcriptPanel.update({` に足す (`enabled: canEditFromTranscript(),` の後):

```ts
    // 区間の見出しと手入力の行は Task 3・4 で繋ぐ
    items: [],
    trimmingIndex: -1,
    canAddManual: false,
```

`createTranscriptPanel({` の呼び出しに足す (`onRetry` の前):

```ts
    onSelectSegment: () => undefined,
    onRemoveSegment: () => undefined,
    onAddManual: () => undefined,
    onManualEdge: () => undefined,
    onManualText: () => false,
    onRemoveManual: () => undefined,
    onPlayManual: () => undefined,
```

- [ ] **Step 14: 通過を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts tests/content/transcript-items.test.ts tests/content/youtube-transcript-panel.test.ts` と `npm run typecheck` (timeout 300000)
期待: PASS

- [ ] **Step 15: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/time.ts src/content/trim-panel.ts src/content/transcript-items.ts src/content/transcript-panel.ts src/content/styles.ts src/content/youtube.ts tests/shared/time.test.ts tests/content/transcript-items.test.ts tests/content/transcript-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "feat(content): 文字起こしの欄に区間の見出しと手入力の行を差し込めるようにする

Why: 区間とテロップの一覧を外したあと、区間を選ぶ・消す場所と、行に無い文言のテロップを足す場所を
欄に置く (ADR 0003)。行の要素は使い回し、数個しかない見出しと手入力の行だけを描くたびに作り直す"
```

(youtube-transcript-panel のテストで「公式字幕がありません」の文言を直したら、そのファイルも add する。)

---

### Task 3: 区間の見出しを繋ぎ、区間の一覧を外す

**Files:**
- Modify: `src/content/youtube.ts`、`src/content/trim-panel.ts`、`src/content/styles.ts`
- Delete: `src/content/segment-list.ts`、`tests/content/segment-list.test.ts`
- Test: `tests/content/trim-panel.test.ts`、`tests/content/youtube.test.ts`、`tests/content/youtube-transcript-panel.test.ts`

**Interfaces:**
- Consumes: Task 2 の `placeTranscriptItems`、`TranscriptView.items / trimmingIndex`、`onSelectSegment` / `onRemoveSegment`、`reveal`
- Produces: `TrimView.maxClipSec: number` (見出しの「合計 N / M 秒」)。`removeSegment(index: number): void` (youtube.ts の中)

- [ ] **Step 1: 詰める欄の合計と上限の失敗するテストを書く**

`tests/content/trim-panel.test.ts` の `VIEW` と `EMPTY` (ファイル冒頭の TrimView の定数) に `maxClipSec: 60` を足す (`totalSec` の後)。「何番目の区間か、頭と尻・長さ・合計を出す」の期待を直す:

```ts
    expect(part(panel, "trim-range").textContent).toBe("12:21.40 – 12:29.80 · 8.4 秒 · 合計 24.6 / 60 秒");
```

同じ describe (`describe("見出しの行")`) に足す:

```ts
  test("合計が上限を超えたら警告の印と色を付ける (区間の一覧の合計の役目)", () => {
    const { panel } = mount({ ...VIEW, totalSec: 61.2, maxClipSec: 60 });
    expect(part(panel, "trim-range").textContent).toContain("合計 61.2 / 60 秒");
    expect(part(panel, "trim-range").dataset.over).toBe("true");
    expect(part(panel, "trim-range").style.cssText).toContain("font-weight: 600");

    panel.update({ ...VIEW, totalSec: 24.6, maxClipSec: 60 });
    expect(part(panel, "trim-range").dataset.over).toBe("false");
  });
```

- [ ] **Step 2: 失敗を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts` (timeout 300000)
期待: FAIL

- [ ] **Step 3: 詰める欄に上限を出す**

`src/content/styles.ts` の `TRIM_STYLE` の `range:` の後に足す:

```ts
  /** 合計が上限を超えた。色だけで伝えない (「/ 60 秒」の文言と太さでも分かる) */
  rangeOver: "color:#f28b82;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;",
```

`src/content/trim-panel.ts`:

- `TrimView` の `totalSec: number;` の後に `/** 1 本のクリップの上限の秒数 (設定)。合計がこれを超えると録画できない */\n  maxClipSec: number;` を足す
- `let view: TrimView = { ... }` の初期値に `maxClipSec: 0` を足す
- `paint` の `rangeText.textContent = ...` の行を置き換える:

```ts
      const over = view.totalSec > view.maxClipSec;
      rangeText.textContent = `${formatTimeCentis(range.startSec)} – ${formatTimeCentis(range.endSec)} · ${formatSecTenths(length)} 秒 · 合計 ${formatSecTenths(view.totalSec)} / ${view.maxClipSec} 秒`;
      rangeText.dataset.over = over ? "true" : "false";
      rangeText.style.cssText = over ? TRIM_STYLE.rangeOver : TRIM_STYLE.range;
```

- 区間が無いときの枝 (`rangeText.textContent = "文字起こしの行を押すか、＋ 区間を追加 で作れます";`) の後に `rangeText.dataset.over = "false";\n      rangeText.style.cssText = TRIM_STYLE.range;` を足す

上限を超えたかの判定は `isOverLimit` (`src/shared/timeline.ts`) と同じ「合計 > 上限」。`isOverLimit` は区間の配列を取るので、ここでは合計の数で比べる。

`src/content/youtube.ts` の `refreshTrimPanel` の `totalSec: totalSec(segments),` の後に `maxClipSec,` を足す。

- [ ] **Step 4: 通過を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts` (timeout 300000)
期待: PASS

- [ ] **Step 5: 見出しの失敗するテストを書く**

`tests/content/youtube-transcript-panel.test.ts` に describe を足す (ファイル末尾。`ready()` で 3 行 (1〜3 秒・4〜6 秒・7〜9 秒) が出る):

```ts
describe("区間の見出し (段階 1c-2)", () => {
  const headers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#yt-clip-list [data-role='segment']")];

  test("行を押すと、その行の上に区間の見出しが出て、詰めている区間に印が付く", async () => {
    ready();
    await flush();
    rows()[1]!.click();
    await flush();
    const list = document.querySelector<HTMLElement>("[data-role='transcript-lines']")!;
    const order = [...list.children].map((child) => (child as HTMLElement).dataset.role);
    expect(order).toEqual(["line", "segment", "line", "line"]);
    expect(headers()[0]?.querySelector("[data-role='segment-title']")?.textContent).toBe("区間 1 · 詰めている");
  });

  test("見出しを押すとその区間を詰める欄で詰める", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    // 3 秒より空いていないので 1 つに繋がらないよう、離れた区間を状態で作る
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 6.8, endSec: 9.3 }],
      telops: [],
      meta: META,
    });
    await flush();
    headers()[0]!.click();
    await flush();
    expect(document.querySelector("[data-role='trim-title']")?.textContent).toBe("区間 1 を詰める");
    expect(headers()[0]?.dataset.selected).toBe("true");
    expect(headers()[1]?.dataset.selected).toBe("false");
  });

  test("見出しの ✕ でその区間を消す", async () => {
    emit({
      kind: "ready",
      segments: [{ startSec: 0.8, endSec: 3.3 }, { startSec: 6.8, endSec: 9.3 }],
      telops: [],
      meta: META,
    });
    await flush();
    events = [];
    headers()[1]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events).toEqual([{ type: "REMOVE_SEGMENT", index: 1 }]);
    expect(headers()).toHaveLength(1);
  });
});
```

- [ ] **Step 6: 失敗を確認**

実行: `npx vitest run tests/content/youtube-transcript-panel.test.ts` (timeout 300000)
期待: FAIL (見出しが出ない)

- [ ] **Step 7: youtube.ts で見出しを繋ぎ、区間の一覧を外す**

`src/content/youtube.ts`:

1. import: `import { createSegmentList, type SegmentList } from "@/content/segment-list";` を消し、`import { placeTranscriptItems } from "@/content/transcript-items";` を足す
2. `let segmentList: SegmentList | null = null;` を消す。`resetModuleState` の `segmentList = null;` を消す
3. `applyStateToSelection` の 1 行目のコメントと `segmentList?.update(listedItems().segments, selectedIndex, maxClipSec);` を `refreshTranscript();` に置き換える (欄の見出しの「· 詰めている」を選び直した区間に合わせる。`refreshTranscript` は最後に `refreshTrimPanel` を呼ぶので、直後の `refreshTrimPanel();` の行は消す)
4. `buildBar` の `segmentList = createSegmentList({ ... });` の塊を消し、その代わりに `buildBar` の前 (関数の外) に足す:

```ts
/**
 * 区間を消す (欄の見出しの ✕)。**テロップが残っている間は最後の 1 区間を消させない。** 区間が 0 個に
 * なると状態機械は idle に戻り、手入力の文言もまとめて消える
 */
function removeSegment(index: number): void {
  if (busy) return;
  if (index < 0 || index >= currentSegments.length) return;
  if (currentSegments.length === 1 && currentTelops.length > 0) {
    setStatus(telopsRemainMessage(currentTelops.length));
    return;
  }
  removedIndexOnNextState = index;
  send({ type: "REMOVE_SEGMENT", index });
}

/** 欄の見出しを押した。その区間を詰める (区間の一覧の行と同じ。録画中は選び直さない) */
function selectSegment(index: number): void {
  if (busy) return;
  if (index < 0 || index >= listedItems().segments.length) return;
  selectedIndex = index;
  applyStateToSelection();
}
```

5. `createTranscriptPanel({` の `onSelectSegment: () => undefined,` を `onSelectSegment: selectSegment,` に、`onRemoveSegment: () => undefined,` を `onRemoveSegment: removeSegment,` にする
6. 詰める欄の `onSelect` (‹ ›) を `onSelect: selectSegment,` にする (中身が同じ。‹ › は録画中は押せない見た目になっているので、busy で止めても変わらない)
7. `refreshTranscript` の仮の値を直す:

```ts
    // 区間の見出し。手入力の行は Task 4 で繋ぐ (それまではテロップの一覧が出す)
    items: placeTranscriptItems(lines, segments, []),
    trimmingIndex: segments.length === 0 ? -1 : selectedIndex,
    canAddManual: false,
```

8. `refreshLists` の `segmentList?.setEnabled(!busy);` と `segmentList?.update(segments, selectedIndex, maxClipSec);` を消す (`const { segments, telops } = listedItems();` の `segments` が使われなくなったら `const { telops } = listedItems();` にする)
9. `listWindow.body.replaceChildren(transcriptPanel.element, segmentList.element, telopList.element);` → `listWindow.body.replaceChildren(transcriptPanel.element, telopList.element);`
10. 足した区間を見せる。`revealRow` を置き換える:

```ts
/**
 * 足した見出しや行を見せる。ページの中ならタブを前に出すだけ (ページは動かさない)、浮いた窓なら窓の中をそこまで送る
 * (右側パネルの spec §3)。欄の中のスクロールは transcriptPanel.reveal が済ませている
 */
function revealInWindow(row: HTMLElement | null): void {
  if (row === null || listWindow.element.hidden) return;
  if (isDockedInPage("list")) {
    dockManager.activate("list");
    return;
  }
  listWindow.scrollTo(row);
}
```

`applyStateToDisplay` の 2 行を置き換える:

```ts
  if (revealSegment) revealInWindow(transcriptPanel?.reveal({ kind: "segment", index: selectedIndex }) ?? null);
  if (revealTelop) {
    const rows = telopList?.element.querySelectorAll<HTMLElement>("[data-role='telop']");
    revealInWindow(rows?.[rows.length - 1] ?? null);
  }
```

(テロップの側は Task 4 で手入力の行に替える。)

11. `src/content/styles.ts` の `SEGMENT_STYLE` を消し、`TELOP_STYLE.iconButton: SEGMENT_STYLE.iconButton,` を値そのものにする:

```ts
  iconButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;min-width:28px;cursor:pointer;font-family:${FONT};font-size:12px;`,
```

12. `git rm src/content/segment-list.ts tests/content/segment-list.test.ts`

- [ ] **Step 8: 外した一覧に頼っていたテストを移す**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-transcript-panel.test.ts tests/content/styles.test.ts` (timeout 300000)

落ちたテストを次の規則で直す (見出しは区間の一覧と同じ `data-role='segment'`・`data-selected`・`[data-role='remove']` を持つので、多くはそのまま通る):

- **区間の一覧の行の文字** を見ていたテスト (`segmentRows()[0]?.textContent).toContain("1:23")` など): 見出しの文字は「区間 1」と「1:23.00 – 1:38.00 · 15.0 秒」。分と秒の部分 (`"1:23"`) はそのまま含まれる。「(15秒)」「1. 」のように一覧の書式に頼っていたら、見出しの書式 (`· 15.0 秒`・`区間 1`) に直す
- **「一覧は区間・テロップの窓に入り、…」** (`describe("区間・テロップの窓")`): 区間の一覧が無くなったので、体の子は 2 つ (文字起こしの欄 → テロップの一覧)。次に置き換える:

```ts
    // 文字起こしの欄 (区間の見出しはこの中) → テロップの一覧の順。設定は入らない (popup にある)
    expect(body.children.length).toBe(2);
    expect(body.children[0]?.getAttribute("data-role")).toBe("transcript");
    expect(body.children[0]?.querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(body.children[1]?.querySelector("[data-role='add-telop']")).not.toBeNull();
    expect(body.children[1]?.querySelectorAll("[data-role='telop']").length).toBe(1);
```

- **`addTelopButton()` の helper 2 か所** (`describe("テロップの一覧")` と `describe("足した行を区間・テロップの窓の見える範囲に入れる")` の中。`grep -n "function addTelopButton" tests/content/youtube.test.ts`): この時点では欄の見出しの行にも押せない `add-telop` があり、DOM で先に来るので `querySelector` は欄の方を取って何も送らない (「＋ テロップで今の位置から 3 秒…」「動画の終わりを超えるなら…」「テロップを足したら、…末尾の行へ送る」の 3 本が落ちる)。2 か所とも最後の 1 つを取る形にする (Task 4 Step 4 で元の `querySelector` に戻す):

```ts
  function addTelopButton(): HTMLButtonElement {
    // Task 3 の間だけ: 欄の「＋ ここに字幕を足す」(押せない) が先に来るので、テロップの一覧の「＋ テロップ」(最後の 1 つ) を取る
    const buttons = document.querySelectorAll<HTMLButtonElement>("[data-role='add-telop']");
    const button = buttons[buttons.length - 1];
    if (button === undefined) throw new Error("＋ テロップがありません");
    return button;
  }
```

  (同じ理由で、`body.children[1]?.querySelector(...)` のように子を指して数える。`listBody().querySelectorAll("[data-role='add-telop']")).toHaveLength(1)` のように窓全体で数えているテスト (「バーを 2 回作り直しても、…」) は、Task 4 で手入力の行を繋ぐまで `toHaveLength(2)` にし、コメント `// 欄の「＋ ここに字幕を足す」とテロップの一覧の「＋ テロップ」 (Task 4 で 1 つになる)` を付ける)
以下の 3 つは cross-review の実測では落ちなかった。落ちたときだけ当てる:

- **合計の文字** を区間の一覧で見ていたテスト: 詰める欄の `[data-role='trim-range']` の「合計 N / M 秒」と `data-over` で見る
- **区間の一覧の setEnabled (録画中に薄い)** を見ていたテスト: 見出しは欄の中にあり、欄の薄さは `canEditFromTranscript` で決まる。録画中に見出しを押しても選び直さない (`selectSegment` の busy) ことを確かめる形に直す
- **`describe("足した行を区間・テロップの窓の見える範囲に入れる")`** の `placeRows("segment")` を使う 4 本: 見出しは欄の行の箱 (`[data-role='transcript-lines']`) の子なので、`this.parentElement.children` の位置は見出しの並び (このファイルは文字起こしの行が無い) と同じ。期待の数字 (900 / 800) は変わらない。落ちたら、`placeRows` の `rectAt(900 + index * 100, 60)` の `index` が見出しの並びの位置になっているか (欄の行の箱の子に見出し以外が混ざっていないか) を見る

`styles.test.ts` が `SEGMENT_STYLE` を import していたら、その import とテストを消す。

- [ ] **Step 9: 通過を確認**

実行: `npx vitest run` と `npm run typecheck` (timeout 300000)
期待: PASS

- [ ] **Step 10: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add -A src/content tests/content
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "feat(content): 区間は文字起こしの欄の見出しで選んで消し、区間の一覧を外す

Why: 段階 1c-2。区間を選ぶ場所が一覧・欄の行・詰める欄の ‹ › の 3 つに割れていた。欄の見出しと ‹ › にまとめ、
一覧の合計と上限の警告は詰める欄の見出しに移す"
```

---

### Task 4: 手入力の行を繋ぎ、テロップの一覧を外す

**Files:**
- Modify: `src/content/youtube.ts`、`src/content/styles.ts`
- Delete: `src/content/telop-list.ts`、`tests/content/telop-list.test.ts`
- Test: `tests/content/youtube.test.ts`、`tests/content/youtube-transcript-panel.test.ts`

**Interfaces:**
- Consumes: Task 2 の `onAddManual` / `onManualEdge` / `onManualText` / `onRemoveManual` / `onPlayManual`、`editManual`、`reveal`。youtube.ts の既存の `onAddTelop()`・`onMoveTelopEdge(index, edge)`・`onTelopText(index, text): boolean`・`playTelop(index)`・`canEditTelops()`

- [ ] **Step 1: 手入力の行の失敗するテストを書く**

`tests/content/youtube-transcript-panel.test.ts` に describe を足す:

```ts
describe("手入力の行 (段階 1c-2・ADR 0003)", () => {
  const manualRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#yt-clip-list [data-role='telop']")];
  const addButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("#yt-clip-list [data-role='add-telop']")!;
  const lineEditor = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']");
  const video = (): HTMLVideoElement => document.querySelector<HTMLVideoElement>("video")!;

  test("区間が無いと押せない", async () => {
    ready();
    await flush();
    expect(addButton().disabled).toBe(true);
  });

  test("押すと今の位置から 3 秒のテロップを足し、行の時刻順の並びに入って文字を打つ欄が開く", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    Object.defineProperty(video(), "duration", { configurable: true, value: 600 });
    video().currentTime = 5;
    events = [];
    addButton().click();
    await flush();
    expect(events).toEqual([{ type: "ADD_TELOP", telop: { startSec: 5, endSec: 8, text: "" } }]);
    const list = document.querySelector<HTMLElement>("[data-role='transcript-lines']")!;
    const order = [...list.children].map((child) => {
      const el = child as HTMLElement;
      return el.dataset.role === "line" ? el.dataset.lineId : el.dataset.role;
    });
    // 5 秒は 4〜6 秒の行の後、7 秒の行の前
    expect(order).toEqual(["segment", "youtube-asr:1.00", "youtube-asr:4.00", "telop", "youtube-asr:7.00"]);
    expect(lineEditor()).not.toBeNull();
    expect(document.activeElement).toBe(lineEditor());
  });

  test("打って Enter でテロップの文字にする", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "" }], meta: META });
    await flush();
    events = [];
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='manual-edit-button']")!.click();
    lineEditor()!.value = "ここ重要";
    lineEditor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(events).toEqual([{ type: "UPDATE_TELOP", index: 0, telop: { startSec: 5, endSec: 8, text: "ここ重要" } }]);
  });

  test("頭を今に・尻を今に・✕", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    events = [];
    video().currentTime = 6;
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-start']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "UPDATE_TELOP", index: 0, telop: { startSec: 6, endSec: 8, text: "あ" } });
    video().currentTime = 7;
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='set-end']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "UPDATE_TELOP", index: 0, telop: { startSec: 6, endSec: 7, text: "あ" } });
    manualRows()[0]!.querySelector<HTMLElement>("[data-role='remove']")!.click();
    await flush();
    expect(events.at(-1)).toEqual({ type: "REMOVE_TELOP", index: 0 });
    expect(manualRows()).toHaveLength(0);
  });

  test("文字起こしを取り直しても手入力の行は残る", async () => {
    emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
    await flush();
    ready();
    await flush();
    expect(manualRows()).toHaveLength(1);
  });

  test("行から作ったテロップは手入力の行にしない", async () => {
    ready();
    await flush();
    rows()[0]!.click();
    await flush();
    expect(manualRows()).toHaveLength(0);
  });
});
```

`video()` の `duration` の stub は、このファイルが既に duration を決めていれば (`grep -n "duration" tests/content/youtube-transcript-panel.test.ts`) それに合わせて消す。

- [ ] **Step 2: 失敗を確認**

実行: `npx vitest run tests/content/youtube-transcript-panel.test.ts` (timeout 300000)
期待: FAIL

- [ ] **Step 3: youtube.ts で手入力の行を繋ぎ、テロップの一覧を外す**

`src/content/youtube.ts`:

1. import: `import { createTelopList, type TelopList } from "@/content/telop-list";` を消す
2. `let telopList: TelopList | null = null;` と `resetModuleState` の `telopList = null;` を消す
3. `buildBar` の `telopList = createTelopList({ ... });` の塊を消す。`listWindow.body.replaceChildren(transcriptPanel.element, telopList.element);` → `listWindow.body.replaceChildren(transcriptPanel.element);`。その上のコメント「区間とテロップの一覧は 1c まで欄の下に残す」を「区間の見出しと手入力の行も欄の中に出す (ADR 0003)」にする
4. `buildBar` の前に足す:

```ts
/** 手入力の行の ✕。手入力の行はテロップそのもの (ADR 0003) */
function removeTelop(index: number): void {
  if (!canEditTelops()) return;
  send({ type: "REMOVE_TELOP", index });
}
```

5. `createTranscriptPanel({` の仮の値を置き換える:

```ts
    onAddManual: onAddTelop,
    onManualEdge: onMoveTelopEdge,
    onManualText: onTelopText,
    onRemoveManual: removeTelop,
    onPlayManual: (index) => void playTelop(index),
```

6. `refreshTranscript` を直す:

```ts
    // 区間の見出しと手入力の行 (lineId の無いテロップ。ADR 0003)
    items: placeTranscriptItems(lines, segments, telops),
    trimmingIndex: segments.length === 0 ? -1 : selectedIndex,
    // 区間があり、テロップを変えられる (ready / posted で、範囲を作った動画を見ている)。canEditTelops は区間がある状態でしか true にならない
    canAddManual: canEditTelops(),
```

7. `applyStateToDisplay` のテロップを見せる枝を置き換える:

```ts
  if (revealTelop && currentTelops.length > 0) {
    // ＋ ここに字幕を足す の答え。足した行 (末尾のテロップ) の直す欄を開いて見せる
    const added = currentTelops.length - 1;
    transcriptPanel?.editManual(added);
    revealInWindow(transcriptPanel?.reveal({ kind: "manual", telopIndex: added }) ?? null);
  }
```

8. `refreshLists` を次にする (持ち越し「`refreshLists` が `refreshTrimPanel` を 2 回通る」。`refreshTranscript` が最後に `refreshTrimPanel` を呼ぶ):

```ts
function refreshLists(): void {
  refreshTranscript();
  refreshTelopTrack();
  refreshWindows();
}
```

コメント「一覧と帯の段を手元の写しに合わせて描き直し、…」は「欄 (区間の見出しと手入力の行)・帯の段・詰める欄を手元の写しに合わせて描き直し、窓を出すかを決め直す。」にする。`refreshTranscript` の末尾のコメント「(refreshLists からも呼ばれるので 2 回になるが冪等)」を「(詰める欄の単語・合計も欄と同じ写しから描く)」にする。

9. 持ち越し「有効・無効の決め方が重なっている」: `applyStateToDisplay` の `trimPanel?.setEnabled(canAdjustRange());` を消す (`refreshLists` → `refreshTranscript` → `refreshTrimPanel` が同じ値で決める)。`rangeBar?.setEnabled(canAdjustRange());` は残す (拡大バーの有効は `refreshTrimPanel` が決めていない)。mount の `trimPanel?.setEnabled(canAdjustRange());` も残す (mount は refreshLists より前に詰める欄を描く)
10. `src/content/styles.ts` の `TELOP_STYLE` を消し、`TRANSCRIPT_STYLE` の `edit` と `textButton` を値そのものにする:

```ts
  edit: `width:100%;box-sizing:border-box;min-height:40px;resize:vertical;border:1px solid var(--ytc-border);border-radius:6px;background:transparent;color:var(--ytc-text);font-family:${FONT};font-size:13px;padding:4px 6px;user-select:text;`,
  textButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;padding:0 8px;cursor:pointer;font-family:${FONT};font-size:12px;`,
```

`TRANSCRIPT_STYLE` の上のコメント「区間とテロップの一覧の上に並ぶので見た目を揃える。」を消し、「(欄の下の一覧に手が届くよう、高さに上限を持つ)」を「(窓の中で欄の見出しの行が流れて消えないよう、高さに上限を持つ)」にする。

11. `git rm src/content/telop-list.ts tests/content/telop-list.test.ts`

- [ ] **Step 4: 外した一覧に頼っていたテストを移す**

実行: `npx vitest run` (timeout 300000)

落ちたテストを次の規則で直す (手入力の行はテロップの一覧と同じ `data-role='telop'`・`set-start`・`set-end`・`remove`、「＋ ここに字幕を足す」は `add-telop` を持つ):

- **入力欄 (`textarea`) の change で文字を送っていたテスト** (`describe("テロップの一覧")` の「文言を確定すると UPDATE_TELOP を送る」「500 文字を超える文言は送らず、…」「500 文字を超えて送らなかった文言は、…」): ✎ で直す欄を開き、Enter で確定する形にする。例 (「文言を確定すると UPDATE_TELOP を送る」):

```ts
  test("文言を確定すると UPDATE_TELOP を送る", async () => {
    await showReady([TELOP]);
    telopRows()[0]?.querySelector<HTMLElement>("[data-role='manual-edit-button']")?.click();
    const editor = document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']");
    if (editor === null) throw new Error("直す欄がありません");

    editor.value = "やあ\n元気";
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(clipEvents().at(-1)).toEqual({
      type: "UPDATE_TELOP",
      index: 0,
      telop: { ...TELOP, text: "やあ\n元気" },
    });
  });
```

  「500 文字を超える…」は同じ手順で `"あ".repeat(501)` を Enter し、送らないこと・理由・`editor.value` が残ることを見て、`"あ".repeat(500)` で Enter すると送ることを見る。「送らなかった文言は、次の状態通知でも前の文言に戻さない」は、Enter で送らなかった後に `emit` しても `document.querySelector<HTMLTextAreaElement>("[data-role='line-edit']")?.value` が `"あ".repeat(501)` のままであることを見る (手入力の行の数は変わらないので直す欄は閉じない)
- **「＋ テロップで今の位置から 3 秒のテロップを送る」「動画の終わりを超えるなら終わりを詰める」**: `addTelopButton()` の探し方 (`[data-role='add-telop']`) はそのまま通る。名前の「＋ テロップ」を「＋ ここに字幕を足す」にする
- **「preview では操作できない」**: preview では欄が薄く (`enabled: false`)、`add-telop` は disabled、手入力の行の ✕ は伝えない。そのまま通る
- **`describe("足した行を…")` の「テロップを足したら、区間・テロップの窓の中を末尾の行へ送る」**: 足した行は直す欄が開いて作り直されるが、`placeRows("telop")` は `data-role='telop'` の要素を見るので通る。落ちたら、`placeRows` の `index` が欄の行の箱の子の位置 (見出し → テロップの順。このテストの区間は `RANGE` 1 つなので、見出し 1・テロップ 2 の 3 つ) になっていることに合わせて期待の数字を直す (末尾は 3 つ目 = `900 + 2 * 100` → scrollTop は 1000)
- **`addTelopButton()` の 2 か所**: Task 3 Step 8 で最後の 1 つを取る形にしたものを、元の `document.querySelector<HTMLButtonElement>("[data-role='add-telop']")` に戻す (欄の 1 つだけになる)
- **「バーを 2 回作り直しても、…」**: Task 3 で `toHaveLength(2)` にした `add-telop` の数を `toHaveLength(1)` に戻し、Task 3 で付けたコメントを消す
- **「一覧は区間・テロップの窓に入り、…」**: 体の子は 1 つ (文字起こしの欄) になる:

```ts
    // 文字起こしの欄だけ (区間の見出しと手入力の行はこの中)。設定は入らない (popup にある)
    expect(body.children.length).toBe(1);
    expect(body.children[0]?.getAttribute("data-role")).toBe("transcript");
    expect(body.children[0]?.querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(body.children[0]?.querySelector("[data-role='add-telop']")).not.toBeNull();
    expect(body.children[0]?.querySelectorAll("[data-role='telop']").length).toBe(1);
```

- **テロップの一覧の「(区間外)」**を見ていたテスト: 手入力の行の `[data-role='telop-outside']` で見る
- **youtube-transcript-panel の「最後の行を外すと手で足したテロップまで消えるときは、…(区間の一覧の ✕ と同じ)」**: 名前の「区間の一覧の ✕」を「見出しの ✕」にする

`styles.test.ts` が `TELOP_STYLE` を import していたら、その import とテストを消す。

- [ ] **Step 5: 通過を確認**

実行: `npx vitest run` と `npm run typecheck` (timeout 300000)
期待: PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add -A src/content tests/content
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "feat(content): 手入力のテロップは文字起こしの欄の行で足して直し、テロップの一覧を外す

Why: ADR 0003。テロップの置き場所を欄の 1 か所にまとめる。手入力の行は lineId の無いテロップそのものなので、
文字起こしを取り直しても残り、保存先は増えない。字幕の無い動画でも区間を作れば同じ手順で足せる"
```

---

### Task 5: 拡大バーの下のテロップの帯を外す

**Files:**
- Modify: `src/content/youtube.ts`、`src/content/trim-panel.ts`、`src/content/styles.ts`
- Delete: `src/content/telop-track.ts`、`tests/content/telop-track.test.ts`
- Test: `tests/content/trim-panel.test.ts`、`tests/content/youtube.test.ts`、`tests/content/styles.test.ts`

- [ ] **Step 1: 詰める欄が帯を抱えないテストに直す (失敗する)**

`tests/content/trim-panel.test.ts` の `mount` を直す:

```ts
  const panel = createTrimPanel({ rangeBar }, callbacks);
```

(`const telopTrack = document.createElement("div");` と `telopTrack.id = "track";` の 2 行を消す。)並びを見ているテストがあれば (`grep -n "track" tests/content/trim-panel.test.ts`)、子の並びを「見出しの行 → 拡大バー → 単語の段」(3 つ) にする。

`tests/content/youtube.test.ts` の「一覧は区間・テロップの窓に入り、…」の詰める欄の並びを直す:

```ts
    // 並び: 詰める欄 (見出しの行 → 拡大バー → 単語) → 操作の行
    expect(bar.children.length).toBe(2);
    const trim = bar.firstElementChild as HTMLElement;
    expect(trim.dataset.role).toBe("trim");
    expect(trim.children[1]?.id).toBe("yt-clip-range");
    expect(trim.children[2]?.getAttribute("data-role")).toBe("trim-words");
    expect(document.querySelector("[data-role='telop-track']")).toBeNull();
```

`describe("拡大バーの下のテロップの帯", ...)` を丸ごと消す。

- [ ] **Step 2: 失敗を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts tests/content/youtube.test.ts` (timeout 300000)
期待: FAIL (型: `telopTrack` が要る / 帯がまだある)

- [ ] **Step 3: 帯を外す**

`src/content/trim-panel.ts`: `parts: { rangeBar: HTMLElement; telopTrack: HTMLElement }` → `parts: { rangeBar: HTMLElement }`、`element.append(head, parts.rangeBar, parts.telopTrack, words);` → `element.append(head, parts.rangeBar, words);`。冒頭のコメントに帯の話があれば消す。

`src/content/youtube.ts`:

1. import `import { createTelopTrack, type TelopTrack } from "@/content/telop-track";` を消す
2. `let telopTrack: TelopTrack | null = null;` (とその上のコメント) を消す。`resetModuleState` の `telopTrack = null;`、`stop` の `telopTrack?.destroy();` を消し、`stop` のコメント「→ 拡大バーと帯の段 (rAF と捕捉)」を「→ 拡大バー (rAF と捕捉)」にする
3. `onTelopDragged` (関数とその上のコメント) を消す
4. `refreshTelopTrack` (関数とその上のコメント) を消し、`refreshLists` と `paintRangeBar` の中の `refreshTelopTrack();` を消す。`refreshLists` のコメントから「帯の段・」を消す
5. `buildBar` の `telopTrack = createTelopTrack({ ... });` の塊とその上のコメントを消し、`createTrimPanel({ rangeBar: rangeBar.element, telopTrack: telopTrack.element }, ...)` → `createTrimPanel({ rangeBar: rangeBar.element }, ...)`。コメント「拡大バーとテロップの帯はここに入る」を「拡大バーはここに入る」に、`bar.append` の上のコメントを「バーは詰める欄 (見出しの行 → 拡大バー → 単語) → 操作の行。拡大バーは幅がそのまま精度になるので、一覧の窓の幅には縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の spec A.1)」にする
6. `mount` の `const previousTrack = telopTrack;`・`previousTrack?.destroy();` とそのコメントを消し、「buildBar が rangeBar と telopTrack を新しいインスタンスに差し替える」を「buildBar が rangeBar を新しいインスタンスに差し替える」にする
7. 帯を根拠にしていたコメントを書き換える:
   - `src/content/range-bar.ts` の「窓の左端・右端の時刻。**素の span のまま、見た目は RANGE_STYLE.root から継ぐ。** telop-track.ts が … (足さないと帯とトラックの左右がずれる)」の 3 行 → 「窓の左端・右端の時刻。**素の span のまま、見た目は RANGE_STYLE.root から継ぐ。** 詰める欄の単語の段 (trim-panel.ts) が同じ時刻を同じ幅の見えない span で左右に置き、トラックの左右に揃えている。ここに style を足すなら、TRIM_STYLE.ghost にも同じものを足す」
   - `src/content/floating-window.ts` の `UNDOCK_THRESHOLD_PX` のコメントの「テロップの帯の「押して離した」の 4px (telop-track.ts の TELOP_CLICK_SLOP_PX) より大きくし、タブを押すつもりの / 指の震えで抜けないようにする」→「タブを押すつもりの指の震え (数 px) で抜けないようにする」(値 8 は変えない)
   - `src/content/trim-panel.ts` の `paintWords` のコメントの「 (telop-track と同じ作法)」を括弧ごと消す
8. ほかに `telopTrack` / `playTelop` の参照が残っていないか `grep -n "telopTrack\|TelopTrack" src/content/youtube.ts` で見る (`playTelop` は手入力の行の ▶ で使うので残す)

`src/content/styles.ts`: `TELOP_TRACK_STYLE` (とその上のコメント) を消す。`TRIM_STYLE` の上のコメントの「拡大バーとテロップの帯を中に抱える。」を「拡大バーを中に抱える。」にし、「**根の gap はバーと同じ 10px。** テロップの帯の段は … 重なる。」の 3 行を「**根の gap はバーと同じ 10px。**」に縮め、「単語の段も同じ `margin-top:-6px` で上の段に寄せ、」を「単語の段は `margin-top:-6px` で拡大バーのトラックに寄せ、」に、「(テロップの帯の段と同じやり方)」を消す。

`tests/content/styles.test.ts`: `TELOP_TRACK_STYLE` の import と、それを使う describe / テスト (194〜212 行付近) を消す。`RANGE_STYLE.root` の `gap:10px` などを確かめる部分が帯の段との揃いのためだけなら一緒に消す。

`git rm src/content/telop-track.ts tests/content/telop-track.test.ts`

- [ ] **Step 4: 通過を確認**

実行: `npx vitest run` と `npm run typecheck` (timeout 300000)
期待: PASS。`grep -rn "telop-track\|TelopTrack\|TELOP_TRACK" src tests` が何も出さない

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add -A src/content tests/content
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "refactor(content): 拡大バーの下のテロップの帯を外す

Why: 段階 1c-2。テロップの時刻は行の時刻 (字幕の行) か手入力の行の「頭を今に / 尻を今に」で決まる。
帯は 2 段まで・+N・詰める欄の前後 2 秒の中だけ、の制約を抱え、1440x795 でバーを 34px 高くしていた"
```

---

### Task 6: `RESET_MARKS` を外す

**Files:**
- Modify: `src/shared/types.ts:216`、`src/background/state.ts:244,403,428,444`、`src/content/youtube.ts:842`
- Test: `tests/background/state.test.ts:82-84,712-714`

- [ ] **Step 1: テストを直す (失敗する)**

`tests/background/state.test.ts` の「RESET_MARKS で idle に戻る」と「RESET_MARKS で消える」の 2 本を消し、代わりに足す (`ready` は同じファイルの既存の ready 状態の値):

```ts
  test("RESET_MARKS はもう受けない (区間を空にするのは SET_CLIP と REMOVE_SEGMENT)", () => {
    // @ts-expect-error 外したイベント
    expect(reduce(ready, { type: "RESET_MARKS" })).toMatchObject({ kind: "failed", reason: "internal-error" });
  });
```

- [ ] **Step 2: 失敗を確認**

実行: `npx vitest run tests/background/state.test.ts` (timeout 300000)
期待: FAIL (`RESET_MARKS` で idle に戻る。`@ts-expect-error` も型で外れていないので typecheck が落ちる)

- [ ] **Step 3: 外す**

- `src/shared/types.ts`: `| { type: "RESET_MARKS" }` (とその上のコメントがあれば) を消す
- `src/background/state.ts`: `if (event.type === "RESET_MARKS") return { kind: "idle" };` の 4 行を消す
- `src/content/youtube.ts:842` 付近のコメント「**ここで RESET_MARKS を送らない。**」の段落: 送るイベントが無くなったので、コメントを「この画面の表示を畳むだけで足り、状態機械の区間とテロップは残す」の意味だけ残して書き直す (前後を読んで 1〜2 行にする)

拒まれた遷移は `invalid(state)` で `internal-error` の failed になる (`src/background/state.ts` の今の作法。区間とテロップは持ったまま)。

- [ ] **Step 4: 通過を確認**

実行: `npx vitest run` と `npm run typecheck` (timeout 300000)
期待: PASS。`grep -rn "RESET_MARKS" src` が何も出さない

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/types.ts src/background/state.ts src/content/youtube.ts tests/background/state.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "refactor(background): 使われていない RESET_MARKS を外す

Why: 1b-1 からの持ち越し。区間を空にする道は SET_CLIP と REMOVE_SEGMENT にあり、どこからも送られていない"
```

---

### Task 7: check:telop と実機で確かめる

**Files:**
- Modify: `e2e/telop-check.spec.ts`、`README.md` (1440x795 の制約の文)、`docs/manual-check.md` (確かめた環境の記録)

- [ ] **Step 1: check:telop をテロップの一覧から手入力の行に移す**

`e2e/telop-check.spec.ts`:

1. `setTelopText` を直す:

```ts
  /** 手入力の行の文字を入れて確定する (✎ で直す欄を開き、Enter) */
  async function setTelopText(index: number, text: string): Promise<void> {
    await telopRows.nth(index).locator("[data-role=manual-edit-button]").click();
    const editor = telopRows.nth(index).locator("[data-role=line-edit]");
    await editor.fill(text);
    await editor.press("Enter");
    // 状態機械からの通知で、行の文字が打った文字になるのを待つ
    await expect(telopRows.nth(index).locator("[data-role=manual-text]")).toHaveText(text);
  }
```

   ＋ ここに字幕を足す は足した行の直す欄を開くので、`addTelops` で `add-telop` を押した後は直す欄が開いている。`setTelopText` の ✎ のクリックは、開いている直す欄 (同じ行) には何もしない (`line-edit` の中ではないので ✎ は押せる。押すと同じ行を直し始め直す) ので、そのまま通る

   `telopRows.nth(i)` は欄の時刻順 (前はテロップの index 順)。`TELOPS` が時刻の昇順なので同じ順になる。`telopTexts` の比べ方も同じ前提に立つ (`TELOPS` の順を変えるなら直す)

2. `buildSegments` の `await expect(segmentRows.nth(i)).toContainText("(3秒)");` → `await expect(segmentRows.nth(i)).toContainText("3.0 秒");`
3. 「入力中にショートカットが発火しない」: `telopRows.nth(0).locator("textarea")` を、✎ で開いた直す欄にする:

```ts
    await telopRows.nth(0).locator("[data-role=manual-edit-button]").click();
    const textarea = telopRows.nth(0).locator("[data-role=line-edit]");
    const original = await textarea.inputValue();
```

   後始末の `await textarea.fill(original);\n    await textarea.blur();` を `await textarea.press("Escape");` にする (Esc で直す前に戻して閉じる)
4. `telopTexts = await telopRows.locator("textarea").evaluateAll(...)` → `telopTexts = await telopRows.locator("[data-role=manual-text]").allTextContents();`
5. 1440x795 の測りの `telopBands` / `telopLanes` / `telopOverflow` の 3 項目とそのコメントを消す。それらを合否か記録の条件に使っていれば (`grep -n "telopBands\|telopLanes\|telopOverflow" e2e/telop-check.spec.ts`) その条件も消す。測る前に重なるテロップを 3 つ作っている準備 (帯の段を最大にするため) は、手入力の行 3 つとしてそのまま残す (欄の高さは窓の中のスクロールなので、バーの高さには効かない)
6. 帯の 3 つの check (「帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる」「帯の端をドラッグすると開始 / 終了だけが変わる」「帯を押して離すと、そのテロップの頭から再生する」) と、その前の帯の準備 (`const firstBand = ...` など。`DOCK_NO_SUCK` の check の直前まで) を消す
7. 一覧を指していたコメント (「一覧」「＋ テロップ」) を「欄の見出し」「手入力の行」「＋ ここに字幕を足す」に直す

`npx tsc --noEmit -p .` か `npm run typecheck` が e2e を含むなら、それで型を見る (timeout 300000)。

- [ ] **Step 2: check:telop を走らせる**

(Step 2・3 は人の手待ちで止まる: 拡張の再読み込みと、普段の Chrome を使ってよいかの確認をユーザーに頼む。)

ユーザーに拡張の再読み込みが要るかを伝えてから (`npm run build` 後)、実行: `npm run check:telop` (timeout 600000)
期待: すべて通過。特に 1440x795 の 2 判定 (受け入れ条件・下の枠に落とす)。結果は `test-results/telop-check/results.json`。**落ちたら直す前に数字 (バーの上端と下端) を記録する** (1c-1 は 628.25〜804.25 で 9.25px はみ出した。帯の段 34px を外したので 770 前後の見込み)

- [ ] **Step 3: 普段の Chrome で manual-check を確かめる**

拡張を再読み込みしてもらい、Claude in Chrome で `docs/manual-check.md` の Task 1 で直した・足した項目 (「文字起こしの欄」の見出しと手入力の行の 5 項目、字幕の無い動画の項目、「詰める欄」の合計の項目、「複数区間の結合」の見出しの項目) を確かめる。字幕の無い動画は、YouTube で字幕の無い短い動画を 1 本選ぶ (選んだ動画の ID を記録する)

- [ ] **Step 4: 回帰を確かめる**

実行: `npx vitest run` と `npm run typecheck` (timeout 300000)、`npx playwright test` (timeout 600000)
期待: 既知の失敗 1 本 (smoke の「オフにすると 1 秒以内…」) を除いて PASS

- [ ] **Step 5: 1440x795 の制約の文を実測で書き換える**

`README.md` の「### 操作の置き場所」の「それでも **1440x795 では、浮かせたバーがプレイヤーの下端に重なり、ページの中のバーは画面の\n  下にはみ出すことがある** (ページの中ならスクロールで届く。帯の段を文字起こしの欄に置き換えて外すときに見直す)」を Step 2 の結果で書き換える:

- 収まった (2 判定とも通過) なら: 「帯の段を外したので、1440x795 でもページの中のバーは画面に収まる (詰める欄の見出しの行が折り返すほど狭い窓では背が伸びる)」
- はみ出したなら: はみ出した px を書き、「(ページの中ならスクロールで届く)」を残す。1c-3 の持ち越しに足す

`docs/manual-check.md` の「## 確認した環境」の末尾に、Step 2〜4 の結果を 1 段落で足す (日付は JST、check:telop の項目数と 1440x795 のバーの上端・下端、確かめた manual-check の項目、字幕の無い動画の ID)。

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts README.md docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "test(e2e): check:telop をテロップの一覧と帯から欄の手入力の行に移し、1440x795 を測り直す

Why: 段階 1c-2 で一覧と帯を外した。1c-1 で 9.25px はみ出していたバーの背が、帯の段を外して収まるかを確かめる"
```

---

## 完了後

1. `npx vitest run` と `npm run typecheck` (timeout 300000)、`npx playwright test` (timeout 600000) で green を確認 (既知の失敗 1 本を除く)
2. whole-branch cross-review: `BASE=$(git -C /Users/trapple/repos/github.com/trapple/yt-clip merge-base develop HEAD)` からの diff を 1 ファイルにまとめ、新しい subagent に subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる。攻撃者の観点では特に: 手入力の行の文字 (タグ・500 文字超・改行だらけ) が欄とテロップに流れたとき、直している間に別の経路 (IN・OUT・欄の行) で手入力の行の位置がずれたとき、字幕の無い動画で区間 0 個のまま ＋ ここに字幕を足す を押す道が無いか。指摘は直して再レビュー (手順は cross-review スキル)
3. plan の末尾に「完了の記録」と「1c-3 に持ち越すもの」(1c-1 と 1b-2 からの持ち越しで、この plan で扱わなかったものを含めて) を書いて commit
4. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ

## 自律判断ログ

- [回答] 手入力の行は `lineId` の無いテロップそのもの (2026-11-03「テロップそのものを行に (推奨)」。ADR 0003 に記録)
- [回答] 手入力の行の時刻は行の「頭を今に / 尻を今に」(2026-11-03「行に「頭を今に / 尻を今に」 (推奨)」。ADR 0003 に記録)
- [選択] 欄の行の要素は使い回し、見出しと手入力の行は描くたびに作り直して差し込む — 見出しを行の並びに混ぜて id の列にすると、行を押すたびに区間が変わって 8000 行を作り直す (1b-2 で避けた重さ)
- [選択] 新しい要素は外す一覧と同じ `data-role` を使う — 単体テストと e2e が一覧をこの名前で探している。名前を変えると、同じ振る舞いのテストを全部書き直すことになる
- [選択] 区間の一覧の ▶ (その区間を再生) は欄の見出しに持ち込まない — 見出しで選んでから ▶ 区間を見る で同じことができる。見出しの操作を ✕ だけにして、押し間違いを減らす
- [選択] 窓の名前は「区間・テロップ」のまま — 区間の見出しと手入力のテロップがこの窓に出る。名前を変えると、ドック枠のタブ・覚えた配置の説明・e2e の文言を広く直すことになる
- [選択] 合計と上限は詰める欄の見出しに「合計 24.6 / 60 秒」で出し、超えたら警告色 — 区間の一覧の合計の役目を引き継ぐ。録画ボタンの文字は変えない (1c-1 の判断と同じ)
- [選択] 手入力の行を直している間に手入力の行の telopIndex の並びが変わったら直す欄を閉じる — テロップの位置 (index) で書き込むので、前のテロップが消えると別のテロップに書き込む。書きかけは捨てる。起きるのは、直している間に別の手入力の行の ✕ を押したときと、前の字幕の行を外して行のテロップが消えたとき (cross-review 1 回目: 数だけ見ると後者を見落とす)
- [選択] (cross-review 1 回目) 手入力の行には「字幕に出さない」を置かない — 字幕の行の「出さない」は文字を空にする作法で、手入力の行の空は「まだ書いていない」と見分けられない。出さないなら ✕ で消す。ADR 0003 の Consequences を Task 1 Step 0 で補う
- [選択] (cross-review 1 回目) 直す欄は `focus({ preventScroll: true })` で開く — 足した直後、ページの中の窓ではページを動かさない (右側パネルの spec §3)。欄の中と窓の中で見せるのは reveal / revealInWindow
- [cross-review] plan を 1 回 (ゼロ context の実装者。worktree に Task 2〜4 を当てて vitest / typecheck で確かめた)。Issues 7 件 (型の絞り込み・Task 3 の add-telop の重複・直す欄を閉じる条件・focus でページが動く・手入力の行の「字幕に出さない」・1b-2 からの持ち越しの振り分け・Task 5 の帯を根拠にしたコメント) を直した。直しはどれも具体的なので 2 回目は回さず実装に引き継ぐ
- [選択] 足した手入力の行は直す欄を開いて見せる — 足した直後のテロップは文字が空で何も描かれない。打つ場所へすぐ入れる
- [選択] 1c-1 の持ち越しのうち撤去に関わる 2 つ (1440x795 の測り直し、有効・無効の決め方と `refreshTrimPanel` の 2 回) だけを扱う。ほか (±0.1 の待ちの上限・トラックを押したときのフォーカス・長い配信の単語) と 1b-2 からの持ち越しは 1c-3
