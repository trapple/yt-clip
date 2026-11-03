# 窓の分割 (spec の C1) 実装プラン

> **実装者向け:** このプランは下の「運用前提」に書いた実装方式 (SDD) で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** 今のパネルの窓 (区間・テロップの一覧 + 設定) を **区間・テロップの窓** と **設定の窓** に分け、窓を 3 つ
(バー / 区間・テロップ / 設定) にする。⚙ は設定の窓を開閉し、パネルの折り畳み (▶) はやめる。覚える配置は
`windowLayout` の v2 の組 (`{ version: 2, float, docks }`。C1 では `docks` は常に空) にする。

**Architecture:** `side-panel.ts` を `panel-window.ts` (見出しのある「幅と高さ」の窓 + 中身の箱 + `scrollTo`。折り畳みなし) に
置き換え、`youtube.ts` はこれで `listWindow` と `settingsWindow` の 2 つを作る。`floating-window.ts` は重なり順を「触った順」に
し、外から前に出す `bringToFront()` を足す。`window-layout.ts` は v1 (`{ bar?, panel? }`) と v2 を読み分け、保存は組ごと
(`saveWindowLayout`)。`youtube.ts` は覚えた `float` の写し (`floatLayout`) を持ち、書き換えるのは読み込み・`onUserMove`・
ダブルクリックの消去の 3 箇所だけにして、窓の `rect()` からは組を作らない。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Playwright / Chrome Extension MV3

**spec:** `.claude/specs/2026-09-25-dockable-windows-design.md` (以下「spec」)。**この plan は spec の「C1. 窓の分割」と、
「テスト」「ドキュメント」節の C1 に関わる部分。** C2 (ドック枠とタブ・`dock.ts`・`setDocked` など) は別の plan で扱う。
ただし v2 の形 (`{ version: 2, float, docks }`) と `float` の写しの扱いは C1 で入れる。
前提の branch は `feat/dockable-windows` (HEAD 4a2e744。`feat/floating-windows` の A・B の上)。

## 判断メモ (spec と既存コードの食い違い・spec の曖昧な箇所。autonomous なので自分で決めた)

1. **保存の形 (Task 4) と窓の分割 (Task 5) を別のタスクにする。** どちらも `youtube.ts` を触るが、「読み替え・組の保存・
   `rect()` から作らない」は窓の数と独立に確かめられ、片方だけ差し戻されうる。Task 4 の間は `youtube.ts` の窓はまだ
   2 つ (バーとパネル) で、パネルを `list` として保存する。そのため Task 4 の `windowOf` / `placeInitial` /
   `initialWindowRect` / `resetWindow` の引数は `"bar" | "list"` に絞り、Task 5 で `WindowId` に広げる。Task 4 の間は
   `float.settings` を読まない (書く者もいない)。
2. **`movedWindows` (動かした窓の Set) をやめ、`floatLayout` (覚えた `float` の写し) に窓があるかで「動かした窓」を判定する。**
   spec C2.6 の「`float` に無いフロートの窓 (最初の配置のまま) は最初の位置を取り直す」と同じ規則で、2 つの持ち物が
   食い違う経路 (片方だけ更新し忘れる) を無くす。
3. **設定の窓の最初の位置は、区間・テロップの窓の「最初の位置」から (0, +32)。今の位置 (動かした後) には付いていかない。**
   spec C1.3 は「区間・テロップの窓から 32px 下」としか書いていない。今の位置に付けると、一覧を動かしたときに動かしていない
   設定の窓も置き直す経路が要り、C2 で一覧がドックしているときの基準も決まらない。1440x795 でプレイヤーに重ならない保証
   (C1.5) も最初の位置どうしでしか成り立たない。ダブルクリックの戻し先も同じ。
4. **`createPanelWindow` は自分で最初の位置に置かない。** spec C1.4 の options に最初の位置が無く、窓が 2 種類になって
   「どちらの最初の位置か」を panel-window.ts が知らないため。`youtube.ts` の `placeInitial` が、窓を出した直後に置く
   (今のバーの窓と同じ経路)。最初の位置の計算は panel-window.ts に `initialListRect(viewport)` /
   `initialSettingsRect(viewport)` として置く (YouTube の実測の値と出所のコメントを同じファイルに置くため)。窓の id
   (`yt-clip-list` / `yt-clip-settings`) は `BAR_WINDOW_ID` と同じく youtube.ts に置く。中身の箱の id は `${id}-body`
   (`yt-clip-list-body` / `yt-clip-settings-body`。E2E と screenshots.mjs が探す)。
5. **`PANEL_WINDOW_STYLE.body` は `display:flex` を持つ。** 今の `SIDE_PANEL_STYLE.body` が display を持たなかったのは、
   折り畳みで本体を出し入れしていたため。折り畳みをやめたので、本体を出し入れする者はいない (窓ごとの出し入れは
   floating-window.ts が窓の根で行う)。
6. **⚙ で開いたとき、設定の窓の中は送らない (`scrollTo` しない)。前に出すだけ。** spec C1.2「設定は窓を前に出す」。設定の窓の
   中身は設定だけなので、先頭まで送る先が無い。区間・テロップの窓の中も送らない (設定は別の窓に出るので、一覧の見ている
   位置を動かす理由が無い)。`bringToFront` は開いたときだけ呼ぶ (閉じたときは呼ばない)。
7. **足した行へ送るとき (`revealLastRow`)、区間・テロップの窓は前に出さない。** spec C1.2 は「区間・テロップの窓の中を
   足した行までスクロール (今と同じ)」だけを書いている。前に出すと、設定の窓で値を見ながら区間を足したときに設定が潜る。
8. **重なり順: 作った窓は「いちばん下」に z-index 2000 で入れ、触った (または `bringToFront` した) ときに全部の窓を
   並びどおり 2000, 2001, … に振り直す。** spec C1.1「z-index 2000 + 触った順」。作ったときに振り直さないので、まだ誰も
   触っていない間は同じ 2000 が並ぶ (今と同じ。DOM の順)。外から前に出すため `FloatingWindow` に `bringToFront(): void`
   を足す (spec C1.2 の `bringToFront`)。
9. **C1 の `mergeWindowLayout` は `docks` の中身を読まず、常に `{}` を返す。** `docks` の検証 (重複・知らない id・入れられない
   組み合わせ・`active` の不整合、「`float` と `docks` の両方にある窓は `docks`」) は C2 の `parseDockState` の役目で、C1 では
   `docks` に何かを入れる経路が無い。ただし v2 の組として `docks` が組 (object) でなければ「型が合わない」として warn して
   空の組にする (C1 自身は常に `docks: {}` を書くので、組でない `docks` は壊れた値)。
10. **版の見分け: `version` のキーが無ければ v1。`version` が 2 以外 (3 以上・1・文字列など) は「読めない版」として warn して
    空の組。** spec の「`version` が 2 より大きい・型が合わない」を、v1 には `version` が無いことと合わせて読んだ。配列も
    「組でないもの」として warn する (今は配列を通してしまい、`bar` などのキーが無いだけの空として扱っている)。
11. **保存は `floatLayout` から毎回組を作って丸ごと書く。前に覚えていた組は読まない。** そのため、覚えていた値のうち読めずに
    捨てた窓 (warn したもの) は、次の保存で消える。読み込みで既に最初の位置に戻しているので、見た目は変わらない。
    v1 は読むときに書き戻さず (spec C1.3)、次に窓を動かした・戻したときに v2 で書かれる。
    **副作用: 別のタブで動かした窓の位置は、こちらのタブで次に窓を動かす・戻すと消える** (こちらのタブは読み込み時の `float` の
    写ししか持たず、後から別のタブが書いた位置を含まない組を書く)。A の「窓ごとに読んで書き戻す」には無かった振る舞いだが、
    spec C1.3 が選んだ作り (組ごと保存) の帰結として受け入れる。**README の「動かした位置と大きさは端末ごとに覚える」の項に
    「同じ端末で複数のタブを開いているときは、最後に窓を動かした (戻した) タブの配置が残る」と書く** (Task 1 Step 3)。理由: 利用者から
    見えるのは「別のタブで動かした位置が戻った」で、書いておかないと不具合と誤認される。書き戻す前に読み直す案は採らない (C2 で
    1 つの操作が 2 つの枠のタブの並びを変える組を、読んだ値と混ぜると整合が崩れる)。`floatLayout` の doc にも一言書く (Task 4 Step 7)
12. **`saveWindowLayout` は呼ばれた時点で組を写してから列に並べる。** 並んでいる間に呼び出し側が `floatLayout` を書き換えても、
    その呼び出しの時点の組を書く (後の保存は後の呼び出しが書く)。
13. **`resetWindow` の保存に失敗したときの warn は「窓の位置を保存できませんでした」に揃える。** 今は「消せませんでした」だが、
    消すのではなく組ごと書く操作になったため。
14. **E2E の受け入れ条件の「窓の中でスクロールする」は、設定の窓の中身の箱 (`#yt-clip-settings-body`) で測る。** 今は
    一覧と設定が入ったパネルの本体で測っている。分けた後の区間・テロップの窓 (区間 5・テロップ 5) は 1440x795 で溢れるか
    分からないが、設定の窓は 1280x800 でも溢れる実績がある (screenshots.mjs のコメント: 最大高さ 716px に収まらない)。
    検査は弱めない。
15. **E2E に 2 項目を足し、名前を 1 つ変える** (24 → 26 項目): 「⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま」と
    「古い形 (v1) の windowLayout があると、パネルの位置に区間・テロップの窓が出る」を足す。「パネルの位置の出所 (YouTube の
    実測)」は「窓の位置の出所 (YouTube の実測)」に変える。受け入れ条件の項目名も設定の窓の条件を含む名前に変える。
    C2 の実測の追加 (`#below` / `#secondary-inner` / `theater`) はこの plan では入れない。
16. **E2E で、一覧の行を押す項目 (帯の確認) の前までに設定の窓を閉じる。** 最初の位置の設定の窓は区間・テロップの窓に下へ
    32px ずれて重なり、一覧の行 (帯の確認で押す区間 1 の行) を覆う。窓の確認の項目どうしは状態を引き継ぐ: 「⚙ で設定が別の窓に
    開閉し…」は開いたまま終え、次の「窓を動かすと…」がそれを前提に始めて最後に閉じる。「掴む場所をダブルクリック…」は開いて
    戻してから閉じる。帯の確認に入るときは必ず閉じている。
17. **CHANGELOG と README には「折り畳みをやめた」「前の版のパネルの位置を引き継ぐ」を書かない。** 右側のパネルもフロートの
    窓も「未リリース」(v1.1.0 の後) で、利用者は折り畳みも v1 の配置も見ていない。CHANGELOG は「利用者から見て何が変わったか」
    を書く決まりなので、未リリースの節の「パネルは見出しで畳める。」を消し (「**区間・テロップ・設定を画面右側のパネルに移した。**」の
    段落そのものは同じ未リリース節の前の変更として残す。後の段落で分けたことを書くので、履歴として読める)、「右側のパネルを区間・テロップの窓と設定の窓に
    分けた」を書く。README は今の振る舞いとして「窓は畳めない (重なるときは動かす)」を書く。v1 の読み替えはコードと
    テストでだけ扱う (この branch で窓を動かした開発者の配置を捨てないため)。
18. **`docs/privacy-policy.md` は窓の名前だけを直し (「操作のバーと右側のパネル」→「操作のバー・区間とテロップの一覧・設定」)、
    最終更新の日付を改める。** 「どの枠に入れたか」は C2 で書く (C1 はドックを保存しない)。
19. **設定の窓の開閉は覚えない** (読み込み直すと閉じている)。今の設定パネルと同じ。E2E の「読み込み直しても同じ位置」は、
    読み込み直した後に ⚙ で開いて測る。

## Global Constraints

### Spec 由来 (spec から逐語コピー)

C1 (spec 21〜129 行目):

**C1.1 窓**

| 窓 | id | 中身 | 見出し (= C2 のタブの文言) | 大きさを変えられる向き |
|---|---|---|---|---|
| バーの窓 | `bar` | 拡大バー + 帯の段 + 操作の行 (今と同じ) | 見出しの行は作らない (A.1 のまま)。タブの文言は「バー」 | 幅だけ (今と同じ) |
| 区間・テロップの窓 | `list` | 区間の一覧 + テロップの一覧 (今のパネルから設定を抜いたもの) | 「区間・テロップ」 | 幅と高さ。中身は窓の中でスクロール (今と同じ) |
| 設定の窓 | `settings` | 設定パネル (`settings-panel.ts`) | 「設定」 | 幅と高さ。中身は窓の中でスクロール |

- 見出しの文言を「yt-clip」から窓の中身の名前に変える。窓が 3 つになると「yt-clip」では区別が付かず、
  C2 ではそのままタブの文言になる
- 区間・テロップの窓と設定の窓の最小の大きさは、今のパネルと同じ (幅 280px・高さ 160px)。バーの窓は幅 480px (今と同じ)
- 3 つの窓が重なったときは、**触った順が新しいほど上** (z-index 2000 + 触った順。3 つなので最大 2002。
  YouTube のヘッダー 2020 より下)。今の「最後に触った窓だけ 2001、残りは 2000」だと、3 つ目からは
  残り 2 つの順が DOM の順で決まり、直前に触った窓が下に潜る

**C1.2 いつ出すか (⚙ との関係、折り畳みのやめ方)**

| 窓 | 出す条件 (共通の条件: 覚えた配置の読み込みが済んでいる・全画面でない・動画ページ) |
|---|---|
| バー | 中身の根 `#yt-clip-bar` がある (今と同じ) |
| 区間・テロップ | 区間の一覧かテロップの一覧のどちらかが見えている (今のパネルの判定から設定を抜いたもの。エディットモードで区間が 1 つ以上) |
| 設定 | **⚙ で開いている** (`settingsPanel.element.hidden === false`。今と同じ状態を、パネルの中の出し入れではなく窓の出し入れに使う) |

- **⚙ は今どおり操作の行の右端。** 押すと設定の窓を開閉する。開いたら設定の窓を前に出す (`bringToFront`)。
  設定の窓に閉じるボタン (×) は置かない (右側パネルの spec で不採用にしたのと同じ。⚙ で閉じる。C2 でドックしたときも
  同じ経路で閉じる方が覚えることが少ない)
- **パネルの折り畳み (▶ / ◀) はやめる。** 折り畳みの理由は「シアターモードや狭い画面でパネルが動画に重なる」だった
  (右側パネルの spec §3)。A で窓を動かせるようになり、C2 では枠へ入れれば重ならない。畳んだ状態は保存もしていない。
  残すと「畳んだ × ドック中 × タブが前」の組み合わせが増える
- 折り畳みをやめるので、`reveal()` (畳んでいれば開く) は要らなくなる。「設定を開いたとき・区間やテロップを足したときに
  結果を見える範囲に入れる」は残す: 区間・テロップの窓の中を足した行までスクロール (`scrollTo`。今と同じ)、
  設定は窓を前に出す

**C1.3 位置と覚えるもの (C1 の間)**

- **最初の位置**: バーはプレイヤーの直下 (A.2 のまま)。区間・テロップの窓は今のパネルと同じ (右 16px・上 68px・幅 400px)。
  **設定の窓は区間・テロップの窓から 32px 下へだけずらして重ねる** (left = 一覧の left と同じ、top = 一覧の top + 32、
  幅 400px。カスケード)。完全に重ねない: 依頼「分けたい」の動機は両方を同時に見ることで、⚙ を押した瞬間に一覧が丸ごと
  隠れると分けた意味が薄い。**左右にはずらさない**: 1440x795 で一覧の left は 1024px、プレイヤーの右端は 1012px (side-panel.ts
  の実測) なので、左へ 32px ずらすとプレイヤーに 20px 重なり、右側パネルの spec の「動画は隠れない」を破る。右へずらすと
  右端で詰められて同じ位置になる。設定を開いたら前に出す (C1.2) ので、一覧の見出しの行 (32px) が残って見え、掴んで
  動かせる。ダブルクリックの戻し先も同じ位置。この位置は C2 でも最初の配置 (C2.6) と、枠が使えない間の退避 (C2.1) に使う
- **覚えるもの**: `chrome.storage.local` の `windowLayout` を **v2 の形**にする (C2 の枠の情報も入る形にしておき、
  C1 と C2 で読み替えを 2 回書かない)
  ```typescript
  export type WindowId = "bar" | "list" | "settings";
  export type DockSlotId = "below" | "side";
  export type WindowLayout = {
    version: 2;
    /** フロートで置いた位置と大きさ。無い窓は最初の位置 (A.2 / C1.3) */
    float: Partial<Record<WindowId, WindowRect>>;
    /** 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ。C1 では常に空 */
    docks: Partial<Record<DockSlotId, { tabs: WindowId[]; active?: WindowId }>>;
  };
  ```
- **古い形 (v1: `{ bar?: rect, panel?: rect }`。`version` が無い) の読み替え**: `bar` → `float.bar`、
  `panel` → `float.list` (今のパネルの位置を区間・テロップの窓が継ぐ)。`settings` は無い扱い (最初の配置)。
  読むときに書き戻さない (読み込みは書かない。次に動かしたときに v2 で書く)。
  `version` が 2 より大きい・型が合わない → `console.warn` して最初の配置 (今の `mergeWindowLayout` と同じ作法)
- **保存は組ごと** (`saveWindowLayout(layout)`)。今の「窓ごとに読んで書き戻す」をやめる。C2 で枠のタブの並びは
  1 つの窓の操作で 2 つの枠が変わりうる (引き出して別の枠へ) ので、窓ごとの部分更新では整合が取れない。
  組は youtube.ts が持つ状態から毎回作る (読んで書き戻さないので、A で入れた直列化の理由「先の書き込みが後の
  書き込みで消える」は無くなるが、書き込みの順は保つため `serialize` は残す)
- **`float` の写しは youtube.ts が持ち、書き換えるのは次の 3 つだけ**: 読み込み (`loadWindowLayout`) / `onUserMove`
  (ユーザーがその窓を動かした・大きさを変えた。C2 の退避中の移動を含む) / ダブルクリックでの消去 (C2.6)。
  **窓の `rect()` から組を作らない。** `rect()` は画面に詰めた後の位置で、A の「ブラウザを小さくして詰めた窓は、大きく戻すと
  置いた場所へ戻る」(floating-window.ts の `requested` と `current` の区別) を壊す: 窓 X を動かして保存するとき、
  動かしていない窓 Y の `rect()` を組に入れると、Y の覚えた位置 (無いはずのもの) が詰めた位置で書かれる。
  今のコードは動かした窓の rect だけを書くのでこの退行が無い。組を作るときは、写しに無い窓は書かない

**C1.4 作り**

- `side-panel.ts` を **`panel-window.ts`** に改める: 見出しのある「幅と高さ」の窓 + 中身の箱 (余白・スクロール) + `scrollTo`。
  折り畳みと `reveal` を消す。区間・テロップの窓と設定の窓の両方をこれで作る
  ```typescript
  export type PanelWindow = {
    element: HTMLElement;
    body: HTMLElement;
    setVisible(visible: boolean): void;
    scrollTo(target: HTMLElement): void;
    destroy(): void;
    frame: FloatingWindow;
  };
  export function createPanelWindow(options: {
    id: string;          // "yt-clip-list" / "yt-clip-settings"
    title: string;       // "区間・テロップ" / "設定"
    onUserMove?(rect: WindowRect): void;
    onResetRequest?(): void;
  }): PanelWindow;
  ```
  `SIDE_PANEL_ID` (`yt-clip-panel`) を探している E2E とテストは、`yt-clip-list` / `yt-clip-settings` に変える
- `youtube.ts`: `sidePanel` を `listWindow` と `settingsWindow` に分ける。`buildBar` は今どおり設定パネルを作り直し、
  中身を設定の窓の `body` に入れる (一覧は区間・テロップの窓の `body`)。`refreshWindows` は 3 つの窓の
  `setVisible` を呼ぶ唯一の場所のまま。`onToggleSettings` は `toggle → refreshWindows → 前に出す`
- `window-layout.ts`: `WindowId` に `settings` を足し `panel` を消す。`mergeWindowLayout` は v1 / v2 を読み分け、
  `saveWindowLayout` / `loadWindowLayout` を組の単位にする。`fitRect` / `initialBarRect` は変えない
- `floating-window.ts`: `bringToFront` を触った順に (C1.1)。それ以外は変えない
- `styles.ts`: `SIDE_PANEL_STYLE` → `PANEL_WINDOW_STYLE` (折り畳みボタンの style を消す)

**C1.5 受け入れ条件**

- ⚙ を押すと設定が**別の窓**に開き、もう一度押すと閉じる。区間・テロップの窓はそのまま
- 1440x795 で、最初の位置のまま、エディットモードで区間 5 つ・テロップ 5 つ・設定を開いた状態で: バーの窓が
  プレイヤーの下端より下で画面に収まる (A.4 と同じ) / 区間・テロップの窓と設定の窓が画面に収まる /
  **設定の窓の左端 ≥ プレイヤーの右端** (`settings.left ≥ player.right`。設定の窓もプレイヤーに重ならない)
- 設定の窓を動かして読み込み直しても同じ位置に出る。区間・テロップの窓も同じ
- A で覚えた `windowLayout` (v1) があるとき、パネルの位置に区間・テロップの窓が出る

テスト (spec「テスト」節のうち C1 に関わる項目。C2 の項目は省いた):

- `window-layout.ts` の単体: v1 → v2 の読み替え (`panel` → `list`、`settings` は無い) / v2 の型違い・`version` 3 は warn して空 / 組の保存
  (「`float` と `docks` の両方にある窓は `docks`」は C2。判断メモ 9)
- 保存する組の作り方 (`youtube.test.ts`): **窓 X を動かして保存したとき、動かしていない窓 Y の覚えた位置が書かれない**
  (`float` に Y のキーが無い) / ブラウザを小さくして詰められた Y を持つ状態で X を動かしても、Y の覚えた位置が詰めた後の
  位置で上書きされない / ダブルクリックで消した窓のキーが組から消える
- `floating-window.ts` の単体: 触った順に z-index
- `youtube.test.ts`: 窓が 3 つできる / ⚙ で設定の窓が出て、もう一度で隠れる / 設定の窓の最初の位置が一覧から (0, +32) で
  left は同じ / 折り畳みのボタンが無い / v1 の `panel` で一覧がフロート
- `e2e/telop-check.spec.ts`: 今の A.4 の確認 (フロートのバーの位置・ドラッグ・読み込み直し) は **そのまま残す** (最初の配置は変わらない)。
  実機の確認は controller が行う
- `scripts/screenshots.mjs`: 最初の配置はフロートのままなので、**変えない** (1-range.png のバーの位置合わせ、
  2-settings.png の `#secondary` を隠す CSS はそのまま)。設定の窓は一覧と同じ left (下へ 32px ずれるだけ) なので、
  2-settings.png の枠取り (パネルの幅ぶんプレイヤーを空ける計算) も変えない。撮る対象を `#yt-clip-panel` から
  `#yt-clip-settings` に変え、窓の中を設定の先頭まで送る (下へ 32px ずれたぶん、末尾が切れる行が 1 つ増えてよい)

ドキュメント (spec「ドキュメント」節のうち C1 に関わる部分。ドック・タブの記述は C2 の plan で足す):

- README: 「使い方」に窓が 3 つ (バー / 区間・テロップ / 設定) になったこと、⚙ で設定の窓が開くこと (最初は一覧の窓の
  少し下にずれて重なって出る) … ダブルクリックで最初の位置 (フロート)。「仕様と制約」: 折り畳みをやめた (動かすかドックする)
  (判断メモ 17 で「窓は畳めない (重なるときは動かす)」と書く)
- CHANGELOG の「未リリース」: 「区間・テロップと設定を別の窓に分けた。… パネルの折り畳みはやめた (動かすかドックする)」
  (判断メモ 17 で折り畳みの一文は書かない)
- `docs/manual-check.md` の「見た目」: パネルの折り畳みの項目を消し … 「設定」の項目の「右側のパネルに設定が開く」を
  「設定の窓に開く (最初は一覧の窓の少し下)」に
- `docs/store-release.md`: 掲載文の「■ 設定 (⚙)」と窓の説明 (別の窓 …)、スクリーンショットの説明
  (2-settings.png は設定の窓。位置は一覧のカスケード)
- `docs/privacy-policy.md`: 保存するものの表の「窓の位置と大きさ」… 最終更新の日付を改める (判断メモ 18)

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定 (`~/.claude/CLAUDE.md`) と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 1 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C /Users/trapple/repos/github.com/trapple/yt-clip ...` を使う
- 外部プロセスを起動して待つ処理には必ず timeout を付ける。**この macOS には `timeout` コマンドが無い**。Bash ツールの `timeout` 引数
  (最大 600000) か、スクリプト側の timeout で止める
- 小さく検証してから全件: 対象の単体テスト 1 ファイル → `npm run typecheck && npm test` → (controller だけ) `npm run e2e` →
  `npm run check:telop` の順に広げる
- 日付を書くときは JST (`TZ=Asia/Tokyo date +%F`) であることを明示する
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける。本文は「なぜ」を書く
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- **Fail Fast**: 配線の不具合 (⚙ が設定パネルより先に押される) は throw で知らせる (既存の `onToggleSettings` のまま)。
  ※ 局所例外: `loadWindowLayout` と `mergeWindowLayout` は読めない値で reject / throw せず、warn して空の組を返す
  (spec A.2 / C1.3「warn して最初の配置」。投げると窓を出さないままにする経路を作りうる)。既存の作法をそのまま残す
- テストは `npm test` (vitest)、型は `npm run typecheck` (`tsc --noEmit`。`src` / `tests` / `e2e` を含む)。**各タスクの commit 前に両方を通す**
  (リポジトリの根 `/Users/trapple/repos/github.com/trapple/yt-clip` で `npm run typecheck && npm test`、Bash の timeout 600000)
- コマンドはリポジトリの根で実行する。`npx vitest run <file>` は Bash の timeout 120000 を付ける
- `tsconfig.json` は `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`。配列の添字は `undefined` を確かめてから使う

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch `feat/dockable-windows` (HEAD 4a2e744、`feat/floating-windows` の上) にそのまま積む。**main には commit しない**
- 並列: SDD (branch + SDD = 方式 D)。1 タスクごとに新しい実装担当 + レビュー。**同じファイルを触るタスクは依存順に 1 つずつ走らせる**
  (`src/content/youtube.ts` と `tests/content/youtube.test.ts` は Task 4・5、`src/content/styles.ts` と `tests/content/styles.test.ts` は
  Task 3・5、`src/content/floating-window.ts` は Task 2・5、`src/content/window-layout.ts` は Task 4・5)。Task 1・2・3・4 は互いに独立
- **実装担当は `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない** (実機の Chrome と YouTube を使う)。
  Task 6 (E2E と screenshots.mjs を書く) も `npm run typecheck && npm test` までで止める
