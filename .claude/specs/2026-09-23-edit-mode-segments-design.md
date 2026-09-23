# エディットモード (1) 複数区間の結合

同じ動画の中の複数箇所を拾って 1 本のクリップに繋げる。操作は設定で選ぶ
**エディットモード**に入っている間だけ出る。シンプルモード (現状) は変えない。

---

## 0. この spec の範囲

「モードを切り替えて今より複雑な編集をする」という要望には、独立した
サブシステムが 4 つ含まれている。**1 本の spec には収まらないので分ける。**

| # | 塊 | 中身 | この spec |
|---|---|---|---|
| 1 | モードの土台 + 複数区間の結合 | 設定・状態機械・録画・UI | **これ** |
| 2 | 書き出しパイプライン | WebCodecs で decode → canvas → encode → mp4 mux | 別 spec |
| 3 | テロップ | 自由配置・時間区間・プレビュー・canvas 合成 | 別 spec |

**3 は 2 の上にしか乗らないが、1 は 2 と独立している。** 1 だけ入った状態でも
「複数箇所を結合したクリップを X に投稿する」は完成品として成立する。

### 0.1 2 と 3 が後で乗る場所を先に決めておく

1 を作り切ってから 2/3 の都合で作り直すのは避ける。土台としては次の 2 つだけ
決めておけばよい。

- **出力タイムラインという座標系** — テロップの時刻は元動画の秒ではなく、
  結合後のクリップの先頭を 0 とした秒で持つ。この変換は `shared/timeline.ts`
  に置く (§2.2)
- **`segments` は将来 `telops` と並ぶ** — 状態が持つのは今は `segments` だけ
  だが、3 では同じ階層に `telops` が生える。`segments` を状態の直下に置き、
  `ClipRange` を包む中間の型を作らないでおく

それ以上は決めない。2 の実現性が未確認なうちに 3 の形を固めても、前提ごと
崩れる可能性がある (§9)。

---

## 1. モードは設定で選ぶ

バー上のトグルで往復する案は採らない。**`Settings` に 1 項目足すだけで済む**
うえ、往復を許すと「シンプルで作った範囲をエディットに引き継ぐか」という
問いが常に付きまとう。固定モードなら、切り替えは稀な操作として扱える。

```typescript
export type ClipMode = "simple" | "edit";

export type Settings = {
  template: string;
  hashtagsByChannel: Record<string, string[]>;
  maxClipSec: number;
  mode: ClipMode;   // 追加。既定は "simple"
};
```

`mergeSettings` は他の項目と同じ作法で扱う。**型の合わない値は既定値に倒し、
理由を `console.warn` に残す。** 黙って落とさない。

### 1.1 設定パネルは選択肢を出せない

`SETTINGS_FIELDS` は**テキスト入力欄専用**になっている。`createSettingsPanel`
は各 field に対して `input type="text"` を 1 つ作るだけで、選択肢を出す道が
ない。モードは自由入力にできる値ではないので、枠を広げる。

```typescript
export type SettingsField = {
  key: string;
  label: string;
  scope: "global" | "channel";
  /** 入力欄の種類。パネルはこれを見て作り分ける */
  control: { kind: "text" } | { kind: "select"; options: SelectOption[] };
  hint(context: SettingsContext): string;
  toText(settings: Settings, context: SettingsContext): string;
  fromText(text: string, settings: Settings, context: SettingsContext): FieldResult;
};

export type SelectOption = { value: string; label: string };
```

**`key` を見た分岐は入れない。** パネルが見るのは `scope` と `control` だけで、
どちらも field 側が宣言する値である。既存の「項目を足すときに触るのは
`Settings` と `SETTINGS_FIELDS` の 2 箇所だけ」という性質は保たれる。

`toText` / `fromText` の形はそのまま使う。select の値も文字列なので、
text と別の経路を作る理由がない。

```typescript
/** 入力欄の文字列をモードの差分にする。他の項目と同じ FieldResult に揃える */
export function parseMode(input: string): FieldResult;
```

`"simple"` / `"edit"` 以外を受けたら `ok: false` を返す。**既定値に倒さない。**
選択肢しか出していないのに別の値が来たら、それは UI のバグである。

