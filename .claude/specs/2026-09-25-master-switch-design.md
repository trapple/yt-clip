# 全機能のオン / オフ (マスタースイッチ)

ツールバーの拡張アイコンを押すと出る popup に、**全機能のオン / オフを切り替えるスイッチ**を置く。
オフの間は YouTube と X のページに何も出さず、ページに何も変えない。

依頼 (2026-09-25、逐語):

> あとここで全機能のon/Offを切り替えたい・
> offのときはUI非表示だし、もとのYouTubeに一切影響をあたえない

「ここ」= popup (`src/popup/`。今は「YouTube の再生画面で IN を押してください」の文言と録画中の進捗バーだけ)。

この spec は `feat/dockable-windows` の **C2 (ドック枠とタブ。spec `2026-09-25-dockable-windows-design.md`) の後**に
実装する前提で書く。C2 がページの流れの中に差すドック枠 (`#yt-clip-dock-below` / `#yt-clip-dock-side`) も、
オフのときに片付ける対象に入れる (§2.2)。

---

## 1. 「一切影響を与えない」の定義

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

## 2. 方式: content script は常に読み込み、オフでは何もしない (案 a)

### 2.1 入口

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

### 2.2 オンのときにページへ触っているものの棚卸しと、片付け方

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

### 2.3 `stop()` の順序

1. `cancelPreviewWatch()`・`cancelWatch()`・`abortRecording()` (このタブで録画が走っていないことは driver の `canStop` が保証する。§4.1。ここで止めるのは範囲再生の監視だけのはず)
2. `chrome.runtime.onMessage` と設定の `chrome.storage.onChanged` の listener を外す (**先に外す**。以後の通知で
   片付けた要素を触りに行かない)
3. `MutationObserver` 2 つと `ResizeObserver` を `disconnect()`、`fullscreenchange` / `resize` を外す、rAF を止める
4. `telopPreview.destroy()`、`clearOverlay()`
5. `dockManager.destroy()` → `rangeBar.destroy()`・`telopTrack.destroy()` → 3 つの窓の `destroy()`
6. モジュールの状態を最初の値に戻す

`start()` はこの逆で、今の import 時の処理 (窓とドック枠と observer を作る → `mount()` → `loadInitialSettings()` →
`loadInitialLayout()` → `recoverFromState()`) をそのまま行う。

### 2.4 オンに戻すとき (読み込み直しは要らない)

- 開いているタブでオンにすると、その場で `start()` が走り、**読み込み直さずに**窓と枠が出る。`recoverFromState()` が
  `content/loaded` を送り、応答の状態で範囲・帯・一覧を取り戻す (タブのリロードと同じ経路。router から見て
  「content script が読み込まれた」と同じ意味なので、メッセージは足さない)
- 覚えた配置の読み込みが済むまで窓を出さない (フロートの窓の spec A.2) のは `start()` の中でも同じ
- 案 (b) (§検討した選択肢) ではオフの間 content script が無いので、オンにしても既に開いているタブには何も出ず、
  読み込み直しを促す文言か `executeScript` が要る。**読み込み直し不要は案 (a) を採る理由の 1 つ**

## 3. 保存: `chrome.storage.local` の `enabled`

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

## 4. 切り替えたときの振る舞い

### 4.1 録画中・書き出し中・投稿の途中でオフにしたとき

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

### 4.2 service worker と状態機械は変えない (オフ ≒ タブが無い)

- **router と状態機械はスイッチを知らない。** オフの間 content script は何も送らず、`onMessage` の listener も無いので、
  service worker から見ると「YouTube のタブが 1 つも無い」のと同じ。既にその場合の扱い (`tab-lost` / `unreachable` /
  `content/loaded` での復帰) を持っている
- 片付けた後に router が `captureTabId` へ同報して失敗する (`Receiving end does not exist`) のは、§4.1 で中止の応答を
  待たずに片付けた直後の `state/changed` と、`composing` の時間切れ (`DEGRADE`) のとき。router は同報の失敗を
  `console.error` に残すだけで止まらない (`publish` は待たない)。受け入れる
- service worker がスイッチを読むのは**ツールバーのバッジのためだけ** (§6.2)

## 5. X の投稿画面 (`x.ts`)

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

## 6. popup とツールバーのアイコン

### 6.1 popup

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

### 6.2 ツールバーのアイコン: オフでバッジ「OFF」