- Task 7 は **controller (メインセッション) が実行する**。`npm run e2e` → `npm run check:telop` → `npm run screenshots` を走らせ、画像を
  見て C1.5 の受け入れ条件 (`settings.left ≥ player.right` を含む) を判定し、`docs/manual-check.md` に記録する
- commit message は日本語で「なぜ」、末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3`
- ドキュメント (README / CHANGELOG / docs/manual-check.md / docs/store-release.md / docs/privacy-policy.md) の更新はコードより先 (Task 1)
- 終点: branch `feat/dockable-windows` 上の commit まで。push / PR はユーザーの指示を待つ

## ファイルの構造

| ファイル | 責務 | タスク |
|---|---|---|
| `README.md` / `CHANGELOG.md` / `docs/manual-check.md` / `docs/store-release.md` / `docs/privacy-policy.md` | 窓が 3 つになったこと・⚙ で設定の窓・畳めないこと | 1 |
| `src/content/floating-window.ts` | 重なり順を触った順に、`bringToFront()` を足す (2)。コメントの出所を panel-window.ts に (5) | 2・5 |
| `src/content/panel-window.ts` (新規) | 見出しのある「幅と高さ」の窓 + 中身の箱 + `scrollTo`。最初の位置 (`initialListRect` / `initialSettingsRect`) | 3 |
| `src/content/styles.ts` | `PANEL_WINDOW_STYLE` を足す (3)、`SIDE_PANEL_STYLE` を消す (5) | 3・5 |
| `src/content/window-layout.ts` | `WindowId` を `bar` / `list` / `settings` に、v2 の型、v1 / v2 の読み分け、組の保存 (4)。コメントの出所 (5) | 4・5 |
| `src/content/youtube.ts` | `float` の写しと組の保存 (4)、窓を 3 つに分けて配線 (5) | 4・5 |
| `src/content/side-panel.ts` / `tests/content/side-panel.test.ts` | 消す (panel-window.ts に置き換わる) | 5 |
| `e2e/telop-check.spec.ts` / `scripts/screenshots.mjs` | 区間・テロップの窓と設定の窓を探す。C1.5 の受け入れ条件と 2 項目を足す | 6 |
| `docs/manual-check.md` (「## 確認した環境」) | 実機で確かめた記録 | 7 |

`segment-list.ts` / `telop-list.ts` / `settings-panel.ts` は変えない (一覧は中身が無いと自分で隠れ、設定パネルは `toggle` で
`hidden` を切り替える。どちらも今の振る舞いのまま、入れる窓だけが変わる)。

## タスクの依存

```
Task 1 (ドキュメント)
Task 2 (floating-window.ts: 触った順・bringToFront) ─────────────────────┐
Task 3 (panel-window.ts + PANEL_WINDOW_STYLE) ───────────────────────────┤
Task 4 (window-layout.ts v2 + youtube.ts の float の写しと組の保存) ─────┴→ Task 5 (youtube.ts: 窓を 3 つに) ─→ Task 6 (E2E・screenshots) ─→ Task 7 (controller: 実機)
```

## 既存テストの洗い出し (grep の結果。Task 4・5・6 の前提)

- `git grep -n 'yt-clip-panel\|SIDE_PANEL\|side-panel\|collapse\|initialPanelRect\|sidePanel'` の結果 (`.claude/` を除く):
  - `tests/content/youtube.test.ts`: ヘルパ `panelElement` (531) / `panelBody` (538) / `collapseButton` (550) / `panelHeader` (581)、
    全体の `beforeEach` の折り畳みの戻し (764〜769)、`describe("右側のパネル")` (2638〜2893)、
    `describe("足した行をパネルの見える範囲に入れる")` (2895〜2998)、`describe("フロートの窓")` (3000〜3325)、
    `describe("動かしていない窓の最初の位置を取り直す")` (3327〜3481)。**Task 4 は保存の期待値だけ、Task 5 で窓の分割に合わせて書き直す**
  - `tests/content/styles.test.ts` の `describe("右側のパネル")` (118〜132) と import (7)。Task 3 で `PANEL_WINDOW_STYLE` の検査を足し、
    Task 5 で `SIDE_PANEL_STYLE` の検査を消す
  - `tests/content/side-panel.test.ts` は Task 5 で消す (折り畳み以外の検査は Task 3 の `panel-window.test.ts` に移してある)
  - `tests/content/floating-window.test.ts` の「最後に触った窓が上に来る」(520〜531) は、窓 2 つなら新しい重なり順でも同じ値になる
    (a 2001 / b 2000 → b 2001 / a 2000)。**変更不要**。3 つの窓の検査を足す
  - `tests/content/window-layout.test.ts` の `describe("mergeWindowLayout")` (26〜87) と `describe("覚えた位置の保存と読み込み")` (213〜269) は
    v2 に合わせて Task 4 で書き直す。`fitRect` / `initialBarRect` の検査は変えない
  - `e2e/telop-check.spec.ts`: `#yt-clip-panel` (384・829・830・919・1115)、`#yt-clip-panel-body` (908・909)、`panel.locator` (506・796・844・891)、
    `panelHeader` (970・1001・1070・1075・1099・1100)。Task 6 で書き直す
  - `scripts/screenshots.mjs`: `#yt-clip-panel` (110)、`yt-clip-panel-body` (130)、コメントの `side-panel.ts` (122)。Task 6
- `e2e/smoke.spec.ts` / `e2e/draft-editor.spec.ts`: パネルを探していない。**変更不要**
- `youtube.test.ts` の `describe("設定")` の「押すとパネルが開き、もう一度押すと閉じる」(1203〜1215) は設定パネルの根 (`hidden`) だけを見ている。
  **変更不要** (設定パネル自体は変わらない)

---

### Task 1: ドキュメントを先に直す (C1 の範囲)

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual-check.md`
- Modify: `docs/store-release.md`
- Modify: `docs/privacy-policy.md`

**Interfaces:**
- Consumes: なし
- Produces: なし (ドキュメントのみ)

グローバル規約「ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する」に従う。ドック・タブの記述は
C2 の plan で足すので、ここでは書かない。`docs/manual-check.md` の「## 確認した環境」は Task 7 で書く。

- [ ] **Step 1: README の「使い方」の窓の説明を 3 つの窓に直す**

`README.md` の 18〜23 行目

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で右側のパネルに開く。

IN / OUT・録画のボタンと拡大バー (以下「バー」) と右側のパネルは、画面の上に浮いた窓に出る。
バーは操作の行の左端の **⠿**、パネルは見出しを掴んでドラッグすると、好きな場所へ動かせる。
右下の角をドラッグすると大きさが変わる (バーは幅だけ)。動かした位置と大きさは、次に開いたときも
同じになる。**⠿ や見出しをダブルクリックすると最初の位置 (バーはプレイヤーの直下、パネルは画面の右上) に戻る。**
```

を次に置き換える。

```markdown
操作は YouTube のページ内で完結する。設定はバーの **⚙** で設定の窓に開く。

IN / OUT・録画のボタンと拡大バー (以下「バー」)、区間とテロップの一覧、設定は、画面の上に浮いた 3 つの窓
(**バー** / **区間・テロップ** / **設定**) に出る。バーは操作の行の左端の **⠿**、区間・テロップの窓と設定の窓は
見出しを掴んでドラッグすると、好きな場所へ動かせる。右下の角をドラッグすると大きさが変わる (バーは幅だけ)。
動かした位置と大きさは、次に開いたときも同じになる。**⠿ や見出しをダブルクリックすると最初の位置 (バーは
プレイヤーの直下、区間・テロップの窓は画面の右上、設定の窓はその少し下) に戻る。**

**⚙ を押すと設定の窓が開き、もう一度押すと閉じる。** 設定の窓は最初は区間・テロップの窓の少し下 (32px) に
ずれて重なって前に出る。区間・テロップの窓の見出しは上に見えたままなので、掴んで動かせば両方を並べて見られる。
```

- [ ] **Step 2: README の「モード」節の一覧の置き場所を直す**

`README.md` の 42〜45 行目

```markdown
区間とテロップの一覧は、画面右側のパネルに出る。IN / OUT・録画のボタンと拡大バーは
最初はプレイヤーの直下に浮いて出るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったらパネルの中でスクロールする。パネルは見出しの **▶** で畳める
(見出しの 1 行だけが残る。**◀** で開く)。
```

を次に置き換える。

```markdown
区間とテロップの一覧は、区間・テロップの窓 (最初は画面の右上) に出る。IN / OUT・録画のボタンと拡大バーは
最初はプレイヤーの直下に浮いて出るので、区間が増えてもページをスクロールせずに操作できる。
一覧が長くなったら区間・テロップの窓の中でスクロールする。
```

同じファイルの 49 行目

```markdown
パネルの区間の一覧の下に **テロップ** の一覧が出る。
```

を次に置き換える。

```markdown
区間・テロップの窓の、区間の一覧の下に **テロップ** の一覧が出る。
```

同じファイルの 68 行目

```markdown
設定 (⚙) を開いたままモードを変えても、設定は開いたままになる。
```

を次に置き換える。

```markdown
設定 (⚙) を開いたままモードを変えても、設定の窓は開いたままになる。
```

- [ ] **Step 3: README の「仕様と制約」の窓の項目を直す**

`README.md` の 164〜173 行目

```markdown
- **区間・テロップ・設定は画面右側のパネルに出る**。IN / OUT・録画と拡大バーは、最初はプレイヤーの直下に
  浮いた窓に出る (拡大バーは幅がそのまま精度になるため、パネルの幅には縮めない)。パネルは最初はおすすめ
  動画の列の上に重ねるので、通常の表示では動画を隠さない
- **シアターモードや狭い画面 (YouTube が 1 列表示に切り替わる幅) では、パネルが動画の右側に重なる**。
  そのときは見出しの ▶ で畳むか、掴んで動かす。畳んでも見出しの 1 行は動画の右上に残る。自動では畳まない
  (重なるかどうかの判定は YouTube のレイアウトに依存し、外れると勝手に消えたように見えるため)
- **畳んだ状態はタブを開いている間だけ覚える**。開き直すと開いた状態に戻る (保存すると
  「パネルが出ない」の原因になりやすいため)。⚙ で設定を開いたときと、区間・テロップを足したときは、
  畳んでいても開く
- **全画面の間と、動画の再生画面以外では、バーもパネルも出さない**
```

を次に置き換える。

```markdown
- **区間・テロップは区間・テロップの窓、設定は設定の窓に出る**。IN / OUT・録画と拡大バーは、最初はプレイヤーの
  直下に浮いた窓に出る (拡大バーは幅がそのまま精度になるため、一覧の窓の幅には縮めない)。区間・テロップの窓と
  設定の窓は最初はおすすめ動画の列の上に重ねるので、通常の表示では動画を隠さない
- **設定の窓は ⚙ で開閉する** (窓に閉じるボタンは無い。閉じ方を 1 つにするため)。最初は区間・テロップの窓から
  32px 下へだけずれて重なり、前に出る。左右にはずらさない (左へずらすと 1440x795 などの画面でプレイヤーに重なる)。
  区間・テロップの窓を動かしても、設定の窓の最初の位置は付いていかない。開いているかは覚えない (読み込み直すと閉じている)
- **シアターモードや狭い画面 (YouTube が 1 列表示に切り替わる幅) では、区間・テロップの窓と設定の窓が動画の右側に
  重なる**。そのときは見出しを掴んで動かす。自動では動かさない (重なるかどうかの判定は YouTube のレイアウトに依存し、
  外れると勝手に跳んだように見えるため)
- **窓は畳めない**。重なるときは見出しを掴んで動かす (畳んだ状態と重なり順の組み合わせを増やさないため)
- **全画面の間と、動画の再生画面以外では、どの窓も出さない**
```

同じ「仕様と制約」の 175〜183 行目と 189 行目 (「状態の文言は 1 行に収める」の項目の後)

```markdown
- **バーとパネルは動かせる窓**。パネルは見出し、バーは操作の行の左端の ⠿ を掴んで動かし、右下の角で
  大きさを変える。**バーは幅だけ変えられる** (高さは中身で決まる。拡大バーは幅がそのまま精度になる)。
  最小はバーが幅 480px、パネルが幅 280px・高さ 160px。最大は画面の大きさまで。バーに見出しの行を
  付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を覆うため
```

```markdown
- **窓は見失わない**。画面の外へドラッグしても、ブラウザを小さくしても、掴む場所 (バーは ⠿、パネルは見出し) は
```

```markdown
- **2 つの窓が重なったときは、最後に触った窓が上に出る**
```

をそれぞれ次に置き換える (間の行は残す)。

```markdown
- **窓は動かせる**。区間・テロップの窓と設定の窓は見出し、バーは操作の行の左端の ⠿ を掴んで動かし、右下の角で
  大きさを変える。**バーは幅だけ変えられる** (高さは中身で決まる。拡大バーは幅がそのまま精度になる)。
  最小はバーが幅 480px、区間・テロップの窓と設定の窓が幅 280px・高さ 160px。最大は画面の大きさまで。バーに見出しの行を
  付けないのは、そのぶん背が高くなると狭い画面 (1440x795 など) でプレイヤーの下端を覆うため
```

```markdown
- **窓は見失わない**。画面の外へドラッグしても、ブラウザを小さくしても、掴む場所 (バーは ⠿、ほかの窓は見出し) は
```

```markdown
- **窓が重なったときは、触った順が新しいほど上に出る** (直前に触った窓が、その前に触った窓の下に潜らない)。
  ⚙ で開いた設定の窓は前に出る
```

同じ「仕様と制約」の 179〜181 行目

```markdown
- **動かした位置と大きさは端末ごとに覚える** (`chrome.storage.local`。Chrome の同期で他の端末へは運ばない。
  画面の大きさと置き場所の好みは端末ごとに違うため)。**掴む場所 (⠿ / 見出し) をダブルクリックすると最初の
  位置に戻り、覚えた位置も消える**
```

を次に置き換える (判断メモ 11)。

```markdown
- **動かした位置と大きさは端末ごとに覚える** (`chrome.storage.local`。Chrome の同期で他の端末へは運ばない。
  画面の大きさと置き場所の好みは端末ごとに違うため)。**掴む場所 (⠿ / 見出し) をダブルクリックすると最初の
  位置に戻り、覚えた位置も消える**。同じ端末で YouTube のタブを複数開いているときは、**最後に窓を動かした (戻した)
  タブの配置が残る** (別のタブで動かした位置は、こちらのタブで窓を動かすと上書きされる)
```

- [ ] **Step 4: README の設計の一覧に spec を足す**

`README.md` の 242 行目

```markdown
- [`.claude/specs/2026-09-24-floating-windows-design.md`](.claude/specs/2026-09-24-floating-windows-design.md) — バーとパネルを動かせる窓にする
```

の**直後** (空行を挟まず) に次を挿入する。

```markdown
- [`.claude/specs/2026-09-25-dockable-windows-design.md`](.claude/specs/2026-09-25-dockable-windows-design.md) — 区間・テロップと設定を別の窓に分ける (と、ドック枠 + タブ)
```

- [ ] **Step 5: CHANGELOG の「未リリース」を直す**

`CHANGELOG.md` の「## 未リリース」の段落

```markdown
**区間・テロップ・設定を画面右側のパネルに移した。** 区間やテロップが増えても、プレイヤー直下の
IN / OUT・録画と拡大バーはページをスクロールせずに操作できる。パネルは見出しで畳める。
```

を次に置き換える (折り畳みは未リリースのまま無くなるので書かない。判断メモ 17)。

```markdown
**区間・テロップ・設定を画面右側のパネルに移した。** 区間やテロップが増えても、プレイヤー直下の
IN / OUT・録画と拡大バーはページをスクロールせずに操作できる。
```

同じ節の最後の段落 (「**拡大バーの下にテロップを帯で出した (エディットモード)。**」で始まり
「入らない分は「+N」で数だけ出す。」で終わる段落) の**直後**に、空行を 1 つ挟んで次を挿入する
(その後の空行と「## 1.1.0 - 2026-09-23」は残す)。

```markdown
**右側のパネルを、区間・テロップの窓と設定の窓に分けた。** ⚙ で設定の窓が開き、区間・テロップの一覧と
並べて見られる (最初は区間・テロップの窓の少し下にずれて重なって出る)。窓は 3 つ (バー / 区間・テロップ / 設定) に
なり、重なったときは触った順が新しいほど上に出る。
```

- [ ] **Step 6: manual-check の項目を直す**

`docs/manual-check.md` を次のとおり直す (行番号は今のファイルのもの。上から順に直すとずれるので、下の項目から直してよい)。

70 行目

```markdown
- [ ] ⚙ でモードをエディットに変えて区間を足すと、画面右側のパネルに区間の一覧が出る (区間が 0 個の間はパネルごと出ない)
```

→

```markdown
- [ ] ⚙ でモードをエディットに変えて区間を足すと、区間・テロップの窓 (最初は画面の右上) に区間の一覧が出る (区間が 0 個の間は窓ごと出ない)
```

283〜285 行目

```markdown
- [ ] バーの右端に ⚙ が出て、押すと右側のパネルに設定が開く。もう一度押すと閉じる
- [ ] 設定を開いたままモードを切り替えても、設定は開いたまま (設定は開き直すので、「保存しました」の表示は残らない。仕様)
      (パネルごと閉じない)
```

→

```markdown
- [ ] バーの右端に ⚙ が出て、押すと設定の窓に開く (最初は区間・テロップの窓の少し下。区間・テロップの窓の見出しは見えたまま)。もう一度押すと閉じる。区間・テロップの窓はそのまま
- [ ] 設定を開いたままモードを切り替えても、設定は開いたまま (設定は開き直すので、「保存しました」の表示は残らない。仕様)
      (設定の窓ごと閉じない)
```

294 行目

```markdown
- [ ] ダークとライトの両方でパネルが読める
```

→

```markdown
- [ ] ダークとライトの両方で設定の窓が読める
```

309 行目の「パネルのハッシュタグ欄に、」を「設定の窓のハッシュタグ欄に、」に置き換える (行の残りは変えない)。

367〜373 行目

```markdown
- [ ] 動かしていない右側のパネルが、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
- [ ] パネルの地が不透明で、下のおすすめ動画が透けない (ダーク・ライトの両方。テーマを切り替えるとパネルも追従する)
- [ ] 区間とテロップを増やすと、**パネルの中だけ**がスクロールする (ページはスクロールしない)。パネルの下端は画面の下から 16px で止まる
- [ ] 見出しの ▶ で畳むと見出しの 1 行だけが残り、◀ で開く。畳んだまま ⚙ を押すと開いて設定が見える。＋ 区間を追加・＋ テロップを押すと開いて足した行が見える
- [ ] 区間とテロップが多いときに ⚙ を押すと、パネルの中が設定の先頭まで送られる (ページは動かない)
- [ ] シアターモードではパネルが動画の右側に重なる (仕様)。畳むか、掴んで動かす。畳めば見出しの 1 行だけが動画の右上に残る
- [ ] 全画面の間はバーの窓もパネルも出ず、全画面を抜けると戻る
```

→

```markdown
- [ ] 動かしていない区間・テロップの窓が、ヘッダーの下 12px・画面の右端から 16px に出て、おすすめ動画の列に重なり動画を隠さない
- [ ] 区間・テロップの窓と設定の窓の地が不透明で、下のおすすめ動画が透けない (ダーク・ライトの両方。テーマを切り替えると窓も追従する)
- [ ] 区間とテロップを増やすと、**区間・テロップの窓の中だけ**がスクロールする (ページはスクロールしない)。窓の下端は画面の下から 16px で止まる
- [ ] 区間・テロップの窓と設定の窓の見出しは「区間・テロップ」「設定」で、折り畳みのボタン (▶) は無い。＋ 区間を追加・＋ テロップを押すと、区間・テロップの窓の中が足した行まで送られる
- [ ] 区間とテロップが多いときに ⚙ を押すと、設定の窓が前に出て設定の先頭が見える。区間・テロップの窓の中は送られない (ページも動かない)
- [ ] シアターモードでは区間・テロップの窓と設定の窓が動画の右側に重なる (仕様)。見出しを掴んで動かす
- [ ] 全画面の間はどの窓も出ず、全画面を抜けると戻る
```

375 行目

```markdown
- [ ] 別の動画へ移ると、パネルの一覧に前の動画の区間が残らない。ホームへ移るとバーの窓もパネルも消える
```

→

```markdown
- [ ] 別の動画へ移ると、区間・テロップの窓に前の動画の区間が残らない。ホームへ移るとどの窓も消える
```

377〜379 行目

```markdown
- [ ] バーの窓は操作の行の左端の ⠿、パネルは見出しの空いたところを掴むと動く。パネルの ▶ を押しても窓は動かない
- [ ] 右下の角をドラッグすると大きさが変わる。バーは幅だけ (480px より狭くならない)、パネルは幅と高さ (280x160 より小さくならない)
- [ ] 窓を画面の外へドラッグしても、⠿ と見出しは画面に残る (パネルを右端に寄せても縁が画面の外へ出ない)。ブラウザの窓を小さくしても同じ
```

→

```markdown
- [ ] バーの窓は操作の行の左端の ⠿、区間・テロップの窓と設定の窓は見出しを掴むと動く
- [ ] 右下の角をドラッグすると大きさが変わる。バーは幅だけ (480px より狭くならない)、区間・テロップの窓と設定の窓は幅と高さ (280x160 より小さくならない)
- [ ] 窓を画面の外へドラッグしても、⠿ と見出しは画面に残る (区間・テロップの窓を右端に寄せても縁が画面の外へ出ない)。ブラウザの窓を小さくしても同じ
```

385 行目

```markdown
- [ ] 2 つの窓を重ねると、最後に触った方が上に出る。YouTube のヘッダーのメニューは窓より上に出る
```

→ 次の 4 行に置き換える。

```markdown
- [ ] 3 つの窓を重ねると、触った順が新しいほど上に出る (バー → 一覧 → 設定の順に触ってからバーを触ると、設定は一覧の上のまま)。YouTube のヘッダーのメニューは窓より上に出る
- [ ] 1440x795 で、最初の位置のままエディットモードで区間 5 つ・テロップ 5 つ・設定を開くと、設定の窓の左端がプレイヤーの右端より右にある (設定の窓もプレイヤーに重ならない)。設定の窓は画面に収まる
- [ ] 設定の窓を動かしてから読み込み直し、⚙ で開くと、動かした位置に出る。見出しをダブルクリックすると区間・テロップの窓の最初の位置の少し下 (32px) へ戻る
- [ ] 区間・テロップの窓を動かしても、設定の窓の最初の位置 (ダブルクリックの戻し先) は動かない
```

- [ ] **Step 7: store-release の掲載文とスクリーンショットの説明を直す**

`docs/store-release.md` の 67〜69 行目

```markdown
操作のバーと右側のパネルは画面の上に浮いた窓です。バーは左端の ⠿、パネルは見出しを掴んで
好きな場所へ動かせ、右下の角で大きさも変えられます (バーは幅だけ)。位置は端末ごとに覚え、
掴む場所をダブルクリックすると最初の位置に戻ります。
```

→

```markdown
操作のバー・区間とテロップの一覧・設定は、画面の上に浮いた 3 つの窓です。バーは左端の ⠿、
ほかの窓は見出しを掴んで好きな場所へ動かせ、右下の角で大きさも変えられます (バーは幅だけ)。
位置は端末ごとに覚え、掴む場所をダブルクリックすると最初の位置に戻ります。
```

77 行目

```markdown
・区間とテロップの一覧は画面右側のパネルに出ます。見出しで畳めます
```

→

```markdown
・区間とテロップの一覧は、区間・テロップの窓 (最初は画面の右上) に出ます
```

89 行目

```markdown
⚙ を押すと画面右側のパネルに開きます。
```

→

```markdown
⚙ を押すと設定の窓が開きます (最初は区間・テロップの窓の少し下にずれて重なって出ます)。
一覧の窓とは別の窓なので、並べて見られます。
```

131 行目

```markdown
> 操作のバーと右側のパネル (画面に浮いた窓) の位置と大きさを端末ごとに保存する (`chrome.storage.local`)。
```

→

```markdown
> 操作のバー・区間とテロップの一覧・設定 (画面に浮いた 3 つの窓) の位置と大きさを端末ごとに保存する (`chrome.storage.local`)。
```

172〜175 行目

```markdown
1. `1-range.png` — プレイヤーの直下に浮いたバーの窓 (拡大バーと IN/OUT などの操作の行。IN を置いた状態)。
   シンプルモードで設定を閉じているので、右側のパネルは出ていない
2. `2-settings.png` — ⚙ で設定を右側のパネルに開いた状態。パネルの中を設定の先頭まで送って撮る。
   1280x800 ではパネルに全項目が収まらず末尾が切れる (パネルの中でスクロールすることが分かる絵にしてある)
```

→

```markdown
1. `1-range.png` — プレイヤーの直下に浮いたバーの窓 (拡大バーと IN/OUT などの操作の行。IN を置いた状態)。
   シンプルモードで設定を閉じているので、区間・テロップの窓も設定の窓も出ていない
2. `2-settings.png` — ⚙ で設定の窓を開いた状態。位置は区間・テロップの窓の最初の位置から下へ 32px (シンプルモードなので
   区間・テロップの窓は出ていない)。窓の中を設定の先頭まで送って撮る。1280x800 では窓に全項目が収まらず末尾が切れる
   (窓の中でスクロールすることが分かる絵にしてある)
```

180〜182 行目

```markdown
2-settings.png だけはプレイヤー (`#primary`) の幅をパネルのぶん空けている
(`scripts/screenshots.mjs`)。関連動画の欄を隠すとプレイヤーが画面右端まで
広がってパネルと重なるので、実機で重ならない幅に合わせ直している。
```

→

```markdown
2-settings.png だけはプレイヤー (`#primary`) の幅を設定の窓のぶん空けている
(`scripts/screenshots.mjs`)。関連動画の欄を隠すとプレイヤーが画面右端まで
広がって設定の窓と重なるので、実機で重ならない幅に合わせ直している。
```

- [ ] **Step 8: privacy-policy の窓の名前を直す**

`docs/privacy-policy.md` の 20 行目

```markdown
| 窓 (操作のバーと右側のパネル) の位置と大きさ | `chrome.storage.local` | 拡張を削除したとき |
```

→

```markdown
| 窓 (操作のバー・区間とテロップの一覧・設定) の位置と大きさ | `chrome.storage.local` | 拡張を削除したとき |
```

3 行目の `最終更新: 2026-09-24` の日付を、`TZ=Asia/Tokyo date +%F` で得た JST の今日の日付に置き換える
(2026-09-24 と同じならそのまま)。

- [ ] **Step 9: 残った「パネル」の言い回しを確かめる**

実行: `git -C /Users/trapple/repos/github.com/trapple/yt-clip grep -n '右側のパネル\|畳め\|▶ で畳\|パネルの中' -- README.md CHANGELOG.md docs/manual-check.md docs/store-release.md docs/privacy-policy.md`
期待: 次の 2 箇所だけが出る。どちらも変えない。
- `docs/manual-check.md` の「## 確認した環境」節の過去の記録 (「2026-09-24 は右側のパネルを…」の段落)
- `CHANGELOG.md` の「未リリース」の `**区間・テロップ・設定を画面右側のパネルに移した。**` の行 (Step 5 で残した段落。
  同じ未リリース節の前の変更で、後の段落で窓を分けたことを書く。判断メモ 17)

ほかが出たら、その行を Step 1〜8 と同じ言い回し (区間・テロップの窓 / 設定の窓) に直す

- [ ] **Step 10: 型とテストを通す (ドキュメントだけの変更だが、commit の前に通す規約に従う)**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 11: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/store-release.md docs/privacy-policy.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 区間・テロップと設定を別の窓に分けることを先に書く

⚙ を押すと設定が一覧と同じパネルに開き、一覧を見ながら設定を
変えられなかった。窓を 3 つに分け、設定は一覧の少し下にずれて
重なって出ることと、畳めない代わりに動かすことを、コードより先に
使い方・制約・確認項目・掲載文・プライバシーポリシーに書いておく。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: 重なり順を触った順にし、外から前に出せるようにする (`floating-window.ts`)

**Files:**
- Modify: `src/content/floating-window.ts:15-35` (重なり順)、`:51-70` (型 `FloatingWindow`)、`:88` (作ったときの z-index)、`:268` (押したとき)、`:280` (登録)、`:287-323` (戻り値)
- Test: `tests/content/floating-window.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `FloatingWindow.bringToFront(): void` — その窓をいちばん上に出し、すべての窓の z-index を下から `2000, 2001, …` に振り直す。
  窓を押したとき (捕捉の段階の `pointerdown`) も同じ処理を通る

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/floating-window.test.ts` の `describe("重なり順とダブルクリック")` の中、「最後に触った窓が上に来る」の
テストの**直後**に次を足す。

```typescript
  test("3 つの窓は触った順が新しいほど上 (2000 + 触った順)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    const zIndexes = () => [a, b, c].map((frame) => frame.element.style.zIndex);

    pointer(a.body, "pointerdown", 0, 0);
    pointer(b.body, "pointerdown", 0, 0);
    pointer(c.body, "pointerdown", 0, 0);
    expect(zIndexes()).toEqual(["2000", "2001", "2002"]);

    // a を触り直すと a がいちばん上。直前に触った c は、その前に触った b の上のまま
    // (「最後に触った窓だけ上げる」だと b と c が同じ値になり、DOM の順で c が潜りうる)
    pointer(a.body, "pointerdown", 0, 0);
    expect(zIndexes()).toEqual(["2002", "2000", "2001"]);
  });

  test("bringToFront で、押さずにいちばん上に出す", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    expect(a.element.style.zIndex).toBe("2001");

    b.bringToFront();

    expect(b.element.style.zIndex).toBe("2001");
    expect(a.element.style.zIndex).toBe("2000");
  });

  test("消した窓は重なり順から外す (残った窓の z-index が詰まる)", () => {
    const a = makeWindow().frame;
    const b = makeWindow().frame;
    const c = makeWindow().frame;
    pointer(a.body, "pointerdown", 0, 0);
    pointer(b.body, "pointerdown", 0, 0);
    pointer(c.body, "pointerdown", 0, 0);

    c.destroy();
    a.bringToFront();

    expect(b.element.style.zIndex).toBe("2000");
    expect(a.element.style.zIndex).toBe("2001");
  });
