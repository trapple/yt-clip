# 詰める欄 (段階 1c-1) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** バーの窓の拡大バーを「詰める欄」にする。選んだ区間の前後 2 秒だけを映し、‹ › で区間を切り替え、ハンドルは単語の切れ目に吸い付き (Alt で吸い付かない)、頭と尻を −0.1 / ＋0.1 (キーは `,` `.`) で詰め、繋ぎ目だけを聞き直せる (▶ 頭の 2 秒前から / ▶ 尻をまたいで)。

**Architecture:** 拡大バー (`range-bar.ts`) はそのまま詰める欄の芯に使う。窓の決め方を「区間の前後 2 秒」(`computeTrimWindow`) に替え、ドラッグ中に吸い付き先へ寄せる (`snapSec`)。詰める欄の見出し・単語の並び・詰める操作の行は新しい `trim-panel.ts` が持ち、拡大バーとテロップの帯の要素を中に抱える。単語の取り出しと吸い付き先は純粋関数 (`trim-words.ts`)。`youtube.ts` は ‹ ›・±0.1・繋ぎ目の再生を既存の経路 (選択の反映・`ADJUST_SEGMENT`・範囲の再生) に繋ぐ。

**Tech Stack:** TypeScript、vitest (jsdom)、Playwright (e2e の窓の数字を直す)

## 段階 1c の分け方 (2026-11-03 回答「詰める欄 → 撤去 → 検索 (推奨)」)

| | 中身 | 状態 |
|---|---|---|
| **1c-1 (この plan)** | 詰める欄 (前後 2 秒の窓・‹ ›・吸い付き・±0.1 と `,` `.`・繋ぎ目の再生) | |
| 1c-2 | 区間とテロップの一覧・帯・`RESET_MARKS` の撤去、欄の区間の見出し (「区間 2 · 詰めている」)、文字起こしが無いときの道 (欄に手入力の行。ADR 0003) | |
| 1c-3 | 欄の検索、残った持ち越しの不具合 | |

**波形は段階 2。** この plan の詰める欄は単語の並びとハンドルだけ。吸い付き先も単語の切れ目だけ (無音への吸い付きは波形と一緒に段階 2)。

**区間とテロップの一覧・帯・IN / OUT・＋ 区間を追加・▶ 区間を見る は、この plan では残す。** 帯は詰める欄の中 (拡大バーの直下) に移るだけで、窓が前後 2 秒になるぶん動かせる範囲が狭くなる (1c-2 で撤去するので直さない)。

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- ADR 0001 (`docs/adr/0001-transcript-first-editor.md`) の Decision: 「選んだ区間はプレイヤーの下の「詰める欄」で、波形と単語を見ながら頭と尻を詰める」
- 第 2 版のモック (artifact `c2a6c8ad-fb19-4f7b-a655-be4d05c9abaf`、2026-10-25 了承) の詰める欄:
  - 「選んだ区間の前後 2 秒まで見せる。外側は薄く、端のハンドルで出し入れする」
  - 「ハンドルは単語の切れ目と無音に吸い付く。Alt を押している間は吸い付かない」(無音は段階 2)
  - 「−0.1 / ＋0.1 は頭と尻それぞれ。キーは `,` `.` で選んでいる端を動かす」
  - 「「頭の 2 秒前から」「尻をまたいで」で、繋ぎ目だけを聞き直せる」
  - 「今の拡大バーの役目はここが引き継ぐ。全体の中の位置は YouTube のシークバーの帯で見る」
  - 見出し: 「区間 2 を詰める」「12:21.40 – 12:29.80 · 8.4 秒」「‹ 区間 1」「区間 3 ›」
- 回答 2026-11-03: 1c は「詰める欄 → 撤去 → 検索」の順。手入力のテロップは「欄に手入力の行を足す」(1c-2 で作る。この plan では ADR 0003 に記録するだけ)
- 区間の長さ: 1 秒 (`MIN_CLIP_SEC`) 以上・1 区間は上限 (`maxClipSec`、既定 60 秒) 以下 (今の拡大バーと同じ `clampHandle` の規則)
- 行と単語の文字は信用できない入力: DOM には `textContent` でだけ入れる (1a の whole-branch review)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- 先にドキュメントを直してからコードに着手する (Task 1 が文書)
- git は `git -C <dir> ...`、gh は `gh ... -R trapple/yt-clip`
- Fail Fast。範囲の計算は不正な入力を `RangeError` で投げる (今の `range-math.ts` の作法)
- コメントとコミットメッセージは日本語、Conventional Commits + Why の本文
- コミットは署名される。署名で失敗したら、署名を外さずにユーザーに伝えて止まる
- 外部プロセスにはタイムアウトを付ける (`npx vitest run` は Bash の timeout 300000、e2e は 600000)

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous (根拠: Auto Mode 既定。設計の分かれ目 2 つは AskUserQuestion で回答済み)
- 隔離: branch。`feat/trim-panel` (develop から切った。PR は develop へ)
- 実装方式: B (branch + 直列)
- 既知の失敗: `e2e/smoke.spec.ts` の「オフにすると 1 秒以内…」は `expect(extensionLogs).toEqual([])` (312 行付近) で落ちる。それ以外で落ちたらこの plan の不具合

---

## ファイル構造

| ファイル | 種別 | 責務 |
|---|---|---|
| `docs/adr/0003-manual-telop-as-transcript-row.md` | Create | 手入力のテロップは欄の行にする (1c-2 で作る決定の記録) |
| `README.md` / `docs/manual-check.md` / `CHANGELOG.md` | Modify | 詰める欄の使い方と制約 |
| `src/shared/time.ts` | Modify | `formatTimeCentis` (100 分の 1 秒まで出す) |
| `src/content/range-math.ts` | Modify | `computeWindow` → `computeTrimWindow` (前後 2 秒)、`snapSec`、`nudgeRange` |
| `src/content/trim-words.ts` | Create | 窓に入る単語・吸い付き先 (純粋関数) |
| `src/content/range-bar.ts` | Modify | 前後 2 秒の窓、ドラッグ中の吸い付き、掴んだ端を知らせる |
| `src/content/trim-panel.ts` | Create | 詰める欄の見出し・単語の並び・詰める操作・キー |
| `src/content/styles.ts` | Modify | `TRIM_STYLE` |
| `src/content/youtube.ts` | Modify | 詰める欄を組み込む (‹ ›・±0.1・繋ぎ目の再生・吸い付き先・確定で窓を取り直す) |
| `tests/...` / `e2e/telop-check.spec.ts` | Create / Modify | 各モジュールのテスト、窓が前後 2 秒になったことによる数字の直し |

---

### Task 1: 文書

**Files:**
- Create: `docs/adr/0003-manual-telop-as-transcript-row.md`
- Modify: `README.md`、`docs/manual-check.md`、`CHANGELOG.md`

- [ ] **Step 1: ADR 0003 を書く**

`docs/adr/0003-manual-telop-as-transcript-row.md`:

```markdown
# 0003. 手入力のテロップは文字起こしの欄の行にする

- 状態: 採用 (2026-11-03)
- 補うもの: ADR 0001 の Consequences「喋りの無い動画のために、時間で区間を作る道とテロップを手で足す道を脇に残す」

## Context

段階 1c-2 で区間の一覧とテロップの一覧を外す。外した後も、字幕の無い動画や、欄の行に無い文言 (補足・ツッコミ) の
テロップを足す道が要る。

## Decision

- 文字起こしの欄に「＋ ここに字幕を足す」を置き、今の再生位置に手入力の行を作る。行は字幕の行と同じ並びに入り、
  ✎ で文字を直し、時刻は詰める欄で直す (回答 2026-11-03「欄に手入力の行を足す (推奨)」)
- 区間は IN / OUT と ＋ 区間を追加で作る (時間で区間を作る道)

## Considered Options

- 詰める欄にテロップの帯を置き、＋ テロップもそこに置く: 今の帯の制約 (2 段まで・+N・窓の中だけ) が残る
- 1c-2 の計画のときに決める: 一覧を外す前に置き場所を決めておかないと、1c-1 の詰める欄の作りが決まらない

## Consequences

- テロップの置き場所が欄の 1 か所にまとまる。手入力のテロップも ✎・字幕に出さない・▶ が字幕の行と同じになる
- 手入力の行は文字起こしを取り直しても消えない形で持つ必要がある (1c-2 で決める)
```

- [ ] **Step 2: README を直す**

`README.md` の冒頭の説明「視聴中に IN を押すと既定 15 秒の範囲ができ、拡大バーで調整してから録画すると、」→「視聴中に IN を押すと既定 15 秒の範囲ができ、詰める欄で調整してから録画すると、」

「使い方」の 2:

```markdown
2. プレイヤー下の **詰める欄** でハンドルをドラッグして範囲を調整する (区間の前後 2 秒が見える)。
   トラックを押すとその位置から再生でき、**▶ 区間を見る** で通しの確認もできる
```

「使い方」の窓の説明の 1 文目「IN / OUT・録画のボタンと拡大バー (以下「バー」)、区間とテロップの一覧は、」→「IN / OUT・録画のボタンと詰める欄 (以下まとめて「バー」)、区間とテロップの一覧は、」

「## 文字起こしの欄」の直後 (「## 複数の場面を繋ぐ」の前) に節を足す:

```markdown
## 詰める欄

バーの上の方が「詰める欄」になる。選んでいる区間 (文字起こしの欄で押した行の区間、または区間の一覧で選んだ区間) の
前後 2 秒までを映し、頭と尻を細かく詰める。

- **見出しの行** — 「区間 2 を詰める」と、区間の頭と尻 (100 分の 1 秒まで)・長さ・全区間の合計。**‹ 区間 1 / 区間 3 ›** で前後の
  区間へ移る。詰める操作 (下の ±0.1 と ▶) も同じ行にある
- **ハンドル** — ドラッグで頭と尻を動かす。**文字起こしの単語の切れ目に吸い付く** (近くに切れ目があるとき)。**Alt を押している間は
  吸い付かない**。手を離すと、新しい区間の前後 2 秒を映し直す (もっと伸ばしたいときは、もう一度端まで引く)
- **単語の並び** — トラックの下に、映している範囲の単語を並べる (区間の外の単語は点線)。自動字幕は単語ごと、手動字幕は行ごと
- **頭 −0.1 / ＋0.1・尻 −0.1 / ＋0.1** — 0.1 秒ずつ動かし、動かした端の映像を出す。**キーは `,` (−0.1) と `.` (＋0.1)** で、最後に
  掴んだ (または ±0.1 を押した) 端を動かす。はじめは頭。キーで動く方の「頭」「尻」に下線が付く。キーが効くのは詰める欄を
  触った後だけ (YouTube の `,` `.` (コマ送り) と取り合わないため)
- **▶ 頭** — 頭の 2 秒前から頭の 2 秒後まで再生して止める。**▶ 尻** — 尻の 2 秒前から尻の 2 秒後まで再生して止める (切り落とした
  所も聞こえる)

録画中と、録画した後のプレビューの間は、詰める欄は薄く出て動かせない。
```

「### テロップ」の段落「区間を選ぶと、その区間の拡大バーの範囲に入るテロップが、拡大バーの下に帯で出る」はそのまま (1c-2 で撤去)。

「### テロップの制約」の「**帯は拡大バーの範囲の中でだけ動かせる**。」の項の末尾に 1 文足す: 「拡大バー (詰める欄) は区間の前後 2 秒しか映さないので、帯で動かせるのもその中だけ。」

「### 操作の置き場所」の「拡大バーは幅がそのまま精度になるため、一覧の窓の幅には縮めない」はそのまま。

「### 操作の置き場所」の「…バーに見出しの行を付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を
覆うため」(窓を掴む見出しの話) の後に、同じ項の続きとして足す:

「詰める欄も、見出しと詰める操作を 1 行にまとめて背を抑えている。それでも **1440x795 では、浮かせたバーがプレイヤーの下端に
重なり、ページの中のバーは画面の下にはみ出すことがある** (ページの中ならスクロールで届く。帯の段を文字起こしの欄に置き換えて
外すときに見直す)。」

- [ ] **Step 3: manual-check を直す**

`docs/manual-check.md` の 1440x795 の高さを求める既存の項目を、新しい制約に合わせて書き換える (詰める欄の見出しの行と単語の段の
ぶんバーが高くなり、ページの中のバーも画面の下にはみ出しうる):

- 164 行付近「…1440x795 でもバーの窓がプレイヤーに重ならず画面に収まる」→「…1440x795 では、浮かせたバーがプレイヤーの下端に
  重なる高さ・ページの中のバーが画面の下にはみ出す高さを測って記録する (詰める欄の行のぶん。1c-2 で帯を外した後に見直す)」
