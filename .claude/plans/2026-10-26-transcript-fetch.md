# 文字起こしの取得 (段階 1a) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** YouTube の動画ページを開いたら、公式字幕 (手動 → 自動の順) を発話の行として取り、端末に 30 本まで保存し、吹き替えの音声が流れているかも分かるようにする。表示は段階 1b で作るので、この段階の結末はコンソールに 1 行出すだけ。

**Architecture:** 公式字幕の URL は PO トークン (`pot`) が無いと空で返る (検証 V1)。そこで MAIN world のスクリプト (`caption-bridge`) がプレイヤーに一度字幕を取らせ、そのリクエストの URL を `PerformanceObserver` で拾って返す。隔離された world の content script は `window.postMessage` でそれを頼み、`pot` を写した URL で json3 を取り、行に直して `chrome.storage.local` に保存する。取得の流れは `transcript-loader` が動画ごとに 1 回だけ回し、`youtube.ts` は動画ページに入ったときに頼むだけにする。

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess)、Chrome MV3 (content script の `world: "MAIN"`)、@crxjs/vite-plugin 2.0 beta、vitest 2 (node / jsdom)、Playwright (e2e)

## 段階 1 の分け方

段階 1 (文字起こしの欄・公式字幕・行で区間とテロップ・モード廃止・詰める欄・文字起こしが無いときの道) は独立した部分を 3 つ含むので分ける。**この plan は 1a だけ。** 1b・1c は 1a が終わってから別の plan にする。

| | 中身 | 単独で動くもの |
|---|---|---|
| **1a (この plan)** | 公式字幕の取得・吹き替えの検出・保存 | 動画を開くと字幕が行になって保存される (コンソールで確かめられる) |
| 1b | 文字起こしの欄・行で区間とテロップを作る・モードの廃止・区間は時間順 | 行を選んで切り抜ける |
| 1c | 詰める欄 (単語と ±0.1)・拡大バー / 帯 / 一覧の撤去・文字起こしが無いときの道 | 繋ぎ目を詰められる。古い UI が消える |

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- 依頼 (2026-10-25): 「近い将来文字起こしはほぼ自動で行われることを前提としたものでよいです。」
- 回答 (2026-10-25): 「２．基本喋りベース」「４．取り方を設定で変えれるようにしたい（公式字幕・PC内音声認識・外部API）」
- 回答 (2026-10-26): 「3 一旦それで」(文字起こしの保存は新しい順に 30 本まで)、「4 知らせるだけ」(吹き替えの音声が流れていたら知らせるだけ)
- 公式字幕は「手動の字幕 → 自動字幕の順」で選ぶ (第 2 版のモックの設定欄)
- 検証 V1 の結果 (2026-10-19): 字幕の一覧の URL をそのまま取ると 200 で 0 バイト。プレイヤーが字幕を取りに行ったときの URL の `pot` ほかの引数を写すと、同じ動画の全字幕が取れる。別の動画の `pot` は効かない。拾うのは `PerformanceObserver` で (既定のリソースの記録は 250 件で埋まって拾えなくなる)。自動操作の Chromium (Playwright) ではプレイヤー自身の取得も 0 バイト
- 吹き替えの検出 (2026-10-26 に実機で確認): `#movie_player` の `getAudioTrack().id` は `251;<base64url>` の形で、base64url を開くと `acont` と `dubbed-auto` (オリジナルは `original`) が入っている
- ADR: `docs/adr/0001-transcript-first-editor.md`、`docs/adr/0002-official-captions-via-player-pot.md` (Task 1 で書く)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ に CLAUDE.md と `.claude/rules/` は無い。ユーザーのグローバル設定 (`~/.claude/CLAUDE.md`) と、既存コードの慣習から:

- ドキュメントとコード両方に修正がある場合、先にドキュメントを直してからコードに着手する (Task 1 が文書)
- git は `git -C <dir> ...` で叩く
- 時刻は UTC epoch ミリ秒で持ち、名前かコメントでそう書く (`savedAt`)
- 外部プロセス・待ちには必ず上限を付ける (ブリッジの応答 2 秒 / 8 秒、字幕の取得 10 秒、`pot` を待つ 5 秒)
- **Fail Fast**: 呼び出し側のバグは throw する。握り潰すときは理由をコメントで書く (既存の `※ 局所例外 (Fail Fast): ...` の書き方)
  - ※ 局所例外: 保存された文字起こしが壊れていても throw せず、warn を残して取り直す (読めない保存値で拡張が止まるより取り直す方がよい。`loadWindowLayout` と同じ判断)
  - ※ 局所例外: 文字起こしの保存に失敗しても、取れた行は使う。warn を残す (保存は取り直しを省くためだけ)
- コメントとコミットメッセージは日本語。コミットは Conventional Commits の prefix + 1 行目の要約 + 空行 + Why の本文
- 依存は引数で差し替えられるようにして (`deps`)、テストは本物の chrome API を使わない (`src/popup/channel.ts` と同じ作法)
- 権限を足したら `docs/store-release.md` も直す (`manifest.config.ts` のコメント)。**この plan では権限は増えない**が、端末に置くものが増えるので `docs/store-release.md` の用途説明とデータの扱いは直す (Task 1)

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous (根拠: Auto Mode 既定)
- 隔離: branch。`feat/transcript-editor` (作成済み。`feat/master-switch` の `ef80dd8` から)
- 実装方式: B (branch + 直列)。タスクがほぼ 1 本の依存の鎖で、同じファイル (`manifest.config.ts`・`youtube.ts`) を触るため
- 既知の失敗: `e2e/smoke.spec.ts` の「オフにすると 1 秒以内に拡張の要素が消え…」は、この plan の前から落ちる (Chromium 153 の警告 `Unsafe attempt to load URL chrome-extension://…` を拡張のログとして数えている)。この plan では直さない。他の e2e が落ちたら直す

---

## ファイル構造

| ファイル | 種別 | 責務 |
|---|---|---|
| `docs/adr/0001-transcript-first-editor.md` | Create | 文字起こしを主役にした編集画面の決定 |
| `docs/adr/0002-official-captions-via-player-pot.md` | Create | 公式字幕をプレイヤーの `pot` を使い回して取る決定 |
| `docs/privacy-policy.md` | Modify | 文字起こしを端末に置くこと |
| `docs/manual-check.md` | Modify | 文字起こしの取得の手動確認 |
| `src/shared/transcript.ts` | Create | 行の型と json3 からの読み取り (純粋関数) |
| `src/content/caption-bridge-protocol.ts` | Create | 2 つの world の間のメッセージの形と判定、吹き替えの判定 |
| `src/content/caption-bridge.ts` | Create | MAIN world で動く処理 (プレイヤーに字幕を取らせて URL を拾う) |
| `src/content/caption-bridge-main.ts` | Create | MAIN world の入口 (`installBridge()` を呼ぶだけ) |
| `src/content/caption-source.ts` | Create | 隔離された world から頼んで json3 を取り、行にする |
| `src/content/transcript-cache.ts` | Create | `chrome.storage.local` への保存 (30 本・1 本 300KB まで) |
| `src/content/transcript-loader.ts` | Create | 動画ごとに 1 回、保存 → 取得 → 保存を回す。状態を知らせる |
| `src/content/youtube.ts` | Modify | start / mount / stop で loader を使う |
| `manifest.config.ts` | Modify | MAIN world の content script を足す |
| `tests/shared/transcript.test.ts` 他 | Create | 各モジュールのテスト |
| `e2e/captions.spec.ts` | Create | 実ブラウザで MAIN world のブリッジが答えること |

---

### Task 1: 文書 (ADR・プライバシーポリシー・手動確認)

**Files:**
- Create: `docs/adr/0001-transcript-first-editor.md`
- Create: `docs/adr/0002-official-captions-via-player-pot.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/manual-check.md`
- Modify: `docs/store-release.md`

**Interfaces:**
- Produces: Global Constraints が参照する ADR の path

- [ ] **Step 1: ADR 0001 を書く**

`docs/adr/0001-transcript-first-editor.md`:

```markdown
# 0001. 文字起こしの行を主役にした編集画面にする

- 状態: 採用 (2026-10-26)
- 覆すもの: `.claude/specs/2026-09-24-telop-design.md` の「スタイルは全テロップ共通」「テロップの時刻の決め方: 開始を今に / 終了を今に」、`.claude/specs/2026-09-23-edit-mode-segments-design.md` のシンプル / エディットのモードと「区間は拾った順に繋ぐ」

## Context

テロップを足してから操作が重くなった (依頼 2026-10-25「テロップを追加する機能を追加しはじめてからUI/UXの著しい低下を感じます」)。原因は、テロップの時刻を人が「開始を今に / 終了を今に」で合わせていることと、操作の置き場所が 2 つの窓 × 3 通りの居場所に割れていること。依頼は、文字起こしがほぼ自動で付く前提で作り直してよいとしている。

3 案 (台本で切る / 編集室 / 拾って並べる) をモックで見せ、回答「決めた場所を詰める」「基本喋りベース」「(テロップの見た目を行ごとに) 変えたい」「取り方を設定で変えれるようにしたい（公式字幕・PC内音声認識・外部API）」を受けて第 2 版「台本で選び、波形で詰める」に絞り、了承を得た。

## Decision

- 文字起こしの行を選ぶと、続いた行が 1 つの区間になり、行の文字がそのままテロップになる。テロップの時刻は行の時刻を使い、人は合わせない
- 選んだ区間はプレイヤーの下の「詰める欄」で、波形と単語を見ながら頭と尻を詰める
- シンプル / エディットのモードを無くす。区間が 1 つならシンプルと同じ
- 区間は動画の時間順に繋ぐ (回答 2026-10-26「1ok」)
- テロップの見た目は「型」を行ごとに選び、色・大きさ・位置だけ行で上書きできる
- 文字起こしの取り方は公式字幕・PC 内の音声認識・外部 API の 3 通りを設定で順に試す。外部 API は ChatGPT の予定で後回し (回答 2026-10-26)
- 吹き替えの音声が流れていたら知らせるだけ (回答 2026-10-26「4 知らせるだけ」)
- 文字起こしは動画ごとに端末に保存し、新しい順に 30 本まで (回答 2026-10-26「3 一旦それで」)

## Considered Options

- 編集室 (全面の編集画面): 詰める精度は最も高いが、見ている最中にさっと切る軽さが無く、作る量が最も多い。詰めきれない声が出たら「詳しく編集」として後から足せる
- 拾って並べる (見ながら一文ずつカゴに入れる): 回答「決めた場所を詰める」の使い方と合わない
- 帯を残して行の時刻を初期値にする: 帯の制約 (2 段まで・+N・範囲の中だけ) がそのまま残る

## Consequences

- 後ろの場面を先に置く・同じ場面を 2 回使う、はできなくなる (時間順で、行の選択は排他)
- 公式字幕以外の取り方 (PC 内の音声認識・外部 API) は、拡張が音声ファイルを取りに行かないため、`captureStream()` で流れてくる**再生した所の音しか**文字にできない
- 喋りの無い動画のために、時間で区間を作る道とテロップを手で足す道を脇に残す
- 作る順: 1a 公式字幕の取得 → 1b 文字起こしの欄 → 1c 詰める欄 → 2 波形 → 3 行ごとの見た目 → 4 PC 内の音声認識 → 5 外部 API
```

- [ ] **Step 2: ADR 0002 を書く**

`docs/adr/0002-official-captions-via-player-pot.md`:

```markdown
# 0002. 公式字幕は、プレイヤーに一度取らせた URL の pot を使い回して取る

- 状態: 採用 (2026-10-26)

## Context

公式字幕の一覧 (`captionTracks`) はプレイヤーの応答にあるが、その `baseUrl` をそのまま取ると 200 で中身が 0 バイトになる。URL の `exp=xpe` から、YouTube が字幕の取得に PO トークン (`pot`) を求めていると見られる。innertube の player API を直接呼んでも `UNPLAYABLE` が返る (2026-10-19 の検証 V1)。

プレイヤー自身が字幕を取りに行くときは `pot` 付きで取り、それは成功する。その URL の `pot` ほかの引数を写すと、**同じ動画の**全言語・手動 / 自動の字幕が取れた。別の動画の `pot` は効かない。

## Decision

- MAIN world の content script (`src/content/caption-bridge-main.ts`) を置き、頼まれたときだけ:
  1. `#movie_player` の `getPlayerResponse()` から字幕の一覧を読む
  2. 字幕の表示を CSS で隠し、`setOption("captions", "track", …)` でプレイヤーに字幕を取りに行かせる
  3. `PerformanceObserver` で `/api/timedtext` の `pot` 付き URL のうち、頼まれた動画のもの (`v=`) を拾う (最大 5 秒)
  4. 字幕を元の状態 (オフならオフ、オンなら同じ字幕) に戻し、表示を戻す
- 隔離された world の content script が `window.postMessage` で頼み、拾った URL の `pot` ほかの引数を、選んだ字幕の `baseUrl` に写して json3 で取る
- 吹き替えの判定も同じブリッジで返す (`getAudioTrack().id` の後半の base64url に `acont` と `dubbed` が入っているか)

## Considered Options

- `baseUrl` をそのまま取る: 0 バイト
- innertube の player API を自分で呼ぶ: `UNPLAYABLE`。PO トークンを自前で作るのは BotGuard を相手にすることになり、続かない
- 字幕のボタンを押して表示中の字幕を DOM から読む: 画面に出た分しか読めない。時刻も粗い

## Consequences

- YouTube の非公開 API (`getPlayerResponse` / `setOption` / `getAudioTrack`) と字幕の URL の形に依存する。変われば壊れる。壊れたら「文字起こしを取れませんでした: …」と理由を出し、他の取り方 (段階 4・5) に進む
- 取る間だけ、プレイヤーが字幕を取りに行く (字幕の表示は隠す)。字幕がオンの人の設定は変えない
- 広告が流れている間 (`#movie_player` に `ad-showing`) は取らずに待つ (最長 3 分)。広告の間はプレイヤーの動画も字幕も本編のものにならない
- 自動操作のブラウザではプレイヤーの取得自体が空になるので、e2e では字幕の中身までは確かめられない。e2e はブリッジが一覧を返すところまで、中身は手動確認 (`docs/manual-check.md`)
- MAIN world のスクリプトは**オフの間も読み込まれ、`message` の listener を 1 本置く**。頼まれない限り何もしない (頼むのは隔離された world のオンの間だけ)。ページの見た目もページのデータも変えない
- 権限は増えない (`https://www.youtube.com/*` のホスト権限の中で動く)
- **未決: YouTube 利用規約 (「許可されない行為」) とウェブストアの審査への影響。** プレイヤーの PO トークンを使い回して非公開の字幕 URL を取るので、保護手段の回避とみなされるおそれがある。ユーザーの判断 (2026-10-26): 進め、ストアに出す前に録画の件 (`docs/store-release.md` §1) とまとめて判断する。差し戻されたら公式字幕を外せるよう、取り方は設定で切れる形にする (設定の欄は段階 1b 以降。取り方の順番を決める設定に入れる)
- オフにしたら走っている取得を止める (広告を待っている間も)。**新しく頼むのはオンの間だけ**: すでにページへ送った頼みは止められず、MAIN world で順に答えられる (長くても数十秒。頼み直しの回数で抑える)
- 広告を待つ間 (最長 3 分) は、文字起こしの用意が終わらない (保存から読めた動画の吹き替えの判定も同じ。読めなければ偽)
```

- [ ] **Step 3: プライバシーポリシーを直す**

`docs/privacy-policy.md` を 6 か所直す。

1 行目付近の日付:
```
最終更新: 2026-09-25
```
→
```
最終更新: 2026-10-26
```

「集めていないもの」の 1 項目:
```
- 閲覧履歴、視聴した動画、検索語を記録しない
```
→
```
- 閲覧履歴、検索語を記録しない。視聴した動画は、文字起こしを取り直さずに済むよう、直近 30 本の動画の ID と字幕の文字を端末の中にだけ置く (外へは送らない。下表)
```

「端末の中に置くもの」の表の `オン / オフ` の行の下に 1 行足す:
```
| 文字起こし (YouTube の字幕から読んだ発話の文字と時刻。動画ごとに、新しい順に 30 本まで) | `chrome.storage.local` | 31 本目を保存したとき古いものから / 拡張を削除したとき |
```

「求めている権限」の `storage` の行:
```
| `storage` | 上表の設定・窓の位置と大きさとどの枠に入れたか・オン / オフ・進行状態を端末内に置くため |
```
→
```
| `storage` | 上表の設定・窓の位置と大きさとどの枠に入れたか・オン / オフ・文字起こし・進行状態を端末内に置くため |
```

`https://www.youtube.com/*` の行:
```
| `https://www.youtube.com/*` | 再生画面に操作 UI を出し、選ばれた区間を録画するため |
```
→
```
| `https://www.youtube.com/*` | 再生画面に操作 UI を出し、選ばれた区間を録画するため。動画の字幕 (YouTube が公開しているもの) を読むため |
```

表の下の本文:
```
`chrome.storage.local` に置いた窓の位置と大きさ・どの枠に入れたか・オン / オフは、その端末の中にだけ残り、同期されない。
```
→
```
`chrome.storage.local` に置いた窓の位置と大きさ・どの枠に入れたか・オン / オフ・文字起こしは、その端末の中にだけ残り、同期されない。
```

- [ ] **Step 4: ストアの申請文を直す**

`docs/store-release.md` を 3 か所直す (プライバシーポリシーと食い違わせない)。

`### \`storage\`` の節の
```
> 全機能のオン / オフを端末ごとに保存する (`chrome.storage.local`)。
```
の次の行に足す:
```
> 動画の字幕から読んだ文字起こし (発話の文字と時刻) を、取り直さずに済むよう動画ごとに端末に保存する。新しい順に 30 本まで (`chrome.storage.local`)。
```