```

(`afterEach` は `created` の窓をすべて `destroy` する。上のテストで先に `destroy` した `c` をもう一度 `destroy` しても、
リスナの解除・要素の取り外し・重なり順からの除外はどれも 2 回目に何もしないので、そのままでよい)

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/floating-window.test.ts` (Bash の timeout 120000)
期待: FAIL。「3 つの窓は…」は `["2000", "2000", "2001"]` などで食い違い、「bringToFront で…」は `b.bringToFront is not a function`、
「消した窓は…」も `bringToFront is not a function`

- [ ] **Step 3: 最小実装**

`src/content/floating-window.ts` の 15〜35 行目

```typescript
/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は side-panel.ts の
 * 実測のコメント) より下**、ページ本体より上。2 つの窓が重なったら、最後に触った窓を 1 つ上げる
 * (spec A.1)
 */
const Z_BACK = 2000;
const Z_FRONT = 2001;
/**
 * 高さを決めていない「幅と高さ」の窓 (パネル) の下端と、画面の下端との間。右側パネルの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/** 今ある窓の枠。最後に触った窓を上げるとき、ほかの窓を下げるのに使う */
const liveWindows = new Set<HTMLElement>();

function bringToFront(target: HTMLElement): void {
  for (const element of liveWindows) {
    element.style.zIndex = String(element === target ? Z_FRONT : Z_BACK);
  }
}
```

を次に置き換える。

```typescript
/*
 * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は side-panel.ts の
 * 実測のコメント) より下**、ページ本体より上。窓が重なったら、**触った順が新しいほど上**
 * (Z_BASE + 触った順。窓は 3 つなので最大 2002。窓の分割の spec C1.1)。
 * 「最後に触った窓だけ 1 つ上げ、残りは同じ値」にしない: 窓が 3 つになると残り 2 つの順が
 * DOM の順で決まり、直前に触った窓がその前に触った窓の下に潜る
 */
const Z_BASE = 2000;
/**
 * 高さを決めていない「幅と高さ」の窓 (パネル) の下端と、画面の下端との間。右側パネルの
 * 最大の高さ (画面の下端から 16px) と同じ
 */
const BOTTOM_GAP_PX = 16;

/**
 * 今ある窓の枠を、下から上への順に並べたもの (末尾がいちばん上)。作った窓は**いちばん下**に
 * 入れる。まだ触っていない窓が、触った窓の上に出ないように
 */
let stack: HTMLElement[] = [];

/**
 * target をいちばん上にし、すべての窓の z-index を並びどおりに振り直す。**毎回全部を振り直す。**
 * 上げた窓だけに値を足していくと、触るたびに値が伸びて YouTube のヘッダー (2020) を越える
 */
function raise(target: HTMLElement): void {
  stack = [...stack.filter((element) => element !== target), target];
  stack.forEach((element, index) => {
    element.style.zIndex = String(Z_BASE + index);
  });
}
```

型 `FloatingWindow` の `refit(): void;` の宣言 (とその doc コメント) の**直後**に次を足す。

```typescript
  /**
   * この窓をいちばん上に出す (窓のどこかを押したときと同じ)。押していないのに前に出したいとき
   * (⚙ で設定の窓を開いたとき) に youtube.ts が呼ぶ
   */
  bringToFront(): void;
```

88 行目

```typescript
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BACK};`;
```

を次に置き換える。

```typescript
  element.style.cssText = `${FLOATING_WINDOW_STYLE.root}z-index:${Z_BASE};`;
```

266〜268 行目

```typescript
  // 窓のどこを押しても、その窓を上にする (最後に触った窓が上。spec A.1)。捕捉の段階で
  // 拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため
  element.addEventListener("pointerdown", () => bringToFront(element), true);
```

を次に置き換える。

```typescript
  // 窓のどこを押しても、その窓を上にする (触った順が新しいほど上。窓の分割の spec C1.1)。捕捉の
  // 段階で拾うのは、中の部品 (拡大バーのハンドルなど) が伝播を扱っても漏らさないため
  element.addEventListener("pointerdown", () => raise(element), true);
```

280 行目

```typescript
  liveWindows.add(element);
```

を次に置き換える。

```typescript
  stack = [element, ...stack];
```

戻り値の `refit(): void { apply(requested); },` の**直後**に次を足す。

```typescript
    bringToFront(): void {
      raise(element);
    },
```

戻り値の `destroy()` の中の

```typescript
      liveWindows.delete(element);