項目の定義:

```typescript
{
  key: "mode",
  label: "モード",
  scope: "global",
  control: {
    kind: "select",
    options: [
      { value: "simple", label: "シンプル (1 区間を切り抜く)" },
      { value: "edit", label: "エディット (複数区間を結合する)" },
    ],
  },
  hint: () => "モードを変えると作りかけの区間は消えます",
  toText: (settings) => settings.mode,
  fromText: (text) => parseMode(text),
}
```

### 1.2 モードを変えたら作りかけの区間は全部消す

エディット (2 区間) からシンプルへ戻したとき、先頭だけ残すような半端な
引き継ぎは**何が消えたのか分からない**。`RESET_MARKS` を投げて `idle` に
戻す。hint に明記してあるので不意打ちにはならない。

**捨ててよい状態になるまで切り替えを待たせる。** 区間を捨てられるのは
`idle` か `ready` のときだけである。

- **録画中** (`BUSY_KINDS`) に変えると、状態機械だけが `idle` に戻り、録画が
  走り続けて取り残される
- **録画済みクリップを持つ状態** (`preview` / `posted` / `degraded`) で変えると、
  実時間を払った成果物への参照ごと失う。`degraded` は X への添付に失敗して
  やり直しを待っている状態なので、ここで捨てるのは特に痛い

**入力欄を `disabled` にする案は採らない。** 設定パネルはバーの中にあり、
開いたまま録画を始められる。開いた時点でしか無効化できないので、結局すり抜ける。

代わりに、切り替えを `pendingMode` として覚えておき、状態が `idle` か `ready` に
落ち着いた時点で適用する。**その場で捨てない。** `chrome.storage.onChanged` は
次に設定を保存するまで来ないので、捨てると「設定はエディットなのにタブは
シンプルのまま、開き直すまで直らない」状態ができる。

---

## 2. データモデル

### 2.1 `range` を `segments` に置き換える

いまは全状態が `range: ClipRange` を 1 つ持っている。これを配列にする。

```typescript
| { kind: "ready"; segments: ClipRange[]; meta: VideoMeta }
| { kind: "recording"; segments: ClipRange[]; meta: VideoMeta }
// ... 以下同様。preview / posted / composing / degraded / failed も同じ
```

**新しい型は作らない。** `ClipRange` は `{ startSec, endSec }` であり、区間として
そのまま使える。`ClipSegment` を別に定義しても中身が同じ型が 2 つ増えるだけで、
`range-bar` との受け渡しで変換が要るようになる。

**シンプルモードは「`segments` の長さが常に 1」という不変条件**で表す。
モードごとに状態型を分けない。分けると `recording` / `encoding` / `preview` 以下
すべてが二重になり、router も popup も両方を知ることになる。

**`range` と `segments` を両方持たせる案は採らない。** どちらが真かが状態ごとに
変わり、同期漏れが必ず出る。一度で置き換える。影響範囲:

| ファイル | 変更 |
|---|---|
| `shared/types.ts` | 状態とイベントの定義 |
| `background/state.ts` | `reduce` 全体 |
| `background/router.ts` | 状態を組み立てている箇所 |
| `popup/view.ts` | 表示文言 (§5.4) |
| `content/youtube.ts` | 配線 |
| `background/storage.ts` | `StoredClip.range` → `segments` |
| `shared/template.ts` | `renderTemplate` が区間列を受ける |
| 対応するテスト | すべて |

**保存済みクリップも `segments` を持つ。** `StoredClip.range` は投稿本文の URL と
ファイル名の開始秒に使われている。先頭区間の秒で足りるので `range` のままでも
動くが、**2 区間目以降を持たないものを `range` と呼び続けると型が嘘になる**。

IndexedDB に残っている古いクリップは `range` しか持たない。読み出し時に
`[range]` として扱い、理由をログに残す。**黙って落とさない。**

`renderTemplate` の変数はこう変わる。`{duration}` の意味が変わるが、**区間が
1 つなら結果は従来と同じ**である。

| 変数 | 複数区間での値 |
|---|---|
| `{url}` / `{start}` | 先頭区間の `startSec` |
| `{end}` | 最終区間の `endSec` |
| `{duration}` | **合計長** (`totalSec`)。元動画上の幅ではない |

