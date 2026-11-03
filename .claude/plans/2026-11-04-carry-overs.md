# 段階 1c-4: 持ち越しの片付け 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (直列) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 1a〜1c-3 で持ち越した不具合と守りの穴 (待ちの守り・状態の欄・広告・保存・router・文字の切り方) を片付ける。

**Architecture:** 振る舞いを足す段階ではない。今の作法に揃える直しを、触るファイルごとの小さなタスクに分ける。
content script の待ち (欄の組・位置で指す操作・区間の範囲) は 1 つの判定 `clipOpBusy()` にまとめ、IN / OUT / ＋ 区間を追加も
それに従わせる。

**Tech Stack:** TypeScript strict / Chrome MV3 (crxjs + vite) / vitest + jsdom / Playwright

## Global Constraints

### 要件由来 (依頼文・合意内容・ADR から逐語コピー)

- 1c-4 の範囲 (`.claude/plans/2026-11-03-transcript-search.md` 末尾「1c-4 に持ち越すもの」) のうち、次を扱う:
  - 「欄の操作の待ち (`indexedAwaiting`) と ±0.1 の待ち (`rangeAwaiting`) は、通知が落ちると次の状態まで下りない。IN / OUT・＋ 区間を追加・拡大バーのドラッグは、欄の組 (SET_CLIP) と混ぜる守りをまだ持たない」
  - 1c-1 から「±0.1 の待ちに上限が無い・OUT 直後の ±0.1 の巻き戻り・トラックを押しても欄にフォーカスが移らない」
  - 1b-2 から「保存から読めたのに吹き替えの判定を待つ間「取っています…」のまま」「保存する字幕が頼んだ動画のものかの確かめ・`language` / `name` の長さの上限」「保存の索引の割り込みで漏れたキーが残る」「router が `apply` の前に `captureTabId` を書く」「Shift の範囲選択で区間が数千になる」「`text.slice(0, 500)` がサロゲートペアを割る」「状態の欄の「録画中… (N秒)」「書き出しています…」が残る」「広告の再生中に行を押すと duration が広告の長さ (＋ ここに字幕を足すも同じ)」
- Shift の範囲選択は「合計が上限を超えたら止める (推奨)」(回答 2026-11-04): Shift で入れた結果の合計が上限を超えるなら、入れずに理由を出す。行を 1 つずつ押すときは今どおり
- 扱わないもの (回答 2026-11-04):
  - 「別の動画で行を押すと前の動画の区間とテロップを確かめずに置き換える」→ 動画ごとに下書きを持つ別の段階にする (「urlごとに別の状態を持てない？」→「別の段階にする (推奨)」)。1c-4 の後に設計 (ADR) から始める
  - 「長い配信は単語の時刻を落として保存する」→ 段階 4 (「段階 4 に回す (推奨)」)
  - crxjs の loader の警告そのもの (1c-3 で smoke から外した)
- 確かめた結果もう片付いているもの: 「`isClipOf` の受理判定が `JSON.stringify`」(今は項目ごとに比べている。`youtube.ts` の `isClipOf` / `sameTelop`)
- 行・テロップの文字は信用できない入力: DOM には `textContent` でだけ入れる

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する (Task 1)
- git は `git -C <dir> ...`、gh は `gh <subcommand> -R trapple/yt-clip ...`
- commit は日本語の Conventional Commits、本文に Why。署名に失敗したら止めてユーザーに伝える
- 外部プロセスには timeout を付ける
- 小さく回す: 単体テスト → typecheck → 全テスト → 実機
- push / PR / merge はユーザーの指示を待つ

### 運用前提 (brainstorming で確定した実装方式)

- モード: guarded (ユーザーが 3 点に回答済み。実装は止まらず進め、実機の確かめだけユーザーに頼む)
- 隔離: branch `fix/carry-overs` (develop 853aeac から切った)
- 実装方式: B (branch + 直列、このセッションで私が消化)
- 実機の確かめは普段の Chrome (Claude in Chrome)。dist を作り直したら chrome://extensions での再読み込みをユーザーに頼む

---

## ファイル構造

| ファイル | 責務 | タスク |
|---|---|---|
| `README.md` / `docs/manual-check.md` / `CHANGELOG.md` | 振る舞いの変わる所 | 1 |
| `src/content/transcript-loader.ts` | 保存から読めたら先に ready | 2 |
| `src/content/caption-source.ts` / `src/content/caption-bridge-protocol.ts` / `src/content/transcript-cache.ts` | 字幕の動画の確かめ・長さの上限・索引から漏れたキー | 3, 4 |
| `src/background/router.ts` | 受け入れたときだけ録画対象のタブを移す | 5 |
| `src/shared/telop.ts` / `src/content/transcript-selection.ts` / `src/content/youtube.ts` | サロゲートペアを割らずに切る | 6 |
| `src/content/youtube.ts` | 状態の欄・広告・Shift の合計・待ちの守り・トラックのフォーカス | 7〜11 |
| `src/content/trim-panel.ts` | `focus()` | 11 |