- 420 行付近「…ページの先頭でプレイヤーの下のバーが画面に収まり、」→「…ページの先頭でプレイヤーの下のバーの操作の行まで
  スクロールで届き (はみ出した px を記録する)、」
- 441 行付近「1440x795 でページの先頭のとき、画面に収まる。」→「1440x795 でページの先頭のとき、はみ出した px を記録する。」

(行番号は目安。文言で探す)

続けて、「文字起こしの欄」の節の後に節を足す (見出しの深さは周りの節に合わせる):

```markdown
### 詰める欄

- [ ] 欄で行を押すと、詰める欄の見出しが「区間 N を詰める」になり、区間の前後 2 秒が映る
- [ ] ‹ 区間 N / 区間 N › で区間を移ると、見出し・映す範囲・単語の並びが変わる。端の区間では先が押せない
- [ ] 自動字幕の動画でハンドルを単語の切れ目の近くへ動かすと吸い付く。Alt を押しながらだと吸い付かない
- [ ] 手を離すと、新しい区間の前後 2 秒を映し直す
- [ ] 頭 ＋0.1 を押すと頭が 0.1 秒動き、その位置の映像が出る。見出しの時刻も変わる
- [ ] ハンドル (尻) を掴んだ後に `.` を押すと尻が 0.1 秒伸びる。「尻」に下線が付いている。YouTube のコマ送りは起きない
- [ ] 動画を押してから `,` を押すと、YouTube のコマ送りになる (詰める欄は動かない)
- [ ] ▶ 頭: 頭の 2 秒前から再生し、頭の 2 秒後で止まる
- [ ] ▶ 尻: 尻の 2 秒前から再生し、尻の 2 秒後で止まる
- [ ] 1440x795 で、ページの中のバーの見出しの行が 1 行に収まる (幅を最小の 480px にした浮いた窓では折り返してよい)
- [ ] 録画中は詰める欄が薄く、ボタンもキーも効かない
- [ ] 手動字幕の動画では、単語の並びが行ごとになる。字幕の無い動画では単語の並びが出ず、吸い付かない
```

- [ ] **Step 4: CHANGELOG を直す**

`CHANGELOG.md` の `## 未リリース` の節の末尾に、既存の段落と同じ「太字の書き出し」の形で足す (見出しは増やさない):

```markdown
**プレイヤーの下の拡大バーを「詰める欄」にした。** 区間の前後 2 秒を映し、‹ › で区間を移り、ハンドルは単語の切れ目に
吸い付く (Alt で吸い付かない)。頭と尻を 0.1 秒ずつ詰められ (キーは `,` `.`)、繋ぎ目だけを聞き直せる。
```

- [ ] **Step 5: commit**

```bash
git -C . add docs/adr/0003-manual-telop-as-transcript-row.md README.md docs/manual-check.md CHANGELOG.md
git -C . commit -m "docs: 詰める欄の使い方と、手入力のテロップを欄の行にする決定を書く

拡大バーを詰める欄にする前に、使い方と制約 (前後 2 秒・吸い付き・キーの効く範囲) を決めておく。
手入力の道は 1c-2 で作るが、一覧を外す前に置き場所を決めておかないと詰める欄の作りが決まらないので ADR に残す"
```

---

### Task 2: 窓・吸い付き・±0.1 の計算

**Files:**
- Modify: `src/shared/time.ts`、`src/content/range-math.ts`
- Create: `src/content/trim-words.ts`
- Test: `tests/shared/time.test.ts`、`tests/content/range-math.test.ts`、`tests/content/trim-words.test.ts`

**Interfaces:**
- Produces:
  - `formatTimeCentis(sec: number): string` — `"12:21.40"` の形 (100 分の 1 秒に丸める)
  - `TRIM_MARGIN_SEC = 2`、`computeTrimWindow(range: ClipRange, videoDurationSec: number): TimeWindow`
  - `NUDGE_SEC = 0.1`、`nudgeRange(kind: HandleKind, deltaSec: number, range: ClipRange, videoDurationSec: number, maxClipSec: number): ClipRange`
  - `snapSec(sec: number, points: readonly number[], toleranceSec: number): number`
  - `TrimWord = { startSec: number; endSec: number; text: string }`、`wordsInWindow(lines: readonly TranscriptLine[], window: TimeWindow): TrimWord[]`、`snapPointsIn(lines: readonly TranscriptLine[], window: TimeWindow): number[]`
- 消すもの: `computeWindow`、`MIN_WINDOW_SEC` (使っているのは `range-bar.ts` だけ。Task 3 で差し替える。この Task では range-bar.ts の import を `computeTrimWindow` に替えるところまでやる。そうしないと typecheck が落ちる)

- [ ] **Step 1: 失敗するテストを書く (time)**

`tests/shared/time.test.ts` の末尾に足す (import に `formatTimeCentis` を足す):

```ts
describe("formatTimeCentis", () => {
  test("100 分の 1 秒まで出す", () => {
    expect(formatTimeCentis(741.4)).toBe("12:21.40");
    expect(formatTimeCentis(5)).toBe("0:05.00");
    expect(formatTimeCentis(3723.456)).toBe("1:02:03.46");
  });

  test("繰り上がりで秒の桁が 60 にならない", () => {
    // 59.996 を秒と 100 分の 1 で別々に丸めると 0:59.100 や 0:60.00 になる
    expect(formatTimeCentis(59.996)).toBe("1:00.00");
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (range-math)**

`tests/content/range-math.test.ts` の `describe("computeWindow", ...)` を丸ごと消し、import から `MIN_WINDOW_SEC` と `computeWindow` を外して `computeTrimWindow`・`nudgeRange`・`snapSec`・`TRIM_MARGIN_SEC` を足し、次を置く:

```ts
describe("computeTrimWindow", () => {
  test("区間の前後 2 秒を映す", () => {
    expect(computeTrimWindow({ startSec: 100, endSec: 108 }, 600)).toEqual({ startSec: 98, endSec: 110 });
    expect(TRIM_MARGIN_SEC).toBe(2);
  });

  test("動画の頭と終わりで切る", () => {
    expect(computeTrimWindow({ startSec: 1, endSec: 5 }, 600)).toEqual({ startSec: 0, endSec: 7 });
    expect(computeTrimWindow({ startSec: 595, endSec: 599 }, 600)).toEqual({ startSec: 593, endSec: 600 });
  });

  test("動画の長さが区間より短くても (広告の間など) 区間の尻までは映す", () => {
    // 窓が区間より狭いと、ハンドルが窓の外になり描けない
    expect(computeTrimWindow({ startSec: 100, endSec: 108 }, 30)).toEqual({ startSec: 98, endSec: 108 });
  });

  test("逆向きの範囲は投げる", () => {
    expect(() => computeTrimWindow({ startSec: 150, endSec: 100 }, 600)).toThrow(RangeError);
  });
});

describe("nudgeRange", () => {
  const RANGE = { startSec: 10, endSec: 20 };

  test("頭と尻を別々に動かす", () => {
    expect(nudgeRange("in", -0.1, RANGE, 600, 60)).toEqual({ startSec: 9.9, endSec: 20 });
    expect(nudgeRange("out", 0.1, RANGE, 600, 60)).toEqual({ startSec: 10, endSec: 20.1 });
  });

  test("足し算の誤差を残さない (100 分の 1 秒に丸める)", () => {
    let range = RANGE;
    for (let i = 0; i < 3; i += 1) range = nudgeRange("out", 0.1, range, 600, 60);
    expect(range.endSec).toBe(20.3);
  });

  test("動画の頭と終わりを越えない", () => {
    expect(nudgeRange("in", -0.1, { startSec: 0.05, endSec: 5 }, 600, 60)).toEqual({ startSec: 0, endSec: 5 });
    expect(nudgeRange("out", 0.1, { startSec: 590, endSec: 599.95 }, 600, 60)).toEqual({ startSec: 590, endSec: 600 });
  });

  test("1 秒より短くも、上限より長くもしない", () => {
    expect(nudgeRange("in", 0.1, { startSec: 10, endSec: 11 }, 600, 60)).toEqual({ startSec: 10, endSec: 11 });
    expect(nudgeRange("out", 0.1, { startSec: 10, endSec: 70 }, 600, 60)).toEqual({ startSec: 10, endSec: 70 });
  });
});

describe("snapSec", () => {
  test("許す幅の中で一番近い点に寄せる", () => {
    expect(snapSec(10.04, [9, 10, 10.1, 11], 0.08)).toBe(10);
    expect(snapSec(10.07, [9, 10, 10.1, 11], 0.08)).toBe(10.1);
  });

  test("許す幅の外なら動かさない", () => {
    expect(snapSec(10.5, [10, 11], 0.08)).toBe(10.5);
    expect(snapSec(10.5, [], 0.08)).toBe(10.5);
  });
});
```

- [ ] **Step 3: 失敗するテストを書く (trim-words)**

`tests/content/trim-words.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { snapPointsIn, wordsInWindow } from "@/content/trim-words";
import type { TranscriptLine } from "@/shared/transcript";

const ASR: TranscriptLine = {
  id: "youtube-asr:10.00",
  startSec: 10,
  endSec: 13,
  text: "その一手で全部",
  words: [
    { startSec: 10, endSec: 10.6, text: "その" },
    { startSec: 10.6, endSec: 11.8, text: "一手で" },
    { startSec: 11.8, endSec: 13, text: "全部" },
  ],
};
const MANUAL: TranscriptLine = { id: "youtube-manual:20.00", startSec: 20, endSec: 24, text: "会場の声" };

describe("wordsInWindow", () => {
  test("単語を持つ行は単語ごと、持たない行は行ごとに出す", () => {
    expect(wordsInWindow([ASR, MANUAL], { startSec: 0, endSec: 30 }).map((word) => word.text)).toEqual([
      "その",
      "一手で",
      "全部",
      "会場の声",
    ]);
  });

  test("窓に一部でも入るものだけ。端が接するだけのものは入れない", () => {
    expect(wordsInWindow([ASR, MANUAL], { startSec: 11, endSec: 20 }).map((word) => word.text)).toEqual([
      "一手で",
      "全部",
    ]);
  });
});

describe("snapPointsIn", () => {
  test("単語の切れ目 (頭と尻) を重ねずに、時刻の順で返す", () => {
    expect(snapPointsIn([ASR, MANUAL], { startSec: 0, endSec: 30 })).toEqual([10, 10.6, 11.8, 13, 20, 24]);
  });

  test("窓の中の点だけ", () => {
    expect(snapPointsIn([ASR, MANUAL], { startSec: 10.5, endSec: 21 })).toEqual([10.6, 11.8, 13, 20]);
  });
});
```

- [ ] **Step 4: 実行して失敗を確認**

実行: `npx vitest run tests/shared/time.test.ts tests/content/range-math.test.ts tests/content/trim-words.test.ts` (timeout 300000)
期待: FAIL (`formatTimeCentis` / `computeTrimWindow` / `@/content/trim-words` が無い)

- [ ] **Step 5: 実装 (time)**

`src/shared/time.ts` の `formatTime` の後に足す:

```ts
/**
 * 再生位置を 100 分の 1 秒まで出す (m:ss.cc / h:mm:ss.cc)。詰める欄の見出しに使う (0.1 秒ずつ詰めるので、秒までだと
 * 押しても変わって見えない)。**先に 100 分の 1 秒に丸めてから割る** (秒と端数を別々に丸めると 0:60.00 ができる)
 */
export function formatTimeCentis(totalSec: number): string {
  assertPlayableSeconds(totalSec, "再生位置");
  const centis = Math.round(totalSec * 100);
  const whole = Math.floor(centis / 100);
  const fraction = String(centis % 100).padStart(2, "0");
  return `${formatTime(whole)}.${fraction}`;
}
```

- [ ] **Step 6: 実装 (range-math)**

`src/content/range-math.ts`:

1. import を `import { round2 } from "@/shared/transcript";` を足した形にする (`DEFAULT_MAX_CLIP_SEC, MIN_CLIP_SEC` はそのまま)。
2. `MIN_WINDOW_SEC` の定義と doc コメント、`computeWindow` 関数と doc コメント、`fitWithin` 関数を消す (`fitWithin` は `computeWindow` だけが使う)。
3. `makeDefaultRange` の後に足す:

```ts
/** 詰める欄が区間の前後に映す幅 (秒。第 2 版のモック「前後 2 秒まで見せる」) */
export const TRIM_MARGIN_SEC = 2;

/**
 * 詰める欄が映す時間帯。区間の前後 2 秒で、動画の頭と終わりで切る。
 *
 * **区間の尻より手前では切らない。** 広告の間は video.duration が広告の長さになり、区間より短いことがある。
 * 窓が区間より狭いとハンドルが窓の外になる (描く場所が無い)
 */