```

を次に置き換える。

```typescript
      stack = stack.filter((candidate) => candidate !== element);
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/floating-window.test.ts` (Bash の timeout 120000)
期待: PASS (既存の「最後に触った窓が上に来る」も、窓 2 つなので同じ値で通る)

- [ ] **Step 5: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS。`tests/content/youtube.test.ts` の「最後に触った窓が上に来る」(窓 2 つ: バーとパネル) も通る

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/floating-window.ts tests/content/floating-window.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 窓の重なり順を触った順にし、外から前に出せるようにする

窓を 3 つに分けると、最後に触った窓だけを上げる今のやり方では残り
2 つが同じ z-index になり、直前に触った窓が DOM の順で下に潜る。
触った順に 2000 から振り直す。⚙ で開いた設定の窓を押さずに前へ
出すため、bringToFront を外から呼べるようにする。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: 見出しのある「幅と高さ」の窓 (`panel-window.ts`) を作る

**Files:**
- Create: `src/content/panel-window.ts`
- Modify: `src/content/styles.ts` (`SIDE_PANEL_STYLE` の後ろに `PANEL_WINDOW_STYLE` を足す)
- Test: `tests/content/panel-window.test.ts` (新規)
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes: `createFloatingWindow(options: FloatingWindowOptions): FloatingWindow` (既存)、`MASTHEAD_HEIGHT_PX` / `TOP_GAP_PX` / `type Viewport` (既存 `window-layout.ts`)
- Produces:
  - `type PanelWindow = { element: HTMLElement; body: HTMLElement; setVisible(visible: boolean): void; scrollTo(target: HTMLElement): void; destroy(): void; frame: FloatingWindow }`
  - `type PanelWindowOptions = { id: string; title: string; onUserMove?(rect: WindowRect): void; onResetRequest?(): void }`
  - `createPanelWindow(options: PanelWindowOptions): PanelWindow` — 中身の箱の id は `${options.id}-body`。**自分では置かない** (判断メモ 4)
  - `initialListRect(viewport: Viewport): WindowRect` — 区間・テロップの窓の最初の位置 (今の `initialPanelRect` と同じ値: 右 16px・上 68px・幅 400px・高さなし)
  - `initialSettingsRect(viewport: Viewport): WindowRect` — `initialListRect` から (0, +32)
  - `SETTINGS_CASCADE_PX = 32`
  - `PANEL_WINDOW_STYLE = { body: string }` (`styles.ts`)

この時点では `side-panel.ts` をまだ消さない (`youtube.ts` が使っている)。Task 5 で置き換えて消す。

- [ ] **Step 1: 失敗するテストを書く (styles)**

`tests/content/styles.test.ts` の import (3〜11 行目) の `FLOATING_WINDOW_STYLE,` の**直後**に `PANEL_WINDOW_STYLE,` を足す。

同じファイルの `describe("右側のパネル", …)` の**直後** (`describe("フロートの窓", …)` の前) に次を足す。

```typescript
describe("見出しのある窓の中身の箱", () => {
  test("本体の中だけでスクロールする", () => {
    expect(PANEL_WINDOW_STYLE.body).toContain("overflow-y:auto");
    // flex の子は min-height:0 が無いと中身より縮まず、窓ごと伸びる
    expect(PANEL_WINDOW_STYLE.body).toContain("min-height:0");
  });

  test("本体は flex で縦に並べる (折り畳みが無いので、出し入れする者がいない)", () => {
    expect(PANEL_WINDOW_STYLE.body).toContain("display:flex");
    expect(PANEL_WINDOW_STYLE.body).toContain("flex-direction:column");
  });

  test("枠の見た目 (地・見出し) と折り畳みのボタンは持たない", () => {
    expect(Object.keys(PANEL_WINDOW_STYLE)).toEqual(["body"]);
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (panel-window)**

`tests/content/panel-window.test.ts` を次の内容で作る。

```typescript
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  SETTINGS_CASCADE_PX,
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
  type PanelWindow,
  type PanelWindowOptions,
} from "@/content/panel-window";

/** jsdom はレイアウトを持たず、どの要素の寸法も 0 を返す。位置を決め打ちする */
function rectAt(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function placeAt(element: HTMLElement, top: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rectAt(top, height));
}

let made: PanelWindow | null = null;

function makeWindow(options: Partial<PanelWindowOptions> = {}): PanelWindow {
  made = createPanelWindow({ id: "yt-clip-list", title: "区間・テロップ", ...options });
  document.body.append(made.element);
  return made;
}

function headerOf(target: PanelWindow): HTMLElement {
  const header = target.element.querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("見出しがありません");
  return header;
}

function resizeGripOf(target: PanelWindow): HTMLElement {
  const grip = target.element.querySelector<HTMLElement>("[data-role='window-resize']");
  if (grip === null) throw new Error("右下のつまみがありません");
  return grip;
}

/** jsdom は PointerEvent を持たない。MouseEvent に pointer* の名前を付けて配る */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

beforeAll(() => {
  // jsdom は Pointer Capture を持たない (窓の枠のドラッグが呼ぶ)
  Element.prototype.setPointerCapture = (): void => undefined;
  Element.prototype.releasePointerCapture = (): void => undefined;
});

afterEach(() => {
  made?.destroy();
  made = null;
  vi.restoreAllMocks();
});

describe("createPanelWindow", () => {
  test("作った直後は隠れている (中身が入り、出す判断がされるまで空の枠を出さない)", () => {
    const target = makeWindow();
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("窓と中身の箱を id で外から辿れる (中身の箱は `${id}-body`)", () => {
    const target = makeWindow({ id: "yt-clip-settings", title: "設定" });
    expect(document.getElementById("yt-clip-settings")).toBe(target.element);
    expect(document.getElementById("yt-clip-settings-body")).toBe(target.body);
  });

  test("見出しに中身の名前を出す。折り畳みのボタンは持たない", () => {
    const target = makeWindow({ title: "設定" });
    expect(headerOf(target).textContent).toBe("設定");
    expect(target.element.querySelector("[data-role='collapse']")).toBeNull();
    expect(target.frame.headerActions?.children.length).toBe(0);
  });

  test("setVisible で出し入れする", () => {
    const target = makeWindow();

    target.setVisible(true);
    expect(target.element.hidden).toBe(false);
    expect(target.element.style.display).toBe("flex");

    target.setVisible(false);
    expect(target.element.hidden).toBe(true);
    expect(target.element.style.display).toBe("none");
  });

  test("中身の箱は出たまま (折り畳みが無いので、本体だけを隠す経路が無い)", () => {
    const target = makeWindow();
    // 並べ方とスクロールの宣言は styles.test.ts の PANEL_WINDOW_STYLE で確かめる
    // (jsdom の style は知らない宣言を落としうるので、ここでは display だけを見る)
    expect(target.body.style.display).toBe("flex");
    expect(target.body.hidden).toBe(false);
  });

  test("最初の位置に置くと、高さは中身まで・最大で画面の下端から 16px まで", () => {
    const target = makeWindow();
    target.frame.place(initialListRect({ width: window.innerWidth, height: window.innerHeight }));
    expect(target.element.style.top).toBe("68px");
    expect(target.element.style.height).toBe("");
    // 768 (jsdom の画面の高さ) - 68 - 16
    expect(target.element.style.maxHeight).toBe(`${window.innerHeight - 84}px`);
  });

  test("見出しをドラッグすると動き、指を離したときに知らせる", () => {
    const onUserMove = vi.fn();
    const target = makeWindow({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400 });
    const header = headerOf(target);

    pointer(header, "pointerdown", 0, 0);
    pointer(header, "pointermove", 30, 20);
    pointer(header, "pointerup", 30, 20);

    expect(onUserMove).toHaveBeenCalledTimes(1);
    expect(onUserMove).toHaveBeenCalledWith({ left: 130, top: 120, width: 400 });
  });

  test("大きさは幅 280px・高さ 160px より小さくならない (今のパネルと同じ下限)", () => {
    const onUserMove = vi.fn();
    const target = makeWindow({ onUserMove });
    target.setVisible(true);
    target.frame.place({ left: 100, top: 100, width: 400, height: 500 });
    const grip = resizeGripOf(target);

    pointer(grip, "pointerdown", 0, 0);
    pointer(grip, "pointermove", -1000, -1000);
    pointer(grip, "pointerup", -1000, -1000);

    expect(onUserMove).toHaveBeenCalledWith({ left: 100, top: 100, width: 280, height: 160 });
  });

  test("見出しのダブルクリックで最初の位置に戻すよう頼む", () => {
    const onResetRequest = vi.fn();
    const target = makeWindow({ onResetRequest });

    headerOf(target).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onResetRequest).toHaveBeenCalledTimes(1);
  });

  test("body に入れたものは窓の中に出る", () => {
    const target = makeWindow();
    const child = document.createElement("div");
    target.body.append(child);
    expect(target.element.contains(child)).toBe(true);
  });

  test("destroy で DOM から外れる", () => {
    const target = makeWindow();
    target.destroy();
    expect(target.element.isConnected).toBe(false);
    expect(document.getElementById("yt-clip-list")).toBeNull();
  });
});

describe("最初の位置", () => {
  test("区間・テロップの窓は今の右側パネルと同じ (右 16px・上 68px・幅 400px・高さは決めない)", () => {
    expect(initialListRect({ width: 1440, height: 795 })).toEqual({
      left: 1024,
      top: 68,
      width: 400,
    });
  });

  test("設定の窓は区間・テロップの窓から下へ 32px だけずらす (left は同じ)", () => {
    expect(SETTINGS_CASCADE_PX).toBe(32);
    expect(initialSettingsRect({ width: 1440, height: 795 })).toEqual({
      left: 1024,
      top: 100,
      width: 400,
    });
  });

  test("1440x795 で設定の窓の左端はプレイヤーの右端 (1012px、実測) より右 (受け入れ条件 C1.5)", () => {
    expect(initialSettingsRect({ width: 1440, height: 795 }).left).toBeGreaterThanOrEqual(1012);
  });
});

describe("scrollTo", () => {
  function windowWithRow(): { target: PanelWindow; row: HTMLElement } {
    const target = makeWindow();
    target.setVisible(true);
    const row = document.createElement("div");
    target.body.append(row);
    // 本体は画面の 100〜500px に見えている
    placeAt(target.body, 100, 400);
    return { target, row };
  }

  test("見える範囲より下にあれば、先頭を本体の上端に揃える", () => {
    const { target, row } = windowWithRow();
    placeAt(row, 900, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("既に送ってあれば、その分に足して揃える", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 200;
    placeAt(row, 700, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(800);
  });

  test("上にはみ出していれば、先頭が見えるところまで戻す", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 500;
    placeAt(row, 40, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(440);
  });

  test("既に全部見えていれば動かさない (見ている位置を勝手に跳ねさせない)", () => {
    const { target, row } = windowWithRow();
    target.body.scrollTop = 30;
    placeAt(row, 150, 50);

    target.scrollTo(row);

    expect(target.body.scrollTop).toBe(30);
  });

  test("本体の外の要素には何もしない", () => {
    const { target } = windowWithRow();
    const outside = document.createElement("div");
    document.body.append(outside);
    placeAt(outside, 900, 50);

    target.scrollTo(outside);

    expect(target.body.scrollTop).toBe(0);
    outside.remove();
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/panel-window.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: FAIL。`panel-window.test.ts` は `Failed to resolve import "@/content/panel-window"`、`styles.test.ts` の「見出しのある窓の中身の箱」は
`PANEL_WINDOW_STYLE` が undefined で落ちる

- [ ] **Step 4: 最小実装 (styles)**

`src/content/styles.ts` の `SIDE_PANEL_STYLE` の定義 (`} as const;` まで) の**直後**に、空行を 1 つ挟んで次を足す。

```typescript
/**
 * 見出しのある「幅と高さ」の窓 (`panel-window.ts`。区間・テロップの窓と設定の窓) の中身の箱。
 * **枠の見た目 (地・影・見出し) は `FLOATING_WINDOW_STYLE` が持つ。** 位置・幅は YouTube の実機の値に
 * 合わせるので、出所と一緒に `panel-window.ts` が持つ。
 *
 * **`body` は display を持つ (flex)。** 右側のパネルの本体が display を持たなかったのは、折り畳みで
 * 本体を出し入れしていたため。折り畳みをやめた (窓の分割の spec C1.2) ので、本体を出し入れする者はいない
 * (窓ごとの出し入れは `floating-window.ts` が窓の根の style.display で行う)
 */
export const PANEL_WINDOW_STYLE = {
  /**
   * 中身の箱。**超えた分はここだけでスクロールする。** `min-height:0` が無いと
   * flex の子は中身より縮まず、窓ごと画面の下へ伸びる
   */
  body: "display:flex;flex-direction:column;gap:12px;padding:0 12px 12px;overflow-y:auto;min-height:0;flex:1 1 auto;",
} as const;
```

- [ ] **Step 5: 最小実装 (panel-window)**

`src/content/panel-window.ts` を次の内容で作る。

```typescript
import {
  createFloatingWindow,
  type FloatingWindow,
  type WindowRect,
} from "@/content/floating-window";
import { PANEL_WINDOW_STYLE } from "@/content/styles";
import { MASTHEAD_HEIGHT_PX, TOP_GAP_PX, type Viewport } from "@/content/window-layout";

/**
 * 見出しのある「幅と高さ」の窓 (`.claude/specs/2026-09-25-dockable-windows-design.md` C1.4)。
 * 区間・テロップの窓と設定の窓の両方をこれで作る。**フロートの窓 (`floating-window.ts`) の上に作る。**
 *
 * **中身の箱 (余白・スクロール) と scrollTo だけを持つ。** 窓の枠 (見出し・ドラッグ・大きさ・画面に
 * 詰める・重なり順) は floating-window.ts、何を入れるか・いつ出すか・どこへ置くかは youtube.ts が決める。
 * 出すかの理由をここにも持たせると、2 箇所の判定が食い違ったときにどちらが正か分からなくなる。
 *
 * **折り畳み (▶) は持たない** (C1.2)。動かせる窓になり、重なるときは動かせば済む。残すと
 * 「畳んだ × 重なり順 (C2 ではドック中 × タブが前)」の組み合わせが増える
 */

/*
 * 最初の位置と寸法。**YouTube の実機の値に合わせている。**
 * 出所: 2026-09-24 に `npm run check:telop` の「パネルの位置の出所 (YouTube の実測)」(当時の名前。今は
 * 「窓の位置の出所 (YouTube の実測)」) で測った
 * (viewport 1920x1080): #masthead-container の高さ 56px・z-index 2020、#secondary の幅 544px。
 * ヘッダーの高さとの間 (MASTHEAD_HEIGHT_PX / TOP_GAP_PX) はバーの窓の上端の下限と共有するので
 * window-layout.ts に置く。
 * z-index は「ヘッダー (#masthead-container、z-index 2020) より下」であることだけ実測
 * (重なり順の値は floating-window.ts の Z_BASE が持つ)。
 * ヘッダーのメニュー本体は自前の z-index を持つため測っておらず、ytd-popup-container の
 * z-index auto はその根拠にならない。#secondary の幅は viewport で変わるので WIDTH_PX の
 * doc に別で書く。YouTube のレイアウトが変わったら測り直す
 */
/** 画面の右端との間 (下端との間 16px は floating-window.ts の BOTTOM_GAP_PX) */
const EDGE_GAP_PX = 16;
/**
 * #secondary の幅は viewport で変わる (1920x1080 で 544px、実測)。400px は
 * 1440x795 (受け入れ条件の viewport) でもプレイヤーに重ならない幅
 * (実測: プレイヤーの右端 1012px < 窓の左端 1024px)
 */
const WIDTH_PX = 400;
/** 大きさを変えられる下限 (フロートの窓の spec A.1。C1.1 で両方の窓に同じ値)。これより小さいと一覧の 1 行が読めない */
const MIN_WIDTH_PX = 280;
const MIN_HEIGHT_PX = 160;
/**
 * 設定の窓を区間・テロップの窓からずらす量 (下へだけ。C1.3 のカスケード)。一覧の見出しの行 (32px) が
 * 設定の窓の上に残って見え、掴んで動かせる。完全に重ねない: ⚙ を押した瞬間に一覧が丸ごと隠れると、
 * 分けた意味 (両方を同時に見る) が薄い。**左右にはずらさない:** 1440x795 で一覧の left は 1024px、
 * プレイヤーの右端は 1012px (実測) なので、左へ 32px ずらすとプレイヤーに 20px 重なる。右へは画面の
 * 右端で詰められて同じ位置になる
 */
export const SETTINGS_CASCADE_PX = 32;

export type PanelWindow = {
  element: HTMLElement;
  /** 中身の箱。区間・テロップの窓には区間の一覧とテロップの一覧、設定の窓には設定パネルを入れる */
  body: HTMLElement;
  /**
   * 出すか隠すか。**理由の計算は youtube.ts の 1 箇所に置く** (中身が無い / 設定を閉じている /
   * 全画面 / 動画ページ以外 / 覚えた配置の読み込み前、のどれかなら隠す)。窓は理由を知らない
   */
  setVisible(visible: boolean): void;
  /** 中身の箱の中だけをスクロールして、target の先頭を見える範囲に入れる */
  scrollTo(target: HTMLElement): void;
  destroy(): void;
  /**
   * 窓の枠。**位置と大きさ (place / rect) は youtube.ts が決める** (最初の位置・
   * 覚えた位置・取り直し)。出し入れは setVisible を使う
   */
  frame: FloatingWindow;
};

export type PanelWindowOptions = {
  /** 窓の id ("yt-clip-list" / "yt-clip-settings")。中身の箱の id は `${id}-body` */
  id: string;
  /** 見出しの文言 ("区間・テロップ" / "設定")。C2 ではそのままタブの文言になる */
  title: string;
  /** 見出しをドラッグして動かした・右下で大きさを変えた (指を離した時点で 1 回) */
  onUserMove?(rect: WindowRect): void;
  /** 見出しのダブルクリック (最初の位置に戻す) */
  onResetRequest?(): void;
};

/**
 * 区間・テロップの窓の最初の位置 (C1.3: 今の右側パネルと同じ)。右端から EDGE_GAP_PX、
 * ヘッダーの下 TOP_GAP_PX、幅 WIDTH_PX。**高さは決めない** (中身まで伸び、画面の下端から 16px で止まる)
 */
export function initialListRect(viewport: Viewport): WindowRect {
  return {
    left: viewport.width - EDGE_GAP_PX - WIDTH_PX,
    top: MASTHEAD_HEIGHT_PX + TOP_GAP_PX,
    width: WIDTH_PX,
  };
}

/**
 * 設定の窓の最初の位置 (C1.3)。区間・テロップの窓の**最初の位置**から下へ SETTINGS_CASCADE_PX。
 * 一覧を動かした後の位置には付いていかない: 付けると、一覧を動かすたびに動かしていない設定の窓も
 * 置き直す経路が要り、1440x795 でプレイヤーに重ならない保証も最初の位置どうしでしか成り立たない
 */
export function initialSettingsRect(viewport: Viewport): WindowRect {
  const list = initialListRect(viewport);
  return { ...list, top: list.top + SETTINGS_CASCADE_PX };
}

/**
 * 窓を作る。**自分では最初の位置に置かない。** どちらの窓の最初の位置かは作る側 (youtube.ts) が
 * 知っており、窓を出した直後に置く (バーの窓と同じ経路)。隠れている間は寸法が 0 なので、
 * 作った時点で置いても出すときに置き直すことになる
 */
export function createPanelWindow(options: PanelWindowOptions): PanelWindow {
  const frame = createFloatingWindow({
    id: options.id,
    title: options.title,
    resize: "both",
    minWidth: MIN_WIDTH_PX,
    minHeight: MIN_HEIGHT_PX,
    onUserMove: (rect) => options.onUserMove?.(rect),
    onResetRequest: () => options.onResetRequest?.(),
  });
  const { element, body } = frame;

  body.id = `${options.id}-body`;
  body.style.cssText = PANEL_WINDOW_STYLE.body;

  return {
    element,
    body,
    frame,

    setVisible(visible): void {
      frame.setVisible(visible);
    },

    scrollTo(target): void {
      // 本体の外 (まだ入れていない・別の場所へ移った) なら送る先が無い
      if (!body.contains(target)) return;
      // **offsetTop ではなく画面上の位置の差で測る。** テロップの行は一覧の中の
      // 入れ子なので、offsetTop の基準の祖先が本体とずれる。
      // **scrollIntoView は使わない。** ページまで動かして動画の位置がずれうる
      const view = body.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      // 既に全部見えていれば動かさない。見ている位置が勝手に跳ねない
      if (rect.top >= view.top && rect.bottom <= view.bottom) return;
      body.scrollTop += rect.top - view.top;
    },

    destroy(): void {
      frame.destroy();
    },
  };
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/panel-window.test.ts tests/content/styles.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 7: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`side-panel.ts` とそのテストはまだ残っていて、そのまま通る)

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/panel-window.ts src/content/styles.ts tests/content/panel-window.test.ts tests/content/styles.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 区間・テロップと設定の窓に使う、見出しのある窓を作る

右側のパネルを 2 つの窓に分けるため、中身の箱と scrollTo だけを
持つ窓を用意する。折り畳みは入れない (動かせる窓になり、残すと
状態の組み合わせだけが増える)。設定の窓は一覧の最初の位置から下へ
32px だけずらす: 左へずらすと 1440x795 でプレイヤーに重なる。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: 覚える配置を v2 の組にし、`float` の写しから保存する (`window-layout.ts` + `youtube.ts`)

**Files:**
- Modify: `src/content/window-layout.ts:1-24` (見出しの doc と型)、`:72-100` (`mergeWindowLayout`)、`:161-215` (保存と読み込み)
- Modify: `src/content/youtube.ts:51-57` (import)、`:136-140` (`movedWindows`)、`:148-151` (パネルの窓の配線)、`:953-1008` (窓の位置の関数)、`:1037` (`refreshWindows`)、`:1744-1747` (`placeUnmovedWindows`)、`:1944-1962` (`loadInitialLayout`)
- Test: `tests/content/window-layout.test.ts`
- Test: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: なし (Task 2・3 とは独立)
- Produces (`window-layout.ts`):
  - `type WindowId = "bar" | "list" | "settings"` (`"panel"` は消える)
  - `type DockSlotId = "below" | "side"`、`type DockState = { tabs: WindowId[]; active?: WindowId }`
  - `type WindowLayout = { version: 2; float: Partial<Record<WindowId, WindowRect>>; docks: Partial<Record<DockSlotId, DockState>> }`
  - `WINDOW_LAYOUT_VERSION = 2`
  - `emptyWindowLayout(): WindowLayout` — `{ version: 2, float: {}, docks: {} }` (呼ぶたびに新しい組)
  - `mergeWindowLayout(stored: unknown): WindowLayout` — v1 / v2 を読み分ける (判断メモ 9・10)
  - `loadWindowLayout(): Promise<WindowLayout>` — 読めなければ warn して `emptyWindowLayout()`
  - `saveWindowLayout(layout: WindowLayout): Promise<void>` — 組ごと書く。呼んだ時点で写す (判断メモ 12)
  - `saveWindowRect` / `clearWindowRect` は消える
- Produces (`youtube.ts`、モジュール内): `floatLayout: Partial<Record<WindowId, WindowRect>>` (覚えた `float` の写し)、
  `rememberWindowRect(id: WindowId, rect: WindowRect): void`、`resetWindow(id)`、`currentWindowLayout(): WindowLayout`、
  `persistWindowLayout(): void`。**この時点の窓は 2 つ (バーとパネル) のまま**で、パネルを `"list"` として保存する
  (`windowOf` / `initialWindowRect` / `placeInitial` / `resetWindow` の引数は `"bar" | "list"`。判断メモ 1)

- [ ] **Step 1: 失敗するテストを書く (window-layout)**

`tests/content/window-layout.test.ts` の import (2〜10 行目) を次に置き換える。

```typescript
import {
  WINDOW_LAYOUT_KEY,
  emptyWindowLayout,
  fitRect,
  initialBarRect,
  loadWindowLayout,
  mergeWindowLayout,
  saveWindowLayout,
  type WindowLayout,
} from "@/content/window-layout";
```

同じファイルの `describe("mergeWindowLayout", …)` (26〜87 行目) を丸ごと次に置き換える。

```typescript
/** 何も覚えていないときの組 (3 つとも最初の位置) */
const EMPTY: WindowLayout = { version: 2, float: {}, docks: {} };

describe("mergeWindowLayout", () => {
  test("何も覚えていなければ空の組。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(undefined)).toEqual(EMPTY);
    expect(emptyWindowLayout()).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("v2 の組を読む。高さは無くてよい", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = {
      version: 2,
      float: {
        bar: { left: 24, top: 636, width: 988 },
        list: { left: 1024, top: 68, width: 400, height: 500 },
        settings: { left: 1024, top: 100, width: 400 },
      },
      docks: {},
    };
    expect(mergeWindowLayout(stored)).toEqual(stored);
    expect(warn).not.toHaveBeenCalled();
  });

  test("古い形 (v1: version が無い) は bar → float.bar、panel → float.list に読み替える。設定の窓は無い扱い", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    const panel = { left: 1024, top: 68, width: 400, height: 500 };
    expect(mergeWindowLayout({ bar, panel })).toEqual({
      version: 2,
      float: { bar, list: panel },
      docks: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("v1 の空の組 (前に全部の窓を戻した) は空の組。warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({})).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("型の違う窓は捨てて warn する。ほかの窓は使う (v2)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const list = { left: 1024, top: 68, width: 400 };
    expect(
      mergeWindowLayout({
        version: 2,
        float: { bar: { left: "24", top: 636, width: 988 }, list },
        docks: {},
      }),
    ).toEqual({ version: 2, float: { list }, docks: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.float.bar");
  });

  test("型の違う窓は捨てて warn する。ほかの窓は使う (v1)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = { left: 1024, top: 68, width: 400 };
    expect(mergeWindowLayout({ bar: { left: "24", top: 636, width: 988 }, panel })).toEqual({
      version: 2,
      float: { list: panel },
      docks: {},
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("windowLayout.bar");
  });

  test("欠けた窓は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: { bar: { left: 24, top: 636 } }, docks: {} }),
    ).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("範囲の外の値は捨てて warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = [
      { left: 0, top: 0, width: 0 },
      { left: 0, top: 0, width: -100 },
      { left: 1e9, top: 0, width: 400 },
      { left: 0, top: Number.POSITIVE_INFINITY, width: 400 },
      { left: 0, top: 0, width: Number.NaN },
      { left: 0, top: 0, width: 400, height: 0 },
    ];
    for (const rect of bad) {
      expect(mergeWindowLayout({ version: 2, float: { list: rect }, docks: {} })).toEqual(EMPTY);
    }
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });

  test("組でないもの (数値・null・配列) は空の組にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout(42)).toEqual(EMPTY);
    expect(mergeWindowLayout(null)).toEqual(EMPTY);
    expect(mergeWindowLayout([])).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("読めない版 (3・1・数でない版) は空の組にして warn する (後の版が書いた形を推測で読まない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bar = { left: 24, top: 636, width: 988 };
    expect(mergeWindowLayout({ version: 3, float: { bar }, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 1, bar })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: "2", float: { bar }, docks: {} })).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("版");
  });

  test("v2 で float か docks が組でなければ、組ごと空にして warn する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: null, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {}, docks: 5 })).toEqual(EMPTY);
    expect(mergeWindowLayout({ version: 2, float: {} })).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("知らない窓の名前は黙って無視する (後の版で窓が増えても古い版が騒がない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mergeWindowLayout({ version: 2, float: { other: { left: 0 } }, docks: {} })).toEqual(EMPTY);
    expect(mergeWindowLayout({ other: { left: 0 } })).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });

  test("ドック枠の中身はまだ読まない (空で返す。枠を入れる経路がまだ無い)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      mergeWindowLayout({ version: 2, float: {}, docks: { below: { tabs: ["bar"] } } }),
    ).toEqual(EMPTY);
    expect(warn).not.toHaveBeenCalled();
  });
});
```

同じファイルの `describe("覚えた位置の保存と読み込み", …)` (213〜269 行目) を丸ごと次に置き換える。

```typescript
describe("覚えた配置の保存と読み込み", () => {
  const BAR = { left: 24, top: 636, width: 988 };
  const LIST = { left: 1024, top: 68, width: 400, height: 500 };
  let store: Record<string, unknown>;
  let writes: number;

  beforeEach(() => {
    store = {};
    writes = 0;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string): Promise<Record<string, unknown>> =>
            key in store ? { [key]: store[key] } : {},
          set: async (items: Record<string, unknown>): Promise<void> => {
            writes += 1;
            Object.assign(store, items);
          },
        },
      },
    });
  });

  test("覚えた配置を読む", async () => {
    store[WINDOW_LAYOUT_KEY] = { version: 2, float: { bar: BAR }, docks: {} };
    expect(await loadWindowLayout()).toEqual({ version: 2, float: { bar: BAR }, docks: {} });
  });

  test("古い形 (v1) を読んでも書き戻さない (次に動かしたときに v2 で書く)", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: LIST };
    expect(await loadWindowLayout()).toEqual({
      version: 2,
      float: { bar: BAR, list: LIST },
      docks: {},
    });
    expect(writes).toBe(0);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ bar: BAR, panel: LIST });
  });

  test("読めなければ warn して空の組を返す (最初の位置で出す)", async () => {
    vi.stubGlobal("chrome", {
      storage: { local: { get: () => Promise.reject(new Error("壊れた")) } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await loadWindowLayout()).toEqual(EMPTY);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("組ごと書く。前に覚えていた組は読まずに置き換える", async () => {
    store[WINDOW_LAYOUT_KEY] = { bar: BAR, panel: LIST };
    await saveWindowLayout({ version: 2, float: { settings: LIST }, docks: {} });
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { settings: LIST }, docks: {} });
  });

  test("続けて保存すると、後に呼んだ組が残る (書き込みの順を保つ)", async () => {
    // 先の書き込みだけを遅らせる。列に並べないと、後の組が先に書かれて先の組に上書きされる
    const delays = [20, 0];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (): Promise<Record<string, unknown>> => ({}),
          set: async (items: Record<string, unknown>): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
            Object.assign(store, items);
          },
        },
      },
    });
    await Promise.all([
      saveWindowLayout({ version: 2, float: { bar: BAR }, docks: {} }),
      saveWindowLayout({ version: 2, float: { list: LIST }, docks: {} }),
    ]);
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { list: LIST }, docks: {} });
  });

  test("高さの無い窓は高さを書かない", async () => {
    await saveWindowLayout({
      version: 2,
      float: { bar: { left: 1, top: 2, width: 480, height: undefined } },
      docks: {},
    });
    const saved = (store[WINDOW_LAYOUT_KEY] as WindowLayout).float.bar;
    expect(Object.keys(saved ?? {})).toEqual(["left", "top", "width"]);
  });

  test("呼んだ後に渡した組を書き換えても、書く値は呼んだ時点のまま", async () => {
    const layout: WindowLayout = { version: 2, float: { bar: { ...BAR } }, docks: {} };
    const saving = saveWindowLayout(layout);
    layout.float.list = LIST;
    const bar = layout.float.bar;
    if (bar !== undefined) bar.left = 0;
    await saving;
    expect(store[WINDOW_LAYOUT_KEY]).toEqual({ version: 2, float: { bar: BAR }, docks: {} });
  });
});
```

- [ ] **Step 2: 実行して失敗を確認 (window-layout)**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: FAIL (`emptyWindowLayout is not a function` / `saveWindowLayout is not a function`、v1 の読み替えの期待値の食い違いなど)

- [ ] **Step 3: 最小実装 (window-layout)**

`src/content/window-layout.ts` の 1〜24 行目 (ファイルの doc から `export type SizeLimits = …;` まで)

```typescript
/**
 * フロートの窓 (バーの窓・パネルの窓) の位置と大きさ
 * (`.claude/specs/2026-09-24-floating-windows-design.md` A.2 / A.3)。
 *
 * 覚えた位置の保存・読み込み・検証と、画面に詰める計算を持つ。計算は純粋関数にして、
 * DOM を持たないテストで確かめる。
 *
 * **`chrome.storage.local` に置く (sync にしない)。** 画面の大きさと窓の置き場所の好みは
 * 端末ごとに違う。sync で運ぶと、大きい画面で置いた位置が小さい画面の端末へ届く
 */

export const WINDOW_LAYOUT_KEY = "windowLayout";

export type WindowId = "bar" | "panel";
const WINDOW_IDS: readonly WindowId[] = ["bar", "panel"];

/** 画面 (viewport) の座標で、窓の左上と大きさ。height が無い窓は高さを中身に任せる */
export type WindowRect = { left: number; top: number; width: number; height?: number };
export type WindowLayout = Partial<Record<WindowId, WindowRect>>;
export type Viewport = { width: number; height: number };
/** 掴む場所 (パネルは見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };
```

を次に置き換える。

```typescript
/**
 * フロートの窓 (バーの窓・区間・テロップの窓・設定の窓) の位置と大きさ
 * (`.claude/specs/2026-09-24-floating-windows-design.md` A.2 / A.3、
 * `.claude/specs/2026-09-25-dockable-windows-design.md` C1.3)。
 *
 * 覚えた配置の保存・読み込み・検証と、画面に詰める計算を持つ。計算は純粋関数にして、
 * DOM を持たないテストで確かめる。
 *
 * **`chrome.storage.local` に置く (sync にしない)。** 画面の大きさと窓の置き場所の好みは
 * 端末ごとに違う。sync で運ぶと、大きい画面で置いた位置が小さい画面の端末へ届く
 */

export const WINDOW_LAYOUT_KEY = "windowLayout";

/** 窓の名前 (窓の分割の spec C1.1)。覚えた配置の鍵にも使う */
export type WindowId = "bar" | "list" | "settings";
const WINDOW_IDS: readonly WindowId[] = ["bar", "list", "settings"];
/** ドック枠の名前 (C2)。C1 では型だけを置き、枠の中身は常に空 */
export type DockSlotId = "below" | "side";
const DOCK_SLOT_IDS: readonly DockSlotId[] = ["below", "side"];
/** 枠に入っている窓 (タブの並び。前から) と、前に出しているタブ (C2) */
export type DockState = { tabs: WindowId[]; active?: WindowId };

/** 画面 (viewport) の座標で、窓の左上と大きさ。height が無い窓は高さを中身に任せる */
export type WindowRect = { left: number; top: number; width: number; height?: number };
/** 覚えている配置の形の版。古い形 (v1: `{ bar?, panel? }`) は version を持たない */
export const WINDOW_LAYOUT_VERSION = 2;
/**
 * 覚える配置 (C1.3)。**C2 の枠の情報も入る形にしておく** (C1 と C2 で読み替えを 2 回書かない)
 */
export type WindowLayout = {
  version: 2;
  /** フロートで置いた位置と大きさ。無い窓は最初の位置 (A.2 / C1.3) */
  float: Partial<Record<WindowId, WindowRect>>;
  /** 枠ごとの、入っている窓 (タブの並び。前から) と前に出しているタブ。C1 では常に空 */
  docks: Partial<Record<DockSlotId, DockState>>;
};
export type Viewport = { width: number; height: number };
/** 掴む場所 (区間・テロップの窓と設定の窓は見出し、バーはつまみ) の箱。窓の左上からの位置 */
export type GripBox = { left: number; top: number; width: number; height: number };
export type SizeLimits = { minWidth: number; minHeight?: number };

/** 何も覚えていないときの配置 (3 つとも最初の位置)。呼ぶたびに新しい組を返す (書き換えても共有しない) */
export function emptyWindowLayout(): WindowLayout {
  return { version: WINDOW_LAYOUT_VERSION, float: {}, docks: {} };
}
```

同じファイルの `mergeWindowLayout` (72〜100 行目。doc コメントから関数の閉じ括弧まで) を次に置き換える。

```typescript
/** 組 (配列でない object) か。配列も typeof は "object" なので分ける */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 覚えた位置を窓ごとに読む。keys は「保存されている鍵 → 窓の名前」。型と範囲が合わない窓は
 * 捨てて warn する (ほかの窓は使う)。知らない鍵は黙って無視する (後の版で窓が増えても古い版が騒がない)
 */
function readRects(
  source: Record<string, unknown>,
  keys: readonly (readonly [string, WindowId])[],
  path: string,
): Partial<Record<WindowId, WindowRect>> {
  const rects: Partial<Record<WindowId, WindowRect>> = {};
  for (const [key, id] of keys) {
    const value = source[key];
    if (value === undefined) continue;
    const rect = parseRect(value);
    if (rect === null) {
      console.warn(
        `[yt-clip] 保存された windowLayout.${path}${key} が使えないため最初の位置を使います: ${JSON.stringify(value)}`,
      );
      continue;
    }
    rects[id] = rect;
  }
  return rects;
}

/** 古い形 (v1) の鍵 → 窓。パネルの位置は区間・テロップの窓が継ぐ。設定の窓は v1 に無い (C1.3) */
const V1_KEYS = [
  ["bar", "bar"],
  ["panel", "list"],
] as const;
const V2_KEYS = WINDOW_IDS.map((id) => [id, id] as const);

/**
 * 覚えた配置を読む (C1.3)。**型は保証されない** (古い版が書いたもの・手で書き換えたもの)。
 *
 * - `version` のキーが無ければ古い形 (v1: `{ bar?, panel? }`)。`bar` → `float.bar`、`panel` → `float.list`
 *   に読み替える。**読み替えた組は書き戻さない** (読み込みは書かない。次に動かしたときに v2 で書く)
 * - `version` が 2 なら v2。`float` と `docks` が組でなければ、組ごと捨てて warn する
 * - それ以外の `version` (後の版が書いた 3 など) は形が分からないので、推測で読まずに warn して最初の配置
 *
 * 窓ごとに型と範囲を確かめ、合わない窓は捨てて最初の位置に戻す。握りつぶさず理由は残す
 * (設定の mergeSettings と同じ作法)。**`docks` の中身はまだ読まない** (枠に入れる経路がまだ無い。
 * タブの並びの検証はドック枠を入れるときに足す)
 */
export function mergeWindowLayout(stored: unknown): WindowLayout {
  if (stored === undefined) return emptyWindowLayout();
  if (!isRecord(stored)) {
    console.warn(
      `[yt-clip] 保存された windowLayout が使えないため最初の位置を使います: ${JSON.stringify(stored)}`,
    );
    return emptyWindowLayout();
  }
  if (!("version" in stored)) {
    return { ...emptyWindowLayout(), float: readRects(stored, V1_KEYS, "") };
  }
  if (stored.version !== WINDOW_LAYOUT_VERSION) {
    console.warn(
      `[yt-clip] 保存された windowLayout の版 (${JSON.stringify(stored.version)}) を読めないため最初の位置を使います`,
    );
    return emptyWindowLayout();
  }
  if (!isRecord(stored.float) || !isRecord(stored.docks)) {
    console.warn(
      `[yt-clip] 保存された windowLayout の float / docks が使えないため最初の位置を使います: ${JSON.stringify(stored)}`,
    );
    return emptyWindowLayout();
  }
  return { ...emptyWindowLayout(), float: readRects(stored.float, V2_KEYS, "float.") };
}
```

同じファイルの 161〜215 行目 (`/** 保存を 1 本の列にする。…` からファイルの末尾まで) を次に置き換える。

```typescript
/**
 * 保存を 1 本の列にする。**書き込みの順を保つ** (先に呼んだ保存が後に呼んだ保存より後に届き、
 * 新しい配置を古い配置で上書きしないように)。組ごと書くようになって「読んで書き戻す処理が重なり、
 * 先の書き込みが後の書き込みで消える」ことは無くなったが、書き込みが呼んだ順に済む保証は無いので残す
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // 1 つが失敗しても後ろの保存は続ける。失敗は呼び出し側 (run) に返す
  queue = run.catch(() => undefined);
  return run;
}

/** 保存する形に写す。高さが無い窓は高さのキーごと持たない (保存に undefined を書かない) */
function toStored(layout: WindowLayout): WindowLayout {
  const float: Partial<Record<WindowId, WindowRect>> = {};
  for (const id of WINDOW_IDS) {
    const rect = layout.float[id];
    if (rect !== undefined) float[id] = toRect(rect.left, rect.top, rect.width, rect.height);
  }
  const docks: Partial<Record<DockSlotId, DockState>> = {};
  for (const slot of DOCK_SLOT_IDS) {
    const dock = layout.docks[slot];
    if (dock === undefined) continue;
    docks[slot] =
      dock.active === undefined
        ? { tabs: [...dock.tabs] }
        : { tabs: [...dock.tabs], active: dock.active };
  }
  return { version: WINDOW_LAYOUT_VERSION, float, docks };
}

/**
 * 覚えた配置を読む。
 *
 * ※ 局所例外 (Fail Fast): **読めなくても reject しない。** warn を残して空の組を返し、窓は
 * 最初の位置で出る (spec A.2「読み込みが失敗 (reject) したら console.warn を残して最初の位置で
 * 出す」)。投げると、呼び出し側が窓を出さないままにする経路を作りうる
 */
export async function loadWindowLayout(): Promise<WindowLayout> {
  try {
    const stored = await chrome.storage.local.get(WINDOW_LAYOUT_KEY);
    return mergeWindowLayout(stored[WINDOW_LAYOUT_KEY]);
  } catch (error) {
    console.warn(`[yt-clip] 窓の位置を読めないため最初の位置を使います: ${String(error)}`);
    return emptyWindowLayout();
  }
}

/**
 * 窓の配置を組ごと覚える (C1.3)。**前に覚えていた組は読まない** (読んで書き戻さない)。組は
 * youtube.ts が持つ写しから毎回作る: ドック枠を入れると、1 つの窓の操作で 2 つの枠のタブの並びが
 * 変わりうり (引き出して別の枠へ)、窓ごとの部分更新では整合が取れない。
 * **呼んだ時点の組を写してから列に並べる** (並んでいる間に呼び出し側が写しを書き換えても、
 * この呼び出しの組を書く。後の組は後の呼び出しが書く)
 */
export function saveWindowLayout(layout: WindowLayout): Promise<void> {
  const value = toStored(layout);
  return serialize(async () => {
    await chrome.storage.local.set({ [WINDOW_LAYOUT_KEY]: value });
  });
}
```

- [ ] **Step 4: 実行して通過を確認 (window-layout)**

実行: `npx vitest run tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: PASS (`fitRect` / `initialBarRect` の検査も変わらず通る)

- [ ] **Step 5: 失敗するテストを書く (youtube の保存の組)**

`tests/content/youtube.test.ts` の 23 行目 `import type { Message } from "@/shared/messages";` の**直後**に次を足す。

```typescript
import type { WindowLayout } from "@/content/window-layout";
```

同じファイルの `LAYOUT_AT_LOAD` の doc コメント (265 行目)

```typescript
/** 読み込み時に覚えていた窓の位置。この位置で出ることを確かめる (jsdom の画面 1024x768 に収まる値) */
```

を次に置き換える。

```typescript
/**
 * 読み込み時に覚えていた窓の位置。この位置で出ることを確かめる (jsdom の画面 1024x768 に収まる値)。
 * **古い形 (v1: version が無い) で置く。** panel は区間・テロップの窓が継ぐ (窓の分割の spec C1.3)
 */
```

`describe("フロートの窓")` の中の「つまみをドラッグすると動き、指を離したときに 1 回だけ覚える」の最後の期待

```typescript
    expect(layoutWrites).toEqual([{ bar: { left: left + 50, top: top + 30, width } }]);
```

を次に置き換える。

```typescript
    // 組ごと書く (v2)。動かしていない窓の位置は書かない (float に bar だけ)
    expect(layoutWrites).toEqual([
      { version: 2, float: { bar: { left: left + 50, top: top + 30, width } }, docks: {} },
    ]);
```

同じ describe の「パネルの窓は見出しをドラッグすると動き、位置を覚える」の最後の期待

```typescript
    expect(layoutWrites).toEqual([{ panel: { left: left - 100, top: 88, width: 400 } }]);
```

を次に置き換える。

```typescript
    // パネルの位置は区間・テロップの窓 (list) として覚える。動かしていないバーは書かない
    expect(layoutWrites).toEqual([
      { version: 2, float: { list: { left: left - 100, top: 88, width: 400 } }, docks: {} },
    ]);
```

同じ describe の「つまみ・見出しをダブルクリックすると最初の位置に戻り、覚えた位置を消す」の 2 つの期待

```typescript
      expect(storedLayout).toEqual({
        bar: { left: 124, top: 588, width: 800 },
        panel: { left: window.innerWidth - 516, top: 88, width: 400 },
      });
```

```typescript
      expect(storedLayout).toEqual({});
```

をそれぞれ次に置き換える。

```typescript
      expect(storedLayout).toEqual({
        version: 2,
        float: {
          bar: { left: 124, top: 588, width: 800 },
          list: { left: window.innerWidth - 516, top: 88, width: 400 },
        },
        docks: {},
      });
```

```typescript
      expect(storedLayout).toEqual({ version: 2, float: {}, docks: {} });
```

同じ describe の「パネルの窓は見出しをドラッグすると動き、位置を覚える」のテストの**直後**に次を足す。

```typescript
  /** 区間・テロップの窓を出す (エディットで区間が 1 つある)。出すかは一覧の中身で決まる */
  async function showList(): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
  }

  test("画面に詰められた窓の覚えた位置を、ほかの窓を動かしたときに詰めた後の位置で上書きしない", async () => {
    await showList();
    // jsdom は寸法を持たない。一覧の窓の見出し (掴む場所) を幅 400・高さ 32 に決め打ちし、詰め方を測れるようにする
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === panelElement()) return boxAt(0, 0, 400, 300);
        if (this === panelHeader()) return boxAt(0, 0, 400, 32);
        return boxAt(0, 0, 0, 0);
      });
    const setWidth = (width: number): void => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
      window.dispatchEvent(new Event("resize"));
    };
    try {
      // 最初の位置 (1024 - 416 = 608, 68) から下へ 100px 動かして覚える
      drag(panelHeader(), 0, 100);
      await flush();
      const placed = { left: 608, top: 168, width: 400 };
      expect((storedLayout as WindowLayout).float.list).toEqual(placed);

      // ブラウザを狭めると、見出しが画面に残るところ (800 - 400) まで詰められる
      setWidth(800);
      expect(panelElement().style.left).toBe("400px");

      // その間にバーの窓を動かして覚えても、一覧の窓の覚えた位置は置いた場所のまま
      // (窓の rect() から組を作ると、詰めた後の 400 で書かれて、広げ直しても戻らなくなる)
      drag(barGrip(), 10, 0);
      await flush();
      const stored = storedLayout as WindowLayout;
      expect(stored.float.list).toEqual(placed);
      expect(Object.keys(stored.float).sort()).toEqual(["bar", "list"]);
    } finally {
      setWidth(1024);
      spy.mockRestore();
    }
  });

  test("ダブルクリックで戻した窓は組から消え、ほかの窓の覚えた位置は残る", async () => {
    await showList();
    drag(barGrip(), 30, 20);
    drag(panelHeader(), -100, 20);
    await flush();
    expect(Object.keys((storedLayout as WindowLayout).float).sort()).toEqual(["bar", "list"]);

    dblclick(panelHeader());
    await flush();

    const stored = storedLayout as WindowLayout;
    expect(stored.version).toBe(2);
    expect(Object.keys(stored.float)).toEqual(["bar"]);
    expect(stored.docks).toEqual({});
  });