---

### Task 1: 文書

**Files:**
- Modify: `README.md`・`docs/manual-check.md`・`CHANGELOG.md`

- [ ] **Step 1: README の「文字起こしの欄」**
  - 「Shift + 行を押す」の項に足す: 「入れた結果の全区間の合計が上限 (設定、既定 60 秒) を超えるときは入れずに理由を出す (行を 1 つずつ押すときは超えても作れて、録画で止める)」
  - 「行を押した・手入力の行や見出しを操作した答えが返るまでは、もう一方の操作を受けない」の段落を、IN / OUT・＋ 区間を追加・詰める欄の ±0.1・拡大バーのドラッグも含めた形に書き換える: 「**区間やテロップを変える操作 (行を押す・手入力の行・見出しの ✕・IN / OUT・＋ 区間を追加・±0.1・拡大バーのドラッグ) は、前の操作の答えが返るまで次を受けない**」。理由の括弧書きは今のものに「±0.1 を IN / OUT の答えの前に押すと、OUT で動かした尻が戻る」を足す。続けて「文字起こしのある動画では IN / OUT の答えの後に行のテロップを揃える組も送るので、IN / OUT を素早く続けて押すと 2 回目は待たされる」と書く
  - 「仕様と制約」の「録画中に広告が挟まると中断される」の後に足す: 「**広告の再生中は区間とテロップを作れない** (行を押す・IN / OUT・＋ 区間を追加・＋ ここに字幕を足す)。動画の長さと再生位置が広告のものになり、区間が詰まる」
- [ ] **Step 2: README の「詰める欄」** — キーの説明 (「ハンドルかボタンを触った後」) に「拡大バーのトラックを押した後」を足す
- [ ] **Step 3: manual-check の「文字起こしの欄」と「詰める欄」に足す**

```markdown
- [ ] 間の空いた行を Shift で広く選び、合計が上限を超えるときは入らずに理由が出る (1 つずつ押せば超えても入る)
- [ ] 広告の再生中に行を押す・IN・OUT・＋ 区間を追加・＋ ここに字幕を足す を押すと、広告の理由が出て区間もテロップも変わらない
- [ ] 保存から読める動画 (2 回目に開いた動画) で、欄がすぐ行を出す (吹き替えの判定を待たない)
- [ ] OUT を押してすぐ ±0.1 を押すと「前の操作の答えを待っています」が出て、OUT で動かした尻が戻らない
- [ ] 録画を ■ 中止すると、状態の欄が「録画中… (N秒)」のまま残らず、区間の範囲の文言に戻る。録り終えてプレビューに入ると「録画を書き出しています…」が残らない
```

「詰める欄」に:

```markdown
- [ ] 拡大バーのトラックを押して再生した後、`,` `.` で選んでいる端が動く (YouTube のコマ送りにならない)
```

- [ ] **Step 4: CHANGELOG の「未リリース」に足す**

```markdown
**細かな不具合を直した。** 録画を中止した後やプレビューに入った後に、状態の欄の「録画中…」「書き出しています…」が残らない。
広告の再生中は区間とテロップを作らない (区間が広告の長さで詰まっていた)。OUT の直後に ±0.1 を押しても尻が戻らない。
2 回目に開いた動画の文字起こしがすぐ出る。Shift で選んだ行の合計が上限を超えるときは入れずに理由を出す。
```

- [ ] **Step 5: commit** — `docs: 1c-4 の持ち越しの片付けで変わる振る舞いを書く` (Why: コードより先に、待ちの守り・広告・Shift の合計・状態の欄の振る舞いを文書にする)

---

### Task 2: 保存から読めたら、吹き替えの判定を待たずに行を出す

**Files:**
- Modify: `src/content/transcript-loader.ts` (`run` の `cached !== null` の枝)
- Test: `tests/content/transcript-loader.test.ts`

- [ ] **Step 1: 失敗するテスト**

```typescript
test("保存から読めたら、吹き替えの判定を待たずに ready を出し、判定が返ったら出し直す", async () => {
  const dubbed = deferred<boolean>();
  const { loader, statuses } = setup({ loadCached: async () => transcript("a"), readDubbed: () => dubbed.promise });
  loader.load("a");
  await flush();
  expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: false });
  dubbed.resolve(true);
  await flush();
  expect(statuses.at(-1)).toEqual({ kind: "ready", videoId: "a", transcript: transcript("a"), dubbed: true });
});

test("判定が偽なら出し直さない", async () => {
  const { loader, statuses } = setup({ loadCached: async () => transcript("a"), readDubbed: async () => false });
  loader.load("a");
  await flush();
  expect(statuses.filter((status) => status.kind === "ready")).toHaveLength(1);
});
```

(`setup` / `transcript` / `flush` / `deferred` はそのファイルのものに合わせる。無ければ同じファイルの Promise の組み立てを使う)

