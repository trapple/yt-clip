# 段階 1c-3: 文字起こしの欄の検索 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 文字起こしの欄に検索を足し (当たりに印を付け、↑↓ で飛ぶ)、欄と窓に関わる 1c-2 の持ち越しを片付ける。

**Architecture:** 比べ方 (NFKC・大小の区別なし・元の文字の位置への写し) は純粋な関数の新しいファイル `transcript-search.ts` に置く。
欄 (`transcript-panel.ts`) は検索の文字・当たり・今の当たりを持ち、行の要素は今どおり使い回して、変わった行だけ印を付け直す。
持ち越しは youtube.ts / trim-panel.ts の小さな直し (区間を選び直すときの近道・単語の段の出し入れで窓を詰め直す・成功した後に古い
エラー文言を消す) と、crxjs の警告の調べに分ける。

**Tech Stack:** TypeScript strict / Chrome MV3 (crxjs + vite) / vitest + jsdom / Playwright

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- ADR 0004 (`docs/adr/0004-transcript-search-marks-and-jumps.md`) の Decision:
  - 「行は全部残し、当たった語に印を付ける。欄に「2 / 5」と出し、↑ ↓ (Enter / Shift+Enter) で次・前の当たりの行へ欄の中をスクロールする」
  - 「当たりは行で数える (同じ行に 2 度出ても 1 件)。今の当たりの行は、ほかの当たりの行より強い印にする」
  - 「探すのは字幕の行の、欄に出している文字 (直した行は直した文字)。手入力の行は探さない」
  - 「比べるときは NFKC で揃え、英字の大小を区別しない (全角・半角の違いで当たり損ねない)。ひらがなとカタカナは区別する」
  - 「打ったら欄の先頭から数えて 1 件目へ飛ぶ。最後の次は最初へ戻る。飛んでも再生位置は動かさない」「飛んだ後しばらくは再生位置を追うスクロールで引き戻さない」
  - 「Esc か ✕ で検索の文字を消し、印を外す。文字起こしが無い・取っている間・取れなかったときは検索欄を押せない。録画中も検索はできる」
- ADR 0004 の Consequences: 「印は行の文字を text node と印の要素に分けて入れる。文字は今どおり `textContent` で入れ、HTML として解釈しない」
  「状態が届いて行の文字が変わっても、検索の文字は残し、当たりを数え直す。今の当たりは行の id で覚え、残っていればその行のまま」
- 第 2 版モック (artifact c2a6c8ad) の文言: 「⌕ 文字起こしを検索」
- 1c-3 に入れる持ち越し (回答 2026-11-03「欄に関わるものだけ (推奨)」。`.claude/plans/2026-11-03-transcript-cleanup.md` 末尾):
  - 「見出しや ‹ › で区間を選び直すたびに `refreshTranscript` が 8000 行の比べ直しと `placeTranscriptItems` を通る (`trimmingIndex` だけ変わるときの近道)」
  - 「`FloatingWindow.refit()` の呼び手が無くなった (帯だけが呼んでいた)。詰める欄の単語の段の出し入れでバーの背が 20px 変わるのに詰め直していない」
  - 「成功した「頭を今に / 尻を今に」の後も、前の操作のエラー文言が状態の欄に残る」
  - 「IME での手入力の行の直し・浮いた窓でのスクロールは手で確かめていない」
  - 「Chromium 153 の `Unsafe attempt to load URL chrome-extension://…/assets/caption-bridge-main.ts-*.js` (と `youtube.ts-*.js`) の警告。… 原因を調べ、smoke と一緒に直す」
- ほかの持ち越し (待ちの守り・1c-1 から・1b-2 から 10 件) は 1c-4「持ち越しの片付け」へ回す (同じ回答)
- 行・テロップの文字は信用できない入力: DOM には `textContent` でだけ入れる (1a の whole-branch review)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- ドキュメントとコード両方に修正がある場合、先にドキュメントを修正してからコードに着手する (Task 1)
- git は `git -C <dir> ...`、gh は `gh <subcommand> -R trapple/yt-clip ...`
- commit は日本語の Conventional Commits、本文に Why。署名に失敗したら止めてユーザーに伝える (署名を外さない)
- 外部プロセスには timeout を付ける (Bash の timeout・Playwright の test.setTimeout)
- 小さく回す: 単体テスト → typecheck → 全テスト → 実機
- push / PR / merge はユーザーの指示を待つ

### 運用前提 (brainstorming で確定した実装方式)

- モード: guarded (ユーザーが設計の 2 点に回答済み。実装は止まらず進め、Task 6 の結論と実機の確かめだけユーザーに見せる)
- 隔離: branch `feat/transcript-search` (develop から切った。ADR 0004 は 26e4ce2)
- 実装方式: B (branch + 直列、このセッションで私が消化)
- 実機の確かめは普段の Chrome (Claude in Chrome)。dist を作り直したら、chrome://extensions での再読み込みをユーザーに頼む

---

## ファイル構造

| ファイル | 責務 | 変更 |
|---|---|---|
| `src/content/transcript-search.ts` | 検索の比べ方 (正規化と元の位置への写し・当たりの範囲) | 新規 |
| `src/content/transcript-panel.ts` | 検索欄・当たりの印・飛ぶ・`setTrimmingIndex` | 変更 |
| `src/content/styles.ts` | 検索欄・印・当たりの行の見た目 | 変更 |
| `src/content/trim-panel.ts` | 単語の段の出し入れを `onHeightChange` で知らせる | 変更 |
| `src/content/youtube.ts` | 選び直しの近道・refit の配線・頭/尻を今にの成功で文言を戻す | 変更 |
| `tests/content/transcript-search.test.ts` | 比べ方 | 新規 |
| `tests/content/transcript-panel.test.ts` | 検索・`setTrimmingIndex` | 変更 |
| `tests/content/trim-panel.test.ts` | `onHeightChange` | 変更 |
| `tests/content/youtube-transcript-panel.test.ts` | 選び直し・文言 | 変更 |
| `README.md` / `docs/manual-check.md` / `CHANGELOG.md` | 検索と手の確かめ | 変更 |

---

### Task 1: 文書 (検索の使い方と手の確かめ)