### 2.2 `shared/timeline.ts` を新設する

区間列に対する純粋関数の置き場。**`content/` ではなく `shared/` に置く。**
`reduce` が `normalize` を呼ぶので、background から参照できる必要がある
(`content/range-math.ts` は UI の座標計算なので content のままでよい)。

```typescript
/** 時系列に並べ替え、重なり・隣接を 1 つに繋ぐ */
export function normalize(segments: ClipRange[]): ClipRange[];

/** 合計の長さ (秒)。最大秒数の検証に使う */
export function totalSec(segments: ClipRange[]): number;

/** その秒を含む区間の index。無ければ -1 */
export function indexAt(segments: ClipRange[], sec: number): number;

/** 出力の t 秒が元動画の何秒か。**3 のテロップがここに乗る** */
export function toSourceTime(segments: ClipRange[], outputSec: number): number | null;
```

`toSourceTime` はこの spec では使わない。**それでも今のうちに置く。** 出力
タイムラインという座標系を後から導入すると、テロップの時刻が元動画の秒で
書かれた状態が先に出来上がってしまい、移行が要る。

### 2.3 `normalize` の規則

- **時系列に並べ替える** (`startSec` の昇順)
- **重なった区間は 1 つに繋ぐ** — `1:23→1:38` と `1:30→1:45` は `1:23→1:45`
- **隣接も繋ぐ** — `1:23→1:38` と `1:38→1:45` の間に切れ目はない
- 空配列はそのまま返す

並べ替えを自動にするのは、**録画中のシークが常に前進になる**ため。巻き戻し
シークはバッファの再読み込みが入りやすく、繋ぎ目の品質が落ちる。順序を
ユーザーに委ねる代わりに、繋ぎの確実さを取る。

重なりをエラーにせずマージするのは、拡大バーのドラッグで隣の区間に触れる
たびに手を止めさせないため。**マージは情報を失わない** (拾いたかった範囲は
すべて出力に入る) ので、拒否する理由が弱い。

### 2.4 index のずれを ID で解かない

並べ替えとマージで index が動く。ハンドルをドラッグして区間が隣を追い越すと、
UI が握っている選択 index が別物を指す。

**区間に ID を振る案は採らない。** `ClipRange` をそのまま使えなくなり、
マージのときにどちらの ID を残すかという問いが増える。得られるのは選択の
同定だけで、割に合わない。

代わりに `indexAt` を使う。UI は `reduce` 後の状態に対し、**いま触っていた区間
の開始秒**で index を引き直す。マージで消えた区間を選んでいた場合もマージ先が
返るので、選択が迷子にならない。

---

## 3. 状態機械

### 3.1 状態機械はモードを知らない

`reduce` が知るのは「置き換える」か「足す」かだけ。**モードという概念は
content script に閉じる。** 状態に `mode` を持たせると、モードを変えるたびに
状態遷移が要り、popup と router もモードを知ることになる。

```typescript
| { type: "MARK_IN"; range: ClipRange; meta: VideoMeta }      // 置き換え
| { type: "ADD_SEGMENT"; range: ClipRange; meta: VideoMeta }  // 追加
| { type: "ADJUST_SEGMENT"; index: number; range: ClipRange }
| { type: "MARK_OUT"; index: number; sec: number }
| { type: "REMOVE_SEGMENT"; index: number }
| { type: "RESET_MARKS" }
```

投げ分けは content script が行う。

- **シンプルモード** — IN は常に `MARK_IN`。`index` は常に 0
- **エディットモード** — IN は常に `ADD_SEGMENT`

**`index` は「一覧で選択中の区間」を指す。** `MARK_OUT` と `ADJUST_SEGMENT` の
どちらも、いま拡大バーに出ている区間に対する操作である。選択を持つのは
`segment-list` であり、状態機械は渡された `index` を信じる (§3.3)。

`idle` からの `ADD_SEGMENT` は `MARK_IN` と同じ結果 (`[range]`) になるので、
エディット側に「最初の 1 回だけ MARK_IN」という分岐は要らない。

### 3.2 `normalize` は `reduce` の中で呼ぶ

