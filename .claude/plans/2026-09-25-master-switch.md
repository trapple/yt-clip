# 全機能のオン / オフ (マスタースイッチ) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (SDD) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** ツールバーの拡張アイコンの popup に**全機能のオン / オフのスイッチ**を置き、オフの間は YouTube と X のページに
何も出さず・何も変えない (要素 0・listener 0・observer 0・ループ 0・メッセージ 0) ようにする。オンに戻すと、開いているタブでも
読み込み直さずに戻る。オフの間はアイコンに `OFF` のバッジを出す。

**Architecture:** 保存は `chrome.storage.local` の `enabled` (既定オン) で、読み書きと見張りは `src/shared/master-switch.ts` の
1 か所。content script (youtube.ts / x.ts) は import 時にページへ触らず、新しい `src/content/switch-driver.ts` が保存された値を
1 回読み・`onChanged` を見張り、望んでいる状態と走っている状態を `reconcile()` で合わせて `start()` / `stop()` を呼ぶ。
youtube.ts は今まで import 時にしていたこと (3 つの窓・ドック枠・observer・listener・mount・読み込み) を `start()` へ移し、
`stop()` で逆順に片付ける。録画対象のタブで録画が走っている間は stop を待たせ、中止 (`CANCEL_RECORDING`) を送るか
書き出しの結末を送り終えてから片付ける。service worker は状態機械を変えず、バッジ (`src/background/badge.ts`) だけを持つ。

**Tech Stack:** TypeScript / Vite (crxjs) / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-25-master-switch-design.md` (以下「spec」。レビュー 2 往復で Approved)。**この plan は spec の全体。**
C2 (ドック枠とタブ。`.claude/plans/2026-09-25-dockable-windows-c2.md`) は実装・レビュー済みで、branch `feat/master-switch` の
HEAD 97c55d9 (C2 の bb0bd30 の上に spec を 1 コミット) にそのまま積む。spec の自律判断ログ末尾の「残りの Recommendations 4 件は
plan の判断メモで扱う」は判断メモ 1〜4 で扱う。spec §2.2 の棚卸し表を C2 の実装後のコードと突き合わせた結果は判断メモ 5〜12。

## 判断メモ (spec と既存コードの食い違い・spec の曖昧な箇所。autonomous なので自分で決めた)

### spec の残りの Recommendations 4 件

1. **中止の応答で片付ける口は「専用の口 + state/changed の両方」にする** (Recommendation 1)。オフを待たされた録画対象タブは
   `cancelForSwitch()` (youtube.ts に足す) で `CANCEL_RECORDING` を `chrome.runtime.sendMessage` で送り、**その応答の状態が busy で
   なければ**その場で旗を下ろして `reconcile()` する。`state/changed` (`ready`) が先に届けばそちらでも下ろす (どちらが先でも
   同じ結果)。state/changed だけに倒さない理由: router の同報は `void sendToTab` の送りっぱなしで、届かなかったとき (タブへの
   同報の失敗は router が `console.error` に残すだけ) に永久に待つ。既存の `send()` を使わない理由: `send()` は応答の状態を
   `accepted` の判定にしか使わず、busy でない応答を「片付けてよい」に変える口が無い。`cancelForSwitch` の送信そのものが
   失敗したとき (拡張が読み込み直されて受け手が居ない) は、待っても結末は届かないので旗を下ろして片付ける (spec §4.1 の
   「永久に待たない」と同じ判断)。
2. **`describeSwitch` の `hint` はモック (spec §6.1) の「区切り線の下の 1 行」にする** (Recommendation 2)。spec の本文は
   `hint` =「端末の注意か待っている間の文言」だが、モックは端末の注意「この端末だけに効く (同期しない)」をスイッチの下に**いつも**
   出し、待っている間の文言は区切り線の下 (オンなら状態の文言が出る場所) に出す。本文どおりに 1 つの `hint` で両方を持つと、
   待っている間は端末の注意が消えてモックと合わない。そこで:
   - 端末の注意は popup.html に固定で書く (状態に依らない。`describeSwitch` は返さない)
   - `hint: string | null` = オフの間に状態の文言の代わりに出す 1 行 (「オフです。YouTube と X のページには何も出ません」/
     「オフにします。録画を中止しています…」/「オフにします。書き出しが済んだら止まります…」)。オンなら `null`
   - `note: string | null` = オフで `preview` / `posted` / `degraded` のときの「録画したクリップは残っています (オンに戻すと続きから)」
   - `state` の型は `ClipState | null` (spec §6.1「状態を取得できなかったときもスイッチは出す」。`null` = 取れていない)
3. **対象タブが消えて「中止しています…」が残るときの抜け道を manual-check と README に書く** (Recommendation 3)。起きる経路:
   オフを待っている間に録画対象のタブを読み込み直すと、読み込まれた content script はオフなので `content/loaded` を送らず、
   router は `recording` / `encoding` のまま。popup は「オフにします。録画を中止しています…」/「…書き出しが済んだら止まります…」を
   出し続ける。抜け道は 2 つ: **オンに戻す** (読み込み直したタブが `content/loaded` を送り、router が `recording-aborted` に落とす)
   か、**そのタブを閉じる** (`tabs.onRemoved` → `tab-lost`)。どちらも既存の経路で、コードは足さない。Task 1 で
   `docs/manual-check.md` の節「オン / オフ」と README の節「オン / オフ」に書く。
4. **`reconcile()` を呼ぶ「送り終えた」位置は notify の then・catch の両方** (Recommendation 4)。今の `notify()` は
   `void sendMessage(...).catch(...)` で、成功の口が無い。これを `Promise<void>` を返す形にし (失敗の扱い = 状態に出して
   `FAIL recording-aborted` を送る、は今のまま)、録画の結末 (`recorder/done` / `recorder/failed`) だけを `notifyOutcome()` で送る:
   `void notify(message).then(endCapture)`。`notify` の Promise は成功でも失敗 (FAIL を送った後) でも resolve するので、
   どちらでも `endCapture()` (旗を下ろして `reconcile()`) が走る。FAIL の応答は待たない (`send` は送りっぱなし。送り出した時点で
   メッセージは出ている)。`recorder/started` は結末ではないので `void notify(...)` のまま。

### spec §2.2 の棚卸し表と C2 の実装後のコードの突き合わせ

5. **「今は無名関数なので名前を付ける」は `fullscreenchange` / `resize` には当たらない。** C2 の後のコードでは
   `document.addEventListener("fullscreenchange", refreshWindows)` と `window.addEventListener("resize", placeUnmovedWindows)` で、
   既に名前のある関数を渡している (youtube.ts 2206・2210 行)。無名なのは `chrome.runtime.onMessage` の listener (2029 行)・
   設定の `chrome.storage.onChanged` の listener (2175 行)・`MutationObserver` 2 つの callback (2189・2213 行)。これらに
   `onRuntimeMessage` / `onSettingsChanged` / `onThemeChanged` / `onPageMutated` の名前を付ける。body の監視の変数名は
   `observer` から `pageObserver` に改める (`themeObserver` と並べて読めるように)。
6. **import 時に作っていたもの (3 つの窓・ドック枠・`telopPreview`・`playerObserver`・observer 2 つ) は `let x!: T` にして
   `start()` で作る。** spec の自律判断ログ「モジュールの `let` を初期値に戻す関数を 1 つ持つ」の具体。`T | null` にすると
   `barWindow` などへの約 60 か所の参照すべてに null の確かめが要り、差分が C2 の読み直しを要する大きさになる。`!` (definite
   assignment) は「start() が必ず先に作る」の宣言で、start の前に触る経路は無い (mount・refreshWindows・listener はすべて
   start の中か start が張った listener から呼ばれる)。**stop の後に古い参照へ触る経路は判断メモ 7 の `runId` で断つ。**
   `telopPreview` は作るだけならページに触らない (`createTelopPreview` は canvas を update で作る) が、spec §2.3 の
   「telopPreview.destroy()」と対にするため start で作る。
7. **棚卸し表に無かった「非同期の続き」を片付けの対象に足す。** 表の項目 (要素・listener・observer・rAF) を外しても、既に
   走っている Promise の続きが stop の後に届くと、ページに触り直す。C2 の後のコードで該当するもの:
   - `send()` の then / catch (`applyStateToDisplay` → 帯を `.ytp-progress-bar` に差す・窓を出す)
   - `recoverFromState()` の then / catch (同上。catch は `console.warn` を出す = オフの間の出力 0 行に反する)
   - `loadInitialSettings()` の then / catch (`applyMode` → `mount()` でバーを作り直す)
   - `loadInitialLayout()` の then / catch / finally (`layoutReady = true` → `refreshWindows()` で窓を出す)
   - `seekAndPlay()` の seek の後 (`video.play()` と、呼び出し側の `playRange` が張る `onReachTime` の rVFC)
   - (録画の経路。Task 8) `prepareRecording()` の seek の後 (`SEEK_DONE` の送信)、`runRecording()` の再生の後
     (`watchSegmentEnd` の rVFC)、`beginRecording()` の `startRecording` の後 (オフの後に `MediaRecorder` と `captureStream` が
     回り始める)、`advanceToSegment()` の seek と再生の後 (複数区間の継ぎ目。`video.play()` と `waitForFreshFrame` の rVFC、
     seek が失敗したときの `FAIL seek-failed` の送信。plan レビューの Issue 1。判断メモ 31)
   - (オフのための中止。Task 8) `cancelForSwitch()` の応答 (古い応答が新しい回の旗を下ろさない。判断メモ 33)
   これらは **`runId` (start と stop のたびに進める番号) と `isCurrentRun(id)`** で断つ: 続きの始めに番号を覚え、今の番号と
   違えば何もしない。オフ → オンで作り直した後に古い続きが新しい窓を触ることも防ぐ。
8. **設定から読んだ値 (`mode` / `maxClipSec` / `telopStyle`) は stop で戻さない。** spec §2.2 の「モジュールの状態」の列挙には
   入っていないが「など」がある。戻さない理由: `mode` を `"simple"` に戻すと、start の `loadInitialSettings` の `applyMode("edit")` が
   「モードが変わった」としてバーを作り直し、`content/loaded` の応答が先に届いて区間を持っていると `RESET_MARKS` を送って区間を
   捨てる (今もタブの読み込み直しで起きうる競合だが、オフ → オンで増やさない)。start が設定を読み直すので値は結局同じになる。
   `floatLayout` (覚えた配置の写し) は spec §8 のテスト「読み直して同じ位置に出る」どおり stop で空にし、start で読み直す。
9. **`playheadWatched` の再生位置のループに止める口を足す** (spec §2.2 の表どおり)。`playheadFrame` に rAF の handle を持ち、
   `stopPlayheadWatch()` で `cancelAnimationFrame` して `playheadWatched = false` に戻す (次の start の mount で張り直す)。
10. **`dock.ts` はコードを変えない。** C2 の `destroy()` は `for (const slot of allSlots) slot.root.remove()` で、目印
    (`[data-role=dock-marker]`)・タブの列・置き場・窓ごとの箱・ドック中の窓はすべて根の子なので一緒に外れる (spec の未確定事項)。
    ドラッグの最中 (目印が出ている) に destroy しても残らないことを `tests/content/dock.test.ts` に特性テストとして足す (Task 7)。
    今のコードのまま通る (TDD の「失敗を見る」は当たらない。step にそう書く)。
11. **`floating-window.ts` のモジュール変数 `stack` (重なり順) は `destroy()` が外す** (C2 の後のコード 506-510 行)。窓を作り直すと
    新しい要素が積まれるだけで、古い要素は残らない。変更は要らない。
12. **stop の順序は spec §2.3 のまま、先頭で `running = false` と `runId += 1` をする。** 片付けの途中で同期に呼ばれる経路は無いが、
    stop の後に届く非同期の続き (判断メモ 7) を確実に断つため、最初に下ろす。

### spec と既存コードの食い違い・曖昧な箇所

13. **「このタブで録画が走っている」旗 (`capturing`) は、state/changed が運ぶ状態で立てる。** spec §4.1 は「`seeking` を受けて
    `prepareRecording` に入ってから、`ready` / `preview` / `failed` の応答か state/changed を受けるか、結末を送り終えるまで」。
    router は state/changed を**録画対象のタブ (`captureTabId`) にしか同報しない** (router.ts 188-197 行) ので、state/changed が
    届いたタブは録画対象で、届いた状態が busy (`seeking` / `recording` / `encoding`) の間はこのタブで録画が走っている。そこで
    **state/changed を受けるたびに `capturing = BUSY_KINDS.has(state.kind)`** とする (seeking だけで立てると、seeking を経ずに
    recording を流す既存の単体テストの形で旗が立たない。実機では必ず seeking が先に届くので結果は同じ)。下ろすのは
    state/changed (busy でない)・`cancelForSwitch` の応答 (busy でない)・`notifyOutcome` の送り終わり。**`send()` の応答や
    `content/loaded` の応答では立てない・下ろさない**: 応答は録画していないタブにも返る (spec §4.1 の「状態機械の busy では
    決めない」)。
14. **`onStopDeferred` は driver が「待つたびに 1 回」呼び、youtube.ts は `lastKind` が `seeking` / `recording` のときだけ中止を
    送る。** `reconcile()` は state/changed のたびに呼ばれるので、driver は待ちに入ったときに 1 回だけ知らせ (`deferred` の旗)、
    stop した・オンに戻ったら旗を下ろす。`encoding` では何も送らない (書き出しの結末を待つ)。中止が router で拒まれた
    (`encoding` へ進んでいた) ときは応答が busy なので旗は下りず、結末 (`recorder/done`) を待つ。
15. **youtube.ts と x.ts は `start` / `stop` を export する** (テストのため。spec §テスト「`start()` の二重呼び出しが throw」と
    x.ts の「`start()` で `/compose/` なら送る」を確かめる口)。呼ぶのは driver だけで、doc にそう書く。crxjs の content script の
    入口が export を持っても動作は変わらない (x.ts は既に関数を export している)。
16. **driver の変数名 `driver` は Task 8 まで作らない。** Task 7 では `createSwitchDriver({ start, stop });` と戻り値を捨てる
    (`tsconfig` の `noUnusedLocals` は使わないモジュールの `const` を咎める)。Task 8 で `reconcile()` を呼ぶところができてから
    `const driver = createSwitchDriver({ ... })` にする。x.ts は戻り値を使わないので最後まで捨てる。
17. **既存の単体テストの stub を 2 ファイルで直す。** `chrome.storage.local.get` が鍵を見ずに `windowLayout` を返し、しかも読み込み時の
    1 回を `layoutGate` で止めている (`tests/content/youtube.test.ts` 381-385 行、`tests/content/youtube-dock-load.test.ts` 141-144 行)。
    このままではスイッチの読み (`get("enabled")`) も門で止まり、start が走らないまま「読み込む前は窓を出さない」を確かめる箇所で
    窓そのものが無くなる。**鍵が `"enabled"` なら門を通さずに返す**ように直す。youtube.test.ts は加えて、`storageListener` (1 本しか
    覚えない) を配列に、`onMessage` に `removeListener` を、`onChanged` に `removeListener` を足し、`beforeAll` で import の後に
    マイクロタスクを流して start を待つ (stub の応答は `setTimeout` の後なので「応答が返る前の画面」は今までどおり測れる)。
18. **オフのまま読み込んだ content script の単体テストを別ファイル `tests/content/youtube-off-load.test.ts` に足す。** spec §8 の
    「オフのまま動画ページを開いても 0 個」の単体版で、spec の「テスト」節には無いが §2.1 の「オフなら何も呼ばない」を直接測る
    (要素 0・listener を張らない・observer を張らない・rAF を張らない・何も送らない・storage の見張りは 1 本)。youtube.ts は import した
    時点でスイッチを読むので、オンで読ませる youtube.test.ts とは別のファイルにする (vitest はファイルごとにモジュールを読み直す)。
19. **E2E の項目は既存の「IN を指定すると…」の中に足さず、別の `test` にして前提を自分で作る。** spec §テストは「既存の…の後に、
    同じタブでオフ → オンを測る」「popup の項目も同じテストの中で」だが、運用前提「E2E の各項目は前提の状態を自分で作り、前の項目の
    終わり方に依存しない」(C1 の実機で踏んだ) を優先する。各項目は先頭で `enabled` と `windowLayout` を書いて前提を作り、`finally` で
    オンに戻す。**「別の動画へ移動」は同じ動画に `&t=3s` を付けた `page.goto`** にする (content script が読み込み直される点は同じ。
    別の実在の動画を足すと、広告や公開状態への依存が増える)。オンに戻したときに IN の範囲が戻ることは、同じ videoId なので測れる。
20. **E2E の「動かした窓の位置と枠の記憶が残る」は、`windowLayout` を書いて作った配置で測る** (区間・テロップの窓を浮かせて
    (200, 150) に置き、バーは下の枠)。ドラッグで配置を作る経路は `npm run check:telop` の「ドック: …」の項目が実機で確かめている。
    ここで見るのはオフ → オンで覚えた配置が残ることだけ。
21. **E2E の「コンソールに `[yt-clip]` を含む行が新しく出ない」は、ページの `console` イベントのうち、文言に `[yt-clip]` を含むか
    出どころ (`location().url`) が拡張 (`chrome-extension://<id>/`) のものを数える。** content script の出力には `[yt-clip]` を
    付けていないもの (「状態を取得できませんでした」など) もあるため、出どころでも拾う。Playwright が content script の隔離された
    world の出力を `console` イベントに載せない場合、この確認は空振りする (テストのコメントにも書く。判断メモ 35)。そのため Task 10 (controller) で DevTools のコンソールを
    目で見る項目を manual-check に置く。
22. **E2E の service worker の数える listener は、読むときに消えていたら落とす。** service worker は止まりうる (MV3) ので、
    `globalThis` に置いた数える配列が無ければ「止まって数え直しになった」と throw する (0 件と区別する。spec の未確定事項)。
23. **バッジは `applyBadge(enabled, action = chrome.action)` と `syncBadge(action = chrome.action)`。** `action` の型は自前の最小の型
    `BadgeAction` (使う 3 つのメソッドの Promise 版) にする。`chrome.action` の型は callback 版との overload で、テストの偽物を
    `Pick<typeof chrome.action, …>` に合わせにくい。オンでは `setBadgeText({ text: "" })` だけを呼ぶ (色は出ていないバッジには効かない)。
    sw.ts は起動時 (モジュールの先頭の評価)・`onStartup`・`onInstalled`・`watchEnabled` で当て、失敗は `console.error` に残す
    (バッジは拡張の動作に関わらない)。listener はモジュールの最初の評価で同期に張る (MV3 で起こされたイベントを取りこぼさない)。
24. **popup のスイッチは HTML で最初から `checked`** (既定 = オン)。読み終えるまでの一瞬に「オフ」に見えるちらつきを避ける。
    `disabled` はどこにも付けない (spec §6.1)。popup はテーマに合わせない (今も明るい配色だけ) ので、manual-check の「ダーク・ライトで
    popup が読める」は「OS がどちらのテーマでも読める」の意味で書く。
25. **README の制約は「仕様と制約」に節「### オン / オフ」を足して書く** (「操作の置き場所」の後)。spec §ドキュメントは「制約として」の
    置き場所を決めていない。「操作の置き場所」は窓の置き方の箇条で埋まっているので、別の節にまとめる。使い方の段落は「使い方」の
    末尾 (「投稿ボタンは自動では押さない。」の段落の後) に置く。
26. **`docs/privacy-policy.md` の「最終更新」は実装した日の JST** (`TZ=Asia/Tokyo date +%F`)。plan を書いた 2026-09-25 (JST) と同じ日なら
    値は変わらない。
27. **router と状態機械 (`src/background/router.ts` / `state.ts`) は触らない** (spec §4.2)。片付けた後の同報の失敗
    (`Receiving end does not exist`) は router が `console.error` に残すだけで止まらない。受け入れる。
28. **`beginRecording` の「始まった録画をオフの後に捨てる」経路には単体テストを足さない。** `startRecording` が stop の後に resolve する
    順序は、stub の `MediaRecorder` では作れない (マイクロタスクで resolve する)。コードの guard (Task 8) と whole-branch review の
    攻撃者視点で見る。
29. **commit の step はすべてファイルを名指しで `git add` する** (`git add -A` / `git add .` を使わない)。
30. **HEAD の表記と「完了後」の diff の基点は bb0bd30** (C2 の最後の commit。spec の commit 97c55d9 はドキュメントだけ)。

### plan レビュー (`.claude/sdd/master-switch/plan-review.md`) の反映

31. **`advanceToSegment()` を非同期の続きの棚卸しに足す** (Issue 1)。複数区間の継ぎ目でオフにすると、中止の応答で stop した後に
    seek が済み、オフのページで `video.play()` が走り `waitForFreshFrame` が rVFC を張る (今の `handle !== recorder` の確かめは
    その後)。seek が時間切れなら catch が `FAIL seek-failed` を送る。先頭で `runId` を取り、`await seekTo` の後・`await startPlayback`
    の後・catch の先頭に `isCurrentRun` の guard を置く (Task 8 Step 5)。単体テストは「複数区間の録画」の作法で 1 件足す
    (Task 8 Step 1。**オフを 1 区間目の終わりより先に押す**: stub の応答と seek の完了はどちらも `setTimeout` で、先に積んだ方が先に
    届く。オフを先に押すと、中止の応答 → stop → seek の完了、の順になり、guard の効きを測れる)
32. **Task 2 の期待件数は 11 件** (Issue 2。`test.each` の 4 件を数え漏らしていた)。**Task 1 Step 8 の grep は `ボタンが 1 つも無い\|ボタンは 1 つも無い`** (角括弧の文字クラスは LANG=C で多バイト文字に当たらないので 2 つに分けた)
    (Issue 3。置き換え後の manual-check の文言は「ボタンは 1 つも無い」)
33. **`cancelForSwitch()` の応答にも guard を置く** (Recommendation)。`runId` の guard だけでは足りない: オフを待っている間にオンへ
    戻すと stop も start も走らず `runId` は変わらないまま、新しい録画が始まった後に古い中止の応答 (busy でない) が届くと、新しい録画の
    `capturing` を下ろしてしまう (次のオフでその場で片付き、service worker が `recording` で固まる)。そこで state/changed を受けた数
    `stateSeq` を持ち、中止を送った後に新しい state/changed が届いていて、それが `capturing` を立てていれば (新しい状態が正) 応答を
    捨てる。state/changed (ready) が先に届いた普通の経路では `capturing` は既に下りているので、捨てても結果は同じ
34. **2 つの新しい describe (Task 7 Step 2・Task 8 Step 1) は `beforeEach` で 3 つの窓を最初の配置へ戻す** (Recommendation)。直前の
    describe「ドック枠とタブ」の終わり方 (枠の中身・`getBoundingClientRect` の mock) に依存しない。jsdom では差す先の幅が 0 なので
    枠は使えず、3 つとも浮いた窓 (退避) で出る。「フロートの窓」describe と同じ作法
35. **E2E の `extensionLogs` は空振りしうる旨をテストのコメントに書く** (Recommendation。判断メモ 21)。`stop()` の `abortRecording()` が
    録画の解放の reject で warn を 1 行出しうる件は、`canStop` で録画中は stop しない前提なので実機ではまず起きない。コードは変えず、
    「完了後」の攻撃者視点の入力に「録画の解放が reject する」を足す (Recommendation)

## Global Constraints

### Spec 由来 (spec から逐語コピー)

spec 19〜318 行目 (§1〜§8)。見出しの行は太字に直した。§7 の表の `src/content/dock.ts` の行は判断メモ 10、§2.2 の表の
「今は無名関数なので」は判断メモ 5 で読み替える。

**1. 「一切影響を与えない」の定義**

オフの間、YouTube と X のページについて次を**すべて**満たす状態を「影響を与えない」と呼ぶ。受け入れ条件 (§8) は
この表の左列を測る。

| 測るもの | オフのとき | 今 (オン) |
|---|---|---|
| 拡張が足した要素 | **0 個** (`[id^="yt-clip-"]` と `[data-role^="dock-"]` が 0。body 直下の 3 つの窓・ドック枠 2 つ・シークバーの帯 `#yt-clip-overlay`・プレイヤーの上の canvas `#yt-clip-telop-preview` を含む) | 3 つの窓 + 枠 2 つ + 帯 + canvas |
| YouTube / X の要素への変更 | **無し** (`.ytp-progress-bar` の中・`video` の親・`#below`・`#secondary-inner` に何も足さない。inline style も触らない) | 帯を `.ytp-progress-bar` に、canvas を `video` の親に、枠を `#below` / `#secondary-inner` に差す |
| `document` / `window` / `video` への listener | **0 本** (`fullscreenchange`・`resize`・`seeked`・`visibilitychange`・pointer 系) | 有り |
| `MutationObserver` / `ResizeObserver` | **0 個** | body の監視・テーマの監視・プレイヤーの大きさ・canvas の追従 |
| `requestAnimationFrame` / `requestVideoFrameCallback` のループ | **0 本** (再生位置の追従・プレビューの描き直し・OUT の監視) | 有り |
| `video.captureStream()` / `MediaRecorder` / `video.pause()` / `currentTime` の書き換え | **無し** | 録画と操作のとき |
| `chrome.runtime.onMessage` の listener (content 側) | **無し** (service worker から見て「受け手が居ない」= タブが無いのと同じ。§4.2) | 有り |
| service worker へ送るメッセージ (`content/loaded`・`x/ready` など) | **0 件** (例外: オフにした瞬間に走っていたものの結末だけ — 録画対象タブの `CANCEL_RECORDING` / `recorder/done` (§4.1) と、X で進行中だった添付の結果 `x/attached` / `x/failed` 1 件 (§5)。どれも片付けの前に送り終える) | 有り |
| コンソールへの出力 | **0 行** (例外: 保存した値が読めなかったときの warn 1 行。§3) | 状況に応じて |

**残るもの (ページからは見えない)**: content script のモジュールの評価 (crxjs の loader 343 バイト + 本体 youtube 58 KB /
x 3 KB。`document_idle` なので読み込みを遅らせない)、`chrome.storage.local.get` 1 回、`chrome.storage.onChanged` の
listener 1 本。これらは拡張の隔離された world の中で完結し、ページの DOM・イベント・スクリプトに触れない。
**「一切」はこの境界で線を引く** (根拠は §2 と「検討した選択肢」)。

**2. 方式: content script は常に読み込み、オフでは何もしない (案 a)**

**2.1 入口**

- **content script の `import` 時にページへ触る副作用を持たない。** 今の `youtube.ts` は import した時点で 3 つの窓を作り
  (`createFloatingWindow` が `window` の `resize` を張る)、`MutationObserver` 2 つと `ResizeObserver` を張り、`mount()` を
  呼ぶ。C2 の `dockManager` も import 時に作られる。これらを **`start()` の中へ移す**。import 時に残してよいのは、DOM を
  作らない定数と関数の定義だけ
