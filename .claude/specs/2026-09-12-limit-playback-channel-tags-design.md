# 最大秒数の設定・バークリックで再生・チャンネル別タグ

実機で出た 3 件をまとめて扱う。3 件とも既存の仕組みの上に乗る改修で、
新しいサブシステムは作らない。

- **A. 最大秒数を設定にする** — いま 60 秒固定
- **B. 拡大バーのクリックでそこから再生** — IN/OUT は変えない
- **C. ハッシュタグをチャンネル別にする** — 共通のタグは持たない

---

## A. 最大秒数の設定

### A.1 いま上限を持っている場所は 2 つある

`MAX_CLIP_SEC` (= 60) を読んでいるのは次の 2 箇所で、**通る経路が違う**。

| 場所 | 経路 | 上限を超えたときの振る舞い |
|---|---|---|
| `validateRange` (`shared/time.ts`) | OUT ボタン | 文言を出して先へ進まない |
| `clampHandle` (`content/range-math.ts`) | 拡大バーのドラッグ | 黙って止まる (それ以上伸びない) |

片方だけ設定に繋ぐと、**ドラッグでは伸ばせるのに OUT では弾かれる**という
食い違いが生まれる。両方を同じ値で動かす。

### A.2 引数で渡す。モジュール変数にしない

どちらも純粋関数なので、上限を**引数で受ける**形にする。

```typescript
export function validateRange(
  startSec: number,
  endSec: number,
  maxClipSec: number = MAX_CLIP_SEC,
): RangeValidation;

export function clampHandle(
  kind: HandleKind,
  desiredSec: number,
  range: ClipRange,
  window: TimeWindow,
  maxClipSec: number = MAX_CLIP_SEC,
): ClipRange;
```

モジュール変数に現在値を置く案は採らない。テストが実行順に依存するようになり、
「どの値で呼ばれたか」がシグネチャから消える。

既定値を残すのは、上限を渡さない呼び出し (既存テスト) を壊さないためであり、
**本番の呼び出しでは必ず明示的に渡す**。

### A.3 拡大バーへの渡し方

`clampHandle` は拡大バーのドラッグ中に呼ばれる。バーに現在値を持たせる。

```typescript
export type RangeBar = {
  // ...
  /** 1 クリップの最大長 (秒)。設定が変わったら呼び直す */
  setMaxClipSec(sec: number): void;
};
```

### A.4 設定が変わったことを知る

設定パネルは content script の中にあるが、**別のタブで変えられることもある**。
`chrome.storage.onChanged` を content script で購読し、`settings` キーが
変わったら現在値を読み直す。パネルの保存ボタンに繋ぐだけでは、隣のタブの
バーが古い上限のまま残る。

### A.5 入れてよい値

| 項目 | 値 |
|---|---|
| 既定 | 60 |
| 下限 | `MIN_CLIP_SEC` (= 1) |
| 上限 | **140** (X の動画の上限) |

範囲外や数値でない入力は保存せず、入力欄の下にその理由を出す。
**保存できなかったことを黙らない。** 設定したつもりで録画に進むのが一番困る。

上限を超える値を保存できてしまうと、録画は通るのに X で弾かれる。
失敗が録画の後まで遅れるぶん、手前で止める価値がある。

---

## B. 拡大バーのクリックで再生

### B.1 やること

拡大バーの**トラック上**を押したら、その位置へシークして再生する。
**IN/OUT は変えない。**

### B.2 ハンドルのドラッグと衝突させない

ハンドルはトラックの子要素なので、ハンドルを掴んだ `pointerdown` は
トラックにも伝わる。トラック側で **イベントの発生元がハンドルなら何もしない**。

```typescript
if (inHandle.contains(target) || outHandle.contains(target)) return;
```

`stopPropagation` をハンドル側に足す案は採らない。ハンドルの責務が
「自分を動かす」から「親に伝えない」まで広がり、後から親を足すたびに
そちらを直すことになる。

### B.3 いつ受け付けるか

ドラッグと**同じ条件** (`enabled`) にする。`enabled` が false なのは
「範囲が未確定」と「録画が進行中」で、後者でシークすると**録画された映像に
意図しない飛びが入る**。ここを緩めると実害が出る。

### B.4 誰がシークするか

バーは DOM しか知らない。秒数をコールバックで返し、動画を触るのは
content script 側にする (`onScrub` と同じ形)。

```typescript
export type RangeBarCallbacks = {
  onScrub(sec: number): void;
  onCommit(range: ClipRange): void;
  /** トラックが押された。その位置から再生する。範囲は変えない */
  onSeekPlay(sec: number): void;
};
```

再生位置マーカー (`setPlayhead`) は既存の rAF 監視がそのまま追従する。

---

## C. ハッシュタグをチャンネル別にする

### C.1 共通のタグは持たない

チャンネルごとの設定**だけ**を持つ。「既定 + チャンネル別」の 2 段は採らない
(利用者の選択)。