`### \`https://www.youtube.com/*\`` の節の
```
> 再生画面に操作 UI を差し込み、選ばれた区間の動画を録画するため。
```
→
```
> 再生画面に操作 UI を差し込み、選ばれた区間の動画を録画するため。動画の字幕 (YouTube が公開しているもの) を読み、文字起こしとして使うため。
```

`### データの取り扱い (Privacy practices)` の
```
- 窓の位置と大きさ・どの枠に入れたか・オン / オフは端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```
→
```
- 窓の位置と大きさ・どの枠に入れたか・オン / オフ・文字起こし (直近 30 本の動画の字幕) は端末の中 (`chrome.storage.local`) にだけ置き、同期もしない
```

「オフの間は YouTube と X のページに何も出さず、何も変えません」は**直さない**。MAIN world の listener はページの見た目もデータも変えない (ADR 0002)。

- [ ] **Step 5: 手動確認の項目を足す**

`docs/manual-check.md` の `## 拡大バーの操作 (詳細)` の見出しの直前に、次の節を足す:

```markdown
## 文字起こし (公式字幕)

拡張を読み込んだ普段の Chrome で確かめる (自動操作のブラウザでは字幕が空で返る。ADR 0002)。結末は DevTools のコンソールに `[yt-clip] 文字起こし…` の 1 行で出る。

- [ ] **手動字幕のある動画** (例: `SmxSCZzV7j0`) を開くと `[yt-clip] 文字起こし: 公式字幕 N 行` が出る。N が数十以上
- [ ] **自動字幕だけの動画** (例: `l_OH3BlNOEo`) を開くと `[yt-clip] 文字起こし: 公式字幕 (自動) N 行` が出る
- [ ] **字幕の無い動画**で `[yt-clip] 文字起こし: この動画には公式字幕がありません` が出る
- [ ] **字幕をオフにしている人**: 取る間に字幕が画面に出ない。取った後も字幕のボタンがオフのまま
- [ ] **字幕をオンにしている人**: `公式字幕 N 行` が出る (字幕を選び直してもプレイヤーが取り直さないと、ここで失敗する)。取った後も同じ言語の字幕がオンのまま出ている
- [ ] **動画の前に広告が流れるとき**: 広告の間は取りに行かず、広告が明けてから `公式字幕 N 行` が出る
- [ ] **同じ動画を開き直すと取りに行かない** (DevTools の Network に `timedtext` が出ない。保存から読む)
- [ ] **吹き替えの音声が流れている動画** (例: `5JeOw-Tt3N0` を日本語の環境で) で、行数の後ろに `(吹き替えの音声が流れています)` が出る
- [ ] **SPA で別の動画へ移ると**、移った先の動画の字幕が取れる (前の動画の行数が出ない)
- [ ] **オフの間はどれも起きない** (コンソールに `[yt-clip] 文字起こし…` が出ない。`timedtext` も取りに行かない)
- [ ] DevTools の Application → Storage → Extension storage (local) に `transcript:<動画 ID>` と `transcriptIndex` がある。31 本目を開くと最も古いものが消える
```

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/adr docs/privacy-policy.md docs/manual-check.md docs/store-release.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
docs: 文字起こしを主役にした編集画面と、公式字幕の取り方を先に書く

テロップを足してから操作が重くなった件で、文字起こしの行で区間とテロップを作る形に作り直すと決めた。
前の設計 (全テロップ共通の見た目・開始を今に・モード・拾った順) を覆すので、理由を ADR に残す。
公式字幕は pot が無いと空で返るため、プレイヤーに一度取らせた URL を使い回す。非公開 API に頼る判断なので
これも ADR にする。文字起こしを端末に 30 本置くことをプライバシーポリシーとストアの申請文に、確かめ方を手動確認に書く。
EOF
```

---

### Task 2: 行の型と json3 の読み取り

**Files:**
- Create: `src/shared/transcript.ts`
- Test: `tests/shared/transcript.test.ts`

**Interfaces:**
- Produces:
  - `type TranscriptWord = { startSec: number; endSec: number; text: string }`
  - `type TranscriptLine = { id: string; startSec: number; endSec: number; text: string; words?: TranscriptWord[] }`
  - `type TranscriptSource = "youtube-manual" | "youtube-asr"`
  - `type Transcript = { videoId: string; source: TranscriptSource; language: string; lines: TranscriptLine[]; savedAt: number }`
  - `function parseJson3(json: unknown, source: TranscriptSource): TranscriptLine[]`
  - `const ASR_LINE_GAP_SEC = 0.8`、`const ASR_LINE_MAX_CHARS = 32`

- [ ] **Step 1: 失敗するテストを書く**

`tests/shared/transcript.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { ASR_LINE_MAX_CHARS, parseJson3 } from "@/shared/transcript";

describe("parseJson3 (手動字幕)", () => {
  test("event 1 つを 1 行にする。改行は空白、時刻は秒", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 0, dDurationMs: 200000, id: 1, wpWinPosId: 1 },
          { tStartMs: 127900, dDurationMs: 3100, segs: [{ utf8: "そう思ってる人も\n多いと思います。" }] },
          { tStartMs: 131000, dDurationMs: 7700, segs: [{ utf8: "あとは、" }, { utf8: "やっぱり" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines).toEqual([
      { id: "youtube-manual:127.90", startSec: 127.9, endSec: 131, text: "そう思ってる人も 多いと思います。" },
      { id: "youtube-manual:131.00", startSec: 131, endSec: 138.7, text: "あとは、やっぱり" },
    ]);
  });

  test("空白だけの event と長さ 0 の event は行にしない", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "\n" }] },
          { tStartMs: 2000, dDurationMs: 0, segs: [{ utf8: "長さ 0" }] },
        ],
      },
      "youtube-manual",
    );
    expect(lines).toEqual([]);
  });
});

describe("parseJson3 (自動字幕)", () => {
  const events = [
    { tStartMs: 3030, dDurationMs: 5010 },
    {
      tStartMs: 3040,
      dDurationMs: 7840,
      segs: [
        { utf8: "です" },
        { utf8: "か", tOffsetMs: 119 },
        { utf8: "はい。", tOffsetMs: 879 },
        { utf8: "今日", tOffsetMs: 1120 },
        { utf8: "は", tOffsetMs: 1319 },
      ],
    },
    { tStartMs: 7000, dDurationMs: 10, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: "11" }, { utf8: "月", tOffsetMs: 440 }] },
  ];

  test("単語に平らにして、句点・沈黙で行に割る。単語の時刻を残す", () => {
    expect(parseJson3({ events }, "youtube-asr")).toEqual([
      {
        id: "youtube-asr:3.04",
        startSec: 3.04,
        endSec: 4.16,
        text: "ですかはい。",
        words: [
          { startSec: 3.04, endSec: 3.16, text: "です" },
          { startSec: 3.16, endSec: 3.92, text: "か" },
          { startSec: 3.92, endSec: 4.16, text: "はい。" },
        ],
      },
      {
        // 「は」の後は 2 秒以上空くので割る。最後の単語は event の終わりか 1.5 秒の短い方まで
        id: "youtube-asr:4.16",
        startSec: 4.16,
        endSec: 5.86,
        text: "今日は",
        words: [
          { startSec: 4.16, endSec: 4.36, text: "今日" },
          { startSec: 4.36, endSec: 5.86, text: "は" },
        ],
      },
      {
        id: "youtube-asr:8.00",
        startSec: 8,
        endSec: 9.94,
        text: "11月",
        words: [
          { startSec: 8, endSec: 8.44, text: "11" },
          { startSec: 8.44, endSec: 9.94, text: "月" },
        ],
      },
    ]);
  });

  test("英語の単語の間の空白は行の文字に残し、単語の文字からは除く", () => {
    const [line] = parseJson3(
      {
        events: [
          {
            tStartMs: 0,
            dDurationMs: 2000,
            segs: [{ utf8: "We're" }, { utf8: " no", tOffsetMs: 300 }, { utf8: " strangers", tOffsetMs: 600 }],
          },
        ],
      },
      "youtube-asr",
    );
    expect(line?.text).toBe("We're no strangers");
    expect(line?.words?.map((word) => word.text)).toEqual(["We're", "no", "strangers"]);
  });

  test("句点が来なくても、文字数の上限を超える前で割る", () => {
    const segs = Array.from({ length: ASR_LINE_MAX_CHARS + 1 }, (_, i) => ({ utf8: "あ", tOffsetMs: i * 100 }));
    const lines = parseJson3({ events: [{ tStartMs: 0, dDurationMs: 10000, segs }] }, "youtube-asr");
    expect(lines.map((line) => line.text.length)).toEqual([ASR_LINE_MAX_CHARS, 1]);
  });

  test("event をまたいで重なる単語は、次の単語の頭で止める", () => {
    const lines = parseJson3(
      {
        events: [
          { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "前" }] },
          { tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: "後" }] },
        ],
      },
      "youtube-asr",
    );
    expect(lines[0]?.words?.[0]).toEqual({ startSec: 0, endSec: 0.5, text: "前" });
  });
});