- 入口は次の順: `loadEnabled()` (§3) → オンなら `start()`。**オフなら何も呼ばない**。以後は `chrome.storage.onChanged`
  (`local` の `enabled`) を見て、変わったら `start()` / `stop()` を呼ぶ
- この「読む → 見張る → start / stop を合わせる」は youtube.ts と x.ts で同じなので、1 つのモジュールに置く
  (`src/content/switch-driver.ts`)。**望んでいる状態 (`desired`) と走っている状態 (`running`) を別に持ち、`reconcile()` で
  合わせる。** 最初の読みが返る前に `onChanged` が来ても、最後に読んだ値だけが効く
  ```typescript
  export type SwitchDriver = {
    /** desired と running を比べ、違えば start / stop を呼ぶ。stop は canStop() が真のときだけ */
    reconcile(): void;
    destroy(): void;
  };
  export function createSwitchDriver(hooks: {
    start(): void;
    stop(): void;
    /**
     * 今 stop してよいか。偽なら stop を待つ。省くと常に真。
     * youtube.ts は**このタブで録画の準備・録画・書き出しが走っている間**だけ偽 (§4.1)。状態機械の busy ではない
     */
    canStop?(): boolean;
    /** stop を待たされた (canStop が偽)。youtube.ts はここで中止を送る (§4.1)。待つたびに 1 回 */
    onStopDeferred?(): void;
  }): SwitchDriver;
  ```
  `reconcile()` は driver が最初の読みと `onChanged` で自分で呼ぶほか、**呼び出し側が「stop してよくなった」ときにも呼ぶ**
  (youtube.ts は `state/changed` を処理し終えた末尾と、中止の応答・書き出しの結果を送り終えたときに呼ぶ。§4.1)
- **`start()` を二度呼ぶ・`stop()` を走っていないときに呼ぶのは配線の誤りなので `throw`** (Fail Fast)。同じ値の
  `onChanged` (オン → オン) は driver が `desired` と `running` の比較で吸収する

**2.2 オンのときにページへ触っているものの棚卸しと、片付け方**

`stop()` が戻すものを、モジュールごとに列挙する。**この表が §1 の左列を保証する根拠**であり、実装の plan はここから
片付けの漏れを探す。

| どこ | 何を | 片付け方 |
|---|---|---|
| youtube.ts | 3 つの窓 (`#yt-clip-bar-window` / `#yt-clip-list` / `#yt-clip-settings`。body 直下) | `FloatingWindow.destroy()` (要素を外し、自分の `resize` listener を解く) |
| youtube.ts (C2) | ドック枠 `#yt-clip-dock-below` / `#yt-clip-dock-side` (`#below` / `#secondary-inner` の先頭) と、落とし先の目印 | `dockManager.destroy()` (枠の根を外す。中の窓ごと外れるので、**窓の `destroy()` より先に呼ぶ**) |
| youtube.ts | シークバーの帯 `#yt-clip-overlay` (`.ytp-progress-bar` の中) | `clearOverlay()` |
| telop-preview.ts | canvas `#yt-clip-telop-preview` (`video` の親の中)、`video` の `seeked`、rVFC、`ResizeObserver` | `telopPreview.destroy()` (今の `detach`) |
| youtube.ts | `MutationObserver` 2 つ (body の子孫、`<html dark>`)、`ResizeObserver` (プレイヤー) | `disconnect()` |
| youtube.ts | `document` の `fullscreenchange`、`window` の `resize` | `removeEventListener` (今は無名関数なので、名前を付ける) |
| youtube.ts | 再生位置の追従の rAF ループ (`watchPlayhead`) | **今は止める口が無い。** handle を持ち `cancelAnimationFrame` で止める |
| range-bar.ts / telop-track.ts | 拡大バーと帯の段 (要素・rAF の間引き・pointer の listener) | `destroy()` (バーの窓の中身なので、窓と一緒に外れるが、rAF と捕捉のために呼ぶ) |
| youtube.ts | 範囲再生の監視 (`onReachTime` の rVFC)、録画の監視、走っている録画 | `cancelPreviewWatch()`・`cancelWatch()`・`abortRecording()` (busy でない前提。§4.1) |
| youtube.ts | `chrome.runtime.onMessage` の listener、`chrome.storage.onChanged` の listener (設定の `sync`) | `removeListener` (どちらも名前を付ける)。**スイッチを見張る listener だけは残す** (driver が持つ) |
| youtube.ts | モジュールの状態 (`currentSegments` / `currentTelops` / `selectedIndex` / `rangeVideoId` / `busy` / `lastKind` / `pendingMode` / `layoutReady` / `floatLayout` / `settingsPanel` / `rangeBar` / `telopTrack` / `segmentList` / `telopList` / `playheadWatched` / `observedPlayer` / `handle` / `recordingTelops` / `lastHref` など) | 最初の値に戻す。**状態機械が正で、これは写し**なので、戻しても失うものは無い (次の `start()` の `content/loaded` で取り戻す) |
| x.ts | `chrome.runtime.onMessage` の listener | `removeListener`。進行中の添付 (`attachPayload`) は**完了させる** (§5) |

- 覚えた配置 (`chrome.storage.local` の `windowLayout`) と設定 (`sync` の `settings`) は**消さない**。オフ → オンで窓は
  前と同じ位置・同じ枠に出る
- テーマの配色 (`--ytc-*`) は自分の要素の inline style なので、要素と一緒に消える。YouTube の要素には当てていない

**2.3 `stop()` の順序**

1. `cancelPreviewWatch()`・`cancelWatch()`・`abortRecording()` (このタブで録画が走っていないことは driver の `canStop` が保証する。§4.1。ここで止めるのは範囲再生の監視だけのはず)
2. `chrome.runtime.onMessage` と設定の `chrome.storage.onChanged` の listener を外す (**先に外す**。以後の通知で
   片付けた要素を触りに行かない)
3. `MutationObserver` 2 つと `ResizeObserver` を `disconnect()`、`fullscreenchange` / `resize` を外す、rAF を止める
4. `telopPreview.destroy()`、`clearOverlay()`
5. `dockManager.destroy()` → `rangeBar.destroy()`・`telopTrack.destroy()` → 3 つの窓の `destroy()`
6. モジュールの状態を最初の値に戻す

`start()` はこの逆で、今の import 時の処理 (窓とドック枠と observer を作る → `mount()` → `loadInitialSettings()` →
`loadInitialLayout()` → `recoverFromState()`) をそのまま行う。

**2.4 オンに戻すとき (読み込み直しは要らない)**

- 開いているタブでオンにすると、その場で `start()` が走り、**読み込み直さずに**窓と枠が出る。`recoverFromState()` が
  `content/loaded` を送り、応答の状態で範囲・帯・一覧を取り戻す (タブのリロードと同じ経路。router から見て
  「content script が読み込まれた」と同じ意味なので、メッセージは足さない)
- 覚えた配置の読み込みが済むまで窓を出さない (フロートの窓の spec A.2) のは `start()` の中でも同じ
- 案 (b) (§検討した選択肢) ではオフの間 content script が無いので、オンにしても既に開いているタブには何も出ず、
  読み込み直しを促す文言か `executeScript` が要る。**読み込み直し不要は案 (a) を採る理由の 1 つ**

**3. 保存: `chrome.storage.local` の `enabled`**

- **`chrome.storage.local`、キー `enabled`、値は `boolean`。** 既定は**オン** (キーが無い = `true`)
- **`sync` の `settings` には入れない。** 理由は 2 つ:
  1. **端末ごとの操作である。** 「いま、この端末で止めたい」の操作が同期で別の端末へ届くと、向こうでは拡張が黙って消える
     (窓の位置を `local` にしたのと同じ理由。フロートの窓の spec A.2)
  2. `settings` の保存は組ごとの読み書き (`saveSettings` は読んで `{ ...current, ...patch }` を書く) なので、設定パネルの
     保存と popup のスイッチが同時に走ると片方が消える。別のキーなら互いに触らない
- **`settings` の項目 (`SETTINGS_FIELDS`) にも出さない。** 設定パネルはページの中にあり、オフのときは消えている。
  オンに戻す場所は popup だけ
- 読み方は既存の作法に合わせる (`mergeSettings` / `mergeWindowLayout`):
  - `readEnabled(stored: unknown): boolean` (純粋関数): `undefined` → `true`、`boolean` → その値、それ以外 → `console.warn`
    して `true`
  - `loadEnabled(): Promise<boolean>`: `chrome.storage.local.get` が reject しても **reject しない**。warn を残して `true`
    (局所例外。`loadWindowLayout` と同じ: 読めないときに拡張が黙って消えるより、今までどおり出る方がよい。
    オフにしたかった人は popup で分かる)
  - `saveEnabled(value: boolean): Promise<void>`: 失敗は**握り潰さず reject** (popup が理由を出して表示を戻す。§6)
  - `watchEnabled(onChange: (enabled: boolean) => void): () => void`: `chrome.storage.onChanged` のうち `areaName === "local"`
    かつ `changes.enabled` だけを拾う (`windowLayout` の書き込みでは呼ばない)
- 置き場所は `src/shared/master-switch.ts` (popup・content・service worker の 3 つが読む)
- 同じ端末で YouTube のタブを複数開いていれば、**すべてのタブが同時に切り替わる** (それぞれが `onChanged` を受ける)

**4. 切り替えたときの振る舞い**

**4.1 録画中・書き出し中・投稿の途中でオフにしたとき**

- **スイッチはどの状態でも押せる。** 依頼は「全機能の on / off」で、録画中だけ切り替えられない例外は依頼に無い。
  拡張が固まりうる状態 (router が `OUT_REACHED` / `recorder/done` を待つ `recording` / `encoding`) でこそ止められることが
  スイッチの価値 (§6.1)。押した瞬間に `enabled: false` が書かれ、録画対象タブの content script が次のように**自分で
  片付けの条件を作る**:
  - `seeking` / `recording` (このタブで録画の準備か録画が走っている): **`CANCEL_RECORDING` を送る** (バーの「■ 中止」と
    同じ。区間とテロップは残り、`ready` に戻る)。片付けはその応答 (`send` の応答に載る状態が busy でない) か、
    `state/changed` (`ready`) を処理した後に走る (driver の `canStop` が真になり、`reconcile()` で `stop()`)。
    `prepareRecording` の seek が途中でも、`SEEK_DONE` は router が `seeking` でないとして無視する
  - `encoding` (このタブで書き出しが走っている): **書き出しが終わるまで待つ**。ここで `abortRecording()` すると
    `recorder/done` が送られず、service worker が `encoding` で固まる (router は `recorder/done` / `recorder/failed` /
    タブの消失 / `content/loaded` でしか抜けない。オフの content script は `content/loaded` を送らないので、抜け道が
    1 つ減る)。書き出しは数秒で `recorder/done` (送れなければ `FAIL`) を送り終え、その時点で片付ける (`state/changed`
    (`preview` / `failed`) を待たない: service worker が応答を返さないときに永久に待たないため)
  - どちらも `pendingMode` と同じ「落ち着いたら適用する」作法。**録画済みのクリップは失わない** (`seeking` / `recording` の
    間はまだ無く、`encoding` は待つ)。待つのは長くて書き出し数秒 + メッセージ 1 往復
- **`canStop` はこのタブの録画で決め、状態機械の busy では決めない。** `busy` (`youtube.ts` の
  `BUSY_KINDS.has(state.kind)`) は応答で受け取った写しで、録画していない別の YouTube タブでも真になりうる。
  そのタブは `state/changed` を受け取らない (router は録画対象タブにしか同報しない) ので、busy で待つと永久に片付かない。
  録画していないタブは**その場で片付ける** (`CANCEL_RECORDING` も送らない)。「このタブで走っている」は、`seeking` を受けて
  `prepareRecording` に入ってから、`ready` / `preview` / `failed` の応答か `state/changed` を受けるか、`recorder/done` /
  `recorder/failed` / `FAIL` を送り終えるまで、の 1 つの旗で持つ (`handle` だけでは `prepareRecording` の seek 中を拾えない)
- 待っている間の見え方: popup はスイッチをオフの見た目 (`checked` 偽) にし、状態に応じて
  「オフにします。録画を中止しています…」(`seeking` / `recording`) か「オフにします。書き出しが済んだら止まります…」
  (`encoding`) を出す (§6.1)。ページのバーは、片付くまで今までどおり (「■ 中止」を押した後と同じ「録画を書き出しています…」
  など)。片付いた瞬間に消える
- **`preview` / `posted` / `degraded` / `ready` / `failed` / `idle` ではその場で片付ける。** 状態機械の状態とクリップ
  (IndexedDB) は**そのまま残す**。オンに戻すと `content/loaded` の応答で同じ状態に戻り、「X に投稿」「もう一度」が
  そのまま押せる
- **オンへ戻す操作も状態に関わらず常に押せる** (§6.1)。オフ + busy (`encoding` を待つ間に対象タブを読み込み直した、
  など) で戻せなくなる状態を作らない
- **`composing` でオフにしたとき**: X 側の content script も止まる (§5) ので添付は進まない。router の投稿待ちの上限
  (`COMPOSE_READY_TIMEOUT_MS` = 30 秒) で `degraded` (`x-attach-failed`) に落ち、**クリップは残る**。オンに戻せば
  「X にもう一度投稿」でやり直せる。service worker が止まっていて時間切れが来ない (タイマーは service worker と一緒に
  消える) こともあり、そのときはオンに戻したバーに `composing` の「取り直す」が出る (今ある抜け道)。文言は「30 秒ほどで」と
  書き、「必ず落ちる」とは書かない

**4.2 service worker と状態機械は変えない (オフ ≒ タブが無い)**

- **router と状態機械はスイッチを知らない。** オフの間 content script は何も送らず、`onMessage` の listener も無いので、
  service worker から見ると「YouTube のタブが 1 つも無い」のと同じ。既にその場合の扱い (`tab-lost` / `unreachable` /
  `content/loaded` での復帰) を持っている
- 片付けた後に router が `captureTabId` へ同報して失敗する (`Receiving end does not exist`) のは、§4.1 で中止の応答を
  待たずに片付けた直後の `state/changed` と、`composing` の時間切れ (`DEGRADE`) のとき。router は同報の失敗を
  `console.error` に残すだけで止まらない (`publish` は待たない)。受け入れる
- service worker がスイッチを読むのは**ツールバーのバッジのためだけ** (§6.2)

**5. X の投稿画面 (`x.ts`)**

- youtube.ts と同じ driver で `start()` / `stop()` を持つ。`start()` = `chrome.runtime.onMessage` の listener を張り、
  `/compose/` なら `x/ready` を送る。`stop()` = listener を外す
- **import 時には何もしない** (今は `x/ready` を import 時に送っている)。オフの間は `x/ready` も送らない: router が
  `composing` で待っていても添付は始まらず、30 秒で `degraded` に落ちる (§4.1)。**オフなのに X の投稿画面に本文と動画が
  入る**方がスイッチの意味に反する
- 進行中の `attachPayload` (本文の paste と添付) は**止めない**。途中でやめると半端な本文が投稿欄に残る。上限は
  要素待ち 10 秒 × 2 + paste の描画待ち 2 秒 × 2 で、有限。終わったら `x/attached` / `x/failed` を送ってよい
  (router は `composing` でなければ拒む)
- オンに戻したときに `/compose/` を開いたままなら `x/ready` を送り直す。router の `sendPayload` は `composing` でないか
  `payloadSent` なら無視する (二重送信の保護は今のまま)
- x.ts は X のページの DOM に**何も足さない** (payload が来たときに入力欄へ paste と `input.files` を入れるだけ)。
  オフの間はそれも起きないので、§1 の「要素 0」は X でも満たす

**6. popup とツールバーのアイコン**

**6.1 popup**

```
[●] yt-clip を使う                       ← <input type="checkbox" role="switch" id="enabled">
    この端末だけに効く (同期しない)
──────────────────────────────
YouTube の再生画面で IN を押してください   ← オンのとき: 今の文言と進捗バー (変えない)
```

オフ:

```
[○] yt-clip を使う
    この端末だけに効く (同期しない)
──────────────────────────────
オフです。YouTube と X のページには何も出ません
録画したクリップは残っています (オンに戻すと続きから)   ← preview / posted / degraded のときだけ
```

オフにした直後、録画対象タブが片付けを待っている間 (`seeking` / `recording` → `encoding` の順に読む):

```
[○] yt-clip を使う
    この端末だけに効く (同期しない)
──────────────────────────────
オフにします。録画を中止しています…            ← seeking / recording
オフにします。書き出しが済んだら止まります…     ← encoding
```

- **スイッチは popup の最上段。どの状態でも押せる (`disabled` は使わない)。** 押した瞬間に `saveEnabled(checked)`。
  **書けなかったら理由を出し、チェックを保存されている値に戻す** (書けたつもりにしない)。`onChanged` は自分の書き込みでも
  発火するので、表示の確定はそれで行う (別の場所 (DevTools・別の popup) で変えたときも同じ経路で追従する)
- **オンへ戻す操作は状態に関わらず常に押せる。** オンに戻す場所は popup だけ (§3) なので、popup が拒む状態が 1 つでも
  あれば拡張を戻せなくなる (オフ + busy は §4.1 の経路で作れる)
- **スイッチは service worker が居なくても動く** (`chrome.storage` へ直接書く)。状態を取得できなかったとき
  (「状態を取得できませんでした: …」) もスイッチは出す。壊れたときに止められる、がスイッチの価値
- オフの間は状態の文言と進捗バーを出さない (状態機械は状態を持ち続けているが、「録画できました」と出ていてもページには
  何も無い。誤解を招く)。代わりに、録画済みのクリップを抱えた状態 (`preview` / `posted` / `degraded`) では「録画したクリップは
  残っています」を添える (オフにした人が成果物を失ったと誤解しない)。状態は `state/get` と `state/changed` で取り続ける
  (待っている間の文言とこの 1 行に要る)
- 見た目の決め方は純粋関数にする: `describeSwitch(enabled, state): { checked, hint, showState, note }` を
  `src/popup/view.ts` に足す (`checked` = `enabled`、`hint` = 端末の注意か待っている間の文言、`showState` = `enabled`、
  `note` = オフでクリップを抱えているときの 1 行)。`describeState` は変えない
- **popup は「操作を持たない」を 1 つだけ破る。** ページ内操作の spec (`2026-09-12-in-page-controls-design.md`) で popup を
  状態の表示だけにしたのは「操作はページの中で完結させる」ため。オフに**する**操作はページの中に置けても、オンに**戻す**
  操作はページに何も無いときに要るので、ページの外にしか置けない。README と manual-check の「popup にボタンが 1 つも無い」は
  「スイッチ以外の操作が無い」に改める (E2E の `getByRole("button")` が 0 個の確認は checkbox に当たらないのでそのまま)

**6.2 ツールバーのアイコン: オフでバッジ「OFF」**

- オフの間、アイコンに**バッジ `OFF`** (地は灰色 `#606060`、文字は白) を出す。オンでは空文字 (バッジ無し)。
  `chrome.action.setBadgeText` / `setBadgeBackgroundColor` / `setBadgeTextColor` は `action` を持つ拡張なら**権限なしで使える**
- **持ち主は service worker** (`src/background/badge.ts`)。`sw.ts` の先頭 (service worker が起きるたび) と
  `chrome.runtime.onStartup` / `onInstalled` で `syncBadge()` (読んで当てる)、`watchEnabled` で変わるたびに当て直す。
  popup が押したときに popup 自身が当てる案は採らない: 持ち主を 1 つにし、DevTools で書いたときも追従させる
- アイコンの絵を灰色に差し替える案は採らない: 4 つの大きさの画像を足して `scripts/make-icons.mjs` を直す手間に対して、
  バッジで同じことが伝わる。可逆

**7. 作り**

| ファイル | 変更 |
|---|---|
| `src/shared/master-switch.ts` | **新規**。`MASTER_SWITCH_KEY` (`"enabled"`)、`readEnabled` (純粋)、`loadEnabled`、`saveEnabled`、`watchEnabled` (§3) |
| `src/content/switch-driver.ts` | **新規**。`createSwitchDriver` (§2.1)。`chrome.storage` にだけ触る (DOM に触らない) |
| `src/content/youtube.ts` | import 時の副作用を `start()` に移し、`stop()` を足す (§2.2 / §2.3)。無名の listener に名前を付ける。`watchPlayhead` に止める口。`state/changed` の末尾と中止の応答・書き出しの結果を送り終えたときに `driver.reconcile()`。このタブで録画が走っている間の旗と `canStop` / `onStopDeferred` (§4.1) |
| `src/content/x.ts` | import 時の副作用を `start()` に移し、`stop()` を足す (§5) |
| `src/content/dock.ts` (C2) | `destroy()` が 2 つの枠の根と目印を外すことを確かめる (C2 の plan で `destroy()` は既にある) |
| `src/popup/popup.html` / `popup.ts` / `view.ts` | スイッチ・文言・`describeSwitch` (§6.1) |
| `src/background/badge.ts` | **新規**。`applyBadge(enabled, action = chrome.action)`、`syncBadge()` (§6.2) |
| `src/background/sw.ts` | 起動時と `onStartup` / `onInstalled` / `watchEnabled` でバッジを当てる。router は触らない |
| `manifest.config.ts` | **変えない** (権限を足さない) |

**8. 受け入れ条件**

E2E (`e2e/smoke.spec.ts`。録画しないので `npm run e2e` に入れる) と、`npm run check:telop` の実機で測る。オン / オフの書き込みは
拡張の service worker の文脈から `chrome.storage.local.set({ enabled })` で行う (popup の操作の確認は別項)。

- **オフにした開いているタブで、1 秒以内に拡張の要素が 0 個になる**: 動画ページでオン (IN を押して `0:05 〜 0:20 (15秒)`
  が出ている) → オフ → `document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length === 0`。
  `.ytp-progress-bar` の中と `video` の親と `#below` / `#secondary-inner` の先頭にも無い (同じ selector で覆う)。
  ページのコンソールに `[yt-clip]` を含む行が**新しく出ない**
- **オフのまま動画ページを開いても 0 個**: オフの状態で別の動画へ移動 (`page.goto`) → `#below` が現れてから 5 秒待っても
  要素が 0 個
- **オフの間、service worker はタブから 1 件もメッセージを受けない**: service worker の文脈で
  `chrome.runtime.onMessage.addListener` に数える listener を足しておき (`sender.tab` があるものを数える)、上の 2 項目の間
  (10 秒以上) に 0 件。**オン → オフの直前に送った分は数えない** (オフに書き込む前に listener を置き直す)
- **オフの間、YouTube 自身の動作が変わらない**: `video.currentTime` が進む、`k` (キー) で一時停止と再生が切り替わる
  (テロップの入力欄が `keydown` を止めていた経路が無い。拡張自身の要素にしか付いていないので要素 0 個から従うが、
  「動作が変わらない」の代表として測る)、`t` でシアターモードに入って戻れる (`ytd-watch-flexy[theater]`)。
  キー操作を代表に選ぶのは、Playwright で確実に再現できて結果を属性と `paused` で読めるため。シークバーのドラッグ・
  全画面・ミニプレイヤーは E2E では測りにくいので manual-check に置く
- **開いているタブでオンに戻すと、読み込み直さずに戻る**: オフ → オン → 1 秒以内に `#yt-clip-bar` が出て、状態の文言が
  `0:05 〜 0:20 (15秒)` (状態機械の範囲が戻る)。`page.reload()` は呼ばない (呼んだら測れない)。C2 の最初の配置なら
  バーは `#below` の枠の中に戻る (`#yt-clip-bar-window` の `closest("#yt-clip-dock-below")` が非 null)。**動かした窓の位置と
  枠の記憶が残る**: 区間・テロップの窓を引き出して動かしてからオフ → オン → 同じ位置に浮いて出る
- **popup**: `#enabled` が `checked`。押すと 1 秒以内に YouTube のタブから要素が消え、もう一度押すと戻る。
  `getByRole("button")` は 0 個のまま。オフの間の文言は「オフです。YouTube と X のページには何も出ません」
- **バッジ**: オフで `chrome.action.getBadgeText({})` が `"OFF"`、オンで `""` (service worker の文脈で読む)
- **オフのまま拡張を読み込み直しても** (`chrome.runtime.reload()` 相当は E2E では起動し直しで代える) オフのまま
  (`local` に残る)。バッジも `OFF`
- 単体テストで確かめる (E2E に載せない): 録画中のオフ (§4.1) — 録画対象タブで `recording` のときにオフにすると
  `CANCEL_RECORDING` が送られ、その応答 (`ready`) で片付く / `encoding` でオフにすると `recorder/done` を送り終えてから
  片付く / `preview` でオフにしても `RESET_MARKS` も `FAIL` も送らない / 録画していないタブ (応答で busy を受け取っただけ)
  はその場で片付き、`CANCEL_RECORDING` を送らない / オフ + busy でもオンに戻せる (popup の `describeSwitch` と、
  content script の `start()` が `content/loaded` を送ること)
- 実機 (`docs/manual-check.md` に節を足す): X の投稿画面を開いた状態でオフ → 本文も動画も入らず、30 秒で popup (オンに
  戻した後) とバーが「X への自動添付に失敗しました」になり「X にもう一度投稿」でやり直せる。ログイン済みが要るので自動化しない

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
- commit message は日本語で「なぜ」を書き、末尾に `Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se` を付ける
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 配線の誤り (`start()` を二度呼ぶ・走っていないのに `stop()`) は throw で知らせる。`saveEnabled` の失敗は握り潰さず reject する。
  ※ 局所例外: `readEnabled` / `loadEnabled` は読めない値・読めないときに throw / reject せず、warn してオン (spec §3。
  `loadWindowLayout` と同じ判断: 読めないときに拡張が黙って消えるより、今までどおり出る方がよい)
- テストは `npm test` (vitest)、型は `npm run typecheck` (`tsc --noEmit`。`src` / `tests` / `e2e` を含む)。**各タスクの commit 前に両方を通す**
  (リポジトリの根 `/Users/trapple/repos/github.com/trapple/yt-clip` で `npm run typecheck && npm test`、Bash の timeout 600000)
- コマンドはリポジトリの根で実行する。`npx vitest run <file>` は Bash の timeout 120000 を付ける
- `tsconfig.json` は `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`。配列の添字は `undefined` を確かめてから使う。
  **使わない関数・変数を先に置かない** (`noUnusedLocals` はモジュールの中の関数と `const` も咎める。判断メモ 16)

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch `feat/master-switch` (HEAD 97c55d9。`feat/dockable-windows` の bb0bd30 の上に spec を 1 コミット) にそのまま積む。
  **main には commit しない**