`segments` を書き換えるすべての遷移で、返す直前に `normalize` を通す。
呼び出し側に任せると、router 経由の経路で漏れたときに不正な `segments` が
状態に入る。**`reduce` は純粋関数のままなので、ここに置いても副作用はない。**

### 3.3 遷移の要点

既存の遷移は `range` を `segments` に読み替えるだけで通る。新しく決めるのは
次の 3 つ。

**`REMOVE_SEGMENT` で空になったら `idle` へ。** 区間が 0 個の `ready` は
録画に進めない死に状態なので作らない。

**`ADD_SEGMENT` は `MARK_IN` と同じ広さで受ける。** つまり `BUSY_KINDS`
(`seeking` / `recording` / `encoding`) 以外のすべてから受け、結果は `ready` に
なる。`idle` からは `MARK_IN` と同じ結果 (`[range]`) になり、クリップを持つ
状態 (`preview` / `posted` / `degraded`) からはクリップが外れる。既存の
`ADJUST_SEGMENT` / `MARK_OUT` と同じ理由で、**区間を変えたらクリップは外す**。
画面に出ている区間と投稿される中身が食い違うのを防ぐ。

**別の動画の区間は混ぜない。** SPA 遷移で動画が変わってから足すと、B の映像を
A の秒で切ったクリップに A のタイトルと URL が付く。`event.meta.videoId` が
いまの `meta` と違えば、足さずに `[event.range]` で作り直す (`MARK_IN` と同じ
結果)。**これは content script 側のガードに頼らない。** 状態機械が最後の砦になる。

**`index` が範囲外なら `invalid`。** UI のバグを握り潰さない。既存の
`internal-error` に倒す。

**`failed` からの `RETRY` は `segments.length === 0` で分岐する。** いまは
`state.range === null` を見て `idle` か `ready` かを決めている。配列になると
`null` ではなく空配列が「区間を作る前に落ちた」を表す。**`segments` を
nullable のまま残さない。** 空配列と `null` の両方が「区間なし」を意味する
状態を作ると、判定が 2 通りに割れる。

**合計が最大秒数を超えていても `ADD_SEGMENT` は通す。** 追加してから前の区間を
縮める編集順は自然であり、拒否すると「先に縮めてから追加」を強制することに
なる。超過は録画に進めないことで示す (§4.7、§5.2)。

---

## 4. 録画

### 4.1 1 本の録画セッションを pause/resume で繋ぐ

`MediaRecorder` を区間ごとに止めない。1 本のセッションを走らせたまま、
区間の間だけ `pause()` し、シークが終わったら `resume()` する。`MediaRecorder`
は pause 中の時間をタイムラインから除くので、出力は継ぎ目のない 1 本になる。

```
元動画  0:00 ────────[1:23━━━1:45]──────[4:02━━4:10]──── 8:30
                       ↓ 録画          ↓ 録画
recorder   start ━━━━━━━━━━━ pause ‥‥‥‥ resume ━━━━ stop
                                  ↑
                          シーク中。録画には入らない

出力     0:00 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 0:30
```

**区間ごとに別 Blob を録って後で繋ぐ案は採らない。** MP4 の結合はサブ
プロジェクト 2 の仕事であり、それを待つと 1 が単独でリリースできなくなる。

`RecorderHandle` に 2 つ足すだけで、`recorder.ts` の構造は変えない。
ストリームも `AudioContext` も 1 セッションの間だけ生きる。

```typescript
export type RecorderHandle = {
  pause(): void;
  resume(): void;
  stop(): Promise<Blob>;
};
```

### 4.2 手順

```
1. 事前検査 (codec / DRM / 広告 / 合計長)
2. seek(segments[0].startSec) → play
3. recorder = startRecording()
4. for i in 0..n-1:
     await onReachTime(segments[i].endSec)
     if i == n-1: break
     recorder.pause()
     seek(segments[i+1].startSec)
     await 再生が整うまで待つ (§4.3)
     広告検査 (§4.4)
     recorder.resume()
5. blob = await recorder.stop()
```

### 4.3 `resume()` を呼ぶ条件を厳しくする

**シーク完了だけでは足りない。** `seeked` の直後はデコードが追いつかず、
前のフレームや乱れたフレームが残っていることがある。ここを雑にすると、
繋ぎ目に前の場面が数フレーム混入する。