export function computeTrimWindow(range: ClipRange, videoDurationSec: number): TimeWindow {
  assertRange(range);
  assertSeconds(videoDurationSec, "動画の長さ");
  return {
    startSec: Math.max(0, range.startSec - TRIM_MARGIN_SEC),
    endSec: Math.max(range.endSec, Math.min(videoDurationSec, range.endSec + TRIM_MARGIN_SEC)),
  };
}

/** 詰める欄の −0.1 / ＋0.1 で動かす幅 (秒) */
export const NUDGE_SEC = 0.1;

/**
 * 頭か尻だけを deltaSec 動かした範囲。動画の頭と終わり・最小の長さ・上限の長さで止める (`clampHandle` と同じ規則。
 * ただし窓では止めない: 窓は確定のたびに映し直す)。100 分の 1 秒に丸める (0.1 を足し続けた誤差を状態機械へ送らない)
 */
export function nudgeRange(
  kind: HandleKind,
  deltaSec: number,
  range: ClipRange,
  videoDurationSec: number,
  maxClipSec: number,
): ClipRange {
  if (!Number.isFinite(deltaSec)) throw new RangeError(`動かす幅が不正です: ${deltaSec}`);
  assertRange(range);
  assertSeconds(videoDurationSec, "動画の長さ");

  if (kind === "in") {
    const lowest = Math.max(0, range.endSec - maxClipSec);
    const highest = range.endSec - MIN_CLIP_SEC;
    const startSec = round2(Math.min(highest, Math.max(lowest, range.startSec + deltaSec)));
    // 既に上限・下限の外にある範囲 (上限を設定で縮めた後など) は、押した向きと逆へ跳ばさない
    if ((deltaSec < 0 && startSec > range.startSec) || (deltaSec > 0 && startSec < range.startSec)) return range;
    return { startSec, endSec: range.endSec };
  }

  const lowest = range.startSec + MIN_CLIP_SEC;
  const highest = Math.min(Math.max(videoDurationSec, range.endSec), range.startSec + maxClipSec);
  const endSec = round2(Math.max(lowest, Math.min(highest, range.endSec + deltaSec)));
  if ((deltaSec < 0 && endSec > range.endSec) || (deltaSec > 0 && endSec < range.endSec)) return range;
  return { startSec: range.startSec, endSec };
}

/**
 * 許す幅 (toleranceSec) の中で一番近い点に寄せる。無ければそのまま。ハンドルを単語の切れ目に吸い付かせる
 * (第 2 版のモック)。点の数は窓の中の単語の数 (数百) なので、並べ替えや二分探索はしない
 */
export function snapSec(sec: number, points: readonly number[], toleranceSec: number): number {
  let best = sec;
  let bestDistance = toleranceSec;
  for (const point of points) {
    const distance = Math.abs(point - sec);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
```

- [ ] **Step 7: 実装 (trim-words)**

`src/content/trim-words.ts`:

```ts
/**
 * 詰める欄に並べる単語と、ハンドルの吸い付き先 (第 2 版のモック)。
 *
 * 単語を持つ行 (自動字幕。段階 4・5 の音声認識も) は単語ごと、持たない行 (手動字幕) は行を 1 つの単語として扱う。
 * 行は時刻の順 (transcript.ts が並べる) だが、ここでは順を前提にしない (窓の中の数百件を舐めるだけ)
 */

import type { TimeWindow } from "@/content/range-math";
import type { TranscriptLine } from "@/shared/transcript";

export type TrimWord = { startSec: number; endSec: number; text: string };

function wordsOf(line: TranscriptLine): TrimWord[] {
  return line.words !== undefined && line.words.length > 0
    ? line.words
    : [{ startSec: line.startSec, endSec: line.endSec, text: line.text }];
}

/** 窓に一部でも入る単語。端が接するだけのものは入れない (テロップの帯の `telopsInWindow` と同じ半開区間) */
export function wordsInWindow(lines: readonly TranscriptLine[], window: TimeWindow): TrimWord[] {
  const words: TrimWord[] = [];
  for (const line of lines) {
    if (line.endSec <= window.startSec || window.endSec <= line.startSec) continue;
    for (const word of wordsOf(line)) {
      if (word.startSec < window.endSec && window.startSec < word.endSec) words.push(word);
    }
  }
  return words;
}

/** 窓の中の単語の切れ目 (頭と尻)。重ねずに時刻の順 */
export function snapPointsIn(lines: readonly TranscriptLine[], window: TimeWindow): number[] {
  const points = new Set<number>();
  for (const word of wordsInWindow(lines, window)) {
    for (const sec of [word.startSec, word.endSec]) {
      if (window.startSec <= sec && sec <= window.endSec) points.add(sec);
    }
  }
  return [...points].sort((a, b) => a - b);
}
```

`wordsInWindow` の 2 つ目のテスト (窓 11〜20) で「会場の声」(20〜24) は接するだけなので入らない。「その」(10〜10.6) は窓の外。

- [ ] **Step 8: range-bar.ts の import を差し替える**

`src/content/range-bar.ts` の import の `computeWindow,` を `computeTrimWindow,` に替え、`update` の中の `computeWindow(nextRange, videoDurationSec)` を `computeTrimWindow(nextRange, videoDurationSec)` に替える (窓が前後 2 秒になる。数字のテストは Task 3 で直す)。

- [ ] **Step 9: 実行して通過を確認**

実行: `npx vitest run tests/shared/time.test.ts tests/content/range-math.test.ts tests/content/trim-words.test.ts` (timeout 300000)
期待: PASS

実行: `npm run typecheck` (timeout 300000)
期待: エラーなし

- [ ] **Step 10: commit**

```bash
git -C . add src/shared/time.ts src/content/range-math.ts src/content/trim-words.ts src/content/range-bar.ts tests/shared/time.test.ts tests/content/range-math.test.ts tests/content/trim-words.test.ts
git -C . commit -m "feat(content): 詰める欄の窓・吸い付き・0.1 秒ずつの計算を足す

モックの「区間の前後 2 秒まで見せる」に合わせて拡大バーの窓を区間の 2 倍・30 秒から前後 2 秒にする。
細かく詰める操作 (±0.1) とハンドルの吸い付き先 (単語の切れ目) は DOM を組まずに境界を確かめたいので純粋関数に切り出す。
この commit では拡大バーと youtube の窓の数字のテストが落ちたまま (Task 3 / Task 5 の commit で直す)"
```

(range-bar と youtube のテストはこの commit の時点で窓の数字が合わず落ちる。Task 3 と Task 5 で直す。commit の前に `npx vitest run tests/shared tests/content/range-math.test.ts tests/content/trim-words.test.ts` だけが通ることを確かめる)

---

### Task 3: 拡大バーの吸い付きと掴んだ端

**Files:**
- Modify: `src/content/range-bar.ts`、`tests/helpers/range-bar.ts`、`src/content/youtube.ts` (仮の `snapPoints` / `onGrab` だけ)
- Test: `tests/content/range-bar.test.ts`

**Interfaces:**
- Consumes: `computeTrimWindow`、`snapSec`、`HandleKind` (Task 2)
- Produces:
  - `RangeBarCallbacks.snapPoints(window: TimeWindow): readonly number[]` — 掴んだときに 1 回だけ引く
  - `RangeBarCallbacks.onGrab(kind: HandleKind): void` — ハンドルを掴んだ (キーで動かす端にする)
  - `SNAP_PX = 8` (export)

- [ ] **Step 1: テストの助けを直す**

`tests/helpers/range-bar.ts`:

- `BarHarness` に `grabbed: HandleKind[]` と `snapPoints: { value: number[] }` を足す (`import type { HandleKind } from "@/content/range-math";`)
- `BarOptions` に `snapPoints?: number[]` を足す
- `mountRangeBar` で `const grabbed: HandleKind[] = []; const snapPoints = { value: options.snapPoints ?? [] };` を作り、`createRangeBar` に `snapPoints: () => snapPoints.value, onGrab: (kind) => grabbed.push(kind),` を渡し、戻り値に `grabbed, snapPoints` を足す
- `dragHandle` に Alt を渡せるようにする:

```ts
export function dragHandle(
  handle: HTMLElement,
  clientX: number,
  fromX = 0,
  altKey = false,
): void {
  pressAt(handle, fromX);
  handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX, altKey }));
}
```

- [ ] **Step 2: 窓の数字のテストを直す**

窓が「範囲の前後 2 秒 (動画の頭と終わりで切る)」になった。`tests/content/range-bar.test.ts` の窓に依るテストを直す。既定の範囲
(`mountRangeBar` の `{ startSec: 30, endSec: 45 }`、動画 600 秒) の窓は 28〜47 (19 秒)。

1. **時刻の表示を見るだけのテストは、期待値を直す。** 例: 「update した範囲と窓が表示に出る」は範囲 100〜130 の窓が 98〜132 になる
   ので、`toContain("1:25")`/`("2:25")` を `toContain("1:38")`/`("2:12")` に、コメントを「窓は範囲の前後 2 秒 (98 〜 132)」に。
   「現在の再生位置」の `makeBar` のコメントを「窓は範囲の前後 2 秒。既定の範囲では 28〜47」に。`setPlayhead(37.5)` で `"50%"` を
   見るテストは窓の中央がそのまま 37.5 なので変えない。窓の外を見るテストは 28 より前・47 より後の値に直す
2. **上限・下限で止まることを見るテストは、期待値ではなく範囲を直す。** 期待値だけ直すと、上限ではなく窓の端で止まるのを見る
   テストに変わってしまう。上限のテスト (`wideBar`、範囲 0〜50・幅 300px) は範囲を `{ startSec: 0, endSec: 59 }` にする (窓は
   0〜61)。「設定した上限までしか伸びない」は上限 20 で「終了 0:20」のまま、「上限を変えれば結果も変わる」は上限 60 で
   「終了 1:00」のまま通る。`wideBar` の doc の「窓より上限を小さく取らないと…」はそのまま
3. ほかに落ちるもの (ドラッグの px と秒の換算) は、テストの意図 (何で止まるか・どこへ動くか) を保って数字を直す

実行: `npx vitest run tests/content/range-bar.test.ts` (timeout 300000) を繰り返し、1〜3 の規則で 1 つずつ直す。

- [ ] **Step 2b: 型が通るように呼び出し側を埋める**

Step 5 で `snapPoints` と `onGrab` を必須にすると、`createRangeBar` を直接呼んでいる 2 か所が型エラーになる。先に埋める:

- `tests/content/range-bar.test.ts` の「update する前は null (幅 0 の窓を軸にさせない)」(195 行付近) の `createRangeBar({...})` に
  `snapPoints: () => [], onGrab: () => undefined,` を足す
- `src/content/youtube.ts` の `buildBar` の `createRangeBar({...})` に、**仮に** `snapPoints: () => [], onGrab: () => undefined,` を足す
  (コメントは `// 吸い付き先と掴んだ端は、詰める欄を組み込むときに繋ぐ`。Task 5 で本物に置き換える)

- [ ] **Step 3: 失敗するテストを書く**

`tests/content/range-bar.test.ts` の末尾に足す:

```ts
describe("単語の切れ目への吸い付き", () => {
  // 既定の範囲 30〜45 の窓は 28〜47 (19 秒)。トラックを 190px にして 1px = 0.1 秒にする。SNAP_PX (8px) は 0.8 秒
  test("近くの切れ目に寄せる", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [31] });
    dragHandle(handles[0], 33); // 28 + 3.3 = 31.3 秒
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)).toEqual({ startSec: 31, endSec: 45 });
  });

  test("Alt を押している間は吸い付かない", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [31] });
    dragHandle(handles[0], 33, 0, true);
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)?.startSec).toBeCloseTo(31.3, 5);
  });

  test("遠い切れ目には寄せない", () => {
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [35] });
    dragHandle(handles[0], 33);
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)?.startSec).toBeCloseTo(31.3, 5);
  });

  test("寄せた後も最小・最大の長さを守る", () => {
    // 尻 45 の 0.5 秒手前に切れ目。寄せると 0.5 秒の区間になるので、1 秒手前で止める
    const { handles, committed } = mountRangeBar({ enabled: true, trackWidth: 190, snapPoints: [44.5] });
    dragHandle(handles[0], 165); // 28 + 16.5 = 44.5 秒
    handles[0].dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(committed.at(-1)).toEqual({ startSec: 44, endSec: 45 });
  });
});

describe("掴んだ端", () => {
  test("ハンドルを掴むと、どちらの端かを知らせる", () => {
    const { handles, grabbed } = mountRangeBar({ enabled: true });
    pressAt(handles[1], 0);
    pressAt(handles[0], 0);
    expect(grabbed).toEqual(["out", "in"]);
  });

  test("操作を受け付けない間は知らせない", () => {
    const { handles, grabbed } = mountRangeBar({ enabled: false });
    pressAt(handles[1], 0);
    expect(grabbed).toEqual([]);
  });
});
```