```typescript
export type Settings = {
  template: string;
  maxClipSec: number;
  /** チャンネル ID → タグ。# は含めない */
  hashtagsByChannel: Record<string, string[]>;
  /** 移行用。C.5 参照 */
  legacyHashtags: string[];
};
```

### C.2 チャンネルを特定する

`VideoMeta` に 2 つ足す。

```typescript
export type VideoMeta = {
  videoId: string;
  title: string;
  /** 設定を引く鍵。`UC...` が取れなければハンドル (`@name`) */
  channelId: string;
  /** 表示用。どのチャンネルの設定を触っているか見せるため */
  channelName: string;
};
```

タイトルと同じく**候補を順に試し、中身が空でない最初のものを採る**。
実機で当たる要素が変わることは既に一度起きている。

鍵には `UC...` を優先する。ハンドルは変更されうるので、変わるとタグが
引けなくなる。ただし `UC...` が取れない画面構成もありうるため、
ハンドルへ落ちる経路を残す。

**どちらも取れなければ throw しない。** タイトルと違い、タグが無いだけで
投稿本文は成立する。`channelId` は空文字にし、タグは空として扱う。

### C.3 本文を組み立てる側

本文を作るのは service worker (`router.ts`) で、そこには `clip.meta` がある。

```typescript
export function hashtagsFor(
  settings: Settings,
  channelId: string | undefined,
): string[];
```

**`undefined` を受けること。** IndexedDB に残っている古いクリップの `meta` には
`channelId` が無い。型の上では `string` だが、保存済みの値は型を保証しない
(設定と同じ理屈)。読み出し側で欠けを許し、タグ無しとして扱う。

### C.4 設定パネルが「今どのチャンネルか」を知る

`SettingsField` は今 `Settings` しか受け取らない。文脈を足す。

```typescript
export type SettingsContext = {
  /** いま開いている動画のチャンネル。特定できなければ null */
  channel: { id: string; name: string } | null;
};

export type SettingsField = {
  key: string;
  label: string;
  /** 文脈によって変わる (「@foo のタグ」) ので関数にする */
  hint(context: SettingsContext): string;
  /** チャンネルが必要な項目。特定できないときは入力させない */
  scope: "global" | "channel";
  toText(settings: Settings, context: SettingsContext): string;
  /**
   * 入力を設定の一部にする。
   * **現在の設定を受け取る。** チャンネル別の項目は既存の他チャンネル分を
   * 残したまま 1 件だけ差し替える必要がある
   */
  fromText(
    text: string,
    settings: Settings,
    context: SettingsContext,
  ): Partial<Settings> | { error: string };
};
```

`scope` で分岐するのはパネル側 1 箇所だけ (`channel` かつ文脈が null なら
入力欄を無効にして理由を出す)。項目の `key` で分岐はしない。

`fromText` が `{ error }` を返せるようにするのは A.5 の検証のため。
**保存できない入力を黙って捨てない。**

### C.5 いま保存されている共通タグの行き場

利用者の `chrome.storage.sync` には共通タグが入っている
(`hashtags: ["クリ明透", "あすカット"]`)。チャンネル別だけにすると行き場が無い。

**捨てない。引き継ぐ。**

- `mergeSettings` は古い `hashtags` キーを `legacyHashtags` に移す
- そのチャンネルの設定がまだ無いとき、入力欄には `legacyHashtags` を出す。
  hint に「以前の共通設定から引き継いでいます」と添える
- **保存すると `legacyHashtags` は空になる。** 残したままにすると、新しい
  チャンネルを開くたびに同じタグが出続け、「チャンネル別のみ」という
  決定と食い違う

移行したことは `console.info` にも残す。画面を見ていなくても追える。

---

## 5. テスト

| 対象 | 見るもの |
|---|---|
| `validateRange` / `clampHandle` | 渡した上限で振る舞いが変わること。**両方が同じ値で動くこと** |
| 設定の検証 | 0 / 141 / 数値でない入力が保存されず理由が出ること |
| `createRangeBar` | トラックの `pointerdown` で `onSeekPlay` が呼ばれ、`onCommit` が呼ばれないこと。ハンドル上では呼ばれないこと。`enabled` が false なら呼ばれないこと |
| `hashtagsFor` | 該当チャンネル / 未設定のチャンネル / `channelId` が `undefined` |
| `mergeSettings` | 古い `hashtags` が `legacyHashtags` に移ること |
| 設定パネル | チャンネルが null のとき入力させないこと。保存が他チャンネルの設定を消さないこと |
| チャンネル抽出 | 候補の順、空要素の読み飛ばし、どちらも無いとき空文字 |

## 6. 手動確認

`manual-check.md` に足す。

- 上限を 10 秒にすると、OUT でもドラッグでも 10 秒までしか伸びない
- 上限に 141 を入れると保存されず理由が出る
- バーのトラックを押すとそこから再生され、**IN/OUT は動かない**
- 録画中にトラックを押しても何も起きない
- チャンネル A で付けたタグが、チャンネル B の投稿に出ない
- 初回の設定画面に、以前の共通タグが引き継がれて出る