test("events の無い値は字幕ではないので throw する", () => {
  expect(() => parseJson3({}, "youtube-manual")).toThrow(TypeError);
  expect(() => parseJson3(null, "youtube-asr")).toThrow(TypeError);
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/transcript.test.ts`
期待: FAIL (`Failed to resolve import "@/shared/transcript"`)

- [ ] **Step 3: 最小実装**

`src/shared/transcript.ts`:

```typescript
/**
 * 文字起こし (発話の行) の形と、YouTube の字幕 (json3) からの読み取り。
 *
 * **時刻は元動画の秒** (テロップと同じ。区間を詰めても行が発話に付いてくる)。
 * 取り方が増えても (段階 4 の PC 内の音声認識・段階 5 の外部 API) 行の形はこれ 1 つにする (ADR 0001)
 */

/** 単語。自動字幕と音声認識だけが持つ (詰める欄でハンドルを単語の切れ目に合わせる) */
export type TranscriptWord = { startSec: number; endSec: number; text: string };

export type TranscriptLine = {
  /** 取り方と開始時刻から作る。取り直しても同じ行は同じ id になり、テロップの行への参照が外れない */
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  words?: TranscriptWord[];
};

/** どこから取ったか。段階 4・5 で増える */
export type TranscriptSource = "youtube-manual" | "youtube-asr";

export type Transcript = {
  videoId: string;
  source: TranscriptSource;
  /** 字幕の言語 (YouTube の languageCode。`ja` / `en-US` など) */
  language: string;
  lines: TranscriptLine[];
  /** 保存した時刻 (UTC epoch ミリ秒)。動画の中の秒とは別物 */
  savedAt: number;
};

/** json3 の形のうち使う所だけ */
type Json3Seg = { utf8?: string; tOffsetMs?: number };
type Json3Event = { tStartMs?: number; dDurationMs?: number; segs?: Json3Seg[] };

/** 自動字幕を行に割るとき、これより長い沈黙で割る (秒) */
export const ASR_LINE_GAP_SEC = 0.8;
/** 自動字幕の 1 行の文字数の上限。句点が来なくてもここで割る (テロップの 1 行に収まる目安) */
export const ASR_LINE_MAX_CHARS = 32;
/** event の最後の単語の長さの上限 (ミリ秒)。次の単語が無いと終わりが分からない */
const LAST_WORD_MAX_MS = 1500;
/** 行の長さの下限 (秒)。単語の時刻が潰れていても、長さ 0 の行は作らない */
const MIN_LINE_SEC = 0.1;
const SENTENCE_END = /[。！？!?]$/;

const round2 = (sec: number): number => Math.round(sec * 100) / 100;
const lineId = (source: TranscriptSource, startSec: number): string => `${source}:${startSec.toFixed(2)}`;

function eventsOf(json: unknown): Json3Event[] {
  if (json === null || typeof json !== "object" || !Array.isArray((json as { events?: unknown }).events)) {
    throw new TypeError("字幕 (json3) の形ではありません: events がありません");
  }
  return (json as { events: Json3Event[] }).events;
}

/** 手動字幕: event 1 つが 1 行 (字幕を作った人の区切り)。改行は空白にする */
function parseManual(events: Json3Event[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const event of events) {
    if (event.segs === undefined || event.tStartMs === undefined) continue;
    const text = event.segs
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (text === "") continue;
    const startSec = round2(event.tStartMs / 1000);
    const endSec = round2((event.tStartMs + (event.dDurationMs ?? 0)) / 1000);
    if (endSec <= startSec) continue;
    lines.push({ id: lineId("youtube-manual", startSec), startSec, endSec, text });
  }
  return lines;
}

type Piece = { word: TranscriptWord; raw: string };

/**
 * 自動字幕: 単語に平らにしてから、句点・沈黙・文字数で行に割る。
 * event の区切りは画面に 2 行ずつ流す都合で、文と合わない (「…伝えたい。そう」のように文をまたぐ)
 */
function parseAsr(events: Json3Event[]): TranscriptLine[] {
  const pieces: Piece[] = [];
  for (const event of events) {
    const segs = event.segs;
    const base = event.tStartMs;
    if (segs === undefined || base === undefined) continue;
    const eventEndMs = base + (event.dDurationMs ?? 0);
    segs.forEach((seg, i) => {
      // 英語の単語は頭に空白を持つ (" no")。行の文字のために生の文字も残す
      const raw = (seg.utf8 ?? "").replace(/\n/g, "");
      const text = raw.trim();
      if (text === "") return;
      const startMs = base + (seg.tOffsetMs ?? 0);
      const nextOffset = segs[i + 1]?.tOffsetMs;
      const endMs =
        nextOffset !== undefined ? base + nextOffset : Math.min(eventEndMs, startMs + LAST_WORD_MAX_MS);
      pieces.push({ word: { startSec: startMs / 1000, endSec: Math.max(endMs, startMs) / 1000, text }, raw });
    });
  }
  pieces.sort((a, b) => a.word.startSec - b.word.startSec);
  // event をまたぐと、前の単語の終わりが次の単語の頭を越えうる。次の頭で止める
  pieces.forEach((piece, i) => {
    const next = pieces[i + 1];
    if (next !== undefined && piece.word.endSec > next.word.startSec) piece.word.endSec = next.word.startSec;
  });

  const lines: TranscriptLine[] = [];
  let current: Piece[] = [];
  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    const startSec = round2(first.word.startSec);
    lines.push({
      id: lineId("youtube-asr", startSec),
      startSec,
      endSec: Math.max(round2(last.word.endSec), round2(startSec + MIN_LINE_SEC)),
      text: current.map((piece) => piece.raw).join("").trim(),
      words: current.map((piece) => ({
        startSec: round2(piece.word.startSec),
        endSec: round2(piece.word.endSec),
        text: piece.word.text,
      })),
    });
    current = [];
  };
  for (const piece of pieces) {
    const last = current[current.length - 1];
    const length = current.reduce((sum, p) => sum + p.word.text.length, 0);
    if (
      last !== undefined &&
      (piece.word.startSec - last.word.endSec > ASR_LINE_GAP_SEC ||
        length + piece.word.text.length > ASR_LINE_MAX_CHARS)
    ) {
      flush();
    }
    current.push(piece);
    if (SENTENCE_END.test(piece.word.text)) flush();
  }
  flush();
  return lines;
}

/**
 * YouTube の字幕 (json3) を行にする。**形が違えば throw する** (字幕の URL が別のものを返した = 取り方の前提が崩れた。
 * 黙って空にすると「字幕が無い」と見分けが付かない)
 */
export function parseJson3(json: unknown, source: TranscriptSource): TranscriptLine[] {
  const events = eventsOf(json);
  return source === "youtube-asr" ? parseAsr(events) : parseManual(events);
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/shared/transcript.test.ts && npm run typecheck`
期待: PASS (7 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/transcript.ts tests/shared/transcript.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(shared): YouTube の字幕 (json3) を発話の行にする

文字起こしの行で区間とテロップを作るため (ADR 0001)、行の形を 1 つ決める。手動字幕は event を 1 行に、
自動字幕は event の区切りが文と合わないので、単語に平らにしてから句点・沈黙・文字数で割り、単語の時刻を残す
(詰める欄で単語の切れ目に合わせるため)。
EOF
```

---

### Task 3: 2 つの world の間のメッセージの形と、吹き替えの判定

**Files:**
- Create: `src/content/caption-bridge-protocol.ts`
- Test: `tests/content/caption-bridge-protocol.test.ts`

**Interfaces:**
- Produces:
  - `const BRIDGE_REQUEST = "yt-clip/captions-request"`、`const BRIDGE_RESPONSE = "yt-clip/captions-response"`、`const POT_WAIT_MS = 5000`
  - `type CaptionTrack = { baseUrl: string; languageCode: string; kind: "asr" | "manual"; name: string }`
  - `type BridgeParams = { videoId: string; wantPot: boolean }`
  - `type BridgeRequest = BridgeParams & { type: typeof BRIDGE_REQUEST; id: string }`
  - `type BridgeAnswer = { ok: true; tracks: CaptionTrack[]; potUrl: string | null; dubbed: boolean } | { ok: false; reason: "no-player" | "video-mismatch" | "ad-showing" }`
  - `type BridgeResponse = BridgeAnswer & { type: typeof BRIDGE_RESPONSE; id: string }`
  - `function isBridgeRequest(value: unknown): value is BridgeRequest`
  - `function isBridgeResponse(value: unknown): value is BridgeResponse`
  - `function isDubbedTrackId(id: string | undefined): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/caption-bridge-protocol.test.ts`:

```typescript
import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  isBridgeRequest,
  isBridgeResponse,
  isDubbedTrackId,
} from "@/content/caption-bridge-protocol";

/** プレイヤーの音声トラックの id の形 (`itag;<base64url の protobuf>`) を作る */
const trackId = (tags: string): string => `251;${Buffer.from(tags, "latin1").toString("base64url")}`;

describe("isDubbedTrackId", () => {
  test("実機の吹き替えの id (acont=dubbed-auto) は真", () => {
    expect(isDubbedTrackId("251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoKCgRsYW5nEgJqYQ")).toBe(true);
  });

  test("オリジナルの音声 (acont=original) は偽", () => {
    expect(isDubbedTrackId(trackId("\n\x11\n\x05acont\x12\x08original"))).toBe(false);
  });

  test("吹き替えの印を作った id も真 (base64url の詰め物なし)", () => {
    expect(isDubbedTrackId(trackId("\n\x14\n\x05acont\x12\x0bdubbed-auto"))).toBe(true);
  });

  test("音声トラックが 1 つの動画 (後半なし)・取れない・壊れた id は偽", () => {
    expect(isDubbedTrackId("251")).toBe(false);
    expect(isDubbedTrackId("251;")).toBe(false);
    expect(isDubbedTrackId(undefined)).toBe(false);
    expect(isDubbedTrackId("251;!!!")).toBe(false);
  });
});

describe("isBridgeRequest", () => {
  test("形の合う頼みだけ真", () => {
    expect(isBridgeRequest({ type: BRIDGE_REQUEST, id: "a", videoId: "v", wantPot: true })).toBe(true);
    expect(isBridgeRequest({ type: BRIDGE_REQUEST, id: "a", videoId: "v" })).toBe(false);
    expect(isBridgeRequest({ type: "other", id: "a", videoId: "v", wantPot: true })).toBe(false);
    expect(isBridgeRequest("yt-clip")).toBe(false);
  });
});

describe("isBridgeResponse", () => {
  const track = { baseUrl: "https://www.youtube.com/api/timedtext?v=v", languageCode: "ja", kind: "asr", name: "日本語" };

  test("成功の応答", () => {
    expect(
      isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [track], potUrl: null, dubbed: false }),
    ).toBe(true);
  });

  test("失敗の応答は決まった理由だけ", () => {
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "no-player" })).toBe(true);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "ad-showing" })).toBe(true);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: false, reason: "other" })).toBe(false);
  });

  test("字幕の形が違う・dubbed が無い応答は偽 (ページの別のスクリプトが送ったものを使わない)", () => {
    expect(
      isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [{ ...track, kind: "x" }], potUrl: null, dubbed: false }),
    ).toBe(false);
    expect(isBridgeResponse({ type: BRIDGE_RESPONSE, id: "a", ok: true, tracks: [], potUrl: null })).toBe(false);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/caption-bridge-protocol.test.ts`
期待: FAIL (`Failed to resolve import "@/content/caption-bridge-protocol"`)

- [ ] **Step 3: 最小実装**

`src/content/caption-bridge-protocol.ts`:

```typescript
/**
 * 隔離された world (youtube.ts) と MAIN world (caption-bridge) の間で `window.postMessage` に載せる形 (ADR 0002)。
 *
 * **両方の world から import する。chrome API に触らないこと** (MAIN world には chrome.runtime が無い)。
 * `window.postMessage` はページの他のスクリプトからも届くので、受け手は必ず判定 (isBridge…) を通す
 */

export const BRIDGE_REQUEST = "yt-clip/captions-request" as const;
export const BRIDGE_RESPONSE = "yt-clip/captions-response" as const;
/** プレイヤーが字幕を取りに行くのを待つ上限。頼む側の待ちはこれより長くする */
export const POT_WAIT_MS = 5000;

export type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind: "asr" | "manual";
  /** 表示名 (「日本語 (自動生成)」など) */
  name: string;
};

export type BridgeParams = {
  videoId: string;
  /** 偽なら字幕の一覧と吹き替えの判定だけを返す (プレイヤーに字幕を取りに行かせない。保存から読めたとき) */
  wantPot: boolean;
};

export type BridgeRequest = BridgeParams & { type: typeof BRIDGE_REQUEST; id: string };

export type BridgeAnswer =
  | { ok: true; tracks: CaptionTrack[]; potUrl: string | null; dubbed: boolean }
  /**
   * no-player: プレイヤーがまだ無い。video-mismatch: プレイヤーの動画がまだ切り替わっていない (SPA 遷移の直後)。
   * ad-showing: 広告が流れている (広告の間はプレイヤーの動画も字幕も本編のものにならない)
   */
  | { ok: false; reason: "no-player" | "video-mismatch" | "ad-showing" };

export type BridgeResponse = BridgeAnswer & { type: typeof BRIDGE_RESPONSE; id: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    isRecord(value) &&
    value.type === BRIDGE_REQUEST &&
    typeof value.id === "string" &&
    typeof value.videoId === "string" &&
    typeof value.wantPot === "boolean"
  );
}

function isCaptionTrack(value: unknown): value is CaptionTrack {
  return (
    isRecord(value) &&
    typeof value.baseUrl === "string" &&
    typeof value.languageCode === "string" &&
    (value.kind === "asr" || value.kind === "manual") &&
    typeof value.name === "string"
  );
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value) || value.type !== BRIDGE_RESPONSE || typeof value.id !== "string") return false;
  if (value.ok === true) {
    return (
      Array.isArray(value.tracks) &&
      value.tracks.every(isCaptionTrack) &&
      (value.potUrl === null || typeof value.potUrl === "string") &&
      typeof value.dubbed === "boolean"
    );
  }
  return (
    value.ok === false &&
    (value.reason === "no-player" || value.reason === "video-mismatch" || value.reason === "ad-showing")
  );
}

/**
 * いま流れている音声トラックが YouTube の自動吹き替えか。
 *
 * プレイヤーの `getAudioTrack().id` は `251;<base64url>` の形で、後半を開くと `acont` と `dubbed-auto`
 * (オリジナルは `original`) が入っている (2026-10-26 に実機で確認)。音声トラックが 1 つの動画は後半が無い。
 * **読めなければ偽** (知らせるだけの機能なので、読めないときに止めない)
 */
export function isDubbedTrackId(id: string | undefined): boolean {
  const tags = id?.split(";")[1];
  if (tags === undefined || tags === "") return false;
  try {
    const base64 = tags.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return decoded.includes("acont") && decoded.includes("dubbed");
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/caption-bridge-protocol.test.ts && npm run typecheck`
期待: PASS (8 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/caption-bridge-protocol.ts tests/content/caption-bridge-protocol.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 字幕を頼むメッセージの形と、吹き替えの音声の判定を決める

公式字幕はプレイヤーの API を呼べる MAIN world でしか取れないので (ADR 0002)、隔離された world との間で
window.postMessage に載せる形を決める。ページの他のスクリプトからも届くので、受け手が形を確かめる判定も置く。
吹き替えが流れていたら知らせるため、音声トラックの id から自動吹き替えを見分ける。
EOF
```

---

### Task 4: MAIN world のブリッジと manifest

**Files:**
- Create: `src/content/caption-bridge.ts`
- Create: `src/content/caption-bridge-main.ts`
- Modify: `manifest.config.ts` (content_scripts の `src/content/youtube.ts` の項目の直前)
- Test: `tests/content/caption-bridge.test.ts`

**Interfaces:**
- Consumes: Task 3 の `BridgeParams` / `BridgeAnswer` / `BridgeResponse` / `CaptionTrack` / `BRIDGE_RESPONSE` / `isBridgeRequest` / `isDubbedTrackId` / `POT_WAIT_MS`
- Produces:
  - `type Player`、`type BridgeDeps = { player(): Player | null; observeTimedtext(onUrl: (url: string) => void): () => void; hideCaptions(): () => void; sleep(ms: number): Promise<void> }`
  - `function answer(params: BridgeParams, deps: BridgeDeps): Promise<BridgeAnswer>`
  - `function handleBridgeMessage(event: { source: unknown; data: unknown }, self: unknown, deps: BridgeDeps, reply: (response: BridgeResponse) => void): void` (頼みは 1 本ずつ順に答える)
  - `function installBridge(deps?: BridgeDeps): () => void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/caption-bridge.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { answer, handleBridgeMessage, type BridgeDeps, type Player } from "@/content/caption-bridge";
import { BRIDGE_REQUEST, BRIDGE_RESPONSE, type BridgeResponse } from "@/content/caption-bridge-protocol";

const POT_URL = "https://www.youtube.com/api/timedtext?v=vid&lang=ja&pot=P0T&c=WEB&fmt=json3";

type Call = [string, ...unknown[]];

/** プレイヤーの要素の代わり。setOption で字幕を選ぶと、プレイヤーが pot 付きで取りに行ったことにする */
function setup(options: {
  videoId?: string;
  tracks?: unknown[];
  ccTrack?: unknown;
  audioId?: string;
  fetchesOnSelect?: boolean;
  ad?: boolean;
  /** 真なら、字幕を選んだ時ではなく待ちの途中 (sleep) で pot の URL を届ける (待ちのループで await を挟ませる) */
  deliverInSleep?: boolean;
} = {}) {
  const calls: Call[] = [];
  let onUrl: ((url: string) => void) | null = null;
  let hidden = 0;
  const player = {
    classList: { contains: (name: string) => options.ad === true && name === "ad-showing" },
    getPlayerResponse: () => ({
      videoDetails: { videoId: options.videoId ?? "vid" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: options.tracks ?? [
            { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=ja&kind=asr", languageCode: "ja", kind: "asr", name: { simpleText: "日本語 (自動生成)" } },
          ],
        },
      },
    }),
    getOption: (module: string, option: string) => {
      calls.push(["getOption", module, option]);
      return options.ccTrack ?? {};
    },
    setOption: (module: string, option: string, value: unknown) => {
      calls.push(["setOption", module, option, value]);
      const selected = typeof value === "object" && value !== null && "languageCode" in value;
      if (selected && options.fetchesOnSelect !== false) onUrl?.(POT_URL);
    },
    loadModule: (module: string) => calls.push(["loadModule", module]),
    unloadModule: (module: string) => calls.push(["unloadModule", module]),
    getAudioTrack: () => ({ id: options.audioId ?? "251" }),
  } as unknown as Player;
  const deps: BridgeDeps = {
    player: () => player,
    observeTimedtext: (fn) => {
      onUrl = fn;
      return () => {
        onUrl = null;
      };
    },
    hideCaptions: () => {
      hidden += 1;
      return () => {
        hidden -= 1;
      };
    },
    sleep: async () => {
      await Promise.resolve();
      if (options.deliverInSleep === true) onUrl?.(POT_URL);
    },
  };
  return { calls, deps, hidden: () => hidden, observing: () => onUrl !== null };
}

describe("answer", () => {
  test("プレイヤーが無ければ no-player", async () => {
    const { deps } = setup();
    expect(await answer({ videoId: "vid", wantPot: true }, { ...deps, player: () => null })).toEqual({
      ok: false,
      reason: "no-player",
    });
  });

  test("広告が流れている間は ad-showing (字幕を取りに行かせない)", async () => {
    const { deps, calls } = setup({ ad: true });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({ ok: false, reason: "ad-showing" });
    expect(calls).toEqual([]);
  });

  test("プレイヤーの動画が頼まれた動画でなければ video-mismatch (SPA 遷移の直後)", async () => {
    const { deps } = setup({ videoId: "old" });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({ ok: false, reason: "video-mismatch" });
  });

  test("wantPot が偽なら一覧と吹き替えの判定だけ。プレイヤーに字幕を取りに行かせない", async () => {
    const { deps, calls } = setup();
    expect(await answer({ videoId: "vid", wantPot: false }, deps)).toEqual({
      ok: true,
      tracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=ja&kind=asr", languageCode: "ja", kind: "asr", name: "日本語 (自動生成)" },
      ],
      potUrl: null,
      dubbed: false,
    });
    expect(calls.filter(([name]) => name === "setOption")).toEqual([]);
  });

  test("字幕の無い動画は空の一覧で、取りに行かせない", async () => {
    const { deps, calls } = setup({ tracks: [] });
    expect(await answer({ videoId: "vid", wantPot: true }, deps)).toEqual({
      ok: true,
      tracks: [],
      potUrl: null,
      dubbed: false,
    });
    expect(calls).toEqual([]);
  });

  test("字幕がオフの人: 隠して取りに行かせ、pot 付きの URL を返し、オフに戻す", async () => {
    const { deps, calls, hidden, observing } = setup();
    const result = await answer({ videoId: "vid", wantPot: true }, deps);
    expect(result).toMatchObject({ ok: true, potUrl: POT_URL });
    expect(calls).toEqual([
      ["getOption", "captions", "track"],
      ["loadModule", "captions"],
      ["setOption", "captions", "track", {}],
      ["setOption", "captions", "track", { languageCode: "ja", kind: "asr" }],
      ["setOption", "captions", "track", {}],
      ["unloadModule", "captions"],
    ]);
    expect(hidden()).toBe(0);
    expect(observing()).toBe(false);
  });

  test("字幕がオンの人: 同じ字幕を選び直して取りに行かせ、オンのまま残す", async () => {
    const previous = { languageCode: "en", kind: "", displayName: "英語" };
    const { deps, calls } = setup({ ccTrack: previous });
    await answer({ videoId: "vid", wantPot: true }, deps);
    expect(calls).toEqual([
      ["getOption", "captions", "track"],
      ["loadModule", "captions"],
      ["setOption", "captions", "track", {}],
      ["setOption", "captions", "track", previous],
    ]);
  });

  test("上限まで待っても拾えなければ potUrl は null。表示と字幕は戻す", async () => {
    const { deps, calls, hidden } = setup({ fetchesOnSelect: false });
    const result = await answer({ videoId: "vid", wantPot: true }, deps);
    expect(result).toMatchObject({ ok: true, potUrl: null });
    expect(calls.slice(-2)).toEqual([
      ["setOption", "captions", "track", {}],
      ["unloadModule", "captions"],
    ]);
    expect(hidden()).toBe(0);
  });

  test("pot の無い timedtext の URL は拾わない", async () => {
    const { deps } = setup({ fetchesOnSelect: false });
    const noisy: BridgeDeps = {
      ...deps,
      observeTimedtext: (fn) => {
        fn("https://www.youtube.com/api/timedtext?v=vid&lang=ja");
        return () => undefined;
      },
    };
    expect(await answer({ videoId: "vid", wantPot: true }, noisy)).toMatchObject({ potUrl: null });
  });

  test("別の動画 (v=) の timedtext の URL は拾わない", async () => {
    const { deps } = setup({ fetchesOnSelect: false });
    const other: BridgeDeps = {
      ...deps,
      observeTimedtext: (fn) => {
        fn("https://www.youtube.com/api/timedtext?v=other&lang=ja&pot=P0T");
        return () => undefined;
      },
    };
    expect(await answer({ videoId: "vid", wantPot: true }, other)).toMatchObject({ potUrl: null });
  });

  test("吹き替えの音声が流れていれば dubbed", async () => {
    const { deps } = setup({ audioId: "251;ChQKBWFjb250EgtkdWJiZWQtYXV0bwoKCgRsYW5nEgJqYQ" });
    expect(await answer({ videoId: "vid", wantPot: false }, deps)).toMatchObject({ dubbed: true });
  });

  test("baseUrl か languageCode の無い字幕は一覧から落とす。手動は kind 'manual'", async () => {
    const { deps } = setup({
      tracks: [
        { languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=en", languageCode: "en", name: { runs: [{ text: "英語" }] } },
      ],
    });
    const result = await answer({ videoId: "vid", wantPot: false }, deps);
    expect(result).toMatchObject({
      tracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=vid&lang=en", languageCode: "en", kind: "manual", name: "英語" }],
    });
  });
});

describe("handleBridgeMessage", () => {
  test("同じ window からの形の合う頼みにだけ、id を付けて答える", async () => {
    const { deps } = setup();
    const self = {};
    const replies: BridgeResponse[] = [];
    const request = { type: BRIDGE_REQUEST, id: "r1", videoId: "vid", wantPot: false };
    handleBridgeMessage({ source: {}, data: request }, self, deps, (r) => replies.push(r));
    handleBridgeMessage({ source: self, data: { type: "other" } }, self, deps, (r) => replies.push(r));
    handleBridgeMessage({ source: self, data: request }, self, deps, (r) => replies.push(r));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: BRIDGE_RESPONSE, id: "r1", ok: true, potUrl: null });
  });

  test("pot の頼みが 2 本重なっても 1 本ずつ答える (後の頼みが、前の頼みで選んだ字幕を「元はオン」と読まない)", async () => {
    // pot は待ちの途中で届く。字幕を選んだ時に同期で届くと、1 本目が await を挟まずに終わり、順番を見張れない
    const { deps, calls } = setup({ fetchesOnSelect: false, deliverInSleep: true });
    const self = {};
    const replies: BridgeResponse[] = [];
    for (const id of ["p1", "p2"]) {
      handleBridgeMessage(
        { source: self, data: { type: BRIDGE_REQUEST, id, videoId: "vid", wantPot: true } },
        self,
        deps,
        (r) => replies.push(r),
      );
    }
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies.map((r) => r.id)).toEqual(["p1", "p2"]);
    // 2 本とも「字幕はオフだった」として扱い、最後にオフへ戻している
    expect(calls.filter(([name]) => name === "unloadModule")).toHaveLength(2);
    const getOptions = calls.map(([name], i) => (name === "getOption" ? i : -1)).filter((i) => i >= 0);
    const firstUnload = calls.findIndex(([name]) => name === "unloadModule");
    expect(getOptions[1]).toBeGreaterThan(firstUnload);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/caption-bridge.test.ts`
期待: FAIL (`Failed to resolve import "@/content/caption-bridge"`)

- [ ] **Step 3: 最小実装**

`src/content/caption-bridge.ts`:

```typescript
import {
  BRIDGE_RESPONSE,
  POT_WAIT_MS,
  isBridgeRequest,
  isDubbedTrackId,
  type BridgeAnswer,
  type BridgeParams,
  type BridgeResponse,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";
import { YT_SELECTORS } from "@/content/selectors";

/**
 * MAIN world で動く、公式字幕のブリッジ (ADR 0002)。
 *
 * **頼まれたときだけ動く。** オフの間も読み込まれて `message` の listener を 1 本置くが (MAIN world は chrome.storage を
 * 読めず、オン / オフを知らない)、頼むのは隔離された world のオンの間だけ。chrome API に触らないこと
 */

/** プレイヤーの要素が持つ API のうち使うもの。**公開 API ではない** (YouTube が変えたら壊れる。ADR 0002) */
export type Player = HTMLElement & {
  getPlayerResponse?(): PlayerResponse | undefined;
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
  unloadModule?(module: string): void;
  getAudioTrack?(): { id?: string } | undefined;
};

type RawTrack = {
  baseUrl?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  name?: { simpleText?: unknown; runs?: { text?: unknown }[] };
};

type PlayerResponse = {
  videoDetails?: { videoId?: unknown };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawTrack[] } };
};

export type BridgeDeps = {
  player(): Player | null;
  /** `/api/timedtext` へのリクエストの URL を知らせる。戻り値で見張りを外す */
  observeTimedtext(onUrl: (url: string) => void): () => void;
  /** 字幕の表示を隠す。戻り値で戻す */
  hideCaptions(): () => void;
  sleep(ms: number): Promise<void>;
};

const POLL_MS = 100;
const HIDE_STYLE_ID = "yt-clip-hide-captions";

function trackName(name: RawTrack["name"]): string {
  if (typeof name?.simpleText === "string") return name.simpleText;
  const first = name?.runs?.[0]?.text;
  return typeof first === "string" ? first : "";
}

function toTracks(response: PlayerResponse): CaptionTrack[] {
  const raw = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const tracks: CaptionTrack[] = [];
  for (const track of raw) {
    if (typeof track.baseUrl !== "string" || typeof track.languageCode !== "string") continue;
    tracks.push({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: track.kind === "asr" ? "asr" : "manual",
      name: trackName(track.name),
    });
  }
  return tracks;
}

function videoOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("v");
  } catch {
    return null;
  }
}

/** 字幕がオンか (getOption の track が言語を持つ) */
function isSelectedTrack(value: unknown): value is { languageCode: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { languageCode?: unknown }).languageCode === "string" &&
    (value as { languageCode: string }).languageCode !== ""
  );
}