次の順で待ってから `resume()` する。

1. `seeked` が来る
2. `playing` が来る (`paused === false`)
3. `requestVideoFrameCallback` が 1 回発火する = 新しいフレームが出た

3 は `HTMLVideoElement.requestVideoFrameCallback` を使う。Chrome では使える。
**取れない環境ではフォールバックしない。** この拡張は Chrome 専用であり、
取れないなら繋ぎ目の品質を保証できないので、`internal-error` で落とす。

待ち時間には上限を置く (`SEGMENT_SEEK_TIMEOUT_MS`)。超えたら
`FAIL("seek-failed")`。既存の理由をそのまま使える。

### 4.4 広告の検査を区間ごとに行う

既存の `isAdPlaying()` は録画開始前に 1 回だけ呼ばれている。**区間の間の
シーク後にミッドロールが始まる経路がある。** `resume()` の直前にも検査し、
広告なら `FAIL("ad-playing")` で全体を落とす。

部分的に広告が混ざったクリップを残すより、録り直させる方がましである。
これは「録画中に広告が挟まると中断する」という既存の判断と同じ。

### 4.5 進捗は状態機械に持たせない

「何区間目か」は content script のローカル変数で持ち、バーの status に
「2 / 3 区間目へ移動中」と出すだけにする。状態に持たせると `SEGMENT_DONE` の
ような遷移が増え、popup も router もそれを知る必要が出る。**得られるのは
popup の進捗表示だけ**で、割に合わない。

**区間の間のシーク中も状態は `recording` のまま。** `seeking` に戻すと、
その状態での `CANCEL_RECORDING` の意味 (録画セッションがまだ無い) が変わる。

### 4.6 中止

既存のまま。`CANCEL_RECORDING` で `ready` に戻り、content script は
「`recording` から外れた」ことを見て録画を止める。**pause 中でも `stop()` は
呼べる**ので、区間の間で中止しても止まる。

### 4.7 検証と上限

| 対象 | 規則 | 破ったとき |
|---|---|---|
| 合計長 | `totalSec(segments) <= maxClipSec` | 録画に進めない。バーに文言 |
| 各区間 | `MIN_CLIP_SEC` 以上 | 拡大バーがそれ以上縮まない |
| 区間の数 | **上限を設けない** | — |

合計長で見る。**個々の区間ではない。** 区間ごとに上限を見ると、10 秒の区間を
10 個作れてしまい、X の上限を超えたクリップができる。

区間数の上限を設けないのは、合計長の制約で実質的に縛られるため。別の上限を
足すと、「合計は足りているのに追加できない」という説明のいる状態が増える。

---

## 5. UI

### 5.1 `range-bar.ts` は複数対応させない

「選択中の区間 1 つを編集する道具」として据え置く。入出力は今まで通り
`ClipRange`。複数を 1 つのバーに詰め込むと、ハンドルの当たり判定と重なりの
解決がバーの中に流れ込み、いま素直な 264 行が読めなくなる。

### 5.2 `content/segment-list.ts` を新設する

一覧の DOM と選択状態だけを持ち、`range-bar` の対象を切り替える。

```
┌────────────────────────────────────────────┐
│ 1. 1:23 〜 1:45 (22秒)   [▶] [✕]           │ ← 選択中は強調
│ 2. 4:02 〜 4:10 ( 8秒)   [▶] [✕]           │
│                           合計 30秒 / 60秒  │
│ ══════█████████════════════════════════════ │ ← 選択中の区間の拡大バー
│ ＋ 区間を追加   IN  OUT   ▶ 区間を見る      │
│ ● 録画    ■ 中止                    ⚙      │
└────────────────────────────────────────────┘
```

**IN と「区間を追加」は別のボタンにする。** IN を「区間を追加」に置き換える案は
採らない。**OUT があるのに IN が無い状態になり、一度作った区間の開始位置を
詰められなくなる。** 「IN で頭を決めて OUT で尻を決める」という操作の型は
シンプルモードで身についているので、エディットでだけ片方が消えると戸惑う。

3 つのボタンはこう対応する。