- 並列: SDD (branch + SDD = 方式 D)。1 タスクごとに新しい実装担当 + レビュー。**同じファイルを触るタスクは依存順に 1 つずつ走らせる**
  (`src/content/youtube.ts` と `tests/content/youtube.test.ts` は Task 7・8)。依存は「タスクの依存」の図
- **実装担当は `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない** (実機の Chrome と YouTube を使う)。
  Task 9 (E2E を書く) も `npm run typecheck && npm test` までで止める。E2E の実機確認は最後の controller タスク (Task 10)
- commit message は日本語で「なぜ」、末尾に `Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se`
- **`git add` はファイルを名指しする** (`git add -A` / `git add .` を使わない。判断メモ 29)
- ドキュメント (README / CHANGELOG / docs/manual-check.md / docs/privacy-policy.md / docs/store-release.md) の更新はコードより先 (Task 1)
- **E2E の各項目は前提の状態 (オン / オフ・覚えた窓の配置・設定) を自分で作り、前の項目の終わり方に依存しない** (C1 の実機で踏んだ。判断メモ 19)
- 完了後の whole-branch diff の基点は **bb0bd30** (判断メモ 30)
- 終点: branch `feat/master-switch` 上の commit まで。push / PR はユーザーの指示を待つ

---

## ファイルの構造

| ファイル | 責務 | タスク |
|---|---|---|
| `README.md` / `CHANGELOG.md` / `docs/manual-check.md` / `docs/privacy-policy.md` / `docs/store-release.md` | スイッチの使い方・制約・抜け道・保存するもの・掲載文 | 1 |
| `src/shared/master-switch.ts` (新規) | `MASTER_SWITCH_KEY` / `readEnabled` (純粋) / `loadEnabled` / `saveEnabled` / `watchEnabled`。popup・content・service worker の 3 つが読む | 2 |
| `src/content/switch-driver.ts` (新規) | `createSwitchDriver`: 読む → 見張る → `desired` と `running` を `reconcile()` で合わせる。`chrome.storage` にだけ触る | 3 |
| `src/background/badge.ts` (新規) | `applyBadge` / `syncBadge` / `BadgeAction` | 4 |
| `src/background/sw.ts` | 起動時・`onStartup`・`onInstalled`・`watchEnabled` でバッジを当てる (router は触らない) | 4 |
| `src/popup/view.ts` | `describeSwitch` / `SwitchView` (純粋。`describeState` は変えない) | 5 |
| `src/popup/popup.html` / `src/popup/popup.ts` | スイッチ・端末の注意・保存の失敗・オフの文言・クリップが残る旨 | 5 |
| `src/content/x.ts` | import 時の `x/ready` と listener を `start()` へ、`stop()` で listener を外す (進行中の添付は止めない) | 6 |
| `src/content/youtube.ts` | import 時の副作用を `start()` へ、`stop()` で片付ける、非同期の続きを `runId` で断つ (7)。録画対象タブの旗・`canStop` / `onStopDeferred` / `cancelForSwitch` / `notifyOutcome` (8) | 7・8 |
| `tests/content/youtube-off-load.test.ts` (新規) | オフのまま読み込んだときに何もしない | 7 |
| `tests/content/youtube-dock-load.test.ts` | stub の `local.get` を鍵で分ける (判断メモ 17) | 7 |
| `tests/content/dock.test.ts` | ドラッグ中の destroy の特性テスト (判断メモ 10) | 7 |
| `e2e/smoke.spec.ts` | spec §8 の E2E 4 項目 | 9 |
| `docs/manual-check.md` (「## 確認した環境」)・spec の自律判断ログ | 実機の記録 | 10 |

`manifest.config.ts` は変えない (権限を足さない)。`src/background/router.ts` / `state.ts` は変えない (判断メモ 27)。`src/content/dock.ts` /
`floating-window.ts` / `telop-preview.ts` / `range-bar.ts` / `telop-track.ts` は変えない (既存の `destroy()` を使う。判断メモ 10・11)。
`e2e/telop-check.spec.ts` と `scripts/screenshots.mjs` は変えない (spec §テスト)。

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (master-switch.ts) ──┬→ Task 3 (switch-driver.ts) ──┬→ Task 6 (x.ts)
                            │                               └→ Task 7 (youtube.ts: start / stop) → Task 8 (youtube.ts: 録画中のオフ)
                            ├→ Task 4 (badge.ts / sw.ts)
                            └→ Task 5 (popup)
Task 4・5・6・8 ─→ Task 9 (E2E) ─→ Task 10 (controller: 実機)
```

Task 1 と Task 2 は独立で、並べて走らせてよい。Task 3・4・5 は Task 2 の後で互いに独立。Task 6 と Task 7 は Task 3 の後で互いに独立
(触るファイルが違う)。Task 8 は Task 7 の後 (同じファイル)。

## 既存テストの洗い出し (grep の結果。Task 7・8 の前提)

- `git grep -n 'storageListener' tests/` → `tests/content/youtube.test.ts` 254 (宣言)・259 (`changeSettings`)・398 (stub の `addListener`) → Task 7 で配列にする
- `tests/content/youtube.test.ts` の stub の `local.get` (381-385 行) は鍵を見ずに `layoutGate` を待つ → Task 7 で鍵が `"enabled"` なら門を通さない
- `tests/content/youtube-dock-load.test.ts` の stub の `local.get` (141-144 行) と `onChanged` (149 行。`addListener` だけ) → Task 7 で同じく直し、`removeListener` を足す
- `tests/content/youtube.test.ts` の `beforeAll` (713-763 行) は `await import("@/content/youtube")` の直後に `rangeBarElement()` を読む
  (import 時にバーがある前提) → Task 7 でマイクロタスクを流してから読む
- `tests/content/youtube.test.ts` の `afterAll` (806-826 行) と `tests/content/youtube-dock-load.test.ts` の `afterAll` のコメント
  「youtube.ts の MutationObserver は解除できない」→ 変えない (オフで解除できるようになったが、body の差し替えで終える今の手順のまま通る)
- `tests/content/x.test.ts` は `@/content/x` を静的に import する (jsdom に `chrome` が無いので import 時の副作用は `typeof chrome` の
  ガードで飛ぶ) → 既存の検査は変えない。Task 6 の検査は `vi.resetModules()` の後に動的に import する
- `e2e/smoke.spec.ts` の「IN を指定するとページ内で録画を始められる」の `popup.getByRole("button")` が 0 個 → そのまま通る
  (checkbox の role は `switch` で `button` に当たらない)。コメントだけ Task 9 で直す

---

### Task 1: ドキュメントを先に直す

**Files:**
- Modify: `README.md` (「## 使い方」の末尾 31 行目の後、「### 操作の置き場所」の最初の箇条 166〜168 行目、「## 開発」213 行目の前)
- Modify: `CHANGELOG.md` (「## 未リリース」の最後の段落 44〜47 行目の後)
- Modify: `docs/manual-check.md` (「## popup」402〜409 行目)
- Modify: `docs/privacy-policy.md` (3 行目・17〜22 行目の表・28 行目・43 行目)
- Modify: `docs/store-release.md` (§2 の説明文 88〜96 行目の後、`storage` の説明 133 行目の後、データの取り扱い 155 行目、§7 の 238〜239 行目)

**Interfaces:**
- Consumes: なし
- Produces: なし (文書だけ)

行番号は 97c55d9 の時点。置き換える前の文言はこの plan に全文を載せているので、行番号がずれていたら文言で探す。

- [ ] **Step 1: README の「使い方」の末尾に段落を足す**

`README.md` の次の行 (31 行目)

```markdown
投稿ボタンは自動では押さない。最終確認は必ず手元に残る。
```

の後に、空行を 1 つ挟んで次の段落を足す (次の「## モード」との間の空行はそのまま残す)。

```markdown
**ツールバーの拡張アイコン (popup) のスイッチで、全機能をオフにできる。** オフの間は YouTube と X のページに何も出さず、
何も変えない (この端末だけ。同期しない)。オンに戻すと、開いているタブでもそのまま戻る。アイコンに `OFF` のバッジが出る。
```

- [ ] **Step 2: README の「操作の置き場所」の最初の箇条を直す**

`README.md` の次の箇条 (166〜168 行目)

```markdown
- **操作は YouTube のページ内で完結する**。拡張のポップアップは状態を映す
  だけで、ボタンは持たない。ポップアップを残しているのは、YouTube 以外の
  タブにいるときに状態を見る場所が無くなるため
```

を次に置き換える。

```markdown
- **操作は YouTube のページ内で完結する**。ポップアップが持つ操作はオン / オフのスイッチだけ (ページに何も無いときに
  オンへ戻すため。どの状態でも押せる)。ほかは状態を映すだけで、ボタンは持たない。ポップアップを残しているのは、
  YouTube 以外のタブにいるときに状態を見る場所が無くなるため
```

- [ ] **Step 3: README の「仕様と制約」に節「オン / オフ」を足す**

`README.md` の「### 操作の置き場所」の最後の箇条

```markdown
- **浮いた窓が重なったときは、触った順が新しいほど上に出る** (直前に触った窓が、その前に触った窓の下に潜らない)。
  ⚙ で開いた浮いた設定の窓は前に出る
```

の後、「## 開発」の見出しの前に、空行を挟んで次の節を足す (判断メモ 3・25)。

```markdown
### オン / オフ

- **オフの間は YouTube と X のページに何も出さず、何も変えない**。窓・ドック枠・シークバーの帯・プレイヤーの上のテロップが
  消え、ページのイベントも監視しない。拡張の中に残るのは、オン / オフを読む処理と、変わるのを待つ処理だけ
  (ページからは見えない)
- **オン / オフはこの端末だけに効く** (`chrome.storage.local`。Chrome の同期で他の端末へは運ばない。「いま、この端末で
  止めたい」ための操作なので)。同じ端末で開いている YouTube のタブは、すべて同時に切り替わる
- **オンに戻すと、開いているタブでも読み込み直さずに戻る**。オフにしても、作った区間・録画済みのクリップ・窓の配置・
  設定は消えない
- **録画中にオフにすると録画は中止される** (■ 中止と同じ。区間とテロップは残り、オンに戻すとそのまま録り直せる)
- **書き出し中にオフにすると、書き出しが済んでから消える** (数秒。録れたクリップは残り、オンに戻すとプレビューから続く)
- **X の投稿画面が開いている間にオフにすると、添付は進まず 30 秒ほどで「X にもう一度投稿」に落ちる** (クリップは残る。
  落ちないときはオンに戻したバーの「取り直す」で抜ける)
- **オフにした後も popup に「録画を中止しています…」「書き出しが済んだら止まります…」が出たまま変わらないとき**
  (録画していたタブをその間に読み込み直した、など) は、オンに戻すか、そのタブを閉じると抜ける
```

- [ ] **Step 4: CHANGELOG の「未リリース」に段落を足す**

`CHANGELOG.md` の「## 未リリース」の最後の段落

```markdown
**窓を最初からページの中に入れた (ドック)。** バーはプレイヤーの直下、区間・テロップと設定はおすすめ動画の上に入り、
ページと一緒にスクロールする。同じ場所に入った窓はタブで切り替える。タブを外へ引き出すと浮いた窓になり、プレイヤーの
下かおすすめ動画の上へドラッグして落とすとまた入る。入れた場所とタブの並びは端末ごとに覚え、ダブルクリックで最初の
配置に戻る。
```

の後に、空行を 1 つ挟んで次を足す (「## 1.1.0 - 2026-09-23」の前の空行は残す)。

```markdown
**popup にオン / オフのスイッチを足した。** オフの間は YouTube と X のページに何も出さず、何も変えない。アイコンに OFF の
バッジが出る。オンに戻すと、開いているタブでもそのまま戻る。
```

- [ ] **Step 5: manual-check の「popup」節を直し、節「オン / オフ」を足す**

`docs/manual-check.md` の次の節 (402〜409 行目)

```markdown
## popup

操作はページ内へ移した。popup は状態を映すだけ。

- [ ] popup に**ボタンが 1 つも無い**
- [ ] YouTube 以外のタブ (X の投稿画面など) で popup を開くと、
      いま何が起きているかが読める
- [ ] 録画中は残り時間が数えられる
```

を次に置き換える (「## 全体フロー」の前の空行は残す)。

```markdown
## popup

操作はページ内へ移した。popup が持つ操作はオン / オフのスイッチだけ (ページに何も無いときにオンへ戻すため)。

- [ ] popup に**スイッチ以外の操作が無い** (ボタンは 1 つも無い)
- [ ] YouTube 以外のタブ (X の投稿画面など) で popup を開くと、
      いま何が起きているかが読める
- [ ] 録画中は残り時間が数えられる

## オン / オフ

popup のスイッチ (`.claude/specs/2026-09-25-master-switch-design.md`)。`npm run e2e` の smoke が、オフで拡張の要素が 0 個になること・
service worker へのメッセージが 0 件・`k` と `t`・オンに戻すと読み込み直さずに戻ること・popup・バッジ・起動し直しを確かめる。
ここは E2E で測れないものと、目で見るもの。

- [ ] オフにすると、窓・ドック枠・シークバーの帯・プレビューの canvas が消える。DevTools の Elements で `yt-clip` を検索して 0 件
- [ ] オフの間、DevTools のコンソール (YouTube のページ) に `[yt-clip]` や拡張から出た行が新しく出ない
- [ ] オフの間、キーボードの `k` `t` `f` と、シークバーのドラッグ・全画面・ミニプレイヤーが今までどおり
- [ ] オフのまま別の動画へ移っても (ページの中のリンクでも、開き直しても) 何も出ない
- [ ] オンに戻すと読み込み直さずに出て、IN の範囲が戻る。ドックしていた窓は枠に、動かした窓は同じ位置に出る
- [ ] 録画中にオフにすると popup に「オフにします。録画を中止しています…」が出て窓が消え、オンに戻すと区間が残っていて録り直せる
- [ ] 書き出し中 (「録画を書き出しています…」の間) にオフにすると popup に「オフにします。書き出しが済んだら止まります…」が出て、
      済んでから窓が消え、popup に「録画したクリップは残っています (オンに戻すと続きから)」が出る。オンに戻すとプレビューから続く
- [ ] プレビュー (「録画できました」) でオフ → オンにしても「X に投稿」が押せる
- [ ] 録画中に別の YouTube タブでオフにしても (オフは全タブに効く)、録画対象のタブだけが中止し、ほかのタブはその場で消える
- [ ] **X の投稿画面を開いたままオフにすると、本文も動画も入らない。** 30 秒ほどで popup (オンに戻した後) とバーが
      「X への自動添付に失敗しました」になり、「X にもう一度投稿」でやり直せる (ログイン済みの X が要るので自動化しない)
- [ ] **popup に「録画を中止しています…」「書き出しが済んだら止まります…」が出たまま変わらないとき** (録画していたタブを
      その間に読み込み直した、など) は、オンに戻すか、そのタブを閉じると抜ける (オンに戻すと「録画が中断されました」、
      閉じると「録画対象のタブが見つかりません」になる)
- [ ] ツールバーのアイコンに、オフの間だけ灰色の `OFF` のバッジが出る
- [ ] ブラウザを再起動してもオフのままで、バッジも残る
- [ ] OS のテーマがダークでもライトでも popup が読める (popup はテーマに合わせず、いつも明るい配色)
```

- [ ] **Step 6: privacy-policy に「オン / オフ」を足す**

`docs/privacy-policy.md` の 3 行目 `最終更新: 2026-09-25` の日付を、実行した日の JST (`TZ=Asia/Tokyo date +%F`) にする (判断メモ 26)。

「## 端末の中に置くもの」の表の行

```markdown
| 窓 (操作のバー・区間とテロップの一覧・設定) の位置と大きさ、どの枠に入れたか | `chrome.storage.local` | 拡張を削除したとき |
```

の直後に次の行を足す。

```markdown
| オン / オフ (全機能を止めているか) | `chrome.storage.local` | 拡張を削除したとき |
```

次の段落 (28 行目)

```markdown
`chrome.storage.local` に置いた窓の位置と大きさ・どの枠に入れたかは、その端末の中にだけ残り、同期されない。
```

を次に置き換える。

```markdown
`chrome.storage.local` に置いた窓の位置と大きさ・どの枠に入れたか・オン / オフは、その端末の中にだけ残り、同期されない。
```

「## 求めている権限」の表の行 (43 行目)

```markdown
| `storage` | 上表の設定・窓の位置と大きさとどの枠に入れたか・進行状態を端末内に置くため |
```

を次に置き換える (権限は増えない)。

```markdown
| `storage` | 上表の設定・窓の位置と大きさとどの枠に入れたか・オン / オフ・進行状態を端末内に置くため |
```

- [ ] **Step 7: store-release の掲載文と権限の説明に「オン / オフ」を足す**

`docs/store-release.md` の §2 の説明文 (コードブロックの中) の「■ 設定 (⚙)」の最後の行

```
・テロップの見た目 — 文字サイズ / フォント / 文字の色 / 縁取りの色 / 縁取りの太さ
```

の後、空行を 1 つ挟んで次を足す (続く「■ 知っておいてほしいこと」の前の空行は残す)。

```
■ オン / オフ

ツールバーのアイコンのスイッチで全機能を止められます。オフの間は YouTube と X のページに何も出さず、何も変えません。
オンに戻すと開いているタブでもそのまま戻ります。
```

「### `storage`」の引用の行

```markdown
> 操作のバー・区間とテロップの一覧・設定 (3 つの窓) の位置と大きさ、ページの中のどの枠に入れたか (タブの並び) を端末ごとに保存する (`chrome.storage.local`)。
```

の直後に次の行を足す。

```markdown
> 全機能のオン / オフを端末ごとに保存する (`chrome.storage.local`)。
```

「### データの取り扱い (Privacy practices)」の箇条

```markdown
- 窓の位置と大きさ・どの枠に入れたかは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

を次に置き換える。

```markdown
- 窓の位置と大きさ・どの枠に入れたか・オン / オフは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

「## 7. 更新公開のとき」の箇条

```markdown
- [ ] **画面を変えたならスクリーンショットを撮り直した** (`npm run screenshots`)。
      設定パネルに項目を足した・バーのボタンが増えた、はどちらも該当する
```

を次に置き換える (spec §ドキュメント「§7 の『画面を変えたなら』に popup は含めない」)。

```markdown
- [ ] **画面を変えたならスクリーンショットを撮り直した** (`npm run screenshots`)。
      設定パネルに項目を足した・バーのボタンが増えた、はどちらも該当する。
      popup (オン / オフのスイッチ) は掲載画像に写していないので、popup だけを変えたときは該当しない
```

- [ ] **Step 8: 文言を確かめる**

実行: `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff --stat` (Bash の timeout 30000)
期待: 5 ファイル (`README.md` / `CHANGELOG.md` / `docs/manual-check.md` / `docs/privacy-policy.md` / `docs/store-release.md`) だけが変わっている

実行: `grep -n "ボタンが 1 つも無い\|ボタンは 1 つも無い\|ボタンは持たない" /Users/trapple/repos/github.com/trapple/yt-clip/README.md /Users/trapple/repos/github.com/trapple/yt-clip/docs/manual-check.md` (Bash の timeout 30000)
期待: README は「ほかは状態を映すだけで、ボタンは持たない」の 1 行、manual-check は「(ボタンは 1 つも無い)」の 1 行だけ

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/privacy-policy.md docs/store-release.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 全機能のオン / オフのスイッチを README とチェックリストに先に書く

popup に「操作を持たない」の例外としてスイッチを 1 つ置き、オフの間は
YouTube と X のページに何も出さない。録画中・書き出し中にオフにしたときの
振る舞いと、待っている表示が残ったときの抜け道 (オンに戻す・タブを閉じる) は
使う人が知らないと困るので、コードより先に制約として書く。保存先が 1 つ
増えるので、プライバシーポリシーとストアの説明も合わせる (権限は増えない)。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 2: オン / オフの保存と読み方 (`src/shared/master-switch.ts`)

**Files:**
- Create: `src/shared/master-switch.ts`
- Test: `tests/shared/master-switch.test.ts`

**Interfaces:**
- Consumes: なし
- Produces (後のタスクが使う):
  - `export const MASTER_SWITCH_KEY = "enabled"`
  - `export function readEnabled(stored: unknown): boolean` — `undefined` → true、boolean → その値、それ以外 → warn して true
  - `export async function loadEnabled(): Promise<boolean>` — reject しない (読めなければ warn して true)
  - `export async function saveEnabled(value: boolean): Promise<void>` — 失敗は reject のまま
  - `export function watchEnabled(onChange: (enabled: boolean) => void): () => void` — `local` の `enabled` だけを拾う。戻り値で外す

- [ ] **Step 1: 失敗するテストを書く**

`tests/shared/master-switch.test.ts` を作る。

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MASTER_SWITCH_KEY,
  loadEnabled,
  readEnabled,
  saveEnabled,
  watchEnabled,
} from "@/shared/master-switch";

/** chrome.storage.onChanged の listener の形 */
type Listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readEnabled", () => {
  test("キーが無ければオン。warn しない (既定はオン)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readEnabled(undefined)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("boolean はその値", () => {
    expect(readEnabled(false)).toBe(false);
    expect(readEnabled(true)).toBe(true);
  });

  test.each([["no"], [1], [null], [{}]])(
    "boolean でない値 (%j) は warn してオン (読めないときに拡張が黙って消えない)",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(readEnabled(value)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("loadEnabled", () => {
  test("chrome.storage.local の enabled を読む", async () => {
    const get = vi.fn(async (_key: string) => ({ enabled: false }));
    vi.stubGlobal("chrome", { storage: { local: { get } } });

    expect(await loadEnabled()).toBe(false);
    expect(MASTER_SWITCH_KEY).toBe("enabled");
    expect(get).toHaveBeenCalledWith("enabled");
  });

  test("読めなくても reject せず、warn してオン", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (): Promise<never> => {
            throw new Error("読めない");
          },
        },
      },
    });

    await expect(loadEnabled()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("saveEnabled", () => {
  test("chrome.storage.local の enabled に書く", async () => {
    const set = vi.fn(async (_items: Record<string, unknown>) => undefined);
    vi.stubGlobal("chrome", { storage: { local: { set } } });

    await saveEnabled(false);
    expect(set).toHaveBeenCalledWith({ enabled: false });
  });

  test("書けなければ reject をそのまま返す (popup が理由を出して表示を戻す)", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          set: async (): Promise<never> => {
            throw new Error("書けない");
          },
        },
      },
    });

    await expect(saveEnabled(true)).rejects.toThrow("書けない");
  });
});

describe("watchEnabled", () => {
  test("local の enabled だけを拾う (sync の settings・local の windowLayout では呼ばない)。戻り値で外す", () => {
    const listeners: Listener[] = [];
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        onChanged: {
          addListener: (fn: Listener): void => {
            listeners.push(fn);
          },
          removeListener,
        },
      },
    });
    const fire: Listener = (changes, areaName) => {
      for (const listener of listeners) listener(changes, areaName);
    };
    const onChange = vi.fn();

    const unwatch = watchEnabled(onChange);
    fire({ settings: { newValue: {} } }, "sync");
    fire({ windowLayout: { newValue: {} } }, "local");
    fire({ enabled: { newValue: false } }, "sync");
    expect(onChange).not.toHaveBeenCalled();

    fire({ enabled: { newValue: false } }, "local");
    expect(onChange).toHaveBeenLastCalledWith(false);
    // キーを消した (既定 = オン)
    fire({ enabled: {} }, "local");
    expect(onChange).toHaveBeenLastCalledWith(true);

    unwatch();
    expect(removeListener).toHaveBeenCalledWith(listeners[0]);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/master-switch.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/shared/master-switch"`)

- [ ] **Step 3: 最小実装**

`src/shared/master-switch.ts` を作る。

```typescript
/**
 * 全機能のオン / オフ (マスタースイッチ。`.claude/specs/2026-09-25-master-switch-design.md` §3)。
 *
 * **`chrome.storage.local` の `enabled` に置く (sync の settings に入れない)。** 理由は 2 つ:
 * 1. 端末ごとの操作である。「いま、この端末で止めたい」が同期で別の端末へ届くと、向こうでは拡張が黙って消える
 *    (窓の位置を local にしたのと同じ理由)
 * 2. settings の保存は組ごとの読み書き (saveSettings は読んで `{ ...current, ...patch }` を書く) なので、設定パネルの
 *    保存と popup のスイッチが同時に走ると片方が消える。別のキーなら互いに触らない
 *
 * 既定は**オン** (キーが無い = true)。popup・content script・service worker の 3 つが読む
 */

export const MASTER_SWITCH_KEY = "enabled";

/**
 * 保存された値を読む。
 *
 * ※ 局所例外 (Fail Fast): **boolean でない値は throw せず、warn してオン** (mergeSettings / mergeWindowLayout と
 * 同じ作法)。オフに倒すと、壊れた値で拡張が黙って消える。オフにしたかった人は popup で分かる
 */
export function readEnabled(stored: unknown): boolean {
  if (stored === undefined) return true;
  if (typeof stored === "boolean") return stored;
  console.warn(`[yt-clip] 保存されたオン / オフが読めないため、オンとして扱います: ${String(stored)}`);
  return true;
}

/**
 * 保存された値を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残してオン (loadWindowLayout と同じ判断:
 * 読めないときに拡張が黙って消えるより、今までどおり出る方がよい)
 */
export async function loadEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(MASTER_SWITCH_KEY);
    return readEnabled(stored[MASTER_SWITCH_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] オン / オフを読めないため、オンとして扱います: ${String(error)}`);
    return true;
  }
}

/** 書く。**失敗は握り潰さず reject する** (popup が理由を出し、チェックを保存されている値に戻す。書けたつもりにしない) */
export async function saveEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [MASTER_SWITCH_KEY]: value });
}

/**
 * 変わるのを見張る。`local` の `enabled` だけを拾う (windowLayout の書き込みや sync の settings では呼ばない)。
 * **自分の書き込みでも来る** (popup はこれで表示を確定する)。戻り値を呼ぶと外す
 */
