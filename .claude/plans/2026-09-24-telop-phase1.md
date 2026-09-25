# テロップ Phase 1 (手入力) 実装プラン

> **実装者向け:** このプランは subagent-driven-development で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** エディットモードでテロップを手入力し、見た目 (サイズ・フォント・文字色・縁取り色・縁取りの太さ) を
設定で決め、プレイヤー上でプレビューし、録画に焼き込めるようにする。

**Architecture:** テロップは元動画の秒で持つ `Telop[]` として状態機械の `segments` と同じ階層に置く。
描画は `content/telop-render.ts` の 1 つの関数に集め、プレビュー (プレイヤーに重ねた canvas) と録画
(`<video>` を canvas に描いて文字を重ね、`canvas.captureStream(0)` を MediaRecorder に渡す) の両方が使う。
テロップが無い録画は今の `video.captureStream()` の経路のまま変えない。

**Tech Stack:** TypeScript / Vite / Vitest / jsdom / Chrome Extension MV3 / Canvas 2D / MediaRecorder

**spec:** `.claude/specs/2026-09-24-telop-design.md` (以下「spec」)

## Global Constraints

### Spec 由来 (spec から逐語コピー)

- テロップの時刻は **元動画の秒** で持つ (出力タイムラインではない。spec §0.1)
- `shared/timeline.ts` の `toSourceTime` は、`tests/shared/timeline.test.ts` の該当テストごと**削除する**
- **ID は振らない。** 区間と同じく、作った順のまま持ち並べ替えないので index が動かない
- **どの区間にも入らないテロップも持てる。** 区間の外なので録画には出ない。一覧で「区間外」と示す
- `segments` を持つ全ての `ClipState` に、同じ階層で `telops: Telop[]` を足す
- テロップの編集は区間の編集 (`isEditEvent`) と同じく **`ready` と `posted` でだけ受ける**。`preview` と `degraded` では受けない
- **区間がすべて消えて `idle` に戻ったら、テロップも消える。** ただし**テロップが残っている間は最後の 1 区間を消させない** (UI 側で止める)
- `ADD_SEGMENT` が別の動画の区間で作り直すときに `telops` も `[]` にする。`MARK_IN` も常に `[]` にする
- **モードを変えるとテロップも消える**
- `failed` からの `RETRY` で `ready` に戻るときは、区間と一緒にテロップも引き継ぐ
- `StoredClip` には `telops` を**持たせない**
- `sw.ts` の `loadSnapshot` は型検査なしで復元するので、`telops` が欠けた古いスナップショットには `[]` を補う
- `Settings` には 5 つの平坦なキー (`telopFontSizePx` / `telopFont` / `telopFillColor` / `telopStrokeColor` / `telopStrokeWidthPx`) で持つ。既定は 64 / "ゴシック" / "#ffffff" / "#000000" / 8
- 値の範囲: 文字の大きさ 16〜200、縁取りの太さ 0〜40。**設定パネルでの入力は、範囲外を `ok: false` で弾く**。読み込み時の範囲外・型違いは既定値に倒して `console.warn`
- 色は `#rrggbb` だけを受け付ける
- 大きさ・縁取りの太さは **動画の高さ 1080 px を基準にした px**。実際は高さに比例させる
- **プレビューも録画も同じ描画関数で描く**
- 位置は**画面下の中央に固定**。下端から高さの 8% 空ける
- **複数が同時に出るときは、作った順に下から積む**
- 改行 (`\n`) で行を分ける。行間はフォントサイズの 1.2 倍。**自動折り返しはしない**
- 縁取りは `strokeText` を先に、`fillText` を後に描く。`lineWidth = strokeWidthPx × 2 × 倍率`、`lineJoin = "round"`。太さ 0 なら `strokeText` を呼ばない
- 文字は太字 (700) 固定
- フォントのプリセット: ゴシック / 明朝 / 丸ゴシック (spec §3.2 の font-family)。それ以外の文字列は `"<名前>", sans-serif`
- 空文字と、`"` `'` `\` `;` を含むフォント名は `fromText` で `ok: false`。`,` は弾かない
- font 指定が受け付けられたかは、代入前に既知の値を入れておき、代入後に**その値から変わったか**で見る。判定は録画開始時とプレビューのスタイル更新時に 1 回だけ
- **Web フォントは同梱しない**
- **どの区間にも重なる空でないテロップが 1 つも無いなら、今の録画経路をそのまま使う**
- canvas の大きさは**録画開始時の `videoWidth` / `videoHeight` で固定**
- 描くときの `sourceSec` には rVFC が渡す `metadata.mediaTime` を使う
- `canvas.captureStream(0)` にし、rVFC ごとに描いて `track.requestFrame()` を呼ぶ
- `Compositor.release()` は `buildRecordingStream` が返す `release` に繋ぐ
- 録画するテロップと設定は録画開始時に固定する
- canvas に描けるかの検査は `prepareRecording` で行い、失敗したら失敗理由 `telop-render-failed` で `FAIL`。**テロップなしで録って続行しない**
- 一覧を操作できるのは `ready` / `posted` のときだけ
- **＋ テロップ** は今の再生位置から 3 秒、文言なし。動画の長さを超えるなら終わりを動画の終わりに詰める
- 開始が終了以上になる操作は送らず、ステータスに理由を出す
- 文言は `change` で `UPDATE_TELOP` を送る
- **一覧を描き直しても、フォーカス中の入力欄は要素も `value` も触らない**
- 最後の 1 区間の ✕ をテロップ残存時に止めるときの文言: 「テロップが N 件残っています。先にテロップを消してください」。止め損ねてテロップが消えたら「テロップも消えました」
- テロップの入力欄は念のため `keydown` の伝播を止める
- プレビューの canvas は `<video>` と同じ親に入れ、`<video>` の `left` / `top` / `width` / `height` に追従。`pointer-events: none`
- プレビューは rVFC に加え、`telops` が変わったとき・`seeked`・設定が変わったとき・表示サイズが変わったときに `video.currentTime` で 1 回描き直す
- プレビューが描けないときは `console.warn` だけ残して続行
- 設定パネルの 5 項目は**モードに関わらず常に出す**。ヒントに「エディットモードのテロップに使う」
- `SettingsField.control` に `{ kind: "color" }` と、`{ kind: "text" }` の省略可能な `suggestions` を足す
- E2E は**足さない**

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

PJ 側に CLAUDE.md / `.claude/rules/` は存在しない。以下はグローバル設定と既存コードの慣習。

- ドキュメント・コード内コメント・commit message はすべて **日本語**
- **Fail Fast**: silent skip / try-catch して続行 を禁止する。握りつぶすなら「なぜ握りつぶしてよいか」をコメントで説明する
  ※ 局所例外: プレビューの描画失敗は `console.warn` で続行する (spec §6。プレビューは目安であり録画を止める理由にならない。範囲の帯と同じ扱い)
- **ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する** (このため Task 2 をコードより前に置く)
- `cd <dir> && git ...` ではなく `git -C <dir> ...` を使う
- 動画の再生位置 (秒) と壁時計時刻を混同しない
- commit message の末尾に `Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3` を付ける
- コメントは「何をするか」ではなく **「なぜそうしたか」「なぜ別の案を採らなかったか」** を書く。既存コードの密度に合わせる
- `key` を見た分岐をパネルに入れない。パネルが見るのは `scope` と `control` だけ
- 失敗理由を足すときは `FAILURE_MESSAGES` に文言を対で足す (型で強制されている)
- テストは `npm test` (vitest)、型は `npm run typecheck`。**各タスクの commit 前に両方を通す**

### 運用前提 (brainstorming で確定した実装方式)

- モード: autonomous
- 隔離: branch のみ。branch 名 `feat/telop-phase1` (作成済み、spec は commit 済み)
- 並列: SDD。ただしタスクは依存順に並べてあり、同じファイルを触るタスク (Task 4〜5 の `types.ts`、Task 8〜11 の `youtube.ts`) は**同時に走らせない**
- Task 1 は Claude in Chrome でメインセッションが実行する (subagent に渡さない)。Chrome に繋がらない等のときだけユーザーに頼る
- Task 12 は拡張の読み込み (`chrome://extensions`) と、耳で確かめる項目だけユーザーに頼る。それ以外は Claude in Chrome でメインセッションが確かめる
- Task 10 は Task 1 の検証 4 の結果次第で実施 / 省略が決まる
- 終点: branch 上の commit まで。push / PR はユーザーの指示を待つ

### タスクの依存

```
Task 1 (実機検証) ─→ Task 2 (ドキュメント)
Task 3 (telop 純粋関数) ─→ Task 4 (状態機械) ─→ Task 8, 9, 10, 11
Task 5 (設定) ─→ Task 6 (描画) ─→ Task 7 (合成) ─→ Task 8 (録画の配線)
                                   Task 6 ─→ Task 11 (プレビュー)
Task 9 (一覧 UI) ─→ Task 10 (タブが隠れたら中断。条件付き)
全部 ─→ Task 12 (スクリーンショット)
```

---

### Task 1: canvas 経由の録画が実機で成立することを確かめる (Claude in Chrome で自動)

**Files:**
- Modify: `.claude/specs/2026-09-24-telop-design.md` (§9 に検証結果を追記)

**実行者: メインセッション。** Claude in Chrome (`mcp__claude-in-chrome__*`) でユーザーの Chrome を操作して行う。subagent には渡さない (ブラウザのツールとタブの状態をメインセッションが持つため)。

**ユーザーに頼るのは次の場合だけ:** Chrome に接続できない、再生が始まらない、広告が挟まり続ける。そのときは状況を伝えて止まる。

**Interfaces:**
- Consumes: なし
- Produces: spec §9.1 の検証結果。検証 4 の結果 (「canvas 経由 / 今の経路それぞれ、非表示タブで映像が止まるか」) が Task 2 と Task 10 の前提になる

spec §9 の未検証の前提 1〜4 を、コードを 1 行も書く前に確かめる。**目視に頼らないよう、映像の左上にその時点の元動画の秒を白黒の格子 (20 ビット、1 マス 24px) で書き込み、出力を再生しながら画素で読み戻す。** これで繋ぎ目の混入とフレーム落ちを数値で判定できる。

- [ ] **Step 1: Chrome に繋いで検証用の動画を開く**

1. ToolSearch で `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__javascript_tool` を 1 回で読み込む (Task 12 でも同じ一覧を使う)
2. `tabs_context_mcp` でタブの状況を取り、`tabs_create_mcp` で新しいタブを作る (既存のタブは使わない)
3. `navigate` で `https://www.youtube.com/watch?v=aqz-KE-bpKQ` (Blender 公式の Big Buck Bunny 60fps。10 分あり、1080p60 が選べる) を開く
4. `javascript_tool` で画質を 1080p に寄せる: `(() => { const p = document.getElementById("movie_player"); return typeof p?.setPlaybackQualityRange === "function" ? (p.setPlaybackQualityRange("hd1080"), "set") : "missing"; })()`。`"missing"` なら黙って進めず、`computer` でプレイヤーの歯車 → 画質 → 1080p60 を選ぶ
5. `computer` でプレイヤーの中央を 1 回クリックする (スクリプトからの `play()` は user activation が無いと拒まれる。一度クリックしておけば以降の `play()` は通る)。**自動再生していた場合はこのクリックで一時停止になるが、それで構わない** (activation は得ている。スクリプトが自分で `play()` する)。クリックを繰り返さないこと
6. `javascript_tool` で `(() => { const v = document.querySelector("video.html5-main-video"); return JSON.stringify({ paused: v.paused, w: v.videoWidth, h: v.videoHeight, ad: document.getElementById("movie_player").classList.contains("ad-showing") }); })()` を読む。`paused` はどちらでもよい。`ad: true` なら広告が終わるまで待って読み直す。`h` が 1080 未満なら 4. をやり直す (3 回やっても上がらなければ、その解像度のまま進めて結果に書く)

- [ ] **Step 2: 検証 A (汚染・繋ぎ目・負荷) を走らせる**

`javascript_tool` で次を実行する。結果は `window.__telopCheckA` に入る (録画 6 秒 + 解析で 20 秒ほどかかるので、実行後は Step 3 で読みに行く)。

```javascript
window.__telopCheckA = { status: "running" };
(async () => {
  try {
    const video = document.querySelector("video.html5-main-video");
    const MIME = 'video/mp4;codecs="avc1.640028,mp4a.40.2"';
    const width = video.videoWidth;
    const height = video.videoHeight;
    const BITS = 20;
    const CELL = 24;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // 検証 1: 汚染されていないか
    ctx.drawImage(video, 0, 0, width, height);
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch (error) {
      window.__telopCheckA = { status: "done", tainted: String(error) };
      return;
    }

    // 元動画の秒 (1/100 秒単位) を左上の格子に書く。出力から読み戻して判定に使う
    const stamp = (sec) => {
      const value = Math.round(sec * 100);
      for (let i = 0; i < BITS; i += 1) {
        ctx.fillStyle = (value >> i) & 1 ? "#fff" : "#000";
        ctx.fillRect(i * CELL, 0, CELL, CELL);
      }
    };

    const canvasTrack = canvas.captureStream(0).getVideoTracks()[0];
    const audioTrack = video.captureStream().getAudioTracks()[0];
    const stream = new MediaStream([canvasTrack, audioTrack].filter(Boolean));
    const rec = new MediaRecorder(stream, { mimeType: MIME });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const painted = [];
    let stopped = false;
    // 録画中に一度でも広告が出たか。終わった後の 1 回だけ見ると、途中で始まって終わった広告を拾えない
    let adSeen = false;
    const tick = (_now, meta) => {
      if (stopped) return;
      if (document.getElementById("movie_player").classList.contains("ad-showing")) adSeen = true;
      ctx.drawImage(video, 0, 0, width, height);
      ctx.font = `700 ${Math.round((64 * height) / 1080)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineJoin = "round";
      ctx.lineWidth = (16 * height) / 1080;
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#fff";
      ctx.strokeText("テロップ検証", width / 2, height * 0.92);
      ctx.fillText("テロップ検証", width / 2, height * 0.92);
      stamp(meta.mediaTime);
      canvasTrack.requestFrame();
      painted.push(meta.mediaTime);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);

    const seekTo = (sec) => new Promise((resolve) => {
      video.addEventListener("seeked", resolve, { once: true });
      video.currentTime = sec;
    });
    const freshFrame = () => new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    await seekTo(60);
    await video.play();
    await freshFrame();
    rec.start(1000);
    await wait(3000);
    rec.pause();
    video.pause();

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
    stopped = true;

    // 出力を頭から再生し、フレームごとに格子を読み戻す。
    // **画面に見える形で DOM に置く。** 描画されない video では rVFC がほとんど来ず
    // (合成器に送られないため)、フレーム落ちと誤判定する。drawImage は表示サイズに
    // 関係なく元の解像度のフレームを読むので、小さく出しても読み戻しは変わらない
    const probe = document.createElement("video");
    probe.muted = true;
    probe.style.cssText = "position:fixed;left:0;top:0;width:480px;height:270px;z-index:2147483647;";
    document.body.append(probe);
    probe.src = URL.createObjectURL(blob);
    await new Promise((r) => probe.addEventListener("loadedmetadata", r, { once: true }));
    if (!Number.isFinite(probe.duration)) {
      await new Promise((r) => { probe.addEventListener("seeked", r, { once: true }); probe.currentTime = 1e9; });
    }
    const durationSec = probe.duration;
    await new Promise((r) => { probe.addEventListener("seeked", r, { once: true }); probe.currentTime = 0; });

    const reader = document.createElement("canvas");
    reader.width = BITS * CELL;
    reader.height = CELL;
    const rctx = reader.getContext("2d", { willReadFrequently: true });
    const decode = () => {
      rctx.drawImage(probe, 0, 0, BITS * CELL, CELL, 0, 0, BITS * CELL, CELL);
      const data = rctx.getImageData(0, 0, BITS * CELL, CELL).data;
      let value = 0;
      for (let i = 0; i < BITS; i += 1) {
        const index = ((CELL / 2) * BITS * CELL + i * CELL + CELL / 2) * 4;
        if (data[index] > 128) value |= 1 << i;
      }
      return value / 100;
    };
    const frames = [];
    let presentedFrames = 0;
    // presentedFrames は要素を作ってからの累計。再生前のシークで提示された分を引く
    let presentedBase = null;
    await new Promise((resolve) => {
      const onFrame = (_now, meta) => {
        frames.push({ t: meta.mediaTime, src: decode() });
        if (presentedBase === null) presentedBase = meta.presentedFrames - 1;
        presentedFrames = meta.presentedFrames - presentedBase;
        if (!probe.ended) probe.requestVideoFrameCallback(onFrame);
      };
      probe.requestVideoFrameCallback(onFrame);
      probe.addEventListener("ended", resolve, { once: true });
      void probe.play();
    });
    URL.revokeObjectURL(probe.src);
    probe.remove();
    if (frames.length === 0) {
      window.__telopCheckA = { status: "no-frames", durationSec };
      return;
    }

    const seam = frames.findIndex((f) => f.src >= 100);
    const after = seam < 0 ? [] : frames.slice(seam);
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t);
    const deltas = painted.slice(1).map((sec, i) => sec - painted[i]).filter((d) => d > 0 && d < 0.1);
    const fps = deltas.length === 0 ? 0 : 1 / (deltas.reduce((a, b) => a + b, 0) / deltas.length);
    window.__telopCheckA = {
      status: "done",
      tainted: false,
      width,
      height,
      sourceFps: Math.round(fps),
      durationSec,
      paintedFrames: painted.length,
      presentedFrames,
      outputFrames: frames.length,
      adShowing: adSeen,
      expectedFrames: Math.round(fps * 6),
      maxOutputGapSec: gaps.length === 0 ? null : Math.max(...gaps),
      lastBeforeSeam: seam > 0 ? frames[seam - 1].src : null,
      firstAfterSeam: seam >= 0 ? frames[seam].src : null,
      staleAfterSeam: after.filter((f) => f.src < 100).length,
      firstSrc: frames[0]?.src ?? null,
      lastSrc: frames.at(-1)?.src ?? null,
    };
  } catch (error) {
    window.__telopCheckA = { status: "error", error: String(error) };
  }
})();
"started";
```

- [ ] **Step 3: 結果 A を読んで判定する**

`javascript_tool` で `JSON.stringify(window.__telopCheckA)` を読む。`"status":"running"` の間は 5 秒ほど空けて読み直す (`computer` の wait を使う。最大 12 回。超えたら止まってユーザーに状況を伝える)。`"status":"error"` なら内容を読んで原因を直し、Step 2 からやり直す (2 回失敗したら止まる)。`"status":"no-frames"` は出力の再生からフレームが取れなかった (判定に使えない) ので、YouTube のタブが前面にあるかを `computer` の screenshot で確かめてからやり直す。`adShowing: true` なら広告が挟まっているので、終わるのを待ってやり直す。

| 見るところ | 通る条件 |
|---|---|
| 検証 1 | `tainted` が `false` |
| 検証 2 長さ | `durationSec` が 5.5〜6.5 |
| 検証 2 繋ぎ目 | `staleAfterSeam` が 0、`firstAfterSeam` が 120.0〜120.25、`lastBeforeSeam` が 62.5〜63.5 |
| 検証 2 頭と尻 | `firstSrc` が 60.0〜60.25、`lastSrc` が 122.5〜123.5 |
| 検証 3 負荷 | `presentedFrames` が `expectedFrames` の 90% 以上、かつ `maxOutputGapSec` が 0.1 未満 (長く止まったフレームが無い)。`outputFrames` (読み戻せた数) は参考。`presentedFrames` より大きく少なければ読み戻し側の取りこぼしで、録画のフレーム落ちではない |

**音と映像のずれはここでは判定しない** (耳でしか分からない)。上がすべて通ったら Step 4 へ。

- [ ] **Step 4: 検証 B (非表示タブ) を走らせる**

同じタブで、次を `window.__withCanvas = true` と `false` の 2 回実行する (2 回目は 1 回目の結果を読んでから。スクリプト冒頭の代入の値だけを変える)。1 回ごとに次の順で操作する。

1. `javascript_tool` でスクリプトを実行する (返りは `"started"`)
2. **すぐに** `tabs_create_mcp` で空のタブを開き、**その tabId で `computer` の screenshot を撮る** (新しいタブが前面に出るとは限らない。screenshot は表示中のタブでしか撮れないので、撮ることで前面に出す)。`tabs_context_mcp` で YouTube のタブがアクティブでないことを確かめる
3. `computer` の wait で 5 秒待つ
4. `tabs_close_mcp` で 2. のタブを閉じ、**YouTube のタブで `computer` の screenshot を撮って前面に戻す**
5. `JSON.stringify(window.__telopCheckB)` を、`status` が `done` になるまで 5 秒おきに読む

```javascript
window.__withCanvas = true; // 2 回目は false
window.__telopCheckB = { status: "running", withCanvas: window.__withCanvas };
(async (WITH_CANVAS) => {
  try {
    const video = document.querySelector("video.html5-main-video");
    const MIME = 'video/mp4;codecs="avc1.640028,mp4a.40.2"';
    const captured = video.captureStream();
    let videoTrack = captured.getVideoTracks()[0];
    let stopped = false;
    let painted = 0;
    let paintedWhileHidden = 0;

    if (WITH_CANVAS) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      videoTrack = canvas.captureStream(0).getVideoTracks()[0];
      const tick = () => {
        if (stopped) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        videoTrack.requestFrame();
        painted += 1;
        if (document.hidden) paintedWhileHidden += 1;
        video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    }

    const visibility = [];
    const onVisibility = () =>
      visibility.push({ hidden: document.hidden, at: performance.now(), sourceSec: video.currentTime });
    document.addEventListener("visibilitychange", onVisibility);

    const stream = new MediaStream([videoTrack, captured.getAudioTracks()[0]].filter(Boolean));
    const rec = new MediaRecorder(stream, { mimeType: MIME });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    if (video.paused) await video.play();
    const startedAt = performance.now();
    rec.start(1000);

    // 12 秒以上録り、かつタブが表に戻るまで待つ (出力の解析は表のタブでしか進まない)
    while (performance.now() - startedAt < 12000 || document.hidden) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: MIME }));
      rec.stop();
    });
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);

    // 出力を再生してフレームの間隔を測る。止まっていた区間は 1 枚のフレームが長く居座る。
    // 画面に見える形で置く (描画されない video では rVFC がほとんど来ない。検証 A と同じ)
    const probe = document.createElement("video");
    probe.muted = true;
    probe.style.cssText = "position:fixed;left:0;top:0;width:480px;height:270px;z-index:2147483647;";
    document.body.append(probe);
    probe.src = URL.createObjectURL(blob);
    await new Promise((r) => probe.addEventListener("loadedmetadata", r, { once: true }));
    if (!Number.isFinite(probe.duration)) {
      await new Promise((r) => { probe.addEventListener("seeked", r, { once: true }); probe.currentTime = 1e9; });
    }
    const durationSec = probe.duration;
    await new Promise((r) => { probe.addEventListener("seeked", r, { once: true }); probe.currentTime = 0; });
    const times = [];
    await new Promise((resolve) => {
      const onFrame = (_now, meta) => {
        times.push(meta.mediaTime);
        if (!probe.ended) probe.requestVideoFrameCallback(onFrame);
      };
      probe.requestVideoFrameCallback(onFrame);
      probe.addEventListener("ended", resolve, { once: true });
      void probe.play();
    });
    URL.revokeObjectURL(probe.src);
    probe.remove();
    if (times.length === 0) {
      window.__telopCheckB = { status: "no-frames", withCanvas: WITH_CANVAS, durationSec };
      return;
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);

    const hiddenAt = visibility.find((v) => v.hidden)?.at;
    const shownAt = visibility.find((v) => !v.hidden)?.at;
    window.__telopCheckB = {
      status: "done",
      withCanvas: WITH_CANVAS,
      hiddenSec: hiddenAt !== undefined && shownAt !== undefined ? (shownAt - hiddenAt) / 1000 : null,
      durationSec,
      outputFrames: times.length,
      maxOutputGapSec: gaps.length === 0 ? null : Math.max(...gaps),
      painted,
      paintedWhileHidden,
      // 隠れている間も元動画が進んでいたか (spec §4.3 の注の参考)
      visibility,
    };
  } catch (error) {
    window.__telopCheckB = { status: "error", error: String(error) };
  }
})(window.__withCanvas);
"started";
```

- [ ] **Step 5: 結果 B を判定する**

`hiddenSec` が `null` なら一度も隠れていない (新しいタブが前面に出なかった)。Step 4 の 2. の screenshot で前面に出し直してやり直す。2 未満なら隠れていた時間が短すぎるので、同じくやり直す。`"status":"no-frames"` なら YouTube のタブが前面にあるかを確かめてやり直す。

| 結果 | 判定 |
|---|---|
| `maxOutputGapSec` が 1 以上 | 隠れている間に映像が**止まる** |
| `maxOutputGapSec` が 1 未満 | 映像が**進む** |

canvas 経由の回は `paintedWhileHidden` も記録する (0 なら rVFC が隠れている間に来ていない裏付けになる)。

- [ ] **Step 6: 結果を spec に追記する**

`.claude/specs/2026-09-24-telop-design.md` の §9 の末尾 (「## 10.」の見出しの直前) に追記する。`<>` は Step 3 / 5 の実際の値で埋める。

```markdown
### 9.1 検証結果 (2026-09-24)