/**
 * プレイヤーに字幕を取りに行かせ、その URL (pot 付き) を拾う。**字幕の状態は必ず戻す**:
 * オフだった人はオフに (モジュールも外す)、オンだった人は同じ字幕のまま
 */
async function capturePot(
  player: Player,
  first: CaptionTrack,
  videoId: string,
  deps: BridgeDeps,
): Promise<string | null> {
  let found: string | null = null;
  const stopObserving = deps.observeTimedtext((url) => {
    // 同じ時に別の動画 (広告など) の字幕を取りに行くことがある。その pot は効かないので、頼まれた動画のものだけ
    if (found === null && /[?&]pot=/.test(url) && videoOf(url) === videoId) found = url;
  });
  const showCaptions = deps.hideCaptions();
  const previous = player.getOption?.("captions", "track");
  const wasOn = isSelectedTrack(previous);
  try {
    player.loadModule?.("captions");
    // 一度外してから選ぶ。同じ字幕を選び直すだけでは、プレイヤーが取り直さない
    player.setOption?.("captions", "track", {});
    player.setOption?.(
      "captions",
      "track",
      wasOn ? previous : { languageCode: first.languageCode, kind: first.kind === "asr" ? "asr" : "" },
    );
    for (let waited = 0; found === null && waited < POT_WAIT_MS; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
    }
  } finally {
    stopObserving();
    if (!wasOn) {
      player.setOption?.("captions", "track", {});
      player.unloadModule?.("captions");
    }
    showCaptions();
  }
  return found;
}

export async function answer(params: BridgeParams, deps: BridgeDeps): Promise<BridgeAnswer> {
  const player = deps.player();
  const response = player?.getPlayerResponse?.();
  if (player === null || response === undefined) return { ok: false, reason: "no-player" };
  // 広告の間は本編の字幕を取りに行けない。頼む側が明けるまで待つ (caption-source の ask)
  if (player.classList?.contains("ad-showing") === true) return { ok: false, reason: "ad-showing" };
  if (response.videoDetails?.videoId !== params.videoId) return { ok: false, reason: "video-mismatch" };
  const tracks = toTracks(response);
  const dubbed = isDubbedTrackId(player.getAudioTrack?.()?.id);
  const first = tracks[0];
  if (!params.wantPot || first === undefined) return { ok: true, tracks, potUrl: null, dubbed };
  return { ok: true, tracks, potUrl: await capturePot(player, first, params.videoId, deps), dubbed };
}

/**
 * 答えている途中の頼み。**頼みは 1 本ずつ順に答える**: pot を取る間はプレイヤーの字幕を切り替えるので、2 本が重なると
 * 後の 1 本が前の 1 本の選んだ字幕を「元はオン」と読み、字幕をオフにしていた人の字幕がオンのまま残る
 */
let inFlight: Promise<unknown> = Promise.resolve();

/** `window` の message を 1 通受ける。同じ window からの、形の合う頼みにだけ答える */
export function handleBridgeMessage(
  event: { source: unknown; data: unknown },
  self: unknown,
  deps: BridgeDeps,
  reply: (response: BridgeResponse) => void,
): void {
  if (event.source !== self || !isBridgeRequest(event.data)) return;
  const { id, videoId, wantPot } = event.data;
  const run = inFlight.then(() => answer({ videoId, wantPot }, deps));
  inFlight = run.catch(() => undefined);
  void run.then((result) => reply({ ...result, type: BRIDGE_RESPONSE, id }));
}

function defaultDeps(): BridgeDeps {
  return {
    player: () => document.querySelector<Player>(YT_SELECTORS.player),
    observeTimedtext: (onUrl) => {
      // 既定のリソースの記録 (getEntriesByType) は 250 件で埋まり、YouTube ではすぐ拾えなくなる。observer は件数に縛られない
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name.includes("/api/timedtext")) onUrl(entry.name);
        }
      });
      observer.observe({ type: "resource", buffered: false });
      return () => observer.disconnect();
    },
    hideCaptions: () => {
      const style = document.createElement("style");
      style.id = HIDE_STYLE_ID;
      style.textContent = ".ytp-caption-window-container{display:none!important}";
      document.head.append(style);
      return () => style.remove();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** listener を 1 本置く。戻り値で外す (MAIN world の入口は外さない。テスト用) */
export function installBridge(deps: BridgeDeps = defaultDeps()): () => void {
  const onMessage = (event: MessageEvent): void => {
    handleBridgeMessage(event, window, deps, (response) => window.postMessage(response, location.origin));
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
```

`src/content/caption-bridge-main.ts`:

```typescript
import { installBridge } from "@/content/caption-bridge";

// MAIN world の入口 (manifest の world: "MAIN")。頼まれたときだけ字幕の一覧と取得用の URL を返す (ADR 0002)
installBridge();
```

`manifest.config.ts` の `content_scripts` の先頭 (`src/content/youtube.ts` の項目の前) に足す:

```typescript
    {
      // ページの文脈 (MAIN world) で動く。プレイヤーの API を呼んで、公式字幕の一覧と取得用の URL を返す (ADR 0002)。
      // 頼まれたときだけ動く (頼むのは youtube.ts のオンの間だけ)。**youtube.ts との実行の順は保証されない**
      // (crxjs のローダーはどちらも非同期の import)。listener が居ないうちの頼みは、頼む側の頼み直しで吸収する
      matches: ["https://www.youtube.com/*"],
      js: ["src/content/caption-bridge-main.ts"],
      run_at: "document_idle",
      world: "MAIN",
    },
```

- [ ] **Step 4: 実行して通過を確認**

あわせて、「pot の頼みが 2 本重なっても 1 本ずつ答える」が順番を見張れていることを一度確かめる: `handleBridgeMessage` の `const run = inFlight.then(() => answer({ videoId, wantPot }, deps));` を一時的に `const run = answer({ videoId, wantPot }, deps);` にして、そのテストが**落ちる**ことを見てから元に戻す。

実行: `npx vitest run tests/content/caption-bridge.test.ts && npm run typecheck && npm run build && python3 -I -c 'import json;m=json.load(open("dist/manifest.json"));print([c.get("world","ISOLATED") for c in m["content_scripts"]])'`
期待: PASS (14 tests)、型エラー無し、ビルド成功、最後の行が `['MAIN', 'ISOLATED', 'ISOLATED']`

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/caption-bridge.ts src/content/caption-bridge-main.ts manifest.config.ts tests/content/caption-bridge.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): MAIN world でプレイヤーに字幕を取らせ、pot 付きの URL を拾う

公式字幕の URL は pot が無いと空で返る。プレイヤーが字幕を取りに行くときの URL なら取れるので (ADR 0002)、
頼まれたときだけ字幕の表示を隠してプレイヤーに取りに行かせ、PerformanceObserver で URL を拾って返す。
字幕がオフの人はオフに、オンの人は同じ字幕のまま戻す。頼みが重なっても 1 本ずつ答える。広告の間は取りに行かず、
拾うのは頼まれた動画の URL だけ。
吹き替えの判定も同じ応答で返す。権限は増えない。
EOF
```

---

### Task 5: 隔離された world から字幕を取る

**Files:**
- Create: `src/content/caption-source.ts`
- Test: `tests/content/caption-source.test.ts`

**Interfaces:**
- Consumes: Task 2 の `parseJson3` / `Transcript`、Task 3 の `BRIDGE_REQUEST` / `POT_WAIT_MS` / `isBridgeResponse` / `BridgeAnswer` / `BridgeParams` / `BridgeRequest` / `CaptionTrack`
- Produces:
  - `class CaptionError extends Error`、`class BridgeTimeoutError extends CaptionError`
  - `type OfficialResult = { kind: "ready"; transcript: Transcript; dubbed: boolean } | { kind: "none"; dubbed: boolean }`
  - `type CaptionDeps = { request(params: BridgeParams): Promise<BridgeAnswer>; fetchText(url: string): Promise<string>; sleep(ms: number): Promise<void>; now(): number }`
  - `function isTimedtextUrl(url: string): boolean`
  - `function withPot(baseUrl: string, potUrl: string): string`
  - `function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null`
  - `function fetchOfficialTranscript(videoId: string, deps: CaptionDeps, signal?: AbortSignal): Promise<OfficialResult>` (中止されたら頼まず・取らずに、signal の理由で reject)
  - `function readDubbed(videoId: string, deps: CaptionDeps, signal?: AbortSignal): Promise<boolean>`
  - `type BridgeWindow`、`function requestViaWindow(win?: BridgeWindow, origin?: string): CaptionDeps["request"]`
  - `function defaultCaptionDeps(): CaptionDeps`
  - `const BRIDGE_RETRIES = 6`、`const BRIDGE_RETRY_MS = 500`、`const AD_WAIT_MS = 2000`、`const AD_MAX_WAIT_MS = 180_000`、`const FETCH_TIMEOUT_MS = 10_000`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/caption-source.test.ts`:

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AD_MAX_WAIT_MS,
  AD_WAIT_MS,
  BRIDGE_RETRIES,
  BridgeTimeoutError,
  CaptionError,
  fetchOfficialTranscript,
  isTimedtextUrl,
  pickTrack,
  readDubbed,
  requestViaWindow,
  withPot,
  type BridgeWindow,
  type CaptionDeps,
} from "@/content/caption-source";
import {
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  type BridgeAnswer,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";

afterEach(() => {
  vi.useRealTimers();
});

const track = (languageCode: string, kind: "asr" | "manual"): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=vid&lang=${languageCode}${kind === "asr" ? "&kind=asr" : ""}&exp=xpe`,
  languageCode,
  kind,
  name: languageCode,
});

const POT_URL =
  "https://www.youtube.com/api/timedtext?v=vid&lang=en&pot=P0T&potc=1&c=WEB&cver=2.2026&fmt=srv3&xorb=2&other=keep-out";

describe("pickTrack", () => {
  test("自動字幕と同じ言語の手動字幕があればそれ", () => {
    expect(pickTrack([track("en", "manual"), track("ja", "asr"), track("ja-JP", "manual")])).toEqual(
      track("ja-JP", "manual"),
    );
  });
  test("話している言語の手動字幕が無ければ自動字幕", () => {
    expect(pickTrack([track("en", "manual"), track("ja", "asr")])).toEqual(track("ja", "asr"));
  });
  test("自動字幕が無ければ最初の手動字幕。何も無ければ null", () => {
    expect(pickTrack([track("es", "manual"), track("en", "manual")])).toEqual(track("es", "manual"));
    expect(pickTrack([])).toBeNull();
  });
});

describe("withPot / isTimedtextUrl", () => {
  test("pot ほかの引数を写し、fmt を json3 にする。関係ない引数は写さない", () => {
    const url = new URL(withPot(track("ja", "asr").baseUrl, POT_URL));
    expect(url.searchParams.get("lang")).toBe("ja");
    expect(url.searchParams.get("pot")).toBe("P0T");
    expect(url.searchParams.get("potc")).toBe("1");
    expect(url.searchParams.get("c")).toBe("WEB");
    expect(url.searchParams.get("xorb")).toBe("2");
    expect(url.searchParams.get("fmt")).toBe("json3");
    expect(url.searchParams.get("other")).toBeNull();
  });
  test("YouTube の字幕の URL 以外は使わない (ページから届いた URL で別の所へ取りに行かない)", () => {
    expect(isTimedtextUrl("https://www.youtube.com/api/timedtext?v=1")).toBe(true);
    expect(isTimedtextUrl("https://evil.example/api/timedtext?v=1")).toBe(false);
    expect(isTimedtextUrl("http://www.youtube.com/api/timedtext?v=1")).toBe(false);
    expect(isTimedtextUrl("not a url")).toBe(false);
    expect(() => withPot("https://evil.example/api/timedtext", POT_URL)).toThrow(CaptionError);
  });
});

function deps(overrides: Partial<CaptionDeps> & { answers?: (BridgeAnswer | Error)[] } = {}) {
  const answers = overrides.answers ?? [];
  const requested: unknown[] = [];
  const fetched: string[] = [];
  const result: CaptionDeps = {
    request: async (params) => {
      requested.push(params);
      const next = answers.shift();
      if (next === undefined) throw new Error("頼みが多すぎます");
      if (next instanceof Error) throw next;
      return next;
    },
    fetchText: async (url) => {
      fetched.push(url);
      return JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "こんにちは" }] }] });
    },
    sleep: async () => undefined,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps: result, requested, fetched };
}