export function watchEnabled(onChange: (enabled: boolean) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    const change = changes[MASTER_SWITCH_KEY];
    if (change === undefined) return;
    onChange(readEnabled(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/shared/master-switch.test.ts` (Bash の timeout 120000)
期待: PASS (11 件。`test.each` の 4 件を含む)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/master-switch.ts tests/shared/master-switch.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(shared): オン / オフの保存と読み方を 1 か所に置く

popup・content script・service worker の 3 つがスイッチを読むので、
キーと既定値と壊れた値の扱いを 1 つのモジュールに集める。端末ごとの
操作なので local に置き、設定の組 (sync) とは別のキーにして同時書き込みで
消えないようにする。読めないときはオンに倒す (拡張が黙って消える方が
分かりにくい)。書けないときは popup が理由を出せるよう reject を返す。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 3: content script のオン / オフを合わせる driver (`src/content/switch-driver.ts`)

**Files:**
- Create: `src/content/switch-driver.ts`
- Test: `tests/content/switch-driver.test.ts`

**Interfaces:**
- Consumes: Task 2 の `loadEnabled(): Promise<boolean>`、`watchEnabled(onChange): () => void`
- Produces (Task 6・7・8 が使う):
  - `export type SwitchHooks = { start(): void; stop(): void; canStop?(): boolean; onStopDeferred?(): void }`
  - `export type SwitchDriver = { reconcile(): void; destroy(): void }`
  - `export function createSwitchDriver(hooks: SwitchHooks): SwitchDriver` — 作った時点で 1 回読み、`onChanged` を張る。
    `start` / `stop` を二度続けて呼ばない (desired と running の比較で吸収)。`canStop` が偽の間は stop を待ち、待ちに入るたびに
    `onStopDeferred` を 1 回呼ぶ (判断メモ 14)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/switch-driver.test.ts` を作る。

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSwitchDriver, type SwitchDriver } from "@/content/switch-driver";

/** chrome.storage.onChanged の listener の形 */
type Listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

let listeners: Listener[] = [];
/** chrome.storage.local.get の応答を離す。離すまで最初の読みは返らない */
let releaseGet: (stored: Record<string, unknown>) => void = () => undefined;
let driver: SwitchDriver | null = null;

beforeEach(() => {
  listeners = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (): Promise<Record<string, unknown>> =>
          new Promise((resolve) => {
            releaseGet = resolve;
          }),
      },
      onChanged: {
        addListener: (fn: Listener): void => {
          listeners.push(fn);
        },
        removeListener: (fn: Listener): void => {
          listeners = listeners.filter((listener) => listener !== fn);
        },
      },
    },
  });
});

afterEach(() => {
  driver?.destroy();
  driver = null;
  vi.unstubAllGlobals();
});

/** 別の場所 (popup・DevTools) で enabled が書き換わった */
function change(enabled: unknown): void {
  for (const listener of [...listeners]) listener({ enabled: { newValue: enabled } }, "local");
}

/** 最初の読みの Promise の連鎖を流す */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

/** 呼ばれた回数を数える hooks。canStop は state.canStop を返す */
function makeHooks(canStop = true) {
  const state = { canStop };
  const hooks = {
    start: vi.fn(),
    stop: vi.fn(),
    canStop: vi.fn(() => state.canStop),
    onStopDeferred: vi.fn(),
  };
  return { hooks, state };
}

describe("最初の読み", () => {
  test("オンなら start を 1 回呼ぶ。読みが返るまでは何も呼ばない", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    expect(hooks.start).not.toHaveBeenCalled();

    releaseGet({ enabled: true });
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
    expect(hooks.stop).not.toHaveBeenCalled();
  });

  test("キーが無ければオン (既定)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
  });

  test("オフなら何も呼ばない", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({ enabled: false });
    await settle();
    expect(hooks.start).not.toHaveBeenCalled();
    expect(hooks.stop).not.toHaveBeenCalled();
  });
});

describe("onChanged", () => {
  test("オフで stop、オンで start", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(2);
  });

  test("同じ値の onChanged では呼ばない (start / stop を二度続けて呼ばない)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(1);
    change(false);
    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });

  test("最初の読みが返る前に onChanged が来たら、最後の値だけが効く (start は二度走らない)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    change(true);
    expect(hooks.start).toHaveBeenCalledTimes(1);
    change(false);
    expect(hooks.stop).toHaveBeenCalledTimes(1);

    // 読みが後から古い値 (オン) を返しても、onChanged の値 (オフ) のまま
    releaseGet({ enabled: true });
    await settle();
    expect(hooks.start).toHaveBeenCalledTimes(1);
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stop を待つ (canStop)", () => {
  test("canStop が偽なら stop を待ち、onStopDeferred を 1 回だけ呼ぶ。真になってから reconcile で stop", async () => {
    const { hooks, state } = makeHooks(false);
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    expect(hooks.stop).not.toHaveBeenCalled();
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(1);
    // 状態の通知のたびに reconcile されても、中止を送り直させない
    driver.reconcile();
    driver.reconcile();
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(1);
    expect(hooks.stop).not.toHaveBeenCalled();

    state.canStop = true;
    driver.reconcile();
    expect(hooks.stop).toHaveBeenCalledTimes(1);
  });

  test("stop を待っている間にオンへ戻したら stop を呼ばない (start も呼び直さない)。次にオフにすると、また 1 回知らせる", async () => {
    const { hooks, state } = makeHooks(false);
    driver = createSwitchDriver(hooks);
    releaseGet({});
    await settle();

    change(false);
    change(true);
    state.canStop = true;
    driver.reconcile();
    expect(hooks.stop).not.toHaveBeenCalled();
    expect(hooks.start).toHaveBeenCalledTimes(1);

    state.canStop = false;
    change(false);
    expect(hooks.onStopDeferred).toHaveBeenCalledTimes(2);
  });

  test("canStop を省くと、いつでもその場で止める", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    driver = createSwitchDriver({ start, stop });
    releaseGet({});
    await settle();

    change(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("destroy", () => {
  test("onChanged を外し、以後は何も呼ばない (読みが後から返っても)", async () => {
    const { hooks } = makeHooks();
    driver = createSwitchDriver(hooks);
    driver.destroy();
    expect(listeners).toHaveLength(0);

    releaseGet({ enabled: true });
    await settle();
    change(false);
    expect(hooks.start).not.toHaveBeenCalled();
    expect(hooks.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/switch-driver.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/content/switch-driver"`)

- [ ] **Step 3: 最小実装**

`src/content/switch-driver.ts` を作る。

```typescript
import { loadEnabled, watchEnabled } from "@/shared/master-switch";

/**
 * content script のオン / オフ (マスタースイッチの spec `.claude/specs/2026-09-25-master-switch-design.md` §2.1)。
 * 保存された値を 1 回読み、chrome.storage.onChanged を見張り、**望んでいる状態 (desired) と走っている状態 (running) を
 * reconcile() で合わせる**。youtube.ts と x.ts が同じ作法で使う。
 *
 * **chrome.storage にだけ触る (DOM に触らない)。** オフのページに残るのは、この読み 1 回と onChanged の listener 1 本だけ
 * (spec §1 の「残るもの」。拡張の隔離された world の中で完結し、ページからは見えない)
 */

export type SwitchHooks = {
  start(): void;
  stop(): void;
  /**
   * 今 stop してよいか。偽なら stop を待つ。省くと常に真。
   * youtube.ts は**このタブで録画の準備・録画・書き出しが走っている間**だけ偽 (spec §4.1)。状態機械の busy ではない
   */
  canStop?(): boolean;
  /** stop を待たされた (canStop が偽)。youtube.ts はここで中止を送る (spec §4.1)。待ちに入るたびに 1 回 */
  onStopDeferred?(): void;
};

export type SwitchDriver = {
  /**
   * desired と running を比べ、違えば start / stop を呼ぶ。stop は canStop() が真のときだけ。最初の読みと onChanged で
   * 自分で呼ぶほか、**呼び出し側が「stop してよくなった」ときにも呼ぶ** (youtube.ts は状態の通知の処理の末尾と、
   * 中止の応答・録画の結末を送り終えたとき)
   */
  reconcile(): void;
  /** onChanged の見張りを外す。走っているものは止めない (content script はページと一緒に消えるので、使うのはテスト) */
  destroy(): void;
};

export function createSwitchDriver(hooks: SwitchHooks): SwitchDriver {
  /** 望んでいる状態。最初の読みか onChanged が来るまでは null (まだ何もしない) */
  let desired: boolean | null = null;
  let running = false;
  /**
   * stop を待たせていて、onStopDeferred を知らせた後か。**待ちに入るたびに 1 回だけ知らせる**: reconcile は状態の通知の
   * たびに呼ばれるので、そのたびに中止を送り直させない。stop した・オンに戻ったら下ろす
   */
  let deferred = false;
  let destroyed = false;

  function reconcile(): void {
    if (destroyed || desired === null) return;
    if (desired) {
      // オンに戻った。待たせていた stop は要らない
      deferred = false;
      if (running) return;
      // 先に立てる: start の中から reconcile が呼ばれても二度 start しない
      running = true;
      hooks.start();
      return;
    }
    if (!running) return;
    if (hooks.canStop !== undefined && !hooks.canStop()) {
      if (!deferred) {
        deferred = true;
        hooks.onStopDeferred?.();
      }
      return;
    }
    deferred = false;
    running = false;
    hooks.stop();
  }

  const unwatch = watchEnabled((enabled) => {
    desired = enabled;
    reconcile();
  });

  void loadEnabled().then((enabled) => {
    // 読みが返る前に onChanged が来ていたら、そちらが新しい (読みは書き換わる前の値を返しうる)。最後の値だけを効かせる
    if (desired !== null) return;
    desired = enabled;
    reconcile();
  });

  return {
    reconcile,
    destroy(): void {
      destroyed = true;
      unwatch();
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/switch-driver.test.ts` (Bash の timeout 120000)
期待: PASS (10 件)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/switch-driver.ts tests/content/switch-driver.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): オン / オフに合わせて start / stop を呼ぶ driver を足す

youtube.ts と x.ts はどちらも「保存された値を読む → 変わるのを見張る →
start / stop を合わせる」をする。最初の読みより先に onChanged が来たときや、
同じ値が 2 度届いたときに start を二度呼ばないよう、望んでいる状態と
走っている状態を分けて持つ。録画中のタブは stop を待たせたいので、
止めてよいかを聞く口と、待たされたことを 1 回だけ知らせる口を持たせる。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 4: ツールバーのバッジ (`src/background/badge.ts` / `sw.ts`)

**Files:**
- Create: `src/background/badge.ts`
- Modify: `src/background/sw.ts` (import の後と末尾)
- Test: `tests/background/badge.test.ts`

**Interfaces:**
- Consumes: Task 2 の `loadEnabled()`、`watchEnabled(onChange)`
- Produces:
  - `export type BadgeAction = { setBadgeText(details: { text: string }): Promise<void>; setBadgeBackgroundColor(details: { color: string }): Promise<void>; setBadgeTextColor(details: { color: string }): Promise<void> }`
  - `export async function applyBadge(enabled: boolean, action: BadgeAction = chrome.action): Promise<void>`
  - `export async function syncBadge(action: BadgeAction = chrome.action): Promise<void>`
  - 定数 `BADGE_OFF_TEXT = "OFF"`、`BADGE_OFF_COLOR = "#606060"`、`BADGE_TEXT_COLOR = "#ffffff"`

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/badge.test.ts` を作る。

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyBadge, syncBadge, type BadgeAction } from "@/background/badge";

/** chrome.action の偽物。呼ばれた引数を見る */
function fakeAction() {
  return {
    setBadgeText: vi.fn(async (_details: { text: string }) => undefined),
    setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => undefined),
    setBadgeTextColor: vi.fn(async (_details: { color: string }) => undefined),
  } satisfies BadgeAction;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyBadge", () => {
  test("オフでは灰色の地に白で OFF", async () => {
    const action = fakeAction();
    await applyBadge(false, action);
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "OFF" });
    expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#606060" });
    expect(action.setBadgeTextColor).toHaveBeenCalledWith({ color: "#ffffff" });
  });

  test("オンでは空文字 (バッジを出さない)。色は触らない", async () => {
    const action = fakeAction();
    await applyBadge(true, action);
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(action.setBadgeBackgroundColor).not.toHaveBeenCalled();
    expect(action.setBadgeTextColor).not.toHaveBeenCalled();
  });
});

describe("syncBadge", () => {
  test("保存された値を読んで当てる (オフ → OFF、キーが無い → 出さない)", async () => {
    let stored: Record<string, unknown> = { enabled: false };
    vi.stubGlobal("chrome", { storage: { local: { get: async () => stored } } });

    const off = fakeAction();
    await syncBadge(off);
    expect(off.setBadgeText).toHaveBeenCalledWith({ text: "OFF" });

    stored = {};
    const on = fakeAction();
    await syncBadge(on);
    expect(on.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/badge.test.ts` (Bash の timeout 120000)
期待: FAIL (`Failed to resolve import "@/background/badge"`)

- [ ] **Step 3: 最小実装**

`src/background/badge.ts` を作る。

```typescript
import { loadEnabled } from "@/shared/master-switch";

/**
 * ツールバーのアイコンのバッジ (マスタースイッチの spec §6.2)。オフの間は灰色の地に白で `OFF`、オンでは出さない。
 *
 * **持ち主は service worker だけ** (sw.ts が起動時と onChanged で当てる)。popup が押したときに popup 自身が当てる案は
 * 採らない: 持ち主が 2 つになり、DevTools など別の経路で書いたときに追従しない。setBadge* は action を持つ拡張なら
 * 権限なしで使える (manifest は変えない)。アイコンの絵を灰色に差し替える案も採らない (4 つの大きさの画像と
 * make-icons.mjs の手間に対して、伝わることは同じ)
 */

export const BADGE_OFF_TEXT = "OFF";
/** 地の色。警告色 (赤) にしない: オフは壊れているのではなく、自分で止めている状態 */
export const BADGE_OFF_COLOR = "#606060";
export const BADGE_TEXT_COLOR = "#ffffff";

/**
 * 使う chrome.action の部分 (Promise 版だけ)。chrome.action の型は callback 版との overload で、テストの偽物を
 * 合わせにくいので、使う 3 つだけの型を持つ
 */
export type BadgeAction = {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setBadgeTextColor(details: { color: string }): Promise<void>;
};

export async function applyBadge(
  enabled: boolean,
  action: BadgeAction = chrome.action,
): Promise<void> {
  if (enabled) {
    // 文言が空ならバッジは出ない。色は出ていないバッジには効かないので触らない
    await action.setBadgeText({ text: "" });
    return;
  }
  // 色を先に当てる (文言が出た瞬間に既定の色で見えないように)
  await action.setBadgeBackgroundColor({ color: BADGE_OFF_COLOR });
  await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
  await action.setBadgeText({ text: BADGE_OFF_TEXT });
}

/**
 * 保存された値を読んでバッジを当てる。service worker が起きたとき・ブラウザの起動・拡張の入れ直しで呼ぶ
 * (バッジの文言がブラウザの再起動をまたいで残るかは実装時に確かめる。残らなくても onStartup で当て直す)
 */
export async function syncBadge(action: BadgeAction = chrome.action): Promise<void> {
  await applyBadge(await loadEnabled(), action);
}
```

`src/background/sw.ts` の import の並び

```typescript
import { createRouter, type RouterSnapshot } from "@/background/router";
import { normalizeSnapshot } from "@/background/snapshot";
import { getClip, saveClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import { loadSettings } from "@/shared/settings";
```

を次に置き換える。

```typescript
import { applyBadge, syncBadge } from "@/background/badge";
import { createRouter, type RouterSnapshot } from "@/background/router";
import { normalizeSnapshot } from "@/background/snapshot";
import { getClip, saveClip } from "@/background/storage";
import { watchEnabled } from "@/shared/master-switch";
import type { Message } from "@/shared/messages";
import { loadSettings } from "@/shared/settings";
```

`src/background/sw.ts` の末尾 (`chrome.runtime.onMessage.addListener(...)` の `});` の後) に、空行を 1 つ挟んで次を足す。

```typescript
/** バッジを当てられなかった。拡張の動作 (オン / オフそのもの) には関わらないので、記録だけ残して続ける */
function reportBadgeError(error: unknown): void {
  console.error("ツールバーのバッジを当てられませんでした", error);
}

// オフの間はアイコンに OFF のバッジを出す (マスタースイッチの spec §6.2)。**router と状態機械はスイッチを知らない**
// (オフ ≒ YouTube のタブが無い。spec §4.2)。service worker がスイッチを読むのはバッジのためだけ。
// service worker が起きるたび (このモジュールの評価) と、ブラウザの起動・拡張の入れ直しで当て直し、変わるたびに当てる。
// listener はモジュールの最初の評価で同期に張る (MV3 で起こされたイベントを取りこぼさない)
void syncBadge().catch(reportBadgeError);
chrome.runtime.onStartup.addListener(() => {
  void syncBadge().catch(reportBadgeError);
});
chrome.runtime.onInstalled.addListener(() => {
  void syncBadge().catch(reportBadgeError);
});
watchEnabled((enabled) => {
  void applyBadge(enabled).catch(reportBadgeError);
});
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/badge.test.ts` (Bash の timeout 120000)
期待: PASS (3 件)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (sw.ts は単体テストを持たない。型だけで確かめ、実機は Task 10)

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/background/badge.ts src/background/sw.ts tests/background/badge.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(background): オフの間はツールバーのアイコンに OFF のバッジを出す

オフにするとページに何も出ないので、拡張が壊れたのか止めたのかを
アイコンで見分けられるようにする。当てる持ち主は service worker だけにし、
popup 以外の経路 (DevTools など) で書いたときも onChanged で追従させる。
バッジがブラウザの再起動をまたいで残らなくても、起動のたびに当て直す。
状態機械はスイッチを知らないまま (オフはタブが無いのと同じ)。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 5: popup のスイッチ (`src/popup/view.ts` / `popup.html` / `popup.ts`)

**Files:**
- Modify: `src/popup/view.ts` (先頭の doc と末尾に `describeSwitch` を足す)
- Modify: `src/popup/popup.html` (全体)
- Modify: `src/popup/popup.ts` (全体)
- Test: `tests/popup/view.test.ts` (末尾に describe を足す)

**Interfaces:**
- Consumes: Task 2 の `loadEnabled` / `saveEnabled` / `watchEnabled`
- Produces:
  - `export type SwitchView = { checked: boolean; hint: string | null; showState: boolean; note: string | null }` (判断メモ 2)
  - `export function describeSwitch(enabled: boolean, state: ClipState | null): SwitchView`
  - popup の DOM: `#enabled` (`<input type="checkbox" role="switch">`)・`#message` (オンなら状態の文言、オフなら `hint`)・`#note`・`#switch-error`
    (Task 9 の E2E が `#enabled` と `#message` を読む)

- [ ] **Step 1: 失敗するテストを書く**

`tests/popup/view.test.ts` の import

```typescript
import { describeState } from "@/popup/view";
```

を次に置き換える。

```typescript
import { describeState, describeSwitch } from "@/popup/view";
```

同じファイルの末尾に次を足す。

```typescript
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
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/popup/view.test.ts` (Bash の timeout 120000)
期待: FAIL (`describeSwitch is not a function` / `does not provide an export named 'describeSwitch'`)

- [ ] **Step 3: 最小実装 (view.ts)**

`src/popup/view.ts` の次の doc

```typescript
/**
 * popup が出すもの。**操作は持たない。**
 *
 * 操作はページ内バーへ移した。popup を残しているのは、YouTube 以外の
 * タブにいるときに状態を見る場所が無くなるため。X の投稿画面で添付に失敗した
 * 場面が実際にこれに当たる
 */
```

を次に置き換える。

```typescript
/**
 * popup が出す状態の表示。**状態の操作は持たない** (持つ操作はオン / オフのスイッチだけ。describeSwitch)。
 *
 * 操作はページ内バーへ移した。popup を残しているのは、YouTube 以外の
 * タブにいるときに状態を見る場所が無くなるため。X の投稿画面で添付に失敗した
 * 場面が実際にこれに当たる
 */
```

同じファイルの末尾 (`describeState` の閉じ括弧の後) に、空行を 1 つ挟んで次を足す。

```typescript
/**
 * popup のスイッチまわりの見た目 (マスタースイッチの spec §6.1)。
 *
 * **押せるか (disabled) を持たない。** オンに戻す場所は popup だけなので、拒む状態が 1 つでもあると拡張を戻せなくなる
 * (オフ + busy は、書き出しを待つ間に録画対象のタブを読み込み直すと作れる)。スイッチの見た目は保存された値だけで決める。
 * 端末の注意 (「この端末だけに効く」) は状態に依らないので popup.html に固定で書く (判断メモ 2)
 */
export type SwitchView = {
  /** スイッチの見た目 = 保存された値 */
  checked: boolean;
  /** オフの間に、状態の文言の代わりに出す 1 行。オンなら null */
  hint: string | null;
  /** 状態の文言と進捗バーを出すか。オフの間は出さない (「録画できました」と出ていてページには何も無い、を避ける) */
  showState: boolean;
  /** オフで録画済みのクリップを抱えているときに添える 1 行 (成果物を失ったと誤解させない)。それ以外は null */
  note: string | null;
};

/** 録画済みのクリップを抱えた状態。オフにしても状態機械とクリップは残る */
const CLIP_KINDS: ReadonlySet<ClipState["kind"]> = new Set(["preview", "posted", "degraded"]);

/**
 * オフの間の 1 行。録画対象のタブが片付けを待っている間 (spec §4.1) は、何を待っているかを出す。
 * state は状態を取得できなかったときは null
 */
function offHint(state: ClipState | null): string {
  if (state?.kind === "seeking" || state?.kind === "recording") {
    return "オフにします。録画を中止しています…";
  }
  if (state?.kind === "encoding") return "オフにします。書き出しが済んだら止まります…";
  return "オフです。YouTube と X のページには何も出ません";
}

export function describeSwitch(enabled: boolean, state: ClipState | null): SwitchView {
  if (enabled) return { checked: true, hint: null, showState: true, note: null };
  return {
    checked: false,
    hint: offHint(state),
    showState: false,
    note:
      state !== null && CLIP_KINDS.has(state.kind)
        ? "録画したクリップは残っています (オンに戻すと続きから)"
        : null,
  };
}
```

- [ ] **Step 4: 実行して通過を確認 (view.ts)**

実行: `npx vitest run tests/popup/view.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 5: popup.html を置き換える**

`src/popup/popup.html` を次の内容にする (スイッチ・端末の注意・保存の失敗・区切り線・`#note` を足した。`#message` と進捗バーは今までどおり)。

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>yt-clip</title>
    <style>
      body {
        width: 320px;
        margin: 0;
        padding: 12px;
        font-family: system-ui, sans-serif;
        font-size: 13px;
      }
      #switch-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: bold;
        cursor: pointer;
      }
      #switch-note {
        margin: 2px 0 0 24px;
        color: #606060;
        font-size: 12px;
      }
      #switch-error {
        margin: 6px 0 0;
        color: #c00;
      }
      hr {
        margin: 10px 0;
        border: none;
        border-top: 1px solid #ddd;
      }
      #message {
        margin: 0 0 10px;
        line-height: 1.5;
      }
      #note {
        margin: 0 0 10px;
        line-height: 1.5;
        color: #606060;
      }
      #progress-area {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      #progress {
        flex: 1;
      }
    </style>
  </head>
  <body>
    <!--
      全機能のオン / オフ (マスタースイッチの spec §6.1)。popup が持つ唯一の操作。どの状態でも押せる (disabled を付けない)。
      既定はオンなので checked で始める (読み終えるまでの一瞬にオフに見えないように)
    -->
    <label id="switch-row">
      <input type="checkbox" role="switch" id="enabled" checked />
      yt-clip を使う
    </label>
    <p id="switch-note">この端末だけに効く (同期しない)</p>
    <p id="switch-error" hidden></p>
    <hr />
    <p id="message"></p>
    <p id="note" hidden></p>
    <div id="progress-area" hidden>
      <progress id="progress" value="0" max="1"></progress>
      <span id="remain"></span>
    </div>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

(今の `#preview` / `#actions` / `button` の CSS は、対応する要素が popup.html に無いので落とす。)

- [ ] **Step 6: popup.ts を置き換える**

`src/popup/popup.ts` を次の内容にする。

```typescript
// popup は状態を映す。持つ操作はオン / オフのスイッチだけ (マスタースイッチの spec §6.1)。
// ほかの操作はページ内バーが持つ。オンに戻す操作はページに何も無いときに要るので、ページの外 (ここ) にしか置けない
import { describeState, describeSwitch } from "@/popup/view";
import { loadEnabled, saveEnabled, watchEnabled } from "@/shared/master-switch";
import type { Message, MessageResponse } from "@/shared/messages";
import type { ClipState } from "@/shared/types";

const switchInput = document.getElementById("enabled") as HTMLInputElement;
const switchError = document.getElementById("switch-error") as HTMLElement;
const messageElement = document.getElementById("message") as HTMLElement;
const noteElement = document.getElementById("note") as HTMLElement;
const progressArea = document.getElementById("progress-area") as HTMLElement;
const progressElement = document.getElementById(
  "progress",
) as HTMLProgressElement;
const remainElement = document.getElementById("remain") as HTMLElement;

/** 保存されているオン / オフ。読むまでは null (スイッチは HTML の既定 = オンのまま) */
let enabled: boolean | null = null;
/** service worker から最後に届いた状態。取れていなければ null */
let state: ClipState | null = null;
/** 状態を取得できなかった理由。取れたら null */
let stateError: string | null = null;

/** 残り時間を数えるタイマー。render の呼び出しごとに stopCountdown で必ず止めてから張り直す */
let countdownTimer: number | null = null;

function stopCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  progressArea.hidden = true;
}

/**
 * 録画の残り時間を数える。
 * 状態機械は録画の開始時刻を持たないため、popup がこの画面を開いてからの
 * 経過で数える。閉じて開き直すと数え直しになるが、録画は最長 60 秒なので
 * 「進んでいることが分かる」という目的には足りる。
 *
 * render のたびに呼ばれるが、先頭で stopCountdown() しているため
 * setInterval が多重に走ることはない。popup がページごと破棄されれば
 * タイマーも自動的に消える。
 */
function startCountdown(totalSec: number): void {
  stopCountdown();

  const endsAt = Date.now() + totalSec * 1000;
  progressElement.max = totalSec;
  progressArea.hidden = false;

  const tick = (): void => {
    const remainSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    progressElement.value = totalSec - remainSec;
    remainElement.textContent = `残り ${remainSec} 秒`;
    if (remainSec === 0) {
      stopCountdown();
    }
  };

  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

/**
 * スイッチと状態を描く。オン / オフと状態のどちらが変わっても呼ぶ。
 * **スイッチは service worker が居なくても出す** (状態を取得できなかったときも。壊れたときに止められる、がスイッチの価値)
 */
function render(): void {
  if (enabled === null) return;
  const view = describeSwitch(enabled, state);
  switchInput.checked = view.checked;
  noteElement.textContent = view.note ?? "";
  noteElement.hidden = view.note === null;

  if (!view.showState) {
    stopCountdown();
    messageElement.textContent = view.hint;
    return;
  }
  if (state === null) {
    stopCountdown();
    messageElement.textContent =
      stateError === null ? "" : `状態を取得できませんでした: ${stateError}`;
    return;
  }
  const stateView = describeState(state);
  messageElement.textContent = stateView.message;
  if (stateView.recordingSec !== null) {
    startCountdown(stateView.recordingSec);
  } else {
    stopCountdown();
  }
}

// 押した瞬間に書く。**表示の確定は onChanged で行う** (自分の書き込みでも来る。DevTools や別の popup で変えたときも
// 同じ経路で追従する)。書けなかったら理由を出し、チェックを保存されている値に戻す (書けたつもりにしない)
switchInput.addEventListener("change", () => {
  const next = switchInput.checked;
  switchError.hidden = true;
  void saveEnabled(next).catch((error: unknown) => {
    switchError.textContent = `切り替えを保存できませんでした: ${String(error)}`;
    switchError.hidden = false;
    switchInput.checked = enabled ?? true;
  });
});

watchEnabled((value) => {
  enabled = value;
  switchError.hidden = true;
  render();
});

// loadEnabled は reject しない (読めなければオン)。読みより先に onChanged が来ていたら、そちらが新しい
void loadEnabled().then((value) => {
  if (enabled === null) enabled = value;
  render();
});

// 状態はオフの間も取り続ける (待っている間の文言とクリップが残る旨に要る)
chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    state = message.state;
    stateError = null;
    render();
  }
});

chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => {
    state = response.state;
    stateError = null;
    render();
  })
  .catch((error: unknown) => {
    stateError = String(error);
    render();
  });
```

- [ ] **Step 7: 型とテストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (popup.ts は単体テストを持たない。実機は Task 9 の E2E と Task 10)

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/popup/view.ts src/popup/popup.html src/popup/popup.ts tests/popup/view.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(popup): 全機能のオン / オフのスイッチを最上段に置く

オフにするとページに何も出ないので、オンに戻す操作はページの外にしか
置けない。popup の「操作を持たない」をスイッチ 1 つだけ破る。どの状態でも
押せるようにし (オフ + 録画中でも戻せないと拡張を戻せなくなる)、service
worker が応答しなくても出す。オフの間は「録画できました」のような状態の
文言を出さず、待っている間は何を待っているか、クリップを抱えているなら
残っていることを出す。書けなかったときは理由を出して表示を戻す。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 6: X の投稿画面の content script (`src/content/x.ts`)

**Files:**
- Modify: `src/content/x.ts` (import と末尾の `if (typeof chrome !== "undefined") { … }` 294〜318 行目)
- Test: `tests/content/x.test.ts` (import と `describe("attachPayload")` の末尾)

**Interfaces:**
- Consumes: Task 3 の `createSwitchDriver(hooks)`
- Produces: `export function start(): void` (listener を張り、`/compose/` なら `x/ready` を送る。二度呼ぶと throw)、
  `export function stop(): void` (listener を外す。走っていなければ throw)。呼ぶのは driver だけ (判断メモ 15)

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/x.test.ts` の import の並び

```typescript
import { beforeEach, describe, expect, test, vi } from "vitest";
```

を次に置き換える。

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Message } from "@/shared/messages";
```

同じファイルの `describe("attachPayload", () => {` の中の最後の test「二度呼んでも積み上がらない」の閉じ括弧 `});` の後、
`describe("attachPayload")` を閉じる `});` の前に次を足す (外側の `beforeEach` が用意する ClipboardEvent / DataTransfer /
`input.files` と、`payload` / `buildComposePage` を使うため、この describe の中に置く)。

```typescript
  describe("オン / オフ (start / stop。マスタースイッチの spec §5)", () => {
    type RuntimeListener = (
      message: Message,
      sender: unknown,
      sendResponse: (response?: unknown) => void,
    ) => void;
    let runtimeListeners: RuntimeListener[] = [];
    let sendMessage = vi.fn(async (_message: Message) => undefined);

    /**
     * chrome を stub してから x.ts を読み直す (vitest はモジュールを覚えているので resetModules で捨てる)。
     * 保存されたオン / オフは enabled
     */
    async function loadX(enabled: boolean): Promise<typeof import("@/content/x")> {
      runtimeListeners = [];
      sendMessage = vi.fn(async (_message: Message) => undefined);
      vi.stubGlobal("chrome", {
        runtime: {
          sendMessage,
          onMessage: {
            addListener: (fn: RuntimeListener): void => {
              runtimeListeners.push(fn);
            },
            removeListener: (fn: RuntimeListener): void => {
              runtimeListeners = runtimeListeners.filter((listener) => listener !== fn);
            },
          },
        },
        storage: {
          local: { get: async (): Promise<Record<string, unknown>> => ({ enabled }) },
          onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
        },
      });
      vi.resetModules();
      return import("@/content/x");
    }

    async function flushTimers(): Promise<void> {
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    beforeEach(() => {
      history.pushState({}, "", "/compose/post");
    });

    afterEach(() => {
      history.pushState({}, "", "/");
    });

    test("オフのまま読み込むと x/ready を送らず、listener も張らない (import 時には何もしない)", async () => {
      await loadX(false);
      await flushTimers();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(runtimeListeners).toHaveLength(0);
    });

    test("オンで読み込むと、/compose/ なら x/ready を送り listener を張る", async () => {
      await loadX(true);
      await flushTimers();
      expect(sendMessage).toHaveBeenCalledWith({ type: "x/ready" });
      expect(runtimeListeners).toHaveLength(1);
    });

    test("start は /compose/ でなければ x/ready を送らない", async () => {
      const x = await loadX(false);
      await flushTimers();
      history.pushState({}, "", "/home");
      x.start();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(runtimeListeners).toHaveLength(1);
      x.stop();
    });

    test("stop で listener が外れ、外し損ねた listener に x/payload が届いても何もしない", async () => {
      const x = await loadX(false);
      await flushTimers();
      x.start();
      const listener = runtimeListeners[0];
      x.stop();
      expect(runtimeListeners).toHaveLength(0);

      const editor = buildComposePage("");
      const respond = vi.fn();
      listener?.({ type: "x/payload", ...payload }, {}, respond);
      await flushTimers();
      expect(respond).not.toHaveBeenCalled();
      expect(readBlocks(editor)).toBe("");
    });

    test("進行中の attachPayload は stop 後も完了して x/attached を送る (半端な本文を残さない)", async () => {
      const x = await loadX(false);
      await flushTimers();
      x.start();
      sendMessage.mockClear();
      const editor = buildComposePage("");

      runtimeListeners[0]?.({ type: "x/payload", ...payload }, {}, () => undefined);
      x.stop();

      await vi.waitFor(
        () => expect(sendMessage).toHaveBeenCalledWith({ type: "x/attached" }),
        { timeout: 5_000 },
      );
      expect(readBlocks(editor)).toBe(payload.text);
    });

    test("start を二度呼ぶ・走っていないのに stop を呼ぶのは配線の誤りなので throw", async () => {
      const x = await loadX(false);
      await flushTimers();
      expect(() => x.stop()).toThrow("走っていない");
      x.start();
      expect(() => x.start()).toThrow("二度");
      x.stop();
    });
  });
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/x.test.ts` (Bash の timeout 120000)
期待: FAIL (オンで読み込む項目と start / stop の項目。`x.start is not a function`、今は import 時に x/ready を送るので「オフのまま読み込むと」も落ちる)

- [ ] **Step 3: 最小実装**

`src/content/x.ts` の import の並び

```typescript
import { baseMimeType } from "@/content/codec";
import { X_SELECTORS } from "@/content/selectors";
import { decodeBase64 } from "@/shared/base64";
import type { Message } from "@/shared/messages";
```

を次に置き換える。

```typescript
import { baseMimeType } from "@/content/codec";
import { X_SELECTORS } from "@/content/selectors";
import { createSwitchDriver } from "@/content/switch-driver";
import { decodeBase64 } from "@/shared/base64";
import type { Message } from "@/shared/messages";
```

同じファイルの末尾の次のブロック (294〜318 行目)

```typescript
if (typeof chrome !== "undefined") {

  /**
   * **同期で `sendResponse()` を返すこと。** 応答しないと送り手の Promise は
   * `The message port closed before a response was received.` で reject し、
   * 受け取って添付を進めていることが「投稿タブが居ない」と区別できなくなる
   * (service worker がダウンロード誘導へ退避してしまう)。
   * `return true` にして添付の完了後に応答するのも不可 — 送り手は直列 queue の
   * 中で待つため、その間 router 全体が止まる。添付の結果は `x/attached` /
   * `x/failed` で別途知らせる。
   */
  chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    if (message.type !== "x/payload") return;
    sendResponse();

    void attachPayload(message);
  });

  // 投稿画面が開かれたことを service worker に知らせる
  if (location.pathname.startsWith("/compose/")) {
    notify({ type: "x/ready" });
  }
}
```

を次に置き換える。

```typescript
/** start() から stop() までの間か (マスタースイッチの spec §5) */
let running = false;

/**
 * **同期で `sendResponse()` を返すこと。** 応答しないと送り手の Promise は
 * `The message port closed before a response was received.` で reject し、
 * 受け取って添付を進めていることが「投稿タブが居ない」と区別できなくなる
 * (service worker がダウンロード誘導へ退避してしまう)。
 * `return true` にして添付の完了後に応答するのも不可 — 送り手は直列 queue の
 * 中で待つため、その間 router 全体が止まる。添付の結果は `x/attached` /
 * `x/failed` で別途知らせる。
 */
function onRuntimeMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): void {
  // 外し損ねたときの防御。stop() が外すので普段は来ない。オフなのに投稿画面へ本文と動画を入れない
  if (!running) return;
  if (message.type !== "x/payload") return;
  sendResponse();

  void attachPayload(message);
}

/**
 * オンにする (マスタースイッチの spec §5)。payload を受ける listener を張り、投稿画面なら開かれたことを service worker に
 * 知らせる。**オフの間は x/ready を送らない**: router が投稿を待っていても添付は始まらず、30 秒で「X にもう一度投稿」に落ちる
 * (オフなのに投稿画面に本文と動画が入る方がスイッチの意味に反する)。オンに戻したときに /compose/ を開いたままなら送り直す
 * (router は composing でないか送り済みなら無視する。二重送信の保護は今のまま)。
 * 呼ぶのは switch driver だけ (テストのために export する)。二度呼ぶのは配線の誤り
 */
export function start(): void {
  if (running) throw new Error("[yt-clip] start() を二度呼びました (配線の誤り)");
  running = true;
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  if (location.pathname.startsWith("/compose/")) {
    notify({ type: "x/ready" });
  }
}

/**
 * オフにする。listener を外すだけ (X のページの DOM には何も足していない)。**進行中の attachPayload は止めない**:
 * 途中でやめると半端な本文が投稿欄に残る。上限は要素待ち 10 秒 × 2 + paste の描画待ち 2 秒 × 2 で有限。終われば
 * x/attached / x/failed を送ってよい (router は composing でなければ拒む)。走っていないのに呼ぶのは配線の誤り
 */
export function stop(): void {
  if (!running) throw new Error("[yt-clip] 走っていないのに stop() を呼びました (配線の誤り)");
  running = false;
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
}

// content script は常に chrome 拡張コンテキストで読み込まれるため実行時は必ず true になるが、単体テスト (jsdom) は
// chrome グローバルを持たないため、import 時の読みが ReferenceError で落ちる。拡張コンテキスト外で読み込まれた場合に
// 安全側へ倒すガードとして扱う。**import 時にするのは、オン / オフを読んで見張ることだけ** (オンなら読んだ後に start)
if (typeof chrome !== "undefined") {
  createSwitchDriver({ start, stop });
}
```

同じファイルの `notify` の直後にある、行き場を失ったコメント

```typescript
// content script は常に chrome 拡張コンテキストで読み込まれるため実行時は必ず true になるが、
// 単体テスト (jsdom) は chrome グローバルを持たないため import 時点の副作用が
// ReferenceError で落ちる。テストのために振る舞いを変えるのではなく、
// 拡張コンテキスト外で読み込まれた場合に安全側へ倒すガードとして扱う。
```

は消す (同じ内容を末尾のガードの直前に移した)。

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/x.test.ts` (Bash の timeout 120000)
期待: PASS (既存の検査も含めてすべて)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/x.ts tests/content/x.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): X の投稿画面もオン / オフに従う

オフなのに投稿画面へ本文と動画が入るとスイッチの意味に反するので、
import 時に送っていた x/ready と payload の listener をオンの間だけにする。
オフの間に投稿を待っていた状態機械は 30 秒で「X にもう一度投稿」に落ち、
クリップは残る。進行中の添付は止めない (途中でやめると半端な本文が残る)。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 7: YouTube の content script を start / stop に分ける (`src/content/youtube.ts`)

**Files:**
- Modify: `src/content/youtube.ts` (import 23〜57 行目、`telopPreview` 154〜155 行目、3 つの窓とドック枠 178〜246 行目、`handle` 310 行目の後、
  `send` 319〜342 行目、`seekAndPlay` 878〜890 行目、`watchPlayhead` 1908〜1926 行目、`playerObserver` 1939〜1942 行目、`onMessage` の listener
  2018〜2073 行目、`recoverFromState` 2089〜2108 行目、`loadInitialSettings` 2122〜2132 行目、`loadInitialLayout` 2142〜2167 行目、末尾 2169〜2232 行目)
- Create: `tests/content/youtube-off-load.test.ts`
- Modify: `tests/content/youtube.test.ts` (stub・helper・`beforeAll`・末尾に describe)
- Modify: `tests/content/youtube-dock-load.test.ts` (stub の `local.get` と `onChanged`。140〜150 行目)
- Test: `tests/content/dock.test.ts` (末尾に describe。特性テスト)

**Interfaces:**
- Consumes: Task 3 の `createSwitchDriver({ start, stop })`
- Produces (Task 8 が使う):
  - `export function start(): void` / `export function stop(): void` (youtube.ts。二度の start・走っていない stop は throw)
  - モジュール変数 `running: boolean`・`runId: number`・`function isCurrentRun(id: number): boolean` (判断メモ 7)
  - `function onRuntimeMessage(message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): void`
  - `function resetModuleState(): void` (Task 8 が `capturing = false` を足す)
  - テストの helper: `setEnabled(value: boolean): void`・`storedEnabled`・`storageListeners`・`ourElements(): number`・`settleMicrotasks()` (youtube.test.ts)

- [ ] **Step 1: 既存テストの stub を直す (判断メモ 17)**

`tests/content/youtube.test.ts` の `flush` の直後 (`async function flush()` の閉じ括弧の後) に次を足す。

```typescript
/**
 * マイクロタスクだけを流す (setTimeout は進めない)。保存されたオン / オフの読みは返り、service worker 役の応答
 * (setTimeout の後) はまだ返らない
 */
async function settleMicrotasks(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await Promise.resolve();
  }
}
```

同じファイルの次の宣言と関数 (253〜260 行目)

```typescript
/** chrome.storage.sync が返す設定。テストごとに差し替える */
let storedSettings: Record<string, unknown> = {};
let storageListener: StorageListener | null = null;