- [ ] **Step 2: 失敗を確認** — `npx vitest run tests/content/transcript-loader.test.ts`
- [ ] **Step 3: 実装**

```typescript
        if (cached !== null) {
          // 行は先に出す (判定は広告の間は最長 3 分待つ。待つ間「取っています…」のままにしない)。吹き替えなら出し直す
          set({ kind: "ready", videoId, transcript: cached, dubbed: false });
          // ※ 局所例外 (Fail Fast): 判定が読めなくても文字起こしは使える。知らせるだけの機能なので偽に倒し、理由は残す
          const dubbed = await deps.readDubbed(videoId, signal).catch((error: unknown) => {
            if (!signal.aborted) console.warn(`[yt-clip] 吹き替えの判定を読めませんでした: ${String(error)}`);
            return false;
          });
          if (dubbed && mine === generation) set({ kind: "ready", videoId, transcript: cached, dubbed: true });
          return;
        }
```

- [ ] **Step 4: 通過を確認** — `npx vitest run tests/content && npx tsc --noEmit` (youtube-transcript-panel.test などで ready の回数を数えていれば合わせる)
- [ ] **Step 5: commit** — `fix(content): 保存から読めた文字起こしは、吹き替えの判定を待たずに出す`

---

### Task 3: 字幕が頼んだ動画のものかを確かめ、言語と名前の長さに上限を付ける

**Files:**
- Modify: `src/content/caption-source.ts` (`fetchOfficialTranscript`)・`src/content/caption-bridge-protocol.ts` (定数)・`src/content/transcript-cache.ts` (`isTranscript`)
- Test: `tests/content/caption-source.test.ts`・`tests/content/transcript-cache.test.ts`

**Interfaces:** Produces `MAX_LANGUAGE_CODE_LENGTH = 35` / `MAX_TRACK_NAME_LENGTH = 200` (`caption-bridge-protocol.ts`)

- [ ] **Step 1: 失敗するテスト**
  - caption-source: track の `baseUrl` の `v` が頼んだ videoId と違う (`...timedtext?v=other&lang=ja`) と `CaptionError` (「別の動画の字幕が返りました」) で reject。`v` が無いときも同じ
  - caption-source: `languageCode` が 36 文字・`name` が 201 文字の track は使う字幕の候補から落とす (ほかの track で取れる。落とした track しか無ければ `none`)。35 / 200 文字は使う
  - (応答ごと捨てない: 判定で捨てると無応答扱いになり、6 回頼み直した末に「ページからの応答がありません」になって理由が分からない)
  - cache: `language` が 36 文字の保存値は `isTranscript` が false
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**

```typescript
// caption-bridge-protocol.ts
/** 言語コードの長さの上限 (BCP 47 の実用の長さ)。応答はページが偽れるので、巨大な文字列を保存に流さない */
export const MAX_LANGUAGE_CODE_LENGTH = 35;
/** 字幕の表示名の長さの上限 */
export const MAX_TRACK_NAME_LENGTH = 200;

```

```typescript
// caption-source.ts の fetchOfficialTranscript、pickTrack の前
  // 言語や名前が上限より長い track は使わない (応答はページが偽れる。巨大な文字列を保存に流さない)。応答ごと捨てると
  // 無応答と見分けられないので、その track だけ落とす
  const tracks = answer.tracks.filter(
    (track) => track.languageCode.length <= MAX_LANGUAGE_CODE_LENGTH && track.name.length <= MAX_TRACK_NAME_LENGTH,
  );
  const track = pickTrack(tracks);
```

```typescript
// caption-source.ts の fetchOfficialTranscript、track を選んだ直後
  // 字幕の URL は頼んだ動画のものか (応答はページが偽れる。別の動画の字幕をこの動画の名で保存しない)
  if (new URL(track.baseUrl).searchParams.get("v") !== videoId) {
    throw new CaptionError("別の動画の字幕が返りました");
  }
```

(`new URL` が投げる不正な URL は、すぐ後の `withPot` の `isTimedtextUrl` と同じく CaptionError にする: `isTimedtextUrl(track.baseUrl)` を先に見る)

```typescript
// transcript-cache.ts の isTranscript
    typeof value.language === "string" &&
    value.language.length <= MAX_LANGUAGE_CODE_LENGTH &&
```

- [ ] **Step 4: 通過を確認** — `npx vitest run tests/content && npx tsc --noEmit`
- [ ] **Step 5: commit** — `fix(content): 字幕が頼んだ動画のものかを確かめ、言語と名前の長さに上限を付ける`

---

### Task 4: 保存のたびに、索引から漏れた文字起こしを消す

**Files:**
- Modify: `src/content/transcript-cache.ts`
- Test: `tests/content/transcript-cache.test.ts`

**Interfaces:** `TranscriptStorage` に `keys(): Promise<string[]> | null` を足す (本物は `chrome.storage.local.getKeys`。無い環境では null を返し、掃除を飛ばす。`get(null)` は毎回最大 9MB ほどを読むので使わない)

