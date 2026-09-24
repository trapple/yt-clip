# 拡大バー上のテロップ (spec の B) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (SDD) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 拡大バーの下に、拡大バーの時間の範囲に入るテロップを帯で出し、帯のドラッグでテロップの**出す時間**を変えられるようにする
(帯の中は長さを保って前後に、端は開始か終了だけ)。

**Architecture:** 新しいモジュール `src/content/telop-track.ts` が帯の段 (描画・段の割り当て・ドラッグ) を持つ。段の割り当て
(`assignLanes`)・窓に入るテロップ (`telopsInWindow`)・掴んだ場所の判定 (`grabKindAt`)・ドラッグの計算 (`dragTelop`) は純粋関数に
切り出してテストする。時間の軸は拡大バーから受け取る: `range-bar.ts` に `window(): TimeWindow | null` を足し、`youtube.ts` は
バーの窓の中で拡大バーの直下に帯の段を置き、拡大バーを描き直すとき (`paintRangeBar`) とテロップが変わったとき (`refreshLists`)
に `update` を呼ぶ。確定は指を離したときの `UPDATE_TELOP` 1 回。状態機械 (`src/background/state.ts`) は変えない。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-24-floating-windows-design.md` (以下「spec」)。**この plan は spec の「B. 拡大バー上のテロップ」と、
A.4 の「B を入れた後も、帯の段が最大 (2 段 + 「+N」) の状態で同じ条件を満たす」、「テスト」「ドキュメント」節の B の部分。**
A (フロートの窓) は `.claude/plans/2026-09-24-floating-windows-a.md` で実装済み (HEAD 82c0c20)。

## 判断メモ (spec と既存コードの食い違い・spec の曖昧な箇所。autonomous なので自分で決めた)

1. **帯の段を出す条件は「一覧に出すテロップ (`listedItems().telops`) が 1 つ以上あるとき」**。0 件なら段ごと隠す。
   理由: spec B.1 の「エディットモードで、範囲を作った動画を見ているときだけ出す (listedItems())」をそのまま使い、シンプルモードと
   テロップを使わない人のバーの高さ (A の受け入れ条件で測った約 106px) を変えないため。判定は `update` の中で帯の段が自分でする
   (spec の API に `setVisible` が無いため)。
2. **出ている間の段の高さは常に 2 段ぶん (14 + 2 + 14 = 30px) に固定する**。理由: 重なりの有無で段の数を変えると、帯を 1 本動かす
   たびにバーの窓の高さが 16px 揺れる。予算 34px (spec B.1) は最大のときの値なので、常にそれを取る。
3. **帯の段が出る・消えるときは `barWindow.refit()` を呼ぶ。最初の位置は取り直さない**。理由: バーの窓の高さが 34px 変わり、
   画面の下寄りに置いた窓ではつまみ (操作の行) が画面の外へ押し出されうる。spec A.2 は最初の位置を取り直すきっかけを
   `resize` とプレイヤーの大きさの変化に限っているので、きっかけは増やさず「置いた場所から詰め直す」だけにする。
4. **「前から順に、空いている段に置く」は、開始の早い順 (同じ開始なら作った順) に、いちばん若い空いた段へ置く**。
   テロップは半開区間なので、前のテロップの終了ちょうどに始まるテロップは同じ段に置ける。2 段に入らないテロップ (`-1`) は段を塞がない。
5. **端の判定は、帯の箱に対する押した位置で決める純粋関数 `grabKindAt(offsetPx, widthPx)`**。端の幅は `min(6, width / 3)`、
   `offset < 端の幅` なら開始、`offset > width - 端の幅` なら終了、ちょうど境目は中。幅 0 (測れない) は中。
   押す前も帯の上でカーソルを変える (端は `ew-resize`、中は `grab`) — 何が動くかを掴む前に見せるため。
6. **「押して動かさずに離したら (4px 未満)」は、押した位置からの距離 (`Math.hypot(dx, dy)`) が 4px 未満のまま離したとき**。
   4px に届くまでは帯を動かさない。一度 4px を超えたらドラッグとして扱い、元の位置へ戻して離しても再生しない (送りもしない)。
7. **時刻が元と同じまま離したら `onCommit` を呼ばない** (4px 以上動かしても、窓の端で止まって時刻が変わらなかったときなど)。
   spec の「指を離したときに 1 回だけ UPDATE_TELOP を送る」を「変わったときに 1 回だけ」と読む (変わらない送信は状態通知を無駄に起こす)。
8. **ドラッグ中に届いた `update` は、指を離すまで描かずに取っておく**。理由: 描き直すと掴んでいる帯の要素が作り直され、
   ポインタの捕捉が外れてドラッグが宙に浮く。離したら取っておいた分を取り込み、確定した時刻をその上に載せて描く
   (状態の通知が返るまでの間も、離した場所に帯を残す)。**ただし、取り込んだ後の同じ index に掴んだ時点と同じ時刻の
   テロップが無ければ (一覧の ✕ で前のテロップが消えて index がずれた・入れ替わった)、確定も再生もせず、取り込んだ
   とおりに描くだけにする** (plan レビューの指摘で追加)。別のテロップに時刻を載せて送らないため。文言だけが変わった
   update は同じテロップとみなして確定する。
9. **ドラッグ中に `setEnabled(false)` されたら、その場で打ち切って帯を元の位置へ戻す** (送らない)。`range-bar.ts` は次の
   `pointermove` で打ち切るが、帯の段は即時にする (録画が始まった後のシークを 1 回でも減らす)。
10. **`pointercancel` / `lostpointercapture` で終わったときは、動かしていれば確定し、押しただけなら何もしない (再生しない)**。
    確定するのは `range-bar.ts`・`floating-window.ts` と同じ作法。再生しないのは、取り上げられた操作をクリックとみなさないため。
11. **無効な間は、押して離しても再生しない**。spec は「動かせない (薄く出す)」だけを書いているが、一覧の ▶ も同じ条件
    (`telopList.setEnabled(canEditTelops())`) で押せないので揃える。
12. **帯の段の左右を拡大バーのトラックに揃える方法**: 帯の段の箱の左右に、拡大バーの左右のラベルと同じ時刻の文字を
    `visibility:hidden` で置く (拡大バーと同じ `gap:10px`・`font-size:12px`・`tabular-nums`)。幅を測って写す形にしないのは、
    ラベルの幅 (`1:02:03` のような長い時刻) が変わるたびに測り直す経路が要るため。「+N」は右側の見えない時刻の箱の中、
    2 段目の高さに置く (spec B.3「右端の時刻のラベルの下の余白」)。拡大バーのトラックの縁 (1px) は揃えない。
13. **px から秒への換算は帯の段の箱 (`[data-role=telop-lanes]`) の幅で行う**: `deltaSec = dx * (窓の長さ) / 幅`
    (先に掛けてから割る。テストの値で浮動小数の誤差を出さないため)。幅が 0 なら動かさない。
14. **`rangeBar.window()` は `update` される前は `null`**。そのときは帯の段にテロップを渡さない (時間の軸が無い)。
15. **拡大バーを描き直す 4 箇所 (`applyRange` / `applyStateToSelection` / `applyStateToDisplay` / `mount`) を `paintRangeBar` に
    まとめる**。拡大バーの窓が変わる経路で、帯だけが古い窓のまま残らないようにする。
16. **`UPDATE_TELOP` は応答の状態で受理を確かめる** (`send` の第 2 引数)。テロップは並べ替えもマージもしないので、受理されれば
    送った時刻がそのまま載る。拒まれたら正の状態で描き直され (帯が元へ戻る)、「この操作は受け付けられませんでした」が出る。
    文言の確定 (`onTelopText`) は確かめていないが、帯は楽観的に動かした見た目を残すので、食い違いを戻す経路が要る。
17. **帯の文言は空白と改行を 1 つの空白に詰めて 1 行で出す**。`title` に時刻と全文を入れる。
18. **ドラッグ中のシークは 1 フレームに 1 回に間引く** (`requestAnimationFrame`。`range-bar.ts` と同じ)。**指を離した・
    打ち切ったときは、予約済みのシークを取り消す** (plan レビューの指摘で追加)。残すと離した 1 フレーム後に動画が飛び、
    元の位置へ戻して離したときに見た目と違う位置で止まる。`range-bar.ts` にも同じ癖があるが、この plan では直さない
    (既存の拡大バーの振る舞いを B の範囲で変えない。直すなら別の変更で)。
19. **E2E で使うテロップの時刻を `[201, 231, 321, 321, 321]` にする** (A の plan では各区間の頭 + 1 秒)。最後に足した区間
    (320〜335) が拡大バーに選ばれていて、その窓 (312.5〜342.5) に 3 つが重なって入るので 2 段 + 「+1」になる。B.4 の確認は
    区間 1 (200〜215) を選び直し、ほかの帯と重ならないテロップ 1 (201〜204) で行う。
20. **`docs/privacy-policy.md` と `scripts/screenshots.mjs` は変えない**。B は何も保存しない。掲載画像は 2 枚ともシンプルモードで
    撮るので帯は写らない (controller が Task 7 で写っていないことを確かめる)。
21. **帯の段が出る・消えるときの `refit` は単体テストで確かめない** (jsdom はレイアウトを持たず、つまみの位置が測れない)。
    1440x795 の受け入れ条件 (E2E) で、帯の段が最大の状態でバーの窓が画面に収まることを確かめる。
22. **`refreshTelopTrack` は 1 回の状態通知で 2 回呼ばれうる** (`refreshLists` と、拡大バーがずれていたときの
    `paintRangeBar`)。冪等なのでそのままにし、誤解されないようコメントに書く (plan レビューの推奨)。
23. **E2E の帯の確認は、ドラッグの前に `seekPaused(201)` で位置を温め、時刻は状態機械に保存されるまで読み直して待つ
    (`waitTelopChanged`)** (plan レビューの推奨)。帯のシークは `video.currentTime` への直接の書き込みで、読み込み直した直後に
    読んでいない位置へ飛ぶと YouTube のプレイヤーが止まりうる。`dragFromTo` の 500ms は窓の位置の保存を待つためのもので、
    `UPDATE_TELOP` の保存を待つ保証にならない。
24. **`range-bar.ts` の左右のラベルに「帯の段が同じ幅の見えない時刻で揃えている」とコメントを足す** (plan レビューの推奨。
    Task 2)。見えない時刻の幅合わせは、ラベルが素の span であることに依存しているため。
25. **Task 5 の「区間を選び直す」テストは、両方の区間を行を押して選ぶ** (plan レビューの Issue)。`selectedIndex` はモジュールの
    変数でテストをまたいで残り、状態の通知 (`emit`) では「足した直後」の扱いにならないので、通知だけでは最後の区間が選ばれない。
    既存の複数区間のテスト (`describe("区間を消したときの選択")`) と同じ形にする。

## Global Constraints

### Spec 由来 (spec から逐語コピー)

B.1 見え方 (spec 124〜140 行目):

- 拡大バーのトラックの**下**に、テロップの帯の段を足す。帯は拡大バーと同じ時間の軸 (`computeWindow` の窓) で置く
- 拡大バーの窓に一部でも入るテロップを出す (空の文言のテロップも出す。まだ書いていないテロップを動かせるように)
- 帯には文言の先頭を出す (はみ出しは省略)。空の文言は「(未入力)」
- 時間が重なるテロップは段を分ける (前から順に、空いている段に置く)。**段は最大 2 段**、段の高さ 14px、段の間 2px、拡大バーのトラックとの間 4px (合計 34px)
  - 予算の根拠: 1440x795 の実測 (右側パネルの受け入れ確認) で、プレイヤーの下端 ≈ 628px、今のバーの窓は 636〜742px。画面の下端から 16px (779px) までに帯の段へ回せるのは 37px。3 段 (48px〜) では溢れてプレイヤーを覆う
  - **2 段に入らないテロップは帯を出さず、2 段目の右端に「+N」だけ出す** (重ねて置くと、重なった帯をうっかり掴んで別のテロップを動かす)。「+N」を押しても何もしない (一覧で直す)。README に書く
- エディットモードで、範囲を作った動画を見ているときだけ出す (テロップの一覧と同じ規則 `listedItems()`)

B.2 ドラッグで出す時間を変える (spec 142〜157 行目):

- **帯の中**を押してドラッグ: 長さを保ったまま前後に動く
- **帯の左端 / 右端** (それぞれ「帯の幅の 1/3、最大 6px」) を押してドラッグ: 開始 / 終了だけが動く (細い帯でも中を掴めるように)
- 動かせる範囲: **拡大バーの時間の窓 (`TimeWindow`) の中** (区間のハンドルの `clampHandle` と同じ)。窓の外へ出すと掴んでいる帯が指の下で消えるため。窓の外へ動かしたいときは一覧の「開始を今に / 終了を今に」を使う (README に書く)
  - **ただし、もともと窓からはみ出しているテロップは、はみ出している分をそのまま認める**: 下限は `min(窓の開始, 今の開始)`、上限は `max(窓の終了, 今の終了)`。窓の中へは動かせるが、今より外へは出せない。窓の端をまたぐテロップを少し動かそうとして、最初の 1 動作で窓の端へ跳ばないようにする
- 開始 < 終了、長さは最短 0.5 秒。**ただし今の長さが 0.5 秒未満なら、今の長さを下限にする** (一覧で短くしたものを帯で掴んだだけで勝手に伸ばさない)
- ドラッグ中は帯だけが動き、**指を離したときに 1 回だけ** `UPDATE_TELOP` を送る (区間の拡大バーと同じ作法)。ドラッグ中は動画をその位置へシークする (拡大バーの `onScrub` と同じ)。「その位置」は、帯の中・左端を掴んだときは開始、右端を掴んだときは終了 (拡大バーの「動かしている側」と同じ)
- 押して動かさずに離したら (4px 未満)、そのテロップの頭から再生する (一覧の ▶ と同じ)
- テロップを編集できないとき (`canEditTelops()` が偽: preview / 録画中など) は、帯は出すが動かせない (薄く出す)

B.3 作り (spec 159〜185 行目):

- 新しいモジュール `src/content/telop-track.ts`: 帯の段 (描画・段の割り当て・ドラッグ) を持つ。時間の軸は拡大バーから受け取る
  ```typescript
  export type TelopTrack = {
    element: HTMLElement;
    /** テロップと、拡大バーの時間の窓を反映して描き直す */
    update(telops: Telop[], window: TimeWindow): void;
    setEnabled(enabled: boolean): void;
    destroy(): void;
  };
  export function createTelopTrack(callbacks: {
    onScrub(sec: number): void;
    /** 指を離した。index のテロップの新しい時刻 */
    onCommit(index: number, startSec: number, endSec: number): void;
    onPlay(index: number): void;
  }): TelopTrack;
  ```
- 段の割り当て (`assignLanes(telops, maxLanes): number[]`) とドラッグの計算 (`dragTelop(kind, start, end, deltaSec, window)`) は純粋関数にしてテストする
- 拡大バー (`range-bar.ts`) は、今の時間の窓を外から読めるようにする (`window(): TimeWindow | null`)。帯の段は拡大バーのトラックと左右を揃える (時間の左端・右端のラベルの幅ぶんずらす)
- `youtube.ts` はバーの窓の中で拡大バーの直下に帯の段を置き、拡大バーを描き直すとき・テロップが変わったときに `update` を呼ぶ。**バーの縦の並びは `gap:10px` (`BAR_STYLE.root`) なので、帯の段の箱に `margin-top:-6px` を付けてトラックとの間を 4px に詰める** (予算 34px を守るため)
- 「+N」は段の外、**右端の時刻のラベルの下の余白**に置く (帯の段の箱は左右を拡大バーのトラックに揃えるので、ラベルの幅ぶんの余白が右にある)。帯と重ならない

B.4 受け入れ条件 (spec 187〜191 行目):

- 区間に重なるテロップが拡大バーの下に帯で出る。帯の中をドラッグすると長さを保って動き、端をドラッグすると開始 / 終了だけが変わる。指を離すと一覧の時刻も変わる
- 帯を押して離すと、そのテロップの頭から再生する

A.4 のうち B に関わる受け入れ条件 (spec 112〜118 行目):

- 1440x795 で、最初の位置のまま、エディットモードで区間 5 つ・テロップ 5 つ・設定を開いた状態で: バーの窓 (**窓の枠の外形。中身の根ではない**) が**プレイヤーの下端より下にあり (重ならない)**、下端が画面に収まる (`playerBottom ≤ bar.top` かつ `bar.bottom ≤ innerHeight`)
  - **B を入れた後も、帯の段が最大 (2 段 + 「+N」) の状態で同じ条件を満たす**。E2E では 5 つのテロップのうち 3 つを同じ時刻に重ねて足し (2 段 + 「+N」になる)、その状態で測る

テスト (spec「テスト」節の B の項目):

- `telop-track.ts` の単体: 段の割り当て (2 段まで、あふれたら +N) / 帯の位置 / 3 種類のドラッグの計算と境界 (最短 0.5 秒・今の長さが 0.5 秒未満のとき・窓の両端・窓からはみ出したテロップ) / 押して離すと onPlay / 無効な間は動かない
- `youtube.test.ts`: … 帯のドラッグで `UPDATE_TELOP` が 1 回だけ送られる
- `e2e/telop-check.spec.ts`: 受け入れ条件 (A.4 の 1440x795、窓を動かして読み込み直す、B.4 の帯のドラッグ) を足す。実機の確認は controller が行う

ドキュメント (spec「ドキュメント」節の B の部分): README の使い方・仕様と制約 (… 帯のドラッグ・**帯は拡大バーの範囲の中でだけ動かせる**・**帯の段は 2 段まで。入らない分は「+N」で数だけ出す**)、`docs/manual-check.md`、`docs/store-release.md` の掲載文、CHANGELOG。

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定 (`~/.claude/CLAUDE.md`) と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 1 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C /Users/trapple/repos/github.com/trapple/yt-clip ...` を使う
- 外部プロセスを起動して待つ処理には必ず timeout を付ける。**この macOS には `timeout` コマンドが無い**。Bash ツールの `timeout` 引数 (最大 600000) か、スクリプト側の timeout で止める
- 小さく検証してから全件: 対象の単体テスト 1 ファイル → `npm run typecheck && npm test` → (controller だけ) `npm run e2e` → `npm run check:telop` の順に広げる
- 日付を書くときは JST (`TZ=Asia/Tokyo date +%F`) であることを明示する
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける。本文は「なぜ」を書く
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 純粋関数は不正な入力 (段の数が 1 未満・動かした量が数でない・終了が開始以下) で `RangeError` を投げる。握りつぶすなら理由をコメントで書く。この plan に局所例外は無い (`onTelopDragged` がテロップの無い index や編集できない状態で黙って戻るのは、既存の `onMoveTelopEdge` / `onTelopText` と同じ「押せない間は伝えない」規則)
- テストは `npm test` (vitest)、型は `npm run typecheck` (`e2e/` も含む)。**各タスクの commit 前に両方を通す** (リポジトリの根 `/Users/trapple/repos/github.com/trapple/yt-clip` で `npm run typecheck && npm test`、Bash の timeout 600000)
- コマンドはリポジトリの根で実行する。`npx vitest run <file>` は Bash の timeout 120000 を付ける
- `tsconfig.json` は `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`。配列の添字は `undefined` を確かめてから使う

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch `feat/floating-windows` の上にそのまま積む (A 完了済み、HEAD 82c0c20)。**main には commit しない**
- 並列: SDD (branch + SDD = 方式 D)。1 タスクごとに新しい実装担当 + レビュー。**同じファイルを触るタスクは依存順に 1 つずつ走らせる**
  (`src/content/telop-track.ts` と `tests/content/telop-track.test.ts` は Task 3・4、`src/content/range-bar.ts` は Task 2 だけ、
  `src/content/youtube.ts` と `tests/content/youtube.test.ts` は Task 5 だけ)。Task 1・2・3 は互いに独立