/** 別のタブで設定が変わったことを届ける */
function changeSettings(next: Record<string, unknown>): void {
  storedSettings = next;
  storageListener?.({ settings: { newValue: next } }, "sync");
}
```

を次に置き換える。

```typescript
/** chrome.storage.sync が返す設定。テストごとに差し替える */
let storedSettings: Record<string, unknown> = {};
/**
 * chrome.storage.onChanged に張られた listener。オンの間は 2 本 (設定の sync を見る youtube.ts と、スイッチを見る
 * switch-driver)、オフの間はスイッチの 1 本だけ
 */
let storageListeners: StorageListener[] = [];

/** 別のタブで設定が変わったことを届ける */
function changeSettings(next: Record<string, unknown>): void {
  storedSettings = next;
  for (const listener of [...storageListeners]) listener({ settings: { newValue: next } }, "sync");
}

/** chrome.storage.local の enabled (マスタースイッチ)。undefined = キーが無い = オン */
let storedEnabled: unknown = undefined;

/** popup でオン / オフを切り替えたことを届ける (chrome.storage.local の enabled の onChanged) */
function setEnabled(value: boolean): void {
  storedEnabled = value;
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: value } }, "local");
}
```

同じファイルの stub の `local` と `onChanged` (379〜400 行目)

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
      // 別のタブで設定を変えられたときに拾う経路
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListener = fn;
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: TabListener): void => {
          onMessage = fn;
        },
      },
```

を次に置き換える。

```typescript
      // 窓の位置 (window-layout.ts) とオン / オフ (master-switch.ts)。窓の位置の読み込み時の 1 回は layoutGate が
      // 離されるまで返さない。**オン / オフは門を通さない**: 止めると start() も止まり、「覚えた位置を読み込む前は
      // 窓を出さない」を確かめる前に窓そのものが無い
      local: {
        get: async (key?: string): Promise<Record<string, unknown>> => {
          if (key === "enabled") {
            return storedEnabled === undefined ? {} : { enabled: storedEnabled };
          }
          await layoutGate;
          return storedLayout === undefined ? {} : { windowLayout: storedLayout };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          storedLayout = items.windowLayout;
          layoutWrites.push(items.windowLayout);
        },
      },
      // 別のタブで設定を変えられたときと、オン / オフを切り替えたときに拾う経路
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListeners.push(fn);
        },
        removeListener: (fn: StorageListener): void => {
          storageListeners = storageListeners.filter((listener) => listener !== fn);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn: TabListener): void => {
          onMessage = fn;
        },
        // オフにすると外す (stop)。外した後は deliver が届けない
        removeListener: (fn: TabListener): void => {
          if (onMessage === fn) onMessage = null;
        },
      },
```

同じファイルの `overlay()` の直後 (`function overlay()` の閉じ括弧の後) に次を足す。

```typescript
/** 拡張が足した要素の数 (マスタースイッチの spec §1 の測り方。窓・ドック枠・帯・プレビューの canvas を覆う) */
function ourElements(): number {
  return document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length;
}
```

同じファイルの `beforeAll` の次の行

```typescript
  // chrome を用意してから読み込む。import 時に listener と observer を張る
  await import("@/content/youtube");
```

を次に置き換える。

```typescript
  // chrome を用意してから読み込む。import 時にはページに触らず、保存されたオン / オフ (無い = オン) を読んだ後に
  // start() が listener と observer を張る。読みはマイクロタスクで返るので流して待つ (応答はまだ返らない)
  await import("@/content/youtube");
  await settleMicrotasks();
```

`tests/content/youtube-dock-load.test.ts` の stub (140〜150 行目)

```typescript
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
```

を次に置き換える。

```typescript
      local: {
        get: async (key?: string): Promise<Record<string, unknown>> => {
          // オン / オフ (無い = オン) は門を通さない。止めると start() も止まり、「読み込むまでは枠も窓も出さない」を
          // 確かめる前に窓そのものが無い
          if (key === "enabled") return {};
          await layoutGate;
          return { windowLayout: LAYOUT_AT_LOAD };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          layoutWrites.push(items.windowLayout);
        },
      },
      onChanged: { addListener: (): void => undefined, removeListener: (): void => undefined },
```

同じファイルの `runtime.onMessage` の stub

```typescript
      onMessage: {
        addListener: (fn: typeof onMessage): void => {
          onMessage = fn;
        },
      },
```

を次に置き換える。

```typescript
      onMessage: {
        addListener: (fn: typeof onMessage): void => {
          onMessage = fn;
        },
        removeListener: (): void => undefined,
      },
```

- [ ] **Step 2: 失敗するテストを書く (youtube.test.ts)**

`tests/content/youtube.test.ts` の末尾に次を足す。

```typescript
describe("オン / オフ (マスタースイッチ)", () => {
  /** テロップ付きの ready。エディットモードならプレビューの canvas が video の親に付く */
  const READY_WITH_TELOP: ClipState = {
    kind: "ready",
    segments: [RANGE],
    telops: [{ startSec: 11, endSec: 13, text: "テロップ" }],
    meta: META_A,
  };

  // 前の describe (「ドック枠とタブ」) の枠の中身を持ち越さない (判断メモ 34)。jsdom では差す先の幅が 0 なので枠は
  // 使えず、3 つとも浮いた窓 (退避) で出る。「フロートの窓」と同じ作法
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(listHeader());
    dblclick(settingsHeader());
    await flush();
  });

  afterEach(async () => {
    // モジュールは 1 回だけ読み込んで使い回しているので、次のテストのためにオンへ戻す
    if (storedEnabled === false) {
      setEnabled(true);
      await flush();
    }
  });

  test("オフにすると窓・ドック枠・シークバーの帯・プレビューの canvas が消え、YouTube の要素の中に何も残らない", async () => {
    changeSettings({ mode: "edit" });
    emit(READY_WITH_TELOP);
    await flush();
    // 前提: 帯と canvas と枠が出ている
    expect(overlay()).not.toBeNull();
    expect(document.getElementById("yt-clip-telop-preview")).not.toBeNull();
    expect(document.getElementById("yt-clip-dock-below")).not.toBeNull();

    setEnabled(false);
    await flush();

    expect(ourElements()).toBe(0);
    expect(document.querySelector(".ytp-progress-bar")?.childElementCount).toBe(0);
    expect(video.element.parentElement?.querySelector("canvas") ?? null).toBeNull();
    expect(document.getElementById("below")?.childElementCount).toBe(0);
    expect(document.getElementById("secondary-inner")?.childElementCount).toBe(0);
  });

  test("オフにすると observer・document と window の listener・再生位置の rAF・onMessage と設定の onChanged を外す (スイッチの見張りは残す)", async () => {
    const mutationDisconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const resizeDisconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    try {
      expect(onMessage).not.toBeNull();
      expect(storageListeners).toHaveLength(2);

      setEnabled(false);
      await flush();

      // body の子孫の監視とテーマ (<html dark>) の監視
      expect(mutationDisconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
      // プレイヤーの大きさの監視 (とプレビューの canvas の追従)
      expect(resizeDisconnect).toHaveBeenCalled();
      expect(documentRemove).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
      expect(windowRemove).toHaveBeenCalledWith("resize", expect.any(Function));
      // 再生位置を拡大バーへ流すループ
      expect(cancelFrame).toHaveBeenCalled();
      expect(onMessage).toBeNull();
      // 残るのはスイッチの見張り (switch-driver) の 1 本だけ
      expect(storageListeners).toHaveLength(1);
    } finally {
      mutationDisconnect.mockRestore();
      resizeDisconnect.mockRestore();
      documentRemove.mockRestore();
      windowRemove.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  test("外し損ねた onMessage に、オフの間に state/changed が届いても何も描かない", async () => {
    const listener = onMessage;
    setEnabled(false);
    await flush();

    listener?.(
      { type: "state/changed", state: { kind: "ready", segments: [RANGE], telops: [], meta: META_A } },
      {},
      () => undefined,
    );
    await flush();

    expect(ourElements()).toBe(0);
    expect(overlay()).toBeNull();
  });

  test("オフの間に設定が変わっても (sync の onChanged) 何もしない", async () => {
    setEnabled(false);
    await flush();
    sent = [];

    changeSettings({ mode: "edit" });
    await flush();

    expect(ourElements()).toBe(0);
    expect(sent).toEqual([]);
  });

  test("オンに戻すと、読み込み直さずに窓が出て content/loaded を送り、応答の状態で範囲と帯が戻る", async () => {
    setEnabled(false);
    await flush();
    swState = { kind: "ready", segments: [RANGE], telops: [], meta: META_A };
    sent = [];

    setEnabled(true);
    await flush();

    expect(sent).toContainEqual({ type: "content/loaded" });
    expect(statusText()).toBe("0:10 〜 0:20 (10秒)");
    expect(overlay()).not.toBeNull();
    expect(barWindowElement().hidden).toBe(false);
    expect(onMessage).not.toBeNull();
    expect(storageListeners).toHaveLength(2);
  });

  test("オフ → オンで覚えた配置を読み直し、動かした窓は同じ位置に出る", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    drag(listHeader(), -100, 20);
    await flush();
    const moved = styleRect(listElement());

    setEnabled(false);
    await flush();
    setEnabled(true);
    await flush();

    // 区間があるので区間・テロップの窓が出る (content/loaded の応答の ready で)
    expect(listElement().hidden).toBe(false);
    expect(listElement().parentElement).toBe(document.body);
    expect(styleRect(listElement())).toEqual(moved);
  });

  test("オンにした直後にオフにすると、遅れて届いた応答と覚えた配置の読みで窓も帯も出さない", async () => {
    setEnabled(false);
    await flush();
    swState = { kind: "ready", segments: [RANGE], telops: [], meta: META_A };

    setEnabled(true);
    // content/loaded の応答 (setTimeout の後) と覚えた配置の読みが返る前に切る
    setEnabled(false);
    await flush();

    expect(ourElements()).toBe(0);
  });

  test("範囲の再生を押した直後にオフにすると、再生も範囲の監視 (rVFC) も始めない", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    const play = vi.spyOn(video.element, "play");
    try {
      clickButton("▶ 範囲を見る");
      // seek の完了 (setTimeout の後) を待たずに切る
      setEnabled(false);
      await flush();

      expect(play).not.toHaveBeenCalled();
      expect(video.pendingFrames()).toBe(0);
    } finally {
      play.mockRestore();
    }
  });

  test("start() を二度呼ぶ・走っていないのに stop() を呼ぶのは配線の誤りなので throw", async () => {
    const content = await import("@/content/youtube");
    expect(() => content.start()).toThrow("二度");

    setEnabled(false);
    await flush();
    expect(() => content.stop()).toThrow("走っていない");
  });
});
```

- [ ] **Step 3: 失敗するテストを書く (オフのまま読み込む)**

`tests/content/youtube-off-load.test.ts` を作る (判断メモ 18)。

