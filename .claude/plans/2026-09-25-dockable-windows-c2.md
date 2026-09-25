# ドック枠とタブ (spec の C2) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (SDD) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 浮いた窓 (バー / 区間・テロップ / 設定) を、ページの中の**ドック枠** 2 か所 (プレイヤーの下 = `#below` の先頭、
右の列のおすすめ動画の上 = `#secondary-inner` の先頭) へドラッグで落とすと枠に入ってページと一緒にスクロールし、
同じ枠に 2 つ以上入るとタブで切り替え、タブ (バーは ⠿) を引き出すと浮いた窓に戻るようにする。入れた枠・タブの並び・
前のタブは `windowLayout` (v2) の `docks` に覚える。**最初の配置はドック** (バー → 下の枠、区間・テロップと設定 → 右の枠。C2.6。
ユーザーが 2026-09-25 に選んだ)。ダブルクリックは最初の配置の枠へ戻す。

**Architecture:** 新しいモジュール `dock.ts` が 2 つの枠 (根・タブの列・40px の目印・窓の置き場)、入れる / 出す /
前に出す、落とし先の見せ方と当たり判定、タブからの引き出し、差し直し、退避、保存用の形を持つ。窓の中身と「出す条件」は
知らず、窓の `hidden` を見るだけ。`floating-window.ts` は `setDocked` (ページの流れの中の見た目)、`onDragPoint`
(ドラッグの指の位置を外へ知らせる)、`onUndockRequest` (ドック中の ⠿ を 8px 動かした)、`beginMoveFrom` (タブから始まった
ドラッグを窓の移動として続ける) を足す。保存データの検証 (`acceptsDock` / `parseDockState`) と最初の配置
(`INITIAL_DOCKS` / `initialWindowLayout`) は `window-layout.ts` の純粋関数。`youtube.ts` は `mount` / `placeUnmovedWindows` で枠を差し直して
使えるかを測り、`refreshWindows` の末尾で `sync`、`float` の写しと `docks` を合わせた組を保存する。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-25-dockable-windows-design.md` (以下「spec」)。**この plan は spec の「C2. ドック枠とタブ」と、
「テスト」「ドキュメント」節の C2 に関わる部分。** C1 (窓の分割) は実装・レビュー済み (branch `feat/dockable-windows`、
その後の fix を含めて HEAD 26eaebd。
`.claude/plans/2026-09-25-dockable-windows-c1.md`)。26eaebd で `fitRect` の上の下限が YouTube のヘッダーの下 (56px − 掴む場所の上端) に
なったので、この plan のテストの期待値は上端 56px 以上で測る。C1 からの持ち越し (`.claude/sdd/dock-c1/progress.md` の
「## C2 へ持ち越し」と `.claude/sdd/dock-c1/whole-branch-review.md`) は判断メモ 2・19・20・21・27 で扱う。**2026-09-25 のユーザーの決定 (最初の配置は
ドック) と plan レビュー (`.claude/sdd/dock/c2-plan-review.md`) の反映は判断メモ 29〜40、再レビュー (`.claude/sdd/dock/c2-plan-rereview.md`) の
反映は判断メモ 41〜43**。spec もドック既定に合わせて書き直してある。

## 判断メモ (spec と既存コードの食い違い・spec の曖昧な箇所。autonomous なので自分で決めた)

1. **型の名前と置き場所。** 今の `window-layout.ts` の `DockState` は 1 つの枠の中身 (`{ tabs, active? }`) の名前だが、spec C2.9 は
   `DockState` を「枠ごとの組」(`Partial<Record<DockSlotId, …>>`) の名前に使う。spec に合わせて、1 つの枠の中身を **`DockTabs`**、
   枠ごとの組を **`DockState`** にする。どちらも `window-layout.ts` に置き (保存データの検証が使う。`dock.ts` に置くと
   `window-layout.ts` → `dock.ts` → `floating-window.ts` → `window-layout.ts` と循環する)、`dock.ts` は `export type` で見せ直す。
   同じ理由で、spec が「純粋関数にしてテストする」とした `accepts` と `parseDockState` も `window-layout.ts` に置く
   (`acceptsDock(id, slot)` / `parseDockState(value)`)。`WINDOW_IDS` / `DOCK_SLOT_IDS` も export する。
2. **v2 の `float` / `docks` は「無いだけなら空」として読み、組でなければ**その部分だけ**捨てて warn する** (C1 持ち越し:
   whole-branch review Minor 1)。今は `docks` が無いだけで正しい `float` まで捨てる。spec C2.6 の「捨てるときは warn」は
   窓ごと・枠ごとに捨てる作法 (`readRects` と同じ) と読み、壊れた部分以外は使う。`version` が違う・組でないときは今のまま
   warn して最初の配置。既存テスト「v2 で float か docks が組でなければ、組ごと空にして warn する」を書き換える。
3. **同じ窓が `float` と `docks` の両方にあれば、枠に入れ、`float` の値も捨てずに残す。** spec C2.6「`docks` を採る」と
   C2.1「`float` の値は引き出したときの大きさ (C2.4) にだけ使う」を合わせて読んだ。読み込み (`loadInitialLayout`) は、
   枠に入る窓には `float` の位置を当てない (写し `floatLayout` には入れる)。ドックしたとき (`onUserMove` を呼ばない) も
   `float` は変わらない (C2.3)。
4. **`parseDockState` の細則:** 別の枠にも入っている窓は `below` → `side` の順で先を残す (spec は「`tabs` の重複は先頭を残す」
   だけ。窓は 1 つの枠にしか入れないので、枠をまたぐ重複も同じ規則で捨てる)。知らない窓・重複・入れられない組み合わせは
   1 つずつ warn して捨て、残りが無い枠は鍵ごと持たない。`active` が `tabs` に無ければ warn して無い扱い。**知らない枠の名前は
   黙って無視する** (`float` の知らない窓と同じ。後の版で枠が増えても古い版が騒がない)。
5. **最初の配置は `window-layout.ts` の `INITIAL_DOCKS` の 1 か所** (`{ below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"] } }` =
   ドック既定。spec C2.6。判断メモ 29)。`initialWindowLayout()` (C1 の `emptyWindowLayout` を改名) がこれを写すので、「何も覚えていない」
   「壊れた値・読めない版」に効き、v1 の読み替えでは位置のある窓を除いて効く (判断メモ 30)。dock.ts には `options.initial` として渡し、
   ダブルクリックの戻し先 (`restore`。判断メモ 31) にも使う。保存する組 (`currentWindowLayout`。`dock.ts` の今の状態) には効かない。
   **既定を変えたときに揃えたもの** (この plan で揃えてある): 定数と `tests/content/window-layout.test.ts` の期待 (Task 2)、
   `tests/content/youtube.test.ts` の既存の保存の期待 6 か所 (Task 7)、E2E の受け入れ条件 1440x795 と浮いた窓の確認の前提 (Task 9)、
   `scripts/screenshots.mjs` (Task 9)、README / CHANGELOG / manual-check / store-release の「最初の位置」の記述 (Task 1)
6. **前のタブの記憶 (`active`) は、そのタブの窓が隠れても書き換えない。表示だけを「見えているタブの先頭」にする。** spec C2.2 は
   見せ方だけを決めている。書き換えると、読み込み直後 (設定は閉じている) や一覧が 0 個になっただけで保存が走る (C1.3「読み込みは
   書かない」に反する)。`onChange` (保存の合図) は `dock` / `undock` / `activate` (ユーザーの操作) だけで呼ぶ。⚙ で開くと設定の
   タブを前に出す (C2.2) ので、閉じていた設定が戻ったときに後ろに隠れることは無い。そのため E2E の「読み込み直しても同じ (タブの並び
   と前のタブも)」は、読み込み直した後の**タブの並び**と、**保存された `docks`** (並びと `active`) で確かめる (設定の開閉は覚えない
   ので、読み込み直した直後の表示では設定のタブが出ない。C1 判断メモ 19)。ダブルクリックで最初の配置の枠へ戻したとき (`restore`) も
   ユーザーの操作なので、戻した窓を前に出して `onChange` を呼ぶ。
7. **`DockManager` / 作る options を spec C2.9 から足す:** `titles` (タブの文言。`FloatingWindow` は見出しの文言を外に見せない)、
   `onTabDoubleClick` (タブのダブルクリック = 最初の位置へ。C2.6)、`onEvacuate` (退避した窓を youtube.ts が最初の位置に置く。C2.1)、
   `elements` (枠の根。配色を当てる)、`load(state)` (読み込み。`onChange` を呼ばない)、`attach` は**使えるかが変わったら true** を返す
   (呼び出し側が窓を出し直す)。**タブから引き出した後のドラッグの続きは `dock.ts` が窓の `beginMoveFrom` で始める** (spec は
   「ドラッグを続けるのは呼ばれた側」)。捕捉とイベントを持っているのは `dock.ts` のタブで、youtube.ts に渡すと `onUndock` の引数が
   増えるだけなので、youtube.ts は「指の下に置く」だけを受け持つ。
8. **`beginMoveFrom(source, event, origin)` の第 3 引数はドラッグの開始点 (タブを押した点)。** spec C2.8 の `beginMoveFrom(source, event, grab)`
   の `grab` は置き方の情報で、置くのは youtube.ts (`onUndock`) なので窓の枠には要らない。代わりに、C2.3 の距離の武装の起点
   (「引き出した直後も…開始点からの距離も 8px なので」) を渡す。`onUndockRequest(point, grab)` の `grab` は**窓の左上から見た押した点**。
   型の名前は `DragPoint` (`{ x, y }`) と `DragPhase` (`"start" | "move" | "end"`)。
9. **引き出した後のドラッグは、動かさずに離しても `onUserMove` を呼ぶ。** 呼ばないと `float` に位置が入らず「動かしていない窓」に
   なり、次の resize で最初の位置へ跳ぶ。書き換えは C1.3 の 3 箇所 (の 1 つ `onUserMove`) のまま。
10. **ドック中のバーの ⠿ で引き出すと、掴む場所ごと窓を body へ移すので捕捉が外れうる。** `onUndockRequest` の後で
    `setPointerCapture` を付け直し、付け直した捕捉が生きている (`hasPointerCapture`) 間に届いた `lostpointercapture` では
    ドラッグを終えない。タブからの引き出しはタブの要素を動かさない (C2.4) ので、この問題は無い。
11. **タブの要素は窓ごとに 1 つを使い回し、`sync` のたびに作り直さない。** spec C2.9 は「タブの列は `sync()` で毎回描き直す」だが、
    押している最中 (8px 未満) に状態の通知で `sync` が走ってタブを作り直すと、捕捉が外れて押したことが消える。描き直すのは並びと
    見た目 (前のタブか) だけ。引き出したタブは `display: none` で列の末尾に残し、ほかのタブはその前へ差す (付け直すと捕捉が外れる)。
    次にその窓を入れたときは新しいタブを作る。
12. **窓ごとの箱 (`pane`) で前のタブを切り替える。** spec C2.8「前に出ているかは dock.ts が body の置き場で display を切り替える」を
    「窓の置き場の中に窓ごとの箱を置き、箱の `display` を切り替える」と読んだ。窓の要素の `display` は youtube.ts の `setVisible`
    (出す条件) が持つので、2 つの軸が同じ `style.display` を取り合わない。
13. **差す先が無いときも「使えない枠」として退避する。** spec C2.1 は「SPA 遷移の途中で要素が無い」を退避に入れ、C2.7 は「差す先
    そのものが無いなら何もしない (窓は隠れている)」と書く。動画ページ以外では 3 つの窓が隠れるので、退避しても見た目は「何もしない」と
    同じ。動画ページで 1 列表示 (`#secondary` が無い・幅 0) のときは C2.1 どおり退避で出す。規則を 1 つにする。spec の文言は直さず、
    Task 10 で spec の自律判断ログに 1 行残す (plan レビューの Recommendation)。
14. **使えるかは `attach` で測って持つ** (差す先の `getBoundingClientRect().width > 0`)。`attach` は `mount` (DOM の変化のたび) と
    `placeUnmovedWindows` (window の resize・プレイヤーの大きさの変化) で呼ぶ (C2.1「次の `mount` / `placeUnmovedWindows` で確かめる」)。
    変わったら youtube.ts が `refreshWindows` を呼び、`sync` が退避 / 枠へ戻す。
15. **退避した窓は `onEvacuate` → `placeInitial` で最初の位置に置く。** `placeInitial` は「ドック中 (使える枠) は置かない」「退避中は
    `float` に位置があっても最初の位置」「それ以外は今まで (`float` に無い窓だけ)」にする (spec C2.1 / C2.6)。退避中の窓を
    ユーザーが動かしたら (`onUserMove`)、`rememberWindowRect` が `undock` して記憶から外す (C2.1)。
16. **枠の根は最初から差す先の先頭に差しておき、中身が無ければ隠す** (`display: none`。最初の配置がドックなので、ほとんどの場合は
    中身がある)。ドラッグを始めたときに差すと、差し直しの経路が
    2 つになる。そのため既存テスト「#below には何も置かない」(youtube.test.ts) を「#below にはドック枠だけを差し、最初の配置では隠す」
    に変える。
17. **落とし先の見せ方の正は data 属性** (帯 = `data-drop-target="true"`、指が中 = `data-drop-hover="true"`)。単体テストと E2E が読む
    (jsdom は `outline` の `var()` や `color-mix()` を落としうる)。見た目は `outline: 2px dashed var(--ytc-accent)` と、塗りの 12% を
    `color-mix(in srgb,var(--ytc-accent) 12%,transparent)` で出す (Chrome 111 以降)。
18. **下の枠の上の余白の補正 `BELOW_SLOT_MARGIN_TOP_PX` を `dock.ts` に置き、今は 0。** spec C2.10「`#below` の上の余白が 27px 以下なら
    収まる。実装時に実測し、超えるなら枠の上の余白で詰める」。実測は Task 9 の E2E が記録し、Task 10 (controller) が値を決める。
19. **覚えた `docks` を読み込む単体テストは別ファイル `tests/content/youtube-dock-load.test.ts` に置く。** `youtube.ts` は import した時点で
    覚えた配置を 1 度だけ読むので、今の `youtube.test.ts` (読み込み時の配置は v1。v1 の読み替えを確かめている) では読ませられない。
    vitest はファイルごとにモジュールを読み直す。C1 持ち越し「`float.settings` を読み込みで当てる経路の単体テスト」もこのファイルで
    埋める (v2 の `float.settings` を読ませ、⚙ で開いた設定の窓がその位置に出る)。そのため、このファイルで読ませる組では設定の窓を
    枠に入れない (spec「テスト」節の「覚えた配置に `docks` があれば…一覧と設定が `#secondary-inner` に入る」のうち、設定は外す)。
    設定の開閉は覚えず読み込み直した直後は設定のタブが出ないので、単体で見られるのは「開いたら右の枠に出る」だけで、それは E2E の
    「ドック: 区間・テロップのタブを下の枠へ…」(覚えた `side: [list, settings]` を読ませてから ⚙ で開く) と「ドック: …右の枠に…読み込み
    直しても並びが同じ」で実機で確かめる。
20. **`floating-window.ts` の `headerActions` と `bodyShown` の分岐を消す** (C1 持ち越し)。ドック中の見出し・つまみ・高さの扱いは
    `setDocked` が持つ。`isOnControl` のコメント (「見出しの右側のボタン」) も、今ある「掴む場所の中のボタン (バーの操作の行)」に
    寄せる (whole-branch review の Recommendations)。
21. **最初の位置のカスケードで設定の窓が一覧を覆う件 (C1 持ち越し) は、最初の配置がドックになったので最初の画面では起きない。**
    カスケードは浮いた窓の最初の位置 (退避・`docks: {}` の組) にだけ残り、値も C1.3 のまま。README の「掴んで動かせば両方を並べて
    見られる」は、最初の配置の説明 (右の枠のタブ) に置き換える (Task 1)。
22. **CHANGELOG に「パネルの折り畳みはやめた」は書かない** (C1 判断メモ 17 と同じ。右側のパネルも未リリースで、利用者は折り畳みを
    見ていない)。ドックの段落だけを足す。
23. **⚙ と足した行の「ドック中なら」は「使える枠に入っている」の意味。** 退避中 (使えない枠の記憶だけがある) の窓は浮いた窓と同じ
    扱いにする (⚙ = 前に出す、足した行 = 窓の中を送る)。見えている形に合わせる。
24. **引き出した窓の置き方 (C2.4):** 区間・テロップ / 設定の窓は、幅 = `float` の幅か最初の位置の幅 (400px)、高さ = `float` の高さ
    (無ければ中身)、左端 = 指 − タブの中で掴んだ x (0〜幅に収める)、上端 = 指 − 見出しの高さの半分。見出しの高さは
    `panel-window.ts` に `PANEL_HEADER_HEIGHT_PX = 32` として置く (C1.3 の「見出しの行 (32px)」)。バーは幅 = `float` の幅かプレイヤーの幅、
    左上 = 指 − ⠿ の窓の中の位置。⠿ で引き出したときは押した点の窓の中の位置、タブから引き出したときは ⠿ の中心を測る。
    **`floatLayout` はここでは書き換えない** (引き出した後のドラッグの終わりの `onUserMove` が書く)。
25. **E2E の C2 の項目は帯の確認の後 (末尾) に 6 つ足す (26 → 32 項目)。** 窓の確認の前提の作り方は判断メモ 34。前の項目 (窓の確認と帯の確認) の終わり方に依存しないよう、
    各項目は `windowLayout` を書いてから読み込み直して前提を作る (C1 の実機で踏んだ)。`openSettings` / `closeSettings` は、
    窓が見えているかではなく**窓の `hidden`** で開閉を判定する (ドック中で後ろのタブにいる設定の窓は、開いているが見えない)。
    シアターモードは YouTube のショートカット `t` で切り替える (フォーカスを外してから)。「窓の位置の出所」と 1440x795 の受け入れ条件に
    `#below` / `#secondary-inner` の箱と `ytd-watch-flexy` の `theater` を足す (C2.1 の余白と C2.5 の幅の出所)。
26. **`selectors.ts` の `watchFlexy` は spec C2.9 どおり足すが、拡張は使わない** (シアターモードでも自動では動かさない。C2.1)。
    E2E はページの中で `ytd-watch-flexy` を直接読む (E2E は `src` を import していない)。doc にそう書く。
27. **whole-branch review (C1) の台帳の Minor のうち、`currentWindowLayout` の `version: 2` 直書き (Task 4 Minor 3) は Task 7 で
    `WINDOW_LAYOUT_VERSION` に直す** (組に `docks` を入れるので同じ関数を書き換える)。ほか (読み込み失敗の後の最初の保存・
    別タブの配置を `onChanged` で取り込む・別タブの設定変更で設定の窓が前に出る) は C2 の範囲外として扱わない。
28. **`docs/manual-check.md` の「パネルの折り畳みの項目を消し」は C1 で済んでいる** (今は「折り畳みのボタン (▶) は無い」の項目だけ)。
    C2 の項目を足し、シアターモードの項目の言い回しを直すだけにする。

29. **最初の配置はドック (ユーザーの決定。2026-09-25)。** `INITIAL_DOCKS = { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"] } }`。
    設定のタブは ⚙ で開いている間、区間・テロップのタブはエディットモードで区間がある間だけ出る (隠れた窓のタブは出さない。C2.2)。
    シンプルモードで設定を閉じていれば、右の枠は隠れ、下の枠にバーだけが入る。spec C2.6 / C2.10 / テスト / ドキュメント /
    検討した選択肢 / 自律判断ログを先に書き直した。
30. **v1 の読み替え: 位置を覚えていた窓は浮いた窓のまま、位置の無い窓は最初の配置の枠へ** (`INITIAL_DOCKS` から `float` にある窓を
    除いたもの)。A で自分で動かした窓を黙ってドックへ移さない。A・C1 は未リリースなので、効くのは開発中に動かした配置だけ。
    **v2 の組は書いてあるとおりに読む** (`docks: {}` なら 3 つとも浮いた窓。C1 が書いた組もこれ)。v2 で `docks` の鍵が無いだけのとき
    (手で書き換えた値) は判断メモ 2 のまま空として読み、最初の配置は当てない (書いた人が枠を消したのか分からない値に既定を足さない)。
31. **ダブルクリックの戻し先は最初の配置の枠** (spec C2.6 を書き直した)。dock.ts に `restore(id)` を足す: 最初の配置で入る枠へ、
    最初の配置の並びの位置 (区間・テロップ → 設定) に入れ、前に出して `onChange`。最初の配置で枠に入らない窓なら `undock`。
    戻す先の枠が使えなければ、その枠の記憶に入れたまま退避 (`onEvacuate` → 浮いた窓の最初の位置)。末尾に付ける `dock` を使わない
    のは、戻すたびに並びが変わると保存の中身が操作の履歴で揺れるため。youtube.ts の `resetWindow` は `float` を消してから
    `restore` → `placeInitial` を呼ぶ (保存は `restore` の `onChange` が行う)。
32. **jsdom の単体テストでは、差す先の幅が 0 なので最初の配置の枠は使えず、3 つの窓は退避 (浮いた窓の最初の位置) で出る。**
    そのため C1 から続く浮いた窓の検査 (位置・ドラッグ・取り直し) は見た目の期待がそのまま通り、変わるのは保存の組の `docks`
    だけ (Task 7 で 6 か所を直す)。ドックの検査は `describe("ドック枠とタブ")` の中で差す先に幅を持たせてから行う。
33. **26eaebd の `fitRect` (上端は 56px − 掴む場所の上端より上へ詰めない) に合わせて、テストの期待を 56px 以上で測る** (plan レビューの
    Issues 2 件)。Task 3 は `top: 60`。Task 7 の ⠿ の引き出しは、stub で枠の中のバーの窓を (0, 600) に置き、引き出した窓が 600 から
    動く形にする (レビューの案 b。詰められない位置で測るので、期待が詰め方に左右されない)。
34. **E2E の浮いた窓の確認 (C1 の 6 項目) は、`windowLayout` を `{ version: 2, float: {}, docks: {} }` にして読み込み直してから行う**
    (浮いた窓の最初の位置から始める)。「掴む場所をダブルクリックすると…」は「最初の配置の枠へ戻り、覚えた位置も消える」に変える。
    受け入れ条件 1440x795 は、覚えた配置を消して読み込み直し、最初の配置 (下の枠のバー・右の枠のタブ) で測る (spec C2.10)。C1 の
    「設定の窓の中でスクロールする」(`settingsScrollHeight > settingsClientHeight`) は、ドック中の窓は中身なりの高さなので外す。
35. **`scripts/screenshots.mjs` を直す** (spec「テスト」節を書き直した): `#secondary` ごと隠す CSS をやめ、おすすめ動画の中身とチャットだけを
    隠して右の列を残す (右の枠を使える枠にする)。2 枚ともページの先頭で撮り、2-settings.png は右の枠で前に出た設定のタブを写す。
    プレイヤーの幅を空ける CSS と、浮いた設定の窓の中を送る処理は消す。書くのは Task 9、撮るのは Task 10 (controller)。
36. **`renderTabs` は差分だけを動かす** (plan レビューの Recommendation): 要らなくなったタブだけを外し、並びの違うタブだけを差し直す。
    押している最中 (8px 未満) に別のタブが消えても、押しているタブは付け直さない (判断メモ 11 の意図)。
37. **枠の根の余白は dock.ts が描くたびに当てる** (plan レビューの Recommendation): 窓が見えている間だけ下の余白 12px
    (`DOCK_SLOT_GAP_PX`) と、下の枠の上の余白の補正 (`BELOW_SLOT_MARGIN_TOP_PX`) を当て、目印だけの間 (ドラッグ中の空の枠) は 0。
    spec C2.3 の「下の内容が 40px 下がる」を守る。`DOCK_STYLE.root` は margin を持たない。
38. **`tests/content/youtube-dock-load.test.ts` は canvas の `getContext` を stub しない。** 流す状態 (`READY`) はテロップが空で、
    プレビューは描かない。テロップを流す検査を足すときは youtube.test.ts の `spyOnGetContext` と同じ扱いにする、とファイルの
    コメントに書く (plan レビューの Recommendation)。
39. **E2E の「浮かせたバーを下の枠に落とす」の迂回はプレイヤーの中 (上方向)** (plan レビューの Recommendation): 下の枠の目印は
    `#below` の幅いっぱいなので、横へ動かすだけでは帯を出られない位置から始まることがある。プレイヤーの中はどの帯の外。
40. **HEAD の表記と「完了後」の diff の基点は 26eaebd** (plan レビューの Recommendation。fitRect の fix を C2 のレビューに混ぜない)。

41. **Task 3 の `setDocked` は見た目を置き換えるとき配色の変数 (`--ytc-*`) を残す** (plan の再レビューの Issue)。`applyPalette` は窓の
    要素の inline の custom property に配色を書くので、cssText を丸ごと置き換えると引き出した・退避した浮いた窓の地と縁が消える。
    `replaceStyle` が `--` で始まる inline のプロパティを拾って戻す。styles.ts の `FLOATING_WINDOW_STYLE.docked` / `root` は文字列のまま
    (styles.test の検査を変えない)。同じ置き換えは dock.ts (タブの `cssText`。配色はタブではなく枠の根に当てる) と panel-window.ts
    (作った直後の本体の `cssText`。配色を当てる前) にもあるが、どちらも配色の変数を持たない要素なので直さない
42. **再レビューの Recommendations のうち、`mount` のたびに差す先を測る件は取り込まない。** spec C2.1「次の `mount` で確かめる」どおりで、
    測るのは差す先 2 つだけ。実機で重さが見えたら、差す先が替わった・`contains` が外れたときだけ測るか、`ResizeObserver` に寄せる。
    ほか (E2E の関数名 `isSettingsOpen`、`DOCK_PULL_OUT` はタブの列へ落とす、Task 7 の Interfaces の名前、読み込みのテストのチャンネル、
    `placeRows` の前提のコメント、spec の manual-check の文言、Task 2 の数と行番号) は取り込んだ
43. **commit の step はすべてファイルを名指しで `git add` する** (`git add -A` / `git add .` を使わない)。作業ツリーには別のセッションの
    untracked のファイル (`.claude/specs/2026-09-25-master-switch-design.md`) があり、巻き込まないため

## Global Constraints

### Spec 由来 (spec から逐語コピー)

C2 と「テスト」「ドキュメント」節 (spec 135〜455 行目。2026-09-25 にドック既定へ書き直した版。見出しの行は太字に直した。
C1 の項目は C1 で済んでいる。C2 の項目がこの plan の対象):

**C2.1 ドック枠の場所**

```
+---------------------------------+  +---------------------+
|                                 |  | [区間・テロップ][設定] | ← 右の枠 (side): タブの列
|             動画                |  |  1. 0:10 …          |
|                                 |  |  2. 1:20 …          |
+---------------------------------+  |  テロップ …          |
| |=====[──────────]=====|        |  +---------------------+
| ⠿ [＋区間][IN][OUT] ●録画 状態 ⚙ |  | おすすめ動画          |
+---------------------------------+  |  …                  |
| 動画のタイトル …                  |  |                     |
```
(最初の配置 (C2.6) の例: バーは下の枠、区間・テロップと設定は右の枠。設定のタブは ⚙ で開いている間だけ出る)

| 枠 | id | 差す先 (YouTube の要素) | 幅 | 高さ |
|---|---|---|---|---|
| 下の枠 | `below` | `#below` の**先頭** (`prepend`。`ytd-watch-metadata` の上) | `#below` の幅 (= 通常はプレイヤーの幅。シアターモードでは `#primary` の幅) | 中身なり |
| 右の枠 | `side` | `#secondary-inner` の**先頭** (無ければ `#secondary`)。おすすめ動画 (`#related`) とチャット (`#chat`) の上 | 右の列の幅 (1920x1080 で `#secondary` は 544px の実測。1440 では 400px 前後) | 中身なり |

- 枠は yt-clip の `div` (`#yt-clip-dock-below` / `#yt-clip-dock-side`)。中は**タブの列**と**窓の置き場**の 2 段。
  `position: static` でページの流れの中にあり、**ページと一緒にスクロールする**
- **`#below` に差す理由**: 右側パネル化の前にバーがあった場所で、YouTube の再描画で外れたときの差し直しも `mount()` で
  実績がある。A.3 の「`#below` にはもう何も置かない」は「フロートの窓の中身をそこに置かない」の意味で、
  ドック枠は置く。`mount()` の「動画ページのページができたか」の目印としては引き続き `#below` を見る
- **`#secondary-inner` に差す理由**: 右の列の先頭。`#secondary` 直下だと YouTube が `#secondary-inner` を
  作り直したときに枠が列の外に残りうる。**セレクタは `selectors.ts` に足す** (`dockBelow: "#below"`、
  `dockSide: ["#secondary-inner", "#secondary"]`、`watchFlexy: "ytd-watch-flexy"`)。**実装時に DevTools で確かめ、
  枠の余白 (`#below` の上の余白など) の実測値を `dock.ts` のコメントに書く** (右側パネルと同じ作法)
- **シアターモード** (`ytd-watch-flexy[theater]`): プレイヤーが幅いっぱいに上へ出て、`#primary` (`#below`) と
  `#secondary` はその**下**に左右に並ぶ。下の枠はそのままプレイヤーの直下 (幅が広がる)。**右の枠は右の列に付いて
  動画の下へ回る**。自動ではフロートに戻さない (右側パネルの「自動では畳まない」と同じ理由: YouTube のレイアウト依存の
  判定で窓が勝手に跳ぶ)。動画を見ながら一覧を触りたいならタブを引き出す。README の制約に書く
- **枠が使えないとき** (1 列表示で `#secondary` が消えている・幅 0・SPA 遷移の途中で要素が無い): その枠に入っている窓は
  **退避フロート**で出す: 最初の位置 (A.2 / C1.3) にフロートで出し、ドックの記憶 (`docks`) は消さない。**`float` に位置が
  残っていても (ドックする前に動かした窓) 退避には使わず**、最初の位置に出す。resize / プレイヤーの大きさの変化での
  取り直し (C2.6) も効く。`float` の値は引き出したときの大きさ (C2.4) にだけ使う。枠が戻れば (次の `mount` /
  `placeUnmovedWindows` で確かめる) 枠に戻す。退避中に窓を動かしたら、その時点でフロートになる (記憶からも外れる)。
  隠す案は採らない: 狭い画面で設定が開けなくなる

**C2.2 タブ**

- 枠の上の段に、入っている窓の見出しを**タブの列**として並べる (窓の `title`。バーは「バー」)。
  **前に出しているタブの窓だけ**を置き場に出し、ほかの窓は隠す (`display: none`。DOM には残す。設定の入力欄の値や
  一覧のスクロール位置を失わない)
- タブを押すと前に出る。前のタブは色 (`--ytc-text`、下線 `--ytc-accent` 2px)、ほかは `--ytc-text-sub`。高さ 28px
- **枠の中の窓が 1 つで、それがバーの窓のときだけ、タブの列を出さない。** バーは ⠿ で掴めるうえ、1440x795 の高さの予算
  (C2.10) にタブの列 (28px) が入らない。区間・テロップの窓や設定の窓が 1 つで入っているときはタブの列を出す
  (フロートのときの見出しの代わり。掴む場所が要る)
- **並びは入れた順** (落とした順に末尾へ)。並べ替えは、いったん引き出して落とし直す (末尾に付く)。窓は最大 3 つで、
  タブの列の中でのドラッグ並べ替えは作らない
- 隠れている窓 (C1.2 の条件を満たさない。設定を閉じている・区間が 0 個) のタブは出さない。前に出していたタブが隠れたら、
  残りの見えているタブの先頭を前に出す。**見えているタブが 1 つも無い枠は枠ごと隠す** (`display: none`。空のタブの列で
  おすすめ動画を押し下げない)
- 設定を ⚙ で開いたとき、設定の窓がドック中なら**そのタブを前に出す** (C1.2 の「前に出す」のドック版)。区間・テロップを
  足したときも同じ (タブを前に出す。ドック中の窓は中身なりの高さで中でスクロールしないので、`scrollTo` はフロートのときだけ。
  **ページはスクロールしない**: 右側パネルの spec §3 と同じ理由)

**C2.3 落とす (ドラッグ中の当たり判定と見せ方)**

- フロートの窓を掴む場所 (見出し / ⠿) でドラッグしている間、**その窓が入れる枠** (C2.5) に**落とし先の帯**を見せる。
  帯は枠の**上の段だけ**:
  - 枠にタブの列が出ているなら、タブの列 (28px) がそのまま帯。縁を点線 (`outline: 2px dashed var(--ytc-accent)`) にする
  - 枠が隠れている (中身が無い) か、タブの列が無い (バーだけの枠) なら、枠の先頭に高さ 40px の点線の箱を出す
    (文言「ここにドック」)。ページの流れの中に出るので、下の内容が一瞬 40px 下がる。上に重ねる案 (`position: fixed` の
    目印) は採らない: 目印がスクロールに付いてこず、落ちる場所と目印がずれる
- **当たり判定は指 (`clientX` / `clientY`) が帯の箱 (`getBoundingClientRect`) の中にあるか。枠の中身 (置き場) の上は
  当たらない** (Unity もタブの列が落とし先)。枠の箱全体にすると、設定が右の枠に入っている状態で一覧のフロートを右上に
  置く場所が無くなる (箱が中身の高さまで広がる)。`elementFromPoint` は使わない (掴んでいる窓が指の下にあり、帯が取れない)。
  指が中にある帯は塗りを付ける (`background: var(--ytc-accent)` の 12%)
- **落とし先が当たるのは、次の 2 つを両方満たしたときだけ**:
  1. **指がドラッグの開始点から 40px 以上離れている** (距離の武装。40px は目印の高さと同じ。値は可逆)。
     開始点から 40px 未満では、指が帯の中にあっても当てない (帯の見せ方は最初から出してよい。当てないだけ)
  2. **その帯に、ドラッグを始めた後で外から入った** (入って初めて当たる)。始めたときに既に帯の中にあった枠は、一度その帯の
     外へ出るまで当てない
  - 2 つとも要る理由: フロートの最初の位置は帯と**ずれて**重なる。区間・テロップの窓の見出し (上 68px〜) と右の枠の帯
    (`#secondary-inner` の先頭。ヘッダーの下 80px 前後〜)、バーの ⠿ (プレイヤーの下端 + 8px〜) と下の枠の帯 (`#below` の先頭)。
    2 だけだと、見出しの上寄り (68〜80px) を掴んだ指は「帯の外から始まる」ので、20px 下へ動かすと帯に入って吸い込まれる
    (掴む y 座標次第で通ったり落ちたりする)。1 だけだと、⠿ を掴んで横へ 50px 動かした指が帯の中に居続けて吸い込まれる
    (帯は `#below` の幅いっぱい)。両方で「少し動かす」は掴む位置に依らずフロートのままになり、100px 引いて帯に入れれば入る
  - **隠れている枠の 40px の目印は `drag("start")` でページの流れへ差した後に測る**: `drag("start")` = 目印を出す → 各帯の
    `getBoundingClientRect` を測る → 指が中にある帯は「出るまで待ち」にする。差す前に測ると目印の分だけ下の帯の位置がずれる
  - 引き出した直後 (C2.4) も指は元の枠の帯の中にあり、開始点からの距離も 8px なので、同じ枠へ戻すには一度帯を出て
    40px 以上離れてから入り直す
- 指を離したとき、指が帯の中なら**その枠の末尾にドックして前に出す**。帯の外なら今までどおりフロートの位置を覚える。
  ドックしたときは `onUserMove` を呼ばない (フロートの位置は変えない)
- 落とし先はページの中にあるので、**画面に見えている枠にしか落とせない** (ドラッグ中にページを自動でスクロールしない。
  コメント欄まで送った状態で下の枠へ入れたいときは、先に上へ戻す)。README に書く
- 落とし先を見せるのはドラッグ中だけ。押して動かさずに離した (クリック) ときは見せない

**C2.4 引き出す (フロートに戻す)**

- **タブを掴んで 8px 以上動かす**と、その窓が枠から出てフロートになり、指の下に付いて動き続ける。8px 未満で離したら
  タブを押した扱い (前に出す)。8px は帯の「押して離した」の 4px より大きくし、タブを押すつもりの指の震えで抜けないようにする
- 引き出した窓の位置 (**区間・テロップ / 設定の窓**。バーは次の項): **掴んだタブの位置関係を保つ**。窓の左端 = 指の x −
  タブの中で掴んだ x (窓の幅に収める)、上端 = 指の y − 見出しの高さの半分 (指が見出しの中に来る)。幅と高さは `float` に
  覚えている値、無ければ最初の位置の大きさ (幅 400px・高さは中身)
- **ドック中のバーは ⠿ でも引き出せる** (⠿ を 8px 以上動かす)。バーだけの枠にはタブの列が無いので、これが唯一の掴む場所。
  引き出した位置は ⠿ が指の下に残るように (窓の左上 = 指 − ⠿ の窓の中の位置。バーには見出しが無いので、タブから
  引き出したときも同じ)。幅は `float` に覚えている値、無ければプレイヤーの幅
- 引き出した直後からドラッグは続き、C2.3 の当たり判定が効く (別の枠へそのまま落とせる。同じ枠へ戻すこともできる)
- **引き出した時点で、元の枠は残りの窓ですぐ描き直す** (残りが 0 なら枠を隠し、ドラッグ中なので 40px の目印に変わる。
  残りがバーだけならタブの列を消して目印を出す。残りが 1 つ以上ならタブの列が帯)。当たり判定 (C2.3) は描き直した後の
  帯で測る。**外さないのは掴んだタブの要素だけ** (`display: none` にして DOM に残す): Pointer Events の捕捉はタブの
  要素に付いており、外すと `lostpointercapture` でドラッグが終わる。指を離したら捨てる

**C2.5 どの窓がどの枠に入れるか**

| 窓 | 下の枠 | 右の枠 |
|---|---|---|
| バー | ○ | **×** |
| 区間・テロップ | ○ | ○ |
| 設定 | ○ | ○ |

- **バーは右の枠に入れない。** バーの最小幅は 480px (A.1。拡大バーの精度) で、右の列の幅より広い。入れると拡大バーが
  最小幅より狭くなるか、列からはみ出す。バーをドラッグしている間、右の枠に落とし先を見せない。
  **右の列の幅の実測は 1920x1080 の 544px だけ** (side-panel.ts)。1440x795 の値は未実測で、パネルの幅 400px が
  プレイヤーに重ならなかった (プレイヤーの右端 1012px < 1024px) ことから 400px 前後と見ている。**実装時に 1440x795 で
  `#secondary-inner` の幅を実測し、480px 未満であることを確かめてここに書き戻す** (480px 以上なら、この行の根拠は
  「拡大バーはプレイヤーの幅で使うもの」だけになる)
- 下の枠にバーと一緒に区間・テロップや設定を入れると、タブの列 (28px) が足されて、1440x795 の予算 (C2.10) を超える。
  **ユーザーの選択なので止めない** (ページの中なのでスクロールすれば届く。フロートのときのようにプレイヤーを覆うことはない)。
  README に「バーだけを下の枠に入れたときは収まる」と書く
- 入れられない組み合わせを `dock()` に渡したら `throw` (配線の誤り。Fail Fast)。保存データにその組み合わせがあれば
  `console.warn` して捨てる (C2.6)

**C2.6 最初の配置と覚えるもの**

- **最初の配置 (初回) はドック**: バーは下の枠、区間・テロップの窓と設定の窓は右の枠 (タブの並びは区間・テロップ → 設定)。
  設定のタブは ⚙ で開いている間だけ出る (C2.2 の「隠れている窓のタブは出さない」)、区間・テロップのタブはエディットモードで
  区間がある間だけ出る。シンプルモードで設定を閉じていれば、右の枠は隠れ、下の枠にバーだけが入る。
  **ユーザーが 2026-09-25 にドック既定を選んだ** (「検討した選択肢」)。浮いた窓は、引き出した人・引き出した窓だけになる。
  - 最初の配置は `window-layout.ts` の 1 か所 (`INITIAL_DOCKS`) に置く。枠が使えない間 (1 列表示など) は退避 (C2.1) で浮いた窓の
    最初の位置 (A.2 / C1.3) に出る
- **覚えるもの**: C1.3 の v2 の形をそのまま使う。`docks` に窓があればドック、`float` にあればフロート (v2 で `docks` に無い窓は
  浮いた窓。`float` にも無ければ浮いた窓の最初の位置)。読むときの検証: `tabs` の重複は先頭を残す・知らない id は捨てる・入れられない
  組み合わせ (`side` の `bar`) は捨てる・`active` が `tabs` に無ければ無い扱い・同じ窓が `float` と `docks` の両方にあれば
  `docks` を採る (`float` の値は引き出したときの大きさに残す)。捨てるときは `console.warn`。**覚えた配置が無い・読めない・版が違う**
  ときは最初の配置 (ドック)
- **v1 の読み替え** (C1.3): `bar` が有れば `float.bar`、`panel` が有れば `float.list`。**v1 で位置を覚えていた窓は浮いた窓のまま**
  (A で自分で動かした窓を黙ってドックへ移さない)、位置の無い窓 (`settings` と、v1 に無い窓) は最初の配置 (ドック)
- **覚えた配置の読み込みが済むまで、枠も窓も出さない** (A.2 と同じ理由。フロートで出してから枠へ跳ぶ絵にしない。
  枠に入ると下の内容が動くので、跳びはフロート同士より目立つ)
- **ダブルクリックで戻す先 = その窓の最初の配置 (最初の配置の枠)**。掴む場所 (見出し / ⠿ / タブ) のダブルクリック。
  浮いた窓も、別の枠に入れた窓も、最初の配置の枠へ入れ直し (並びは最初の配置の順: 区間・テロップ → 設定)、そのタブを前に出す。
  `float` の覚えた位置も消す。最初の配置の枠が使えない間は退避 (浮いた窓の最初の位置) に出る。ドックした人も引き出した人も、
  「元に戻す」は A と同じ操作で最初の配置に戻る
- フロートの窓の「一度も動かしていない窓は resize / プレイヤーの大きさの変化で最初の位置を取り直す」(A.2) は、
  `float` に無い浮いた窓と、退避中の窓 (`float` に位置があっても最初の位置に出す。C2.1) に効く。
  ドック中の窓には効かない (ページの流れが決める)

**C2.7 いつ隠すか・差し直し**

- 全画面・動画ページ以外・覚えた配置の読み込み前は、**フロートもドックも全部隠す** (A.1 の規則を 3 つの窓と 2 つの枠へ広げる。
  全画面ではページが見えないので触らなくてもよいが、規則を 1 つにする)
- **差し直し**: `mount()` (DOM 変化のたびに呼ばれる) で、2 つの枠が差す先の中にあるか (`anchor.contains(slot)`) を確かめ、
  無ければ先頭に差し直す。YouTube が `#below` / `#secondary-inner` の子を作り直しても、枠は中の窓ごとメモリに残っている
  (`replaceChildren` で外されるだけ)。**差す先そのものが無い** (動画ページ以外・SPA 遷移の途中) なら何もしない
  (窓は隠れている)。差す先はあるが幅 0 なら C2.1 の退避
- SPA で別の動画へ移ったら、今の `observer` の href の分岐で一覧を描き直すのと同じ場所で、枠の出し入れ (`sync`) も呼ぶ
  (区間が 0 個になれば区間・テロップのタブが消え、右の枠が隠れる)
- ドラッグの最中に差し直しが起きても (YouTube の再描画)、掴んでいるのはフロートの窓 (body 直下) かタブ (C2.4 で外さない)
  なので、捕捉は切れない。落とし先の帯は差し直しのあとの位置で測り直す (当たり判定は毎 `pointermove` で
  `getBoundingClientRect` を取る)

**C2.8 窓の枠 (`floating-window.ts`) をドック中どう扱うか**

- `setDocked(true)`: 枠の要素の見た目を**インライン用**に切り替える: `position: static`、`left / top / width / height /
  max-height` を外し `width: 100%`、`z-index: auto`、`box-shadow: none`、角丸 8px。見出しの行を隠す (文言はタブが持つ)。
  右下のつまみを隠す (大きさは枠が決める)。`window` の `resize` での詰め直しをしない。`place` / `refit` は無視する
  (呼ばれても位置を当てない。**ただし `requested` は覚える**: 引き出したときの幅と高さに使う)。`rect()` は `requested` を返す
- `setDocked(false)`: 元の見た目 (`FLOATING_WINDOW_STYLE.root` + `z-index`) に戻し、`requested` から詰めて置く
- ドック中の掴む場所 (⠿) の `pointerdown` は、8px 動くまで窓を動かさず、8px 動いたら `onUndockRequest(point, grab)` を
  呼ぶ (C2.4)。呼ばれた側 (dock.ts) が窓を枠から出して `setDocked(false)` → 指の下に `place` する。その後は今の移動の
  ドラッグ (`beginDrag` の `move`) に続く。`start` は引き出した後の `current` で取り直す
- タブ (枠の外の要素) から始まったドラッグを窓の移動として続ける口 `beginMoveFrom(source, event, grab)` を足す。
  `beginDrag` は既に `source` を引数に取っているので、捕捉と listener の付け先を `source` にするだけ
- ドラッグの最中と終わりを外へ知らせる `onDragPoint(phase, point)` を足す (C2.3 の当たり判定は dock.ts が持つ。窓の枠は
  枠を知らない)。`end` で `true` が返ったら (dock.ts が窓を引き取った) `onUserMove` を呼ばない
- ドック中に `bringToFront` は効かない (`z-index: auto` のまま)。ドック中の窓を押しても、ほかのフロートの窓の順は変えない
- **ドック中は `hidden` / `display` の出し入れを dock.ts が行う** (タブの切り替え)。`setVisible` (youtube.ts の
  「出す条件」) とタブの切り替えは別の軸: 出す条件を満たさない窓はタブごと消え、満たしていて前に出ていない窓は
  タブだけ出る。実装では `setVisible(false)` → タブ無し、`setVisible(true)` → タブ有り、前に出ているかは dock.ts が
  `body` の置き場で `display` を切り替える

**C2.9 作り**

- 新しいモジュール `src/content/dock.ts`: 2 つの枠 (箱・タブの列・置き場)、入れる/出す/前に出す、落とし先の見せ方と
  当たり判定、引き出し、差し直し、保存用の形を持つ。**窓の中身と、出す条件は知らない**
  ```typescript
  export type DockSlotId = "below" | "side";
  export type DockState = Partial<Record<DockSlotId, { tabs: WindowId[]; active?: WindowId }>>;
  export type DockManager = {
    /** 枠を差す先に付け直す (mount ごと)。差す先が無い・幅 0 の枠は使えない (isUsable が false。中の窓は退避) */
    attach(anchors: Record<DockSlotId, Element | null>): void;
    isUsable(slot: DockSlotId): boolean;
    /** 入れられない組み合わせは throw */
    dock(id: WindowId, slot: DockSlotId): void;
    undock(id: WindowId): void;
    activate(id: WindowId): void;
    slotOf(id: WindowId): DockSlotId | null;
    /** 窓の出す条件が変わった後に呼ぶ。タブと枠の出し入れを合わせる */
    sync(): void;
    /** ドラッグ中の落とし先の見せ方と当たり判定。end で入れた枠を返す (入れなければ null) */
    drag(id: WindowId, phase: "start" | "move" | "end", point: { x: number; y: number }): DockSlotId | null;
    state(): DockState;
    destroy(): void;
  };
  export function createDockManager(options: {
    windows: Record<WindowId, FloatingWindow>;
    accepts(id: WindowId, slot: DockSlotId): boolean;
    /** タブを掴んで 8px 動いた。引き出した窓を指の下に置き、ドラッグを続けるのは呼ばれた側 */
    onUndock(id: WindowId, point: { x: number; y: number }, grab: { x: number; y: number }): void;
    /** 入れた・出した・前に出した (保存の合図) */
    onChange(state: DockState): void;
  }): DockManager;
  ```
- `accepts` と保存データの検証 (`parseDockState`) は純粋関数にしてテストする。タブの列は `sync()` で毎回描き直す
  (引き出し中を除く。C2.4)
- `youtube.ts`: `mount()` で `dockManager.attach({ below: #below, side: #secondary-inner ?? #secondary })`。`refreshWindows` の
  末尾で `dockManager.sync()`。`placeUnmovedWindows` で退避の判定 (使えない枠の窓を退避フロートへ、戻った枠へ戻す)。
  `onToggleSettings` と足した行の表示は「ドック中ならタブを前に出す、フロートなら前に出す + `scrollTo`」。
  `windowLayout` の保存は `float` (窓の `onUserMove`) と `docks` (`onChange`) を合わせた組を書く
- `selectors.ts` に `dockBelow` / `dockSide` / `watchFlexy` を足す (C2.1)
- `styles.ts` に `DOCK_STYLE` (枠・タブの列・タブ・前のタブ・落とし先の目印・帯の縁・塗り) と `FLOATING_WINDOW_STYLE.docked`
  を足す。枠の地は `--ytc-panel`、配色は `applyPalette` を枠にも当てる (body 直下でなくても YouTube の CSS 変数は
  解決しない方針のまま)

**C2.10 受け入れ条件**

- **最初の配置 (覚えた配置が無い) で 1440x795 に収まる**: エディットモードで区間 5 つ・テロップ 5 つ (うち 3 つは同じ時刻に
  重ねて帯の段を 2 段 + 「+N」に)・設定を開いた状態で、バーの窓が下の枠 (`#below` の先頭) に入り、ページの先頭 (`scrollY = 0`) で
  **下の枠の外形**が `playerBottom ≤ slot.top` かつ `slot.bottom ≤ innerHeight` (フロートの A.4 と同じ式。バーだけの枠なので
  タブの列は無い)。予算: 795 − 628 (プレイヤーの下端の実測) = 167px。バーの窓 (帯の段まで) は約 140px なので、`#below` の上の
  余白が 27px 以下なら収まる。**実装時に実測し、超えるなら枠の上の余白で詰める** (YouTube の余白は枠の `margin-top` を負にして
  相殺できる)。区間・テロップの窓と設定の窓は右の枠 (`#secondary-inner` の先頭) にタブで入り (区間・テロップ → 設定、⚙ で開いた
  設定が前)、`slot.left ≥ playerRight`・`slot.top ≥ mastheadBottom`。**バー以外を下の枠に入れたときの予算は保証しない**
  (C2.5。E2E でも測らない)
- **浮いた窓を少し動かしてもドックされない** (覚えた配置が `docks: {}` で 3 つとも浮いた窓の最初の位置にあるとき。1440x795):
  区間・テロップの窓の見出しを 20px 下へ動かして離してもドックされない (C2.3 の距離の武装 40px。見出しのどこを掴んでも
  成り立つ。E2E では見出しの上端から 4px の点を掴む = 帯の外から始まる最も吸い込まれやすい経路で測る)。バーの ⠿ を 20px 右へ
  動かして離してもドックされない
- **浮かせたバーを下の枠に落としたとき** (⠿ をプレイヤーの直下の帯 = `#below` の先頭の目印へ。指を一度帯の外 (プレイヤーの上) へ
  出してから入れる): バーの窓が下の枠の中 (`#below` の子孫) に入り、最初の配置と同じく画面に収まる。読み込み直しても下の枠に
  入ったまま。⠿ で引き出して浮かせてからダブルクリックすると下の枠 (最初の配置) に戻る
- **浮いた区間・テロップの窓と設定の窓を右の枠に落としたとき** (覚えた配置が `docks: {}`。見出しを `#secondary-inner` の先頭の
  帯へ。設定は ⚙ で開いてから):
  右の枠が `#secondary-inner` の先頭にあり、`slot.left ≥ playerRight` (プレイヤーに重ならない)、`slot.top ≥ mastheadBottom`。
  タブが 2 つ (区間・テロップ / 設定) で、後から落とした方が前。⚙ を押して閉じ、もう一度押すと設定のタブが前に出る。
  区間・テロップのタブを押すと一覧が出て設定が隠れる。読み込み直しても同じ (タブの並びと前のタブも)
- 最初の配置から、区間・テロップのタブを下の枠 (バーの上の目印) へドラッグして落とすと、下の枠にタブが 2 つ (バー / 区間・テロップ)
  出て、右の枠は設定だけになる。タブを押すと切り替わる
- 最初の配置から、タブを枠の外 (プレイヤーの上) へ引き出して離すとフロートになる。浮いた窓の見出しをダブルクリックすると
  右の枠 (最初の配置) に戻り、引き出してから右の枠のタブの列へ落としても戻る
- 右の枠に入れたまま `t` でシアターモードにすると、右の枠が動画の下 (`slot.top ≥ playerBottom`) にそのままドックされている。
  戻すと元の位置

**テスト**

- `dock.ts` の単体 (jsdom): `accepts` (バーは `side` に入れない) / `dock` で枠の置き場に入り `setDocked(true)` / 2 つ入れると
  タブの列、前のタブの窓だけ `display` / バーだけの枠はタブの列が無い / `activate` / 隠れた窓のタブが消え、前のタブが
  隠れたら先頭へ / 見えている窓が無い枠は隠れる / `undock` で枠から出て残りで描き直す / `drag` の当たり判定
  (`getBoundingClientRect` を stub。**帯 (タブの列か 40px の目印) の中なら `end` で入れる、枠の中身の上や外なら null** /
  **開始点から 40px 未満では帯の中でも `end` が null** / 始めたときに帯の中にあった指は、一度出るまで当たらない (40px 以上
  離れていても) / `start` で目印を差してから測る) / 落とし先の帯は入れられる枠にだけ出る / タブを 8px 動かすと
  `onUndock` し、元の枠はその場で残りの窓で描き直す (残り 0 なら目印) / 掴んだタブの要素だけは指を離すまで DOM に残る /
  8px 未満なら `activate` / `attach` で差し直す / 最初の配置の枠へ戻す (`restore`: 最初の配置の並びの位置へ入れて前に出す) /
  `parseDockState` の検証 (重複・知らない id・入れられない組み合わせ・`active` の不整合)
- `window-layout.ts` の単体: 覚えた配置が無い・壊れている・`version` 3 は最初の配置 (ドック) / v1 → v2 の読み替え (`panel` →
  `list`、位置のある窓は浮いた窓のまま、位置の無い窓と `settings` は最初の配置の枠) / v2 の型違いは warn してその部分を捨てる /
  `float` と `docks` の両方にある窓は `docks` / 組の保存
- 保存する組の作り方 (`youtube.test.ts`): **窓 X を動かして保存したとき、動かしていない窓 Y の覚えた位置が書かれない**
  (`float` に Y のキーが無い) / ブラウザを小さくして詰められた Y を持つ状態で X を動かしても、Y の覚えた位置が詰めた後の
  位置で上書きされない / ダブルクリックで消した窓のキーが組から消える
- `floating-window.ts` の単体: `setDocked(true)` で `position: static`・見出しとつまみが隠れる・`place` が位置を当てない
  (`requested` は覚える)・`resize` で詰めない / `setDocked(false)` で戻る / ドック中の掴む場所は 8px で `onUndockRequest`、
  8px 未満では呼ばない / `beginMoveFrom` で外の要素から移動が続く / `onDragPoint` の `end` が true なら `onUserMove` を
  呼ばない / 触った順に z-index
- `youtube.test.ts`: 窓が 3 つできる / ⚙ で設定の窓が出て、もう一度で隠れる / 設定の窓の最初の位置が一覧から (0, +32) で
  left は同じ / 退避中の窓は `float` に位置があっても最初の位置に出る /
  折り畳みのボタンが無い / 最初の配置ではバーが `#below` の枠、一覧と設定が `#secondary-inner` の枠に入る (`buildPage()` に
  `#secondary-inner` を足す。設定のタブは開いたときだけ) / 差す先が使えない (jsdom の幅 0) 間は最初の配置の窓も退避で浮く /
  覚えた配置に `docks` があればその枠に入る /
  覚えた配置を読む前は枠も出ない / v1 の `panel` で一覧がフロート / 右の枠に入れた一覧は `#secondary-inner` が無いと退避
  フロートで出て、足すと戻る / `mount` で枠を差し直す (子を `replaceChildren` で消してから) / 別の動画へ移ると
  区間・テロップのタブが消える / 設定を開くとドック中の設定のタブが前に出る / 浮いた窓・別の枠の窓のダブルクリックで最初の
  配置の枠へ戻る / 全画面で枠も隠れる
- `e2e/telop-check.spec.ts`: C2.10 を足す。1440x795 の受け入れ条件 (A.4 / C1.5) は、最初の配置 (ドック) の下の枠と右の枠で
  測る形に変える。浮いた窓の確認 (C1 の開閉・ドラッグ・大きさ・画面の外・読み込み直し) は、覚えた配置を `docks: {}` にして
  読み込み直してから行い (浮いた窓の最初の位置から始める)、ダブルクリックの確認は「最初の配置の枠へ戻る」に変える。その後に
  「落とす → 測る → 引き出す → 戻す」を足す。ドラッグの経路は、指を一度帯の外へ出してから帯に入れる (C2.3)。**「パネルの位置の出所」の実測に `#below` / `#secondary-inner` の箱と
  `ytd-watch-flexy` の `theater` 属性を足す** (C2.1 の余白と C2.5 の幅の出所)。実機の確認は controller が行う
- `scripts/screenshots.mjs`: 最初の配置がドックになるので直す。他人の動画のサムネイルを写さないため、`#secondary` ごとではなく
  おすすめ動画の中身 (`#related` / `ytd-watch-next-secondary-results-renderer`) とチャットだけを隠す (右の列を残し、右の枠を
  使える枠にする)。1-range.png はページの先頭でプレイヤーと下の枠のバーを撮る。2-settings.png は ⚙ で開いた設定が右の枠の
  タブで前に出た絵を撮る (プレイヤーの幅を空ける CSS と、浮いた設定の窓の中を送る処理は要らなくなる)。
  (C1 の間の記述: 撮る対象を `#yt-clip-panel` から `#yt-clip-settings` に変え、窓の中を設定の先頭まで送る)

**ドキュメント**

- README: 「使い方」に窓が 3 つ (バー / 区間・テロップ / 設定) になったこと、**最初はページの中に入っている** (バーはプレイヤーの
  下、区間・テロップと設定はおすすめ動画の上にタブで並ぶ。⚙ で開くと設定のタブが前に出る)、タブ (バーは ⠿) を引き出すと浮いた
  窓になり、プレイヤーの下・おすすめ動画の上の帯へ落とすとページの中に戻る (ドック)、同じ枠に 2 つ入れるとタブ、ダブルクリックで
  最初の配置 (ページの中) に戻る。
  「仕様と制約」: 折り畳みをやめた (動かすかドックする) / バーは右の枠に入れない (最小幅 480px) / シアターモードでは
  右の枠が動画の下へ回る (自動では動かさない) / 1 列表示など枠が無い間は退避でフロート / 落とし先は画面に見えている枠の
  帯だけ / **ドック中の窓は画面の外にあると ⚙ や区間・テロップの追加の結果が見えない (ページをスクロールして戻す。
  ページは自動で動かさない)** / 下の枠にバーと一緒に入れると 1440x795 の予算を超える (バーだけなら収まる) /
  画面の高さが足りないときバーがプレイヤーに重なる (A) のは、下の枠に入れれば起きない
- CHANGELOG の「未リリース」: 「区間・テロップと設定を別の窓に分けた。窓は最初からプレイヤーの下・おすすめ動画の上の 2 か所に
  入っていて (ドック)、同じ場所ではタブになる。引き出すと浮いた窓になり、落とすとまた入る。パネルの折り畳みはやめた
  (動かすかドックする)」
- `docs/manual-check.md` の「見た目」: パネルの折り畳みの項目を消し、C2.10 の各項目 + 最初の位置の窓を少し動かしても
  ドックされない + 退避 (右の枠に入れてからブラウザを 1 列表示の幅まで狭める) + シアターモード + 落とし先の見せ方 +
  ダーク/ライトで枠とタブが読める + ドック中に画面の外で ⚙ を押しても跳ばない、を足す。「設定」の項目を
  「⚙ で設定が開く (最初はおすすめ動画の上で、区間・テロップのタブの隣に設定のタブが前に出る)」に (C1 の間は「設定の窓に開く
  (最初は一覧の窓の少し下)」)
- `docs/store-release.md`: 掲載文の「■ 設定 (⚙)」と窓の説明 (最初はページの中・引き出して浮かせられる)、スクリーンショットの
  説明 (1-range.png は下の枠のバー、2-settings.png は右の枠で前に出た設定のタブ)
- `docs/privacy-policy.md`: 保存するものの表の「窓の位置と大きさ」を「窓の位置と大きさ、どの枠に入れたか」に。
  最終更新の日付を改める

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定 (`~/.claude/CLAUDE.md`) と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 1 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C /Users/trapple/repos/github.com/trapple/yt-clip ...` を使う
- 外部プロセスを起動して待つ処理には必ず timeout を付ける。**この macOS には `timeout` コマンドが無い**。Bash ツールの `timeout` 引数
  (最大 600000) か、スクリプト側の timeout で止める
- 小さく検証してから全件: 対象の単体テスト 1 ファイル → `npm run typecheck && npm test` → (controller だけ) `npm run e2e` →
  `npm run check:telop` の順に広げる
- 日付を書くときは JST (`TZ=Asia/Tokyo date +%F`) であることを明示する
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける。本文は「なぜ」を書く
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 配線の誤り (入れられない組み合わせを `dock()` に渡す・ドック中の窓に `beginMoveFrom`・設定パネルより先に ⚙) は
  throw で知らせる。
  ※ 局所例外: `mergeWindowLayout` / `parseDockState` / `loadWindowLayout` は読めない値で throw / reject せず、warn して捨てる
  (spec C1.3 / C2.6「捨てるときは `console.warn`」。投げると窓を出さないままにする経路を作りうる)。既存の作法をそのまま残す
- テストは `npm test` (vitest)、型は `npm run typecheck` (`tsc --noEmit`。`src` / `tests` / `e2e` を含む)。**各タスクの commit 前に両方を通す**
  (リポジトリの根 `/Users/trapple/repos/github.com/trapple/yt-clip` で `npm run typecheck && npm test`、Bash の timeout 600000)
- コマンドはリポジトリの根で実行する。`npx vitest run <file>` は Bash の timeout 120000 を付ける
- `tsconfig.json` は `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`。配列の添字は `undefined` を確かめてから使う。
  **使わない関数を先に置かない** (`noUnusedLocals` はモジュールの中の関数も咎める)。後のタスクで使う関数は、そのタスクで足す

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch `feat/dockable-windows` (HEAD 26eaebd。C1 の実装とレビューと fitRect の fix が済んだ所) にそのまま積む。**main には commit しない**
- 並列: SDD (branch + SDD = 方式 D)。1 タスクごとに新しい実装担当 + レビュー。**同じファイルを触るタスクは依存順に 1 つずつ走らせる**
  (`src/content/styles.ts` と `tests/content/styles.test.ts` は Task 3・5、`src/content/floating-window.ts` と `tests/content/floating-window.test.ts` は
  Task 3・4、`src/content/panel-window.ts` と `tests/content/panel-window.test.ts` は Task 3・4、`src/content/dock.ts` と `tests/content/dock.test.ts` は
  Task 5・6、`src/content/youtube.ts` と `tests/content/youtube.test.ts` は Task 7・8)。Task 1・2・3 は互いに独立
- **実装担当は `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない** (実機の Chrome と YouTube を使う)。
  Task 9 (E2E を書く) も `npm run typecheck && npm test` までで止める
- Task 10 は **controller (メインセッション) が実行する**。`npm run e2e` → `npm run check:telop` → `npm run screenshots` を走らせ、画像と
  記録を見て C2.10 の受け入れ条件を判定し、実測値 (`#below` の上の余白・1440x795 の `#secondary-inner` の幅・シアターモードの
  `#secondary` の位置) を `dock.ts` のコメントと spec の自律判断ログに書き、`docs/manual-check.md` に記録する
- commit message は日本語で「なぜ」、末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3`
- **`git add` はファイルを名指しする** (`git add -A` / `git add .` を使わない)。作業ツリーに別のセッションの untracked のファイル
  (`.claude/specs/2026-09-25-master-switch-design.md`) がある (判断メモ 43)
- ドキュメント (README / CHANGELOG / docs/manual-check.md / docs/store-release.md / docs/privacy-policy.md) の更新はコードより先 (Task 1)
- E2E の各項目は前提の状態 (設定の窓の開閉・窓のドック状態・画面の大きさ) を自分で作り、前の項目の終わり方に依存しない
  (C1 の実機で踏んだ。`openSettings` / `closeSettings` / `bringBarToFront` のヘルパが既にある。C2 では `windowLayout` を書いて
  読み込み直す `setLayoutAndReload` を足す)
- **最初の配置はドック** (spec C2.6。ユーザーが 2026-09-25 に決めた)。値は `INITIAL_DOCKS` の 1 か所 (判断メモ 5・29)
- 終点: branch `feat/dockable-windows` 上の commit まで。push / PR はユーザーの指示を待つ

---

## ファイルの構造

| ファイル | 責務 | タスク |
|---|---|---|
| `README.md` / `CHANGELOG.md` / `docs/manual-check.md` / `docs/store-release.md` / `docs/privacy-policy.md` | ドック・タブ・引き出し・制約 | 1 |
| `src/content/window-layout.ts` | `DockTabs` / `DockState` / `WINDOW_IDS` / `DOCK_SLOT_IDS` の export、`acceptsDock`、`parseDockState`、`INITIAL_DOCKS` (ドック既定) と `initialDocks` / `initialWindowLayout` (`emptyWindowLayout` を改名)、v1 の読み替え (位置のある窓は浮いた窓)、v2 の読み方 (無いだけなら空) | 2 |
| `src/content/styles.ts` | `FLOATING_WINDOW_STYLE.docked` を足し `headerActions` を消す (3)、`DOCK_STYLE` を足す (5) | 3・5 |
| `src/content/floating-window.ts` | `headerActions` / `bodyShown` を消し `setDocked` を足す (3)。`onDragPoint` / `onUndockRequest` / `beginMoveFrom` / `UNDOCK_THRESHOLD_PX` (4) | 3・4 |
| `src/content/panel-window.ts` | `onDragPoint` を渡す口と `PANEL_HEADER_HEIGHT_PX` | 4 |
| `src/content/dock.ts` (新規) | 枠の DOM・入れる / 出す / 前に出す・最初の配置の枠へ戻す (`restore`)・差し直し・退避・保存用の形 (5)。落とし先の当たり判定・タブの押す / 引き出す (6) | 5・6 |
| `src/content/selectors.ts` | `dockBelow` / `dockSide` / `watchFlexy` | 7 |
| `src/content/youtube.ts` | 枠を作って差す・落として入れる・引き出す・退避・保存 (7)。読み込み・⚙・足した行 (8) | 7・8 |
| `tests/content/youtube-dock-load.test.ts` (新規) | 覚えた `docks` と `float.settings` を読み込むときの単体テスト | 8 |
| `e2e/telop-check.spec.ts` | 受け入れ条件 1440x795 を最初の配置 (ドック) で測る・浮いた窓の確認の前提を `docks: {}` に・ダブルクリックの確認を「最初の配置の枠へ」に・C2.10 の確認 6 項目・実測の追加・`openSettings` / `closeSettings` の判定 | 9 |
| `scripts/screenshots.mjs` | 右の列を残しておすすめ動画の中身だけ隠す・ページの先頭で撮る・2-settings.png は右の枠の設定のタブ | 9 |
| `src/content/dock.ts` (コメント)・`BELOW_SLOT_MARGIN_TOP_PX`・`docs/manual-check.md` (「## 確認した環境」)・spec の自律判断ログ | 実機の実測と記録 | 10 |

`segment-list.ts` / `telop-list.ts` / `settings-panel.ts` / `range-bar.ts` / `telop-track.ts` は変えない (窓の中身は枠に入っても同じ)。
`scripts/screenshots.mjs` は最初の配置がドックになったので Task 9 で直す (判断メモ 35)。撮り直して確かめるのは Task 10 (controller)。

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (window-layout.ts: 型・acceptsDock・parseDockState・INITIAL_DOCKS) ─────────────────────────────┐
Task 3 (floating-window.ts: setDocked・headerActions を消す / styles.ts: docked)                          │
  └→ Task 4 (floating-window.ts: onDragPoint・beginMoveFrom・DragPoint / panel-window.ts)                   │
        └→ Task 5 (dock.ts: 枠の DOM・入れる / 出す・差し直し・退避 / styles.ts: DOCK_STYLE) ←───────────────┘
              └→ Task 6 (dock.ts: 落とし先・タブの押す / 引き出す)
                    └→ Task 7 (youtube.ts: 枠を差す・落とす・引き出す・退避・保存)
                          └→ Task 8 (youtube.ts: 読み込み・⚙・足した行 / 読み込みのテスト)
                                └→ Task 9 (E2E) ─→ Task 10 (controller: 実機)
```

Task 5 は Task 2 (`DockState` などの型・`DOCK_SLOT_IDS`) と Task 4 (`DragPoint` の型。Task 4 は Task 3 の `setDocked` と同じファイルの後) の後。
`styles.ts` は Task 3 と Task 5 が触るので、Task 5 は Task 3 の後でもある (Task 4 の後なので満たす)。Task 6 は Task 4
(`UNDOCK_THRESHOLD_PX`・`beginMoveFrom`・`DragPhase`) と Task 5 の後。Task 1・2・3 は互いに独立で、並べて走らせてよい。

## 既存テストの洗い出し (grep の結果。Task 2〜9 の前提)

- `git grep -n 'headerActions\|bodyShown\|body.hidden'` (`.claude/` を除く):
  - `src/content/floating-window.ts` 62-63 (型)・105・113-115 (作る)・175-190 (`bodyShown`)・303 (戻り値) → Task 3 で消す
  - `src/content/styles.ts` 224-225 (`FLOATING_WINDOW_STYLE.headerActions`) → Task 3 で消す
  - `tests/content/floating-window.test.ts` 147-160 (「見出しのある窓は、見出しの文言と右側の部品の箱を持つ」「見出しの無い窓は…」)・
    224-237 (「見出しの中のボタンを押してドラッグしても動かない」)・394-408 (「本体を隠した窓は高さを持たず…」)・578-588 (26eaebd で 1 行ずれた)
    (「見出しのダブルクリックで onResetRequest を呼ぶ。見出しの中のボタンでは呼ばない」) → Task 3 で書き換える / 消す
  - `tests/content/panel-window.test.ts` 85 (`expect(target.frame.headerActions?.children.length).toBe(0);`) → Task 3 で消す
- `tests/content/window-layout.test.ts`: `EMPTY` (`{ version: 2, float: {}, docks: {} }`) を期待する検査のうち、「最初の配置」を返す経路
  (覚えていない・組でない・読めない版・v1・読み込みの reject) は最初の配置 (ドック) の組を期待するように Task 2 で書き換える。v2 で
  `docks: {}` を書いてある値の検査は `docks: {}` のまま。`emptyWindowLayout` は `initialWindowLayout` に改名する。v1 の読み替えの検査
  (「古い形 (v1: version が無い) は…」「型の違う窓は捨てて warn する。ほかの窓は使う (v1)」「古い形 (v1) を読んでも書き戻さない」) は、
  位置の無い窓が最初の配置の枠に入る期待に変える。「v2 で float か docks が組でなければ、組ごと空にして warn する」と「ドック枠の中身は
  まだ読まない (空で返す。…)」は書き換える
- `tests/content/youtube.test.ts`:
  - `buildPage` (198-236) に `#secondary > #secondary-inner` を足す → Task 7
  - `describe("フロートの窓")` の「#below には何も置かない」(3055-3059) → Task 7 で「#below にはドック枠だけを差し…」に書き換える
  - 最初の配置がドックになるので、jsdom では 3 つの窓は既定の枠の記憶を持ったまま退避 (浮いた窓の最初の位置) で出る (判断メモ 32)。
    `describe("フロートの窓")` の保存の組を丸ごと期待する検査 6 か所 (「つまみをドラッグすると動き、指を離したときに 1 回だけ覚える」・
    「区間・テロップの窓は見出しをドラッグすると動き、位置を覚える」・「設定の窓は見出しをドラッグすると動き、位置を覚える」・
    「ダブルクリックで戻した窓は組から消え…」・「つまみ・見出しをダブルクリックすると最初の位置に戻り、覚えた位置を消す」の 2 か所) は、
    `docks` の期待を Task 7 で直す。見た目の期待 (位置・大きさ・body 直下) は変わらない
  - `getBoundingClientRect` を全要素に stub する既存のテスト (`placePlayer` / `placeRows` / `stubPlayer` など) は、差す先の幅を 0 か
    400 に測らせる。400 のとき (placeRows) は既定の枠が使える扱いになり、隠れている設定の窓が一時的に右の枠の中へ入るが、その
    テストは設定を見ないので結果は変わらない (stub を戻すと次の attach で退避に戻る)
- `e2e/telop-check.spec.ts`: `openSettings` / `closeSettings` (「設定の窓が閉じていれば ⚙ を押して開く」の関数。`settingsWindow.isVisible()` で
  判定している) → Task 9。「窓の位置の出所 (YouTube の実測)」の `measured` → Task 9 で足す。受け入れ条件 1440x795 → 最初の配置 (ドック) で
  測る形に書き換える。浮いた窓の確認 6 項目 (「⚙ で設定が別の窓に開閉し…」「窓を動かすと…」「右下をドラッグすると…」「窓を画面の外へ…」
  「掴む場所をダブルクリックすると…」「古い形 (v1)…」) → 前提を `docks: {}` にして読み込み直す形に、ダブルクリックは最初の配置の枠へ戻る
  期待に書き換える (Task 9)
- `scripts/screenshots.mjs`: 右の列を残し、ページの先頭で撮る形に書き換える (Task 9)

---

### Task 1: ドキュメントを先に直す (C2 の範囲。最初の配置はドック)

**Files:**
- Modify: `README.md` (「使い方」18〜27 行目、「### 操作の置き場所」167〜195 行目)
- Modify: `CHANGELOG.md` (「## 未リリース」の最後の段落 42〜44 行目)
- Modify: `docs/manual-check.md` (70 行目、283 行目、「## 見た目」367〜389 行目)
- Modify: `docs/store-release.md` (掲載文の 67〜69 行目・89〜90 行目、`storage` の説明 132 行目、データの取り扱い 154 行目、スクリーンショットの説明 173〜189 行目)
- Modify: `docs/privacy-policy.md` (3 行目・20 行目・28 行目・43 行目)

**Interfaces:**
- Consumes: なし
- Produces: なし (文書だけ)

行番号は 26eaebd の時点。置き換える前の文言はこの plan に全文を載せているので、行番号がずれていたら文言で探す。

- [ ] **Step 1: README の「使い方」を直す**

`README.md` の次の段落 (18〜27 行目)

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で設定の窓に開く。

IN / OUT・録画のボタンと拡大バー (以下「バー」)、区間とテロップの一覧、設定は、画面の上に浮いた 3 つの窓
(**バー** / **区間・テロップ** / **設定**) に出る。バーは操作の行の左端の **⠿**、区間・テロップの窓と設定の窓は
見出しを掴んでドラッグすると、好きな場所へ動かせる。右下の角をドラッグすると大きさが変わる (バーは幅だけ)。
動かした位置と大きさは、次に開いたときも同じになる。**⠿ や見出しをダブルクリックすると最初の位置 (バーは
プレイヤーの直下、区間・テロップの窓は画面の右上、設定の窓はその少し下) に戻る。**

**⚙ を押すと設定の窓が開き、もう一度押すと閉じる。** 設定の窓は最初は区間・テロップの窓の少し下 (32px) に
ずれて重なって前に出る。区間・テロップの窓の見出しは上に見えたままなので、掴んで動かせば両方を並べて見られる。
```

を次に置き換える。

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で開く。

IN / OUT・録画のボタンと拡大バー (以下「バー」)、区間とテロップの一覧、設定は、3 つの窓 (**バー** / **区間・テロップ** /
**設定**) に出る。**最初はページの中に入っている**: バーはプレイヤーの直下、区間・テロップと設定はおすすめ動画の上に
タブで並び、ページと一緒にスクロールする。区間・テロップのタブはエディットモードで区間があるとき、設定のタブは ⚙ で開いて
いる間だけ出る。**⚙ を押すと設定のタブが前に出て、もう一度押すと閉じる。** タブを押すと切り替わる。

窓は浮かせて好きな場所に置ける。タブ (プレイヤーの下にバーだけのときは ⠿) を掴んで外へ引き出すと、浮いた窓になる。
浮いた窓は ⠿ や見出しを掴んで動かせ、右下の角をドラッグすると大きさが変わる (バーは幅だけ)。ドラッグしている間、
プレイヤーの下とおすすめ動画の上に点線の帯 (落とし先) が出て、帯の中で離すとページの中に戻る。同じ場所に 2 つ以上
入れるとタブになる。置いた場所と大きさは、次に開いたときも同じになる。**⠿・見出し・タブをダブルクリックすると最初の配置
(ページの中) に戻る。**
```

- [ ] **Step 2: README の「操作の置き場所」を直す**

`README.md` の「### 操作の置き場所」の、次の箇条 (167〜195 行目。「区間・テロップは区間・テロップの窓…」から節の終わりまで)

```markdown
- **区間・テロップは区間・テロップの窓、設定は設定の窓に出る**。IN / OUT・録画と拡大バーは、最初はプレイヤーの
  直下に浮いた窓に出る (拡大バーは幅がそのまま精度になるため、一覧の窓の幅には縮めない)。区間・テロップの窓と
  設定の窓は最初はおすすめ動画の列の上に重ねるので、通常の表示では動画を隠さない
- **設定の窓は ⚙ で開閉する** (窓に閉じるボタンは無い。閉じ方を 1 つにするため)。最初は区間・テロップの窓から
  32px 下へだけずれて重なり、前に出る。左右にはずらさない (左へずらすと 1440x795 などの画面でプレイヤーに重なる)。
  区間・テロップの窓を動かしても、設定の窓の最初の位置は付いていかない。開いているかは覚えない (読み込み直すと閉じている)
- **シアターモードや狭い画面 (YouTube が 1 列表示に切り替わる幅) では、区間・テロップの窓と設定の窓が動画の右側に
  重なる**。そのときは見出しを掴んで動かす。自動では動かさない (重なるかどうかの判定は YouTube のレイアウトに依存し、
  外れると勝手に跳んだように見えるため)
- **窓は畳めない**。重なるときは見出しを掴んで動かす (畳んだ状態と重なり順の組み合わせを増やさないため)
- **全画面の間と、動画の再生画面以外では、どの窓も出さない**
- **状態の文言は 1 行に収める**。長い文言は末尾が「…」で省略され、マウスを乗せると全文が出る
- **窓は動かせる**。区間・テロップの窓と設定の窓は見出し、バーは操作の行の左端の ⠿ を掴んで動かし、右下の角で
  大きさを変える。**バーは幅だけ変えられる** (高さは中身で決まる。拡大バーは幅がそのまま精度になる)。
  最小はバーが幅 480px、区間・テロップの窓と設定の窓が幅 280px・高さ 160px。最大は画面の大きさまで。バーに見出しの行を
  付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を覆うため
- **動かした位置と大きさは端末ごとに覚える** (`chrome.storage.local`。Chrome の同期で他の端末へは運ばない。
  画面の大きさと置き場所の好みは端末ごとに違うため)。**掴む場所 (⠿ / 見出し) をダブルクリックすると最初の
  位置に戻り、覚えた位置も消える**。同じ端末で YouTube のタブを複数開いているときは、**最後に窓を動かした (戻した)
  タブの配置が残る** (別のタブで動かした位置は、こちらのタブで窓を動かすと上書きされる)
- **窓は見失わない**。画面の外へドラッグしても、ブラウザを小さくしても、掴む場所 (バーは ⠿、ほかの窓は見出し) は
  画面の中の、YouTube のヘッダーより下に残る。大きい画面で覚えた位置を小さい画面で開いたときも同じ
- **動かしていない窓は、ブラウザの大きさやプレイヤーの大きさ (シアターモードの切り替えなど) が変わると最初の
  位置を取り直す** (プレイヤーが画面の上へスクロールされて見えないときは、バーは YouTube のヘッダーの直下に出る)。
  ページをスクロールしても窓は同じ画面位置に浮いたまま (コメント欄を読む間も操作できる)。
  動かした窓は置いた場所から動かない
- **画面の高さが足りないとき、バーは画面の下端 (から 16px) に寄せて出す**。そのときだけプレイヤーの下端に重なる
- **窓が重なったときは、触った順が新しいほど上に出る** (直前に触った窓が、その前に触った窓の下に潜らない)。
  ⚙ で開いた設定の窓は前に出る
```

を次に置き換える。

```markdown
- **区間・テロップは区間・テロップの窓、設定は設定の窓に出る**。最初はバーがプレイヤーの直下、区間・テロップと設定が
  おすすめ動画の上に入っている (ページの中なので動画を隠さない)。拡大バーは幅がそのまま精度になるため、一覧の窓の
  幅には縮めない
- **設定は ⚙ で開閉する** (窓に閉じるボタンは無い。閉じ方を 1 つにするため)。ページの中では設定のタブが前に出る。
  浮かせた設定の窓の最初の位置は、浮かせた区間・テロップの窓の最初の位置 (画面の右上) から 32px 下へだけずれて重なり、
  前に出る。左右にはずらさない (左へずらすと 1440x795 などの画面でプレイヤーに重なる)。開いているかは覚えない
  (読み込み直すと閉じている)
- **ページの中に入れられる場所は 2 か所** (プレイヤーの下・右の列のおすすめ動画の上)。入れた窓はページと一緒にスクロール
  し、動画に重ならない。同じ場所に 2 つ以上入れるとタブになる (並びは入れた順。並べ替えは一度引き出して入れ直す)
- **バーはおすすめ動画の上には入れられない** (最小の幅 480px が右の列より広い。拡大バーは幅がそのまま精度になる)
- **落とし先は画面に見えている帯だけ**。ドラッグの間にページは自動でスクロールしない (コメント欄まで送っているときは、
  先に上へ戻す)。浮いた窓を少し動かしただけでは入らない (ドラッグを始めた所から 40px 以上離れ、帯の外から入った
  ときだけ入る)。タブは 8px 以上ドラッグすると抜ける (押して離しただけなら、そのタブが前に出る)
- **シアターモードでは、右の列に入れた窓は動画の下へ回る** (自動では浮いた窓に戻さない。YouTube のレイアウトに依存した
  判定で窓が勝手に跳ばないように)。動画を見ながら触りたいときはタブを引き出す。浮かせた区間・テロップの窓と設定の窓は
  動画の右側に重なりうるので、そのときは見出しを掴んで動かすか、ページの中に入れる
- **1 列表示などで入れた場所が無い間は、その窓を浮いた窓で出す** (浮いた窓の最初の位置に出す。入れた場所は覚えたままで、
  場所が戻れば戻る。その間に動かすと浮いた窓になる)
- **ページの中に入れた窓が画面の外にあるときに ⚙ を押したり区間・テロップを足したりしても、結果は見えない** (その窓の
  タブが前に出るだけで、ページは自動で動かさない。スクロールして戻す)
- **プレイヤーの下にバーと一緒にほかの窓を入れると、1440x795 などの画面では 1 画面に収まらない** (タブの列の分だけ背が
  高くなる。バーだけなら収まる)。ページの中なのでスクロールすれば届く
- **窓は畳めない**。重なるときは動かすか、ページの中に入れる (畳んだ状態と重なり順とタブの組み合わせを増やさないため)
- **全画面の間と、動画の再生画面以外では、どの窓も出さない**
- **状態の文言は 1 行に収める**。長い文言は末尾が「…」で省略され、マウスを乗せると全文が出る
- **浮いた窓は動かせる**。区間・テロップの窓と設定の窓は見出し、バーは操作の行の左端の ⠿ を掴んで動かし、右下の角で
  大きさを変える。**バーは幅だけ変えられる** (高さは中身で決まる。拡大バーは幅がそのまま精度になる)。
  最小はバーが幅 480px、区間・テロップの窓と設定の窓が幅 280px・高さ 160px。最大は画面の大きさまで。バーに見出しの行を
  付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を覆うため
- **置いた位置・大きさ・入れた場所 (タブの並びと前のタブ) は端末ごとに覚える** (`chrome.storage.local`。Chrome の同期で
  他の端末へは運ばない。画面の大きさと置き場所の好みは端末ごとに違うため)。**掴む場所 (⠿ / 見出し / タブ) をダブルクリック
  すると最初の配置 (ページの中) に戻り、覚えた位置も消える**。同じ端末で YouTube のタブを複数開いているときは、**最後に窓を
  動かした (戻した・入れた) タブの配置が残る** (別のタブで動かした位置は、こちらのタブで窓を動かすと上書きされる)
- **窓は見失わない**。画面の外へドラッグしても、ブラウザを小さくしても、浮いた窓の掴む場所 (バーは ⠿、ほかの窓は見出し) は
  画面の中の、YouTube のヘッダーより下に残る。大きい画面で覚えた位置を小さい画面で開いたときも同じ
- **動かしていない浮いた窓 (入れた場所が無い間に浮いている窓など) は、ブラウザの大きさやプレイヤーの大きさ (シアターモードの
  切り替えなど) が変わると最初の位置を取り直す** (プレイヤーが画面の上へスクロールされて見えないときは、バーは YouTube の
  ヘッダーの直下に出る)。ページをスクロールしても浮いた窓は同じ画面位置に浮いたまま (コメント欄を読む間も操作できる)。
  動かした窓は置いた場所から動かない
- **画面の高さが足りないとき、浮いたバーは画面の下端 (から 16px) に寄せて出す**。そのときだけプレイヤーの下端に重なる
  (プレイヤーの下に入れれば重ならない)
- **浮いた窓が重なったときは、触った順が新しいほど上に出る** (直前に触った窓が、その前に触った窓の下に潜らない)。
  ⚙ で開いた浮いた設定の窓は前に出る
```

- [ ] **Step 3: CHANGELOG の「未リリース」を直す**

`CHANGELOG.md` の次の段落 (42〜44 行目)

```markdown
**右側のパネルを、区間・テロップの窓と設定の窓に分けた。** ⚙ で設定の窓が開き、区間・テロップの一覧と
並べて見られる (最初は区間・テロップの窓の少し下にずれて重なって出る)。窓は 3 つ (バー / 区間・テロップ / 設定) に
なり、重なったときは触った順が新しいほど上に出る。
```

を次に置き換える (折り畳みの一文は書かない。判断メモ 22)。

```markdown
**右側のパネルを、区間・テロップの窓と設定の窓に分けた。** ⚙ で設定の窓が開き、区間・テロップの一覧と
並べて見られる。窓は 3 つ (バー / 区間・テロップ / 設定) になり、重なったときは触った順が新しいほど上に出る。

**窓を最初からページの中に入れた (ドック)。** バーはプレイヤーの直下、区間・テロップと設定はおすすめ動画の上に入り、
ページと一緒にスクロールする。同じ場所に入った窓はタブで切り替える。タブを外へ引き出すと浮いた窓になり、プレイヤーの
下かおすすめ動画の上へドラッグして落とすとまた入る。入れた場所とタブの並びは端末ごとに覚え、ダブルクリックで最初の
配置に戻る。
```

- [ ] **Step 4: docs/manual-check.md を直す**

70 行目

```markdown
- [ ] ⚙ でモードをエディットに変えて区間を足すと、区間・テロップの窓 (最初は画面の右上) に区間の一覧が出る (区間が 0 個の間は窓ごと出ない)
```

を次に置き換える。

```markdown
- [ ] ⚙ でモードをエディットに変えて区間を足すと、区間・テロップの窓 (最初はおすすめ動画の上のタブ) に区間の一覧が出る (区間が 0 個の間はタブごと出ない)
```

283 行目

```markdown
- [ ] バーの右端に ⚙ が出て、押すと設定の窓に開く (最初は区間・テロップの窓の少し下。区間・テロップの窓の見出しは見えたまま)。もう一度押すと閉じる。区間・テロップの窓はそのまま
```

を次に置き換える。

```markdown
- [ ] バーの右端に ⚙ が出て、押すと設定が開く (最初はおすすめ動画の上で、区間・テロップのタブの隣に設定のタブが前に出る)。もう一度押すと閉じる (設定のタブが消える)。区間・テロップの窓はそのまま
```

「## 見た目」の次の箇条 (367〜389 行目。「動かしていない区間・テロップの窓が…」から「バーの窓の地が不透明で…」まで)

```markdown
- [ ] 動かしていない区間・テロップの窓が、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
- [ ] 区間・テロップの窓と設定の窓の地が不透明で、下のおすすめ動画が透けない (ダーク・ライトの両方。テーマを切り替えると窓も追従する)
- [ ] 区間とテロップを増やすと、**区間・テロップの窓の中だけ**がスクロールする (ページはスクロールしない)。窓の下端は画面の下から 16px で止まる
- [ ] 区間・テロップの窓と設定の窓の見出しは「区間・テロップ」「設定」で、折り畳みのボタン (▶) は無い。＋ 区間を追加・＋ テロップを押すと、区間・テロップの窓の中が足した行まで送られる
- [ ] 区間とテロップが多いときに ⚙ を押すと、設定の窓が前に出て設定の先頭が見える。区間・テロップの窓の中は送られない (ページも動かない)
- [ ] シアターモードでは区間・テロップの窓と設定の窓が動画の右側に重なる (仕様)。見出しを掴んで動かす
- [ ] 全画面の間はどの窓も出ず、全画面を抜けると戻る
- [ ] 状態の文言が長いときは 1 行で省略され (…)、マウスを乗せると全文が出る
- [ ] 別の動画へ移ると、区間・テロップの窓に前の動画の区間が残らない。ホームへ移るとどの窓も消える
- [ ] 最初のバーの窓は、プレイヤーの直下 (左端を揃え、幅はプレイヤーの幅、8px 空けて) に出る。読み込んだ直後に別の場所から跳んでこない
- [ ] バーの窓は操作の行の左端の ⠿、区間・テロップの窓と設定の窓は見出しを掴むと動く
- [ ] 右下の角をドラッグすると大きさが変わる。バーは幅だけ (480px より狭くならない)、区間・テロップの窓と設定の窓は幅と高さ (280x160 より小さくならない)
- [ ] 窓を画面の外へドラッグしても、⠿ と見出しは画面に残る (区間・テロップの窓を右端に寄せても縁が画面の外へ出ない)。上へドラッグしても見出しが YouTube のヘッダーの裏に入らず、掴んで動かせる。ブラウザの窓を小さくしても同じ
- [ ] 動かしてからページを読み込み直すと、同じ位置と大きさで出る。別のタブで同じ動画を開いても同じ
- [ ] ⠿ と見出しをダブルクリックすると最初の位置に戻る。読み込み直しても最初の位置のまま
- [ ] 動かしていない窓は、シアターモードの切り替えやブラウザの大きさの変更でプレイヤーに付いてくる。ページをスクロールしても窓は動かない
- [ ] コメント欄まで送ってプレイヤーが画面の上に消えた状態でブラウザの大きさを変えると、動かしていないバーの窓は YouTube のヘッダーの直下に出る (ヘッダーの裏に潜らない)
- [ ] 動かした窓は、シアターモードを切り替えても置いた場所から動かない
- [ ] 3 つの窓を重ねると、触った順が新しいほど上に出る (バー → 一覧 → 設定の順に触ってからバーを触ると、設定は一覧の上のまま)。YouTube のヘッダーのメニューは窓より上に出る
- [ ] 1440x795 で、最初の位置のままエディットモードで区間 5 つ・テロップ 5 つ・設定を開くと、設定の窓の左端がプレイヤーの右端より右にある (設定の窓もプレイヤーに重ならない)。設定の窓は画面に収まる
- [ ] 設定の窓を動かしてから読み込み直し、⚙ で開くと、動かした位置に出る。見出しをダブルクリックすると区間・テロップの窓の最初の位置の少し下 (32px) へ戻る
- [ ] 区間・テロップの窓を動かしても、設定の窓の最初の位置 (ダブルクリックの戻し先) は動かない
- [ ] バーの窓の地が不透明で、下のページが透けない (ダーク・ライトの両方。テーマを切り替えると追従する)
```

を次に置き換える。

```markdown
- [ ] 最初の配置では、バーがプレイヤーの直下 (動画のタイトルの上) に、区間・テロップと設定がおすすめ動画の上 (右の列の先頭) にページの一部として入り、動画を隠さない。読み込んだ直後に浮いた窓から跳んでこない。シンプルモードで設定を閉じているときは、おすすめ動画の上には何も出ない
- [ ] 1440x795 で、最初の配置のままエディットモードで区間 5 つ・テロップ 5 つ・設定を開くと、ページの先頭でプレイヤーの下のバーが画面に収まり、おすすめ動画の上の枠はプレイヤーに重ならない
- [ ] 区間・テロップの窓と設定の窓の地が不透明で、下のおすすめ動画が透けない (浮かせたとき。ダーク・ライトの両方。テーマを切り替えると窓も追従する)
- [ ] 浮かせた区間・テロップの窓は、区間とテロップを増やすと**窓の中だけ**がスクロールする (ページはスクロールしない)。窓の下端は画面の下から 16px で止まる。ページの中では中身なりに伸びる
- [ ] 区間・テロップの窓と設定の窓の見出し (浮かせたとき) とタブは「区間・テロップ」「設定」で、折り畳みのボタン (▶) は無い。＋ 区間を追加・＋ テロップを押すと、浮いた区間・テロップの窓は中が足した行まで送られ、ページの中ではそのタブが前に出る (ページは動かない)
- [ ] 区間とテロップが多いときに ⚙ を押すと、設定の先頭が見える (ページの中では設定のタブが前に出る。浮いた窓では設定の窓が前に出る)。区間・テロップの窓の中は送られない (ページも動かない)
- [ ] シアターモードでは浮いた区間・テロップの窓と設定の窓が動画の右側に重なる (仕様)。見出しを掴んで動かすか、ページの中に入れる
- [ ] 全画面の間はどの窓も枠も出ず、全画面を抜けると戻る
- [ ] 状態の文言が長いときは 1 行で省略され (…)、マウスを乗せると全文が出る
- [ ] 別の動画へ移ると、区間・テロップの窓に前の動画の区間が残らない (区間・テロップのタブが消える)。ホームへ移るとどの窓も消える
- [ ] 浮かせたバーの窓は操作の行の左端の ⠿、浮かせた区間・テロップの窓と設定の窓は見出しを掴むと動く
- [ ] 浮いた窓の右下の角をドラッグすると大きさが変わる。バーは幅だけ (480px より狭くならない)、区間・テロップの窓と設定の窓は幅と高さ (280x160 より小さくならない)
- [ ] 浮いた窓を画面の外へドラッグしても、⠿ と見出しは画面に残る (区間・テロップの窓を右端に寄せても縁が画面の外へ出ない)。上へドラッグしても見出しが YouTube のヘッダーの裏に入らず、掴んで動かせる。ブラウザの窓を小さくしても同じ
- [ ] 浮いた窓を動かしてからページを読み込み直すと、同じ位置と大きさで出る。別のタブで同じ動画を開いても同じ
- [ ] 浮いた窓の ⠿ と見出し、ページの中のタブをダブルクリックすると最初の配置 (バーはプレイヤーの下、区間・テロップと設定はおすすめ動画の上) に戻る。読み込み直しても最初の配置のまま
- [ ] 1 列表示の間に浮いている窓 (入れた場所が無いので最初の位置に出ている窓) は、ブラウザの大きさの変更でプレイヤーに付いてくる。ページをスクロールしても浮いた窓は動かない
- [ ] コメント欄まで送ってプレイヤーが画面の上に消えた状態で、1 列表示の間に浮いているバーの窓のままブラウザの大きさを変えると、YouTube のヘッダーの直下に出る (ヘッダーの裏に潜らない)
- [ ] 動かした浮いた窓は、シアターモードを切り替えても置いた場所から動かない
- [ ] 3 つの浮いた窓を重ねると、触った順が新しいほど上に出る (バー → 一覧 → 設定の順に触ってからバーを触ると、設定は一覧の上のまま)。YouTube のヘッダーのメニューは窓より上に出る
- [ ] 浮かせた設定の窓を動かしてから読み込み直し、⚙ で開くと、動かした位置に出る。見出しをダブルクリックするとおすすめ動画の上の設定のタブに戻る
- [ ] 浮かせた区間・テロップの窓を動かしても、浮いた設定の窓の最初の位置 (区間・テロップの窓の最初の位置から下へ 32px。1 列表示で浮いたときに出る所) は動かない
- [ ] バーの窓の地が不透明で、下のページが透けない (ダーク・ライトの両方。テーマを切り替えると追従する)
- [ ] 浮いた窓を少し (20px) 動かして離しても、近くの帯に吸い込まれない。1440x795 で、浮かせた区間・テロップの窓の見出しの上端近くを掴んで 20px 下へ、浮かせたバーの ⠿ を 20px 右へ動かしても、ページの中に入らない
- [ ] 窓をドラッグしている間だけ、入れられる場所に点線の帯が出る (空の場所・バーだけの場所には「ここにドック」の 40px の箱、タブがある場所にはタブの列)。指が帯の中にあると塗られる。押して離しただけ (クリック) では出ない。バーをドラッグしている間は、おすすめ動画の上には出ない。帯が出ている間、下の内容は 40px だけ下がる
- [ ] ⠿ で引き出したバーをプレイヤーの下の帯へ落とすと、バーがプレイヤーの直下 (動画のタイトルの上) に戻り、タブの列は出ない。1440x795 でページの先頭のとき、画面に収まる。読み込み直しても入ったまま
- [ ] 浮かせた区間・テロップの窓と設定の窓をおすすめ動画の上の帯へ落とすと、タブが並び、後から落とした方が前に出る。タブを押すと切り替わる。⚙ で閉じると設定のタブが消え、もう一度押すと設定のタブが前に出る。読み込み直しても並びが同じ
- [ ] 区間・テロップのタブをプレイヤーの下のバーの上の帯へ落とすと、プレイヤーの下にタブが 2 つ (バー / 区間・テロップ) 出て、おすすめ動画の上は設定だけになる。区間・テロップのタブをダブルクリックすると、おすすめ動画の上 (設定の前) に戻る
- [ ] タブを 8px 以上ドラッグすると枠から抜けて浮いた窓になり、指に付いて動く。押して離しただけでは抜けない (そのタブが前に出る)。プレイヤーの上で離すと浮いた窓のまま、帯へ戻すとまた入る
- [ ] プレイヤーの下にバーだけが入っているとき、⠿ を 8px 以上ドラッグすると抜けて、⠿ が指の下に付いたまま動く
- [ ] ページの中に入れた窓は、ページをスクロールするとページと一緒に動く
- [ ] おすすめ動画の上に入れたまま t でシアターモードにすると、枠ごと動画の下へ回り (入ったまま)、戻すと元の位置
- [ ] おすすめ動画の上に入っている状態でブラウザを 1 列表示の幅まで狭めると、入れた窓が浮いた窓の最初の位置 (画面の右上) で出る。広げ直すと枠に戻る。狭めている間に動かすと、広げても浮いた窓のまま
- [ ] ダークとライトの両方で、枠とタブ (前のタブと後ろのタブの見分け)・落とし先の帯が読める
- [ ] ページの中の設定が画面の外 (ページを送った先) にあるときに ⚙ を押しても、ページは跳ばない (タブが前に出るだけ)
```

- [ ] **Step 5: docs/store-release.md を直す**

掲載文の次の 3 行

```markdown
操作のバー・区間とテロップの一覧・設定は、画面の上に浮いた 3 つの窓です。バーは左端の ⠿、
ほかの窓は見出しを掴んで好きな場所へ動かせ、右下の角で大きさも変えられます (バーは幅だけ)。
位置は端末ごとに覚え、掴む場所をダブルクリックすると最初の位置に戻ります。
```

を次に置き換える。

```markdown
操作のバー・区間とテロップの一覧・設定は 3 つの窓です。最初はページの中に入っていて (バーはプレイヤーの直下、
一覧と設定はおすすめ動画の上にタブで並びます)、動画を隠しません。タブを引き出すと画面の上に浮かせて好きな場所へ
動かせ、プレイヤーの下やおすすめ動画の上へドラッグするとページの中に戻ります。
置いた場所は端末ごとに覚え、掴む場所をダブルクリックすると最初の配置に戻ります。
```

「■ 設定 (⚙)」の次の 2 行

```markdown
⚙ を押すと設定の窓が開きます (最初は区間・テロップの窓の少し下にずれて重なって出ます)。
一覧の窓とは別の窓なので、並べて見られます。
```

を次に置き換える。

```markdown
⚙ を押すと設定が開きます (最初はおすすめ動画の上に、一覧の隣のタブとして前に出ます)。
一覧とは別の窓なので、引き出して並べて見ることもできます。
```

`storage` の説明の次の行

```markdown
> 操作のバー・区間とテロップの一覧・設定 (画面に浮いた 3 つの窓) の位置と大きさを端末ごとに保存する (`chrome.storage.local`)。
```

を次に置き換える。

```markdown
> 操作のバー・区間とテロップの一覧・設定 (3 つの窓) の位置と大きさ、ページの中のどの枠に入れたか (タブの並び) を端末ごとに保存する (`chrome.storage.local`)。
```

データの取り扱いの次の行

```markdown
- 窓の位置と大きさは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

を次に置き換える。

```markdown
- 窓の位置と大きさ・どの枠に入れたかは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

「## 4. スクリーンショット」の次の箇所 (173〜189 行目)

```markdown
1. `1-range.png` — プレイヤーの直下に浮いたバーの窓 (拡大バーと IN/OUT などの操作の行。IN を置いた状態)。
   シンプルモードで設定を閉じているので、区間・テロップの窓も設定の窓も出ていない
2. `2-settings.png` — ⚙ で設定の窓を開いた状態。位置は区間・テロップの窓の最初の位置から下へ 32px (シンプルモードなので
   区間・テロップの窓は出ていない)。窓の中を設定の先頭まで送って撮る。1280x800 では窓に全項目が収まらず末尾が切れる
   (窓の中でスクロールすることが分かる絵にしてある)

**題材は Big Buck Bunny (Blender Foundation, Creative Commons)。** 掲載画像には
動画の中身がそのまま写るので、権利関係で問題にならないものを使う。
関連動画の欄は隠してある (他人の動画のサムネイルを写さないため)。
2-settings.png だけはプレイヤー (`#primary`) の幅を設定の窓のぶん空けている
(`scripts/screenshots.mjs`)。関連動画の欄を隠すとプレイヤーが画面右端まで
広がって設定の窓と重なるので、実機で重ならない幅に合わせ直している。
1-range.png とプレイヤーの幅が違って見えるのはこのため。

**バーの窓はページのスクロールに付いてこない** (画面に浮いたまま)。そのため `scripts/screenshots.mjs` は
ページを送って枠取りを決めた後に `resize` を配り、動かしていないバーの窓に最初の位置 (プレイヤーの直下) を
取り直させてから撮る。
```

を次に置き換える (判断メモ 35。`scripts/screenshots.mjs` は Task 9 で直す)。

```markdown
1. `1-range.png` — プレイヤーの直下 (ページの中) に入ったバー (拡大バーと IN/OUT などの操作の行。IN を置いた状態)。
   シンプルモードで設定を閉じているので、おすすめ動画の上の枠は出ていない
2. `2-settings.png` — ⚙ で設定を開いた状態。おすすめ動画の上の枠で設定のタブが前に出て、設定の先頭から見える
   (ページの中の窓は中身なりに伸びるので、末尾は画面の下で切れてよい)

**題材は Big Buck Bunny (Blender Foundation, Creative Commons)。** 掲載画像には
動画の中身がそのまま写るので、権利関係で問題にならないものを使う。
関連動画の欄は中身だけを隠してある (他人の動画のサムネイルを写さないため)。右の列そのものは残すので、
プレイヤーの幅は実際の YouTube と同じで、設定はおすすめ動画の上の枠に入る。2 枚ともページの先頭で撮る
(最初の配置ではバーも設定もページの中に入っていて、ページを送る必要が無い)。
```

- [ ] **Step 6: docs/privacy-policy.md を直す**

表の次の行

```markdown
| 窓 (操作のバー・区間とテロップの一覧・設定) の位置と大きさ | `chrome.storage.local` | 拡張を削除したとき |
```

を次に置き換える。

```markdown
| 窓 (操作のバー・区間とテロップの一覧・設定) の位置と大きさ、どの枠に入れたか | `chrome.storage.local` | 拡張を削除したとき |
```

次の行

```markdown
`chrome.storage.local` に置いた窓の位置と大きさは、その端末の中にだけ残り、同期されない。
```

を次に置き換える。

```markdown
`chrome.storage.local` に置いた窓の位置と大きさ・どの枠に入れたかは、その端末の中にだけ残り、同期されない。
```

権限の表の次の行

```markdown
| `storage` | 上表の設定・窓の位置と大きさ・進行状態を端末内に置くため |
```

を次に置き換える。

```markdown
| `storage` | 上表の設定・窓の位置と大きさとどの枠に入れたか・進行状態を端末内に置くため |
```

3 行目の `最終更新: 2026-09-25` は、`TZ=Asia/Tokyo date +%F` (JST) の日付に改める (同じ日付ならそのまま)。

- [ ] **Step 7: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (文書だけの変更だが、commit の前に通す規約に従う)

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/store-release.md docs/privacy-policy.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 窓を最初からページの中に入れる (ドック) ことを先に書く

最初の配置をドックにする (バーはプレイヤーの下、区間・テロップと
設定はおすすめ動画の上のタブ) とユーザーが決めた。浮いた窓は引き
出したときだけになり、ダブルクリックは最初の配置へ戻す。使い方・
制約・保存するもの・掲載画像の説明と確認手順を、コードより先に
揃えておく。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: 枠の中身の型・検証・最初の配置 (ドック) (`window-layout.ts`)

**Files:**
- Modify: `src/content/window-layout.ts:15-22` (型)、`:28-46` (`WindowLayout` と `emptyWindowLayout`)、`:95-98` の後 (`isRecord` の後に関数を足す)、`:132-168` (`mergeWindowLayout`)、`:246-263` (`toStored`)
- Modify: `src/content/window-layout.ts` の `loadWindowLayout` (読めないときの戻り値)
- Test: `tests/content/window-layout.test.ts`

**Interfaces:**
- Consumes: なし
- Produces (後のタスクが使う):
  - `export const WINDOW_IDS: readonly WindowId[]` (`["bar", "list", "settings"]`)
  - `export const DOCK_SLOT_IDS: readonly DockSlotId[]` (`["below", "side"]`)
  - `export type DockTabs = { tabs: WindowId[]; active?: WindowId }` — 1 つの枠の中身
  - `export type DockState = Partial<Record<DockSlotId, DockTabs>>` — 枠ごとの組 (`WindowLayout.docks` の型)
  - `export function acceptsDock(id: WindowId, slot: DockSlotId): boolean` — バーを右の枠に入れるときだけ false
  - `export function parseDockState(value: unknown): DockState` — 保存データの `docks` を確かめて読む (warn して捨てる)
  - `export function initialDocks(): DockState` — 最初の配置の枠の写し (`INITIAL_DOCKS` = `{ below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"] } }`)
  - `export function initialWindowLayout(): WindowLayout` — 最初の配置の組 (`{ version: 2, float: {}, docks: initialDocks() }`)。
    C1 の `emptyWindowLayout` を改名する (中身が空ではなくなったため。呼んでいるのはこのファイルとそのテストだけ)
  - `mergeWindowLayout`: 覚えていない・組でない・読めない版 → 最初の配置。v1 → 位置のある窓は `float`、`INITIAL_DOCKS` からその窓を
    除いたものが `docks`。v2 → 書いてあるとおり (`docks` が無いだけなら `{}`)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/window-layout.test.ts` の import を次に置き換える。

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  WINDOW_LAYOUT_KEY,
  acceptsDock,
  fitRect,
  initialBarRect,
  initialWindowLayout,
  loadWindowLayout,
  mergeWindowLayout,
  parseDockState,
  saveWindowLayout,
  type WindowLayout,
} from "@/content/window-layout";
```

同じファイルの定数

```typescript
/** 何も覚えていないときの組 (3 つとも最初の位置) */
const EMPTY: WindowLayout = { version: 2, float: {}, docks: {} };
```

を次に置き換える。

```typescript
/** 最初の配置 (ドック。spec C2.6): バーは下の枠、区間・テロップの窓と設定の窓は右の枠 */
const INITIAL: WindowLayout = {
  version: 2,
  float: {},
  docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"] } },
};
/** v2 で枠を空に書いてある組 (3 つとも浮いた窓の最初の位置) */
const EMPTY: WindowLayout = { version: 2, float: {}, docks: {} };
```

`describe("mergeWindowLayout")` の既存の検査のうち、最初の配置を返す経路の期待を次のとおり直す (v2 で `docks: {}` を書いてある値の
期待 `EMPTY` はそのまま)。

「何も覚えていなければ空の組。warn しない」を次に置き換える。

```typescript
  test("何も覚えていなければ最初の配置 (ドック)。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual(INITIAL);
    expect(initialWindowLayout()).toEqual(INITIAL);
    expect(warn).not.toHaveBeenCalled();
  });

  test("最初の配置の組は呼ぶたびに新しい (書き換えても次の組に残らない)", () => {
    const first = initialWindowLayout();
    first.docks.side?.tabs.push("bar");
    expect(initialWindowLayout()).toEqual(INITIAL);
  });
```

「古い形 (v1: version が無い) は bar → float.bar、panel → float.list に読み替える。設定の窓は無い扱い」の期待

```typescript
    expect(mergeWindowLayout({ bar, panel })).toEqual({
      version: 2,
      float: { bar, list: panel },
      docks: {},
    });
```

を次に置き換え、テスト名を「古い形 (v1: version が無い) は bar → float.bar、panel → float.list に読み替える。位置のある窓は浮いた窓のまま、設定の窓は最初の配置の枠」にする。

```typescript
    expect(mergeWindowLayout({ bar, panel })).toEqual({
      version: 2,
      float: { bar, list: panel },
      docks: { side: { tabs: ["settings"] } },
    });
```

「v1 の空の組 (前に全部の窓を戻した) は空の組。warn しない」を次に置き換える。

```typescript
  test("v1 の空の組 (前に全部の窓を戻した) は最初の配置。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({})).toEqual(INITIAL);
    expect(warn).not.toHaveBeenCalled();
  });
```

「型の違う窓は捨てて warn する。ほかの窓は使う (v1)」の期待

```typescript
    expect(mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel })).toEqual({
      version: 2,
      float: { list: panel },
      docks: {},
    });
```

を次に置き換える (捨てたバーは位置が無いので最初の配置の枠へ)。

```typescript
    expect(mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel })).toEqual({
      version: 2,
      float: { list: panel },
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["settings"] } },
    });
```

「組でないもの (数値・null・配列) は空の組にして warn する」の 3 つの `toEqual(EMPTY)` を `toEqual(INITIAL)` にし、テスト名を
「組でないもの (数値・null・配列) は最初の配置にして warn する」にする。「読めない版 (3・1・数でない版) は空の組にして warn する
(後の版が書いた形を推測で読まない)」の 3 つの `toEqual(EMPTY)` も `toEqual(INITIAL)` にし、テスト名の「空の組」を「最初の配置」にする。
「知らない窓の名前は黙って無視する (…)」の 2 つ目の `expect(mergeWindowLayout({ other: { left: 0 } })).toEqual(EMPTY);` (v1) を
`toEqual(INITIAL)` にする (1 つ目の v2 は `EMPTY` のまま)。

`describe("覚えた配置の保存と読み込み")` の「古い形 (v1) を読んでも書き戻さない (次に動かしたときに v2 で書く)」の期待

```typescript
    expect(await loadWindowLayout()).toEqual({
      version: 2,
      float: { bar: BAR, list: LIST },
      docks: {},
    });
```

を次に置き換える。

```typescript
    expect(await loadWindowLayout()).toEqual({
      version: 2,
      float: { bar: BAR, list: LIST },
      docks: { side: { tabs: ["settings"] } },
    });
```

同じ describe の「読めなければ warn して空の組を返す (最初の位置で出す)」の `toEqual(EMPTY)` を `toEqual(INITIAL)` にし、テスト名を
「読めなければ warn して最初の配置の組を返す」にする。

`describe("mergeWindowLayout")` の中の次のテスト

```typescript
  test("v2 で float か docks が組でなければ、組ごと空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: null, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {}, docks: 5 })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {} })).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
  });
```

を次に置き換える。

```typescript
  test("v2 で float か docks が組でなければ、その部分だけ捨てて warn する (ほかの部分は使う)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(
      mergeWindowLayout({ version: 2, float: null, docks: { below: { tabs: ["bar"] } } }),
    ).toEqual({ version: 2, float: {}, docks: { below: { tabs: ["bar"] } } });
    expect(mergeWindowLayout({ version: 2, float: { bar }, docks: 5 })).toEqual({
      version: 2,
      float: { bar },
      docks: {},
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("v2 で float か docks が無いだけなら空として読み、warn しない (正しい float を捨てない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(mergeWindowLayout({ version: 2, float: { bar } })).toEqual({
      version: 2,
      float: { bar },
      docks: {},
    });
    expect(mergeWindowLayout({ version: 2, docks: { side: { tabs: ["list"] } } })).toEqual({
      version: 2,
      float: {},
      docks: { side: { tabs: ["list"] } },
    });
    expect(warn).not.toHaveBeenCalled();
  });
```

同じ `describe` の次のテスト

```typescript
  test("ドック枠の中身はまだ読まない (空で返す。枠を入れる経路がまだ無い)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: {}, docks: { below: { tabs: ["bar"] } } }),
    ).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });
```

を次に置き換える。

```typescript
  test("枠の中身 (タブの並びと前のタブ) を読む", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      version: 2,
      float: {},
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("float と docks の両方にある窓は枠に入れ、float の値も残す (引き出したときの大きさに使う)", () => {
    const list = { left: 1024, top: 68, width: 400, height: 500 };
    const stored = { version: 2, float: { list }, docks: { side: { tabs: ["list"], active: "list" } } };
    expect(mergeWindowLayout(stored)).toEqual(stored);
  });

  test("枠の中身の検証は parseDockState と同じ (右の枠のバーは捨てて warn する)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: {}, docks: { side: { tabs: ["bar", "list"] } } }),
    ).toEqual({ version: 2, float: {}, docks: { side: { tabs: ["list"] } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
```

`describe("mergeWindowLayout")` の**後** (`describe("fitRect")` の前) に次を足す。

```typescript
describe("acceptsDock", () => {
  test("バーは右の枠に入れない。ほかの組み合わせは入れる", () => {
    expect(acceptsDock("bar", "side")).toBe(false);
    expect(acceptsDock("bar", "below")).toBe(true);
    for (const id of ["list", "settings"] as const) {
      expect(acceptsDock(id, "below")).toBe(true);
      expect(acceptsDock(id, "side")).toBe(true);
    }
  });
});

describe("parseDockState", () => {
  test("枠ごとのタブの並びと前のタブを読む", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const docks = { below: { tabs: ["bar", "list"], active: "list" }, side: { tabs: ["settings"] } };
    expect(parseDockState(docks)).toEqual(docks);
    expect(warn).not.toHaveBeenCalled();
  });

  test("無ければ空。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState(undefined)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  test("組でなければ空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const value of [5, null, [], "side"]) {
      expect(parseDockState(value)).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test("組でない枠・tabs が配列でない枠は捨てて warn する。ほかの枠は使う", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ below: { tabs: "bar" }, side: { tabs: ["list"] } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(parseDockState({ below: 3 })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("同じ枠の重複は先頭を残し、別の枠にも入っている窓は below の方を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      parseDockState({ below: { tabs: ["list", "list"] }, side: { tabs: ["list", "settings"] } }),
    ).toEqual({ below: { tabs: ["list"] }, side: { tabs: ["settings"] } });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("知らない窓と、入れられない組み合わせ (右の枠のバー) は捨てて warn する。残りが無い枠は鍵ごと持たない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ below: { tabs: ["panel", "bar"] }, side: { tabs: ["bar"] } })).toEqual({
      below: { tabs: ["bar"] },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("active が tabs に無ければ無い扱いにして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ side: { tabs: ["list"], active: "settings" } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(parseDockState({ side: { tabs: ["list"], active: 7 } })).toEqual({
      side: { tabs: ["list"] },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("知らない枠の名前は黙って無視する (後の版で枠が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseDockState({ top: { tabs: ["bar"] } })).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});
```

`describe("覚えた配置の保存と読み込み")` の最後のテスト (「呼んだ後に渡した組を書き換えても…」) の後に次を足す
(保存の形は今の `toStored` で既に通る。組の形を固定するための検査)。

```typescript
  test("枠の中身も組ごと書く (タブの並びと前のタブ)", async () => {
    await saveWindowLayout({
      version: 2,
      float: { list: LIST },
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    });
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({
      version: 2,
      float: { list: LIST },
      docks: { below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "settings" } },
    });
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: FAIL。`acceptsDock` / `parseDockState` / `initialWindowLayout` が export されていない (`is not a function`)、最初の配置を期待する検査が `docks: {}` で食い違う、「その部分だけ捨てて…」「無いだけなら…」
「枠の中身 (タブの並びと前のタブ) を読む」「float と docks の両方…」「枠の中身の検証は…」が今の `mergeWindowLayout` (docks を読まない・
組ごと捨てる) で食い違う。「枠の中身も組ごと書く」は通る

- [ ] **Step 3: 最小実装**

`src/content/window-layout.ts` の 15〜22 行目

```typescript
/** 窓の名前 (窓の分割の spec C1.1)。覚えた配置の鍵にも使う */
export type WindowId = "bar" | "list" | "settings";
const WINDOW_IDS: readonly WindowId[] = ["bar", "list", "settings"];
/** ドック枠の名前 (C2)。C1 では型だけを置き、枠の中身は常に空 */
export type DockSlotId = "below" | "side";
const DOCK_SLOT_IDS: readonly DockSlotId[] = ["below", "side"];
/** 枠に入っている窓 (タブの並び。前から) と、前に出しているタブ (C2) */
export type DockState = { tabs: WindowId[]; active?: WindowId };
```

を次に置き換える。

```typescript
/** 窓の名前 (窓の分割の spec C1.1)。覚えた配置の鍵にも使う */
export type WindowId = "bar" | "list" | "settings";
export const WINDOW_IDS: readonly WindowId[] = ["bar", "list", "settings"];
/**
 * ドック枠の名前 (C2.1)。below はプレイヤーの下 (#below の先頭)、side は右の列 (#secondary-inner の先頭。
 * おすすめ動画の上)
 */
export type DockSlotId = "below" | "side";
export const DOCK_SLOT_IDS: readonly DockSlotId[] = ["below", "side"];
/** 1 つの枠に入っている窓 (タブの並び。前から = 入れた順) と、前に出しているタブ (C2.2) */
export type DockTabs = { tabs: WindowId[]; active?: WindowId };
/**
 * 枠ごとの中身 (C2.6)。窓が 1 つも無い枠は鍵ごと持たない。**型はここに置く** (保存データの検証が使う。
 * dock.ts に置くと dock.ts → floating-window.ts → このファイルと循環する)。dock.ts は見せ直すだけ
 */
export type DockState = Partial<Record<DockSlotId, DockTabs>>;
```

`WindowLayout` の型 (28〜37 行目の `export type WindowLayout = { … };`) の `docks` の行と doc

```typescript
  /** 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ。C1 では常に空 */
  docks: Partial<Record<DockSlotId, DockState>>;
```

を次に置き換える。

```typescript
  /**
   * 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ (C2.6)。**float と両方にある窓は枠に入っている**
   * (float の値は引き出したときの大きさにだけ使う。C2.1 / C2.4)
   */
  docks: DockState;
```

43〜46 行目 (26eaebd の時点。`emptyWindowLayout` の doc と関数)

```typescript
/** 何も覚えていないときの配置 (3 つとも最初の位置)。呼ぶたびに新しい組を返す (書き換えても共有しない) */
export function emptyWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: {}, docks: {} };
}
```

を次に置き換える (`emptyWindowLayout` は `initialWindowLayout` に改名する。このファイルの中で呼んでいる 7 か所 (`mergeWindowLayout` の
6 か所と `loadWindowLayout` の catch) も、下の `mergeWindowLayout` の置き換えと `loadWindowLayout` の直しで `initialWindowLayout` になる)。

```typescript
/**
 * 最初の配置 (C2.6): **ドック**。バーは下の枠、区間・テロップの窓と設定の窓は右の枠 (並びは区間・テロップ → 設定)。
 * 設定のタブは ⚙ で開いている間、区間・テロップのタブはエディットモードで区間がある間だけ出る (隠れた窓のタブは出さない)。
 * ユーザーが 2026-09-25 に選んだ。**最初の配置はここ 1 か所に置く**: initialWindowLayout (何も覚えていない・壊れた値・
 * 読めない版)、v1 の読み替え (位置の無い窓)、ダブルクリックの戻し先 (dock.ts の restore に youtube.ts が渡す) がここを見る
 */
const INITIAL_DOCKS: DockState = {
  below: { tabs: ["bar"] },
  side: { tabs: ["list", "settings"] },
};

/** 枠の中身を写す (呼び出し側が書き換えても共有しない) */
function cloneDocks(docks: DockState): DockState {
  const copy: DockState = {};
  for (const slot of DOCK_SLOT_IDS) {
    const entry = docks[slot];
    if (entry === undefined) continue;
    copy[slot] =
      entry.active === undefined
        ? { tabs: [...entry.tabs] }
        : { tabs: [...entry.tabs], active: entry.active };
  }
  return copy;
}

/** 最初の配置の枠の写し */
export function initialDocks(): DockState {
  return cloneDocks(INITIAL_DOCKS);
}

/**
 * 最初の配置の枠から、ids の窓を除いたもの (v1 で位置を覚えていた窓は浮いた窓のまま読む。C2.6)。
 * 窓が残らない枠は鍵ごと持たない
 */
function initialDocksWithout(ids: readonly WindowId[]): DockState {
  const docks: DockState = {};
  for (const slot of DOCK_SLOT_IDS) {
    const tabs = INITIAL_DOCKS[slot]?.tabs.filter((id) => !ids.includes(id)) ?? [];
    if (tabs.length > 0) docks[slot] = { tabs };
  }
  return docks;
}

/**
 * 最初の配置の組 (浮いた窓の位置は無く、枠は INITIAL_DOCKS)。呼ぶたびに新しい組を返す (書き換えても共有しない)
 */
export function initialWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: {}, docks: initialDocks() };
}
```

`isRecord` の関数 (95〜98 行目) の**直後**に次を足す。

```typescript
function isWindowId(value: unknown): value is WindowId {
  return typeof value === "string" && (WINDOW_IDS as readonly string[]).includes(value);
}

/**
 * その窓をその枠に入れられるか (C2.5)。**バーは右の枠に入れない**: バーの最小の幅 480px (フロートの窓の spec A.1。
 * 拡大バーの精度) が右の列の幅 (1920x1080 で 544px、1440x795 で 400px 前後) より広く、入れると最小の幅より
 * 狭くなるか列からはみ出す
 */
export function acceptsDock(id: WindowId, slot: DockSlotId): boolean {
  return !(id === "bar" && slot === "side");
}

/**
 * 覚えた枠の中身を読む (C2.6)。**型は保証されない。** 使えないものは捨てて warn する (ほかは使う):
 *
 * - 組でない → どの枠も空
 * - 枠ごと: 組でない・`tabs` が配列でない → その枠を捨てる
 * - `tabs` の窓: 知らない名前・既に入っている窓 (同じ枠の重複は先頭、別の枠との重複は below → side の先を残す。
 *   窓は 1 つの枠にしか入らない)・入れられない組み合わせ (右の枠のバー。acceptsDock) を捨てる。残りが無い枠は鍵ごと持たない
 * - `active` が `tabs` に無ければ無い扱い (前のタブは見えているタブの先頭になる)
 *
 * 無いだけ (undefined) なら空として読み、warn しない。知らない枠の名前は黙って無視する (後の版で枠が増えても
 * 古い版が騒がない。float の知らない窓と同じ)
 */
export function parseDockState(value: unknown): DockState {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    console.warn(
      `[yt-clip] 保存された windowLayout.docks が使えないため、どの窓も枠に入れません: ${JSON.stringify(value)}`,
    );
    return {};
  }
  const docks: DockState = {};
  /** 既にどこかの枠に入れた窓。窓は 1 つの枠にしか入らない */
  const seen = new Set<WindowId>();
  for (const slot of DOCK_SLOT_IDS) {
    const entry = value[slot];
    if (entry === undefined) continue;
    const rawTabs: unknown = isRecord(entry) ? entry.tabs : undefined;
    if (!isRecord(entry) || !Array.isArray(rawTabs)) {
      console.warn(
        `[yt-clip] 保存された windowLayout.docks.${slot} が使えないため捨てます: ${JSON.stringify(entry)}`,
      );
      continue;
    }
    const tabs: WindowId[] = [];
    for (const tab of rawTabs as unknown[]) {
      if (!isWindowId(tab) || seen.has(tab) || !acceptsDock(tab, slot)) {
        console.warn(
          `[yt-clip] 保存された windowLayout.docks.${slot}.tabs の ${JSON.stringify(tab)} を捨てます (知らない窓・重複・入れられない枠)`,
        );
        continue;
      }
      seen.add(tab);
      tabs.push(tab);
    }
    if (tabs.length === 0) continue;
    const active = entry.active;
    if (active === undefined) {
      docks[slot] = { tabs };
    } else if (isWindowId(active) && tabs.includes(active)) {
      docks[slot] = { tabs, active };
    } else {
      console.warn(
        `[yt-clip] 保存された windowLayout.docks.${slot}.active (${JSON.stringify(active)}) が tabs に無いため捨てます`,
      );
      docks[slot] = { tabs };
    }
  }
  return docks;
}
```

`mergeWindowLayout` の doc と本体 (132〜168 行目。`/**` の「覚えた配置を読む (C1.3)。」から関数の閉じ括弧まで) を次に置き換える。

```typescript
/**
 * 覚えた配置を読む (C1.3 / C2.6)。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 *
 * - 何も覚えていない・組でない → 最初の配置 (ドック。INITIAL_DOCKS)
 * - `version` のキーが無ければ古い形 (v1: `{ bar?, panel? }`)。`bar` → `float.bar`、`panel` → `float.list`
 *   に読み替える。**位置を覚えていた窓は浮いた窓のまま**、位置の無い窓 (`settings` を含む) は最初の配置の枠に入れる
 *   (A で自分で動かした窓を黙ってドックへ移さない)。**読み替えた組は書き戻さない** (読み込みは書かない。
 *   次に動かしたときに v2 で書く)
 * - `version` が 2 なら v2 を書いてあるとおりに読む (`docks: {}` なら 3 つとも浮いた窓)。`float` と `docks` は**無いだけなら空**
 *   として読む (正しい float まで捨てない)。組でなければ、その部分だけ捨てて warn する。枠の中身は parseDockState が確かめる
 * - それ以外の `version` (後の版が書いた 3 など) は形が分からないので、推測で読まずに warn して最初の配置
 *
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて warn する。握りつぶさず理由は残す (設定の mergeSettings と同じ作法)。
 * **同じ窓が float と docks の両方にあれば枠に入る** (float の値は引き出したときの大きさにだけ使うので捨てない。C2.1 / C2.6)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return initialWindowLayout();
  if (!isRecord(stored)) {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の配置を使います: ${JSON.stringify(stored)}`,
    );
    return initialWindowLayout();
  }
  if (!("version" in stored)) {
    const float = readRects(stored, V1_KEYS, "");
    const placed = WINDOW_IDS.filter((id) => float[id] !== undefined);
    return { version: WINDOW_LAYOUT_VERSION, float, docks: initialDocksWithout(placed) };
  }
  if (stored.version !== WINDOW_LAYOUT_VERSION) {
    console.warn(
      `[yt-clip] 保存された windowLayout の版 (${JSON.stringify(stored.version)}) を読めないため最初の配置を使います`,
    );
    return initialWindowLayout();
  }
  const float: unknown = stored.float === undefined ? {} : stored.float;
  if (!isRecord(float)) {
    console.warn(
      `[yt-clip] 保存された windowLayout.float が使えないため、浮いた窓を最初の位置に置きます: ${JSON.stringify(float)}`,
    );
  }
  return {
    version: WINDOW_LAYOUT_VERSION,
    float: isRecord(float) ? readRects(float, V2_KEYS, "float.") : {},
    docks: parseDockState(stored.docks),
  };
}
```

`loadWindowLayout` の catch の

```typescript
    console.warn(`[yt-clip] 窓の位置を読めないため最初の位置を使います: ${String(error)}`);
    return emptyWindowLayout();
```

を次に置き換える。

```typescript
    console.warn(`[yt-clip] 窓の配置を読めないため最初の配置を使います: ${String(error)}`);
    return initialWindowLayout();
```

同じ関数の doc の「warn を残して空の組を返し、窓は最初の位置で出る」を「warn を残して最初の配置の組を返し、窓は最初の配置で出る」に直す。

`toStored` (246〜263 行目。26eaebd の時点) の中の

```typescript
  const docks: Partial<Record<DockSlotId, DockState>> = {};
  for (const slot of DOCK_SLOT_IDS) {
    const dock = layout.docks[slot];
    if (dock === undefined) continue;
    docks[slot] =
      dock.active === undefined
        ? { tabs: [...dock.tabs] }
        : { tabs: [...dock.tabs], active: dock.active };
  }
  return { version: WINDOW_LAYOUT_VERSION, float, docks };
```

を次に置き換える。

```typescript
  return { version: WINDOW_LAYOUT_VERSION, float, docks: cloneDocks(layout.docks) };
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: PASS (v2 で `docks: {}` を書いた値の検査は `EMPTY` のまま通る)

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`DockState` の意味が変わったが、`src` で使っているのはこのファイルだけ。`git grep -n 'DockState\|emptyWindowLayout' -- src tests` で
確かめる。`emptyWindowLayout` が残っていれば改名し忘れ)。youtube.ts はまだ `docks` を読み書きしない (Task 7・8 で配線する) ので、
この時点では画面は変わらない

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/window-layout.ts tests/content/window-layout.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 覚えた配置の枠の中身を確かめて読み、最初の配置をドックにする

ドック枠を入れると、手で書き換えた値や古い版の値で同じ窓が 2 つの
枠に入ったり、バーが右の枠に入ったりしうる。窓ごと・枠ごとに warn して
捨て、壊れた部分以外は使う。docks が無いだけで正しい float まで捨てて
いたのも直す。最初の配置はドックとユーザーが決めたので、INITIAL_DOCKS
の 1 か所に置き、何も覚えていないとき・読めないとき・古い形で位置の
無い窓に当てる。古い形で位置を覚えていた窓は浮いた窓のまま読む。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: 窓の枠をページの中に入れられるようにする (`setDocked`)。使わなくなった `headerActions` / `bodyShown` を消す

**Files:**
- Modify: `src/content/styles.ts:207-232` (`FLOATING_WINDOW_STYLE`)
- Modify: `src/content/floating-window.ts` (ファイル全体を置き換える。26eaebd の版からの差分は `headerActions` / `bodyShown` の削除と `docked` / `setDocked` / `replaceStyle` の追加だけ)
- Test: `tests/content/floating-window.test.ts`、`tests/content/styles.test.ts`、`tests/content/panel-window.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `FloatingWindow.setDocked(docked: boolean): void` — true でページの流れの中の見た目 (`FLOATING_WINDOW_STYLE.docked`)、見出しと右下の
    つまみを隠し、重なり順から外れる。place / refit / resize では位置を当てず `requested` だけを覚え、`rect()` は `requested` を返す。
    false で浮いた窓の見た目に戻り、`requested` から詰めて置き、いちばん上に出す。同じ値で呼んだら何もしない
  - `FloatingWindow` から `headerActions` が無くなる
  - `FLOATING_WINDOW_STYLE.docked: string` (display を持たない)。`FLOATING_WINDOW_STYLE.headerActions` は無くなる

- [ ] **Step 1: 失敗するテストを書く (と、消える部品の検査を直す)**

`tests/content/styles.test.ts` の `describe("フロートの窓")` の中、「右下のつまみは 16px 四方」のテストの**後**に次を足す。

```typescript
  test("ドック中はページの流れの中 (static)・幅いっぱい・影なし・角丸 8px・z-index auto。display は持たない", () => {
    const docked = FLOATING_WINDOW_STYLE.docked;
    for (const rule of [
      "position:static",
      "width:100%",
      "box-shadow:none",
      "border-radius:8px",
      "z-index:auto",
      "background:var(--ytc-panel)",
    ]) {
      expect(docked).toContain(rule);
    }
    expect(docked).not.toContain("display");
  });

  test("見出しの右側の部品の箱は持たない (置く部品が無い)", () => {
    expect("headerActions" in FLOATING_WINDOW_STYLE).toBe(false);
  });
```

`tests/content/floating-window.test.ts` の次のテスト

```typescript
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
```

を次に置き換える。

```typescript
  test("見出しのある窓は、見出しの文言を持つ", () => {
    const { frame } = makeWindow({ title: "yt-clip" });
    const header = headerOf(frame);
    expect(header.textContent).toBe("yt-clip");
    expect(frame.element.contains(frame.body)).toBe(true);
  });

  test("見出しの無い窓は見出しの行を作らない", () => {
    const { frame } = makeWindow({ title: undefined });
    expect(frame.element.querySelector("[data-role='window-header']")).toBeNull();
  });
```

「見出しの中のボタンを押してドラッグしても動かない」のテストの中の

```typescript
    frame.headerActions?.append(button);
```

を次に置き換える (見出しの右側の箱は無くなったので、見出しに直接置く)。

```typescript
    headerOf(frame).append(button);
```

「見出しのダブルクリックで onResetRequest を呼ぶ。見出しの中のボタンでは呼ばない」のテストの中の

```typescript
    frame.headerActions?.append(button);
```

も同じく次に置き換える。

```typescript
    headerOf(frame).append(button);
```

次のテストを**消す** (本体を隠す者はいない。右下のつまみの出し入れは setDocked が持つ)。

```typescript
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
```

`describe("重なり順とダブルクリック")` の**後** (ファイルの末尾) に次を足す。

```typescript
describe("ページの中の枠に入れる (setDocked)", () => {
  test("setDocked(true) でページの流れの中の見た目になり、見出しと右下のつまみを隠す", () => {
    const { frame } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400, height: 300 });

    frame.setDocked(true);

    expect(frame.element.style.position).toBe("static");
    expect(frame.element.style.width).toBe("100%");
    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.top).toBe("");
    expect(frame.element.style.height).toBe("");
    expect(frame.element.style.zIndex).toBe("auto");
    // 出ている窓は出たまま (出し入れは setVisible が持つ)
    expect(frame.element.style.display).toBe("flex");
    expect(headerOf(frame).style.display).toBe("none");
    expect(resizeGripOf(frame).hidden).toBe(true);
  });

  test("隠れている窓は、入れても隠れたまま", () => {
    const { frame } = makeWindow();
    frame.setVisible(false);
    frame.setDocked(true);
    expect(frame.element.hidden).toBe(true);
    expect(frame.element.style.display).toBe("none");
  });

  test("ドック中の place は位置を当てず、求められた位置と大きさを覚える (rect はその値)", () => {
    const { frame } = makeWindow();
    frame.setDocked(true);

    frame.place({ left: 10, top: 60, width: 500, height: 200 });

    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.width).toBe("100%");
    expect(frame.rect()).toEqual({ left: 10, top: 60, width: 500, height: 200 });
  });

  test("ドック中は window の resize でも refit でも詰めない", () => {
    const { frame } = makeWindow();
    frame.setDocked(true);
    setViewport(300, 300);
    window.dispatchEvent(new Event("resize"));
    frame.refit();
    expect(frame.element.style.left).toBe("");
    expect(frame.element.style.position).toBe("static");
  });

  test("setDocked(false) で浮いた窓に戻り、覚えた位置と大きさから詰めて置き、いちばん上に出す", () => {
    const other = makeWindow().frame;
    const { frame } = makeWindow();
    frame.setDocked(true);
    // 上端は 60 (fitRect は YouTube のヘッダーの下 56px より上へ詰めるので、詰められない値で測る)
    frame.place({ left: 10, top: 60, width: 500, height: 200 });
    pointer(other.body, "pointerdown", 0, 0);

    frame.setDocked(false);

    expect(frame.element.style.position).toBe("fixed");
    expect(styleOf(frame)).toEqual({ left: "10px", top: "60px", width: "500px", height: "200px" });
    expect(headerOf(frame).style.display).toBe("flex");
    expect(resizeGripOf(frame).hidden).toBe(false);
    expect(Number(frame.element.style.zIndex)).toBeGreaterThan(Number(other.element.style.zIndex));
  });

  test("ドック中の窓は重なり順に加わらない (押しても bringToFront でも、ほかの浮いた窓の順を変えない)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    c.setDocked(true);
    pointer(a.body, "pointerdown", 0, 0);
    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);

    pointer(c.body, "pointerdown", 0, 0);
    c.bringToFront();

    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);
    expect(c.element.style.zIndex).toBe("auto");
  });

  test("入れても出しても、窓に当てた配色の変数 (--ytc-*) は残す (消えると浮いた窓の地と縁が透ける)", () => {
    const { frame } = makeWindow();
    // youtube.ts の applyPalette と同じく、窓の要素の inline の custom property に配色を書く
    frame.element.style.setProperty("--ytc-panel", "#212121");
    frame.element.style.setProperty("--ytc-border", "#5a5a5a");

    frame.setDocked(true);
    expect(frame.element.style.getPropertyValue("--ytc-panel")).toBe("#212121");

    frame.setDocked(false);
    expect(frame.element.style.getPropertyValue("--ytc-panel")).toBe("#212121");
    expect(frame.element.style.getPropertyValue("--ytc-border")).toBe("#5a5a5a");
    expect(frame.element.style.position).toBe("fixed");
  });

  test("同じ値で呼んでも何もしない (浮いた窓に setDocked(false) で、重なり順を変えない)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    b.setDocked(false);
    expect([a.element.style.zIndex, b.element.style.zIndex]).toEqual(["2001", "2000"]);
  });
});
```

同じファイルのヘルパ (`resizeGripOf` の後) に次を足す (位置と大きさの 4 つだけを読む)。

```typescript
/** 窓の枠に当てた位置と大きさ */
function styleOf(frame: FloatingWindow): { left: string; top: string; width: string; height: string } {
  const { left, top, width, height } = frame.element.style;
  return { left, top, width, height };
}
```

`tests/content/panel-window.test.ts` の「見出しに中身の名前を出す。折り畳みのボタンは持たない」のテストの中の次の行を**消す**。

```typescript
    expect(target.frame.headerActions?.children.length).toBe(0);
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/styles.test.ts tests/content/panel-window.test.ts` (Bash の timeout 120000)
期待: FAIL。`frame.setDocked is not a function`、`FLOATING_WINDOW_STYLE.docked` が undefined (`toContain` で落ちる)、
「見出しの右側の部品の箱は持たない」が true で落ちる。「見出しのある窓は、見出しの文言を持つ」も見出しの中に空の箱があるので
`toBe("yt-clip")` は通る (文言は同じ)

- [ ] **Step 3: 最小実装**

`src/content/styles.ts` の `FLOATING_WINDOW_STYLE` (207〜232 行目。doc コメントの `/**` から `} as const;` まで) を次に置き換える。

```typescript
/**
 * フロートの窓の枠 (`floating-window.ts`)。バーの窓・区間・テロップの窓・設定の窓で同じものを使う。
 *
 * **`root`・`docked`・`resizeGrip` は display を持たない。** 出し入れは `floating-window.ts` が
 * `style.display` で行う。ここに display を書くと、`hidden` を立てても inline の display が
 * 勝って出たままになる。位置・大きさ・重なり順も `floating-window.ts` が決める
 */
export const FLOATING_WINDOW_STYLE = {
  /** 下のページが透けると読めないので、不透明な地と影を付ける */
  root: `position:fixed;flex-direction:column;box-sizing:border-box;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:${FONT};font-size:13px;`,
  /**
   * ページの中の枠に入っている間 (窓の分割の spec C2.8)。**ページの流れの中** (static) で枠の幅いっぱい。
   * ページに埋まるので影は付けず、角丸は枠に合わせて小さくする。z-index は効かないので auto
   */
  docked: `position:static;flex-direction:column;box-sizing:border-box;width:100%;overflow:hidden;background:var(--ytc-panel);color:var(--ytc-text);border:1px solid var(--ytc-border);border-radius:8px;box-shadow:none;z-index:auto;font-family:${FONT};font-size:13px;`,
  /**
   * 見出し。空いたところを掴んで動かす。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  header:
    "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;user-select:none;touch-action:none;",
  title: "flex:1;color:var(--ytc-text);font-size:13px;font-weight:600;",
  /**
   * 右下の角のつまみ (16px 四方。spec A.1)。カーソルは窓の向き (幅だけ / 幅と高さ) で
   * `floating-window.ts` が足す
   */
  resizeGrip:
    "position:absolute;right:0;bottom:0;width:16px;height:16px;touch-action:none;background:linear-gradient(135deg,transparent 50%,var(--ytc-border) 50%);",
} as const;
```

`src/content/floating-window.ts` を次の内容に置き換える (C1 からの変更: `headerActions` と `bodyShown` の分岐を消し、`docked` と
`setDocked` と、配色の変数 (`--ytc-*`) を残して見た目を置き換える `replaceStyle` を足した。重なり順・ドラッグ・詰め方はそのまま)。

```typescript
import { FLOATING_WINDOW_STYLE } from "@/content/styles";
import { fitRect, type GripBox, type WindowRect } from "@/content/window-layout";

export type { WindowRect } from "@/content/window-layout";

/**
 * 画面の上に浮いた窓の枠 (`.claude/specs/2026-09-24-floating-windows-design.md` A.3)。
 *
 * **枠だけを持つ**: 見出し・本体の箱・右下のつまみ・ドラッグで動かす・大きさを変える・
 * 画面の中に詰める・重なり順・ページの中の枠に入っている間の見た目 (`setDocked`。
 * `.claude/specs/2026-09-25-dockable-windows-design.md` C2.8)。中身と「いつ出すか・最初にどこへ置くか・
 * どの枠に入れるか」は知らない (panel-window.ts・dock.ts・youtube.ts が決める)。3 つの窓で同じ処理を
 * 何度も書かないために 1 つにしている
 */

/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は panel-window.ts の
 * 実測のコメント) より下**、ページ本体より上。窓が重なったら、**触った順が新しいほど上**
 * (Z_BASE + 触った順。窓は 3 つなので最大 2002。窓の分割の spec C1.1)。
 * 「最後に触った窓だけ 1 つ上げ、残りは同じ値」にしない: 窓が 3 つになると残り 2 つの順が
 * DOM の順で決まり、直前に触った窓がその前に触った窓の下に潜る
 */
const Z_BASE = 2000;
/**
 * 高さを決めていない「幅と高さ」の窓 (区間・テロップの窓・設定の窓) の下端と、画面の下端との間。右側パネルだったときの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/**
 * 今ある浮いた窓の枠を、下から上への順に並べたもの (末尾がいちばん上)。作った窓は**いちばん下**に
 * 入れる。まだ触っていない窓が、触った窓の上に出ないように。**ページの中の枠に入っている窓は外す** (setDocked)
 */
let stack: HTMLElement[] = [];

/**
 * target をいちばん上にし、すべての窓の z-index を並びどおりに振り直す。**毎回全部を振り直す。**
 * 上げた窓だけに値を足していくと、触るたびに値が伸びて YouTube のヘッダー (2020) を越える
 */
function raise(target: HTMLElement): void {
  stack = [...stack.filter((element) => element !== target), target];
  stack.forEach((element, index) => {
    element.style.zIndex = String(Z_BASE + index);
  });
}

/**
 * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (バーの操作の行のボタンを
 * 押したら、そのボタンの操作だけ。spec A.1)
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
  /** この要素を押してドラッグすると窓が動く (中のボタンを押したときは動かさない) */
  addDragHandle(element: HTMLElement): void;
  /** 中身の箱。見た目 (余白・スクロール・出し入れ) は中身を入れる側が決める */
  body: HTMLElement;
  setVisible(visible: boolean): void;
  /** 位置と大きさを置く。画面に収まるよう詰める。**ページの中の枠に入っている間は当てずに覚えるだけ** */
  place(rect: WindowRect): void;
  /** 今の位置と大きさ (詰めた後)。枠に入っている間は、最後に place で求められた位置と大きさ */
  rect(): WindowRect;
  /**
   * 最後に place (またはドラッグ) で置いた位置と大きさから、画面に詰め直す (テロップの帯の段が出る・消えて窓の
   * 高さが変わったとき)。place(rect()) で代えない: 詰めた後の位置で置いた場所を上書きし、ブラウザを大きく戻しても
   * 戻らない
   */
  refit(): void;
  /**
   * この窓をいちばん上に出す (窓のどこかを押したときと同じ)。押していないのに前に出したいとき
   * (⚙ で設定の窓を開いたとき) に youtube.ts が呼ぶ。枠に入っている間は何もしない
   */
  bringToFront(): void;
  /**
   * ページの中の枠に入れる (true) / 出す (false) (C2.8)。入れている間は `position: static`・幅いっぱい・影なしで
   * ページの流れに任せ、見出しの行 (文言はタブが持つ) と右下のつまみ (大きさは枠が決める) を隠し、重なり順にも
   * 加わらない。place / refit / resize では位置を当てず、求められた位置と大きさ (requested) だけを覚える。
   * 出すと浮いた窓の見た目に戻り、requested から詰めて置き、いちばん上に出す (引き出した窓はいま触っている窓)。
   * **枠のどこに置くか (DOM の親) は dock.ts が決める**
   */
  setDocked(docked: boolean): void;
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
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BASE};`;

  let header: HTMLElement | null = null;
  if (options.title !== undefined) {
    header = document.createElement("div");
    header.dataset.role = "window-header";
    header.style.cssText = FLOATING_WINDOW_STYLE.header;
    const title = document.createElement("span");
    title.style.cssText = FLOATING_WINDOW_STYLE.title;
    title.textContent = options.title;
    header.append(title);
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
   * ページの中の枠に入っているか (C2.8)。入っている間は位置を当てず (ページの流れが決める)、requested だけを覚える
   * (引き出したときの大きさを youtube.ts が覚えた float から決めるので、ここの値は使われなくてもよい)
   */
  let docked = false;

  /**
   * 掴む場所の箱 (窓の左上から)。登録した中で窓の中にある、いちばん新しいもの。
   * 隠れている窓では寸法が 0 になるので、出すときに測り直す (setVisible)
   */
  function gripBox(): GripBox {
    const handle = [...handles].reverse().find((candidate) => element.contains(candidate));
    if (handle === undefined) return { left: 0, top: 0, width: 0, height: 0 };
    const frame = element.getBoundingClientRect();
    const box = handle.getBoundingClientRect();
    // **見出しは窓の縁 (1px) まで含めて数える。** 見出しは窓の幅いっぱいで縁の内側にあるので、
    // 見出しの箱のままだと右端・上端に寄せたときに縁が 1px 画面の外へ出る (spec A.1)。
    // バーのつまみは窓の中の小さな箱なので、そのまま測る (縁まで広げると窓全体が掴む場所になる)
    if (handle === header) {
      return { left: 0, top: 0, width: frame.width, height: box.bottom - frame.top };
    }
    return {
      left: box.left - frame.left,
      top: box.top - frame.top,
      width: box.width,
      height: box.height,
    };
  }

  /**
   * 見た目 (cssText) を丸ごと置き換える。**配色の変数 (`--ytc-*`) は残す**: youtube.ts の applyPalette は同じ要素の inline の
   * custom property に配色を書くので、cssText の置き換えで消えると `var(--ytc-panel)` などが解決できず、枠から引き出した・
   * 退避した浮いた窓の地が透け、縁も消える (テーマを切り替えるまで戻らない)。`--` で始まる inline のプロパティを拾って戻す
   */
  function replaceStyle(cssText: string): void {
    const custom: [string, string][] = [];
    for (let index = 0; index < element.style.length; index += 1) {
      const name = element.style.item(index);
      if (name.startsWith("--")) custom.push([name, element.style.getPropertyValue(name)]);
    }
    element.style.cssText = cssText;
    for (const [name, value] of custom) element.style.setProperty(name, value);
  }

  /** 位置と大きさを画面に詰めて当てる。**枠に入っている間は呼ばない** (呼ぶ側が docked を見る) */
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
    if (fitted.height !== undefined) {
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
    // このドラッグを起こした指だけを追う。**違う pointerId の move / up / cancel は無視する**
    // (2 本目の指が同じ要素に触れても、こちらの位置を横から書き換えない)
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = current;
    // 高さを決めていない窓を縦に広げるときは、今の見た目の高さから始める
    const startHeight = start.height ?? element.getBoundingClientRect().height;
    source.setPointerCapture(pointerId);

    /** ドラッグを終わらせる。捕捉とリスナをまとめて解く (range-bar.ts の拡大バーと同じ作法) */
    const finish = (): void => {
      source.releasePointerCapture(pointerId);
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointerup", onSettle);
      source.removeEventListener("pointercancel", onSettle);
      source.removeEventListener("lostpointercapture", onSettle);
    };

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (kind === "move") {
        apply({ ...start, left: start.left + dx, top: start.top + dy });
      } else if (options.resize === "both") {
        // 高さを決めていない窓は、実際に縦へ動いた (dy !== 0) ときだけ高さを持たせる。
        // 移動量 0 の pointermove (押して動かさずに離す) だけで height が入ると、元は
        // undefined だった height が定義された値になり、sameRect が false になって
        // クリックしただけで onUserMove が呼ばれてしまう
        apply(
          start.height !== undefined || dy !== 0
            ? { ...start, width: start.width + dx, height: startHeight + dy }
            : { ...start, width: start.width + dx },
        );
      } else {
        apply({ ...start, width: start.width + dx });
      }
    };

    // pointercancel (タッチの横取りなど)・lostpointercapture (要素が DOM から外れる、
    // ほかが捕捉を奪うなど) でも終える。pointerup が来ないままドラッグが宙に浮くのを防ぐ。
    // そこまでに動かした位置は、画面に出ているとおりに確定する (拡大バーのハンドルと同じ)
    const onSettle = (settled: Event): void => {
      const settledPointerId = (settled as PointerEvent).pointerId;
      // lostpointercapture は座標を持たない。current (最後の pointermove で反映済み) を使う
      if (settledPointerId !== undefined && settledPointerId !== pointerId) return;
      finish();
      requested = current;
      // 押して離しただけ (クリックやダブルクリックの 1 回目) は知らせない。知らせると
      // 「動かした窓」になり、最初の位置を取り直さなくなる
      if (sameRect(start, current)) return;
      options.onUserMove({ ...current });
    };

    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onSettle);
    source.addEventListener("pointercancel", onSettle);
    source.addEventListener("lostpointercapture", onSettle);
  }

  function addDragHandle(handle: HTMLElement): void {
    // 窓から外れた古い掴む場所 (作り直したバーの前のつまみ) は捨てる。持ち続けると溜まる
    handles = handles.filter((candidate) => element.contains(candidate));
    // 同じ要素を 2 回登録しない。listener を重ねて足すと、1 回のドラッグに 2 重に反応する
    if (handles.includes(handle)) return;
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

  // 窓のどこを押しても、その窓を上にする (触った順が新しいほど上。窓の分割の spec C1.1)。捕捉の
  // 段階で拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため。
  // **枠に入っている窓は重なり順に加わらない** (押しても、ほかの浮いた窓の順を変えない。C2.8)
  element.addEventListener(
    "pointerdown",
    () => {
      if (!docked) raise(element);
    },
    true,
  );
  resizeGrip.addEventListener("pointerdown", (event: PointerEvent) => {
    beginDrag(resizeGrip, "resize", event);
  });
  if (header !== null) addDragHandle(header);

  /**
   * ブラウザの大きさが変わったら、掴む場所が画面に残るよう詰め直す。**詰めた後の位置ではなく
   * 置いた場所 (requested) から詰める** (小さくしてから戻すと、置いた場所に戻る)。枠に入っている間は
   * ページの流れが決めるので詰めない
   */
  const onResize = (): void => {
    if (!docked) apply(requested);
  };
  window.addEventListener("resize", onResize);
  stack = [element, ...stack];

  apply(requested);
  // 中身が入り、出す判断がされるまでは出さない。空の枠だけを出さない
  element.hidden = true;
  element.style.display = "none";

  return {
    element,
    body,
    addDragHandle,

    setVisible(visible: boolean): void {
      const wasHidden = element.hidden;
      // 出し入れは hidden と style.display の両方で行う。root は flex で並べるので display を
      // 持ち、inline の display は UA の [hidden] { display: none } に勝つ。hidden は外から
      // 「出ているか」を読むために残す (dock.ts もタブを出すかをこれで決める)
      element.hidden = !visible;
      element.style.display = visible ? "flex" : "none";
      // 隠れている間は掴む場所の寸法が 0 で、詰め方を測れていない。出した直後に詰め直す。
      // **出ている間は置き直さない** (ドラッグ中に状態の通知で呼ばれても、指の下の窓を戻さない)。
      // 枠に入っている間は位置を当てない
      if (visible && wasHidden && !docked) apply(requested);
    },

    place(rect: WindowRect): void {
      requested = { ...rect };
      // 枠に入っている間は覚えるだけ。位置はページの流れが決める
      if (!docked) apply(requested);
    },

    rect(): WindowRect {
      // 枠に入っている間は画面の位置を持たない。覚えている (求められた) 位置と大きさを返す
      return docked ? { ...requested } : { ...current };
    },

    refit(): void {
      if (!docked) apply(requested);
    },

    bringToFront(): void {
      if (!docked) raise(element);
    },

    setDocked(next: boolean): void {
      if (next === docked) return;
      docked = next;
      // cssText を置き換えると出し入れ (setVisible) の display も消えるので、今の出し入れを当て直す
      const display = element.hidden ? "none" : "flex";
      if (docked) {
        // 重なり順から外す。ページの流れの中の要素に z-index は効かず、押してもほかの浮いた窓の順を変えない
        stack = stack.filter((candidate) => candidate !== element);
        replaceStyle(FLOATING_WINDOW_STYLE.docked);
      } else {
        replaceStyle(FLOATING_WINDOW_STYLE.root);
        // 引き出した窓はいま触っている窓なので、いちばん上に出す (z-index もここで当て直す)
        raise(element);
      }
      element.style.display = display;
      // 見出しの文言はタブが持ち、大きさは枠が決める (C2.8)
      if (header !== null) header.style.display = docked ? "none" : "flex";
      resizeGrip.hidden = docked;
      resizeGrip.style.display = docked ? "none" : "";
      if (!docked) apply(requested);
    },

    destroy(): void {
      window.removeEventListener("resize", onResize);
      stack = stack.filter((candidate) => candidate !== element);
      element.remove();
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/styles.test.ts tests/content/panel-window.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS。`git grep -n 'headerActions\|bodyShown' -- src tests e2e scripts` が何も出さない

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/styles.ts src/content/floating-window.ts tests/content/floating-window.test.ts tests/content/styles.test.ts tests/content/panel-window.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓の枠をページの中の枠に入れた見た目に切り替えられるようにする

ドック枠に入った窓は、ページの流れの中で枠の幅いっぱいに並び、
画面の位置で詰めたり重なり順を振ったりしてはいけない。見出しと
右下のつまみも枠とタブが代わりを持つ。setDocked で見た目を切り替え、
入っている間の place は覚えるだけにする。折り畳みをやめて使われなく
なった見出しの右側の箱と、本体を隠したときの分岐はここで消す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: ドラッグの指の位置を外へ知らせ、枠からの引き出しとタブからの移動を続けられるようにする

**Files:**
- Modify: `src/content/floating-window.ts` (Task 3 の版の `isOnControl` の前・`FloatingWindow` 型・`FloatingWindowOptions` 型・`beginDrag` 全体・戻り値)
- Modify: `src/content/panel-window.ts:1-7` (import)、`:51-52` の後 (定数)、`:73-82` (`PanelWindowOptions`)、`:112-120` (`createFloatingWindow` の呼び出し)
- Test: `tests/content/floating-window.test.ts`、`tests/content/panel-window.test.ts`

**Interfaces:**
- Consumes: Task 3 の `FloatingWindow.setDocked` と `docked` の状態
- Produces:
  - `export const UNDOCK_THRESHOLD_PX = 8` (floating-window.ts。dock.ts のタブも使う)
  - `export type DragPoint = { x: number; y: number }`、`export type DragPhase = "start" | "move" | "end"`
  - `FloatingWindowOptions.onDragPoint?(phase: DragPhase, point: DragPoint): boolean` — 窓を動かすドラッグの start (動かし始めたときに
    開始点で) / move / end。end で true を返すと `onUserMove` を呼ばない
  - `FloatingWindowOptions.onUndockRequest?(point: DragPoint, grab: DragPoint): void` — ドック中の掴む場所を 8px 動かした。grab は窓の
    左上から見た押した点。呼ばれた側が `setDocked(false)` して `place` する
  - `FloatingWindow.beginMoveFrom(source: HTMLElement, event: PointerEvent, origin: DragPoint): void` — 窓の外の要素で始まったドラッグを
    窓の移動として続ける。ドック中に呼ぶと throw。続きのドラッグは、動かさずに離しても `onUserMove` を呼ぶ
  - `PanelWindowOptions.onDragPoint?(phase: DragPhase, point: DragPoint): boolean` (窓の枠へそのまま渡す)
  - `export const PANEL_HEADER_HEIGHT_PX = 32` (panel-window.ts)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/floating-window.test.ts` の import を次に置き換える。

```typescript
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  UNDOCK_THRESHOLD_PX,
  createFloatingWindow,
  type FloatingWindow,
  type FloatingWindowOptions,
} from "@/content/floating-window";
```

`makeBarLikeWindow` を次に置き換える (options を足せるようにする)。

```typescript
/** バーの窓と同じ形 (見出し無し・幅だけ・つまみを登録) */
function makeBarLikeWindow(overrides: Partial<FloatingWindowOptions> = {}) {
  const made = makeWindow({
    title: undefined,
    resize: "width",
    minWidth: 480,
    minHeight: undefined,
    ...overrides,
  });
  const grip = document.createElement("span");
  made.frame.body.append(grip);
  made.frame.addDragHandle(grip);
  return { ...made, grip };
}
```

同じファイルのヘルパ (`styleOf` の後) に次を足す。

```typescript
/** onDragPoint の形 (vi.fn の呼び出しの記録を型付きで読むため) */
type DragPointFn = NonNullable<FloatingWindowOptions["onDragPoint"]>;

/** jsdom は PointerEvent を持たない。beginMoveFrom に渡す pointermove を MouseEvent で作る */
function moveEvent(x: number, y: number): PointerEvent {
  return new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }) as PointerEvent;
}
```

ファイルの末尾に次を足す。

```typescript
describe("落とし先へ指の位置を知らせる (onDragPoint)", () => {
  test("動かし始めたときに開始点で start、動くたびに move、離すと end", () => {
    const onDragPoint = vi.fn<DragPointFn>(() => false);
    const { frame, onUserMove } = makeWindow({ onDragPoint });
    frame.place({ left: 100, top: 100, width: 400 });

    drag(headerOf(frame), 30, 20);

    expect(onDragPoint.mock.calls).toEqual([
      ["start", { x: 100, y: 100 }],
      ["move", { x: 130, y: 120 }],
      ["end", { x: 130, y: 120 }],
    ]);
    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  test("押して動かさずに離したときは知らせない", () => {
    const onDragPoint = vi.fn<DragPointFn>(() => false);
    const { frame } = makeWindow({ onDragPoint });
    pointer(headerOf(frame), "pointerdown", 100, 100);
    pointer(headerOf(frame), "pointerup", 100, 100);
    expect(onDragPoint).not.toHaveBeenCalled();
  });

  test("end で true が返ったら (枠に引き取られた) onUserMove を呼ばない", () => {
    const { frame, onUserMove } = makeWindow({ onDragPoint: (phase) => phase === "end" });
    frame.place({ left: 100, top: 100, width: 400 });
    drag(headerOf(frame), 30, 20);
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("大きさを変えるドラッグでは知らせない", () => {
    const onDragPoint = vi.fn<DragPointFn>(() => false);
    const { frame } = makeWindow({ onDragPoint });
    frame.place({ left: 100, top: 100, width: 400, height: 300 });
    drag(resizeGripOf(frame), 30, 20);
    expect(onDragPoint).not.toHaveBeenCalled();
  });
});

describe("ドック中の掴む場所から引き出す (onUndockRequest)", () => {
  test(`ドック中の掴む場所は ${UNDOCK_THRESHOLD_PX}px 動くまで窓を動かさず、動いたら押した点の窓の中の位置と一緒に知らせる`, () => {
    let made: ReturnType<typeof makeBarLikeWindow> | null = null;
    const onUndockRequest = vi.fn(() => {
      // 呼ばれた側 (youtube.ts) の代わり: 枠から出して、窓の左上 = 指 − 押した点の窓の中の位置 に置く
      made?.frame.setDocked(false);
      made?.frame.place({ left: 18, top: 500, width: 480 });
    });
    made = makeBarLikeWindow({ onUndockRequest });
    const { frame, grip, onUserMove } = made;
    frame.setDocked(true);
    // ドック中の窓の左上は (20, 500)。⠿ を (100, 540) で掴む = 窓の中の (80, 40)。押した後は測りを戻す
    // (浮いた窓の詰め方 fitRect が、⠿ の箱をこの枠の位置から測ってしまわないように)
    const spy = vi
      .spyOn(frame.element, "getBoundingClientRect")
      .mockReturnValue(boxAt(20, 500, 800, 140));
    pointer(grip, "pointerdown", 100, 540);
    spy.mockRestore();
    pointer(grip, "pointermove", 105, 540);
    expect(onUndockRequest).not.toHaveBeenCalled();

    pointer(grip, "pointermove", 98, 540);
    pointer(grip, "pointermove", 100, 548);
    expect(onUndockRequest).toHaveBeenCalledTimes(1);
    expect(onUndockRequest).toHaveBeenCalledWith({ x: 100, y: 548 }, { x: 80, y: 40 });

    // 引き出した後は、その時点の指の位置から窓が付いて動く
    pointer(grip, "pointermove", 120, 568);
    pointer(grip, "pointerup", 120, 568);
    expect(styleOf(frame)).toEqual({ left: "38px", top: "520px", width: "480px", height: "" });
    expect(onUserMove).toHaveBeenCalledWith({ left: 38, top: 520, width: 480 });
  });

  test(`${UNDOCK_THRESHOLD_PX}px 未満で離すと何もしない (onUndockRequest も onUserMove も呼ばない)`, () => {
    const onUndockRequest = vi.fn();
    const { frame, grip, onUserMove } = makeBarLikeWindow({ onUndockRequest });
    frame.setDocked(true);
    pointer(grip, "pointerdown", 100, 540);
    pointer(grip, "pointermove", 104, 540);
    pointer(grip, "pointerup", 104, 540);
    expect(onUndockRequest).not.toHaveBeenCalled();
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("引き取られなかった (枠に入ったまま) ら、そこでドラッグを終える", () => {
    const onUndockRequest = vi.fn();
    const { frame, grip, onUserMove } = makeBarLikeWindow({ onUndockRequest });
    frame.setDocked(true);
    pointer(grip, "pointerdown", 100, 540);
    pointer(grip, "pointermove", 120, 540);
    pointer(grip, "pointermove", 160, 540);
    pointer(grip, "pointerup", 160, 540);
    expect(onUndockRequest).toHaveBeenCalledTimes(1);
    expect(frame.element.style.position).toBe("static");
    expect(onUserMove).not.toHaveBeenCalled();
  });

  test("付け直した捕捉が生きている間の lostpointercapture ではドラッグを終えない (窓を body へ移したときの知らせ)", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "hasPointerCapture");
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      writable: true,
      value: () => true,
    });
    try {
      const { frame, onUserMove } = makeWindow();
      frame.place({ left: 100, top: 100, width: 400 });
      const header = headerOf(frame);
      pointer(header, "pointerdown", 100, 100);
      pointer(header, "pointermove", 110, 100);
      header.dispatchEvent(new MouseEvent("lostpointercapture", { bubbles: true }));
      pointer(header, "pointermove", 130, 120);
      pointer(header, "pointerup", 130, 120);
      expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 400 });
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Element.prototype, "hasPointerCapture");
      } else {
        Object.defineProperty(Element.prototype, "hasPointerCapture", descriptor);
      }
    }
  });
});

describe("窓の外の要素から移動を続ける (beginMoveFrom)", () => {
  test("タブなど窓の外の要素で始まったドラッグで窓が動き、離すと置いた場所を知らせる", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const tab = document.createElement("div");
    document.body.append(tab);

    frame.beginMoveFrom(tab, moveEvent(150, 150), { x: 150, y: 140 });
    pointer(tab, "pointermove", 170, 180);
    pointer(tab, "pointerup", 170, 180);

    expect(styleOf(frame)).toEqual({ left: "120px", top: "130px", width: "400px", height: "" });
    expect(onUserMove).toHaveBeenCalledWith({ left: 120, top: 130, width: 400 });
    tab.remove();
  });

  test("動かさずに離しても置いた場所を知らせる (引き出した窓を「動かしていない窓」にしない)", () => {
    const { frame, onUserMove } = makeWindow();
    frame.place({ left: 100, top: 100, width: 400 });
    const tab = document.createElement("div");
    document.body.append(tab);

    frame.beginMoveFrom(tab, moveEvent(150, 150), { x: 150, y: 140 });
    pointer(tab, "pointerup", 150, 150);

    expect(onUserMove).toHaveBeenCalledWith({ left: 100, top: 100, width: 400 });
    tab.remove();
  });

  test("落とし先へは、引き出す前に押した点 (開始点) で start を知らせ、すぐ今の点で move を知らせる", () => {
    const onDragPoint = vi.fn<DragPointFn>(() => false);
    const { frame } = makeWindow({ onDragPoint });
    const tab = document.createElement("div");
    document.body.append(tab);

    frame.beginMoveFrom(tab, moveEvent(150, 150), { x: 150, y: 140 });

    expect(onDragPoint.mock.calls).toEqual([
      ["start", { x: 150, y: 140 }],
      ["move", { x: 150, y: 150 }],
    ]);
    pointer(tab, "pointerup", 150, 150);
    tab.remove();
  });

  test("枠に入っている窓で呼ぶと throw する (先に setDocked(false) で引き出す)", () => {
    const { frame } = makeWindow();
    frame.setDocked(true);
    const tab = document.createElement("div");
    expect(() => frame.beginMoveFrom(tab, moveEvent(0, 0), { x: 0, y: 0 })).toThrow();
  });
});
```

`tests/content/panel-window.test.ts` の import に `PANEL_HEADER_HEIGHT_PX` を足し (`SETTINGS_CASCADE_PX,` の前の行に
`  PANEL_HEADER_HEIGHT_PX,`)、`describe("createPanelWindow")` の中、「見出しのダブルクリックで最初の位置に戻すよう頼む」のテストの**後**に次を足す。

```typescript
  test("見出しのドラッグの指の位置を onDragPoint へそのまま渡す (落とし先の当たり判定は dock.ts)", () => {
    const onDragPoint = vi.fn<NonNullable<PanelWindowOptions["onDragPoint"]>>(() => false);
    const target = makeWindow({ onDragPoint });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });

    pointer(headerOf(target), "pointerdown", 100, 100);
    pointer(headerOf(target), "pointermove", 130, 120);
    pointer(headerOf(target), "pointerup", 130, 120);

    expect(onDragPoint.mock.calls.map(([phase]) => phase)).toEqual(["start", "move", "end"]);
  });

  test("見出しの行の高さは 32px (タブから引き出した窓を、指が見出しの中に来るよう置く)", () => {
    expect(PANEL_HEADER_HEIGHT_PX).toBe(32);
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/panel-window.test.ts` (Bash の timeout 120000)
期待: FAIL。`UNDOCK_THRESHOLD_PX` / `PANEL_HEADER_HEIGHT_PX` が undefined、`onDragPoint` が呼ばれない、`beginMoveFrom is not a function`、
ドック中の ⠿ で窓が動く (引き出しの待ちが無い)

- [ ] **Step 3: 最小実装**

`src/content/floating-window.ts` (Task 3 の版) の `/**\n * 押した場所が、掴む場所の中のボタンや入力欄か。` の doc コメントの**直前**に次を足す。

```typescript
/**
 * ドック中の掴む場所 (バーの ⠿。dock.ts のタブも同じ値を使う) を、これだけ動かしたら枠から引き出す (C2.4)。
 * テロップの帯の「押して離した」の 4px (telop-track.ts の TELOP_CLICK_SLOP_PX) より大きくし、タブを押すつもりの
 * 指の震えで抜けないようにする
 */
export const UNDOCK_THRESHOLD_PX = 8;

/** 画面 (viewport) の座標の点。ドラッグの指の位置 */
export type DragPoint = { x: number; y: number };
/** 窓を動かすドラッグの段階 (落とし先の当たり判定へ知らせる。C2.3) */
export type DragPhase = "start" | "move" | "end";
```

`FloatingWindow` 型の `setDocked(docked: boolean): void;` の宣言 (とその doc) の**直後**に次を足す。

```typescript
  /**
   * 窓の外の要素 (dock.ts のタブ) で始まったドラッグを、窓の移動として続ける (C2.8)。捕捉と listener は source に
   * 付ける。event はその時点の pointermove、origin はドラッグの開始点 (タブを押した点。落とし先の距離の起点。C2.3)。
   * **浮いた窓でだけ呼ぶ** (枠に入っている間は throw。先に setDocked(false) で引き出す)。この続きのドラッグは、
   * 動かさずに離しても置いた場所を onUserMove で知らせる (引き出した窓を「動かしていない窓」にしない)
   */
  beginMoveFrom(source: HTMLElement, event: PointerEvent, origin: DragPoint): void;
```

`FloatingWindowOptions` 型の `onResetRequest(): void;` の宣言 (とその doc) の**直後**に次を足す。

```typescript
  /**
   * 窓を動かすドラッグの指の位置 (C2.3)。**落とし先の当たり判定は dock.ts が持つ** (窓の枠は枠を知らない)。
   * start は動かし始めたとき (押して離しただけでは呼ばない) に開始点で、move は動くたびに、end は指を離したときに
   * 呼ぶ。end で true を返したら (枠に引き取った) onUserMove を呼ばない
   */
  onDragPoint?(phase: DragPhase, point: DragPoint): boolean;
  /**
   * 枠に入っている間に、掴む場所 (バーの ⠿) を UNDOCK_THRESHOLD_PX 動かした (C2.8)。grab は窓の左上から見た押した点。
   * 呼ばれた側が窓を枠から出し (setDocked(false))、指の下に place する。その後のドラッグはこの窓が続ける
   */
  onUndockRequest?(point: DragPoint, grab: DragPoint): void;
```

`beginDrag` の doc コメントと関数全体 (`  /**\n   * ドラッグを始める。**Pointer Events と捕捉を使う**` から `beginDrag` の閉じ括弧まで) を次に置き換える。

```typescript
  /**
   * ドラッグを始める。**Pointer Events と捕捉を使う** (spec A.3)。捕捉すると、指が窓の外へ
   * 出ても pointermove が掴んだ要素に届き続ける。
   *
   * 窓を動かすドラッグ (move) は、動かし始めてから指を離すまで onDragPoint で落とし先の当たり判定へ指の位置を
   * 知らせる (C2.3)。`continued` は窓の外の要素 (タブ) で始まったドラッグの続き (beginMoveFrom) の開始点
   */
  function beginDrag(
    source: HTMLElement,
    kind: "move" | "resize",
    event: PointerEvent,
    continued: DragPoint | null = null,
  ): void {
    // 主ボタン以外 (右クリックのメニューなど) では動かさない。続き (タブから引き出した後) は pointermove から
    // 始まり、button は -1 (押しているボタンが変わっていない) なので見ない
    if (continued === null && event.button !== 0) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();
    // このドラッグを起こした指だけを追う。**違う pointerId の move / up / cancel は無視する**
    // (2 本目の指が同じ要素に触れても、こちらの位置を横から書き換えない)
    const pointerId = event.pointerId;
    /** ドラッグの開始点。落とし先に当てる距離 (C2.3) と、枠からの引き出し (C2.8) の起点 */
    const origin: DragPoint = continued ?? { x: event.clientX, y: event.clientY };
    /** 窓の動きを測る基準の点。枠から引き出したら、その時点の指の位置に取り直す */
    let baseX = event.clientX;
    let baseY = event.clientY;
    let start = current;
    // 高さを決めていない窓を縦に広げるときは、今の見た目の高さから始める
    const startHeight = start.height ?? element.getBoundingClientRect().height;
    /**
     * 枠に入っている窓の掴む場所 (バーの ⠿) から始めたか。UNDOCK_THRESHOLD_PX 動くまで窓を動かさず、動いたら
     * onUndockRequest で枠から引き出してもらう (C2.8)
     */
    let pendingUndock = kind === "move" && docked;
    const frame = pendingUndock ? element.getBoundingClientRect() : null;
    /** 窓の左上から見た押した点 (引き出した窓を、⠿ が指の下に残るよう置くため) */
    const grab: DragPoint =
      frame === null ? { x: 0, y: 0 } : { x: origin.x - frame.left, y: origin.y - frame.top };
    /**
     * 枠から引き出した窓か。引き出した後は、動かさずに離しても置いた場所を知らせる (知らせないと float に位置が
     * 入らず「動かしていない窓」になり、次の resize で最初の位置へ跳ぶ)
     */
    let undocked = continued !== null;
    /** 落とし先へ知らせているか。押して動かさずに離した (クリック) ときは知らせない (C2.3) */
    let reporting = false;
    let last: DragPoint = { x: event.clientX, y: event.clientY };
    source.setPointerCapture(pointerId);

    const report = (phase: DragPhase, point: DragPoint): boolean =>
      options.onDragPoint?.(phase, point) === true;
    const startReporting = (): void => {
      reporting = true;
      report("start", origin);
    };
    // タブから引き出した続きは、もう動いている。開始点と今の点をすぐ知らせる
    if (continued !== null && kind === "move") {
      startReporting();
      report("move", last);
    }

    /** ドラッグを終わらせる。捕捉とリスナをまとめて解く (range-bar.ts の拡大バーと同じ作法) */
    const finish = (): void => {
      source.releasePointerCapture(pointerId);
      source.removeEventListener("pointermove", onMove);
      source.removeEventListener("pointerup", onSettle);
      source.removeEventListener("pointercancel", onSettle);
      source.removeEventListener("lostpointercapture", onSettle);
    };

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      last = { x: move.clientX, y: move.clientY };
      if (pendingUndock) {
        // 押すつもりの指の震えでは抜けない
        if (Math.hypot(last.x - origin.x, last.y - origin.y) < UNDOCK_THRESHOLD_PX) return;
        pendingUndock = false;
        options.onUndockRequest?.(last, grab);
        // 引き取られなかった (枠から出されなかった) ら、ここで終える。枠の中の窓は動かさない
        if (docked) {
          finish();
          return;
        }
        // 窓は枠から body へ移った。掴む場所ごと移したので捕捉が外れうる。付け直す (C2.8)
        source.setPointerCapture(pointerId);
        undocked = true;
        start = current;
        baseX = last.x;
        baseY = last.y;
        startReporting();
        report("move", last);
        return;
      }
      const dx = last.x - baseX;
      const dy = last.y - baseY;
      if (kind === "move") {
        if (!reporting && (dx !== 0 || dy !== 0)) startReporting();
        apply({ ...start, left: start.left + dx, top: start.top + dy });
        if (reporting) report("move", last);
      } else if (options.resize === "both") {
        // 高さを決めていない窓は、実際に縦へ動いた (dy !== 0) ときだけ高さを持たせる。
        // 移動量 0 の pointermove (押して動かさずに離す) だけで height が入ると、元は
        // undefined だった height が定義された値になり、sameRect が false になって
        // クリックしただけで onUserMove が呼ばれてしまう
        apply(
          start.height !== undefined || dy !== 0
            ? { ...start, width: start.width + dx, height: startHeight + dy }
            : { ...start, width: start.width + dx },
        );
      } else {
        apply({ ...start, width: start.width + dx });
      }
    };

    // pointercancel (タッチの横取りなど)・lostpointercapture (要素が DOM から外れる、
    // ほかが捕捉を奪うなど) でも終える。pointerup が来ないままドラッグが宙に浮くのを防ぐ。
    // そこまでに動かした位置は、画面に出ているとおりに確定する (拡大バーのハンドルと同じ)
    const onSettle = (settled: Event): void => {
      const settledPointerId = (settled as PointerEvent).pointerId;
      // lostpointercapture は座標を持たない。current (最後の pointermove で反映済み) を使う
      if (settledPointerId !== undefined && settledPointerId !== pointerId) return;
      // 枠から引き出すときに掴む場所ごと body へ移すと、古い捕捉が外れた知らせが後から届く。付け直した
      // 捕捉が生きていれば、ドラッグは続いている
      if (settled.type === "lostpointercapture" && source.hasPointerCapture?.(pointerId) === true) {
        return;
      }
      finish();
      // 枠に入ったまま押して離しただけ (引き出すほど動かさなかった)。何も変えない
      if (pendingUndock) return;
      requested = current;
      // 落とし先の枠に引き取られた。浮いた窓の位置は変えない (C2.3)
      if (reporting && report("end", last)) return;
      // 押して離しただけ (クリックやダブルクリックの 1 回目) は知らせない。知らせると
      // 「動かした窓」になり、最初の位置を取り直さなくなる。引き出した窓は知らせる (undocked の doc)
      if (!undocked && sameRect(start, current)) return;
      options.onUserMove({ ...current });
    };

    source.addEventListener("pointermove", onMove);
    source.addEventListener("pointerup", onSettle);
    source.addEventListener("pointercancel", onSettle);
    source.addEventListener("lostpointercapture", onSettle);
  }
```

戻り値の `setDocked(next: boolean): void { … },` の**直後**に次を足す。

```typescript
    beginMoveFrom(source: HTMLElement, event: PointerEvent, origin: DragPoint): void {
      // 枠の中のまま動かす経路は無い (位置はページの流れが決める)。先に setDocked(false) で引き出す。配線の誤り
      if (docked) throw new Error("[yt-clip] 枠に入っている窓は beginMoveFrom で動かせません");
      beginDrag(source, "move", event, origin);
    },
```

`src/content/panel-window.ts` の import (1〜5 行目)

```typescript
import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
```

を次に置き換える。

```typescript
import {
  createFloatingWindow,
  type DragPhase,
  type DragPoint,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
```

`export const SETTINGS_CASCADE_PX = 32;` の**直後**に次を足す。

```typescript
/**
 * 見出しの行の高さ (padding 8px × 2 + 文字の行。C1.3 の「見出しの行 (32px)」)。タブから引き出した窓を、指が
 * 見出しの中に来るよう置くのに使う (C2.4: 上端 = 指 − 見出しの高さの半分)
 */
export const PANEL_HEADER_HEIGHT_PX = 32;
```

`PanelWindowOptions` の `onResetRequest?(): void;` の宣言 (とその doc) の**直後**に次を足す。

```typescript
  /** 見出しのドラッグの指の位置 (落とし先の当たり判定。dock.ts へ渡す。C2.3)。end で true なら枠に引き取った */
  onDragPoint?(phase: DragPhase, point: DragPoint): boolean;
```

`createPanelWindow` の中の `createFloatingWindow({ … })` の `onResetRequest: () => options.onResetRequest?.(),` の**直後**に次を足す。

```typescript
    onDragPoint: (phase, point) => options.onDragPoint?.(phase, point) ?? false,
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/floating-window.test.ts tests/content/panel-window.test.ts` (Bash の timeout 120000)
期待: PASS (既存のドラッグ・大きさ・重なり順の検査も通る。onDragPoint を渡していない窓では何も変わらない)

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/floating-window.ts src/content/panel-window.ts tests/content/floating-window.test.ts tests/content/panel-window.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓のドラッグの指の位置を外へ知らせ、枠からの引き出しを続けられるようにする

ドック枠へ落とす当たり判定は枠を知る側 (dock.ts) が持つので、窓の枠は
ドラッグの開始点と指の位置を知らせるだけにする。枠に入ったバーは ⠿ を
8px 動かしたら引き出してもらい、タブから引き出した窓はタブで始まった
ドラッグをそのまま窓の移動として続ける。引き出した窓は動かさずに離しても
位置を覚え、resize で最初の位置へ跳ばないようにする。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: ドック枠の DOM と、入れる / 出す / 前に出す・最初の配置へ戻す・差し直し・退避 (`dock.ts` の前半)

**Files:**
- Modify: `src/content/styles.ts` (`FLOATING_WINDOW_STYLE` の後に `DOCK_STYLE` を足す)
- Create: `src/content/dock.ts`
- Test: `tests/content/dock.test.ts` (新規)、`tests/content/styles.test.ts`

**Interfaces:**
- Consumes: Task 2 の `DOCK_SLOT_IDS` / `DockSlotId` / `DockState` / `WindowId` / `acceptsDock` (テスト)、Task 3 の `FloatingWindow.setDocked`、
  Task 4 の `DragPoint` (型だけ)
- Produces:
  - `export function createDockManager(options: DockManagerOptions): DockManager`
  - `DockManagerOptions = { windows: Record<WindowId, FloatingWindow>; titles: Record<WindowId, string>; initial: DockState; accepts(id, slot): boolean;
    onUndock(id, point: DragPoint, grab: DragPoint): void; onTabDoubleClick(id): void; onEvacuate(id): void; onChange(state: DockState): void }`
  - `DockManager = { elements: Record<DockSlotId, HTMLElement>; attach(anchors: Record<DockSlotId, Element | null>): boolean;
    isUsable(slot): boolean; load(state: DockState): void; dock(id, slot): void; undock(id): void; restore(id): void; activate(id): void;
    slotOf(id): DockSlotId | null; sync(): void; state(): DockState; destroy(): void }` (`drag` は Task 6 で足す)
  - DOM: 枠の根 `#yt-clip-dock-below` / `#yt-clip-dock-side`、その中に `[data-role=dock-marker]` (Task 6 で使う) → `[data-role=dock-tabs]`
    (タブ `[data-role=dock-tab][data-window=<id>][data-active=true|false]`) → `[data-role=dock-content]` (窓ごとの箱
    `[data-role=dock-pane][data-window=<id>]`) の順
  - `restore(id)`: 最初の配置 (`options.initial`) で入る枠へ、最初の配置の並びの位置に入れて前に出し、`onChange`。最初の配置で枠に入らない窓なら `undock`
  - `export const BELOW_SLOT_MARGIN_TOP_PX = 0` (Task 10 で実測から決める)、`export const DOCK_SLOT_GAP_PX = 12` (窓が見えている枠の下の余白。
    目印だけの間は 0。判断メモ 37)
  - `DOCK_STYLE` (styles.ts): `root` / `tabRow` / `tab` / `tabActive` / `marker` / `bandOutline` / `bandFill`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/styles.test.ts` の import に `DOCK_STYLE,` を足し (`BAR_STYLE,` の次の行)、ファイルの末尾に次を足す。

```typescript
describe("ドック枠", () => {
  test("枠の根はページの流れの中 (static) で、地は窓と同じ。display は持たない (出し入れは dock.ts)", () => {
    expect(DOCK_STYLE.root).toContain("position:static");
    expect(DOCK_STYLE.root).toContain("background:var(--ytc-panel)");
    expect(DOCK_STYLE.root).not.toContain("display");
    // 余白は dock.ts が描くたびに当てる (目印だけの間は 0。判断メモ 37)
    expect(DOCK_STYLE.root).not.toContain("margin");
  });

  test("タブの列は高さ 28px、目印は高さ 40px。どちらも display は持たない", () => {
    expect(DOCK_STYLE.tabRow).toContain("height:28px");
    expect(DOCK_STYLE.marker).toContain("height:40px");
    expect(DOCK_STYLE.tabRow).not.toContain("display");
    expect(DOCK_STYLE.marker).not.toContain("display");
  });

  test("前のタブは文字の色とアクセントの下線 2px、ほかのタブは薄い文字 (C2.2)", () => {
    expect(DOCK_STYLE.tabActive).toContain("color:var(--ytc-text);");
    expect(DOCK_STYLE.tabActive).toContain("border-bottom:2px solid var(--ytc-accent)");
    expect(DOCK_STYLE.tab).toContain("color:var(--ytc-text-sub)");
  });

  test("タブは掴めることが分かる見た目で、文字を選ばせず、タッチでスクロールに取られない", () => {
    for (const style of [DOCK_STYLE.tab, DOCK_STYLE.tabActive]) {
      expect(style).toContain("user-select:none");
      expect(style).toContain("touch-action:none");
    }
  });

  test("落とし先の帯は点線の縁、指が中にあるとアクセントの 12% で塗る (C2.3)", () => {
    expect(DOCK_STYLE.bandOutline).toBe("2px dashed var(--ytc-accent)");
    expect(DOCK_STYLE.bandFill).toContain("12%");
  });
});
```

`tests/content/dock.test.ts` を次の内容で作る。

```typescript
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDockManager, type DockManager } from "@/content/dock";
import { createFloatingWindow, type FloatingWindow } from "@/content/floating-window";
import { acceptsDock, initialDocks, type DockSlotId, type WindowId } from "@/content/window-layout";

/** タブの文言 (youtube.ts と同じ) */
const TITLES = { bar: "バー", list: "区間・テロップ", settings: "設定" } as const;
/** 差す先の箱 (jsdom はレイアウトを持たない)。帯 (目印 40px / タブの列 28px) は枠の上端に置く */
const BELOW = { left: 0, top: 600, width: 800 };
const SIDE = { left: 840, top: 60, width: 400 };

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

/** 右の枠の差す先の幅。0 にすると使えない枠になる */
let sideWidth = SIDE.width;

/**
 * 差す先と、枠の中の帯・タブ・置き場の位置を決め打ちする。ほかの要素は 0。
 * タブは枠の左端から 8px の所に幅 100px で並べる (どのタブも同じ箱。当たり判定には使わない)
 */
function stubLayout() {
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      if (this.id === "below") return boxAt(BELOW.left, BELOW.top, BELOW.width, 0);
      if (this.id === "secondary-inner") return boxAt(SIDE.left, SIDE.top, sideWidth, 0);
      const box =
        this.closest("#yt-clip-dock-below") !== null
          ? BELOW
          : this.closest("#yt-clip-dock-side") !== null
            ? SIDE
            : null;
      const role = this instanceof HTMLElement ? this.dataset.role : undefined;
      if (box !== null && role === "dock-marker") return boxAt(box.left, box.top, box.width, 40);
      if (box !== null && role === "dock-tabs") return boxAt(box.left, box.top, box.width, 28);
      if (box !== null && role === "dock-tab") return boxAt(box.left + 8, box.top, 100, 28);
      if (box !== null && role === "dock-content") return boxAt(box.left, box.top + 28, box.width, 300);
      return boxAt(0, 0, 0, 0);
    });
}

type Setup = {
  manager: DockManager;
  windows: Record<WindowId, FloatingWindow>;
  below: HTMLElement;
  side: HTMLElement;
  onChange: ReturnType<typeof vi.fn>;
  onEvacuate: ReturnType<typeof vi.fn>;
  onUndock: ReturnType<typeof vi.fn>;
  onTabDoubleClick: ReturnType<typeof vi.fn>;
};

let made: Setup | null = null;

/** 差す先 2 つと窓 3 つ (浮いた窓で出ている) を作り、枠を差す */
function setup(): Setup {
  const below = document.createElement("div");
  below.id = "below";
  const side = document.createElement("div");
  side.id = "secondary-inner";
  document.body.append(below, side);
  const make = (id: WindowId): FloatingWindow => {
    const frame = createFloatingWindow({
      id: `win-${id}`,
      title: id === "bar" ? undefined : TITLES[id],
      resize: id === "bar" ? "width" : "both",
      minWidth: 280,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
    });
    document.body.append(frame.element);
    frame.setVisible(true);
    return frame;
  };
  const windows = { bar: make("bar"), list: make("list"), settings: make("settings") };
  const onChange = vi.fn();
  const onEvacuate = vi.fn();
  const onUndock = vi.fn();
  const onTabDoubleClick = vi.fn();
  const manager = createDockManager({
    windows,
    titles: TITLES,
    initial: initialDocks(),
    accepts: acceptsDock,
    onChange,
    onEvacuate,
    onUndock,
    onTabDoubleClick,
  });
  manager.attach({ below, side });
  made = { manager, windows, below, side, onChange, onEvacuate, onUndock, onTabDoubleClick };
  return made;
}

function slotRoot(slot: DockSlotId): HTMLElement {
  const root = document.getElementById(`yt-clip-dock-${slot}`);
  if (root === null) throw new Error(`#yt-clip-dock-${slot} がありません`);
  return root;
}

function tabRowOf(slot: DockSlotId): HTMLElement {
  const row = slotRoot(slot).querySelector<HTMLElement>("[data-role='dock-tabs']");
  if (row === null) throw new Error("タブの列がありません");
  return row;
}

/** 出ているタブの文言 (並び順) */
function tabLabels(slot: DockSlotId): string[] {
  return [...tabRowOf(slot).querySelectorAll<HTMLElement>("[data-role='dock-tab']")]
    .filter((tab) => tab.style.display !== "none")
    .map((tab) => tab.textContent ?? "");
}

function activeLabel(slot: DockSlotId): string | null {
  return (
    tabRowOf(slot).querySelector<HTMLElement>("[data-role='dock-tab'][data-active='true']")
      ?.textContent ?? null
  );
}

/** 窓を入れた箱の display (前のタブだけ block) */
function paneDisplay(frame: FloatingWindow): string {
  const pane = frame.element.parentElement;
  if (pane === null || pane.dataset.role !== "dock-pane") throw new Error("枠の置き場に入っていません");
  return pane.style.display;
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない (窓のドラッグとタブの押下が呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

beforeEach(() => {
  sideWidth = SIDE.width;
  stubLayout();
});

afterEach(() => {
  if (made !== null) {
    made.manager.destroy();
    for (const frame of Object.values(made.windows)) frame.destroy();
    made.below.remove();
    made.side.remove();
    made = null;
  }
  vi.restoreAllMocks();
});

describe("入れる・出す・前に出す", () => {
  test("dock で枠の置き場に入り、窓はページの流れの中の見た目になる。枠を出し、onChange で組を知らせる", () => {
    const { manager, windows, onChange } = setup();

    manager.dock("list", "side");

    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(windows.list.element.style.position).toBe("static");
    expect(slotRoot("side").style.display).toBe("block");
    expect(slotRoot("side").parentElement?.id).toBe("secondary-inner");
    expect(manager.slotOf("list")).toBe("side");
    expect(manager.slotOf("bar")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list"], active: "list" } });
  });

  test("2 つ入れるとタブの列が出て、後から入れた方が前。前のタブの窓だけを出す (窓の出し入れは変えない)", () => {
    const { manager, windows } = setup();

    manager.dock("list", "side");
    manager.dock("settings", "side");

    expect(tabRowOf("side").style.display).toBe("flex");
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("設定");
    expect(paneDisplay(windows.list)).toBe("none");
    expect(paneDisplay(windows.settings)).toBe("block");
    expect(windows.list.element.hidden).toBe(false);
  });

  test("バーだけの枠はタブの列を出さない。区間・テロップの窓だけの枠は出す (掴む場所が要る)", () => {
    const { manager } = setup();

    manager.dock("bar", "below");
    manager.dock("list", "side");

    expect(tabRowOf("below").style.display).toBe("none");
    expect(slotRoot("below").style.display).toBe("block");
    expect(tabRowOf("side").style.display).toBe("flex");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
  });

  test("入れられない組み合わせ (右の枠のバー) は throw する", () => {
    const { manager } = setup();
    expect(() => manager.dock("bar", "side")).toThrow();
    expect(manager.slotOf("bar")).toBeNull();
  });

  test("activate で前のタブを替え、onChange で知らせる。枠に入っていない窓では何もしない", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    manager.activate("list");

    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(paneDisplay(windows.list)).toBe("block");
    expect(paneDisplay(windows.settings)).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list", "settings"], active: "list" } });

    onChange.mockClear();
    manager.activate("bar");
    manager.activate("list");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("隠れた窓のタブは出さず、前のタブが隠れたら見えているタブの先頭を出す。覚えた前のタブは変えず、保存も求めない", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    windows.settings.setVisible(false);
    manager.sync();

    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(paneDisplay(windows.list)).toBe("block");
    expect(manager.state().side?.active).toBe("settings");
    expect(onChange).not.toHaveBeenCalled();

    windows.settings.setVisible(true);
    manager.sync();
    expect(activeLabel("side")).toBe("設定");
  });

  test("見えている窓が 1 つも無い枠は、枠ごと隠す (空のタブの列でおすすめ動画を押し下げない)", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");

    windows.list.setVisible(false);
    manager.sync();

    expect(slotRoot("side").style.display).toBe("none");
  });

  test("undock で枠から出して body へ戻し、浮いた窓の見た目に戻す。元の枠は残りの窓で描き直す", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");

    manager.undock("settings");

    expect(windows.settings.element.parentElement).toBe(document.body);
    expect(windows.settings.element.style.position).toBe("fixed");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(paneDisplay(windows.list)).toBe("block");
    expect(manager.slotOf("settings")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list"] } });
  });

  test("別の枠へ入れ直すと、元の枠から外れて入れた枠の末尾に付く", () => {
    const { manager } = setup();
    manager.dock("bar", "below");
    manager.dock("list", "side");

    manager.dock("list", "below");

    expect(manager.state()).toEqual({ below: { tabs: ["bar", "list"], active: "list" } });
    expect(tabLabels("below")).toEqual(["バー", "区間・テロップ"]);
    expect(slotRoot("side").style.display).toBe("none");
  });

  test("restore は最初の配置の枠へ、最初の配置の並びの位置に入れて前に出す (浮いた窓も、別の枠の窓も)", () => {
    const { manager, windows, onChange } = setup();
    manager.dock("settings", "side");
    manager.dock("list", "below");

    manager.restore("list");

    // 区間・テロップ → 設定 の順 (末尾に付けない)
    expect(manager.state()).toEqual({ side: { tabs: ["list", "settings"], active: "list" } });
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(slotRoot("below").style.display).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list", "settings"], active: "list" } });

    manager.restore("bar");
    expect(manager.state().below).toEqual({ tabs: ["bar"], active: "bar" });
  });

  test("restore で、既に最初の配置の枠にある窓は並びを変えずに前に出すだけ (保存も求める)", () => {
    const { manager, onChange } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    onChange.mockClear();

    manager.restore("list");

    expect(manager.state()).toEqual({ side: { tabs: ["list", "settings"], active: "list" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("窓が見えている枠だけ下に 12px 空ける。下の枠の上の余白の補正も、窓が見えている間だけ", () => {
    const { manager, windows } = setup();
    manager.dock("bar", "below");
    expect(slotRoot("below").style.marginBottom).toBe("12px");
    expect(slotRoot("below").style.marginTop).toBe("0px");

    windows.bar.setVisible(false);
    manager.sync();
    expect(slotRoot("below").style.marginBottom).toBe("0px");
  });

  test("state は写しを返す (書き換えても枠の中身は変わらない)", () => {
    const { manager } = setup();
    manager.dock("list", "side");
    const copy = manager.state();
    copy.side?.tabs.push("settings");
    expect(manager.state()).toEqual({ side: { tabs: ["list"], active: "list" } });
  });
});

describe("差し直しと退避", () => {
  test("attach は差す先の中に無い枠を、中の窓ごと先頭に差し直す (使えるかは変わらないので false)", () => {
    const { manager, windows, below, side } = setup();
    manager.dock("list", "side");
    const root = slotRoot("side");
    const related = document.createElement("div");
    side.replaceChildren(related);
    expect(root.isConnected).toBe(false);

    expect(manager.attach({ below, side })).toBe(false);

    expect(side.firstElementChild).toBe(root);
    expect(root.contains(windows.list.element)).toBe(true);
  });

  test("差す先が幅 0 の枠は使えない。中の窓は sync で退避 (body の浮いた窓・onEvacuate を 1 回)。記憶は残し、戻ると枠に戻す", () => {
    const { manager, windows, below, side, onChange, onEvacuate } = setup();
    manager.dock("list", "side");
    onChange.mockClear();

    sideWidth = 0;
    expect(manager.attach({ below, side })).toBe(true);
    expect(manager.isUsable("side")).toBe(false);
    manager.sync();

    expect(windows.list.element.parentElement).toBe(document.body);
    expect(windows.list.element.style.position).toBe("fixed");
    expect(onEvacuate).toHaveBeenCalledWith("list");
    expect(slotRoot("side").style.display).toBe("none");
    expect(manager.slotOf("list")).toBe("side");
    expect(onChange).not.toHaveBeenCalled();

    manager.sync();
    expect(onEvacuate).toHaveBeenCalledTimes(1);

    sideWidth = SIDE.width;
    expect(manager.attach({ below, side })).toBe(true);
    manager.sync();
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(windows.list.element.style.position).toBe("static");
  });

  test("差す先が無い枠も使えない (退避する)", () => {
    const { manager, windows, below, onEvacuate } = setup();
    manager.dock("list", "side");

    expect(manager.attach({ below, side: null })).toBe(true);
    manager.sync();

    expect(windows.list.element.parentElement).toBe(document.body);
    expect(onEvacuate).toHaveBeenCalledWith("list");
  });

  test("load は onChange を呼ばずに枠の中身を入れ、sync で置く", () => {
    const { manager, windows, onChange } = setup();

    manager.load({ below: { tabs: ["bar"] }, side: { tabs: ["list", "settings"], active: "list" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(windows.list.element.parentElement).toBe(document.body);

    manager.sync();

    expect(windows.bar.element.closest("#yt-clip-dock-below")).not.toBeNull();
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(manager.state()).toEqual({
      below: { tabs: ["bar"] },
      side: { tabs: ["list", "settings"], active: "list" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/dock.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: FAIL。`@/content/dock` が無い (Failed to resolve import)、`DOCK_STYLE` が undefined

- [ ] **Step 3: 最小実装**

`src/content/styles.ts` の `FLOATING_WINDOW_STYLE` の `} as const;` の**後**に次を足す。

```typescript

/**
 * ページの中のドック枠 (`dock.ts`。窓の分割の spec C2)。**根・タブの列・目印は display を持たない**
 * (出し入れは dock.ts が style.display で行う。ここに書くと hidden を立てても出たままになる)。配色は youtube.ts が
 * 枠の根に applyPalette で当てる (枠は #below / #secondary-inner の中にあるが、YouTube の CSS 変数には頼らない方針のまま)
 */
export const DOCK_STYLE = {
  /**
   * 枠の根 (#yt-clip-dock-below / #yt-clip-dock-side)。**ページの流れの中** (static) にあり、ページと一緒に
   * スクロールする (C2.1)。**余白は持たない**: 動画のタイトル・おすすめ動画との間 (下の余白) と下の枠の上の余白の補正は、
   * 窓が見えている間だけ dock.ts が当てる (ドラッグの間の目印だけの枠で、下の内容が 40px より多く下がらないように)
   */
  root: `position:static;box-sizing:border-box;border-radius:8px;background:var(--ytc-panel);color:var(--ytc-text);font-family:${FONT};font-size:13px;`,
  /** タブの列 (C2.2)。高さ 28px。ドラッグの間は落とし先の帯になる (C2.3) */
  tabRow: "align-items:stretch;gap:4px;height:28px;padding:0 4px;box-sizing:border-box;",
  /**
   * タブ。押すと前に出し、ドラッグで引き出す (C2.4)。文字を選べると、掴んだつもりで選択が始まる。
   * `touch-action:none` が無いと、タッチでは掴んだ瞬間にページのスクロールに取られる
   */
  tab: "display:flex;align-items:center;padding:0 12px;box-sizing:border-box;cursor:pointer;user-select:none;touch-action:none;white-space:nowrap;font-size:13px;font-weight:500;color:var(--ytc-text-sub);border-bottom:2px solid transparent;",
  /** 前に出しているタブ。文字の色と、アクセントの下線 2px で見分ける (C2.2) */
  tabActive:
    "display:flex;align-items:center;padding:0 12px;box-sizing:border-box;cursor:pointer;user-select:none;touch-action:none;white-space:nowrap;font-size:13px;font-weight:500;color:var(--ytc-text);border-bottom:2px solid var(--ytc-accent);",
  /** 隠れている枠・バーだけの枠の落とし先 (C2.3)。高さ 40px の箱に「ここにドック」 */
  marker:
    "align-items:center;justify-content:center;height:40px;box-sizing:border-box;border-radius:8px;color:var(--ytc-text-sub);font-size:13px;",
  /** 落とし先の帯の縁 (タブの列にも目印にも当てる。outline なので帯の高さを変えない) */
  bandOutline: "2px dashed var(--ytc-accent)",
  /** 指が中にある帯の塗り (アクセントの 12%。Chrome 111 以降の color-mix) */
  bandFill: "color-mix(in srgb,var(--ytc-accent) 12%,transparent)",
} as const;
```

`src/content/dock.ts` を次の内容で作る。

```typescript
import type { DragPoint, FloatingWindow } from "@/content/floating-window";
import { DOCK_STYLE } from "@/content/styles";
import {
  DOCK_SLOT_IDS,
  type DockSlotId,
  type DockState,
  type WindowId,
} from "@/content/window-layout";

export type { DockSlotId, DockState } from "@/content/window-layout";

/**
 * ページの中のドック枠 2 か所とタブ (`.claude/specs/2026-09-25-dockable-windows-design.md` C2)。
 * 下の枠 (#yt-clip-dock-below) は #below の先頭、右の枠 (#yt-clip-dock-side) は #secondary-inner の先頭に差し、
 * ページと一緒にスクロールする。
 *
 * 枠 (根・タブの列・窓の置き場)、入れる / 出す / 前に出す、差し直し、退避、保存用の形を持つ。**窓の中身と、
 * 窓を出す条件は知らない** (youtube.ts が決め、窓の `hidden` として見える)。浮いた窓の位置も知らない: 退避した窓は
 * onEvacuate、引き出した窓は onUndock で youtube.ts が置く
 */

/**
 * 下の枠の上の余白の補正 (px。負で詰める)。1440x795 でバーだけを下の枠に入れたとき、枠の外形が画面に収まる予算は
 * 795 − 628 (プレイヤーの下端の実測) = 167px、バーの窓は約 140px (C2.10)。#below の上の余白が 27px を超えると収まらない
 * ので、そのときは実測に合わせてここを負にする (YouTube の余白を枠の margin-top で相殺する)
 */
export const BELOW_SLOT_MARGIN_TOP_PX = 0;
/**
 * 窓が見えている枠の下の余白 (動画のタイトル・おすすめ動画との間)。**目印だけの間 (ドラッグ中の空の枠) は 0** にして、
 * 下の内容が目印の高さ (40px) だけ下がるようにする (C2.3)
 */
export const DOCK_SLOT_GAP_PX = 12;

export type DockManager = {
  /** 2 つの枠の根。配色 (applyPalette) を当てるために見せる */
  elements: Record<DockSlotId, HTMLElement>;
  /**
   * 枠を差す先に付け直す (mount・resize のたび)。差す先の中に無ければ先頭に差す。差す先が無い・幅 0 の枠は
   * 使えない (isUsable が false。中の窓は次の sync で退避)。**使えるかが変わったら true** (呼び出し側が窓を出し直す)
   */
  attach(anchors: Record<DockSlotId, Element | null>): boolean;
  isUsable(slot: DockSlotId): boolean;
  /** 覚えた枠の中身を入れる (読み込みの 1 回)。**onChange を呼ばない** (読み込みは書かない)。置くのは次の sync */
  load(state: DockState): void;
  /** 枠の末尾に入れて前に出す (C2.3)。入れられない組み合わせは throw (配線の誤り) */
  dock(id: WindowId, slot: DockSlotId): void;
  /** 枠から出して body へ戻し、浮いた窓にする。どこに置くかは呼び出し側が決める */
  undock(id: WindowId): void;
  /**
   * 最初の配置へ戻す (ダブルクリック。C2.6): options.initial で入る枠へ、最初の配置の並びの位置に入れて前に出し、onChange。
   * 既にその枠にあれば並びは変えず前に出すだけ。最初の配置で枠に入らない窓なら undock。戻す先の枠が使えなければ、記憶に
   * 入れたまま退避 (onEvacuate)
   */
  restore(id: WindowId): void;
  /** その窓のタブを前に出す。枠に入っていなければ何もしない */
  activate(id: WindowId): void;
  /** 入っている枠 (使えない枠で退避中も含む)。入っていなければ null */
  slotOf(id: WindowId): DockSlotId | null;
  /** 窓の出す条件 (hidden) が変わった後に呼ぶ。窓の置き場・タブ・枠の出し入れ・退避を合わせる */
  sync(): void;
  /** 保存用の形 (写し) */
  state(): DockState;
  destroy(): void;
};

export type DockManagerOptions = {
  windows: Record<WindowId, FloatingWindow>;
  /** タブの文言 (窓の見出しと同じ。バーは見出しを作らないので「バー」) */
  titles: Record<WindowId, string>;
  /** 最初の配置 (window-layout.ts の initialDocks)。restore の戻し先と並び順 */
  initial: DockState;
  accepts(id: WindowId, slot: DockSlotId): boolean;
  /**
   * タブを掴んで UNDOCK_THRESHOLD_PX 動かした (C2.4)。窓はもう枠から出て body にある。呼ばれた側は窓を指の下に置く
   * (grab はタブの左上から見た押した点)。その後のドラッグの続きは dock.ts が窓の beginMoveFrom で始める
   */
  onUndock(id: WindowId, point: DragPoint, grab: DragPoint): void;
  /** タブのダブルクリック (最初の位置に戻す。C2.6) */
  onTabDoubleClick(id: WindowId): void;
  /**
   * 入っている枠が使えなくなったので、窓を body へ移して浮かせた (退避。C2.1)。呼ばれた側は最初の位置に置く。
   * ドックの記憶 (tabs) は消さない。退避している間は 1 回だけ呼ぶ
   */
  onEvacuate(id: WindowId): void;
  /** 入れた・出した・前に出した (ユーザーの操作。保存の合図) */
  onChange(state: DockState): void;
};

type Slot = {
  id: DockSlotId;
  root: HTMLElement;
  /** 隠れている枠・バーだけの枠の落とし先 (高さ 40px の点線の箱。C2.3)。ドラッグの間だけ出す */
  marker: HTMLElement;
  tabRow: HTMLElement;
  /** 窓の置き場。窓ごとの箱 (pane) を並べ、前のタブの箱だけを出す */
  content: HTMLElement;
  /** 入っている窓 (タブの並び。前から = 入れた順) */
  tabs: WindowId[];
  /**
   * ユーザーが前に出したタブ。**見えていなければ、見えているタブの先頭を出す (この値は変えない)**。窓が隠れた
   * だけで書き換えると、読み込み直後や一覧が 0 個になっただけで保存が走る
   */
  active: WindowId | undefined;
  /** 差す先があり、幅があるか (attach で測る) */
  usable: boolean;
};

function createSlot(id: DockSlotId): Slot {
  const root = document.createElement("div");
  root.id = `yt-clip-dock-${id}`;
  root.style.cssText = DOCK_STYLE.root;
  root.style.display = "none";
  const marker = document.createElement("div");
  marker.dataset.role = "dock-marker";
  marker.style.cssText = DOCK_STYLE.marker;
  marker.textContent = "ここにドック";
  marker.style.display = "none";
  const tabRow = document.createElement("div");
  tabRow.dataset.role = "dock-tabs";
  tabRow.style.cssText = DOCK_STYLE.tabRow;
  tabRow.style.display = "none";
  const content = document.createElement("div");
  content.dataset.role = "dock-content";
  // 目印は枠の先頭 (C2.3: 帯は枠の上の段だけ)。タブの列 → 置き場の順
  root.append(marker, tabRow, content);
  return { id, root, marker, tabRow, content, tabs: [], active: undefined, usable: false };
}

export function createDockManager(options: DockManagerOptions): DockManager {
  const slots: Record<DockSlotId, Slot> = { below: createSlot("below"), side: createSlot("side") };
  const allSlots: Slot[] = DOCK_SLOT_IDS.map((id) => slots[id]);
  /**
   * 窓ごとの箱 (枠の置き場の中)。前のタブかどうかはこの箱の display で切り替える。**窓の要素の display は
   * youtube.ts の setVisible (出す条件) が持つ** ので、2 つの軸が同じ style.display を取り合わない (C2.8)
   */
  const panes = new Map<WindowId, HTMLElement>();
  /**
   * 窓ごとのタブ。**描き直しても作り直さない** (押している最中に状態の通知で sync が走ってタブを作り直すと、
   * 捕捉が外れて押したことが消える)。描き直すのは並びと見た目だけ
   */
  const tabElements = new Map<WindowId, HTMLElement>();
  /** 入っている枠が使えないため、浮いた窓で出している窓 (退避。C2.1)。onEvacuate を 2 度呼ばないため */
  const evacuated = new Set<WindowId>();

  function findSlot(id: WindowId): Slot | null {
    return allSlots.find((slot) => slot.tabs.includes(id)) ?? null;
  }

  function paneOf(id: WindowId): HTMLElement {
    const existing = panes.get(id);
    if (existing !== undefined) return existing;
    const pane = document.createElement("div");
    pane.dataset.role = "dock-pane";
    pane.dataset.window = id;
    panes.set(id, pane);
    return pane;
  }

  function tabOf(id: WindowId): HTMLElement {
    const existing = tabElements.get(id);
    if (existing !== undefined) return existing;
    const tab = document.createElement("div");
    tab.dataset.role = "dock-tab";
    tab.dataset.window = id;
    tab.textContent = options.titles[id];
    tab.title = "押すと前に出す。ドラッグで取り出す (ダブルクリックで最初の位置へ)";
    tabElements.set(id, tab);
    return tab;
  }

  /** 窓を body へ戻して浮いた窓にする (箱は捨てる) */
  function releaseToBody(id: WindowId): void {
    const frame = options.windows[id];
    if (frame.element.parentElement !== document.body) document.body.append(frame.element);
    frame.setDocked(false);
    panes.get(id)?.remove();
    panes.delete(id);
  }

  /** 枠に入っている窓を置く。使える枠なら置き場の箱へ、使えない枠なら退避 (body の浮いた窓) */
  function placeWindows(slot: Slot, shown: WindowId | undefined): void {
    for (const id of slot.tabs) {
      if (!slot.usable) {
        if (evacuated.has(id)) continue;
        evacuated.add(id);
        releaseToBody(id);
        options.onEvacuate(id);
        continue;
      }
      evacuated.delete(id);
      const frame = options.windows[id];
      const pane = paneOf(id);
      if (pane.parentElement !== slot.content) slot.content.append(pane);
      if (frame.element.parentElement !== pane) pane.append(frame.element);
      frame.setDocked(true);
      pane.style.display = id === shown ? "block" : "none";
    }
  }

  /**
   * タブの列を ids の並びにする。前のタブ (shown) は見た目と data-active で見分ける。**差分だけを動かす**: 要らなくなった
   * タブだけを外し、並びの違うタブだけを差し直す (押している最中のタブを付け直すと捕捉が外れる。判断メモ 36)
   */
  function renderTabs(slot: Slot, ids: WindowId[], shown: WindowId | undefined): void {
    const desired = ids.map((id) => {
      const tab = tabOf(id);
      const active = id === shown;
      tab.style.cssText = active ? DOCK_STYLE.tabActive : DOCK_STYLE.tab;
      tab.dataset.active = String(active);
      return tab;
    });
    for (const child of [...slot.tabRow.children]) {
      if (!desired.includes(child as HTMLElement)) child.remove();
    }
    desired.forEach((tab, index) => {
      const at = slot.tabRow.children[index] ?? null;
      if (at !== tab) slot.tabRow.insertBefore(tab, at);
    });
  }

  /**
   * 1 つの枠を描き直す (C2.2)。見えている窓 (hidden でない) のタブだけを出し、前のタブの窓だけを置き場に出す。
   * **枠の中の窓が 1 つでバーのときだけタブの列を出さない** (⠿ で掴めるうえ、1440x795 の高さの予算に 28px が入らない)。
   * 見えている窓が無い枠・使えない枠は枠ごと隠す
   */
  function render(slot: Slot): void {
    const visible = slot.tabs.filter((id) => !options.windows[id].element.hidden);
    const shown =
      slot.active !== undefined && visible.includes(slot.active) ? slot.active : visible[0];
    placeWindows(slot, shown);
    const showTabs = visible.length > 0 && !(visible.length === 1 && visible[0] === "bar");
    renderTabs(slot, showTabs ? visible : [], shown);
    slot.tabRow.style.display = showTabs ? "flex" : "none";
    slot.root.style.display = slot.usable && visible.length > 0 ? "block" : "none";
    applyGaps(slot, visible.length > 0);
  }

  /** 枠の余白。窓が見えている間だけ下の余白と、下の枠の上の余白の補正を当てる (判断メモ 37) */
  function applyGaps(slot: Slot, hasWindows: boolean): void {
    slot.root.style.marginBottom = `${hasWindows ? DOCK_SLOT_GAP_PX : 0}px`;
    slot.root.style.marginTop = `${hasWindows && slot.id === "below" ? BELOW_SLOT_MARGIN_TOP_PX : 0}px`;
  }

  function state(): DockState {
    const result: DockState = {};
    for (const slot of allSlots) {
      if (slot.tabs.length === 0) continue;
      result[slot.id] =
        slot.active === undefined
          ? { tabs: [...slot.tabs] }
          : { tabs: [...slot.tabs], active: slot.active };
    }
    return result;
  }

  function dock(id: WindowId, slotId: DockSlotId): void {
    // 落とし先の帯は入れられる枠にしか出さないので、ここへ来るのは配線の誤り。黙って捨てない
    if (!options.accepts(id, slotId)) {
      throw new Error(`[yt-clip] ${id} の窓は ${slotId} の枠に入れられません`);
    }
    const from = findSlot(id);
    const to = slots[slotId];
    if (from !== null) {
      from.tabs = from.tabs.filter((tab) => tab !== id);
      if (from.active === id) from.active = undefined;
    }
    // 並びは入れた順 (末尾に付く)。落とした窓を前に出す (C2.2 / C2.3)
    to.tabs = [...to.tabs, id];
    to.active = id;
    if (from !== null && from !== to) render(from);
    render(to);
    options.onChange(state());
  }

  function undock(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null) return;
    slot.tabs = slot.tabs.filter((tab) => tab !== id);
    if (slot.active === id) slot.active = undefined;
    evacuated.delete(id);
    releaseToBody(id);
    // 元の枠は残りの窓ですぐ描き直す (C2.4)
    render(slot);
    options.onChange(state());
  }

  function restore(id: WindowId): void {
    const home = allSlots.find((slot) => options.initial[slot.id]?.tabs.includes(id) === true);
    if (home === undefined) {
      undock(id);
      return;
    }
    const order = options.initial[home.id]?.tabs ?? [];
    /** 最初の配置の並びでの位置。最初の配置に無い窓は後ろ */
    const rank = (tab: WindowId): number => {
      const index = order.indexOf(tab);
      return index === -1 ? order.length : index;
    };
    const from = findSlot(id);
    if (from !== home) {
      if (from !== null) {
        from.tabs = from.tabs.filter((tab) => tab !== id);
        if (from.active === id) from.active = undefined;
      }
      // 最初の配置の並びの位置へ入れる (末尾に付けると、戻すたびに並びが操作の履歴で変わる)
      const tabs = [...home.tabs];
      const at = tabs.findIndex((tab) => rank(tab) > rank(id));
      tabs.splice(at === -1 ? tabs.length : at, 0, id);
      home.tabs = tabs;
    }
    home.active = id;
    if (from !== null && from !== home) render(from);
    render(home);
    options.onChange(state());
  }

  function activate(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null || slot.active === id) return;
    slot.active = id;
    render(slot);
    options.onChange(state());
  }

  return {
    elements: { below: slots.below.root, side: slots.side.root },

    attach(anchors: Record<DockSlotId, Element | null>): boolean {
      let changed = false;
      for (const slot of allSlots) {
        const anchor = anchors[slot.id];
        // YouTube が差す先の子を作り直すと、枠は中の窓ごとメモリに残って外れる。先頭に差し直す (C2.7)。
        // 差す先の中にあれば動かさない (YouTube が後から先頭に何かを足しても、取り合わない)
        if (anchor !== null && !anchor.contains(slot.root)) anchor.prepend(slot.root);
        // 差す先が無い (動画ページ以外・SPA の途中・1 列表示で消えた) か幅 0 なら使えない (C2.1)
        const usable = anchor !== null && anchor.getBoundingClientRect().width > 0;
        if (usable !== slot.usable) {
          slot.usable = usable;
          changed = true;
        }
      }
      return changed;
    },

    isUsable(slot: DockSlotId): boolean {
      return slots[slot].usable;
    },

    load(saved: DockState): void {
      for (const slot of allSlots) {
        const entry = saved[slot.id];
        slot.tabs = entry === undefined ? [] : [...entry.tabs];
        slot.active = entry?.active;
      }
    },

    dock,
    undock,
    restore,
    activate,

    slotOf(id: WindowId): DockSlotId | null {
      return findSlot(id)?.id ?? null;
    },

    sync(): void {
      for (const slot of allSlots) render(slot);
    },

    state,

    destroy(): void {
      for (const slot of allSlots) slot.root.remove();
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/dock.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`dock.ts` はまだどこからも import されない)

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/styles.ts src/content/dock.ts tests/content/dock.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): ページの中のドック枠を作り、窓を入れる・出す・タブで切り替える

窓をプレイヤーの下とおすすめ動画の上に入れるための枠を dock.ts に
まとめる。枠は窓の中身も出す条件も知らず、窓の hidden だけを見て
タブと枠の出し入れを決める。YouTube が差す先を作り直したら先頭に
差し直し、差す先が消えた・幅 0 の間は中の窓を浮かせて (退避)、
戻ったら枠へ戻す。読み込みと、隠れたタブの表示の切り替えでは
保存を求めない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: 落とし先の見せ方と当たり判定、タブの押す / 引き出す (`dock.ts` の後半)

**Files:**
- Modify: `src/content/dock.ts` (ファイル全体を置き換える。Task 5 の版に `drag` と、タブの pointer の扱い、帯の描き方を足す)
- Test: `tests/content/dock.test.ts`

**Interfaces:**
- Consumes: Task 4 の `UNDOCK_THRESHOLD_PX` / `DragPoint` / `DragPhase` / `FloatingWindow.beginMoveFrom`、Task 5 の `createDockManager` と DOM
- Produces:
  - `DockManager.drag(id: WindowId, phase: DragPhase, point: DragPoint): DockSlotId | null` — start で落とし先の帯を出して測り、
    move で当たり判定と塗り、end で当たっている枠に入れて (dock) その枠を返す。入れなければ null
  - `export const DOCK_ARM_DISTANCE_PX = 40`
  - 帯の目印: 帯になっている要素 (タブの列か `[data-role=dock-marker]`) に `data-drop-target="true"`、指が中なら `data-drop-hover="true"`
  - タブ: 押して UNDOCK_THRESHOLD_PX 未満で離すと `activate`、以上動かすと `undock` → `onUndock(id, point, grab)` → 窓の `beginMoveFrom(tab, event, 押した点)`。
    掴んだタブは指を離す (drag の end) まで `display: none` で DOM に残す。ダブルクリックで `onTabDoubleClick(id)`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/dock.test.ts` の `setup` の中の `make` を次に置き換える (youtube.ts と同じく、窓のドラッグの指の位置を枠の当たり判定へ渡す。
`manager` は下で作るので、後から入る変数を見る)。

```typescript
  let manager: DockManager | null = null;
  const make = (id: WindowId): FloatingWindow => {
    const frame = createFloatingWindow({
      id: `win-${id}`,
      title: id === "bar" ? undefined : TITLES[id],
      resize: id === "bar" ? "width" : "both",
      minWidth: 280,
      onUserMove: () => undefined,
      onResetRequest: () => undefined,
      onDragPoint: (phase, point) => (manager?.drag(id, phase, point) ?? null) !== null,
    });
    document.body.append(frame.element);
    frame.setVisible(true);
    return frame;
  };
```

同じ `setup` の中の

```typescript
  const manager = createDockManager({
```

を次に置き換える。

```typescript
  manager = createDockManager({
```

`setup` の残りの行 (`manager.attach({ below, side });` から `return made;` まで) は変えない。`manager = createDockManager({ … })` の
代入の後は、TypeScript が `manager` を `DockManager` に絞るので、`manager.attach(…)` と `made = { manager, … }` はそのまま通る。

ヘルパ (`paneDisplay` の後) に次を足す。

```typescript
/** 帯の中の点 (下の枠 / 右の枠)。目印 (40px) にもタブの列 (28px) にも入る高さ */
const BELOW_BAND = { x: 100, y: 610 };
const SIDE_BAND = { x: 900, y: 70 };
/** どの帯からも離れた点 */
const AWAY = { x: 300, y: 300 };

function markerOf(slot: DockSlotId): HTMLElement {
  const marker = slotRoot(slot).querySelector<HTMLElement>("[data-role='dock-marker']");
  if (marker === null) throw new Error("目印がありません");
  return marker;
}

/** 落とし先の帯になっている要素 (無ければ null) */
function bandOf(slot: DockSlotId): HTMLElement | null {
  return slotRoot(slot).querySelector<HTMLElement>("[data-drop-target='true']");
}

function tabOf(slot: DockSlotId, id: WindowId): HTMLElement {
  const tab = tabRowOf(slot).querySelector<HTMLElement>(`[data-role='dock-tab'][data-window='${id}']`);
  if (tab === null) throw new Error(`${id} のタブがありません`);
  return tab;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}
```

ファイルの末尾に次を足す。

```typescript
describe("落とし先 (drag)", () => {
  test("帯の外から入り、開始点から 40px 以上離れた点で離すと、その枠の末尾に入れて前に出す", () => {
    const { manager, windows, onChange } = setup();

    manager.drag("list", "start", AWAY);
    manager.drag("list", "move", SIDE_BAND);
    const slot = manager.drag("list", "end", SIDE_BAND);

    expect(slot).toBe("side");
    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ side: { tabs: ["list"], active: "list" } });
  });

  test("枠の中身 (置き場) の上や、帯の外で離しても入れない", () => {
    const { manager } = setup();
    manager.dock("settings", "side");

    manager.drag("list", "start", AWAY);
    manager.drag("list", "move", { x: 900, y: 200 });
    expect(manager.drag("list", "end", { x: 900, y: 200 })).toBeNull();

    manager.drag("list", "start", AWAY);
    expect(manager.drag("list", "end", { x: 500, y: 400 })).toBeNull();
    expect(manager.slotOf("list")).toBeNull();
  });

  test("開始点から 40px 未満では、帯の中で離しても入れない (距離の武装)", () => {
    const { manager } = setup();
    // 帯 (右の枠の目印: 上端 60・高さ 40) のすぐ下から始め、30px 上の帯の中で離す
    manager.drag("list", "start", { x: 900, y: 110 });
    manager.drag("list", "move", { x: 900, y: 80 });
    expect(manager.drag("list", "end", { x: 900, y: 80 })).toBeNull();
  });

  test("始めたときに帯の中にあった指は、一度その帯の外へ出るまで当てない (40px 以上離れていても)", () => {
    const { manager } = setup();
    manager.drag("list", "start", { x: 850, y: 70 });
    manager.drag("list", "move", { x: 1200, y: 70 });
    expect(manager.drag("list", "end", { x: 1200, y: 70 })).toBeNull();

    manager.drag("list", "start", { x: 850, y: 70 });
    manager.drag("list", "move", { x: 900, y: 200 });
    manager.drag("list", "move", SIDE_BAND);
    expect(manager.drag("list", "end", SIDE_BAND)).toBe("side");
  });

  test("隠れている枠は start で目印をページの流れへ出し、出した後で帯を測る", () => {
    const { manager } = setup();
    const displaysWhenMeasured: string[] = [];
    const spy = vi.mocked(Element.prototype.getBoundingClientRect);
    const measure = spy.getMockImplementation();
    spy.mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.role === "dock-marker") {
        displaysWhenMeasured.push(this.style.display);
      }
      return measure === undefined ? boxAt(0, 0, 0, 0) : measure.call(this);
    });
    expect(markerOf("side").style.display).toBe("none");

    manager.drag("list", "start", AWAY);

    expect(markerOf("side").style.display).toBe("flex");
    expect(slotRoot("side").style.display).toBe("block");
    expect(displaysWhenMeasured.length).toBeGreaterThan(0);
    expect(displaysWhenMeasured.every((display) => display === "flex")).toBe(true);
    manager.drag("list", "end", AWAY);
  });

  test("落とし先の帯は入れられる枠にだけ出す (バーのドラッグでは右の枠に出さない)", () => {
    const { manager } = setup();

    manager.drag("bar", "start", AWAY);

    expect(bandOf("below")).toBe(markerOf("below"));
    expect(bandOf("side")).toBeNull();
    expect(markerOf("side").style.display).toBe("none");
    expect(manager.drag("bar", "end", SIDE_BAND)).toBeNull();
  });

  test("タブの列がある枠は、タブの列そのものが帯になる (目印は出さない)", () => {
    const { manager } = setup();
    manager.dock("settings", "side");

    manager.drag("list", "start", AWAY);

    expect(bandOf("side")).toBe(tabRowOf("side"));
    expect(markerOf("side").style.display).toBe("none");
    manager.drag("list", "end", AWAY);
  });

  test("指が中にある帯は塗り (data-drop-hover)、離すと帯も塗りも消す", () => {
    const { manager } = setup();
    manager.drag("list", "start", AWAY);
    manager.drag("list", "move", SIDE_BAND);
    expect(markerOf("side").dataset.dropHover).toBe("true");

    manager.drag("list", "move", AWAY);
    expect(markerOf("side").dataset.dropHover).toBeUndefined();

    manager.drag("list", "end", AWAY);
    expect(bandOf("side")).toBeNull();
    expect(bandOf("below")).toBeNull();
    expect(slotRoot("side").style.display).toBe("none");
  });

  test("目印だけの間は、枠の余白を 0 にする (下の内容は目印の高さだけ下がる)", () => {
    const { manager } = setup();
    manager.drag("list", "start", AWAY);
    expect(markerOf("side").style.display).toBe("flex");
    expect(slotRoot("side").style.marginBottom).toBe("0px");
    manager.drag("list", "end", AWAY);
  });

  test("窓の見出しのドラッグ (onDragPoint) からそのまま入る", () => {
    const { windows } = setup();
    const header = windows.list.element.querySelector<HTMLElement>("[data-role='window-header']");
    if (header === null) throw new Error("見出しがありません");

    pointer(header, "pointerdown", AWAY.x, AWAY.y);
    pointer(header, "pointermove", AWAY.x + 10, AWAY.y);
    pointer(header, "pointermove", SIDE_BAND.x, SIDE_BAND.y);
    pointer(header, "pointerup", SIDE_BAND.x, SIDE_BAND.y);

    expect(windows.list.element.closest("#yt-clip-dock-side")).not.toBeNull();
  });
});

describe("タブ", () => {
  test("押して 8px 未満で離すと、そのタブを前に出す", () => {
    const { manager, onUndock } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");

    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 863, 70);
    pointer(tab, "pointerup", 863, 70);

    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(onUndock).not.toHaveBeenCalled();
  });

  test("8px 以上動かすと枠から出して onUndock (指の位置・タブの中で押した点) を呼び、元の枠は残りの窓ですぐ描き直す", () => {
    const { manager, windows, onUndock } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    manager.activate("list");

    // タブの箱は (848, 60) から (stub)。(860, 70) で押す = タブの中の (12, 10)
    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 860, 80);

    expect(onUndock).toHaveBeenCalledWith("list", { x: 860, y: 80 }, { x: 12, y: 10 });
    expect(windows.list.element.parentElement).toBe(document.body);
    expect(manager.slotOf("list")).toBeNull();
    expect(tabLabels("side")).toEqual(["設定"]);
    pointer(tab, "pointerup", 860, 80);
  });

  test("残りが 0 になった枠は、ドラッグの間は 40px の目印に変わる", () => {
    const { manager } = setup();
    manager.dock("list", "side");

    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 860, 90);

    expect(tabRowOf("side").style.display).toBe("none");
    expect(markerOf("side").style.display).toBe("flex");
    expect(slotRoot("side").style.display).toBe("block");
    pointer(tab, "pointerup", 860, 90);
  });

  test("掴んだタブの要素だけは、指を離すまで DOM に残す (display: none。捕捉が付いている)", () => {
    const { manager } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");

    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 860, 90);
    expect(tab.isConnected).toBe(true);
    expect(tab.style.display).toBe("none");

    // 設定のタブが描き直されても、掴んだタブは外さない
    manager.sync();
    expect(tab.isConnected).toBe(true);

    pointer(tab, "pointermove", 400, 300);
    pointer(tab, "pointerup", 400, 300);
    expect(tab.isConnected).toBe(false);
  });

  test("引き出した直後は元の枠の帯の中にあるので、一度帯を出て入り直すまで戻さない", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");

    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 1100, 70);
    pointer(tab, "pointerup", 1100, 70);
    expect(windows.list.element.parentElement).toBe(document.body);
  });

  test("引き出したまま別の枠へ落とせる", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");

    const tab = tabOf("side", "list");
    pointer(tab, "pointerdown", 860, 70);
    pointer(tab, "pointermove", 860, 90);
    pointer(tab, "pointermove", AWAY.x, AWAY.y);
    pointer(tab, "pointermove", BELOW_BAND.x, BELOW_BAND.y);
    pointer(tab, "pointerup", BELOW_BAND.x, BELOW_BAND.y);

    expect(windows.list.element.closest("#yt-clip-dock-below")).not.toBeNull();
    expect(manager.state()).toEqual({ below: { tabs: ["list"], active: "list" } });
  });

  test("押している最中に別のタブが消えても、押しているタブは付け直さない (捕捉が外れない)", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");
    manager.dock("settings", "side");
    const tab = tabOf("side", "list");
    const observer = new MutationObserver(() => undefined);
    observer.observe(tabRowOf("side"), { childList: true });
    pointer(tab, "pointerdown", 860, 70);

    windows.settings.setVisible(false);
    manager.sync();

    const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes]);
    observer.disconnect();
    expect(removed).not.toContain(tab);
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    pointer(tab, "pointerup", 860, 70);
  });

  test("タブのダブルクリックで onTabDoubleClick", () => {
    const { manager, onTabDoubleClick } = setup();
    manager.dock("list", "side");
    tabOf("side", "list").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onTabDoubleClick).toHaveBeenCalledWith("list");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/dock.test.ts` (Bash の timeout 120000)
期待: FAIL。`manager.drag` が無い (型の誤りで typecheck も落ちる。vitest は型を見ないので `drag is not a function` で落ちる)、タブを押しても前に出ない

- [ ] **Step 3: 最小実装**

`src/content/dock.ts` を次の内容に置き換える (Task 5 からの変更: import、`DOCK_ARM_DISTANCE_PX`、`DockManager.drag`、`Slot.band`、
`Dragging` と `contains`、`dragging` / `grabbedTab`、`tabOf` のリスナ、`pressTab` / `pullOut`、`renderTabs` の掴んだタブの扱い、
`render` の帯、`hitTest` / `drag`、戻り値の `drag`)。

```typescript
import {
  UNDOCK_THRESHOLD_PX,
  type DragPhase,
  type DragPoint,
  type FloatingWindow,
} from "@/content/floating-window";
import { DOCK_STYLE } from "@/content/styles";
import {
  DOCK_SLOT_IDS,
  type DockSlotId,
  type DockState,
  type WindowId,
} from "@/content/window-layout";

export type { DockSlotId, DockState } from "@/content/window-layout";

/**
 * ページの中のドック枠 2 か所とタブ (`.claude/specs/2026-09-25-dockable-windows-design.md` C2)。
 * 下の枠 (#yt-clip-dock-below) は #below の先頭、右の枠 (#yt-clip-dock-side) は #secondary-inner の先頭に差し、
 * ページと一緒にスクロールする。
 *
 * 枠 (根・タブの列・窓の置き場)、入れる / 出す / 前に出す、落とし先の見せ方と当たり判定、タブからの引き出し、
 * 差し直し、退避、保存用の形を持つ。**窓の中身と、窓を出す条件は知らない** (youtube.ts が決め、窓の `hidden` として
 * 見える)。浮いた窓の位置も知らない: 退避した窓は onEvacuate、引き出した窓は onUndock で youtube.ts が置く
 */

/**
 * 下の枠の上の余白の補正 (px。負で詰める)。1440x795 でバーだけを下の枠に入れたとき、枠の外形が画面に収まる予算は
 * 795 − 628 (プレイヤーの下端の実測) = 167px、バーの窓は約 140px (C2.10)。#below の上の余白が 27px を超えると収まらない
 * ので、そのときは実測に合わせてここを負にする (YouTube の余白を枠の margin-top で相殺する)
 */
export const BELOW_SLOT_MARGIN_TOP_PX = 0;
/**
 * 窓が見えている枠の下の余白 (動画のタイトル・おすすめ動画との間)。**目印だけの間 (ドラッグ中の空の枠) は 0** にして、
 * 下の内容が目印の高さ (40px) だけ下がるようにする (C2.3)
 */
export const DOCK_SLOT_GAP_PX = 12;

/**
 * 落とし先に当てるまでに、指がドラッグの開始点から離れていなければならない距離 (C2.3 の距離の武装)。目印の高さと
 * 同じ。最初の位置の窓は帯とずれて重なるので、「帯に外から入った」だけでは、掴む高さ次第で少し動かしただけで
 * 吸い込まれる。値は可逆
 */
export const DOCK_ARM_DISTANCE_PX = 40;

export type DockManager = {
  /** 2 つの枠の根。配色 (applyPalette) を当てるために見せる */
  elements: Record<DockSlotId, HTMLElement>;
  /**
   * 枠を差す先に付け直す (mount・resize のたび)。差す先の中に無ければ先頭に差す。差す先が無い・幅 0 の枠は
   * 使えない (isUsable が false。中の窓は次の sync で退避)。**使えるかが変わったら true** (呼び出し側が窓を出し直す)
   */
  attach(anchors: Record<DockSlotId, Element | null>): boolean;
  isUsable(slot: DockSlotId): boolean;
  /** 覚えた枠の中身を入れる (読み込みの 1 回)。**onChange を呼ばない** (読み込みは書かない)。置くのは次の sync */
  load(state: DockState): void;
  /** 枠の末尾に入れて前に出す (C2.3)。入れられない組み合わせは throw (配線の誤り) */
  dock(id: WindowId, slot: DockSlotId): void;
  /** 枠から出して body へ戻し、浮いた窓にする。どこに置くかは呼び出し側が決める */
  undock(id: WindowId): void;
  /**
   * 最初の配置へ戻す (ダブルクリック。C2.6): options.initial で入る枠へ、最初の配置の並びの位置に入れて前に出し、onChange。
   * 既にその枠にあれば並びは変えず前に出すだけ。最初の配置で枠に入らない窓なら undock。戻す先の枠が使えなければ、記憶に
   * 入れたまま退避 (onEvacuate)
   */
  restore(id: WindowId): void;
  /** その窓のタブを前に出す。枠に入っていなければ何もしない */
  activate(id: WindowId): void;
  /** 入っている枠 (使えない枠で退避中も含む)。入っていなければ null */
  slotOf(id: WindowId): DockSlotId | null;
  /** 窓の出す条件 (hidden) が変わった後に呼ぶ。窓の置き場・タブ・枠の出し入れ・退避を合わせる */
  sync(): void;
  /**
   * 浮いた窓のドラッグの落とし先 (C2.3)。start で入れられる枠に帯を出して (隠れている枠・バーだけの枠は 40px の目印を
   * ページの流れへ出して) から測り、指が既に中にある帯は「出るまで待ち」にする。move で当たり判定と塗り、end で
   * 当たっている枠の末尾に入れて前に出し、その枠を返す (入れなければ null)。当たるのは、指が帯の中にあり、開始点から
   * DOCK_ARM_DISTANCE_PX 以上離れ、その帯に外から入ったときだけ
   */
  drag(id: WindowId, phase: DragPhase, point: DragPoint): DockSlotId | null;
  /** 保存用の形 (写し) */
  state(): DockState;
  destroy(): void;
};

export type DockManagerOptions = {
  windows: Record<WindowId, FloatingWindow>;
  /** タブの文言 (窓の見出しと同じ。バーは見出しを作らないので「バー」) */
  titles: Record<WindowId, string>;
  /** 最初の配置 (window-layout.ts の initialDocks)。restore の戻し先と並び順 */
  initial: DockState;
  accepts(id: WindowId, slot: DockSlotId): boolean;
  /**
   * タブを掴んで UNDOCK_THRESHOLD_PX 動かした (C2.4)。窓はもう枠から出て body にある。呼ばれた側は窓を指の下に置く
   * (grab はタブの左上から見た押した点)。その後のドラッグの続きは dock.ts が窓の beginMoveFrom で始める
   */
  onUndock(id: WindowId, point: DragPoint, grab: DragPoint): void;
  /** タブのダブルクリック (最初の位置に戻す。C2.6) */
  onTabDoubleClick(id: WindowId): void;
  /**
   * 入っている枠が使えなくなったので、窓を body へ移して浮かせた (退避。C2.1)。呼ばれた側は最初の位置に置く。
   * ドックの記憶 (tabs) は消さない。退避している間は 1 回だけ呼ぶ
   */
  onEvacuate(id: WindowId): void;
  /** 入れた・出した・前に出した (ユーザーの操作。保存の合図) */
  onChange(state: DockState): void;
};

type Slot = {
  id: DockSlotId;
  root: HTMLElement;
  /** 隠れている枠・バーだけの枠の落とし先 (高さ 40px の点線の箱。C2.3)。ドラッグの間だけ出す */
  marker: HTMLElement;
  tabRow: HTMLElement;
  /** 窓の置き場。窓ごとの箱 (pane) を並べ、前のタブの箱だけを出す */
  content: HTMLElement;
  /** 入っている窓 (タブの並び。前から = 入れた順) */
  tabs: WindowId[];
  /**
   * ユーザーが前に出したタブ。**見えていなければ、見えているタブの先頭を出す (この値は変えない)**。窓が隠れた
   * だけで書き換えると、読み込み直後や一覧が 0 個になっただけで保存が走る
   */
  active: WindowId | undefined;
  /** 差す先があり、幅があるか (attach で測る) */
  usable: boolean;
  /** ドラッグの間、落とし先の帯になっている要素 (タブの列か目印)。ドラッグしていない・入れられない枠では null */
  band: HTMLElement | null;
};

/** ドラッグ中の窓 (C2.3)。drag("start") から drag("end") まで */
type Dragging = {
  id: WindowId;
  /** ドラッグの開始点。ここから DOCK_ARM_DISTANCE_PX 離れるまで当てない */
  origin: DragPoint;
  /** 始めたときに指が中にあった帯。一度その帯の外へ出るまで当てない */
  waitingOut: Set<DockSlotId>;
  /** 当たっている帯 (離すとここに入れる) */
  hover: DockSlotId | null;
};

function contains(box: DOMRect, point: DragPoint): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

function createSlot(id: DockSlotId): Slot {
  const root = document.createElement("div");
  root.id = `yt-clip-dock-${id}`;
  root.style.cssText = DOCK_STYLE.root;
  root.style.display = "none";
  const marker = document.createElement("div");
  marker.dataset.role = "dock-marker";
  marker.style.cssText = DOCK_STYLE.marker;
  marker.textContent = "ここにドック";
  marker.style.display = "none";
  const tabRow = document.createElement("div");
  tabRow.dataset.role = "dock-tabs";
  tabRow.style.cssText = DOCK_STYLE.tabRow;
  tabRow.style.display = "none";
  const content = document.createElement("div");
  content.dataset.role = "dock-content";
  // 目印は枠の先頭 (C2.3: 帯は枠の上の段だけ)。タブの列 → 置き場の順
  root.append(marker, tabRow, content);
  return {
    id,
    root,
    marker,
    tabRow,
    content,
    tabs: [],
    active: undefined,
    usable: false,
    band: null,
  };
}

export function createDockManager(options: DockManagerOptions): DockManager {
  const slots: Record<DockSlotId, Slot> = { below: createSlot("below"), side: createSlot("side") };
  const allSlots: Slot[] = DOCK_SLOT_IDS.map((id) => slots[id]);
  /**
   * 窓ごとの箱 (枠の置き場の中)。前のタブかどうかはこの箱の display で切り替える。**窓の要素の display は
   * youtube.ts の setVisible (出す条件) が持つ** ので、2 つの軸が同じ style.display を取り合わない (C2.8)
   */
  const panes = new Map<WindowId, HTMLElement>();
  /**
   * 窓ごとのタブ。**描き直しても作り直さない** (押している最中に状態の通知で sync が走ってタブを作り直すと、
   * 捕捉が外れて押したことが消える)。描き直すのは並びと見た目だけ
   */
  const tabElements = new Map<WindowId, HTMLElement>();
  /** 入っている枠が使えないため、浮いた窓で出している窓 (退避。C2.1)。onEvacuate を 2 度呼ばないため */
  const evacuated = new Set<WindowId>();
  let dragging: Dragging | null = null;
  /**
   * タブから引き出した窓の、掴んだタブの要素。**指を離す (drag の end) まで DOM に残す** (display: none)。
   * Pointer Events の捕捉がこの要素に付いており、外すと lostpointercapture でドラッグが終わる (C2.4)
   */
  let grabbedTab: HTMLElement | null = null;

  function findSlot(id: WindowId): Slot | null {
    return allSlots.find((slot) => slot.tabs.includes(id)) ?? null;
  }

  function paneOf(id: WindowId): HTMLElement {
    const existing = panes.get(id);
    if (existing !== undefined) return existing;
    const pane = document.createElement("div");
    pane.dataset.role = "dock-pane";
    pane.dataset.window = id;
    panes.set(id, pane);
    return pane;
  }

  function tabOf(id: WindowId): HTMLElement {
    const existing = tabElements.get(id);
    if (existing !== undefined) return existing;
    const tab = document.createElement("div");
    tab.dataset.role = "dock-tab";
    tab.dataset.window = id;
    tab.textContent = options.titles[id];
    tab.title = "押すと前に出す。ドラッグで取り出す (ダブルクリックで最初の位置へ)";
    tab.addEventListener("pointerdown", (event: PointerEvent) => pressTab(id, tab, event));
    tab.addEventListener("dblclick", () => options.onTabDoubleClick(id));
    tabElements.set(id, tab);
    return tab;
  }

  /**
   * タブを押した (C2.4)。UNDOCK_THRESHOLD_PX 未満で離したら前に出す。それ以上動いたら枠から引き出し、
   * ドラッグは窓の移動として続ける。捕捉はタブに付けたまま渡す
   */
  function pressTab(id: WindowId, tab: HTMLElement, event: PointerEvent): void {
    if (event.button !== 0) return;
    // 文字の選択やページのスクロールを始めさせない
    event.preventDefault();
    const pointerId = event.pointerId;
    const origin: DragPoint = { x: event.clientX, y: event.clientY };
    const box = tab.getBoundingClientRect();
    /** タブの左上から見た押した点 (引き出した窓を、掴んだ位置関係を保って置くため) */
    const grab: DragPoint = { x: origin.x - box.left, y: origin.y - box.top };
    tab.setPointerCapture(pointerId);

    const stop = (): void => {
      tab.removeEventListener("pointermove", onMove);
      tab.removeEventListener("pointerup", onUp);
      tab.removeEventListener("pointercancel", onCancel);
      tab.removeEventListener("lostpointercapture", onCancel);
    };
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      if (Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < UNDOCK_THRESHOLD_PX) return;
      // 捕捉は解かない。続きのドラッグ (窓の移動) が同じタブの捕捉を使う
      stop();
      pullOut(id, tab, move, origin, grab);
    };
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      stop();
      activate(id);
    };
    const onCancel = (cancel: Event): void => {
      const cancelId = (cancel as PointerEvent).pointerId;
      if (cancelId !== undefined && cancelId !== pointerId) return;
      stop();
    };
    tab.addEventListener("pointermove", onMove);
    tab.addEventListener("pointerup", onUp);
    tab.addEventListener("pointercancel", onCancel);
    tab.addEventListener("lostpointercapture", onCancel);
  }

  /**
   * タブから窓を引き出す (C2.4)。元の枠は残りの窓ですぐ描き直し (当たり判定はその後の帯で測る)、窓は youtube.ts が
   * 指の下に置き、ドラッグは窓の beginMoveFrom で続ける (開始点はタブを押した点。C2.3 の距離の起点)
   */
  function pullOut(
    id: WindowId,
    tab: HTMLElement,
    move: PointerEvent,
    origin: DragPoint,
    grab: DragPoint,
  ): void {
    // 掴んだタブは外さず隠すだけ。次にこの窓を入れたときは新しいタブを作る
    tabElements.delete(id);
    tab.style.display = "none";
    grabbedTab = tab;
    undock(id);
    options.onUndock(id, { x: move.clientX, y: move.clientY }, grab);
    options.windows[id].beginMoveFrom(tab, move, origin);
  }

  /** 窓を body へ戻して浮いた窓にする (箱は捨てる) */
  function releaseToBody(id: WindowId): void {
    const frame = options.windows[id];
    if (frame.element.parentElement !== document.body) document.body.append(frame.element);
    frame.setDocked(false);
    panes.get(id)?.remove();
    panes.delete(id);
  }

  /** 枠に入っている窓を置く。使える枠なら置き場の箱へ、使えない枠なら退避 (body の浮いた窓) */
  function placeWindows(slot: Slot, shown: WindowId | undefined): void {
    for (const id of slot.tabs) {
      if (!slot.usable) {
        if (evacuated.has(id)) continue;
        evacuated.add(id);
        releaseToBody(id);
        options.onEvacuate(id);
        continue;
      }
      evacuated.delete(id);
      const frame = options.windows[id];
      const pane = paneOf(id);
      if (pane.parentElement !== slot.content) slot.content.append(pane);
      if (frame.element.parentElement !== pane) pane.append(frame.element);
      frame.setDocked(true);
      pane.style.display = id === shown ? "block" : "none";
    }
  }

  /**
   * タブの列を ids の並びにする。前のタブ (shown) は見た目と data-active で見分ける。**差分だけを動かす**: 要らなくなった
   * タブだけを外し、並びの違うタブだけを差し直す (押している最中のタブを付け直すと捕捉が外れる。判断メモ 36)。
   * **掴んで引き出したタブは動かさない** (列の末尾に残し、ほかのタブはその前に差す)
   */
  function renderTabs(slot: Slot, ids: WindowId[], shown: WindowId | undefined): void {
    const desired = ids.map((id) => {
      const tab = tabOf(id);
      const active = id === shown;
      tab.style.cssText = active ? DOCK_STYLE.tabActive : DOCK_STYLE.tab;
      tab.dataset.active = String(active);
      return tab;
    });
    const kept = grabbedTab !== null && grabbedTab.parentElement === slot.tabRow ? grabbedTab : null;
    for (const child of [...slot.tabRow.children]) {
      if (child !== kept && !desired.includes(child as HTMLElement)) child.remove();
    }
    desired.forEach((tab, index) => {
      const others = [...slot.tabRow.children].filter((child) => child !== kept);
      const at = others[index] ?? kept;
      if (at !== tab) slot.tabRow.insertBefore(tab, at);
    });
  }

  /**
   * 1 つの枠を描き直す (C2.2 / C2.3)。見えている窓 (hidden でない) のタブだけを出し、前のタブの窓だけを置き場に出す。
   * **枠の中の窓が 1 つでバーのときだけタブの列を出さない** (⠿ で掴めるうえ、1440x795 の高さの予算に 28px が入らない)。
   * ドラッグの間は、入れられる枠に落とし先の帯を出す: タブの列が出ていればタブの列、無ければ枠の先頭の 40px の目印
   * (ページの流れの中に出る。上に重ねる目印はスクロールで落ちる場所とずれる)。見えている窓も目印も無い枠・
   * 使えない枠は枠ごと隠す
   */
  function render(slot: Slot): void {
    const visible = slot.tabs.filter((id) => !options.windows[id].element.hidden);
    const shown =
      slot.active !== undefined && visible.includes(slot.active) ? slot.active : visible[0];
    placeWindows(slot, shown);
    const showTabs = visible.length > 0 && !(visible.length === 1 && visible[0] === "bar");
    renderTabs(slot, showTabs ? visible : [], shown);
    slot.tabRow.style.display = showTabs ? "flex" : "none";

    const target = dragging !== null && slot.usable && options.accepts(dragging.id, slot.id);
    const showMarker = target && !showTabs;
    slot.marker.style.display = showMarker ? "flex" : "none";
    slot.band = target ? (showTabs ? slot.tabRow : slot.marker) : null;
    for (const element of [slot.tabRow, slot.marker]) {
      const isBand = element === slot.band;
      const hovered = isBand && dragging?.hover === slot.id;
      if (isBand) element.dataset.dropTarget = "true";
      else delete element.dataset.dropTarget;
      if (hovered) element.dataset.dropHover = "true";
      else delete element.dataset.dropHover;
      element.style.outline = isBand ? DOCK_STYLE.bandOutline : "";
      element.style.outlineOffset = isBand ? "-2px" : "";
      element.style.background = hovered ? DOCK_STYLE.bandFill : "";
    }
    slot.root.style.display = slot.usable && (visible.length > 0 || showMarker) ? "block" : "none";
    applyGaps(slot, visible.length > 0);
  }

  /** 枠の余白。窓が見えている間だけ下の余白と、下の枠の上の余白の補正を当てる (目印だけの間は 0。判断メモ 37) */
  function applyGaps(slot: Slot, hasWindows: boolean): void {
    slot.root.style.marginBottom = `${hasWindows ? DOCK_SLOT_GAP_PX : 0}px`;
    slot.root.style.marginTop = `${hasWindows && slot.id === "below" ? BELOW_SLOT_MARGIN_TOP_PX : 0}px`;
  }

  function state(): DockState {
    const result: DockState = {};
    for (const slot of allSlots) {
      if (slot.tabs.length === 0) continue;
      result[slot.id] =
        slot.active === undefined
          ? { tabs: [...slot.tabs] }
          : { tabs: [...slot.tabs], active: slot.active };
    }
    return result;
  }

  function dock(id: WindowId, slotId: DockSlotId): void {
    // 落とし先の帯は入れられる枠にしか出さないので、ここへ来るのは配線の誤り。黙って捨てない
    if (!options.accepts(id, slotId)) {
      throw new Error(`[yt-clip] ${id} の窓は ${slotId} の枠に入れられません`);
    }
    const from = findSlot(id);
    const to = slots[slotId];
    if (from !== null) {
      from.tabs = from.tabs.filter((tab) => tab !== id);
      if (from.active === id) from.active = undefined;
    }
    // 並びは入れた順 (末尾に付く)。落とした窓を前に出す (C2.2 / C2.3)
    to.tabs = [...to.tabs, id];
    to.active = id;
    if (from !== null && from !== to) render(from);
    render(to);
    options.onChange(state());
  }

  function undock(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null) return;
    slot.tabs = slot.tabs.filter((tab) => tab !== id);
    if (slot.active === id) slot.active = undefined;
    evacuated.delete(id);
    releaseToBody(id);
    // 元の枠は残りの窓ですぐ描き直す (C2.4)
    render(slot);
    options.onChange(state());
  }

  function restore(id: WindowId): void {
    const home = allSlots.find((slot) => options.initial[slot.id]?.tabs.includes(id) === true);
    if (home === undefined) {
      undock(id);
      return;
    }
    const order = options.initial[home.id]?.tabs ?? [];
    /** 最初の配置の並びでの位置。最初の配置に無い窓は後ろ */
    const rank = (tab: WindowId): number => {
      const index = order.indexOf(tab);
      return index === -1 ? order.length : index;
    };
    const from = findSlot(id);
    if (from !== home) {
      if (from !== null) {
        from.tabs = from.tabs.filter((tab) => tab !== id);
        if (from.active === id) from.active = undefined;
      }
      // 最初の配置の並びの位置へ入れる (末尾に付けると、戻すたびに並びが操作の履歴で変わる)
      const tabs = [...home.tabs];
      const at = tabs.findIndex((tab) => rank(tab) > rank(id));
      tabs.splice(at === -1 ? tabs.length : at, 0, id);
      home.tabs = tabs;
    }
    home.active = id;
    if (from !== null && from !== home) render(from);
    render(home);
    options.onChange(state());
  }

  function activate(id: WindowId): void {
    const slot = findSlot(id);
    if (slot === null || slot.active === id) return;
    slot.active = id;
    render(slot);
    options.onChange(state());
  }

  /**
   * 当たっている帯。**帯の箱 (getBoundingClientRect) を毎回測る** (YouTube の再描画で差し直された後の位置で測る。
   * C2.7)。elementFromPoint は使わない (掴んでいる窓が指の下にあり、帯が取れない)
   */
  function hitTest(current: Dragging, point: DragPoint): DockSlotId | null {
    const armed =
      Math.hypot(point.x - current.origin.x, point.y - current.origin.y) >= DOCK_ARM_DISTANCE_PX;
    let hit: DockSlotId | null = null;
    for (const slot of allSlots) {
      if (slot.band === null) continue;
      if (!contains(slot.band.getBoundingClientRect(), point)) {
        current.waitingOut.delete(slot.id);
        continue;
      }
      if (armed && !current.waitingOut.has(slot.id) && hit === null) hit = slot.id;
    }
    return hit;
  }

  function drag(id: WindowId, phase: DragPhase, point: DragPoint): DockSlotId | null {
    if (phase === "start") {
      const started: Dragging = { id, origin: point, waitingOut: new Set(), hover: null };
      dragging = started;
      // 帯を出して (隠れている枠の目印はページの流れへ差して) から測る。差す前に測ると、目印の分だけ下の帯の
      // 位置がずれる (C2.3)
      for (const slot of allSlots) render(slot);
      for (const slot of allSlots) {
        if (slot.band !== null && contains(slot.band.getBoundingClientRect(), point)) {
          started.waitingOut.add(slot.id);
        }
      }
      return null;
    }
    const current = dragging;
    if (current === null || current.id !== id) return null;
    const hover = hitTest(current, point);
    if (hover !== current.hover) {
      current.hover = hover;
      for (const slot of allSlots) render(slot);
    }
    if (phase === "move") return null;

    dragging = null;
    // 引き出しに使ったタブは、ここで捨てる (捕捉はもう窓の枠が解いた)
    grabbedTab?.remove();
    grabbedTab = null;
    if (hover === null) {
      for (const slot of allSlots) render(slot);
      return null;
    }
    dock(id, hover);
    // 入れなかった方の枠の帯も消す
    for (const slot of allSlots) render(slot);
    return hover;
  }

  return {
    elements: { below: slots.below.root, side: slots.side.root },

    attach(anchors: Record<DockSlotId, Element | null>): boolean {
      let changed = false;
      for (const slot of allSlots) {
        const anchor = anchors[slot.id];
        // YouTube が差す先の子を作り直すと、枠は中の窓ごとメモリに残って外れる。先頭に差し直す (C2.7)。
        // 差す先の中にあれば動かさない (YouTube が後から先頭に何かを足しても、取り合わない)
        if (anchor !== null && !anchor.contains(slot.root)) anchor.prepend(slot.root);
        // 差す先が無い (動画ページ以外・SPA の途中・1 列表示で消えた) か幅 0 なら使えない (C2.1)
        const usable = anchor !== null && anchor.getBoundingClientRect().width > 0;
        if (usable !== slot.usable) {
          slot.usable = usable;
          changed = true;
        }
      }
      return changed;
    },

    isUsable(slot: DockSlotId): boolean {
      return slots[slot].usable;
    },

    load(saved: DockState): void {
      for (const slot of allSlots) {
        const entry = saved[slot.id];
        slot.tabs = entry === undefined ? [] : [...entry.tabs];
        slot.active = entry?.active;
      }
    },

    dock,
    undock,
    restore,
    activate,

    slotOf(id: WindowId): DockSlotId | null {
      return findSlot(id)?.id ?? null;
    },

    sync(): void {
      for (const slot of allSlots) render(slot);
    },

    drag,
    state,

    destroy(): void {
      for (const slot of allSlots) slot.root.remove();
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/dock.test.ts` (Bash の timeout 120000)
期待: PASS (Task 5 の検査も通る)

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/dock.ts tests/content/dock.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓を枠の帯へ落として入れ、タブを押して切り替え・引き出して浮かせる

落とし先は枠の上の帯 (タブの列か 40px の目印) だけにし、ドラッグの
開始点から 40px 離れて帯に外から入ったときだけ当てる。最初の位置の
窓は帯とずれて重なるので、どちらか片方だけだと少し動かしただけで
吸い込まれる。タブは 8px 動かすと抜けて窓の移動に続き、掴んだタブは
捕捉が切れないよう指を離すまで DOM に残す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: 枠を差し、落として入れ、引き出し、退避し、組ごと保存する (`youtube.ts`)

**Files:**
- Modify: `src/content/selectors.ts:14` の後 (`dockBelow` / `dockSide` / `watchFlexy`)
- Modify: `src/content/youtube.ts` (import、窓の id の後、3 つの窓の作り方、`placeInitial` / `currentWindowLayout` / `rememberWindowRect` /
  `resetWindow`、`refreshWindows`、`placeUnmovedWindows`、`mount` の先頭、テーマの監視)。`dockManager` に最初の配置 (`initialDocks()`) を渡し、
  ダブルクリックは `restore` で最初の配置の枠へ戻す
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 2 の `WINDOW_IDS` / `WINDOW_LAYOUT_VERSION` / `acceptsDock` / `DockSlotId`、Task 4 の `DragPoint` / `onDragPoint` /
  `onUndockRequest` / `PANEL_HEADER_HEIGHT_PX`、Task 6 の `createDockManager` (`drag` を含む)
- Produces (Task 8 が使う): youtube.ts の中の `dockManager` (`DockManager`)、`WINDOW_TITLES`、`placeInitial(id)` が退避中の窓を
  最初の位置に置くこと、`refreshWindows()` の末尾近くで `dockManager.sync()` を呼ぶこと。
  youtube.test.ts: `buildPage` が `#secondary > #secondary-inner` を作ること、`describe("ドック枠とタブ")` とその中のヘルパ
  (`stubDockLayout` / `dropAt` / `slotElement` / `tabElement` / `tabLabels` / `activeLabel` / `bandShown` / `pullSideTab` / `pullBar` / `lastWrite` / `showEdit` /
  `resetAll`、定数 `SIDE_BAND` / `BELOW_BAND` / `AWAY` / `START`)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の

```typescript
import type { WindowLayout } from "@/content/window-layout";
```

を次に置き換える。

```typescript
import type { WindowId, WindowLayout } from "@/content/window-layout";
```

`buildPage` の中の

```typescript
  // 広告の判定は #movie_player の ad-showing を見る (player.ts の isAdPlaying)
  const player = document.createElement("div");
  player.id = "movie_player";
```

の**直前**に次を足す。

```typescript
  // 右の列 (#secondary > #secondary-inner)。右のドック枠を差す先 (窓の分割の spec C2.1)
  const secondary = document.createElement("div");
  secondary.id = "secondary";
  const secondaryInner = document.createElement("div");
  secondaryInner.id = "secondary-inner";
  secondary.append(secondaryInner);
```

同じ `buildPage` の `document.body.append(` の引数の `below,` の次の行に `secondary,` を足す (`below, secondary, title, author, …` の順)。

`describe("フロートの窓")` の中の次のテスト

```typescript
  test("#below には何も置かない", () => {
    const below = document.getElementById("below");
    if (below === null) throw new Error("#below がありません");
    expect(below.children.length).toBe(0);
  });
```

を次に置き換える。

```typescript
  test("#below にはドック枠だけを差し、最初の配置では隠しておく (窓の中身は置かない)", () => {
    const below = document.getElementById("below");
    if (below === null) throw new Error("#below がありません");
    expect([...below.children].map((child) => child.id)).toEqual(["yt-clip-dock-below"]);
    expect((below.firstElementChild as HTMLElement).style.display).toBe("none");
  });
```

`describe("足した行を区間・テロップの窓の見える範囲に入れる")` の `placeRows` の doc コメント (「本体は画面の 100〜500px。…」) の末尾の
`*/` の直前に、次の 2 行を足す (前提を残す。plan の再レビューの Recommendation)。

```typescript
   * **前提: 区間・テロップの窓は枠に入っていない** (読み込み時の v1 の組で浮いた窓。この stub はほかの要素の幅を 400 で返すので
   * 差す先が使える扱いになり、枠に入っていると足した行は送らずタブを前に出すだけになる)。前の describe でダブルクリックしない
```

`describe("フロートの窓")` の、保存の組を丸ごと期待する既存の検査の `docks` を次のとおり直す (判断メモ 32。jsdom では差す先の幅が 0 なので、
この describe の `beforeEach` のダブルクリックで 3 つの窓は最初の配置の枠 (下の枠 [bar] / 右の枠 [list, settings]、前は最後に戻した settings) の
記憶に入り、退避で浮いて出る。浮いた窓を動かすと枠の記憶から外れる。位置と大きさの期待は変わらない)。

「つまみをドラッグすると動き、指を離したときに 1 回だけ覚える」の

```typescript
    expect(layoutWrites).toEqual([
      { version: 2, float: { bar: { left: left + 50, top: top + 30, width } }, docks: {} },
    ]);
```

を次に置き換える。

```typescript
    // 最初の配置の枠 (下の枠) の記憶から外れ、右の枠の記憶は残る
    expect(layoutWrites).toEqual([
      {
        version: 2,
        float: { bar: { left: left + 50, top: top + 30, width } },
        docks: { side: { tabs: ["list", "settings"], active: "settings" } },
      },
    ]);
```

「区間・テロップの窓は見出しをドラッグすると動き、位置を覚える」の

```typescript
    expect(layoutWrites).toEqual([
      { version: 2, float: { list: { left: left - 100, top: 88, width: 400 } }, docks: {} },
    ]);
```

を次に置き換える。

```typescript
    expect(layoutWrites).toEqual([
      {
        version: 2,
        float: { list: { left: left - 100, top: 88, width: 400 } },
        docks: {
          below: { tabs: ["bar"], active: "bar" },
          side: { tabs: ["settings"], active: "settings" },
        },
      },
    ]);
```

「設定の窓は見出しをドラッグすると動き、位置を覚える」の

```typescript
    expect(layoutWrites).toEqual([
      { version: 2, float: { settings: { left: left - 100, top: 120, width: 400 } }, docks: {} },
    ]);
```

を次に置き換える (前に出ていた設定を外すので、右の枠の前のタブは無い扱い)。

```typescript
    expect(layoutWrites).toEqual([
      {
        version: 2,
        float: { settings: { left: left - 100, top: 120, width: 400 } },
        docks: { below: { tabs: ["bar"], active: "bar" }, side: { tabs: ["list"] } },
      },
    ]);
```

「ダブルクリックで戻した窓は組から消え、ほかの窓の覚えた位置は残る」の

```typescript
    expect(stored.docks).toEqual({});
```

を次に置き換える (戻した区間・テロップの窓は最初の配置の並びの位置へ入り、前に出る。動かしたバーは枠の外のまま)。

```typescript
    expect(stored.docks).toEqual({ side: { tabs: ["list", "settings"], active: "list" } });
```

「つまみ・見出しをダブルクリックすると最初の位置に戻り、覚えた位置を消す」の 1 つ目の期待

```typescript
      expect(storedLayout).toEqual({
        version: 2,
        float: {
          bar: { left: 124, top: 588, width: 800 },
          list: { left: window.innerWidth - 516, top: 88, width: 400 },
        },
        docks: {},
      });
```

を次に置き換える。

```typescript
      expect(storedLayout).toEqual({
        version: 2,
        float: {
          bar: { left: 124, top: 588, width: 800 },
          list: { left: window.innerWidth - 516, top: 88, width: 400 },
        },
        docks: { side: { tabs: ["settings"], active: "settings" } },
      });
```

同じテストの最後の

```typescript
      expect(storedLayout).toEqual({ version: 2, float: {}, docks: {} });
```

を次に置き換え、テスト名を「つまみ・見出しをダブルクリックすると最初の配置の枠に戻り (jsdom では枠が使えないので最初の位置に浮く)、覚えた位置を消す」にする。

```typescript
      expect(storedLayout).toEqual({
        version: 2,
        float: {},
        docks: {
          below: { tabs: ["bar"], active: "bar" },
          side: { tabs: ["list", "settings"], active: "list" },
        },
      });
```

ファイルの末尾に次を足す。

```typescript
describe("ドック枠とタブ", () => {
  type Point = { x: number; y: number };
  /** 差す先の箱 (jsdom はレイアウトを持たない)。帯 (目印 40px / タブの列 28px) はそれぞれの枠の上端に置く */
  const BELOW = { left: 0, top: 600, width: 800 };
  const SIDE = { left: 840, top: 60, width: 400 };
  /**
   * 下の枠の中のバーの窓の箱。引き出した窓の位置を、fitRect の上限 (YouTube のヘッダーの下 56px) に詰められない所で
   * 測るため (26eaebd。判断メモ 33)
   */
  const DOCKED_BAR = { left: 0, top: 600, width: 800, height: 140 };
  /** 帯の中の点 (下の枠 / 右の枠)。目印 (40px) にもタブの列 (28px) にも入る高さ */
  const BELOW_BAND: Point = { x: 100, y: 610 };
  const SIDE_BAND: Point = { x: 900, y: 70 };
  /** どの帯からも離れた点 */
  const AWAY: Point = { x: 300, y: 300 };
  /** ドラッグを始める点 (帯の外) */
  const START: Point = { x: 320, y: 320 };

  /** 右の枠の差す先の幅。0 にすると使えない枠になる (1 列表示の代わり) */
  let sideWidth = SIDE.width;
  let layoutSpy: { mockRestore(): void } | null = null;

  /** 差す先と、枠の中の帯・タブ・バーの窓の位置を決め打ちする。ほかの要素は 0 */
  function stubDockLayout() {
    return vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.id === "below") return boxAt(BELOW.left, BELOW.top, BELOW.width, 0);
        if (this.id === "secondary-inner") return boxAt(SIDE.left, SIDE.top, sideWidth, 0);
        const box =
          this.closest("#yt-clip-dock-below") !== null
            ? BELOW
            : this.closest("#yt-clip-dock-side") !== null
              ? SIDE
              : null;
        if (box === BELOW && this.id === "yt-clip-bar-window") {
          return boxAt(DOCKED_BAR.left, DOCKED_BAR.top, DOCKED_BAR.width, DOCKED_BAR.height);
        }
        const role = this instanceof HTMLElement ? this.dataset.role : undefined;
        if (box !== null && role === "dock-marker") return boxAt(box.left, box.top, box.width, 40);
        if (box !== null && role === "dock-tabs") return boxAt(box.left, box.top, box.width, 28);
        if (box !== null && role === "dock-tab") return boxAt(box.left + 8, box.top, 100, 28);
        return boxAt(0, 0, 0, 0);
      });
  }

  function slotElement(slot: "below" | "side"): HTMLElement {
    const element = document.getElementById(`yt-clip-dock-${slot}`);
    if (element === null) throw new Error(`#yt-clip-dock-${slot} がありません`);
    return element;
  }

  function tabElement(slot: "below" | "side", id: WindowId): HTMLElement {
    const tab = slotElement(slot).querySelector<HTMLElement>(
      `[data-role='dock-tab'][data-window='${id}']`,
    );
    if (tab === null) throw new Error(`${id} のタブがありません`);
    return tab;
  }

  /** 出ているタブの文言 (並び順) */
  function tabLabels(slot: "below" | "side"): string[] {
    return [...slotElement(slot).querySelectorAll<HTMLElement>("[data-role='dock-tab']")]
      .filter((tab) => tab.style.display !== "none")
      .map((tab) => tab.textContent ?? "");
  }

  function activeLabel(slot: "below" | "side"): string | null {
    return (
      slotElement(slot).querySelector<HTMLElement>("[data-role='dock-tab'][data-active='true']")
        ?.textContent ?? null
    );
  }

  /** 落とし先の帯が出ているか (dock.ts がドラッグの間だけ data-drop-target を立てる) */
  function bandShown(slot: "below" | "side"): boolean {
    return slotElement(slot).querySelector("[data-drop-target='true']") !== null;
  }

  /** 最後に保存した組 */
  function lastWrite(): WindowLayout {
    const last = layoutWrites[layoutWrites.length - 1];
    if (last === undefined) throw new Error("まだ保存していません");
    return last as WindowLayout;
  }

  /** START で押し、AWAY を通って to で離す (帯へは一度その外から入れる。C2.3) */
  function dropAt(handle: Element, to: Point): void {
    pointer(handle, "pointerdown", START.x, START.y);
    pointer(handle, "pointermove", AWAY.x, AWAY.y);
    pointer(handle, "pointermove", to.x, to.y);
    pointer(handle, "pointerup", to.x, to.y);
  }

  /**
   * 右の枠のタブを (850, 70) で押し、20px 下で抜いてから to まで運んで離す (C2.4)。抜いた窓は (848, 74) に置かれ
   * (タブの中の x 2・見出しの高さの半分 16)、to まで同じだけ動く
   */
  function pullSideTab(id: WindowId, to: Point): void {
    const tab = tabElement("side", id);
    pointer(tab, "pointerdown", 850, 70);
    pointer(tab, "pointermove", 850, 90);
    pointer(tab, "pointermove", to.x, to.y);
    pointer(tab, "pointerup", to.x, to.y);
  }

  /** 下の枠のバーの ⠿ を (100, 700) で押し (窓の中の (100, 100))、10px 右で抜いてそのまま離す。バーは (10, 600) に浮く */
  function pullBar(): void {
    pointer(barGrip(), "pointerdown", 100, 700);
    pointer(barGrip(), "pointermove", 110, 700);
    pointer(barGrip(), "pointerup", 110, 700);
  }

  async function showEdit(): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
  }

  /** 3 つの窓を最初の配置 (下の枠 [bar] / 右の枠 [list, settings]) に戻す (掴む場所のダブルクリック) */
  function resetAll(): void {
    dblclick(barGrip());
    dblclick(listHeader());
    dblclick(settingsHeader());
  }

  beforeEach(async () => {
    sideWidth = SIDE.width;
    layoutSpy = stubDockLayout();
    // 差す先の幅を測り直させる (幅 0 の枠は使えない)。resize で placeUnmovedWindows → attach が走る
    window.dispatchEvent(new Event("resize"));
    await showEdit();
    resetAll();
    await flush();
    layoutWrites = [];
  });

  afterEach(() => {
    // 次のテストへ枠の中身を持ち越さない (最初の配置に戻す)
    resetAll();
    layoutSpy?.mockRestore();
    layoutSpy = null;
    window.dispatchEvent(new Event("resize"));
  });

  test("最初の配置では、バーは #below の枠、区間・テロップの窓と設定の窓は #secondary-inner の枠に入る。設定は開くまでタブを出さない", () => {
    expect(barWindowElement().closest("#yt-clip-dock-below")).not.toBeNull();
    expect(listElement().closest("#yt-clip-dock-side")).not.toBeNull();
    expect(settingsWindowElement().closest("#yt-clip-dock-side")).not.toBeNull();
    expect(listElement().style.position).toBe("static");
    expect(slotElement("below").parentElement?.id).toBe("below");
    expect(slotElement("side").parentElement?.id).toBe("secondary-inner");
    expect(slotElement("below").style.display).toBe("block");
    expect(slotElement("side").style.display).toBe("block");
    // バーだけの枠はタブの列を出さない
    expect(
      slotElement("below").querySelector<HTMLElement>("[data-role='dock-tabs']")?.style.display,
    ).toBe("none");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
  });

  test("タブを 8px 以上ドラッグすると枠から出て指の下に付いて動き、離した位置を覚える", async () => {
    const tab = tabElement("side", "list");

    // タブの箱は (848, 60) から (stub)。(850, 70) で押す = タブの中の (2, 10)
    pointer(tab, "pointerdown", 850, 70);
    pointer(tab, "pointermove", 850, 74);
    expect(listElement().closest("#yt-clip-dock-side")).not.toBeNull();

    pointer(tab, "pointermove", 850, 90);
    // 窓の左端 = 指 − タブの中で掴んだ x (850 − 2)、上端 = 指 − 見出しの高さの半分 (90 − 16)。幅は最初の位置の 400px
    expect(listElement().parentElement).toBe(document.body);
    expect(styleRect(listElement())).toEqual({ left: "848px", top: "74px", width: "400px", height: "" });
    // 掴んだタブは指を離すまで残る (捕捉が付いている)
    expect(tab.isConnected).toBe(true);

    pointer(tab, "pointermove", 400, 300);
    pointer(tab, "pointerup", 400, 300);
    await flush();

    expect(tab.isConnected).toBe(false);
    expect(styleRect(listElement())).toEqual({ left: "398px", top: "284px", width: "400px", height: "" });
    expect(lastWrite()).toEqual({
      version: 2,
      float: { list: { left: 398, top: 284, width: 400 } },
      docks: {
        below: { tabs: ["bar"], active: "bar" },
        side: { tabs: ["settings"], active: "settings" },
      },
    });
  });

  test("浮いた区間・テロップの窓の見出しを右の枠の帯へ落とすと枠の末尾に入って前に出る。float は変えない", async () => {
    pullSideTab("list", AWAY);
    await flush();
    expect(listElement().parentElement).toBe(document.body);

    dropAt(listHeader(), SIDE_BAND);
    await flush();

    expect(listElement().closest("#yt-clip-dock-side")).not.toBeNull();
    expect(listElement().style.position).toBe("static");
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(lastWrite()).toEqual({
      version: 2,
      float: { list: { left: 298, top: 284, width: 400 } },
      docks: {
        below: { tabs: ["bar"], active: "bar" },
        side: { tabs: ["settings", "list"], active: "list" },
      },
    });
  });

  test("ドック中のバーの ⠿ を 8px 以上動かすと枠から出て、⠿ が指の下に残ったまま動く", async () => {
    // 枠の中のバーの窓の左上は (0, 600) (stub)。⠿ を (100, 700) で掴む = 窓の中の (100, 100)
    pointer(barGrip(), "pointerdown", 100, 700);
    pointer(barGrip(), "pointermove", 104, 700);
    expect(barWindowElement().closest("#yt-clip-dock-below")).not.toBeNull();

    pointer(barGrip(), "pointermove", 110, 700);
    expect(barWindowElement().parentElement).toBe(document.body);
    // 窓の左上 = 指 − ⠿ の窓の中の位置。幅はプレイヤーの幅 (stub で 0) を最小の 480px に詰めたもの
    expect(styleRect(barWindowElement())).toEqual({
      left: "10px",
      top: "600px",
      width: "480px",
      height: "",
    });

    pointer(barGrip(), "pointermove", 130, 720);
    pointer(barGrip(), "pointerup", 130, 720);
    await flush();

    expect(styleRect(barWindowElement())).toEqual({
      left: "30px",
      top: "620px",
      width: "480px",
      height: "",
    });
    expect(lastWrite()).toEqual({
      version: 2,
      float: { bar: { left: 30, top: 620, width: 480 } },
      docks: { side: { tabs: ["list", "settings"], active: "settings" } },
    });
  });

  test("⠿ で引き出したバーを下の枠の帯へ落とすと戻る。バーだけの枠はタブの列を出さない", async () => {
    pullBar();
    await flush();
    expect(barWindowElement().parentElement).toBe(document.body);

    dropAt(barGrip(), BELOW_BAND);
    await flush();

    expect(barWindowElement().closest("#yt-clip-dock-below")).not.toBeNull();
    expect(
      slotElement("below").querySelector<HTMLElement>("[data-role='dock-tabs']")?.style.display,
    ).toBe("none");
    expect(lastWrite()).toEqual({
      version: 2,
      float: { bar: { left: 10, top: 600, width: 480 } },
      docks: {
        below: { tabs: ["bar"], active: "bar" },
        side: { tabs: ["list", "settings"], active: "settings" },
      },
    });
  });

  test("バーをドラッグしている間、右の枠には落とし先を出さず、右の帯で離しても入らない", async () => {
    pullBar();
    await flush();

    pointer(barGrip(), "pointerdown", START.x, START.y);
    pointer(barGrip(), "pointermove", AWAY.x, AWAY.y);
    expect(bandShown("below")).toBe(true);
    expect(bandShown("side")).toBe(false);

    pointer(barGrip(), "pointermove", SIDE_BAND.x, SIDE_BAND.y);
    pointer(barGrip(), "pointerup", SIDE_BAND.x, SIDE_BAND.y);
    await flush();

    expect(barWindowElement().parentElement).toBe(document.body);
    expect(bandShown("below")).toBe(false);
    expect(lastWrite().docks).toEqual({ side: { tabs: ["list", "settings"], active: "settings" } });
  });

  test("浮いた窓の見出しをダブルクリックすると最初の配置の枠 (区間・テロップ → 設定の並び) に戻って前に出て、float から消える", async () => {
    pullSideTab("list", AWAY);
    await flush();

    dblclick(listHeader());
    await flush();

    expect(listElement().closest("#yt-clip-dock-side")).not.toBeNull();
    expect(lastWrite()).toEqual({
      version: 2,
      float: {},
      docks: {
        below: { tabs: ["bar"], active: "bar" },
        side: { tabs: ["list", "settings"], active: "list" },
      },
    });
  });

  test("別の枠に入れた窓のタブをダブルクリックしても、最初の配置の枠に戻る", async () => {
    // 区間・テロップのタブを下の枠 (バーだけなので目印) へ
    const tab = tabElement("side", "list");
    pointer(tab, "pointerdown", 850, 70);
    pointer(tab, "pointermove", 850, 90);
    pointer(tab, "pointermove", AWAY.x, AWAY.y);
    pointer(tab, "pointermove", BELOW_BAND.x, BELOW_BAND.y);
    pointer(tab, "pointerup", BELOW_BAND.x, BELOW_BAND.y);
    await flush();
    expect(tabLabels("below")).toEqual(["バー", "区間・テロップ"]);

    dblclick(tabElement("below", "list"));
    await flush();

    expect(tabLabels("below")).toEqual([]);
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    // 下の枠の前のタブ (区間・テロップ) は抜けたので無い扱い。表示はバーだけ
    expect(lastWrite().docks).toEqual({
      below: { tabs: ["bar"] },
      side: { tabs: ["list", "settings"], active: "list" },
    });
  });

  test("右の枠の差す先が幅 0 になると、中の窓は float に位置があっても最初の位置の浮いた窓で出る。戻ると枠に戻る", async () => {
    // 引き出して置き、戻す (float に位置がある)
    pullSideTab("list", AWAY);
    await flush();
    dropAt(listHeader(), SIDE_BAND);
    await flush();

    sideWidth = 0;
    window.dispatchEvent(new Event("resize"));

    expect(listElement().parentElement).toBe(document.body);
    expect(styleRect(listElement())).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
      height: "",
    });
    expect(slotElement("side").style.display).toBe("none");

    sideWidth = SIDE.width;
    window.dispatchEvent(new Event("resize"));

    expect(listElement().closest("#yt-clip-dock-side")).not.toBeNull();
  });

  test("退避中の窓を動かすと、その時点で浮いた窓になり、枠の記憶からも外れる", async () => {
    sideWidth = 0;
    window.dispatchEvent(new Event("resize"));
    layoutWrites = [];

    drag(listHeader(), 30, 20);
    await flush();

    expect(lastWrite()).toEqual({
      version: 2,
      float: { list: { left: window.innerWidth - 386, top: 88, width: 400 } },
      docks: {
        below: { tabs: ["bar"], active: "bar" },
        side: { tabs: ["settings"], active: "settings" },
      },
    });
    sideWidth = SIDE.width;
    window.dispatchEvent(new Event("resize"));
    expect(listElement().parentElement).toBe(document.body);
  });

  test("YouTube が差す先の子を作り直しても (replaceChildren)、mount で枠を中の窓ごと先頭に差し直す", async () => {
    const slot = slotElement("side");
    const inner = document.getElementById("secondary-inner");
    if (inner === null) throw new Error("#secondary-inner がありません");

    const related = document.createElement("div");
    related.id = "related";
    inner.replaceChildren(related);
    expect(slot.isConnected).toBe(false);
    await flush();

    expect(inner.firstElementChild).toBe(slot);
    expect(slot.contains(listElement())).toBe(true);
  });

  test("別の動画へ移ると区間・テロップのタブが消えて右の枠が隠れ、戻ると出る", async () => {
    history.pushState({}, "", "/watch?v=video-b");
    document.body.append(document.createElement("div"));
    await flush();
    expect(tabLabels("side")).toEqual([]);
    expect(slotElement("side").style.display).toBe("none");

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
    expect(slotElement("side").style.display).toBe("block");
  });

  test("全画面の間は枠も隠し、抜けたら戻す", async () => {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(slotElement("below").style.display).toBe("none");
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(slotElement("below").style.display).toBe("block");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: FAIL。「#below にはドック枠だけを差し…」と `describe("ドック枠とタブ")` のすべてが、`#yt-clip-dock-below` が無い
(`#yt-clip-dock-side がありません` など) で落ちる。`describe("フロートの窓")` の保存の期待を直した 6 か所も `docks: {}` で食い違う。
ほかの describe は通る (`#secondary` を足しても今のコードは見ない)

- [ ] **Step 3: 最小実装**

`src/content/selectors.ts` の

```typescript
  mountAnchor: "#below",
```

の**直後**に次を足す。

```typescript
  /**
   * 下のドック枠を差す先 (`.claude/specs/2026-09-25-dockable-windows-design.md` C2.1)。**先頭に差す**
   * (`ytd-watch-metadata` の上)。mountAnchor と同じ要素: 右側パネル化の前にバーがあった場所で、再描画で外れたときの
   * 差し直しも実績がある。実測は dock.ts のコメント
   */
  dockBelow: "#below",
  /**
   * 右のドック枠を差す先。候補を順に試し、**先頭に差す** (おすすめ動画 `#related` とチャット `#chat` の上)。
   * `#secondary` 直下を先にしない: YouTube が `#secondary-inner` を作り直したとき、枠が列の外に残りうる
   */
  dockSide: ["#secondary-inner", "#secondary"],
  /**
   * 動画ページの根。シアターモードの間 `theater` 属性が立つ。**拡張はこれを見て窓を動かさない** (シアターモードでも
   * 右の枠は右の列に付いて動画の下へ回るまま。C2.1)。E2E の実測が同じ要素を読む
   */
  watchFlexy: "ytd-watch-flexy",
```

`src/content/youtube.ts` の import の

```typescript
import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import {
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
} from "@/content/panel-window";
```

を次に置き換える。

```typescript
import { createDockManager } from "@/content/dock";
import {
  createFloatingWindow,
  type DragPoint,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import {
  PANEL_HEADER_HEIGHT_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
} from "@/content/panel-window";
```

同じく

```typescript
import {
  initialBarRect,
  loadWindowLayout,
  saveWindowLayout,
  type WindowId,
  type WindowLayout,
} from "@/content/window-layout";
```

を次に置き換える。

```typescript
import {
  WINDOW_IDS,
  WINDOW_LAYOUT_VERSION,
  acceptsDock,
  initialBarRect,
  initialDocks,
  loadWindowLayout,
  saveWindowLayout,
  type DockSlotId,
  type WindowId,
  type WindowLayout,
} from "@/content/window-layout";
```

`const SETTINGS_WINDOW_ID = "yt-clip-settings";` の**直後**に次を足す。

```typescript
/**
 * 窓の見出しの文言 = ドック枠のタブの文言 (窓の分割の spec C1.1)。バーは見出しの行を作らないので、タブだけの文言
 */
const WINDOW_TITLES: Record<WindowId, string> = {
  bar: "バー",
  list: "区間・テロップ",
  settings: "設定",
};
```

`listWindow` の作り方

```typescript
const listWindow = createPanelWindow({
  id: LIST_WINDOW_ID,
  title: "区間・テロップ",
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
});
```

を次に置き換える。

```typescript
const listWindow = createPanelWindow({
  id: LIST_WINDOW_ID,
  title: WINDOW_TITLES.list,
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
  // 見出しのドラッグの落とし先の当たり判定 (C2.3)。枠に引き取られたら onUserMove は来ない
  onDragPoint: (phase, point) => dockManager.drag("list", phase, point) !== null,
});
```

`settingsWindow` の作り方

```typescript
const settingsWindow = createPanelWindow({
  id: SETTINGS_WINDOW_ID,
  title: "設定",
  onUserMove: (rect) => rememberWindowRect("settings", rect),
  onResetRequest: () => resetWindow("settings"),
});
```

を次に置き換える。

```typescript
const settingsWindow = createPanelWindow({
  id: SETTINGS_WINDOW_ID,
  title: WINDOW_TITLES.settings,
  onUserMove: (rect) => rememberWindowRect("settings", rect),
  onResetRequest: () => resetWindow("settings"),
  onDragPoint: (phase, point) => dockManager.drag("settings", phase, point) !== null,
});
```

`barWindow` の作り方

```typescript
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

を次に置き換える。

```typescript
const barWindow = createFloatingWindow({
  id: BAR_WINDOW_ID,
  resize: "width",
  minWidth: BAR_MIN_WIDTH_PX,
  onUserMove: (rect) => rememberWindowRect("bar", rect),
  onResetRequest: () => resetWindow("bar"),
  onDragPoint: (phase, point) => dockManager.drag("bar", phase, point) !== null,
  // 枠に入ったバーは ⠿ を 8px 動かすと引き出す (バーだけの枠にはタブが無く、⠿ が唯一の掴む場所。C2.4)
  onUndockRequest: (point, grab) => {
    dockManager.undock("bar");
    placeUnderPointer("bar", point, grab);
  },
});
// バーの窓も body の直下にあり、ページの配色は継がれない
applyPalette(barWindow.element, isDarkTheme());
/**
 * ページの中のドック枠 2 か所 (プレイヤーの下・おすすめ動画の上) とタブ (窓の分割の spec C2)。
 * **枠の中だけを持つ**: 窓を出す条件は refreshWindows、浮いた窓の位置は placeInitial / placeUnderPointer が決める
 */
const dockManager = createDockManager({
  windows: { bar: barWindow, list: listWindow.frame, settings: settingsWindow.frame },
  titles: WINDOW_TITLES,
  // 最初の配置 (ドック。window-layout.ts の INITIAL_DOCKS)。ダブルクリックの戻し先
  initial: initialDocks(),
  accepts: acceptsDock,
  // タブから引き出した窓を指の下に置く。バーはタブの中の位置ではなく ⠿ の位置で置く (C2.4)
  onUndock: (id, point, grab) => placeUnderPointer(id, point, id === "bar" ? null : grab),
  onTabDoubleClick: (id) => resetWindow(id),
  onEvacuate: (id) => placeInitial(id),
  onChange: () => persistWindowLayout(),
});
// 枠は #below / #secondary-inner の中にあるが、YouTube の CSS 変数には頼らない (配色は自前で持つ)
for (const slot of Object.values(dockManager.elements)) applyPalette(slot, isDarkTheme());
```

`placeInitial` の doc と関数 (`/**\n * 動かしていない窓 (覚えた \`float\` に無い窓) を最初の位置に置く。` から関数の閉じ括弧まで) を次に置き換える。

```typescript
/**
 * 動かしていない窓 (覚えた `float` に無い窓) と、退避中の窓 (入っている枠が使えない間の浮いた窓。C2.1) を
 * 最初の位置に置く。**退避中の窓は `float` に位置があっても最初の位置** (C2.1 / C2.6)。ドック中の窓 (使える枠に
 * 入っている) はページの流れが決めるので置かない。覚えた配置の読み込みが済む前は何もしない (まだ出さない)
 */
function placeInitial(id: WindowId): void {
  if (!layoutReady) return;
  const slot = dockManager.slotOf(id);
  const evacuated = slot !== null && !dockManager.isUsable(slot);
  if (slot !== null && !evacuated) return;
  if (!evacuated && floatLayout[id] !== undefined) return;
  const rect = initialWindowRect(id);
  if (rect !== null) windowOf(id).place(rect);
}

/**
 * 枠から引き出した窓を指の下に置く (C2.4)。幅と高さは覚えた `float`、無ければ最初の位置の大きさ
 * (バーはプレイヤーの幅、区間・テロップの窓と設定の窓は幅 400px・高さは中身)。
 *
 * - バー: ⠿ が指の下に残るよう、窓の左上 = 指 − ⠿ の窓の中の位置。`grab` (⠿ で引き出したとき、押した点の窓の中の
 *   位置) が無ければ (タブから引き出したとき) ⠿ の中心を測る
 * - 区間・テロップの窓と設定の窓: 掴んだタブの位置関係を保つ。窓の左端 = 指 − タブの中で掴んだ x (窓の幅に収める)、
 *   上端 = 指 − 見出しの高さの半分 (指が見出しの中に来る)
 *
 * **`floatLayout` は書き換えない** (書き換えるのは読み込み・onUserMove・ダブルクリックの 3 箇所)。引き出した後の
 * ドラッグの終わりに onUserMove が来て、そこで覚える
 */
function placeUnderPointer(id: WindowId, point: DragPoint, grab: DragPoint | null): void {
  const remembered = floatLayout[id];
  if (id === "bar") {
    const player = document.querySelector(YT_SELECTORS.player);
    const width = remembered?.width ?? player?.getBoundingClientRect().width ?? BAR_MIN_WIDTH_PX;
    // 幅を先に当てる (操作の行の折り返しで ⠿ の位置が変わる)
    barWindow.place({ left: point.x, top: point.y, width });
    const offset = grab ?? barGripCenter();
    barWindow.place({ left: point.x - offset.x, top: point.y - offset.y, width });
    return;
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const width = remembered?.width ?? initialListRect(viewport).width;
  const tabX = Math.min(Math.max(grab?.x ?? 0, 0), width);
  const left = point.x - tabX;
  const top = point.y - PANEL_HEADER_HEIGHT_PX / 2;
  windowOf(id).place(
    remembered?.height === undefined
      ? { left, top, width }
      : { left, top, width, height: remembered.height },
  );
}

/** バーの窓の中の ⠿ の中心 (窓の左上から)。⠿ が無ければ窓の左上 */
function barGripCenter(): DragPoint {
  const grip = document.getElementById(BAR_ID)?.querySelector("[data-role='grip']");
  if (grip == null) return { x: 0, y: 0 };
  const frame = barWindow.element.getBoundingClientRect();
  const box = grip.getBoundingClientRect();
  return { x: box.left - frame.left + box.width / 2, y: box.top - frame.top + box.height / 2 };
}

/** ドック枠を差す先 (C2.1)。右の枠は #secondary-inner、無ければ #secondary */
function dockAnchors(): Record<DockSlotId, Element | null> {
  let side: Element | null = null;
  for (const selector of YT_SELECTORS.dockSide) {
    side = document.querySelector(selector);
    if (side !== null) break;
  }
  return { below: document.querySelector(YT_SELECTORS.dockBelow), side };
}
```

`currentWindowLayout` の doc と関数

```typescript
/**
 * 覚える配置の組を、写し (`floatLayout`) から作る。**窓の `rect()` からは作らない**
 * (floatLayout の doc)。ドック枠はまだ無いので `docks` は空
 */
function currentWindowLayout(): WindowLayout {
  return { version: 2, float: { ...floatLayout }, docks: {} };
}
```

を次に置き換える。

```typescript
/**
 * 覚える配置の組を、写し (`floatLayout`) と枠の中身 (`dockManager.state()`) から作る。**窓の `rect()` からは作らない**
 * (floatLayout の doc)。1 つの操作で 2 つの枠が変わりうる (引き出して別の枠へ) ので、いつも組ごと書く (C1.3)
 */
function currentWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: { ...floatLayout }, docks: dockManager.state() };
}
```

`rememberWindowRect` と `resetWindow` (`/** ユーザーが窓を動かした・大きさを変えた` から `resetWindow` の閉じ括弧まで) を次に置き換える。

```typescript
/** ユーザーが窓を動かした・大きさを変えた (指を離した時点で 1 回)。次に開いたときも同じ位置に出す */
function rememberWindowRect(id: WindowId, rect: WindowRect): void {
  floatLayout[id] = { ...rect };
  // 退避中 (入っている枠が使えない間の浮いた窓) の窓を動かしたら、その時点で浮いた窓になる (枠の記憶からも外す。
  // C2.1)。外すと onChange で組ごと保存されるので、ここでは保存しない
  if (dockManager.slotOf(id) !== null) {
    dockManager.undock(id);
    return;
  }
  persistWindowLayout();
}

/**
 * 掴む場所 (⠿ / 見出し / タブ) のダブルクリック。**最初の配置 (ドック) の枠へ戻し**、覚えた位置も消す (spec A.2 / C2.6)。
 * 浮いた窓も、別の枠に入れた窓も、最初の配置の枠の最初の配置の並びの位置へ入れて前に出す (dock.ts の restore)。
 * 保存は restore の onChange が組ごと行う (消した float も含む)
 */
function resetWindow(id: WindowId): void {
  // 先に写しから消す。placeInitial は写しにある窓 (動かした窓) を置き直さない
  delete floatLayout[id];
  dockManager.restore(id);
  // 戻す先の枠が使えない (退避) か、最初の配置で枠に入らない窓は、浮いた窓の最初の位置へ置く。ドック中なら何もしない
  placeInitial(id);
}
```

`refreshWindows` の中の

```typescript
  settingsWindow.setVisible(canShow && settingsOpen);
```

の**直後**に次を足す。

```typescript
  // 出す条件が変わったら、枠のタブ・枠の出し入れ・退避を合わせる (C2.2 / C2.7)。**出した直後の取り直しより先に:**
  // 使えない枠の窓は sync が body へ移して浮かせ (onEvacuate で最初の位置へ)、その後で下の取り直しが効く
  dockManager.sync();
```

`placeUnmovedWindows` の本体

```typescript
function placeUnmovedWindows(): void {
  placeInitial("bar");
  placeInitial("list");
  placeInitial("settings");
}
```

を次に置き換える。

```typescript
function placeUnmovedWindows(): void {
  // 枠が使えるかも見直す (1 列表示との切り替えは resize で起きる。C2.1)。変わったら窓を出し直す (退避 / 枠へ戻す)
  if (dockManager.attach(dockAnchors())) refreshWindows();
  for (const id of WINDOW_IDS) placeInitial(id);
}
```

`mount` の先頭

```typescript
function mount(): void {
  // 3 つの窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられると窓だけが外れる
  for (const frame of [barWindow.element, listWindow.element, settingsWindow.element]) {
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
```

を次に置き換える。

```typescript
function mount(): void {
  // ドック枠を差す先に付け直す (C2.7)。YouTube が子を作り直すと枠ごと外れる。使えるかが変わったら
  // (1 列表示になった・戻った・差す先が消えた) 窓を出し直す (退避 / 枠へ戻す)。**バーの有無より先に見る**
  if (dockManager.attach(dockAnchors())) refreshWindows();
  // 浮いた窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。**バーの有無より先に見る。**
  // body の子を差し替えられると窓だけが外れる。**使える枠に入っている窓は枠の中のまま** (枠ごと差し直すのは attach)
  for (const id of WINDOW_IDS) {
    const slot = dockManager.slotOf(id);
    if (slot !== null && dockManager.isUsable(slot)) continue;
    const frame = windowOf(id).element;
    if (frame.parentElement !== document.body) document.body.append(frame);
  }
```

テーマの監視の中の

```typescript
  applyPalette(settingsWindow.element, dark);
});
```

を次に置き換える。

```typescript
  applyPalette(settingsWindow.element, dark);
  // ドック枠 (タブの列と目印) も自前の配色
  for (const slot of Object.values(dockManager.elements)) applyPalette(slot, dark);
});
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: PASS (既存の浮いた窓の検査は、jsdom では差す先の幅が 0 で最初の配置の枠が使えず、3 つの窓が退避で最初の位置に浮くので、位置の
期待がそのまま通る。保存の期待は Step 1 で `docks` を直した。判断メモ 32)

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/selectors.ts src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓を最初からページの中の枠に入れ、落として入れ直せるようにする

最初の配置はドック (バーはプレイヤーの下、区間・テロップと設定は
おすすめ動画の上) とユーザーが決めたので、ダブルクリックもその枠へ
戻す。3 つの窓のドラッグを枠の当たり判定へつなぎ、落とした窓をページの
中に入れる。タブや ⠿ で引き出した窓は掴んだ位置関係を保って指の下に
置く。差す先が消えた・幅 0 の間は、覚えた位置があっても最初の位置の
浮いた窓で出し、その間に動かしたら枠の記憶から外す。保存は浮いた
窓の写しと枠の中身を合わせた組で書き、版の番号は定数から取る。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 8: 覚えた枠を読み込み、⚙ と足した行でドック中のタブを前に出す (`youtube.ts`)

**Files:**
- Modify: `src/content/youtube.ts` (`revealLastRow`、`onToggleSettings`、`loadInitialLayout`、`isDockedInPage` を足す)
- Test: `tests/content/youtube.test.ts` (`describe("ドック枠とタブ")` に足す)、`tests/content/youtube-dock-load.test.ts` (新規)

**Interfaces:**
- Consumes: Task 7 の `dockManager` と `describe("ドック枠とタブ")` のヘルパ、Task 5 の `DockManager.load`
- Produces: youtube.ts の `isDockedInPage(id: WindowId): boolean` (使える枠に入っているか。退避中は false)。読み込みで覚えた `docks` が
  枠に入り (`load` → `refreshWindows` の `sync`)、`float` と両方にある窓には `float` の位置を当てない

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の `describe("ドック枠とタブ")` の最後のテスト (「全画面の間は枠も隠し、抜けたら戻す」) の**後**に次を足す。

```typescript
  test("⚙ で設定を開くと、ドック中の設定のタブが前に出る (閉じるとタブが消える)", async () => {
    // 最初の配置 (右の枠 [list, settings]) で、区間・テロップのタブを押して前に出しておく
    const listTab = tabElement("side", "list");
    pointer(listTab, "pointerdown", 850, 70);
    pointer(listTab, "pointerup", 850, 70);
    expect(activeLabel("side")).toBe("区間・テロップ");

    clickButton("⚙");
    await flush();
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("設定");

    clickButton("⚙");
    await flush();
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);

    clickButton("⚙");
    await flush();
    expect(tabLabels("side")).toEqual(["区間・テロップ", "設定"]);
    expect(activeLabel("side")).toBe("設定");
  });

  test("区間を足すと、ドック中の区間・テロップのタブが前に出る (窓の中は送らない)", async () => {
    // 最初の配置で ⚙ を開き、設定のタブを前に出しておく
    clickButton("⚙");
    await flush();
    expect(activeLabel("side")).toBe("設定");

    video.element.currentTime = 300;
    clickButton("＋ 区間を追加");
    await flush();
    emit({
      kind: "ready",
      segments: [RANGE, { startSec: 300, endSec: 315 }],
      telops: [],
      meta: META_A,
    });

    expect(activeLabel("side")).toBe("区間・テロップ");
    expect(listBody().scrollTop).toBe(0);
  });
```

`tests/content/youtube-dock-load.test.ts` を次の内容で作る。

```typescript
// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CHANNEL, makeVideoMeta } from "../helpers/fixtures";
import type { Message } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

/**
 * 覚えた配置に枠 (docks) と v2 の float があるときの読み込み (窓の分割の spec C2.6)。
 *
 * youtube.ts は import した時点で覚えた配置を 1 度だけ読むので、古い形 (v1) を読ませている youtube.test.ts とは
 * 別のファイルにする (vitest はファイルごとにモジュールを読み直す)。ここでは v2 の組を読ませる:
 * バーは下の枠、区間・テロップの窓は右の枠 (float にもある。枠を採る)、設定の窓は float の位置 (C1 から持ち越した
 * 「float.settings を読み込みで当てる経路」の検査)。
 *
 * **canvas の getContext は stub しない。** 流す状態 (READY) はテロップが空で、プレビューは描かない。テロップ付きの状態を
 * 流す検査を足すときは、youtube.test.ts の spyOnGetContext と同じ扱いにする (jsdom の "Not implemented" が出力に混ざるため)
 */

const META = makeVideoMeta({ videoId: "video-a", title: "動画 A" });
const READY: ClipState = {
  kind: "ready",
  segments: [{ startSec: 10, endSec: 20 }],
  telops: [],
  meta: META,
};
/** 設定の窓の覚えた位置 (jsdom の画面 1024x768 に収まる値) */
const SETTINGS_RECT = { left: 200, top: 150, width: 360, height: 300 };
const LAYOUT_AT_LOAD = {
  version: 2,
  float: { list: { left: 50, top: 60, width: 320 }, settings: SETTINGS_RECT },
  docks: { below: { tabs: ["bar"] }, side: { tabs: ["list"], active: "list" } },
};

/** chrome.storage.local へ書いた windowLayout。書いた順 */
const layoutWrites: unknown[] = [];
/** 覚えた配置の読み込みを止めておく。止めている間に「枠も窓も出ていない」ことを確かめる */
let releaseLayout: () => void = () => undefined;
const layoutGate = new Promise<void>((resolve) => {
  releaseLayout = resolve;
});
let onMessage:
  | ((message: Message, sender: unknown, sendResponse: (response?: unknown) => void) => void)
  | null = null;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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

/** 動画ページの骨組み (差す先 #below と #secondary > #secondary-inner、タイトル、チャンネル、プレイヤー、動画) */
function buildPage(): void {
  const below = document.createElement("div");
  below.id = "below";
  const secondary = document.createElement("div");
  secondary.id = "secondary";
  const inner = document.createElement("div");
  inner.id = "secondary-inner";
  secondary.append(inner);
  const title = document.createElement("h1");
  title.className = "ytd-watch-metadata";
  const titleText = document.createElement("yt-formatted-string");
  titleText.textContent = META.title;
  title.append(titleText);
  // チャンネル (構造化データのハンドル)。⚙ で開いた設定パネルがチャンネルを読むので、無いと warn が出力に混ざる
  const author = document.createElement("span");
  author.setAttribute("itemprop", "author");
  const authorUrl = document.createElement("link");
  authorUrl.setAttribute("itemprop", "url");
  authorUrl.setAttribute("href", `/${META.channelId}`);
  const authorName = document.createElement("link");
  authorName.setAttribute("itemprop", "name");
  authorName.setAttribute("content", CHANNEL.name);
  author.append(authorUrl, authorName);
  const player = document.createElement("div");
  player.id = "movie_player";
  const video = document.createElement("video");
  video.className = "html5-main-video";
  Object.defineProperty(video, "duration", { configurable: true, value: 600 });
  document.body.append(below, secondary, title, author, player, video);
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} がありません`);
  return element;
}

function tabLabels(slot: "below" | "side"): string[] {
  return [...byId(`yt-clip-dock-${slot}`).querySelectorAll<HTMLElement>("[data-role='dock-tab']")]
    .filter((tab) => tab.style.display !== "none")
    .map((tab) => tab.textContent ?? "");
}

/** 読み込む前の様子 (枠と 3 つの窓が出ているか) */
let beforeLoad = { slotsShown: [] as boolean[], windowsHidden: [] as boolean[] };

beforeAll(async () => {
  buildPage();
  // 差す先に幅を持たせる (jsdom はレイアウトを持たず、幅 0 の枠は使えない扱いになる)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.id === "below") return boxAt(0, 600, 800, 0);
    if (this.id === "secondary-inner") return boxAt(840, 60, 400, 0);
    return boxAt(0, 0, 0, 0);
  });
  // jsdom は Pointer Capture も ResizeObserver も持たない
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: async (): Promise<Record<string, unknown>> => ({ settings: { mode: "edit" } }),
        set: async (): Promise<void> => undefined,
      },
      local: {
        get: async (): Promise<Record<string, unknown>> => {
          await layoutGate;
          return { windowLayout: LAYOUT_AT_LOAD };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          layoutWrites.push(items.windowLayout);
        },
      },
      onChanged: { addListener: (): void => undefined },
    },
    runtime: {
      onMessage: {
        addListener: (fn: typeof onMessage): void => {
          onMessage = fn;
        },
      },
      sendMessage: async (): Promise<{ state: ClipState }> => ({ state: READY }),
    },
  });

  await import("@/content/youtube");
  await flush();
  beforeLoad = {
    slotsShown: ["below", "side"].map(
      (slot) => document.getElementById(`yt-clip-dock-${slot}`)?.style.display === "block",
    ),
    windowsHidden: ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].map(
      (id) => byId(id).hidden,
    ),
  };
  releaseLayout();
  await flush();
  // エディットモードで区間があるので、区間・テロップの窓を出す条件を満たす
  onMessage?.({ type: "state/changed", state: READY }, {}, () => undefined);
  await flush();
});

afterAll(async () => {
  // youtube.ts の MutationObserver は解除できない。youtube.test.ts と同じく、保留中の DOM 変化を出し切り、
  // observer が見ていない空の body に差し替えて終える
  document.body.innerHTML = "";
  await flush();
  document.documentElement.replaceChild(document.createElement("body"), document.body);
  await flush();
});

describe("覚えた枠を読み込む", () => {
  test("読み込むまでは、枠も窓も出さない (浮いた窓で出してから枠へ跳ぶ絵にしない)", () => {
    expect(beforeLoad.slotsShown).toEqual([false, false]);
    expect(beforeLoad.windowsHidden).toEqual([true, true, true]);
  });

  test("読み込みは保存しない", () => {
    expect(layoutWrites).toEqual([]);
  });

  test("覚えた docks どおり、バーは #below の枠、区間・テロップの窓は #secondary-inner の枠に入る (float にもある窓は枠を採る)", () => {
    const below = byId("yt-clip-dock-below");
    const side = byId("yt-clip-dock-side");
    expect(below.parentElement?.id).toBe("below");
    expect(side.parentElement?.id).toBe("secondary-inner");
    expect(below.contains(byId("yt-clip-bar-window"))).toBe(true);
    expect(side.contains(byId("yt-clip-list"))).toBe(true);
    expect(byId("yt-clip-list").style.position).toBe("static");
    expect(below.style.display).toBe("block");
    expect(side.style.display).toBe("block");
    // バーだけの枠はタブの列を出さない。区間・テロップの窓だけの枠は出す
    expect(tabLabels("below")).toEqual([]);
    expect(tabLabels("side")).toEqual(["区間・テロップ"]);
  });

  test("覚えた float.settings の位置に、⚙ で開いた設定の窓を出す", async () => {
    const gear = [...document.querySelectorAll<HTMLButtonElement>("#yt-clip-bar button")].find(
      (button) => button.textContent === "⚙",
    );
    if (gear === undefined) throw new Error("⚙ がありません");
    gear.click();
    await flush();

    const settings = byId("yt-clip-settings");
    expect(settings.parentElement).toBe(document.body);
    expect(settings.hidden).toBe(false);
    expect({
      left: settings.style.left,
      top: settings.style.top,
      width: settings.style.width,
      height: settings.style.height,
    }).toEqual({ left: "200px", top: "150px", width: "360px", height: "300px" });
  });

  test("#secondary が無くなると区間・テロップの窓は最初の位置の浮いた窓で出て (float に位置があっても)、戻ると枠に戻る", async () => {
    const secondary = byId("secondary");
    secondary.remove();
    await flush();

    const list = byId("yt-clip-list");
    expect(list.parentElement).toBe(document.body);
    expect(list.style.position).toBe("fixed");
    expect({ left: list.style.left, top: list.style.top, width: list.style.width }).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
    });

    document.body.append(secondary);
    await flush();
    expect(byId("yt-clip-dock-side").contains(list)).toBe(true);
    expect(list.style.position).toBe("static");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-dock-load.test.ts` (Bash の timeout 120000)
期待: FAIL。youtube.test.ts の足した 2 件は、⚙ で開いても前のタブが「区間・テロップ」のまま / 区間を足しても「設定」のまま
(2 件目の「⚙ で開き、設定のタブを前に出しておく」の確かめは、前のタブの記憶が beforeEach の戻しで「設定」なので今のコードでも通り、
その後の「区間・テロップ」で落ちる)。
youtube-dock-load.test.ts は「覚えた docks どおり…」が、枠が空 (バーも一覧も body の直下) で落ちる。「覚えた float.settings の位置に…」は
今の読み込み (3 つの窓の float を当てる) で通ってよい。「#secondary が無くなると…」は一覧が枠に入っていないので、最初の位置ではなく
覚えた float (50, 60) で出て落ちる

- [ ] **Step 3: 最小実装**

`src/content/youtube.ts` の `revealLastRow` の doc と関数 (`/**\n * 足した行を区間・テロップの窓の見える範囲に入れる。` から関数の閉じ括弧まで) を次に置き換える。

```typescript
/**
 * 使える枠に入っている (ページの中にある) か。退避中 (入っている枠が使えない間の浮いた窓) は false:
 * 見えている形 (浮いた窓) に合わせて、⚙ と足した行の扱いを浮いた窓と同じにする
 */
function isDockedInPage(id: WindowId): boolean {
  const slot = dockManager.slotOf(id);
  return slot !== null && dockManager.isUsable(slot);
}

/**
 * 足した行を区間・テロップの窓の見える範囲に入れる。**応答を描いた後に呼ぶ** (クリックの時点では
 * 行がまだ無い)。押した結果が見えないと無反応に見える (右側パネルの spec §3)。
 *
 * **浮いた窓は前には出さない** (C1.2 は窓の中を送ることだけを求める)。前に出すと、設定の窓で値を
 * 見ながら区間を足したときに設定が潜る。**ドック中ならタブを前に出すだけ** (C2.2): ページの中の窓は中身なりの
 * 高さで中でスクロールしないので送る先が無く、ページもスクロールしない (右側パネルの spec §3 と同じ理由)。
 * 窓が隠れている (全画面など) ときは何もしない。出す判断は `refreshWindows` のもの
 */
function revealLastRow(
  list: HTMLElement | undefined,
  role: "segment" | "telop",
): void {
  if (list === undefined || listWindow.element.hidden) return;
  const rows = list.querySelectorAll<HTMLElement>(`[data-role='${role}']`);
  const last = rows[rows.length - 1];
  if (last === undefined) return;
  if (isDockedInPage("list")) {
    dockManager.activate("list");
    return;
  }
  listWindow.scrollTo(last);
}
```

`onToggleSettings` の doc と関数 (`/**\n * ⚙。設定の窓を開閉する` から関数の閉じ括弧まで) を次に置き換える。

```typescript
/**
 * ⚙。設定の窓を開閉する (窓の分割の spec C1.2)。**開いたら設定の窓を前に出す。** 最初の位置では
 * 区間・テロップの窓に下へ 32px ずれて重なるので、前に出さないと一覧の窓の下に潜り、押しても
 * 開いていないように見える。**ドック中ならそのタブを前に出す** (C2.2。ページはスクロールしない)。
 *
 * **開く → 出す → 前に出す の順を崩さない。** 窓を出すかは設定パネルの `hidden` を見て
 * refreshWindows が決める (ドック中ならタブもそこで出る)。窓の中は送らない (中身は設定だけで、送る先が無い)
 */
function onToggleSettings(): void {
  // ⚙ は buildBar の中で設定パネルを作った後に作るので、押せた時点で null は
  // ありえない。null なら配線のバグなので、黙って何もしない形で隠さない
  if (settingsPanel === null) {
    throw new Error("設定パネルを作る前に ⚙ が押されました");
  }
  settingsPanel.toggle();
  refreshWindows();
  if (settingsPanel.element.hidden) return;
  if (isDockedInPage("settings")) {
    dockManager.activate("settings");
    return;
  }
  settingsWindow.frame.bringToFront();
}
```

`loadInitialLayout` の中の

```typescript
    .then((layout) => {
      for (const id of ["bar", "list", "settings"] as const) {
        const rect = layout.float[id];
        if (rect === undefined) continue;
        // 写しを書き換える 3 箇所の 1 つ (floatLayout の doc)
        floatLayout[id] = rect;
        windowOf(id).place(rect);
      }
    })
```

を次に置き換える。

```typescript
    .then((layout) => {
      // 枠の中身を先に入れる。窓を枠へ置くのは下の refreshWindows の sync (出す条件が決まってから)。
      // **読み込みは保存しない** (load は onChange を呼ばない。C1.3)
      dockManager.load(layout.docks);
      for (const id of WINDOW_IDS) {
        const rect = layout.float[id];
        if (rect === undefined) continue;
        // 写しを書き換える 3 箇所の 1 つ (floatLayout の doc)
        floatLayout[id] = rect;
        // float と docks の両方にある窓は枠を採る (C2.6)。float は引き出したときの大きさにだけ使うので、
        // 写しには入れ、位置は当てない
        if (dockManager.slotOf(id) !== null) continue;
        windowOf(id).place(rect);
      }
    })
```

同じ関数の doc の 1 行目

```typescript
 * 起動時に覚えた窓の位置を読む。**済むまで窓を出さない** (refreshWindows が layoutReady を見る)。
```

を次に置き換える。

```typescript
 * 起動時に覚えた窓の配置 (浮いた窓の位置と、どの枠に入れたか) を読む。**済むまで窓も枠も出さない**
 * (refreshWindows が layoutReady を見る。枠は窓が隠れていれば隠れる)。
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-dock-load.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts tests/content/youtube-dock-load.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 覚えた枠に窓を入れて開き、⚙ と足した行ではドック中のタブを前に出す

読み込み直しても入れた枠とタブの並びを保つ。浮いた窓の位置も覚えて
いる窓は枠を採り、位置は引き出したときの大きさにだけ使う。ドック中の
窓はページの中にあり中でスクロールしないので、⚙ や区間・テロップの
追加ではタブを前に出すだけにし、ページは動かさない。v2 の設定の窓の
位置を読み込みで当てる経路の検査も、読み込みを分けたテストで埋める。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 9: E2E を最初の配置 (ドック) に合わせ、C2.10 の確認と実測を足す。掲載画像のスクリプトを直す

**Files:**
- Modify: `e2e/telop-check.spec.ts` (「窓の位置の出所」の `measured` 825〜833 行目、受け入れ条件 1440x795 の 871〜973 行目、`openSettings` /
  `closeSettings` 1039〜1052 行目とその後、浮いた窓の確認 5 項目 1054〜1275 行目、「古い形 (v1)…」1277〜1307 行目のコメント、
  末尾の `await writeResults();` 1424 行目の前)
- Modify: `scripts/screenshots.mjs` (関連動画を隠す CSS 55〜58 行目、`framePlayerAndBar` 85〜103 行目以降)

**Interfaces:**
- Consumes: Task 5〜8 の DOM (`#yt-clip-dock-below` / `#yt-clip-dock-side`、`[data-role=dock-tabs]`・`[data-role=dock-tab][data-active]`・
  `[data-drop-target=true]`)、`windowLayout` の `docks` の形、最初の配置 (ドック)、既存のヘルパ (`check` / `record` / `boxOf` / `centerOf` / `near` /
  `headerPoint` / `floatOf` / `dragFromTo` / `reloadAndWaitList` / `readWindowLayout` / `bringBarToFront` / `getWorker` / `writeSettings` / `waitNoAd` /
  `seekPaused` / `OUT_DIR` / `join`)
- Produces: check:telop の項目が 26 → 32 (「ドック: …」で始まる 6 項目。受け入れ条件 1440x795 とダブルクリックの項目は名前が変わる)。
  `test-results/telop-check/dock-bar-below-1440x795.png`。記録に `belowTop` / `playerBottom` (`#below` の上の余白)・`secondaryInnerWidth` (1440x795)・
  シアターモードの `#secondary` の箱 (Task 10 が読む)。`scripts/screenshots.mjs` が最初の配置 (ドック) の絵を撮る

行番号は 26eaebd の時点。**このタスクは `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない** (運用前提)。型と単体テスト
までで止め、実機は Task 10 で controller が行う。

- [ ] **Step 1: 「窓の位置の出所」に差す先の箱とシアターモードを足す**

`e2e/telop-check.spec.ts` の「窓の位置の出所 (YouTube の実測)」の `measured` の中の

```typescript
        list: box("#yt-clip-list"),
        listZIndex: zIndex("#yt-clip-list"),
      };
```

を次に置き換える。

```typescript
        list: box("#yt-clip-list"),
        listZIndex: zIndex("#yt-clip-list"),
        // ドック枠の差す先 (窓の分割の spec C2.1)。#below の上の余白と右の列の幅の出所。人が読んで dock.ts に書き写す
        below: box("#below"),
        secondaryInner: box("#secondary-inner"),
        player: box("#movie_player"),
        theater: document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? null,
      };
```

同じ項目の `record` の合否

```typescript
      measured.masthead !== null && measured.secondary !== null && measured.list !== null,
```

を次に置き換える (差す先が読めなければ、ドックの確認も成り立たない)。

```typescript
      measured.masthead !== null &&
        measured.secondary !== null &&
        measured.list !== null &&
        measured.below !== null &&
        measured.secondaryInner !== null,
```

- [ ] **Step 2: 受け入れ条件 1440x795 を最初の配置 (ドック) で測る形に置き換える**

`e2e/telop-check.spec.ts` の「// --- 受け入れ条件 (フロートの窓の spec A.4・窓の分割の spec C1.5): 1440x795 で、…」のコメントの行から、
`ACCEPTANCE_1440` の `check` の閉じ (`});`) まで (871〜973 行目) を次に置き換える (判断メモ 34。C1 の「設定の窓の中でスクロールする」は、
ページの中の窓は中身なりの高さなので外す)。

```typescript
  // --- 受け入れ条件 (窓の分割の spec C2.10。フロートの窓の spec A.4・C1.5 を最初の配置 (ドック) で測る): 1440x795 で、
  // 覚えた配置が無いとき、バーは下の枠 (#below の先頭) に入ってページの先頭で画面に収まり、区間・テロップと設定は
  // 右の枠 (#secondary-inner の先頭) にタブで入ってプレイヤーに重ならない ---------------------------------------------
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  const ACCEPTANCE_1440 =
    "受け入れ条件 1440x795: 最初の配置 (ドック) のまま帯の段が最大 (2 段 + 「+N」) で設定を開いても、下の枠のバーがプレイヤーの下で画面に収まり、右の枠の区間・テロップと設定がプレイヤーに重ならない";
  await check(ACCEPTANCE_1440, async () => {
    // 前提を自分で作る: 覚えた配置を消して読み込み直す (最初の配置になる)。区間はまだ無い (直前の項目でシンプルに
    // 切り替えた) ので reloadAndWaitList は使わない
    const worker = await getWorker();
    await worker.evaluate(() => chrome.storage.local.remove("windowLayout"));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await waitNoAd();
      await writeSettings({ mode: "edit" });
      await expect(button("＋ 区間を追加")).toBeVisible({ timeout: 10_000 });
      for (const [i, startSec] of LAYOUT_SEGMENT_STARTS.entries()) {
        await seekPaused(startSec);
        await button("＋ 区間を追加").click();
        await expect(segmentRows).toHaveCount(i + 1);
      }
      // 3 つを同じ時刻に重ねて、帯の段を最大 (2 段 + 「+1」) にしてから測る (spec A.4)
      for (const [i, startSec] of LAYOUT_TELOP_STARTS.entries()) {
        await seekPaused(startSec);
        await listWindow.locator("[data-role=add-telop]").click();
        await expect(telopRows).toHaveCount(i + 1);
      }
      // 設定も開く (右の枠で設定のタブが前に出る)
      await button("⚙").click();
      await expect(page.locator("#yt-clip-setting-mode")).toBeVisible();
      await expect(settingsWindow).toBeVisible();

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
        const player = document.getElementById("movie_player");
        const below = document.getElementById("yt-clip-dock-below");
        const side = document.getElementById("yt-clip-dock-side");
        if (player === null || below === null || side === null) {
          throw new Error("プレイヤーかドック枠がありません");
        }
        const p = player.getBoundingClientRect();
        const inSlot = (slot: HTMLElement, id: string) => {
          const element = document.getElementById(id);
          return element !== null && slot.contains(element);
        };
        const belowTabs = below.querySelector<HTMLElement>("[data-role=dock-tabs]");
        const sideTabs = [...side.querySelectorAll<HTMLElement>("[data-role=dock-tab]")].filter(
          (tab) => getComputedStyle(tab).display !== "none",
        );
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          // **枠の外形で測る。** 中身の根 (#yt-clip-bar) ではない (spec A.4 / C2.10)
          below: rect("yt-clip-dock-below"),
          side: rect("yt-clip-dock-side"),
          barInBelow: inSlot(below, "yt-clip-bar-window"),
          belowFirst: below.parentElement?.id === "below" && below.parentElement.firstElementChild === below,
          belowTabsShown: belowTabs !== null && getComputedStyle(belowTabs).display !== "none",
          listInSide: inSlot(side, "yt-clip-list"),
          settingsInSide: inSlot(side, "yt-clip-settings"),
          sideFirst:
            side.parentElement?.id === "secondary-inner" && side.parentElement.firstElementChild === side,
          sideLabels: sideTabs.map((tab) => tab.textContent ?? ""),
          sideActive: sideTabs.find((tab) => tab.dataset.active === "true")?.textContent ?? null,
          playerBottom: p.bottom,
          playerRight: p.right,
          mastheadBottom:
            document.getElementById("masthead-container")?.getBoundingClientRect().bottom ?? null,
          // C2.10 の予算の出所 (#below の上の余白) と C2.5 の右の列の幅 (1440x795)。人が読んで dock.ts に書き写す
          belowTop: document.getElementById("below")?.getBoundingClientRect().top ?? null,
          secondaryInnerWidth:
            document.getElementById("secondary-inner")?.getBoundingClientRect().width ?? null,
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
      });
      // **記録だけ (合否には入れない)。** 落ちたときに、覚えた配置が本当に消えていたか (最初の配置か) を後から読めるようにする
      const windowLayout = await readWindowLayout().catch((error: unknown) => ({
        error: String(error),
      }));
      const file = join(OUT_DIR, "layout-1440x795.png");
      await page.screenshot({ path: file });
      record(
        ACCEPTANCE_1440,
        measured.scrollY === 0 &&
          measured.barInBelow &&
          measured.belowFirst &&
          !measured.belowTabsShown &&
          measured.playerBottom <= measured.below.top &&
          measured.below.bottom <= measured.innerHeight &&
          measured.listInSide &&
          measured.settingsInSide &&
          measured.sideFirst &&
          measured.side.left >= measured.playerRight &&
          measured.side.top >= (measured.mastheadBottom ?? Number.POSITIVE_INFINITY) &&
          JSON.stringify(measured.sideLabels) === JSON.stringify(["区間・テロップ", "設定"]) &&
          measured.sideActive === "設定" &&
          measured.telopBands === 2 &&
          measured.telopLanes === 2 &&
          measured.telopOverflow === "+1",
        {
          ...measured,
          belowGap: measured.belowTop === null ? null : measured.belowTop - measured.playerBottom,
          windowLayout,
          file,
        },
      );
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });
```

- [ ] **Step 3: `openSettings` / `closeSettings` を窓の hidden で判定する**

```typescript
  async function openSettings(): Promise<void> {
    if (await settingsWindow.isVisible()) return;
```

を次に置き換える。

```typescript
  async function openSettings(): Promise<void> {
    if (await isSettingsOpen()) return;
```

```typescript
  async function closeSettings(): Promise<void> {
    if (!(await settingsWindow.isVisible())) return;
```

を次に置き換える。

```typescript
  async function closeSettings(): Promise<void> {
    if (!(await isSettingsOpen())) return;
```

`openSettings` の doc コメント (`/**\n   * 設定の窓が閉じていれば ⚙ を押して開く。`) の**直前**に次を足す (名前を `isSettingsOpen` に
するのは、「⚙ で設定が別の窓に開閉し…」の中に同じ名前の Box の変数 `settingsOpen` があり、読み手が迷わないように)。

```typescript
  /**
   * 設定が開いているか。**窓が見えているかでは判定しない**: ドック中で後ろのタブにいる設定の窓は、開いているが
   * 見えない (枠の中の箱が隠れている)。開閉は窓の hidden (出す条件) で見る (窓の分割の spec C2.8)
   */
  async function isSettingsOpen(): Promise<boolean> {
    return settingsWindow.evaluate((element) => !(element as HTMLElement).hidden);
  }

```

- [ ] **Step 4: ドックの確認のヘルパを、浮いた窓の確認の前に置く**

`closeSettings` の関数の閉じ (`}`) の後、`await check("⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま", …)` の**直前**に次を足す
(浮いた窓の確認の前提と、末尾のドックの確認が両方使う)。

```typescript
  // --- ドック枠の確認のヘルパ (窓の分割の spec C2) ---------------------------------------------------------------
  type Point = { x: number; y: number };
  const belowSlot = page.locator("#yt-clip-dock-below");
  const sideSlot = page.locator("#yt-clip-dock-side");
  /** 3 つとも浮いた窓 (最初の位置) の配置。浮いた窓の確認の前提に使う (判断メモ 34) */
  const FLOAT_LAYOUT = { version: 2, float: {}, docks: {} };

  /** 枠の中の、文言が label のタブ */
  const tabIn = (slot: Locator, label: string) =>
    slot.locator("[data-role=dock-tab]", { hasText: label });
  /** 覚えた配置の docks (v2 でなければ null) */
  const docksOf = (saved: Record<string, unknown> | null): Record<string, unknown> | null =>
    saved !== null && saved.version === 2 && typeof saved.docks === "object" && saved.docks !== null
      ? (saved.docks as Record<string, unknown>)
      : null;
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** 覚えた配置を書いてから読み込み直す (前提を作る。区間 5 つが残っていることが要る) */
  async function setLayoutAndReload(layout: Record<string, unknown>): Promise<void> {
    const worker = await getWorker();
    await worker.evaluate((value) => chrome.storage.local.set({ windowLayout: value }), layout);
    await reloadAndWaitList();
  }

  /** 覚えた配置を消してから読み込み直す (最初の配置 = ドックになる) */
  async function resetLayoutAndReload(): Promise<void> {
    const worker = await getWorker();
    await worker.evaluate(() => chrome.storage.local.remove("windowLayout"));
    await reloadAndWaitList();
  }

  /**
   * from で押し、detour を通ってから slot の落とし先の帯の中心で離す。**帯へは一度その外から入れる** (始めたときに
   * 帯の中にあった指は、一度出るまで当たらない。C2.3)。**帯はドラッグを始めた後で測る** (隠れている枠の目印は、
   * ドラッグの間だけページの流れに出る)
   */
  async function dropInto(from: Point, detour: Point, slot: Locator): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(detour.x, detour.y, { steps: 8 });
    const band = centerOf(await boxOf(slot.locator("[data-drop-target=true]")));
    await page.mouse.move(band.x, band.y, { steps: 8 });
    await page.mouse.up();
    // 覚える (chrome.storage.local への保存) のは指を離した後に非同期で走る
    await page.waitForTimeout(500);
  }

  /** 枠の様子: 差した先・先頭か・箱・タブの列が出ているか・出ているタブの文言と前のタブ・中の窓 */
  async function slotState(slot: "below" | "side") {
    return page.evaluate((id) => {
      const root = document.getElementById(`yt-clip-dock-${id}`);
      if (root === null) return null;
      const b = root.getBoundingClientRect();
      const row = root.querySelector<HTMLElement>("[data-role=dock-tabs]");
      const tabs = [...root.querySelectorAll<HTMLElement>("[data-role=dock-tab]")].filter(
        (tab) => getComputedStyle(tab).display !== "none",
      );
      return {
        shown: getComputedStyle(root).display !== "none",
        parentId: root.parentElement?.id ?? null,
        first: root.parentElement?.firstElementChild === root,
        box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
        tabsShown: row !== null && getComputedStyle(row).display !== "none",
        labels: tabs.map((tab) => tab.textContent ?? ""),
        active: tabs.find((tab) => tab.dataset.active === "true")?.textContent ?? null,
        windows: ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].filter((windowId) => {
          const element = document.getElementById(windowId);
          return element !== null && root.contains(element);
        }),
      };
    }, slot);
  }

  /** プレイヤー・ヘッダー・差す先の箱と、シアターモードか (C2.1 の余白・C2.5 の幅の出所) */
  async function pageBoxes() {
    return page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const b = element.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width };
      };
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollY: window.scrollY,
        player: box("#movie_player"),
        masthead: box("#masthead-container"),
        below: box("#below"),
        secondary: box("#secondary"),
        secondaryInner: box("#secondary-inner"),
        theater: document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? null,
      };
    });
  }

  /** 3 つの窓がどれも body の直下 (浮いた窓) か */
  async function allFloating(): Promise<boolean> {
    return page.evaluate(() =>
      ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].every(
        (id) => document.getElementById(id)?.parentElement === document.body,
      ),
    );
  }

```

- [ ] **Step 5: 浮いた窓の確認の前提を「3 つとも浮いた窓」にする**

最初の配置がドックになったので、浮いた窓の確認 (C1 の項目) は覚えた配置を `FLOAT_LAYOUT` にして読み込み直してから始める (判断メモ 34)。
次の 4 つの `check` の `async () => {` の**直後**の行に、それぞれ次の 2 行を足す (元の `await page.evaluate(() => window.scrollTo(0, 0));`
や `closeSettings()` / `openSettings()` はそのまま後ろに残す)。

- `await check("⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま", async () => {`
- `await check("窓を動かすと、読み込み直しても同じ位置に出る", async () => {`
- `await check("右下をドラッグすると大きさが変わる (バーの窓は幅だけ)", async () => {`
- `await check("窓を画面の外へドラッグしても、掴む場所が画面に残る", async () => {`

```typescript
    // 前提: 3 つとも浮いた窓の最初の位置 (最初の配置はドックなので、覚えた配置を枠なしにして読み込み直す。判断メモ 34)
    await setLayoutAndReload(FLOAT_LAYOUT);
```

「窓を動かすと、読み込み直しても同じ位置に出る」の中の次の 2 か所を直す (浮いた区間・テロップの窓と設定の窓は右の列の上にあり、
左へ少しだけ動かすと、右の枠の帯に外から入って離れる経路になりうる (C2.3)。プレイヤーの上まで左へ動かして、どの帯の外で離す。
各項目が前提を作り直すので、次の項目でバーの窓の角に重なる心配は無くなった)。

```typescript
    await dragFromTo(settingsAt, { x: settingsAt.x - 60, y: settingsAt.y + 80 });
```

を次に置き換える。

```typescript
    await dragFromTo(settingsAt, { x: settingsAt.x - 200, y: settingsAt.y + 80 });
```

```typescript
    // 区間・テロップの窓の見出しは、設定の窓の上に出ている (カスケード)。左へは少しだけ動かす
    // (大きく動かすと、次の項目でバーの窓の右下の角に重なる)
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 60, y: listAt.y + 40 });
```

を次に置き換える。

```typescript
    // 区間・テロップの窓の見出しは、設定の窓の上に出ている (カスケード)。プレイヤーの上まで左へ動かし、右の枠の帯の外で離す
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 200, y: listAt.y + 40 });
```

同じ項目の `record` の合否の

```typescript
        near(listMoved.x, listStart.x - 60) &&
```

と

```typescript
        near(settingsMoved.x, settingsStart.x - 60) &&
```

を、それぞれ `listStart.x - 200` / `settingsStart.x - 200` に直す。

- [ ] **Step 6: ダブルクリックの確認を「最初の配置の枠へ戻る」に置き換える**

`await check("掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える", async () => {` から、その `check` の閉じ (`});`) まで
(1218〜1275 行目) を次に置き換える (spec C2.6。ダブルクリックの戻し先は最初の配置の枠)。

```typescript
  await check("掴む場所をダブルクリックすると最初の配置の枠 (ドック) に戻り、覚えた位置も消える", async () => {
    // 前提: 3 つとも浮いた窓にして、どれも動かしておく (どの帯の外で離す)
    await setLayoutAndReload(FLOAT_LAYOUT);
    await page.evaluate(() => window.scrollTo(0, 0));
    await closeSettings();
    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: grip.x + 80, y: grip.y + 40 });
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 200, y: listAt.y + 40 });
    await openSettings();
    const settingsAt = headerPoint(await boxOf(settingsHeader));
    await dragFromTo(settingsAt, { x: settingsAt.x - 200, y: settingsAt.y + 160 });
    const savedMoved = await readWindowLayout();

    await barGrip.dblclick();
    const listHeaderBox = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: listHeaderBox.height / 2 } });
    const settingsHeaderBox = await boxOf(settingsHeader);
    await settingsHeader.dblclick({ position: { x: 40, y: settingsHeaderBox.height / 2 } });
    await page.waitForTimeout(500);
    const below = await slotState("below");
    const side = await slotState("side");
    const saved = await readWindowLayout();
    // 後の項目 (帯) は区間・テロップの窓の行を押す。設定は閉じておく (右の枠では区間・テロップのタブが前に出る)
    await closeSettings();

    const movedFloat = floatOf(savedMoved);
    const float = floatOf(saved);
    record(
      "掴む場所をダブルクリックすると最初の配置の枠 (ドック) に戻り、覚えた位置も消える",
      movedFloat !== null &&
        Object.keys(movedFloat).length === 3 &&
        below !== null &&
        below.windows.includes("yt-clip-bar-window") &&
        side !== null &&
        side.windows.includes("yt-clip-list") &&
        side.windows.includes("yt-clip-settings") &&
        sameJson(side.labels, ["区間・テロップ", "設定"]) &&
        side.active === "設定" &&
        float !== null &&
        Object.keys(float).length === 0 &&
        sameJson(docksOf(saved), {
          below: { tabs: ["bar"], active: "bar" },
          side: { tabs: ["list", "settings"], active: "settings" },
        }),
      { savedMoved, below, side, saved },
    );
  });
```

「古い形 (v1)…」の項目の中のコメント

```typescript
    // 後の項目 (帯) のために最初の位置へ戻す。戻すと v2 の組で書かれる
```

を次に置き換える (中身は変えない。v1 で位置を覚えていた区間・テロップの窓は浮いた窓で出て (判断メモ 30)、ダブルクリックで最初の配置の
右の枠へ戻る)。

```typescript
    // 後の項目 (帯) のために最初の配置 (右の枠) へ戻す。戻すと v2 の組で書かれる。バーと設定は v1 に位置が無いので最初から枠の中
```

その後の帯の確認の前のコメント「// 窓の確認の後 (3 つの窓は最初の位置に戻り、設定の窓は閉じている)。」を
「// 窓の確認の後 (3 つの窓は最初の配置の枠に入り、設定は閉じている)。」に直す。

- [ ] **Step 7: 末尾に C2.10 の 6 項目を足す**

「帯を押して離すと、そのテロップの頭から再生する」の `check` の閉じ (`});`) の後、`await writeResults();` の**直前**に次を足す (ヘルパは Step 4 で
足してある)。

```typescript
  // --- ドック枠とタブ (窓の分割の spec C2.10) ---------------------------------------------------------------
  // 帯の確認の後 (末尾) に行う。受け入れ条件の確認で足した区間 5 つ・テロップ 5 つが残っている。**各項目は前提 (覚えた
  // 配置・設定の開閉・画面の大きさ) を自分で作る**: 覚えた配置を書いて (消して) から読み込み直す
  const DOCK_NO_SUCK =
    "ドック: 浮いた窓を少し動かしてもドックされない (見出しを 20px 下・⠿ を 20px 右。1440x795)";
  await check(DOCK_NO_SUCK, async () => {
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await setLayoutAndReload(FLOAT_LAYOUT);
      await page.evaluate(() => window.scrollTo(0, 0));
      // 受け入れ条件と同じく設定も開く (浮いた設定の窓は一覧の窓の下へ 32px ずれて前に出る。一覧の見出しは見えている)
      await openSettings();
      const floatingBefore = await allFloating();
      // 見出しの上端から 4px の点 (帯の外から始まる、最も吸い込まれやすい経路。C2.10)
      const header = await boxOf(listHeader);
      const headerFrom = { x: header.x + 40, y: header.y + 4 };
      await dragFromTo(headerFrom, { x: headerFrom.x, y: headerFrom.y + 20 });
      const grip = centerOf(await boxOf(barGrip));
      await dragFromTo(grip, { x: grip.x + 20, y: grip.y });
      const floatingAfter = await allFloating();
      const saved = await readWindowLayout();
      const boxes = await pageBoxes();
      record(DOCK_NO_SUCK, floatingBefore && floatingAfter && sameJson(docksOf(saved), {}), {
        floatingBefore,
        floatingAfter,
        saved,
        headerFrom,
        grip,
        boxes,
      });
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });

  const DOCK_BAR_BELOW =
    "ドック: 浮いたバーを下の枠に落とすと #below の先頭に入り、ページの先頭でプレイヤーの下に画面に収まる。読み込み直しても入ったまま、⠿ で引き出してダブルクリックすると下の枠に戻る (1440x795)";
  await check(DOCK_BAR_BELOW, async () => {
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await setLayoutAndReload(FLOAT_LAYOUT);
      await closeSettings();
      await page.evaluate(() => window.scrollTo(0, 0));
      // ⠿ をプレイヤーの中 (上方向) へ外してから (どの帯の外。下の枠の目印は #below の幅いっぱいなので、横へ動かすだけ
      // では帯を出られない位置から始まることがある。判断メモ 39)、プレイヤーの直下の目印 (#below の先頭) へ
      const grip = centerOf(await boxOf(barGrip));
      const player = await boxOf(page.locator("#movie_player"));
      await dropInto(grip, { x: grip.x, y: player.y + player.height / 2 }, belowSlot);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const docked = await slotState("below");
      const boxes = await pageBoxes();
      const saved = await readWindowLayout();
      const file = join(OUT_DIR, "dock-bar-below-1440x795.png");
      await page.screenshot({ path: file });

      await reloadAndWaitList();
      await page.evaluate(() => window.scrollTo(0, 0));
      const afterReload = await slotState("below");

      // ⠿ で引き出してプレイヤーの上に置き、⠿ をダブルクリックすると下の枠 (最初の配置) に戻る
      const dockedGrip = centerOf(await boxOf(barGrip));
      await dragFromTo(dockedGrip, { x: dockedGrip.x + 100, y: player.y + player.height / 2 });
      const pulled = await page.evaluate(
        () => document.getElementById("yt-clip-bar-window")?.parentElement === document.body,
      );
      await barGrip.dblclick();
      await page.waitForTimeout(500);
      const reset = await slotState("below");
      const savedAfterReset = await readWindowLayout();

      const playerBottom = boxes.player?.bottom ?? Number.POSITIVE_INFINITY;
      record(
        DOCK_BAR_BELOW,
        docked !== null &&
          boxes.scrollY === 0 &&
          docked.parentId === "below" &&
          docked.first &&
          docked.windows.includes("yt-clip-bar-window") &&
          !docked.tabsShown &&
          playerBottom <= docked.box.top &&
          docked.box.bottom <= boxes.innerHeight &&
          sameJson(docksOf(saved), { below: { tabs: ["bar"], active: "bar" } }) &&
          afterReload !== null &&
          afterReload.windows.includes("yt-clip-bar-window") &&
          pulled &&
          reset !== null &&
          reset.windows.includes("yt-clip-bar-window") &&
          sameJson(docksOf(savedAfterReset), { below: { tabs: ["bar"], active: "bar" } }) &&
          !("bar" in (floatOf(savedAfterReset) ?? { bar: true })),
        {
          docked,
          boxes,
          belowGap:
            boxes.below !== null && boxes.player !== null
              ? boxes.below.top - boxes.player.bottom
              : null,
          saved,
          afterReload,
          pulled,
          reset,
          savedAfterReset,
          file,
        },
      );
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });

  const DOCK_SIDE_TABS =
    "ドック: 浮いた区間・テロップの窓と設定の窓を右の枠に落とすとタブが 2 つ並び、後から落とした方が前。⚙ とタブで切り替わり、読み込み直しても並びが同じ";
  await check(DOCK_SIDE_TABS, async () => {
    await setLayoutAndReload(FLOAT_LAYOUT);
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    // プレイヤーの上はどの帯の外
    const detour = centerOf(await boxOf(page.locator("#movie_player")));
    await dropInto(headerPoint(await boxOf(listHeader)), detour, sideSlot);
    // 設定は浮いた窓で開く (最初の位置)。見出しを右の枠のタブの列へ
    await openSettings();
    await dropInto(headerPoint(await boxOf(settingsHeader)), detour, sideSlot);
    const docked = await slotState("side");
    const boxes = await pageBoxes();
    const shown = { list: await listWindow.isVisible(), settings: await settingsWindow.isVisible() };

    // ⚙ で閉じると設定のタブが消え、もう一度押すと設定のタブが前に出る
    await closeSettings();
    const closed = await slotState("side");
    await openSettings();
    const reopened = await slotState("side");
    // 区間・テロップのタブを押すと一覧が出て設定が隠れる
    await tabIn(sideSlot, "区間・テロップ").click();
    await page.waitForTimeout(500);
    const listFront = {
      state: await slotState("side"),
      list: await listWindow.isVisible(),
      settings: await settingsWindow.isVisible(),
    };
    const saved = await readWindowLayout();

    // 読み込み直しても並びが同じ。設定の開閉は覚えないので、読み込み直した直後は一覧のタブだけ。⚙ で開いて並びを見る
    await reloadAndWaitList();
    const afterReload = await slotState("side");
    await openSettings();
    const afterReloadOpened = await slotState("side");
    await closeSettings();

    const mastheadBottom = boxes.masthead?.bottom ?? Number.POSITIVE_INFINITY;
    const playerRight = boxes.player?.right ?? Number.POSITIVE_INFINITY;
    record(
      DOCK_SIDE_TABS,
      docked !== null &&
        docked.parentId === "secondary-inner" &&
        docked.first &&
        docked.box.left >= playerRight &&
        docked.box.top >= mastheadBottom &&
        sameJson(docked.labels, ["区間・テロップ", "設定"]) &&
        docked.active === "設定" &&
        !shown.list &&
        shown.settings &&
        closed !== null &&
        sameJson(closed.labels, ["区間・テロップ"]) &&
        reopened !== null &&
        reopened.active === "設定" &&
        listFront.state !== null &&
        listFront.state.active === "区間・テロップ" &&
        listFront.list &&
        !listFront.settings &&
        sameJson(docksOf(saved), { side: { tabs: ["list", "settings"], active: "list" } }) &&
        afterReload !== null &&
        sameJson(afterReload.labels, ["区間・テロップ"]) &&
        afterReloadOpened !== null &&
        sameJson(afterReloadOpened.labels, ["区間・テロップ", "設定"]),
      { docked, boxes, shown, closed, reopened, listFront, saved, afterReload, afterReloadOpened },
    );
  });

  const DOCK_TAB_TO_BELOW =
    "ドック: 最初の配置から区間・テロップのタブを下の枠 (バーの上の目印) へ落とすと、下の枠にタブが 2 つ (バー / 区間・テロップ) 出て、右の枠は設定だけになる。タブを押すと切り替わる";
  await check(DOCK_TAB_TO_BELOW, async () => {
    // 前提: 最初の配置 (下の枠 [bar] / 右の枠 [list, settings])
    await resetLayoutAndReload();
    // 設定を開く (右の枠で設定のタブが前に出る)。バーは下の枠にバーだけで入っていて、⚙ が見えている
    await openSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const detour = centerOf(await boxOf(page.locator("#movie_player")));
    await dropInto(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), detour, belowSlot);
    const below = await slotState("below");
    const side = await slotState("side");
    // バーのタブを押すとバーが出て、一覧が隠れる
    await tabIn(belowSlot, "バー").click();
    await page.waitForTimeout(500);
    const barFront = {
      state: await slotState("below"),
      bar: await barWindow.isVisible(),
      list: await listWindow.isVisible(),
    };
    const saved = await readWindowLayout();
    record(
      DOCK_TAB_TO_BELOW,
      below !== null &&
        sameJson(below.labels, ["バー", "区間・テロップ"]) &&
        below.active === "区間・テロップ" &&
        side !== null &&
        sameJson(side.labels, ["設定"]) &&
        barFront.state !== null &&
        barFront.state.active === "バー" &&
        barFront.bar &&
        !barFront.list &&
        sameJson(docksOf(saved), {
          below: { tabs: ["bar", "list"], active: "bar" },
          side: { tabs: ["settings"], active: "settings" },
        }),
      { below, side, barFront, saved },
    );
  });

  const DOCK_PULL_OUT =
    "ドック: 最初の配置からタブを枠の外 (プレイヤーの上) へ引き出して離すとフロートになり、見出しのダブルクリックで右の枠 (最初の配置) に戻る。引き出してから右の枠の帯へ落としても戻る";
  await check(DOCK_PULL_OUT, async () => {
    await resetLayoutAndReload();
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const target = centerOf(await boxOf(page.locator("#movie_player")));
    await dragFromTo(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), target);
    const pulled = {
      floating: await page.evaluate(
        () => document.getElementById("yt-clip-list")?.parentElement === document.body,
      ),
      side: await slotState("side"),
    };
    const savedPulled = await readWindowLayout();

    // 浮いた窓の見出しをダブルクリックすると最初の配置 (右の枠) に戻り、覚えた位置も消える
    const header = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: header.height / 2 } });
    await page.waitForTimeout(500);
    const reset = await slotState("side");
    const savedReset = await readWindowLayout();

    // 設定を開いて右の枠にタブの列を出してから (spec C2.10「タブの列へ落としても戻る」)、もう一度引き出し、見出しをタブの列へ落として戻す
    await openSettings();
    await dragFromTo(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), target);
    await dropInto(headerPoint(await boxOf(listHeader)), { x: target.x, y: target.y + 100 }, sideSlot);
    const back = await slotState("side");
    await closeSettings();

    const floatPulled = floatOf(savedPulled);
    const floatReset = floatOf(savedReset);
    record(
      DOCK_PULL_OUT,
      pulled.floating &&
        pulled.side !== null &&
        !pulled.side.shown &&
        floatPulled !== null &&
        "list" in floatPulled &&
        sameJson(docksOf(savedPulled), {
          below: { tabs: ["bar"] },
          side: { tabs: ["settings"] },
        }) &&
        reset !== null &&
        reset.windows.includes("yt-clip-list") &&
        sameJson(reset.labels, ["区間・テロップ"]) &&
        floatReset !== null &&
        !("list" in floatReset) &&
        sameJson(docksOf(savedReset), {
          below: { tabs: ["bar"] },
          side: { tabs: ["list", "settings"], active: "list" },
        }) &&
        back !== null &&
        back.windows.includes("yt-clip-list") &&
        sameJson(back.labels, ["設定", "区間・テロップ"]) &&
        back.active === "区間・テロップ",
      { pulled, savedPulled, reset, savedReset, back },
    );
  });

  // シアターモードは YouTube が覚える (次の読み込みにも残る) ので、最後に置き、戻してから終える
  const DOCK_THEATER =
    "ドック: 最初の配置のまま t でシアターモードにすると、右の枠は動画の下へ回ってドックされたまま。戻すと元の位置";
  await check(DOCK_THEATER, async () => {
    await resetLayoutAndReload();
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const measure = async () => ({ slot: await slotState("side"), boxes: await pageBoxes() });
    /** YouTube のショートカット t。入力欄やボタンにフォーカスがあると効かない・文字として入るので、先に外す */
    const toggleTheater = async (theater: boolean): Promise<void> => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("t");
      await page.waitForFunction(
        (expected) =>
          (document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? false) === expected,
        theater,
        { timeout: 10_000 },
      );
      // レイアウトが落ち着くのを待つ (プレイヤーの大きさの変化で placeUnmovedWindows も走る)
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollTo(0, 0));
    };
    const normal = await measure();
    await toggleTheater(true);
    const theater = await measure();
    await toggleTheater(false);
    const restored = await measure();
    const inSlot = (m: typeof normal) =>
      m.slot !== null && m.slot.windows.includes("yt-clip-list");
    const infinity = Number.POSITIVE_INFINITY;
    record(
      DOCK_THEATER,
      inSlot(normal) &&
        normal.boxes.theater === false &&
        (normal.slot?.box.left ?? -infinity) >= (normal.boxes.player?.right ?? infinity) &&
        inSlot(theater) &&
        theater.boxes.theater === true &&
        (theater.slot?.box.top ?? -infinity) >= (theater.boxes.player?.bottom ?? infinity) &&
        inSlot(restored) &&
        restored.boxes.theater === false &&
        (restored.slot?.box.left ?? -infinity) >= (restored.boxes.player?.right ?? infinity),
      { normal, theater, restored },
    );
  });

```

- [ ] **Step 8: 掲載画像のスクリプトを最初の配置 (ドック) に合わせる**

`scripts/screenshots.mjs` の関連動画を隠す CSS

```javascript
  // **関連動画を隠す。** 掲載画像に他人の動画のサムネイルが写り込むのを避ける。
  // 拡張と関係ない要素が減って、見せたいものにも目が行く
  await page.addStyleTag({
    content: "#secondary, ytd-watch-next-secondary-results-renderer { display: none !important; }",
  });
```

を次に置き換える (判断メモ 35)。

```javascript
  // **関連動画の中身を隠す。** 掲載画像に他人の動画のサムネイルが写り込むのを避ける。
  // **右の列 (#secondary) そのものは残す**: 最初の配置では区間・テロップと設定が右の列の先頭の枠に入る
  // (窓の分割の spec C2.6)。列ごと隠すと右の枠が使えない扱いになり、設定が浮いた窓で出て、実際の絵と違ってしまう
  await page.addStyleTag({
    content:
      "#related, #chat, ytd-watch-next-secondary-results-renderer { display: none !important; }",
  });
```

`framePlayerAndBar` の doc と関数、その呼び出しから 1-range.png を撮るまで

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

  await framePlayerAndBar(0.72);
```

を次に置き換える。

```javascript
  /**
   * ページの先頭へ戻す。最初の配置ではバーはプレイヤーの直下 (#below の先頭の枠)、設定はおすすめ動画の上の枠に
   * ページの一部として入っている (窓の分割の spec C2.6) ので、先頭のままでプレイヤーと操作の両方が 1 枚に入る
   * (1280x800 でプレイヤーの下端 + バー約 140px < 800)。浮いた窓の置き直し (resize) は要らなくなった
   */
  const frameTop = async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(500);
  };

  await frameTop();
```

2-settings.png を撮る部分 (「// 設定を開く。**設定は設定の窓に開き**」のコメントから `await framePlayerAndBar(0.72);` と
`await page.screenshot({ path: \`${OUT_DIR}/2-settings.png\` });` の直前まで) を次に置き換える
(プレイヤーの幅を空ける CSS と、浮いた設定の窓の中を送る処理は要らなくなった)。

```javascript
  // 設定を開く。最初の配置では、おすすめ動画の上の枠で設定のタブが前に出る (窓の分割の spec C2.2)。
  // ページの中の窓は中身なりに伸びるので、1280x800 では設定の末尾が画面の下で切れるが、それでよい
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-settings")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  await frameTop();
```

ファイルの先頭の doc コメントは変えない。

- [ ] **Step 9: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`e2e` は typecheck の対象。`scripts/screenshots.mjs` は JavaScript なので typecheck の対象外。`node --check scripts/screenshots.mjs`
(Bash の timeout 60000) で構文だけ確かめる。E2E と掲載画像そのものは走らせない)

- [ ] **Step 10: 項目の数を確かめる**

実行: `grep -c 'await check(' e2e/telop-check.spec.ts` (リポジトリの根で)
期待: 変更前より 6 多い (変更前の数は `git -C /Users/trapple/repos/github.com/trapple/yt-clip show HEAD:e2e/telop-check.spec.ts | grep -c 'await check('`。
26eaebd で 21)。check:telop の結果の項目数 26 → 32 は Task 10 で確かめる

- [ ] **Step 11: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts scripts/screenshots.mjs
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): 最初の配置 (ドック) で受け入れ条件を測り、ドック枠とタブの確認を足す

最初の配置がドックになったので、1440x795 の受け入れ条件は下の枠の
バーと右の枠のタブで測る。浮いた窓の確認は覚えた配置を枠なしにして
読み込み直してから行い、ダブルクリックは最初の配置の枠へ戻ることを
確かめる。浮いた窓を少し動かしても吸い込まれないこと・バーを下の枠へ
落とすこと・右の枠のタブ・引き出し・シアターモードを測り、#below の
上の余白と右の列の幅を記録する。掲載画像は右の列を残し、ページの
先頭で撮る。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 10: 実機で確かめ、実測値を書き込む (controller が実行)

**Files:**
- Modify: `src/content/dock.ts` (差す先の実測のコメント。予算を超えたときだけ `BELOW_SLOT_MARGIN_TOP_PX`)
- Modify: `docs/manual-check.md` (「## 確認した環境」)
- Modify: `.claude/specs/2026-09-25-dockable-windows-design.md` (`## 自律判断ログ` の末尾に 2 行)
- Modify: `scripts/screenshots.mjs` (掲載画像に他人の動画のサムネイルが写り込んだときだけ、隠す CSS に要素を足す)

**実行者: controller (メインセッション)。** 実機 (Google Chrome / 同梱の Chromium と YouTube) を使い、結果の画像と記録を見て判断するため
subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜9 のすべて
- Produces: `test-results/telop-check/` の結果、`release/screenshots/` の掲載画像、`dock.ts` の実測のコメント、`docs/manual-check.md` と spec の記録

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: 通常の E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout がある)
期待: smoke の 3 件が PASS、`テロップの実機確認` は skip

- [ ] **Step 3: `npm run check:telop` を走らせる**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分を超えうるので Bash の timeout 600000 では足りない。テスト自身が
`test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。
20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` の項目がすべて `pass: true` で、C1 のときの 26 項目に「ドック: 」で始まる 6 項目を
足した **32 項目**がある (受け入れ条件 1440x795 とダブルクリックの項目は名前が変わっている。数が違えば `results.json` のキーを並べて差を確かめる)

落ちたときの見方:

- 受け入れ条件 1440x795 で `below.bottom > innerHeight` → 最初の配置のバーだけの下の枠が予算 (167px) を超えた。記録の `belowGap`
  (`#below` の上端 − プレイヤーの下端) が 27px を超えていれば spec C2.10 の想定どおりの原因。Step 5 で `BELOW_SLOT_MARGIN_TOP_PX` を決める。
  `barInBelow` / `listInSide` が false なら、覚えた配置が消えていない (`windowLayout` の記録) か、差す先が使えない (幅 0) 扱いになっている
- 浮いた窓の確認 (C1 の項目) が「要素が画面に出ていません」で落ちたら、前提の `setLayoutAndReload(FLOAT_LAYOUT)` の後で窓が枠に入っている。
  `readWindowLayout` の値が `docks: {}` か、C1 の見出しのドラッグの終わりが帯の中になっていないか (右の枠の帯の外で離しているか) を見る
- 「ドック: 浮いた窓を少し動かしても…」で `floatingAfter` が false → 少し動かしただけで吸い込まれた。`saved.docks` のどの枠に入ったかと、`headerFrom` /
  `grip` と帯の位置 (記録の `boxes.below` / `boxes.secondaryInner` の top) を比べ、距離の武装 (40px) と「外から入った」のどちらが効いて
  いないかを見る (dock.ts の `hitTest`)
- 「ドック: 浮いたバーを下の枠に…」で `docked` が null・`windows` にバーが無い → 落とせていない。迂回 (プレイヤーの中) を通っても帯に
  入れていないなら、`boxOf` で測った目印の中心が画面の外 (下) に出ていないか (記録の `boxes.below` と `innerHeight`) を見る。
  `docked.box.bottom > boxes.innerHeight` は受け入れ条件と同じ原因。`playerBottom > docked.box.top` → 枠がプレイヤーに食い込んだ (補正を負にしすぎた)
- 「ドック: 浮いた区間・テロップの窓と設定の窓を右の枠に…」で `docked.parentId` が `secondary-inner` でない → YouTube の右の列の作りが
  変わった。`boxes.secondaryInner` が null なら `#secondary` に差している (selectors.ts の `dockSide` の 2 つ目)
- 「ドック: …シアターモード…」で `theater.boxes.theater` が false → `t` が効いていない (フォーカスがページの外)。記録の `normal` と
  `theater` の `boxes.player` の幅が同じなら切り替わっていない
- どれも `boxOf` の「要素が画面に出ていません」で落ちたら、ドラッグの間に帯 (`[data-drop-target=true]`) が出ていない。落とし先の帯は
  入れられて使える枠にだけ出る (差す先の幅 0 = 使えない)

- [ ] **Step 4: 画像と記録を見て判定する**

Read で次を見る。

- `test-results/telop-check/layout-1440x795.png` — 最初の配置: バーがプレイヤーの直下 (動画のタイトルの上) にページの一部として入り
  (影が無い・タブの列が無い)、枠の下端が画面の下端より上。右の列の先頭に「区間・テロップ」「設定」のタブが並び、設定が前に出ている。
  どれも動画に重ならない
- `test-results/telop-check/dock-bar-below-1440x795.png` — 浮かせたバーを落とし直した後も、上と同じ位置に入っている
- `results.json` の「ドック: 浮いた区間・テロップの窓と設定の窓を右の枠に…」の `docked` — `labels` が `["区間・テロップ", "設定"]`、`active` が「設定」、
  `box.left ≥ boxes.player.right`

**1440x795 でバーだけの下の枠が画面に収まらず、補正 (Step 5) でも収まらない (補正するとプレイヤーに食い込む) ときは、spec の受け入れ条件
(C2.10) が崩れている。** 直さずに spec の `## 自律判断ログ` に
`- [実機] 1440x795 でバーだけの下の枠が画面に N px 収まらない (belowGap=…, slot.bottom=…, innerHeight=795)` と 1 行書き、最終報告でユーザーに伝える。

- [ ] **Step 5: 実測値を dock.ts に書き、要るなら下の枠の上の余白を詰める**

記録から次の 3 つを読む (値は小数を丸めて px で書く)。

- `#below` の上の余白 = 受け入れ条件 1440x795 の `belowGap` (`belowTop − playerBottom`)。「ドック: 浮いたバーを下の枠に…」の `belowGap` とも一致するはず
- 1440x795 での `#secondary-inner` の幅 = 受け入れ条件 1440x795 の `secondaryInnerWidth`
- シアターモードの `#secondary` の位置 = 「ドック: …シアターモード…」の `theater.boxes.secondary` (top / left / width) と `theater.boxes.player.bottom`

`src/content/dock.ts` の `BELOW_SLOT_MARGIN_TOP_PX` の doc コメントの**直前**に次のコメントを足す (`<…>` は実際の値。日付は
`TZ=Asia/Tokyo date +%F` の JST)。

```typescript
/*
 * 差す先の実測 (YouTube。<JST の日付> に `npm run check:telop` の「ドック: …」と「窓の位置の出所」で測った):
 * - 1440x795: プレイヤーの下端 <playerBottom>px、#below の上端 <belowTop>px (上の余白 <belowGap>px)、
 *   #secondary-inner の幅 <secondaryInnerWidth>px (バーの最小の幅 480px <より狭い / 以上>。C2.5)
 * - 1920x1080: #secondary-inner の左端 <left>px・幅 <width>px (「窓の位置の出所」の secondaryInner)
 * - シアターモード (1920x1080): #secondary は動画の下 (top <top>px ≥ プレイヤーの下端 <playerBottom>px)、幅 <width>px
 * YouTube のレイアウトが変わったら測り直す
 */
```

`belowGap` が 27px を超え、受け入れ条件 1440x795 が `below.bottom > innerHeight` で落ちたときだけ、
`BELOW_SLOT_MARGIN_TOP_PX` を `-(below.bottom − innerHeight)` を切り上げた負の整数にする。ただし
`below.top − |補正| ≥ playerBottom` を保つ (プレイヤーに食い込ませない)。保てないなら Step 4 の太字の手順に従う。
変えたら Step 1 と Step 3 をもう一度走らせ、32 項目がすべて通ることを確かめる。

`#secondary-inner` の幅が 480px 以上だったら、spec C2.5 の「バーは右の枠に入れない」の根拠は「拡大バーはプレイヤーの幅で使うもの」だけに
なる。`window-layout.ts` の `acceptsDock` の doc の「右の列の幅 (… 1440x795 で 400px 前後) より広く」を実測に合わせて直す。

spec の `## 自律判断ログ` の末尾に次の 2 行を足す (`<…>` は実際の値)。2 行目は plan の判断メモ 13 の記録 (spec の文言は直さない)。

```markdown
- [実機 C2] <JST の日付> check:telop 32 項目通過。#below の上の余白 <belowGap>px (1440x795。BELOW_SLOT_MARGIN_TOP_PX = <値>)、#secondary-inner の幅 <secondaryInnerWidth>px (1440x795。480px <未満 / 以上>)、シアターモードの #secondary は top <top>px (プレイヤーの下端 <playerBottom>px の下)。値は dock.ts のコメント
- [実装 C2] 差す先そのものが無いとき (C2.7「何もしない」) も、幅 0 と同じく「使えない枠」として退避にした (C2.1 と規則を 1 つにする)。動画ページ以外では 3 つの窓が隠れているので、見た目は「何もしない」と同じ
```

- [ ] **Step 6: 掲載画像を撮り直して確かめる**

実行: `npm run screenshots` (Bash の timeout 600000。スクリプト側にも起動 60 秒・遷移 60 秒・待ち 30 秒の上限がある)
期待: `release/screenshots/1-range.png` と `release/screenshots/2-settings.png` が出力される

Read で 2 枚を見る (判断メモ 35)。

- `1-range.png`: ページの先頭で、バーがプレイヤーの直下 (ページの中) に入っている。右の列は空 (おすすめ動画の中身は隠している。
  シンプルモードで設定を閉じているので右の枠も出ていない)。他人の動画のサムネイルが写っていない
- `2-settings.png`: 右の列の先頭の枠で設定のタブが前に出て、設定の先頭が見える。末尾は画面の下で切れてよい。プレイヤーに重ならない。
  他人の動画のサムネイルやチャットが写っていない

写り込みがあれば (YouTube が別の要素でおすすめ動画を出している)、その要素を `scripts/screenshots.mjs` の隠す CSS に足して撮り直し、commit に含める。
`release/` は `.gitignore` の対象なので commit しない。

- [ ] **Step 7: 手で見る項目を確かめる**

`docs/manual-check.md` の「見た目」に Task 1 で足した項目のうち、E2E で測っていないもの (落とし先の帯の見せ方と塗り・ドック中のバーの ⠿ での
引き出し・ページと一緒にスクロールする・1 列表示の幅まで狭めたときの退避と戻り・ダークとライトの枠とタブ・画面の外で ⚙ を押しても跳ばない) を、
`npm run check:telop` と同じ Chrome で拡張を読み込んで手で確かめる。できなかった項目は Step 8 の記録に「単体テストでだけ確かめている」と書く。

- [ ] **Step 8: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の最後の段落 (「2026-09-25 は窓の分割 (C1) を `npm run check:telop` で確かめた」で始まる段落) の後に、
空行を 1 つ挟んで次を足す (`<…>` は実際の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。表の「確認日 (JST)」の範囲も、日付が変わっていれば後ろを延ばす。

```markdown
<JST の日付> はドック枠とタブ (C2。最初の配置はドック) を `npm run check:telop` で確かめた (32 項目すべて通過)。1440x795 で、最初の配置の
まま区間 5・テロップ 5・設定を開いた状態で、下の枠のバーがプレイヤーの下端 <playerBottom>px より下で画面に収まり (枠の下端 <slotBottom>px。
#below の上の余白 <belowGap>px。画面は `test-results/telop-check/layout-1440x795.png`)、右の枠のタブがプレイヤーに重ならないこと、浮いた窓を
少し動かしてもドックされないこと、浮かせたバーを下の枠へ落とし直せること、浮いた区間・テロップの窓と設定の窓を右の枠に入れるとタブが並び、
⚙ とタブで切り替わって読み込み直しても並びが同じこと、タブを下の枠へ移せること、タブの引き出しと、ダブルクリックで最初の配置の枠へ
戻ること、シアターモードで右の枠が動画の下へ回ることを確かめた。「見た目」節のドックの項目のうち、<手で確かめた項目> は手で確かめ、
<確かめていない項目> は単体テストでだけ確かめている。ストアの掲載画像 (`npm run screenshots`) で、バーが下の枠に、設定が右の枠のタブに
写ることを確かめた。
```

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/dock.ts src/content/window-layout.ts docs/manual-check.md .claude/specs/2026-09-25-dockable-windows-design.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: ドック枠とタブを実機で確かめ、差す先の実測を残す

1440x795 でバーだけを下の枠に入れても画面に収まるか、右の列の幅が
バーの最小の幅より狭いかは、spec が実装時に測ると決めていた。
check:telop で測った #below の上の余白・#secondary-inner の幅・
シアターモードの右の列の位置を dock.ts と spec に書き、C2 の受け入れ
条件を実機で通したことと、手で見た項目を記録する。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

(`src/content/window-layout.ts` は `acceptsDock` の doc を直したとき、`scripts/screenshots.mjs` は隠す CSS を足したときだけ変わる。変わった
ファイルは `git add` に足し、変わっていなければ外す)

---

## 完了後

1. `npm run typecheck && npm test` (Bash の timeout 600000) で全テストが green であることを確認する
2. whole-branch cross-review: この plan の範囲 (C1 の終わりと fitRect の fix の後、commit 26eaebd 以降) を見るため、
   `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff 26eaebd..HEAD` を 1 ファイルにまとめ、新しい subagent に
   subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる (A・B・C1 と合わせた branch 全体
   `BASE=$(git merge-base main HEAD)` の diff も添える)。指摘は直して再レビュー (手順は cross-review スキル)。
   攻撃者視点の入力例: 壊れた `windowLayout.docks` (`{ side: { tabs: ["bar"] } }`・`{ below: { tabs: ["list", "list"], active: "x" } }`・
   `docks: []`・`{ side: { tabs: "list" } }`・同じ窓が `below` と `side` の両方・`float` と `docks` の両方にある窓)・ドラッグの最中に
   `#secondary` を消す / シアターモードを切り替える / 全画面にする / 別の動画へ移る・タブを押したまま状態の通知が届く・⚙ の連打
   (設定がドック中)・1 列表示の幅と広い幅を行き来しながら退避中の窓を動かす・引き出したタブの上でダブルクリック・
   3 つの窓をすべて下の枠に入れる (バーのタブが後ろのとき ⚙ に届かない)・古い形 (v1) と v2 の `docks: {}`・覚えた配置が無いときの最初の配置
   (ドック) で 1 列表示から始める・ダブルクリックの連打で並び順が揺れないか
   - subagent を派遣できない環境では、自分で spec の C2 の各項目と diff を突き合わせ、上の入力例を単体テストか実機で試して結果を記録する
3. branch `feat/dockable-windows` 上の commit で停止。push / PR / merge はユーザーの指示を待つ。最終報告では、Task 10 の実測 (1440x795 で最初の
   配置のバーだけの下の枠が収まったか、`BELOW_SLOT_MARGIN_TOP_PX` を詰めたか) を伝える

完了の条件:

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke が通る
- `npm run check:telop` の 32 項目がすべて通り、`layout-1440x795.png` で最初の配置のバーだけの下の枠がプレイヤーの下で画面に収まっていることを
  controller が目で確かめた (Task 10)
- `release/screenshots/` の 2 枚が最初の配置 (下の枠のバー・右の枠の設定のタブ) を写し、他人の動画のサムネイルを写していない
- README / CHANGELOG / docs (manual-check・store-release・privacy-policy) に C2 の文言が入っている
- `dock.ts` のコメントと spec の自律判断ログに実測値がある
- whole-branch の cross-review が Approved
