# エディットモード (1) 複数区間の結合 実装プラン

> **実装者向け:** このプランはこのスレッドで直列に消化する。step は `- [ ]` で track する。

**Goal:** 設定で選ぶエディットモードを足し、同じ動画の中の複数区間を 1 本の
クリップに結合して X へ投稿できるようにする。シンプルモード (現状) の挙動は変えない。

**Architecture:** 状態機械が持つ `range: ClipRange` を `segments: ClipRange[]` に
置き換え、区間列に対する純粋関数を `shared/timeline.ts` に集める。録画は
`MediaRecorder` を 1 本走らせたまま、区間の間だけ `pause()` / `resume()` して繋ぐ。
UI は既存の拡大バーを「選択中の区間を編集する道具」として据え置き、一覧を
`content/segment-list.ts` に新設する。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Chrome Extension MV3

## Global Constraints

### Spec 由来 (spec から逐語コピー)

- **シンプルモードは「`segments` の長さが常に 1」という不変条件**で表す。
  モードごとに状態型を分けない
- **`range` と `segments` を両方持たせる案は採らない。** どちらが真かが状態
  ごとに変わり、同期漏れが必ず出る
- **状態機械はモードを知らない。** `reduce` が知るのは「置き換える」か
  「足す」かだけ。モードという概念は content script に閉じる
- **`normalize` は `reduce` の中で呼ぶ。** 呼び出し側に任せると、router 経由の
  経路で漏れたときに不正な `segments` が状態に入る
- **区間に ID を振る案は採らない。** index のずれは `indexAt` で解く
- **並べ替えを自動にするのは、録画中のシークが常に前進になるため。** 巻き戻し
  シークはバッファの再読み込みが入りやすく、繋ぎ目の品質が落ちる
- **`resume()` を呼ぶ条件を厳しくする。** `seeked` → `playing` →
  `requestVideoFrameCallback` が 1 回発火する、の順で待つ。雑にすると繋ぎ目に
  前の場面が数フレーム混入する
- **取れない環境ではフォールバックしない。** この拡張は Chrome 専用であり、
  `requestVideoFrameCallback` が取れないなら繋ぎ目の品質を保証できないので
  `internal-error` で落とす
- **広告の検査を区間ごとに行う。** `resume()` の直前にも検査し、広告なら
  `FAIL("ad-playing")` で全体を落とす
- **進捗は状態機械に持たせない。** 「何区間目か」は content script のローカル
  変数で持つ
- **区間の間のシーク中も状態は `recording` のまま。** `seeking` に戻すと
  `CANCEL_RECORDING` の意味が変わる
- 合計長は `totalSec(segments) <= maxClipSec`。**個々の区間ではない**
- **区間の数に上限を設けない。** 合計長の制約で実質的に縛られる
- **合計が最大秒数を超えていても `ADD_SEGMENT` は通す。** 超過は録画に進めない
  ことで示す
- **`range-bar.ts` は複数対応させない。** 入出力は今まで通り `ClipRange`
- **全区間の通し再生は作らない。** 録画そのものが通し再生を兼ねている
- **モードを変えたら作りかけの区間は全部消す。** 録画中は変更できない
- **新しい失敗理由は足さない。** 起きうる失敗は既存の理由で表せる
- **`key` を見た分岐は入れない。** パネルが見るのは `scope` と `control` だけ
- **`segments` を nullable のまま残さない。** 空配列と `null` の両方が
  「区間なし」を意味する状態を作ると、判定が 2 通りに割れる

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定と、
このリポジトリの既存 commit / コードから読み取れる慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **Fail Fast**: silent skip / try-catch して続行 を禁止する。握りつぶすなら
  「なぜ握りつぶしてよいか」をコメントで説明する
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する**
  (このため Task 2 をコードより前に置いている)
- `cd <dir> && git ...` ではなく `git -C <dir> ...` を使う
- 動画の再生位置 (秒) と壁時計時刻を混同しない
- commit message の末尾に `Claude-Session:` trailer を付ける
  ※ 既存 commit は `https://claude.ai/code/session_...` 形式だが、このセッションで
  取得できるのはローカルのセッション ID のみ。
  `Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2` と書く
- 版番号の出どころは `package.json` の 1 箇所だけ。`manifest.config.ts` は手で直さない
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」**
  を書く。既存コードの密度に合わせる

### 運用前提 (brainstorming で確定した実装方式)

- 隔離: branch のみ (worktree なし)。branch 名 `feat/edit-mode-segments` (作成済み)
- 並列: 直列 (SDD ではない)。このスレッドで Task 1 から順に消化する
- spec は `b6ce322` で commit 済み
- サブプロジェクト 2 (書き出しパイプライン) / 3 (テロップ) はこの plan の範囲外

---

### Task 1: pause/resume が実機で繋がることを確かめる

**Files:**
- Modify: `.claude/specs/2026-09-23-edit-mode-segments-design.md`

**Gate: human**

※ リスク昇格リストには該当しないが、**実ブラウザでの目視確認が必要**で自動で
先に進めない。また結果次第で Task 7 / 11 の設計が変わる。

**Interfaces:**
- Consumes: なし
- Produces: 検証結果 (spec §9 への追記)。Task 7 / 11 の前提

spec §9 の未検証の前提を潰す。**ここが崩れると設計の退避が要るので、コードを
1 行も書く前に確かめる。**

- [x] **Step 1: 検証スニペットをユーザーに渡す**

YouTube の適当な動画 (3 分以上・広告なし・1080p) を開く。

**貼る前に動画を再生しておくこと。** DevTools の Console から呼ぶ `play()` は
user gesture を持たないため、停止したまま貼ると再生が始まらず検証にならない。
一度再生してからコンソールを開き、以下を貼って実行する。

```javascript
(async () => {
  const video = document.querySelector("video");
  const MIME = 'video/mp4;codecs="avc1.640028,mp4a.40.2"';
  const stream = video.captureStream();
  const rec = new MediaRecorder(stream, { mimeType: MIME });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const seekTo = (sec) =>
    new Promise((resolve) => {
      video.addEventListener("seeked", resolve, { once: true });
      video.currentTime = sec;
    });
  const freshFrame = () =>
    new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 区間 1: 60 秒から 3 秒
  await seekTo(60);
  await video.play();
  await freshFrame();
  rec.start(1000);
  await wait(3000);
  rec.pause();
  video.pause();

  // 区間 2: 120 秒から 3 秒
  await seekTo(120);
  await video.play();
  await freshFrame();
  rec.resume();
  await wait(3000);
  video.pause();

  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: MIME }));
    rec.stop();
  });

  // MediaRecorder の出力は duration が Infinity になることがある。
  // 末尾まで seek させて確定させる
  const probe = document.createElement("video");
  probe.src = URL.createObjectURL(blob);
  await new Promise((r) => probe.addEventListener("loadedmetadata", r, { once: true }));
  if (!Number.isFinite(probe.duration)) {
    await new Promise((r) => {
      probe.addEventListener("seeked", r, { once: true });
      probe.currentTime = 1e9;
    });
  }
  console.log("[検証] 出力の長さ:", probe.duration, "秒 (期待: 6 秒前後)");
  console.log("[検証] サイズ:", blob.size, "bytes");
  console.log("[検証] 再生して繋ぎ目を見る:", probe.src);
})();
```

- [x] **Step 2: 結果を判定する**

出力された URL を新しいタブで開いて再生し、次の 3 点を確認する。

| 見るところ | 通る条件 |
|---|---|
| 出力の長さ | **6 秒前後** (5.5〜6.5 秒)。12 秒近い場合は pause 中も記録されている |
| 繋ぎ目の映像 | 60 秒地点の場面が 120 秒地点に混入していない |
| 繋ぎ目の音 | 映像と音がずれていない。無音区間が挟まっていない |

- [x] **Step 3: 結果を spec に追記する**

`.claude/specs/2026-09-23-edit-mode-segments-design.md` の §9 末尾に追記する。
**通った場合:**

```markdown
### 9.1 検証結果 (2026-09-23)

実機 (Chrome / YouTube) で 2 区間 × 各 3 秒を録り、**出力は N 秒**だった。
繋ぎ目に前の場面の混入はなく、音ズレも確認できなかった。
**この設計のまま進める。**
```

**通らなかった場合はここで止まる。** 結果を追記したうえで、区間ごとに別 Blob を
録る設計へ倒す判断をユーザーに仰ぐ。その場合この plan は破棄し、サブプロジェクト
2 (書き出しパイプライン) の spec から書き直すことになる。

- [x] **Step 4: commit**

```bash
git add .claude/specs/2026-09-23-edit-mode-segments-design.md
git commit -m "$(cat <<'MSG'
docs(specs): pause/resume で繋がることを実機で確かめた

タイムスタンプが連続するかは仕様の意図でしかなく、実装がどう振る舞うかは
動かさないと分からなかった。ここが崩れると設計ごと退避が要るため、コードを
書く前に確かめた。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 2: ドキュメントを先に直す

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-check.md`

**Interfaces:**
- Consumes: Task 1 の検証結果
- Produces: なし (以降のタスクが満たすべき受け入れ条件)

**コードより先にドキュメントを直す** (PJ 恒久ルール)。ここで書いた挙動が
以降のタスクの受け入れ条件になる。

- [x] **Step 1: README に使い方とモードを書く**

`README.md` の「## 使い方」の直後に節を足す。

```markdown
## モード

⚙ の **モード** で切り替える。

- **シンプル** (既定) — 1 つの範囲を切り抜く。上の「使い方」のとおり
- **エディット** — 同じ動画の中の複数箇所を拾って 1 本に繋ぐ

エディットモードでは IN を押すたびに区間が増え、一覧から選んで拡大バーで
調整する。録画は区間を順に辿って 1 本のクリップにする。

**モードを変えると作りかけの区間は消える。** 録画中は変えられない。
```

- [x] **Step 2: README の「できないこと・制約」に追記する**

`## できないこと・制約` の箇条書きの末尾に足す。

```markdown
- **結合できるのは同じ動画の中だけ**。別の動画の切り抜きは繋げられない
- **区間は時系列に並び替えられる**。拾った順ではなく動画の時間順に繋がる。
  録画中のシークを常に前進にするため (巻き戻しシークはバッファの再読み込みが
  入りやすく、繋ぎ目の品質が落ちる)
- **重なった区間は 1 つに繋がる**。`1:23→1:38` と `1:30→1:45` を拾うと
  `1:23→1:45` になる
- **最大長は合計で見る**。区間ごとではないので、20 秒の区間を 4 つ作ると
  既定の 60 秒を超えて録画に進めない
- **録画にかかる実時間は合計長 + 区間の間のシーク**。区間が増えるほど
  待ち時間も伸びる
```

- [x] **Step 3: README の spec 一覧にリンクを足す**

`設計は以下を参照。` の箇条書き末尾に足す。

```markdown
- [`.claude/specs/2026-09-23-edit-mode-segments-design.md`](.claude/specs/2026-09-23-edit-mode-segments-design.md) — エディットモードと複数区間の結合
```

- [x] **Step 4: 手動確認に節を足す**

`docs/manual-check.md` の `## 制約の確認` の直前に節を足す。

```markdown
## エディットモード (複数区間の結合)

### 区間の指定

- [ ] ⚙ でモードをエディットに変えると、バーに区間の一覧が出る
- [ ] IN を押すたびに一覧へ行が増える
- [ ] 行を選ぶと拡大バーがその区間に切り替わる
- [ ] **重なる区間を作るとマージされ、選択が迷子にならない** (マージ先が
      選ばれたままになる)
- [ ] **拾う順を逆にしても、一覧は動画の時間順に並ぶ**
- [ ] ✕ で区間を消せる。全部消すと一覧が消えて IN の前の状態に戻る
- [ ] 合計が最大秒数を超えると合計の表示が警告色になり、録画が押せない
- [ ] **モードをシンプルに戻すと一覧が消え、区間も消える**
- [ ] **録画中はモードを変えられない**

### 結合の録画

- [ ] 2 区間 (各 5 秒) を録って、**出力が 10 秒ちょうど**になる
- [ ] **繋ぎ目で前の場面のフレームが混入していない**
- [ ] **繋ぎ目で音がずれていない / 途切れ方が不自然でない**
- [ ] 3 区間以上でも同じ
- [ ] 区間の間のシーク中に「2 / 3 区間目へ移動中…」が出る
- [ ] **区間の間で「中止」を押すと止まり、区間は残る**
- [ ] 区間の間のシーク後に広告が始まったら、広告の理由で止まる
- [ ] 結合したクリップが X に添付でき、X 上でインライン再生される
- [ ] popup に「2 区間 / 30 秒」のように出る
```