```

- [ ] **Step 6: 実行して失敗を確認 (youtube)**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: FAIL。`src/content/youtube.ts` がまだ `saveWindowRect` / `clearWindowRect` を import しているので読み込みで落ちる
(`saveWindowRect is not a function` など)。`npm run typecheck` も `youtube.ts` の import と `"panel"` で落ちる

- [ ] **Step 7: 最小実装 (youtube)**

`src/content/youtube.ts` の 51〜57 行目

```typescript
import {
  clearWindowRect,
  initialBarRect,
  loadWindowLayout,
  saveWindowRect,
  type WindowId,
} from "@/content/window-layout";
```

を次に置き換える。

```typescript
import {
  initialBarRect,
  loadWindowLayout,
  saveWindowLayout,
  type WindowId,
  type WindowLayout,
} from "@/content/window-layout";
```

136〜140 行目

```typescript
/**
 * ユーザーが動かした (か、覚えた位置で出した) 窓。**動かした窓は最初の位置を取り直さない**
 * (spec A.2: 置いた場所から動かさない)。掴む場所のダブルクリックで戻すと外れる
 */
const movedWindows = new Set<WindowId>();
```

を次に置き換える。

```typescript
/**
 * フロートで置いた窓の位置と大きさの写し (覚えた配置の `float`。窓の分割の spec C1.3)。
 *
 * **書き換えるのは 3 箇所だけ**: 読み込み (`loadInitialLayout`) / ユーザーが動かした・大きさを変えた
 * (`rememberWindowRect`) / 掴む場所のダブルクリックで戻した (`resetWindow`)。**窓の `rect()` からは作らない。**
 * rect() は画面に詰めた後の位置で、別の窓を動かしただけで、動かしていない窓 (覚えた位置が無いはず) や
 * 詰められた窓 (ブラウザを大きく戻すと置いた場所へ戻るはず) の覚えた位置を書き換えてしまう
 * (floating-window.ts の requested と current の区別を壊す)。
 *
 * **ここに無い窓が「動かしていない窓」。** resize とプレイヤーの大きさの変化で最初の位置を取り直す
 * (spec A.2)。ここにある窓は置いた場所から動かさない。
 *
 * 保存はこの写しから組ごと書く (読み直さない)。そのため**別のタブで後から動かした窓の位置は、このタブで次に
 * 保存すると消える** (最後に動かしたタブの配置が残る。README の制約に書いてある)
 */
const floatLayout: Partial<Record<WindowId, WindowRect>> = {};
```

148〜151 行目

```typescript
const sidePanel = createSidePanel({
  onUserMove: (rect) => rememberWindowRect("panel", rect),
  onResetRequest: () => resetWindow("panel"),
});
```

を次に置き換える。

```typescript
// パネルの位置は、窓を分けた後に区間・テロップの窓が継ぐ鍵 (list) で覚える
const sidePanel = createSidePanel({
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
});
```

953〜1008 行目 (`/** 窓の枠。id で引く … */` から `resetWindow` の閉じ括弧まで) を次に置き換える。

```typescript
/** 窓の枠。id で引く (覚えた配置の鍵と同じ名前) */
function windowOf(id: "bar" | "list"): FloatingWindow {
  return id === "bar" ? barWindow : sidePanel.frame;
}

/**
 * 窓の最初の位置 (spec A.2)。バーはプレイヤーの直下、パネルは画面の右上。
 * プレイヤーがまだ無ければ null (出たときに取り直す)。
 *
 * **プレイヤーの画面上の位置をそのまま使う。** ページがスクロールされていても、今見えている
 * 位置の直下に置く (窓は画面に固定なので、ページの座標に直さない)。バーの高さは出ている窓で
 * 測る (隠れている窓は 0 になる。そのため出した直後に取り直す: refreshWindows)
 */
function initialWindowRect(id: "bar" | "list"): WindowRect | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (id === "list") return initialPanelRect(viewport);
  const player = document.querySelector(YT_SELECTORS.player);
  if (player === null) return null;
  const box = player.getBoundingClientRect();
  // **高さを測る前にプレイヤーの幅を当てる。** 覚えた位置が無い読み込みでは窓は最小の幅
  // (480px) のままで、エディットモードの操作の行は 2 段に折り返して背が高く測れる。その高さで
  // 画面の下端に詰めると、プレイヤーの直下より上に置かれてシークバーに重なる。
  // place は style を同期で当てるので、直後の測定は新しい幅でレイアウトされる
  barWindow.place({ left: box.left, top: barWindow.rect().top, width: box.width });
  return initialBarRect(
    { left: box.left, bottom: box.bottom, width: box.width },
    barWindow.element.getBoundingClientRect().height,
    viewport,
  );
}

/**
 * 動かしていない窓 (覚えた `float` に無い窓) を最初の位置に置く。覚えた配置の読み込みが済む前は
 * 何もしない (まだ出さない)
 */
function placeInitial(id: "bar" | "list"): void {
  if (!layoutReady || floatLayout[id] !== undefined) return;
  const rect = initialWindowRect(id);
  if (rect !== null) windowOf(id).place(rect);
}

/**
 * 覚える配置の組を、写し (`floatLayout`) から作る。**窓の `rect()` からは作らない**
 * (floatLayout の doc)。ドック枠はまだ無いので `docks` は空
 */
function currentWindowLayout(): WindowLayout {
  return { version: 2, float: { ...floatLayout }, docks: {} };
}

/** 覚える配置を組ごと保存する */
function persistWindowLayout(): void {
  void saveWindowLayout(currentWindowLayout()).catch((error: unknown) => {
    // 覚えられないだけで、今の画面の窓は置いた場所にある。次に開くと前に覚えた配置で出る
    console.warn(`窓の位置を保存できませんでした: ${String(error)}`);
  });
}

/** ユーザーが窓を動かした・大きさを変えた (指を離した時点で 1 回)。次に開いたときも同じ位置に出す */
function rememberWindowRect(id: WindowId, rect: WindowRect): void {
  floatLayout[id] = { ...rect };
  persistWindowLayout();
}

/** 掴む場所のダブルクリック。最初の位置に戻し、覚えた位置も消す (spec A.2) */
function resetWindow(id: "bar" | "list"): void {
  // 先に写しから消す。placeInitial は写しにある窓 (動かした窓) を置き直さない
  delete floatLayout[id];
  placeInitial(id);
  persistWindowLayout();
}
```

`refreshWindows` の中 (1037 行目)

```typescript
  if (panelWasHidden && !sidePanel.element.hidden) placeInitial("panel");
```

を次に置き換える。

```typescript
  if (panelWasHidden && !sidePanel.element.hidden) placeInitial("list");
```

`placeUnmovedWindows` の中 (1745〜1746 行目)

```typescript
  placeInitial("bar");
  placeInitial("panel");
```

を次に置き換える。

```typescript
  placeInitial("bar");
  placeInitial("list");
```

`loadInitialLayout` の `.then` (1946〜1953 行目)

```typescript
    .then((layout) => {
      for (const id of ["bar", "panel"] as const) {
        const rect = layout[id];
        if (rect === undefined) continue;
        movedWindows.add(id);
        windowOf(id).place(rect);
      }
    })
```

を次に置き換える。

```typescript
    .then((layout) => {
      for (const id of ["bar", "list"] as const) {
        const rect = layout.float[id];
        if (rect === undefined) continue;
        // 写しを書き換える 3 箇所の 1 つ (floatLayout の doc)
        floatLayout[id] = rect;
        windowOf(id).place(rect);
      }
    })
```

- [ ] **Step 8: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/window-layout.test.ts` (Bash の timeout 120000)
期待: PASS (「覚えた位置で出る」は、v1 の `LAYOUT_AT_LOAD.panel` が `float.list` に読み替わってパネルの窓に置かれるので、今と同じ値で通る)

- [ ] **Step 9: 残った古い名前が無いことを確かめる**

実行: `git -C /Users/trapple/repos/github.com/trapple/yt-clip grep -n 'movedWindows\|saveWindowRect\|clearWindowRect\|"panel"' -- src tests`
期待: 出るのは `src/content/window-layout.ts` の `V1_KEYS` の `["panel", "list"]` の 1 行だけ (古い形の鍵の読み替え)。
`movedWindows` / `saveWindowRect` / `clearWindowRect` は 1 つも出ない。ほかに出たら、その箇所を Step 7 に合わせて直す

- [ ] **Step 10: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 11: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/window-layout.ts src/content/youtube.ts tests/content/window-layout.test.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 覚える窓の配置を v2 の組にし、float の写しから保存する

窓を 3 つに分け、後でドック枠のタブの並びも覚えるには、窓ごとの
部分更新では整合が取れない。組ごと書く v2 の形にし、古い形のパネル
の位置は区間・テロップの窓が継ぐ (読むときは書き戻さない)。組は窓の
rect() からは作らない: 詰めた後の位置で、動かしていない窓や詰められ
た窓の覚えた位置を書き換えてしまうため、読み込み・動かした・戻した
の 3 箇所だけが書き換える写しを持つ。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: 窓を 3 つに分けて配線する (`youtube.ts`)。`side-panel.ts` を消す

**Files:**
- Modify: `src/content/youtube.ts` (import・窓の生成・`windowOf` などの窓の位置の関数・`refreshWindows`・`revealLastRow`・`onToggleSettings`・`buildBar`・`placeUnmovedWindows`・`mount`・`loadInitialLayout`・テーマの追従・コメント)
- Modify: `src/content/styles.ts` (`SIDE_PANEL_STYLE` を消す、コメント)
- Modify: `src/content/floating-window.ts` (コメントだけ)
- Modify: `src/content/window-layout.ts` (コメントだけ)
- Delete: `src/content/side-panel.ts`
- Delete: `tests/content/side-panel.test.ts`
- Test: `tests/content/youtube.test.ts`
- Test: `tests/content/styles.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `FloatingWindow.bringToFront(): void`
  - Task 3: `createPanelWindow(options: PanelWindowOptions): PanelWindow`、`initialListRect(viewport): WindowRect`、`initialSettingsRect(viewport): WindowRect`
  - Task 4: `WindowId = "bar" | "list" | "settings"`、`floatLayout`、`rememberWindowRect(id: WindowId, rect)`、`persistWindowLayout()`、`loadWindowLayout(): Promise<WindowLayout>`
- Produces (DOM。E2E・screenshots.mjs が探す): `#yt-clip-list` / `#yt-clip-list-body` (区間・テロップの窓)、`#yt-clip-settings` / `#yt-clip-settings-body` (設定の窓)。
  `#yt-clip-panel` / `#yt-clip-panel-body` / `[data-role='collapse']` は無くなる

- [ ] **Step 1: 失敗するテストを書く (youtube のヘルパ)**

`tests/content/youtube.test.ts` を次のとおり直す。**Step 1〜6 の置き換えはすべて Task 4 の後のファイルの文言で探し、最後に Step 7 で
残りの呼び出しの名前をまとめて置き換える** (先に名前を置き換えると、置き換え前の文言が見つからなくなる)。

ヘルパの `/** 右側のパネル。body の直下に 1 つだけある */` から `function panelHeader(): HTMLElement { … }` の閉じ括弧まで
(Task 4 の前の 529〜586 行目。`barElement` / `collapseButton` / `settingsRoot` / `barWindowElement` / `barGrip` を含む) を
丸ごと次に置き換える (`collapseButton` は消え、`barElement` / `settingsRoot` / `barWindowElement` / `barGrip` は同じ中身で残る)。

```typescript
/** 区間・テロップの窓。body の直下に 1 つだけある */
function listElement(): HTMLElement {
  const element = document.getElementById("yt-clip-list");
  if (element === null) throw new Error("区間・テロップの窓が見つかりません");
  return element;
}

/** 区間・テロップの窓の中身の箱。区間の一覧とテロップの一覧が入る */
function listBody(): HTMLElement {
  const element = document.getElementById("yt-clip-list-body");
  if (element === null) throw new Error("区間・テロップの窓の中身が見つかりません");
  return element;
}

/** 設定の窓。body の直下に 1 つだけある */
function settingsWindowElement(): HTMLElement {
  const element = document.getElementById("yt-clip-settings");
  if (element === null) throw new Error("設定の窓が見つかりません");
  return element;
}

/** 設定の窓の中身の箱。設定パネルが入る */
function settingsBody(): HTMLElement {
  const element = document.getElementById("yt-clip-settings-body");
  if (element === null) throw new Error("設定の窓の中身が見つかりません");
  return element;
}

/** プレイヤー直下のバー */
function barElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar");
  if (element === null) throw new Error("バーが見つかりません");
  return element;
}

/** 設定パネルの根。最初の項目 (モード) の入力欄 → 項目の枠 → 根 */
function settingsRoot(): HTMLElement {
  const root = document.getElementById("yt-clip-setting-mode")?.parentElement
    ?.parentElement;
  if (root == null) throw new Error("設定パネルが見つかりません");
  return root;
}

/** バーの窓の枠 (外形)。中身の根 #yt-clip-bar はこの中にある */
function barWindowElement(): HTMLElement {
  const element = document.getElementById("yt-clip-bar-window");
  if (element === null) throw new Error("バーの窓が見つかりません");
  return element;
}

/** バーの窓を動かすつまみ (⠿)。操作の行の左端にある */
function barGrip(): HTMLElement {
  const grip = barElement().querySelector<HTMLElement>("[data-role='grip']");
  if (grip === null) throw new Error("つまみが見つかりません");
  return grip;
}

/** 区間・テロップの窓の見出し (掴んで動かす所) */
function listHeader(): HTMLElement {
  const header = listElement().querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("区間・テロップの窓の見出しが見つかりません");
  return header;
}

/** 設定の窓の見出し (掴んで動かす所) */
function settingsHeader(): HTMLElement {
  const header = settingsWindowElement().querySelector<HTMLElement>("[data-role='window-header']");
  if (header === null) throw new Error("設定の窓の見出しが見つかりません");
  return header;
}

/** 3 つの窓 (バー・区間・テロップ・設定) が隠れているか。この順に並べる */
function windowsHidden(): boolean[] {
  return [barWindowElement(), listElement(), settingsWindowElement()].map((element) => element.hidden);
}
```

- [ ] **Step 2: 読み込み時の窓の記録を 3 つにする**

同じファイルの

```typescript
/** 覚えた位置を読み込む前の窓 (設定を開いてパネルに中身がある状態) */
let windowsBeforeLayout = { barHidden: false, panelHidden: false };
/** 覚えた位置を読み込んだ後の窓 */
let windowsAfterLayout = {
  barHidden: true,
  panelHidden: true,
  bar: { left: "", top: "", width: "", height: "" },
  panel: { left: "", top: "", width: "", height: "" },
};
```

を次に置き換える。

```typescript
/** 覚えた位置を読み込む前の窓 (設定を開いて設定の窓に中身がある状態) */
let windowsBeforeLayout = { barHidden: false, listHidden: false, settingsHidden: false };
/** 覚えた位置を読み込んだ後の窓 */
let windowsAfterLayout = {
  barHidden: true,
  listHidden: false,
  settingsHidden: true,
  bar: { left: "", top: "", width: "", height: "" },
  list: { left: "", top: "", width: "", height: "" },
  settings: { left: "", top: "", width: "", height: "" },
};
```

`beforeAll` の中の

```typescript
  // 覚えた窓の位置の読み込みは layoutGate で止めてある。設定を開いてパネルに中身が
  // ある状態にしても、読み込みが済むまではどちらの窓も出ない (最初の位置から跳ぶ絵にしない)
  clickButton("⚙");
  windowsBeforeLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
  };
  releaseLayout();
  await flush();
  windowsAfterLayout = {
    barHidden: barWindowElement().hidden,
    panelHidden: panelElement().hidden,
    bar: styleRect(barWindowElement()),
    panel: styleRect(panelElement()),
  };
```

を次に置き換える。

```typescript
  // 覚えた窓の位置の読み込みは layoutGate で止めてある。設定を開いて設定の窓に中身が
  // ある状態にしても、読み込みが済むまではどの窓も出ない (最初の位置から跳ぶ絵にしない)
  clickButton("⚙");
  windowsBeforeLayout = {
    barHidden: barWindowElement().hidden,
    listHidden: listElement().hidden,
    settingsHidden: settingsWindowElement().hidden,
  };
  releaseLayout();
  await flush();
  windowsAfterLayout = {
    barHidden: barWindowElement().hidden,
    listHidden: listElement().hidden,
    settingsHidden: settingsWindowElement().hidden,
    bar: styleRect(barWindowElement()),
    list: styleRect(listElement()),
    settings: styleRect(settingsWindowElement()),
  };
```

全体の `beforeEach` の中の

```typescript
  // パネルはタブを開いている間 1 つを使い回す (畳んだ状態を覚えるため)。
  // 前のテストで畳んだまま・送ったままにしない
  const collapse = document.querySelector<HTMLButtonElement>(
    "#yt-clip-panel [data-role='collapse']",
  );
  if (collapse?.getAttribute("aria-expanded") === "false") collapse.click();
  const panelBodyElement = document.getElementById("yt-clip-panel-body");
  if (panelBodyElement !== null) panelBodyElement.scrollTop = 0;
```

を次に置き換える。

```typescript
  // 区間・テロップの窓と設定の窓はタブを開いている間 1 つずつを使い回す (位置を持つため)。
  // 前のテストで送ったままにしない
  for (const id of ["yt-clip-list-body", "yt-clip-settings-body"]) {
    const body = document.getElementById(id);
    if (body !== null) body.scrollTop = 0;
  }
```

- [ ] **Step 3: 「右側のパネル」の describe を 2 つの窓の describe に書き直す**

`describe("右側のパネル", () => { … });` (Task 4 の前の 2638〜2893 行目) を丸ごと次に置き換える。