- オフの間、アイコンに**バッジ `OFF`** (地は灰色 `#606060`、文字は白) を出す。オンでは空文字 (バッジ無し)。
  `chrome.action.setBadgeText` / `setBadgeBackgroundColor` / `setBadgeTextColor` は `action` を持つ拡張なら**権限なしで使える**
- **持ち主は service worker** (`src/background/badge.ts`)。`sw.ts` の先頭 (service worker が起きるたび) と
  `chrome.runtime.onStartup` / `onInstalled` で `syncBadge()` (読んで当てる)、`watchEnabled` で変わるたびに当て直す。
  popup が押したときに popup 自身が当てる案は採らない: 持ち主を 1 つにし、DevTools で書いたときも追従させる
- アイコンの絵を灰色に差し替える案は採らない: 4 つの大きさの画像を足して `scripts/make-icons.mjs` を直す手間に対して、
  バッジで同じことが伝わる。可逆

## 7. 作り

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

## 8. 受け入れ条件

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

## テスト

- `src/shared/master-switch.ts` の単体: `readEnabled` (`undefined` → true / `false` → false / `"no"` `1` `null` → warn して true) /
  `loadEnabled` は `get` が reject しても true を返して warn / `saveEnabled` は `set` の reject をそのまま返す /
  `watchEnabled` は `local` の `enabled` だけを拾う (`sync` の `settings`・`local` の `windowLayout` では呼ばない)
- `src/content/switch-driver.ts` の単体 (`chrome.storage` を stub): 最初の読みが true なら `start` 1 回 / false なら何も呼ばない /
  `onChanged` で false → `stop` / true → `start` / 同じ値の `onChanged` では呼ばない / 最初の読みが返る前に `onChanged` が来たら
  最後の値だけが効く (`start` が二度走らない) / `canStop` が偽なら `stop` を待ち `onStopDeferred` を呼ぶ、真になってから
  `reconcile()` で `stop` / `stop` を待っている間に true に戻ったら `stop` を呼ばない / `destroy` で `onChanged` を外す
- `tests/content/youtube.test.ts`: **モジュールの読み込みは 1 回のまま**。`chrome` の stub に `local.get` の `enabled` を足し
  (`storageListener` は 1 本しか覚えていないので配列にする。設定の `sync` とスイッチの `local` で 2 本になる)、
  今の `beforeAll` の `flush()` で `start()` が走るのを待つ (今は `loadInitialLayout` の finally を待っているのと同じ)。足す項目:
  オフの `onChanged` で `[id^="yt-clip-"]` と `[data-role^="dock-"]` が 0 個 / `MutationObserver.disconnect` と
  `ResizeObserver.disconnect` が呼ばれる / `fullscreenchange` / `resize` の `removeEventListener` / `cancelAnimationFrame` が
  呼ばれる / `chrome.runtime.onMessage.removeListener` が呼ばれる (stub に足す) / `.ytp-progress-bar` の中と `video` の親が
  空 / オフの間に `state/changed` が届いても (listener を外し損ねた場合の防御を測る) 何も描かない /
  オンに戻すと `content/loaded` を送り、応答の状態で範囲が戻る / 窓の位置 (`floatLayout`) をオフ → オンで読み直して同じ位置に出る /
  §4.1 の 4 項目 (`recording` で `CANCEL_RECORDING` を送って応答で片付く、`encoding` で `recorder/done` を送り終えてから
  片付く、`preview` でその場、録画していないタブは busy の応答を受けていてもその場で `CANCEL_RECORDING` を送らない) /
  `encoding` を待っている間にオンへ戻したら `stop()` を呼ばない / `start()` の二重呼び出しが throw
- `tests/content/x.test.ts`: import 時に `x/ready` を送らない / `start()` で `/compose/` なら送る / `stop()` で listener が外れ、
  `x/payload` が届いても何もしない / 進行中の `attachPayload` は `stop()` 後も完了して `x/attached` を送る
- `tests/popup/view.test.ts`: `describeSwitch` — オンで `checked` と `showState` / オフで `showState` が偽と文言 /
  **オフ + `seeking` / `recording` で「録画を中止しています…」、オフ + `encoding` で「書き出しが済んだら止まります…」** /
  オフ + `preview` / `posted` / `degraded` で `note` にクリップが残っている旨、`ready` / `idle` では無し /
  **戻り値に `disabled` が無い = どの状態 (busy・`composing`・`failed`・オフ + busy) でも押せる** (型で保証し、テストは
  `checked` が `enabled` だけで決まることを全状態で確かめる)