- **実装担当は `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない** (実機の Chrome と YouTube を使う)。
  Task 6 (E2E を書く) も `npm run typecheck && npm test` までで止める
- Task 7 は **controller (メインセッション) が実行する**。`npm run check:telop` に足した B の項目を走らせ、画像を見て判定し、
  `docs/manual-check.md` に記録する
- 受け入れ: 1440x795 で A と同じ条件 (`playerBottom ≤ bar.top`、`bar.bottom ≤ innerHeight`) を「5 件のテロップのうち 3 件が重なって
  最大レーン数を使う」状態で満たす
- 終点: branch `feat/floating-windows` 上の commit まで。push / PR はユーザーの指示を待つ

## ファイルの構造

| ファイル | 責務 | タスク |
|---|---|---|
| `README.md` / `CHANGELOG.md` / `docs/manual-check.md` / `docs/store-release.md` | 帯の使い方と制約 | 1 |
| `src/content/range-bar.ts` | `window(): TimeWindow \| null` を足す | 2 |
| `src/content/telop-track.ts` (新規) | 定数・純粋関数 (`telopsInWindow` / `assignLanes` / `grabKindAt` / `dragTelop`) (3)、帯の段の DOM とドラッグ `createTelopTrack` (4) | 3・4 |
| `src/content/styles.ts` | `TELOP_TRACK_STYLE` を足す | 4 |
| `src/content/youtube.ts` | 帯の段を作って拡大バーの直下に置き、描き直しと `UPDATE_TELOP` を配線する | 5 |
| `e2e/telop-check.spec.ts` | 受け入れ条件を帯の段が最大の状態にし、B.4 の 3 項目を足す | 6 |
| `docs/manual-check.md` (「## 確認した環境」) | 実機で確かめた記録 | 7 |

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (range-bar.ts: window())          ─┐
Task 3 (telop-track.ts: 純粋関数) ─→ Task 4 (telop-track.ts: DOM + TELOP_TRACK_STYLE) ─┤
                                                                                      └→ Task 5 (youtube.ts の配線) ─→ Task 6 (E2E) ─→ Task 7 (controller: 実機)
```

## 既存テストの洗い出し (grep の結果。Task 5・6 の前提)

- `grep -n 'children\|firstElementChild' tests/content/youtube.test.ts` の結果: `describe("右側のパネル")` の
  「一覧と設定はパネルに入り、バーには拡大バーと操作の行だけが残る」(2464〜2485 行目付近) が `bar.children.length` を 2 と見ている。
  帯の段が拡大バーと操作の行の間に入るので、**Task 5 で 3 に直し、2 番目が帯の段であることを足す** (検査は弱めない)
- `[data-role='telop']` (テロップの一覧の行) を探すテスト (`youtube.test.ts` 2275・2472・2627・2664 行目付近、`telop-list.test.ts`、
  `e2e/telop-check.spec.ts` 379 行目) は属性の完全一致なので、帯の段の `telop-track` / `telop-lanes` / `telop-band` / `telop-overflow`
  には当たらない。**変更不要**
- `tests/content/range-bar.test.ts`: `window()` を足すだけで既存の振る舞いは変えない。**既存の検査は変更不要** (import だけ直す)
- `tests/content/styles.test.ts`: `TELOP_TRACK_STYLE` の検査を足すだけ
- `e2e/telop-check.spec.ts` の受け入れ条件 (865〜950 行目付近) はテロップを各区間の頭 + 1 秒に足している。Task 6 で
  `LAYOUT_TELOP_STARTS` に替え、3 つを重ねる。後に続く窓の 4 項目は区間の数 (`LAYOUT_SEGMENT_STARTS.length`) しか見ていないので変えない
- `e2e/smoke.spec.ts` / `scripts/screenshots.mjs`: シンプルモードだけを使うので帯の段は出ない。**変更不要**

---

### Task 1: ドキュメントを先に直す (B の範囲)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual-check.md`
- Modify: `docs/store-release.md`

**Interfaces:**
- Consumes: なし
- Produces: なし (ドキュメントのみ)

グローバル規約「ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する」に従う。
`docs/privacy-policy.md` は変えない (B は何も保存しない)。`docs/manual-check.md` の「## 確認した環境」は Task 7 で書く。

- [ ] **Step 1: README の「テロップ (エディットモード)」に帯の使い方を足す**

`README.md` の 54 行目付近

```markdown
- **▶** — そのテロップの頭から再生する / **✕** — 消す
```

の**直後**に、空行を 1 つ挟んで次を挿入する (その後の空行と「テロップはプレイヤーの上に、…」の段落は残す)。

```markdown
区間を選ぶと、その区間の拡大バーの範囲に入るテロップが、拡大バーの下に帯で出る (帯には文言の先頭。
まだ書いていないテロップは「(未入力)」)。帯をドラッグすると出す時間が変わる。

- **帯の中** をドラッグ — 長さを保ったまま前後に動く
- **帯の左端 / 右端** をドラッグ — 開始 / 終了だけが動く
- **帯を押して離す** — そのテロップの頭から再生する (一覧の ▶ と同じ)
```

- [ ] **Step 2: README の「テロップの制約」に帯の制約を足す**