describe("fetchOfficialTranscript", () => {
  test("選んだ字幕を pot 付きで取り、行にする", async () => {
    const { deps: d, requested, fetched } = deps({
      answers: [{ ok: true, tracks: [track("ja", "manual"), track("ja", "asr")], potUrl: POT_URL, dubbed: true }],
    });
    const result = await fetchOfficialTranscript("vid", d);
    expect(requested).toEqual([{ videoId: "vid", wantPot: true }]);
    expect(new URL(fetched[0] ?? "").searchParams.get("pot")).toBe("P0T");
    expect(result).toEqual({
      kind: "ready",
      dubbed: true,
      transcript: {
        videoId: "vid",
        source: "youtube-manual",
        language: "ja",
        savedAt: 1_700_000_000_000,
        lines: [{ id: "youtube-manual:1.00", startSec: 1, endSec: 3, text: "こんにちは" }],
      },
    });
  });

  test("字幕が無ければ none", async () => {
    const { deps: d, fetched } = deps({ answers: [{ ok: true, tracks: [], potUrl: null, dubbed: false }] });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(fetched).toEqual([]);
  });

  test("プレイヤーの動画がまだ切り替わっていなければ待って頼み直す", async () => {
    const { deps: d, requested } = deps({
      answers: [
        { ok: false, reason: "video-mismatch" },
        new BridgeTimeoutError(),
        { ok: true, tracks: [], potUrl: null, dubbed: false },
      ],
    });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(requested).toHaveLength(3);
  });

  test("頼み直しても駄目なら理由を付けて throw する", async () => {
    const answers = Array.from({ length: BRIDGE_RETRIES }, (): BridgeAnswer => ({ ok: false, reason: "no-player" }));
    const { deps: d } = deps({ answers });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("プレイヤーが見つかりません");
  });

  test("広告の間は回数に数えずに待ち、明けたら取る", async () => {
    const ad: BridgeAnswer = { ok: false, reason: "ad-showing" };
    const answers: BridgeAnswer[] = [
      ...Array.from({ length: BRIDGE_RETRIES + 2 }, () => ad),
      { ok: true, tracks: [], potUrl: null, dubbed: false },
    ];
    const { deps: d, requested } = deps({ answers });
    expect(await fetchOfficialTranscript("vid", d)).toEqual({ kind: "none", dubbed: false });
    expect(requested).toHaveLength(BRIDGE_RETRIES + 3);
  });

  test("広告が上限まで明けなければ throw する", async () => {
    const answers = Array.from({ length: AD_MAX_WAIT_MS / AD_WAIT_MS + 1 }, (): BridgeAnswer => ({ ok: false, reason: "ad-showing" }));
    const { deps: d } = deps({ answers });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("広告が終わらないため字幕を取れませんでした");
  });

  test("pot を拾えなければ throw する", async () => {
    const { deps: d } = deps({ answers: [{ ok: true, tracks: [track("ja", "asr")], potUrl: null, dubbed: false }] });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("字幕の取得に要る情報を拾えませんでした");
  });

  test("空で返れば throw する (pot が効かなかった。字幕が無いのと見分ける)", async () => {
    const { deps: d } = deps({
      answers: [{ ok: true, tracks: [track("ja", "asr")], potUrl: POT_URL, dubbed: false }],
      fetchText: async () => "",
    });
    await expect(fetchOfficialTranscript("vid", d)).rejects.toThrow("字幕が空で返りました");
  });
});

test("中止されたら、それ以降は頼まず取りに行かない (オフにした後に字幕を取りに行かない)", async () => {
  const controller = new AbortController();
  const ad: BridgeAnswer = { ok: false, reason: "ad-showing" };
  const { deps: d, requested, fetched } = deps({
    answers: [ad, ad, ad],
    sleep: async () => {
      controller.abort(new Error("止めました"));
    },
  });
  await expect(fetchOfficialTranscript("vid", d, controller.signal)).rejects.toThrow("止めました");
  expect(requested).toHaveLength(1);
  expect(fetched).toEqual([]);
});

test("readDubbed は字幕を取りに行かせずに判定だけ読む", async () => {
  const { deps: d, requested } = deps({ answers: [{ ok: true, tracks: [], potUrl: null, dubbed: true }] });
  expect(await readDubbed("vid", d)).toBe(true);
  expect(requested).toEqual([{ videoId: "vid", wantPot: false }]);
});

describe("requestViaWindow", () => {
  /** window の代わり。postMessage で受けた頼みを respond に渡し、返した値を同じ window からの message として届ける */
  function fakeWindow(respond: (request: Record<string, unknown>) => unknown) {
    const listeners = new Set<(event: MessageEvent) => void>();
    const posted: unknown[] = [];
    const win: BridgeWindow = {
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      postMessage: (message) => {
        posted.push(message);
        const reply = respond(message as Record<string, unknown>);
        if (reply === undefined) return;
        for (const fn of [...listeners]) fn({ source: win, data: reply } as unknown as MessageEvent);
      },
    };
    return { win, posted, listeners };
  }

  test("id の合う応答を答えにする。listener は外す", async () => {
    const { win, posted, listeners } = fakeWindow((request) => ({
      type: BRIDGE_RESPONSE,
      id: request.id,
      ok: true,
      tracks: [],
      potUrl: null,
      dubbed: false,
    }));
    const answer = await requestViaWindow(win, "https://www.youtube.com")({ videoId: "vid", wantPot: false });
    expect(answer).toEqual({ ok: true, tracks: [], potUrl: null, dubbed: false });
    expect(posted[0]).toMatchObject({ type: BRIDGE_REQUEST, videoId: "vid", wantPot: false });
    expect(listeners.size).toBe(0);
  });

  test("id の違う応答・形の違う応答は無視し、上限で BridgeTimeoutError", async () => {
    vi.useFakeTimers();
    const { win, listeners } = fakeWindow(() => ({ type: BRIDGE_RESPONSE, id: "someone-else", ok: false, reason: "no-player" }));
    const pending = requestViaWindow(win, "https://www.youtube.com")({ videoId: "vid", wantPot: false });
    const settled = expect(pending).rejects.toBeInstanceOf(BridgeTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await settled;
    expect(listeners.size).toBe(0);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/caption-source.test.ts`
期待: FAIL (`Failed to resolve import "@/content/caption-source"`)

- [ ] **Step 3: 最小実装**

`src/content/caption-source.ts`:

```typescript
import {
  BRIDGE_REQUEST,
  POT_WAIT_MS,
  isBridgeResponse,
  type BridgeAnswer,
  type BridgeParams,
  type BridgeRequest,
  type CaptionTrack,
} from "@/content/caption-bridge-protocol";
import { parseJson3, type Transcript, type TranscriptSource } from "@/shared/transcript";

/**
 * 隔離された world から公式字幕を取る (ADR 0002)。MAIN world のブリッジに一覧と pot 付きの URL を頼み、
 * 選んだ字幕の URL に pot を写して json3 を取り、行にする
 */

/** ブリッジに頼み直す回数。SPA 遷移の直後はプレイヤーの動画がまだ前の動画のことがある */
export const BRIDGE_RETRIES = 6;
export const BRIDGE_RETRY_MS = 500;
/** 広告が流れている間、頼み直すまでの間隔と、待つ上限。広告の間は回数 (BRIDGE_RETRIES) に数えない */
export const AD_WAIT_MS = 2000;
export const AD_MAX_WAIT_MS = 180_000;
/** 字幕の取得の上限 */
export const FETCH_TIMEOUT_MS = 10_000;
/** 一覧だけを頼むときの応答の上限。pot を頼むときはプレイヤーを待つ分 (POT_WAIT_MS) を足す */
const LIST_TIMEOUT_MS = 2000;
const POT_TIMEOUT_MS = POT_WAIT_MS + 3000;

/** pot を使い回すときに写す引数。検証 V1 で、これを写せば同じ動画の別の字幕も取れた */
const POT_PARAMS = [
  "pot",
  "potc",
  "c",
  "cver",
  "cplayer",
  "cos",
  "cosver",
  "cplatform",
  "cbr",
  "cbrver",
  "cbrand",
  "xorb",
  "xobt",
  "xovt",
] as const;

export class CaptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionError";
  }
}

export class BridgeTimeoutError extends CaptionError {
  constructor() {
    super("ページからの応答がありません");
    this.name = "BridgeTimeoutError";
  }
}

export type OfficialResult =
  | { kind: "ready"; transcript: Transcript; dubbed: boolean }
  | { kind: "none"; dubbed: boolean };

export type CaptionDeps = {
  request(params: BridgeParams): Promise<BridgeAnswer>;
  fetchText(url: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** UTC epoch ミリ秒 */
  now(): number;
};

const REASON_TEXT: Record<string, string> = {
  "no-player": "プレイヤーが見つかりません",
  "video-mismatch": "プレイヤーの動画が切り替わりませんでした",
  timeout: "ページからの応答がありません",
};

/** YouTube の字幕の URL か。**ページから届いた URL で、別の所へ取りに行かない** */
export function isTimedtextUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "www.youtube.com" && parsed.pathname === "/api/timedtext";
  } catch {
    return false;
  }
}

/** 字幕の URL に、プレイヤーが取りに行った URL の pot ほかの引数を写す */
export function withPot(baseUrl: string, potUrl: string): string {
  if (!isTimedtextUrl(baseUrl) || !isTimedtextUrl(potUrl)) {
    throw new CaptionError(`字幕の URL ではありません: ${baseUrl}`);
  }
  const target = new URL(baseUrl);
  const source = new URL(potUrl);
  for (const key of POT_PARAMS) {
    const value = source.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  target.searchParams.set("fmt", "json3");
  return target.toString();
}

const baseLanguage = (code: string): string => code.split("-")[0] ?? code;

/**
 * 使う字幕を選ぶ。**手動の字幕 → 自動字幕の順** (第 2 版のモックの設定)。話している言語は自動字幕の言語で見る
 * (手動字幕は翻訳のことがある)。自動字幕が無ければ最初の手動字幕
 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const asr = tracks.find((track) => track.kind === "asr");
  const manual = tracks.filter((track) => track.kind === "manual");
  if (asr === undefined) return manual[0] ?? null;
  return manual.find((track) => baseLanguage(track.languageCode) === baseLanguage(asr.languageCode)) ?? asr;
}

async function ask(
  params: BridgeParams,
  deps: CaptionDeps,
  signal: AbortSignal | undefined,
): Promise<Extract<BridgeAnswer, { ok: true }>> {
  let lastReason = "";
  let attempt = 0;
  let adWaited = 0;
  while (attempt < BRIDGE_RETRIES) {
    // オフにされたら、それ以上は頼まない (広告を待っている間も)。頼むのはオンの間だけ (ADR 0002)
    signal?.throwIfAborted();
    try {
      const answer = await deps.request(params);
      if (answer.ok) return answer;
      if (answer.reason === "ad-showing") {
        // 広告は数十秒〜数分続く。回数に数えずに明けるまで待つ (上限あり)
        if (adWaited >= AD_MAX_WAIT_MS) throw new CaptionError("広告が終わらないため字幕を取れませんでした");
        adWaited += AD_WAIT_MS;
        await deps.sleep(AD_WAIT_MS);
        signal?.throwIfAborted();
        continue;
      }
      lastReason = answer.reason;
    } catch (error) {
      // 上限まで応答が無い = ブリッジがまだ居ない (読み込みの順は保証されない) かもしれない。それ以外の失敗は頼み直さない
      if (!(error instanceof BridgeTimeoutError)) throw error;
      lastReason = "timeout";
    }
    signal?.throwIfAborted();
    attempt += 1;
    if (attempt < BRIDGE_RETRIES) await deps.sleep(BRIDGE_RETRY_MS);
  }
  throw new CaptionError(REASON_TEXT[lastReason] ?? lastReason);
}

export async function fetchOfficialTranscript(
  videoId: string,
  deps: CaptionDeps,
  signal?: AbortSignal,
): Promise<OfficialResult> {
  const answer = await ask({ videoId, wantPot: true }, deps, signal);
  const track = pickTrack(answer.tracks);
  if (track === null) return { kind: "none", dubbed: answer.dubbed };
  if (answer.potUrl === null) throw new CaptionError("字幕の取得に要る情報を拾えませんでした");
  signal?.throwIfAborted();
  const body = await deps.fetchText(withPot(track.baseUrl, answer.potUrl));
  // pot が効かないと 200 で空が返る (検証 V1)。字幕が無いのと見分けるため throw する
  if (body.trim() === "") throw new CaptionError("字幕が空で返りました");
  const source: TranscriptSource = track.kind === "asr" ? "youtube-asr" : "youtube-manual";
  return {
    kind: "ready",
    dubbed: answer.dubbed,
    transcript: {
      videoId,
      source,
      language: track.languageCode,
      lines: parseJson3(JSON.parse(body) as unknown, source),
      savedAt: deps.now(),
    },
  };
}

/** 吹き替えの判定だけを読む (保存から読めたとき。プレイヤーに字幕を取りに行かせない) */
export async function readDubbed(videoId: string, deps: CaptionDeps, signal?: AbortSignal): Promise<boolean> {
  return (await ask({ videoId, wantPot: false }, deps, signal)).dubbed;
}

export type BridgeWindow = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

/** `window.postMessage` で MAIN world のブリッジに頼む。id の合う応答だけを受ける。上限で BridgeTimeoutError */
export function requestViaWindow(
  win: BridgeWindow = window,
  origin: string = location.origin,
): CaptionDeps["request"] {
  return (params) =>
    new Promise<BridgeAnswer>((resolve, reject) => {
      const id = crypto.randomUUID();
      const onMessage = (event: MessageEvent): void => {
        if (event.source !== win || !isBridgeResponse(event.data) || event.data.id !== id) return;
        clearTimeout(timer);
        win.removeEventListener("message", onMessage);
        const data = event.data;
        resolve(
          data.ok
            ? { ok: true, tracks: data.tracks, potUrl: data.potUrl, dubbed: data.dubbed }
            : { ok: false, reason: data.reason },
        );
      };
      const timer = setTimeout(
        () => {
          win.removeEventListener("message", onMessage);
          reject(new BridgeTimeoutError());
        },
        params.wantPot ? POT_TIMEOUT_MS : LIST_TIMEOUT_MS,
      );
      win.addEventListener("message", onMessage);
      win.postMessage({ type: BRIDGE_REQUEST, id, ...params } satisfies BridgeRequest, origin);
    });
}

export function defaultCaptionDeps(): CaptionDeps {
  return {
    request: requestViaWindow(),
    fetchText: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new CaptionError(`字幕を取れませんでした: HTTP ${response.status}`);
      return response.text();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/caption-source.test.ts && npm run typecheck`
期待: PASS (17 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/caption-source.ts tests/content/caption-source.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 隔離された world からブリッジに頼んで公式字幕を行にする

MAIN world のブリッジから字幕の一覧と pot 付きの URL を受け、手動 → 自動の順で字幕を選び、pot を写した URL で
json3 を取って行にする (ADR 0002)。SPA 遷移の直後はプレイヤーの動画がまだ前の動画のことがあるので頼み直し、
広告の間は明けるまで待つ。オフにされたら、それ以上は頼まない。
pot が効かずに空で返ったときは、字幕が無いのと見分けて理由を付けて失敗にする。ページから届いた URL は
YouTube の字幕の URL のときだけ使う。
EOF
```

---

### Task 6: 文字起こしの保存

**Files:**
- Create: `src/content/transcript-cache.ts`
- Test: `tests/content/transcript-cache.test.ts`

**Interfaces:**
- Consumes: Task 2 の `Transcript` / `TranscriptLine`
- Produces:
  - `const TRANSCRIPT_KEY_PREFIX = "transcript:"`、`const TRANSCRIPT_INDEX_KEY = "transcriptIndex"`、`const MAX_CACHED_TRANSCRIPTS = 30`、`const MAX_TRANSCRIPT_BYTES = 300_000`
  - `type TranscriptStorage = { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> }`
  - `const chromeLocalStorage: TranscriptStorage`
  - `function isTranscript(value: unknown): value is Transcript`
  - `function fitToBudget(transcript: Transcript, maxBytes: number): Transcript`
  - `function loadTranscript(videoId: string, storage?: TranscriptStorage): Promise<Transcript | null>`
  - `function saveTranscript(transcript: Transcript, storage?: TranscriptStorage): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/transcript-cache.test.ts`:

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_CACHED_TRANSCRIPTS,
  TRANSCRIPT_INDEX_KEY,
  fitToBudget,
  isTranscript,
  loadTranscript,
  saveTranscript,
  type TranscriptStorage,
} from "@/content/transcript-cache";
import type { Transcript } from "@/shared/transcript";

afterEach(() => {
  vi.restoreAllMocks();
});

function memoryStorage(initial: Record<string, unknown> = {}, quota = Infinity) {
  const data: Record<string, unknown> = { ...initial };
  const storage: TranscriptStorage = {
    get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (items) => {
      const next = { ...data, ...items };
      const transcripts = Object.keys(next).filter((key) => key.startsWith("transcript:")).length;
      if (transcripts > quota) throw new Error("QUOTA_BYTES quota exceeded");
      Object.assign(data, items);
    },
    remove: async (keys) => {
      for (const key of keys) delete data[key];
    },
  };
  return { data, storage };
}

function transcript(videoId: string, savedAt: number, lines = 1): Transcript {
  return {
    videoId,
    source: "youtube-asr",
    language: "ja",
    savedAt,
    lines: Array.from({ length: lines }, (_, i) => ({
      id: `youtube-asr:${i}.00`,
      startSec: i,
      endSec: i + 1,
      text: `行 ${i}`,
      words: [{ startSec: i, endSec: i + 1, text: `行 ${i}` }],
    })),
  };
}

describe("saveTranscript / loadTranscript", () => {
  test("保存したものを読める。索引は新しい順", async () => {
    const { storage, data } = memoryStorage();
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    expect(await loadTranscript("a", storage)).toEqual(transcript("a", 1));
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "b", savedAt: 2 },
      { videoId: "a", savedAt: 1 },
    ]);
  });

  test("同じ動画を保存し直すと索引の先頭へ移り、重ならない", async () => {
    const { storage, data } = memoryStorage();
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    await saveTranscript(transcript("a", 3), storage);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "a", savedAt: 3 },
      { videoId: "b", savedAt: 2 },
    ]);
  });

  test(`${MAX_CACHED_TRANSCRIPTS + 1} 本目で最も古いものを消す`, async () => {
    const { storage, data } = memoryStorage();
    for (let i = 0; i <= MAX_CACHED_TRANSCRIPTS; i += 1) await saveTranscript(transcript(`v${i}`, i), storage);
    expect(data["transcript:v0"]).toBeUndefined();
    expect(data["transcript:v1"]).toBeDefined();
    expect(data[TRANSCRIPT_INDEX_KEY]).toHaveLength(MAX_CACHED_TRANSCRIPTS);
  });

  test("容量が足りなければ古いものから消して入れ直す", async () => {
    const { storage, data } = memoryStorage({}, 2);
    await saveTranscript(transcript("a", 1), storage);
    await saveTranscript(transcript("b", 2), storage);
    await saveTranscript(transcript("c", 3), storage);
    expect(Object.keys(data).filter((key) => key.startsWith("transcript:")).sort()).toEqual([
      "transcript:b",
      "transcript:c",
    ]);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([
      { videoId: "c", savedAt: 3 },
      { videoId: "b", savedAt: 2 },
    ]);
  });

  test("消せるものが無くても入らなければ throw する", async () => {
    const { storage } = memoryStorage({}, 0);
    await expect(saveTranscript(transcript("a", 1), storage)).rejects.toThrow("QUOTA");
  });

  test("無いものは null", async () => {
    const { storage } = memoryStorage();
    expect(await loadTranscript("nothing", storage)).toBeNull();
  });

  test("壊れた保存値は warn を残して null (取り直す)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage } = memoryStorage({ "transcript:a": { videoId: "a", lines: "broken" } });
    expect(await loadTranscript("a", storage)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("保存された文字起こしが読めない"));
  });

  test("索引が壊れていても保存できる (索引を作り直す)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { storage, data } = memoryStorage({ [TRANSCRIPT_INDEX_KEY]: "broken" });
    await saveTranscript(transcript("a", 1), storage);
    expect(data[TRANSCRIPT_INDEX_KEY]).toEqual([{ videoId: "a", savedAt: 1 }]);
  });
});