| ボタン | 送るイベント | 対象 |
|---|---|---|
| ＋ 区間を追加 | `ADD_SEGMENT` | 新しい区間 |
| IN | `ADJUST_SEGMENT` | **選択中**の区間の開始 |
| OUT | `MARK_OUT` | **選択中**の区間の終了 |

**IN は専用イベントを持たない。** `ADJUST_SEGMENT`(= 拡大バーのドラッグと
同じ) で「開始だけを今の位置にした範囲」を送る。状態機械に `MARK_IN` の
index 付き版を足すこともできるが、`ADJUST_SEGMENT` が既に「この区間をこの
範囲にする」を表せているので、同じことをする経路を 2 本持つ理由がない。

**区間が 1 つも無いとき、IN と OUT は何もしない。** 「先に区間を追加して
ください」と出す。最初の 1 つは「＋ 区間を追加」で作る。

**開始を動かすと並び替えが起きうる。** 区間 2 の開始を区間 1 より前へ動かせば
順序が入れ替わる。選択は `selectionAnchorSec` に新しい開始秒を入れて追う
(§2.4 と同じ仕掛け)。

**選択は一覧ではなく `youtube.ts` が持つ。** 選択とは「拡大バーがいま何を
編集しているか」と同じものであり、拡大バーを持っているのは `youtube.ts` で
ある。両方に置くと同期が要る。

合計が `maxClipSec` を超えたら表示を警告色にし、録画ボタンを `disabled` に
する。

**`youtube.ts` には配線しか足さない。** 既に 935 行あり、ここに UI を足すと
読めなくなる。ただしファイル全体の分割は今回のゴールと関係ないので混ぜない。

### 5.3 全区間の通し再生は作らない

一見あった方がよいが、**通し再生も録画も同じシーケンス** (シークしながら
実時間で再生する) である。確認に 30 秒払って、録画でもう 30 秒払うことになる。
**録画そのものが通し再生を兼ねている。** 個別区間の `▶` だけ残す。

### 5.4 オーバーレイと popup

プレイヤーのシークバー上の範囲オーバーレイ (`paintOverlay` /
`refreshOverlay`) は複数区間を塗れるようにする。素直な拡張。

popup は状態を映すだけという役割を保つ。`segments` を読んで区間数と合計を
出す (例: `2 区間 / 30 秒`)。**ボタンは持たない。** 区間が 1 つのときは
今まで通りの文言にする。

---

## 6. エラー

新しい失敗理由は**足さない**。起きうる失敗は既存の理由で表せる。

| 起きること | 理由 | 文言 (既存) |
|---|---|---|
| 区間の間のシークが終わらない | `seek-failed` | 開始位置へ移動できませんでした |
| シーク後に広告が始まった | `ad-playing` | 広告の再生中です。終了後にやり直してください |
| `index` が範囲外 | `internal-error` | 内部エラーが発生しました |
| `requestVideoFrameCallback` が無い | `internal-error` | 内部エラーが発生しました |

合計長の超過は失敗状態にしない。**録画を始めさせないだけ**で、既存の
`validateRange` と同じ扱いにする。範囲を直せば進める。

Fail Fast を守る。`normalize` が想定外の入力 (負の秒、`endSec <= startSec`) を
受けたら、黙って直さず throw する。**これは UI のバグであり、握り潰すと
録画に実時間を払った後で気付くことになる。**

---

## 7. テスト

### 7.1 単体 (`vitest`)

| 対象 | 見るところ |
|---|---|
| `shared/timeline.ts` | `normalize` の並べ替え・重なり・隣接・空配列。`totalSec`。`indexAt` の境界と不一致 (-1)。`toSourceTime` の区間跨ぎと範囲外 (null) |
| `background/state.ts` | `ADD_SEGMENT` / `REMOVE_SEGMENT` / `ADJUST_SEGMENT` / `MARK_OUT` の遷移。空になったら `idle`。`posted` からの `ADD_SEGMENT` でクリップが外れる。`index` 範囲外で `internal-error` |
| `shared/settings.ts` | `mode` の既定値。`mergeSettings` が不正な `mode` を既定に倒して warn する。`parseMode` |
| `content/settings-panel.ts` | `control.kind === "select"` の項目が `<select>` として出る。既存の text 項目が壊れていない |
| `content/segment-list.ts` | 一覧の描画、選択の切り替え、合計超過時に録画が `disabled` |
| `content/recorder.ts` | `pause()` / `resume()` が `MediaRecorder` に委譲される。pause 中の `stop()` |

