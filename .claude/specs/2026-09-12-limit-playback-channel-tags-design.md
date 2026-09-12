# 最大秒数の設定・バークリックで再生・チャンネル別タグ

実機で出た 3 件をまとめて扱う。3 件とも既存の仕組みの上に乗る改修で、
新しいサブシステムは作らない。

- **A. 最大秒数を設定にする** — いま 60 秒固定
- **B. 拡大バーのクリックでそこから再生** — IN/OUT は変えない
- **C. ハッシュタグをチャンネル別にする** — 共通のタグは持たない

---

## A. 最大秒数の設定

### A.1 いま上限を持っている場所は 3 つある

`MAX_CLIP_SEC` (= 60) を読んでいるのは次の 2 箇所で、**通る経路が違う**。

| 場所 | 経路 | 上限を超えたときの振る舞い |
|---|---|---|
| `validateRange` (`shared/time.ts`) | OUT ボタン | 文言を出して先へ進まない |
| `clampHandle` (`content/range-math.ts`) | 拡大バーのドラッグ | 黙って止まる (それ以上伸びない) |

片方だけ設定に繋ぐと、**ドラッグでは伸ばせるのに OUT では弾かれる**という
食い違いが生まれる。両方を同じ値で動かす。

3 つめは `makeDefaultRange` で、IN を押したときに **15 秒** (`DEFAULT_CLIP_SEC`)
の範囲を作る。上限を 15 秒より短くすると、**IN を押した直後から上限を超えた
範囲**ができ、そのまま録画できてしまう (`validateRange` は OUT ボタンしか
通らない)。既定の長さも上限で頭打ちにする。

### A.1.1 定数の名前を変える

`MAX_CLIP_SEC` は「いまの上限」ではなく「既定値」になる。名前を
`DEFAULT_MAX_CLIP_SEC` に変え、設定で入れられる上限を
`MAX_SETTABLE_CLIP_SEC` (= 140) として隣に置く。
古い名前のまま残すと、**現在値のつもりで既定値を読む**取り違えが起きる。

### A.2 引数で渡す。モジュール変数にしない

どちらも純粋関数なので、上限を**引数で受ける**形にする。

```typescript
export function validateRange(
  startSec: number,
  endSec: number,
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
): RangeValidation;

export function clampHandle(
  kind: HandleKind,
  desiredSec: number,
  range: ClipRange,
  window: TimeWindow,
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
): ClipRange;

export function makeDefaultRange(
  startSec: number,
  videoDurationSec: number,
  maxClipSec: number = DEFAULT_MAX_CLIP_SEC,
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

範囲外や数値でない入力は保存せず、その理由を出す。
**保存できなかったことを黙らない。** 設定したつもりで録画に進むのが一番困る。

入力が 1 つでも通らなければ、**他の項目も保存しない**。一部だけ書き込むと、
エラーを見た利用者が「何が保存されて何が保存されなかったか」を
画面から判断できない。

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
};
```

### C.2 チャンネルを特定する

`VideoMeta` に 2 つ足す。

```typescript
export type VideoMeta = {
  videoId: string;
  title: string;
  /** 設定を引く鍵。ハンドル (`@name`)。取れなければ `UC...` */
  channelId: string;
  /** 表示用。どのチャンネルの設定を触っているか見せるため */
  channelName: string;
};
```

**実機を調べた結果、いまの watch ページには `UC...` がどこにも出ていない。**
`meta[itemprop="channelId"]` は存在せず、オーナー欄のリンクもすべて
ハンドル (`/@name`) だった。したがって**実際に使われる鍵はハンドル**になる。

**鍵にはハンドルを優先する。** `UC...` はハンドルが取れないときの保険。

`UC...` の方が本来は安定した識別子だが、**いま取れるとは限らない**。
メンバーシップのあるチャンネルだけ `/channel/UC.../join` のリンクが出る、
といった差が実際にありうる。`UC...` を優先すると、**同じチャンネルなのに
動画によって鍵が変わり**、設定したタグが別の動画で出てこなくなる。
ハンドルはどの watch ページにも必ず出ているので、鍵として一貫する。

代償として、チャンネルがハンドルを変えるとそのタグは引けなくなる。
これは稀で、設定し直せば直る。**鍵が黙って変わる方が危険**。