```typescript
// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Message } from "@/shared/messages";

/**
 * オフのまま動画ページで読み込まれた content script (マスタースイッチの spec §1 / §2.1)。
 *
 * youtube.ts は import した時点で保存されたオン / オフを読むので、オンで読ませる youtube.test.ts とは別のファイルにする
 * (vitest はファイルごとにモジュールを読み直す)。**オフなら何も呼ばない**: 要素・listener・observer・rAF・メッセージが 0 で、
 * 残るのは chrome.storage の読み 1 回と onChanged の listener 1 本だけ
 */

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

const sent: Message[] = [];
const storageListeners: StorageListener[] = [];
let messageListeners = 0;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function ourElements(): number {
  return document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length;
}

// import の前に張る (import 時に張られたものも数える)。どれも本物へ通す
const documentAdd = vi.spyOn(document, "addEventListener");
const windowAdd = vi.spyOn(window, "addEventListener");
const observe = vi.spyOn(MutationObserver.prototype, "observe");
const frame = vi.spyOn(window, "requestAnimationFrame");

beforeAll(async () => {
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
  // jsdom は ResizeObserver を持たない。オンにした項目 (start) が作る
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
      local: {
        get: async (key?: string): Promise<Record<string, unknown>> =>
          key === "enabled" ? { enabled: false } : {},
        set: async (): Promise<void> => undefined,
      },
      sync: {
        get: async (): Promise<Record<string, unknown>> => ({}),
        set: async (): Promise<void> => undefined,
      },
      onChanged: {
        addListener: (fn: StorageListener): void => {
          storageListeners.push(fn);
        },
        removeListener: (fn: StorageListener): void => {
          const index = storageListeners.indexOf(fn);
          if (index >= 0) storageListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (): void => {
          messageListeners += 1;
        },
        removeListener: (): void => {
          messageListeners -= 1;
        },
      },
      sendMessage: async (message: Message): Promise<{ state: { kind: "idle" } }> => {
        sent.push(message);
        return { state: { kind: "idle" } };
      },
    },
  });

  await import("@/content/youtube");
  await flush();
});

afterAll(async () => {
  // オンにした項目の後始末。オフにすれば observer も listener も外れる (以前は body を差し替えて終えていた)
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: false } }, "local");
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("オフのまま読み込む", () => {
  test("ページに何も足さず、YouTube の要素の中にも何も差さない", () => {
    expect(ourElements()).toBe(0);
    expect(document.getElementById("below")?.childElementCount).toBe(0);
    expect(document.getElementById("secondary-inner")?.childElementCount).toBe(0);
    expect(document.querySelector(".ytp-progress-bar")?.childElementCount).toBe(0);
  });

  test("document / window の listener・MutationObserver・rAF を張らない", () => {
    const documentTypes = documentAdd.mock.calls.map(([type]) => type);
    const windowTypes = windowAdd.mock.calls.map(([type]) => type);
    expect(documentTypes).not.toContain("fullscreenchange");
    expect(windowTypes).not.toContain("resize");
    expect(observe).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });

  test("service worker へ何も送らず、onMessage も張らない。storage の見張りはスイッチの 1 本だけ", () => {
    expect(sent).toEqual([]);
    expect(messageListeners).toBe(0);
    expect(storageListeners).toHaveLength(1);
  });

  test("オンに書き換わると start() が走り、窓を作って content/loaded を送る", async () => {
    for (const listener of [...storageListeners]) listener({ enabled: { newValue: true } }, "local");
    await flush();

    expect(sent).toContainEqual({ type: "content/loaded" });
    expect(messageListeners).toBe(1);
    expect(document.getElementById("yt-clip-bar-window")).not.toBeNull();
    expect(document.getElementById("yt-clip-dock-below")?.parentElement?.id).toBe("below");
  });
});
```

- [ ] **Step 4: ドック枠の destroy の特性テストを書く (判断メモ 10)**

`tests/content/dock.test.ts` の末尾に次を足す。

```typescript
describe("destroy (マスタースイッチのオフ)", () => {
  test("ドラッグの最中 (目印を出している) でも、2 つの枠の根ごと目印・タブの列・入っている窓を外す", () => {
    const { manager, windows } = setup();
    manager.dock("list", "side");
    // 設定の窓のドラッグを始める。空の下の枠に 40px の目印が出る
    manager.drag("settings", "start", AWAY);
    expect(markerOf("below").style.display).not.toBe("none");

    manager.destroy();

    expect(document.querySelectorAll('[id^="yt-clip-dock-"], [data-role^="dock-"]').length).toBe(0);
    // ドック中の窓は枠の根と一緒に外れる (youtube.ts の stop は枠を窓より先に destroy する)
    expect(windows.list.element.isConnected).toBe(false);
  });
});
```

- [ ] **Step 5: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-off-load.test.ts tests/content/dock.test.ts tests/content/youtube-dock-load.test.ts` (Bash の timeout 120000)
期待:
- `tests/content/dock.test.ts` は PASS (特性テスト。今のコードのまま通る。判断メモ 10)
- `tests/content/youtube-off-load.test.ts` は FAIL (import 時に窓を作り listener を張る)
- `tests/content/youtube.test.ts` は新しい describe「オン / オフ (マスタースイッチ)」の項目が FAIL (オフにしても何も外れない・`content.start is not a function`)。
  **既存の項目は PASS のまま** (stub を直しただけで、import 時に start 相当が走っている)
- `tests/content/youtube-dock-load.test.ts` は PASS のまま

- [ ] **Step 6: import を直す**

`src/content/youtube.ts` の次の import

```typescript
import { createDockManager } from "@/content/dock";
```

```typescript
import {
  PANEL_HEADER_HEIGHT_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
} from "@/content/panel-window";
```

```typescript
import { createTelopPreview } from "@/content/telop-preview";
```

```typescript
import { YT_SELECTORS } from "@/content/selectors";
```

をそれぞれ次に置き換える。

```typescript
import { createDockManager, type DockManager } from "@/content/dock";
```

```typescript
import {
  PANEL_HEADER_HEIGHT_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
  type PanelWindow,
} from "@/content/panel-window";
```

```typescript
import { createTelopPreview, type TelopPreview } from "@/content/telop-preview";
```

```typescript
import { YT_SELECTORS } from "@/content/selectors";
import { createSwitchDriver } from "@/content/switch-driver";
```

- [ ] **Step 7: import 時に作っていた窓・ドック枠・プレビューを `let` にし、`createWindows()` へ移す (判断メモ 6)**

`src/content/youtube.ts` の次 (154〜155 行目)

```typescript
/** プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため) */
const telopPreview = createTelopPreview();
```

を次に置き換える。

```typescript
/**
 * プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため)。
 * **オンの間だけある** (マスタースイッチの spec §2.1): start() が作り、stop() が destroy する (canvas・video の seeked・
 * rVFC・ResizeObserver を外す)。`!` の意味は下の listWindow と同じ
 */
let telopPreview!: TelopPreview;
```

同じファイルの次 (178〜246 行目。`floatLayout` の宣言の直後の「区間・テロップの窓。…」の doc から、ドック枠の配色を当てる `for` の行まで)

```typescript
/**
 * 区間・テロップの窓。区間の一覧とテロップの一覧を入れる (窓の分割の spec C1.1)。
 *
 * **1 つを使い回す。** 窓の位置を持つので、バーを作り直すたびに作り直さない。中身の入れ替えは
 * `buildBar`、body への付け直しは `mount`、出すかの判定は `refreshWindows` が行う
 */