`README.md` の 116〜117 行目付近 (「### テロップの制約」の最後の項目)

```markdown
- **テロップが残っている間は、最後の 1 区間を消せない**。区間と一緒に手入力の文言が
  全部消えるのを防ぐため。先にテロップを消す
```

の**直後** (空行を挟まず、同じ箇条書きの続き) に次を挿入する。

```markdown
- **帯は拡大バーの範囲の中でだけ動かせる**。範囲の外へ動かしたいときは、一覧の「開始を今に / 終了を今に」を使う
  (範囲の外へ出すと、掴んでいる帯が指の下で消えるため)。もともと範囲の端をまたいでいるテロップは、はみ出して
  いる分はそのまま残り、範囲の中へは動かせる
- **帯の段は 2 段まで**。時間が重なるテロップが 3 つ以上あると、入らない分は帯を出さず、右端の時刻の下に「+N」で
  数だけ出す。「+N」を押しても何も起きない (一覧で直す)。3 段にしないのは、狭い画面 (1440x795 など) でバーが
  プレイヤーの下端を覆うため
- **帯で縮められるのは 0.5 秒まで**。一覧で 0.5 秒より短くしたテロップは、帯で掴んでもそれより短くはならない
  (掴んだだけで勝手に伸ばさない)
- **録画中と、録画した後のプレビューの間は、帯は薄く出て動かせない** (区間の拡大バーと同じ)
```

- [ ] **Step 3: CHANGELOG の「未リリース」に足す**

`CHANGELOG.md` の「## 未リリース」の最後の段落

```markdown
**バーとパネルを動かせる窓にした。** パネルは見出し、バーは左端の ⠿ を掴んで好きな場所へ動かせる。
右下の角で大きさも変えられる (バーは幅だけ)。位置と大きさは端末ごとに覚え、掴む場所をダブルクリック
すると最初の位置に戻る。
```

の**直後**に、空行を 1 つ挟んで次を挿入する (その後の空行と「## 1.1.0 - 2026-09-23」は残す)。

```markdown
**拡大バーの下にテロップを帯で出した (エディットモード)。** 選んでいる区間の拡大バーの範囲に入るテロップが、
拡大バーの下に帯で並ぶ。帯の中をドラッグすると長さを保ったまま、端をドラッグすると開始か終了だけが動く。
帯を押すとそのテロップの頭から再生する。時間が重なるテロップは 2 段まで並べ、入らない分は「+N」で数だけ出す。
```

- [ ] **Step 4: manual-check の「テロップ (エディットモード)」に項目を足す**

`docs/manual-check.md` の 116 行目付近 (「## テロップ (エディットモード)」の最後の項目)

```markdown
- [ ] テロップ付きの録画中に別のタブへ移る・ウィンドウを最小化すると、壊れたクリップを作らずに理由付きで中断する。「もう一度」で区間もテロップも残っている
```

の**直後** (空行を挟まず) に次を挿入する。

```markdown
- [ ] 区間を選ぶと、その拡大バーの範囲に入るテロップが拡大バーの下に帯で出る。帯の左右の端が拡大バーのトラックの左右と揃い、まだ書いていないテロップは「(未入力)」
- [ ] 帯の中をドラッグすると長さを保って動き、左端・右端をドラッグすると開始・終了だけが動く。ドラッグ中は動画がその位置 (中・左端は開始、右端は終了) へ追従し、指を離すと一覧の時刻も変わる
- [ ] 帯は拡大バーの範囲の外へは動かない。範囲の端をまたぐテロップは、掴んで少し動かしただけで範囲の端へ跳ばない
- [ ] 帯を押して離すと、そのテロップの頭から再生する
- [ ] 同じ時刻に重なるテロップを 3 つ作ると、帯は 2 段で、3 つ目は右端の時刻の下に「+1」とだけ出る。1440x795 でもバーの窓がプレイヤーに重ならず画面に収まる
- [ ] 録画中と録画後のプレビューの間は、帯が薄く出て、掴んでも押しても何も起きない
- [ ] シンプルモードと、テロップが 1 つも無いエディットモードでは、帯の段が出ず、バーの高さが変わらない
```

- [ ] **Step 5: store-release の掲載文に足す**

`docs/store-release.md` の 80 行目付近

```markdown
・テロップを入れて動画に焼き込むこともできます
```

の**直後** (空行を挟まず) に次を挿入する。

```markdown
・テロップは拡大バーの下に帯で出て、ドラッグで出す時間を動かせます
```

- [ ] **Step 6: 型とテストを通す (ドキュメントだけの変更だが、commit の前に通す規約に従う)**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/store-release.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 拡大バーの下のテロップの帯の使い方と制約を書く

帯は拡大バーの範囲の中でだけ動かせること、段は 2 段までで入らない
分は「+N」で数だけ出すことは、知らないと「動かない」「消えた」に
見える。コードより先に、使い方・制約・確認項目・掲載文に書いておく。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: 拡大バーの時間の窓を外から読めるようにする (`range-bar.ts`)

**Files:**
- Modify: `src/content/range-bar.ts:34-47` (型 `RangeBar`)、`:55-56` (ラベルのコメントだけ)、`:96-98` (状態)、`:228-235` (`update` と戻り値)
- Test: `tests/content/range-bar.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `RangeBar.window(): TimeWindow | null` — `update` される前は `null`、後は `computeWindow` の窓の**写し**

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/range-bar.test.ts` の 3 行目

```typescript
import type { RangeBar } from "@/content/range-bar";
```

を次に置き換える。

```typescript
import { createRangeBar, type RangeBar } from "@/content/range-bar";
```

ファイルの末尾に次を足す。

```typescript
describe("時間の窓 (テロップの帯が同じ軸で読む)", () => {
  test("update する前は null (幅 0 の窓を軸にさせない)", () => {
    const bar = createRangeBar({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onSeekPlay: () => undefined,
      maxClipSec: () => 60,
    });

    expect(bar.window()).toBeNull();
  });

  test("update した範囲から決めた窓を返す", () => {
    // 範囲 30〜45 (15 秒) の窓は 30 秒幅で、中央 37.5 の前後に 15 秒ずつ
    const { bar } = mountRangeBar();

    expect(bar.window()).toEqual({ startSec: 22.5, endSec: 52.5 });
  });

  test("返した窓を書き換えても、拡大バーの窓は変わらない", () => {
    const { bar } = mountRangeBar();
    const read = bar.window();
    if (read === null) throw new Error("窓がありません");

    read.startSec = 0;

    expect(bar.window()).toEqual({ startSec: 22.5, endSec: 52.5 });
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/range-bar.test.ts` (Bash の timeout 120000)
期待: FAIL (`bar.window is not a function`。型の検査は vitest ではしないので、実行時の失敗で出る)

- [ ] **Step 3: 最小実装**

`src/content/range-bar.ts` の型 `RangeBar` の

```typescript
  /** 現在の再生位置を示す。窓の外や位置が分からないときは null */
  setPlayhead(sec: number | null): void;
  destroy(): void;
};
```

を次に置き換える。

```typescript
  /** 現在の再生位置を示す。窓の外や位置が分からないときは null */
  setPlayhead(sec: number | null): void;
  /**
   * 今映している時間の窓。**まだ update していなければ null** (初期値の 0〜0 は軸にならない)。
   * 拡大バーの下のテロップの帯が、同じ時間の軸で帯を置くために読む (フロートの窓の spec B.3)
   */
  window(): TimeWindow | null;
  destroy(): void;
};
```

同じファイルの

```typescript
  const startLabel = document.createElement("span");
  const endLabel = document.createElement("span");
```

を次に置き換える (振る舞いは変えない。後で style を足す人が帯の段とのずれに気づけるようにする)。

```typescript
  // 窓の左端・右端の時刻。**素の span のまま、見た目は RANGE_STYLE.root から継ぐ。** telop-track.ts が
  // 同じ時刻を同じ幅の見えない span で左右に置き、帯の段をトラックの左右に揃えている。ここに style を
  // 足すなら、TELOP_TRACK_STYLE.ghost にも同じものを足す (足さないと帯とトラックの左右がずれる)
  const startLabel = document.createElement("span");
  const endLabel = document.createElement("span");
```

同じファイルの

```typescript
  /** 現在の範囲と窓。update で更新される */
  let range: ClipRange = { startSec: 0, endSec: 0 };
  let window_: TimeWindow = { startSec: 0, endSec: 0 };
```

の**直後**に次を挿入する。

```typescript
  /** update が 1 度でも呼ばれたか。呼ばれる前の窓 (0〜0) は外へ渡さない */
  let updated = false;
```

同じファイルの戻り値の

```typescript
    update(nextRange: ClipRange, videoDurationSec: number): void {
      range = nextRange;
      window_ = computeWindow(nextRange, videoDurationSec);
      paint();
    },
```

を次に置き換える。

```typescript
    update(nextRange: ClipRange, videoDurationSec: number): void {
      range = nextRange;
      window_ = computeWindow(nextRange, videoDurationSec);
      updated = true;
      paint();
    },

    window(): TimeWindow | null {
      // 写しを返す。受け取った側が書き換えても、この拡大バーの窓は変わらない
      return updated ? { ...window_ } : null;
    },
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/range-bar.test.ts` (Bash の timeout 120000)
期待: PASS (既存 + 新しい 3 件)

- [ ] **Step 5: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/range-bar.ts tests/content/range-bar.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(range-bar): 拡大バーが映している時間の窓を外から読めるようにする

拡大バーの下に出すテロップの帯は、拡大バーと同じ時間の軸で置く。
窓の決め方 (computeWindow) を帯の側でもう一度計算すると、選んでいる
区間を取り違えたときに軸がずれるので、拡大バーが持つ窓をそのまま
読ませる。update 前の 0〜0 の窓は軸にならないので null で返す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: 帯の段の計算 (純粋関数。`telop-track.ts`)

**Files:**
- Create: `src/content/telop-track.ts`
- Test: `tests/content/telop-track.test.ts`

**Interfaces:**
- Consumes: `TimeWindow` (`src/content/range-math.ts`)
- Produces (Task 4・5 が使う):
  - `export const MAX_TELOP_LANES = 2` / `TELOP_LANE_HEIGHT_PX = 14` / `TELOP_LANE_GAP_PX = 2` / `MIN_TELOP_DRAG_SEC = 0.5` / `TELOP_EDGE_MAX_PX = 6` / `TELOP_CLICK_SLOP_PX = 4`
  - `export type TelopDragKind = "move" | "start" | "end"`
  - `export type TelopSpan = { startSec: number; endSec: number }`
  - `export function telopsInWindow(telops: readonly TelopSpan[], window: TimeWindow): number[]` — 窓に一部でも入るテロップの index (元の並び)
  - `export function assignLanes(telops: readonly TelopSpan[], maxLanes: number): number[]` — 入力と同じ並びで段 (0 始まり)。入らないものは `-1`
  - `export function grabKindAt(offsetPx: number, widthPx: number): TelopDragKind`
  - `export function dragTelop(kind: TelopDragKind, startSec: number, endSec: number, deltaSec: number, window: TimeWindow): TelopSpan`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/telop-track.test.ts` を作る。**Task 4 で DOM のテストを同じファイルに足すので、最初から jsdom にしておく。**

```typescript
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  MAX_TELOP_LANES,
  assignLanes,
  dragTelop,
  grabKindAt,
  telopsInWindow,
} from "@/content/telop-track";

const span = (startSec: number, endSec: number) => ({ startSec, endSec });

describe("telopsInWindow", () => {
  const WINDOW = span(20, 50);

  test("窓に一部でも入るテロップを、元の位置 (index) で返す", () => {
    expect(
      telopsInWindow(
        [span(0, 10), span(18, 22), span(30, 33), span(48, 60), span(70, 80)],
        WINDOW,
      ),
    ).toEqual([1, 2, 3]);
  });

  test("窓の端に接するだけのテロップは入れない (半開区間)", () => {
    expect(telopsInWindow([span(10, 20), span(50, 55)], WINDOW)).toEqual([]);
  });

  test("窓を丸ごと覆うテロップも入れる", () => {
    expect(telopsInWindow([span(0, 100)], WINDOW)).toEqual([0]);
  });
});

describe("assignLanes", () => {
  test("段は最大 2 段 (3 段だと 1440x795 でバーがプレイヤーを覆う)", () => {
    expect(MAX_TELOP_LANES).toBe(2);
  });

  test("重ならなければ全部 1 段目", () => {
    expect(assignLanes([span(0, 5), span(6, 10), span(12, 15)], 2)).toEqual([0, 0, 0]);
  });

  test("重なれば空いている次の段に置く", () => {
    expect(assignLanes([span(0, 5), span(3, 8)], 2)).toEqual([0, 1]);
  });

  test("2 段に入らないテロップは -1 (帯を出さず +N で数える)", () => {
    expect(assignLanes([span(0, 5), span(1, 5), span(2, 5)], 2)).toEqual([0, 1, -1]);
  });

  test("前のテロップの終了ちょうどに始まるテロップは同じ段 (半開区間)", () => {
    expect(assignLanes([span(0, 5), span(5, 8)], 2)).toEqual([0, 0]);
  });

  test("作った順ではなく、開始の早い順に置く", () => {
    expect(assignLanes([span(20, 25), span(10, 30)], 2)).toEqual([1, 0]);
  });

  test("同じ開始なら作った順", () => {
    expect(assignLanes([span(0, 5), span(0, 5), span(0, 5)], 2)).toEqual([0, 1, -1]);
  });

  test("空いた段は前から使う", () => {
    // 3 つ目 (4〜8) は 1 段目 (〜5) とは重なるが、2 段目 (〜3) は空いている
    expect(assignLanes([span(0, 5), span(1, 3), span(4, 8)], 2)).toEqual([0, 1, 1]);
  });

  test("あふれたテロップは段を塞がない", () => {
    // 3 つ目 (2〜3) はあふれる。4 つ目 (10〜12) は 1 段目の終わり (10) から置ける
    expect(
      assignLanes([span(0, 10), span(1, 10), span(2, 3), span(10, 12)], 2),
    ).toEqual([0, 1, -1, 0]);
  });

  test("段の数が 1 未満や整数でなければ throw", () => {
    expect(() => assignLanes([], 0)).toThrow(RangeError);
    expect(() => assignLanes([], 1.5)).toThrow(RangeError);
  });
});

describe("grabKindAt", () => {
  test("幅の広い帯は、端から 6px までが端", () => {
    expect(grabKindAt(0, 60)).toBe("start");
    expect(grabKindAt(5.9, 60)).toBe("start");
    expect(grabKindAt(6, 60)).toBe("move");
    expect(grabKindAt(54, 60)).toBe("move");
    expect(grabKindAt(54.1, 60)).toBe("end");
    expect(grabKindAt(60, 60)).toBe("end");
  });

  test("細い帯は、幅の 1/3 までが端 (中も掴めるように)", () => {
    expect(grabKindAt(2.9, 9)).toBe("start");
    expect(grabKindAt(3, 9)).toBe("move");
    expect(grabKindAt(6, 9)).toBe("move");
    expect(grabKindAt(6.1, 9)).toBe("end");
  });

  test("幅が測れない (0) ときは中", () => {
    expect(grabKindAt(0, 0)).toBe("move");
  });
});

describe("dragTelop", () => {
  /** 拡大バーの窓。テロップは 30〜33 (3 秒) を基本にする */
  const WINDOW = span(20, 50);

  describe("中を掴む (move)", () => {
    test("長さを保って前後に動く", () => {
      expect(dragTelop("move", 30, 33, 5, WINDOW)).toEqual(span(35, 38));
      expect(dragTelop("move", 30, 33, -4, WINDOW)).toEqual(span(26, 29));
    });

    test("窓の終わりで止まる (帯が指の下で消えない)", () => {
      expect(dragTelop("move", 30, 33, 100, WINDOW)).toEqual(span(47, 50));
    });

    test("窓の始まりで止まる", () => {
      expect(dragTelop("move", 30, 33, -100, WINDOW)).toEqual(span(20, 23));
    });
  });

  describe("左端を掴む (start)", () => {
    test("開始だけが動く", () => {
      expect(dragTelop("start", 30, 33, -4, WINDOW)).toEqual(span(26, 33));
    });

    test("終了の 0.5 秒手前で止まる", () => {
      expect(dragTelop("start", 30, 33, 10, WINDOW)).toEqual(span(32.5, 33));
    });

    test("窓の始まりで止まる", () => {
      expect(dragTelop("start", 30, 33, -100, WINDOW)).toEqual(span(20, 33));
    });
  });

  describe("右端を掴む (end)", () => {
    test("終了だけが動く", () => {
      expect(dragTelop("end", 30, 33, 4, WINDOW)).toEqual(span(30, 37));
    });

    test("開始の 0.5 秒後で止まる", () => {
      expect(dragTelop("end", 30, 33, -10, WINDOW)).toEqual(span(30, 30.5));
    });

    test("窓の終わりで止まる", () => {
      expect(dragTelop("end", 30, 33, 100, WINDOW)).toEqual(span(30, 50));
    });
  });

  describe("今の長さが 0.5 秒未満", () => {
    test("今の長さより短くしない (掴んだだけで勝手に伸ばさない)", () => {
      expect(dragTelop("start", 30, 30.25, 5, WINDOW)).toEqual(span(30, 30.25));
      expect(dragTelop("end", 30, 30.25, -5, WINDOW)).toEqual(span(30, 30.25));
    });

    test("伸ばす向きには動く", () => {
      expect(dragTelop("end", 30, 30.25, 1, WINDOW)).toEqual(span(30, 31.25));
    });
  });

  describe("窓からはみ出したテロップ", () => {
    test("窓の始まりより前にはみ出した分はそのまま認め、今より外へは出さない", () => {
      expect(dragTelop("move", 15, 25, -3, WINDOW)).toEqual(span(15, 25));
      expect(dragTelop("start", 15, 25, -3, WINDOW)).toEqual(span(15, 25));
    });

    test("窓の中へは動かせる", () => {
      expect(dragTelop("move", 15, 25, 2, WINDOW)).toEqual(span(17, 27));
    });

    test("窓の終わりより後にはみ出した分も同じ", () => {
      expect(dragTelop("move", 45, 55, 3, WINDOW)).toEqual(span(45, 55));
      expect(dragTelop("end", 45, 55, 3, WINDOW)).toEqual(span(45, 55));
      expect(dragTelop("end", 45, 55, -2, WINDOW)).toEqual(span(45, 53));
    });

    test("少し動かしただけで窓の端へ跳ばない", () => {
      // 窓の始まり (20) より前から始まるテロップを 1 秒右へ。窓の端に揃え直さない
      expect(dragTelop("move", 15, 25, 1, WINDOW)).toEqual(span(16, 26));
    });
  });

  test("動かした量が数でなければ throw", () => {
    expect(() => dragTelop("move", 30, 33, Number.NaN, WINDOW)).toThrow(RangeError);
  });

  test("終了が開始以下なら throw", () => {
    expect(() => dragTelop("move", 33, 30, 1, WINDOW)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-track.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/content/telop-track"`)

- [ ] **Step 3: 最小実装**

`src/content/telop-track.ts` を作る。

```typescript
/**
 * 拡大バーの下に出すテロップの帯の段 (`.claude/specs/2026-09-24-floating-windows-design.md` B)。
 *
 * **時間の軸は持たない。** 拡大バー (range-bar.ts) が映している窓を受け取り、同じ軸で帯を置く。
 * 段の割り当て・窓に入るテロップ・掴んだ場所・ドラッグの計算は純粋関数に切り出してある
 * (DOM を組まずに境界を確かめるため)。
 *
 * 帯を動かして変えるのは**出す時間**だけ。文言は一覧 (telop-list.ts) で直す
 */

import type { TimeWindow } from "@/content/range-math";

/** 段の数の上限 (spec B.1)。3 段 (48px〜) だと 1440x795 でバーがプレイヤーの下端を覆う */
export const MAX_TELOP_LANES = 2;
/** 段の高さと段の間 (spec B.1)。2 段で 30px、拡大バーのトラックとの間 4px を足して 34px */
export const TELOP_LANE_HEIGHT_PX = 14;
export const TELOP_LANE_GAP_PX = 2;
/** 帯のドラッグで作れる最短の長さ (秒。spec B.2) */
export const MIN_TELOP_DRAG_SEC = 0.5;
/** 帯の端として掴める幅の上限 (px)。実際の幅は帯の幅の 1/3 との小さい方 (spec B.2) */
export const TELOP_EDGE_MAX_PX = 6;
/** これ未満しか動かさずに離したら、ドラッグではなくクリック (spec B.2) */
export const TELOP_CLICK_SLOP_PX = 4;

/** 帯のどこを掴んだか。中 = 長さを保って動かす、端 = 開始か終了だけを動かす */
export type TelopDragKind = "move" | "start" | "end";

/** 時刻だけを見る計算の入力と出力。文言は要らない */
export type TelopSpan = { startSec: number; endSec: number };

/**
 * 窓に一部でも入るテロップの位置 (index。元の並び)。**空の文言も入れる** (まだ書いていない
 * テロップも帯で動かせるように。spec B.1)。端が接するだけのものは入れない (テロップは半開区間。
 * `overlapsSegments` と同じ判定)
 */
export function telopsInWindow(telops: readonly TelopSpan[], window: TimeWindow): number[] {
  const indices: number[] = [];
  telops.forEach((telop, index) => {
    if (telop.startSec < window.endSec && window.startSec < telop.endSec) {
      indices.push(index);
    }
  });
  return indices;
}

/**
 * 時間が重なるテロップを段に分ける (spec B.1「前から順に、空いている段に置く」)。
 * 戻り値は入力と同じ並びで、各テロップの段 (0 始まり)。**どの段にも入らないものは -1** で、帯は
 * 出さず「+N」で数だけ出す (重ねて置くと、重なった帯をうっかり掴んで別のテロップを動かす)。
 *
 * 開始の早い順 (同じ開始なら作った順) に、いちばん若い空いた段へ置く。作った順に置くと、後から
 * 足した早いテロップが 2 段目に回り、時間の流れと段の並びが食い違って読みにくい
 */
export function assignLanes(telops: readonly TelopSpan[], maxLanes: number): number[] {
  if (!Number.isInteger(maxLanes) || maxLanes < 1) {
    throw new RangeError(`段の数が不正です: ${maxLanes}`);
  }
  const order = telops
    .map((telop, index) => ({ telop, index }))
    .sort((a, b) => a.telop.startSec - b.telop.startSec || a.index - b.index);
  /** 段ごとの、いま置いてある最後のテロップの終了 */
  const laneEnds: number[] = [];
  const lanes = telops.map(() => -1);
  for (const { telop, index } of order) {
    // 半開区間なので、前のテロップの終了ちょうどに始まるなら同じ段に置ける
    const free = laneEnds.findIndex((end) => end <= telop.startSec);
    if (free >= 0) {
      laneEnds[free] = telop.endSec;
      lanes[index] = free;
    } else if (laneEnds.length < maxLanes) {
      lanes[index] = laneEnds.length;
      laneEnds.push(telop.endSec);
    }
    // どの段にも入らないものは -1 のまま。段を塞がないので、後のテロップは空いた段に入れる
  }
  return lanes;
}

/**
 * 帯のどこを掴んだか。端の幅は「帯の幅の 1/3、最大 6px」(spec B.2)。細い帯でも中を掴めるように
 * 1/3 で頭打ちにする。ちょうど境目は中。幅が測れない (0) ときも中
 */
export function grabKindAt(offsetPx: number, widthPx: number): TelopDragKind {
  const edge = Math.min(TELOP_EDGE_MAX_PX, widthPx / 3);
  if (offsetPx < edge) return "start";
  if (offsetPx > widthPx - edge) return "end";
  return "move";
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(highest, Math.max(lowest, value));
}

/**
 * 帯を動かした結果の時刻 (spec B.2)。
 *
 * 動かせる範囲は拡大バーの窓の中。**ただし、もともと窓からはみ出している分はそのまま認める**
 * (下限は min(窓の開始, 今の開始)、上限は max(窓の終了, 今の終了))。窓の端をまたぐテロップを
 * 少し動かしただけで、窓の端へ跳ばないようにする。
 *
 * 長さの下限は 0.5 秒。**今の長さが 0.5 秒未満なら今の長さを下限にする** (一覧で短くしたものを、
 * 帯で掴んだだけで勝手に伸ばさない)
 */
export function dragTelop(
  kind: TelopDragKind,
  startSec: number,
  endSec: number,
  deltaSec: number,
  window: TimeWindow,
): TelopSpan {
  if (!Number.isFinite(deltaSec)) {
    throw new RangeError(`動かした量が不正です: ${deltaSec}`);
  }
  // NaN もここで弾く (比較が偽になる)
  if (!(endSec > startSec)) {
    throw new RangeError(`テロップの終了が開始以下です: ${startSec}-${endSec}`);
  }
  const lowest = Math.min(window.startSec, startSec);
  const highest = Math.max(window.endSec, endSec);
  const length = endSec - startSec;
  const minLength = Math.min(MIN_TELOP_DRAG_SEC, length);

  if (kind === "move") {
    const next = clamp(startSec + deltaSec, lowest, highest - length);
    return { startSec: next, endSec: next + length };
  }
  if (kind === "start") {
    return { startSec: clamp(startSec + deltaSec, lowest, endSec - minLength), endSec };
  }
  return { startSec, endSec: clamp(endSec + deltaSec, startSec + minLength, highest) };
}
```

`TELOP_LANE_HEIGHT_PX` / `TELOP_LANE_GAP_PX` / `TELOP_CLICK_SLOP_PX` はこのタスクでは使わないが、`export` しているので
`noUnusedLocals` には掛からない (Task 4 の DOM が使う)。

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/telop-track.test.ts` (Bash の timeout 120000)
期待: PASS (33 件)

- [ ] **Step 5: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/telop-track.ts tests/content/telop-track.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): テロップの帯の段の割り当てとドラッグの計算を足す

拡大バーの下にテロップを帯で出すための計算を、DOM から切り離して
境界まで確かめられるようにする。段は開始の早い順に 2 段まで置き、
入らない分は数だけ出す (重ねると別のテロップを掴む)。帯は拡大バー
の窓の中でだけ動かし、もともとはみ出していた分は認める (掴んだだけ
で窓の端へ跳ばない)。0.5 秒より短いテロップは掴んでも伸ばさない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: 帯の段の描画とドラッグ (`createTelopTrack`)

**Files:**
- Modify: `src/content/styles.ts` (`RANGE_STYLE` の後に `TELOP_TRACK_STYLE` を足す)
- Modify: `src/content/telop-track.ts` (import と `createTelopTrack` を足す)
- Test: `tests/content/telop-track.test.ts`
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes: Task 3 の定数・`telopsInWindow` / `assignLanes` / `grabKindAt` / `dragTelop` / `TelopSpan`、`timeToRatio` (`range-math.ts`)、`formatTime` (`shared/time.ts`)、`Telop` (`shared/types.ts`)
- Produces (Task 5 が使う):
  - `export type TelopTrackCallbacks = { onScrub(sec: number): void; onCommit(index: number, startSec: number, endSec: number): void; onPlay(index: number): void }`
  - `export type TelopTrack = { element: HTMLElement; update(telops: Telop[], window: TimeWindow): void; setEnabled(enabled: boolean): void; destroy(): void }`
  - `export function createTelopTrack(callbacks: TelopTrackCallbacks): TelopTrack`
  - DOM の目印: 根 `[data-role=telop-track]` (子は順に 左の見えない時刻 `span` / 段の箱 `[data-role=telop-lanes]` / 右の箱 (見えない時刻 `span` と `[data-role=telop-overflow]`))。帯 `[data-role=telop-band]` (`data-index` = 元の並びの index、`data-lane` = 段)
  - 出し入れ: テロップが 0 件なら `element.hidden === true` かつ `element.style.display === "none"`、1 件以上なら `false` / `"flex"`
  - 無効の見た目: `element.style.opacity === "0.4"`、段の箱の `style.pointerEvents === "none"`。**生成直後は無効**
  - `export const TELOP_TRACK_STYLE` (`styles.ts`)

- [ ] **Step 1: 失敗するテストを書く (styles)**

`tests/content/styles.test.ts` の import

```typescript
import {
  BAR_STYLE,
  FLOATING_WINDOW_STYLE,
  SIDE_PANEL_STYLE,
  applyPalette,
  isDarkTheme,
} from "@/content/styles";
```

を次に置き換える。

```typescript
import {
  BAR_STYLE,
  FLOATING_WINDOW_STYLE,
  RANGE_STYLE,
  SIDE_PANEL_STYLE,
  TELOP_TRACK_STYLE,
  applyPalette,
  isDarkTheme,
} from "@/content/styles";
```

ファイルの末尾に次を足す。

```typescript
describe("テロップの帯の段", () => {
  test("拡大バーのトラックとの間を 4px に詰め、高さは 2 段ぶん (14 + 2 + 14) に固定する", () => {
    // バーの縦の並びは gap:10px。-6px で 4px になる (spec B.3。予算 34px)
    expect(BAR_STYLE.root).toContain("gap:10px");
    expect(TELOP_TRACK_STYLE.root).toContain("margin-top:-6px");
    expect(TELOP_TRACK_STYLE.root).toContain("height:30px");
    expect(TELOP_TRACK_STYLE.band).toContain("height:14px");
    // 「+N」は 2 段目の高さ (14 + 2) に置く
    expect(TELOP_TRACK_STYLE.overflow).toContain("top:16px");
  });

  test("根は display を持たない (出し入れは telop-track.ts が決める)", () => {
    expect(TELOP_TRACK_STYLE.root).not.toContain("display");
  });

  test("左右の見えない時刻は、拡大バーのラベルと同じ文字の大きさ・数字の幅・間で並ぶ", () => {
    // 同じでないと、帯の段の左右が拡大バーのトラックの左右とずれる
    for (const rule of ["gap:10px", "font-size:12px", "font-variant-numeric:tabular-nums"]) {
      expect(RANGE_STYLE.root).toContain(rule);
      expect(TELOP_TRACK_STYLE.root).toContain(rule);
    }
    expect(TELOP_TRACK_STYLE.ghost).toContain("visibility:hidden");
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (telop-track の DOM)**

`tests/content/telop-track.test.ts` の import (Task 3 で書いたもの)

```typescript
import { describe, expect, test } from "vitest";
import {
  MAX_TELOP_LANES,
  assignLanes,
  dragTelop,
  grabKindAt,
  telopsInWindow,
} from "@/content/telop-track";
```

を次に置き換える。

```typescript
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { TimeWindow } from "@/content/range-math";
import {
  MAX_TELOP_LANES,
  assignLanes,
  createTelopTrack,
  dragTelop,
  grabKindAt,
  telopsInWindow,
  type TelopTrack,
} from "@/content/telop-track";
import type { Telop } from "@/shared/types";
```

ファイルの末尾に次を足す。

```typescript
/** 窓 0〜40 秒を幅 400px の段の箱に置く (10px/秒) */
const TRACK_WINDOW: TimeWindow = { startSec: 0, endSec: 40 };
const LANES_WIDTH = 400;
/** 帯は 100〜200px (25%〜50%)。中は 106〜194px、左端は 100〜106px、右端は 194〜200px */
const TELOP: Telop = { startSec: 10, endSec: 20, text: "こんにちは" };

function box(left: number, width: number): DOMRect {
  return {
    left,
    width,
    top: 0,
    height: 14,
    right: left + width,
    bottom: 14,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom はレイアウトを持たない。段の箱は幅 400px、帯の箱は style の % から求める
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (!(this instanceof HTMLElement)) return box(0, 0);
    if (this.dataset.role === "telop-lanes") return box(0, LANES_WIDTH);
    if (this.dataset.role === "telop-band") {
      const left = (Number.parseFloat(this.style.left) / 100) * LANES_WIDTH;
      const width = (Number.parseFloat(this.style.width) / 100) * LANES_WIDTH;
      return box(left, width);
    }
    return box(0, 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Harness = {
  track: TelopTrack;
  committed: [number, number, number][];
  played: number[];
  scrubbed: number[];
};

function mountTrack(telops: Telop[], enabled = true): Harness {
  const committed: [number, number, number][] = [];
  const played: number[] = [];
  const scrubbed: number[] = [];
  const track = createTelopTrack({
    onScrub: (sec) => scrubbed.push(sec),
    onCommit: (index, startSec, endSec) => committed.push([index, startSec, endSec]),
    onPlay: (index) => played.push(index),
  });
  document.body.append(track.element);
  track.update(telops, TRACK_WINDOW);
  track.setEnabled(enabled);
  return { track, committed, played, scrubbed };
}

function bandsOf(track: TelopTrack): HTMLElement[] {
  return [...track.element.querySelectorAll<HTMLElement>("[data-role='telop-band']")];
}

function bandAt(track: TelopTrack, position: number): HTMLElement {
  const band = bandsOf(track)[position];
  if (band === undefined) throw new Error(`帯がありません: ${position}`);
  return band;
}

function lanesOf(track: TelopTrack): HTMLElement {
  const lanes = track.element.querySelector<HTMLElement>("[data-role='telop-lanes']");
  if (lanes === null) throw new Error("段の箱がありません");
  return lanes;
}

function overflowOf(track: TelopTrack): HTMLElement {
  const overflow = track.element.querySelector<HTMLElement>("[data-role='telop-overflow']");
  if (overflow === null) throw new Error("+N がありません");
  return overflow;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 7, button: 0 }));
}

/** ドラッグ中のシークは 1 フレームに 1 回に間引かれる。1 フレーム待つ */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("createTelopTrack の見た目", () => {
  test("窓に入るテロップを、拡大バーと同じ時間の軸で帯にする", () => {
    const { track } = mountTrack([TELOP]);

    const band = bandAt(track, 0);
    expect(bandsOf(track)).toHaveLength(1);
    expect(band.style.left).toBe("25%");
    expect(band.style.width).toBe("25%");
    expect(band.textContent).toBe("こんにちは");
    expect(band.dataset.index).toBe("0");
  });

  test("窓の外のテロップは帯にしない。index は元の並びのまま", () => {
    const { track } = mountTrack([{ startSec: 50, endSec: 60, text: "外" }, TELOP]);

    expect(bandsOf(track)).toHaveLength(1);
    expect(bandAt(track, 0).dataset.index).toBe("1");
  });

  test("空の文言は「(未入力)」。改行は 1 行に詰める", () => {
    const { track } = mountTrack([
      { startSec: 10, endSec: 20, text: "" },
      { startSec: 21, endSec: 25, text: "一行目\n二行目" },
    ]);

    expect(bandsOf(track).map((band) => band.textContent)).toEqual([
      "(未入力)",
      "一行目 二行目",
    ]);
  });

  test("左右に拡大バーと同じ時刻を置いて、帯の段をトラックの左右に揃える", () => {
    const { track } = mountTrack([TELOP]);

    expect(track.element.children[0]?.textContent).toBe("0:00");
    expect(track.element.children[1]).toBe(lanesOf(track));
    expect(track.element.children[2]?.firstElementChild?.textContent).toBe("0:40");
  });

  test("重なるテロップは段を分ける (段の高さ 14px・段の間 2px)", () => {
    const { track } = mountTrack([TELOP, { startSec: 15, endSec: 25, text: "やあ" }]);

    expect(bandsOf(track).map((band) => band.style.top)).toEqual(["0px", "16px"]);
    expect(bandsOf(track).map((band) => band.dataset.lane)).toEqual(["0", "1"]);
  });

  test("2 段に入らない分は帯を出さず、右端に「+N」だけ出す", () => {
    const { track } = mountTrack([
      TELOP,
      { startSec: 12, endSec: 18, text: "b" },
      { startSec: 14, endSec: 16, text: "c" },
      { startSec: 15, endSec: 19, text: "d" },
    ]);

    expect(bandsOf(track)).toHaveLength(2);
    expect(overflowOf(track).hidden).toBe(false);
    expect(overflowOf(track).textContent).toBe("+2");
  });

  test("あふれが無ければ「+N」を隠す", () => {
    const { track } = mountTrack([TELOP]);

    expect(overflowOf(track).hidden).toBe(true);
  });

  test("テロップが 1 つも無ければ段ごと隠す (バーを高くしない)", () => {
    const { track } = mountTrack([]);

    expect(track.element.hidden).toBe(true);
    expect(track.element.style.display).toBe("none");

    track.update([TELOP], TRACK_WINDOW);

    expect(track.element.hidden).toBe(false);
    expect(track.element.style.display).toBe("flex");
  });

  test("「+N」を押しても何も起きない (一覧で直す)", () => {
    const { track, committed, played } = mountTrack([
      TELOP,
      { startSec: 12, endSec: 18, text: "b" },
      { startSec: 14, endSec: 16, text: "c" },
    ]);

    pointer(overflowOf(track), "pointerdown", 410);
    pointer(overflowOf(track), "pointerup", 410);
    overflowOf(track).click();

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("生成直後は動かせない (薄く出す)", () => {
    // 呼び出し側が setEnabled を呼び忘れても、編集できない状態で動かさない
    const track = createTelopTrack({
      onScrub: () => undefined,
      onCommit: () => undefined,
      onPlay: () => undefined,
    });

    expect(track.element.style.opacity).toBe("0.4");
    expect(lanesOf(track).style.pointerEvents).toBe("none");
  });
});

describe("帯のドラッグ", () => {
  test("中を掴むと長さを保って動き、指を離したときに 1 回だけ onCommit", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);
    // 動かしている間は送らない (区間の拡大バーと同じ。往復を増やさない)
    expect(committed).toEqual([]);
    pointer(band, "pointerup", 250);

    // 100px = 10 秒
    expect(committed).toEqual([[0, 20, 30]]);
    // 状態の通知が返るまでも、離した場所に帯を残す
    expect(bandAt(track, 0).style.left).toBe("50%");
  });

  test("左端を掴むと開始だけが動く", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 102);
    pointer(band, "pointermove", 82);
    pointer(band, "pointerup", 82);

    expect(committed).toEqual([[0, 8, 20]]);
  });

  test("右端を掴むと終了だけが動く", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 197);
    pointer(band, "pointermove", 217);
    pointer(band, "pointerup", 217);

    expect(committed).toEqual([[0, 10, 22]]);
  });

  test("中を掴んで動かすと、開始の位置へシークする", async () => {
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    await nextFrame();
    pointer(band, "pointerup", 170);

    expect(scrubbed).toEqual([12]);
  });

  test("右端を掴んで動かすと、終了の位置へシークする", async () => {
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 197);
    pointer(band, "pointermove", 217);
    await nextFrame();
    pointer(band, "pointerup", 217);

    expect(scrubbed).toEqual([22]);
  });

  test("4px 未満しか動かさずに離すと、そのテロップの頭から再生する (onPlay)", () => {
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 153);
    pointer(band, "pointerup", 153);

    expect(played).toEqual([0]);
    expect(committed).toEqual([]);
  });

  test("4px 以上動かしてから元の場所へ戻して離したら、送らず再生もしない", () => {
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointermove", 150);
    pointer(band, "pointerup", 150);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("窓の外へは動かさない", () => {
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 1000);
    pointer(band, "pointerup", 1000);

    expect(committed).toEqual([[0, 30, 40]]);
  });

  test("無効な間は動かず、押して離しても再生しない (薄く出す)", () => {
    const { track, committed, played } = mountTrack([TELOP], false);
    const band = bandAt(track, 0);

    expect(track.element.style.opacity).toBe("0.4");
    expect(lanesOf(track).style.pointerEvents).toBe("none");

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointerup", 170);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointerup", 150);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
  });

  test("ドラッグ中に無効になったら打ち切り、帯を元の位置に戻す", () => {
    // 録画が始まった後もシークし続けると、録画された映像に飛びが入る
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);
    expect(band.style.left).toBe("50%");

    track.setEnabled(false);
    pointer(band, "pointerup", 250);

    expect(committed).toEqual([]);
    expect(bandAt(track, 0).style.left).toBe("25%");
  });

  test("ドラッグ中に届いた update は、指を離してから描く", () => {
    // 描き直すと掴んでいる帯が作り直され、ポインタの捕捉が外れる
    const { track, committed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);

    track.update([{ ...TELOP, text: "やあ" }], TRACK_WINDOW);

    expect(bandAt(track, 0)).toBe(band);
    expect(band.textContent).toBe("こんにちは");

    pointer(band, "pointerup", 250);

    expect(committed).toEqual([[0, 20, 30]]);
    // 届いていた文言に、離した時刻を載せて描く
    expect(bandAt(track, 0).textContent).toBe("やあ");
    expect(bandAt(track, 0).style.left).toBe("50%");
  });

  test("ドラッグ中に届いた update で掴んだテロップが入れ替わったら、確定しない", () => {
    // 一覧の ✕ で前のテロップが消えると index がずれる。別のテロップに時刻を載せて送らない
    const { track, committed, played } = mountTrack([TELOP]);
    const band = bandAt(track, 0);
    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 250);

    track.update([{ startSec: 30, endSec: 35, text: "別" }], TRACK_WINDOW);
    pointer(band, "pointerup", 250);

    expect(committed).toEqual([]);
    expect(played).toEqual([]);
    // 届いていた update のとおりに描く
    expect(bandAt(track, 0).textContent).toBe("別");
    expect(bandAt(track, 0).style.left).toBe("75%");
  });

  test("指を離した後は、予約済みのシークも走らせない", async () => {
    // 1 フレーム後に動画が飛ぶと、元へ戻して離したときに見た目と違う位置で止まる
    const { track, scrubbed } = mountTrack([TELOP]);
    const band = bandAt(track, 0);

    pointer(band, "pointerdown", 150);
    pointer(band, "pointermove", 170);
    pointer(band, "pointerup", 170);
    await nextFrame();

    expect(scrubbed).toEqual([]);
  });

  test("destroy すると要素が DOM から外れる", () => {
    const { track } = mountTrack([TELOP]);

    track.destroy();

    expect(document.body.contains(track.element)).toBe(false);
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-track.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: FAIL (`createTelopTrack is not a function` / `TELOP_TRACK_STYLE` が undefined で `toContain` が落ちる)

- [ ] **Step 4: 見た目を足す (`styles.ts`)**

`src/content/styles.ts` の `RANGE_STYLE` の終わり

```typescript
  disabled: "opacity:0.4;pointer-events:none;",
} as const;

/** 区間の一覧。行は押せるので、押せることが分かる見た目にする */
```

を次に置き換える (`RANGE_STYLE` の後、`SEGMENT_STYLE` の前に `TELOP_TRACK_STYLE` を挟む)。

```typescript
  disabled: "opacity:0.4;pointer-events:none;",
} as const;

/**
 * 拡大バーの下のテロップの帯の段 (`telop-track.ts`。フロートの窓の spec B)。
 *
 * **根は display を持たない。** 出し入れは telop-track.ts が `style.display` で行う (ここに display を
 * 書くと、`hidden` を立てても inline の display が勝って出たままになる)。高さは 2 段ぶん
 * (14 + 2 + 14 = 30px) に固定し、重なりの有無でバーの高さを揺らさない。`margin-top:-6px` で、バーの
 * 縦の並びの gap (10px) を拡大バーのトラックとの間 4px に詰める (spec B.3。予算 34px)。
 *
 * `gap`・文字の大きさ・数字の幅は拡大バー (`RANGE_STYLE.root`) に揃える。左右に置く見えない時刻
 * (`ghost`) の幅が拡大バーのラベルの幅と同じになり、帯の段がトラックの左右に揃う
 */
export const TELOP_TRACK_STYLE = {
  root: "gap:10px;height:30px;margin-top:-6px;font-size:12px;font-variant-numeric:tabular-nums;",
  ghost: "visibility:hidden;white-space:nowrap;",
  lanes: "position:relative;flex:1;min-width:0;",
  /** 右の見えない時刻の箱。「+N」をこの中の 2 段目の高さに置く (帯と重ねない。spec B.3) */
  endCell: "position:relative;",
  /**
   * 帯 1 本。位置 (left / width / top) は telop-track.ts が決める。文字を選べると、掴んだつもりで
   * 選択が始まる。`touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  band: "position:absolute;height:14px;box-sizing:border-box;min-width:4px;padding:0 4px;border:1px solid var(--ytc-accent);border-radius:3px;background:var(--ytc-surface);color:var(--ytc-text);font-size:10px;line-height:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:grab;touch-action:none;user-select:none;",
  /** 2 段に入らない分の数。押しても何もしないので、掴めそうなカーソルを出さない */
  overflow:
    "position:absolute;left:0;top:16px;height:14px;line-height:14px;font-size:11px;color:var(--ytc-text-sub);white-space:nowrap;cursor:default;",
} as const;

/** 区間の一覧。行は押せるので、押せることが分かる見た目にする */
```

- [ ] **Step 5: 帯の段を作る (`telop-track.ts`)**

`src/content/telop-track.ts` の import

```typescript
import type { TimeWindow } from "@/content/range-math";
```

を次に置き換える。

```typescript
import { timeToRatio, type TimeWindow } from "@/content/range-math";
import { TELOP_TRACK_STYLE } from "@/content/styles";
import { formatTime } from "@/shared/time";
import type { Telop } from "@/shared/types";
```

ファイルの末尾に次を足す。

```typescript
export type TelopTrackCallbacks = {
  /** ドラッグ中。動画をその位置へ追従させる (拡大バーの onScrub と同じ) */
  onScrub(sec: number): void;
  /** 指を離した。index のテロップの新しい時刻。**時刻が変わったときだけ**呼ぶ */
  onCommit(index: number, startSec: number, endSec: number): void;
  /** 押して動かさずに離した (4px 未満)。そのテロップの頭から再生する */
  onPlay(index: number): void;
};

export type TelopTrack = {
  element: HTMLElement;
  /**
   * テロップと、拡大バーの時間の窓を反映して描き直す。**テロップが 1 つも無ければ段ごと隠す**
   * (シンプルモードやテロップを使わない人のバーを高くしない)。ドラッグ中に呼ばれた分は、指を
   * 離してから描く (掴んでいる帯を作り直すと、ポインタの捕捉が外れる)
   */
  update(telops: Telop[], window: TimeWindow): void;
  /**
   * 動かせるか。偽の間は帯を薄く出し、掴んでも動かさず、押しても再生しない。**生成直後は偽**
   * (呼び出し側が忘れても、編集できない状態で動かさない)。進行中のドラッグは打ち切る
   */
  setEnabled(enabled: boolean): void;
  destroy(): void;
};

/** 帯に出す文言。空白と改行は 1 つの空白に詰める (帯は 1 行)。空なら「(未入力)」 */
function bandLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? "(未入力)" : line;
}

export function createTelopTrack(callbacks: TelopTrackCallbacks): TelopTrack {
  const element = document.createElement("div");
  element.dataset.role = "telop-track";
  element.style.cssText = TELOP_TRACK_STYLE.root;

  // 左右に拡大バーの時刻のラベルと同じ文字を見えない形で置き、帯の段の箱を拡大バーのトラックと
  // 同じ左右に揃える (spec B.3)。幅を測って写す形にしないのは、ラベルの幅が変わるたび
  // (1:02:03 のような長い時刻) に測り直す経路が要るため
  const startGhost = document.createElement("span");
  startGhost.style.cssText = TELOP_TRACK_STYLE.ghost;
  const lanes = document.createElement("div");
  lanes.dataset.role = "telop-lanes";
  lanes.style.cssText = TELOP_TRACK_STYLE.lanes;
  const endCell = document.createElement("div");
  endCell.style.cssText = TELOP_TRACK_STYLE.endCell;
  const endGhost = document.createElement("span");
  endGhost.style.cssText = TELOP_TRACK_STYLE.ghost;
  // 2 段に入らない分の数。右端の時刻のラベルの下の余白に置き、帯と重ねない (spec B.3)。
  // 押しても何もしない (一覧で直す) ので、リスナは付けない
  const overflow = document.createElement("span");
  overflow.dataset.role = "telop-overflow";
  overflow.style.cssText = TELOP_TRACK_STYLE.overflow;
  overflow.hidden = true;
  endCell.append(endGhost, overflow);
  element.append(startGhost, lanes, endCell);

  let telops: Telop[] = [];
  let window_: TimeWindow = { startSec: 0, endSec: 0 };
  let enabled = false;
  /** 進行中のドラッグを打ち切る (帯を元に戻す)。ドラッグしていなければ null */
  let cancelDrag: (() => void) | null = null;
  /** ドラッグ中に届いた update。指を離してから取り込む */
  let pending: { telops: Telop[]; window: TimeWindow } | null = null;
  /** 間引き用。次の描画フレームまで scrub をまとめる (range-bar.ts と同じ) */
  let scrubFrame = 0;
  let pendingScrubSec: number | null = null;

  function takePending(): void {
    if (pending === null) return;
    telops = pending.telops;
    window_ = pending.window;
    pending = null;
  }

  function placeBand(band: HTMLElement, span: TelopSpan): void {
    const left = timeToRatio(span.startSec, window_);
    const right = timeToRatio(span.endSec, window_);
    band.style.left = `${left * 100}%`;
    band.style.width = `${(right - left) * 100}%`;
  }

  /** ドラッグ中の追従。毎フレーム 1 回に間引く */
  function requestScrub(sec: number): void {
    pendingScrubSec = sec;
    if (scrubFrame !== 0) return;
    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      if (pendingScrubSec === null) return;
      const target = pendingScrubSec;
      pendingScrubSec = null;
      // 予約した後に無効になっている (録画が始まった) ことがある。シークすると録画に飛びが入る
      if (!enabled) return;
      callbacks.onScrub(target);
    });
  }

  function beginDrag(band: HTMLElement, index: number, event: PointerEvent): void {
    // 無効な間 (preview・録画中) は動かさず、再生もしない (一覧の ▶ も押せない)。
    // 主ボタン以外 (右クリックのメニューなど) では動かさない
    if (!enabled || event.button !== 0 || cancelDrag !== null) return;
    const telop = telops[index];
    if (telop === undefined) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();

    const box = band.getBoundingClientRect();
    const kind = grabKindAt(event.clientX - box.left, box.width);
    // このドラッグを起こした指だけを追う (floating-window.ts と同じ)
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin: TelopSpan = { startSec: telop.startSec, endSec: telop.endSec };
    let current: TelopSpan = origin;
    /** 4px 以上動いたか。一度動いたら、元の場所へ戻してもクリックには戻さない */
    let moved = false;
    band.setPointerCapture(pointerId);

    const finish = (): void => {
      // リスナを外してから捕捉を解く。先に解くと、自分の lostpointercapture で settle が 2 度走る
      band.removeEventListener("pointermove", onMove);
      band.removeEventListener("pointerup", onUp);
      band.removeEventListener("pointercancel", onCancel);
      band.removeEventListener("lostpointercapture", onCancel);
      band.releasePointerCapture(pointerId);
      // 予約済みのシークも取り消す。残すと指を離した 1 フレーム後に動画が飛ぶ (元の位置へ戻して
      // 離した・打ち切ったときでも、見た目と違う位置へシークしてしまう)
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      scrubFrame = 0;
      pendingScrubSec = null;
      cancelDrag = null;
    };

    /** 指を離した (または取り上げられた)。時刻が変わっていれば確定する */
    const settle = (canPlay: boolean): void => {
      finish();
      const changed =
        current.startSec !== origin.startSec || current.endSec !== origin.endSec;
      takePending();
      // 掴んだ後に届いた update でテロップが消えた・入れ替わった (index がずれた) ときは確定も
      // 再生もしない。掴んだ時点の時刻のテロップが同じ index にあることで、同じテロップと見なす。
      // 確かめないと、別のテロップに時刻を載せて送ってしまう
      const target = telops[index];
      const sameTarget =
        target !== undefined &&
        target.startSec === origin.startSec &&
        target.endSec === origin.endSec;
      const commit = changed && sameTarget;
      if (commit) {
        // 状態の通知が返るまでの間も、離した場所に帯を残す (次の通知で同じ時刻が届く)
        telops = telops.map((item, position) =>
          position === index ? { ...item, ...current } : item,
        );
      }
      paint();
      if (commit) {
        callbacks.onCommit(index, current.startSec, current.endSec);
      } else if (!moved && canPlay && sameTarget) {
        callbacks.onPlay(index);
      }
    };

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      // 4px に届くまでは動かさない (押して離すクリックと見分ける。spec B.2)
      if (!moved && Math.hypot(dx, dy) < TELOP_CLICK_SLOP_PX) return;
      moved = true;
      const width = lanes.getBoundingClientRect().width;
      // 幅が 0 (隠れた直後など) なら秒に直せない。動かさない。
      // 先に掛けてから割る (割ってから掛けるより丸めの誤差が出にくい)
      const deltaSec =
        width <= 0 ? 0 : (dx * (window_.endSec - window_.startSec)) / width;
      current = dragTelop(kind, origin.startSec, origin.endSec, deltaSec, window_);
      placeBand(band, current);
      // 動かしている側の位置を見せる。中を掴んだときは開始 (拡大バーの「動かしている側」と同じ)
      requestScrub(kind === "end" ? current.endSec : current.startSec);
    };

    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      settle(true);
    };

    // pointercancel (タッチの横取りなど)・lostpointercapture でも終える。動かした分は確定する
    // (range-bar.ts・floating-window.ts と同じ)。押しただけなら再生しない (取り上げられた操作を
    // クリックとみなさない)
    const onCancel = (cancelled: Event): void => {
      const cancelledId = (cancelled as PointerEvent).pointerId;
      if (cancelledId !== undefined && cancelledId !== pointerId) return;
      settle(false);
    };

    cancelDrag = (): void => {
      finish();
      takePending();
      // 元の位置 (または届いていた update の位置) で描き直す。送らない
      paint();
    };

    band.addEventListener("pointermove", onMove);
    band.addEventListener("pointerup", onUp);
    band.addEventListener("pointercancel", onCancel);
    band.addEventListener("lostpointercapture", onCancel);
  }

  function makeBand(index: number, telop: Telop, lane: number): HTMLElement {
    const band = document.createElement("div");
    band.dataset.role = "telop-band";
    band.dataset.index = String(index);
    band.dataset.lane = String(lane);
    band.style.cssText = TELOP_TRACK_STYLE.band;
    band.style.top = `${lane * (TELOP_LANE_HEIGHT_PX + TELOP_LANE_GAP_PX)}px`;
    band.textContent = bandLabel(telop.text);
    // 帯は 1 行で省略する。時刻と全文はマウスを乗せたときに読めるようにする
    band.title = `${formatTime(telop.startSec)} 〜 ${formatTime(telop.endSec)}\n${
      telop.text.trim() === "" ? "(未入力)" : telop.text
    }`;
    placeBand(band, telop);
    // 押す前から、端と中で違うカーソルを出す (掴んだら何が動くかを先に見せる)
    band.addEventListener("pointermove", (event: PointerEvent) => {
      if (cancelDrag !== null) return;
      const box = band.getBoundingClientRect();
      band.style.cursor =
        grabKindAt(event.clientX - box.left, box.width) === "move" ? "grab" : "ew-resize";
    });
    band.addEventListener("pointerdown", (event: PointerEvent) => beginDrag(band, index, event));
    return band;
  }

  function paint(): void {
    // 出し入れは hidden と style.display の両方で行う。根は flex で並べるので display を持ち、
    // inline の display は UA の [hidden] に勝つ (floating-window.ts と同じ作法)
    const shown = telops.length > 0;
    element.hidden = !shown;
    element.style.display = shown ? "flex" : "none";
    startGhost.textContent = formatTime(window_.startSec);
    endGhost.textContent = formatTime(window_.endSec);

    const entries = telopsInWindow(telops, window_).flatMap((index) => {
      const telop = telops[index];
      return telop === undefined ? [] : [{ index, telop }];
    });
    const laneOf = assignLanes(
      entries.map((entry) => entry.telop),
      MAX_TELOP_LANES,
    );
    const bands: HTMLElement[] = [];
    let overflowCount = 0;
    entries.forEach(({ index, telop }, position) => {
      const lane = laneOf[position] ?? -1;
      if (lane < 0) {
        overflowCount += 1;
        return;
      }
      bands.push(makeBand(index, telop, lane));
    });
    lanes.replaceChildren(...bands);
    overflow.hidden = overflowCount === 0;
    overflow.textContent = overflowCount === 0 ? "" : `+${overflowCount}`;
    overflow.title =
      overflowCount === 0
        ? ""
        : `ほかに ${overflowCount} 件 (時間が重なって帯に出せないテロップ。一覧で直す)`;
  }

  function applyEnabled(): void {
    element.style.opacity = enabled ? "" : "0.4";
    lanes.style.pointerEvents = enabled ? "" : "none";
  }

  applyEnabled();
  paint();

  return {
    element,

    update(nextTelops: Telop[], nextWindow: TimeWindow): void {
      if (cancelDrag !== null) {
        pending = { telops: nextTelops, window: nextWindow };
        return;
      }
      telops = nextTelops;
      window_ = nextWindow;
      paint();
    },

    setEnabled(next: boolean): void {
      enabled = next;
      applyEnabled();
      // 録画が始まったら進行中のドラッグも打ち切る。捕捉中は pointer-events を切ってもイベントが
      // 届くので、切るだけでは止まらない (range-bar.ts と同じ理由)
      if (!next) cancelDrag?.();
    },

    destroy(): void {
      cancelDrag?.();
      if (scrubFrame !== 0) cancelAnimationFrame(scrubFrame);
      element.remove();
    },
  };
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/telop-track.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: PASS (`telop-track.test.ts` は 57 件 = Task 3 の 33 + 24。`styles.test.ts` は既存 + 3 件)

- [ ] **Step 7: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/styles.ts src/content/telop-track.ts tests/content/telop-track.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): テロップの帯の段を描き、ドラッグで出す時間を動かす

帯の中は長さを保って、端は開始か終了だけを動かし、指を離したときに
1 回だけ確定を伝える (往復を増やさない)。4px 未満で離したら再生に
する。掴んでいる間に届いた描き直しは離すまで待つ (帯を作り直すと
捕捉が外れる)。段の高さは 2 段ぶんに固定し、帯を動かすたびにバー
の高さが揺れないようにする。左右は拡大バーと同じ時刻を見えない形で
置いて揃える (幅を測って写すと、ラベルの幅が変わるたびに測り直しが
要る)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: バーの窓に帯の段を置き、描き直しと `UPDATE_TELOP` を配線する (`youtube.ts`)

**Files:**
- Modify: `src/content/youtube.ts` (import・状態・`applyRange`・`applyStateToSelection`・`playTelop` の後・`refreshLists`・`applyStateToDisplay`・`buildBar`・`mount`)
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 2 の `RangeBar.window()`、Task 4 の `createTelopTrack` / `TelopTrack`
- Produces: `youtube.ts` の内部関数 `paintRangeBar(range: ClipRange, videoDurationSec: number): void` / `refreshTelopTrack(): void` / `onTelopDragged(index: number, startSec: number, endSec: number): void` (外へは出さない)。バーの中身の根 `#yt-clip-bar` の子は順に `#yt-clip-range` → `[data-role=telop-track]` → 操作の行

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の `describe("右側のパネル")` の中の「一覧と設定はパネルに入り、バーには拡大バーと操作の行だけが残る」
(2464 行目付近) を直す。テスト名

```typescript
  test("一覧と設定はパネルに入り、バーには拡大バーと操作の行だけが残る", async () => {
```

を次に置き換える。

```typescript
  test("一覧と設定はパネルに入り、バーには拡大バー・テロップの帯の段・操作の行だけが残る", async () => {
```

同じテストの

```typescript
    // 並びは今のまま: 拡大バー → 操作の行
    expect(bar.children.length).toBe(2);
    expect(bar.firstElementChild?.id).toBe("yt-clip-range");
```

を次に置き換える。

```typescript
    // 並び: 拡大バー → テロップの帯の段 (フロートの窓の spec B.3) → 操作の行
    expect(bar.children.length).toBe(3);
    expect(bar.firstElementChild?.id).toBe("yt-clip-range");
    expect(bar.children[1]?.getAttribute("data-role")).toBe("telop-track");
```

`describe("右側のパネル", () => {` の**直前**に、次の describe を足す。

```typescript
describe("拡大バーの下のテロップの帯", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  function track(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      "#yt-clip-bar [data-role='telop-track']",
    );
    if (element === null) throw new Error("帯の段がありません");
    return element;
  }

  function bands(): HTMLElement[] {
    return [...track().querySelectorAll<HTMLElement>("[data-role='telop-band']")];
  }

  function firstBand(): HTMLElement {
    const band = bands()[0];
    if (band === undefined) throw new Error("帯がありません");
    return band;
  }

  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  async function showReady(
    telops: Telop[],
    segments: ClipRange[] = [RANGE],
    clipMode: "edit" | "simple" = "edit",
  ): Promise<void> {
    changeSettings({ mode: clipMode });
    emit({ kind: "ready", segments, meta: META_A, telops });
    await flush();
    sent = [];
  }

  /**
   * 拡大バーの窓は 0〜30 秒 (範囲 10〜20 の 2 倍と 30 秒の広い方)。帯の段の箱を幅 300px
   * (10px/秒) に、テロップ (11〜14 秒) の帯を 110〜140px に決め打ちする。ほかの要素は 0
   */
  function stubLayout() {
    return vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const role = this instanceof HTMLElement ? this.dataset.role : undefined;
        if (role === "telop-lanes") return boxAt(0, 0, 300, 30);
        if (role === "telop-band") return boxAt(110, 0, 30, 14);
        return boxAt(0, 0, 0, 0);
      });
  }

  function updateTelopEvents(): unknown[] {
    return clipEvents().filter(
      (event) => (event as { type: string }).type === "UPDATE_TELOP",
    );
  }

  test("エディットモードで、拡大バーの窓に入るテロップを拡大バーの直下に帯で出す", async () => {
    await showReady([TELOP, { startSec: 100, endSec: 103, text: "窓の外" }]);

    expect(track().hidden).toBe(false);
    expect(bands().map((band) => band.textContent)).toEqual(["こんにちは"]);
    expect(track().previousElementSibling?.id).toBe("yt-clip-range");
  });

  test("シンプルモードでは出さない", async () => {
    await showReady([TELOP], [RANGE], "simple");

    expect(track().hidden).toBe(true);
  });

  test("テロップが 1 つも無ければ段ごと出さない (バーを高くしない)", async () => {
    await showReady([]);

    expect(track().hidden).toBe(true);
  });

  test("区間を選び直すと、選んだ区間の拡大バーの窓で帯を描き直す", async () => {
    await showReady(
      [TELOP, { startSec: 205, endSec: 208, text: "二つ目" }],
      [RANGE, { startSec: 200, endSec: 215 }],
    );
    // 状態の通知では選択は動かない (selectedIndex はテストをまたいで残り、index 0 = RANGE のまま)。
    // 行を押して区間 2 (200〜215、窓 192.5〜222.5) を選ぶ
    segmentRows()[1]?.click();
    expect(bands().map((band) => band.textContent)).toEqual(["二つ目"]);

    segmentRows()[0]?.click();

    expect(bands().map((band) => band.textContent)).toEqual(["こんにちは"]);
  });

  test("帯の中をドラッグすると、指を離したときに UPDATE_TELOP を 1 回だけ送る", async () => {
    await showReady([TELOP]);
    const spy = stubLayout();
    try {
      const band = firstBand();
      pointer(band, "pointerdown", 125, 5);
      pointer(band, "pointermove", 135, 5);
      pointer(band, "pointermove", 145, 5);
      // 動かしている間は送らない (区間の拡大バーと同じ。往復を増やさない)
      expect(updateTelopEvents()).toEqual([]);
      pointer(band, "pointerup", 145, 5);
    } finally {
      spy.mockRestore();
    }

    // 20px = 2 秒。長さ (3 秒) と文言は保つ
    expect(updateTelopEvents()).toEqual([
      {
        type: "UPDATE_TELOP",
        index: 0,
        telop: { startSec: 13, endSec: 16, text: "こんにちは" },
      },
    ]);
  });

  test("帯を押して動かさずに離すと、そのテロップの頭から再生する", async () => {
    await showReady([TELOP]);
    const spy = stubLayout();
    try {
      const band = firstBand();
      pointer(band, "pointerdown", 125, 5);
      pointer(band, "pointerup", 126, 5);
    } finally {
      spy.mockRestore();
    }
    await flush();

    expect(updateTelopEvents()).toEqual([]);
    expect(video.element.currentTime).toBe(11);
    expect(statusText()).toBe("テロップ 1 の頭から再生中…");
  });

  test("preview では帯を薄く出し、動かしも再生もしない", async () => {
    // 区間の拡大バーと同じ条件 (canEditTelops)。テロップだけ触れる非対称を作らない
    changeSettings({ mode: "edit" });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      meta: META_A,
      telops: [TELOP],
    });
    await flush();
    sent = [];

    expect(track().hidden).toBe(false);
    expect(track().style.opacity).toBe("0.4");

    const spy = stubLayout();
    try {
      const band = firstBand();
      pointer(band, "pointerdown", 125, 5);
      pointer(band, "pointermove", 145, 5);
      pointer(band, "pointerup", 145, 5);
      pointer(band, "pointerdown", 125, 5);
      pointer(band, "pointerup", 125, 5);
    } finally {
      spy.mockRestore();
    }
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).not.toBe("テロップ 1 の頭から再生中…");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: FAIL (`帯の段がありません`、`bar.children.length` が 2)

- [ ] **Step 3: import と状態を足す**

`src/content/youtube.ts` の

```typescript
import { createTelopPreview } from "@/content/telop-preview";
```

の**直後**に次を挿入する。

```typescript
import { createTelopTrack, type TelopTrack } from "@/content/telop-track";
```

同じファイルの

```typescript
let rangeBar: RangeBar | null = null;
```

の**直後**に次を挿入する。

```typescript
/**
 * 拡大バーの下のテロップの帯の段 (フロートの窓の spec B)。拡大バーと同じ時間の軸で描くので、
 * 拡大バーと一緒に buildBar が作り直す
 */
let telopTrack: TelopTrack | null = null;
```

- [ ] **Step 4: 拡大バーを描き直す 4 箇所を `paintRangeBar` に替える**

`src/content/youtube.ts` で、次の 4 行をそれぞれ置き換える (どれもファイルの中で 1 箇所だけ)。

`applyRange` の中:

```typescript
  rangeBar?.update(range, videoDurationSec);
```

→

```typescript
  paintRangeBar(range, videoDurationSec);
```

`applyStateToSelection` の中:

```typescript
    rangeBar?.update(segment, getVideo().duration);
```

→

```typescript
    paintRangeBar(segment, getVideo().duration);
```

`applyStateToDisplay` の終わり近く:

```typescript
      rangeBar?.update(current, getVideo().duration);
```

→

```typescript
      paintRangeBar(current, getVideo().duration);
```

`mount` の中:

```typescript
      rangeBar?.update(restored, getVideo().duration);
```

→

```typescript
      paintRangeBar(restored, getVideo().duration);
```

置き換えた後、`grep -n "rangeBar?.update(" src/content/youtube.ts` が **0 件**であることを確かめる (Step 5 で `paintRangeBar` の中に 1 件だけ戻す)。

- [ ] **Step 5: `paintRangeBar` と `refreshTelopTrack` を足し、`refreshLists` から呼ぶ**

`src/content/youtube.ts` の

```typescript
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
  refreshWindows();
}
```

を次に置き換える。

```typescript
/**
 * 拡大バーを描き直し、同じ時間の軸で帯の段も描き直す。**拡大バーの窓が変わる経路はここを通す**
 * (帯だけが古い窓のまま残らないように)
 */
function paintRangeBar(range: ClipRange, videoDurationSec: number): void {
  rangeBar?.update(range, videoDurationSec);
  refreshTelopTrack();
}

/**
 * 拡大バーの下のテロップの帯を描き直す (フロートの窓の spec B)。拡大バーを描き直したとき
 * (`paintRangeBar`) と、テロップや出す条件が変わったとき (`refreshLists`) に呼ぶ。
 *
 * 出すテロップは一覧と同じ規則 (`listedItems`: エディットモードで、範囲を作った動画を見ている
 * とき)。拡大バーがまだ窓を持たない (範囲を描く前) ときは渡さない (時間の軸が無い)。
 * 動かせる条件も一覧と同じ (`canEditTelops`)。
 *
 * **1 回の状態通知で 2 回呼ばれうる** (`applyStateToDisplay` が `refreshLists` の後に、拡大バーが
 * ずれていれば `paintRangeBar` も呼ぶ)。同じ入力なら同じ絵になる (冪等) ので、二重呼び出しは不具合ではない
 */
function refreshTelopTrack(): void {
  if (telopTrack === null) return;
  const timeWindow = rangeBar?.window() ?? null;
  const wasHidden = telopTrack.element.hidden;
  telopTrack.setEnabled(canEditTelops());
  telopTrack.update(
    timeWindow === null ? [] : listedItems().telops,
    timeWindow ?? { startSec: 0, endSec: 0 },
  );
  // 段が出る・消えるとバーの窓の高さが 34px 変わる。つまみ (操作の行) が画面の下へ押し出され
  // ないよう、置いた場所から詰め直す。**最初の位置は取り直さない** (取り直すきっかけは resize と
  // プレイヤーの大きさの変化だけ。spec A.2)
  if (wasHidden !== telopTrack.element.hidden) barWindow.refit();
}

/**
 * 一覧と帯の段を手元の写しに合わせて描き直し、パネルを出すかを決め直す。
 * 状態の通知・バーの作り直し (`mount`)・SPA 遷移の 3 箇所から呼ぶ
 */
function refreshLists(): void {
  const { segments, telops } = listedItems();
  segmentList?.setEnabled(!busy);
  segmentList?.update(segments, selectedIndex, maxClipSec);
  telopList?.setEnabled(canEditTelops());
  telopList?.update(telops, segments);
  refreshTelopTrack();
  refreshWindows();
}
```

- [ ] **Step 6: 帯のドラッグの確定を足す (`onTelopDragged`)**

`src/content/youtube.ts` の `playTelop` の終わり

```typescript
  if ((await seekAndPlay(telop.startSec)) === null) return;
  setStatus(`テロップ ${index + 1} の頭から再生中…`);
}
```

の**直後**に、空行を 1 つ挟んで次を挿入する。

```typescript
/**
 * 帯のドラッグが確定した (フロートの窓の spec B.2)。帯の段は指を離したときに 1 回だけ、時刻が
 * 変わったときだけ呼ぶ。
 *
 * **応答の状態で受理を確かめる。** 帯は動かした場所に楽観的に描かれているので、拒まれたまま
 * にすると画面と状態が食い違う。拒まれたら正の状態で描き直す (`send` の作法)。テロップは並べ
 * 替えもマージもしないので、受理されれば送った時刻がそのまま載る
 */
function onTelopDragged(index: number, startSec: number, endSec: number): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  if (telop.startSec === startSec && telop.endSec === endSec) return;
  send(
    { type: "UPDATE_TELOP", index, telop: { ...telop, startSec, endSec } },
    (state) =>
      "telops" in state &&
      state.telops[index]?.startSec === startSec &&
      state.telops[index]?.endSec === endSec,
  );
}
```

- [ ] **Step 7: `buildBar` で帯の段を作り、拡大バーの直下に置く**

`src/content/youtube.ts` の `buildBar` の中の

```typescript
  rangeBar.element.id = RANGE_ID;
```

の**直後**に次を挿入する。

```typescript

  // 拡大バーの下のテロップの帯。拡大バーと同じ時間の軸で描くので、拡大バーと一緒に作り直す。
  // ドラッグ中のシークは拡大バーと同じ onScrub、押して離したときは一覧の ▶ と同じ再生
  telopTrack = createTelopTrack({
    onScrub,
    onCommit: onTelopDragged,
    onPlay: (index) => void playTelop(index),
  });
```

同じ関数の

```typescript
  // バーは拡大バー → 操作の行だけ。拡大バーは幅がそのまま精度になるので、パネルの幅には
  // 縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の spec A.1)
  bar.append(rangeBar.element, row);
```

を次に置き換える。

```typescript
  // バーは拡大バー → テロップの帯の段 → 操作の行だけ。拡大バーは幅がそのまま精度になるので、
  // パネルの幅には縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の
  // spec A.1)。帯の段は拡大バーのトラックの**下**に置く: トラックの中に重ねると、区間のハンドルと
  // 帯の当たり判定が重なる (spec B.1)
  bar.append(rangeBar.element, telopTrack.element, row);
```

- [ ] **Step 8: `mount` で古い帯の段を捨てる**

`src/content/youtube.ts` の `mount` の中の

```typescript
  const previousBar = rangeBar;
  // buildBar が rangeBar を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();
```

を次に置き換える。

```typescript
  const previousBar = rangeBar;
  const previousTrack = telopTrack;
  // buildBar が rangeBar と telopTrack を新しいインスタンスに差し替える
  const bar = buildBar();
  previousBar?.destroy();
  // 帯の段も rAF (シークの間引き) とドラッグのリスナを抱えうる。拡大バーと同じく捨てる
  previousTrack?.destroy();
```

- [ ] **Step 9: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: PASS (既存 + 新しい 7 件。「一覧と設定はパネルに入り、…」は名前を変えて通る)

- [ ] **Step 10: 型とテスト全体を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 11: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 拡大バーの直下にテロップの帯を出し、ドラッグで時刻を送る

一覧と同じ規則 (エディットモードで範囲を作った動画) のテロップを、
拡大バーと同じ時間の軸で帯にする。拡大バーを描き直す 4 箇所を 1 つ
にまとめ、帯だけ古い窓で残らないようにする。確定は指を離したとき
の UPDATE_TELOP 1 回で、帯は楽観的に描くので応答の状態で受理を確か
め、拒まれたら正の状態へ戻す。段が出る・消えるとバーの高さが変わる
ので、置いた場所から詰め直す (最初の位置は取り直さない)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: E2E の受け入れ条件を帯の段が最大の状態にし、B.4 の確認を足す

**Files:**
- Modify: `e2e/telop-check.spec.ts` (定数 51 行目付近・受け入れ条件 865〜950 行目付近・`await writeResults();` の直前)

**Interfaces:**
- Consumes: Task 5 までの DOM (`#yt-clip-bar [data-role=telop-band]` の `data-index` / `data-lane`、`[data-role=telop-overflow]`)。service worker の `chrome.storage.session` の `router-snapshot` (`{ state: ClipState }`。`src/background/sw.ts` の `SESSION_KEY`)
- Produces: `test-results/telop-check/results.json` の項目 (Task 7 が読む):
  - 名前を変えた受け入れ条件「受け入れ条件 1440x795: 帯の段が最大 (2 段 + 「+N」) でも、バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする」(`values` に `telopBands` / `telopLanes` / `telopOverflow` を足す)
  - 新しい 3 項目「帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる」「帯の端をドラッグすると開始 / 終了だけが変わる」「帯を押して離すと、そのテロップの頭から再生する」

**実装担当は `npm run check:telop` / `npm run e2e` を走らせない** (実機の Chrome と YouTube を使う。Task 7 で controller が走らせる)。
このタスクは `npm run typecheck` (`e2e/` も型を検査する) と `npm test` までで止める。

- [ ] **Step 1: テロップの時刻の定数を足す**

`e2e/telop-check.spec.ts` の

```typescript
const LAYOUT_SEGMENT_STARTS = [200, 230, 260, 290, 320];
```

の**直後**に次を挿入する。

```typescript
/**
 * 受け入れ条件の確認で足す 5 つのテロップの頭 (フロートの窓の spec A.4 / B)。**後ろの 3 つは同じ時刻に
 * 重ねる**: 最後に足した区間 (320〜335) が拡大バーに選ばれていて、その窓 (312.5〜342.5) に 3 つが
 * 重なって入るので、帯の段が最大 (2 段 + 「+1」) になる。前の 2 つのうち 201 は帯の確認 (区間 1 を
 * 選び直して動かす) に使う。231 は区間 2 の中に置き、5 つの数を揃えるだけ
 */
const LAYOUT_TELOP_STARTS = [201, 231, 321, 321, 321];
```

- [ ] **Step 2: 受け入れ条件の名前を帯の段が最大の状態に合わせる**

`e2e/telop-check.spec.ts` の中の文字列

```
受け入れ条件 1440x795: バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする
```

を、**2 箇所とも** (`await check(` の引数と `record(` の引数) 次に置き換える。

```
受け入れ条件 1440x795: 帯の段が最大 (2 段 + 「+N」) でも、バーの窓がプレイヤーの下で画面に収まり、パネルの窓の中でスクロールする
```

置き換えた後、`grep -c "帯の段が最大 (2 段 + 「+N」) でも" e2e/telop-check.spec.ts` が 2 であることを確かめる。

- [ ] **Step 3: テロップを重ねて足す**

同じ検査の中の

```typescript
        for (const [i, startSec] of LAYOUT_SEGMENT_STARTS.entries()) {
          await seekPaused(startSec + 1);
          await panel.locator("[data-role=add-telop]").click();
          await expect(telopRows).toHaveCount(i + 1);
        }
```

を次に置き換える。

```typescript
        // 3 つを同じ時刻に重ねて、帯の段を最大 (2 段 + 「+1」) にしてから測る (spec A.4)
        for (const [i, startSec] of LAYOUT_TELOP_STARTS.entries()) {
          await seekPaused(startSec);
          await panel.locator("[data-role=add-telop]").click();
          await expect(telopRows).toHaveCount(i + 1);
        }
```

- [ ] **Step 4: 帯の段を測り、合否に入れる**

同じ検査の `page.evaluate` の戻り値の

```typescript
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
          };
```

を次に置き換える。

```typescript
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            // 帯の段 (spec B): 出ている帯の数・使っている段の数・「+N」。最大 (2 段 + 「+1」) の
            // 状態で測っていることを確かめる (段が出ていないまま通ると、B の予算を測っていない)
            telopBands: document.querySelectorAll("#yt-clip-bar [data-role=telop-band]").length,
            telopLanes: new Set(
              [
                ...document.querySelectorAll<HTMLElement>("#yt-clip-bar [data-role=telop-band]"),
              ].map((band) => band.dataset.lane),
            ).size,
            telopOverflow:
              document.querySelector("#yt-clip-bar [data-role=telop-overflow]")?.textContent ?? "",
          };
```

同じ検査の合否の

```typescript
            measured.panel.bottom <= measured.innerHeight &&
            measured.bodyScrollHeight > measured.bodyClientHeight,
```

を次に置き換える。

```typescript
            measured.panel.bottom <= measured.innerHeight &&
            measured.bodyScrollHeight > measured.bodyClientHeight &&
            measured.telopBands === 2 &&
            measured.telopLanes === 2 &&
            measured.telopOverflow === "+1",
```

- [ ] **Step 5: B.4 の 3 項目を足す**

`e2e/telop-check.spec.ts` の終わり近くの

```typescript
  await writeResults();
  const failed = Object.entries(results)
```

の `await writeResults();` の**直前**に、次を挿入する (直前の「掴む場所をダブルクリックすると…」の `check` の閉じ `});` の後、空行を 1 つ挟む)。

```typescript
  // --- 拡大バー上のテロップの帯 (フロートの窓の spec B.4) ---------------------------------
  // 窓の確認の後 (2 つの窓は最初の位置に戻っている)。受け入れ条件の確認で足した区間 5 つと
  // テロップ 5 つ (201・231・321×3) が残っている。区間 1 (200〜215) を選び直すと拡大バーの窓は
  // 192.5〜222.5 になり、テロップ 1 (201〜204) だけが帯で出る (ほかの帯と重ならない)
  type TelopTimes = { startSec: number; endSec: number; text: string };

  /** 状態機械が持つテロップ (service worker が chrome.storage.session に置く写し。sw.ts の SESSION_KEY) */
  async function readTelops(): Promise<TelopTimes[]> {
    const worker = await getWorker();
    return worker.evaluate(async () => {
      const stored = await chrome.storage.session.get("router-snapshot");
      const snapshot = stored["router-snapshot"] as
        | { state?: { telops?: { startSec: number; endSec: number; text: string }[] } }
        | undefined;
      return snapshot?.state?.telops ?? [];
    });
  }

  async function firstTelop(): Promise<TelopTimes> {
    const telop = (await readTelops())[0];
    if (telop === undefined) throw new Error("テロップ 1 がありません");
    return telop;
  }

  /**
   * テロップ 1 の時刻が before から変わるまで待って返す (10 秒で諦めて、その時点の値を返す。合否は
   * 呼び出し側の record が決める)。**dragFromTo の末尾の 500ms は窓の位置の保存 (chrome.storage.local)
   * を待つためのもの**で、帯の UPDATE_TELOP が状態機械に届いて chrome.storage.session に保存される
   * までを待つ保証にはならない。遅い環境で古い値を読まないよう、変わるまで読み直す
   */
  async function waitTelopChanged(before: TelopTimes): Promise<TelopTimes> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const now = await firstTelop();
      if (now.startSec !== before.startSec || now.endSec !== before.endSec) return now;
      if (Date.now() > deadline) return now;
      await page.waitForTimeout(200);
    }
  }

  /** m:ss (拡大バー・一覧と同じ書き方。この動画は 1 時間未満) */
  const clock = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const firstBand = bar.locator("[data-role=telop-band][data-index='0']");

  await check("帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    // 区間 1 を選ぶ。行の左の文字 (区間の時刻) を押す。右の ▶ / ✕ を押すと再生・削除になる
    await segmentRows.nth(0).locator("span").first().click();
    await expect(firstBand).toBeVisible({ timeout: 10_000 });
    // 帯のドラッグ中のシークは video.currentTime への直接の書き込み (拡大バーのハンドルと同じ onScrub)。
    // 直前の項目でページを読み込み直しているので、読み込んでいない位置へ直接飛ぶと YouTube のプレイヤーが
    // 止まりうる (seekPaused のコメント)。先にプレイヤーの seekTo で近くを読み込ませておく
    await seekPaused(201);
    const before = await firstTelop();
    const box = await boxOf(firstBand);
    const from = centerOf(box);
    // 帯の段は約 1180px で 30 秒 (約 39px/秒)。60px で 1.5 秒ほど後ろへ
    await dragFromTo(from, { x: from.x + 60, y: from.y });
    const after = await waitTelopChanged(before);
    // 一覧の行の文言も状態の通知で描き直される。変わるまで待ってから読む (待ちきれなくても合否は record で見る)
    await expect(telopRows.nth(0))
      .toContainText(`${clock(after.startSec)} 〜 ${clock(after.endSec)}`, { timeout: 10_000 })
      .catch(() => undefined);
    const label = (await telopRows.nth(0).textContent()) ?? "";
    record(
      "帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる",
      after.startSec > before.startSec + 0.5 &&
        Math.abs(after.endSec - after.startSec - (before.endSec - before.startSec)) < 0.01 &&
        label.includes(`${clock(after.startSec)} 〜 ${clock(after.endSec)}`),
      { before, after, label, box },
    );
  });

  await check("帯の端をドラッグすると開始 / 終了だけが変わる", async () => {
    const before = await firstTelop();
    // 右端。端として掴めるのは min(6px, 帯の幅の 1/3)。端から 2px の所を掴む
    const endBox = await boxOf(firstBand);
    const endAt = { x: endBox.x + endBox.width - 2, y: endBox.y + endBox.height / 2 };
    await dragFromTo(endAt, { x: endAt.x + 60, y: endAt.y });
    const afterEnd = await waitTelopChanged(before);
    // 左端
    const startBox = await boxOf(firstBand);
    const startAt = { x: startBox.x + 2, y: startBox.y + startBox.height / 2 };
    await dragFromTo(startAt, { x: startAt.x - 40, y: startAt.y });
    const afterStart = await waitTelopChanged(afterEnd);
    record(
      "帯の端をドラッグすると開始 / 終了だけが変わる",
      afterEnd.startSec === before.startSec &&
        afterEnd.endSec > before.endSec + 0.5 &&
        afterStart.endSec === afterEnd.endSec &&
        afterStart.startSec < afterEnd.startSec - 0.5,
      { before, afterEnd, afterStart, endBox, startBox },
    );
  });

  await check("帯を押して離すと、そのテロップの頭から再生する", async () => {
    const telop = await firstTelop();
    // テロップから離れた位置で止めておく (再生が始まった場所で、頭から再生したことを見分ける)
    await seekPaused(212);
    await firstBand.click();
    await page.waitForTimeout(1000);
    const played = await videoState();
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.pause(),
    );
    record(
      "帯を押して離すと、そのテロップの頭から再生する",
      !played.paused &&
        played.currentTime >= telop.startSec - 0.1 &&
        played.currentTime < telop.startSec + 3,
      { telop, ...played },
    );
  });
```

`boxOf` / `centerOf` / `dragFromTo` / `segmentRows` / `telopRows` / `bar` / `videoState` / `seekPaused` / `getWorker` / `record` / `check` は
このファイルに既にある (窓の確認と前半のヘルパ)。新しく定義する名前 (`TelopTimes` / `readTelops` / `firstTelop` / `waitTelopChanged` / `clock` / `firstBand`)
が既存の名前とぶつからないことを `grep -n "readTelops\|firstTelop\|waitTelopChanged\|const clock\|firstBand\|TelopTimes" e2e/telop-check.spec.ts` で確かめる
(このタスクで足した分だけが出る)。

- [ ] **Step 6: 型とテスト全体を通す (E2E は走らせない)**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`typecheck` は `e2e/` も検査する)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): 帯の段が最大の状態で受け入れ条件を測り、帯の操作を確かめる