- [ ] **Step 1: 失敗するテスト** — (偽の storage の `keys` は持っている鍵を返す。`keys` が null のときは何も消さないテストも足す) 保存に `transcript:orphan` (索引に無い) と索引にある `transcript:a` がある状態で `saveTranscript(transcript("b"))` を呼ぶと、`transcript:orphan` が消え、`transcript:a` と `transcript:b` は残る。`transcriptIndex` など prefix の違う鍵は消さない
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — `saveTranscript` の `set` が通った後 (`return` の前) に、**書いた索引 `kept` を渡して**
`await removeOrphans(storage, kept).catch((error) => console.warn(...))` を呼ぶ (保存前の `index` を渡すと、今保存した鍵を消す):

```typescript
/**
 * 索引に無い `transcript:<id>` を消す。2 つのタブが同時に保存すると、後から書いた索引に先の動画が載らず、その鍵は
 * 30 本の追い出しに掛からないまま残る
 */
async function removeOrphans(storage: TranscriptStorage, written: readonly IndexEntry[]): Promise<void> {
  const listing = storage.keys();
  if (listing === null) return;
  const keys = await listing;
  // 消す直前に索引を読み直す。別のタブがこの間に書いた索引の鍵は消さない (書いた索引 written との和に無い鍵だけ)
  const latest = readIndex((await storage.get([TRANSCRIPT_INDEX_KEY]))[TRANSCRIPT_INDEX_KEY]);
  const kept = new Set([...written, ...latest].map((entry) => keyOf(entry.videoId)));
  const orphans = keys.filter((key) => key.startsWith(TRANSCRIPT_KEY_PREFIX) && !kept.has(key));
  if (orphans.length > 0) await storage.remove(orphans);
}
```

`chromeLocalStorage` に:

```typescript
  // getKeys は Chrome 130 から。@types/chrome の版に無いので型を足して呼ぶ。無ければ掃除を飛ばす (null)
  keys: () => {
    const local = chrome.storage.local as typeof chrome.storage.local & { getKeys?: () => Promise<string[]> };
    return local.getKeys !== undefined ? local.getKeys() : null;
  },
```

テストの偽の storage にも `keys` を足す。※ 局所例外 (Fail Fast): `removeOrphans` の失敗は warn にして保存の成功を覆さない (掃除は保存の目的ではない)

- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: commit** — `fix(content): 文字起こしを保存するたびに、索引から漏れた保存を消す`

---

### Task 5: router は受け入れたイベントでだけ録画対象のタブを移す

**Files:**
- Modify: `src/background/router.ts` (`handleEvent` の `captureTabId = senderTabId` の 2 か所、`apply`)
- Test: `tests/background/router.test.ts`

- [ ] **Step 1: 失敗するテスト** — タブ 1 の MARK_IN で ready → タブ 2 から拒まれる `ADJUST_SEGMENT` (index 5) → popup から送り主の無い `START_RECORDING`。seeking の通知 (`sendToTab`) の宛先と persist の `captureTabId` がタブ 1 のまま。もう 1 本: ready (タブ 1) でタブ 2 から受け入れられる `MARK_OUT` を送ると、その通知はタブ 2 に届く (今の振る舞いを守る)
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — 移す先を先に決め、`apply` が受け入れたときだけ publish の前に書く:

```typescript
    // 移す先は決めるだけ。書くのは apply が受け入れたとき (拒まれた操作で録画対象を移さない)。publish が新しいタブへ
    // 通知を届けるよう、publish の前に書く
    const owner =
      senderTabId !== undefined &&
      (event.type === "MARK_IN" || event.type === "ADD_SEGMENT" ||
        (!BUSY_KINDS.has(state.kind) && TAB_OWNING_EVENTS.has(event.type)))
        ? senderTabId
        : null;
    ...
    const previous = await apply(event, owner);
```

```typescript
  async function apply(event: ClipEvent, owner: number | null = null): Promise<ClipState | null> {
    const next = reduce(state, event);
    if (event.type !== "FAIL" && isRejectedTransition(state, next)) { /* 今のまま */ return null; }
    if (owner !== null) captureTabId = owner;
    const previous = state;
    await publish(next);
    return previous;
  }
```

(MARK_IN の録画中のガードと SEEK_DONE の枝は今のまま、その前に置く。コメントは今の 2 つの段落を `owner` の上にまとめる)

- [ ] **Step 4: 通過を確認** — `npx vitest run tests/background && npx tsc --noEmit`
- [ ] **Step 5: commit** — `fix(background): 受け入れたイベントでだけ録画対象のタブを移す`

---

### Task 6: テロップの文字を上限で切るとき、サロゲートペアを割らない

**Files:**
- Modify: `src/shared/telop.ts` (`clampTelopText` を足す)・`src/content/transcript-selection.ts` (3 か所)・`src/content/youtube.ts:768`
- Test: `tests/shared/telop.test.ts`