Claude in Chrome で実機 (Chrome / YouTube / Big Buck Bunny 60fps / <width>x<height>) を操作して確かめた。
映像の左上に元動画の秒を格子で書き込み、出力を再生しながら読み戻して判定した。

| 前提 | 結果 |
|---|---|
| 1. canvas の汚染 | <汚染なし / 汚染あり> |
| 2. pause / resume をまたいだ長さ | 出力 <durationSec> 秒 (期待 6 秒) |
| 2. 繋ぎ目 | 前の区間の最後 <lastBeforeSeam> 秒 → 次の区間の最初 <firstAfterSeam> 秒。繋ぎ目の後に前の場面のフレーム <staleAfterSeam> 枚 |
| 3. 負荷 (<sourceFps>fps) | 出力で提示されたフレーム <presentedFrames> (再生前のシーク分を除く) / 期待 <expectedFrames> (読み戻せたのは <outputFrames>)。最長のフレーム間隔 <maxOutputGapSec> 秒 |
| 4. 非表示タブ (canvas 経由) | <hiddenSec> 秒隠して、映像が <止まる / 進む> (最長のフレーム間隔 <maxOutputGapSec> 秒、隠れている間に描いたフレーム <paintedWhileHidden>) |
| 4. 非表示タブ (今の経路・対照) | <hiddenSec> 秒隠して、映像が <止まる / 進む> (最長のフレーム間隔 <maxOutputGapSec> 秒) |

音と映像のずれは自動では判定していない (手動確認の項目に残す)。

<結論を 1〜3 文で。例: 「1〜3 は通った。4 は canvas 経由だけ止まるので §4.3 のとおり
テロップ付きの録画中にタブが隠れたら中断する (Task 10 を実施)」>
```

**判定と、その後の進め方:**

- **1 か 2 が崩れた場合は、ここで止まる。** spec §9 のフォールバックのとおり、この plan は破棄して元の計画 (サブプロジェクト 2 の上に乗せる) に戻る判断をユーザーに仰ぐ
- **3 が崩れた場合:** Task 7 の「検証 3 が崩れていた場合」の手順を実施する
- **4 の結果で Task 10 が決まる:**
  - canvas 経由が止まる・今の経路は進む → Task 10 の「A. canvas 経由だけ止まる」を実施
  - 両方止まる → Task 10 の「B. 両方止まる」を実施
  - どちらも進む → Task 10 は省略する

- [ ] **Step 7: 後片付け**

`tabs_close_mcp` で Step 1 で作ったタブを閉じる。

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add .claude/specs/2026-09-24-telop-design.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs(specs): canvas 経由の録画を実機で確かめた

canvas の汚染・pause/resume をまたいだ繋ぎ目・1080p60 の負荷・非表示タブでの
挙動は、どれも動かさないと分からなかった。崩れると設計ごと退避が要るため、
コードを書く前に確かめた。映像に元動画の秒を書き込んで読み戻し、目視に
頼らずに判定した。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 2: ドキュメントを先に直す

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual-check.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/store-release.md`
- Modify: `.claude/specs/2026-09-23-edit-mode-segments-design.md`

**Interfaces:**
- Consumes: Task 1 の検証 4 の結果 (spec §9.1)
- Produces: なし (ドキュメントのみ)

※ プライバシーポリシーとストア掲載文を直すが、**権限は増えず、保存する項目の列挙が変わるだけ**なので human gate は付けない (公開は別手順で、ユーザーが行う)。

グローバル規約「ドキュメントとコード両方に修正がある場合、先にドキュメントを修正する」に従う。

- [ ] **Step 1: README の「モード」節のエディットモードの説明の後にテロップを足す**

`README.md` の「**モードを変えると作りかけの区間は消える。** 録画中は変えられない。」の段落の**直前**に、次を挿入する。

```markdown
### テロップ (エディットモード)

区間の一覧の下に **テロップ** の一覧が出る。

- **＋ テロップ** — 今の再生位置から 3 秒のテロップを足す。文言は一覧の入力欄に書く
  (改行も入れられる)
- **開始を今に** / **終了を今に** — 出す時間を今の再生位置に合わせる
- **▶** — そのテロップの頭から再生する / **✕** — 消す

テロップはプレイヤーの上に、録画と同じ見た目で重なって見える。録画すると
動画に焼き込まれる。見た目 (文字サイズ・フォント・文字の色・縁取りの色・
縁取りの太さ) は ⚙ で決める。全テロップ共通。
```

- [ ] **Step 2: README の「仕様と制約」にテロップの節を足す**

`README.md` の「### 投稿本文」の見出しの**直前**に、次を挿入する。**`<タブの制約>` の行は Task 1 の検証 4 の結果で書き分ける:**
canvas 経由だけ止まる → 「**テロップ付きの録画中はタブを離れられない**。…」、両方止まる → この行は消して代わりに「### 録画」の節の末尾に「- **録画中はタブを離れられない**。タブが隠れると中断する (ブラウザが隠れたタブの映像の処理を止めるため)」を足す、どちらも進む → この行は消す。

```markdown
### テロップ (エディットモード)

- **テロップの時刻は元動画の時刻に付いている**。区間を並べ替えたり縮めたりしても、
  テロップはその場面の発話に付いてくる。同じ場面を 2 回使えば、テロップも 2 回出る
- **どの区間にも入らないテロップは録画に出ない**。一覧に「(区間外)」と出る。
  消さずに残るので、区間を伸ばせば出るようになる
- **位置は画面下の中央に固定**。複数が同時に出るときは作った順に下から積む
- **自動で折り返さない**。長い文言は入力欄で改行する。はみ出した分は切れる
- **フォントは環境によって字形が変わる**。プリセット (ゴシック / 明朝 / 丸ゴシック)
  は Mac / Windows の標準フォントを順に探す。名前を書いたフォントが手元に無いときは
  代わりのフォントで描かれる (⚙ で変えた瞬間のプレビューで分かる)
- **テロップ付きの録画は、録画開始時の画質で固定される**。録画中に画質が上がっても
  出力の解像度は変わらない。録画中に ⚙ でテロップの見た目を変えても、その録画には効かない
- <タブの制約>
- **テロップが残っている間は、最後の 1 区間を消せない**。区間と一緒に手入力の文言が
  全部消えるのを防ぐため。先にテロップを消す
```

同じ README の「### 録画」の節で、「**画質は録画時に再生している画質になる**。」で始まる項目の末尾 (その項目の最後の文の後) に、次の 1 文を足す。

```markdown
  テロップ付きの録画は、録画開始時の画質で固定される (途中で画質が上がっても出力の解像度は変わらない)
```

- [ ] **Step 3: CHANGELOG の「未リリース」を書く**

`CHANGELOG.md` の `（次の版の変更をここに書く）` を次に置き換える。

```markdown
**エディットモードにテロップを足した。** 区間の一覧の下の「＋ テロップ」で作り、
文言と出す時間を決めると、録画に焼き込まれる。文字サイズ・フォント・文字の色・
縁取りの色・縁取りの太さは ⚙ で決める。プレイヤーの上で録画と同じ見た目を
確かめられる。
```

- [ ] **Step 4: 手動確認のチェックリストを足す**

`docs/manual-check.md` の「## 制約の確認」の見出しの**直前** (「## エディットモード (複数区間の結合)」の節の後) に次を足す。**最後の項目は Task 10 を実施する場合だけ残す** (「B. 両方止まる」の場合は「テロップ付きの」を外す)。

```markdown
## テロップ (エディットモード)

- [ ] テロップ付きで 2 区間を録り、**出力の長さが区間の合計と一致し、音ズレが無い**
- [ ] 焼き込まれたテロップの位置・大きさ・色・縁取りが、プレビューと同じに見える
- [ ] 360p と 1080p で録って、テロップの見た目の比率が同じ
- [ ] 録画中に画質が変わっても、出力の解像度が変わらず映像が崩れない
- [ ] テロップなしの録画が今までと変わらない (canvas を経由していない)
- [ ] 入力欄で文字を打っても YouTube のショートカット (スペース・`f` など) が発火しない
- [ ] 1080p60 で録ってフレーム落ち (カクつき) が目立たない
- [ ] 一時停止したまま文言や時刻を変えると、プレビューがその場で描き直される
- [ ] シアターモード・全画面に切り替えても、プレビューのテロップが動画の上の同じ位置に出る
- [ ] テロップが残っているとき、最後の 1 区間の ✕ が止まり理由が出る
- [ ] テロップ付きの録画中に別のタブへ移る・ウィンドウを最小化すると、壊れたクリップを作らずに理由付きで中断する。「もう一度」で区間もテロップも残っている
```

- [ ] **Step 5: プライバシーポリシーの設定の列挙を直す**

`docs/privacy-policy.md` の 19 行目の表の行

```markdown
| 設定 (投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数) | `chrome.storage.sync` | 拡張を削除したとき |
```

を次に置き換える (モードも漏れていたので一緒に足す)。

```markdown
| 設定 (投稿本文のテンプレート、チャンネルごとのハッシュタグ、クリップの最大秒数、モード、テロップの見た目) | `chrome.storage.sync` | 拡張を削除したとき |
```

- [ ] **Step 6: ストア掲載文を直す**

`docs/store-release.md` を開き、次の 3 箇所を直す。**掲載文はです・ます調**なので、足す文もそれに揃える。

1. 119〜121 行目付近の `storage` の用途説明の引用 (`> 切り抜きのモード (シンプル / エディット) を保存する (\`chrome.storage.sync\`)。` を含む段落) で、モードを保存する旨の文の直後に `テロップの見た目 (文字サイズ・フォント・色) を保存する (\`chrome.storage.sync\`)。` を足す。**テロップの文言そのものは `chrome.storage.session` の進行状態に含まれる**ので、同じ引用の中の `chrome.storage.session` の説明に「(作りかけの区間とテロップ)」と足す
2. 「■ 複数の場面を繋ぐ (エディットモード)」(67 行目付近) の段落の末尾に「テロップを入れて動画に焼き込むこともできます。」を足す
3. 「■ 設定 (⚙)」(80 行目付近) の箇条書きの末尾に「・テロップの見た目 — 文字サイズ / フォント / 文字の色 / 縁取りの色 / 縁取りの太さ」を足す (既存の「・モード — …」の行と同じ書式)

まず `grep -n "エディット\|storage.session\|■" docs/store-release.md` で該当行を確かめてから直すこと。

- [ ] **Step 7: エディット spec に「覆した」旨を書く**

`.claude/specs/2026-09-23-edit-mode-segments-design.md` の `### 0.1 2 と 3 が後で乗る場所を先に決めておく` の見出しの直後に 1 段落足す。

```markdown
> **2026-09-24 追記:** テロップ spec (`2026-09-24-telop-design.md` §0.1) で、この節の
> 前提 2 つ (テロップは 2 の上に乗る / テロップの時刻は出力タイムラインの秒) を覆した。
> テロップはリアルタイム録画に canvas 合成を差し込んで作り、時刻は元動画の秒で持つ。
> `toSourceTime` は削除した。
```

同じファイルの「### 2.2 `shared/timeline.ts` を新設する」の節で、`toSourceTime` の段落 (「`toSourceTime` はこの spec では使わない。**それでも今のうちに置く。**」で始まるもの) の直後に 1 行足す。

```markdown
> **2026-09-24 追記:** テロップは元動画の秒で持つことにしたので (テロップ spec §0.1)、`toSourceTime` は削除した。
```

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add README.md CHANGELOG.md docs/manual-check.md docs/privacy-policy.md docs/store-release.md .claude/specs/2026-09-23-edit-mode-segments-design.md
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
docs: テロップの使い方と制約を先に書く

コードより先に、利用者から見た振る舞いと、そう作った理由を固めておく。
権限は増えないが、保存する設定の列挙は変わるのでプライバシーポリシーと
ストアの説明も合わせる。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 3: テロップの純粋関数を `shared/telop.ts` に作る

**Files:**
- Create: `src/shared/telop.ts`
- Modify: `src/shared/types.ts` (型 `Telop` を足す)
- Modify: `src/shared/timeline.ts` (`assertValidRange` を export、`toSourceTime` を削除)
- Create: `tests/shared/telop.test.ts`
- Modify: `tests/shared/timeline.test.ts` (`toSourceTime` のテストを削除)

**Interfaces:**
- Consumes: `ClipRange` (`@/shared/types`)
- Produces:
  - `type Telop = { startSec: number; endSec: number; text: string }` (`@/shared/types`)
  - `assertValidRange(range: ClipRange): void` (`@/shared/timeline`、export に変える)
  - `assertValidTelops(telops: Telop[]): void`
  - `activeTelops(telops: Telop[], sourceSec: number): Telop[]`
  - `overlapsSegments(telop: Telop, segments: ClipRange[]): boolean`
  - `hasRenderableTelops(telops: Telop[], segments: ClipRange[]): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`tests/shared/telop.test.ts` を作る。

```typescript
import { describe, expect, test } from "vitest";
import {
  activeTelops,
  assertValidTelops,
  hasRenderableTelops,
  overlapsSegments,
} from "@/shared/telop";
import type { ClipRange, Telop } from "@/shared/types";

const hello: Telop = { startSec: 10, endSec: 13, text: "こんにちは" };
const world: Telop = { startSec: 12, endSec: 15, text: "世界" };
const blank: Telop = { startSec: 10, endSec: 13, text: "  " };

describe("assertValidTelops", () => {
  test("正しいテロップは通す", () => {
    expect(() => assertValidTelops([hello, world])).not.toThrow();
  });

  test("空文字の文言は通す (まだ書いていないテロップ)", () => {
    expect(() =>
      assertValidTelops([{ startSec: 0, endSec: 1, text: "" }]),
    ).not.toThrow();
  });

  test("終了が開始以下なら弾く", () => {
    // UI のバグ。黙って直すと、思っていたのと違う時間に出るテロップが焼き込まれる
    expect(() =>
      assertValidTelops([{ startSec: 5, endSec: 5, text: "a" }]),
    ).toThrow(RangeError);
  });

  test("負の開始は弾く", () => {
    expect(() =>
      assertValidTelops([{ startSec: -1, endSec: 2, text: "a" }]),
    ).toThrow(RangeError);
  });

  test("文言が文字列でなければ弾く", () => {
    expect(() =>
      assertValidTelops([
        { startSec: 0, endSec: 1, text: 3 } as unknown as Telop,
      ]),
    ).toThrow(TypeError);
  });
});

describe("activeTelops", () => {
  test("開始ちょうどは出し、終了ちょうどは出さない", () => {
    expect(activeTelops([hello], 10)).toEqual([hello]);
    expect(activeTelops([hello], 13)).toEqual([]);
  });

  test("空白だけの文言は出さない", () => {
    expect(activeTelops([blank], 11)).toEqual([]);
  });

  test("同時に出るものは作った順のまま返す", () => {
    // 下から積む順番がこれで決まる
    expect(activeTelops([world, hello], 12.5)).toEqual([world, hello]);
  });
});

describe("overlapsSegments", () => {
  const segments: ClipRange[] = [
    { startSec: 0, endSec: 5 },
    { startSec: 20, endSec: 30 },
  ];

  test("どれかの区間に一部でも重なれば真", () => {
    expect(overlapsSegments({ startSec: 4, endSec: 8, text: "a" }, segments)).toBe(true);
    expect(overlapsSegments({ startSec: 25, endSec: 26, text: "a" }, segments)).toBe(true);
  });

  test("区間の間にだけあれば偽", () => {
    expect(overlapsSegments({ startSec: 6, endSec: 19, text: "a" }, segments)).toBe(false);
  });

  test("端が接しているだけなら偽", () => {
    // 区間の終わりちょうどで始まるテロップは 1 フレームも出ない
    expect(overlapsSegments({ startSec: 5, endSec: 8, text: "a" }, segments)).toBe(false);
  });
});