(`dragHandle` の pointerup はハンドル自身に送る。今の `onUp` は `upEvent.pointerId` を読むだけなので MouseEvent で足りる。既存のテストが pointerup をどう送っているかを先に見て、同じ書き方に揃える)

- [ ] **Step 4: 実行して失敗を確認**

実行: `npx vitest run tests/content/range-bar.test.ts` (timeout 300000)
期待: 吸い付きと掴んだ端のテストが FAIL (`snapPoints` / `onGrab` を呼ばない)

- [ ] **Step 5: 実装**

`src/content/range-bar.ts`:

1. import に `snapSec` を足す。`export const SNAP_PX = 8;` を `RangeBarCallbacks` の前に置く (doc: 「ハンドルが単語の切れ目に吸い付く距離 (px)。秒ではなく画面の距離で決める: 窓の幅で 1px の秒数が変わる」)
2. `RangeBarCallbacks` に足す:

```ts
  /**
   * 吸い付き先 (単語の切れ目。第 2 版のモック)。**掴んだときに 1 回だけ引く** (動かしている間に文字起こしが
   * 変わっても、指の下で吸い付き先を変えない)。無ければ空
   */
  snapPoints(window: TimeWindow): readonly number[];
  /** ハンドルを掴んだ。詰める欄のキー (`,` `.`) で動かす端にする */
  onGrab(kind: HandleKind): void;
```

3. `beginDrag` の pointerdown で、`handle.setPointerCapture(event.pointerId);` の後に:

```ts
      callbacks.onGrab(kind);
      const points = callbacks.snapPoints(window_);
```

4. `onMove` の `range = clampHandle(kind, pointerToSec(moveEvent.clientX), ...)` を次に替える:

```ts
        const raw = pointerToSec(moveEvent.clientX);
        // Alt を押している間は吸い付かない (モック)。吸い付きの幅は画面の距離で決める
        const desired = moveEvent.altKey ? raw : snapSec(raw, points, SNAP_PX * secondsPerPixel());
        range = clampHandle(kind, desired, range, window_, callbacks.maxClipSec());
```

5. `pointerToSec` の後に足す:

```ts
  /** トラックの 1px が何秒か。幅が取れないときは 0 (吸い付かない) */
  function secondsPerPixel(): number {
    const width = track.getBoundingClientRect().width;
    return width > 0 ? (window_.endSec - window_.startSec) / width : 0;
  }
```

6. `RangeBar.window()` の doc の「拡大バーの下のテロップの帯が」はそのまま。

`clampHandle` が吸い付いた後の値を最小・最大で止めるので、「寄せた後も最小・最大の長さを守る」は 5 で満たされる。

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/range-bar.test.ts tests/content/range-math.test.ts` (timeout 300000)
期待: PASS

実行: `npm run typecheck` (timeout 300000)
期待: エラーなし

- [ ] **Step 7: commit**

```bash
git -C . add src/content/range-bar.ts tests/helpers/range-bar.ts tests/content/range-bar.test.ts src/content/youtube.ts
git -C . commit -m "feat(content): 拡大バーのハンドルを単語の切れ目に吸い付かせ、掴んだ端を知らせる

詰める欄で発話の頭と尻に合わせやすくする (モック「単語の切れ目に吸い付く。Alt で吸い付かない」)。
掴んだ端は詰める欄のキー (, .) で動かす端に使う"
```

---

### Task 4: 詰める欄の部品

**Files:**
- Create: `src/content/trim-panel.ts`
- Modify: `src/content/styles.ts`
- Test: `tests/content/trim-panel.test.ts`

**Gate: human** (Step 0 だけ。実機の YouTube でキーの受け方を確かめるので、ユーザーに拡張の読み込み直しが要るなら頼む。ほかの step は止まらない)

**Interfaces:**
- Consumes: `TimeWindow`・`HandleKind`・`timeToRatio`・`NUDGE_SEC` (range-math)、`TrimWord` (Task 2)、`formatTimeCentis` (Task 2)
- Produces:

```ts
export type TrimPanelCallbacks = {
  /** ‹ › で区間を選んだ (0 始まり) */
  onSelect(index: number): void;
  /** 頭か尻を deltaSec (±NUDGE_SEC) 動かす */
  onNudge(kind: HandleKind, deltaSec: number): void;
  /** 繋ぎ目を聞き直す。in = 頭の 2 秒前から、out = 尻をまたいで */
  onPlayAround(kind: HandleKind): void;
};
export type TrimView = {
  /** 選んでいる区間 (0 始まり)。無ければ -1 */
  index: number;
  count: number;
  /** 選んでいる区間。無ければ null */
  range: ClipRange | null;
  /** 全区間の合計 (秒) */
  totalSec: number;
  /** 拡大バーが映している窓。まだ無ければ null */
  window: TimeWindow | null;
  /** 窓に入る単語 (`wordsInWindow`) */
  words: readonly TrimWord[];
};
export type TrimPanel = {
  element: HTMLElement;
  update(view: TrimView): void;
  setEnabled(enabled: boolean): void;
  /** キーで動かす端。拡大バーのハンドルを掴んだら呼ぶ */
  setActiveEdge(kind: HandleKind): void;
};
export function createTrimPanel(parts: { rangeBar: HTMLElement; telopTrack: HTMLElement }, callbacks: TrimPanelCallbacks): TrimPanel;
```

**並び (回答 2026-11-03「行を詰めて最小に」):** 見出しの行 1 本に「区間 N を詰める・時刻・‹ ›・頭 −0.1 ＋0.1・尻 −0.1 ＋0.1・▶ 頭・▶ 尻」をまとめ、その下に拡大バー → テロップの帯の段 → 単語の段。詰める操作だけの行は作らない (バーの背を 1440x795 で伸ばしすぎない)。

DOM の目印 (テストと youtube.ts が掴む): 根 `data-role="trim"`、見出しの行 `data-role="trim-head"`、見出しの文 `trim-title`、時刻 `trim-range`、‹ `trim-prev`、› `trim-next`、頭の組 `trim-edge-in`、尻の組 `trim-edge-out` (キーで動く方に `data-active="true"`)、頭 −0.1 `nudge-in-minus`、頭 ＋0.1 `nudge-in-plus`、尻 −0.1 `nudge-out-minus`、尻 ＋0.1 `nudge-out-plus`、▶ 頭 `play-head`、▶ 尻 `play-tail`、単語の段 `trim-words`、単語 `trim-word` (区間の外は `data-out="true"`)。

- [ ] **Step 0: YouTube がどこで `,` `.` を受けるかを実機で確かめる (spike)**

設計は「詰める欄の根で keydown を受け、`stopPropagation` で YouTube へ渡さない」。YouTube が window や document の **capture** で受けていると、これでは止まらない。作る前に確かめる。

ユーザーの普段の Chrome (Claude in Chrome) で、動画の再生画面を開き、動画を止めてから `javascript_tool` で次を実行する:

```js
(() => {
  const video = document.querySelector("video.html5-main-video");
  video.pause();
  const before = video.currentTime;
  const box = document.createElement("div");
  box.tabIndex = -1;
  document.body.append(box);
  box.addEventListener("keydown", (event) => event.stopPropagation());
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Period", keyCode: 190, bubbles: true, cancelable: true }));
  const stopped = video.currentTime;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Period", keyCode: 190, bubbles: true, cancelable: true }));
  const passed = video.currentTime;
  box.remove();
  return { before, stopped, passed };
})()
```

- `stopped === before` かつ `passed > before` → 設計のまま (根の bubble で止まる)。Step 1 へ
- `passed === before` (合成したキーでは YouTube が動かない) → この方法では確かめられない。設計のまま進め、Task 6 Step 4 で実際のキーを押して確かめる (外れたら下の代わりの手に替える)
- `stopped > before` (根で止めても YouTube に届く) → 代わりの手が効くかを確かめる。同じ画面で次を実行する:

```js
(() => {
  const video = document.querySelector("video.html5-main-video");
  video.pause();
  const before = video.currentTime;
  const block = (event) => { if (event.key === ".") { event.stopImmediatePropagation(); event.preventDefault(); } };
  window.addEventListener("keydown", block, { capture: true });
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Period", keyCode: 190, bubbles: true, cancelable: true }));
  window.removeEventListener("keydown", block, { capture: true });
  return { before, after: video.currentTime };
})()
```

  `after === before` なら **代わりの手**にする (下)。`after > before` (YouTube が window の capture で先に受けていて止められない)
  なら、**作業を止めてユーザーに聞く**: 「`,` `.` は YouTube のコマ送りと取り合って止められない。キーは諦めてボタンだけにするか、
  別のキー (例: `[` `]`) にするか」

  **代わりの手**: `createTrimPanel` の中で `window.addEventListener("keydown", onKey, { capture: true })` とし、`onKey` の先頭で `if (!element.contains(event.target as Node)) return;` を見て、受けたら `event.stopImmediatePropagation()` も呼ぶ。`TrimPanel` に `destroy(): void` (window のリスナを外す) を足し、youtube.ts でバーを作り直すとき (`buildBar` の前の `previousBar` / `previousTrack` の後始末と同じ場所) と `stop()` の片付けで呼ぶ。テスト「受けたキーは YouTube へ渡さない」はそのまま通る (window の capture は document より先)

結果を plan の自律判断ログに 1 行書く。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/trim-panel.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTrimPanel, type TrimPanel, type TrimView } from "@/content/trim-panel";

const VIEW: TrimView = {
  index: 1,
  count: 3,
  range: { startSec: 741.4, endSec: 749.8 },
  totalSec: 24.6,
  window: { startSec: 739.4, endSec: 751.8 },
  words: [
    { startSec: 740, endSec: 741, text: "（前）" },
    { startSec: 741.4, endSec: 742.2, text: "その" },
    { startSec: 749.9, endSec: 751, text: "いやほんと" },
  ],
};

const EMPTY: TrimView = { index: -1, count: 0, range: null, totalSec: 0, window: null, words: [] };

function mount(view: TrimView = VIEW) {
  const callbacks = { onSelect: vi.fn(), onNudge: vi.fn(), onPlayAround: vi.fn() };
  const rangeBar = document.createElement("div");
  rangeBar.id = "range";
  const telopTrack = document.createElement("div");
  telopTrack.id = "track";
  const panel = createTrimPanel({ rangeBar, telopTrack }, callbacks);
  document.body.append(panel.element);
  panel.update(view);
  panel.setEnabled(true);
  return { panel, callbacks };
}

function part(panel: TrimPanel, role: string): HTMLElement {
  const element = panel.element.querySelector<HTMLElement>(`[data-role='${role}']`);
  if (element === null) throw new Error(`${role} がありません`);
  return element;
}

function buttonOf(panel: TrimPanel, role: string): HTMLButtonElement {
  return part(panel, role) as HTMLButtonElement;
}

function key(panel: TrimPanel, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  panel.element.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("見出しの行", () => {
  test("何番目の区間か、頭と尻・長さ・合計を出す", () => {
    const { panel } = mount();
    expect(part(panel, "trim-title").textContent).toBe("区間 2 を詰める");
    expect(part(panel, "trim-range").textContent).toBe("12:21.40 – 12:29.80 · 8.4 秒 · 合計 24.6 秒");
  });

  test("‹ › は行き先の区間の番号を出し、押すとその区間を選ぶ", () => {
    const { panel, callbacks } = mount();
    expect(part(panel, "trim-prev").textContent).toBe("‹ 区間 1");
    expect(part(panel, "trim-next").textContent).toBe("区間 3 ›");
    part(panel, "trim-prev").click();
    part(panel, "trim-next").click();
    expect(callbacks.onSelect.mock.calls).toEqual([[0], [2]]);
  });

  test("端の区間では先が押せず、番号も出さない", () => {
    const { panel } = mount({ ...VIEW, index: 0 });
    expect(buttonOf(panel, "trim-prev").disabled).toBe(true);
    expect(part(panel, "trim-prev").textContent).toBe("‹");
    panel.update({ ...VIEW, index: 2 });
    expect(buttonOf(panel, "trim-next").disabled).toBe(true);
    expect(part(panel, "trim-next").textContent).toBe("›");
  });

  test("区間が無いときは案内だけ", () => {
    const { panel } = mount(EMPTY);
    expect(part(panel, "trim-title").textContent).toBe("区間はまだありません");
    expect(part(panel, "trim-range").textContent).toBe("文字起こしの行を押すか、＋ 区間を追加 で作れます");
    for (const role of ["trim-prev", "trim-next", "nudge-in-minus", "nudge-out-plus", "play-head", "play-tail"]) {
      expect(buttonOf(panel, role).disabled).toBe(true);
    }
  });

  test("詰める操作は見出しの行に入る (行を増やさない)", () => {
    const { panel } = mount();
    const head = part(panel, "trim-head");
    for (const role of ["trim-prev", "trim-next", "nudge-in-minus", "nudge-in-plus", "nudge-out-minus", "nudge-out-plus", "play-head", "play-tail"]) {
      expect(head.contains(part(panel, role))).toBe(true);
    }
  });
});

describe("中身の並び", () => {
  test("見出しの行 → 拡大バー → テロップの帯 → 単語", () => {
    const { panel } = mount();
    const ids = [...panel.element.children].map((child) => child.id || (child as HTMLElement).dataset.role);
    expect(ids).toEqual(["trim-head", "range", "track", "trim-words"]);
  });
});

describe("単語の並び", () => {
  test("窓の中の位置に置き、区間の外の単語は印を付ける", () => {
    const { panel } = mount();
    const words = [...panel.element.querySelectorAll<HTMLElement>("[data-role='trim-word']")];
    expect(words.map((word) => word.textContent)).toEqual(["（前）", "その", "いやほんと"]);
    expect(words.map((word) => word.dataset.out)).toEqual(["true", undefined, "true"]);
    // 窓 739.4〜751.8 (12.4 秒) の 740 は 0.6 / 12.4
    expect(parseFloat(words[0]?.style.left ?? "")).toBeCloseTo((0.6 / 12.4) * 100, 3);
  });

  test("単語が無ければ段を出さない", () => {
    const { panel } = mount({ ...VIEW, words: [] });
    expect(part(panel, "trim-words").hidden).toBe(true);
  });

  test("文字は textContent で入れる", () => {
    const { panel } = mount({ ...VIEW, words: [{ startSec: 742, endSec: 743, text: "<img src=x onerror=alert(1)>" }] });
    expect(panel.element.querySelector("img")).toBeNull();
  });
});

describe("詰める操作", () => {
  test("頭と尻の −0.1 / ＋0.1", () => {
    const { panel, callbacks } = mount();
    part(panel, "nudge-in-minus").click();
    part(panel, "nudge-in-plus").click();
    part(panel, "nudge-out-minus").click();
    part(panel, "nudge-out-plus").click();
    expect(callbacks.onNudge.mock.calls).toEqual([
      ["in", -0.1],
      ["in", 0.1],
      ["out", -0.1],
      ["out", 0.1],
    ]);
  });

  test("繋ぎ目を聞き直す", () => {
    const { panel, callbacks } = mount();
    part(panel, "play-head").click();
    part(panel, "play-tail").click();
    expect(callbacks.onPlayAround.mock.calls).toEqual([["in"], ["out"]]);
  });
});

describe("キー", () => {
  test(", と . は、はじめは頭を動かす。頭の組に印が付く", () => {
    const { panel, callbacks } = mount();
    expect(part(panel, "trim-edge-in").dataset.active).toBe("true");
    expect(part(panel, "trim-edge-out").dataset.active).toBeUndefined();
    key(panel, ",");
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls).toEqual([
      ["in", -0.1],
      ["in", 0.1],
    ]);
  });

  test("掴んだ端を動かし、印も移る", () => {
    const { panel, callbacks } = mount();
    panel.setActiveEdge("out");
    expect(part(panel, "trim-edge-out").dataset.active).toBe("true");
    expect(part(panel, "trim-edge-in").dataset.active).toBeUndefined();
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls).toEqual([["out", 0.1]]);
  });

  test("±0.1 を押した端もキーの端になる", () => {
    const { panel, callbacks } = mount();
    part(panel, "nudge-out-minus").click();
    key(panel, ".");
    expect(callbacks.onNudge.mock.calls.at(-1)).toEqual(["out", 0.1]);
    expect(part(panel, "trim-edge-out").dataset.active).toBe("true");
  });

  test("受けたキーは YouTube へ渡さない (コマ送りと取り合わない)", () => {
    const { panel } = mount();
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    const event = key(panel, ".");
    document.removeEventListener("keydown", onDocument);
    expect(event.defaultPrevented).toBe(true);
    expect(onDocument).not.toHaveBeenCalled();
  });

  test("修飾キー付きと、ほかのキーは受けない", () => {
    const { panel, callbacks } = mount();
    expect(key(panel, ".", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(panel, "k").defaultPrevented).toBe(false);
    expect(callbacks.onNudge).not.toHaveBeenCalled();
  });

  test("文字を打つ欄の中のキーは受けない", () => {
    const { panel, callbacks } = mount();
    const input = document.createElement("textarea");
    panel.element.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true, cancelable: true }));
    expect(callbacks.onNudge).not.toHaveBeenCalled();
  });

  test("操作を受け付けない間は、ボタンもキーも効かない", () => {
    const { panel, callbacks } = mount();
    panel.setEnabled(false);
    key(panel, ".");
    part(panel, "nudge-in-plus").click();
    part(panel, "trim-next").click();
    part(panel, "play-head").click();
    expect(callbacks.onNudge).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onPlayAround).not.toHaveBeenCalled();
  });

  test("掴んだら欄にフォーカスを移す (キーが届くように)", () => {
    const { panel } = mount();
    panel.setActiveEdge("in");
    expect(document.activeElement).toBe(panel.element);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts` (timeout 300000)