- `tests/background/badge.test.ts`: `applyBadge(false)` で `setBadgeText({ text: "OFF" })` と地の色、`applyBadge(true)` で `""`
- `e2e/smoke.spec.ts`: §8 の E2E の項目。既存の「IN を指定するとページ内で録画を始められる」の後に、同じタブでオフ → オンを
  測る (IN の範囲が戻ることまで)。popup の項目も同じテストの中で
- `e2e/telop-check.spec.ts`: 変えない (録画の経路にスイッチは関わらない)。「窓の位置の出所」の実測も変えない
- `scripts/screenshots.mjs`: 変えない (popup の絵は掲載しない)

## ドキュメント

- README: 「使い方」の末尾に「**ツールバーの拡張アイコン (popup) のスイッチで、全機能をオフにできる。** オフの間は YouTube と X の
  ページに何も出さず、何も変えない (この端末だけ。同期しない)。オンに戻すと、開いているタブでもそのまま戻る。アイコンに
  `OFF` のバッジが出る」。「仕様と制約」の「操作の置き場所」: 「ポップアップは状態を映すだけで、ボタンは持たない」を
  「ポップアップが持つ操作はオン / オフのスイッチだけ (ページに何も無いときにオンへ戻すため。どの状態でも押せる)」に。制約として
  「**録画中にオフにすると録画は中止される** (■ 中止と同じ。区間とテロップは残り、オンに戻すとそのまま録り直せる)」
  「**書き出し中にオフにすると、書き出しが済んでから消える** (数秒。録れたクリップは残り、オンに戻すとプレビューから続く)」
  「X の投稿画面が開いている間にオフにすると、添付は進まず 30 秒ほどで『X にもう一度投稿』に落ちる (クリップは残る。
  落ちないときはオンに戻したバーの『取り直す』で抜ける)」「オフにしても、作った区間・録画済みのクリップ・
  窓の配置・設定は消えない」
- CHANGELOG の「未リリース」: 「**popup にオン / オフのスイッチを足した。** オフの間は YouTube と X のページに何も出さず、
  何も変えない。アイコンに OFF のバッジが出る。オンに戻すと、開いているタブでもそのまま戻る」
- `docs/manual-check.md`: 「popup」節の「ボタンが 1 つも無い」を「スイッチ以外の操作が無い」に改め、節「オン / オフ」を足す:
  オフで窓・枠・帯・プレビューの canvas が消え、DevTools の Elements で `yt-clip` を検索して 0 件 / オフの間にキーボードの
  `k` `t` `f` と、シークバーのドラッグが今までどおり / 別の動画へ移っても何も出ない / オンに戻すと読み込み直さずに出て、
  IN の範囲が戻る / ドックしていた窓は枠に、動かした窓は同じ位置に / 録画中にオフにすると popup に
  「録画を中止しています…」が出て窓が消え、オンに戻すと区間が残っていて録り直せる / 書き出し中 (「録画を書き出しています…」の
  間) にオフにすると「書き出しが済んだら止まります…」が出て、済んでから窓が消え、popup に「録画したクリップは残っています」が
  出て、オンに戻すとプレビューから続く / `preview` でオフ → オンで「X に投稿」が押せる / 録画中に別の YouTube タブでオフに
  しても (オフは全タブに効く)、録画対象タブだけが中止し、ほかのタブはその場で消える / X の投稿画面を開いたままオフ
  (§8 の実機の項目) / バッジ `OFF` / ブラウザを再起動してもオフのままでバッジも残る / ダーク・ライトで popup が読める /
  オフの間、シークバーのドラッグ・全画面・ミニプレイヤー・`f` `k` `t` が今までどおり
- `docs/privacy-policy.md`: 「端末の中に置くもの」の表に「オン / オフ | `chrome.storage.local` | 拡張を削除したとき」を足し、
  `storage` の説明に「オン / オフ」を足す。**求めている権限は増えない。** 最終更新の日付を改める
- `docs/store-release.md`: §2 の説明文に「■ オン / オフ」(「ツールバーのアイコンのスイッチで全機能を止められます。オフの間は
  YouTube と X のページに何も出さず、何も変えません。オンに戻すと開いているタブでもそのまま戻ります」)、`storage` の説明に
  「オン / オフ (`chrome.storage.local`)」。§7 の「画面を変えたなら」に popup は含めない (掲載画像は変えない)
- `manifest.config.ts` のコメント (「権限を足したら…」) は変えない。**権限を足していない**ことを自律判断ログに残す

## 仮定と根拠