describe("hasRenderableTelops", () => {
  const segments: ClipRange[] = [{ startSec: 10, endSec: 20 }];

  test("区間に重なる空でないテロップがあれば真", () => {
    expect(hasRenderableTelops([hello], segments)).toBe(true);
  });

  test("空白だけのテロップしか無ければ偽", () => {
    expect(hasRenderableTelops([blank], segments)).toBe(false);
  });

  test("区間外のテロップしか無ければ偽", () => {
    // canvas を挟む負荷を、録画に出ないテロップのために払わない
    expect(
      hasRenderableTelops([{ startSec: 30, endSec: 33, text: "a" }], segments),
    ).toBe(false);
  });

  test("テロップが無ければ偽", () => {
    expect(hasRenderableTelops([], segments)).toBe(false);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/telop.test.ts`
期待: FAIL (`Failed to resolve import "@/shared/telop"`)

- [ ] **Step 3: `Telop` 型を足す**

`src/shared/types.ts` の `ClipRange` の定義の直後に足す。

```typescript
/**
 * 動画に重ねる文字。
 *
 * **時刻は元動画の秒。出力タイムラインではない。** 区間を並べ替えたり縮めたり
 * してもテロップが発話に付いてくるようにするため (テロップ spec §0.1)。
 * 自動文字起こし (Phase 2) の出力もそのまま入れられる
 */
export type Telop = {
  startSec: number;
  endSec: number;
  /** 改行を含んでよい。空文字は「まだ書いていない」テロップで、描かない */
  text: string;
};
```

- [ ] **Step 4: `timeline.ts` の `assertValidRange` を export し、`toSourceTime` を消す**

`src/shared/timeline.ts` で `function assertValidRange(range: ClipRange): void {` を `export function assertValidRange(range: ClipRange): void {` に変える。

同じファイルの末尾の `toSourceTime` を、直前の JSDoc (`/** 出力タイムラインの \`outputSec\` 秒が、元動画の何秒に当たるか。…`) ごと削除する。

`tests/shared/timeline.test.ts` から `toSourceTime` の import と、`describe("toSourceTime", ...)` ブロック、および `toSourceTime` を呼んでいる残りのテスト (104〜106 行目付近。並べ替えた区間での変換を確かめているもの。囲んでいる `test(...)` ごと) を削除する。削除後に `grep -n toSourceTime tests src` が何も返さないことを確かめる。

- [ ] **Step 5: `shared/telop.ts` を作る**

```typescript
/**
 * テロップ (元動画の秒に付いた文字) に対する計算。
 *
 * **`content/` ではなく `shared/` に置く。** 検証は `reduce` (background) が、
 * 出すかどうかの判定は録画とプレビュー (content) が使う。
 */

import { assertValidRange } from "@/shared/timeline";
import type { ClipRange, Telop } from "@/shared/types";

/**
 * テロップとして成立しているか確かめる。
 *
 * **握り潰して直さない。** ここに不正な値が来るのは UI のバグであり、黙って
 * 補正すると、思っていたのと違う時間に出るテロップが焼き込まれる (区間と同じ方針)
 */
export function assertValidTelops(telops: Telop[]): void {
  for (const telop of telops) {
    assertValidRange(telop);
    if (typeof telop.text !== "string") {
      throw new TypeError(`テロップの文言が文字列ではありません: ${String(telop.text)}`);
    }
  }
}

/** 描く中身があるか。空白だけの文言は「まだ書いていない」扱い */
function hasText(telop: Telop): boolean {
  return telop.text.trim() !== "";
}

/**
 * `sourceSec` の時点で出すテロップ。作った順のまま返す (下から積む順番になる)。
 *
 * 開始ちょうどは出し、終了ちょうどは出さない。区間の `endSec` と同じ半開区間に
 * しておけば、続けて並べたテロップが 1 フレームだけ重なることがない
 */
export function activeTelops(telops: Telop[], sourceSec: number): Telop[] {
  return telops.filter(
    (telop) =>
      hasText(telop) && telop.startSec <= sourceSec && sourceSec < telop.endSec,
  );
}

/**
 * どれかの区間に一部でも重なるか。重ならなければ録画に 1 フレームも出ない。
 *
 * 端が接しているだけの場合は重ならないとみなす (半開区間なので出る瞬間が無い)
 */
export function overlapsSegments(telop: Telop, segments: ClipRange[]): boolean {
  return segments.some(
    (segment) =>
      telop.startSec < segment.endSec && segment.startSec < telop.endSec,
  );
}

/**
 * 録画に焼き込むテロップが 1 つでもあるか。
 *
 * **偽なら今の録画経路をそのまま使う。** canvas を挟むと描画の負荷とフレーム落ちの
 * 可能性が増えるので、要らないときに払わない (テロップ spec §4.1)
 */
export function hasRenderableTelops(
  telops: Telop[],
  segments: ClipRange[],
): boolean {
  return telops.some(
    (telop) => hasText(telop) && overlapsSegments(telop, segments),
  );
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/shared/telop.test.ts tests/shared/timeline.test.ts && npm run typecheck`
期待: PASS、型エラーなし

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/telop.ts src/shared/types.ts src/shared/timeline.ts tests/shared/telop.test.ts tests/shared/timeline.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(telop): テロップの型と判定を shared に置く

時刻は元動画の秒で持つ。区間を組み替えてもテロップが発話からずれない。
出力タイムラインで持つ前提で置いていた toSourceTime は使い道が無くなった
ので消す (使われない関数が誤った設計意図を語り続けないように)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 4: 状態機械にテロップを通す

**Files:**
- Modify: `src/shared/types.ts` (`ClipState` の全ての区間を持つ状態に `telops`、イベント 3 つ、失敗理由 `telop-render-failed`)
- Modify: `src/background/state.ts`
- Modify: `src/background/sw.ts` (`loadSnapshot` で `telops` を補う)
- Modify: `tests/background/state.test.ts`
- Modify: `tests/background/router.test.ts`, `tests/popup/view.test.ts`, `tests/content/youtube.test.ts`, `tests/shared/template.test.ts` ほか、`ClipState` を組み立てているテスト (型エラーと `toEqual` の不一致を直す)
- Create: `src/background/snapshot.ts` (スナップショットの補完を純粋関数にしてテストする)
- Create: `tests/background/snapshot.test.ts`

**Interfaces:**
- Consumes: `Telop`, `assertValidTelops` (Task 3)
- Produces:
  - `ClipState` の `ready` / `seeking` / `recording` / `encoding` / `preview` / `posted` / `composing` / `degraded` / `failed` に `telops: Telop[]`
  - `ClipEvent` に `{ type: "ADD_TELOP"; telop: Telop }` / `{ type: "UPDATE_TELOP"; index: number; telop: Telop }` / `{ type: "REMOVE_TELOP"; index: number }`
  - `FailureReason` に `"telop-render-failed"`、`FAILURE_MESSAGES["telop-render-failed"] = "テロップを動画に描けませんでした"`
  - `normalizeSnapshot(snapshot: RouterSnapshot | undefined): RouterSnapshot | undefined` (`@/background/snapshot`)

**進め方の注意:** 状態を組み立てる箇所は `reduce` に 20 近くある。**先に `telopsOf` と `readyWith` の引数を直し、次に各遷移を上から順に直す**。型エラーを手がかりにすれば漏れない。テストの `ClipState` リテラルにも `telops: []` を足す必要がある (約 170 箇所)。機械的な置換で済むが、**`toEqual` で比べている期待値にも忘れず足す**こと。

- [ ] **Step 1: 失敗するテストを書く (状態機械)**

`tests/background/state.test.ts` の末尾に足す。ファイル先頭の `ready` / `preview` の定義には、この後の Step 4 で `telops: []` を足す。

```typescript
describe("テロップ", () => {
  const telop: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
  const withTelop: ClipState = {
    kind: "ready",
    segments,
    meta,
    telops: [telop],
  };
  const postedWithTelop: ClipState = {
    kind: "posted",
    segments,
    meta,
    telops: [telop],
    clipId: "clip-1",
    mimeType: "video/mp4",
  };

  test("ready で足すと末尾に付く", () => {
    const next: Telop = { startSec: 15, endSec: 18, text: "" };
    expect(reduce(withTelop, { type: "ADD_TELOP", telop: next })).toEqual({
      ...withTelop,
      telops: [telop, next],
    });
  });

  test("UPDATE_TELOP は指したテロップを丸ごと差し替える", () => {
    const changed: Telop = { startSec: 12, endSec: 14, text: "やあ" };
    expect(
      reduce(withTelop, { type: "UPDATE_TELOP", index: 0, telop: changed }),
    ).toEqual({ ...withTelop, telops: [changed] });
  });

  test("REMOVE_TELOP で消える", () => {
    expect(reduce(withTelop, { type: "REMOVE_TELOP", index: 0 })).toEqual({
      ...withTelop,
      telops: [],
    });
  });

  test("posted で変えるとクリップが外れて ready に戻る", () => {
    // 焼き込まれているので、古いクリップを持ち続けると画面と投稿内容が食い違う
    expect(reduce(postedWithTelop, { type: "REMOVE_TELOP", index: 0 })).toEqual({
      kind: "ready",
      segments,
      meta,
      telops: [],
    });
  });

  test("preview / degraded / idle では受けない", () => {
    // 区間の編集も受けていない状態。テロップだけ触れる非対称を作らない
    const previewWithTelop: ClipState = {
      kind: "preview",
      clipId: "clip-1",
      segments,
      meta,
      telops: [telop],
      mimeType: "video/mp4",
    };
    const degraded: ClipState = {
      kind: "degraded",
      clipId: "clip-1",
      segments,
      meta,
      telops: [telop],
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    };
    for (const state of [previewWithTelop, degraded, INITIAL_STATE]) {
      expect(reduce(state, { type: "REMOVE_TELOP", index: 0 }).kind).toBe("failed");
    }
  });

  test("不正な index は internal-error", () => {
    const next = reduce(withTelop, { type: "REMOVE_TELOP", index: 3 });
    expect(next).toMatchObject({ kind: "failed", reason: "internal-error" });
  });

  test("不正な時刻は throw する (区間と同じく握り潰さない)", () => {
    expect(() =>
      reduce(withTelop, {
        type: "ADD_TELOP",
        telop: { startSec: 5, endSec: 5, text: "" },
      }),
    ).toThrow(RangeError);
  });

  test("録画中は受けない", () => {
    const recording: ClipState = { kind: "recording", segments, meta, telops: [telop] };
    expect(reduce(recording, { type: "REMOVE_TELOP", index: 0 }).kind).toBe("failed");
  });

  test("最後の区間を消して idle に戻るとテロップも消える", () => {
    expect(reduce(withTelop, { type: "REMOVE_SEGMENT", index: 0 })).toEqual({
      kind: "idle",
    });
  });

  test("区間の編集ではテロップを残す", () => {
    const next = reduce(withTelop, { type: "MARK_OUT", index: 0, sec: 50 });
    expect(next).toMatchObject({ kind: "ready", telops: [telop] });
  });

  test("同じ動画に区間を足してもテロップを残す", () => {
    const next = reduce(withTelop, {
      type: "ADD_SEGMENT",
      range: { startSec: 60, endSec: 70 },
      meta,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [telop] });
  });

  test("別の動画の区間を足すとテロップも消える", () => {
    // 元動画の秒で書いたテロップが、別の動画のクリップに焼き込まれるのを防ぐ
    const other = makeVideoMeta({ videoId: "other" });
    const next = reduce(withTelop, {
      type: "ADD_SEGMENT",
      range: { startSec: 60, endSec: 70 },
      meta: other,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [] });
  });

  test("MARK_IN は常にテロップを消す", () => {
    const next = reduce(withTelop, {
      type: "MARK_IN",
      range: { startSec: 60, endSec: 70 },
      meta,
    });
    expect(next).toMatchObject({ kind: "ready", telops: [] });
  });

  test("RESET_MARKS で消える", () => {
    expect(reduce(withTelop, { type: "RESET_MARKS" })).toEqual({ kind: "idle" });
  });

  test("録画から preview まで持ち回る", () => {
    let state = reduce(withTelop, { type: "START_RECORDING" });
    state = reduce(state, { type: "SEEK_DONE" });
    state = reduce(state, { type: "OUT_REACHED" });
    state = reduce(state, { type: "BLOB_READY", clipId: "c", mimeType: "video/mp4" });
    expect(state).toMatchObject({ kind: "preview", telops: [telop] });
  });

  test("failed から RETRY するとテロップを引き継ぐ", () => {
    const failed = reduce(withTelop, { type: "FAIL", reason: "telop-render-failed" });
    expect(failed).toMatchObject({ kind: "failed", telops: [telop] });
    expect(reduce(failed, { type: "RETRY" })).toEqual(withTelop);
  });
});
```

ファイル先頭の import を `import type { ClipRange, ClipState, Telop } from "@/shared/types";` に変える。

- [ ] **Step 2: 失敗するテストを書く (スナップショットの補完)**

`tests/background/snapshot.test.ts` を作る。

```typescript
import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import { normalizeSnapshot } from "@/background/snapshot";
import type { RouterSnapshot } from "@/background/router";

describe("normalizeSnapshot", () => {
  test("テロップを持たない古い状態には空配列を補う", () => {
    // 拡張の更新前に保存されたスナップショット。型検査なしで復元されるので、
    // 補わないと telops.map などで落ちる
    const old = {
      state: {
        kind: "ready",
        segments: [{ startSec: 1, endSec: 2 }],
        meta: makeVideoMeta(),
      },
      captureTabId: null,
      composeTabId: null,
    } as unknown as RouterSnapshot;

    expect(normalizeSnapshot(old)?.state).toMatchObject({ telops: [] });
  });

  test("テロップを持つ状態はそのまま", () => {
    const current: RouterSnapshot = {
      state: {
        kind: "ready",
        segments: [{ startSec: 1, endSec: 2 }],
        meta: makeVideoMeta(),
        telops: [{ startSec: 1, endSec: 2, text: "a" }],
      },
      captureTabId: null,
      composeTabId: null,
    };
    expect(normalizeSnapshot(current)).toEqual(current);
  });

  test("区間を持たない状態には足さない", () => {
    const idle: RouterSnapshot = {
      state: { kind: "idle" },
      captureTabId: null,
      composeTabId: null,
    };
    expect(normalizeSnapshot(idle)).toEqual(idle);
  });

  test("無ければ無いまま", () => {
    expect(normalizeSnapshot(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/background/state.test.ts tests/background/snapshot.test.ts`
期待: FAIL (型の不足と `@/background/snapshot` が無いこと)

- [ ] **Step 4: 型を直す**

`src/shared/types.ts` を次のように直す。

1. `ClipState` のうち `segments` を持つ全ての variant (`ready` / `seeking` / `recording` / `encoding` / `preview` / `posted` / `composing` / `degraded` / `failed`) に `telops: Telop[];` を `segments` の直後に足す。`ready` の上に次のコメントを 1 回だけ置く。

```typescript
  /**
   * `telops` は `segments` と同じ階層に置く (エディット spec §0.1 で予告していた形)。
   * 区間と違い、空配列でも `ready` になれる (テロップの無いクリップは普通)
   */
```

2. `FailureReason` の `"internal-error"` の直前に足す。

```typescript
  /**
   * テロップを描く canvas に動画を描けない。**テロップなしで録って続行しない。**
   * 実時間を払った後で「テロップが入っていない」と気付くことになる
   */
  | "telop-render-failed"
```

3. `FAILURE_MESSAGES` に足す。

```typescript
  "telop-render-failed": "テロップを動画に描けませんでした",
```

4. `ClipEvent` の `| { type: "RESET_MARKS" }` の直前に足す。

```typescript
  /** テロップを 1 つ足す。末尾に付く */
  | { type: "ADD_TELOP"; telop: Telop }
  /** 指したテロップを丸ごと差し替える。取りこぼしでずれないよう常に全項目を送る */
  | { type: "UPDATE_TELOP"; index: number; telop: Telop }
  | { type: "REMOVE_TELOP"; index: number }
```

- [ ] **Step 5: `state.ts` を直す**

`src/background/state.ts` を次のように直す。

import を差し替える。

```typescript
import {
  BUSY_KINDS,
  type ClipEvent,
  type ClipRange,
  type ClipState,
  type Telop,
  type VideoMeta,
} from "@/shared/types";
import { assertValidTelops } from "@/shared/telop";
import { assertValidSegments } from "@/shared/timeline";
```

`metaOf` の直後に足す。

```typescript
/** 状態が持っているテロップを取り出す。持たない状態では空配列 */
function telopsOf(state: ClipState): Telop[] {
  return "telops" in state ? state.telops : [];
}
```

`invalid` の返り値に `telops: telopsOf(state),` を足す。

`readyWith` を差し替える。

```typescript
function readyWith(
  segments: ClipRange[],
  meta: VideoMeta,
  telops: Telop[],
): ClipState {
  assertValidSegments(segments);
  assertValidTelops(telops);
  // 区間が 0 個の ready は録画に進めない死に状態なので作らない。
  // **テロップもここで消える。** `idle` は何も持たない。手入力の文言を ✕ 1 回で
  // 失わないよう、最後の区間の削除は UI 側で止めている (テロップ spec §2.2)
  if (segments.length === 0) return { kind: "idle" };
  return { kind: "ready", segments, meta, telops };
}
```

`editSegments` の引数に `telops: Telop[]` を `meta` の後に足し、中の 3 つの `readyWith(..., meta)` を `readyWith(..., meta, telops)` にする。

`isEditEvent` の直後に足す。

```typescript
/**
 * テロップを編集する 3 イベントを処理する。処理しないイベントなら null。
 *
 * 区間の編集と同じく `ready` と `posted` だけが受ける。`posted` から受けたときは
 * クリップが外れる (焼き込まれているので、古いクリップと画面が食い違う)
 */
function editTelops(
  segments: ClipRange[],
  meta: VideoMeta,
  telops: Telop[],
  event: ClipEvent,
): ClipState | null {
  if (event.type === "ADD_TELOP") {
    return readyWith(segments, meta, [...telops, event.telop]);
  }
  if (event.type === "UPDATE_TELOP") {
    if (!hasIndex(telops, event.index)) return null;
    return readyWith(
      segments,
      meta,
      telops.map((telop, index) => (index === event.index ? event.telop : telop)),
    );
  }
  if (event.type === "REMOVE_TELOP") {
    if (!hasIndex(telops, event.index)) return null;
    return readyWith(
      segments,
      meta,
      telops.filter((_, index) => index !== event.index),
    );
  }
  return null;
}

/** テロップを編集するイベントか。index が不正でも true (invalid に落とすため) */
function isTelopEvent(event: ClipEvent): boolean {
  return (
    event.type === "ADD_TELOP" ||
    event.type === "UPDATE_TELOP" ||
    event.type === "REMOVE_TELOP"
  );
}
```

`hasIndex` の型を `function hasIndex(items: readonly unknown[], index: number): boolean` にし、中の `segments.length` を `items.length` にする。

`reduce` の中を直す。

- `FAIL`: 返り値に `telops: telopsOf(state),` を足す
- `MARK_IN`: `return readyWith([event.range], event.meta, []);` (直前に `// シンプルモードの「区間を丸ごと置き換える」操作。テロップも持ち越さない` のコメント)
- `ADD_SEGMENT` の別動画の分岐: `return readyWith([event.range], event.meta, []);` 同じ動画: `return readyWith([...segmentsOf(state), event.range], event.meta, telopsOf(state));`
- `case "ready"`: `isEditEvent` の分岐を `editSegments(state.segments, state.meta, state.telops, event)` にし、その直後に足す

```typescript
      if (isTelopEvent(event)) {
        return (
          editTelops(state.segments, state.meta, state.telops, event) ??
          invalid(state)
        );
      }
```

- `case "posted"`: `ready` と同じく `editSegments` に `state.telops` を渡し、`isTelopEvent` の分岐を足す
- その他の全ての遷移で、`{ kind: ..., segments: state.segments, meta: state.meta, ... }` を組み立てている箇所に `telops: state.telops,` を足す (`seeking` / `recording` / `encoding` / `preview` / `composing` / `degraded` / `failed` の `RETRY`)

- [ ] **Step 6: `snapshot.ts` を作り、`sw.ts` から使う**

`src/background/snapshot.ts` を作る。

```typescript
import type { RouterSnapshot } from "@/background/router";

/**
 * 保存されていたスナップショットを今の形に揃える。
 *
 * **`chrome.storage.session` の中身は型を保証しない。** 拡張の更新前に保存された
 * 状態は `telops` を持たない。`storage.session` は更新で消える見込みだが、
 * 消えなかったときに `telops.map` で落ちると、操作がすべて止まる
 */
export function normalizeSnapshot(
  snapshot: RouterSnapshot | undefined,
): RouterSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  const state = snapshot.state;
  if (!("segments" in state) || "telops" in state) return snapshot;
  return {
    ...snapshot,
    // 型の上では telops を持つはずの値を直すので、unknown を経由して戻す
    state: {
      ...(state as Record<string, unknown>),
      telops: [],
    } as unknown as RouterSnapshot["state"],
  };
}
```

`src/background/sw.ts` の `loadSnapshot` を差し替える。

```typescript
async function loadSnapshot(): Promise<RouterSnapshot | undefined> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return normalizeSnapshot(stored[SESSION_KEY] as RouterSnapshot | undefined);
}
```

import に `import { normalizeSnapshot } from "@/background/snapshot";` を足す。

- [ ] **Step 7: 既存テストの `ClipState` に `telops: []` を足す**

`npm run typecheck` を実行し、`Property 'telops' is missing` が出た箇所すべてに `telops: []` を足す (`segments` の直後)。型エラーが出ない `toEqual` の期待値 (オブジェクトリテラルを `ClipState` と注釈せずに書いている箇所) は、次の Step の `npm test` の失敗で拾う。

`tests/content/youtube.test.ts` など、テスト内で `reduce` を使って service worker 役を作っているファイルは、`swState` の初期値や手組みの状態にも足すこと。

- [ ] **Step 8: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add -A src tests
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(state): 状態機械にテロップを通す

区間と同じ階層に telops を置き、区間の編集と同じく ready / posted でだけ
受ける。preview / degraded で受けると、区間は触れないのにテロップだけ触れる
非対称ができる。別の動画で区間を作り直したときは、元動画の秒で書いた
テロップが別の動画に焼き込まれないよう消す。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 5: テロップの見た目を設定に足す

**Files:**
- Create: `src/shared/telop-style.ts`
- Modify: `src/shared/settings.ts`
- Modify: `src/content/settings-panel.ts`
- Create: `tests/shared/telop-style.test.ts`
- Modify: `tests/shared/settings.test.ts`
- Modify: `tests/content/settings-panel.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `Settings` の `telopFontSizePx: number` / `telopFont: string` / `telopFillColor: string` / `telopStrokeColor: string` / `telopStrokeWidthPx: number`
  - `type TelopStyle = { fontSizePx: number; fontFamily: string; fillColor: string; strokeColor: string; strokeWidthPx: number }` (`@/shared/telop-style`)
  - `TELOP_FONT_PRESETS: readonly { label: string; family: string }[]` (`@/shared/telop-style`)
  - `expandFontFamily(font: string): string` (`@/shared/telop-style`)
  - `telopStyleOf(settings: Settings): TelopStyle` (`@/shared/telop-style`)
  - `FieldControl` に `{ kind: "text"; suggestions?: readonly string[] }` と `{ kind: "color" }`
  - `createFieldExtras(field: SettingsField): HTMLElement[]` (`@/content/settings-panel`)

- [ ] **Step 1: 失敗するテストを書く (見た目の組み立て)**

`tests/shared/telop-style.test.ts` を作る。

```typescript
import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import {
  TELOP_FONT_PRESETS,
  expandFontFamily,
  telopStyleOf,
} from "@/shared/telop-style";

describe("expandFontFamily", () => {
  test("プリセットの表示名は font-family に展開する", () => {
    const gothic = TELOP_FONT_PRESETS[0];
    expect(gothic?.label).toBe("ゴシック");
    expect(expandFontFamily("ゴシック")).toBe(gothic?.family);
    expect(expandFontFamily("明朝")).toContain("serif");
  });

  test("それ以外はフォント名として引用符で囲み、ゴシック系に落とす", () => {
    expect(expandFontFamily("Klee One")).toBe('"Klee One", sans-serif');
  });

  test("前後の空白は落とす", () => {
    expect(expandFontFamily("  Klee One ")).toBe('"Klee One", sans-serif');
  });
});

describe("telopStyleOf", () => {
  test("既定の設定から既定の見た目を作る", () => {
    expect(telopStyleOf(DEFAULT_SETTINGS)).toEqual({
      fontSizePx: 64,
      fontFamily: TELOP_FONT_PRESETS[0]?.family,
      fillColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidthPx: 8,
    });
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (設定)**

`tests/shared/settings.test.ts` の末尾に足す。先頭の import に `parseTelopFont` / `parseTelopFontSize` / `parseTelopStrokeWidth` / `parseColor` を足す。

```typescript
describe("テロップの見た目", () => {
  test("既定値", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      telopFontSizePx: 64,
      telopFont: "ゴシック",
      telopFillColor: "#ffffff",
      telopStrokeColor: "#000000",
      telopStrokeWidthPx: 8,
    });
  });

  test("読み込み時の範囲外・型違い・不正な色は既定値に倒す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeSettings({
      telopFontSizePx: 999,
      telopFont: 'bad"name',
      telopFillColor: "red",
      telopStrokeColor: 3,
      telopStrokeWidthPx: -1,
    });
    expect(merged).toMatchObject({
      telopFontSizePx: 64,
      telopFont: "ゴシック",
      telopFillColor: "#ffffff",
      telopStrokeColor: "#000000",
      telopStrokeWidthPx: 8,
    });
    // 黙って落とさない
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  test("正しい値は採る", () => {
    expect(
      mergeSettings({
        telopFontSizePx: 100,
        telopFont: "Klee One",
        telopFillColor: "#ffcc00",
        telopStrokeColor: "#112233",
        telopStrokeWidthPx: 0,
      }),
    ).toMatchObject({
      telopFontSizePx: 100,
      telopFont: "Klee One",
      telopFillColor: "#ffcc00",
      telopStrokeColor: "#112233",
      telopStrokeWidthPx: 0,
    });
  });

  test("文字サイズの入力は 16〜200 の整数だけ通す", () => {
    expect(parseTelopFontSize("48")).toEqual({ ok: true, patch: { telopFontSizePx: 48 } });
    expect(parseTelopFontSize("15").ok).toBe(false);
    expect(parseTelopFontSize("201").ok).toBe(false);
    expect(parseTelopFontSize("4.5").ok).toBe(false);
    expect(parseTelopFontSize("").ok).toBe(false);
  });

  test("縁取りの太さの入力は 0〜40 の整数だけ通す", () => {
    expect(parseTelopStrokeWidth("0")).toEqual({ ok: true, patch: { telopStrokeWidthPx: 0 } });
    expect(parseTelopStrokeWidth("41").ok).toBe(false);
    expect(parseTelopStrokeWidth("-1").ok).toBe(false);
  });

  test("フォント名は空と引用符・バックスラッシュ・セミコロンを弾く", () => {
    // 引用符が混ざると font の指定全体が不正になり、代入が黙って無視される
    // (大きさまで既定の 10px のまま録画される)
    expect(parseTelopFont(" Klee One ")).toEqual({ ok: true, patch: { telopFont: "Klee One" } });
    expect(parseTelopFont("").ok).toBe(false);
    expect(parseTelopFont('a"b').ok).toBe(false);
    expect(parseTelopFont("a'b").ok).toBe(false);
    expect(parseTelopFont("a\\b").ok).toBe(false);
    expect(parseTelopFont("a;b").ok).toBe(false);
  });

  test("カンマは弾かない (候補が 2 つになるだけで壊れない)", () => {
    expect(parseTelopFont("Klee One, Meiryo").ok).toBe(true);
  });

  test("色は #rrggbb だけを小文字にして通す", () => {
    expect(parseColor("telopFillColor", "#FFCC00")).toEqual({
      ok: true,
      patch: { telopFillColor: "#ffcc00" },
    });
    expect(parseColor("telopFillColor", "red").ok).toBe(false);
    expect(parseColor("telopFillColor", "#fff").ok).toBe(false);
  });

  test("画面にはモードに関わらず 5 項目が出る", () => {
    const keys = SETTINGS_FIELDS.map((field) => field.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "telopFontSizePx",
        "telopFont",
        "telopFillColor",
        "telopStrokeColor",
        "telopStrokeWidthPx",
      ]),
    );
  });
});
```

- [ ] **Step 3: 失敗するテストを書く (設定パネル)**

`tests/content/settings-panel.test.ts` の末尾に足す。

```typescript
describe("テロップの見た目", () => {
  test("色の項目は色の入力欄になる", () => {
    const field = SETTINGS_FIELDS.find((f) => f.key === "telopFillColor");
    if (field === undefined) throw new Error("項目がありません");
    const input = createFieldInput(field) as HTMLInputElement;
    expect(input.type).toBe("color");
  });

  test("フォントの項目は候補付きのテキスト欄になる", () => {
    const panel = createSettingsPanel(makeDeps().deps);
    const input = inputOf(panel, "telopFont");
    expect(input.type).toBe("text");
    const listId = input.getAttribute("list");
    expect(listId).not.toBeNull();
    const datalist = panel.element.querySelector(`#${listId ?? ""}`);
    const values = [...(datalist?.querySelectorAll("option") ?? [])].map(
      (option) => option.value,
    );
    expect(values).toEqual(["ゴシック", "明朝", "丸ゴシック"]);
  });

  test("テロップの 2 項目を同時に変えても両方が保存される", async () => {
    // 1 つのオブジェクトにまとめると、浅いマージで後の項目が前の項目を消す
    const { deps, store } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    inputOf(panel, "telopFontSizePx").value = "80";
    inputOf(panel, "telopStrokeColor").value = "#112233";
    saveButton(panel).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.telopFontSizePx).toBe(80);
    expect(store.telopStrokeColor).toBe("#112233");
  });
});
```

- [ ] **Step 4: 実行して失敗を確認**

実行: `npx vitest run tests/shared/telop-style.test.ts tests/shared/settings.test.ts tests/content/settings-panel.test.ts`
期待: FAIL

- [ ] **Step 5: `telop-style.ts` を作る**

```typescript
/**
 * テロップの見た目。設定 (`Settings`) から描画側が使う形を組み立てる。
 *
 * **`shared/` の純粋関数にする。** プレビューと録画開始の両方が呼ぶ。
 * フォントが受け付けられたかの検証は canvas が要るので、描画側 (`content/`) で行う
 */

import type { Settings } from "@/shared/settings";

/** 描画側が受け取る形。フォントは展開済みの font-family */
export type TelopStyle = {
  /** 1080 px 基準。実際は動画の高さに比例させる */
  fontSizePx: number;
  fontFamily: string;
  fillColor: string;
  strokeColor: string;
  /** 1080 px 基準。0 で縁取りなし */
  strokeWidthPx: number;
};

/**
 * フォントのプリセット。**先頭が既定で、代わりのフォントにも使う。**
 *
 * Web フォントは同梱しない (日本語は 1 書体で数 MB あり、拡張が一桁重くなる)。
 * Mac / Windows の標準フォントを順に探し、無ければ総称に落とす
 */
export const TELOP_FONT_PRESETS = [
  {
    label: "ゴシック",
    family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif',
  },
  { label: "明朝", family: '"Hiragino Mincho ProN", "Yu Mincho", serif' },
  {
    label: "丸ゴシック",
    family: '"Hiragino Maru Gothic ProN", "BIZ UDGothic", sans-serif',
  },
] as const satisfies readonly { label: string; family: string }[];

/**
 * 設定のフォントを font-family にする。
 *
 * プリセットの表示名ならその font-family、それ以外はフォント名とみなして
 * ゴシック系に落とす。**名前で指定するだけなら権限は要らない** (Local Font Access
 * が要るのは列挙するときだけ)。表示名を変えると保存済みの値はフォント名扱いに
 * なるが、`sans-serif` に落ちるだけで壊れない
 */
export function expandFontFamily(font: string): string {
  const name = font.trim();
  const preset = TELOP_FONT_PRESETS.find((candidate) => candidate.label === name);
  if (preset !== undefined) return preset.family;
  return `"${name}", sans-serif`;
}

/** `mergeSettings` を通った設定から見た目を組み立てる */
export function telopStyleOf(settings: Settings): TelopStyle {
  return {
    fontSizePx: settings.telopFontSizePx,
    fontFamily: expandFontFamily(settings.telopFont),
    fillColor: settings.telopFillColor,
    strokeColor: settings.telopStrokeColor,
    strokeWidthPx: settings.telopStrokeWidthPx,
  };
}
```

- [ ] **Step 6: `settings.ts` に 5 項目を足す**

`src/shared/settings.ts` を直す。

import に足す。

```typescript
import { TELOP_FONT_PRESETS } from "@/shared/telop-style";
```

`Settings` 型の `mode` の後に足す。

```typescript
  // テロップの見た目。**5 つの平坦なキーで持つ。** 1 つのオブジェクトにまとめると、
  // 設定パネルの保存 (項目ごとの差分を浅く重ねる) で後の項目が前の項目を消す
  /** テロップの文字の大きさ。動画の高さ 1080 px を基準にした px */
  telopFontSizePx: number;
  /** フォント。プリセットの表示名か、font-family に渡す名前 */
  telopFont: string;
  /** 文字の色 (#rrggbb) */
  telopFillColor: string;
  /** 縁取りの色 (#rrggbb) */
  telopStrokeColor: string;
  /** 縁取りの太さ。1080 px 基準。0 で縁取りなし */
  telopStrokeWidthPx: number;
```

`DEFAULT_SETTINGS` に足す。

```typescript
  telopFontSizePx: 64,
  telopFont: TELOP_FONT_PRESETS[0].label,
  telopFillColor: "#ffffff",
  telopStrokeColor: "#000000",
  telopStrokeWidthPx: 8,
```

`parseMode` の後に足す。

```typescript
/** テロップの文字の大きさとして設定できる範囲 (1080 px 基準) */
export const TELOP_FONT_SIZE_RANGE = { min: 16, max: 200 } as const;
/** 縁取りの太さとして設定できる範囲 (1080 px 基準) */
export const TELOP_STROKE_WIDTH_RANGE = { min: 0, max: 40 } as const;

/** 範囲内の整数か。読み込みと入力の両方で使う */
function isIntegerIn(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/**
 * 整数の入力欄を差分にする。**範囲外は弾く。** 既定値に倒すのは読み込み側だけ
 * (`parseMaxClipSec` と同じ。設定したつもりで録画に進ませない)
 */
function parseIntegerField(
  input: string,
  label: string,
  range: { min: number; max: number },
  toPatch: (value: number) => Partial<Settings>,
): FieldResult {
  const text = input.trim();
  if (text === "") return { ok: false, message: `${label}を入れてください` };
  const value = Number(text);
  if (!isIntegerIn(value, range)) {
    return {
      ok: false,
      message: `${label}は ${range.min}〜${range.max} の整数です: ${text}`,
    };
  }
  return { ok: true, patch: toPatch(value) };
}

export function parseTelopFontSize(input: string): FieldResult {
  return parseIntegerField(input, "文字サイズ", TELOP_FONT_SIZE_RANGE, (value) => ({
    telopFontSizePx: value,
  }));
}

export function parseTelopStrokeWidth(input: string): FieldResult {
  return parseIntegerField(
    input,
    "縁取りの太さ",
    TELOP_STROKE_WIDTH_RANGE,
    (value) => ({ telopStrokeWidthPx: value }),
  );
}

/** font の指定を壊す文字。引用符が混ざると `ctx.font` への代入が黙って無視される */
const FONT_NAME_FORBIDDEN = /["'\\;]/u;

/** 保存されている値がフォント名として使えるか */
function isFontName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !FONT_NAME_FORBIDDEN.test(value)
  );
}

/**
 * フォントの入力欄を差分にする。
 *
 * **手元に無いフォントかは調べない。** `document.fonts.check()` はシステムフォントに
 * 常に真を返すので判定に使えない。代わりのフォントで描かれたことはプレビューで見える。
 * `,` は弾かない (ファミリの区切りとして読まれ、候補が 2 つになるだけ)
 */
export function parseTelopFont(input: string): FieldResult {
  const name = input.trim();
  if (name === "") return { ok: false, message: "フォントを入れてください" };
  if (!isFontName(name)) {
    return {
      ok: false,
      message: `フォント名に使えない文字が入っています (" ' \\ ;): ${name}`,
    };
  }
  return { ok: true, patch: { telopFont: name } };
}

/** `input type="color"` が返す形。これ以外は受け付けない */
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** 色の入力欄を差分にする。小文字に揃えて保存する */
export function parseColor(
  key: "telopFillColor" | "telopStrokeColor",
  input: string,
): FieldResult {
  const text = input.trim();
  if (!isHexColor(text)) {
    return { ok: false, message: `色は #rrggbb の形で入れてください: ${text}` };
  }
  return { ok: true, patch: { [key]: text.toLowerCase() } };
}
```

`mergeSettings` の `mode` の処理の後、`return settings;` の前に足す。

```typescript
  // テロップの見た目。どれも同じ作法: 型の合う値だけ採り、合わなければ理由を残す
  const telopFields = [
    ["telopFontSizePx", (v: unknown) => isIntegerIn(v, TELOP_FONT_SIZE_RANGE)],
    ["telopFont", isFontName],
    ["telopFillColor", isHexColor],
    ["telopStrokeColor", isHexColor],
    ["telopStrokeWidthPx", (v: unknown) => isIntegerIn(v, TELOP_STROKE_WIDTH_RANGE)],
  ] as const;
  for (const [key, accepts] of telopFields) {
    const value = source[key];
    if (accepts(value)) {
      Object.assign(settings, {
        [key]: typeof value === "string" && key !== "telopFont" ? value.toLowerCase() : value,
      });
    } else if (value !== undefined) {
      console.warn(
        `[yt-clip] 保存された ${key} が使えないため既定値を使います: ${String(value)}`,
      );
    }
  }
```

`FieldControl` を差し替える。

```typescript
export type FieldControl =
  /** `suggestions` があれば候補として出す。候補以外も書ける */
  | { kind: "text"; suggestions?: readonly string[] }
  | { kind: "select"; options: readonly SelectOption[] }
  /** `#rrggbb` の文字列で往復する */
  | { kind: "color" };
```

`SETTINGS_FIELDS` の末尾 (`maxClipSec` の後) に 5 要素足す。

```typescript
  // テロップの見た目。**モードに関わらず常に出す。** パネルには項目をモードで
  // 出し分ける仕組みが無く、モード自体が同じパネルの未保存の選択肢なので、
  // 出し分けると選び直した瞬間に項目が出入りする処理まで要る
  {
    key: "telopFontSizePx",
    label: "テロップの文字サイズ",
    scope: "global",
    control: { kind: "text" },
    hint: () =>
      `エディットモードのテロップに使う。${TELOP_FONT_SIZE_RANGE.min}〜${TELOP_FONT_SIZE_RANGE.max} (1080p で見たときの px)`,
    toText: (settings) => String(settings.telopFontSizePx),
    fromText: (text) => parseTelopFontSize(text),
  },
  {
    key: "telopFont",
    label: "テロップのフォント",
    scope: "global",
    control: {
      kind: "text",
      suggestions: TELOP_FONT_PRESETS.map((preset) => preset.label),
    },
    hint: () =>
      "エディットモードのテロップに使う。候補から選ぶか、手元にあるフォントの名前を書く (無ければ代わりのフォントで描く)",
    toText: (settings) => settings.telopFont,
    fromText: (text) => parseTelopFont(text),
  },
  {
    key: "telopFillColor",
    label: "テロップの文字の色",
    scope: "global",
    control: { kind: "color" },
    hint: () => "エディットモードのテロップに使う",
    toText: (settings) => settings.telopFillColor,
    fromText: (text) => parseColor("telopFillColor", text),
  },
  {
    key: "telopStrokeColor",
    label: "テロップの縁取りの色",
    scope: "global",
    control: { kind: "color" },
    hint: () => "エディットモードのテロップに使う",
    toText: (settings) => settings.telopStrokeColor,
    fromText: (text) => parseColor("telopStrokeColor", text),
  },
  {
    key: "telopStrokeWidthPx",
    label: "テロップの縁取りの太さ",
    scope: "global",
    control: { kind: "text" },
    hint: () =>
      `エディットモードのテロップに使う。${TELOP_STROKE_WIDTH_RANGE.min}〜${TELOP_STROKE_WIDTH_RANGE.max}、0 で縁取りなし (1080p で見たときの px)`,
    toText: (settings) => String(settings.telopStrokeWidthPx),
    fromText: (text) => parseTelopStrokeWidth(text),
  },
```

- [ ] **Step 7: パネルが色と候補を出せるようにする**

`src/content/settings-panel.ts` の `createFieldInput` の、`const input = document.createElement("input");` 以降を差し替える。

```typescript
  const input = document.createElement("input");
  input.id = id;
  input.type = field.control.kind === "color" ? "color" : "text";
  input.style.cssText = PANEL_STYLE.input;
  if (field.control.kind === "text" && field.control.suggestions !== undefined) {
    // 候補の箱は `createFieldExtras` が作る。id の決め方をここと揃える
    input.setAttribute("list", `${id}-suggestions`);
  }
  return input;
}

/**
 * 入力欄の隣に置く要素。いまは候補の `datalist` だけ。
 *
 * **`createFieldInput` の返り値を変えない。** 入力欄として振る舞う要素を 1 つ返す
 * 形はテストと保存処理が前提にしている。候補の箱は DOM に置かないと効かないので、
 * パネルが入力欄と並べて置く
 */
export function createFieldExtras(field: SettingsField): HTMLElement[] {
  if (field.control.kind !== "text" || field.control.suggestions === undefined) {
    return [];
  }
  const datalist = document.createElement("datalist");
  datalist.id = `yt-clip-setting-${field.key}-suggestions`;
  datalist.append(
    ...field.control.suggestions.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
  return [datalist];
}
```

`createSettingsPanel` の行の組み立てで、`wrapper.append(label, input, hint);` を `wrapper.append(label, input, ...createFieldExtras(field), hint);` にする。

- [ ] **Step 8: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS (既存の `mergeSettings` のテストで `DEFAULT_SETTINGS` と `toEqual` しているものは、5 項目が増えても `DEFAULT_SETTINGS` 経由なら通る。手書きの期待値で比べている箇所があれば 5 項目を足す)

- [ ] **Step 9: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/shared/telop-style.ts src/shared/settings.ts src/content/settings-panel.ts tests/shared/telop-style.test.ts tests/shared/settings.test.ts tests/content/settings-panel.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(settings): テロップの見た目を 5 項目の設定にする

1 つのオブジェクトにまとめると、パネルの保存 (項目ごとの差分を浅く重ねる)
で後の項目が前の項目を消すので、平坦なキーで持つ。フォントはプリセットに
加えて名前を書ける。名前で指定するだけなら権限は要らない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 6: テロップを描く関数を作る

**Files:**
- Create: `src/content/telop-render.ts`
- Create: `tests/content/telop-render.test.ts`

**Interfaces:**
- Consumes: `Telop`, `activeTelops` (Task 3)、`TelopStyle`, `TELOP_FONT_PRESETS` (Task 5)
- Produces:
  - `TELOP_BASE_HEIGHT = 1080`
  - `layoutTelops(texts: string[], width: number, height: number, fontSizePx: number): TelopLine[]` / `type TelopLine = { text: string; x: number; y: number }`
  - `resolveTelopStyle(ctx: CanvasRenderingContext2D, style: TelopStyle): TelopStyle`
  - `drawTelops(ctx: CanvasRenderingContext2D, telops: Telop[], sourceSec: number, style: TelopStyle, width: number, height: number): void`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/telop-render.test.ts` を作る。canvas は jsdom で描けないので `ctx` はモックにする。

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  drawTelops,
  layoutTelops,
  resolveTelopStyle,
} from "@/content/telop-render";
import { TELOP_FONT_PRESETS, type TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};

/**
 * CanvasRenderingContext2D のモック。呼ばれた順を記録する。
 *
 * `font` は実物と同じく、**不正な指定の代入を黙って無視する** (ここでは "BROKEN" を
 * 含むものを不正とみなす)。読み戻しは正規化した値を返すので、代入した文字列とは
 * 一致しないことも再現する
 */
function makeContext() {
  const calls: string[] = [];
  let font = "10px sans-serif";
  const ctx = {
    calls,
    get font(): string {
      return font;
    },
    set font(value: string) {
      if (value.includes("BROKEN")) return;
      font = `normalized(${value})`;
    },
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    lineWidth: 0,
    fillStyle: "",
    strokeStyle: "",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    strokeText: (text: string, x: number, y: number) =>
      calls.push(`stroke:${text}@${x},${y}`),
    fillText: (text: string, x: number, y: number) =>
      calls.push(`fill:${text}@${x},${y}`),
  };
  return ctx;
}

describe("layoutTelops", () => {
  test("1 行は下中央、下端から高さの 8% 空けた位置に置く", () => {
    expect(layoutTelops(["a"], 1920, 1080, 64)).toEqual([
      { text: "a", x: 960, y: 1080 - 1080 * 0.08 },
    ]);
  });

  test("改行で行を分け、行間は文字サイズの 1.2 倍", () => {
    const lines = layoutTelops(["上\n下"], 1920, 1080, 100);
    const bottom = 1080 - 1080 * 0.08;
    expect(lines).toEqual([
      { text: "上", x: 960, y: bottom - 120 },
      { text: "下", x: 960, y: bottom },
    ]);
  });

  test("複数のテロップは作った順に下から積む", () => {
    const lines = layoutTelops(["先", "後"], 1920, 1080, 100);
    const bottom = 1080 - 1080 * 0.08;
    expect(lines).toEqual([
      { text: "先", x: 960, y: bottom },
      { text: "後", x: 960, y: bottom - 120 },
    ]);
  });

  test("大きさは動画の高さに比例する (1080 基準)", () => {
    // 540p では 1080p の半分の大きさで、見た目の比率が同じになる
    const lines = layoutTelops(["上\n下"], 960, 540, 100);
    const bottom = 540 - 540 * 0.08;
    expect(lines[0]?.y).toBeCloseTo(bottom - 60);
  });
});

describe("resolveTelopStyle", () => {
  test("受け付けられた指定はそのまま使う", () => {
    // 読み戻しが代入した文字列と一致しなくても (正規化されても) 採用する
    const ctx = makeContext();
    const resolved = resolveTelopStyle(
      ctx as unknown as CanvasRenderingContext2D,
      { ...STYLE, fontFamily: '"Klee One", sans-serif' },
    );
    expect(resolved.fontFamily).toBe('"Klee One", sans-serif');
  });

  test("無視された指定はゴシックに倒して理由を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = makeContext();
    const resolved = resolveTelopStyle(
      ctx as unknown as CanvasRenderingContext2D,
      { ...STYLE, fontFamily: "BROKEN" },
    );
    expect(resolved.fontFamily).toBe(TELOP_FONT_PRESETS[0].family);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("drawTelops", () => {
  const telop: Telop = { startSec: 10, endSec: 13, text: "こんにちは" };

  test("縁取りを先に、文字を後に描く", () => {
    // 逆にすると文字の内側が縁に食われる
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080);
    const drawn = ctx.calls.filter((call) => call !== "save" && call !== "restore");
    expect(drawn[0]).toMatch(/^stroke:こんにちは/u);
    expect(drawn[1]).toMatch(/^fill:こんにちは/u);
  });

  test("線の太さは縁取りの 2 倍 × 倍率、角は丸める", () => {
    // 線は輪郭の両側に乗るので 2 倍
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 960, 540);
    expect(ctx.lineWidth).toBe(8 * 2 * 0.5);
    expect(ctx.lineJoin).toBe("round");
  });

  test("縁取りの太さが 0 なら縁取りを描かない", () => {
    const ctx = makeContext();
    drawTelops(
      ctx as unknown as CanvasRenderingContext2D,
      [telop],
      11,
      { ...STYLE, strokeWidthPx: 0 },
      1920,
      1080,
    );
    expect(ctx.calls.some((call) => call.startsWith("stroke:"))).toBe(false);
  });

  test("出す時間でなければ何も描かない", () => {
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 20, STYLE, 1920, 1080);
    expect(ctx.calls).toEqual([]);
  });

  test("描いた後は ctx の設定を戻す", () => {
    // 録画ではこの後に次のフレームの drawImage が来る。設定を残すと影響する
    const ctx = makeContext();
    drawTelops(ctx as unknown as CanvasRenderingContext2D, [telop], 11, STYLE, 1920, 1080);
    expect(ctx.calls[0]).toBe("save");
    expect(ctx.calls.at(-1)).toBe("restore");
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-render.test.ts`
期待: FAIL (`Failed to resolve import "@/content/telop-render"`)

- [ ] **Step 3: 最小実装**

`src/content/telop-render.ts` を作る。

```typescript
/**
 * テロップを canvas に描く。
 *
 * **プレビューも録画もこの関数で描く。** 画面では CSS、録画では canvas と別の手段で
 * 描くと、縁取りの付き方や行間が微妙に違い、プレビューで見たものと違うクリップができる
 * (テロップ spec §3.1)
 */

import { activeTelops } from "@/shared/telop";
import { TELOP_FONT_PRESETS, type TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

/** 大きさの基準にする動画の高さ。設定の px はこの高さで見たときの大きさ */
export const TELOP_BASE_HEIGHT = 1080;
/** 下端から空ける割合 (高さに対して) */
const BOTTOM_MARGIN_RATIO = 0.08;
/** 行間 (文字サイズに対して) */
const LINE_HEIGHT_RATIO = 1.2;
/** テロップとして読める太さ。細字を選ぶ要望は無いので固定する */
const FONT_WEIGHT = 700;

export type TelopLine = {
  text: string;
  /** 行の中央 */
  x: number;
  /** 行の下端 (`textBaseline = "bottom"`) */
  y: number;
};

function fontOf(family: string, sizePx: number): string {
  return `${FONT_WEIGHT} ${sizePx}px ${family}`;
}

/**
 * 行の位置を決める。**作った順に下から積む。** 1 つのテロップの中の行は上から下。
 *
 * 自動折り返しはしない。日本語の禁則まで含めると重く、Phase 1 では手で改行してもらう
 */
export function layoutTelops(
  texts: string[],
  width: number,
  height: number,
  fontSizePx: number,
): TelopLine[] {
  const lineHeight = fontSizePx * (height / TELOP_BASE_HEIGHT) * LINE_HEIGHT_RATIO;
  const x = width / 2;
  let bottom = height - height * BOTTOM_MARGIN_RATIO;
  const lines: TelopLine[] = [];

  for (const text of texts) {
    const rows = text.split("\n");
    rows.forEach((row, index) => {
      lines.push({
        text: row,
        x,
        y: bottom - (rows.length - 1 - index) * lineHeight,
      });
    });
    bottom -= rows.length * lineHeight;
  }
  return lines;
}

/**
 * font の指定が受け付けられるか確かめ、駄目ならゴシックに倒す。
 *
 * **代入した文字列と読み戻しの一致では判定しない。** `ctx.font` は正規化した値を
 * 返すので必ず不一致になる。代入前に既知の値を入れ、代入後に**それから変わったか**
 * で見る (不正な指定は例外を出さずに無視され、値が変わらない)。
 *
 * 呼ぶのは録画開始時とプレビューのスタイル更新時の 1 回だけ。フレームごとに呼ばない
 */
export function resolveTelopStyle(
  ctx: CanvasRenderingContext2D,
  style: TelopStyle,
): TelopStyle {
  ctx.font = "1px serif";
  const before = ctx.font;
  ctx.font = fontOf(style.fontFamily, style.fontSizePx);
  if (ctx.font !== before) return style;

  console.warn(
    `[yt-clip] テロップのフォント指定が使えないためゴシックで描きます: ${style.fontFamily}`,
  );
  return { ...style, fontFamily: TELOP_FONT_PRESETS[0].family };
}

/**
 * `sourceSec` (元動画の秒) の時点のテロップを描く。`style` は `resolveTelopStyle` を
 * 通したものを渡すこと。
 *
 * 縁取りを先に、文字を後に描く (文字の内側が縁に食われない)。線は輪郭の両側に
 * 乗るので太さの 2 倍、角は丸める (トゲにならない)
 */
export function drawTelops(
  ctx: CanvasRenderingContext2D,
  telops: Telop[],
  sourceSec: number,
  style: TelopStyle,
  width: number,
  height: number,
): void {
  const active = activeTelops(telops, sourceSec);
  if (active.length === 0) return;

  const scale = height / TELOP_BASE_HEIGHT;
  ctx.save();
  ctx.font = fontOf(style.fontFamily, style.fontSizePx * scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineJoin = "round";
  ctx.lineWidth = style.strokeWidthPx * 2 * scale;
  ctx.strokeStyle = style.strokeColor;
  ctx.fillStyle = style.fillColor;

  const lines = layoutTelops(
    active.map((telop) => telop.text),
    width,
    height,
    style.fontSizePx,
  );
  for (const line of lines) {
    if (style.strokeWidthPx > 0) ctx.strokeText(line.text, line.x, line.y);
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/content/telop-render.test.ts && npm run typecheck`
期待: PASS、型エラーなし

- [ ] **Step 5: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/telop-render.ts tests/content/telop-render.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(telop): テロップを canvas に描く関数を作る

プレビューと録画を同じ関数で描き、見た目の食い違いを作らない。大きさは
1080p 基準で動画の高さに比例させる。font の指定が無視されたかは、読み戻しの
一致ではなく既知の値から変わったかで見る (読み戻しは正規化されるため)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 7: 動画とテロップを合成するトラックを作り、録画に差し込めるようにする

**Files:**
- Create: `src/content/telop-compositor.ts`
- Modify: `src/content/recorder.ts` (`buildRecordingStream` / `startRecording` に映像の差し替え口)
- Create: `tests/content/telop-compositor.test.ts`
- Modify: `tests/content/recorder.test.ts`

**Interfaces:**
- Consumes: `drawTelops`, `resolveTelopStyle` (Task 6)、`Telop`、`TelopStyle`
- Produces:
  - `class TelopRenderError extends Error`
  - `type VideoOverride = { track: MediaStreamTrack; release(): void }` (`@/content/recorder`)
  - `type Compositor = VideoOverride` (`@/content/telop-compositor`)
  - `type CompositorDeps = { createCanvas(): HTMLCanvasElement }`
  - `assertTelopRenderable(video: HTMLVideoElement, deps?: CompositorDeps): void` — 描けなければ `TelopRenderError`
  - `startCompositor(video: HTMLVideoElement, telops: Telop[], style: TelopStyle, deps?: CompositorDeps): Compositor`
  - `buildRecordingStream(captured, createAudioContext?, videoOverride?: VideoOverride)`
  - `RecorderOptions` に `videoOverride?: VideoOverride`

**Task 1 で検証 3 (負荷) が崩れていた場合:** Step 5 の `startCompositor` の `paint` を次に差し替える (テストは Step 1 のものがそのまま通る。外から見た振る舞いは変えず、内部だけ変える)。テロップの層を別 canvas にキャッシュし、出すテロップの集合が変わったときだけ描き直す。毎フレームは `drawImage` 2 回だけになる。`activeTelops` を `@/shared/telop` から import する。

```typescript
  // テロップの層。出すテロップの集合が変わったときだけ描き直す (spec §9 の第一手)
  const layer = deps.createCanvas();
  layer.width = width;
  layer.height = height;
  const layerCtx = layer.getContext("2d");
  if (layerCtx === null) {
    throw new TelopRenderError("テロップの層の描画の文脈を取れません");
  }
  let layerKey = "";

  const paint = (sourceSec: number): void => {
    const active = activeTelops(telops, sourceSec);
    const key = active.map((telop) => telops.indexOf(telop)).join(",");
    if (key !== layerKey) {
      layerKey = key;
      layerCtx.clearRect(0, 0, width, height);
      drawTelops(layerCtx, telops, sourceSec, resolved, width, height);
    }
    ctx.drawImage(video, 0, 0, width, height);
    if (key !== "") ctx.drawImage(layer, 0, 0);
    track.requestFrame();
  };
```

- [ ] **Step 1: 失敗するテストを書く (合成)**

`tests/content/telop-compositor.test.ts` を作る。

```typescript
// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  TelopRenderError,
  assertTelopRenderable,
  startCompositor,
} from "@/content/telop-compositor";
import type { TelopStyle } from "@/shared/telop-style";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

function makeVideo(width = 1920, height = 1080) {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  Object.defineProperty(video, "currentTime", { value: 5, writable: true });
  const callbacks = new Map<number, FrameCallback>();
  let next = 1;
  Object.assign(video, {
    requestVideoFrameCallback: (callback: FrameCallback) => {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: (handle: number) => callbacks.delete(handle),
  });
  return {
    video,
    frame(mediaTime: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0, { mediaTime });
    },
    pending: () => callbacks.size,
  };
}

function makeCanvas(options: { tainted?: boolean; noContext?: boolean } = {}) {
  const log = { drawn: 0, requested: 0, stopped: false, texts: [] as string[] };
  const track = {
    kind: "video",
    requestFrame: () => {
      log.requested += 1;
    },
    stop: () => {
      log.stopped = true;
    },
  };
  let font = "10px sans-serif";
  const ctx = {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    drawImage: () => {
      log.drawn += 1;
    },
    getImageData: () => {
      if (options.tainted) throw new DOMException("tainted", "SecurityError");
      return {};
    },
    save: () => undefined,
    restore: () => undefined,
    strokeText: () => undefined,
    fillText: (text: string) => log.texts.push(text),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (options.noContext ? null : ctx),
    captureStream: () => ({ getVideoTracks: () => [track] }),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, log, track };
}

describe("assertTelopRenderable", () => {
  test("描けるなら通す", () => {
    const { video } = makeVideo();
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).not.toThrow();
  });

  test("汚染されていたら TelopRenderError", () => {
    // テロップなしで録って続行しない。実時間を払った後で気付くことになる
    const { video } = makeVideo();
    const { canvas } = makeCanvas({ tainted: true });
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("2D の文脈が取れなければ TelopRenderError", () => {
    const { video } = makeVideo();
    const { canvas } = makeCanvas({ noContext: true });
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("フレーム単位の監視が使えなければ TelopRenderError", () => {
    // 1 区間の録画でも合成は rVFC に乗る。beginRecording で初めて落ちると
    // router が recording-aborted に化けさせ、理由が出ない
    const { video } = makeVideo();
    Object.assign(video, { requestVideoFrameCallback: undefined });
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });

  test("動画の大きさがまだ無ければ TelopRenderError", () => {
    const { video } = makeVideo(0, 0);
    const { canvas } = makeCanvas();
    expect(() => assertTelopRenderable(video, { createCanvas: () => canvas })).toThrow(
      TelopRenderError,
    );
  });
});

describe("startCompositor", () => {
  test("canvas の大きさを録画開始時の動画の大きさで固定する", () => {
    const { video } = makeVideo(1280, 720);
    const { canvas } = makeCanvas();
    startCompositor(video, [], STYLE, { createCanvas: () => canvas });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  test("動画のフレームごとに描いて 1 フレーム送る", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    startCompositor(fake.video, [], STYLE, { createCanvas: () => canvas });
    const before = log.requested;
    fake.frame(6);
    fake.frame(6.1);
    expect(log.requested - before).toBe(2);
  });

  test("描くときの時刻は rVFC の mediaTime を使う", () => {
    // currentTime は描画時点ですでに先へ進んでいることがある
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    startCompositor(
      fake.video,
      [{ startSec: 10, endSec: 11, text: "出る" }],
      STYLE,
      { createCanvas: () => canvas },
    );
    fake.frame(10.5);
    expect(log.texts).toContain("出る");
  });

  test("release で描画ループとトラックを止める。二度呼んでも安全", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    const compositor = startCompositor(fake.video, [], STYLE, {
      createCanvas: () => canvas,
    });
    compositor.release();
    compositor.release();
    expect(log.stopped).toBe(true);
    expect(fake.pending()).toBe(0);
  });

  test("release の後に届いたフレームでは描かない", () => {
    const fake = makeVideo();
    const { canvas, log } = makeCanvas();
    const compositor = startCompositor(fake.video, [], STYLE, {
      createCanvas: () => canvas,
    });
    const before = log.requested;
    compositor.release();
    fake.frame(7);
    expect(log.requested).toBe(before);
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (録画への差し込み)**

`tests/content/recorder.test.ts` の `describe("buildRecordingStream", ...)` の中に足す。

```typescript
  test("映像の差し替えがあれば、その映像と落とした音声で録る", () => {
    const capturedVideo = new FakeTrack("video", "captured");
    const captured = new FakeStream([capturedVideo, new FakeTrack("audio", "captured")]);
    const { create } = makeAudioContext();
    const composed = new FakeTrack("video", "composed");
    let overrideReleased = false;

    const built = buildRecordingStream(captured as unknown as MediaStream, create, {
      track: composed as unknown as MediaStreamTrack,
      release: () => {
        overrideReleased = true;
      },
    });

    const videos = built.stream.getVideoTracks() as unknown as FakeTrack[];
    expect(videos.map((track) => track.label)).toEqual(["composed"]);

    // release は合成側も解放する。自動停止の経路でも rVFC のループを残さない
    built.release();
    expect(overrideReleased).toBe(true);
    expect(capturedVideo.stopped).toBe(true);
  });

  test("音声が無くても映像の差し替えは効く", () => {
    const captured = new FakeStream([new FakeTrack("video", "captured")]);
    const composed = new FakeTrack("video", "composed");
    let overrideReleased = false;

    const built = buildRecordingStream(captured as unknown as MediaStream, undefined, {
      track: composed as unknown as MediaStreamTrack,
      release: () => {
        overrideReleased = true;
      },
    });

    const videos = built.stream.getVideoTracks() as unknown as FakeTrack[];
    expect(videos.map((track) => track.label)).toEqual(["composed"]);
    built.release();
    expect(overrideReleased).toBe(true);
  });
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-compositor.test.ts tests/content/recorder.test.ts`
期待: FAIL

- [ ] **Step 4: `recorder.ts` に差し替え口を作る**

`src/content/recorder.ts` を直す。`RecorderOptions` の定義の直前に足す。

```typescript
/**
 * 録画に使う映像トラックの差し替え。テロップを焼き込むときに合成した映像を渡す。
 *
 * **解放も一緒に受け取る。** 録画の解放は `recorder.onstop` から呼ばれ、録画が
 * 自動で止まった経路でも走る。合成側の解放をそこに繋がないと、自動停止のときに
 * 描画ループと canvas のトラックが残る
 */
export type VideoOverride = {
  track: MediaStreamTrack;
  release(): void;
};
```

`RecorderOptions` に足す。

```typescript
  /** 映像を差し替える。無ければ `video.captureStream()` の映像をそのまま録る */
  videoOverride?: VideoOverride;
```

`buildRecordingStream` を差し替える (JSDoc はそのまま残し、末尾に「`videoOverride` があれば映像はそちらを使う」の 1 行を足す)。

```typescript
export function buildRecordingStream(
  captured: MediaStream,
  createAudioContext: () => AudioContext = () => new AudioContext(),
  videoOverride?: VideoOverride,
): RecordingStream {
  const releaseCaptured = (): void => {
    videoOverride?.release();
    for (const track of captured.getTracks()) {
      track.stop();
    }
  };
  const videoTracks =
    videoOverride === undefined ? captured.getVideoTracks() : [videoOverride.track];

  const audioTrack = captured.getAudioTracks()[0];
  if (audioTrack === undefined) {
    return {
      stream:
        videoOverride === undefined ? captured : new MediaStream(videoTracks),
      release: releaseCaptured,
    };
  }

  try {
    const context = createAudioContext();
    const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
    const destination = context.createMediaStreamDestination();
    // 既定でも 2ch だが、話者配置に沿って混ぜる規則ごと明示しておく
    destination.channelCount = MAX_AUDIO_CHANNELS;
    destination.channelCountMode = "explicit";
    destination.channelInterpretation = "speakers";
    source.connect(destination);

    const downmixed = destination.stream.getAudioTracks()[0];
    if (downmixed === undefined) {
      throw new Error("ステレオに落とした音声を取り出せませんでした");
    }

    return {
      stream: new MediaStream([...videoTracks, downmixed]),
      release(): void {
        downmixed.stop();
        void context.close();
        releaseCaptured();
      },
    };
  } catch (error) {
    // ここで録画ごと失敗させない。8ch のままでも録画は成立し、
    // ダウンロードして使う道は残る。塞がるのは X への添付だけなので、
    // 後から原因を追えるよう理由は必ず残す
    console.warn(
      `音声をステレオに落とせませんでした。X への添付が通らない可能性があります: ${String(error)}`,
    );
    return {
      stream:
        videoOverride === undefined
          ? captured
          : new MediaStream([...videoTracks, audioTrack]),
      release: releaseCaptured,
    };
  }
}
```

`startRecording` の `const recording = buildRecordingStream(target.captureStream());` を次にする。

```typescript
  const recording = buildRecordingStream(
    target.captureStream(),
    undefined,
    options.videoOverride,
  );
```

- [ ] **Step 5: `telop-compositor.ts` を作る**

```typescript
/**
 * 動画とテロップを canvas で合成し、録画に使う映像トラックを作る。
 *
 * **テロップがあるときだけ使う。** 無いときは今の `video.captureStream()` の経路の
 * まま (canvas を挟むと描画の負荷とフレーム落ちの可能性が増える。テロップ spec §4.1)
 */

import type { VideoOverride } from "@/content/recorder";
import { drawTelops, resolveTelopStyle } from "@/content/telop-render";
import type { TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

export type Compositor = VideoOverride;

export type CompositorDeps = {
  createCanvas(): HTMLCanvasElement;
};

const defaultDeps: CompositorDeps = {
  createCanvas: () => document.createElement("canvas"),
};

/** テロップを描く canvas に動画を描けない。録画を始める前に弾く */
export class TelopRenderError extends Error {
  constructor(detail: string) {
    super(`テロップを動画に描けませんでした: ${detail}`);
    this.name = "TelopRenderError";
  }
}

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};
type CanvasCaptureTrack = MediaStreamTrack & { requestFrame(): void };

type Surface = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
};

/**
 * 動画の大きさの canvas を用意して 1 フレーム描き、読み出せるか確かめる。
 *
 * 読み出せない (汚染されている) canvas を録っても映像は出ない。**失敗を投げる。**
 * テロップなしで録って続行すると、実時間を払った後で気付くことになる
 */
function prepareSurface(video: HTMLVideoElement, deps: CompositorDeps): Surface {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    throw new TelopRenderError("動画の大きさがまだ分かりません");
  }

  const canvas = deps.createCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new TelopRenderError("canvas の描画の文脈を取れません");
  }

  ctx.drawImage(video, 0, 0, width, height);
  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (error) {
    throw new TelopRenderError(String(error));
  }
  return { canvas, ctx, width, height };
}

/**
 * 録画を始める前の検査。`prepareRecording` から呼ぶ。
 *
 * **`beginRecording` で初めて気付かない。** そこの失敗は router が理由を問わず
 * `recording-aborted` に落とすので、専用の文言が出ない (テロップ spec §4.3)
 */
export function assertTelopRenderable(
  video: HTMLVideoElement,
  deps: CompositorDeps = defaultDeps,
): void {
  // 1 区間の録画でも合成は rVFC に乗る (区間の繋ぎ目の検査は 2 区間以上でしか走らない)
  const request = (video as Partial<VideoWithFrameCallback>).requestVideoFrameCallback;
  if (typeof request !== "function") {
    throw new TelopRenderError("この環境では動画のフレームに合わせて描けません");
  }
  prepareSurface(video, deps);
}

/**
 * 合成を始める。返したトラックを録画に渡し、`release` を録画の解放に繋ぐこと。
 *
 * - canvas の大きさは**開始時の動画の大きさで固定する**。録画中に画質が変わっても
 *   変えず、`drawImage` で引き伸ばす (MediaRecorder は途中の解像度変更を想定しない)
 * - **動画の新しいフレームが来るたびに描いて 1 フレーム送る** (`captureStream(0)` +
 *   `requestFrame`)。タイマーで描くと動画とずれ、同じ絵が 2 回出たり飛んだりする
 * - 描く時刻は rVFC の `mediaTime`。`currentTime` は描画時点で先へ進んでいることがある
 * - 録画の pause 中も描き続けてよい (pause 中のフレームは記録されない)
 */
export function startCompositor(
  video: HTMLVideoElement,
  telops: Telop[],
  style: TelopStyle,
  deps: CompositorDeps = defaultDeps,
): Compositor {
  const { canvas, ctx, width, height } = prepareSurface(video, deps);
  const resolved = resolveTelopStyle(ctx, style);

  const track = canvas.captureStream(0).getVideoTracks()[0] as
    | CanvasCaptureTrack
    | undefined;
  if (track === undefined) {
    throw new TelopRenderError("canvas から映像のトラックを取れません");
  }

  const target = video as VideoWithFrameCallback;
  let handle = 0;
  let released = false;

  const paint = (sourceSec: number): void => {
    ctx.drawImage(video, 0, 0, width, height);
    drawTelops(ctx, telops, sourceSec, resolved, width, height);
    track.requestFrame();
  };
  const tick: FrameCallback = (_now, metadata) => {
    if (released) return;
    paint(metadata.mediaTime);
    handle = target.requestVideoFrameCallback(tick);
  };

  // 最初のフレームは今の位置で描いておく。録画の先頭が空の映像にならないように
  paint(video.currentTime);
  handle = target.requestVideoFrameCallback(tick);

  return {
    track,
    release(): void {
      if (released) return;
      released = true;
      target.cancelVideoFrameCallback(handle);
      track.stop();
    },
  };
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npx vitest run tests/content/telop-compositor.test.ts tests/content/recorder.test.ts && npm run typecheck`
期待: PASS、型エラーなし

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/telop-compositor.ts src/content/recorder.ts tests/content/telop-compositor.test.ts tests/content/recorder.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(recorder): テロップを合成した映像を録画に差し込めるようにする

動画のフレームごとに canvas へ描いて 1 フレーム送る。タイマーで描くと動画と
ずれる。合成側の解放は録画の解放に繋ぎ、録画が自動で止まった経路でも
描画ループを残さない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 8: テロップ付きの録画を `youtube.ts` に配線する

**Files:**
- Modify: `src/content/youtube.ts`
- Modify: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `hasRenderableTelops` (Task 3)、`ClipState.telops`・`telop-render-failed` (Task 4)、`telopStyleOf`・`TelopStyle`・`DEFAULT_SETTINGS` (Task 5)、`assertTelopRenderable`・`startCompositor`・`TelopRenderError` (Task 7)
- Produces (Task 9〜11 が使う `youtube.ts` のモジュール変数):
  - `let currentTelops: Telop[]` — いま画面に出ているテロップ。状態機械の写し
  - `let telopStyle: TelopStyle` — 設定から組み立てた見た目
  - `function applyTelopSettings(settings: Settings): void` — 設定を読んだとき・変わったときに呼ぶ

- [ ] **Step 1: テストの仕掛けを足す**

`tests/content/youtube.test.ts` のフェイクの `MediaRecorder` は、渡されたストリームを覚えていない。合成した映像で録っているかを確かめるため、覚えさせる。

`type FakeRecorder = {` に `/** 録画に渡されたストリーム */ stream: unknown;` を足す。`class FakeMediaRecorder implements FakeRecorder {` の中を次のように直す。

```typescript
    readonly calls: string[] = [];
    readonly stream: unknown;

    constructor(stream: unknown) {
      this.stream = stream;
      recorders.push(this);
    }
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に足す。import の `@/shared/types` に `type Telop` を、`vitest` の import に `afterEach` を足す。

jsdom は canvas を描けず、`MediaStream` も持たないので、この describe の中で差し替える。**`vi.unstubAllGlobals()` は呼ばないこと** (ファイル先頭の `beforeAll` で差し替えた `chrome` と `MediaRecorder` まで外れる)。

```typescript
describe("テロップ付きの録画", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
  let restoreCanvas: (() => void) | null = null;

  /** canvas を描ける状態にする。tainted なら getImageData が SecurityError */
  function installCanvas(options: { tainted?: boolean } = {}) {
    const track = { kind: "video", requestFrame: () => undefined, stop: () => undefined };
    const ctx = {
      font: "10px sans-serif",
      drawImage: () => undefined,
      getImageData: () => {
        if (options.tainted) throw new DOMException("tainted", "SecurityError");
        return {};
      },
      clearRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      strokeText: () => undefined,
      fillText: () => undefined,
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true,
      value: () => ({ getVideoTracks: () => [track] }),
    });
    // mockRestore にしない。Task 11 で installGlobals に置く「既定は null」の spy まで
    // 外れて jsdom の実装に戻り、以降のテストの出力に "Not implemented" が混ざる
    restoreCanvas = () => getContext.mockReturnValue(null);
    return { track };
  }

  beforeEach(() => {
    // 合成の canvas は録画開始時の動画の大きさで作る。フェイクは高さしか持たない
    Object.defineProperty(video.element, "videoWidth", {
      configurable: true,
      value: 1920,
    });
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: { kind: string }[] = []) {}
        getTracks() {
          return this.tracks;
        }
        getVideoTracks() {
          return this.tracks.filter((track) => track.kind === "video");
        }
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio");
        }
      },
    );
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
  });

  /**
   * seeking → recording → recorder/start と進める。
   *
   * **seeking を通すこと。** 経路の判定と描けるかの検査は prepareRecording
   * (seeking を受けたとき) で行うので、recording から始めると合成を通らない
   */
  async function recordWith(telops: Telop[]): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops });
    await flush();
    emit({ kind: "recording", segments: [RANGE], meta: META_A, telops });
    await flush();
    command("recorder/start");
    await flush();
  }

  test("区間に重なるテロップがあると canvas の映像で録る", async () => {
    const { track } = installCanvas();

    await recordWith([TELOP]);

    const stream = startedRecorder().stream as { getVideoTracks(): unknown[] };
    expect(stream.getVideoTracks()).toEqual([track]);
  });

  /**
   * 録画が今の経路 (video.captureStream の映像) で録っているか。
   *
   * **canvas が作られたかでは見ない。** プレビュー (Task 11) は区間外のテロップ
   * でも canvas を作るので、録画の経路とは関係なく canvas は現れる
   */
  function recordsCapturedVideo(): boolean {
    const stream = startedRecorder().stream as {
      getVideoTracks(): object[];
    };
    const tracks = stream.getVideoTracks();
    return tracks.length === 1 && !tracks.some((track) => "requestFrame" in track);
  }

  test("テロップが無ければ今の経路のまま", async () => {
    installCanvas();

    await recordWith([]);

    expect(recordsCapturedVideo()).toBe(true);
  });

  test("区間外のテロップしか無ければ今の経路のまま", async () => {
    // canvas を挟む負荷を、録画に出ないテロップのために払わない
    installCanvas();

    await recordWith([{ startSec: 100, endSec: 103, text: "外" }]);

    expect(recordsCapturedVideo()).toBe(true);
  });

  test("canvas に描けなければ録画を始めずに telop-render-failed で落とす", async () => {
    // テロップなしで録って続行すると、実時間を払った後で気付くことになる
    installCanvas({ tainted: true });
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-render-failed" });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
    expect(statusText()).toContain("テロップを動画に描けませんでした");
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts -t "テロップ付きの録画"`
期待: FAIL

- [ ] **Step 4: モジュール変数と設定の取り込みを足す**

`src/content/youtube.ts` を直す。

import に足す。

```typescript
import {
  TelopRenderError,
  assertTelopRenderable,
  startCompositor,
} from "@/content/telop-compositor";
import { hasRenderableTelops } from "@/shared/telop";
import { telopStyleOf, type TelopStyle } from "@/shared/telop-style";
```

`@/shared/settings` の import に `DEFAULT_SETTINGS` と `type Settings` を、`@/shared/types` の import に `type Telop` を足す。

`let currentSegments: ClipRange[] = [];` の直後に足す。

```typescript
/**
 * いま画面に出ているテロップ。**状態機械が正で、これはその写し。**
 * 別の動画を見ているタブでは空 (区間と同じ規則)
 */
let currentTelops: Telop[] = [];
/** テロップの見た目。設定から組み立てる */
let telopStyle: TelopStyle = telopStyleOf(DEFAULT_SETTINGS);
/**
 * 録画するテロップと見た目。**録画開始時に固定する。** 録画中に ⚙ で見た目を
 * 変えても、途中で見た目が変わるクリップを作らない。null なら今の経路で録る
 */
let recordingTelops: { telops: Telop[]; style: TelopStyle } | null = null;
```

`loadInitialSettings` の前に足す。

```typescript
/** 設定のうちテロップの見た目を取り込む。起動時と、別のタブで変わったときに呼ぶ */
function applyTelopSettings(settings: Settings): void {
  telopStyle = telopStyleOf(settings);
}
```

`loadInitialSettings` の `.then` の中と、`chrome.storage.onChanged` のリスナーの中の `maxClipSec = settings.maxClipSec;` の直後に、それぞれ `applyTelopSettings(settings);` を足す。

`applyStateToDisplay` の `currentSegments = liveSegments;` の直後に足す。

```typescript
  currentTelops =
    liveSegments.length === 0 || !("telops" in state) ? [] : state.telops;
```

- [ ] **Step 5: `prepareRecording` に検査を、`beginRecording` に差し替えを足す**

`prepareRecording` の `assertRecordable(getVideo());` の直後に足す。

```typescript
    // **テロップの有無で録画の経路を決め、描けるかをここで確かめる。**
    // `beginRecording` で気付くと、router が理由を問わず recording-aborted に
    // 落とすので専用の文言が出ない。見た目もここで固定する (録画中に変えても効かない)
    recordingTelops = hasRenderableTelops(currentTelops, currentSegments)
      ? { telops: currentTelops, style: telopStyle }
      : null;
    if (recordingTelops !== null) {
      assertTelopRenderable(getVideo());
    }
```

同じ関数の `catch` の `if (error instanceof FrameCallbackUnsupportedError) {` の直前に足す。

```typescript
    if (error instanceof TelopRenderError) {
      recordingTelops = null;
      send({ type: "FAIL", reason: "telop-render-failed" });
      setStatus(error.message);
      return;
    }
```

`beginRecording` を丸ごと差し替える。import の `@/content/telop-compositor` に `type Compositor` を足す。

```typescript
/** service worker からの指示で録画を始める */
async function beginRecording(): Promise<void> {
  // 録画が始まらなかったときに合成を残さないよう、try の外で持つ
  let videoOverride: Compositor | undefined;
  try {
    const video = getVideo();
    const { mimeType } = pickMimeType();
    const telops = recordingTelops;
    // 使い切ったら空にする。seeking を通らずに recorder/start が来たとき
    // (実機の順序の食い違いやテスト) に、前の録画のテロップで合成しない
    recordingTelops = null;
    // 合成は録画の解放 (buildRecordingStream の release) に繋がるので、
    // 録画が自動で止まった経路でも描画ループが残らない
    videoOverride =
      telops === null
        ? undefined
        : startCompositor(video, telops.telops, telops.style);
    handle = await startRecording(video, mimeType, {
      videoOverride,
      onUnexpectedStop: (error) => {
        handle = null;
        notify({ type: "recorder/failed", reason: error.message });
      },
    });
    notify({ type: "recorder/started" });
  } catch (error) {
    // release は二度呼んでも安全 (startRecording の中で解放済みのことがある)
    videoOverride?.release();
    notify({ type: "recorder/failed", reason: String(error) });
  }
}
```

- [ ] **Step 6: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

- [ ] **Step 7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/youtube.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 区間に重なるテロップがあれば合成した映像で録る

経路の判定と描けるかの検査は prepareRecording で行う。beginRecording で
気付くと router が recording-aborted に落とし、理由が出ない。録画する
テロップと見た目は開始時に固定する。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 9: テロップの一覧を作り、バーに配線する

**Files:**
- Create: `src/content/telop-list.ts`
- Modify: `src/content/styles.ts` (`TELOP_STYLE`)
- Modify: `src/content/youtube.ts`
- Create: `tests/content/telop-list.test.ts`
- Modify: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `overlapsSegments` (Task 3)、`ADD_TELOP` / `UPDATE_TELOP` / `REMOVE_TELOP` (Task 4)、`currentTelops` (Task 8)
- Produces:
  - `createTelopList(callbacks: TelopListCallbacks): TelopList`
  - `type TelopListCallbacks = { onAdd(): void; onSetStart(index: number): void; onSetEnd(index: number): void; onPlay(index: number): void; onRemove(index: number): void; onText(index: number, text: string): void }`
  - `type TelopList = { element: HTMLElement; update(telops: Telop[], segments: ClipRange[]): void; setEnabled(enabled: boolean): void }`

- [ ] **Step 1: 失敗するテストを書く (一覧)**

`tests/content/telop-list.test.ts` を作る。

```typescript
// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { createTelopList, type TelopListCallbacks } from "@/content/telop-list";
import type { ClipRange, Telop } from "@/shared/types";

const SEGMENTS: ClipRange[] = [{ startSec: 10, endSec: 20 }];
const HELLO: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };
const OUTSIDE: Telop = { startSec: 40, endSec: 43, text: "外" };

function makeCallbacks() {
  const calls: string[] = [];
  const callbacks: TelopListCallbacks = {
    onAdd: () => calls.push("add"),
    onSetStart: (i) => calls.push(`start:${i}`),
    onSetEnd: (i) => calls.push(`end:${i}`),
    onPlay: (i) => calls.push(`play:${i}`),
    onRemove: (i) => calls.push(`remove:${i}`),
    onText: (i, text) => calls.push(`text:${i}:${text}`),
  };
  return { calls, callbacks };
}

function rows(list: { element: HTMLElement }): HTMLElement[] {
  return [...list.element.querySelectorAll<HTMLElement>("[data-role=telop]")];
}

function button(row: HTMLElement, role: string): HTMLButtonElement {
  const found = row.querySelector<HTMLButtonElement>(`[data-role=${role}]`);
  if (found === null) throw new Error(`ボタンがありません: ${role}`);
  return found;
}

describe("createTelopList", () => {
  test("区間が無ければ箱ごと隠す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([], []);
    expect(list.element.hidden).toBe(true);
  });

  test("区間があればテロップが無くても出す (＋ テロップを押せるように)", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([], SEGMENTS);
    expect(list.element.hidden).toBe(false);
    expect(list.element.querySelector("[data-role=add-telop]")).not.toBeNull();
  });

  test("行に時刻と文言を出す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    const [row] = rows(list);
    expect(row?.textContent).toContain("0:11 〜 0:14");
    expect(row?.querySelector("textarea")?.value).toBe("こんにちは");
  });

  test("どの区間にも重ならなければ (区間外) と出す", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    const [inside, outside] = rows(list);
    expect(inside?.textContent).not.toContain("区間外");
    expect(outside?.textContent).toContain("(区間外)");
  });

  test("ボタンは index 付きで伝える", () => {
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    const second = rows(list)[1];
    if (second === undefined) throw new Error("行がありません");
    button(second, "set-start").click();
    button(second, "set-end").click();
    button(second, "play").click();
    button(second, "remove").click();
    (list.element.querySelector("[data-role=add-telop]") as HTMLButtonElement).click();
    expect(calls).toEqual(["start:1", "end:1", "play:1", "remove:1", "add"]);
  });

  test("文言はフォーカスが外れたとき (change) に伝える", () => {
    // 1 文字ごとに送ると、そのたびにクリップが外れて状態通知が飛ぶ
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.value = "やあ";
    textarea.dispatchEvent(new Event("input"));
    expect(calls).toEqual([]);
    textarea.dispatchEvent(new Event("change"));
    expect(calls).toEqual(["text:0:やあ"]);
  });

  test("描き直しても、フォーカス中の入力欄は要素も value も触らない", () => {
    // value を書き換えると打ちかけの文字が消え、その後 change も発火しなくなる
    const list = createTelopList(makeCallbacks().callbacks);
    document.body.append(list.element);
    list.update([HELLO], SEGMENTS);
    const textarea = rows(list)[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");
    textarea.focus();
    textarea.value = "打ちかけ";

    list.update([{ ...HELLO, startSec: 12 }], SEGMENTS);

    const after = rows(list)[0]?.querySelector("textarea");
    expect(after).toBe(textarea);
    expect(after?.value).toBe("打ちかけ");
    // 表示 (時刻) は更新される
    expect(rows(list)[0]?.textContent).toContain("0:12");
    list.element.remove();
  });

  test("フォーカスしていない入力欄は状態の値に合わせる", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    list.update([{ ...HELLO, text: "別のタブで変えた" }], SEGMENTS);
    expect(rows(list)[0]?.querySelector("textarea")?.value).toBe("別のタブで変えた");
  });

  test("数が減れば行も減る", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO, OUTSIDE], SEGMENTS);
    list.update([HELLO], SEGMENTS);
    expect(rows(list)).toHaveLength(1);
  });

  test("入力欄の keydown は YouTube のショートカットへ伝えない", () => {
    const list = createTelopList(makeCallbacks().callbacks);
    list.update([HELLO], SEGMENTS);
    const outer = vi.fn();
    document.body.append(list.element);
    document.body.addEventListener("keydown", outer);
    rows(list)[0]
      ?.querySelector("textarea")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", outer);
    list.element.remove();
  });

  test("無効な間は押しても伝えない", () => {
    const { calls, callbacks } = makeCallbacks();
    const list = createTelopList(callbacks);
    list.update([HELLO], SEGMENTS);
    list.setEnabled(false);
    const row = rows(list)[0];
    if (row === undefined) throw new Error("行がありません");
    button(row, "remove").click();
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: 失敗するテストを書く (配線)**

`tests/content/youtube.test.ts` の末尾に足す。

```typescript
describe("テロップの一覧", () => {
  const TELOP: Telop = { startSec: 11, endSec: 14, text: "こんにちは" };

  function telopRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='telop']")];
  }

  function segmentRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-role='segment']")];
  }

  function addTelopButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-role='add-telop']");
    if (button === null) throw new Error("＋ テロップがありません");
    return button;
  }

  async function showReady(
    telops: Telop[],
    segments: ClipRange[] = [RANGE],
  ): Promise<void> {
    changeSettings({ mode: "edit" });
    emit({ kind: "ready", segments, meta: META_A, telops });
    await flush();
    sent = [];
  }

  async function seekVideo(sec: number): Promise<void> {
    video.element.currentTime = sec;
    await flush();
  }

  test("＋ テロップで今の位置から 3 秒のテロップを送る", async () => {
    await showReady([]);
    await seekVideo(12);

    addTelopButton().click();

    expect(clipEvents().at(-1)).toEqual({
      type: "ADD_TELOP",
      telop: { startSec: 12, endSec: 15, text: "" },
    });
  });

  test("動画の終わりを超えるなら終わりを詰める", async () => {
    await showReady([]);
    await seekVideo(598);

    addTelopButton().click();

    expect(clipEvents().at(-1)).toEqual({
      type: "ADD_TELOP",
      telop: { startSec: 598, endSec: 600, text: "" },
    });
  });

  test("開始を今にで、開始が終了以上になるなら送らず理由を出す", async () => {
    await showReady([TELOP]);
    await seekVideo(20);

    telopRows()[0]?.querySelector<HTMLElement>("[data-role='set-start']")?.click();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe("開始は終了より前にしてください");
  });

  test("文言を確定すると UPDATE_TELOP を送る", async () => {
    await showReady([TELOP]);
    const textarea = telopRows()[0]?.querySelector("textarea");
    if (textarea == null) throw new Error("入力欄がありません");

    textarea.value = "やあ\n元気";
    textarea.dispatchEvent(new Event("change"));

    expect(clipEvents().at(-1)).toEqual({
      type: "UPDATE_TELOP",
      index: 0,
      telop: { ...TELOP, text: "やあ\n元気" },
    });
  });

  test("テロップが残っていると最後の 1 区間は消せない", async () => {
    // 区間が 0 個になると idle に戻り、手入力の文言もまとめて消える
    await showReady([TELOP]);

    segmentRows()[0]?.querySelector<HTMLElement>("[data-role='remove']")?.click();

    expect(clipEvents()).toEqual([]);
    expect(statusText()).toBe(
      "テロップが 1 件残っています。先にテロップを消してください",
    );
  });

  test("区間の削除でテロップが消えてしまったら知らせる", async () => {
    // 手元の写しが古くて止め損ねた場合の保険
    await showReady([TELOP], [RANGE, { startSec: 30, endSec: 40 }]);
    segmentRows()[1]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    await flush();

    emit({ kind: "idle" });
    await flush();

    expect(statusText()).toBe("テロップも消えました");
  });

  test("preview では操作できない", async () => {
    // 区間の拡大バーと同じ条件。テロップだけ触れる非対称を作らない
    changeSettings({ mode: "edit" });
    emit({
      kind: "preview",
      clipId: "clip-1",
      mimeType: "video/mp4",
      segments: [RANGE],
      meta: META_A,
      telops: [TELOP],
    });
    await flush();
    sent = [];

    telopRows()[0]?.querySelector<HTMLElement>("[data-role='remove']")?.click();
    addTelopButton().click();

    expect(clipEvents()).toEqual([]);
  });

  test("シンプルモードでは出さない", async () => {
    changeSettings({ mode: "simple" });
    emit({ kind: "ready", segments: [RANGE], meta: META_A, telops: [] });
    await flush();

    // 一覧の箱は ＋ テロップの見出しの親
    expect(addTelopButton().parentElement?.parentElement?.hidden).toBe(true);
  });
});
```

- [ ] **Step 3: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-list.test.ts tests/content/youtube.test.ts -t "テロップ"`
期待: FAIL

- [ ] **Step 4: スタイルを足す**

`src/content/styles.ts` の `SEGMENT_STYLE` の後に足す。

```typescript
/** テロップの一覧。区間の一覧と並ぶので見た目を揃える */
export const TELOP_STYLE = {
  root: "display:flex;flex-direction:column;gap:4px;",
  header: "display:flex;align-items:center;gap:8px;",
  title: "color:var(--ytc-text);font-size:12px;font-weight:600;flex:1;",
  row: "display:flex;flex-direction:column;gap:4px;padding:4px 8px;border-radius:6px;background:var(--ytc-surface);",
  rowHead: "display:flex;gap:8px;align-items:center;",
  label: "color:var(--ytc-text);font-size:12px;flex:1;",
  outside: "color:var(--ytc-text-sub);font-size:11px;",
  iconButton: SEGMENT_STYLE.iconButton,
  textButton: `border:1px solid var(--ytc-border);background:transparent;color:var(--ytc-text);border-radius:6px;height:24px;padding:0 8px;cursor:pointer;font-family:${FONT};font-size:12px;`,
  textarea: `width:100%;box-sizing:border-box;min-height:40px;resize:vertical;border:1px solid var(--ytc-border);border-radius:6px;background:transparent;color:var(--ytc-text);font-family:${FONT};font-size:13px;padding:4px 6px;`,
} as const;
```

- [ ] **Step 5: `telop-list.ts` を作る**

```typescript
/**
 * エディットモードで出すテロップの一覧。
 *
 * **選択状態は持たない。** 区間の一覧と違い、拡大バーと連動させない (時刻は
 * 「開始を今に / 終了を今に」で決める)。渡されたものを描き、押されたことを伝えるだけ。
 */

import { TELOP_STYLE } from "@/content/styles";
import { overlapsSegments } from "@/shared/telop";
import { formatTime } from "@/shared/time";
import type { ClipRange, Telop } from "@/shared/types";

export type TelopListCallbacks = {
  /** ＋ テロップ。今の再生位置から足す */
  onAdd(): void;
  onSetStart(index: number): void;
  onSetEnd(index: number): void;
  /** そのテロップの頭から再生する */
  onPlay(index: number): void;
  onRemove(index: number): void;
  /** 文言が確定した (フォーカスが外れた) */
  onText(index: number, text: string): void;
};

export type TelopList = {
  element: HTMLElement;
  /** テロップと区間 (区間外の判定に使う) を反映して描き直す */
  update(telops: Telop[], segments: ClipRange[]): void;
  /** 操作を受け付けるか。ready / posted のときだけ true */
  setEnabled(enabled: boolean): void;
};

type Row = {
  root: HTMLElement;
  label: HTMLElement;
  outside: HTMLElement;
  textarea: HTMLTextAreaElement;
};

function telopLabel(telop: Telop, index: number): string {
  return `${index + 1}. ${formatTime(telop.startSec)} 〜 ${formatTime(telop.endSec)}`;
}

export function createTelopList(callbacks: TelopListCallbacks): TelopList {
  const element = document.createElement("div");
  element.style.cssText = TELOP_STYLE.root;
  element.hidden = true;

  let enabled = true;

  /** 押せない間は伝えない。押せるのに何も起きない状態を作らない */
  function fire(action: () => void): (event: Event) => void {
    return (event) => {
      event.stopPropagation();
      if (!enabled) return;
      action();
    };
  }

  function makeButton(
    role: string,
    label: string,
    title: string,
    style: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.dataset.role = role;
    button.textContent = label;
    button.title = title;
    button.style.cssText = style;
    button.addEventListener("click", fire(onClick));
    return button;
  }

  const header = document.createElement("div");
  header.style.cssText = TELOP_STYLE.header;
  const title = document.createElement("span");
  title.style.cssText = TELOP_STYLE.title;
  title.textContent = "テロップ";
  header.append(
    title,
    makeButton("add-telop", "＋ テロップ", "今の位置からテロップを足す", TELOP_STYLE.textButton, () =>
      callbacks.onAdd(),
    ),
  );

  const body = document.createElement("div");
  body.style.cssText = TELOP_STYLE.root;
  element.append(header, body);

  /**
   * 行は index ごとに使い回す。**作り直さない。** 状態通知のたびに作り直すと、
   * 打ちかけの文字とフォーカスが消える
   */
  const rows: Row[] = [];

  function makeRow(index: number): Row {
    const root = document.createElement("div");
    root.dataset.role = "telop";
    root.style.cssText = TELOP_STYLE.row;

    const head = document.createElement("div");
    head.style.cssText = TELOP_STYLE.rowHead;
    const label = document.createElement("span");
    label.style.cssText = TELOP_STYLE.label;
    const outside = document.createElement("span");
    outside.style.cssText = TELOP_STYLE.outside;
    outside.textContent = "(区間外)";

    head.append(
      label,
      outside,
      makeButton("set-start", "開始を今に", "開始を今の再生位置に合わせる", TELOP_STYLE.textButton, () =>
        callbacks.onSetStart(index),
      ),
      makeButton("set-end", "終了を今に", "終了を今の再生位置に合わせる", TELOP_STYLE.textButton, () =>
        callbacks.onSetEnd(index),
      ),
      makeButton("play", "▶", "このテロップの頭から再生", TELOP_STYLE.iconButton, () =>
        callbacks.onPlay(index),
      ),
      makeButton("remove", "✕", "このテロップを消す", TELOP_STYLE.iconButton, () =>
        callbacks.onRemove(index),
      ),
    );

    const textarea = document.createElement("textarea");
    textarea.style.cssText = TELOP_STYLE.textarea;
    textarea.placeholder = "文言 (改行できます)";
    // 1 文字ごとに送ると、そのたびにクリップが外れて状態通知が飛ぶ
    textarea.addEventListener("change", () => {
      if (!enabled) return;
      callbacks.onText(index, textarea.value);
    });
    // YouTube のショートカットは入力欄の中では効かない作りだが、**念のため止める。**
    // 打つ文字が多く、YouTube 側の判定が変わったときの被害が大きい
    textarea.addEventListener("keydown", (event) => event.stopPropagation());

    root.append(head, textarea);
    return { root, label, outside, textarea };
  }

  return {
    element,

    update(telops, segments): void {
      // 区間が無いときは箱ごと消す (テロップは区間に焼き込むもの)
      element.hidden = segments.length === 0;

      while (rows.length > telops.length) {
        rows.pop()?.root.remove();
      }
      while (rows.length < telops.length) {
        const row = makeRow(rows.length);
        rows.push(row);
        body.append(row.root);
      }

      telops.forEach((telop, index) => {
        const row = rows[index];
        if (row === undefined) return;
        row.label.textContent = telopLabel(telop, index);
        row.outside.hidden = overlapsSegments(telop, segments);
        // **フォーカス中の入力欄は value も触らない。** 書き換えると打ちかけの
        // 文字が消え、しかもその後 blur しても change が発火しない
        if (document.activeElement !== row.textarea) {
          row.textarea.value = telop.text;
        }
      });
    },

    setEnabled(next): void {
      enabled = next;
      // 見た目でも押せないことを示す。押せる見た目のまま無反応にしない
      element.style.opacity = next ? "1" : "0.5";
      for (const row of rows) row.textarea.disabled = !next;
    },
  };
}
```

- [ ] **Step 6: `youtube.ts` に配線する**

import に `import { createTelopList, type TelopList } from "@/content/telop-list";` を足す。

`let segmentList: SegmentList | null = null;` の直後に `let telopList: TelopList | null = null;` を足す。

`onAddSegment` の後に足す。

```typescript
/** テロップを出す既定の長さ (秒) */
const DEFAULT_TELOP_SEC = 3;

/**
 * テロップを編集してよいか。区間の拡大バーと同じ条件 (`ready` / `posted` で、
 * 範囲を作った動画を見ている)。**区間は触れないのにテロップだけ触れる非対称を作らない**
 */
function canEditTelops(): boolean {
  return canAdjustRange();
}

/** ＋ テロップ。今の位置から 3 秒、文言なし。動画の長さを超えるなら終わりを詰める */
function onAddTelop(): void {
  if (!canEditTelops()) {
    setStatus("いまはテロップを変更できません");
    return;
  }
  const video = getVideo();
  // メタデータを読む前は duration が NaN。そのまま足すと状態機械が throw する
  if (!Number.isFinite(video.duration)) {
    setStatus("動画の長さが分からないため、テロップを足せません");
    return;
  }
  const startSec = video.currentTime;
  const endSec = Math.min(startSec + DEFAULT_TELOP_SEC, video.duration);
  if (endSec <= startSec) {
    setStatus("動画の終わりにはテロップを足せません");
    return;
  }
  send({ type: "ADD_TELOP", telop: { startSec, endSec, text: "" } });
}

/**
 * テロップの開始か終了を今の位置に合わせる。
 *
 * **開始が終了以上になる操作は送らない。** 状態機械は不正な時刻で throw する。
 * 黙って無反応にせず理由を出す
 */
function onMoveTelopEdge(index: number, edge: "start" | "end"): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  const sec = getVideo().currentTime;
  const next =
    edge === "start" ? { ...telop, startSec: sec } : { ...telop, endSec: sec };
  if (next.endSec <= next.startSec) {
    setStatus("開始は終了より前にしてください");
    return;
  }
  send({ type: "UPDATE_TELOP", index, telop: next });
}

/** 文言の確定。改行はそのまま持つ */
function onTelopText(index: number, text: string): void {
  const telop = currentTelops[index];
  if (telop === undefined || !canEditTelops()) return;
  if (telop.text === text) return;
  send({ type: "UPDATE_TELOP", index, telop: { ...telop, text } });
}

/** そのテロップの頭から再生する。範囲再生の監視は解く (押した場所からの再生が止まる) */
async function playTelop(index: number): Promise<void> {
  const telop = currentTelops[index];
  if (telop === undefined || busy) return;
  cancelPreviewWatch();
  if ((await seekAndPlay(telop.startSec)) === null) return;
  setStatus(`テロップ ${index + 1} の頭から再生中…`);
}
```

`buildBar` の中の `segmentList = createSegmentList({ ... })` の `onRemove` を差し替える。

```typescript
    onRemove: (index) => {
      // **テロップが残っている間は最後の 1 区間を消させない。** 区間が 0 個に
      // なると状態機械は idle に戻り、手入力の文言もまとめて消える
      if (currentSegments.length === 1 && currentTelops.length > 0) {
        setStatus(
          `テロップが ${currentTelops.length} 件残っています。先にテロップを消してください`,
        );
        return;
      }
      removedIndexOnNextState = index;
      send({ type: "REMOVE_SEGMENT", index });
    },
```

同じ `buildBar` の `segmentList = ...` の直後に足し、`bar.append(` の引数の `segmentList.element,` の直後に `telopList.element,` を足す。

```typescript
  telopList = createTelopList({
    onAdd: onAddTelop,
    onSetStart: (index) => onMoveTelopEdge(index, "start"),
    onSetEnd: (index) => onMoveTelopEdge(index, "end"),
    onPlay: (index) => void playTelop(index),
    onRemove: (index) => {
      if (!canEditTelops()) return;
      send({ type: "REMOVE_TELOP", index });
    },
    onText: onTelopText,
  });
```

`applyStateToDisplay` の `currentTelops = ...` (Task 8 で足した行) を次に差し替える。

```typescript
  const previousTelopCount = currentTelops.length;
  currentTelops =
    liveSegments.length === 0 || !("telops" in state) ? [] : state.telops;
  // 最後の区間の削除は UI で止めているが、手元の写しが古くて止め損ねた場合に
  // 黙って消さない
  if (
    removedIndexOnNextState !== null &&
    previousTelopCount > 0 &&
    currentTelops.length === 0
  ) {
    setStatus("テロップも消えました");
  }
```

※ この差し替えは `removedIndexOnNextState = null;` より**前**に置くこと (既存の順序では `currentSegments = liveSegments;` の直後で、選択を詰める処理より前なので、Task 8 で足した位置のままでよい)。

同じ関数の `segmentList?.update(...)` の直後に足す。

```typescript
  telopList?.setEnabled(canEditTelops());
  telopList?.update(
    mode === "edit" ? currentTelops : [],
    mode === "edit" ? currentSegments : [],
  );
```

- [ ] **Step 7: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

- [ ] **Step 8: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/telop-list.ts src/content/styles.ts src/content/youtube.ts tests/content/telop-list.test.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): テロップの一覧から作る・直す・消す

行は作り直さず使い回し、フォーカス中の入力欄は value も触らない。書き換えると
打ちかけの文字が消え、その後 change も発火しない。テロップが残っている間は
最後の区間を消させない (区間と一緒に手入力の文言が全部消えるため)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 10: 録画中にタブが隠れたら中断する (Task 1 の検証 4 の結果次第)

**Files:**
- Modify: `src/shared/types.ts` (失敗理由)
- Modify: `src/content/telop-compositor.ts` (Task 1 で「canvas 経由だけ止まる」だった場合)
- Modify: `src/content/youtube.ts`
- Modify: `tests/content/telop-compositor.test.ts`
- Modify: `tests/content/youtube.test.ts`

**Interfaces:**
- Consumes: `startCompositor` (Task 7)、`prepareRecording` / `beginRecording` の配線 (Task 8)
- Produces: 失敗理由 `telop-tab-hidden` (A) または `tab-hidden` (B)

**実施するかを先に決める。** spec §9.1 (Task 1 で追記) を読み、次のどれかに当てはめる。

| 検証 4 の結果 | この Task |
|---|---|
| canvas 経由だけ止まる | **A** を実施 (失敗理由 `telop-tab-hidden`。テロップ付きの録画だけ) |
| 両方止まる | **B** を実施 (失敗理由 `tab-hidden`。全ての録画) |
| どちらも止まらない | **省略**。spec の自律判断ログに「[選択] Task 10 は省略 — §9.1 の検証 4 でどちらも止まらなかった」と 1 行足して commit し、次へ |

---

#### A. canvas 経由だけ止まる

- [ ] **A-1: 失敗するテストを書く (合成)**

`tests/content/telop-compositor.test.ts` に足す。ファイル先頭の import を `import { describe, expect, test, vi } from "vitest";` にする。

```typescript
describe("タブが隠れたとき", () => {
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  test("隠れたら onHidden を呼ぶ", () => {
    const fake = makeVideo();
    const { canvas } = makeCanvas();
    const onHidden = vi.fn();
    startCompositor(fake.video, [], STYLE, { createCanvas: () => canvas }, { onHidden });
    setHidden(true);
    expect(onHidden).toHaveBeenCalledOnce();
    setHidden(false);
  });

  test("release の後は呼ばない", () => {
    // 録画が終わった後に FAIL を送らない
    const fake = makeVideo();
    const { canvas } = makeCanvas();
    const onHidden = vi.fn();
    const compositor = startCompositor(
      fake.video,
      [],
      STYLE,
      { createCanvas: () => canvas },
      { onHidden },
    );
    compositor.release();
    setHidden(true);
    expect(onHidden).not.toHaveBeenCalled();
    setHidden(false);
  });
});
```

- [ ] **A-2: 失敗するテストを書く (配線)**

`tests/content/youtube.test.ts` の「テロップ付きの録画」の describe (Task 8) の中に足す。`installCanvas` と `recordWith` はその describe のものを使う。

```typescript
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    setHidden(false);
  });

  test("録画を始める前にタブが隠れていたら始めない", async () => {
    // 隠れたまま始めると、最初のフレームから映像が止まる
    installCanvas();
    setHidden(true);
    changeSettings({ mode: "edit" });

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [TELOP] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
  });

  test("録画中にタブが隠れたら中断する", async () => {
    installCanvas();
    await recordWith([TELOP]);
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "telop-tab-hidden" });
  });

  test("テロップの無い録画では隠れても中断しない", async () => {
    // 今の経路は隠れても映像が止まらない (§9.1)
    await recordWith([]);
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).not.toContainEqual(expect.objectContaining({ type: "FAIL" }));
  });
```

- [ ] **A-3: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-compositor.test.ts tests/content/youtube.test.ts -t "隠れ"`
期待: FAIL

- [ ] **A-4: 失敗理由を足し、合成に監視を足す**

`src/shared/types.ts` の `FailureReason` の `"telop-render-failed"` の後に足す。

```typescript
  /**
   * テロップ付きの録画中にタブが隠れた。隠れたタブでは canvas の映像が止まり、
   * 音声だけ進むクリップになる (テロップ spec §4.3、§9.1 で確認)。壊れたクリップを
   * 作ってから気付かせるより、中断して録り直させる
   */
  | "telop-tab-hidden"
```

`FAILURE_MESSAGES` に足す。

```typescript
  "telop-tab-hidden":
    "テロップ付きの録画中はタブを表示したままにしてください。もう一度録り直してください",
```

`src/content/telop-compositor.ts` に足す。

```typescript
export type CompositorOptions = {
  /** 録画中にタブが隠れた。呼ばれるのは release の前だけ */
  onHidden(): void;
};
```

`startCompositor` のシグネチャを `(video: HTMLVideoElement, telops: Telop[], style: TelopStyle, deps: CompositorDeps = defaultDeps, options?: CompositorOptions): Compositor` にし、最後の `handle = target.requestVideoFrameCallback(tick);` の直後に足す。

```typescript
  // **監視は release で外す。** 外し忘れると、録画が終わった後にタブを切り替えた
  // だけで FAIL が飛ぶ
  const onVisibilityChange = (): void => {
    if (!released && document.hidden) options?.onHidden();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
```

`release()` の中の `track.stop();` の直後に `document.removeEventListener("visibilitychange", onVisibilityChange);` を足す。

- [ ] **A-5: `youtube.ts` に配線する**

`prepareRecording` の `if (recordingTelops !== null) { assertTelopRenderable(getVideo()); }` を次にする。

```typescript
    if (recordingTelops !== null) {
      assertTelopRenderable(getVideo());
      // 隠れたまま始めると、最初のフレームから映像が止まる
      if (document.hidden) {
        recordingTelops = null;
        send({ type: "FAIL", reason: "telop-tab-hidden" });
        setStatus(FAILURE_MESSAGES["telop-tab-hidden"]);
        return;
      }
    }
```

`beginRecording` の `startCompositor(video, telops.telops, telops.style)` を次にする。

```typescript
        startCompositor(video, telops.telops, telops.style, undefined, {
          // 区間の間の広告検査と同じく FAIL で落とす。状態が recording を離れると
          // state/changed の処理が abortRecording を呼び、合成も解放される
          onHidden: () => {
            send({ type: "FAIL", reason: "telop-tab-hidden" });
            setStatus(FAILURE_MESSAGES["telop-tab-hidden"]);
          },
        })
```

- [ ] **A-6: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

- [ ] **A-7: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src tests
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): テロップ付きの録画中にタブが隠れたら中断する

隠れたタブでは canvas の映像が止まり、音声だけ進むクリップになる (実機で
確認)。壊れたクリップを作ってから気付かせるより、中断して録り直させる。
RETRY で区間もテロップも残るので、作業は消えない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

#### B. 両方止まる

テロップの有無に関わらず、録画中はタブを離れられない。監視は合成ではなく `youtube.ts` の録画の寿命に付ける。**`telop-compositor.ts` は触らない。**

- [ ] **B-1: 失敗するテストを書く**

`tests/content/youtube.test.ts` の末尾に足す (Task 8 の describe の外。テロップの無い録画も対象なので)。

```typescript
describe("録画中にタブが隠れたとき", () => {
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    setHidden(false);
  });

  test("録画を始める前に隠れていたら始めない", async () => {
    setHidden(true);

    emit({ kind: "seeking", segments: [RANGE], meta: META_A, telops: [] });
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "tab-hidden" });
    expect(clipEvents()).not.toContainEqual({ type: "SEEK_DONE" });
  });

  test("録画中に隠れたら中断する", async () => {
    emit({ kind: "recording", segments: [RANGE], meta: META_A, telops: [] });
    await flush();
    command("recorder/start");
    await flush();
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).toContainEqual({ type: "FAIL", reason: "tab-hidden" });
  });

  test("録画が終わった後に隠れても何も送らない", async () => {
    // 監視を外し忘れると、書き出し後にタブを切り替えただけで FAIL が飛ぶ
    emit({ kind: "recording", segments: [RANGE], meta: META_A, telops: [] });
    await flush();
    command("recorder/start");
    await flush();
    emit({ kind: "encoding", segments: [RANGE], meta: META_A, telops: [] });
    command("recorder/stop");
    await flush();
    sent = [];

    setHidden(true);
    await flush();

    expect(clipEvents()).not.toContainEqual(expect.objectContaining({ type: "FAIL" }));
  });
});
```

- [ ] **B-2: 実行して失敗を確認**

実行: `npx vitest run tests/content/youtube.test.ts -t "隠れ"`
期待: FAIL

- [ ] **B-3: 失敗理由を足す**

`src/shared/types.ts` の `FailureReason` の `"telop-render-failed"` の後に足す。

```typescript
  /**
   * 録画中にタブが隠れた。隠れたタブでは映像が止まり、音声だけ進むクリップになる
   * (テロップ spec §9.1 で、テロップの無い今の経路でも止まることを確認)。
   * 壊れたクリップを作ってから気付かせるより、中断して録り直させる
   */
  | "tab-hidden"
```

`FAILURE_MESSAGES` に足す。

```typescript
  "tab-hidden":
    "録画中はタブを表示したままにしてください。もう一度録り直してください",
```

- [ ] **B-4: `youtube.ts` に監視を足す**

モジュール変数の `let handle: RecorderHandle | null = null;` の直後に足す。

```typescript
/** 録画中のタブの表示の監視を外す。録画していなければ null */
let cancelVisibilityWatch: (() => void) | null = null;

/**
 * 録画中にタブが隠れたら中断する。**録画の寿命に付ける。** 外し忘れると、
 * 録画が終わった後にタブを切り替えただけで FAIL が飛ぶ
 */
function watchVisibility(): void {
  cancelVisibilityWatch?.();
  const onChange = (): void => {
    if (!document.hidden) return;
    // 1 回送ったら外す。失敗した後に何度も送らない
    cancelVisibilityWatch?.();
    send({ type: "FAIL", reason: "tab-hidden" });
    setStatus(FAILURE_MESSAGES["tab-hidden"]);
  };
  document.addEventListener("visibilitychange", onChange);
  cancelVisibilityWatch = () => {
    document.removeEventListener("visibilitychange", onChange);
    cancelVisibilityWatch = null;
  };
}
```

`prepareRecording` の `if (recordingTelops !== null) { assertTelopRenderable(getVideo()); }` の直後に足す (テロップの有無に関わらず見る)。

```typescript
    // 隠れたまま始めると、最初のフレームから映像が止まる
    if (document.hidden) {
      recordingTelops = null;
      send({ type: "FAIL", reason: "tab-hidden" });
      setStatus(FAILURE_MESSAGES["tab-hidden"]);
      return;
    }
```

`beginRecording` の `notify({ type: "recorder/started" });` の直前に `watchVisibility();` を足す。

`abortRecording` の先頭 (`if (handle === null) return;` の前) と、`finishRecording` の先頭 (`if (handle === null) {` の前) に、それぞれ `cancelVisibilityWatch?.();` を足す。

- [ ] **B-5: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

- [ ] **B-6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src tests
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): 録画中にタブが隠れたら中断する

隠れたタブでは、テロップの有無に関わらず映像が止まり、音声だけ進む
クリップになる (実機で確認)。壊れたクリップを作ってから気付かせるより、
中断して録り直させる。RETRY で区間もテロップも残るので、作業は消えない。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

B を実施した場合は、Task 2 で書いた README の「<タブの制約>」と `docs/manual-check.md` の最後の項目が「録画中は」になっているかを確かめ、なっていなければこの commit に含める。

---

### Task 11: プレイヤーの上にテロップのプレビューを重ねる

**Files:**
- Create: `src/content/telop-preview.ts`
- Modify: `src/content/youtube.ts`
- Create: `tests/content/telop-preview.test.ts`

**Interfaces:**
- Consumes: `drawTelops`・`resolveTelopStyle` (Task 6)、`currentTelops`・`telopStyle`・`applyTelopSettings` (Task 8)
- Produces:
  - `createTelopPreview(): TelopPreview`
  - `type TelopPreview = { update(video: HTMLVideoElement | null, telops: Telop[], style: TelopStyle): void; destroy(): void }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/telop-preview.test.ts` を作る。

```typescript
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTelopPreview } from "@/content/telop-preview";
import type { TelopStyle } from "@/shared/telop-style";

const STYLE: TelopStyle = {
  fontSizePx: 64,
  fontFamily: "sans-serif",
  fillColor: "#ffffff",
  strokeColor: "#000000",
  strokeWidthPx: 8,
};
const TELOP = { startSec: 10, endSec: 13, text: "見える" };

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

let texts: string[] = [];
let clears = 0;

function makeVideo() {
  const parent = document.createElement("div");
  const video = document.createElement("video");
  video.style.left = "10px";
  video.style.top = "20px";
  video.style.width = "640px";
  video.style.height = "360px";
  Object.defineProperty(video, "clientWidth", { value: 640 });
  Object.defineProperty(video, "clientHeight", { value: 360 });
  let current = 11;
  Object.defineProperty(video, "currentTime", {
    get: () => current,
    set: (value: number) => {
      current = value;
    },
  });
  const callbacks = new Map<number, FrameCallback>();
  let next = 1;
  Object.assign(video, {
    requestVideoFrameCallback: (callback: FrameCallback) => {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: (handle: number) => callbacks.delete(handle),
  });
  parent.append(video);
  document.body.append(parent);
  return {
    video,
    parent,
    frame(mediaTime: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0, { mediaTime });
    },
    pending: () => callbacks.size,
  };
}

beforeEach(() => {
  texts = [];
  clears = 0;
  const ctx = {
    font: "10px sans-serif",
    clearRect: () => {
      clears += 1;
    },
    save: () => undefined,
    restore: () => undefined,
    strokeText: () => undefined,
    fillText: (text: string) => texts.push(text),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("createTelopPreview", () => {
  test("video と同じ親に、video の矩形に合わせて canvas を置く", () => {
    // レターボックスは video の外にできるので、video の矩形に合わせれば黒帯に乗らない
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    const canvas = fake.parent.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.style.left).toBe("10px");
    expect(canvas?.style.top).toBe("20px");
    expect(canvas?.style.width).toBe("640px");
    expect(canvas?.style.pointerEvents).toBe("none");
    preview.destroy();
  });

  test("更新したその場で今の位置を描く (一時停止中でも見える)", () => {
    // rVFC は再生中しか発火しない。止めて文言を打つ間も描き直す
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    expect(texts).toContain("見える");
    preview.destroy();
  });

  test("再生中はフレームごとに描き直す", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    const before = clears;
    fake.frame(11.5);
    expect(clears).toBeGreaterThan(before);
    preview.destroy();
  });

  test("シークしたら描き直す", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    texts = [];
    fake.video.currentTime = 12;
    fake.video.dispatchEvent(new Event("seeked"));
    expect(texts).toContain("見える");
    preview.destroy();
  });

  test("テロップが無くなれば canvas を外してループを止める", () => {
    const fake = makeVideo();
    const preview = createTelopPreview();
    preview.update(fake.video, [TELOP], STYLE);
    preview.update(fake.video, [], STYLE);
    expect(fake.parent.querySelector("canvas")).toBeNull();
    expect(fake.pending()).toBe(0);
    preview.destroy();
  });

  test("描けない環境では warn だけ残して続ける", () => {
    // プレビューは目安。描けないことは操作を止める理由にならない
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = makeVideo();
    const preview = createTelopPreview();
    expect(() => preview.update(fake.video, [TELOP], STYLE)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    preview.destroy();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/telop-preview.test.ts`
期待: FAIL (`Failed to resolve import "@/content/telop-preview"`)

- [ ] **Step 3: `telop-preview.ts` を作る**

```typescript
/**
 * プレイヤーの上にテロップを重ねて見せる。
 *
 * **録画と同じ関数 (`drawTelops`) で描く。** CSS で描くと縁取りや行間が録画とずれる。
 *
 * **描けないときは warn だけ残して続ける。** プレビューは目安であり、描けないことは
 * 操作や録画を止める理由にならない (範囲の帯と同じ扱い。テロップ spec §6)
 */

import { drawTelops, resolveTelopStyle } from "@/content/telop-render";
import type { TelopStyle } from "@/shared/telop-style";
import type { Telop } from "@/shared/types";

const PREVIEW_ID = "yt-clip-telop-preview";

export type TelopPreview = {
  /**
   * 今のテロップと見た目で描き直す。テロップが空か video が無ければ外す。
   * 状態や設定が変わるたびに呼ぶ (その場で今の位置を描く)
   */
  update(video: HTMLVideoElement | null, telops: Telop[], style: TelopStyle): void;
  destroy(): void;
};

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};

export function createTelopPreview(): TelopPreview {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let attached: VideoWithFrameCallback | null = null;
  let telops: Telop[] = [];
  let style: TelopStyle | null = null;
  let frameHandle = 0;
  let resizeObserver: ResizeObserver | null = null;

  function warn(error: unknown): void {
    console.warn(`[yt-clip] テロップのプレビューを描けませんでした: ${String(error)}`);
  }

  /**
   * canvas を video の矩形に合わせる。YouTube は video に inline の left / top /
   * width / height を当てて動画のアスペクト比ぴったりに置くので、それを写せば
   * レターボックスの上に乗らない
   */
  function syncRect(): void {
    if (canvas === null || attached === null) return;
    const { left, top, width, height } = attached.style;
    canvas.style.left = left;
    canvas.style.top = top;
    canvas.style.width = width;
    canvas.style.height = height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(attached.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(attached.clientHeight * ratio));
  }

  function paint(sourceSec: number): void {
    if (canvas === null || ctx === null || style === null) return;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawTelops(ctx, telops, sourceSec, style, canvas.width, canvas.height);
    } catch (error) {
      warn(error);
    }
  }

  function paintNow(): void {
    if (attached !== null) paint(attached.currentTime);
  }

  const tick: FrameCallback = (_now, metadata) => {
    if (attached === null) return;
    paint(metadata.mediaTime);
    frameHandle = attached.requestVideoFrameCallback(tick);
  };

  /** 一時停止中は rVFC が来ない。シークの後はその場で描き直す */
  const onSeeked = (): void => paintNow();

  function detach(): void {
    if (attached !== null) {
      attached.cancelVideoFrameCallback(frameHandle);
      attached.removeEventListener("seeked", onSeeked);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    canvas?.remove();
    canvas = null;
    ctx = null;
    attached = null;
  }

  function attach(video: VideoWithFrameCallback): boolean {
    const parent = video.parentElement;
    if (parent === null) return false;

    const element = document.createElement("canvas");
    element.id = PREVIEW_ID;
    element.style.cssText = "position:absolute;pointer-events:none;z-index:10;";
    const context = element.getContext("2d");
    if (context === null) {
      warn(new Error("canvas の描画の文脈を取れません"));
      return false;
    }

    // **監視を先に用意してから状態に入れる。** 途中で落ちたときに、canvas だけ
    // 付いて監視の無い半端な状態を残さない
    // 大きさが変わったら位置も読み直す (シアターモードや全画面では同時に変わる)
    const observer = new ResizeObserver(() => {
      syncRect();
      paintNow();
    });

    parent.append(element);
    canvas = element;
    ctx = context;
    attached = video;
    resizeObserver = observer;
    syncRect();
    observer.observe(video);
    video.addEventListener("seeked", onSeeked);
    frameHandle = video.requestVideoFrameCallback(tick);
    return true;
  }

  return {
    update(video, nextTelops, nextStyle): void {
      telops = nextTelops;
      if (video === null || nextTelops.length === 0) {
        detach();
        return;
      }
      try {
        // SPA 遷移で video が差し替わったら付け直す
        if (attached !== video) {
          detach();
          if (!attach(video as VideoWithFrameCallback)) return;
        }
        if (ctx !== null) style = resolveTelopStyle(ctx, nextStyle);
        paintNow();
      } catch (error) {
        warn(error);
      }
    },

    destroy(): void {
      detach();
    },
  };
}
```

- [ ] **Step 4: `youtube.ts` に配線する**

import に `import { createTelopPreview } from "@/content/telop-preview";` を足す。

モジュール変数に足す (`let telopList ...` の直後)。

```typescript
/** プレイヤーの上のテロップ。バーを作り直しても使い回す (video に付いているため) */
const telopPreview = createTelopPreview();
```

`refreshOverlay` の後に足す。

```typescript
/**
 * プレビューを今のテロップと見た目に合わせる。
 *
 * エディットモードで、範囲を作った動画を見ているときだけ出す。別の動画の
 * テロップを重ねない (帯と同じ規則)
 */
function refreshTelopPreview(): void {
  let video: HTMLVideoElement | null = null;
  try {
    video = getVideo();
  } catch {
    // 動画要素がまだ無いか差し替えの最中。次の状態通知か DOM 変化で追いつく
    video = null;
  }
  const visible = mode === "edit" && rangeVideoId === currentVideoId();
  telopPreview.update(video, visible ? currentTelops : [], telopStyle);
}
```

呼ぶ場所を 3 つ足す。

1. `applyStateToDisplay` の `refreshOverlay();` の直後に `refreshTelopPreview();`
2. `applyTelopSettings` の末尾に `refreshTelopPreview();` (設定が変わったらその場で描き直す)
3. 末尾の `const observer = new MutationObserver(() => {` の中の `refreshOverlay();` の直後に `refreshTelopPreview();` (SPA 遷移で別の動画へ移ったら外す)

- [ ] **Step 5: 実行して通過を確認**

実行: `npm run typecheck && npm test`
期待: 型エラーなし、全テスト PASS

**その前に `tests/content/youtube.test.ts` の仕掛けを足す。** jsdom は `ResizeObserver` を持たず、`getContext` は "Not implemented" を console.error に流す。テストは落ちないが、プレビューが半端に付いた状態で走り、出力にノイズが混ざる。`installGlobals` の末尾に次を足す (Task 8 の `installCanvas` は `getContext` を spy し直すので、この既定の上に乗る)。

```typescript
  // プレビュー (telop-preview.ts) のため。jsdom は ResizeObserver を持たず、
  // canvas も描けない。描けない環境ではプレビューは warn して何もしない
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
```

`getContext` が null のとき、プレビューは `console.warn` を出す。テストの出力に出るのが煩わしければ、`installGlobals` で `console.warn` を黙らせず、そのまま残す (warn は理由を残すための仕組みであり、テストで消すと壊れたときに気付けない)。

- [ ] **Step 6: commit**

```bash
git -C /Users/trapple/repos/github.com/trapple/yt-clip add src/content/telop-preview.ts src/content/youtube.ts tests/content/telop-preview.test.ts tests/content/youtube.test.ts
git -C /Users/trapple/repos/github.com/trapple/yt-clip commit -m "$(cat <<'MSG'
feat(youtube): プレイヤーの上でテロップを録画と同じ見た目で見せる

video の矩形に canvas を重ね、録画と同じ関数で描く。rVFC は再生中しか
来ないので、テロップや設定を変えたとき・シークしたときにもその場で
描き直す (止めて文言を打つのが主な使い方のため)。

Claude-Session: b82d7fb3-2278-45ea-9692-62c7246061e3
MSG
)"
```

---

### Task 12: 実機で通しを確かめる (Playwright のスクリプト)

**2026-09-24 変更:** 当初は Claude in Chrome で操作する計画だったが、接続先の Chrome の取り違え・
ウィンドウが覆われると `hidden` になる・ツールでタブを隠せない、でユーザーの手作業が増えたため、
Playwright のスクリプトに変えた (ユーザー了承済み)。

**Files:**
- Create: `e2e/telop-check.spec.ts` (手動実行専用。環境変数 `YT_CLIP_TELOP_CHECK=1` が無ければ skip する)
- Modify: `package.json` (`"check:telop": "npm run build && YT_CLIP_TELOP_CHECK=1 playwright test e2e/telop-check.spec.ts"`)
- Modify: `docs/manual-check.md` (「## 確認した環境」に記入)

**Gate: human** — 音ズレとカクつきの最終判断だけ、書き出したクリップをユーザーに再生してもらう。

やり方:
- `chromium.launchPersistentContext` を `channel: "chrome"` (インストール済みの Google Chrome。同梱の
  Chromium は H.264 を持たず MP4 で録れない)・`headless: false` で起動し、`--load-extension=dist`、
  `--autoplay-policy=no-user-gesture-required`、`--disable-backgrounding-occluded-windows` (ウィンドウが
  覆われても hidden にしない。タブの切り替えで隠れる動作は本物のまま残る) を渡す
- 設定は拡張の service worker で `chrome.storage.sync` に書く (エディットモード)
- 録画結果は service worker から IndexedDB (`yt-clip` / `clips`) を読んで取り出し、ffprobe / ffmpeg で
  長さを測りフレームを書き出す
- 結果 (JSON・スクリーンショット・mp4・フレーム画像) を `test-results/telop-check/` に置く。controller が
  画像を見て判定し、ユーザーには mp4 を 1 本聞いてもらう

確かめること (`docs/manual-check.md` の「テロップ」節に対応):
焼き込みとプレビューの見た目の一致 / 出力の長さ = 区間の合計 / 360p と 1080p で比率が同じ /
テロップなしの録画が今までどおり / 入力中にショートカットが発火しない / 一時停止中の描き直し /
シアターモードでのプレビューの位置 / 最後の区間の ✕ が止まる / シンプルモードで一覧が出ない /
テロップ付きの録画中にタブが隠れたら中断し、もう一度で区間とテロップが残る

---

## 完了の条件

- `npm run typecheck && npm test` が通る
- `docs/manual-check.md` の「テロップ (エディットモード)」節が実機で通る (Task 12。音ズレはユーザーの耳で)
- whole-branch の cross-review (保守担当 + 攻撃者視点) が Approved
- branch `feat/telop-phase1` 上の commit で止める。push / PR はユーザーの指示を待つ