帯の段を足すとバーの窓が 34px 高くなる。1440x795 でプレイヤーに
重ならないことは、段が最大 (2 段 + 「+1」) の状態で測らないと意味
が無いので、テロップを 3 つ同じ時刻に重ねて足し、段と「+N」が出て
いることも合否に入れる。帯の中・端のドラッグで状態機械の時刻と一覧
が変わること、押して離すと頭から再生することを実機で確かめる。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: 実機で確かめる (controller が実行)

**Files:**
- Modify: `docs/manual-check.md` (「## 確認した環境」)

**実行者: controller (メインセッション)。** 実機 (Google Chrome / 同梱の Chromium と YouTube) を使い、結果の画像を見て判断するため
subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜6 のすべて
- Produces: `test-results/telop-check/` の結果、`release/screenshots/` の掲載画像、`docs/manual-check.md` の記録

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる
(後に走らせると check:telop の結果が消える)。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: 通常の E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout がある)
期待: smoke の 3 件が PASS、`テロップの実機確認` は skip。smoke はシンプルモードだけを使うので、帯の段は出ない

- [ ] **Step 3: `npm run check:telop` を走らせる**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分かかりうるので Bash の timeout 600000 では足りない。テスト自身が
`test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。
20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` の項目がすべて `pass: true` で、A のときの 21 項目 (受け入れ条件の名前は
「帯の段が最大 (2 段 + 「+N」) でも、…」に変わっている) に B の 3 項目を足した 24 項目がある (数が違えば `results.json` のキーを
並べて差を確かめる)