describe("fitToBudget", () => {
  test("収まるならそのまま", () => {
    const value = transcript("a", 1, 3);
    expect(fitToBudget(value, 1_000_000)).toBe(value);
  });

  test("収まらなければ単語の時刻を落とす", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = transcript("a", 1, 3);
    const withoutWordsSize = new TextEncoder().encode(
      JSON.stringify({ ...value, lines: value.lines.map(({ id, startSec, endSec, text }) => ({ id, startSec, endSec, text })) }),
    ).length;
    const fitted = fitToBudget(value, withoutWordsSize);
    expect(fitted.lines).toHaveLength(3);
    expect(fitted.lines.every((line) => line.words === undefined)).toBe(true);
  });

  test("それでも収まらなければ後ろの行を落とす", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fitted = fitToBudget(transcript("a", 1, 100), 2000);
    expect(fitted.lines.length).toBeGreaterThan(0);
    expect(fitted.lines.length).toBeLessThan(100);
    expect(fitted.lines[0]?.id).toBe("youtube-asr:0.00");
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(2000);
  });
});

test("isTranscript", () => {
  expect(isTranscript(transcript("a", 1))).toBe(true);
  expect(isTranscript({ ...transcript("a", 1), source: "other" })).toBe(false);
  expect(isTranscript({ ...transcript("a", 1), lines: [{ id: "x", startSec: "0", endSec: 1, text: "" }] })).toBe(false);
  expect(isTranscript(null)).toBe(false);
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-cache.test.ts`
期待: FAIL (`Failed to resolve import "@/content/transcript-cache"`)

- [ ] **Step 3: 最小実装**

`src/content/transcript-cache.ts`:

```typescript
import type { Transcript, TranscriptLine } from "@/shared/transcript";

/**
 * 文字起こしの保存 (`chrome.storage.local`。同期しない)。同じ動画を開き直したときに取り直さずに済ませる。
 * 段階 4・5 の取り方は再生した所しか取れないので、そちらでは特に要る (ADR 0001)。
 *
 * **新しい順に 30 本まで** (回答 2026-10-26「一旦それで」)。1 本は 300KB まで: local の既定の容量 (10MB) に
 * 30 本が収まるように。動画ごとに `transcript:<videoId>` に置き、新しい順の索引を `transcriptIndex` に置く
 */

export const TRANSCRIPT_KEY_PREFIX = "transcript:";
export const TRANSCRIPT_INDEX_KEY = "transcriptIndex";
export const MAX_CACHED_TRANSCRIPTS = 30;
export const MAX_TRANSCRIPT_BYTES = 300_000;

type IndexEntry = { videoId: string; savedAt: number };

export type TranscriptStorage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

/** 本物。chrome を呼ぶのは使うときだけ (import しただけで chrome を触らない) */
export const chromeLocalStorage: TranscriptStorage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const keyOf = (videoId: string): string => `${TRANSCRIPT_KEY_PREFIX}${videoId}`;
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isWord(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.startSec) && isFiniteNumber(value.endSec) && typeof value.text === "string";
}

function isLine(value: unknown): value is TranscriptLine {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.startSec) &&
    isFiniteNumber(value.endSec) &&
    typeof value.text === "string" &&
    (value.words === undefined || (Array.isArray(value.words) && value.words.every(isWord)))
  );
}

export function isTranscript(value: unknown): value is Transcript {
  return (
    isRecord(value) &&
    typeof value.videoId === "string" &&
    (value.source === "youtube-manual" || value.source === "youtube-asr") &&
    typeof value.language === "string" &&
    isFiniteNumber(value.savedAt) &&
    Array.isArray(value.lines) &&
    value.lines.every(isLine)
  );
}

/** 収まらなければ単語の時刻を落とし、それでも収まらなければ後ろの行を落とす。落としたら warn を残す */
export function fitToBudget(transcript: Transcript, maxBytes: number): Transcript {
  if (byteLength(transcript) <= maxBytes) return transcript;
  const withoutWords: Transcript = {
    ...transcript,
    lines: transcript.lines.map((line) => ({ id: line.id, startSec: line.startSec, endSec: line.endSec, text: line.text })),
  };
  console.warn(`[yt-clip] 文字起こしが大きいため、単語の時刻を落として保存します: ${transcript.videoId}`);
  if (byteLength(withoutWords) <= maxBytes) return withoutWords;

  let used = byteLength({ ...withoutWords, lines: [] });
  const kept: TranscriptLine[] = [];
  for (const line of withoutWords.lines) {
    // +1 は配列の区切りの `,`
    const size = byteLength(line) + 1;
    if (used + size > maxBytes) break;
    used += size;
    kept.push(line);
  }
  console.warn(
    `[yt-clip] 文字起こしが大きいため、後ろの ${withoutWords.lines.length - kept.length} 行を落として保存します: ${transcript.videoId}`,
  );
  return { ...withoutWords, lines: kept };
}

function readIndex(value: unknown): IndexEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.warn(`[yt-clip] 文字起こしの索引が読めないため作り直します: ${String(value)}`);
    return [];
  }
  return value.filter(
    (entry): entry is IndexEntry =>
      isRecord(entry) && typeof entry.videoId === "string" && isFiniteNumber(entry.savedAt),
  );
}

/**
 * 読む。**※ 局所例外 (Fail Fast): 壊れた保存値は throw せず、warn を残して null** (取り直せば済む。読めない保存値で
 * 文字起こしごと止めない。loadWindowLayout と同じ判断)
 */
export async function loadTranscript(
  videoId: string,
  storage: TranscriptStorage = chromeLocalStorage,
): Promise<Transcript | null> {
  const key = keyOf(videoId);
  const stored = (await storage.get([key]))[key];
  if (stored === undefined) return null;
  if (!isTranscript(stored) || stored.videoId !== videoId) {
    console.warn(`[yt-clip] 保存された文字起こしが読めないため取り直します: ${videoId}`);
    return null;
  }
  return stored;
}

/**
 * 保存する。索引の先頭に入れ、30 本を超えた分を消す。容量が足りなければ古いものから 1 本ずつ消して入れ直す。
 * 消せるものが無くなっても入らなければ throw する
 */