const listWindow = createPanelWindow({
```

(上は範囲の最初の 7 行。範囲の最後の行 (246 行目) は次の行。範囲の中身 (`listWindow` / `settingsWindow` / `barWindow` / `dockManager` を作って
配色を当てる処理とその doc) は、すべて下の `createWindows()` と宣言に移す)

```typescript
for (const slot of Object.values(dockManager.elements)) applyPalette(slot, isDarkTheme());
```

を次に置き換える。

```typescript
/**
 * 区間・テロップの窓。区間の一覧とテロップの一覧を入れる (窓の分割の spec C1.1)。
 *
 * **オンの間は 1 つを使い回す。** 窓の位置を持つので、バーを作り直すたびに作り直さない。中身の入れ替えは
 * `buildBar`、body への付け直しは `mount`、出すかの判定は `refreshWindows` が行う。
 *
 * **オンの間だけある** (マスタースイッチの spec §2.1)。start() の createWindows が作り、stop() が destroy する。
 * `!` は「start() が必ず先に作る」の意味: 触る経路 (mount・refreshWindows・listener) はすべて start() の中か、start() が
 * 張った listener から呼ばれる。stop() の後に古い参照へ触る非同期の続きは isCurrentRun で断つ (判断メモ 6・7)
 */
let listWindow!: PanelWindow;
/**
 * 設定の窓。設定パネル (`settings-panel.ts`) を入れ、⚙ で開閉する (C1.2)。**閉じるボタン (×) は
 * 置かない** (右側パネルの spec で不採用にしたのと同じ。閉じ方を ⚙ の 1 つにする)。使い回すのは
 * 区間・テロップの窓と同じ理由。オンの間だけあるのも同じ
 */
let settingsWindow!: PanelWindow;
/**
 * バーの窓。拡大バーと操作の行 (中身の根 #yt-clip-bar) を入れる。
 *
 * **オンの間は 1 つを使い回す** (spec A.3)。モードを変えてバーを作り直しても窓は作り直さないので、
 * 位置と大きさは変わらない。見出しの行は作らず、操作の行の左端のつまみ (⠿) で動かす
 * (見出しの行ぶん高くなると、1440x795 でプレイヤーの下端を覆うため。spec A.1)。オンの間だけあるのも同じ
 */
let barWindow!: FloatingWindow;
/**
 * ページの中のドック枠 2 か所 (プレイヤーの下・おすすめ動画の上) とタブ (窓の分割の spec C2)。
 * **枠の中だけを持つ**: 窓を出す条件は refreshWindows、浮いた窓の位置は placeInitial / placeUnderPointer が決める。
 * オンの間だけあるのも同じ (枠は #below / #secondary-inner に差さるので、オフのページには残さない)
 */
let dockManager!: DockManager;

/**
 * 3 つの窓とドック枠を作る (start() の最初)。**import 時には作らない**: createFloatingWindow は window の resize を張り、
 * ドック枠は mount で YouTube の要素に差さる。オフで読み込まれたページにはどれも残さない (マスタースイッチの spec §1)
 */
function createWindows(): void {
  listWindow = createPanelWindow({
    id: LIST_WINDOW_ID,
    title: WINDOW_TITLES.list,
    onUserMove: (rect) => rememberWindowRect("list", rect),
    onResetRequest: () => resetWindow("list"),
    // 見出しのドラッグの落とし先の当たり判定 (C2.3)。枠に引き取られたら onUserMove は来ない
    onDragPoint: (phase, point) => dockManager.drag("list", phase, point) !== null,
  });
  // 窓は body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
  applyPalette(listWindow.element, isDarkTheme());
  settingsWindow = createPanelWindow({
    id: SETTINGS_WINDOW_ID,
    title: WINDOW_TITLES.settings,
    onUserMove: (rect) => rememberWindowRect("settings", rect),
    onResetRequest: () => resetWindow("settings"),
    onDragPoint: (phase, point) => dockManager.drag("settings", phase, point) !== null,
  });
  applyPalette(settingsWindow.element, isDarkTheme());
  barWindow = createFloatingWindow({
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
  dockManager = createDockManager({
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
}
```

- [ ] **Step 8: 走っているかと回の番号を足す (判断メモ 7・12)**

`src/content/youtube.ts` の次の行 (310 行目)

```typescript
let handle: RecorderHandle | null = null;
```

の後に、空行を 1 つ挟んで次を足す。

```typescript
/** start() から stop() までの間か (マスタースイッチの spec §2.1)。二度の start()・走っていない stop() を見分ける */
let running = false;
/**
 * start() と stop() のたびに進める回の番号。**非同期の続き (storage の読み・service worker の応答・seek の完了) は、
 * 始めたときの番号と今の番号が同じときだけ画面と動画に触る** (isCurrentRun)。オフにした後や、オフ → オンで作り直した後に
 * 古い続きが届いて、片付けた窓を描き直す・帯を差す・再生を始める・監視を張る、をしない (オフの間は 0。spec §1。判断メモ 7)
 */
let runId = 0;

/** 続きを始めたときの番号 id が、今走っている回のものか */
function isCurrentRun(id: number): boolean {
  return running && id === runId;
}
```

- [ ] **Step 9: `send` の続きを断つ**

`src/content/youtube.ts` の `send` の本体 (319〜342 行目)

```typescript
function send(
  event: ClipEvent,
  accepted?: (state: ClipState) => boolean,
): void {
  void chrome.runtime
    .sendMessage({ type: "clip/event", event } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (response === undefined) {
```

を次に置き換える (`.then` の中の残りはそのまま)。

```typescript
function send(
  event: ClipEvent,
  accepted?: (state: ClipState) => boolean,
): void {
  // 応答が届くまでにオフにした・作り直したら、画面に触らない (isCurrentRun の doc)
  const id = runId;
  void chrome.runtime
    .sendMessage({ type: "clip/event", event } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (!isCurrentRun(id)) return;
      if (response === undefined) {
```

同じ関数の `.catch`

```typescript
    .catch((error: unknown) => {
      setStatus(`操作を送信できませんでした: ${String(error)}`);
    });
}
```

を次に置き換える。

```typescript
    .catch((error: unknown) => {
      if (!isCurrentRun(id)) return;
      setStatus(`操作を送信できませんでした: ${String(error)}`);
    });
}
```

- [ ] **Step 10: `seekAndPlay` の続きを断つ**

`src/content/youtube.ts` の `seekAndPlay` (878〜890 行目)

```typescript
async function seekAndPlay(sec: number): Promise<HTMLVideoElement | null> {
  try {
    // getVideo() を try の外に置くと、同期的な throw が Promise の拒否になり、
    // 呼び出し元の `void ...` で握り潰されてボタンが無反応に見える
    const video = getVideo();
    await seekTo(video, sec);
    await startPlayback(video);
    return video;
  } catch (error) {
    setStatus(`再生できませんでした: ${String(error)}`);
    return null;
  }
}
```

を次に置き換える。

```typescript
async function seekAndPlay(sec: number): Promise<HTMLVideoElement | null> {
  const id = runId;
  try {
    // getVideo() を try の外に置くと、同期的な throw が Promise の拒否になり、
    // 呼び出し元の `void ...` で握り潰されてボタンが無反応に見える
    const video = getVideo();
    await seekTo(video, sec);
    // seek を待つ間にオフにしたら、再生を始めない。null を返すので、呼び出し側 (playRange) も範囲の監視 (rVFC) を
    // 張らない (オフの間は video に触らない。spec §1)。始めてしまった seek は止められない
    if (!isCurrentRun(id)) return null;
    await startPlayback(video);
    if (!isCurrentRun(id)) return null;
    return video;
  } catch (error) {
    if (!isCurrentRun(id)) return null;
    setStatus(`再生できませんでした: ${String(error)}`);
    return null;
  }
}
```

- [ ] **Step 11: 再生位置のループに止める口を足す (判断メモ 9)**

`src/content/youtube.ts` の次の宣言 (299〜300 行目)

```typescript
/** 再生位置の監視を張ったか。mount は DOM 変化のたびに呼ばれる */
let playheadWatched = false;
```

を次に置き換える。

```typescript
/** 再生位置の監視を張ったか。mount は DOM 変化のたびに呼ばれる */
let playheadWatched = false;
/** 再生位置のループの rAF の handle。止めるのは stop() (オフの間に rAF を残さない。spec §1) */
let playheadFrame = 0;
```

同じファイルの `watchPlayhead` (1908〜1926 行目。doc の「再生位置を拡大バーへ流し続ける。」から関数の閉じ括弧まで)

```typescript
function watchPlayhead(): void {
  const step = (): void => {
    try {
      rangeBar?.setPlayhead(getVideo().currentTime);
    } catch {
      // 動画要素がまだ無いか差し替えの最中。位置を示しようがないので消す。
      // ここで投げると監視が止まり、以降ずっと更新されなくなる
      rangeBar?.setPlayhead(null);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
```

を次に置き換える (doc はそのまま)。

```typescript
function watchPlayhead(): void {
  const step = (): void => {
    try {
      rangeBar?.setPlayhead(getVideo().currentTime);
    } catch {
      // 動画要素がまだ無いか差し替えの最中。位置を示しようがないので消す。
      // ここで投げると監視が止まり、以降ずっと更新されなくなる
      rangeBar?.setPlayhead(null);
    }
    playheadFrame = requestAnimationFrame(step);
  };
  playheadFrame = requestAnimationFrame(step);
}

/**
 * 再生位置のループを止める (stop())。今までは止める口が無かった (content script はページと一緒に消えるだけだった)。
 * 次の start() の mount が張り直す
 */
function stopPlayheadWatch(): void {
  if (playheadFrame !== 0) cancelAnimationFrame(playheadFrame);
  playheadFrame = 0;
  playheadWatched = false;
}
```

- [ ] **Step 12: プレイヤーの大きさの監視を `let` にする**

`src/content/youtube.ts` の次 (1939〜1942 行目)

```typescript
/** 大きさを見ているプレイヤー。**SPA 遷移や再描画で要素が替わる**ので、mount のたびに確かめる */
let observedPlayer: Element | null = null;
/** プレイヤーの大きさの変化 (シアターモードの切り替えなど) を拾う */
const playerObserver = new ResizeObserver(() => placeUnmovedWindows());
```

を次に置き換える。

```typescript
/** 大きさを見ているプレイヤー。**SPA 遷移や再描画で要素が替わる**ので、mount のたびに確かめる */
let observedPlayer: Element | null = null;
/** プレイヤーの大きさの変化 (シアターモードの切り替えなど) を拾う。オンの間だけある (start() が作り、stop() が外す) */
let playerObserver!: ResizeObserver;
```

- [ ] **Step 13: `chrome.runtime.onMessage` の listener に名前を付ける (判断メモ 5)**

`src/content/youtube.ts` の次の行 (2029 行目。doc「service worker からの指示を受ける。…」はそのまま)

```typescript
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === "recorder/start") {
```

を次に置き換える。

```typescript
function onRuntimeMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): void {
  // 外し損ねたときの防御 (マスタースイッチの spec §8)。stop() が listener を外すので普段は来ない。来ても、片付けた
  // 窓・帯・canvas を描き直さない
  if (!running) return;
  if (message.type === "recorder/start") {
```

同じ listener の最後 (2070〜2073 行目)

```typescript
  if (state.kind === "recording") {
    void runRecording(state.segments);
  }
});
```

を次に置き換える。

```typescript
  if (state.kind === "recording") {
    void runRecording(state.segments);
  }
}
```

- [ ] **Step 14: 読み込みの続きを断つ**

`src/content/youtube.ts` の `recoverFromState` の本体 (2089〜2108 行目)

```typescript
function recoverFromState(): void {
  void chrome.runtime
    .sendMessage({ type: "content/loaded" } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (response === undefined) {
```

を次に置き換える (`.then` の中の残りはそのまま)。

```typescript
function recoverFromState(): void {
  // 応答が届くまでにオフにしたら画面に触らない (isCurrentRun の doc)
  const id = runId;
  void chrome.runtime
    .sendMessage({ type: "content/loaded" } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (!isCurrentRun(id)) return;
      if (response === undefined) {
```

同じ関数の `.catch`

```typescript
    .catch((error: unknown) => {
      // 拡張の再読み込み直後などは受け手が居ない。状態を取り戻せないだけで、
      // 次の state/changed で追いつくため、ここで操作を止める必要はない
      console.warn(`状態を取得できませんでした: ${String(error)}`);
    });
}
```

を次に置き換える。

```typescript
    .catch((error: unknown) => {
      // オフにした後の失敗はコンソールにも出さない (オフの間の出力は 0 行。spec §1)
      if (!isCurrentRun(id)) return;
      // 拡張の再読み込み直後などは受け手が居ない。状態を取り戻せないだけで、
      // 次の state/changed で追いつくため、ここで操作を止める必要はない
      console.warn(`状態を取得できませんでした: ${String(error)}`);
    });
}
```

同じファイルの `loadInitialSettings` の本体 (2122〜2132 行目)

```typescript
function loadInitialSettings(): void {
  void loadSettings()
    .then((settings) => {
      maxClipSec = settings.maxClipSec;
      applyTelopSettings(settings);
      applyMode(settings.mode);
    })
    .catch((error: unknown) => {
      console.warn(`設定を読めませんでした: ${String(error)}`);
    });
}
```

を次に置き換える。

```typescript
function loadInitialSettings(): void {
  // 読み終えるまでにオフにしたら、バーを作り直さない (applyMode は mount を呼ぶ)
  const id = runId;
  void loadSettings()
    .then((settings) => {
      if (!isCurrentRun(id)) return;
      maxClipSec = settings.maxClipSec;
      applyTelopSettings(settings);
      applyMode(settings.mode);
    })
    .catch((error: unknown) => {
      if (!isCurrentRun(id)) return;
      console.warn(`設定を読めませんでした: ${String(error)}`);
    });
}
```

同じファイルの `loadInitialLayout` の本体 (2142〜2167 行目)

```typescript
function loadInitialLayout(): void {
  void loadWindowLayout()
    .then((layout) => {
      // 枠の中身を先に入れる。窓を枠へ置くのは下の refreshWindows の sync (出す条件が決まってから)。
```

を次に置き換え (`.then` の中の残りはそのまま)、

```typescript
function loadInitialLayout(): void {
  // 読み終えるまでにオフにしたら、窓を置かない・出さない (layoutReady を立てると refreshWindows が窓を出す)
  const id = runId;
  void loadWindowLayout()
    .then((layout) => {
      if (!isCurrentRun(id)) return;
      // 枠の中身を先に入れる。窓を枠へ置くのは下の refreshWindows の sync (出す条件が決まってから)。
```

同じ関数の `.catch` と `.finally`

```typescript
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

を次に置き換える。

```typescript
    .catch((error: unknown) => {
      if (!isCurrentRun(id)) return;
      // 窓を置けないのは想定外。それでも出さないままにはしない (spec A.2)
      console.warn(`覚えた窓の位置を使えませんでした: ${String(error)}`);
    })
    .finally(() => {
      if (!isCurrentRun(id)) return;
      layoutReady = true;
      refreshWindows();
    });
}
```

- [ ] **Step 15: 末尾の import 時の処理を start / stop へ移す**

`src/content/youtube.ts` の末尾 (2169〜2232 行目。「// 設定は**別のタブで変えられる**。…」のコメントから、最後の `recoverFromState();` まで)

```typescript
// 設定は**別のタブで変えられる**。保存ボタンに繋ぐだけでは、開いたままの
// タブが古い上限のまま残り、そのタブでだけ録画の長さが違うことになる。
//
// **通知が新しい値を持っているので読み直さない。** ここで loadSettings すると、
// 設定を 1 回保存するたびに、開いている YouTube タブの数だけ storage を
// 往復することになる (書いた当のタブでも発火する)
chrome.storage.onChanged.addListener((changes, areaName) => {
```

(上は範囲の最初の 7 行。範囲はファイルの最後の 5 行 (次のとおり) で終わる。範囲の中身 (設定の onChanged の listener・`lastHref`・テーマの監視・
`fullscreenchange` と `resize` の listener・body の監視・import 時の `mount()` と 3 つの読み込み) は、すべて下の関数と `start()` に移す)

```typescript
observer.observe(document.body, { childList: true, subtree: true });
mount();
loadInitialSettings();
loadInitialLayout();
recoverFromState();
```

を次に置き換える。

```typescript
/**
 * 設定は**別のタブで変えられる**。保存ボタンに繋ぐだけでは、開いたままの
 * タブが古い上限のまま残り、そのタブでだけ録画の長さが違うことになる。
 *
 * **通知が新しい値を持っているので読み直さない。** ここで loadSettings すると、
 * 設定を 1 回保存するたびに、開いている YouTube タブの数だけ storage を
 * 往復することになる (書いた当のタブでも発火する)。
 * オンの間だけ張る (start() が張り、stop() が外す)。スイッチの見張り (switch-driver) とは別の listener
 */
function onSettingsChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  const change = areaName === "sync" ? changes[SETTINGS_KEY] : undefined;
  if (change === undefined) return;
  const settings = mergeSettings(change.newValue);
  maxClipSec = settings.maxClipSec;
  applyTelopSettings(settings);
  applyMode(settings.mode);
}

/** 直前に見ていた URL。SPA 遷移の検出に使う。start() が読み直す */
let lastHref = location.href;

/**
 * テーマの切り替えに追従する。YouTube は <html dark> を付け外しするだけで
 * 画面を作り直さないため、DOM 変化の監視では拾えない
 */
function onThemeChanged(): void {
  const dark = isDarkTheme();
  const bar = document.getElementById(BAR_ID);
  if (bar !== null) applyPalette(bar, dark);
  // 3 つの窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(listWindow.element, dark);
  applyPalette(settingsWindow.element, dark);
  // ドック枠 (タブの列と目印) も自前の配色
  for (const slot of Object.values(dockManager.elements)) applyPalette(slot, dark);
}

/** テーマ (<html dark>) の監視。オンの間だけある */
let themeObserver!: MutationObserver;

/** YouTube は SPA 遷移するため DOM 変化を監視して再マウントする */
function onPageMutated(): void {
  if (location.href !== lastHref) {
    lastHref = location.href;
    // 別の動画へ移ったら、範囲も帯もこの画面のものではなくなる。帯を残すと
    // 旧動画の位置に青い帯が出たままになり、ハンドルを動かせてしまうと
    // 見えていない動画の範囲を書き換えることになる
    rangeBar?.setEnabled(canAdjustRange());
    refreshOverlay();
    refreshTelopPreview();
    // 一覧も同じ規則で描き直す。区間・テロップの窓に A の区間が B の画面で出続けないように。
    // 動画ページ以外へ移ったら、3 つの窓ごと隠れる (refreshWindows)
    refreshLists();
  }
  mount();
}

/** body の子孫の監視 (SPA 遷移と再描画)。オンの間だけある */
let pageObserver!: MutationObserver;

/**
 * モジュールの状態を最初の値に戻す (stop() の最後。spec §2.2)。**状態機械が正で、ここにあるのは写し**なので、戻しても
 * 失うものは無い (次の start() の content/loaded の応答と、覚えた配置の読み直しで取り戻す)。
 *
 * **設定から読んだ値 (mode / maxClipSec / telopStyle) は戻さない** (判断メモ 8)。start() の loadInitialSettings が読み直す
 * ので値は同じになる。mode を simple に戻すと、読み直しの applyMode が「モードが変わった」としてバーを作り直し、
 * content/loaded の応答が先に届いて区間を持っていると RESET_MARKS で区間を捨てる
 */
function resetModuleState(): void {
  currentSegments = [];
  currentTelops = [];
  recordingTelops = null;
  selectedIndex = -1;
  segmentList = null;
  telopList = null;
  settingsPanel = null;
  rangeBar = null;
  telopTrack = null;
  layoutReady = false;
  // 覚えた配置の写し。start() の loadInitialLayout が読み直す (オフの間に別のタブで動かした位置も拾う)
  for (const id of WINDOW_IDS) delete floatLayout[id];
  lastKind = "idle";
  pendingMode = null;
  selectLastOnNextState = false;
  revealLastTelopOnNextState = false;
  removedIndexOnNextState = null;
  rangeVideoId = null;
  busy = false;
  rangeEditable = false;
  cancelWatch = null;
  cancelPreview = null;
  handle = null;
  observedPlayer = null;
}

/**
 * オンにする (マスタースイッチの spec §2.3 の逆順)。今まで import 時に行っていた処理を、そのままここで行う:
 * 窓とドック枠と監視を作る → mount() → 設定の読み込み → 覚えた配置の読み込み → content/loaded (状態の取り戻し)。
 * **読み込み直さずにオンへ戻せる** (spec §2.4): content/loaded はタブのリロードと同じ経路で、応答の状態で範囲・帯・一覧が
 * 戻る。覚えた配置の読み込みが済むまで窓を出さない (spec A.2) のも今までと同じ。
 * 呼ぶのは switch driver だけ (テストのために export する。判断メモ 15)。二度呼ぶのは配線の誤り
 */
export function start(): void {
  if (running) throw new Error("[yt-clip] start() を二度呼びました (配線の誤り)");
  running = true;
  runId += 1;
  createWindows();
  telopPreview = createTelopPreview();
  playerObserver = new ResizeObserver(() => placeUnmovedWindows());
  // 状態の通知と設定の変更。stop() が先に外す (以後の通知で、片付けた要素を触りに行かない)
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  lastHref = location.href;
  themeObserver = new MutationObserver(onThemeChanged);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dark"],
  });
  // 全画面の間は 3 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる
  document.addEventListener("fullscreenchange", refreshWindows);
  // ブラウザの大きさが変わったら、動かしていない窓の最初の位置を取り直す (spec A.2)。
  // 動かした窓は置いた場所のまま (画面の外へ出る分は窓の枠が自分で詰める)
  window.addEventListener("resize", placeUnmovedWindows);
  pageObserver = new MutationObserver(onPageMutated);
  pageObserver.observe(document.body, { childList: true, subtree: true });
  mount();
  loadInitialSettings();
  loadInitialLayout();
  recoverFromState();
}

/**
 * オフにする (マスタースイッチの spec §2.2 / §2.3)。ページに足したもの・張った listener と監視・走っているループを
 * すべて外し、モジュールの状態を最初の値に戻す。**覚えた配置 (local の windowLayout) と設定 (sync の settings) は消さない**
 * (オフ → オンで窓は前と同じ位置・同じ枠に出る)。スイッチを見張る listener は switch driver が持つので残る。
 * 呼ぶのは switch driver だけ。走っていないのに呼ぶのは配線の誤り
 */
export function stop(): void {
  if (!running) throw new Error("[yt-clip] 走っていないのに stop() を呼びました (配線の誤り)");
  // 先に下ろす。この後に届く非同期の続き (storage の読み・応答・seek の完了) は isCurrentRun で何もしない (判断メモ 12)
  running = false;
  runId += 1;
  // 1. 範囲再生の監視・録画の監視・録画。このタブで録画が走っていないことは driver の canStop が保証する
  //    (spec §4.1)。ここで止まるのは範囲再生の監視だけのはず
  cancelPreviewWatch();
  cancelWatch?.();
  cancelWatch = null;
  abortRecording();
  // 2. 通知の listener を先に外す (以後の通知で、片付けた要素を触りに行かない)
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  chrome.storage.onChanged.removeListener(onSettingsChanged);
  // 3. 監視と listener とループ
  pageObserver.disconnect();
  themeObserver.disconnect();
  playerObserver.disconnect();
  document.removeEventListener("fullscreenchange", refreshWindows);
  window.removeEventListener("resize", placeUnmovedWindows);
  stopPlayheadWatch();
  // 4. YouTube の要素の中に差したもの: プレイヤーの上の canvas (video の seeked・rVFC・ResizeObserver も) とシークバーの帯
  telopPreview.destroy();
  clearOverlay();
  // 5. ドック枠 (中の窓ごと外れる) → 拡大バーと帯の段 (rAF と捕捉) → 3 つの窓 (resize の listener)。**枠を窓より先に**:
  //    ドック中の窓は枠の根の中にあり、窓の destroy は自分の要素しか外さない
  dockManager.destroy();
  rangeBar?.destroy();
  telopTrack?.destroy();
  barWindow.destroy();
  listWindow.destroy();
  settingsWindow.destroy();
  // 6. 写しを最初の値に戻す
  resetModuleState();
}

// オン / オフに合わせて start() / stop() を呼ぶ (マスタースイッチの spec §2.1)。**import 時にするのはこれだけ**:
// chrome.storage.local を 1 回読み、onChanged を 1 本張る (どちらもページからは見えない)。オンなら読んだ後に start() が
// 走り、オフなら何も呼ばない。戻り値は Task 8 で録画中のオフを扱うときに使う (判断メモ 16)
createSwitchDriver({ start, stop });
```

- [ ] **Step 16: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-off-load.test.ts tests/content/dock.test.ts tests/content/youtube-dock-load.test.ts` (Bash の timeout 120000)
期待: PASS (既存の項目も含めてすべて)

落ちたときの見方:
- `beforeAll` の `rangeBarElement()` が「拡大バーが見つかりません」→ start が走る前に読んでいる。`settleMicrotasks` の回数を増やすか、stub の
  `local.get("enabled")` が門を通っていないか (Step 1) を見る
- 「オフにすると observer…」で `mutationDisconnect` が 2 未満 → `pageObserver` / `themeObserver` の disconnect が漏れている
- 「オフ → オンで覚えた配置を読み直し…」で位置がずれる → `resetModuleState` で `floatLayout` を空にしていないか、`loadInitialLayout` の
  `isCurrentRun` の判定で読み直しの結果を捨てている (start の後に `runId` を取っているか)

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 17: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts tests/content/youtube-off-load.test.ts tests/content/youtube-dock-load.test.ts tests/content/dock.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): YouTube の content script をオン / オフで start / stop する

オフの間は YouTube に一切影響を与えないため、import した時点で作って
いた窓・ドック枠・observer・listener をオンのときだけ start で作り、
オフで stop が逆順に外す。再生位置のループには止める口が無かったので
足す。外しても、既に走っている応答や seek の続きが後から窓を描き直したり
再生を始めたりしうるので、回の番号で古い続きを捨てる。オンに戻すと
タブのリロードと同じ content/loaded の経路で状態を取り戻す。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 8: 録画中・書き出し中のオフ (`src/content/youtube.ts`)

**Files:**
- Modify: `src/content/youtube.ts` (`notify` 344〜358 行目、`prepareRecording`、`beginRecording`、`runRecording`、`advanceToSegment`、`finishRecording`、`onRuntimeMessage`、
  `resetModuleState`、末尾の `createSwitchDriver`)。行番号は Task 7 の後でずれているので、関数名で探す
- Test: `tests/content/youtube.test.ts` (末尾に describe)

**Interfaces:**
- Consumes: Task 3 の `SwitchHooks` の `canStop` / `onStopDeferred`、`SwitchDriver.reconcile()`。Task 7 の `runId` / `isCurrentRun` /
  `onRuntimeMessage` / `resetModuleState` / `setEnabled` (テスト) / `ourElements` (テスト)
- Produces: モジュール変数 `capturing: boolean` (判断メモ 13)・`stateSeq: number` (判断メモ 33)、`function notify(message: Message): Promise<void>`、
  `function notifyOutcome(message: Message): void`、`function endCapture(): void`、`function cancelForSwitch(): void`、
  `function onStopDeferred(): void`、`const driver: SwitchDriver`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に次を足す。

```typescript
describe("録画中・書き出し中のオフ (マスタースイッチの spec §4.1)", () => {
  // 前の describe の枠の中身を持ち越さない (判断メモ 34)
  beforeEach(async () => {
    dblclick(barGrip());
    dblclick(listHeader());
    dblclick(settingsHeader());
    await flush();
  });

  afterEach(async () => {
    // 次のテストのためにオンへ戻す (モジュールは 1 回だけ読み込んで使い回している)
    if (storedEnabled === false) {
      setEnabled(true);
      await flush();
    }
  });

  /** このタブで録画を始め、recording まで進める (実機の順序: seeking → recorder/start → recording) */
  async function startRecordingInThisTab(): Promise<void> {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "seeking", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    command("recorder/start");
    await flush();
    emit({ kind: "recording", segments: [RANGE], telops: [], meta: META_A });
    await flush();
  }

  test("録画中 (recording) にオフにすると CANCEL_RECORDING を送り、その応答 (ready) で片付く。録画も OUT の監視も止まる", async () => {
    await startRecordingInThisTab();
    const recorder = startedRecorder();
    sent = [];

    setEnabled(false);
    // 応答が返るまでは片付けない (ページのバーは今までどおり)
    expect(ourElements()).toBeGreaterThan(0);
    await flush();

    expect(clipEvents()).toEqual([{ type: "CANCEL_RECORDING" }]);
    expect(swState.kind).toBe("ready");
    expect(ourElements()).toBe(0);
    expect(recorder.state).toBe("inactive");
    expect(video.pendingFrames()).toBe(0);
  });

  test("録画の準備中 (seeking) にオフにしても CANCEL_RECORDING を送って片付く", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    emit({ kind: "seeking", segments: [RANGE], telops: [], meta: META_A });

    setEnabled(false);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "CANCEL_RECORDING" });
    expect(ourElements()).toBe(0);
  });

  test("複数区間の継ぎ目でオフにすると、片付けた後に seek が済んでも再生も rVFC も始めず、FAIL も送らない", async () => {
    const TWO: ClipRange[] = [
      { startSec: 83, endSec: 98 },
      { startSec: 242, endSec: 250 },
    ];
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: TWO, telops: [], meta: META_A });
    await flush();
    command("recorder/start");
    await flush();
    const recorder = startedRecorder();
    const play = vi.spyOn(video.element, "play");
    try {
      sent = [];
      // **オフを先に押す** (判断メモ 31): 中止の応答 (setTimeout) を先に積み、その後に 1 区間目の終わりを踏ませて継ぎ目の
      // seek (seeked も setTimeout) を始める。応答 → stop → seek の完了、の順になる
      setEnabled(false);
      video.advanceFrame(98);
      await flush();

      expect(ourElements()).toBe(0);
      expect(play).not.toHaveBeenCalled();
      expect(video.pendingFrames()).toBe(0);
      expect(clipEvents()).toEqual([{ type: "CANCEL_RECORDING" }]);
      expect(recorder.state).toBe("inactive");
    } finally {
      play.mockRestore();
    }
  });

  test("書き出し中 (encoding) にオフにすると中止は送らずに待ち、recorder/done を送り終えてから片付く", async () => {
    await startRecordingInThisTab();
    video.advanceFrame(20.1);
    emit({ kind: "encoding", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    sent = [];

    setEnabled(false);
    await flush();
    // 中止を送らない (encoding で止めると service worker が encoding で固まる)。窓もまだある
    expect(clipEvents()).toEqual([]);
    expect(barWindowElement().isConnected).toBe(true);

    command("recorder/stop");
    await flush();
    await flush();

    expect(sent.some((message) => message.type === "recorder/done")).toBe(true);
    expect(ourElements()).toBe(0);
  });

  test("プレビュー (preview) でオフにするとその場で片付き、RESET_MARKS も FAIL も送らない (クリップは状態機械に残る)", async () => {
    emit({
      kind: "preview",
      clipId: "clip-1",
      segments: [RANGE],
      telops: [],
      meta: META_A,
      mimeType: "video/mp4",
    });
    await flush();
    sent = [];

    setEnabled(false);
    expect(ourElements()).toBe(0);
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(swState.kind).toBe("preview");
  });

  test("録画していないタブ (応答で busy を受け取っただけ) はその場で片付き、CANCEL_RECORDING を送らない。オフ + busy でもオンに戻せる", async () => {
    setEnabled(false);
    await flush();
    // 別のタブで録画中。このタブには state/changed は届かず、content/loaded の応答でだけ busy を知る
    swState = { kind: "recording", segments: [RANGE], telops: [], meta: META_A };
    sent = [];

    setEnabled(true);
    await flush();
    // オフ + busy でもオンに戻せる (start が content/loaded を送る)
    expect(sent).toContainEqual({ type: "content/loaded" });
    expect(ourElements()).toBeGreaterThan(0);
    sent = [];

    setEnabled(false);
    expect(ourElements()).toBe(0);
    await flush();

    expect(clipEvents()).toEqual([]);
    expect(swState.kind).toBe("recording");
  });

  test("書き出しを待っている間にオンへ戻したら stop しない (書き出しの結果はそのまま送る)", async () => {
    await startRecordingInThisTab();
    video.advanceFrame(20.1);
    emit({ kind: "encoding", segments: [RANGE], telops: [], meta: META_A });
    await flush();

    setEnabled(false);
    await flush();
    setEnabled(true);
    await flush();
    command("recorder/stop");
    await flush();
    await flush();

    expect(sent.some((message) => message.type === "recorder/done")).toBe(true);
    expect(barWindowElement().isConnected).toBe(true);
    expect(onMessage).not.toBeNull();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts -t "録画中・書き出し中のオフ"` (Bash の timeout 120000)
期待: FAIL (録画中のオフで `CANCEL_RECORDING` が送られず、その場で片付く。書き出し中のオフでも待たずに片付き、`recorder/done` が送られない)。
「プレビュー」と「録画していないタブ」の項目は PASS してよい (Task 7 でその場で片付く)。「複数区間の継ぎ目」は中止を送らないので FAIL

- [ ] **Step 3: 旗を足す (判断メモ 13・33)**

`src/content/youtube.ts` の Task 7 で足した `isCurrentRun` の閉じ括弧の後に、空行を 1 つ挟んで次を足す。

```typescript
/**
 * このタブで録画の準備・録画・書き出しが走っているか (マスタースイッチの spec §4.1)。**立っている間はオフでも stop を
 * 待つ** (driver の canStop)。
 *
 * **状態機械の busy ではない**: busy は応答で受け取った写しで、録画していない別の YouTube タブでも真になる。そのタブには
 * state/changed が届かない (router は録画対象のタブにしか同報しない) ので、busy でオフを待たせると永久に片付かない。
 *
 * 立てる / 下ろすのは state/changed を受けたとき (届いた = このタブが録画対象。busy の間は立つ)。ほかに下ろすのは、
 * オフの中止 (cancelForSwitch) の応答が busy でないときと、録画の結末 (notifyOutcome) を送り終えたとき。応答
 * (send・content/loaded) では変えない (録画していないタブにも返る)。handle だけでは prepareRecording の seek 中を拾えない
 */
let capturing = false;
/**
 * 受けた state/changed の数。オフのための中止の応答が、送った後に届いた新しい状態より古いかを見分ける (cancelForSwitch。
 * 判断メモ 33)
 */
let stateSeq = 0;
```

同じファイルの `resetModuleState` の最後の行

```typescript
  observedPlayer = null;
}
```

を次に置き換える。

```typescript
  observedPlayer = null;
  capturing = false;
  stateSeq = 0;
}
```

- [ ] **Step 4: 録画の結末を送り終えたら reconcile する (判断メモ 4)**

`src/content/youtube.ts` の `notify` (doc の「service worker へ録画の進行を伝える。」から閉じ括弧まで)

```typescript
/**
 * service worker へ録画の進行を伝える。
 *
 * 録画結果は base64 で数十 MB になりうる。メッセージ長の超過や拡張コンテキストの
 * 無効化で送れなかったとき、黙って捨てると service worker は `encoding` のまま、
 * popup は `actions: []` で操作不能になる。ユーザーに見せたうえで、小さい
 * `FAIL` を送って状態を抜けさせる。
 */
function notify(message: Message): void {
  void chrome.runtime.sendMessage(message).catch((error: unknown) => {
    setStatus(`拡張への送信に失敗しました: ${String(error)}`);
    // 成果物を渡せていない以上、録画が中断されたのと結果は同じ
    send({ type: "FAIL", reason: "recording-aborted" });
  });
}
```

を次に置き換える。

```typescript
/**
 * service worker へ録画の進行を伝える。
 *
 * 録画結果は base64 で数十 MB になりうる。メッセージ長の超過や拡張コンテキストの
 * 無効化で送れなかったとき、黙って捨てると service worker は `encoding` のまま、
 * popup は `actions: []` で操作不能になる。ユーザーに見せたうえで、小さい
 * `FAIL` を送って状態を抜けさせる。
 *
 * **送り終えたら resolve する** (届いても、届かずに FAIL を送り出した後でも。reject しない)。録画の結末を送り終えた
 * 時点を notifyOutcome が知るため
 */
function notify(message: Message): Promise<void> {
  return chrome.runtime.sendMessage(message).then(
    () => undefined,
    (error: unknown) => {
      setStatus(`拡張への送信に失敗しました: ${String(error)}`);
      // 成果物を渡せていない以上、録画が中断されたのと結果は同じ
      send({ type: "FAIL", reason: "recording-aborted" });
    },
  );
}

/**
 * 録画の結末 (recorder/done・recorder/failed) を送る。**送り終えたら、このタブの録画は終わり** (spec §4.1)。オフを
 * 待っていたなら、ここで片付けてよい。state/changed (preview / failed) は待たない: service worker が応答を返さないときに
 * 永久に待たないため。届かなかったときは notify が FAIL を送り出した後に片付ける (FAIL の応答は待たない。判断メモ 4)
 */
function notifyOutcome(message: Message): void {
  void notify(message).then(endCapture);
}

/** このタブの録画が終わった。オフを待っていたなら、ここで stop() が走る */
function endCapture(): void {
  capturing = false;
  driver.reconcile();
}
```

`src/content/youtube.ts` の `beginRecording` の中の次の 3 か所を直す。

```typescript
    handle = await startRecording(video, mimeType, {
      videoOverride,
      onUnexpectedStop: (error) => {
        handle = null;
        notify({ type: "recorder/failed", reason: error.message });
      },
    });
    notify({ type: "recorder/started" });
  } catch (error) {
    // release は二度呼んでも安全 (startRecording の中で解放済みのことがある)
    videoOverride?.release();
    notify({ type: "recorder/failed", reason: String(error) });
  }
}
```

を次に置き換える。

```typescript
    handle = await startRecording(video, mimeType, {
      videoOverride,
      onUnexpectedStop: (error) => {
        handle = null;
        notifyOutcome({ type: "recorder/failed", reason: error.message });
      },
    });
    // 録画の準備を待っている間に片付いた (オフにして中止が通った)。始まった録画はここで捨てる。残すと、オフのページで
    // MediaRecorder と captureStream が回り続ける (spec §1)。合成は録画の解放に繋がっているので一緒に止まる
    if (!isCurrentRun(id)) {
      abortRecording();
      return;
    }
    void notify({ type: "recorder/started" });
  } catch (error) {
    // release は二度呼んでも安全 (startRecording の中で解放済みのことがある)
    videoOverride?.release();
    notifyOutcome({ type: "recorder/failed", reason: String(error) });
  }
}
```

同じ関数の先頭

```typescript
async function beginRecording(): Promise<void> {
  // 録画が始まらなかったときに合成を残さないよう、try の外で持つ
  let videoOverride: Compositor | undefined;
```

を次に置き換える。

```typescript
async function beginRecording(): Promise<void> {
  // 録画の準備 (startRecording) を待つ間にオフにしたかを見る (isCurrentRun)
  const id = runId;
  // 録画が始まらなかったときに合成を残さないよう、try の外で持つ
  let videoOverride: Compositor | undefined;
```

`src/content/youtube.ts` の `finishRecording` の中の `notify(` 3 か所

```typescript
    notify({ type: "recorder/failed", reason: "録画が開始されていません" });
```

```typescript
    notify({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notify({ type: "recorder/failed", reason: String(error) });
  }
```

をそれぞれ次に置き換える。

```typescript
    notifyOutcome({ type: "recorder/failed", reason: "録画が開始されていません" });
```

```typescript
    notifyOutcome({
      type: "recorder/done",
      base64: encodeBase64(bytes),
      mimeType: blob.type,
    });
  } catch (error) {
    notifyOutcome({ type: "recorder/failed", reason: String(error) });
  }
```

- [ ] **Step 5: 録画の準備と再生の続きを断つ (判断メモ 7)**

`src/content/youtube.ts` の `prepareRecording` の先頭

```typescript
async function prepareRecording(
  startSec: number,
  expectedVideoId: string,
): Promise<void> {
  try {
```

を次に置き換える。

```typescript
async function prepareRecording(
  startSec: number,
  expectedVideoId: string,
): Promise<void> {
  // seek を待つ間にオフにして中止が通ったら、SEEK_DONE を送らない (オフの間は何も送らない。spec §1)
  const id = runId;
  try {
```

同じ関数の seek の後

```typescript
    video.pause();
    await seekTo(video, startSec);

    send({ type: "SEEK_DONE" });
```

を次に置き換える。

```typescript
    video.pause();
    await seekTo(video, startSec);
    if (!isCurrentRun(id)) return;

    send({ type: "SEEK_DONE" });
```

同じ関数の `catch` の先頭

```typescript
  } catch (error) {
    if (error instanceof DrmProtectedError) {
```

を次に置き換える (prepareRecording の catch だけ。`DrmProtectedError` を見る catch はこの関数にしか無い)。

```typescript
  } catch (error) {
    if (!isCurrentRun(id)) return;
    if (error instanceof DrmProtectedError) {
```

`src/content/youtube.ts` の `runRecording`

```typescript
async function runRecording(segments: ClipRange[]): Promise<void> {
  try {
    const video = getVideo();
    await startPlayback(video);
    watchSegmentEnd(video, segments, 0);
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}
```

を次に置き換える。

```typescript
async function runRecording(segments: ClipRange[]): Promise<void> {
  const id = runId;
  try {
    const video = getVideo();
    await startPlayback(video);
    // 再生を待つ間にオフにして中止が通ったら、OUT の監視 (rVFC) をオフのページに張らない
    if (!isCurrentRun(id)) return;
    watchSegmentEnd(video, segments, 0);
  } catch (error) {
    if (!isCurrentRun(id)) return;
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}
```

`src/content/youtube.ts` の `advanceToSegment` の次の 2 か所を直す (判断メモ 31)。

```typescript
  const recorder = handle;
  try {
    recorder.pause();
    video.pause();
    setStatus(`${index + 1} / ${segments.length} 区間目へ移動中…`);

    await seekTo(video, segment.startSec);
    await startPlayback(video);
    await waitForFreshFrame(video);
```

を次に置き換える。

```typescript
  const recorder = handle;
  // 継ぎ目の seek と再生を待つ間にオフにして中止が通ったら、続きを走らせない (isCurrentRun)
  const id = runId;
  try {
    recorder.pause();
    video.pause();
    setStatus(`${index + 1} / ${segments.length} 区間目へ移動中…`);

    await seekTo(video, segment.startSec);
    // オフのページで再生を始めない・waitForFreshFrame の rVFC を張らない (spec §1)。下の handle の確かめは
    // waitForFreshFrame の後なので、それより前で断つ
    if (!isCurrentRun(id)) return;
    await startPlayback(video);
    if (!isCurrentRun(id)) return;
    await waitForFreshFrame(video);
```

同じ関数の `catch`

```typescript
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`${FAILURE_MESSAGES["seek-failed"]}: ${String(error)}`);
  }
}
```

を次に置き換える。

```typescript
  } catch (error) {
    // オフにした後の seek の失敗 (時間切れ) を service worker へ送らない (オフの間は 0 件。spec §1)
    if (!isCurrentRun(id)) return;
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`${FAILURE_MESSAGES["seek-failed"]}: ${String(error)}`);
  }
}
```

- [ ] **Step 6: 状態の通知の末尾で reconcile し、旗を合わせる**

`src/content/youtube.ts` の `onRuntimeMessage` (Task 7 で名前を付けた関数) の次の部分

```typescript
  if (message.type !== "state/changed") return;
  sendResponse();

  const state = message.state;
  applyStateToDisplay(state);
```

から関数の終わり

```typescript
  if (state.kind === "recording") {
    void runRecording(state.segments);
  }
}
```

までを次に置き換える (状態を処理する本体を `handleStateChanged` に分け、その後で旗と reconcile を扱う)。

```typescript
  if (message.type !== "state/changed") return;
  sendResponse();

  // state/changed は録画対象のタブにしか届かない (router は captureTabId にだけ同報する)。busy の間は、このタブで
  // 録画の準備・録画・書き出しが走っている (capturing の doc。判断メモ 13)
  stateSeq += 1;
  capturing = BUSY_KINDS.has(message.state.kind);
  handleStateChanged(message.state);
  // 状態を処理し終えた。オフを待っていたなら、ここで片付けてよくなったかもしれない (spec §4.1)
  driver.reconcile();
}

/** 状態の通知を画面と録画に反映する (onRuntimeMessage の state/changed) */
function handleStateChanged(state: ClipState): void {
  applyStateToDisplay(state);

  // ready を離れたら範囲再生の監視は用済み。残すと、旧 OUT 位置を通過した
  // ときに録画中の再生を止めてしまい、新しい OUT へ到達できなくなる
  if (state.kind !== "ready") {
    cancelPreviewWatch();
  }

  // 録画の進行から離れた状態では、走っている監視と録画を始末する。
  // recording は自分で監視を張り直し、encoding では finishRecording が
  // handle を使うので、その 2 つだけは触らない
  if (state.kind !== "recording" && state.kind !== "encoding") {
    cancelWatch?.();
    cancelWatch = null;
    abortRecording();
  }

  if (state.kind === "seeking") {
    const first = state.segments[0];
    if (first === undefined) {
      send({ type: "FAIL", reason: "internal-error" });
      return;
    }
    void prepareRecording(first.startSec, state.meta.videoId);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.segments);
  }
}
```

(置き換える前の本体と同じ処理。`const state = message.state;` を引数に変えただけで、コメントも移す。)

- [ ] **Step 7: 待たされたら中止を送る (判断メモ 1・14)**

`src/content/youtube.ts` の `handleStateChanged` の閉じ括弧の後に、空行を 1 つ挟んで次を足す。

```typescript
/**
 * オフにしたが、このタブで録画が走っているので stop を待たされた (driver が待ちに入るたびに 1 回呼ぶ。spec §4.1)。
 *
 * - seeking / recording: 中止 (CANCEL_RECORDING) を送る。バーの「■ 中止」と同じ経路で、区間とテロップは残り ready に戻る
 * - encoding: 何もしない。**書き出しが終わるまで待つ**: ここで録画を捨てると recorder/done が送られず、service worker が
 *   encoding で固まる。書き出しの結末を送り終えたら notifyOutcome が reconcile する
 */
function onStopDeferred(): void {
  if (lastKind !== "seeking" && lastKind !== "recording") return;
  cancelForSwitch();
}

/**
 * オフのための中止を送る。**応答の状態が busy でなければ、state/changed を待たずに片付ける** (判断メモ 1): router の同報は
 * 送りっぱなしで、届かなかったときに永久に待たないため。state/changed (ready) が先に届けば、そちらで片付く。
 * 中止が拒まれた (既に encoding へ進んでいた) ときは応答が busy のままなので、書き出しの結末を待つ。
 * 送れなかった (拡張が読み込み直されて受け手が居ない) ときは、待っても結末は届かないので片付ける
 */
function cancelForSwitch(): void {
  const id = runId;
  const seq = stateSeq;
  /**
   * この応答が古くなったか (判断メモ 33)。オフ → オンで作り直した後か、送った後に届いた state/changed が録画中を
   * 知らせた (オフを待つ間にオンへ戻して新しい録画が始まった) なら、新しい状態が正なので応答で旗を下ろさない
   */
  const stale = (): boolean => !isCurrentRun(id) || (stateSeq !== seq && capturing);
  void chrome.runtime
    .sendMessage({
      type: "clip/event",
      event: { type: "CANCEL_RECORDING" },
    } satisfies Message)
    .then((response: MessageResponse | undefined) => {
      if (stale()) return;
      if (response !== undefined && !BUSY_KINDS.has(response.state.kind)) endCapture();
    })
    .catch((error: unknown) => {
      if (stale()) return;
      setStatus(`操作を送信できませんでした: ${String(error)}`);
      endCapture();
    });
}
```

- [ ] **Step 8: driver に止めてよいかを渡す (判断メモ 16)**

`src/content/youtube.ts` の末尾

```typescript
// オン / オフに合わせて start() / stop() を呼ぶ (マスタースイッチの spec §2.1)。**import 時にするのはこれだけ**:
// chrome.storage.local を 1 回読み、onChanged を 1 本張る (どちらもページからは見えない)。オンなら読んだ後に start() が
// 走り、オフなら何も呼ばない。戻り値は Task 8 で録画中のオフを扱うときに使う (判断メモ 16)
createSwitchDriver({ start, stop });
```

を次に置き換える。

```typescript
/**
 * オン / オフに合わせて start() / stop() を呼ぶ (マスタースイッチの spec §2.1)。**import 時にするのはこれだけ**:
 * chrome.storage.local を 1 回読み、onChanged を 1 本張る (どちらもページからは見えない)。オンなら読んだ後に start() が
 * 走り、オフなら何も呼ばない。
 * **このタブで録画が走っている間は stop を待つ** (canStop。spec §4.1)。待たされたら中止を送るか書き出しを待ち
 * (onStopDeferred)、終わったところ (状態の通知の末尾・中止の応答・録画の結末の送り終わり) で reconcile する
 */
const driver = createSwitchDriver({
  start,
  stop,
  canStop: () => !capturing,
  onStopDeferred,
});
```

- [ ] **Step 9: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: PASS (既存の「録画の後始末」「録画の中止」「複数区間の録画」「テロップ付きの録画」を含めてすべて)

落ちたときの見方:
- 「録画中 (recording) にオフにすると…」で `ourElements()` が 0 にならない → `cancelForSwitch` の応答で `endCapture` が走っていない。stub の応答の
  `state.kind` が `ready` か (`swState` が recording から CANCEL_RECORDING で ready になるか) を見る
- 「書き出し中 (encoding)…」で `recorder/done` の後も要素が残る → `finishRecording` の `notify` を `notifyOutcome` に替え損ねている
- 既存の「録画結果を送れなかったら失敗として知らせる」が落ちる → `notify` の失敗の扱い (setStatus と FAIL) が then の第 2 引数に移っているか

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 10: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 録画中にオフにしたら中止し、書き出し中なら済んでから消す

スイッチはどの状態でも押せるので、録画対象のタブがその場で片付けると
service worker が録画の続きを待ったまま固まる。録画の準備中・録画中は
■ 中止と同じ CANCEL_RECORDING を送り、応答か通知で ready に戻ってから
片付ける。書き出し中は結末 (recorder/done) を送り終えるまで待つ
(録れたクリップを失わない)。待つかどうかは状態機械の busy ではなく
このタブで録画が走っているかで決め、録画していないタブはその場で消す。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 9: E2E に spec §8 の項目を足す (`e2e/smoke.spec.ts`)

**Files:**
- Modify: `e2e/smoke.spec.ts` (import、`beforeAll` 16〜33 行目、「IN を指定すると…」のコメント 1 か所、末尾に helper と 4 項目)

**Interfaces:**
- Consumes: Task 4 のバッジ (`chrome.action.getBadgeText`)、Task 5 の popup の `#enabled` / `#message`、Task 7・8 の youtube.ts、Task 2 の `enabled` の鍵
- Produces: E2E 4 項目 (オフ → YouTube の動作・開き直し・メッセージ 0 件 → オン / オフ → オンで覚えた配置 / popup のスイッチ / オフのまま起動し直す)。
  実機で走らせるのは Task 10 (controller)

**実装担当はこのタスクで `npm run e2e` を走らせない** (運用前提)。型と単体テストまでで止める。

- [ ] **Step 1: import と起動を関数にする**

`e2e/smoke.spec.ts` の先頭の import

```typescript
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
```

を次に置き換える。

```typescript
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
```

同じファイルの `beforeAll` (16〜33 行目)

```typescript
test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    // ブラウザ起動が固まったまま待ち続けないようにする
    timeout: 60_000,
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
});
```

を次に置き換える。

```typescript
/**
 * ブラウザを起動し、拡張の id を得る。「オフのまま起動し直す」の項目も同じ userDataDir で呼ぶ
 * (chrome.storage.local は userDataDir に残るので、起動し直してもオフのまま)
 */
async function launch(): Promise<void> {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    // ブラウザ起動が固まったまま待ち続けないようにする
    timeout: 60_000,
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-"));
  await launch();
});
```

同じファイルの「IN を指定するとページ内で録画を始められる」の中のコメント

```typescript
  // popup は状態を映すだけ。YouTube 以外のタブにいるときの逃げ道として残す
```

を次に置き換える (検査は変えない。checkbox の role は switch なので button には当たらない)。

```typescript
  // popup が持つ操作はオン / オフのスイッチだけ (role は switch なので button には当たらない)。
  // 状態を映すのは、YouTube 以外のタブにいるときの逃げ道として残す
```

- [ ] **Step 2: helper を足す**

`e2e/smoke.spec.ts` の `test.afterAll(...)` の後、最初の `test("拡張がロードされ…")` の前に次を足す。

```typescript
/**
 * service worker は MV3 で止まりうる。止まっていたら popup を開いて起こす
 * (popup は service worker に状態を問い合わせる。telop-check.spec.ts の getWorker と同じ)
 */
async function getWorker(): Promise<Worker> {
  const found = context
    .serviceWorkers()
    .find((w) => new URL(w.url()).host === extensionId);
  if (found !== undefined) return found;
  const waiting = context.waitForEvent("serviceworker", { timeout: 30_000 });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const worker = await waiting;
  await popup.close();
  return worker;
}

/**
 * オン / オフを service worker の文脈から書く (マスタースイッチの spec §8。popup の操作は別の項目で確かめる)。
 * 各項目は先頭でこれを呼んで前提を作り、finally でオンに戻す (前の項目の終わり方に依存しない)
 */
async function writeEnabled(enabled: boolean): Promise<void> {
  const worker = await getWorker();
  await worker.evaluate((value) => chrome.storage.local.set({ enabled: value }), enabled);
}

async function badgeText(): Promise<string> {
  const worker = await getWorker();
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

/** 拡張が足した要素の数 (spec §1 の測り方)。窓・ドック枠・シークバーの帯・プレビューの canvas を覆う */
function countOurElements(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length,
  );
}

/**
 * service worker が受けるタブからのメッセージを数え始める (spec §8)。数える listener は一度だけ足し、呼ぶたびに数を
 * 0 に戻す。**service worker が止まると listener も数も消える** ので、読むとき (countedTabMessages) に消えていたら落とす
 */
async function startCountingTabMessages(): Promise<void> {
  const worker = await getWorker();
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      ytClipTabMessages?: string[];
      ytClipCounting?: boolean;
    };
    scope.ytClipTabMessages = [];
    if (scope.ytClipCounting === true) return;
    scope.ytClipCounting = true;
    chrome.runtime.onMessage.addListener((message: { type?: unknown }, sender) => {
      if (sender.tab !== undefined) scope.ytClipTabMessages?.push(String(message.type));
    });
  });
}

async function countedTabMessages(): Promise<string[]> {
  const worker = await getWorker();
  return worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { ytClipTabMessages?: string[] };
    if (scope.ytClipTabMessages === undefined) {
      throw new Error("service worker が止まり、数える listener が消えました。測り直してください");
    }
    return [...scope.ytClipTabMessages];
  });
}

/** 動画ページを開き、バーとタイトルが出るまで待つ (IN を押すとタイトルを読む) */
async function openVideo(page: Page, url: string = TEST_VIDEO): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("h1.ytd-watch-metadata yt-formatted-string"),
  ).not.toBeEmpty({ timeout: 30_000 });
}

/** 再生位置を動かす。UI 操作ではシークバーの精度が出ないため直接指定する */
async function seekVideo(page: Page, sec: number): Promise<void> {
  await page.evaluate((target: number) => {
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (video === null) throw new Error("video 要素が見つかりません");
    video.currentTime = target;
  }, sec);
}

function videoState(page: Page): Promise<{ currentTime: number; paused: boolean }> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (video === null) throw new Error("video 要素が見つかりません");
    return { currentTime: video.currentTime, paused: video.paused };
  });
}

function isTheater(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? false,
  );
}

/** YouTube のショートカット。入力欄やボタンにフォーカスがあると効かない・文字として入るので、先に外す */
async function pressShortcut(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}
```

- [ ] **Step 3: オフ → YouTube の動作 → 開き直し → オンの項目を足す**

`e2e/smoke.spec.ts` の末尾に次を足す。

```typescript
test("オフにすると 1 秒以内に拡張の要素が消え、YouTube はそのまま動き、開き直しても何も出ず、メッセージも来ない。オンに戻すと読み込み直さずに戻る", async () => {
  test.setTimeout(240_000);
  // 前提を自分で作る: オン・覚えた窓の配置なし (最初の配置 = バーは下の枠)
  await writeEnabled(true);
  await (await getWorker()).evaluate(() => chrome.storage.local.remove("windowLayout"));
  const page = await context.newPage();
  // オフにした後にページのコンソールへ出た拡張の行 (判断メモ 21)。**空振りしうる**: Playwright が content script の
  // 隔離された world の console を console イベントに載せないなら、拡張が出しても 0 行のまま通る (拾えていることの正例は
  // 作れていない)。そのため manual-check の「オン / オフ」で DevTools のコンソールを目で見る
  const extensionLogs: string[] = [];
  let watchingLogs = false;
  page.on("console", (message) => {
    if (!watchingLogs) return;
    const fromExtension = message.location().url.startsWith(`chrome-extension://${extensionId}/`);
    if (fromExtension || message.text().includes("[yt-clip]")) extensionLogs.push(message.text());
  });
  try {
    await openVideo(page);
    await seekVideo(page, 5);
    await page.locator("#yt-clip-bar").getByRole("button", { name: "IN" }).click();
    await expect(page.locator("#yt-clip-bar-status")).toHaveText("0:05 〜 0:20 (15秒)");
    expect(await countOurElements(page)).toBeGreaterThan(0);

    // オフに書く直前に数え始める (オンの間に送った分は数えない。spec §8)
    await startCountingTabMessages();
    const offAt = Date.now();
    watchingLogs = true;
    await writeEnabled(false);
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await expect.poll(badgeText, { timeout: 5_000 }).toBe("OFF");

    // YouTube 自身の動作が変わらない (代表: 再生が進む・k で一時停止と再生・t でシアターモード)
    await page.bringToFront();
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.play(),
    );
    const before = await videoState(page);
    await page.waitForTimeout(1_500);
    expect((await videoState(page)).currentTime).toBeGreaterThan(before.currentTime);
    await pressShortcut(page, "k");
    await expect.poll(async () => (await videoState(page)).paused, { timeout: 5_000 }).toBe(true);
    await pressShortcut(page, "k");
    await expect.poll(async () => (await videoState(page)).paused, { timeout: 5_000 }).toBe(false);
    const theaterBefore = await isTheater(page);
    await pressShortcut(page, "t");
    await expect.poll(() => isTheater(page), { timeout: 10_000 }).toBe(!theaterBefore);
    await pressShortcut(page, "t");
    await expect.poll(() => isTheater(page), { timeout: 10_000 }).toBe(theaterBefore);
    expect(await countOurElements(page)).toBe(0);

    // オフのまま動画ページを開き直す (content script は読み込まれるが何もしない。判断メモ 19)
    await page.goto(`${TEST_VIDEO}&t=3s`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#below").waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(5_000);
    expect(await countOurElements(page)).toBe(0);

    // オフにしてから 10 秒以上、タブから service worker へ 1 通も来ない
    const rest = 10_000 - (Date.now() - offAt);
    if (rest > 0) await page.waitForTimeout(rest);
    expect(await countedTabMessages()).toEqual([]);
    expect(extensionLogs).toEqual([]);

    // オンに戻す。読み込み直さない (page.reload を呼ばない)。同じ動画なので IN の範囲も戻る
    watchingLogs = false;
    await writeEnabled(true);
    await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 1_000 });
    await expect(page.locator("#yt-clip-bar-status")).toHaveText("0:05 〜 0:20 (15秒)", {
      timeout: 5_000,
    });
    // 最初の配置なので、バーは下の枠 (#below の中) に戻る
    expect(
      await page.evaluate(
        () => document.getElementById("yt-clip-bar-window")?.closest("#yt-clip-dock-below") != null,
      ),
    ).toBe(true);
    await expect.poll(badgeText, { timeout: 5_000 }).toBe("");
  } finally {
    await writeEnabled(true);
    await page.close();
  }
});
```

- [ ] **Step 4: オフ → オンで覚えた配置が残る項目を足す**

`e2e/smoke.spec.ts` の末尾に次を足す (判断メモ 20)。

```typescript
test("オフ → オンで、浮かせて置いた窓は同じ位置に、枠に入れた窓は同じ枠に出る", async () => {
  // 前提を自分で作る: エディットモード (区間・テロップの窓は区間があるときだけ出る) と、区間・テロップの窓を
  // 浮かせて (200, 150) に置き、バーを下の枠に入れた配置
  await writeEnabled(true);
  await (await getWorker()).evaluate(() =>
    Promise.all([
      chrome.storage.sync.set({ settings: { mode: "edit" } }),
      chrome.storage.local.set({
        windowLayout: {
          version: 2,
          float: { list: { left: 200, top: 150, width: 360, height: 300 } },
          docks: { below: { tabs: ["bar"] } },
        },
      }),
    ]),
  );
  const page = await context.newPage();
  /** 区間・テロップの窓の置き場所と、バーが下の枠にあるか */
  const placement = () =>
    page.evaluate(() => {
      const list = document.getElementById("yt-clip-list");
      return {
        left: list?.style.left ?? null,
        top: list?.style.top ?? null,
        floating: list?.parentElement === document.body,
        barInBelow:
          document.getElementById("yt-clip-bar-window")?.closest("#yt-clip-dock-below") != null,
      };
    });
  try {
    await openVideo(page);
    await page.locator("#yt-clip-bar").getByRole("button", { name: "＋ 区間を追加" }).click();
    const list = page.locator("#yt-clip-list");
    await expect(list).toBeVisible();
    const before = await placement();
    expect(before).toEqual({ left: "200px", top: "150px", floating: true, barInBelow: true });

    await writeEnabled(false);
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await writeEnabled(true);
    await expect(list).toBeVisible({ timeout: 5_000 });
    expect(await placement()).toEqual(before);
  } finally {
    await (await getWorker()).evaluate(() =>
      Promise.all([
        chrome.storage.sync.remove("settings"),
        chrome.storage.local.remove("windowLayout"),
      ]),
    );
    await writeEnabled(true);
    await page.close();
  }
});
```

- [ ] **Step 5: popup のスイッチの項目を足す**

`e2e/smoke.spec.ts` の末尾に次を足す。

```typescript
test("popup のスイッチを押すと 1 秒以内に YouTube のタブから拡張の要素が消え、もう一度押すと戻る。ボタンは持たない", async () => {
  // 前提を自分で作る: オン・覚えた窓の配置なし
  await writeEnabled(true);
  await (await getWorker()).evaluate(() => chrome.storage.local.remove("windowLayout"));
  const page = await context.newPage();
  const popup = await context.newPage();
  try {
    await openVideo(page);
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      timeout: 30_000,
    });
    const toggle = popup.locator("#enabled");
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await expect(toggle).not.toBeChecked();
    await expect(popup.locator("#message")).toHaveText(
      "オフです。YouTube と X のページには何も出ません",
    );
    await expect(popup.getByRole("button")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 5_000 });
  } finally {
    await writeEnabled(true);
    await popup.close();
    await page.close();
  }
});
```

- [ ] **Step 6: オフのまま起動し直す項目を足す (最後に置く)**

`e2e/smoke.spec.ts` の末尾に次を足す。**ブラウザを起動し直すので、必ずファイルの最後の項目にする** (後ろに足す項目は、この項目の
`launch()` が作った `context` を使うことになる)。

```typescript
// **この項目はファイルの最後に置く** (ブラウザを起動し直す。context と extensionId を作り直す)
test("オフのまま起動し直してもオフのまま。バッジも OFF で、動画ページに何も出ない", async () => {
  test.setTimeout(240_000);
  await writeEnabled(false);
  try {
    // chrome.runtime.reload() の代わりに、同じ userDataDir で起動し直す (spec §8)
    await context.close();
    await launch();
    const worker = await getWorker();
    expect(await worker.evaluate(() => chrome.storage.local.get("enabled"))).toEqual({
      enabled: false,
    });
    await expect.poll(badgeText, { timeout: 10_000 }).toBe("OFF");

    const page = await context.newPage();
    await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#below").waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(5_000);
    expect(await countOurElements(page)).toBe(0);
    await page.close();
  } finally {
    await writeEnabled(true);
  }
});
```

- [ ] **Step 7: 型と単体テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`e2e/` は `tsconfig.json` の include に入っているので型は確かめられる。`npm run e2e` は走らせない)

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/smoke.spec.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): オン / オフで YouTube に影響を与えないことを実機で測る

「一切影響を与えない」は単体テストの jsdom では測り切れない (実物の
YouTube のキー操作・シアターモード・service worker が受けるメッセージ)。
オフにした開いているタブ・開き直したタブで要素が 0 個・メッセージが
0 件・k と t が今までどおり、オンに戻すと読み込み直さずに範囲と配置が
戻ること、popup のスイッチ、起動し直してもオフのままを項目にする。
各項目は前提を自分で作り、前の項目の終わり方に依存しない。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

### Task 10: 実機で確かめ、記録する (controller が実行)

**Files:**
- Modify: `docs/manual-check.md` (「## 確認した環境」)
- Modify: `.claude/specs/2026-09-25-master-switch-design.md` (`## 自律判断ログ` の末尾に行を足す)

**実行者: controller (メインセッション)。** 実機 (同梱の Chromium と YouTube) を使い、結果を見て判断するため subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜9 のすべて
- Produces: `npm run e2e` と `npm run check:telop` の結果、`docs/manual-check.md` と spec の記録

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout がある)
期待: smoke の 3 件 + Task 9 の 4 件 = 7 件が PASS、`テロップの実機確認` は skip

落ちたときの見方:
- 「オフにすると 1 秒以内に…」で要素が 0 にならない → service worker の文脈で書いた `enabled` の onChanged が content script に届いていない
  (`chrome://extensions` の content script のエラー) か、`stop()` の片付け漏れ。`countOurElements` の代わりに
  `document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]')` の id を並べて、残った要素を特定する
- `countedTabMessages` が「service worker が止まり…」で落ちた → 測っている間に service worker が止まった。走らせ直す。繰り返すなら、測る間
  popup を開いたままにして service worker を起こしておく形に直す
- `countedTabMessages` に型が並んだ → オフの間に送っている。`content/loaded` なら開き直したページで start が走った (driver の読み)、
  `clip/event` なら非同期の続き (`isCurrentRun` の漏れ)
- `extensionLogs` に行がある → オフの間の console 出力。出どころの関数を探し、`isCurrentRun` で断つか出力をやめる
- `k` / `t` が効かない → フォーカスがページの外。`page.bringToFront()` の後に `pressShortcut` を呼んでいるか
- 「オフ → オンで…」で `before` が `{ left: "200px", … }` にならない → `windowLayout` の書き込みより先にページが読み込んだ。書き込みを
  `openVideo` より前に済ませているか

- [ ] **Step 3: `npm run check:telop` を走らせる (回帰の確認)**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分を超えうるので Bash の timeout 600000 では足りない。テスト自身が
`test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。
20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` の 32 項目がすべて `pass: true` (C2 のときと同じ。オンのままの経路が変わっていない)

- [ ] **Step 4: 手で見る項目を確かめる**

`docs/manual-check.md` の節「オン / オフ」(Task 1) の項目を、`npm run e2e` と同じ Chromium に `dist/` を読み込んで手で確かめる。
とくに E2E で測っていないもの: DevTools の Elements で `yt-clip` を検索して 0 件・DevTools のコンソールに拡張の行が出ない (判断メモ 21)・
`f` とシークバーのドラッグ・全画面・ミニプレイヤー・録画中のオフ (popup の文言と、オンに戻して録り直せる)・書き出し中のオフ (済んでから消える・
クリップが残る旨)・プレビューでオフ → オン・別の YouTube タブでオフ・待っている表示が残ったときの抜け道 (録画中にオフにして、応答が返る
前に対象タブを読み込み直す)・バッジの色・ブラウザの再起動 (バッジが残るか。spec の未確定事項)。X の投稿画面の項目はログイン済みの X が要る。
できなかった項目は Step 5 の記録に「確かめていない」と書く。

- [ ] **Step 5: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の最後の段落 (「2026-09-25 はドック枠とタブ (C2。最初の配置はドック) を…」で始まる段落) の後に、
空行を 1 つ挟んで次を足す (`<…>` は実際の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。表の「確認日 (JST)」の範囲も、日付が変わっていれば後ろを延ばす。

```markdown
<JST の日付> は全機能のオン / オフ (マスタースイッチ) を `npm run e2e` で確かめた (smoke 7 項目すべて通過)。オフにした開いているタブで 1 秒以内に
拡張の要素が 0 個になり、オフの間に `k` で一時停止と再生・`t` でシアターモードが今までどおり動き、開き直した動画ページにも何も出ず、
10 秒以上 service worker へタブからメッセージが来ないこと、オンに戻すと読み込み直さずに IN の範囲と窓の配置が戻ること、popup のスイッチ、
起動し直してもオフのままでバッジが `OFF` のことを確かめた。`npm run check:telop` の 32 項目もすべて通過した (オンのままの経路の回帰)。
「オン / オフ」節のうち、<手で確かめた項目> は手で確かめ、<確かめていない項目> は単体テストでだけ確かめている。バッジはブラウザの再起動を
またいで <残った / 残らず onStartup で当て直された>。
```

spec の `## 自律判断ログ` の末尾に次の行を足す (`<…>` は実際の値)。

```markdown
- [実機] <JST の日付> npm run e2e の smoke 7 項目と check:telop 32 項目が通過。バッジはブラウザの再起動をまたいで <残った / 残らなかった (onStartup で当て直す)>。E2E の service worker の数える listener は <測る間に止まらなかった / 止まって走らせ直した>
- [実装] 権限を足していない (manifest.config.ts は変えていない。バッジの setBadge* は action を持つ拡張なら権限なしで使えた)
- [実装] plan の判断メモ 1〜4 で、残りの Recommendations 4 件を扱った (中止の応答と state/changed の両方で片付ける / hint は区切り線の下の 1 行・端末の注意は popup.html に固定 / 抜け道は README と manual-check に / notify の then・catch の両方の後で reconcile)
```

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md .claude/specs/2026-09-25-master-switch-design.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: オン / オフを実機で確かめた記録を残す

「YouTube に一切影響を与えない」は実機でしか測れない項目 (キー操作・
service worker が受けるメッセージ・起動し直し) を含むので、E2E と
check:telop の結果と、手で見た項目・見ていない項目を記録する。バッジが
再起動をまたいで残るかは spec で未確定にしていたので、結果を書き戻す。

Claude-Session: https://claude.ai/code/session_01F8pEKyvhDJVCRo65HLA8se
MSG
)"
```

---

## 完了後

1. `npm run typecheck && npm test` (Bash の timeout 600000) で全テストが green であることを確認する
2. whole-branch cross-review: この plan の範囲 (C2 の終わり、commit **bb0bd30** 以降) を見るため、
   `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff bb0bd30..HEAD` を 1 ファイルにまとめ、新しい subagent に
   subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる。指摘は直して再レビュー (手順は cross-review スキル)。
   攻撃者視点の入力例: 壊れた `enabled` (`"no"`・`1`・`null`・`{}`・キーの削除)・オン / オフの連打 (start の途中の非同期の続きが次の回に
   届く)・録画の準備中 (seeking) / 録画中 / 書き出し中 / 投稿待ち (composing) にオフ・オフを待っている間にオンへ戻す・オフを待っている間に
   録画対象のタブを読み込み直す / 閉じる・2 つの YouTube タブの片方で録画中にオフ・service worker が止まっている / 応答しないときにオフ・
   `chrome.storage.local.set` が失敗する (popup の表示が戻るか)・オフのまま SPA で別の動画へ移る・オフのまま全画面やシアターモードを切り替える・
   ドラッグの最中 (枠の目印が出ている) にオフ・X の投稿画面で添付の最中にオフ・`startRecording` が stop の後に resolve する順序 (判断メモ 28)・複数区間の継ぎ目でオフ
   (判断メモ 31)・オフを待つ間にオンへ戻して録り直した後に古い中止の応答が届く (判断メモ 33)・stop の `abortRecording` で録画の解放が
   reject する (オフの後に warn が 1 行出ないか。判断メモ 35)
   - subagent を派遣できない環境では、自分で spec の各項目と diff を突き合わせ、上の入力例を単体テストか実機で試して結果を記録する
3. branch `feat/master-switch` 上の commit で停止。push / PR / merge はユーザーの指示を待つ。最終報告では、Task 10 の結果 (E2E が通ったか・
   手で確かめられなかった項目・バッジが再起動をまたいで残ったか) を伝える

完了の条件:

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke 7 項目が通る
- `npm run check:telop` の 32 項目がすべて通る (オンの経路の回帰)
- README / CHANGELOG / docs (manual-check・privacy-policy・store-release) にオン / オフの文言が入っている
- `manifest.config.ts` の権限が変わっていない
- whole-branch の cross-review が Approved