- [x] **Step 5: commit**

```bash
git add README.md docs/manual-check.md
git commit -m "$(cat <<'MSG'
docs: エディットモードの挙動と確認項目を先に決める

コードより先にドキュメントを直す。ここで書いた挙動が実装の受け入れ条件に
なるため、実装しながら仕様を決める順序にしない。

結合が同じ動画に限られること、区間が時間順に並び替えられること、最大長が
合計で効くことは、どれも使う前に知らないと驚く制約なので明示した。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 3: 区間列の純粋関数を `shared/timeline.ts` に作る

**Files:**
- Create: `src/shared/timeline.ts`
- Test: `tests/shared/timeline.test.ts`

**Interfaces:**
- Consumes: `ClipRange` (`@/shared/types`)
- Produces: `normalize(segments)`, `totalSec(segments)`, `indexAt(segments, sec)`,
  `toSourceTime(segments, outputSec)`

**`content/` ではなく `shared/` に置く。** `reduce` (background) が `normalize` を
呼ぶため。

- [x] **Step 1: 失敗するテストを書く**

`tests/shared/timeline.test.ts` を新規作成:

```typescript
import { describe, expect, test } from "vitest";
import { indexAt, normalize, toSourceTime, totalSec } from "@/shared/timeline";
import type { ClipRange } from "@/shared/types";

const seg = (startSec: number, endSec: number): ClipRange => ({ startSec, endSec });

describe("normalize", () => {
  test("空配列はそのまま", () => {
    expect(normalize([])).toEqual([]);
  });

  test("動画の時間順に並べ替える", () => {
    expect(normalize([seg(242, 250), seg(83, 98)])).toEqual([
      seg(83, 98),
      seg(242, 250),
    ]);
  });

  test("重なった区間は 1 つに繋ぐ", () => {
    expect(normalize([seg(83, 98), seg(90, 105)])).toEqual([seg(83, 105)]);
  });

  test("隣接した区間も繋ぐ。間に切れ目はない", () => {
    expect(normalize([seg(83, 98), seg(98, 105)])).toEqual([seg(83, 105)]);
  });

  test("内側に完全に含まれる区間を飲み込む", () => {
    expect(normalize([seg(83, 120), seg(90, 105)])).toEqual([seg(83, 120)]);
  });

  test("3 つ以上が数珠つなぎでも 1 つになる", () => {
    expect(normalize([seg(10, 20), seg(18, 30), seg(25, 40)])).toEqual([
      seg(10, 40),
    ]);
  });

  test("離れた区間は繋がない", () => {
    expect(normalize([seg(10, 20), seg(30, 40)])).toEqual([
      seg(10, 20),
      seg(30, 40),
    ]);
  });

  test("元の配列を壊さない", () => {
    const input = [seg(30, 40), seg(10, 20)];
    normalize(input);
    expect(input).toEqual([seg(30, 40), seg(10, 20)]);
  });

  test("不正な区間は握り潰さず throw する", () => {
    // UI のバグ。黙って直すと、録画に実時間を払った後で気付くことになる
    expect(() => normalize([seg(-1, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(10, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(20, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(Number.NaN, 10)])).toThrow(RangeError);
    expect(() => normalize([seg(0, Number.POSITIVE_INFINITY)])).toThrow(RangeError);
  });
});

describe("totalSec", () => {
  test("区間の長さを足す", () => {
    expect(totalSec([seg(83, 98), seg(242, 250)])).toBe(23);
  });

  test("空なら 0", () => {
    expect(totalSec([])).toBe(0);
  });
});

describe("indexAt", () => {
  const segments = [seg(10, 20), seg(30, 40)];

  test("その秒を含む区間を返す", () => {
    expect(indexAt(segments, 15)).toBe(0);
    expect(indexAt(segments, 35)).toBe(1);
  });

  test("境界は含む", () => {
    expect(indexAt(segments, 10)).toBe(0);
    expect(indexAt(segments, 20)).toBe(0);
  });

  test("どの区間にも入らなければ -1", () => {
    expect(indexAt(segments, 25)).toBe(-1);
    expect(indexAt(segments, 0)).toBe(-1);
  });

  test("空配列なら -1", () => {
    expect(indexAt([], 15)).toBe(-1);
  });
});

describe("toSourceTime", () => {
  // 出力 0〜15 秒が 83〜98、15〜23 秒が 242〜250 に対応する
  const segments = [seg(83, 98), seg(242, 250)];

  test("最初の区間の中", () => {
    expect(toSourceTime(segments, 0)).toBe(83);
    expect(toSourceTime(segments, 5)).toBe(88);
  });

  test("区間をまたぐ", () => {
    expect(toSourceTime(segments, 15)).toBe(242);
    expect(toSourceTime(segments, 20)).toBe(247);
  });

  test("出力の長さを超えたら null", () => {
    expect(toSourceTime(segments, 23)).toBeNull();
    expect(toSourceTime(segments, 100)).toBeNull();
  });

  test("負の秒は null", () => {
    expect(toSourceTime(segments, -1)).toBeNull();
  });

  test("空配列なら null", () => {
    expect(toSourceTime([], 0)).toBeNull();
  });
});
```

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/timeline.test.ts`
期待: FAIL (`Failed to resolve import "@/shared/timeline"`)

- [x] **Step 3: 最小実装**

`src/shared/timeline.ts` を新規作成:

```typescript
/**
 * 出力クリップを構成する区間列に対する計算。
 *
 * **`content/` ではなく `shared/` に置く。** `reduce` (background) が
 * `normalize` を呼ぶため。`content/range-math.ts` は拡大バーの座標計算なので
 * content のままでよい。
 */

import type { ClipRange } from "@/shared/types";

/**
 * 区間として成立しているかを確かめる。
 *
 * **握り潰して直さない。** ここに不正な値が来るのは UI のバグであり、
 * 黙って補正すると、録画に実時間を払い切った後で「思っていたのと違う範囲が
 * 録れた」と気付くことになる。
 */
function assertValidRange(range: ClipRange): void {
  const { startSec, endSec } = range;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new RangeError(
      `区間の秒が数値ではありません: ${String(startSec)}-${String(endSec)}`,
    );
  }
  if (startSec < 0) {
    throw new RangeError(`区間の開始が負です: ${startSec}`);
  }
  if (endSec <= startSec) {
    throw new RangeError(`区間の終了が開始以下です: ${startSec}-${endSec}`);
  }
}

/**
 * 区間を動画の時間順に並べ、重なり・隣接を 1 つに繋ぐ。
 *
 * **並べ替えを自動にするのは、録画中のシークを常に前進にするため。**
 * 巻き戻しシークはバッファの再読み込みが入りやすく、繋ぎ目の品質が落ちる。
 * 順序をユーザーに委ねる代わりに、繋ぎの確実さを取っている。
 *
 * **重なりをエラーにせずマージするのは、** 拡大バーのドラッグで隣の区間に
 * 触れるたびに手を止めさせないため。マージは情報を失わない (拾いたかった
 * 範囲はすべて出力に入る) ので、拒否する理由が弱い。
 */
export function normalize(segments: ClipRange[]): ClipRange[] {
  for (const segment of segments) {
    assertValidRange(segment);
  }

  // 引数の配列は呼び出し側 (状態機械の前の状態) のものなので複製してから並べる
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);

  const merged: ClipRange[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    // `<=` にして隣接 (前の終わり === 次の始まり) も繋ぐ。間に切れ目はない
    if (last !== undefined && segment.startSec <= last.endSec) {
      merged[merged.length - 1] = {
        startSec: last.startSec,
        // 内側に完全に含まれる区間を飲み込んでも終端が縮まないようにする
        endSec: Math.max(last.endSec, segment.endSec),
      };
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/**
 * 出力クリップの合計の長さ (秒)。
 *
 * **最大秒数はこれで見る。区間ごとではない。** 区間ごとに上限を見ると、
 * 10 秒の区間を 10 個作れてしまい、X の上限を超えたクリップができる。
 */
export function totalSec(segments: ClipRange[]): number {
  return segments.reduce(
    (sum, segment) => sum + (segment.endSec - segment.startSec),
    0,
  );
}

/**
 * その秒を含む区間の index。含む区間が無ければ -1。
 *
 * **区間に ID を振る代わりにこれを使う。** 並べ替えとマージで index は動くが、
 * UI は「いま触っていた区間の開始秒」でこれを引き直せば選択を追える。
 * マージで消えた区間を選んでいた場合もマージ先が返る。
 */
export function indexAt(segments: ClipRange[], sec: number): number {
  return segments.findIndex(
    (segment) => sec >= segment.startSec && sec <= segment.endSec,
  );
}

/**
 * 出力タイムラインの `outputSec` 秒が、元動画の何秒に当たるか。範囲外なら null。
 *
 * **この spec では使わない。それでも今のうちに置く。** 出力タイムラインという
 * 座標系を後から導入すると、テロップの時刻が元動画の秒で書かれた状態が先に
 * 出来上がってしまい、移行が要る (spec §0.1)。
 */
export function toSourceTime(
  segments: ClipRange[],
  outputSec: number,
): number | null {
  if (outputSec < 0) return null;

  let elapsed = 0;
  for (const segment of segments) {
    const length = segment.endSec - segment.startSec;
    if (outputSec < elapsed + length) {
      return segment.startSec + (outputSec - elapsed);
    }
    elapsed += length;
  }
  return null;
}
```

- [x] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/shared/timeline.test.ts && npm run typecheck`
期待: PASS (テスト 20 件前後) / 型エラーなし

- [x] **Step 5: commit**

```bash
git add src/shared/timeline.ts tests/shared/timeline.test.ts
git commit -m "$(cat <<'MSG'
feat(timeline): 区間列の計算を純粋関数として置く

状態機械が区間の配列を持つようになるため、その計算を 1 箇所に集める。
background から呼ぶので content ではなく shared に置いた。

toSourceTime はこの機能では使わない。テロップの時刻は出力タイムライン基準に
なるため、座標系を後から導入すると元動画の秒で書かれた状態からの移行が要る。
先に置いておく方が安い。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---
### Task 4: 設定パネルが選択肢を出せるようにする

**Files:**
- Modify: `src/shared/settings.ts`
- Modify: `src/content/settings-panel.ts`
- Test: `tests/content/settings-panel.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `FieldControl`, `SelectOption`, `SettingsField.control`

`SETTINGS_FIELDS` はテキスト入力欄専用になっており、パネルは各 field に対して
`input type="text"` を 1 つ作るだけで選択肢を出す道がない。モードは自由入力に
できる値ではないので、先に枠を広げる。**モード項目そのものは Task 5 で足す。**

- [x] **Step 1: 失敗するテストを書く**

`tests/content/settings-panel.test.ts` の末尾に `describe` を足す:

```typescript
describe("入力欄の種類", () => {
  test("text の項目は input として出る", () => {
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    document.body.append(panel.element);

    const input = panel.element.querySelector("#yt-clip-setting-maxClipSec");
    expect(input?.tagName).toBe("INPUT");
  });

  test("select の項目は option つきの select として出る", () => {
    // 実際の項目 (mode) は Task 5 で足す。ここでは枠組みだけを確かめる
    const field: SettingsField = {
      key: "dummy",
      label: "ダミー",
      scope: "global",
      control: {
        kind: "select",
        options: [
          { value: "a", label: "あ" },
          { value: "b", label: "い" },
        ],
      },
      hint: () => "",
      toText: () => "b",
      fromText: () => ({ ok: true, patch: {} }),
    };

    const element = createFieldInput(field);
    expect(element.tagName).toBe("SELECT");
    expect([...element.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "a",
      "b",
    ]);
    expect([...element.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "あ",
      "い",
    ]);
  });
});
```

import に `createFieldInput` と `type SettingsField` を足す:

```typescript
import { createFieldInput, createSettingsPanel } from "@/content/settings-panel";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  type Settings,
  type SettingsContext,
  type SettingsField,
} from "@/shared/settings";
```

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/settings-panel.test.ts`
期待: FAIL (`createFieldInput` が export されていない / `control` が型に無い)

- [x] **Step 3: `settings.ts` に `control` を足す**

`SettingsField` の定義の直前に型を足す:

```typescript
/** 選択肢 1 つ分 */
export type SelectOption = { value: string; label: string };

/**
 * 入力欄の種類。
 *
 * **パネルはこれを見て作り分ける。`key` を見て分岐しない。** key で分岐すると、
 * 項目を足すたびにパネルへ戻ってくることになり、「触るのは `Settings` と
 * `SETTINGS_FIELDS` の 2 箇所だけ」という性質が崩れる。
 */
export type FieldControl =
  | { kind: "text" }
  | { kind: "select"; options: readonly SelectOption[] };
```

`SettingsField` に 1 行足す (`scope` の直後):

```typescript
  /** 入力欄の種類。パネルはこれを見て作り分ける */
  control: FieldControl;
```

既存の 2 項目に `control` を書く。`hashtags` の `scope: "channel",` の直後と、
`maxClipSec` の `scope: "global",` の直後に、それぞれ:

```typescript
    control: { kind: "text" },
```

- [x] **Step 4: パネルを作り分ける**

`src/content/settings-panel.ts` の import に `SettingsField` を足す:

```typescript
import {
  SETTINGS_FIELDS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsContext,
  type SettingsField,
} from "@/shared/settings";
```

`createSettingsPanel` の直前に関数を足す:

```typescript
/** 入力欄として振る舞う要素。`value` と `disabled` はどちらも持つ */
export type FieldInput = HTMLInputElement | HTMLSelectElement;

/**
 * 項目 1 つ分の入力欄を作る。
 *
 * **分岐するのは `control` だけ。** `key` を見て分岐すると、項目を足すたびに
 * ここへ戻ってくることになる (`scope` による分岐が `fill` に 1 箇所あるのと
 * 同じ理由で、field 側が宣言した値しか見ない)
 */
export function createFieldInput(field: SettingsField): FieldInput {
  const id = `yt-clip-setting-${field.key}`;

  if (field.control.kind === "select") {
    const select = document.createElement("select");
    select.id = id;
    select.style.cssText = PANEL_STYLE.input;
    select.append(
      ...field.control.options.map((option) => {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        return element;
      }),
    );
    return select;
  }

  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.style.cssText = PANEL_STYLE.input;
  return input;
}
```

`rows` を作っている箇所で、`input` の生成 4 行を 1 行に差し替える。

置き換え前 (`const input = document.createElement("input");` から
`input.style.cssText = PANEL_STYLE.input;` までの 4 行):

```typescript
    const input = document.createElement("input");
    input.id = `yt-clip-setting-${field.key}`;
    input.type = "text";
    input.style.cssText = PANEL_STYLE.input;
```

置き換え後:

```typescript
    const input = createFieldInput(field);
```

`label.htmlFor` は `id` を文字列で組み立てているのでそのままでよい。

- [x] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/settings-panel.test.ts && npm run typecheck`
期待: PASS / 型エラーなし

- [x] **Step 6: commit**

```bash
git add src/shared/settings.ts src/content/settings-panel.ts tests/content/settings-panel.test.ts
git commit -m "$(cat <<'MSG'
feat(settings): 設定項目に選択肢の入力欄を持たせられるようにする

モードは自由入力にできる値ではないが、パネルはテキスト入力欄しか作れなかった。
control を field 側の宣言にして、パネルは key ではなく control を見て作り分ける。
key で分岐すると、項目を足すたびにパネルへ戻ってくることになる。

項目そのものはまだ足していない。枠組みと項目追加を同じコミットに混ぜると、
枠組みの設計だけを見直したくなったときに切り分けられない。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 5: `Settings.mode` を足す

**Files:**
- Modify: `src/shared/settings.ts`
- Test: `tests/shared/settings.test.ts`

**Interfaces:**
- Consumes: Task 4 の `FieldControl`
- Produces: `ClipMode`, `Settings.mode`, `parseMode(input)`

- [x] **Step 1: 失敗するテストを書く**

`tests/shared/settings.test.ts` の末尾に足す:

```typescript
describe("モード", () => {
  test("既定はシンプル", () => {
    expect(DEFAULT_SETTINGS.mode).toBe("simple");
  });

  test("保存された値を読む", () => {
    expect(mergeSettings({ mode: "edit" }).mode).toBe("edit");
  });

  test("知らない値は既定に倒して理由を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeSettings({ mode: "advanced" }).mode).toBe("simple");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("項目として画面に出る", () => {
    const field = SETTINGS_FIELDS.find((f) => f.key === "mode");
    expect(field?.control.kind).toBe("select");
  });
});

describe("parseMode", () => {
  test("受け付ける値", () => {
    expect(parseMode("simple")).toEqual({ ok: true, patch: { mode: "simple" } });
    expect(parseMode("edit")).toEqual({ ok: true, patch: { mode: "edit" } });
  });

  test("知らない値は既定に倒さず理由を返す", () => {
    // 選択肢しか出していないのに別の値が来たら、それは UI のバグ
    const result = parseMode("advanced");
    expect(result.ok).toBe(false);
  });
});
```

import に `parseMode` と `vi` を足す (既存の import 文に追記):

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  mergeSettings,
  parseMode,
} from "@/shared/settings";
```

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/settings.test.ts`
期待: FAIL (`parseMode` が export されていない)

- [x] **Step 3: 最小実装**

`src/shared/settings.ts` の `Settings` の直前に型を足す:

```typescript
/**
 * 切り抜きの作り方。
 *
 * **往復するトグルではなく設定にしてある。** 往復を許すと「シンプルで作った
 * 範囲をエディットに引き継ぐか」という問いが常に付きまとう。固定モードなら
 * 切り替えは稀な操作として扱える。
 */
export type ClipMode = "simple" | "edit";
```

`Settings` に 1 行足す:

```typescript
  /** 切り抜きの作り方。エディットでは複数の区間を結合できる */
  mode: ClipMode;
```

`DEFAULT_SETTINGS` に 1 行足す:

```typescript
  mode: "simple",
```

`isSettableClipSec` の隣に型ガードを足す:

```typescript
/** 保存されている値がモードとして読めるか */
function isClipMode(value: unknown): value is ClipMode {
  return value === "simple" || value === "edit";
}
```

`mergeSettings` の `maxClipSec` の節の後に足す:

```typescript
  if (isClipMode(source.mode)) {
    settings.mode = source.mode;
  } else if (source.mode !== undefined) {
    console.warn(
      `[yt-clip] 保存された mode が使えないため既定値を使います: ${String(source.mode)}`,
    );
  }
```

`parseMaxClipSec` の隣に足す:

```typescript
/**
 * 入力欄の文字列をモードの差分にする。
 *
 * **既定値に倒さない。** 選択肢しか出していないのに別の値が来たら、それは
 * UI のバグである。黙って `simple` にすると、エディットに切り替えたつもりで
 * シンプルのまま録画に進む
 */
export function parseMode(input: string): FieldResult {
  if (!isClipMode(input)) {
    return { ok: false, message: `知らないモードです: ${input}` };
  }
  return { ok: true, patch: { mode: input } };
}
```

`SETTINGS_FIELDS` の先頭 (`hashtags` の前) に項目を足す。**先頭に置くのは、
他の項目の意味がモードによって変わるため** (最大秒数は合計に効く)。

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
  },