探し方は「候補を順に試して最初の 1 つ」ではなく、**候補を全部集めてから
ハンドル → `UC...` の順に探す**。順に試す方式だと、リストの前の方にある
`UC...` のリンクが先に当たり、ハンドルを見ずに終わる。

候補は**構造化データ (schema.org) を先に見る**。
`span[itemprop="author"] link[itemprop="url"]` と `link[itemprop="name"]` は
見た目のレイアウトより変わりにくい。オーナー欄の DOM 構成は
A/B テストで利用者ごとに違いうる。

リンクからは**絶対 URL (`element.href`) を読む**。`getAttribute("href")` は
ページによって相対にも絶対にもなり、`[href^="/@"]` のようなセレクタでは
片方しか拾えない。

特定できなかったときは、**集まった候補をそのままログに出す**。
「特定できません」だけでは、次に何を直せばよいか分からない。

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
(設定と同じ理屈)。読み出し側で欠けを許す。

設定がまだ無いチャンネルでは**空**を返す。パネルの表示 (`toText`) と
本文の組み立ては**同じ関数**から引くので、「パネルには出ているのに本文に
入らない」という食い違いは起きない。

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
  /** 「どのチャンネルのタグか」を出すので、文脈を受け取る */
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
  ): FieldResult;
};
```

`scope` で分岐するのはパネル側 1 箇所だけ (`channel` かつ文脈が null なら
入力欄を無効にして理由を出す)。項目の `key` で分岐はしない。

`fromText` の戻り値は既存の `RangeValidation` と同じ判別可能ユニオンにする。

```typescript
export type FieldResult =
  | { ok: true; patch: Partial<Settings> }
  | { ok: false; message: string };
```

検証を持てるようにするのは A.5 のため。**保存できない入力を黙って捨てない。**

### C.5 いま保存されている共通タグの行き場

利用者の `chrome.storage.sync` には共通タグが入っている
(`hashtags: ["クリ明透", "あすカット"]`)。チャンネル別だけにすると行き場が無い。

**引き継がない。捨てる。**

一度は引き継ぎ (設定の無いチャンネルに共通タグを出す) を実装したが、
利用者の判断で取りやめた。**どのチャンネルにも同じタグが出てくるのは邪魔**で、
「チャンネル別のみ」という決定とも食い違う。

- `mergeSettings` は古い `hashtags` キーを**読み捨てる**
- 捨てたことは `console.info` に残す。値も出す。**黙って消さない**
- 保存し直せば古いキーは storage からも消える
  (`saveSettings` は `Settings` の形で書き直すため)

設定の無いチャンネルのタグは空。`hashtagsFor` も空を返す。

---

## 5. テスト

| 対象 | 見るもの |
|---|---|
| `validateRange` / `clampHandle` / `makeDefaultRange` | 渡した上限で振る舞いが変わること。**3 つが同じ値で動くこと** |
| 拡大バー | `setMaxClipSec` した値がドラッグのクランプに効くこと (計算だけでなく繋ぎ込みを見る) |
| 設定の検証 | 0 / 141 / 数値でない入力が保存されず理由が出ること |
| `createRangeBar` | トラックの `pointerdown` で `onSeekPlay` が呼ばれ、`onCommit` が呼ばれないこと。ハンドル上では呼ばれないこと。`enabled` が false なら呼ばれないこと |
| `hashtagsFor` | 該当チャンネル / 未設定のチャンネル / `channelId` が `undefined` や空文字 |
| `mergeSettings` | 古い `hashtags` を読み捨て、理由をログに残すこと |
| 設定パネル | チャンネルが null のとき入力させないこと。保存が他チャンネルの設定を消さないこと |
| チャンネル抽出 | **ハンドルを `UC...` より先に**探すこと (候補の並び順に引きずられないこと)、相対 URL と絶対 URL の両方、空要素の読み飛ばし、どちらも無いとき空文字 |

## 6. 手動確認

`manual-check.md` に足す。

- 上限を 10 秒にすると、OUT でもドラッグでも 10 秒までしか伸びない
- 上限に 141 を入れると保存されず理由が出る
- バーのトラックを押すとそこから再生され、**IN/OUT は動かない**
- 録画中にトラックを押しても何も起きない
- チャンネル A で付けたタグが、チャンネル B の投稿に出ない