export async function saveTranscript(
  transcript: Transcript,
  storage: TranscriptStorage = chromeLocalStorage,
): Promise<void> {
  const fitted = fitToBudget(transcript, MAX_TRANSCRIPT_BYTES);
  const index = readIndex((await storage.get([TRANSCRIPT_INDEX_KEY]))[TRANSCRIPT_INDEX_KEY]);
  const next: IndexEntry[] = [
    { videoId: transcript.videoId, savedAt: transcript.savedAt },
    ...index.filter((entry) => entry.videoId !== transcript.videoId),
  ];
  const evicted = next.slice(MAX_CACHED_TRANSCRIPTS).map((entry) => keyOf(entry.videoId));
  if (evicted.length > 0) await storage.remove(evicted);

  let kept = next.slice(0, MAX_CACHED_TRANSCRIPTS);
  for (;;) {
    try {
      await storage.set({ [keyOf(transcript.videoId)]: fitted, [TRANSCRIPT_INDEX_KEY]: kept });
      return;
    } catch (error) {
      const oldest = kept[kept.length - 1];
      if (kept.length <= 1 || oldest === undefined) throw error;
      kept = kept.slice(0, -1);
      await storage.remove([keyOf(oldest.videoId)]);
    }
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-cache.test.ts && npm run typecheck`
期待: PASS (12 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-cache.ts tests/content/transcript-cache.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 文字起こしを端末に新しい順で 30 本まで保存する

同じ動画を開き直したときに取り直さずに済ませるため (回答 2026-10-26「一旦それで」)。local の既定の容量に
30 本が収まるよう 1 本は 300KB までにし、超える分は単語の時刻、次に後ろの行を落とす。容量が足りなければ
古いものから消して入れ直す。壊れた保存値は止めずに取り直す。
EOF
```

---

### Task 7: 動画ごとに 1 回取る loader

**Files:**
- Create: `src/content/transcript-loader.ts`
- Test: `tests/content/transcript-loader.test.ts`

**Interfaces:**
- Consumes: Task 5 の `fetchOfficialTranscript` / `readDubbed` / `defaultCaptionDeps` / `OfficialResult`、Task 6 の `loadTranscript` / `saveTranscript`、Task 2 の `Transcript`
- Produces:
  - `type TranscriptStatus = { kind: "idle" } | { kind: "loading"; videoId: string } | { kind: "ready"; videoId: string; transcript: Transcript; dubbed: boolean } | { kind: "none"; videoId: string; dubbed: boolean } | { kind: "failed"; videoId: string; reason: string }`
  - `type TranscriptLoader = { load(videoId: string): void; retry(): void; reset(): void; status(): TranscriptStatus }`
  - `type LoaderDeps = { loadCached(videoId: string): Promise<Transcript | null>; save(transcript: Transcript): Promise<void>; fetchOfficial(videoId: string, signal: AbortSignal): Promise<OfficialResult>; readDubbed(videoId: string, signal: AbortSignal): Promise<boolean>; onChange(status: TranscriptStatus): void }`
  - `function createTranscriptLoader(deps: LoaderDeps): TranscriptLoader`
  - `function createDefaultTranscriptLoader(onChange: (status: TranscriptStatus) => void): TranscriptLoader`
  - `function transcriptLogLine(status: TranscriptStatus): string | null`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/transcript-loader.test.ts`:

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createTranscriptLoader,
  transcriptLogLine,
  type LoaderDeps,
  type TranscriptStatus,
} from "@/content/transcript-loader";
import type { OfficialResult } from "@/content/caption-source";
import type { Transcript } from "@/shared/transcript";

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const transcript = (videoId: string): Transcript => ({
  videoId,
  source: "youtube-asr",
  language: "ja",
  savedAt: 1,
  lines: [{ id: "youtube-asr:1.00", startSec: 1, endSec: 2, text: "こんにちは" }],
});

/** 手で解決できる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<LoaderDeps> = {}) {
  const statuses: TranscriptStatus[] = [];
  const saved: Transcript[] = [];
  const fetchOfficial = vi.fn(
    async (videoId: string): Promise<OfficialResult> => ({ kind: "ready", transcript: transcript(videoId), dubbed: false }),
  );
  const deps: LoaderDeps = {
    loadCached: async () => null,
    save: async (value) => {
      saved.push(value);
    },
    fetchOfficial,
    readDubbed: async () => true,
    onChange: (status) => statuses.push(status),
    ...overrides,
  };
  return { loader: createTranscriptLoader(deps), statuses, saved, fetchOfficial };
}

describe("createTranscriptLoader", () => {
  test("保存に無ければ取りに行き、ready にして保存する", async () => {
    const { loader, statuses, saved } = setup();
    loader.load("a");
    await flush();
    expect(statuses).toEqual([
      { kind: "loading", videoId: "a" },
      { kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false },
    ]);
    expect(saved).toEqual([transcript("a")]);
  });

  test("保存にあればそれを使い、吹き替えの判定だけ読む", async () => {
    const { loader, statuses, fetchOfficial } = setup({ loadCached: async (id) => transcript(id) });
    loader.load("a");
    await flush();
    expect(fetchOfficial).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: true });
  });

  test("保存から読んだとき、吹き替えの判定が読めなければ偽にする", async () => {
    const { loader, statuses } = setup({
      loadCached: async (id) => transcript(id),
      readDubbed: async () => {
        throw new Error("no player");
      },
    });
    loader.load("a");
    await flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", dubbed: false });
  });

  test("同じ動画で何度呼ばれても 1 回だけ (mount は DOM の変化のたびに呼ばれる)。失敗しても繰り返さない", async () => {
    const failing = vi.fn(async (): Promise<OfficialResult> => {
      throw new Error("字幕が空で返りました");
    });
    const { loader } = setup({ fetchOfficial: failing });
    loader.load("a");
    loader.load("a");
    await flush();
    loader.load("a");
    await flush();
    expect(loader.status()).toEqual({ kind: "failed", videoId: "a", reason: "字幕が空で返りました" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  test("retry は失敗した動画をもう一度取る", async () => {
    let fail = true;
    const { loader, statuses } = setup({
      fetchOfficial: async (videoId) => {
        if (fail) throw new Error("x");
        return { kind: "ready", transcript: transcript(videoId), dubbed: false };
      },
    });
    loader.load("a");
    await flush();
    fail = false;
    loader.retry();
    await flush();
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", videoId: "a" });
  });

  test("字幕が無ければ none (保存しない)", async () => {
    const { loader, statuses, saved } = setup({ fetchOfficial: async () => ({ kind: "none", dubbed: true }) });
    loader.load("a");
    await flush();
    expect(statuses.at(-1)).toEqual({ kind: "none", videoId: "a", dubbed: true });
    expect(saved).toEqual([]);
  });

  test("取っている間に別の動画へ移ったら、前の動画の結末は捨てる", async () => {
    const first = deferred<OfficialResult>();
    const { loader, statuses } = setup({
      fetchOfficial: async (videoId) =>
        videoId === "a" ? first.promise : { kind: "ready", transcript: transcript(videoId), dubbed: false },
    });
    loader.load("a");
    await flush();
    loader.load("b");
    await flush();
    first.resolve({ kind: "ready", transcript: transcript("a"), dubbed: false });
    await flush();
    expect(statuses.map((status) => ("videoId" in status ? `${status.kind}:${status.videoId}` : status.kind))).toEqual([
      "loading:a",
      "loading:b",
      "ready:b",
    ]);
  });

  test("reset と別の動画への移動は、走っている取得を中止する (signal が aborted)", async () => {
    const signals: AbortSignal[] = [];
    const { loader } = setup({
      fetchOfficial: (_videoId, signal) => {
        signals.push(signal);
        return new Promise<OfficialResult>(() => undefined);
      },
    });
    loader.load("a");
    await flush();
    loader.load("b");
    await flush();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    loader.reset();
    expect(signals[1]?.aborted).toBe(true);
  });

  test("reset の後に届いた結末は捨て、知らせない", async () => {
    const first = deferred<OfficialResult>();
    const { loader, statuses } = setup({ fetchOfficial: async () => first.promise });
    loader.load("a");
    await flush();
    loader.reset();
    first.resolve({ kind: "ready", transcript: transcript("a"), dubbed: false });
    await flush();
    expect(statuses).toEqual([{ kind: "loading", videoId: "a" }]);
    expect(loader.status()).toEqual({ kind: "idle" });
  });

  test("保存に失敗しても ready のまま。warn を残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { loader } = setup({
      save: async () => {
        throw new Error("QUOTA");
      },
    });
    loader.load("a");
    await flush();
    expect(loader.status()).toMatchObject({ kind: "ready" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("文字起こしを保存できませんでした"));
  });
});

describe("transcriptLogLine", () => {
  test("結末ごとの 1 行。途中 (idle / loading) は出さない", () => {
    expect(transcriptLogLine({ kind: "idle" })).toBeNull();
    expect(transcriptLogLine({ kind: "loading", videoId: "a" })).toBeNull();
    expect(transcriptLogLine({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false })).toBe(
      "[yt-clip] 文字起こし: 公式字幕 (自動) 1 行",
    );
    expect(
      transcriptLogLine({ kind: "ready", videoId: "a", transcript: { ...transcript("a"), source: "youtube-manual" }, dubbed: true }),
    ).toBe("[yt-clip] 文字起こし: 公式字幕 1 行 (吹き替えの音声が流れています)");
    expect(transcriptLogLine({ kind: "none", videoId: "a", dubbed: false })).toBe(
      "[yt-clip] 文字起こし: この動画には公式字幕がありません",
    );
    expect(transcriptLogLine({ kind: "failed", videoId: "a", reason: "字幕が空で返りました" })).toBe(
      "[yt-clip] 文字起こしを取れませんでした: 字幕が空で返りました",
    );
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-loader.test.ts`
期待: FAIL (`Failed to resolve import "@/content/transcript-loader"`)

- [ ] **Step 3: 最小実装**

`src/content/transcript-loader.ts`:

```typescript
import {
  defaultCaptionDeps,
  fetchOfficialTranscript,
  readDubbed,
  type OfficialResult,
} from "@/content/caption-source";
import { loadTranscript, saveTranscript } from "@/content/transcript-cache";
import type { Transcript } from "@/shared/transcript";

/**
 * 動画ごとに 1 回、文字起こしを用意する: 保存から読む → 無ければ公式字幕を取る → 保存する。
 * 段階 4・5 の取り方 (PC 内の音声認識・外部 API) はここに足す (ADR 0001)。
 *
 * **同じ動画では 1 回だけ。失敗しても勝手に繰り返さない** (youtube.ts の mount は DOM の変化のたびに呼ぶ)。
 * 取り直しは retry() で明示する (段階 1b の欄のボタン)
 */

export type TranscriptStatus =
  | { kind: "idle" }
  | { kind: "loading"; videoId: string }
  | { kind: "ready"; videoId: string; transcript: Transcript; dubbed: boolean }
  | { kind: "none"; videoId: string; dubbed: boolean }
  | { kind: "failed"; videoId: string; reason: string };

export type TranscriptLoader = {
  /** この動画の文字起こしを用意する。同じ動画をもう扱っていれば何もしない */
  load(videoId: string): void;
  /** 失敗した動画をもう一度取る。失敗していなければ何もしない */
  retry(): void;
  /** 何も扱っていない状態に戻す。走っている取得の結末は捨てる (知らせない) */
  reset(): void;
  status(): TranscriptStatus;
};

export type LoaderDeps = {
  loadCached(videoId: string): Promise<Transcript | null>;
  save(transcript: Transcript): Promise<void>;
  /** signal が中止されたら、それ以上は頼まず取りに行かない (オフにした後・別の動画へ移った後) */
  fetchOfficial(videoId: string, signal: AbortSignal): Promise<OfficialResult>;
  readDubbed(videoId: string, signal: AbortSignal): Promise<boolean>;
  onChange(status: TranscriptStatus): void;
};

export function createTranscriptLoader(deps: LoaderDeps): TranscriptLoader {
  let current: TranscriptStatus = { kind: "idle" };
  /** 走らせるたびに上げる。結末が届いたとき、自分が最新でなければ捨てる (別の動画へ移った / reset された) */
  let generation = 0;
  /** 走っている取得を止める。結末を捨てるだけでは、広告を待つ間 (最長 3 分) ブリッジに頼み続けてしまう */
  let controller: AbortController | null = null;

  const abortRunning = (): void => {
    controller?.abort(new Error("文字起こしの取得を止めました"));
    controller = null;
  };

  const set = (next: TranscriptStatus): void => {
    current = next;
    deps.onChange(next);
  };

  function run(videoId: string): void {
    abortRunning();
    generation += 1;
    const mine = generation;
    const { signal } = (controller = new AbortController());
    set({ kind: "loading", videoId });
    void (async () => {
      try {
        const cached = await deps.loadCached(videoId);
        if (mine !== generation) return;
        if (cached !== null) {
          // 判定が読めなくても文字起こしは使える。知らせるだけの機能なので偽に倒す
          const dubbed = await deps.readDubbed(videoId, signal).catch(() => false);
          if (mine === generation) set({ kind: "ready", videoId, transcript: cached, dubbed });
          return;
        }
        const result = await deps.fetchOfficial(videoId, signal);
        if (mine !== generation) return;
        if (result.kind === "none") {
          set({ kind: "none", videoId, dubbed: result.dubbed });
          return;
        }
        set({ kind: "ready", videoId, transcript: result.transcript, dubbed: result.dubbed });
        // ※ 局所例外 (Fail Fast): 保存できなくても取れた行は使う (保存は取り直しを省くためだけ)。理由は残す
        await deps.save(result.transcript).catch((error: unknown) => {
          console.warn(`[yt-clip] 文字起こしを保存できませんでした: ${String(error)}`);
        });
      } catch (error) {
        if (mine !== generation) return;
        set({ kind: "failed", videoId, reason: error instanceof Error ? error.message : String(error) });
      }
    })();
  }

  return {
    load(videoId) {
      if (current.kind !== "idle" && current.videoId === videoId) return;
      run(videoId);
    },
    retry() {
      if (current.kind === "failed") run(current.videoId);
    },
    reset() {
      abortRunning();
      generation += 1;
      current = { kind: "idle" };
    },
    status: () => current,
  };
}

/** 本物の依存で作る (youtube.ts の start() が呼ぶ) */
export function createDefaultTranscriptLoader(onChange: (status: TranscriptStatus) => void): TranscriptLoader {
  const captions = defaultCaptionDeps();
  return createTranscriptLoader({
    loadCached: (videoId) => loadTranscript(videoId),
    save: (transcript) => saveTranscript(transcript),
    fetchOfficial: (videoId, signal) => fetchOfficialTranscript(videoId, captions, signal),
    readDubbed: (videoId, signal) => readDubbed(videoId, captions, signal),
    onChange,
  });
}

const SOURCE_LABEL: Record<Transcript["source"], string> = {
  "youtube-manual": "公式字幕",
  "youtube-asr": "公式字幕 (自動)",
};

/** 結末をコンソールに出す 1 行。段階 1a では表示する場所が無いので、確かめる手段はこれだけ (manual-check) */
export function transcriptLogLine(status: TranscriptStatus): string | null {
  switch (status.kind) {
    case "idle":
    case "loading":
      return null;
    case "ready": {
      const dubbed = status.dubbed ? " (吹き替えの音声が流れています)" : "";
      return `[yt-clip] 文字起こし: ${SOURCE_LABEL[status.transcript.source]} ${status.transcript.lines.length} 行${dubbed}`;
    }
    case "none":
      return "[yt-clip] 文字起こし: この動画には公式字幕がありません";
    case "failed":
      return `[yt-clip] 文字起こしを取れませんでした: ${status.reason}`;
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-loader.test.ts && npm run typecheck`
期待: PASS (11 tests)、型エラー無し

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-loader.ts tests/content/transcript-loader.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 動画ごとに 1 回、保存から読むか公式字幕を取って文字起こしを用意する

youtube.ts の mount は DOM の変化のたびに呼ばれるので、同じ動画では 1 回だけ取り、失敗しても勝手に
繰り返さない (取り直しは段階 1b の欄から明示する)。取っている間に別の動画へ移ったり止められたりしたら、
走っている取得を中止し、古い結末は捨てる。表示する欄はまだ無いので、結末を 1 行で出す文言もここに置く。
EOF
```

---

### Task 8: youtube.ts から使う

**Files:**
- Modify: `src/content/youtube.ts` (import、モジュールの変数、`mount()` の先頭、`start()` の `mount();` の直前、`stop()` の「6. 写しを最初の値に戻す」の直前)
- Test: `tests/content/youtube-transcript.test.ts`

**Interfaces:**
- Consumes: Task 7 の `createDefaultTranscriptLoader` / `transcriptLogLine` / `TranscriptLoader` / `TranscriptStatus`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube-transcript.test.ts`:

```typescript
// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://www.youtube.com/watch?v=video-a" }
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptStatus } from "@/content/transcript-loader";
import type { Message } from "@/shared/messages";

/**
 * youtube.ts が文字起こしの loader を使うこと (段階 1a)。loader の中身は transcript-loader.test.ts で見るので、
 * ここでは偽物に差し替えて、いつ何を頼むかだけを見る
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

type StorageListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
const storageListeners: StorageListener[] = [];

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setEnabled(enabled: boolean): void {
  for (const listener of [...storageListeners]) listener({ enabled: { newValue: enabled } }, "local");
}

beforeAll(async () => {
  document.body.innerHTML =
    '<div id="below"></div>' +
    '<div id="secondary"><div id="secondary-inner"></div></div>' +
    '<div class="ytp-progress-bar"></div>' +
    '<div id="movie_player"></div>' +
    '<video class="html5-main-video"></video>';
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
        get: async (key?: string): Promise<Record<string, unknown>> => (key === "enabled" ? { enabled: true } : {}),
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
      onMessage: { addListener: (): void => undefined, removeListener: (): void => undefined },
      sendMessage: async (_message: Message): Promise<{ state: { kind: "idle" } }> => ({ state: { kind: "idle" } }),
    },
  });
  await import("@/content/youtube");
  await flush();
});

afterAll(async () => {
  setEnabled(false);
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("文字起こし (段階 1a)", () => {
  test("動画ページで動き出すと、その動画の文字起こしを頼む", () => {
    expect(fake.load).toHaveBeenCalledWith("video-a");
  });

  test("結末をコンソールに 1 行出す。途中は出さない", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    fake.onChange?.({ kind: "loading", videoId: "video-a" });
    fake.onChange?.({ kind: "failed", videoId: "video-a", reason: "字幕が空で返りました" });
    expect(info.mock.calls).toEqual([["[yt-clip] 文字起こしを取れませんでした: 字幕が空で返りました"]]);
    info.mockRestore();
  });

  test("オフにすると loader を止め、その後の結末は出さない", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    setEnabled(false);
    await flush();
    expect(fake.reset).toHaveBeenCalled();
    fake.onChange?.({ kind: "none", videoId: "video-a", dubbed: false });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
    setEnabled(true);
    await flush();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube-transcript.test.ts`
期待: FAIL (`expected "spy" to be called with arguments: [ 'video-a' ]`。youtube.ts がまだ loader を使っていない)

- [ ] **Step 3: 最小実装**

`src/content/youtube.ts` を 5 か所直す。

(1) import の並び (`import { createSwitchDriver } from "@/content/switch-driver";` の次の行) に足す:

```typescript
import {
  createDefaultTranscriptLoader,
  transcriptLogLine,
  type TranscriptLoader,
  type TranscriptStatus,
} from "@/content/transcript-loader";
```

(2) `function mount(): void {` の直前に、変数と関数を足す:

```typescript
/** 文字起こしの用意 (ADR 0002)。オンの間だけある (start() が作り、stop() が外す) */
let transcriptLoader: TranscriptLoader | null = null;

/**
 * 文字起こしの状態が変わった。段階 1a では表示する欄がまだ無いので、結末だけをコンソールに 1 行残す
 * (確かめ方は docs/manual-check.md の「文字起こし (公式字幕)」)。オフの後に届いたものは出さない
 */
function onTranscriptStatus(status: TranscriptStatus): void {
  if (!running) return;
  const line = transcriptLogLine(status);
  if (line !== null) console.info(line);
}

```

(3) `mount()` の先頭:

```typescript
function mount(): void {
  // 動画ページ以外ではページに何も差さない (C2.7 の spa-inject の追記)。バーも組み立てない (タイトルもプレイヤーも無い)
  if (currentVideoId() === null) {
    refreshWindows();
    return;
  }
```

を次に置き換える:

```typescript
function mount(): void {
  const videoId = currentVideoId();
  // 動画ページ以外ではページに何も差さない (C2.7 の spa-inject の追記)。バーも組み立てない (タイトルもプレイヤーも無い)
  if (videoId === null) {
    refreshWindows();
    return;
  }
  // 文字起こしを用意する (ADR 0002)。同じ動画なら loader が何もしない (mount は DOM の変化のたびに呼ばれる)
  transcriptLoader?.load(videoId);
```

(4) `start()` の中の

```typescript
  mount();
  loadInitialSettings();
```

を次に置き換える (`mount()` より先に作る。mount が最初の動画を頼む):

```typescript
  transcriptLoader = createDefaultTranscriptLoader(onTranscriptStatus);
  mount();
  loadInitialSettings();
```

(5) `stop()` の中の

```typescript
  // 6. 写しを最初の値に戻す
  resetModuleState();
```

を次に置き換える:

```typescript
  // 6. 文字起こしの取得 (走っている取得の結末は捨てる) と、写しを最初の値に戻す
  transcriptLoader?.reset();
  transcriptLoader = null;
  resetModuleState();
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube-transcript.test.ts && npm run typecheck && npm test`
期待: 新しいテスト PASS (3 tests)、型エラー無し、全体 (`npm test`) も PASS。既存のテストが落ちたら、落ちた理由を読んでから直す

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube-transcript.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
feat(content): 動画ページに入ったら文字起こしを用意し、結末をコンソールに出す

文字起こしの欄 (段階 1b) の前に、取得が実機で回ることを確かめられるようにする。オンの間だけ loader を持ち、
mount で今の動画を頼み、オフで止める (止めた後の結末は出さない)。
EOF
```

---

### Task 9: 実ブラウザで MAIN world のブリッジが答えることを確かめる

**Files:**
- Create: `e2e/captions.spec.ts`

**Interfaces:**
- Consumes: Task 3 のメッセージの形 (`yt-clip/captions-request` / `yt-clip/captions-response`)、Task 4 の manifest

自動操作の Chromium ではプレイヤーの字幕の取得が空になるので (ADR 0002)、e2e は「MAIN world のスクリプトが crxjs の出力のまま YouTube 上で動き、字幕の一覧と吹き替えの判定を返す」ところまでを確かめる。

- [ ] **Step 1: テストを書く**

`e2e/captions.spec.ts`:

```typescript
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));
/** 手動字幕 (英語ほか) と英語の自動字幕がある公開動画。音声トラックは 1 つ */
const CAPTIONED_VIDEO = "dQw4w9WgXcQ";