```

- [x] **Step 4: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck`
期待: PASS / 型エラーなし

- [x] **Step 5: commit**

```bash
git add src/shared/settings.ts tests/shared/settings.test.ts
git commit -m "$(cat <<'MSG'
feat(settings): モードを設定に足す

エディットモードの入口。バー上のトグルで往復する案は採らなかった。往復を
許すと「シンプルで作った範囲をエディットに引き継ぐか」という問いが常に
付きまとうが、固定モードなら切り替えは稀な操作として扱える。

知らない値は既定に倒さず理由を返す。選択肢しか出していないのに別の値が来たら
UI のバグであり、黙って simple にすると切り替えたつもりで録画に進む。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 6: `range` を `segments[]` へ一括で置き換える

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/background/state.ts`
- Modify: `src/background/router.ts`
- Modify: `src/background/storage.ts`
- Modify: `src/shared/template.ts`
- Modify: `src/popup/view.ts`
- Modify: `src/content/youtube.ts`
- Modify: `.claude/specs/2026-09-23-edit-mode-segments-design.md`
- Test: `tests/background/state.test.ts`
- Test: `tests/background/router.test.ts`
- Test: `tests/background/storage.test.ts`
- Test: `tests/popup/view.test.ts`
- Test: `tests/shared/template.test.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 3 の `normalize` / `totalSec` / `indexAt`
- Produces: `ClipState` の各 kind が `segments: ClipRange[]` を持つ。
  `ADD_SEGMENT` / `ADJUST_SEGMENT` / `MARK_OUT{index}` / `REMOVE_SEGMENT`

**このタスクは分割できない。** 型が全モジュールに繋がっているので、途中で
commit すると型エラーを抱えた状態が残る。**このタスクでは UI は複数区間に
対応させない。** `youtube.ts` は `segments[0]` を読んで従来どおり動かし、
シンプルモードの挙動を変えないことをテストで守る。複数対応は Task 10〜12。

**spec に書き漏らした影響範囲がある。** `StoredClip` と `renderTemplate` も
`range` を持っていた。この 2 つの扱いを決めて spec に追記する (Step 1)。

- [x] **Step 1: spec の影響範囲表を直す**

`.claude/specs/2026-09-23-edit-mode-segments-design.md` の §2.1 の表に 2 行足し、
表の直後に段落を足す。

表に足す行:

```markdown
| `background/storage.ts` | `StoredClip.range` → `segments` |
| `shared/template.ts` | `renderTemplate` が区間列を受ける |
```

表の直後に足す段落:

```markdown
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
```

- [x] **Step 2: 失敗するテストを書く**

`tests/background/state.test.ts` の先頭の共通定義を差し替える:

```typescript
import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { INITIAL_STATE, reduce } from "@/background/state";
import type { ClipRange, ClipState } from "@/shared/types";

const meta = makeVideoMeta();
const range: ClipRange = { startSec: 10, endSec: 40 };
const segments = [range];