- [ ] **Step 1: 失敗するテスト**

```typescript
test("上限で切るとき、サロゲートペアを割らない", () => {
  const text = "あ".repeat(MAX_TELOP_TEXT_LENGTH - 1) + "𠮷";
  expect(clampTelopText(text)).toBe("あ".repeat(MAX_TELOP_TEXT_LENGTH - 1));
  expect(clampTelopText("短い")).toBe("短い");
  expect(clampTelopText("あ".repeat(MAX_TELOP_TEXT_LENGTH + 5)).length).toBe(MAX_TELOP_TEXT_LENGTH);
});
```

- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**

```typescript
/**
 * 上限 (UTF-16 の長さ) までに切る。**サロゲートペアの片方で切らない** (片方だけの文字は描けず、保存の検証も通らない
 * 恐れがある)。上限は状態機械の検証 (`text.length`) と同じ単位
 */
export function clampTelopText(text: string): string {
  if (text.length <= MAX_TELOP_TEXT_LENGTH) return text;
  const last = text.charCodeAt(MAX_TELOP_TEXT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_TELOP_TEXT_LENGTH - 1 : MAX_TELOP_TEXT_LENGTH;
  return text.slice(0, end);
}
```

`line.text.slice(0, MAX_TELOP_TEXT_LENGTH)` の 4 か所を `clampTelopText(line.text)` にする。transcript-selection.ts の import は `MAX_TELOP_TEXT_LENGTH` から `clampTelopText` に差し替える (残すと `noUnusedLocals` で落ちる)

- [ ] **Step 4: 通過を確認** — `npx vitest run && npx tsc --noEmit`
- [ ] **Step 5: commit** — `fix(content): 字幕の行の文字をテロップの上限で切るとき、サロゲートペアを割らない`

---

### Task 7: 録画を離れたら、状態の欄の「録画中…」「書き出しています…」を出し直す

**Files:**
- Modify: `src/content/youtube.ts` (`applyStateToDisplay`)
- Test: `tests/content/youtube.test.ts` (録画の流れを組めるファイル。無ければ youtube-transcript-panel.test の emit で組む)

- [ ] **Step 1: 失敗するテスト**
  - recording の状態を描いて状態の欄に「録画中…」を書いた後 (`#yt-clip-bar-status` に直接書いてもよい)、同じ区間の ready を描くと、状態の欄が `rangeLabel` の文言 (例「0:00 〜 0:09 (9秒)」)
  - encoding の後に preview を描くと、状態の欄が `PREVIEW_STATUS` (「録画できました。X に投稿 か 取り直す を選んでください」)
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 1 に足すテスト** — 合計が上限を超えて録画を始められなかった (「合計 N 秒は上限 M 秒を超えています」を出して CANCEL_RECORDING) 後に ready を描いても、その理由の文言が残る
- [ ] **Step 3: 実装** — **録画中の文言を書いたかを旗 `recordingStatusShown` で持つ** (busy から抜けただけで戻すと、`prepareRecording` が出した上限超えの理由まで消す)。`watchSegmentEnd` の「録画中…」・区間の移動中の「N / M 区間目へ移動中…」・「録画を書き出しています…」を出すときに立て、`applyStateToDisplay` の文言の出し分けの最後で、旗が立っていて busy でない種類になったときだけ出し直して下ろす:

```typescript
/** プレビューに入ったときの状態の欄。ボタンの文言 (ACTION_LABELS) と揃える */
const PREVIEW_STATUS = "録画できました。X に投稿 か 取り直す を選んでください";
```

```typescript
  // 録画を離れた (中止・書き出し済み)。録画の間に書いた「録画中… (N秒)」「書き出しています…」を残さない
  if (recordingStatusShown && !BUSY_KINDS.has(state.kind)) {
    recordingStatusShown = false;
    if (state.kind !== "failed") setStatus(state.kind === "preview" ? PREVIEW_STATUS : restingStatus());
  }
```

(failed は上で失敗の文言を出している。旗はオフ・作り直し (`runId` を上げる所) でも下ろす)

- [ ] **Step 4: 通過を確認** — `npx vitest run && npx tsc --noEmit`
- [ ] **Step 5: commit** — `fix(content): 録画を中止した後とプレビューに入った後に、状態の欄の録画中の文言を残さない`

---

### Task 8: 広告の再生中は区間とテロップを作らない

**Files:**
- Modify: `src/content/youtube.ts` (`onMarkIn`・`onToggleLine`・`onAddSegment`・`onMarkSegmentStart`・`onMarkOut`・`onAddTelop`)
- Test: `tests/content/youtube-transcript-panel.test.ts` / `tests/content/youtube.test.ts`

- [ ] **Step 1: 失敗するテスト** — `#movie_player` に `ad-showing` クラスを付けた状態で、行を押す・＋ 区間を追加・IN・OUT・＋ ここに字幕を足す を押すと、`events` が空で、状態の欄が `FAILURE_MESSAGES["ad-playing"]` (「広告の再生中です。終了後にやり直してください」)。後片付けでクラスを外す
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**