**Files:**
- Modify: `README.md` (「## 文字起こしの欄」の箇条書き)
- Modify: `docs/manual-check.md` (「## 文字起こしの欄」の末尾)
- Modify: `CHANGELOG.md` (「## 未リリース」)

- [ ] **Step 1: README の「文字起こしの欄」の箇条書きの末尾 (「＋ ここに字幕を足す」の項の後) に足す**

```markdown
- **⌕ 文字起こしを検索** — 欄の上の検索欄に打つと、当たった語に印が付き、「2 / 5」と何件目かが出る。行は全部残る。
  **Enter / ↓** で次、**Shift + Enter / ↑** で前の当たりの行へ欄の中が送られる (最後の次は最初へ戻る。再生位置は動かさない)。
  全角と半角・英字の大小は区別しない (ひらがなとカタカナは区別する)。**Esc / ✕** で消す。探すのは字幕の行の文字 (直した行は
  直した文字) で、手入力の行は探さない。録画中も探せる
```

- [ ] **Step 2: manual-check の「## 文字起こしの欄」の末尾 (「区間・テロップの窓がページの中…」の項の後) に足す**

```markdown
- [ ] 検索欄に字幕の中の語を打つと、当たった語に印が付き「1 / N」が出て、欄の中が 1 件目の行まで送られる (ページはスクロールしない)。Enter と ↓ で次、Shift + Enter と ↑ で前へ移り、最後の次は最初へ戻る。全角で打っても半角の英数字に当たる
- [ ] 検索欄で日本語の IME を使うとき、変換を確かめる Enter では次へ飛ばない。検索欄で k や j を打っても YouTube のショートカットが動かない。Esc か ✕ で印が消える
- [ ] 1 時間を超える配信 (数千行) で検索欄に打っても、打つのが引っかからない。当たりへ飛んだ後、再生中でも 5 秒は欄が再生位置へ引き戻されない
- [ ] 検索の印が付いたまま行を押して区間に入れても、印と「N / M」が残る。直した行は直した文字で当たる
- [ ] 手入力の行の ✎ を日本語の IME で直すとき、変換を確かめる Enter では確定しない。変換を取り消す Esc で欄が閉じない
- [ ] 区間・テロップの窓を浮かせて小さくしたとき、窓の中のスクロールと欄の中のスクロールが両方効き、＋ ここに字幕を足す で足した行が窓の見える所に出る
- [ ] バーを浮かせて画面の下の端に置き、単語のある区間と無い区間 (手動字幕の動画か字幕の無い動画) を ‹ › で行き来すると、バーが画面の下からはみ出さない
- [ ] 手入力の行で頭を尻より後ろにして理由を出した後、正しく「頭を今に」を押すと、理由の文言が消えて区間の範囲の文言に戻る
```

- [ ] **Step 3: CHANGELOG の「## 未リリース」の段落の後に足す**

```markdown
**文字起こしの欄で検索できるようにした。** 欄の上の検索欄に打つと、当たった語に印が付き、Enter (↓) と Shift + Enter (↑) で
当たりの行を順に見ていける。全角と半角・英字の大小は区別しない。
```

- [ ] **Step 4: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md docs/manual-check.md CHANGELOG.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "docs: 文字起こしの欄の検索と、1c-3 の手の確かめを書く" -m "Why: 段階 1c-3。コードより先に、検索の使い方 (ADR 0004) と、1c-2 で手で確かめていない IME・浮いた窓のスクロールを文書にする"
```

---

### Task 2: 検索の比べ方 (`transcript-search.ts`)

**Files:**
- Create: `src/content/transcript-search.ts`
- Test: `tests/content/transcript-search.test.ts`

**Interfaces:**
- Produces:
  - `type NormalizedText = { text: string; starts: number[]; ends: number[] }` (`text[i]` が元の文字の `[starts[i], ends[i])` から来た)
  - `normalizeForSearch(source: string): NormalizedText`
  - `normalizeQuery(query: string): string` (前後の空白を落とす。空なら探さない)
  - `type MatchRange = { start: number; end: number }` (元の文字の UTF-16 の位置)
  - `findMatches(normalized: NormalizedText, query: string): MatchRange[]` (重ならない。query は normalizeQuery 済み。空なら [])

- [ ] **Step 1: 失敗するテストを書く**

```typescript
import { describe, expect, test } from "vitest";
import { findMatches, normalizeForSearch, normalizeQuery } from "@/content/transcript-search";

const find = (source: string, query: string) => findMatches(normalizeForSearch(source), normalizeQuery(query));

describe("normalizeForSearch", () => {
  test("NFKC で揃え、英字を小文字にする", () => {
    expect(normalizeForSearch("ＡＢＣ１２３").text).toBe("abc123");
  });

  test("半角のカナと濁点は 1 文字にまとめる (2 文字から来た 1 文字は元の 2 文字を指す)", () => {
    const normalized = normalizeForSearch("ｶﾞｲﾄﾞ");
    expect(normalized.text).toBe("ガイド");
    expect(normalized.starts).toEqual([0, 2, 3]);
    expect(normalized.ends).toEqual([2, 3, 5]);
  });

  test("ひらがなとカタカナは揃えない", () => {
    expect(normalizeForSearch("みぎ").text).not.toBe(normalizeForSearch("ミギ").text);
  });
});

describe("normalizeQuery", () => {
  test("前後の空白を落とし、本文と同じに揃える", () => {
    expect(normalizeQuery("  ＲＩＧＨＴ ")).toBe("right");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("findMatches", () => {
  test("元の文字の位置で返す", () => {
    expect(find("ここは絶対に右から回る", "右から")).toEqual([{ start: 6, end: 9 }]);
  });

  test("全角で打っても半角に当たり、大小を区別しない", () => {
    expect(find("Game Over", "ｇａｍｅ")).toEqual([{ start: 0, end: 4 }]);
  });

  test("半角のカナに全角で当たると、濁点まで含めた範囲を返す", () => {
    expect(find("ｶﾞｲﾄﾞです", "ガイド")).toEqual([{ start: 0, end: 5 }]);
  });

  test("サロゲートペアを割らない", () => {
    expect(find("𠮷野家", "野")).toEqual([{ start: 2, end: 3 }]);
    expect(find("𠮷野家", "𠮷")).toEqual([{ start: 0, end: 2 }]);
  });

  test("重ならずに全部返す", () => {
    expect(find("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  test("空の query と当たらない query は []", () => {
    expect(find("abc", "")).toEqual([]);
    expect(find("abc", "x")).toEqual([]);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-search.test.ts`
期待: FAIL (`Failed to resolve import "@/content/transcript-search"`)

- [ ] **Step 3: 最小実装**

```typescript
/**
 * 文字起こしの欄の検索の比べ方 (ADR 0004)。NFKC で揃え、英字の大小を区別しない。印を元の文字に付けるため、揃えた後の
 * 1 文字ごとに、元の文字のどこから来たかを持つ。
 *
 * **塊ごとに揃える。** 元の文字を「基の 1 文字 + 後ろに付く結合文字 (と半角の濁点・半濁点)」の塊に割り、塊ごとに NFKC に
 * かける。1 文字ずつだと半角の「ｶﾞ」が「カ + 結合の濁点」になって「ガ」に当たらない。文字列ごとだと元の位置が分からない
 */

export type NormalizedText = { text: string; starts: number[]; ends: number[] };
export type MatchRange = { start: number; end: number };

/** 基の 1 文字と、後ろに付く結合文字・半角の濁点 (U+FF9E)・半濁点 (U+FF9F) */
const CLUSTER = /\P{M}[\p{M}ﾞﾟ]*|\p{M}+/gu;

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

export function normalizeForSearch(source: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of source.matchAll(CLUSTER)) {
    const start = match.index;
    const end = start + match[0].length;
    const folded = fold(match[0]);
    text += folded;
    // 揃えた後の UTF-16 の 1 単位ごとに、塊の範囲を持つ (1 つの塊が数文字になることがある)
    for (let i = 0; i < folded.length; i += 1) {
      starts.push(start);
      ends.push(end);
    }
  }
  return { text, starts, ends };
}

export function normalizeQuery(query: string): string {
  return fold(query.trim());
}

export function findMatches(normalized: NormalizedText, query: string): MatchRange[] {
  if (query === "") return [];
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const at = normalized.text.indexOf(query, from);
    if (at < 0) break;
    const start = normalized.starts[at]!;
    const end = normalized.ends[at + query.length - 1]!;
    const last = ranges.at(-1);
    // 1 つの塊が数文字に揃うと、続いた当たりが同じ元の文字を指しうる。重ねずにつなぐ
    if (last !== undefined && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    from = at + query.length;
  }
  return ranges;
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-search.test.ts && npx tsc --noEmit`
期待: PASS / 型エラーなし

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-search.ts tests/content/transcript-search.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "feat(content): 文字起こしの検索の比べ方 (NFKC・大小を区別しない・元の位置への写し) を足す" -m "Why: ADR 0004。全角と半角の違いで当たり損ねないよう揃えて比べ、印は元の文字に付けるので、揃えた文字ごとに元の位置を持つ"
```

---

### Task 3: 欄の検索 (検索欄・印・飛ぶ)

**Files:**
- Modify: `src/content/transcript-panel.ts`
- Modify: `src/content/styles.ts` (`TRANSCRIPT_STYLE`)
- Test: `tests/content/transcript-panel.test.ts`

**Interfaces:**
- Consumes: `normalizeForSearch` / `normalizeQuery` / `findMatches` / `NormalizedText` (Task 2)
- Produces (DOM): `div[data-role=transcript-search]` の中に `input[data-role=search-input]` (placeholder 「⌕ 文字起こしを検索」)、
  `span[data-role=search-count]` (「」/「0 件」/「2 / 5」)、`button[data-role=search-prev]` ↑ / `search-next` ↓ / `search-clear` ✕。
  当たりの行は `data-hit="true"`、今の当たりは `data-hit="current"`、ほかは `data-hit` 無し。印は `mark[data-role=search-mark]`

- [ ] **Step 1: 失敗するテストを書く** (`tests/content/transcript-panel.test.ts` の末尾。`setup` / `view` / `rows` / `role` / `part` / `key` は今のもの)

```typescript
describe("検索 (ADR 0004)", () => {
  const searchInput = (): HTMLInputElement => role("search-input") as HTMLInputElement;
  const type = (text: string): void => {
    searchInput().value = text;
    searchInput().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const hits = (): (string | undefined)[] => rows().map((row) => row.dataset.hit);
  const marks = (index: number): string[] =>
    [...(rows()[index]?.querySelectorAll("[data-role='search-mark']") ?? [])].map((mark) => mark.textContent ?? "");
  const many = (): TranscriptView =>
    view({
      rows: [
        { id: "a", startSec: 1, text: "右から回る", selected: false, hidden: false, hasTelop: false },
        { id: "b", startSec: 5, text: "左に寄せた", selected: false, hidden: false, hasTelop: false },
        { id: "c", startSec: 9, text: "やっぱり右、右", selected: false, hidden: false, hasTelop: false },
      ],
    });

  test("検索欄は欄の見出しの下にあり、モックの文言を出す", () => {
    const { panel } = setup();
    panel.update(view());
    expect(searchInput().placeholder).toBe("⌕ 文字起こしを検索");
    const children = [...panel.element.children];
    expect(children.indexOf(role("transcript-search")!)).toBe(1);
  });

  test("打つと当たった語に印を付け、行で数える。1 件目が今の当たり", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    expect(hits()).toEqual(["current", undefined, "true"]);
    expect(marks(0)).toEqual(["右"]);
    expect(marks(2)).toEqual(["右", "右"]);
    expect(role("search-count")?.textContent).toBe("1 / 2");
    // 印の外の文字も残る
    expect(part(2, "line-text")?.textContent).toBe("やっぱり右、右");
  });

  test("Enter で次、Shift + Enter で前。端で反対の端へ戻る", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    key(searchInput(), { key: "Enter" });
    expect(hits()).toEqual(["true", undefined, "current"]);
    expect(role("search-count")?.textContent).toBe("2 / 2");
    key(searchInput(), { key: "Enter" });
    expect(hits()).toEqual(["current", undefined, "true"]);
    key(searchInput(), { key: "Enter", shiftKey: true });
    expect(hits()).toEqual(["true", undefined, "current"]);
  });

  test("↑ ↓ のボタンでも移る", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    role("search-next")?.click();
    expect(role("search-count")?.textContent).toBe("2 / 2");
    role("search-prev")?.click();
    expect(role("search-count")?.textContent).toBe("1 / 2");
  });

  test("↓ ↑ のキーでも移る", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    key(searchInput(), { key: "ArrowDown" });
    expect(role("search-count")?.textContent).toBe("2 / 2");
    key(searchInput(), { key: "ArrowUp" });
    expect(role("search-count")?.textContent).toBe("1 / 2");
  });

  test("揃えると同じ文字 (後ろに空白を打った) なら、今の当たりを 1 件目へ戻さない", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    key(searchInput(), { key: "Enter" });
    type("右 ");
    expect(role("search-count")?.textContent).toBe("2 / 2");
  });

  test("当たらなければ「0 件」で、↑ ↓ は押せない", () => {
    const { panel } = setup();
    panel.update(many());
    type("上");
    expect(role("search-count")?.textContent).toBe("0 件");
    expect((role("search-next") as HTMLButtonElement).disabled).toBe(true);
    expect((role("search-prev") as HTMLButtonElement).disabled).toBe(true);
    expect(hits()).toEqual([undefined, undefined, undefined]);
  });

  test("全角で打っても半角に当たる", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "a", startSec: 1, text: "Game Over", selected: false, hidden: false, hasTelop: false }] }));
    type("ｇａｍｅ");
    expect(marks(0)).toEqual(["Game"]);
  });

  test("Esc と ✕ で消し、印を外す", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    key(searchInput(), { key: "Escape" });
    expect(searchInput().value).toBe("");
    expect(hits()).toEqual([undefined, undefined, undefined]);
    expect(role("search-count")?.textContent).toBe("");
    type("右");
    role("search-clear")?.click();
    expect(searchInput().value).toBe("");
    expect(marks(0)).toEqual([]);
  });

  test("検索欄のキーは YouTube へ渡さない。IME の変換中の Enter では移らない", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    key(searchInput(), { key: "k" });
    key(searchInput(), { key: "Enter", isComposing: true });
    document.removeEventListener("keydown", onDocument);
    expect(onDocument).not.toHaveBeenCalled();
    expect(role("search-count")?.textContent).toBe("1 / 2");
  });

  test("飛んだ行を欄の中で見える所へ送る (ページは動かさない)", () => {
    const { panel } = setup();
    panel.update(many());
    const list = role("transcript-lines")!;
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(rows()[2]!, "offsetTop", { configurable: true, value: 1000 });
    type("右");
    key(searchInput(), { key: "Enter" });
    expect(list.scrollTop).toBe(900);
  });

  test("状態が届いて文字が変わっても検索は残り、今の当たりは行の id で保つ", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    key(searchInput(), { key: "Enter" });
    const next = many();
    next.rows[0] = { ...next.rows[0]!, text: "上から回る", selected: true, hasTelop: true };
    panel.update(next);
    expect(searchInput().value).toBe("右");
    expect(hits()).toEqual([undefined, undefined, "current"]);
    expect(role("search-count")?.textContent).toBe("1 / 1");
  });

  test("印の文字もタグとして解釈しない", () => {
    const { panel } = setup();
    panel.update(view({ rows: [{ id: "x", startSec: 0, text: "<b>右</b>", selected: false, hidden: false, hasTelop: false }] }));
    type("右");
    expect(document.querySelector("b")).toBeNull();
    expect(part(0, "line-text")?.textContent).toBe("<b>右</b>");
  });

  test("直している行は直す欄を出し、印は付けない (検索を消すと直す欄のまま)", () => {
    const { panel } = setup();
    panel.update(view());
    part(1, "line-edit-button")?.click();
    type("右");
    expect(rows()[1]?.querySelector("[data-role='line-edit']")).not.toBeNull();
    expect(marks(1)).toEqual([]);
  });

  test("文字起こしが無い・取っている間・取れなかったときは押せず、検索の文字を消す", () => {
    const { panel } = setup();
    panel.update(many());
    type("右");
    panel.update(view({ header: { kind: "loading" }, rows: [] }));
    expect(searchInput().disabled).toBe(true);
    expect(searchInput().value).toBe("");
    panel.update(view({ header: { kind: "none" }, rows: [] }));
    expect(searchInput().disabled).toBe(true);
    panel.update(view({ header: { kind: "failed", reason: "x" }, rows: [] }));
    expect(searchInput().disabled).toBe(true);
    panel.update(many());
    expect(searchInput().disabled).toBe(false);
  });

  test("録画中 (enabled: false) も探せる", () => {
    const { panel } = setup();
    panel.update({ ...many(), enabled: false });
    expect(searchInput().disabled).toBe(false);
    type("右");
    expect(role("search-count")?.textContent).toBe("1 / 2");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts`
期待: 新しい describe の項目が FAIL (`search-input` が無い)。前からの項目は PASS

- [ ] **Step 3: styles に足す** (`src/content/styles.ts` の `TRANSCRIPT_STYLE` の `textButton` の後)

```typescript
  /** 検索欄の行。見出しの下に置く */
  search: "display:flex;align-items:center;gap:4px;",
  searchInput: `flex:1;min-width:0;height:26px;box-sizing:border-box;border:1px solid var(--ytc-border);border-radius:13px;background:transparent;color:var(--ytc-text);font-family:${FONT};font-size:12px;padding:0 10px;user-select:text;`,
  searchCount: "color:var(--ytc-text-sub);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:3.5em;text-align:right;",
  /** 当たった語。地の色は区間に入った行 (surface) の上でも見えるよう accent を薄く重ねる */
  searchMark: "background:color-mix(in srgb, var(--ytc-accent) 30%, transparent);color:inherit;border-radius:2px;padding:0;",
  /** 当たりの行と今の当たりの行。区間の印 (左の線・地) と重ねて付ける */
  rowHit: "box-shadow:inset 0 0 0 1px var(--ytc-border);",
  rowCurrentHit: "box-shadow:inset 0 0 0 2px var(--ytc-accent);",
```

- [ ] **Step 4: 欄に検索を足す** (`src/content/transcript-panel.ts`)

4-1. import と RowParts:

```typescript
import { findMatches, normalizeForSearch, normalizeQuery, type MatchRange, type NormalizedText } from "@/content/transcript-search";

type Hit = "none" | "hit" | "current";

type RowParts = {
  element: HTMLElement;
  now: HTMLElement;
  time: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  row: TranscriptRow | null;
  /** 描いたときの当たり (印の出し直しが要るかを見る) */
  hit: Hit;
  /** 描いたときの検索の文字 (当たりの行だけ。ほかは "") */
  query: string;
};
```

`buildRow` の返り値に `hit: "none", query: ""` を足す。

4-2. 見出しの下に検索欄を作る (`header.append(...)` の後):

```typescript
  const search = document.createElement("div");
  search.dataset.role = "transcript-search";
  search.style.cssText = TRANSCRIPT_STYLE.search;
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.dataset.role = "search-input";
  searchInput.placeholder = "⌕ 文字起こしを検索";
  searchInput.style.cssText = TRANSCRIPT_STYLE.searchInput;
  const searchCount = document.createElement("span");
  searchCount.dataset.role = "search-count";
  searchCount.style.cssText = TRANSCRIPT_STYLE.searchCount;
  const searchPrev = makeButton("search-prev", "↑", "前の当たり (Shift + Enter)");
  const searchNext = makeButton("search-next", "↓", "次の当たり (Enter)");
  const searchClear = makeButton("search-clear", "✕", "検索を消す (Esc)");
  search.append(searchInput, searchCount, searchPrev, searchNext, searchClear);
```

`element.append(header, notice, dubbedBox, list)` を `element.append(header, search, notice, dubbedBox, list)` にする。

4-3. 検索の状態と操作 (`let userScrolledAt` の後):

```typescript
  /** 揃えた検索の文字。"" なら探していない */
  let query = "";
  /** 当たった行の位置 (view.rows の index。早い順) */
  let hits: number[] = [];
  /** 当たった行の index → 当たりの範囲 (元の文字の位置)。数えたときの範囲を描くときにも使う (2 度探さない) */
  let hitRanges = new Map<number, MatchRange[]>();
  /** 今の当たり (hits の index)。無ければ -1 */
  let hitIndex = -1;
  /** 行の文字を揃えたもの。打つたびに 8000 行を揃え直さない。行の並びが変わったら捨てる */
  let normalizedCache = new Map<string, NormalizedText>();

  function normalized(text: string): NormalizedText {
    let found = normalizedCache.get(text);
    if (found === undefined) {
      found = normalizeForSearch(text);
      normalizedCache.set(text, found);
    }
    return found;
  }

  function currentHitId(): string | null {
    return hitIndex < 0 ? null : (view.rows[hits[hitIndex]!]?.id ?? null);
  }

  /** 当たりを数え直す。keepId の行がまだ当たっていればそこを今の当たりにし、無ければ 1 件目 */
  function recomputeHits(keepId: string | null): void {
    hits = [];
    hitRanges = new Map();
    if (query !== "") {
      view.rows.forEach((row, i) => {
        const ranges = findMatches(normalized(row.text), query);
        if (ranges.length === 0) return;
        hits.push(i);
        hitRanges.set(i, ranges);
      });
    }
    const kept = keepId === null ? -1 : hits.findIndex((i) => view.rows[i]!.id === keepId);
    hitIndex = hits.length === 0 ? -1 : Math.max(kept, 0);
  }

  /** その行の当たり。描く側 (paintRow) が使う */
  function hitOf(index: number): Hit {
    if (!hitRanges.has(index)) return "none";
    return hits[hitIndex] === index ? "current" : "hit";
  }

  function renderSearch(): void {
    searchInput.disabled = view.header.kind !== "ready" || view.rows.length === 0;
    searchCount.textContent = query === "" ? "" : hits.length === 0 ? "0 件" : `${hitIndex + 1} / ${hits.length}`;
    searchPrev.disabled = hits.length === 0;
    searchNext.disabled = hits.length === 0;
    searchClear.disabled = searchInput.value === "";
  }

  function jumpToHit(): void {
    const row = hitIndex < 0 ? undefined : parts[hits[hitIndex]!]?.element;
    if (row !== undefined) scrollIntoList(row);
  }

  function setQuery(raw: string): void {
    const next = normalizeQuery(raw);
    // 揃えると前と同じ (前後の空白を打った・消した、IME の確定の後の input)。今の当たりを 1 件目へ戻さない
    if (next === query) {
      renderSearch();
      return;
    }
    query = next;
    recomputeHits(null);
    patchRows();
    renderSearch();
    jumpToHit();
  }

  /** 次・前の当たりへ。印が変わるのは前の今の当たりと新しい今の当たりの 2 行だけなので、その 2 行だけ描く */
  function step(delta: number): void {
    if (hits.length === 0) return;
    const previous = hits[hitIndex]!;
    hitIndex = (hitIndex + delta + hits.length) % hits.length;
    for (const index of [previous, hits[hitIndex]!]) {
      const part = parts[index];
      const row = view.rows[index];
      if (part !== undefined && row !== undefined) paintRow(part, row, index);
    }
    renderSearch();
    jumpToHit();
  }

  function clearSearch(): void {
    searchInput.value = "";
    setQuery("");
  }

  searchInput.addEventListener("input", () => setQuery(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    // ページのショートカット (YouTube の k / j など) に流さない
    event.stopPropagation();
    // IME の変換を確かめる Enter / 取り消す Esc / 候補を選ぶ ↑↓ は、検索欄のものではない
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if ((event.key === "Enter" && event.shiftKey) || event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearSearch();
    }
  });
  searchPrev.addEventListener("click", () => step(-1));
  searchNext.addEventListener("click", () => step(1));
  searchClear.addEventListener("click", () => clearSearch());
```

※ `makeButton` は関数宣言なので、この位置から呼べる (巻き上げ)。`scrollIntoList` は 4-5 で足す。

4-4. `paintRow` を丸ごと次に置き換える (今の関数に index の引数・当たりの判定・当たりだけ変わったときの近道を足したもの)。
時刻の行 (`before.startSec !== row.startSec`)・直す欄の出し入れ・actions は今の中身のまま:

```typescript
  /** 当たりの印 (行の data-hit と地・線) を付ける */
  function paintHitMark(part: RowParts, row: TranscriptRow, hit: Hit): void {
    if (hit === "none") delete part.element.dataset.hit;
    else part.element.dataset.hit = hit === "current" ? "current" : "true";
    const hitStyle = hit === "current" ? TRANSCRIPT_STYLE.rowCurrentHit : hit === "hit" ? TRANSCRIPT_STYLE.rowHit : "";
    part.element.style.cssText = (row.selected ? TRANSCRIPT_STYLE.rowSelected : TRANSCRIPT_STYLE.row) + hitStyle;
  }

  function paintBodyText(part: RowParts, row: TranscriptRow, index: number, hit: Hit): void {
    part.body.dataset.role = "line-text";
    paintText(part.body, row.text, hit === "none" ? [] : (hitRanges.get(index) ?? []));
    part.body.style.cssText = row.hidden ? TRANSCRIPT_STYLE.textHidden : TRANSCRIPT_STYLE.text;
  }

  /** 1 行を描く。前に描いた中身と同じ (直す欄の出し入れも当たりも同じ) なら何もしない */
  function paintRow(part: RowParts, row: TranscriptRow, index: number): void {
    const before = part.row;
    const isEditing = editing?.id === row.id;
    const wasEditing = part.body.dataset.role === "line-edit";
    const hit = hitOf(index);
    const hitQuery = hit === "none" ? "" : query;
    const sameRow =
      before !== null &&
      before.selected === row.selected &&
      before.hidden === row.hidden &&
      before.text === row.text &&
      before.hasTelop === row.hasTelop &&
      isEditing === wasEditing;
    if (sameRow && part.hit === hit && part.query === hitQuery) {
      if (isEditing) editor = part.body as HTMLTextAreaElement;
      return;
    }
    part.hit = hit;
    part.query = hitQuery;
    if (sameRow) {
      // 当たりだけが変わった (検索を打った・次へ移った)。印と文字だけを直し、ボタンは作り直さない
      paintHitMark(part, row, hit);
      if (isEditing) editor = part.body as HTMLTextAreaElement;
      else paintBodyText(part, row, index, hit);
      return;
    }
    part.row = row;
    part.element.dataset.lineId = row.id;
    part.element.dataset.selected = row.selected ? "true" : "false";
    part.element.dataset.hidden = row.hidden ? "true" : "false";
    paintHitMark(part, row, hit);
    if (before === null || before.startSec !== row.startSec) part.time.textContent = formatTime(row.startSec);

    if (isEditing) {
      if (!wasEditing) {
        const edit = makeEditor(row.id);
        part.body.replaceWith(edit);
        part.body = edit;
      }
      editor = part.body as HTMLTextAreaElement;
    } else {
      if (wasEditing) {
        const span = document.createElement("span");
        part.body.replaceWith(span);
        part.body = span;
      }
      paintBodyText(part, row, index, hit);
    }

    part.actions.replaceChildren();
    if (row.selected && row.hasTelop) {
      part.actions.append(
        makeButton("line-edit-button", "✎", "テロップの文字を直す"),
        makeButton("hide-telop", row.hidden ? "字幕に出す" : "字幕に出さない", "区間に残したまま、テロップだけ出さない / 出す"),
      );
    }
  }

  /** 文字を入れ、当たった所だけ印の要素に包む。どちらも textContent / text node で入れる (タグとして解釈しない) */
  function paintText(body: HTMLElement, text: string, ranges: readonly MatchRange[]): void {
    if (ranges.length === 0) {
      body.textContent = text;
      return;
    }
    const nodes: Node[] = [];
    let at = 0;
    for (const range of ranges) {
      if (range.start > at) nodes.push(document.createTextNode(text.slice(at, range.start)));
      const mark = document.createElement("mark");
      mark.dataset.role = "search-mark";
      mark.style.cssText = TRANSCRIPT_STYLE.searchMark;
      mark.textContent = text.slice(range.start, range.end);
      nodes.push(mark);
      at = range.end;
    }
    if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
    body.replaceChildren(...nodes);
  }
```

`patchRows` の `view.rows.forEach((row, i) => paintRow(parts[i]!, row));` を `paintRow(parts[i]!, row, i)` にし、作り直す枝
(`if (!sameIds(...))`) の中で `normalizedCache = new Map();` も行う。`import` の `NormalizedText` / `MatchRange` は型として使う。

4-5. スクロールを 1 つにまとめる (`follow` の前)。`reveal` の中の 4 行もこれに置き換える:

```typescript
  /**
   * 行の箱の中だけをスクロールして、target を上から 1/3 の所へ送る (scrollIntoView はページまで動かす)。
   * 送った後しばらくは、再生位置を追う動き (follow) で引き戻さない
   */
  function scrollIntoList(target: HTMLElement): void {
    const before = list.scrollTop;
    list.scrollTop = Math.max(0, target.offsetTop - list.clientHeight / 3);
    if (list.scrollTop !== before) scrollingByUs = true;
    userScrolledAt = Date.now();
  }
```

```typescript
    reveal(target): HTMLElement | null {
      const selector = /* 今のまま */;
      const found = list.querySelector<HTMLElement>(selector);
      if (found === null) return null;
      scrollIntoList(found);
      return found;
    },
```

4-6. `update` で検索を保つ。`view = next;` の前後を次のようにする:

```typescript
    update(next): void {
      if (editing !== null && editor !== null) editing.draft = editor.value;
      const keepHit = currentHitId();
      view = next;
      // 文字起こしが無くなった (別の動画・取っている間・取れなかった) ら、検索の文字を消す
      if (next.header.kind !== "ready" && searchInput.value !== "") {
        searchInput.value = "";
        query = "";
      }
      recomputeHits(keepHit);
      // ...(直す欄を閉じる判定・opacity・renderHeader は今のまま)...
      patchRows();
      renderSearch();
    },
```

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts tests/content/youtube-transcript-panel.test.ts tests/content/styles.test.ts && npx tsc --noEmit`
期待: PASS / 型エラーなし (styles.test が TRANSCRIPT_STYLE の鍵を数えていれば、足した鍵に合わせて直す)

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-panel.ts src/content/styles.ts tests/content/transcript-panel.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "feat(content): 文字起こしの欄で検索し、当たりに印を付けて Enter / ↑↓ で飛ぶ" -m "Why: ADR 0004。長い配信では 8000 行ほどになり、スクロールだけでは場面を探せない。行は全部残すので、区間の見出しと前後の行を見ながら選べ、行の要素も使い回せる"
```

---

### Task 4: 区間を選び直すときは見出しだけ描き直す

**Files:**
- Modify: `src/content/transcript-panel.ts`
- Modify: `src/content/youtube.ts` (`applyStateToSelection`)
- Test: `tests/content/transcript-panel.test.ts`

**Interfaces:**
- Produces: `TranscriptPanel.setTrimmingIndex(index: number): void` — 見出しの「· 詰めている」だけを付け替える。行は描き直さない

- [ ] **Step 1: 失敗するテストを書く** (`tests/content/transcript-panel.test.ts`)

```typescript
describe("setTrimmingIndex", () => {
  const segmentItems = (): TranscriptView["items"] => [
    { kind: "segment", index: 0, startSec: 0.8, endSec: 2, before: 0 },
    { kind: "segment", index: 1, startSec: 64.8, endSec: 73.3, before: 1 },
  ];

  test("見出しの「· 詰めている」だけを付け替え、行の要素は描き直さない", () => {
    const { panel } = setup();
    panel.update(view({ items: segmentItems(), trimmingIndex: 0 }));
    const lineText = part(1, "line-text");
    const titles = (): (string | null)[] =>
      [...document.querySelectorAll("[data-role='segment-title']")].map((title) => title.textContent);
    expect(titles()).toEqual(["区間 1 · 詰めている", "区間 2"]);
    panel.setTrimmingIndex(1);
    expect(titles()).toEqual(["区間 1", "区間 2 · 詰めている"]);
    expect(part(1, "line-text")).toBe(lineText);
  });

  test("同じ index なら見出しも作り直さない", () => {
    const { panel } = setup();
    panel.update(view({ items: segmentItems(), trimmingIndex: 0 }));
    const header = document.querySelector("[data-role='segment']");
    panel.setTrimmingIndex(0);
    expect(document.querySelector("[data-role='segment']")).toBe(header);
  });
});
```

(`SegmentHeaderItem` の項目名は `src/content/transcript-items.ts` に合わせる。違えばこの Step で直す)

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/transcript-panel.test.ts -t setTrimmingIndex`
期待: FAIL (`panel.setTrimmingIndex is not a function`)

- [ ] **Step 3: 最小実装**

`TranscriptPanel` 型に足す:

```typescript
  /** 詰めている区間だけが変わった (見出しや ‹ › で選び直した)。見出しだけを描き直す (8000 行を比べ直さない) */
  setTrimmingIndex(index: number): void;
```

返すオブジェクトに足す:

```typescript
    setTrimmingIndex(index): void {
      if (index === view.trimmingIndex) return;
      view = { ...view, trimmingIndex: index };
      placeExtras();
    },
```

`src/content/youtube.ts` の `applyStateToSelection` の頭の `refreshTranscript();` を置き換える:

```typescript
function applyStateToSelection(): void {
  // 選び直しで変わるのは「· 詰めている」と詰める欄だけ。欄の行は区間から決まり、選択では変わらない
  // (refreshTranscript は 8000 行の比べ直しと placeTranscriptItems を通る)
  const { segments } = listedItems();
  transcriptPanel?.setTrimmingIndex(segments.length === 0 ? -1 : selectedIndex);
  refreshTrimPanel();

  const segment = selectedSegment();
  // ...(今のまま)...
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content && npx tsc --noEmit`
期待: PASS (youtube-transcript-panel.test の「見出しを押すと詰める欄がその区間になり、· 詰めている が付く」系もそのまま通る)

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/transcript-panel.ts src/content/youtube.ts tests/content/transcript-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "perf(content): 区間を選び直すときは欄の見出しだけを描き直す" -m "Why: 1c-2 の持ち越し。見出しや ‹ › で選び直すたびに 8000 行の比べ直しと placeTranscriptItems を通っていた。選択で変わるのは「· 詰めている」と詰める欄だけ"
```

---

### Task 5: 単語の段の出し入れでバーの窓を詰め直す

**Files:**
- Modify: `src/content/trim-panel.ts`
- Modify: `src/content/youtube.ts` (`createTrimPanel` の呼び出し)
- Test: `tests/content/trim-panel.test.ts`

**Interfaces:**
- Produces: `TrimPanelCallbacks.onHeightChange(): void` — 単語の段を出した・消した (欄の背が変わった) ときに呼ぶ

- [ ] **Step 1: 失敗するテストを書く** (`tests/content/trim-panel.test.ts`。`mount` の callbacks に `onHeightChange: vi.fn()` を足す)

```typescript
describe("背の変わり目", () => {
  test("単語の段を出した・消したときだけ知らせる (窓を画面に詰め直すため)", () => {
    const { panel, callbacks } = mount();
    callbacks.onHeightChange.mockClear();
    panel.update(VIEW);
    expect(callbacks.onHeightChange).not.toHaveBeenCalled();
    panel.update({ ...VIEW, words: [] });
    expect(callbacks.onHeightChange).toHaveBeenCalledTimes(1);
    panel.update({ ...VIEW, words: [] });
    expect(callbacks.onHeightChange).toHaveBeenCalledTimes(1);
    panel.update(VIEW);
    expect(callbacks.onHeightChange).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/trim-panel.test.ts`
期待: FAIL (呼ばれない)。型エラーで落ちるなら、それも失敗の確認とする

- [ ] **Step 3: 最小実装**

`TrimPanelCallbacks` に足す:

```typescript
  /** 単語の段を出した・消した (欄の背が変わった)。浮いた窓を画面に詰め直すのは呼び手の役目 */
  onHeightChange(): void;
```

`paintWords` の `words.hidden = ...` の 2 行を置き換える:

```typescript
    const hide = shown.length === 0;
    const changed = words.hidden !== hide;
    // **display も切り替える。** 根の inline の display:flex は [hidden] に勝ち、空の段が背を取り続ける
    words.hidden = hide;
    words.style.display = hide ? "none" : "flex";
    if (changed) callbacks.onHeightChange();
```

`src/content/youtube.ts` の `createTrimPanel` の callbacks に足す:

```typescript
      // 単語の段の出し入れでバーの背が 20px ほど変わる。浮いた窓が画面の下からはみ出さないよう詰め直す (枠の中では何もしない)
      onHeightChange: () => barWindow.refit(),
```

(`tests/content/youtube*.test.ts` に `createTrimPanel` の callbacks を組むものがあれば、そこにも足す。`grep -rn "onPlayAround" tests` で探す)

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content && npx tsc --noEmit`
期待: PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/trim-panel.ts src/content/youtube.ts tests/content/trim-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "fix(content): 詰める欄の単語の段を出し入れしたら、浮いたバーを画面に詰め直す" -m "Why: 1c-2 の持ち越し。refit を呼んでいたのは外した帯だけで、単語の段の出し入れで背が変わっても詰め直さず、画面の下の端に置いたバーがはみ出していた"
```

---

### Task 6: 成功した「頭を今に / 尻を今に」で古いエラー文言を消す

**Files:**
- Modify: `src/content/youtube.ts` (`onMoveTelopEdge`)
- Test: `tests/content/youtube-transcript-panel.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/youtube-transcript-panel.test.ts` の手入力の行の describe の中に足す (`emit` / `flush` / `video` / `META` は
そのファイルのもの。手入力の行は `[data-role='telop']`)。

```typescript
test("頭を尻より後ろにして理由を出した後、正しく頭を今にすると、理由を消して区間の範囲の文言に戻す", async () => {
  emit({ kind: "ready", segments: [{ startSec: 0.8, endSec: 9.3 }], telops: [{ startSec: 5, endSec: 8, text: "あ" }], meta: META });
  await flush();
  const setStart = (): HTMLElement =>
    document.querySelector<HTMLElement>("[data-role='telop'] [data-role='set-start']")!;
  const status = (): string | null => document.querySelector("#yt-clip-bar-status")?.textContent ?? null;
  video().currentTime = 9;
  setStart().click();
  expect(status()).toBe("開始は終了より前にしてください");
  video().currentTime = 6;
  setStart().click();
  expect(status()).toBe("0:00 〜 0:09 (9秒)");
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube-transcript-panel.test.ts -t "理由を消して"`
期待: FAIL (`開始は終了より前にしてください` のまま)

- [ ] **Step 3: 最小実装** (`src/content/youtube.ts`)

`INITIAL_STATUS` の後に足す:

```typescript
/** 操作が通ったときの状態の欄。選んでいる区間があればその範囲、無ければ最初の案内 (前の操作の理由を残さない) */
function restingStatus(): string {
  const segment = selectedSegment();
  return segment === null ? INITIAL_STATUS : rangeLabel(segment);
}
```

`onMoveTelopEdge` の最後を置き換える:

```typescript
  // 送れたら、前の操作の理由 (「開始は終了より前に」・「答えを待っています」) を消す
  if (sendIndexed({ type: "UPDATE_TELOP", index, telop: next })) setStatus(restingStatus());
```

(`selectedSegment` が `restingStatus` より後で宣言されていても、関数宣言なので呼べる)

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content && npx tsc --noEmit`
期待: PASS

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube-transcript-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "fix(content): 頭を今に / 尻を今にが通ったら、前の操作の理由の文言を消す" -m "Why: 1c-2 の持ち越し。頭を尻より後ろにした理由や「答えを待っています」が、正しく直した後も状態の欄に残り、まだ失敗しているように見えた"
```

---

### Task 7: crxjs の loader の警告を調べる (時間を区切る)

**Files:** (結論しだい。調べるだけで終わることもある)
- Modify: `e2e/smoke.spec.ts` (直せたとき・扱いを変えるとき)
- Modify: `.claude/plans/2026-11-03-transcript-search.md` (結論の記録)

**Gate:** smoke の判定を緩める (警告を数えない) 形で終えるなら、その前にユーザーに結論と案を見せて決めてもらう

上限: 調べるのは 1 時間まで。それで出どころが分からなければ、試したことを記録して 1c-4 へ回す。

- [ ] **Step 1: 出どころの文書を突き止める** (普段の Chrome。Claude in Chrome で動画ページを開き、DevTools の警告と同時に下を見る)

```javascript
// javascript_tool で動画ページに流す
({
  url: location.href,
  prerendering: document.prerendering,
  activationStart: performance.getEntriesByType("navigation")[0]?.activationStart,
  speculationRules: [...document.querySelectorAll("script[type='speculationrules']")].map((s) => s.textContent?.slice(0, 300)),
  frames: [...document.querySelectorAll("iframe")].map((f) => ({ src: f.src, sandbox: f.getAttribute("sandbox") })),
})
```

確かめる仮説 (上から):
1. YouTube の speculation rules (prerender) が `watch?v=…&sttick=0` を先に描き、prerender 中の文書で content script の loader が
   動的 import を試みて拒まれる (`document.prerendering` と speculationRules に `sttick` が出るか)
2. sandbox 付きの iframe (opaque origin) の中で loader が走る (`all_frames` は無いので起きないはず。frames の src と sandbox で否定する)

- [ ] **Step 2: 仮説 1 なら、loader が prerender 中は待つようにできるかを確かめる**

crxjs の loader は生成物 (`dist/assets/*-loader-*.js`) で、手を入れる場所は vite の設定か、content script の入口。
入口で `document.prerendering` が true の間は何もせず `prerenderingchange` を待つ形にできるかを、`src/content/youtube.ts` と
`src/content/caption-bridge-main.ts` の入口 (`onExecute`) で試す。loader の動的 import そのものが拒まれる (入口まで届かない) なら、
拡張の側では止められない。

- [ ] **Step 3: 結論を plan 末尾の「完了の記録」に書き、smoke の扱いを決める**

- 直せた: smoke を通して commit (`fix(content): ...`)
- 拡張の側では止められない: Gate。ユーザーに「smoke の数え方からこの警告 (`Unsafe attempt to load URL chrome-extension://` で、
  frame の URL が `sttick=` を含む) だけを外す」案を見せ、決まってから直す
- 出どころが分からない: 試したことを記録し、1c-4 へ回す

---

### Task 8: 実機で確かめる

**Files:**
- Modify: `docs/manual-check.md` (確かめた記録の段落)

- [ ] **Step 1: 全テストと型**

実行: `npm test && npx tsc --noEmit`
期待: PASS

- [ ] **Step 2: dist を作り、拡張の再読み込みをユーザーに頼む**

実行: `npm run build` (timeout 120 秒)

- [ ] **Step 3: 普段の Chrome で Task 1 で足した manual-check の項目を通す** (IME はユーザーに打ってもらう。1 時間を超える配信で検索の速さも見る)

- [ ] **Step 4: manual-check の「## 確認した環境」の末尾に記録を足して commit**

```markdown
2026-11-03 は段階 1c-3 (文字起こしの欄の検索・区間を選び直すときの近道・単語の段の出し入れでの詰め直し・頭 / 尻を今にの後の文言) を確かめた。
```

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "docs(manual-check): 段階 1c-3 を確かめた記録" -m "Why: 検索と、1c-2 で手で確かめていなかった IME・浮いた窓のスクロールを普段の Chrome で通した"
```

---

## 完了後

1. `npm test` と `npx tsc --noEmit` で green を確認
2. whole-branch cross-review: `BASE=$(git -C /Users/trapple/repos/github.com/trapple/yt-clip merge-base develop HEAD)` からの diff を 1 ファイルにまとめ、新しい subagent に「保守担当 + 攻撃者」視点のレビューをさせる (node_modules に触らせない)。指摘は直して再レビュー
3. plan の末尾に「完了の記録」と「1c-4 に持ち越すもの」(この plan で扱わなかった 1c-2 の持ち越しすべて) を書いて commit
4. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ

## 自律判断ログ

- [回答] 検索は行を残して印を付け、↑↓ で飛ぶ (2026-11-03「印を付けて ↑↓ で飛ぶ (推奨)」。ADR 0004 に記録)
- [回答] 1c-3 に入れる持ち越しは欄に関わるものだけ (2026-11-03「欄に関わるものだけ (推奨)」)。待ちの守り・1c-1 から・1b-2 からは 1c-4
- [選択] 打った直後は欄の先頭から数えて 1 件目へ飛ぶ — 再生位置から数えると、同じ語でも開いた位置で 1 件目が変わり「1 / N」の意味が揺れる
- [選択] 手入力の行は探さない — 数個で目で見える。描くたびに作り直すので、印を付け直す仕組みが別に要る
- [選択] 行の文字を揃えたものを文字ごとに覚える (行の並びが変わったら捨てる) — 打つたびに 8000 行を NFKC にかけ直さない
- [選択] 頭 / 尻を今にの後の文言は、送れた時点で区間の範囲に戻す — 答えを待ってから戻すと、待ちの間に出た別の文言 (「テロップも消えました」など) と取り合う
- [cross-review] plan を 1 回 (ゼロ context の実装者。scratch に Task 2〜6 を当てて tsc / vitest 1232 件で確かめた)。Issues 5 件 (↑↓ のキー・Task 6 のテストの組み立て・揃えると同じ文字で当たりが戻る・次へ移るたびに全行を描き直す・paintRow の差分が貼れない) を直した。直しは具体的なので 2 回目は回さず実装に引き継ぐ
- [選択] refit は詰める欄が背の変わり目を知らせ、youtube.ts が呼ぶ — 背が変わるかを知っているのは詰める欄、窓を知っているのは youtube.ts
- [cross-review] whole-branch review を 1 回 (保守担当 + 攻撃者)。Approved、Minor 3 件 (検索の文字と本文の揃え方の違い・選び直しで詰める欄を前の窓で一度描く・修飾キー付きの ↑↓) を直した (73c97d0 / fedee18 / 46ca394)。どれも失敗するテストで確かめた小さな直しなので、2 回目は回さない
- [回答] crxjs の loader の警告は smoke で数えない (2026-11-03「この警告だけ数えない (推奨)」)

## 完了の記録 (2026-11-03)

- Task 1〜8 を commit (b6137ff / 7d30712 / 38d3c70 / e298d9b / 35d9995 / fcb6f62 / 783fea6・07b63f3 / 44c005e)。ADR 0004 は 26e4ce2、plan は 9bf0697
- 計画からの逸脱:
  - Task 4 と Task 5 の commit で youtube.ts の配線が混ざったため、作り直して分けた (各 commit で型が通る形)
  - Task 6 のテストは、答え (setTimeout で届く ready) が次のテストの idle を上書きしたので、最後に `await flush()` を足した
  - Task 7 は仮説 (prerender・sandbox の iframe) がどちらも外れた。Playwright で、同じタブで 2 回目以降に読み込むと loader の動的 import の先の chunk ごとに出ること、それでもバーと MAIN world の橋渡しが動くことを確かめた。Gate でユーザーに見せ、smoke でこの行だけ数えない形にした (README の切り分けにも書いた)。smoke は 9 項目すべて通過
  - whole-branch review で、塊の割り方を `\P{M}[\p{M}ﾞﾟ]*` から `Intl.Segmenter` (書記素) に替えた
- 普段の Chrome で確かめた (manual-check の記録)。IME・浮いた窓のスクロール・バーの詰め直しはユーザーが手で確かめた
- 全テスト 1238 件・typecheck 通過

### 1c-4 に持ち越すもの (持ち越しの片付け)

- 欄の操作の待ち (`indexedAwaiting`) と ±0.1 の待ち (`rangeAwaiting`) は、通知が落ちると次の状態まで下りない。IN / OUT・＋ 区間を追加・拡大バーのドラッグは、欄の組 (SET_CLIP) と混ぜる守りをまだ持たない
- 1c-1 から: ±0.1 の待ちに上限が無い・OUT 直後の ±0.1 の巻き戻り (帯を外した後は OUT と手入力の行の頭を今に / 尻を今にだけが残る)・トラックを押しても欄にフォーカスが移らない・長い配信は単語の時刻を落として保存する
- 1b-2 から 10 件 (`.claude/plans/2026-11-03-transcript-cleanup.md` の Global Constraints の振り分け):
  - 保存から読めたのに吹き替えの判定を待つ間「取っています…」のまま
  - 保存する字幕が頼んだ動画のものかの確かめ・`language` / `name` の長さの上限
  - 保存の索引の割り込みで漏れたキーが残る
  - router が `apply` の前に `captureTabId` を書く
  - `isClipOf` の受理判定が `JSON.stringify`
  - Shift の範囲選択で区間が数千になる
  - `text.slice(0, 500)` がサロゲートペアを割る
  - 状態の欄の「録画中… (N秒)」「書き出しています…」が残る
  - 広告の再生中に行を押すと duration が広告の長さ (＋ ここに字幕を足すも同じ)
  - 別の動画で行を押すと前の動画の区間とテロップ (手入力も) を確かめずに置き換える
- crxjs の loader の警告そのもの (止めるには loader の仕組みを替える。smoke は数えないようにした)
- 1c-3 で見つけたもの: 検索は手入力の行を探さない (ADR 0004 の判断。要るなら印を付け直す仕組みを足す)