const ready: ClipState = { kind: "ready", segments, meta };
const preview: ClipState = {
  kind: "preview",
  clipId: "clip-1",
  segments,
  meta,
  mimeType: "video/mp4",
};
```

既存のテストは `range` を `segments` に読み替える (`state.range` を参照して
いる箇所を `state.segments` に、期待値の `range` を `segments` に)。
そのうえで末尾に `describe` を足す:

```typescript
describe("複数区間", () => {
  const second: ClipRange = { startSec: 100, endSec: 120 };

  test("idle から区間を足すと ready になる", () => {
    expect(reduce(INITIAL_STATE, { type: "ADD_SEGMENT", range, meta })).toEqual({
      kind: "ready",
      segments: [range],
      meta,
    });
  });

  test("ready に区間を足すと並んで増える", () => {
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: second, meta }),
    ).toEqual({ kind: "ready", segments: [range, second], meta });
  });

  test("足した区間は動画の時間順に並ぶ", () => {
    const earlier: ClipRange = { startSec: 1, endSec: 5 };
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: earlier, meta }),
    ).toEqual({ kind: "ready", segments: [earlier, range], meta });
  });

  test("重なる区間を足すと 1 つに繋がる", () => {
    const overlapping: ClipRange = { startSec: 30, endSec: 60 };
    expect(
      reduce(ready, { type: "ADD_SEGMENT", range: overlapping, meta }),
    ).toEqual({ kind: "ready", segments: [{ startSec: 10, endSec: 60 }], meta });
  });

  test("合計が長くなっても区間は足せる", () => {
    // 超過は録画に進めないことで示す。先に縮めてから追加、を強制しない
    const long: ClipRange = { startSec: 1000, endSec: 1200 };
    const next = reduce(ready, { type: "ADD_SEGMENT", range: long, meta });
    expect(next.kind).toBe("ready");
  });

  test("投稿後に区間を足すとクリップは外れる", () => {
    const posted: ClipState = {
      kind: "posted",
      segments,
      meta,
      clipId: "clip-1",
      mimeType: "video/mp4",
    };
    expect(reduce(posted, { type: "ADD_SEGMENT", range: second, meta })).toEqual({
      kind: "ready",
      segments: [range, second],
      meta,
    });
  });

  test("区間を消せる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    expect(reduce(two, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "ready",
      segments: [second],
      meta,
    });
  });

  test("最後の区間を消すと idle に戻る", () => {
    // 区間が 0 個の ready は録画に進めない死に状態なので作らない
    expect(reduce(ready, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "idle",
    });
  });

  test("index を指して区間を動かせる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    const moved: ClipRange = { startSec: 100, endSec: 130 };
    expect(
      reduce(two, { type: "ADJUST_SEGMENT", index: 1, range: moved }),
    ).toEqual({ kind: "ready", segments: [range, moved], meta });
  });

  test("index を指して終端だけ動かせる", () => {
    const two: ClipState = { kind: "ready", segments: [range, second], meta };
    expect(reduce(two, { type: "MARK_OUT", index: 1, sec: 130 })).toEqual({
      kind: "ready",
      segments: [range, { startSec: 100, endSec: 130 }],
      meta,
    });
  });

  test("範囲外の index は握り潰さず内部エラーにする", () => {
    expect(reduce(ready, { type: "REMOVE_SEGMENT", index: 5 })).toEqual({
      kind: "failed",
      reason: "internal-error",
      segments,
      meta,
    });
    expect(
      reduce(ready, { type: "ADJUST_SEGMENT", index: -1, range }),
    ).toEqual({ kind: "failed", reason: "internal-error", segments, meta });
  });

  test("録画中は区間を足せない", () => {
    const recording: ClipState = { kind: "recording", segments, meta };
    expect(
      reduce(recording, { type: "ADD_SEGMENT", range: second, meta }).kind,
    ).toBe("failed");
  });

  test("区間を作る前に落ちた失敗からは idle へ戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      segments: [],
      meta: null,
    };
    expect(reduce(failed, { type: "RETRY" })).toEqual({ kind: "idle" });
  });
});
```

`tests/popup/view.test.ts` に足す:

```typescript
describe("複数区間の表示", () => {
  test("1 区間なら今までどおり範囲で出す", () => {
    const view = describeState({
      kind: "ready",
      segments: [{ startSec: 83, endSec: 98 }],
      meta: makeVideoMeta(),
    });
    expect(view.message).toContain("1:23");
    expect(view.message).toContain("1:38");
  });

  test("複数区間なら区間数と合計で出す", () => {
    const view = describeState({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      meta: makeVideoMeta(),
    });
    expect(view.message).toBe("2 区間 / 23 秒 を録画できます");
  });

  test("録画中の長さは合計で数える", () => {
    const view = describeState({
      kind: "recording",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      meta: makeVideoMeta(),
    });
    expect(view.recordingSec).toBe(23);
  });
});
```

`tests/shared/template.test.ts` に足す:

```typescript
describe("複数区間の本文", () => {
  const segments = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  test("URL と開始は先頭区間から取る", () => {
    expect(renderTemplate("{url} {start}", makeVideoMeta(), segments)).toBe(
      "https://youtu.be/abc123?t=83 1:23",
    );
  });

  test("終了は最終区間から取る", () => {
    expect(renderTemplate("{end}", makeVideoMeta(), segments)).toBe("4:10");
  });

  test("長さは合計。元動画上の幅ではない", () => {
    // 15 + 8 = 23。元動画上の幅 (242-83=159) ではない
    expect(renderTemplate("{duration}", makeVideoMeta(), segments)).toBe("23");
  });
});
```

- [x] **Step 3: 実行して失敗を確認**

実行: `npx vitest run`
期待: FAIL (型エラーおよび `segments` が存在しないことによる多数の失敗)

- [x] **Step 4: `types.ts` を書き換える**

`ClipState` の各 kind の `range: ClipRange` を `segments: ClipRange[]` に置き換える。
`failed` だけは形が変わるので明示する:

```typescript
  /**
   * 区間を作る前に落ちた場合は `segments` が空配列になる。
   *
   * **nullable にしない。** 空配列と `null` の両方が「区間なし」を意味する
   * 状態を作ると、判定が 2 通りに割れる
   */
  | {
      kind: "failed";
      reason: FailureReason;
      segments: ClipRange[];
      meta: VideoMeta | null;
    };
```

`ClipEvent` のマーク系を置き換える:

```typescript
export type ClipEvent =
  /** 範囲の作成 (シンプルモード)。今ある区間を置き換える */
  | { type: "MARK_IN"; range: ClipRange; meta: VideoMeta }
  /**
   * 区間の追加 (エディットモード)。
   *
   * `idle` から受けたときは `MARK_IN` と同じ結果になるので、
   * 「最初の 1 回だけ MARK_IN」という分岐は content script に要らない
   */
  | { type: "ADD_SEGMENT"; range: ClipRange; meta: VideoMeta }
  /** 指した区間の終了位置だけを今の再生位置に合わせる */
  | { type: "MARK_OUT"; index: number; sec: number }
  /** 拡大バーでのドラッグ結果。取りこぼしでずれないよう常に両端を送る */
  | { type: "ADJUST_SEGMENT"; index: number; range: ClipRange }
  | { type: "REMOVE_SEGMENT"; index: number }
  | { type: "RESET_MARKS" }
  // 以下は変更なし
  | { type: "START_RECORDING" }
  ...
```

- [x] **Step 5: `state.ts` を書き換える**

先頭の import に `normalize` を足す:

```typescript
import { normalize } from "@/shared/timeline";
```

`rangeOf` を `segmentsOf` に置き換える:

```typescript
/** 状態が持っている区間列を取り出す。持たない状態では空配列 */
function segmentsOf(state: ClipState): ClipRange[] {
  return "segments" in state ? state.segments : [];
}
```

`invalid` と `FAIL` の分岐で `range: rangeOf(state)` を
`segments: segmentsOf(state)` に置き換える。

`reduce` の中に、区間を組み立てるヘルパーを足す (`invalid` の直後):

```typescript
/**
 * 区間を差し替えて `ready` を作る。
 *
 * **`normalize` はここを必ず通す。** 呼び出し側に任せると、router 経由の
 * 経路で漏れたときに不正な `segments` が状態に入る。`reduce` は純粋関数の
 * ままなので、ここに置いても副作用はない
 */
function readyWith(segments: ClipRange[], meta: VideoMeta): ClipState {
  const normalized = normalize(segments);
  // 区間が 0 個の ready は録画に進めない死に状態なので作らない
  if (normalized.length === 0) return { kind: "idle" };
  return { kind: "ready", segments: normalized, meta };
}

/** UI から届いた index が実在するか。実在しなければ UI のバグ */
function hasIndex(segments: ClipRange[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < segments.length;
}
```

`MARK_IN` の分岐を置き換え、直後に `ADD_SEGMENT` を足す:

```typescript
  if (event.type === "MARK_IN") {
    // 録画中に範囲を作り直させない。状態機械だけが戻って録画が走り続ける
    if (BUSY_KINDS.has(state.kind)) return invalid(state);
    return readyWith([event.range], event.meta);
  }

  if (event.type === "ADD_SEGMENT") {
    if (BUSY_KINDS.has(state.kind)) return invalid(state);
    // idle からは MARK_IN と同じ結果になる。posted からはクリップが外れる
    return readyWith([...segmentsOf(state), event.range], event.meta);
  }
```

`ready` の分岐を置き換える:

```typescript
    case "ready":
      if (event.type === "MARK_OUT") {
        if (!hasIndex(state.segments, event.index)) return invalid(state);
        return readyWith(
          state.segments.map((segment, index) =>
            index === event.index
              ? { startSec: segment.startSec, endSec: event.sec }
              : segment,
          ),
          state.meta,
        );
      }
      if (event.type === "ADJUST_SEGMENT") {
        if (!hasIndex(state.segments, event.index)) return invalid(state);
        return readyWith(
          state.segments.map((segment, index) =>
            index === event.index ? event.range : segment,
          ),
          state.meta,
        );
      }
      if (event.type === "REMOVE_SEGMENT") {
        if (!hasIndex(state.segments, event.index)) return invalid(state);
        return readyWith(
          state.segments.filter((_, index) => index !== event.index),
          state.meta,
        );
      }
      if (event.type === "START_RECORDING") {
        return { kind: "seeking", segments: state.segments, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);
```

`posted` の分岐も同じ 3 イベントを受けるようにする (`ready` と同じ本体で、
`MARK_OUT` / `ADJUST_SEGMENT` / `REMOVE_SEGMENT` を `readyWith` に流す)。
**クリップは外れる。** 他の kind は `range` を `segments` に読み替えるだけ。

`failed` の `RETRY` を置き換える:

```typescript
      if (event.type === "RETRY") {
        if (state.segments.length === 0 || state.meta === null) {
          return { kind: "idle" };
        }
        return { kind: "ready", segments: state.segments, meta: state.meta };
      }
```

- [x] **Step 6: 残りのモジュールを追従させる**

型エラーの出る箇所を機械的に直す。`npm run typecheck` が案内になる。

`src/background/storage.ts`:

```typescript
export type StoredClip = {
  ...
  /** 出力クリップを構成する区間列。古いレコードは `range` しか持たない */
  segments: ClipRange[];
  ...
};

/**
 * 保存されているクリップを読む形に整える。
 *
 * **古いレコードを黙って落とさない。** `segments` を持たないのは
 * 複数区間に対応する前に録ったクリップで、`range` 1 つ分として読めば
 * 投稿には足りる。理由は残す
 */
function migrateClip(stored: StoredClip & { range?: ClipRange }): StoredClip {
  if (Array.isArray(stored.segments)) return stored;
  if (stored.range === undefined) {
    throw new Error(`区間を持たないクリップです: ${stored.id}`);
  }
  console.info(
    `[yt-clip] 区間を持たない古いクリップを 1 区間として読みました: ${stored.id}`,
  );
  return { ...stored, segments: [stored.range] };
}
```

`getClip` の返り値を `migrateClip(found)` で包む。

`src/shared/template.ts`: `renderTemplate` の第 3 引数を
`segments: ClipRange[]` に変え、変数を組み立て直す:

```typescript
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("区間を持たないクリップの本文は組み立てられません");
  }

  const vars: Record<string, string> = {
    title: meta.title,
    videoId: meta.videoId,
    url: buildYouTubeUrl(meta.videoId, first.startSec),
    start: formatTime(first.startSec),
    end: formatTime(last.endSec),
    // **合計長。元動画上の幅ではない。** 区間が 1 つなら結果は従来と同じ
    duration: String(Math.round(totalSec(segments))),
    tags: tagsVariable(hashtags),
  };
```

`src/background/router.ts`: `range: state.range` を
`segments: state.segments` に、`clip.range.startSec` を
`clip.segments[0].startSec` に、`renderTemplate(..., clip.range, ...)` を
`renderTemplate(..., clip.segments, ...)` に置き換える。
`clip.segments[0]` は `migrateClip` が空配列を許さないので必ず存在するが、
`noUncheckedIndexedAccess` が有効なら先頭を変数に取って `undefined` を
`throw` で弾く。

`src/popup/view.ts`: `durationOf` を置き換え、`ready` / `recording` /
`posted` の文言を組み立て直す:

```typescript
import { totalSec } from "@/shared/timeline";
import type { ClipRange } from "@/shared/types";

/** クリップの長さ (秒)。**合計で数える** */
function durationOf(segments: ClipRange[]): number {
  return Math.round(totalSec(segments));
}

/**
 * 区間を人が読める形にする。
 *
 * **1 区間なら今までどおり範囲で出す。** 区間数を常に出すと、シンプルモードで
 * 使っている人に関係のない概念が見えることになる
 */
function segmentsLabel(segments: ClipRange[]): string {
  const only = segments.length === 1 ? segments[0] : undefined;
  if (only !== undefined) {
    return `${formatTime(only.startSec)} 〜 ${formatTime(only.endSec)} (${durationOf(segments)}秒)`;
  }
  return `${segments.length} 区間 / ${durationOf(segments)} 秒`;
}
```

`ready` は `` `${segmentsLabel(state.segments)} を録画できます` ``、
`recording` は `recordingSec: durationOf(state.segments)`、
`posted` は `` `X に添付しました (${durationOf(state.segments)}秒)` `` にする。

`src/content/youtube.ts`: **このタスクでは複数区間に対応させない。**
`state.range` を参照している箇所を `state.segments[0]` に読み替え、
送るイベントを新しい形にするだけに留める。

| 置き換え前 | 置き換え後 |
|---|---|
| `"range" in state ? state.range : null` | `"segments" in state ? (state.segments[0] ?? null) : null` |
| `send({ type: "MARK_OUT", sec })` | `send({ type: "MARK_OUT", index: 0, sec })` |
| `send({ type: "ADJUST_RANGE", range })` | `send({ type: "ADJUST_SEGMENT", index: 0, range })` |
| `state.kind === "ready" && sameRange(state.range, r)` | `state.kind === "ready" && state.segments[0] !== undefined && sameRange(state.segments[0], r)` |
| `state.range.startSec` (prepare/run) | `state.segments[0].startSec` (先頭を変数に取る) |

- [x] **Step 7: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck`
期待: PASS / 型エラーなし。**シンプルモードの既存テストがすべて通ること**が
このタスクの受け入れ条件。

- [x] **Step 8: commit**

```bash
git add -A
git commit -m "$(cat <<'MSG'
refactor: 状態機械が持つ範囲を区間の配列にする

複数区間の結合に向けた土台。range と segments を両方持たせる案は採らなかった。
どちらが真かが状態ごとに変わり、同期漏れが必ず出る。

型が全モジュールに繋がっているため一度で置き換える。UI はまだ複数区間に
対応させず、先頭区間だけを読んで従来どおり動かす。シンプルモードの既存
テストがすべて通ることを受け入れ条件にした。

保存済みクリップと本文テンプレートも range を持っていた。spec の影響範囲に
書き漏らしていたので追記した。古いクリップは 1 区間として読み、理由を残す。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 7: 録画を一時停止・再開できるようにする

**Files:**
- Modify: `src/content/recorder.ts`
- Test: `tests/content/recorder.test.ts`

**Interfaces:**
- Consumes: Task 1 の検証結果
- Produces: `RecorderHandle.pause()`, `RecorderHandle.resume()`

- [x] **Step 1: 失敗するテストを書く**

`tests/content/recorder.test.ts` の末尾に足す:

```typescript
/** jsdom は MediaRecorder を持たないので、状態遷移だけを真似る */
class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: { type: string }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly calls: string[] = [];

  constructor(
    public readonly stream: unknown,
    public readonly options: { mimeType: string },
  ) {}

  start(): void {
    this.state = "recording";
    this.calls.push("start");
  }
  pause(): void {
    this.state = "paused";
    this.calls.push("pause");
  }
  resume(): void {
    this.state = "recording";
    this.calls.push("resume");
  }
  stop(): void {
    this.state = "inactive";
    this.calls.push("stop");
    this.onstop?.();
  }
}