```typescript
/**
 * 広告の再生中か。**区間とテロップを作る操作の頭で見る**: 広告の間は video の duration と currentTime が広告のもので、
 * 区間が広告の長さに詰まる・広告の中の時刻で IN を打つ。理由を出して止める
 */
function refuseDuringAd(): boolean {
  if (!isAdPlaying()) return false;
  setStatus(FAILURE_MESSAGES["ad-playing"]);
  return true;
}
```

`onMarkIn` (`startOver` の MARK_IN の道も通る)・`onToggleLine` (`canEditFromTranscript` の直後)・`onAddSegment`・`onMarkSegmentStart`・`onMarkOut`・`onAddTelop` (`canEditTelops` の直後) に `if (refuseDuringAd()) return;` を足す。テストも 6 つの入口で見る

- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: commit** — `fix(content): 広告の再生中は、行・IN / OUT・＋ 区間を追加・＋ ここに字幕を足す で区間とテロップを作らない`

---

### Task 9: Shift の範囲選択で合計が上限を超えるなら入れない

**Files:**
- Modify: `src/content/youtube.ts` (`onToggleLine` の `tooLong` の後)
- Test: `tests/content/youtube-transcript-panel.test.ts`

- [ ] **Step 1: 失敗するテスト** — 2 秒の行を 6 秒おきに 40 行 (`JOIN_GAP_SEC` の 3 秒より空く。1 区間は上限以下、合計 80 秒で上限 60 秒を超える) の文字起こしをテスト内で渡し、最初の行を押してから最後の行を Shift で押すと、2 回目の SET_CLIP を送らず、状態の欄に「合計が上限」を含む文言。1 行ずつ押した場合は送る (今どおり)
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**

```typescript
  // Shift で (起点からまとめて) 入れた結果の合計が上限を超えるなら送らない。起点が無い Shift は 1 行だけなので見ない (間の空いた行を広く選ぶと、区間が数千になる)。
  // 1 つずつ押したときは今どおり作れて、録画で止める (回答 2026-11-04「合計が上限を超えたら止める」)
  if (ids.length > 1 && selected && totalSec(next.segments) > maxClipSec && totalSec(next.segments) > totalSec(base.segments)) {
    setStatus(`選んだ行の合計が上限 ${maxClipSec} 秒を超えます。範囲を狭めて選んでください (設定で上限を変えられます)`);
    return;
  }
```

- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: commit** — `fix(content): Shift の範囲選択で、合計が上限を超えるなら行を入れない`

---

### Task 10: 区間とテロップを変える操作の待ちを 1 つにまとめる

**Files:**
- Modify: `src/content/youtube.ts` (`sendIndexed`・`canSendClip`・`onNudge`・`onRangeCommitted`・`onAddSegment`・`onMarkSegmentStart`・`onMarkOut`)
- Test: `tests/content/youtube-transcript-panel.test.ts` / `tests/content/youtube.test.ts`

- [ ] **Step 1: 失敗するテスト**
  - OUT を押して答えが届く前に ±0.1 を押すと、ADJUST_SEGMENT を送らず「前の操作の答えを待っています」が出る (`events` は MARK_OUT だけ)
  - ＋ 区間を追加の答えの前に行を押すと SET_CLIP を送らない
  - 行を押した答えの前に IN / OUT / ＋ 区間を追加を押すと送らない
  - ±0.1 を送り、応答は受け入れたが状態の通知が来ない (テストの `sendMessage` で emit を落とす) とき、1500ms 後に ±0.1 がまた効く (`vi.useFakeTimers` か、待ちの定数を待つ)
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**

```typescript
/**
 * 区間とテロップを変える操作の答えを待っているか。**待っている間は次を受けない** (欄の組の丸ごと差し替え・位置で指す
 * 操作・区間の範囲は、答えを待たずに混ぜると互いの結果を古い写しで戻す。OUT の直後の ±0.1 は OUT で動かした尻を戻す)
 */
function clipOpBusy(): boolean {
  return pendingClip !== null || indexedAwaiting || rangeAwaiting !== null;
}
```

- `sendIndexed` の頭の判定を `clipOpBusy()` にする (今は `rangeAwaiting` を見ていない)
- `canSendClip` は **`pendingClip` を含めない**: `indexedAwaiting || rangeAwaiting !== null` にする (行は答えを待たずに続けて押せる。`clipBase()` が送った組に積む。含めると「答えを待たずに続けて押しても、先に押した行は消えない」のテストが落ちる)
- `onNudge` の `rangeAwaiting !== null || pendingClip !== null` を `clipOpBusy()` に。`onRangeCommitted` の `pendingClip !== null` も `clipOpBusy()` に (ドラッグの確定は答えを待つ間なら今の区間で描き直す)
- `onMarkIn` (`startOver` の MARK_IN の道を含む)・`onAddSegment`・`onMarkSegmentStart`・`onMarkOut` の頭 (録画中・広告のガードの後) に:

```typescript
  if (clipOpBusy()) {
    setStatus(CLIP_BUSY_MESSAGE);
    return;
  }
```

  そのうえで ＋ 区間を追加・IN (頭を動かす道)・OUT の 3 つは送った範囲を待つ: `rangeAwaiting = next` (＋ 区間を追加は `range`) を送る直前に書き、`accepted` で受け入れられなかったら **`applyStateToDisplay(response.state)` より前に** 下ろす (`onRangeCommitted` の `settle` と同じ形。`undelivered` でも下ろす)。`onAddSegment` には今 `accepted` が無いので `(state) => hasSegment(state, range)` を足す (ADD_SEGMENT は範囲を丸めも混ぜもしないので `sameRange` で下りる)。MARK_IN (作り直し) は区間を丸ごと置き換えるので範囲は待たない (ガードだけ)
- 振る舞いの変わり目: IN / OUT の答えを描くと `syncTelopsToSegments` が SET_CLIP を送るので、文字起こしのある動画で IN / OUT を素早く続けて押すと 2 回目は「待っています」になる。Task 1 の README と manual-check に書く
- `rangeAwaiting` が通知の落ちで下りない道を塞ぐ: `onRangeCommitted` (と上の 3 つ) の `accepted` で受け入れられたら、送ってから何も描いていない (`drawCount === sentAt`) まま `INDEXED_ANSWER_WAIT_MS` 経ったときに答えの状態を描く (描けば下りる)。何か描いていれば待ちを下ろすだけにする (`sendIndexed` の `indexedFallback` と同じ規則)。共通の形にまとめる:

```typescript
/**
 * 送った操作の答え (応答の状態) を、通知が来ないときの代わりに描く。router は通知を応答より先に送るので、ふつうは
 * もう描いている。送ってから何も描いていないまま待ちの上限が過ぎたら、答えの状態を描く (描けば待ちが下りる)。
 * 何か描いていれば、描いたのは答えの通知かそれより新しい状態なので、still() が真のときだけ release() で待ちを下ろす
 */
function drawAnswerIfSilent(state: ClipState, sentAt: number, still: () => boolean, release: () => void): void {
  const id = runId;
  setTimeout(() => {
    if (!isCurrentRun(id) || !still()) return;
    if (drawCount === sentAt) applyStateToDisplay(state);
    else release();
  }, INDEXED_ANSWER_WAIT_MS);
}
```

  (`sendIndexed` の今の `indexedFallback` は、答えの鍵 (`indexedResult`) を見る分だけ形が違う。無理に寄せず、そのままにしてよい)

- [ ] **Step 4: 通過を確認** — `npx vitest run && npx tsc --noEmit`。前からの「±0.1 を続けて押す」「欄の組と位置の操作を混ぜない」テストが通ること
- [ ] **Step 5: commit** — `fix(content): 区間とテロップを変える操作の待ちを 1 つにまとめ、IN / OUT・＋ 区間を追加も答えを待つ`

---

### Task 11: 拡大バーのトラックを押したら、詰める欄にフォーカスを移す

**Files:**
- Modify: `src/content/trim-panel.ts` (`focus()`)・`src/content/youtube.ts` (`onSeekPlay` の呼び出し)
- Test: `tests/content/trim-panel.test.ts`

- [ ] **Step 1: 失敗するテスト** — `document.body.append(panel.element)` してから (jsdom はつないだ要素にしかフォーカスを移さない。今の `mount` はつないでいる) `panel.focus()` の後 `document.activeElement === panel.element`
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — `TrimPanel` に `focus(): void` (`element.focus({ preventScroll: true })`)。`setActiveEdge` の中のフォーカスもこれを呼ぶ。youtube.ts の `onSeekPlay: (sec) => { trimPanel?.focus(); void onSeekPlay(sec); }`
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: commit** — `fix(content): 拡大バーのトラックを押したら詰める欄にフォーカスを移し、, . が効くようにする`

---

### Task 12: 実機で確かめる

- [ ] **Step 1:** `npm test && npx tsc --noEmit`、`npx playwright test e2e/smoke.spec.ts` (timeout 600 秒)
- [ ] **Step 2:** `npm run build`、拡張の再読み込みをユーザーに頼む
- [ ] **Step 3:** 普段の Chrome で Task 1 の manual-check の項目を通す (広告はユーザーに、出たときに押してもらう)
- [ ] **Step 4:** manual-check の「確認した環境」に記録を足して commit (`docs(manual-check): 段階 1c-4 を確かめた記録`)

---

## 完了後

1. `npm test` と `npx tsc --noEmit` で green を確認
2. whole-branch cross-review: develop との merge-base からの diff を 1 ファイルにまとめ、新しい subagent に「保守担当 + 攻撃者」視点のレビューをさせる (node_modules に触らせない・一時ファイルを置かせない)。指摘は直して再レビュー
3. plan の末尾に「完了の記録」と「次に持ち越すもの」を書いて commit
4. branch 上の commit で停止。push / PR / merge はユーザーの指示を待つ