期待: FAIL (`@/content/trim-panel` が無い)

- [ ] **Step 3: 見た目を足す**

`src/content/styles.ts` の `RANGE_STYLE` の後に足す:

```ts
/**
 * 詰める欄 (`trim-panel.ts`。第 2 版のモック)。拡大バーとテロップの帯を中に抱える。
 *
 * **根の gap はバーと同じ 10px。** テロップの帯の段は `margin-top:-6px` で拡大バーのトラックとの間を 4px に詰める
 * 前提で作ってある (`TELOP_TRACK_STYLE`)。gap を狭めると帯がハンドルの当たり判定 (トラックの上下 4px) に重なる。
 * 単語の段も同じ `margin-top:-6px` で上の段に寄せ、バーの背を伸ばしすぎない。
 *
 * **単語の段は拡大バーと同じ左右の余白を持つ。** 拡大バーはトラックの左右に時刻を置くので、単語の段も同じ文字の
 * 見えない時刻 (`ghost`) を左右に置き、トラックと同じ幅に揃える (テロップの帯の段と同じやり方)
 */
export const TRIM_STYLE = {
  /** `outline:none`: フォーカスはキーを受けるためだけ。枠を出すとバーの見た目が揺れる */
  root: "display:flex;flex-direction:column;gap:10px;outline:none;",
  /** 見出しの行。詰める操作もここに入れる (回答 2026-11-03「行を詰めて最小に」)。狭い幅では折り返す */
  head: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;",
  title: "font-weight:500;color:var(--ytc-text);white-space:nowrap;",
  range: "color:var(--ytc-text-sub);font-variant-numeric:tabular-nums;white-space:nowrap;",
  grow: "flex:1;",
  group: "display:inline-flex;gap:3px;align-items:center;color:var(--ytc-text-sub);padding:0 2px;border-radius:6px;",
  /** キーで動く端の組。文字を濃くして下線を引く (色だけに頼らない) */
  groupActive: "color:var(--ytc-text);font-weight:500;text-decoration:underline;",
  smallButton: `appearance:none;border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:13px;height:26px;padding:0 8px;font-family:${FONT};font-size:12px;cursor:pointer;white-space:nowrap;`,
  disabled: "opacity:0.4;pointer-events:none;",
  words:
    "display:flex;align-items:center;gap:10px;height:20px;margin-top:-6px;font-size:12px;font-variant-numeric:tabular-nums;",
  ghost: "visibility:hidden;white-space:nowrap;",
  lane: "position:relative;flex:1;min-width:0;height:20px;overflow:hidden;",
  word: "position:absolute;top:0;height:18px;box-sizing:border-box;padding:0 3px;border:1px solid transparent;border-radius:4px;background:var(--ytc-surface);color:var(--ytc-text);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:clip;pointer-events:none;",
  wordOut: "background:transparent;border:1px dashed var(--ytc-border);color:var(--ytc-text-sub);",
} as const;
```

- [ ] **Step 4: 実装**

`src/content/trim-panel.ts`:

```ts
/**
 * 詰める欄 (ADR 0001・第 2 版のモック)。見出しの行 (区間 N を詰める・時刻・‹ ›・頭と尻の ±0.1・繋ぎ目の聞き直し)、
 * 拡大バー (前後 2 秒の窓) とテロップの帯、窓の中の単語を並べる。詰める操作は見出しの行に入れ、行を増やさない
 * (回答 2026-11-03「行を詰めて最小に」。1440x795 でバーがプレイヤーの下端を覆わないように)。
 *
 * **区間は持たない。** 何を出すかは `update` で受け取り、押されたことを伝えるだけ (状態機械に送るのは youtube.ts)。
 * 拡大バーとテロップの帯は youtube.ts が作り、要素だけをここに入れる (どちらも youtube.ts が直接更新する)
 */

import { NUDGE_SEC, timeToRatio, type HandleKind, type TimeWindow } from "@/content/range-math";
import { TRIM_STYLE } from "@/content/styles";
import type { TrimWord } from "@/content/trim-words";
import { formatTime, formatTimeCentis } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

export type TrimPanelCallbacks = {
  /** ‹ › で区間を選んだ (0 始まり) */
  onSelect(index: number): void;
  /** 頭か尻を deltaSec (±NUDGE_SEC) 動かす */
  onNudge(kind: HandleKind, deltaSec: number): void;
  /** 繋ぎ目を聞き直す。in = 頭の 2 秒前から、out = 尻をまたいで */
  onPlayAround(kind: HandleKind): void;
};

export type TrimView = {
  /** 選んでいる区間 (0 始まり)。無ければ -1 */
  index: number;
  count: number;
  /** 選んでいる区間。無ければ null */
  range: ClipRange | null;
  /** 全区間の合計 (秒) */
  totalSec: number;
  /** 拡大バーが映している窓。まだ無ければ null */
  window: TimeWindow | null;
  /** 窓に入る単語 (`wordsInWindow`) */
  words: readonly TrimWord[];
};

export type TrimPanel = {
  element: HTMLElement;
  update(view: TrimView): void;
  setEnabled(enabled: boolean): void;
  /** キーで動かす端。拡大バーのハンドルを掴んだら呼ぶ */
  setActiveEdge(kind: HandleKind): void;
};

/** 秒を 0.1 秒の桁で出す (見出しの長さと合計) */
const tenths = (sec: number): string => (Math.round(sec * 10) / 10).toFixed(1);

/** 押されたキーが文字を打つ欄の中か。打っている文字を横取りしない */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

export function createTrimPanel(
  parts: { rangeBar: HTMLElement; telopTrack: HTMLElement },
  callbacks: TrimPanelCallbacks,
): TrimPanel {
  let view: TrimView = { index: -1, count: 0, range: null, totalSec: 0, window: null, words: [] };
  let enabled = false;
  /** キーで動かす端。はじめは頭 (モック「選んでいる端を動かす」) */
  let activeEdge: HandleKind = "in";

  const element = document.createElement("div");
  element.dataset.role = "trim";
  // キーを受けるためにフォーカスを持てるようにする (ハンドルを掴んだら setActiveEdge が移す)
  element.tabIndex = -1;
  element.style.cssText = TRIM_STYLE.root;

  function button(role: string, label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.dataset.role = role;
    node.textContent = label;
    if (title !== undefined) {
      node.title = title;
      // 文字を縮めたボタンは、読み上げにも全文を渡す
      node.setAttribute("aria-label", title);
    }
    node.style.cssText = TRIM_STYLE.smallButton;
    node.addEventListener("click", () => {
      if (enabled) onClick();
    });
    return node;
  }

  /** ボタンを押したときも、その端をキーの端にする (続けてキーで詰められる) */
  function nudge(kind: HandleKind, deltaSec: number): void {
    setActive(kind);
    callbacks.onNudge(kind, deltaSec);
  }

  // --- 見出しの行 (詰める操作も入れる) ---
  const head = document.createElement("div");
  head.dataset.role = "trim-head";
  head.style.cssText = TRIM_STYLE.head;
  const title = document.createElement("span");
  title.dataset.role = "trim-title";
  title.style.cssText = TRIM_STYLE.title;
  const rangeText = document.createElement("span");
  rangeText.dataset.role = "trim-range";
  rangeText.style.cssText = TRIM_STYLE.range;
  const prev = button("trim-prev", "‹", () => callbacks.onSelect(view.index - 1));
  const nextButton = button("trim-next", "›", () => callbacks.onSelect(view.index + 1));
  const grow = document.createElement("span");
  grow.style.cssText = TRIM_STYLE.grow;

  const edgeGroup = (role: string, label: string, ...buttons: HTMLButtonElement[]): HTMLElement => {
    const box = document.createElement("span");
    box.dataset.role = role;
    box.append(label, ...buttons);
    return box;
  };
  const nudgeButtons = [
    button("nudge-in-minus", "−0.1", () => nudge("in", -NUDGE_SEC)),
    button("nudge-in-plus", "＋0.1", () => nudge("in", NUDGE_SEC)),
    button("nudge-out-minus", "−0.1", () => nudge("out", -NUDGE_SEC)),
    button("nudge-out-plus", "＋0.1", () => nudge("out", NUDGE_SEC)),
  ] as const;
  const inGroup = edgeGroup("trim-edge-in", "頭", nudgeButtons[0], nudgeButtons[1]);
  const outGroup = edgeGroup("trim-edge-out", "尻", nudgeButtons[2], nudgeButtons[3]);
  // 文字は短くし、全文は title に出す (1 行に収める)
  const playHead = button("play-head", "▶ 頭", () => callbacks.onPlayAround("in"), "頭の 2 秒前から再生");
  const playTail = button("play-tail", "▶ 尻", () => callbacks.onPlayAround("out"), "尻をまたいで再生 (尻の 2 秒前から 2 秒後まで)");
  head.append(title, rangeText, prev, nextButton, grow, inGroup, outGroup, playHead, playTail);

  // --- 単語の段 (拡大バーのトラックと左右を揃える) ---
  const words = document.createElement("div");
  words.dataset.role = "trim-words";
  words.style.cssText = TRIM_STYLE.words;
  const ghostStart = document.createElement("span");
  ghostStart.style.cssText = TRIM_STYLE.ghost;
  const lane = document.createElement("div");
  lane.style.cssText = TRIM_STYLE.lane;
  const ghostEnd = document.createElement("span");
  ghostEnd.style.cssText = TRIM_STYLE.ghost;
  words.append(ghostStart, lane, ghostEnd);

  element.append(head, parts.rangeBar, parts.telopTrack, words);

  /** キーで動く端の組に印を付ける (どちらが動くか見えるように) */
  function setActive(kind: HandleKind): void {
    activeEdge = kind;
    for (const [group, edge] of [[inGroup, "in"], [outGroup, "out"]] as const) {
      if (edge === kind) group.dataset.active = "true";
      else delete group.dataset.active;
      group.style.cssText = edge === kind ? `${TRIM_STYLE.group}${TRIM_STYLE.groupActive}` : TRIM_STYLE.group;
    }
  }
  setActive("in");

  element.addEventListener("keydown", (event) => {
    if (event.key !== "," && event.key !== ".") return;
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (!enabled || view.range === null) return;
    // YouTube は , . を止めている間のコマ送りに使う。欄が受けたら渡さない (Task 4 Step 0 で受け方を確かめた)
    event.preventDefault();
    event.stopPropagation();
    callbacks.onNudge(activeEdge, event.key === "," ? -NUDGE_SEC : NUDGE_SEC);
  });

  function paintWords(): void {
    const window = view.window;
    const range = view.range;
    const shown = window !== null && range !== null ? view.words : [];
    words.hidden = shown.length === 0;
    if (window === null || range === null) {
      lane.replaceChildren();
      return;
    }
    // 拡大バーのトラックの左右の時刻と同じ文字を見えないまま置き、幅を揃える
    ghostStart.textContent = formatTime(window.startSec);
    ghostEnd.textContent = formatTime(window.endSec);
    lane.replaceChildren(
      ...shown.map((word) => {
        const chip = document.createElement("span");
        chip.dataset.role = "trim-word";
        const middle = (word.startSec + word.endSec) / 2;
        const out = middle < range.startSec || range.endSec < middle;
        if (out) chip.dataset.out = "true";
        chip.style.cssText = out ? `${TRIM_STYLE.word}${TRIM_STYLE.wordOut}` : TRIM_STYLE.word;
        const left = timeToRatio(Math.max(word.startSec, window.startSec), window);
        const right = timeToRatio(Math.min(word.endSec, window.endSec), window);
        chip.style.left = `${left * 100}%`;
        chip.style.width = `${(right - left) * 100}%`;
        chip.textContent = word.text;
        chip.title = word.text;
        return chip;
      }),
    );
  }

  function paint(): void {
    const range = view.index >= 0 ? view.range : null;
    if (range !== null) {
      title.textContent = `区間 ${view.index + 1} を詰める`;
      const length = range.endSec - range.startSec;
      rangeText.textContent = `${formatTimeCentis(range.startSec)} – ${formatTimeCentis(range.endSec)} · ${tenths(length)} 秒 · 合計 ${tenths(view.totalSec)} 秒`;
    } else {
      title.textContent = "区間はまだありません";
      rangeText.textContent = "文字起こしの行を押すか、＋ 区間を追加 で作れます";
    }
    const hasPrev = range !== null && view.index > 0;
    const hasNext = range !== null && view.index < view.count - 1;
    // 行き先の番号を出す (モック「‹ 区間 1」「区間 3 ›」)
    prev.textContent = hasPrev ? `‹ 区間 ${view.index}` : "‹";
    nextButton.textContent = hasNext ? `区間 ${view.index + 2} ›` : "›";
    prev.disabled = !hasPrev;
    nextButton.disabled = !hasNext;
    for (const node of [...nudgeButtons, playHead, playTail]) node.disabled = range === null;
    paintWords();
  }

  return {
    element,
    update(nextView: TrimView): void {
      view = nextView;
      paint();
    },
    setEnabled(value: boolean): void {
      enabled = value;
      // 見出しの文 (何を詰めているか) は録画中も読める。押せる所だけ薄くする
      for (const node of [prev, nextButton, ...nudgeButtons, playHead, playTail]) {
        node.style.cssText = value ? TRIM_STYLE.smallButton : `${TRIM_STYLE.smallButton}${TRIM_STYLE.disabled}`;
      }
    },
    setActiveEdge(kind: HandleKind): void {
      setActive(kind);
      element.focus({ preventScroll: true });
    },
  };
}
```

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts` (timeout 300000)
期待: PASS

実行: `npm run typecheck` (timeout 300000)
期待: エラーなし (Task 3 で youtube.ts に仮の `snapPoints` / `onGrab` を足してあるので、ここで落ちるものは無い。未使用の変数が残っていれば `noUnusedLocals` で落ちる)

- [ ] **Step 6: commit**

```bash
git -C . add src/content/trim-panel.ts src/content/styles.ts tests/content/trim-panel.test.ts
git -C . commit -m "feat(content): 詰める欄の見出しの行と単語の並びを作る

モックの詰める欄 (区間 N を詰める・‹ ›・単語・頭と尻の ±0.1・繋ぎ目の聞き直し) を、状態を持たない部品にする。
詰める操作は見出しの行にまとめ、1440x795 でバーの背を伸ばしすぎない。
, . は YouTube のコマ送りと同じキーなので、欄にフォーカスがあるときだけ受けて YouTube へ渡さない"
```

---

### Task 5: youtube.ts に組み込む

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`、`tests/content/youtube-transcript-panel.test.ts`

**Interfaces:**
- Consumes: Task 2〜4 のすべて
- Produces: バーの窓の中身が `詰める欄 (見出しの行 → 拡大バー → テロップの帯 → 単語) → 操作の行` になる

- [ ] **Step 1: 窓と並びが変わって落ちるテストを直す**

`npx vitest run tests/content/youtube.test.ts tests/content/youtube-transcript-panel.test.ts` (timeout 300000) で落ちるのは次の 3 本の見込み
(3 本目は Step 4 の組み込みの後に落ちる。Step 4 の後にもう一度回して直す):

1. **「作り直されたバーにも設定した上限が効く」(1359 行付近)** — 上限で止まることを見るテスト。**期待値ではなく範囲を直す**:
   `emit` する区間を `{ startSec: 100, endSec: 119 }` にする (窓は 98〜121、上限 20 で「終了 2:00」のまま通る)。窓の端 (1:57) を
   見るテストに変えない
2. **`describe("拡大バーの下のテロップの帯")` のドラッグ** — 範囲 10〜20 の窓は 8〜22 (14 秒)。`stubLayout` の doc を「拡大バーの窓は
   8〜22 秒 (範囲 10〜20 の前後 2 秒)。帯の段の箱を幅 280px (20px/秒) に、テロップ (11〜14 秒) の帯を 60〜120px に決め打ちする」に
   直し、`telop-lanes` を `boxAt(0, 0, 280, 30)`、`telop-band` を `boxAt(60, 0, 60, 14)` にする。ドラッグの px は 20px/秒で、
   **同じ秒だけ動かす**ように直す (例: 今 10px/秒で 20px 動かして 2 秒ずらしているなら 40px)。**この describe の pointer の x
   (今は 125 など) はすべて新しい帯 (60〜120px) の中の同じ所へ移す** (帯の真ん中を掴むテストは 90 前後、端を掴むテストは新しい
   帯の端から同じ距離)。x を直さないと、帯の中を掴むつもりのテストが右端を掴む操作に変わり、黙って意味が変わる
   (「拒否されたとき帯を戻す」「押して動かさずに離すと再生」「preview では動かない」は落ちないまま意味が変わる)「窓 192.5〜222.5」のような古い窓の
   コメント (2717 行付近) も新しい窓に直す
3. **「一覧は区間・テロップの窓に入り、バーには拡大バー・テロップの帯の段・操作の行だけが残る」(2844 行付近)** — バーの子が
   詰める欄と操作の行の 2 つになる。テスト名を「一覧は区間・テロップの窓に入り、バーには詰める欄と操作の行だけが残る」にし、
   末尾の並びの expect を次に替える:

```ts
    // 並び: 詰める欄 (見出しの行 → 拡大バー → テロップの帯の段 (フロートの窓の spec B.3) → 単語) → 操作の行
    expect(bar.children.length).toBe(2);
    const trim = bar.firstElementChild as HTMLElement;
    expect(trim.dataset.role).toBe("trim");
    expect(trim.children[1]?.id).toBe("yt-clip-range");
    expect(trim.children[2]?.getAttribute("data-role")).toBe("telop-track");
    expect(
      bar.lastElementChild?.contains(document.getElementById("yt-clip-bar-status")),
    ).toBe(true);
```

ほかに落ちるものがあれば、同じく「止まる理由・確かめる中身を変えない」で直し、直した本数を commit の本文に書く。

- [ ] **Step 2: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に足す (`emit`・`flush`・`META_A`・`clipEvents`・`installVideo` などは既存のもの。`sent = []` で送ったイベントを空にする作法も既存のテストに倣う。`FakeVideo` の `currentTime` / `duration` の扱いは `installVideo` を読んで合わせる):

