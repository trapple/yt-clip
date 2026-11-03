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