落ちたときの見方:

- 受け入れ条件で `telopBands` / `telopLanes` / `telopOverflow` が 2 / 2 / "+1" でない → 帯の段が最後の区間の窓で描かれていない。
  `values` と画像で、選ばれている区間 (拡大バーの左右の時刻が 5:12〜5:42 か) と、テロップが 3 つとも 321 秒で足されているかを見る
- 受け入れ条件で `playerBottom > bar.top` または `bar.bottom > innerHeight` → 帯の段の分 (34px) でバーの窓が画面から溢れた。
  `values` の `bar` の高さを見て、spec の予算 (106 + 34 = 140px) を超えていないかを確かめる。超えていれば操作の行が折り返して
  いないか画像で見る
- 「帯の中をドラッグすると…」で `before` と `after` が同じ → 帯を掴めていない。`box` の座標が拡大バーの下にあるか、区間 1 を
  選べているか (拡大バーの左右の時刻が 3:12〜3:42 か) を見る
- 「帯を押して離すと…」で `paused: true` → 再生が始まっていない。広告が出ていないか、`currentTime` が 212 のままかを見る

- [ ] **Step 4: 画像を見て判定する**

Read で次を見る。

- `test-results/telop-check/layout-1440x795.png` — バーの窓の拡大バーの直下に帯の段があり、帯が 2 段 (「(未入力)」が 2 本、
  上下に並ぶ) で、右端の時刻の下に「+1」が出ている。帯の段の左右の端が拡大バーのトラックの左右の端と揃っている。
  バーの窓がプレイヤーの下端の**下**に重ならずに出て、画面に全部見えている