describe("区間の間で一時停止する", () => {
  let created: FakeRecorder[] = [];

  beforeEach(() => {
    created = [];
    vi.stubGlobal(
      "MediaRecorder",
      class extends FakeRecorder {
        constructor(stream: unknown, options: { mimeType: string }) {
          super(stream, options);
          created.push(this);
        }
      },
    );
  });

  /** captureStream を持つ video を用意する */
  function makeCapturable(): HTMLVideoElement {
    const video = document.createElement("video");
    Object.defineProperty(video, "captureStream", {
      value: () => new FakeStream([]),
      configurable: true,
    });
    return video;
  }

  test("一時停止と再開を MediaRecorder に渡す", async () => {
    const handle = await startRecording(makeCapturable(), "video/mp4", {
      onUnexpectedStop: () => undefined,
    });

    handle.pause();
    handle.resume();
    await handle.stop();

    expect(created[0]?.calls).toEqual(["start", "pause", "resume", "stop"]);
  });

  test("一時停止中でも止められる", async () => {
    const handle = await startRecording(makeCapturable(), "video/mp4", {
      onUnexpectedStop: () => undefined,
    });

    handle.pause();
    await expect(handle.stop()).resolves.toBeInstanceOf(Blob);
  });

  test("録画中でないのに一時停止したら握り潰さず throw する", async () => {
    const handle = await startRecording(makeCapturable(), "video/mp4", {
      onUnexpectedStop: () => undefined,
    });

    handle.pause();
    // 呼び出し側のバグ。黙って無視すると、区間の境目がずれた録画ができる
    expect(() => handle.pause()).toThrow();
    expect(() => handle.resume()).not.toThrow();
    expect(() => handle.resume()).toThrow();
  });
});
```

import に `startRecording` と `beforeEach` / `vi` を足す。

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/recorder.test.ts`
期待: FAIL (`handle.pause is not a function`)

- [x] **Step 3: 最小実装**

`src/content/recorder.ts` の `RecorderHandle` を置き換える:

```typescript
export type RecorderHandle = {
  /**
   * 録画を一時停止する。
   *
   * **止めている間の時間は出力に含まれない。** 区間の間のシークを録画から
   * 外すために使う (`MediaRecorder` が pause 中の時間をタイムラインから除く)
   */
  pause(): void;
  /** 一時停止から再開する */
  resume(): void;
  /** 録画を止めて Blob を確定させる */
  stop(): Promise<Blob>;
};
```

`startRecording` が返すオブジェクトに 2 つ足す (`stop` の前):

```typescript
      pause(): void {
        // 状態が合わないのは呼び出し側のバグ。MediaRecorder も
        // InvalidStateError を投げるが、理由が読み取れる文言にしておく。
        // 黙って無視すると、区間の境目がずれた録画が出来上がる
        if (recorder.state !== "recording") {
          throw new Error(`録画中でないため一時停止できません: ${recorder.state}`);
        }
        recorder.pause();
      },
      resume(): void {
        if (recorder.state !== "paused") {
          throw new Error(`一時停止中でないため再開できません: ${recorder.state}`);
        }
        recorder.resume();
      },
```

- [x] **Step 4: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck`
期待: PASS / 型エラーなし

- [x] **Step 5: commit**

```bash
git add src/content/recorder.ts tests/content/recorder.test.ts
git commit -m "$(cat <<'MSG'
feat(recorder): 区間の間で録画を一時停止できるようにする

区間ごとに別の録画セッションを回すと MP4 の結合が要る。1 本のセッションを
pause/resume で繋げば、出力は継ぎ目のない 1 本になる。

状態が合わないときは黙って無視せず throw する。無視すると区間の境目が
ずれた録画が出来上がり、実時間を払った後で気付くことになる。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 8: 新しいフレームが出るまで待つ

**Files:**
- Modify: `src/content/player.ts`
- Test: `tests/content/player.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `waitForFreshFrame(video, timeoutMs?)`

`seeked` だけでは足りない。直後はデコードが追いつかず前のフレームが残って
いることがあり、ここを雑にすると繋ぎ目に前の場面が数フレーム混入する。

- [x] **Step 1: 失敗するテストを書く**

`tests/content/player.test.ts` の末尾に足す:

```typescript
describe("waitForFreshFrame", () => {
  /** requestVideoFrameCallback を持つ video を作る */
  function makeVideo(
    request: ((callback: () => void) => number) | undefined,
  ): HTMLVideoElement {
    const video = document.createElement("video");
    Object.defineProperty(video, "requestVideoFrameCallback", {
      value: request,
      configurable: true,
    });
    return video;
  }

  test("新しいフレームが出たら解決する", async () => {
    const video = makeVideo((callback) => {
      setTimeout(callback, 0);
      return 1;
    });
    await expect(waitForFreshFrame(video)).resolves.toBeUndefined();
  });

  test("フレームが出なければ時間で諦める", async () => {
    const video = makeVideo(() => 1);
    await expect(waitForFreshFrame(video, 10)).rejects.toThrow(
      /新しいフレームが出ませんでした/u,
    );
  });

  test("使えない環境ではフォールバックせず throw する", () => {
    // 繋ぎ目の品質を保証できないまま録画に実時間を払わせない
    expect(() => waitForFreshFrame(makeVideo(undefined))).toThrow(
      /区間の繋ぎ目を保証できません/u,
    );
  });
});
```

import に `waitForFreshFrame` を足す。

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/player.test.ts`
期待: FAIL (`waitForFreshFrame` が export されていない)

- [x] **Step 3: 最小実装**

`src/content/player.ts` の末尾に足す:

```typescript
/** 新しいフレームが出るのを待つ上限 (ミリ秒) */
export const FRESH_FRAME_TIMEOUT_MS = 5000;

/** `requestVideoFrameCallback` は標準の型定義に含まれないため補う */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

/**
 * 新しいフレームが実際に描かれるまで待つ。
 *
 * **`seeked` だけでは足りない。** 直後はデコードが追いつかず、前のフレームが
 * 残っていることがある。区間の繋ぎ目でこれを怠ると、前の場面が数フレーム
 * 混入した録画ができる。
 *
 * **取れない環境ではフォールバックしない。** この拡張は Chrome 専用であり、
 * `requestVideoFrameCallback` が無いなら繋ぎ目の品質を保証できない。
 * 保証できないまま実時間を払わせるより、始める前に止める方がよい。
 */
export function waitForFreshFrame(
  video: HTMLVideoElement,
  timeoutMs: number = FRESH_FRAME_TIMEOUT_MS,
): Promise<void> {
  const request = (video as FrameCallbackVideo).requestVideoFrameCallback;
  if (typeof request !== "function") {
    throw new Error("この環境では区間の繋ぎ目を保証できません");
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`新しいフレームが出ませんでした (${timeoutMs}ms)`),
      );
    }, timeoutMs);

    request.call(video, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
```

- [x] **Step 4: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck`
期待: PASS / 型エラーなし

- [x] **Step 5: commit**

```bash
git add src/content/player.ts tests/content/player.test.ts
git commit -m "$(cat <<'MSG'
feat(player): 新しいフレームが描かれるまで待てるようにする

区間の繋ぎ目で seeked だけを待つと、デコードが追いつかず前のフレームが
残ったまま録画が再開する。数フレームだけ前の場面が混入する。

使えない環境ではフォールバックしない。繋ぎ目の品質を保証できないまま
実時間を払わせるより、始める前に止める方がよい。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---
### Task 9: 区間の一覧を作る

**Files:**
- Create: `src/content/segment-list.ts`
- Modify: `src/content/styles.ts`
- Modify: `.claude/specs/2026-09-23-edit-mode-segments-design.md`
- Test: `tests/content/segment-list.test.ts`

**Interfaces:**
- Consumes: Task 3 の `totalSec`
- Produces: `createSegmentList(callbacks)`, `SegmentList`, `SegmentListCallbacks`

**選択は一覧が持たない。** spec §5.2 は「一覧の DOM と選択状態だけを持ち」と
書いたが、選択とは「拡大バーがいま何を編集しているか」と同じものであり、
拡大バーを持っているのは `youtube.ts` である。両方に置くと同期が要る。
**一覧は表示とコールバックだけを持ち、選択は `youtube.ts` が唯一の持ち主に
する。** spec のモックも合わせて直す。

- [x] **Step 1: spec のモックを実装に合わせる**

`.claude/specs/2026-09-23-edit-mode-segments-design.md` の §5.2 のモックを
差し替える。**`[+ ここを追加]` を一覧から外す。** バーの IN ボタンが区間を
足す入口であり、同じ働きの入口を 2 つ作ると「どちらを押せばよいか」が生まれる。