```typescript
describe("区間・テロップの窓と設定の窓", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  async function showEdit(telops: Telop[] = []): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops, meta: META_A });
    await flush();
  }

  test("body を作り直しても、2 つの窓を body の直下に付け直す", async () => {
    // buildPage は body を空にする。付け直さないと、以降は窓が DOM に無く
    // 一覧も設定も操作できない
    buildPage();
    document.body.append(document.createElement("div"));
    await flush();

    expect(listElement().parentElement).toBe(document.body);
    expect(settingsWindowElement().parentElement).toBe(document.body);
    expect(document.querySelectorAll("#yt-clip-list").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-settings").length).toBe(1);
  });

  test("一覧は区間・テロップの窓、設定は設定の窓に入り、バーには拡大バー・テロップの帯の段・操作の行だけが残る", async () => {
    await showEdit([TELOP]);

    const body = listBody();
    // 区間の一覧 → テロップの一覧の順。設定は入らない (別の窓)
    expect(body.children.length).toBe(2);
    expect(body.children[0]?.querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(body.children[1]?.querySelector("[data-role='add-telop']")).not.toBeNull();
    expect(body.children[1]?.querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(body.contains(settingsRoot())).toBe(false);
    expect([...settingsBody().children]).toEqual([settingsRoot()]);

    const bar = barElement();
    expect(bar.querySelector("[data-role='segment']")).toBeNull();
    expect(bar.querySelector("[data-role='add-telop']")).toBeNull();
    expect(bar.querySelector("#yt-clip-setting-mode")).toBeNull();
    // 並び: 拡大バー → テロップの帯の段 (フロートの窓の spec B.3) → 操作の行
    expect(bar.children.length).toBe(3);
    expect(bar.firstElementChild?.id).toBe("yt-clip-range");
    expect(bar.children[1]?.getAttribute("data-role")).toBe("telop-track");
    expect(
      bar.lastElementChild?.contains(document.getElementById("yt-clip-bar-status")),
    ).toBe(true);
  });

  test("見出しは中身の名前 (区間・テロップ / 設定)。折り畳みのボタンは無い", () => {
    expect(listHeader().textContent).toBe("区間・テロップ");
    expect(settingsHeader().textContent).toBe("設定");
    expect(document.querySelector("[data-role='collapse']")).toBeNull();
  });

  test("エディットで区間があると区間・テロップの窓を出す。設定を閉じていれば設定の窓は出さない", async () => {
    await showEdit();
    expect(listElement().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(true);
  });

  test("エディットでも区間が 0 個なら区間・テロップの窓を出さない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    expect(listElement().hidden).toBe(true);
  });

  test("⚙ で設定の窓が出て、もう一度押すと隠れる (シンプル)", async () => {
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(settingsWindowElement().hidden).toBe(true);

    clickButton("⚙");
    expect(settingsWindowElement().hidden).toBe(false);
    expect(settingsRoot().hidden).toBe(false);
    expect(settingsBody().contains(settingsRoot())).toBe(true);
    // シンプルでは一覧が空なので、区間・テロップの窓は出ないまま
    expect(listElement().hidden).toBe(true);

    clickButton("⚙");
    expect(settingsRoot().hidden).toBe(true);
    expect(settingsWindowElement().hidden).toBe(true);
  });

  test("⚙ で設定を開閉しても、区間・テロップの窓はそのまま", async () => {
    await showEdit([TELOP]);
    const before = styleRect(listElement());

    clickButton("⚙");
    expect(settingsWindowElement().hidden).toBe(false);
    expect(listElement().hidden).toBe(false);
    expect(styleRect(listElement())).toEqual(before);

    clickButton("⚙");
    expect(settingsWindowElement().hidden).toBe(true);
    expect(listElement().hidden).toBe(false);
    expect(styleRect(listElement())).toEqual(before);
    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(1);
  });

  test("⚙ で開くと設定の窓を前に出す (一覧の窓に重なって出ても潜らない)", async () => {
    await showEdit();
    // 一覧の窓を触って、いちばん上にしておく
    pointer(listBody(), "pointerdown", 0, 0);

    clickButton("⚙");

    expect(Number(settingsWindowElement().style.zIndex)).toBeGreaterThan(
      Number(listElement().style.zIndex),
    );
  });

  test("⚙ で開いても、区間・テロップの窓の中は送らない (設定は別の窓に出る)", async () => {
    await showEdit([TELOP]);
    listBody().scrollTop = 40;

    clickButton("⚙");

    expect(listBody().scrollTop).toBe(40);
  });

  test("モードを変えてバーを作り直しても、一覧と設定が 2 重にならない", async () => {
    changeSettings({ mode: "edit" });
    await flush();
    changeSettings({ mode: "simple" });
    await flush();
    changeSettings({ mode: "edit" });
    await flush();

    expect(document.querySelectorAll("#yt-clip-list").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-settings").length).toBe(1);
    expect(listBody().children.length).toBe(2);
    expect(settingsBody().children.length).toBe(1);
    expect(document.querySelectorAll("[data-role='add-telop']").length).toBe(1);
    expect(document.querySelectorAll("#yt-clip-setting-mode").length).toBe(1);

    // 入っているのは今の一覧。状態が届けば行が出る
    emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
    await flush();
    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(1);
  });

  test("設定を開いた状態でモードを変えても、設定の窓は開いたまま", async () => {
    // シンプルで ⚙ を開く
    clickButton("⚙");
    expect(settingsRoot().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);

    changeSettings({ mode: "edit" });
    await flush();

    // バーを作り直すと設定パネルも新しいものに替わるが、開いていたなら
    // 開き直しておく (モードを変えた瞬間に設定が消えるのは驚きが大きい)
    expect(settingsRoot().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);

    changeSettings({ mode: "simple" });
    await flush();

    expect(settingsRoot().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);
  });

  test("バーを作り直しても、手元の区間で一覧を描き直す", async () => {
    await showEdit([TELOP]);

    // YouTube の再描画でバーが外れた場面。次の状態通知を待たずに一覧を戻す
    barElement().remove();
    document.body.append(document.createElement("div"));
    await flush();

    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(listBody().querySelectorAll("[data-role='telop']").length).toBe(1);
    expect(listElement().hidden).toBe(false);
  });

  test("全画面の間は区間・テロップの窓と設定の窓を隠し、抜けたら戻す", async () => {
    await showEdit();
    clickButton("⚙");
    expect(listElement().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(listElement().hidden).toBe(true);
      expect(settingsWindowElement().hidden).toBe(true);

      // 全画面の間に状態が届いても出さない
      emit({ kind: "ready", segments: [RANGE], telops: [], meta: META_A });
      expect(listElement().hidden).toBe(true);
      expect(settingsWindowElement().hidden).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(listElement().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);
  });

  test("別の動画へ移ると一覧を空にして区間・テロップの窓を隠す。戻れば出す", async () => {
    await showEdit([TELOP]);
    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(1);

    // 動画 B の画面に A の区間が出続けると目立つ
    history.pushState({}, "", "/watch?v=video-b");
    document.body.append(document.createElement("div"));
    await flush();

    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(0);
    expect(listBody().querySelectorAll("[data-role='telop']").length).toBe(0);
    expect(listElement().hidden).toBe(true);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();

    expect(listBody().querySelectorAll("[data-role='segment']").length).toBe(1);
    expect(listElement().hidden).toBe(false);
  });

  test("動画ページ以外では区間・テロップの窓も設定の窓も出さない", async () => {
    await showEdit();
    clickButton("⚙");
    expect(listElement().hidden).toBe(false);
    expect(settingsWindowElement().hidden).toBe(false);

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();

    expect(listElement().hidden).toBe(true);
    expect(settingsWindowElement().hidden).toBe(true);
  });

  test("テーマを切り替えると 2 つの窓の配色も変わる", async () => {
    // 窓は body の直下でバーの外にある。バーの配色は継がれない
    document.documentElement.setAttribute("dark", "");
    try {
      await flush();
      expect(listElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
      expect(settingsWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#212121");
    } finally {
      document.documentElement.removeAttribute("dark");
    }
    await flush();
    expect(listElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
    expect(settingsWindowElement().style.getPropertyValue("--ytc-panel")).toBe("#ffffff");
  });
});
```

- [ ] **Step 4: 「足した行をパネルの見える範囲に入れる」の describe を書き直す**

`describe("足した行をパネルの見える範囲に入れる", () => { … });` (Task 4 の前の 2895〜2998 行目) を丸ごと次に置き換える
(折り畳みが無くなったので「畳んでいても開く」を外し、区間・テロップの窓の中を送ることと、窓を前に出さないことを確かめる)。

```typescript
describe("足した行を区間・テロップの窓の見える範囲に入れる", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  /**
   * 本体は画面の 100〜500px。行は並び順に 900px から 100px ずつ下に置く。
   * 末尾の行が選ばれたかを送り先の値で見分けられる
   */
  function placeRows(role: "segment" | "telop") {
    const body = listBody();
    return vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this === body) return rectAt(100, 400);
        if (this instanceof HTMLElement && this.dataset.role === role) {
          const index =
            this.parentElement === null
              ? 0
              : [...this.parentElement.children].indexOf(this);
          return rectAt(900 + index * 100, 60);
        }
        return rectAt(0, 0);
      });
  }

  function addTelopButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-role='add-telop']");
    if (button === null) throw new Error("＋ テロップがありません");
    return button;
  }

  test("区間を足したら、区間・テロップの窓の中を末尾の行へ送る", async () => {
    const first: ClipRange = { startSec: 83, endSec: 98 };
    const added: ClipRange = { startSec: 300, endSec: 315 };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [first], telops: [], meta: META_A });
    await flush();
    const spy = placeRows("segment");
    try {
      video.element.currentTime = 300;
      clickButton("＋ 区間を追加");
      await flush();
      // 押した時点では行がまだ無い。送るのは状態機械の答えを描いた後
      expect(listBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });

      // 末尾 (2 行目: 1000px) の先頭を本体の上端 (100px) に揃える
      expect(listBody().scrollTop).toBe(900);

      // 送るのは足した直後の 1 回だけ。見ている位置を勝手に戻さない
      listBody().scrollTop = 0;
      emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });
      expect(listBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("テロップを足したら、区間・テロップの窓の中を末尾の行へ送る", async () => {
    const added: Telop = { startSec: 15, endSec: 18, text: "" };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [RANGE], telops: [TELOP], meta: META_A });
    await flush();
    const spy = placeRows("telop");
    try {
      video.element.currentTime = 15;
      await flush();
      addTelopButton().click();
      await flush();
      expect(listBody().scrollTop).toBe(0);

      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });

      expect(listBody().scrollTop).toBe(900);

      listBody().scrollTop = 0;
      emit({ kind: "ready", segments: [RANGE], telops: [TELOP, added], meta: META_A });
      expect(listBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("足した行へ送っても、区間・テロップの窓を前に出さない (前に出した設定の窓が潜らない)", async () => {
    const first: ClipRange = { startSec: 83, endSec: 98 };
    const added: ClipRange = { startSec: 300, endSec: 315 };
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments: [first], telops: [], meta: META_A });
    await flush();
    // 設定を見ながら区間を足す場面。⚙ で開いた設定の窓は前に出ている
    clickButton("⚙");

    video.element.currentTime = 300;
    clickButton("＋ 区間を追加");
    await flush();
    emit({ kind: "ready", segments: [first, added], telops: [], meta: META_A });

    expect(Number(settingsWindowElement().style.zIndex)).toBeGreaterThan(
      Number(listElement().style.zIndex),
    );
  });

  test("足していない状態の通知では送らない", async () => {
    changeSettings({ mode: "edit" });
    const spy = placeRows("segment");
    try {
      emit({
        kind: "ready",
        segments: [RANGE, { startSec: 30, endSec: 40 }],
        telops: [],
        meta: META_A,
      });
      await flush();
      expect(listBody().scrollTop).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 5: 「フロートの窓」の describe を 3 つの窓に合わせる**

`describe("フロートの窓")` の `beforeEach` の

```typescript
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
    layoutWrites = [];
```

を次に置き換える。

```typescript
    dblclick(barGrip());
    dblclick(panelHeader());
    dblclick(settingsHeader());
    await flush();
    layoutWrites = [];
```

同じ describe のテスト「バーの窓とパネルの窓が body の直下に 1 つずつある」を丸ごと次に置き換える。

```typescript
  test("3 つの窓 (バー・区間・テロップ・設定) が body の直下に 1 つずつある", () => {
    for (const id of ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"]) {
      expect(document.querySelectorAll(`#${id}`).length).toBe(1);
      expect(document.getElementById(id)?.parentElement).toBe(document.body);
    }
    // バーの中身 (拡大バーと操作の行) は窓の中
    expect(barWindowElement().contains(barElement())).toBe(true);
  });
```

テスト「覚えた位置を読み込むまで、設定を開いていても窓を出さない」の期待

```typescript
    expect(windowsBeforeLayout).toEqual({ barHidden: true, panelHidden: true });
```

を次に置き換える。

```typescript
    expect(windowsBeforeLayout).toEqual({ barHidden: true, listHidden: true, settingsHidden: true });
```

テスト「覚えた位置で出る」を丸ごと次に置き換える。

```typescript
  test("覚えた位置で出る。古い形 (v1) のパネルの位置は区間・テロップの窓が継ぎ、設定の窓は最初の位置", () => {
    expect(windowsAfterLayout).toEqual({
      barHidden: false,
      // シンプルモードで一覧が空なので、区間・テロップの窓は隠れている (位置は当たっている)
      listHidden: true,
      settingsHidden: false,
      bar: { left: "40px", top: "500px", width: "700px", height: "" },
      list: { left: "300px", top: "120px", width: "360px", height: "400px" },
      // v1 に設定の窓は無い。区間・テロップの窓の最初の位置 (右 16px・上 68px) から下へ 32px
      settings: { left: `${window.innerWidth - 416}px`, top: "100px", width: "400px", height: "" },
    });
  });
```

テスト「パネルの窓の最初の位置は右上 (右端から 16px・上 68px・幅 400px)」を丸ごと次に置き換える。

```typescript
  test("区間・テロップの窓の最初の位置は右上 (右端から 16px・上 68px・幅 400px)", () => {
    expect(styleRect(listElement())).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "68px",
      width: "400px",
      height: "",
    });
  });

  test("設定の窓の最初の位置は、区間・テロップの窓から下へ 32px だけずらす (left は同じ)", () => {
    const list = styleRect(listElement());
    const settings = styleRect(settingsWindowElement());
    expect(settings.left).toBe(list.left);
    expect(parseFloat(settings.top)).toBe(parseFloat(list.top) + 32);
    expect(settings.width).toBe("400px");
    expect(settings.height).toBe("");
  });

  test("区間・テロップの窓を動かしても、設定の窓の最初の位置は付いていかない", async () => {
    await showList();
    drag(listHeader(), -100, 20);

    dblclick(settingsHeader());

    expect(styleRect(settingsWindowElement())).toEqual({
      left: `${window.innerWidth - 416}px`,
      top: "100px",
      width: "400px",
      height: "",
    });
  });
```

テスト「パネルの窓は見出しをドラッグすると動き、位置を覚える」を丸ごと次に置き換える (区間・テロップの窓は
⚙ では出ないので、エディットで区間を出してから動かす。`showList` は同じ describe の中の関数宣言なので、先に呼べる)。

```typescript
  test("区間・テロップの窓は見出しをドラッグすると動き、位置を覚える", async () => {
    await showList();
    const frame = listElement();
    const left = parseFloat(frame.style.left);

    drag(listHeader(), -100, 20);
    await flush();

    expect(frame.style.left).toBe(`${left - 100}px`);
    expect(frame.style.top).toBe("88px");
    // 動かしていないバーと設定の窓は書かない
    expect(layoutWrites).toEqual([
      { version: 2, float: { list: { left: left - 100, top: 88, width: 400 } }, docks: {} },
    ]);
  });

  test("設定の窓は見出しをドラッグすると動き、位置を覚える", async () => {
    clickButton("⚙");
    const frame = settingsWindowElement();
    const left = parseFloat(frame.style.left);

    drag(settingsHeader(), -100, 20);
    await flush();

    expect(frame.style.left).toBe(`${left - 100}px`);
    expect(frame.style.top).toBe("120px");
    expect(layoutWrites).toEqual([
      { version: 2, float: { settings: { left: left - 100, top: 120, width: 400 } }, docks: {} },
    ]);
  });
```

テスト「最後に触った窓が上に来る」を丸ごと次に置き換える。

```typescript
  test("触った順が新しいほど上に来る (3 つの窓)", async () => {
    await showList();
    clickButton("⚙");
    const zIndexes = () =>
      [barWindowElement(), listElement(), settingsWindowElement()].map((element) =>
        Number(element.style.zIndex),
      );

    pointer(barElement(), "pointerdown", 0, 0);
    pointer(listBody(), "pointerdown", 0, 0);
    pointer(settingsBody(), "pointerdown", 0, 0);
    expect(zIndexes()).toEqual([2000, 2001, 2002]);

    // バーを触り直すとバーがいちばん上。直前に触った設定の窓は一覧の窓の上のまま
    pointer(barElement(), "pointerdown", 0, 0);
    expect(zIndexes()).toEqual([2002, 2000, 2001]);
  });
```

テスト「全画面の間は 2 つとも隠し、抜けたら戻す」を丸ごと次に置き換える。

```typescript
  test("全画面の間は 3 つとも隠し、抜けたら戻す", async () => {
    await showList();
    clickButton("⚙");
    expect(windowsHidden()).toEqual([false, false, false]);

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video.element,
    });
    try {
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(windowsHidden()).toEqual([true, true, true]);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }

    document.dispatchEvent(new Event("fullscreenchange"));
    expect(windowsHidden()).toEqual([false, false, false]);
  });
```

テスト「動画ページ以外では 2 つとも隠す。戻れば出す」を丸ごと次に置き換える。

```typescript
  test("動画ページ以外では 3 つとも隠す。戻れば出す", async () => {
    await showList();
    clickButton("⚙");

    history.pushState({}, "", "/");
    document.body.append(document.createElement("div"));
    await flush();
    expect(windowsHidden()).toEqual([true, true, true]);

    history.pushState({}, "", "/watch?v=video-a");
    document.body.append(document.createElement("div"));
    await flush();
    expect(windowsHidden()).toEqual([false, false, false]);
  });
```

- [ ] **Step 6: 「動かしていない窓の最初の位置を取り直す」の describe を 3 つの窓に合わせる**

この describe の `beforeEach` の

```typescript
    dblclick(barGrip());
    dblclick(panelHeader());
    await flush();
  });
```

を次に置き換える。

```typescript
    dblclick(barGrip());
    dblclick(panelHeader());
    dblclick(settingsHeader());
    await flush();
  });
```

テスト「パネルの窓も画面の幅に合わせて取り直す」を丸ごと次に置き換える。

```typescript
  test("区間・テロップの窓と設定の窓も画面の幅に合わせて取り直す", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    try {
      window.dispatchEvent(new Event("resize"));
      // 1440 - 16 - 400。設定の窓は left が同じで、下へ 32px
      expect(listElement().style.left).toBe("1024px");
      expect(settingsWindowElement().style.left).toBe("1024px");
      expect(settingsWindowElement().style.top).toBe("100px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: 1024,
      });
      window.dispatchEvent(new Event("resize"));
    }
    expect(listElement().style.left).toBe("608px");
    expect(settingsWindowElement().style.left).toBe("608px");
  });
```

- [ ] **Step 7: 残りの呼び出しの名前をまとめて置き換える**

実行:

```bash
sed -i '' -e 's/panelElement()/listElement()/g' -e 's/panelBody()/listBody()/g' -e 's/panelHeader()/listHeader()/g' /Users/trapple/repos/github.com/trapple/yt-clip/tests/content/youtube.test.ts
```

(Task 4 で足した「画面に詰められた窓の…」「ダブルクリックで戻した窓は…」と、「フロートの窓」の残りのテストの
`panelHeader()` / `panelElement()` がここで置き換わる。どちらのテストも区間・テロップの窓 (エディットで区間を出した状態) で
そのまま意味が通る)

`afterAll` の中のコメント

```typescript
  // 空にした body を mount() が拾って 2 つの窓 (バーとパネル) を付け直す。jsdom は破棄の
```

を次に置き換える (コードは変えない)。

```typescript
  // 空にした body を mount() が拾って 3 つの窓 (バー・区間・テロップ・設定) を付け直す。jsdom は破棄の
```

確認: `grep -n 'panelElement\|panelBody\|panelHeader\|collapseButton\|yt-clip-panel\|panelHidden\|2 つの窓' /Users/trapple/repos/github.com/trapple/yt-clip/tests/content/youtube.test.ts`
期待: 何も出ない

- [ ] **Step 8: styles のテストから右側のパネルの検査を消す**

`tests/content/styles.test.ts` の import から `SIDE_PANEL_STYLE,` の行を消し、`describe("右側のパネル", () => { … });`
(118〜132 行目。「本体の中だけでスクロールする」「本体は display を持たない…」「枠の見た目 (地・見出し) は持たない…」の 3 つ) を
丸ごと消す (同じ観点は Task 3 の `describe("見出しのある窓の中身の箱")` が持つ)。

- [ ] **Step 9: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts` (Bash の timeout 120000)
期待: FAIL (`区間・テロップの窓が見つかりません` / `設定の窓が見つかりません` など。`youtube.ts` はまだ `#yt-clip-panel` を作っている)

- [ ] **Step 10: 最小実装 (youtube.ts の窓の生成)**

`src/content/youtube.ts` の import

```typescript
import { createSidePanel, initialPanelRect } from "@/content/side-panel";
```

を次に置き換える。

```typescript
import {
  createPanelWindow,
  initialListRect,
  initialSettingsRect,
} from "@/content/panel-window";
```

定数の

```typescript
/** バーの窓の最小の幅 (spec A.1)。これより狭いと拡大バーの精度が出ず、操作の行も折り返す */
const BAR_MIN_WIDTH_PX = 480;
```

の**直後**に次を足す。

```typescript
/**
 * 区間・テロップの窓と設定の窓の枠 (窓の分割の spec C1.1)。中身の箱は `${id}-body`
 * (panel-window.ts)。E2E と screenshots.mjs もこの id で探す
 */
const LIST_WINDOW_ID = "yt-clip-list";
const SETTINGS_WINDOW_ID = "yt-clip-settings";
```

パネルの窓を作るところ (Task 4 の後の文言)

```typescript
/**
 * 右側のパネル (パネルの窓)。区間の一覧・テロップの一覧・設定を入れる。
 *
 * **1 つを使い回す。** 畳んだ状態はタブを開いている間だけ覚える (右側パネルの spec §3) うえ、
 * 窓の位置も持つので、バーを作り直すたびに作り直さない。中身の入れ替えは `buildBar`、body への
 * 付け直しは `mount`、出すかの判定は `refreshWindows` が行う
 */
// パネルの位置は、窓を分けた後に区間・テロップの窓が継ぐ鍵 (list) で覚える
const sidePanel = createSidePanel({
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
});
// パネルは body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
applyPalette(sidePanel.element, isDarkTheme());
```

を次に置き換える。

```typescript
/**
 * 区間・テロップの窓。区間の一覧とテロップの一覧を入れる (窓の分割の spec C1.1)。
 *
 * **1 つを使い回す。** 窓の位置を持つので、バーを作り直すたびに作り直さない。中身の入れ替えは
 * `buildBar`、body への付け直しは `mount`、出すかの判定は `refreshWindows` が行う
 */
const listWindow = createPanelWindow({
  id: LIST_WINDOW_ID,
  title: "区間・テロップ",
  onUserMove: (rect) => rememberWindowRect("list", rect),
  onResetRequest: () => resetWindow("list"),
});
// 窓は body の直下でバーの外にある。バーの配色は継がれないので自分で持つ
applyPalette(listWindow.element, isDarkTheme());
/**
 * 設定の窓。設定パネル (`settings-panel.ts`) を入れ、⚙ で開閉する (C1.2)。**閉じるボタン (×) は
 * 置かない** (右側パネルの spec で不採用にしたのと同じ。閉じ方を ⚙ の 1 つにする)。使い回すのは
 * 区間・テロップの窓と同じ理由
 */
const settingsWindow = createPanelWindow({
  id: SETTINGS_WINDOW_ID,
  title: "設定",
  onUserMove: (rect) => rememberWindowRect("settings", rect),
  onResetRequest: () => resetWindow("settings"),
});
applyPalette(settingsWindow.element, isDarkTheme());
```

`settingsPanel` の doc

```typescript
/** 設定パネル。⚙ の開閉と、パネルを出すかの判定の両方が読む。`buildBar` が作る */
```

を次に置き換える。

```typescript
/** 設定パネル。⚙ の開閉と、設定の窓を出すかの判定の両方が読む。`buildBar` が作る */
```

- [ ] **Step 11: 最小実装 (youtube.ts の窓の位置の関数)**

Task 4 で書いた `windowOf` / `initialWindowRect` / `placeInitial` / `resetWindow` を、次のとおり 3 つの窓に広げる。

```typescript
/** 窓の枠。id で引く (覚えた配置の鍵と同じ名前) */
function windowOf(id: "bar" | "list"): FloatingWindow {
  return id === "bar" ? barWindow : sidePanel.frame;
}
```

→

```typescript
/** 窓の枠。id で引く (覚えた配置の鍵と同じ名前) */
function windowOf(id: WindowId): FloatingWindow {
  if (id === "bar") return barWindow;
  return id === "list" ? listWindow.frame : settingsWindow.frame;
}
```

`initialWindowRect` の doc の 1 行目と先頭の 3 行

```typescript
 * 窓の最初の位置 (spec A.2)。バーはプレイヤーの直下、パネルは画面の右上。
```

```typescript
function initialWindowRect(id: "bar" | "list"): WindowRect | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (id === "list") return initialPanelRect(viewport);
```

を次に置き換える。

```typescript
 * 窓の最初の位置 (spec A.2 / C1.3)。バーはプレイヤーの直下、区間・テロップの窓は画面の右上、
 * 設定の窓は区間・テロップの窓の最初の位置から下へ 32px。
```

```typescript
function initialWindowRect(id: WindowId): WindowRect | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (id === "list") return initialListRect(viewport);
  // 区間・テロップの窓の**最初の位置**から下へずらす。一覧を動かしていても、その位置には付いていかない
  if (id === "settings") return initialSettingsRect(viewport);
```

`placeInitial` と `resetWindow` の引数の型 `id: "bar" | "list"` を、どちらも `id: WindowId` に置き換える (本体は変えない)。

- [ ] **Step 12: 最小実装 (youtube.ts の出し入れ・送る・⚙)**

`refreshWindows` を doc コメントごと次に置き換える。

```typescript
/**
 * 3 つの窓 (バーの窓・区間・テロップの窓・設定の窓) を出すか隠すかを決める。**`setVisible` を
 * 呼ぶのはここだけ** (右側パネルの spec §4 を 3 つの窓へ広げた。窓の分割の spec C1.2)。
 *
 * どれも隠すのは、覚えた位置を読み込む前 / 全画面 / 動画ページ以外。そのうえで、バーは中身の根
 * (BAR_ID) がある間、区間・テロップの窓は一覧のどちらかが見えている間 (一覧は中身が無いと自分で
 * 隠れる)、設定の窓は ⚙ で開いている間 (設定パネルの `hidden` が偽) だけ出す
 */
function refreshWindows(): void {
  const listShown = [segmentList?.element, telopList?.element].some(
    (part) => part !== undefined && !part.hidden,
  );
  const settingsOpen = settingsPanel?.element.hidden === false;
  // **`!= null` にする。** jsdom は fullscreenElement を持たず undefined を返すので、
  // `!== null` だとテストで常に全画面扱いになる。body 直下の fixed 要素は全画面の
  // 動画の上に残りうるので、全画面では出さない
  const fullscreen = document.fullscreenElement != null;
  const onVideoPage = currentVideoId() !== null;
  // 覚えた位置を読む前に出すと、最初の位置に出てから覚えた位置へ跳ぶ絵になる (spec A.2)
  const canShow = layoutReady && !fullscreen && onVideoPage;

  const barWasHidden = barWindow.element.hidden;
  const listWasHidden = listWindow.element.hidden;
  const settingsWasHidden = settingsWindow.element.hidden;
  barWindow.setVisible(canShow && document.getElementById(BAR_ID) !== null);
  listWindow.setVisible(canShow && listShown);
  settingsWindow.setVisible(canShow && settingsOpen);
  // 隠れていた窓は寸法が 0 で、最初の位置 (バーの高さで画面の下端に詰める) を測れていない。
  // **出した直後にだけ**取り直す。出ている間に状態が届くたびに取り直すと、ページを
  // スクロールした後に IN を押しただけで、バーがプレイヤーを追って跳ぶ (spec A.2)
  if (barWasHidden && !barWindow.element.hidden) placeInitial("bar");
  if (listWasHidden && !listWindow.element.hidden) placeInitial("list");
  if (settingsWasHidden && !settingsWindow.element.hidden) placeInitial("settings");
}
```