- 「一切影響を与えない」の境界は §1 の表 — 根拠: ページから観測できるもの (DOM・イベント・スクリプトの実行・ネットワーク)
  を 0 にすれば、YouTube にとって拡張が入っていないのと区別が付かない。隔離された world の中のモジュールの評価と
  `chrome.storage` の読みは、ページからは観測できない
- content script は常に読み込み、オフでは何もしない (案 a) — 根拠: 権限を足さない (審査・privacy-policy・
  `store-release` の説明文を触らない)。開いているタブでオンに戻せる。案 (b) は既に開いているタブの片付けに結局 (a) の
  `stop()` が要る (unregister は次の読み込みから効く) ので、(a) に足す形にしかならない。「検討した選択肢」
- 保存は `chrome.storage.local` の `enabled`、既定オン、読めなければ warn してオン — 根拠: 端末ごとの操作 (§3)。
  設定の組と分けるのは同時書き込みで消さないため。既定と読めないときをオンに倒すのは、拡張が黙って消える方が
  黙って出るより分かりにくいから (`loadWindowLayout` の局所例外と同じ判断)。可逆
- スイッチはどの状態でも押せ、録画中のオフは `CANCEL_RECORDING` (seeking / recording) で中止、書き出し中は
  `recorder/done` を送り終えてから片付ける — 根拠: 依頼「全機能の on / off」に録画中の例外は無い。固まりうる状態で
  こそ止められることがスイッチの価値。中止の経路はバーの「■ 中止」と同じで作りが増えない。`encoding` で止めると
  service worker が固まる (router は `recorder/done` を待つ)。クリップは失わない (中止の間はまだ無く、書き出しは待つ)。
  可逆 (待たずに `FAIL recording-aborted` でも区間は残る)
- オンへ戻す操作は常に押せる (`disabled` を持たない) — 根拠: オンに戻す場所は popup だけ。オフ + busy は
  `encoding` を待つ間の読み込み直しで作れ、そこで拒むと戻せない
- `canStop` はこのタブで録画が走っているかで決め、状態機械の busy では決めない — 根拠: busy は応答で受け取った写しで
  録画していないタブでも真になり、そのタブは `state/changed` を受け取らないので永久に待つ
- `composing` ではその場で片付ける — 根拠: 投稿画面が開けないまま待たされている間に止められないと、抜け道が「取り直す」しか
  無い。クリップは `degraded` に残る (時間切れは service worker のタイマー任せなので「30 秒ほどで」と書く)
- service worker と状態機械はスイッチを知らない (オフ ≒ タブが無い) — 根拠: router は「受け手が居ない」場合の扱いを
  既に持つ。状態を消さないので、オンに戻せば続きから使える
- x.ts もスイッチに従う (オフでは `x/ready` を送らない・listener を外す) — 根拠: オフなのに投稿画面に本文と動画が入るのは
  スイッチの意味に反する。進行中の添付は完了させる (半端な本文を残さない)
- popup は「操作を持たない」をスイッチ 1 つだけ破る — 根拠: オンに戻す操作はページに何も無いときに要る。ページの外にしか
  置けない
- オフの間は popup に状態の文言を出さない — 根拠: 「録画できました」と出ていてページには何も無い、を避ける。可逆
- バッジ `OFF` (灰色)、持ち主は service worker — 根拠: 権限なしで使える。アイコンの絵の差し替えは画像 4 つと
  `make-icons.mjs` の手間に対して同じことしか伝わらない。持ち主を 1 つにして DevTools で書いたときも追従させる。可逆
- 読み込み直し不要でオンに戻す — 根拠: `content/loaded` の経路 (タブのリロードと同じ) が既にあり、状態を取り戻せる
- 遅延 `import()` で本体 (58 KB) をオンのときだけ読む案は今は採らない — 根拠: `document_idle` の 58 KB の評価は
  ページの読み込みを遅らせず、YouTube 自身のスクリプトに比べて桁違いに小さい。crxjs が動的 import の chunk を
  `web_accessible_resources` に載せるかを確かめる手間が要る。§1 の表は満たす。測って重ければ足せる (可逆)

## 検討した選択肢

- **採用: (a) content script は常に読み込み、オフでは何もしない** — 権限を足さない。既に開いているタブで即座に消え、
  オンに戻すと読み込み直さずに戻る。`stop()` の棚卸し (§2.2) が受け入れ条件の根拠になる