```
┌──────────────────────────────────────┐
│ ① 1:23 〜 1:45 (22秒)   [▶] [✕]      │ ← 選択中は強調
│ ② 4:02 〜 4:10 ( 8秒)   [▶] [✕]      │
│                     合計 30秒 / 60秒  │
│ ══════█████████══════════════════════ │ ← 選択中の区間の拡大バー
│ ＋ 区間を追加  OUT  ▶ 区間を見る      │
│ ● 録画    ■ 中止              ⚙      │
└──────────────────────────────────────┘
```

モックの直後に段落を足す:

```markdown
**区間を足す入口は IN ボタン 1 つ。** 一覧の中に「追加」を置くと同じ働きの
入口が 2 つになる。エディットモードでは IN のラベルを「＋ 区間を追加」に
変えるだけにする。

**選択は一覧ではなく `youtube.ts` が持つ。** 選択とは「拡大バーがいま何を
編集しているか」と同じものであり、拡大バーを持っているのは `youtube.ts` で
ある。両方に置くと同期が要る。
```

- [x] **Step 2: 失敗するテストを書く**

`tests/content/segment-list.test.ts` を新規作成:

```typescript
// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { createSegmentList } from "@/content/segment-list";
import type { ClipRange } from "@/shared/types";

const segments: ClipRange[] = [
  { startSec: 83, endSec: 98 },
  { startSec: 242, endSec: 250 },
];

function makeList() {
  const calls = { select: [] as number[], play: [] as number[], remove: [] as number[] };
  const list = createSegmentList({
    onSelect: (index) => calls.select.push(index),
    onPlay: (index) => calls.play.push(index),
    onRemove: (index) => calls.remove.push(index),
  });
  document.body.append(list.element);
  return { list, calls };
}

function rows(list: { element: HTMLElement }): HTMLElement[] {
  return [...list.element.querySelectorAll<HTMLElement>("[data-role='segment']")];
}

describe("区間の一覧", () => {
  test("区間ごとに行を出す", () => {
    const { list } = makeList();
    list.update(segments, 0, 60);

    const texts = rows(list).map((row) => row.textContent ?? "");
    expect(texts[0]).toContain("1:23");
    expect(texts[0]).toContain("1:38");
    expect(texts[0]).toContain("15秒");
    expect(texts[1]).toContain("4:02");
  });

  test("選択中の行に印を付ける", () => {
    const { list } = makeList();
    list.update(segments, 1, 60);

    expect(rows(list).map((row) => row.dataset.selected)).toEqual([
      "false",
      "true",
    ]);
  });

  test("行を押すと選択を伝える", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);
    rows(list)[1]?.click();

    expect(calls.select).toEqual([1]);
  });

  test("▶ と ✕ は選択と混ざらない", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);
    list.element
      .querySelectorAll<HTMLElement>("[data-role='play']")[1]
      ?.click();
    list.element
      .querySelectorAll<HTMLElement>("[data-role='remove']")[0]
      ?.click();

    expect(calls.play).toEqual([1]);
    expect(calls.remove).toEqual([0]);
    // 行のクリックまで一緒に発火すると、消そうとして選択が動く
    expect(calls.select).toEqual([]);
  });

  test("合計と上限を出す", () => {
    const { list } = makeList();
    list.update(segments, 0, 60);

    const total = list.element.querySelector("[data-role='total']");
    expect(total?.textContent).toBe("合計 23秒 / 60秒");
  });

  test("合計が上限を超えたら知らせる", () => {
    const { list } = makeList();
    list.update(segments, 0, 20);

    const total = list.element.querySelector<HTMLElement>("[data-role='total']");
    expect(total?.dataset.over).toBe("true");
  });

  test("区間が無ければ何も出さない", () => {
    const { list } = makeList();
    list.update([], -1, 60);

    expect(rows(list)).toEqual([]);
    expect(list.element.hidden).toBe(true);
  });

  test("録画中は操作を受け付けない", () => {
    const { list, calls } = makeList();
    list.update(segments, 0, 60);
    list.setEnabled(false);
    rows(list)[1]?.click();
    list.element.querySelectorAll<HTMLElement>("[data-role='remove']")[0]?.click();

    expect(calls.select).toEqual([]);
    expect(calls.remove).toEqual([]);
  });
});
```