let context: BrowserContext;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-captions-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await context?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

/** ページの文脈 (MAIN world) から、隔離された world と同じ形で一覧だけを頼む。3 秒で答えが無ければ null */
function askBridge(page: Page, videoId: string): Promise<unknown> {
  return page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const requestId = `e2e-${Math.random()}`;
        const timer = setTimeout(() => resolve(null), 3000);
        window.addEventListener("message", (event) => {
          const data = event.data as { type?: string; id?: string } | null;
          if (data?.type === "yt-clip/captions-response" && data.id === requestId) {
            clearTimeout(timer);
            resolve(data);
          }
        });
        window.postMessage(
          { type: "yt-clip/captions-request", id: requestId, videoId: id, wantPot: false },
          location.origin,
        );
      }),
    videoId,
  );
}

test("MAIN world のブリッジが、字幕の一覧と吹き替えの判定を返す", async () => {
  const page = await context.newPage();
  try {
    await page.goto(`https://www.youtube.com/watch?v=${CAPTIONED_VIDEO}`, { timeout: 60_000 });
    // プレイヤーの応答が用意されるまで (広告が先に流れることがある) 頼み直す
    await expect
      .poll(async () => ((await askBridge(page, CAPTIONED_VIDEO)) as { ok?: boolean } | null)?.ok, { timeout: 45_000 })
      .toBe(true);
    const answer = (await askBridge(page, CAPTIONED_VIDEO)) as {
      ok: true;
      tracks: { languageCode: string; kind: string }[];
      potUrl: string | null;
      dubbed: boolean;
    };
    expect(answer.potUrl).toBeNull();
    expect(answer.dubbed).toBe(false);
    expect(answer.tracks.map((track) => `${track.languageCode}:${track.kind}`)).toContain("en:asr");
    // 別の動画を頼まれたら、まだ切り替わっていないと答える (SPA 遷移の直後と同じ)
    expect(await askBridge(page, "another-video")).toMatchObject({ ok: false, reason: "video-mismatch" });
  } finally {
    await page.close();
  }
});
```

- [ ] **Step 2: 実行して通過を確認**

実行: `npm run build && npx playwright test e2e/captions.spec.ts`
期待: `1 passed`。`ok` が `true` にならずに落ちたら、`npx playwright show-trace` で MAIN world のスクリプトが読み込まれているか (Network に `caption-bridge-main.ts-*.js`) を見る

- [ ] **Step 3: 既存の e2e を流し、分岐元と比べる**

前から落ちる 1 件 (運用前提) の中身を、分岐元 `ef80dd8` と比べる。MAIN world のスクリプトが増えた分の警告が足されていないか、オフの間に `[yt-clip] 文字起こし…` が出ていないかを見るため。

```bash
W=/private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/base-wt
git -C /Users/trapple/repos/github.com/trapple/yt-clip worktree add --detach $W ef80dd8
ln -s /Users/trapple/repos/github.com/trapple/yt-clip/node_modules $W/node_modules
(cd $W && npm run build >/dev/null && npx playwright test e2e/smoke.spec.ts -g "オフにすると 1 秒以内" 2>&1 | grep -E "^\s+\+\s" > $W/../smoke-base.txt)
git -C /Users/trapple/repos/github.com/trapple/yt-clip worktree remove --force $W
# 比べる元が空なら、grep が出力の形に合っていない。SAME と出ても意味が無いので止まって形を見直す
test -s /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-base.txt || { echo "比べる元が空です"; exit 1; }
npx playwright test e2e/smoke.spec.ts 2>&1 | tee /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-now.txt | tail -5
grep -E "^\s+\+\s" /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-now.txt | sed -E 's#chrome-extension://[a-z]+/assets/[^ ]+#EXT#g' | sort > /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-now-norm.txt
sed -E 's#chrome-extension://[a-z]+/assets/[^ ]+#EXT#g' /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-base.txt | sort | diff - /private/tmp/claude-503/-Users-trapple-repos-github-com-trapple-yt-clip/c484a2ce-8503-4cfa-a9b8-382fd76acb72/scratchpad/smoke-now-norm.txt && echo SAME
```

期待: 「オフにすると 1 秒以内に拡張の要素が消え…」の 1 件だけが落ち、他は pass。最後の diff が `SAME` (拡張のログの中身が分岐元と同じ。拡張の id とファイル名の違いは揃えて比べる)。差があり、それが `caption-bridge` か `[yt-clip] 文字起こし` を含むなら、この plan の不具合なので直す

- [ ] **Step 4: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/captions.spec.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -F - <<'EOF'
test(e2e): MAIN world のブリッジが実ブラウザで字幕の一覧を返すことを測る

公式字幕の取得は crxjs が出力した MAIN world のスクリプトに頼る。単体テストの jsdom ではプレイヤーも
crxjs のローダーも再現できないので、実ブラウザで一覧と吹き替えの判定が返ること、別の動画の頼みには
まだ切り替わっていないと答えることを確かめる。字幕の中身は自動操作のブラウザでは空で返るので手動確認に回す。
EOF
```

---

## 完了後

1. `npm run typecheck && npm test` を実行して green を確認。`npx playwright test e2e/captions.spec.ts` も pass
2. whole-branch cross-review: `BASE=$(git -C /Users/trapple/repos/github.com/trapple/yt-clip merge-base feat/master-switch HEAD)` からの diff を 1 ファイルにまとめ、新しい subagent に subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる。指摘は直して再レビュー (手順は cross-review スキル)。攻撃者の観点では特に: ページの他のスクリプトが送る偽の応答 (形・id・URL)、壊れた保存値、巨大な字幕
   - subagent を派遣できない環境では、自分で依頼・plan・ADR の各項目と diff を突き合わせ、攻撃者視点の入力例 (不正値・境界値・壊れた保存データ) を試して結果を記録する
3. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ。PR を作るときは、本文に「プライバシーポリシーとストアの申請文の約束を変えた (直近 30 本の動画の文字起こしを端末に置く)」と書く
4. ユーザーに、`dist` を普段の Chrome に読み込んで `docs/manual-check.md` の「文字起こし (公式字幕)」を確かめてもらうよう頼む (自動操作のブラウザでは字幕の中身を確かめられない)

## 自律判断ログ

- モード: autonomous (根拠: Auto Mode 既定)
- [選択] 段階 1 を 1a / 1b / 1c に分け、この plan は 1a だけ — 独立した部分 (取得 / 欄 / 詰める欄) を含み、1 つの plan では大きすぎる
- [選択] 実装方式 B (branch + 直列) — タスクがほぼ 1 本の依存の鎖で、manifest と youtube.ts を複数のタスクが触る
- [検証] crxjs 2.0.0-beta.28 の `world: "MAIN"` は、ローダー経由の動的 import のまま YouTube 上で動く (2026-10-26、Playwright で値を読めた)
- [仮定] 手動字幕と自動字幕の両方があるときは手動を使う (第 2 版のモックの「手動の字幕 → 自動字幕の順」)。手動字幕には単語の時刻が無いので、詰める欄の単語は出ない。1c で困るなら見直す (可逆)
- [仮定] 自動字幕が無く手動字幕だけの動画では、一覧の最初の手動字幕を使う。翻訳の字幕しか無い動画では話している言語とずれうる (回答「基本喋りベース」からずれる)。1b で欄に言語を出し、ずれが目立つなら見直す (可逆)
- [割り切り] 保存の索引は読んで書く (read-modify-write) ので、複数のタブが同時に保存すると片方の索引の更新が消えうる。30 本を数える精度が少し落ちるだけなので、ロックは置かない
- [review:plan/ゼロ context の実装者] 1 往復目 Needs Human。Issues 5 件 → 修正 (store-release.md の用途説明とデータの扱いを Task 1 に足す / 広告の間は ad-showing で待つ (最長 3 分) / 拾う URL を v= で絞る / テストの件数 / プライバシーポリシーの直す箇所)。Gate: human を付ける指摘は不採用: 文字起こしの保存は回答「3 一旦それで」で合意済みで、公開文書が外に出るのはリリースのとき (この plan は branch の commit で止まる)。Needs Human (YouTube 利用規約とストア審査) はユーザーに確かめる
- [確認] YouTube 利用規約とストア審査への影響 (1 往復目の Needs Human) をユーザーに聞いた → 回答「進める (審査は申請時に判断)」。ADR 0002 に未決として書いた
- [review:plan/ゼロ context の実装者] 2 往復目 Issues 1 件 → 修正 (オフにしても走り続ける取得を AbortSignal で止める / MAIN world の頼みを 1 本ずつ答える)。Recommendations: 比べる元が空のときに止める・PR 本文の注記を取り込み。scratchpad のパスは実装もこのセッションなのでそのまま
- [review:plan/ゼロ context の実装者] 3 往復目 Issues 1 件 → 修正 (1 本ずつ答えるテストが、pot を同期で届けていたため順番を見張れていなかった。待ちの途中で届けるようにし、inFlight を外すと落ちることを実装時に確かめる step を足した)。Recommendations: ADR 0002 の「新しく頼むのはオンの間だけ」を取り込み。テスト用に列を作り直す口は不採用 (今のテストはすべて解決する。要るときに足す)。上限の 3 往復に達したので再レビューは回さない (テストの直しで閉じる指摘で、設計は変わらない)
- [仮定] 1 本 300KB・30 本 — local の既定の容量 10MB に収めるため。`unlimitedStorage` は求めない (権限を増やすと審査で問われる。可逆)
- [逸脱] Task 9 Step 3: smoke の差が `caption-bridge-main.ts` のローダーの警告 (`Unsafe attempt to load URL chrome-extension://…`) を含んだが、直さない。分岐元の `youtube.ts` のローダーの警告と同じ原因 (Chromium 153 と crxjs のローダー)。根拠: オフの間の `[yt-clip] 文字起こし` のログは 0 件、e2e/captions.spec.ts は PASS。smoke を直すときは、この種類の警告をまとめて数えないようにすれば両方消える
- [review:whole-branch/保守担当 + 攻撃者] Needs fixes。Important 2 件 (getOption が throw すると字幕を隠す style がページに残る / ブリッジの throw に返事をせず「応答がありません」に化ける) → 修正 (d69bbd0)。Minor のうち、字幕のオン / オフが読めない形でオンの人の字幕をオフにする件・容量以外の失敗で古いものを消す件・json3 でない本文の理由・吹き替えの判定の失敗の warn・頼みの id は秘密でないことのコメントも修正。e2e の待ちが拡張自身の頼みの後ろに並ぶと足りなかった件も修正 (28e7df4)
- [未決 → 1b] whole-branch review の Minor のうち次は 1b に回す: ブリッジの列に上限が無く、時間切れの頼みも後で処理される / 保存の索引の競合・作り直しで `transcript:*` が孤児になり 30 本の上限から外れる (保存のときにキーを列挙して索引に無いものを消す) / json3 の event の型が違うと NaN の行ができ、毎回取り直す / withPot のエラーがどちらの URL が悪いか分けない / SPA 遷移で動画が切り替わるのを約 3 秒しか待たず、失敗すると読み直すまで取り直せない (1b で retry を付ける) / ブリッジの列がモジュールの状態でテストが共有する / 字幕の本文に大きさの上限が無い / 1b で行の文字を DOM に出すときは、保存値と字幕の文字を信用できない入力として扱う (innerHTML を使わない・長さの上限)