- 不採用: (b) `chrome.scripting.registerContentScripts` / `unregisterContentScripts` でオフのときは content script 自体を
  注入しない — 権限 `scripting` が要る (manifest の `permissions` に足す → `docs/store-release.md` §2 に権限ごとの説明を
  足す・`docs/privacy-policy.md` の「求めている権限」に行を足す・審査で用途を問われる。`scripting` 自体は Chrome の
  権限の警告 (インストール時の文言) の一覧に無く、ホスト権限の警告で覆われると理解しているが、更新のたびの審査で説明が
  増えることは確実)。manifest の静的な `content_scripts` は unregister できないので、**静的な登録をやめて起動時に動的に
  登録する**ことになり、登録に失敗すると拡張が黙って何もしなくなる (crxjs の開発時の読み込みも静的な登録が前提)。
  unregister は**次の読み込みから**しか効かず、既に開いているタブには script が残るので、(a) の `stop()` が結局要る。
  オンに戻すときは開いているタブに `executeScript` するか読み込み直しを促す必要がある。得られるのは「オフの間の
  58 KB の評価」を無くすことだけで、それはページから観測できない
- 不採用: (a) に遅延 `import()` を足し、オフでは本体を読まない — 「仮定と根拠」の最後の項目。今は測っていない
- 不採用: スイッチを `sync` の `settings` に入れる — 端末をまたいで黙って消える。設定パネルの保存と同時に書くと消える
- 不採用: スイッチを設定パネル (⚙) に置く — オフのときパネルが無く、オンに戻せない
- 不採用: オフで状態機械を `idle` に戻す (`RESET_MARKS`) — 作った区間と録画済みのクリップを捨てる理由が無い。オンに
  戻して続きから使える方がよい
- 不採用: busy の間にオフが届いたら `FAIL recording-aborted` で落とす — 区間は残るが、「録画が中断されました」の文言が
  出る。`CANCEL_RECORDING` なら「■ 中止」と同じ `ready` に戻り、文言も揃う。`encoding` では待つしかない
- 不採用: busy (`seeking` / `recording` / `encoding`) の間はスイッチを押せなくする (`disabled`。この spec の初版の案) —
  依頼「全機能の on / off」に例外が無い。拡張が固まりうる状態でだけスイッチを奪うことになり、「壊れたときに止められる」
  価値と矛盾する。`encoding` にはバーの「■ 中止」が無い (`actionsFor("encoding")` は空) ので、「中止で止めてから」は
  成り立たない。「誤操作で録画を失う」はアイコン → popup → スイッチの 3 段の操作では起きにくく、録画は最長でも設定の
  上限 (既定 60 秒)。`disabled` の条件が `enabled` に依らない実装を許すと、オフ + busy で戻せなくなる (レビューの Issue 1・2)
- 不採用: オフの間は `chrome.runtime.onMessage` の listener を残して `state/changed` を読み捨てる — 読み捨てる listener に
  「描かない」分岐が増える。外せば service worker から見て「タブが無い」と同じで、既存の扱いに乗る
- 不採用: オフをタブごと (このタブだけ) にする — 依頼は「全機能」。タブごとの状態は保存できず (タブの識別子は content
  script から見えない)、YouTube の SPA 遷移でも残るか曖昧になる
- 不採用: アイコンの絵を灰色に差し替える — バッジで足りる (§6.2)
- 不採用: popup がバッジを当てる — 持ち主が 2 つになる。DevTools や別の経路で書いたときに追従しない

## 自律判断ログ

- モード: autonomous (根拠: Auto Mode 既定)。依頼の文言は「全機能の on / off」「off のとき UI 非表示」「もとの YouTube に
  一切影響を与えない」の 3 点で、方式・保存場所・busy のときの扱い・X 側・popup の見た目は依頼に無いので自分で決めた
  (「仮定と根拠」)
- **この spec は別のセッションが同じブランチで C2 を実装している最中に書いた。** 既存のファイルは読んだだけで触っていない。
  C2 の spec と plan (`.claude/plans/2026-09-25-dockable-windows-c2.md`) の `dockManager` (`destroy()` を持つ・import 時に
  作られる) を前提に §2.2 を書いた。C2 の実装が変われば §2.2 の表を合わせる
- [選択] 案 (a)。案 (b) は権限 `scripting` と動的な登録の不安定さに対して、得るものがページから観測できない (§検討した選択肢)
- [選択] `chrome.storage.local` の `enabled`。既定オン、読めなければオン
- [選択 → レビューで変更 (下の [review])] busy は popup で止め、届いたオフは `CANCEL_RECORDING` (seeking / recording) か待つ
  (encoding)。`composing` は止めない