- [x] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/segment-list.test.ts`
期待: FAIL (`Failed to resolve import "@/content/segment-list"`)

- [x] **Step 4: スタイルを足す**

`src/content/styles.ts` の `PANEL_STYLE` の後に足す:

```typescript
/** 区間の一覧。行は押せるので、押せることが分かる見た目にする */
export const SEGMENT_STYLE = {
  root: "display:flex;flex-direction:column;gap:4px;",
  row: "display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;cursor:pointer;background:transparent;",
  rowSelected:
    "display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;cursor:pointer;background:var(--ytc-surface);",
  label: "color:var(--ytc-text);font-size:12px;flex:1;",
  // 行のクリックと混ざらないよう、小さくても押せる大きさを確保する
  iconButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;min-width:28px;cursor:pointer;font-family:${FONT};font-size:12px;`,
  total: "color:var(--ytc-text-sub);font-size:11px;text-align:right;",
  // 超過は色だけで伝えない。文言側でも「/ 60秒」と出しているので、
  // 色が見えない環境でも判断できる
  totalOver: "color:#f28b82;font-size:11px;text-align:right;font-weight:600;",
} as const;
```

- [x] **Step 5: 一覧を実装する**

`src/content/segment-list.ts` を新規作成:

```typescript
/**
 * エディットモードで出す区間の一覧。
 *
 * **選択状態は持たない。** 選択とは「拡大バーがいま何を編集しているか」と
 * 同じものであり、拡大バーを持っているのは `youtube.ts` である。ここにも
 * 置くと同期が要る。この一覧は渡されたものを描き、押されたことを伝えるだけ。
 *
 * **拡大バーを複数対応させない代わりに置く。** 複数区間を 1 つのバーに
 * 詰め込むと、ハンドルの当たり判定と重なりの解決がバーの中に流れ込む。
 */

import { SEGMENT_STYLE } from "@/content/styles";
import { totalSec } from "@/shared/timeline";
import { formatTime } from "@/shared/time";
import type { ClipRange } from "@/shared/types";

export type SegmentListCallbacks = {
  /** 行が押された。その区間を編集対象にする */
  onSelect(index: number): void;
  /** ▶ が押された。その区間だけを再生する */
  onPlay(index: number): void;
  /** ✕ が押された */
  onRemove(index: number): void;
};

export type SegmentList = {
  element: HTMLElement;
  /** 区間・選択・上限を反映して描き直す */
  update(segments: ClipRange[], selectedIndex: number, maxClipSec: number): void;
  /** 操作を受け付けるか。録画中は false */
  setEnabled(enabled: boolean): void;
};

/** 区間 1 つ分の表示。拡大バーの文言と揃える */
function segmentLabel(segment: ClipRange, index: number): string {
  const durationSec = Math.round(segment.endSec - segment.startSec);
  return `${index + 1}. ${formatTime(segment.startSec)} 〜 ${formatTime(segment.endSec)} (${durationSec}秒)`;
}

export function createSegmentList(
  callbacks: SegmentListCallbacks,
): SegmentList {
  const element = document.createElement("div");
  element.style.cssText = SEGMENT_STYLE.root;
  element.hidden = true;

  const rows = document.createElement("div");
  rows.style.cssText = SEGMENT_STYLE.root;

  const total = document.createElement("div");
  total.dataset.role = "total";

  element.append(rows, total);

  let enabled = true;

  /** 押せない間は伝えない。押せるのに何も起きない状態を作らない */
  function fire(action: () => void): (event: Event) => void {
    return (event) => {
      // 行の上のボタンが押されたとき、行の選択まで一緒に起きると
      // 「消そうとして選択が動く」ことになる
      event.stopPropagation();
      if (!enabled) return;
      action();
    };
  }

  function makeIconButton(
    role: string,
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = SEGMENT_STYLE.iconButton;
    button.addEventListener("click", fire(onClick));
    return button;
  }

  return {
    element,

    update(segments, selectedIndex, maxClipSec): void {
      // 区間が無いときは箱ごと消す。空の枠だけが残ると、何かを見落として
      // いるように見える
      element.hidden = segments.length === 0;

      rows.replaceChildren(
        ...segments.map((segment, index) => {
          const row = document.createElement("div");
          row.dataset.role = "segment";
          const selected = index === selectedIndex;
          row.dataset.selected = selected ? "true" : "false";
          row.style.cssText = selected
            ? SEGMENT_STYLE.rowSelected
            : SEGMENT_STYLE.row;

          const label = document.createElement("span");
          label.style.cssText = SEGMENT_STYLE.label;
          label.textContent = segmentLabel(segment, index);

          row.append(
            label,
            makeIconButton("play", "▶", "この区間を再生", () =>
              callbacks.onPlay(index),
            ),
            makeIconButton("remove", "✕", "この区間を消す", () =>
              callbacks.onRemove(index),
            ),
          );
          row.addEventListener("click", fire(() => callbacks.onSelect(index)));
          return row;
        }),
      );

      const sum = Math.round(totalSec(segments));
      const over = sum > maxClipSec;
      total.textContent = `合計 ${sum}秒 / ${maxClipSec}秒`;
      total.dataset.over = over ? "true" : "false";
      total.style.cssText = over
        ? SEGMENT_STYLE.totalOver
        : SEGMENT_STYLE.total;
    },

    setEnabled(next): void {
      enabled = next;
      // 見た目でも押せないことを示す。押せる見た目のまま無反応にしない
      element.style.opacity = next ? "1" : "0.5";
    },
  };
}
```

- [x] **Step 6: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck`
期待: PASS / 型エラーなし

- [x] **Step 7: commit**

```bash
git add src/content/segment-list.ts src/content/styles.ts tests/content/segment-list.test.ts .claude/specs/2026-09-23-edit-mode-segments-design.md
git commit -m "$(cat <<'MSG'
feat(segment-list): 区間の一覧を出す

拡大バーは「選択中の区間 1 つを編集する道具」として据え置く。複数を 1 つの
バーに詰め込むと、ハンドルの当たり判定と重なりの解決がバーの中に流れ込む。

選択状態はここに持たせない。選択とは「拡大バーがいま何を編集しているか」と
同じもので、拡大バーを持っているのは youtube.ts である。両方に置くと同期が
要る。spec のモックにあった一覧内の追加ボタンも外した。同じ働きの入口が
2 つあると、どちらを押せばよいかが生まれる。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 10: モードと一覧をバーに配線する

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 5 の `Settings.mode`、Task 9 の `createSegmentList`、
  Task 3 の `indexAt`
- Produces: なし (UI の完成)

- [x] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に足す。**このファイルは content script を
1 度だけ import して使い回す**ので、新しい mount helper は作らず、既にある
`emit` (state/changed を配る) / `changeSettings` (storage の変更を配る) /
`clickButton` / `flush` / `sent` をそのまま使う。

```typescript
describe("エディットモード", () => {
  /** バーに出ているボタンの文言 */
  function buttonLabels(): string[] {
    return [...document.querySelectorAll("#yt-clip-bar button")].map(
      (button) => button.textContent ?? "",
    );
  }

  /** 一覧の行 */
  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  test("シンプルでは一覧を出さない", async () => {
    changeSettings({ mode: "simple" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();

    expect(segmentRows()).toEqual([]);
  });

  test("エディットでは IN のラベルが変わる", async () => {
    changeSettings({ mode: "edit" });
    await flush();

    // 区間を足す入口を 2 つ作らないので、IN 自体が追加ボタンになる
    expect(buttonLabels()).toContain("＋ 区間を追加");
    expect(buttonLabels()).not.toContain("IN");
  });

  test("エディットの IN は区間を足すイベントを送る", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    sent = [];

    clickButton("＋ 区間を追加");

    expect(sent.at(-1)?.type).toBe("ADD_SEGMENT");
  });

  test("シンプルの IN は今までどおり置き換える", () => {
    changeSettings({ mode: "simple" });
    sent = [];

    clickButton("IN");

    expect(sent.at(-1)?.type).toBe("MARK_IN");
  });

  test("区間ごとに行が出る", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 83, endSec: 98 },
        { startSec: 242, endSec: 250 },
      ],
      meta: META_A,
    });
    await flush();

    expect(segmentRows().length).toBe(2);
    expect(segmentRows()[0]?.textContent).toContain("1:23");
  });

  test("モードが変わると作りかけの区間を消す", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();

    expect(sent.at(-1)).toEqual({ type: "RESET_MARKS" });
  });

  test("録画中はモードの変更を受け付けない", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: [RANGE], meta: META_A });
    await flush();
    sent = [];

    changeSettings({ mode: "simple" });
    await flush();

    // 状態機械だけが戻ると、録画が走り続けて取り残される
    expect(sent).toEqual([]);
  });
});
```

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts`
期待: FAIL

- [x] **Step 3: 状態の持ち方を変える**

まず `src/content/youtube.ts` の import に足す:

```typescript
import { createSegmentList, type SegmentList } from "@/content/segment-list";
import { indexAt, totalSec } from "@/shared/timeline";
import { type ClipMode } from "@/shared/settings";
```

`src/content/youtube.ts` の先頭の状態変数を置き換える。

置き換え前:

```typescript
let currentRange: ClipRange | null = null;
```

置き換え後:

```typescript
/**
 * いま画面に出ている区間列。**状態機械が正で、これはその写し。**
 * シンプルモードでは常に 0 個か 1 個
 */
let currentSegments: ClipRange[] = [];
/**
 * 拡大バーがいま編集している区間の位置。区間が無ければ -1。
 *
 * **ここが選択の唯一の持ち主。** 一覧にも持たせると同期が要る。
 * 並べ替えとマージで index は動くので、確定のたびに `indexAt` で引き直す
 */
let selectedIndex = -1;
/** 切り抜きの作り方。設定から読む */
let mode: ClipMode = "simple";
let segmentList: SegmentList | null = null;
```

`currentRange` を参照していた箇所は、次の関数を経由させる (`sameRange` の隣):

```typescript
/** 拡大バーが編集している区間。無ければ null */
function selectedSegment(): ClipRange | null {
  return currentSegments[selectedIndex] ?? null;
}
```

- [x] **Step 4: 状態の反映に一覧を混ぜる**

`applyStateToDisplay` の `stateRange` を区間列に置き換える:

```typescript
  const stateSegments = "segments" in state ? state.segments : [];
  // idle と failed が持つ区間は「もう操作できない過去のもの」。画面から消す。
  // **別の動画を見ているタブでは取り込まない** (canAdjustRange と同じ規則)
  const liveSegments =
    state.kind === "idle" ||
    state.kind === "failed" ||
    stateMeta?.videoId !== currentVideoId()
      ? []
      : stateSegments;
```

`drifted` の判定は「選択中の区間が変わったか」で見る。`currentSegments` を
差し替える前に、いま選んでいた区間の開始秒を控えておき、差し替えた後に
`indexAt` で引き直す:

```typescript
  // 並べ替えとマージで index は動く。開始秒で引き直せば、マージで消えた
  // 区間を選んでいた場合もマージ先が返るので、選択が迷子にならない
  const anchorSec = selectedSegment()?.startSec ?? null;
  const previous = selectedSegment();

  currentSegments = liveSegments;
  selectedIndex =
    anchorSec === null
      ? liveSegments.length - 1
      : indexAt(liveSegments, anchorSec);
  // 引き直せなかった (区間ごと消えた) ときは末尾を選ぶ。選択なしの状態を
  // 作ると、拡大バーが何も編集していないのに出ていることになる
  if (selectedIndex === -1 && liveSegments.length > 0) {
    selectedIndex = liveSegments.length - 1;
  }

  const current = selectedSegment();
  const drifted =
    previous === null || current === null
      ? previous !== current
      : !sameRange(previous, current);
```

同じ関数の末尾 (`rangeBar?.update(...)` の前) に一覧の更新を足す:

```typescript
  // 一覧はエディットモードでだけ出す。シンプルで使っている人に、関係のない
  // 概念を見せない
  segmentList?.setEnabled(!busy);
  segmentList?.update(
    mode === "edit" ? currentSegments : [],
    selectedIndex,
    maxClipSec,
  );
```

`rangeBar?.update(currentRange, ...)` は `selectedSegment()` を使う形に直す。

- [x] **Step 5: IN を分岐させる**

`onMarkIn` を置き換える:

```typescript
function onMarkIn(): void {
  if (busy) {
    setStatus("録画中は区間を変更できません");
    return;
  }

  const video = getVideo();
  const meta = getVideoMeta();
  // 既定の長さの区間をここで作る。状態機械は長さの決め方を知らない
  const range = makeDefaultRange(video.currentTime, video.duration, maxClipSec);

  rangeVideoId = meta.videoId;

  // **エディットでは楽観的に描かない。** 並べ替えとマージで結果が変わるので、
  // 状態機械の答えを待ってから描く (applyStateToDisplay が反映する)。
  // シンプルは結果が自明なので今までどおり先に描く
  if (mode === "edit") {
    send({ type: "ADD_SEGMENT", range, meta });
    return;
  }

  applyRange(range, video.duration);
  send(
    { type: "MARK_IN", range, meta },
    (state) =>
      state.kind === "ready" &&
      state.segments[0] !== undefined &&
      sameRange(state.segments[0], range),
  );
}
```

`onMarkOut` / `onRangeCommitted` は `index: selectedIndex` を送る形に直す
(Task 6 で `index: 0` 固定にしてあるところ)。どちらも先頭で
`if (selectedIndex < 0) return;` を確かめる。

- [x] **Step 6: バーに一覧を組み込む**

`buildBar` の中を直す。IN ボタンのラベルをモードで変え、一覧を差し込む:

```typescript
  // ラベルだけを変える。区間を足す入口を 2 つ作らない
  const inButton = makeButton(
    mode === "edit" ? "＋ 区間を追加" : "IN",
    false,
    onMarkIn,
  );
```

`rangeBar` を作っている箇所の後に足す:

```typescript
  segmentList = createSegmentList({
    onSelect: (index) => {
      selectedIndex = index;
      // 選び直したら拡大バーもその区間に移る
      applyStateToSelection();
    },
    onPlay: (index) => {
      selectedIndex = index;
      applyStateToSelection();
      void playRange();
    },
    onRemove: (index) => {
      send({ type: "REMOVE_SEGMENT", index });
    },
  });
```

`bar.append(...)` を直す (一覧は拡大バーの上に置く。区間を選んでから
バーで調整する順番):

```typescript
  bar.append(segmentList.element, rangeBar.element, row, settingsPanel.element);
```

`applyStateToSelection` を `applyStateToDisplay` の隣に足す:

```typescript
/**
 * 選択だけを画面に反映する。状態機械には何も送らない。
 *
 * 選び直しは状態の変化ではないので、`send` を通すと往復のぶん反応が遅れる
 */
function applyStateToSelection(): void {
  const segment = selectedSegment();
  segmentList?.update(
    mode === "edit" ? currentSegments : [],
    selectedIndex,
    maxClipSec,
  );
  if (segment === null) return;
  try {
    rangeBar?.update(segment, getVideo().duration);
    setStatus(rangeLabel(segment));
  } catch (error) {
    console.warn(`拡大バーを選択に合わせられませんでした: ${String(error)}`);
  }
}
```

- [x] **Step 7: 設定の読み込みを直す**

`loadInitialSettings` で `mode` も読む:

```typescript
      maxClipSec = settings.maxClipSec;
      applyMode(settings.mode);
```

`chrome.storage.onChanged` のリスナーを直す:

```typescript
chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = areaName === "sync" ? changes[SETTINGS_KEY] : undefined;
  if (change === undefined) return;
  const settings = mergeSettings(change.newValue);
  maxClipSec = settings.maxClipSec;
  applyMode(settings.mode);
});
```

`applyMode` を足す:

```typescript
/**
 * モードの変更を取り込む。
 *
 * **作りかけの区間は全部消す。** エディット (2 区間) からシンプルへ戻したとき、
 * 先頭だけ残すような半端な引き継ぎは何が消えたのか分からない。設定パネルの
 * 説明にも「モードを変えると作りかけの区間は消えます」と書いてある。
 *
 * **録画中は変えない。** 状態機械だけが戻り、録画が走り続けて取り残される。
 * 設定は既に保存されているので、録画が終われば次の通知で追いつく
 */
function applyMode(next: ClipMode): void {
  if (next === mode) return;
  if (busy) {
    setStatus("録画中はモードを変更できません");
    return;
  }

  mode = next;
  // バーごと作り直してラベルと並びを入れ替える。部分的に差し替えるより、
  // 一度で作り直す方が「どちらのモードの見た目が残っているか」を考えずに済む
  document.getElementById(BAR_ID)?.remove();
  mount();

  if (currentSegments.length > 0) {
    send({ type: "RESET_MARKS" });
  }
}
```

- [x] **Step 8: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck && npm run build`
期待: PASS / 型エラーなし / ビルド成功

- [x] **Step 9: commit**

```bash
git add src/content/youtube.ts tests/content/youtube.test.ts
git commit -m "$(cat <<'MSG'
feat(youtube): エディットモードで区間の一覧を操作できるようにする

選択の持ち主を youtube.ts に一本化した。並べ替えとマージで index が動くため、
確定のたびに開始秒から indexAt で引き直す。マージで消えた区間を選んでいた
場合もマージ先が返るので、選択が迷子にならない。

エディットでは楽観的に描かない。並べ替えとマージで結果が変わるので、状態機械
の答えを待ってから描く。シンプルは結果が自明なので今までどおり先に描く。

モードを変えたら作りかけの区間は全部消す。先頭だけ残すような半端な引き継ぎは
何が消えたのか分からない。録画中は変えない。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 11: 録画を区間の数だけ繋ぐ

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 7 の `pause()` / `resume()`、Task 8 の `waitForFreshFrame`
- Produces: なし (録画の完成)

- [x] **Step 1: 失敗するテストを書く**

まず `tests/content/youtube.test.ts` の `FakeRecorder` を拡張する。いまは
`state: "inactive" | "recording"` しか持たず、一時停止を観測できない。

```typescript
type FakeRecorder = {
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
  /** 呼ばれた順。区間の繋ぎ方を順序ごと確かめる */
  calls: string[];
};
```

`installGlobals` の `MediaRecorder` フェイクに `pause()` / `resume()` を足し、
`start` / `pause` / `resume` / `stop` で `calls.push(...)` と `state` の更新を
行う。

そのうえで末尾に足す:

```typescript
describe("複数区間の録画", () => {
  const TWO: ClipRange[] = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  /** 録画が走っている状態まで進める */
  async function startTwoSegmentRecording(): Promise<FakeRecorder> {
    changeSettings({ mode: "edit" });
    emit({ kind: "recording", segments: TWO, meta: META_A });
    await flush();
    command("recorder/start");
    await flush();
    return startedRecorder();
  }

  test("最初の区間の頭へ飛ぶ", async () => {
    changeSettings({ mode: "edit" });
    emit({ kind: "seeking", segments: TWO, meta: META_A });
    await flush();

    expect(video.element.currentTime).toBe(83);
  });

  test("区間の終わりで録画を止め、次の頭へ飛んでから再開する", async () => {
    const recorder = await startTwoSegmentRecording();

    video.advanceFrame(98);
    await flush();

    // 止めてから飛び、映像が整ってから再開する。順序が崩れると繋ぎ目に
    // 前の場面が混入する
    expect(recorder.calls).toEqual(["start", "pause", "resume"]);
    expect(video.element.currentTime).toBe(242);
    expect(recorder.state).toBe("recording");
  });

  test("区間の間では書き出しへ進まない", async () => {
    await startTwoSegmentRecording();
    sent = [];

    video.advanceFrame(98);
    await flush();

    expect(sent.map((message) => message.type)).not.toContain("OUT_REACHED");
  });

  test("最後の区間の終わりで書き出しへ進む", async () => {
    await startTwoSegmentRecording();

    video.advanceFrame(98);
    await flush();
    sent = [];
    video.advanceFrame(250);
    await flush();

    expect(sent.at(-1)).toEqual({ type: "OUT_REACHED" });
  });

  test("区間の間で広告が始まったら全体を落とす", async () => {
    const recorder = await startTwoSegmentRecording();
    sent = [];
    // 広告の判定は player.ts が DOM を見る。既存テストと同じ作りで仕込む
    document.querySelector(".html5-video-player")?.classList.add("ad-showing");

    video.advanceFrame(98);
    await flush();

    // 部分的に広告が混ざったクリップを残すより、録り直させる方がましである
    expect(sent.at(-1)).toEqual({ type: "FAIL", reason: "ad-playing" });
    expect(recorder.calls).not.toContain("resume");

    document.querySelector(".html5-video-player")?.classList.remove("ad-showing");
  });

  test("区間の間で中止しても止められる", async () => {
    const recorder = await startTwoSegmentRecording();

    video.advanceFrame(98);
    await flush();
    emit({ kind: "ready", segments: TWO, meta: META_A });
    await flush();

    expect(recorder.state).toBe("inactive");
  });
});
```

※ 広告の仕込み方 (`ad-showing` を付けるセレクタ) は `src/content/player.ts` の
`isAdPlaying` と `buildPage()` の DOM に合わせること。

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts`
期待: FAIL (`recorder.calls` が存在しない / 2 区間目へ進まない)