`revealLastRow` を doc コメントごと次に置き換える。

```typescript
/**
 * 足した行を区間・テロップの窓の見える範囲に入れる。**応答を描いた後に呼ぶ** (クリックの時点では
 * 行がまだ無い)。押した結果が見えないと無反応に見える (右側パネルの spec §3)。
 *
 * **窓を前には出さない** (C1.2 は窓の中を送ることだけを求める)。前に出すと、設定の窓で値を
 * 見ながら区間を足したときに設定が潜る。窓が隠れている (全画面など) ときは何もしない。
 * 出す判断は `refreshWindows` のもの
 */
function revealLastRow(
  list: HTMLElement | undefined,
  role: "segment" | "telop",
): void {
  if (list === undefined || listWindow.element.hidden) return;
  const rows = list.querySelectorAll<HTMLElement>(`[data-role='${role}']`);
  const last = rows[rows.length - 1];
  if (last === undefined) return;
  listWindow.scrollTo(last);
}
```

`onToggleSettings` を doc コメントごと次に置き換える。

```typescript
/**
 * ⚙。設定の窓を開閉する (窓の分割の spec C1.2)。**開いたら設定の窓を前に出す。** 最初の位置では
 * 区間・テロップの窓に下へ 32px ずれて重なるので、前に出さないと一覧の窓の下に潜り、押しても
 * 開いていないように見える。
 *
 * **開く → 出す → 前に出す の順を崩さない。** 窓を出すかは設定パネルの `hidden` を見て
 * refreshWindows が決める。窓の中は送らない (中身は設定だけで、送る先が無い)
 */
function onToggleSettings(): void {
  // ⚙ は buildBar の中で設定パネルを作った後に作るので、押せた時点で null は
  // ありえない。null なら配線のバグなので、黙って何もしない形で隠さない
  if (settingsPanel === null) {
    throw new Error("設定パネルを作る前に ⚙ が押されました");
  }
  settingsPanel.toggle();
  refreshWindows();
  if (settingsPanel.element.hidden) return;
  settingsWindow.frame.bringToFront();
}
```

`buildBar` の末尾の

```typescript
  // 一覧と設定は右側のパネルへ。**中身ごと入れ替える。** 足すだけにすると、
  // バーを作り直すたびに古い一覧が残って 2 重になる
  sidePanel.body.replaceChildren(
    segmentList.element,
    telopList.element,
    settings.element,
  );
```

を次に置き換える。

```typescript
  // 一覧は区間・テロップの窓へ、設定は設定の窓へ (窓の分割の spec C1.4)。**中身ごと入れ替える。**
  // 足すだけにすると、バーを作り直すたびに古い一覧や設定が残って 2 重になる
  listWindow.body.replaceChildren(segmentList.element, telopList.element);
  settingsWindow.body.replaceChildren(settings.element);
```

同じ `buildBar` の少し上のコメント

```typescript
  // バーは拡大バー → テロップの帯の段 → 操作の行だけ。拡大バーは幅がそのまま精度になるので、
  // パネルの幅には縮めず、幅を変えられるバーの窓に入れる (右側パネルの spec §1、フロートの窓の
```

の 2 行目の「パネルの幅には縮めず」を「一覧の窓の幅には縮めず」に置き換える (行の残りは変えない)。

`placeUnmovedWindows` の本体

```typescript
  placeInitial("bar");
  placeInitial("list");
```

を次に置き換える。

```typescript
  placeInitial("bar");
  placeInitial("list");
  placeInitial("settings");
```

`mount` の先頭の

```typescript
  // 2 つの窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられると窓だけが外れる
  for (const frame of [barWindow.element, sidePanel.element]) {
```

を次に置き換える。

```typescript
  // 3 つの窓は body の直下に置く (#below の中だと YouTube の再描画で外れる)。
  // **バーの有無より先に見る。** body の子を差し替えられると窓だけが外れる
  for (const frame of [barWindow.element, listWindow.element, settingsWindow.element]) {
```

`loadInitialLayout` の `.then` の

```typescript
      for (const id of ["bar", "list"] as const) {
```

を次に置き換える。

```typescript
      for (const id of ["bar", "list", "settings"] as const) {
```

テーマの追従 (`themeObserver`) の

```typescript
  // 2 つの窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(sidePanel.element, dark);
```

を次に置き換える。

```typescript
  // 3 つの窓は body の直下にある。ページの配色は継がれない
  applyPalette(barWindow.element, dark);
  applyPalette(listWindow.element, dark);
  applyPalette(settingsWindow.element, dark);
```

- [ ] **Step 13: youtube.ts のコメントの「パネル」を直す**

`src/content/youtube.ts` の次のコメントを置き換える (コードは変えない)。

| 今の文言 | 置き換え後 |
|---|---|
| ` * 次に状態が届いたとき、テロップの一覧の末尾の行をパネルの見える範囲に入れる。` | ` * 次に状態が届いたとき、テロップの一覧の末尾の行を区間・テロップの窓の見える範囲に入れる。` |
| `  // 設定 (シンプルならパネルごと) が消える。1 つのパネルを使い回す設計に` | `  // 設定 (設定の窓ごと) が消える。1 つの設定の窓を使い回す設計に` |
| `  // 開いていたなら、⚙ と同じ経路 (開く → refreshWindows → reveal → scrollTo)` | `  // 開いていたなら、⚙ と同じ経路 (開く → refreshWindows → 前に出す)` |
| `  // **新しい隠れたパネルがあるときだけ開く。** onToggleSettings は toggle なので、` | `  // **新しい隠れた設定パネルがあるときだけ開く。** onToggleSettings は toggle なので、` |
| `  // 古いパネルを逆に閉じてしまう` | `  // 古い設定パネルを逆に閉じてしまう` |
| `  // 足した行をパネルの見える範囲に入れる。畳んでいても開く (spec §3)` | `  // 足した行を区間・テロップの窓の見える範囲に入れる (右側パネルの spec §3)` |
| ` * (帯・プレビューと同じ規則)。固定のパネルに出すので、SPA で動画 B へ移ったのに` | ` * (帯・プレビューと同じ規則)。画面に浮いた窓に出すので、SPA で動画 B へ移ったのに` |
| ` * 一覧と帯の段を手元の写しに合わせて描き直し、パネルを出すかを決め直す。` | ` * 一覧と帯の段を手元の写しに合わせて描き直し、窓を出すかを決め直す。` |
| `  // 一覧とパネルの表示が決まってから送る (出す → 開く → 送る の順)` | `  // 一覧と窓の表示が決まってから送る (出す → 送る の順)` |
| ` * \`buildBar\` の中に閉じ込めないのは、同じスコープの他のクロージャがパネルを` | ` * \`buildBar\` の中に閉じ込めないのは、同じスコープの他のクロージャが設定パネルを` |
| `  // パネルの表示も決め直す` | `  // 窓の表示も決め直す` |
| `    // 一覧も同じ規則で描き直す。固定のパネルに A の区間が B の画面で出続けないように。` | `    // 一覧も同じ規則で描き直す。区間・テロップの窓に A の区間が B の画面で出続けないように。` |
| `    // 動画ページ以外へ移ったら、2 つの窓ごと隠れる (refreshWindows)` | `    // 動画ページ以外へ移ったら、3 つの窓ごと隠れる (refreshWindows)` |
| `// 全画面の間は 2 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる` | `// 全画面の間は 3 つの窓を隠す。body 直下の fixed 要素は全画面の動画の上に残りうる` |
| ` * 覚えた位置 (chrome.storage.local) の読み込みが済んだか。**済むまで 2 つの窓を出さない**` | ` * 覚えた位置 (chrome.storage.local) の読み込みが済んだか。**済むまで 3 つの窓を出さない**` |

(表の `\`` はコードの中のバッククォートそのもの)

確認: `grep -n 'sidePanel\|side-panel\|reveal()\|畳\|2 つの窓' /Users/trapple/repos/github.com/trapple/yt-clip/src/content/youtube.ts`
期待: `688` 行目付近の「この画面の表示を畳むだけで足り、」(録画の中止の話で、窓とは無関係) だけが出る

- [ ] **Step 14: side-panel.ts と SIDE_PANEL_STYLE を消し、他のファイルのコメントの出所を直す**

実行:

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip rm src/content/side-panel.ts tests/content/side-panel.test.ts
```

`src/content/styles.ts` の `SIDE_PANEL_STYLE` の定義と、その直前の doc コメント (`/**\n * 右側のパネル (\`side-panel.ts\`) の中身。…` から
`} as const;` まで) を丸ごと消す。同じファイルの次のコメントを置き換える。

| 今の文言 | 置き換え後 |
|---|---|
| ` * 配色は自前の変数 (\`--ytc-*\`) としてバーと右側のパネルの根に置く。テーマが` | ` * 配色は自前の変数 (\`--ytc-*\`) としてバーと窓の根に置く。テーマが` |
| `   * 右側のパネルの地。**\`surface\` とは別に持つ。** \`surface\` はテロップ行・選択中の` | `   * 窓の地。**\`surface\` とは別に持つ。** \`surface\` はテロップ行・選択中の` |
| ` * フロートの窓の枠 (\`floating-window.ts\`)。バーの窓とパネルの窓で同じものを使う。` | ` * フロートの窓の枠 (\`floating-window.ts\`)。バーの窓・区間・テロップの窓・設定の窓で同じものを使う。` |

`src/content/floating-window.ts` の次のコメントを置き換える。

| 今の文言 | 置き換え後 |
|---|---|
| ` * (side-panel.ts と youtube.ts が決める)。パネルの窓とバーの窓で同じ処理を 2 回書かないために` | ` * (panel-window.ts と youtube.ts が決める)。3 つの窓で同じ処理を何度も書かないために` |
| ` * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は side-panel.ts の` | ` * 重なり順。**YouTube のヘッダー (#masthead-container、z-index 2020。出所は panel-window.ts の` |
| ` * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (折り畳みの ▶ を` | ` * 押した場所が、掴む場所の中のボタンや入力欄か。**そこでは窓を動かさない** (見出しの右側のボタンを` |
| ` * 押したら畳むだけ。spec A.1)` | ` * 押したら、そのボタンの操作だけ。spec A.1)` |
| ` * 高さを決めていない「幅と高さ」の窓 (パネル) の下端と、画面の下端との間。右側パネルの` | ` * 高さを決めていない「幅と高さ」の窓 (区間・テロップの窓・設定の窓) の下端と、画面の下端との間。右側パネルだったときの` |
| `  /** 見出しの右側に置く部品 (折り畳みボタンなど) の箱。見出しの無い窓では null */` | `  /** 見出しの右側に置く部品の箱 (今は何も置いていない)。見出しの無い窓では null */` |
| `    // 本体を隠した (畳んだ) 窓は見出しだけにする。高さを残すと空の枠が残る` | `    // 本体を隠した窓は見出しだけにする。高さを残すと空の枠が残る (今は本体を隠す者はいない)` |

`src/content/window-layout.ts` の次のコメントを置き換える。

| 今の文言 | 置き換え後 |
|---|---|
| ` * **ここに置く (side-panel.ts ではなく)。** パネルの窓の最初の上端 (side-panel.ts) とバーの窓の` | ` * **ここに置く (panel-window.ts ではなく)。** 区間・テロップの窓の最初の上端 (panel-window.ts) とバーの窓の` |
| ` * 上端の下限 (initialBarRect) の 2 箇所が使う。side-panel.ts は floating-window.ts を経て` | ` * 上端の下限 (initialBarRect) の 2 箇所が使う。panel-window.ts は floating-window.ts を経て` |
| ` * 重なりうる)。**上端はヘッダーの下 (MASTHEAD_HEIGHT_PX + TOP_GAP_PX、パネルの窓の最初の上端と` | ` * 重なりうる)。**上端はヘッダーの下 (MASTHEAD_HEIGHT_PX + TOP_GAP_PX、区間・テロップの窓の最初の上端と` |

確認: `git -C /Users/trapple/repos/github.com/trapple/yt-clip grep -n 'side-panel\|SIDE_PANEL\|sidePanel\|initialPanelRect\|collapse' -- src tests`
期待: 次の箇所だけが出る。どれも変えない。
- `tests/content/range-math.test.ts` の変数名 `collapsed` (範囲の話で無関係)
- `tests/content/panel-window.test.ts` の `expect(target.element.querySelector("[data-role='collapse']")).toBeNull();` (Task 3。折り畳みのボタンが無いことを確かめる検査なので残る)
- `tests/content/youtube.test.ts` の `expect(document.querySelector("[data-role='collapse']")).toBeNull();` (Step 3。同じ理由で残る)

- [ ] **Step 15: 実行して通過を確認**

実行: `npx vitest run tests/content/youtube.test.ts tests/content/styles.test.ts tests/content/panel-window.test.ts` (Bash の timeout 120000)
期待: PASS

- [ ] **Step 16: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS。`e2e/telop-check.spec.ts` はまだ `#yt-clip-panel` を探しているが、文字列なので型は通る (Task 6 で直す)

- [ ] **Step 17: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add -A src/content tests/content
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(content): 区間・テロップと設定を別の窓に分ける

⚙ を押すと設定が一覧と同じパネルの下に開き、区間やテロップが多いと
一覧が送られて見えなくなった。設定を別の窓にし、⚙ で開閉して開いた
ら前に出す。最初は一覧の窓から下へ 32px だけずらして重ね、一覧の
見出しを残す。折り畳みはやめる: 動かせる窓になったので、残すと
状態の組み合わせだけが増える。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: E2E と掲載画像のスクリプトを 3 つの窓に合わせ、C1.5 の確認を足す

**Files:**
- Modify: `e2e/telop-check.spec.ts:383-386` (一覧と設定の窓の locator)、`:506`・`:796`・`:844` (＋ テロップ)、`:810-839` (位置の出所)、`:868-965` (受け入れ条件)、`:966-1139` (窓の確認)、`:1142-1145` (帯の節のコメント)
- Modify: `scripts/screenshots.mjs:104-138` (設定を開いて撮るところ)

**Interfaces:**
- Consumes: Task 5 の DOM (`#yt-clip-list` / `#yt-clip-settings` / `#yt-clip-settings-body` / 見出しの `[data-role=window-header]`)、
  Task 4 の保存の形 (`chrome.storage.local` の `windowLayout` が `{ version: 2, float, docks }`)
- Produces: `npm run check:telop` の項目が 24 → 26 (判断メモ 15)。Task 7 の controller が走らせる

**実装担当は `npm run check:telop` / `npm run e2e` / `npm run screenshots` を走らせない。** このタスクの確認は
`npm run typecheck && npm test` まで (E2E のファイルは `tsc` の対象なので、型の誤りはここで分かる)。

E2E は 1 本の長いシナリオで、項目の順に窓の状態を引き継ぐ。**各項目の終わりで設定の窓を閉じる** (判断メモ 16。最初の位置の
設定の窓は区間・テロップの窓の行を覆うので、開いたままだと後の項目で一覧の行を押せない)。置き換えはすべて今のファイルの
文言で探す。**Step 6 の `sed` は Step 3〜5 の後に行う** (先に行うと Step 3 の置き換え前の文言が見つからなくなる)。

- [ ] **Step 1: 一覧と設定の窓の locator を分ける**

`e2e/telop-check.spec.ts` の 383〜386 行目

```typescript
  // 一覧と設定は右側のパネルにある。バーには拡大バーと操作の行だけ
  const panel = page.locator("#yt-clip-panel");
  const segmentRows = panel.locator("[data-role=segment]");
  const telopRows = panel.locator("[data-role=telop]");
```

を次に置き換える。

```typescript
  // 区間とテロップの一覧は区間・テロップの窓、設定は設定の窓にある (窓の分割の spec C1.1)。
  // バーには拡大バーと操作の行だけ
  const listWindow = page.locator("#yt-clip-list");
  const settingsWindow = page.locator("#yt-clip-settings");
  const segmentRows = listWindow.locator("[data-role=segment]");
  const telopRows = listWindow.locator("[data-role=telop]");
```

- [ ] **Step 2: 窓の位置の出所の実測を区間・テロップの窓に直す**

`// --- パネルの位置の出所 (spec §1: 実機の値を確かめて side-panel.ts に書く) ------` から、その `check(…)` の閉じ `});` まで
(810〜839 行目) を次に置き換える。

```typescript
  // --- 窓の位置の出所 (右側パネルの spec §1: 実機の値を確かめて panel-window.ts に書く) ------
  await check("窓の位置の出所 (YouTube の実測)", async () => {
    const measured = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const b = element.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const zIndex = (selector: string) => {
        const element = document.querySelector(selector);
        return element === null ? null : getComputedStyle(element).zIndex;
      };
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        masthead: box("#masthead-container"),
        mastheadZIndex: zIndex("#masthead-container"),
        secondary: box("#secondary"),
        popupContainerZIndex: zIndex("ytd-popup-container"),
        list: box("#yt-clip-list"),
        listZIndex: zIndex("#yt-clip-list"),
      };
    });
    // 値そのものは人が読んで panel-window.ts のコメントに書き写す。ここでは読めたかだけ見る
    record(
      "窓の位置の出所 (YouTube の実測)",
      measured.masthead !== null && measured.secondary !== null && measured.list !== null,
      measured,
    );
  });
```

- [ ] **Step 3: 受け入れ条件を設定の窓まで含めて測る**

`// --- 受け入れ条件 (フロートの窓の spec A.4): 1440x795 で、最初の位置のままのバーの窓が` から、その `await check(` の
閉じ `);` まで (868〜965 行目) を次に置き換える。

```typescript
  // --- 受け入れ条件 (フロートの窓の spec A.4・窓の分割の spec C1.5): 1440x795 で、最初の位置のままの
  // バーの窓がプレイヤーの下に重ならずに収まり、区間・テロップの窓と設定の窓も画面に収まって、設定の窓も
  // プレイヤーに重ならない (settings.left ≥ player.right) -------------------------------------------
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  const ACCEPTANCE_1440 =
    "受け入れ条件 1440x795: 帯の段が最大 (2 段 + 「+N」) で設定を開いても、バーの窓がプレイヤーの下で画面に収まり、区間・テロップの窓と設定の窓が画面に収まって、設定の窓がプレイヤーに重ならない";
  await check(ACCEPTANCE_1440, async () => {
    // **先にページを先頭へ戻す。** 動かしていない窓は viewport が変わったときのプレイヤーの
    // 画面上の位置で最初の位置を取り直し、スクロールでは取り直さない (spec A.2)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      // 直前の項目でシンプルに切り替えたので、区間とテロップは消えている
      await writeSettings({ mode: "edit" });
      await expect(button("＋ 区間を追加")).toBeVisible({ timeout: 10_000 });
      for (const [i, startSec] of LAYOUT_SEGMENT_STARTS.entries()) {
        await seekPaused(startSec);
        await button("＋ 区間を追加").click();
        await expect(segmentRows).toHaveCount(i + 1);
      }
      // 3 つを同じ時刻に重ねて、帯の段を最大 (2 段 + 「+1」) にしてから測る (spec A.4)
      for (const [i, startSec] of LAYOUT_TELOP_STARTS.entries()) {
        await seekPaused(startSec);
        await listWindow.locator("[data-role=add-telop]").click();
        await expect(telopRows).toHaveCount(i + 1);
      }
      // 設定も開く (設定の窓に出る)。設定は 1280x800 でも窓に収まらない (screenshots.mjs の実測) ので、
      // 設定の窓の中でのスクロールを確実に見られる (判断メモ 14)
      await button("⚙").click();
      await expect(page.locator("#yt-clip-setting-mode")).toBeVisible();
      await expect(settingsWindow).toBeVisible();

      // 「スクロールせずに操作できる」かを測るので、ページは先頭に戻す
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const measured = await page.evaluate(() => {
        const rect = (id: string) => {
          const element = document.getElementById(id);
          if (element === null) throw new Error(`#${id} がありません`);
          const b = element.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        };
        const settingsBody = document.getElementById("yt-clip-settings-body");
        if (settingsBody === null) throw new Error("#yt-clip-settings-body がありません");
        const player = document.getElementById("movie_player");
        if (player === null) throw new Error("#movie_player がありません");
        const p = player.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          // **窓の枠の外形で測る。** 中身の根 (#yt-clip-bar) ではない (spec A.4)
          bar: rect("yt-clip-bar-window"),
          list: rect("yt-clip-list"),
          settings: rect("yt-clip-settings"),
          playerBottom: p.bottom,
          // 設定の窓もプレイヤーに重ならない (C1.5: settings.left ≥ player.right)
          playerRight: p.right,
          settingsScrollHeight: settingsBody.scrollHeight,
          settingsClientHeight: settingsBody.clientHeight,
          // 帯の段 (spec B): 出ている帯の数・使っている段の数・「+N」。最大 (2 段 + 「+1」) の
          // 状態で測っていることを確かめる (段が出ていないまま通ると、B の予算を測っていない)
          telopBands: document.querySelectorAll("#yt-clip-bar [data-role=telop-band]").length,
          telopLanes: new Set(
            [
              ...document.querySelectorAll<HTMLElement>("#yt-clip-bar [data-role=telop-band]"),
            ].map((band) => band.dataset.lane),
          ).size,
          telopOverflow:
            document.querySelector("#yt-clip-bar [data-role=telop-overflow]")?.textContent ?? "",
        };
      });
      const inside = (edges: { top: number; bottom: number; left: number; right: number }) =>
        edges.top >= 0 &&
        edges.left >= 0 &&
        edges.right <= measured.innerWidth &&
        edges.bottom <= measured.innerHeight;
      // **記録だけ (合否には入れない)。** 落ちたときに「最初の位置のままか、動かした窓か」を
      // 後から読めるようにする (覚えた位置があれば、その窓は最初の位置を取り直さない)。
      // 読めなくても測定の合否は変えない
      const windowLayout = await readWindowLayout().catch((error: unknown) => ({
        error: String(error),
      }));
      const file = join(OUT_DIR, "layout-1440x795.png");
      await page.screenshot({ path: file });
      record(
        ACCEPTANCE_1440,
        measured.scrollY === 0 &&
          measured.playerBottom <= measured.bar.top &&
          measured.bar.bottom <= measured.innerHeight &&
          inside(measured.list) &&
          inside(measured.settings) &&
          measured.settings.left >= measured.playerRight &&
          measured.settingsScrollHeight > measured.settingsClientHeight &&
          measured.telopBands === 2 &&
          measured.telopLanes === 2 &&
          measured.telopOverflow === "+1",
        { ...measured, windowLayout, file },
      );
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });
```

- [ ] **Step 4: 窓の確認を 3 つの窓に合わせ、⚙ の開閉と v1 の読み替えを足す**

`// --- フロートの窓 (spec A.4): 動かす・大きさを変える・画面の外へ出しきれない・戻す ---------` から、
「掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える」の `check(…)` の閉じ `});` まで (966〜1139 行目) を
次に置き換える。