## 自律判断ログ

- [回答] 別の動画で行を押したときの置き換えは、動画ごとに下書きを持つ別の段階にする (2026-11-04「urlごとに別の状態を持てない？」→「別の段階にする (推奨)」)
- [回答] Shift の範囲選択は合計が上限を超えたら止める (2026-11-04「合計が上限を超えたら止める (推奨)」)
- [回答] 長い配信の単語の時刻の保存は段階 4 (2026-11-04「段階 4 に回す (推奨)」)
- [選択] 広告の間は区間とテロップを作る操作を止める (duration を無限とみなす案は取らない) — IN / OUT の再生位置も広告のものになる。録画の開始が広告で止まるのと同じ文言にする
- [選択] 待ちは 3 つの変数のまま、判定だけ `clipOpBusy()` にまとめる — 1 つの変数にすると、下ろす条件 (欄の組は isClipOf、位置の操作は応答の鍵、範囲は sameRange) を混ぜることになる
- [選択] 保存から読めた文字起こしは dubbed: false で先に出し、吹き替えなら出し直す — 判定は広告の間は最長 3 分待つ。知らせが遅れるだけで、行は使える
- [選択] 索引から漏れた鍵は保存のたびに消す (読むときではない) — 保存は新しい動画を開いたときだけで回数が少ない
- [cross-review] plan を 1 回 (ゼロ context の実装者。scratch の複製で Task 10 を当てて確かめた)。Issues 10 件 (canSendClip に pendingClip を含めると行を続けて押せない・中止の後の文言で上限超えの理由を消す・onMarkIn の作り直しの道の漏れ・Task 9 のテストの組み方・孤立した鍵の消し方と get(null) の重さ・Task 5 のテストが直す前から通る・onAddSegment に accepted が無い・import の残り・jsdom のフォーカス・長い track で応答ごと捨てる) を直した。直しは具体的なので 2 回目は回さず実装に引き継ぐ
- [cross-review] whole-branch review を 1 回 (保守担当 + 攻撃者)。Issues (Important 1: 欄の組の通知が落ちると pendingClip が下りず、待ちをまとめたので IN / OUT・±0.1 まで止まる。Minor 3: 別の動画へ移ると rangeAwaiting が下りない・作り直しの IN が答えを待たない・待つ間のドラッグが黙って戻る) を ff2423c で直した。Important を直したので直しの commit だけを再レビュー。Issues 1 件 (基準を送った時点に取ると、行を続けて押して後の通知だけ落ちたとき押した行が黙って消える) を 86a539b で直した (応答を受けた時点を基準にする)。1 か所の直しで失敗するテストで確かめたので 3 回目は回さない

## 完了の記録 (2026-11-04)

- Task 1〜12 を commit (e6a03f1 / 0dbaae2 / 29adb2a / 189f734 / bf76e14 / a39255b / 05f10b9 / cf983fb / 057fbbe / 6ea9251 / 3691284 / bf9fbc7)。plan は 5d1f721。レビューの直しは ff2423c / 86a539b
- 計画からの逸脱:
  - Task 10 はテストより先に実装を書いた。後から足したテスト 4 本が、実装を外すと落ちることを確かめた
  - Task 10 で OUT の直後の ±0.1 は (±0.1 を押し続けたときと同じく) 黙って数えない形にしたので、manual-check の文言を「待っています」が出るから「効かない」に直した
  - レビューの直しで、作り直しの IN (MARK_IN) も範囲の答えを待つ形にした (plan は「ガードだけ」)。youtube.test の IN を 2 回押すテストは、間に作り直した状態の通知を入れる形に直した
  - テストの偽の service worker に、通知を落とす (`dropBroadcast`) と router と同じく通知を応答より先に送る (`broadcastFirst`) 切り替えを足した
- 普段の Chrome で確かめた (manual-check の記録)。広告の再生中と Shift の合計は実機で再現できず、単体テストで確かめた
- 全テスト 1265 件・typecheck・smoke 9 項目が通過

### 次に持ち越すもの

- 別の動画で行を押すと前の動画の区間とテロップを確かめずに置き換える → 次の段階「動画ごとの下書き」(設計 (ADR) から。回答 2026-11-04「urlごとに別の状態を持てない？」→「別の段階にする」)
- 長い配信は単語の時刻を落として保存する → 段階 4 (保存の形と一緒に決める)
- crxjs の loader の警告そのもの (止めるには loader を替える)
- 検索は手入力の行を探さない (ADR 0004 の判断)
- 広告の再生中の振る舞いは、広告が出たときにユーザーに手で確かめてもらう
- 位置で指す操作の待ち (`indexedAwaiting`) の下ろし方は、答えの鍵を見る形のまま (`drawAnswerIfSilent` に寄せていない)。寄せるなら応答を受けた時点を基準にする