- [x] **Step 3: 録画シーケンスを書き換える**

`src/content/player.ts` からの import に `waitForFreshFrame` を足したうえで、
`runRecording` を置き換え、2 つの関数を足す:

```typescript
/**
 * 録画の後半。録画開始後に呼ばれ、区間を順に辿って最後の OUT で止める。
 *
 * **区間ごとに録画セッションを分けない。** 1 本のセッションを走らせたまま
 * `pause()` / `resume()` で繋げば、出力は継ぎ目のない 1 本になる。分けると
 * MP4 の結合が要る
 */
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

/** いまの区間の終わりを待つ。次があれば繋ぎ、無ければ書き出しへ進む */
function watchSegmentEnd(
  video: HTMLVideoElement,
  segments: ClipRange[],
  index: number,
): void {
  const segment = segments[index];
  if (segment === undefined) {
    // 状態機械が渡した区間列と辿っている位置が食い違っている。UI のバグ
    send({ type: "FAIL", reason: "internal-error" });
    return;
  }

  const remainingSec = Math.round(
    segments
      .slice(index)
      .reduce((sum, s) => sum + (s.endSec - s.startSec), 0),
  );
  setStatus(
    segments.length === 1
      ? `録画中… (${remainingSec}秒)`
      : `録画中… ${index + 1} / ${segments.length} 区間目 (残り ${remainingSec}秒)`,
  );

  cancelWatch = onReachTime(video, segment.endSec, () => {
    cancelWatch = null;
    if (segments[index + 1] === undefined) {
      video.pause();
      send({ type: "OUT_REACHED" });
      setStatus("録画を書き出しています…");
      return;
    }
    void advanceToSegment(video, segments, index + 1);
  });
}

/**
 * 区間の間。録画を止めて次の頭へ飛び、映像が整ってから再開する。
 *
 * **`seeked` だけで再開しない。** 直後はデコードが追いつかず前のフレームが
 * 残っていることがあり、繋ぎ目に前の場面が数フレーム混入する
 * (`waitForFreshFrame`)。
 */
async function advanceToSegment(
  video: HTMLVideoElement,
  segments: ClipRange[],
  index: number,
): Promise<void> {
  const segment = segments[index];
  if (segment === undefined || handle === null) {
    // handle が無いのに区間を繋ごうとしている = 録画が始まっていない
    send({ type: "FAIL", reason: "internal-error" });
    return;
  }

  const recorder = handle;
  try {
    recorder.pause();
    video.pause();
    setStatus(`${index + 1} / ${segments.length} 区間目へ移動中…`);

    await seekTo(video, segment.startSec);
    await startPlayback(video);
    await waitForFreshFrame(video);

    // **区間ごとに広告を見る。** 録画開始前の 1 回だけでは、この間に始まった
    // ミッドロールを拾えない。部分的に広告が混ざったクリップを残すより、
    // 録り直させる方がましである
    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus(FAILURE_MESSAGES["ad-playing"]);
      return;
    }

    recorder.resume();
    watchSegmentEnd(video, segments, index);
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`${FAILURE_MESSAGES["seek-failed"]}: ${String(error)}`);
  }
}
```

- [x] **Step 4: 呼び出し側を直す**

`chrome.runtime.onMessage` のリスナーを直す:

```typescript
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
```

`prepareRecording` の中で合計長を確かめる (`assertRecordable` の後):

```typescript
    // 合計で見る。区間ごとに上限を見ると、10 秒の区間を 10 個作れてしまい、
    // X の上限を超えたクリップができる
    const sum = totalSec(currentSegments);
    if (sum > maxClipSec) {
      send({ type: "FAIL", reason: "internal-error" });
      setStatus(`合計 ${Math.round(sum)} 秒は上限 ${maxClipSec} 秒を超えています`);
      return;
    }
```

`renderActions` で、合計超過のときに録画ボタンを無効にする。
`makeButton` の後に:

```typescript
      // 押しても弾かれるだけの録画は押させない。一覧の合計表示と理由を揃える
      if (action === "record" && totalSec(currentSegments) > maxClipSec) {
        button.disabled = true;
        button.title = `合計が上限 ${maxClipSec} 秒を超えています`;
      }
```

- [x] **Step 5: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck && npm run build`
期待: PASS / 型エラーなし / ビルド成功

- [x] **Step 6: commit**

```bash
git add src/content/youtube.ts tests/content/youtube.test.ts
git commit -m "$(cat <<'MSG'
feat(youtube): 複数の区間を 1 本に繋いで録画する

1 本の録画セッションを走らせたまま、区間の間だけ pause/resume する。
MediaRecorder は止めている間の時間をタイムラインから除くので、出力は
継ぎ目のない 1 本になる。

再開の条件を厳しくした。seeked の直後はデコードが追いつかず前のフレームが
残っていることがあり、繋ぎ目に前の場面が混入する。

広告は区間ごとに見る。録画開始前の 1 回だけでは、区間の間に始まった
ミッドロールを拾えない。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

### Task 12: シークバーの帯を区間の数だけ描く

**Files:**
- Modify: `src/content/youtube.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: Task 10 の `currentSegments`
- Produces: なし (UI の完成)

- [x] **Step 1: 失敗するテストを書く**

`tests/content/youtube.test.ts` に足す。既にある `overlay()` helper を使う。

```typescript
describe("シークバーの帯", () => {
  /** 帯 1 本ずつの左端 (%) */
  function bandLefts(): string[] {
    return [...(overlay()?.querySelectorAll<HTMLElement>("div") ?? [])].map(
      (band) => band.style.left,
    );
  }

  test("区間の数だけ帯を描く", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 60, endSec: 70 },
      ],
      meta: META_A,
    });
    await flush();

    // 1 本の帯で全体を覆うと、間の拾っていない部分まで切り抜くように見える
    expect(bandLefts().length).toBe(2);
  });

  test("帯は動画の時間順に並ぶ", async () => {
    changeSettings({ mode: "edit" });
    emit({
      kind: "ready",
      segments: [
        { startSec: 10, endSec: 20 },
        { startSec: 60, endSec: 70 },
      ],
      meta: META_A,
    });
    await flush();

    const lefts = bandLefts().map((left) => Number.parseFloat(left));
    expect(lefts[0]).toBeLessThan(lefts[1] ?? 0);
  });

  test("区間が無くなったら帯ごと消す", async () => {
    emit({ kind: "idle" });
    await flush();

    expect(overlay()).toBeNull();
  });
});
```

- [x] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts`
期待: FAIL (帯が 1 本しか出ない)

- [x] **Step 3: 帯を描き直す**

`paintOverlay` と `refreshOverlay` を置き換える:

```typescript
/** 帯 1 本分のスタイル。区間ごとに同じものを並べる */
const OVERLAY_BAND_STYLE =
  "position:absolute;top:0;bottom:0;background:#3ea6ff;opacity:0.5;pointer-events:none;";

/**
 * YouTube のシークバーに区間を帯で重ねて、動画全体のどこかを示す。
 *
 * **区間ごとに子要素を並べる。** 1 本の帯を伸ばして全区間を覆うと、
 * 間の拾っていない部分まで切り抜くように見える
 */
function paintOverlay(segments: ClipRange[], videoDurationSec: number): void {
  const bar = document.querySelector<HTMLElement>(YT_SELECTORS.progressBar);
  if (bar === null || videoDurationSec <= 0) return;

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay === null) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;z-index:1;";
    bar.appendChild(overlay);
  }

  overlay.replaceChildren(
    ...segments.map((segment) => {
      const band = document.createElement("div");
      band.style.cssText = OVERLAY_BAND_STYLE;
      band.style.left = `${(segment.startSec / videoDurationSec) * 100}%`;
      band.style.width = `${((segment.endSec - segment.startSec) / videoDurationSec) * 100}%`;
      return band;
    }),
  );
}

/** 帯を今の区間に合わせ直す。区間が無い・別の動画を見ているなら消す */
function refreshOverlay(): void {
  if (currentSegments.length === 0 || rangeVideoId !== currentVideoId()) {
    clearOverlay();
    return;
  }
  try {
    paintOverlay(currentSegments, getVideo().duration);
  } catch (error) {
    // 帯は区間の目安にすぎない。描けないことは録画を止める理由にならない
    console.warn(`区間の帯を描き直せませんでした: ${String(error)}`);
  }
}
```

`applyRange` の中の `paintOverlay(range, videoDurationSec)` を
`paintOverlay(currentSegments, videoDurationSec)` に、`onRangeCommitted` の
中の呼び出しも同様に直す。

- [x] **Step 4: 実行して通過を確認**

実行: `npx vitest run && npm run typecheck && npm run build`
期待: PASS / 型エラーなし / ビルド成功

- [x] **Step 5: 手動確認を通す**

`npm run build` した `dist/` を `chrome://extensions` から読み込み、
`docs/manual-check.md` の **「## エディットモード (複数区間の結合)」** の
項目をすべて確認する。**繋ぎ目の品質 (映像の混入・音ズレ) は自動テストで
見ていないので、ここが唯一の砦。**

- [x] **Step 6: commit**

```bash
git add src/content/youtube.ts tests/content/youtube.test.ts
git commit -m "$(cat <<'MSG'
feat(youtube): シークバーの帯を区間ごとに描く

1 本の帯を伸ばして全区間を覆うと、間の拾っていない部分まで切り抜くように
見える。区間ごとに子要素を並べる。

Claude-Session: 1b0aa9e1-e807-41c7-85c5-21a2795cbff2
MSG
)"
```

---

## 完了の条件

- [x] `npx vitest run` が通る
- [x] `npm run typecheck` が通る
- [x] `npm run build` が通る
- [x] `docs/manual-check.md` の「エディットモード (複数区間の結合)」を全項目確認した
- [x] **シンプルモードの挙動が変わっていない** (既存の手動確認項目も通る)
- [x] 全タスク完了後、branch 全体の cross-review (保守担当 + 攻撃者視点、
      別 Claude モデル) を 1 回通し、指摘を直した

## plan を書いた後に決まったこと

実機で使ってから、この plan の前提を 2 つ変えている。経緯は spec §2.3 と
CHANGELOG を参照。

- **IN を「＋ 区間を追加」に置き換えない。** OUT があるのに IN が無い状態になり、
  一度作った区間の頭を詰められなくなる。3 つのボタンを並べる
- **自動ソートと自動マージをやめた。** 区間の中で「追加」を押すと無反応になり、
  同じ場面を 2 回使うこともできなかった。拾った順のまま持つ

**push / PR 作成 / merge はユーザーの指示を待つ。**