```typescript
  // --- フロートの窓 (spec A.4・窓の分割の spec C1): 開閉する・動かす・大きさを変える・画面の外へ出しきれない・
  // 戻す・古い形を読む -------------------------------------------------------------------------------------
  // 1920x1080 に戻した後に行う。受け入れ条件の確認で足した区間 5 つと、開いた設定が残っている
  const barWindow = page.locator("#yt-clip-bar-window");
  const barGrip = bar.locator("[data-role=grip]");
  const listHeader = listWindow.locator("[data-role=window-header]");
  const settingsHeader = settingsWindow.locator("[data-role=window-header]");

  type Box = { x: number; y: number; width: number; height: number };
  async function boxOf(locator: Locator): Promise<Box> {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("要素が画面に出ていません");
    return box;
  }
  const centerOf = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
  const samePlace = (a: Box, b: Box) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width);
  /** 見出しの左寄り (見出しの文字の上) の点。右端には何も置いていないが、文字の上を掴むのが人の操作に近い */
  const headerPoint = (header: Box) => ({ x: header.x + 40, y: header.y + header.height / 2 });
  /** 覚えた配置の float (窓ごとの位置)。v2 でなければ null */
  const floatOf = (saved: Record<string, unknown> | null): Record<string, unknown> | null =>
    saved !== null && saved.version === 2 && typeof saved.float === "object" && saved.float !== null
      ? (saved.float as Record<string, unknown>)
      : null;

  /** from を押して to まで動かして離す。途中も刻んで動かし、pointermove を届ける */
  async function dragFromTo(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    // 覚える (chrome.storage.local への保存) のは指を離した後に非同期で走る
    await page.waitForTimeout(500);
  }

  /** ページを読み込み直し、区間 5 つが戻って区間・テロップの窓が出るまで待つ */
  async function reloadAndWaitList(): Promise<void> {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await waitNoAd();
    // エディットで区間があるので区間・テロップの窓も出る (受け入れ条件の確認で足した区間が状態機械に残っている)
    await expect(segmentRows).toHaveCount(LAYOUT_SEGMENT_STARTS.length, { timeout: 30_000 });
    await expect(listWindow).toBeVisible();
  }

  await check("⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    // 受け入れ条件の確認で設定を開いたまま。どちらの窓もまだ動かしていない (1920x1080 の最初の位置)
    await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
    const listOpen = await boxOf(listWindow);
    const settingsOpen = await boxOf(settingsWindow);

    await button("⚙").click();
    await expect(settingsWindow).toBeHidden({ timeout: 10_000 });
    const listClosed = await boxOf(listWindow);

    await button("⚙").click();
    await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
    const settingsReopened = await boxOf(settingsWindow);

    record(
      "⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま",
      // 設定の窓は区間・テロップの窓から (0, +32) (C1.3 のカスケード)
      near(settingsOpen.x, listOpen.x) &&
        near(settingsOpen.y, listOpen.y + 32) &&
        near(settingsOpen.width, 400) &&
        // 閉じても区間・テロップの窓は同じ場所に出たまま
        samePlace(listClosed, listOpen) &&
        near(listClosed.height, listOpen.height) &&
        samePlace(settingsReopened, settingsOpen),
      { listOpen, settingsOpen, listClosed, settingsReopened },
    );
  });

  await check("窓を動かすと、読み込み直しても同じ位置に出る", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    // 設定は直前の項目で開いたまま。設定の窓は区間・テロップの窓に下へ 32px ずれて重なり、前に出ている
    const barStart = await boxOf(barWindow);
    const listStart = await boxOf(listWindow);
    const settingsStart = await boxOf(settingsWindow);

    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: grip.x + 80, y: grip.y + 40 });
    // 設定の窓を先に動かす。下へ 80px 送り、区間・テロップの窓の見出しの行 (上の 32px) から離す
    const settingsAt = headerPoint(await boxOf(settingsHeader));
    await dragFromTo(settingsAt, { x: settingsAt.x - 60, y: settingsAt.y + 80 });
    // 区間・テロップの窓の見出しは、設定の窓の上に出ている (カスケード)。左へは少しだけ動かす
    // (大きく動かすと、次の項目でバーの窓の右下の角に重なる)
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 60, y: listAt.y + 40 });
    const barMoved = await boxOf(barWindow);
    const listMoved = await boxOf(listWindow);
    const settingsMoved = await boxOf(settingsWindow);
    const saved = await readWindowLayout();

    await reloadAndWaitList();
    const barAfter = await boxOf(barWindow);
    const listAfter = await boxOf(listWindow);
    // 設定の開閉は覚えない (読み込み直すと閉じている)。⚙ で開いて、覚えた位置に出るかを見る
    await button("⚙").click();
    await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
    const settingsAfter = await boxOf(settingsWindow);
    // 後の項目は設定を閉じた状態から始める (設定の窓が区間・テロップの窓の右下の角を覆わないように)
    await button("⚙").click();
    await expect(settingsWindow).toBeHidden({ timeout: 10_000 });

    const float = floatOf(saved);
    record(
      "窓を動かすと、読み込み直しても同じ位置に出る",
      near(barMoved.x, barStart.x + 80) &&
        near(barMoved.y, barStart.y + 40) &&
        near(listMoved.x, listStart.x - 60) &&
        near(listMoved.y, listStart.y + 40) &&
        near(settingsMoved.x, settingsStart.x - 60) &&
        near(settingsMoved.y, settingsStart.y + 80) &&
        samePlace(barAfter, barMoved) &&
        samePlace(listAfter, listMoved) &&
        samePlace(settingsAfter, settingsMoved) &&
        float !== null &&
        "bar" in float &&
        "list" in float &&
        "settings" in float,
      {
        barStart,
        barMoved,
        barAfter,
        listStart,
        listMoved,
        listAfter,
        settingsStart,
        settingsMoved,
        settingsAfter,
        saved,
      },
    );
  });

  await check("右下をドラッグすると大きさが変わる (バーの窓は幅だけ)", async () => {
    // バーの窓を上にしておく (右下の角が区間・テロップの窓の下に潜っていても掴めるように)。
    // 押して離すだけなので、位置は変わらず覚え直しもしない
    await barGrip.click();
    const barBefore = await boxOf(barWindow);
    const barCorner = centerOf(await boxOf(barWindow.locator("[data-role=window-resize]")));
    await dragFromTo(barCorner, { x: barCorner.x - 200, y: barCorner.y + 50 });
    const barAfter = await boxOf(barWindow);

    const listBefore = await boxOf(listWindow);
    const listCorner = centerOf(await boxOf(listWindow.locator("[data-role=window-resize]")));
    await dragFromTo(listCorner, { x: listCorner.x - 60, y: listCorner.y - 100 });
    const listAfter = await boxOf(listWindow);

    record(
      "右下をドラッグすると大きさが変わる (バーの窓は幅だけ)",
      near(barAfter.width, barBefore.width - 200, 2) &&
        near(barAfter.height, barBefore.height) &&
        near(barAfter.x, barBefore.x) &&
        near(listAfter.width, listBefore.width - 60, 2) &&
        near(listAfter.height, listBefore.height - 100, 2),
      { barBefore, barAfter, listBefore, listAfter },
    );
  });

  await check("窓を画面の外へドラッグしても、掴む場所が画面に残る", async () => {
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("viewport が取れません");
    // 掴んだ点を画面の隅まで運ぶ。掴む場所の残りは画面の外へ出ようとするが、詰められて残る。
    // 画面の外の座標へはマウスを運べない (ページにイベントが届かない) ので、隅で止める。
    // バーのつまみは右下、区間・テロップの窓の見出しは左下へ。反対の隅へ送るのは、次の項目で
    // ダブルクリックするときに 2 つの窓が重ならないようにするため
    const gripBefore = await boxOf(barGrip);
    const grip = centerOf(gripBefore);
    await dragFromTo(grip, { x: viewport.width - 1, y: viewport.height - 1 });
    const headerBefore = await boxOf(listHeader);
    const headerAt = headerPoint(headerBefore);
    await dragFromTo(headerAt, { x: 1, y: viewport.height - 1 });

    const gripBox = await boxOf(barGrip);
    const headerBox = await boxOf(listHeader);
    const inside = (b: Box) =>
      b.x >= -0.5 &&
      b.y >= -0.5 &&
      b.x + b.width <= viewport.width + 0.5 &&
      b.y + b.height <= viewport.height + 0.5;
    // **ドラッグが効いたことも確かめる。** 掴めなかった (pointerdown が落ちた) ときも掴む場所は
    // 元の位置で画面の中にあり、inside だけでは通ってしまう。隅へ送るので、詰められても
    // x か y が大きく動く
    const moved = (before: Box, after: Box) =>
      Math.abs(after.x - before.x) >= 50 || Math.abs(after.y - before.y) >= 50;
    record(
      "窓を画面の外へドラッグしても、掴む場所が画面に残る",
      inside(gripBox) &&
        inside(headerBox) &&
        moved(gripBefore, gripBox) &&
        moved(headerBefore, headerBox),
      { viewport, gripBefore, gripBox, headerBefore, headerBox },
    );
  });

  await check("掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える", async () => {
    // バーを先に戻す。区間・テロップの窓を先に右上へ戻すと、高さが画面の下まで伸びて右下のつまみに被さる
    await barGrip.dblclick();
    const listHeaderBox = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: listHeaderBox.height / 2 } });
    // 設定の窓は閉じているので、⚙ で開いてから見出しをダブルクリックする (開くと前に出る)
    await button("⚙").click();
    await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
    const settingsHeaderBox = await boxOf(settingsHeader);
    await settingsHeader.dblclick({ position: { x: 40, y: settingsHeaderBox.height / 2 } });
    await page.waitForTimeout(500);

    const measured = await page.evaluate(() => {
      const box = (id: string) => {
        const element = document.getElementById(id);
        if (element === null) throw new Error(`#${id} がありません`);
        const b = element.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      };
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        player: box("movie_player"),
        bar: box("yt-clip-bar-window"),
        list: box("yt-clip-list"),
        settings: box("yt-clip-settings"),
      };
    });
    const saved = await readWindowLayout();
    // 後の項目 (帯) は区間・テロップの窓の行を押す。最初の位置の設定の窓は行を覆うので閉じておく
    await button("⚙").click();
    await expect(settingsWindow).toBeHidden({ timeout: 10_000 });

    // バーの最初の位置: プレイヤーの下端 + 8px。収まらなければ画面の下端から 16px。
    // ヘッダーの下 (68px) より上には置かない (window-layout.ts の initialBarRect)。
    // 区間・テロップの窓は右 16px・上 68px・幅 400px、設定の窓はその (0, +32) (panel-window.ts)
    const expectedBarTop = Math.max(
      68,
      Math.min(measured.player.bottom + 8, measured.innerHeight - 16 - measured.bar.height),
    );
    const float = floatOf(saved);
    record(
      "掴む場所をダブルクリックすると最初の位置に戻り、覚えた位置も消える",
      near(measured.bar.left, measured.player.left) &&
        near(measured.bar.width, measured.player.width) &&
        near(measured.bar.top, expectedBarTop) &&
        near(measured.list.right, measured.innerWidth - 16) &&
        near(measured.list.top, 68) &&
        near(measured.list.width, 400) &&
        near(measured.settings.left, measured.list.left) &&
        near(measured.settings.top, 100) &&
        near(measured.settings.width, 400) &&
        float !== null &&
        Object.keys(float).length === 0,
      { ...measured, expectedBarTop, saved },
    );
  });

  await check("古い形 (v1) の windowLayout があると、パネルの位置に区間・テロップの窓が出る", async () => {
    // フロートの窓 (A) の版が覚えた形。version が無く、区間・テロップと設定が 1 つのパネルだった
    const legacy = { panel: { left: 600, top: 150, width: 420 } };
    const worker = await getWorker();
    await worker.evaluate(
      (value) => chrome.storage.local.set({ windowLayout: value }),
      legacy,
    );
    await reloadAndWaitList();
    const listBox = await boxOf(listWindow);
    // 読み込みは書き戻さない (次に動かしたときに v2 で書く。C1.3)
    const savedAfterLoad = await readWindowLayout();

    // 後の項目 (帯) のために最初の位置へ戻す。戻すと v2 の組で書かれる
    const header = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: header.height / 2 } });
    await page.waitForTimeout(500);
    const savedAfterReset = await readWindowLayout();

    record(
      "古い形 (v1) の windowLayout があると、パネルの位置に区間・テロップの窓が出る",
      near(listBox.x, 600) &&
        near(listBox.y, 150) &&
        near(listBox.width, 420) &&
        savedAfterLoad !== null &&
        !("version" in savedAfterLoad) &&
        "panel" in savedAfterLoad &&
        floatOf(savedAfterReset) !== null,
      { legacy, listBox, savedAfterLoad, savedAfterReset },
    );
  });
```

- [ ] **Step 5: 帯の節の前提のコメントを直す**

同じファイルの

```typescript
  // 窓の確認の後 (2 つの窓は最初の位置に戻っている)。受け入れ条件の確認で足した区間 5 つと
```

を次に置き換える。

```typescript
  // 窓の確認の後 (3 つの窓は最初の位置に戻り、設定の窓は閉じている)。受け入れ条件の確認で足した区間 5 つと
```

- [ ] **Step 6: 残った ＋ テロップの locator を置き換える**

実行:

```bash
sed -i '' 's/panel\.locator("\[data-role=add-telop\]")/listWindow.locator("[data-role=add-telop]")/g' /Users/trapple/repos/github.com/trapple/yt-clip/e2e/telop-check.spec.ts
```

確認: `grep -n -e 'panel\.' -e 'yt-clip-panel' -e 'panelHeader' -e 'panelStart' -e 'side-panel' /Users/trapple/repos/github.com/trapple/yt-clip/e2e/telop-check.spec.ts`
期待: 何も出ない (v1 の項目の `legacy` の `panel:` のキーと `"panel" in savedAfterLoad` は、この検索には当たらない)

- [ ] **Step 7: 掲載画像のスクリプトを設定の窓に向ける**

`scripts/screenshots.mjs` の 104〜112 行目

```javascript
  // 設定を開く。**設定は右側の固定のパネルに開き、ページのスクロールでは動かない。**
  // 枠取りは 1-range と同じ (プレイヤーとバーが下寄り) にして、パネルの中を設定の
  // 先頭まで送って撮る。1280x800 ではパネルの最大高さ (716px) に 8 項目と保存ボタンが
  // 収まらず末尾は切れるが、それでよい。パネルの中でスクロールすることが見て分かる
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-panel")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
```

を次に置き換える。

```javascript
  // 設定を開く。**設定は設定の窓に開き (窓の分割の spec C1.1)、ページのスクロールでは動かない。**
  // 最初の位置は区間・テロップの窓の最初の位置から下へ 32px (シンプルモードなので区間・テロップの窓は
  // 出ていない)。枠取りは 1-range と同じ (プレイヤーとバーが下寄り) にして、窓の中を設定の先頭まで
  // 送って撮る。1280x800 では窓の最大高さ (800 - 100 - 16 = 684px) に 8 項目と保存ボタンが収まらず
  // 末尾は切れるが、それでよい。窓の中でスクロールすることが見て分かる
  await bar.getByRole("button", { name: "⚙" }).click();
  await page
    .locator("#yt-clip-settings")
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
```

同じファイルの 113〜122 行目のコメント (`addStyleTag` の直前)

```javascript
  // **このスクリーンショットだけ**、動画 (#primary) の幅をパネルのぶん空ける。
  // 掲載画像はおすすめ列 (#secondary) を隠しているのでプレイヤーが画面右端まで
  // 広がり、固定パネルと重なって「動画は隠れない」設計と食い違う絵になる。実際の
  // YouTube にはおすすめ列があるので重ならない (1440 幅の実測で
  // playerRight 1012 < panel.left 1024)。
  // 実測 (1280x800、YouTube 2026-09-24): #secondary を隠すと #columns は
  // justify-content: center になり、max-width だけ足すとプレイヤーが中央へ
  // 寄って逆に重なりが深くなる (primary right 1072 > panel.left 864) ので、
  // 左詰めに戻す指定も一緒に足す。448 = パネル幅 400 + 右端の余白 16 +
  // プレイヤー側の左マージン 32 (side-panel.ts の WIDTH_PX / EDGE_GAP_PX と対応)
```

を次に置き換える (448 の計算と `addStyleTag` の中身は変えない。設定の窓は区間・テロップの窓と同じ left なので、
空ける幅も同じ。spec「scripts/screenshots.mjs」)。

```javascript
  // **このスクリーンショットだけ**、動画 (#primary) の幅を設定の窓のぶん空ける。
  // 掲載画像はおすすめ列 (#secondary) を隠しているのでプレイヤーが画面右端まで
  // 広がり、設定の窓と重なって「動画は隠れない」設計と食い違う絵になる。実際の
  // YouTube にはおすすめ列があるので重ならない (1440 幅の実測で
  // playerRight 1012 < 窓の left 1024。設定の窓は区間・テロップの窓と同じ left)。
  // 実測 (1280x800、YouTube 2026-09-24): #secondary を隠すと #columns は
  // justify-content: center になり、max-width だけ足すとプレイヤーが中央へ
  // 寄って逆に重なりが深くなる (primary right 1072 > 窓の left 864) ので、
  // 左詰めに戻す指定も一緒に足す。448 = 窓の幅 400 + 右端の余白 16 +
  // プレイヤー側の左マージン 32 (panel-window.ts の WIDTH_PX / EDGE_GAP_PX と対応)
```

同じファイルの 129〜135 行目

```javascript
  await page.evaluate(() => {
    const body = document.getElementById("yt-clip-panel-body");
    // 設定パネルの根は、最初の項目 (モード) の入力欄 → 項目の枠 → 根
    const settings = document.getElementById("yt-clip-setting-mode")?.parentElement
      ?.parentElement;
    if (body === null || settings == null) {
      throw new Error("パネルか設定が見つかりません");
    }
```

を次に置き換える。

```javascript
  await page.evaluate(() => {
    const body = document.getElementById("yt-clip-settings-body");
    // 設定パネルの根は、最初の項目 (モード) の入力欄 → 項目の枠 → 根
    const settings = document.getElementById("yt-clip-setting-mode")?.parentElement
      ?.parentElement;
    if (body === null || settings == null) {
      throw new Error("設定の窓か設定が見つかりません");
    }
```

確認: `grep -n 'yt-clip-panel\|side-panel\|パネル' /Users/trapple/repos/github.com/trapple/yt-clip/scripts/screenshots.mjs`
期待: 「設定パネルの根は、…」のコメント 1 行 (設定パネル `settings-panel.ts` の話で、窓とは別) だけが出る

- [ ] **Step 8: 型と全テストを通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (`e2e/` も `tsc` の対象。`check:telop` は走らせない)

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add e2e/telop-check.spec.ts scripts/screenshots.mjs
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
test(e2e): 区間・テロップの窓と設定の窓で受け入れ条件を測る

パネルを 2 つの窓に分けたので、E2E と掲載画像のスクリプトが探す窓を
変える。1440x795 の受け入れ条件に「設定の窓もプレイヤーに重ならない」
を足し、⚙ の開閉で一覧の窓が動かないこと、設定の窓の位置を覚える
こと、古い形のパネルの位置を区間・テロップの窓が継ぐことを実機で
確かめられるようにする。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: 実機で確かめる (controller が実行)

**Files:**
- Modify: `docs/manual-check.md` (「## 確認した環境」)

**実行者: controller (メインセッション)。** 実機 (Google Chrome / 同梱の Chromium と YouTube) を使い、結果の画像を見て判断するため
subagent に渡さない。

**Interfaces:**
- Consumes: Task 1〜6 のすべて
- Produces: `test-results/telop-check/` の結果、`release/screenshots/` の掲載画像、`docs/manual-check.md` の記録

**順序に注意:** Playwright は実行のたびに `test-results/` を消す。`npm run e2e` を `npm run check:telop` より**先に**走らせる
(後に走らせると check:telop の結果が消える)。

- [ ] **Step 1: 単体テストと型を通す**

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS

- [ ] **Step 2: 通常の E2E (smoke) を通す**

実行: `npm run e2e` (Bash の timeout 600000。Playwright 側にもテストごとの timeout がある)
期待: smoke の 3 件が PASS、`テロップの実機確認` は skip。smoke は窓の id を探していないので、分割の影響を受けない

- [ ] **Step 3: `npm run check:telop` を走らせる**

実行: Bash を `run_in_background: true` で `npm run check:telop` (15 分かかりうるので Bash の timeout 600000 では足りない。テスト自身が
`test.setTimeout(900_000)` と各操作の 30 秒の上限で止まる)。
待ち方: Monitor で、バックグラウンドのタスクが終わるまで 30 秒おきに確かめる。途中経過は出力の `[PASS]` / `[FAIL]` の行で見る。
20 分経っても終わらなければ出力の最後を見て、止まっている操作を特定してからタスクを止める。
期待: 終了コード 0。`test-results/telop-check/results.json` の項目がすべて `pass: true` で、B のときの 24 項目から
「⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま」と「古い形 (v1) の windowLayout があると、パネルの位置に
区間・テロップの窓が出る」を足した **26 項目**がある (名前が変わった 2 項目: 「窓の位置の出所 (YouTube の実測)」と
受け入れ条件。数が違えば `results.json` のキーを並べて差を確かめる)

落ちたときの見方:

- 受け入れ条件で `settings.left < playerRight` → 設定の窓がプレイヤーに重なった。`values` の `settings` と `list` の left が同じか
  (カスケードが左右にずれていないか)、`playerRight` が 1012 前後か (YouTube のレイアウトが変わっていないか) を見る
- 受け入れ条件で `settingsScrollHeight <= settingsClientHeight` → 設定の窓が溢れていない。画像で設定の窓の高さを見て、窓が画面の
  下端まで伸びているか (最大の高さが効いているか) を確かめる。溢れないのが正しい (設定が全部入った) なら、判断メモ 14 の前提が
  崩れているので spec の `## 自律判断ログ` に 1 行書き、ユーザーに伝える
- 「⚙ で設定が別の窓に開閉し…」で `settingsOpen.y` が `listOpen.y + 32` でない → 設定の窓の最初の位置が一覧から取れていない。
  どちらかの窓が覚えた位置で出ていないか (`values` と、1 つ前の項目までに動かした窓が無いか) を見る
- 「窓を動かすと…」で `settingsAfter` だけが違う → 設定の窓の位置を覚えていない (`saved.float.settings` の有無を見る) か、
  開いたときに最初の位置を取り直している (`placeInitial` が `floatLayout` を見ていない) か
- 「古い形 (v1)…」で `listBox` が (600, 150) でない → v1 の `panel` を `float.list` に読み替えていない。`savedAfterLoad` が
  書き戻されて v2 になっていれば、読み込みが書いている

- [ ] **Step 4: 画像を見て判定する**

Read で次を見る。

- `test-results/telop-check/layout-1440x795.png` — 右上に区間・テロップの窓 (見出し「区間・テロップ」) があり、その少し下 (32px) に
  設定の窓 (見出し「設定」) が重なって前に出ている。区間・テロップの窓の見出しの行は設定の窓の上に見えている。設定の窓の左端が
  プレイヤーの右端より右で、動画に重ならない。バーの窓がプレイヤーの下端の**下**に重ならずに出て、画面に全部見えている。
  どの窓にも ▶ (折り畳み) が無い
- 既存の画像 (`preview-*-t*.png` と `frame-*-t*.png`) が前回と同じ見た目

**1440x795 で設定の窓がプレイヤーに重なっていたら、spec の受け入れ条件 (C1.5) が崩れている。** 直さずに spec の `## 自律判断ログ` に
`- [実機] 1440x795 で設定の窓がプレイヤーに N px 重なる (settings.left=…, playerRight=…)` と 1 行書き、最終報告でユーザーに伝える。

- [ ] **Step 5: 掲載画像を撮り直して確かめる**

実行: `npm run screenshots` (Bash の timeout 600000。スクリプト側にも起動 60 秒・遷移 60 秒・待ち 30 秒の上限がある)
期待: `release/screenshots/1-range.png` と `release/screenshots/2-settings.png` が出力される

Read で 2 枚を見る。

- `1-range.png`: A・B のときと同じ見た目 (バーの窓がプレイヤーの直下。区間・テロップの窓も設定の窓も出ていない)
- `2-settings.png`: 設定の窓 (見出し「設定」) が右上から 32px 下に出て、中が設定の先頭まで送られている。末尾が切れていてよい
  (下へ 32px ずれたぶん、切れる行が 1 つ増えてよい)。プレイヤーと重ならない。見出しに ▶ が無い

`release/` は `.gitignore` の対象なので commit しない。

- [ ] **Step 6: 確認した環境を記録する**

`docs/manual-check.md` の「## 確認した環境」の最後の段落 (「2026-09-25 は拡大バー上のテロップの帯 (B) を …」で始まり
「シンプルモードで出ないことは単体テストでだけ確かめている。」で終わる段落) の後に、空行を 1 つ挟んで次を足す
(`<…>` は実際の値。日付は `TZ=Asia/Tokyo date +%F` の JST)。表の「確認日 (JST)」の範囲も、日付が変わっていれば後ろを延ばす。

```markdown
<JST の日付> は窓の分割 (C1) を `npm run check:telop` で確かめた (26 項目すべて通過。1440x795 で区間 5・テロップ 5・設定を開いた
状態で、最初の位置の設定の窓の左端 <settings.left>px がプレイヤーの右端 <playerRight>px より右にあり、区間・テロップの窓と設定の窓が
画面に収まる。画面は `test-results/telop-check/layout-1440x795.png`)。⚙ で設定の窓が一覧の窓から (0, +32) に開閉すること、設定の窓を
動かして読み込み直すと同じ位置に出ること、古い形 (v1) のパネルの位置に区間・テロップの窓が出ることも check:telop で確かめた。
「見た目」節の窓の項目のうち、3 つの窓の重なり順・区間・テロップの窓を動かしても設定の窓の戻し先が動かないこと・足した行へ送るとき
一覧の窓を前に出さないことは単体テストでだけ確かめている。ストアの掲載画像 (`npm run screenshots`) で、設定の窓が一覧の窓の最初の
位置から 32px 下に写ることを確かめた。
```

実行: `npm run typecheck && npm test` (Bash の timeout 600000)
期待: どちらも PASS (ドキュメントだけの変更だが、commit の前に通す規約に従う)

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add docs/manual-check.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: 窓の分割を実機で確かめたことを記録する

1440x795 で設定を開いても設定の窓がプレイヤーに重ならず画面に
収まること、⚙ の開閉・設定の窓の位置の記憶・古い形のパネルの位置の
引き継ぎが実機の YouTube で効くことを npm run check:telop で通した
ことを残す。単体テストでだけ確かめた項目も分けて書く。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

## 完了後

1. `npm run typecheck && npm test` (Bash の timeout 600000) で全テストが green であることを確認する
2. whole-branch cross-review: この plan の範囲 (spec の commit 4a2e744 以降) を見るため、
   `git -C /Users/trapple/repos/github.com/trapple/yt-clip diff 4a2e744..HEAD` を 1 ファイルにまとめ、新しい subagent に
   subagent-driven-development の `reviewer.md` で「保守担当 + 攻撃者」視点のレビューをさせる (A・B と合わせた branch 全体
   `BASE=$(git merge-base main HEAD)` の diff も添える)。指摘は直して再レビュー (手順は cross-review スキル)。
   攻撃者視点の入力例: 壊れた `windowLayout` (`{ version: 2, float: [] }`・`{ version: "2" }`・`{ panel: "x" }`・`{ version: 2, float: { list: { left: 1e9, top: 0, width: 400 } }, docks: {} }`)・
   v1 と v2 のキーが混ざった組 (`{ bar, panel, version: 2, float: {}, docks: {} }`)・⚙ の連打・全画面の間に ⚙ を押して抜ける・
   設定を開いたままモードを切り替える・ブラウザを 400px 幅まで狭めてから窓を動かし、広げ直す・3 つの窓を同じ位置に重ねて触る順を変える
   - subagent を派遣できない環境では、自分で spec の C1 の各項目と diff を突き合わせ、上の入力例を単体テストか実機で試して結果を記録する
3. branch `feat/dockable-windows` 上の commit で停止。push / PR / merge はユーザーの指示を待つ。C2 (ドック枠とタブ) の plan は、
   spec の「自律判断ログ」の未決事項 (既定をドックにするか) をもう一度見てから書く

完了の条件:

- `npm run typecheck && npm test` が通る
- `npm run e2e` の smoke が通る
- `npm run check:telop` の 26 項目がすべて通り、`layout-1440x795.png` で設定の窓がプレイヤーに重ならず (`settings.left ≥ player.right`)、
  3 つの窓が画面に収まっていることを controller が目で確かめた (Task 7)
- `release/screenshots/2-settings.png` が設定の窓を写している
- README / CHANGELOG / docs (manual-check・store-release・privacy-policy) に C1 の文言が入っている
- whole-branch の cross-review が Approved