- 既存の画像 (`preview-*-t*.png` と `frame-*-t*.png`) が前回と同じ見た目

**1440x795 でバーの窓がプレイヤーに重なっていたら、spec の受け入れ条件が崩れている。** 直さずに spec の `## 自律判断ログ` に
`- [実機] 1440x795 で帯の段が最大のとき、バーの窓がプレイヤーに N px 重なる (playerBottom=…, bar.top=…)` と 1 行書き、最終報告で
ユーザーに伝える。

- [ ] **Step 5: 掲載画像に帯の段が写らないことを確かめる**

実行: `npm run screenshots` (Bash の timeout 600000。スクリプト側にも起動 60 秒・遷移 60 秒・待ち 30 秒の上限がある)
期待: `release/screenshots/1-range.png` と `release/screenshots/2-settings.png` が出力される

Read で 2 枚を見る。どちらもシンプルモードなので、バーの窓は拡大バーと操作の行だけで、帯の段 (と空いた 34px) が無い。
A のときと同じ見た目であること。`release/` は `.gitignore` の対象なので commit しない。

- [ ] **Step 6: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の最後の段落 (「2026-09-25 (JST) はフロートの窓 (A) を …」で始まり
「バーの窓がプレイヤーの直下に写ることを確かめた。」で終わる段落) の後に、空行を 1 つ挟んで次を足す
(`<…>` は実際の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。表の「確認日 (JST)」の範囲も、日付が変わっていれば後ろを延ばす。

```markdown
<JST の日付> は拡大バー上のテロップの帯 (B) を `npm run check:telop` で確かめた (24 項目すべて通過。1440x795 でテロップ 3 つを
同じ時刻に重ねて帯の段を最大 (2 段 + 「+1」) にした状態で、最初の位置のバーの窓がプレイヤーの下端 <playerBottom>px より下
(<bar.top>〜<bar.bottom>px) に収まる。画面は `test-results/telop-check/layout-1440x795.png`)。帯の中・端のドラッグで状態機械の
時刻と一覧が変わること、押して離すと頭から再生することも check:telop で確かめた。「テロップ」節の帯の項目のうち、窓の端を
またぐテロップ・録画中とプレビューの間に動かないこと・シンプルモードで出ないことは単体テストでだけ確かめている。
```

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (ドキュメントだけの変更だが、commit の前に通す規約に従う)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 拡大バー上のテロップの帯を実機で確かめたことを記録する

帯の段が最大 (2 段 + 「+1」) のときも 1440x795 でバーの窓がプレイヤー
に重ならずに収まり、帯のドラッグと押して離す再生が実機の YouTube で
効くことを npm run check:telop で通したことを残す。単体テストでだけ
確かめた項目も分けて書く。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

## 完了後

1. `npm run typecheck && npm test` (Bash の timeout 600000) で全テストが green であることを確認する
2. whole-branch cross-review: この plan の範囲 (A の最後の commit 82c0c20 以降) を見るため、`git -C /Users/trapple/repos/github.com/trapple/yt-clip diff 82c0c20..HEAD`
   を 1 ファイルにまとめ、新しい subagent に subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる
   (A と合わせた branch 全体 `BASE=$(git merge-base main HEAD)` の diff も添える)。指摘は直して再レビュー (手順は cross-review スキル)。
   攻撃者視点の入力例: 長さ 0.1 秒のテロップ・窓を丸ごと覆うテロップ・同じ時刻に 10 個のテロップ・ドラッグ中の録画開始・ドラッグ中の
   SPA 遷移・`UPDATE_TELOP` が拒まれる状態 (preview に切り替わった直後に指を離す)
   - subagent を派遣できない環境では、自分で spec の B の各項目と diff を突き合わせ、上の入力例を単体テストか実機で試して結果を記録する
3. branch `feat/floating-windows` 上の commit で停止。push / PR / merge はユーザーの指示を待つ

完了の条件:

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke が通る
- `npm run check:telop` の 24 項目がすべて通り、`layout-1440x795.png` で帯の段が最大 (2 段 + 「+1」) のままバーの窓がプレイヤーの
  下端より下に重ならずに収まっていることを controller が目で確かめた (Task 7)
- `release/screenshots/1-range.png` / `2-settings.png` に帯の段が写っていない (シンプルモード)
- README / CHANGELOG / docs (manual-check・store-release) に B の文言が入っている。`docs/privacy-policy.md` は変わっていない
- whole-branch の cross-review が Approved