- [選択] スイッチはどの状態でも押せる。録画対象タブが `CANCEL_RECORDING` (seeking / recording) か書き出し待ち (encoding) で
  片付けの条件を自分で作る。`canStop` はこのタブで録画が走っているかで決める
- [選択] service worker と状態機械はスイッチを知らない。バッジだけ
- [選択] x.ts もスイッチに従う。進行中の添付は完了させる
- [選択] popup に状態を出すのはオンのときだけ。スイッチは service worker が居なくても動く
- [選択] 権限を足さない。`manifest.config.ts` は変えない
- [未確定・実装時に確かめる] `chrome.action.setBadgeText` の値がブラウザの再起動をまたいで残るか (残らなければ
  `onStartup` の `syncBadge()` が当て直す。どちらでも受け入れ条件は満たす) / `chrome.runtime.onMessage.removeListener` を
  youtube.test.ts の stub が持っていない (足す) / C2 の `dockManager.destroy()` が目印 (`[data-role=dock-marker]`) を含めて
  枠の根ごと外すこと (根の子なので外れるはず) / E2E で service worker の文脈に数える listener を足す方法 (`worker.evaluate`
  で `chrome.runtime.onMessage.addListener` を張り、`globalThis` に数える。service worker が止まると消えるので、測る直前に
  張り直す)
- [review:spec/依頼者代理人] 1 往復目 Issues 2 件 → 修正: (1) busy の間スイッチを `disabled` にするのをやめ、
  「録画中は `CANCEL_RECORDING` で中止 → 片付け」「書き出し中は `recorder/done` を送り終えてから片付け」を正規の経路にした
  (§4.1)。待っている間の popup の文言を 2 つ決めた (§6.1)。「バーの ■ 中止で止めてから」の文言を消した (`encoding` には
  中止が無い)。(2) オンへ戻す操作はどの状態でも押せると明記し (§4.1 / §6.1)、`describeSwitch` から `disabled` を無くして
  テストに足した。Recommendations 5 件を取り込み: §1 の表にメッセージの例外 (中止・書き出しの結末と `x/attached`) /
  `canStop` をこのタブの録画で決める (状態機械の busy は録画していないタブでも真になり、そのタブは `state/changed` を
  受け取らないので永久に待つ) / オフの文言にクリップが残っている旨 / `composing` の時間切れは「30 秒ほどで」 /
  plan は C2 の commit を base にする。E2E の `k` / `t` を選んだ理由を §8 に添えた
- [順序] C2 → この spec の plan (writing-plans) → 実装。**plan は C2 が commit された後の HEAD を base にする** (`youtube.ts` の
  import 時の `const` (窓 3 つ・`telopPreview`・observer 3 つ・C2 の `dockManager`) を `start()` の中で作る `let` に変える改修は、
  C2 が同じファイルを触っている間に始めると衝突する)。plan では §2.2 の表を「片付けの漏れ」のチェックリストとして使い、
  `youtube.ts` の import 時の副作用を `start()` へ移す方法 (モジュールの `let` を初期値に戻す関数を 1 つ持つ) を決める
- [review:spec/依頼者の代理人/fable] 2 往復目 Approved。残りの Recommendations 4 件 (中止の応答で片付けるための専用の口か state/changed だけに倒すか / describeSwitch の hint とモックの一致 / 対象タブが消えて「中止しています…」が残るときの抜け道を manual-check に / reconcile() を呼ぶ「送り終えた」位置 (notify の then・catch 両方)) は plan の判断メモで扱う
- [選択] 実装スタイル: D (branch + SDD)。branch は feat/dockable-windows (C2 完了、HEAD bb0bd30) から分岐した feat/master-switch (C2 のドック枠も片付け対象のため C2 の上に積む)
- [plan] .claude/plans/2026-09-25-master-switch.md (10 タスク、判断メモ 35)。[review:plan/ゼロ context の実装者/fable] 1 往復目 Issues 3 件 (advanceToSegment の
  非同期の続きが棚卸しから漏れていた / テストの期待件数 / grep パターン) → 修正。Recommendations を取り込み、cancelForSwitch の応答の guard に stateSeq を新設。
  2 往復目 Approved。残りの Recommendations (stale() が同じ録画の中の状態の進みでも応答を捨てるトレードオフの明記 / 継ぎ目のテストの見方) は実装時に扱う。Gate は付けない