`normalize` は性質が単純なので、**境界を列挙したテーブル駆動**で書く。

### 7.2 E2E (`playwright`)

**今回は E2E を足さない。** 当初は次の 3 つを実 YouTube で確認するつもりだった。

- エディットモードで IN を 2 回押すと一覧に 2 行出る
- 合計が最大秒数を超えると録画ボタンが押せない
- モードをシンプルに戻すと一覧が消え、区間も消える

いずれも jsdom の単体テストで同じことを固定できており (`tests/content/youtube.test.ts`
の「エディットモード」節)、E2E で増えるのは「実 YouTube の DOM に載るか」だけで
ある。それは既存の `e2e/smoke.spec.ts` がバーの生成を見ているので、モード固有の
E2E を足しても得られるものが薄い。

**繋ぎ目の品質は E2E でも見られない。** フレーム単位の確認は自動化に見合わない
ので、手動確認 (`docs/manual-check.md`) に回す。**ここがこの機能の唯一の砦**で
あり、E2E を足してもその事実は変わらない。

---

## 8. 手動確認

`docs/manual-check.md` に追加する。

- [ ] 2 区間 (各 5 秒) を録って、**出力が 10 秒ちょうど**になる
- [ ] 繋ぎ目で**前の場面のフレームが混入していない**
- [ ] 繋ぎ目で**音がずれていない / 途切れ方が不自然でない**
- [ ] 3 区間以上でも同じ
- [ ] 区間の間のシーク中に status が「2 / 3 区間目へ移動中」を出す
- [ ] 区間の間で中止できる
- [ ] 合計が最大秒数を超えると録画に進めない
- [ ] 重なる区間を作るとマージされ、選択が迷子にならない
- [ ] モードを変えると区間が消える。録画中は変えられない
- [ ] 結合したクリップが X に添付できる

---

## 9. 未検証の前提とフォールバック

この設計には**未検証の前提が 1 つ**ある。

> **`pause()` / `resume()` をまたいだタイムスタンプが、Chrome の MP4 出力で
> 本当に連続するか。**

仕様の意図はそうだが、実装がどう振る舞うかは動かさないと分からない。ここが
崩れると、繋ぎ目で音がずれるか、再生時間が実際より長い MP4 が出る。

**実装の最初のタスクをこの検証にする。**

```
2 区間 × 各 3 秒を録り、出力が 6 秒ちょうどで音ズレがないことを確認する
```

通らなかった場合は、区間ごとに別 Blob を録り、サブプロジェクト 2 の結合を
待つ設計に倒す。**その場合サブプロジェクト 1 は単独でリリースできなくなる**
ので、2 の spec を先に書くことになる。

§1〜§3 (設定・データモデル・状態機械) と §5 (UI) はこの前提に依存しない。
影響を受けるのは §4 だけである。

### 9.1 検証結果 (2026-09-23)

実機 (Chrome / YouTube) で 2 区間 × 各 3 秒を録り、次の結果を得た。

| 見たところ | 結果 |
|---|---|
| 出力の長さ | **6.005633 秒** (期待 6 秒)。pause 中も記録されていれば 12 秒近くなる |
| ファイルサイズ | 2,136,577 バイト |
| 繋ぎ目の映像 | 前の場面の混入は確認できなかった |
| 繋ぎ目の音 | 目立つズレは確認できなかった |

**`pause()` / `resume()` がタイムラインから除外されていることが確認できた。
この設計のまま進める。**

なお繋ぎ目の確認では、`seeked` の後に `requestVideoFrameCallback` を 1 回
待ってから `resume()` している (§4.3 の手順どおり)。**この待ちを外した場合に
混入するかまでは試していない**ので、`waitForFreshFrame` が実際に効いているのか、
無くても問題ないのかは分かっていない。外して確かめる価値は薄いと判断した
(待つコストはミリ秒で、外して得られるものが無い)。