```ts
describe("詰める欄", () => {
  const TWO: ClipRange[] = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  function trimPart(role: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`#yt-clip-bar [data-role='${role}']`);
    if (element === null) throw new Error(`${role} がありません`);
    return element;
  }

  function adjustEvents(): unknown[] {
    return clipEvents().filter((event) => (event as { type: string }).type === "ADJUST_SEGMENT");
  }

  async function showTwo(): Promise<void> {
    // 選択はテストをまたいで残る (未選択なら末尾を選ぶ規則)。idle で -1 に戻してから流す
    emit({ kind: "idle" });
    await flush();
    emit({ kind: "ready", segments: TWO, telops: [], meta: META_A });
    await flush();
    sent = [];
  }

  test("バーの窓は詰める欄と操作の行。詰める欄の中に拡大バーとテロップの帯が入る", async () => {
    await showTwo();
    const trim = trimPart("trim");
    expect(trim.parentElement?.id).toBe("yt-clip-bar");
    expect(trim.contains(rangeBarElement())).toBe(true);
    expect(trim.querySelector("[data-role='telop-track']")).not.toBeNull();
  });

  test("選んでいる区間を見出しに出し、‹ で前の区間へ移る", async () => {
    await showTwo();
    // 届いた直後は最後の区間が選ばれる (今の作法)
    expect(trimPart("trim-title").textContent).toBe("区間 2 を詰める");
    expect(trimPart("trim-range").textContent).toContain("4:02.00 – 4:10.00");

    trimPart("trim-prev").click();
    await flush();

    expect(trimPart("trim-title").textContent).toBe("区間 1 を詰める");
    // 拡大バーの窓も前後 2 秒で移る (81〜100)
    expect(handleLabels()).toEqual(["開始 1:23", "終了 1:38"]);
    expect(clipEvents()).toEqual([]);
  });

  test("＋0.1 で尻を伸ばし、ADJUST_SEGMENT を送る", async () => {
    await showTwo();
    trimPart("nudge-out-plus").click();
    await flush();

    expect(adjustEvents()).toEqual([{ type: "ADJUST_SEGMENT", index: 1, range: { startSec: 242, endSec: 250.1 } }]);
    // 答えを待たずに見出しを変える (拡大バーのドラッグと同じく楽観的に描く)
    expect(trimPart("trim-range").textContent).toContain("4:10.10");
  });

  test("続けて押すと、前に押した分に積む", async () => {
    await showTwo();
    trimPart("nudge-in-minus").click();
    trimPart("nudge-in-minus").click();
    await flush();

    expect(adjustEvents().at(-1)).toEqual({ type: "ADJUST_SEGMENT", index: 1, range: { startSec: 241.8, endSec: 250 } });
  });

  test("録画中は詰めない", async () => {
    emit({ kind: "recording", segments: TWO, telops: [], meta: META_A });
    await flush();
    sent = [];

    trimPart("nudge-out-plus").click();
    await flush();

    expect(adjustEvents()).toEqual([]);
  });

  test("▶ 尻 は尻の 2 秒前から再生する", async () => {
    await showTwo();
    trimPart("play-tail").click();
    await flush();

    expect(video.element.currentTime).toBe(248);
    expect(statusText()).toContain("尻をまたいで再生中");
  });

  test("▶ 頭 は頭の 2 秒前から再生する", async () => {
    await showTwo();
    trimPart("play-head").click();
    await flush();

    expect(video.element.currentTime).toBe(240);
    expect(statusText()).toContain("頭の 2 秒前から再生中");
  });
});
```

(`video` はこのファイルの既存の `installVideo()` の戻り値を持つ変数。seek した位置は `currentTime` の getter で読める)

`tests/content/youtube-transcript-panel.test.ts` の `describe("文字起こしの欄 (段階 1b-2)", ...)` の後に足す。このファイルの
`<video>` は本物の jsdom の video で `duration` が NaN なので、窓が作れない (`computeTrimWindow` が投げる)。このテストの中だけ
`duration` を与え、終わったら外す。単語を持つ行は共有の `LINES` を書き換えず、このテスト専用に読み込ませる:

```ts
describe("詰める欄 (段階 1c-1)", () => {
  const WORD_LINES = [
    {
      id: "youtube-asr:1.00",
      startSec: 1,
      endSec: 3,
      text: "さあ残り 30 秒",
      words: [
        { startSec: 1, endSec: 1.8, text: "さあ" },
        { startSec: 1.8, endSec: 2.4, text: "残り" },
        { startSec: 2.4, endSec: 3, text: "30 秒" },
      ],
    },
  ];

  function readyWithWords(): void {
    fake.onChange?.({
      kind: "ready",
      videoId: "video-a",
      dubbed: false,
      transcript: { videoId: "video-a", source: "youtube-asr", language: "ja", savedAt: 1, lines: WORD_LINES },
    });
  }

  test("行を押すと、その区間の単語が詰める欄に並ぶ", async () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 600 });
    try {
      readyWithWords();
      await flush();
      rows()[0]?.click();
      await flush();

      const words = [...document.querySelectorAll<HTMLElement>("#yt-clip-bar [data-role='trim-word']")];
      expect(words.map((word) => word.textContent)).toEqual(["さあ", "残り", "30 秒"]);
    } finally {
      delete (video as { duration?: number }).duration;
    }
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/youtube-transcript-panel.test.ts` (timeout 300000)
期待: 「詰める欄」の describe と単語のテストが FAIL

- [ ] **Step 4: 実装**

`src/content/youtube.ts`:

1. import:

```ts
import { createTrimPanel, type TrimPanel } from "@/content/trim-panel";
import { snapPointsIn, wordsInWindow } from "@/content/trim-words";
import { TRIM_MARGIN_SEC, makeDefaultRange, nudgeRange, type HandleKind } from "@/content/range-math";
```

(今の `import { makeDefaultRange } from "@/content/range-math";` を置き換える)

2. `let telopTrack: TelopTrack | null = null;` の後に:

```ts
/** 詰める欄 (ADR 0001)。拡大バーとテロップの帯を中に抱える。バーと一緒に作り直す */
let trimPanel: TrimPanel | null = null;
```

3. `buildBar` で、`telopTrack = createTelopTrack({...});` の後に詰める欄を作り、`bar.append(rangeBar.element, telopTrack.element, row);` を `bar.append(trimPanel.element, row);` に替える。`createRangeBar` の呼び出しの仮の `snapPoints` / `onGrab` (Task 3 Step 2b) とそのコメントを本物に替える:

```ts
  rangeBar = createRangeBar({
    onScrub,
    onCommit: onRangeCommitted,
    onSeekPlay: (sec) => void onSeekPlay(sec),
    maxClipSec: () => maxClipSec,
    // 吸い付き先は今の動画の文字起こしの単語の切れ目 (別の動画の行は transcriptLines が返さない)
    snapPoints: (window) => snapPointsIn(transcriptLines(), window),
    onGrab: (kind) => trimPanel?.setActiveEdge(kind),
  });
```

```ts
  // 詰める欄 (第 2 版のモック)。拡大バーとテロップの帯はここに入る
  trimPanel = createTrimPanel(
    { rangeBar: rangeBar.element, telopTrack: telopTrack.element },
    {
      onSelect: (index) => {
        if (index < 0 || index >= listedItems().segments.length) return;
        selectedIndex = index;
        applyStateToSelection();
      },
      onNudge,
      onPlayAround: (kind) => void playAround(kind),
    },
  );
```

`buildBar` の中のコメント「バーは拡大バー → テロップの帯の段 → 操作の行だけ。」を「バーは詰める欄 (見出しの行 → 拡大バー → テロップの帯の段 → 単語) → 操作の行。」に直す (後ろの理由の文はそのまま)。

4. `paintRangeBar` を、詰める欄も描き直す形にする:

```ts
/**
 * 拡大バーを描き直し、同じ時間の軸で帯の段と詰める欄の単語も描き直す。**拡大バーの窓が変わる経路はここを通す**
 * (帯や単語だけが古い窓のまま残らないように)
 */
function paintRangeBar(range: ClipRange, videoDurationSec: number): void {
  rangeBar?.update(range, videoDurationSec);
  refreshTelopTrack();
  refreshTrimPanel();
}

/**
 * 詰める欄の見出し・単語・押せるかを手元の写しに合わせる。区間の数や選択が変わったとき (`refreshLists`) と、
 * 拡大バーの窓が変わったとき (`paintRangeBar`) に呼ぶ。同じ入力なら同じ絵になる (冪等)
 */
function refreshTrimPanel(): void {
  if (trimPanel === null) return;
  const { segments } = listedItems();
  const range = segments[selectedIndex] ?? null;
  const window = range === null ? null : (rangeBar?.window() ?? null);
  trimPanel.setEnabled(canAdjustRange());
  trimPanel.update({
    index: range === null ? -1 : selectedIndex,
    count: segments.length,
    range,
    totalSec: totalSec(segments),
    window,
    words: window === null ? [] : wordsInWindow(transcriptLines(), window),
  });
}
```

`refreshLists` の `refreshTelopTrack();` の後に `refreshTrimPanel();` を足す。`applyStateToDisplay` の `rangeBar?.setEnabled(canAdjustRange());` の後と、`setEnabled` を呼んでいるほかの 2 か所 (`rangeBar?.setEnabled(canAdjustRange());` で grep) の後にも `trimPanel?.setEnabled(canAdjustRange());` を足す。`applyStateToSelection` は `paintRangeBar` を通るので足さなくてよいが、`segmentList?.update(...)` の後に `refreshTrimPanel();` を足す (区間が無いときも見出しを直す)。

文字起こしの読み込みが済んだとき (`refreshTranscript` を呼んでいる経路) にも単語を出したいので、`refreshTranscript` の末尾で `refreshTrimPanel();` を呼ぶ。`refreshLists` からも呼ばれるので 2 回になるが冪等。

5. 確定で窓を取り直す。`onRangeCommitted` の `paintOverlay(currentSegments, durationSec);` の後に `paintRangeBar(range, durationSec);` を足す (doc に 1 文: 「**確定したら窓を前後 2 秒で映し直す** (詰める欄。もっと伸ばしたいときはもう一度端まで引く)」)。`applyStateToDisplay` の末尾近くのコメント「拡大バーを描き直すのは、表示がずれているときだけにする。確定のたびに描き直すと窓が計算し直されてハンドルが跳ねる。」を「拡大バーを描き直すのは、表示がずれているときだけにする (手を離したときの映し直しは `onRangeCommitted` がしている。答えが届くたびに描き直すと、続けて動かしている最中に窓が動く)。」に直す。

6. ±0.1。`onRangeCommitted` の後に足す:

```ts
/**
 * 詰める欄の −0.1 / ＋0.1 (と `,` `.`)。拡大バーのドラッグの確定と同じ経路 (`onRangeCommitted`) で送る。
 *
 * **手元の写し (楽観的に描いた範囲) に積む。** 答えを待たずに続けて押しても、前に押した分が消えない。
 * 動かした端の映像を出す (止めて、その位置へ)
 */
function onNudge(kind: HandleKind, deltaSec: number): void {
  if (!canAdjustRange()) return;
  const range = selectedSegment();
  if (range === null) return;
  try {
    const next = nudgeRange(kind, deltaSec, range, getVideo().duration, maxClipSec);
    if (sameRange(next, range)) return;
    onRangeCommitted(next);
    onScrub(kind === "in" ? next.startSec : next.endSec);
  } catch (error) {
    setStatus(`区間を詰められませんでした: ${String(error)}`);
  }
}
```

7. 繋ぎ目の再生。`playRange` を、範囲と文言を受け取る `playSpan` に分ける:

```ts
/** 指定した範囲を通しで再生して内容を確認する */
async function playRange(): Promise<void> {
  const range = selectedSegment();
  if (range === null) return;
  await playSpan(range, range.startSec, range.endSec, `区間を再生中… (${Math.round(range.endSec - range.startSec)}秒)`);
}

/**
 * 繋ぎ目だけを聞き直す (第 2 版のモック)。in = 頭の 2 秒前から頭の 2 秒後まで、out = 尻の 2 秒前から尻の 2 秒後まで
 * (切り落とした所も聞こえる)
 */
async function playAround(kind: HandleKind): Promise<void> {
  const range = selectedSegment();
  if (range === null) return;
  const edge = kind === "in" ? range.startSec : range.endSec;
  const fromSec = Math.max(0, edge - TRIM_MARGIN_SEC);
  const label = kind === "in" ? "頭の 2 秒前から再生中…" : "尻をまたいで再生中…";
  await playSpan(range, fromSec, edge + TRIM_MARGIN_SEC, label);
}

/**
 * fromSec から toSec まで再生して止める。止めたら区間の範囲を状態の欄に戻す。
 *
 * **選んでいる区間が変わっていたら止めない** (解除が漏れていた場合に、別の範囲の再生や録画まで巻き込んで止めない)
 */
async function playSpan(range: ClipRange, fromSec: number, toSec: number, playingLabel: string): Promise<void> {
  if (busy) return;
  cancelPreviewWatch();
  const video = await seekAndPlay(fromSec);
  if (video === null) return;

  try {
    setStatus(playingLabel);
    cancelPreview = onReachTime(video, toSec, () => {
      cancelPreview = null;
      const still = selectedSegment();
      if (busy || still === null || !sameRange(still, range)) {
        return;
      }
      video.pause();
      setStatus(rangeLabel(range));
    });
  } catch (error) {
    setStatus(`区間を再生できませんでした: ${String(error)}`);
  }
}
```

(尻の 2 秒後が動画の終わりを越えても、`onReachTime` は `ended` で止まる。`playRange` の元の doc コメントとその中のコメントは `playSpan` に移す)

8. 片付け: `trimPanel = null;` を `telopTrack = null;` の隣 (2706 行付近) に足す。`buildBar` の作り直し (2343 行付近の `previousBar` / `previousTrack`) は、詰める欄が両方の要素を抱えるので、古い詰める欄はバーの根ごと捨てられる。追加の destroy は要らない (詰める欄は rAF もタイマーも持たない)。

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run` (timeout 300000)
期待: 全部 PASS

実行: `npm run typecheck` (timeout 300000)
期待: エラーなし

- [ ] **Step 6: commit**

```bash
git -C . add src/content/youtube.ts tests/content/youtube.test.ts tests/content/youtube-transcript-panel.test.ts
git -C . commit -m "feat(content): 拡大バーを詰める欄にする

ADR 0001 の「選んだ区間をプレイヤーの下の詰める欄で詰める」の入口。‹ › で区間を移り、±0.1 と , . で頭と尻を
細かく詰め、繋ぎ目だけを聞き直せる。確定したら前後 2 秒で映し直す (もっと伸ばすときはもう一度端まで引く)。
窓が前後 2 秒になったぶん、帯と拡大バーの数字のテストを N 本直した"
```

(N は Step 1 で直した数)

---

### Task 6: e2e と実機

**Files:**
- Modify: `e2e/telop-check.spec.ts`

**Gate: human** (Step 1〜2 は本物の YouTube に繋ぐ手動実行の e2e、Step 4 はユーザーに拡張の読み込み直しを頼む)

- [ ] **Step 1: 自動の e2e を回す**

実行: `npm run build && npx playwright test` (timeout 600000)
期待: 既知の失敗 (`smoke.spec.ts` の「オフにすると 1 秒以内…」) のほかは PASS。`telop-check.spec.ts` は
`test.skip(!process.env.YT_CLIP_TELOP_CHECK, "手動実行専用")` で skip される (ここでは走らない)

- [ ] **Step 2: telop-check の窓の数字を直して回す**

`e2e/telop-check.spec.ts` の、拡大バーの窓の幅・位置に依る期待値とコメント (55 行・1361 行・1415 行付近の「窓は 312.5〜342.5」など)
を、前後 2 秒の窓 (例: 区間 320〜335 の窓は 318〜337) で書き直す。帯をドラッグする px は、新しい窓で同じ秒だけ動くように計算
し直す。**帯が窓の外になって掴めなくなるところは、テロップの時刻を窓の中に入るように選び直す** (帯は 1c-2 で撤去するので、
確かめる中身 — 動かした時刻が状態機械に届く — を変えない)。

実行: `npm run check:telop` (timeout 600000。本物の YouTube に繋ぐ。広告で落ちたらもう一度)
期待: 判定は `test-results/telop-check/` に残る。窓の数字に依る判定が通る。**「1440x795 で…画面に収まる」の判定は落ちうる**
(README に書いた制約どおり)。落ちたら差の px を完了の記録に書き、1c-2 に「実測の px を見て、帯を外した後も足りなければ
背の削り方を決める」として持ち越す (帯を外せば戻るとは決めつけない。見積もりでは帯を外しても 795 を数 px 超える)

- [ ] **Step 3: commit**

```bash
git -C . add e2e/telop-check.spec.ts
git -C . commit -m "test(e2e): 詰める欄の前後 2 秒の窓に合わせて帯の数字を直す

拡大バーの窓が区間の 2 倍・30 秒から前後 2 秒になり、帯の位置とドラッグの距離が変わったため"
```

- [ ] **Step 4: 普段の Chrome で manual-check の「詰める欄」を確かめる**

ユーザーに拡張の読み込み直しを頼み (`npm run build` 済みの `dist/`)、Claude in Chrome で `docs/manual-check.md` の「詰める欄」の項目を
順に確かめる。`,` `.` は実機のキーで YouTube のコマ送りが起きないことまで見る (Task 4 Step 0 で合成したキーでは確かめられなかった
場合は特に)。**Alt を押しながらのドラッグはユーザーに確かめてもらう** (Claude in Chrome では修飾キー付きのドラッグを再現しにくい)。
見つけた不具合は直して commit してから次へ進む。

---

## 完了後

1. `npx vitest run` と `npm run typecheck` (timeout 300000)、`npx playwright test` (timeout 600000) で green を確認 (既知の失敗 1 本を除く)
2. whole-branch cross-review: `BASE=$(git -C . merge-base develop HEAD)` からの diff を 1 ファイルにまとめ、新しい subagent に subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる。指摘は直して再レビュー (手順は cross-review スキル)
3. plan の末尾に「完了の記録」と「1c-2 に持ち越すもの」を書いて commit
4. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ

## 自律判断ログ

- [選択] 拡大バーを作り直さず、詰める欄の芯に使う — ハンドル・再生位置・トラックを押して再生・録画中の打ち切りがもう揃っていて、テストも厚い。波形 (段階 2) はトラックの中に描き足せる
- [選択] 窓は区間の前後 2 秒だけ (モック)。手を離したら映し直す — 前後 2 秒より外へ伸ばすときはもう一度端まで引く。大きく動かすのは IN / OUT と欄の行の役目
- [選択] 吸い付きの幅は画面の距離 (8px) — 秒で決めると、長い区間 (60 秒) の窓では吸い付きすぎ、短い区間では効かない
- [選択] 吸い付き先は掴んだときに 1 回だけ引く — 動かしている間に文字起こしの読み込みが済んでも、指の下で吸い付き先が変わらない
- [選択] `,` `.` は詰める欄にフォーカスがあるときだけ受け、YouTube へ渡さない — YouTube は止めている間の `,` `.` をコマ送りに使う。ページ全体で受けると、動画を見ながらのコマ送りを奪う
- [選択] キーの端は、最後に掴んだハンドルか最後に押した ±0.1 の端。はじめは頭 — モック「選んでいる端を動かす」。端を選ぶだけの操作を増やさない
- [選択] ±0.1 は動かした端の映像を出す (止めてその位置へ) — 0.1 秒の違いは見ないと分からない。ドラッグの追従 (`onScrub`) と同じ
- [選択] 全区間の合計は録画ボタンではなく詰める欄の見出しに出す — モックは「● 録画 24.6 秒」だが、ボタンの文字を変えると e2e と単体テストがボタンを文字で探しているので 10 か所以上直すことになる。見出しに出せば読める
- [選択] (cross-review 1 回目 → 回答 2026-11-03「行を詰めて最小に (推奨)」) 詰める操作 (±0.1・▶) は見出しの行に入れ、詰める操作だけの行を作らない — モックどおり別の行にすると 1440x795 でバーが 80〜100px 伸び、プレイヤーの下端を覆う (README の制約)。1 行にまとめても見出しの行と単語の段で 60px ほど伸びる。見積もり (前の実測 636〜776px) では帯の段 (34px) を外しても 795 を数 px 超えるので、1c-2 で実測して背の削り方を決める。README と manual-check の制約をそのように書き換える
- [選択] (cross-review 1 回目) 見出しと ‹ › はモックの文言 (「区間 2 を詰める」「‹ 区間 1」「区間 3 ›」)。端では番号を出さず「‹」「›」だけにして押せなくする
- [選択] ▶ の文字は「▶ 頭」「▶ 尻」に縮め、モックの「頭の 2 秒前から」「尻をまたいで」は title に出す — 見出しの行 1 本に収めるため
- [選択] (cross-review 1 回目) キーで動く端は「頭」「尻」の組に下線と濃い文字で示す — モックの「選んでいる端」が見えないと、次の `.` でどちらが動くか分からない。色だけに頼らない
- [選択] (cross-review 1 回目) YouTube のキーの受け方は作る前に実機で確かめる (Task 4 Step 0) — 外れていたら window の capture で受ける代わりの手に替える。外れたと分かるのが実機の確かめ (Task 6) だと、作り直しが大きい
- [選択] 吸い付いたときの「単語の切れ目に合わせました」の吹き出しは出さない — ハンドルが単語の端に揃うことで見て分かる。吹き出しの出し入れの規則 (いつ消すか) を増やさない
- [選択] 区間の見出し (欄の「区間 2 · 詰めている」) は 1c-2 — 区間の一覧を外すときに、選ぶ場所として欄の見出しを作る。1c-1 の選び方は ‹ › と、欄の行を押したとき (今もその区間が選ばれる)
- [選択] 帯は詰める欄の中に移すだけで直さない — 窓が前後 2 秒になると帯で動かせる範囲が狭くなるが、1c-2 で撤去する
```
- [cross-review] plan を 2 回 (ゼロ context の実装者。2 回とも複製に Task 2〜5 を当てて vitest / tsc で確かめた)。1 回目は Needs Human (バーの高さ) を利用者に聞き「行を詰めて最小に」。2 回目の Issues 3 件 (帯のテストの掴む x、1440x795 の既存の確かめ項目、spike の代わりの手の確かめ) は直した。指摘はどれも具体的な直しで閉じたので、3 回目は回さず実装に引き継ぐ
- [実機] (Task 4 Step 0、2026-11-03) 合成した `.` の keydown を、bubble で止める箱から送ると currentTime は動かず (127.770 → 127.770)、body から送ると 1 コマ進んだ (→ 127.804)。YouTube は合成したキーにも反応し、根の bubble で止まる。設計のまま (代わりの手は使わない)
- [実機] (Task 6 Step 2、2026-11-03) `npm run check:telop` は 1440x795 の 2 判定 (受け入れ条件・下の枠に落とす) だけ落ち、ほかは通過。下の枠のバーは 628.25〜804.25 (高さ 176px、帯 2 段 + 「+1」のとき)。画面の下 795 を 9.25px はみ出す。帯の段 (34px) を外せば 770 前後で収まる見込み (cross-review の見積もり「外しても数 px 超える」より小さかった)。1c-2 で帯を外した後に同じ判定で確かめる
- [実機] (Task 6 Step 4、2026-11-03、普段の Chrome) manual-check の「詰める欄」を確かめた: 行を押すと見出しが「区間 N を詰める」で前後 2 秒が映る / ‹ 区間 3・区間 5 › で移る / 尻 ＋0.1 で 0.1 秒伸びその位置の映像が出る / 欄を触った後の実キーの `.` `,` で尻が動きコマ送りは起きない / プレイヤーを触った後の `.` は YouTube のコマ送り (欄は動かない) / ▶ 頭 831.0→835.0、▶ 尻 833.6→837.6 で止まる / 尻のハンドルを 0.5 秒引くと離した所で窓を映し直し、下線が尻へ移る / 自動字幕の短い動画で頭のハンドルを単語の頭の 5px 右で離すと単語の頭 (1:01.48) に吸い付く / 録画中はボタン・キー・‹ が効かず薄い。Alt のドラッグはユーザーに頼む
- [実機で見つけて直した] キーで動く端の下線が組の中のボタンの文字にも継がれていた (「頭」「尻」の文字だけに付けた)

## 完了の記録 (2026-11-03)

- Task 1〜6 を commit (73baccf / 61cc775 / f23b78c / a8acc15 / 99149ef / f6dbb71)。Task 6 は check:telop と普段の Chrome で確かめた (上の [実機] の行)。実機で直した: キーで動く端の下線 (36bd95c)
- whole-branch review (保守担当 + 攻撃者、2 回) で直した: ±0.1 を答えを待たずに積むと巻き戻り、並べ替わった後は隣の区間を書き換える (7d50e35 → 待つ範囲を覚える形に 44875ca)、ページを開いた直後に欄の行を続けて押すと先の行の区間が選ばれる (7d50e35、1b-2 からの形)、単語の段の hidden が効かない・録画の準備中のキーが YouTube へ抜ける・丸めで 1 秒を割る (016f316)、掴んで離すだけで ADJUST を送る (7d50e35)。文書 44026f3
- check:telop を直した後に回し直しても、1440x795 は 628.25〜804.25 で 9.25px はみ出す (空の単語の段を隠しても変わらない = 帯の段の分)
- Alt を押しながらのドラッグはユーザーが確かめた (2026-11-03「123 おｋ」: 単語の切れ目に吸い付く・Alt で吸い付かない)

### 1c-2 に持ち越すもの

- 1440x795 で 9.25px はみ出す。帯の段 (34px) を外した後に check:telop の 2 判定で確かめる
- 長い配信 (保存の予算を超える) は単語の時刻を落として保存するので、単語の並びも吸い付きも行ごとになる。単語を落とさずに済む保存の仕方 (単語だけ別に持つ・圧縮) を検討する
- 有効・無効の決め方が重なっている (`refreshTrimPanel` の中と `rangeBar.setEnabled` の隣) / `refreshLists` が `refreshTrimPanel` を 2 回通る。一覧を外すときに有効の決め方ごと見直す
- ±0.1 の待ちが下りる道は状態の通知だけ。同報が落ちると次の通知まで ±0.1 とキーが黙って効かない (キーは飲み込む)。待つ間はボタンを薄くするか、待ちに上限を付ける
- テロップの帯のドラッグ・OUT など、区間の範囲以外を送った直後の往復の間に ±0.1 を押すと、その通知で手元が巻き戻りうる (並びは変わらないので隣の区間は書き換えない)
- トラックを押して再生しても欄にフォーカスは移らない (キーは効かない。README は「ハンドルかボタンを触った後」)
- 前からの持ち越し (2026-11-03-transcript-panel.md の末尾) はそのまま
