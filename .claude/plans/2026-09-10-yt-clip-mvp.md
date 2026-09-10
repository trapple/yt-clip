# yt-clip MVP 実装プラン

> **実装者向け:** このプランは subagent-driven-development (推奨) または手動実行で消化する。step は `- [ ]` チェックボックスで track する。

**Goal:** YouTube 視聴ページで IN/OUT を指定するとその区間をタブ録画し、X の投稿画面に本文つきで動画を自動添付する Chrome 拡張 (MV3) を作る。

**Architecture:** MV3 の service worker は DOM も `MediaRecorder` も持てないため、録画は offscreen document に隔離する。YouTube 側 content script が IN/OUT UI と player 制御を担い、service worker が状態機械・`tabCapture` の streamId 取得・IndexedDB 保管を担い、x.com 側 content script が本文プリフィルと `DataTransfer` による自動添付を担う。全コンポーネントは `src/shared/` の型定義だけを介して通信する。

**Tech Stack:** TypeScript / Vite / @crxjs/vite-plugin / Vitest / fake-indexeddb / Playwright

## Global Constraints

### Spec 由来 (spec から逐語コピー)

- 最大クリップ長を **60 秒**に制限する
- MP4 判定は `MediaRecorder.isTypeSupported('video/mp4;codecs="avc1.42E01E,mp4a.40.2"')` を評価する
- 非対応時は WebM で録画し、「この環境では X に直接添付できません。変換してご利用ください」と明示する
- x.com の DOM 変更で添付に失敗した場合「X の画面構成が変わったため自動添付できませんでした。ファイルをダウンロードして手動で添付してください」と提示する
- **投稿ボタンは押さない。** 最終確認はユーザーに残す
- 停止側は `timeupdate` ではなく `requestVideoFrameCallback` で OUT フレームの到達を検出して停止する
- 録画開始は `video.currentTime = IN` の後に `seeked` イベント、続いて `playing` イベントを待ってから `MediaRecorder.start()` を呼ぶ
- 本文テンプレート既定値は `{title}` + 空行 + `{url}`、`{url}` は `https://youtu.be/{videoId}?t={IN秒}` に展開する
- 利用可能なテンプレート変数は `{title}` `{url}` `{videoId}` `{start}` `{end}` `{duration}`
- 権限: `tabCapture` `offscreen` `storage` `tabs` `downloads`、host は `https://www.youtube.com/*` と `https://x.com/*`
- 倍速再生すると早送り映像がそのまま記録されるため等速固定
- tabCapture 中はタブ音声が出なくなるため offscreen 側で `AudioContext` を通し `destination` へ流し戻す
- セレクタ定義を 1 ファイルに集約し、要素が見つからなければ即座に degraded path へ落とす
- 録画自体は成功したがその先の工程で失敗した場合は成果物を捨てない

### PJ 恒久ルール (CLAUDE.md / `.claude/rules/` 由来)

- コード内のコメント・ドキュメント・コミットメッセージはすべて **日本語**で記述する
- `cd <dir> && git ...` ではなく `git -C <dir> ...` を使う
- 日付・時刻を扱うときは JST (Asia/Tokyo) と UTC のどちらかを明示する。本 plan では**動画内の再生位置 (秒) と実時刻を混同しない**こと。`createdAt` は UTC epoch ミリ秒とする
- 外部プロセスを起動する処理には必ず timeout を設定する (本 plan では Playwright の起動と待機が該当)
- **Fail Fast**: 想定できる失敗は明示的な失敗状態としてユーザーに理由を提示し、握り潰した継続はしない
  - ※ 局所例外: 録画完了後の X 添付失敗のみ、例外を再 throw せず `downloadable` 状態へ退避させる。理由は「録画は実時間コストを払った成果物であり、破棄するとユーザーが同じ時間を再度支払うことになる」ため
- ドキュメントとコード両方に修正がある場合、先にドキュメントを修正してからコードに着手する
- **main 直コミット禁止**

### 運用前提 (brainstorming で確定した実装方式)

- 隔離方式: **branch** (worktree なし)。ブランチ名 `feat/yt-clip-mvp` (作成済み)
- 並列方式: **SDD** (subagent-driven-development)
- spec は `.claude/specs/2026-09-10-yt-clip-design.md` に commit 済み (commit `e74b9a5`)
- Task 1 は全タスクの土台であり **直列**で先に完了させる。Task 2〜7 は Task 1 完了後に**並列実行可能**

---

## ファイル構造マップ

| ファイル | 責務 | 担当タスク |
|---|---|---|
| `src/shared/types.ts` | ドメイン型 (ClipRange / VideoMeta / ClipState / ClipEvent) | Task 1 |
| `src/shared/messages.ts` | chrome.runtime メッセージの型と型ガード | Task 1 |
| `src/shared/time.ts` | 秒⇄表示変換、範囲バリデーション | Task 1 |
| `src/shared/template.ts` | 本文テンプレート展開、YouTube URL 生成 | Task 2 |
| `src/shared/filename.ts` | 添付・保存用のファイル名生成 | Task 7 |
| `src/background/state.ts` | 状態機械 (純粋関数 reducer) | Task 3 |
| `src/background/storage.ts` | IndexedDB へのクリップ CRUD | Task 4 |
| `src/offscreen/codec.ts` | MP4 対応判定 | Task 5 |
| `src/offscreen/recorder.ts` | streamId → Blob。他を一切知らない | Task 5 |
| `src/offscreen/offscreen.html` | offscreen document のホスト | Task 5 |
| `src/offscreen/main.ts` | offscreen 側のメッセージ受付 | Task 5 |
| `src/content/player.ts` | seek/play/待機の Promise ラッパ、広告検出 | Task 6 |
| `src/content/youtube.ts` | IN/OUT UI 注入とメタ取得 | Task 6 |
| `src/content/selectors.ts` | YouTube / X の DOM セレクタ集約 | Task 6 |
| `src/content/x.ts` | 本文プリフィルと動画添付 | Task 7 |
| `src/background/capture.ts` | tabCapture + offscreen ライフサイクル | Task 8 |
| `src/background/router.ts` | メッセージ処理の本体 (依存注入でテスト可能) | Task 9 |
| `src/background/sw.ts` | エントリ。実物の chrome API を router へ配線するだけ | Task 9 |
| `src/popup/view.ts` | 状態から画面表示を決める純粋関数 | Task 10 |
| `src/popup/popup.html` / `popup.ts` | IN/OUT 確認・録画・プレビュー・投稿 | Task 10 |
| `e2e/smoke.spec.ts` | 拡張ロードと録画完了までのスモーク | Task 11 |
| `docs/manual-check.md` | リリース前手動確認チェックリスト | Task 11 |

---

## Task 1: プロジェクト土台と共有型定義

**依存:** なし (最初に直列で完了させる)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.config.ts`, `.gitignore`
- Create: `src/shared/types.ts`, `src/shared/messages.ts`, `src/shared/time.ts`
- Test: `tests/shared/time.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: 後続の全タスクが依存する。
  - `src/shared/types.ts`: `ClipRange` `VideoMeta` `DegradedReason` `FailureReason` `ClipState` `ClipEvent`
  - `src/shared/messages.ts`: `Message`
  - `src/shared/time.ts`: `MAX_CLIP_SEC` `MIN_CLIP_SEC` `formatTime(totalSec: number): string` `toUrlSeconds(sec: number): number` `validateRange(startSec: number, endSec: number): RangeValidation`

- [ ] **Step 1: 依存関係とビルド設定を作る**

`package.json`:

```json
{
  "name": "yt-clip",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.28",
    "@playwright/test": "^1.47.0",
    "@types/chrome": "^0.0.268",
    "@types/node": "^22.0.0",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["chrome", "node", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", "tests", "e2e", "*.config.ts"]
}
```

`.gitignore`:

```
node_modules/
dist/
test-results/
playwright-report/
.DS_Store
```

- [ ] **Step 2: Vite / Vitest / manifest を設定する**

`manifest.config.ts`:

```typescript
import { defineManifest } from "@crxjs/vite-plugin";

// 権限は設計ドキュメント「必要な権限」表と 1:1 対応させる
export default defineManifest({
  manifest_version: 3,
  name: "yt-clip",
  version: "0.1.0",
  description: "YouTube の切り抜きを作って X に投稿する",
  permissions: ["tabCapture", "offscreen", "storage", "tabs", "downloads"],
  host_permissions: ["https://www.youtube.com/*", "https://x.com/*"],
  background: {
    service_worker: "src/background/sw.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/popup.html",
  },
  content_scripts: [
    {
      matches: ["https://www.youtube.com/watch*"],
      js: ["src/content/youtube.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://x.com/*"],
      js: ["src/content/x.ts"],
      run_at: "document_idle",
    },
  ],
});
```

`vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: { "@": src },
  },
  build: {
    rollupOptions: {
      // offscreen document は manifest から参照されないため明示的に入力へ加える
      input: {
        offscreen: fileURLToPath(
          new URL("./src/offscreen/offscreen.html", import.meta.url),
        ),
      },
    },
  },
});
```

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

実行: `npm install`
期待: 依存がインストールされ `node_modules/` が作られる

- [ ] **Step 3: 共有型を定義する**

`src/shared/types.ts`:

```typescript
/** 動画内の再生位置 (秒)。実時刻ではないので Date と混同しないこと */
export type ClipRange = {
  startSec: number;
  endSec: number;
};

export type VideoMeta = {
  videoId: string;
  title: string;
};

/** 録画は成功したが通常の投稿フローに乗せられなかった理由 */
export type DegradedReason = "mp4-unsupported" | "x-attach-failed";

/** 明示的な失敗の理由。握り潰さず必ずユーザーに提示する */
export type FailureReason =
  | "capture-permission-denied"
  | "seek-failed"
  | "playback-failed"
  | "ad-playing"
  | "tab-lost"
  | "recording-aborted"
  /** 状態機械の不正遷移など、ユーザー起因ではない内部エラー */
  | "internal-error";

export type ClipState =
  | { kind: "idle" }
  | { kind: "marking"; startSec: number; meta: VideoMeta }
  | { kind: "ready"; range: ClipRange; meta: VideoMeta }
  | { kind: "seeking"; range: ClipRange; meta: VideoMeta }
  | { kind: "recording"; range: ClipRange; meta: VideoMeta }
  | { kind: "encoding"; range: ClipRange; meta: VideoMeta }
  | {
      kind: "preview";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
    }
  | {
      kind: "composing";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
    }
  | {
      kind: "downloadable";
      clipId: string;
      range: ClipRange;
      meta: VideoMeta;
      mimeType: string;
      reason: DegradedReason;
    }
  /** range / meta が null なのは、マーク確定前に起きた内部エラーの場合だけ */
  | {
      kind: "failed";
      reason: FailureReason;
      range: ClipRange | null;
      meta: VideoMeta | null;
    };

export type ClipEvent =
  | { type: "MARK_IN"; sec: number; meta: VideoMeta }
  | { type: "MARK_OUT"; sec: number }
  | { type: "RESET_MARKS" }
  | { type: "START_RECORDING" }
  | { type: "SEEK_DONE" }
  | { type: "OUT_REACHED" }
  | { type: "BLOB_READY"; clipId: string; mimeType: string }
  | { type: "RETAKE" }
  | { type: "POST" }
  | { type: "ATTACHED" }
  | { type: "DEGRADE"; reason: DegradedReason }
  | { type: "FAIL"; reason: FailureReason }
  | { type: "RETRY" };
```

`src/shared/messages.ts`:

```typescript
import type { ClipEvent, ClipState } from "@/shared/types";

/** chrome.runtime を流れるメッセージ。両端がこの型だけを知る */
export type Message =
  /** popup / content → sw: 現在状態の問い合わせ */
  | { type: "state/get" }
  /** sw → popup / content: 状態変化の通知 */
  | { type: "state/changed"; state: ClipState }
  /** content / popup → sw: 状態機械へのイベント投入 */
  | { type: "clip/event"; event: ClipEvent }
  /** sw → offscreen: 録画開始。使用する形式は offscreen 側が判定する */
  | { type: "recorder/start"; streamId: string }
  /** sw → offscreen: 録画停止 */
  | { type: "recorder/stop" }
  /** offscreen → sw: 録画が実際に始まった。これを待ってから再生を再開させる */
  | { type: "recorder/started" }
  /** offscreen → sw: 録画結果 */
  | { type: "recorder/done"; buffer: ArrayBuffer; mimeType: string }
  /** offscreen → sw: 録画中の失敗 */
  | { type: "recorder/failed"; reason: string }
  /** content(x) → sw: 投稿画面の準備完了 */
  | { type: "x/ready" }
  /** sw → content(x): 添付する動画と本文 */
  | {
      type: "x/payload";
      buffer: ArrayBuffer;
      mimeType: string;
      fileName: string;
      text: string;
    }
  /** content(x) → sw: 添付成功 */
  | { type: "x/attached" }
  /** content(x) → sw: 添付失敗 (DOM 変更など) */
  | { type: "x/failed"; reason: string };

/** sw が返す応答。state/get のみ状態を返し、他は受領確認のみ */
export type MessageResponse = { state: ClipState } | { ok: true };
```

実行: `npx tsc --noEmit`
期待: エラーなし

- [ ] **Step 4: 失敗するテストを書く**

`tests/shared/time.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  formatTime,
  toUrlSeconds,
  validateRange,
} from "@/shared/time";

describe("formatTime", () => {
  test("1 時間未満は m:ss で表示する", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9)).toBe("0:09");
    expect(formatTime(75)).toBe("1:15");
    expect(formatTime(599)).toBe("9:59");
  });

  test("1 時間以上は h:mm:ss で表示する", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  test("端数は切り捨てる", () => {
    expect(formatTime(75.9)).toBe("1:15");
  });

  test("不正な値は握り潰さず throw する", () => {
    expect(() => formatTime(-1)).toThrow(RangeError);
    expect(() => formatTime(Number.NaN)).toThrow(RangeError);
    expect(() => formatTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("toUrlSeconds", () => {
  test("URL 用に整数へ切り捨てる", () => {
    expect(toUrlSeconds(75.9)).toBe(75);
    expect(toUrlSeconds(0)).toBe(0);
  });

  test("不正な値は throw する", () => {
    expect(() => toUrlSeconds(-1)).toThrow(RangeError);
  });
});

describe("validateRange", () => {
  test("妥当な範囲は ok を返す", () => {
    expect(validateRange(10, 40)).toEqual({ ok: true });
  });

  test("上限ちょうどは許可する", () => {
    expect(validateRange(0, MAX_CLIP_SEC)).toEqual({ ok: true });
  });

  test("下限ちょうどは許可する", () => {
    expect(validateRange(0, MIN_CLIP_SEC)).toEqual({ ok: true });
  });

  test("終了が開始以前なら理由つきで拒否する", () => {
    const result = validateRange(40, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("終了位置は開始位置より後にしてください");
    }
  });

  test("短すぎる範囲は拒否する", () => {
    const result = validateRange(10, 10.5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("クリップは 1 秒以上必要です");
    }
  });

  test("60 秒を超える範囲は現在の長さつきで拒否する", () => {
    const result = validateRange(0, 90);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("クリップは 60 秒までです (現在 90 秒)");
    }
  });

  test("不正な値は throw する", () => {
    expect(() => validateRange(Number.NaN, 10)).toThrow(RangeError);
  });
});
```

- [ ] **Step 5: 実行して失敗を確認**

実行: `npx vitest run tests/shared/time.test.ts`
期待: FAIL (`Failed to resolve import "@/shared/time"`)

- [ ] **Step 6: time.ts を実装する**

`src/shared/time.ts`:

```typescript
/** 1 クリップの最大長 (秒)。ArrayBuffer 転送量を抑えるための上限 */
export const MAX_CLIP_SEC = 60;

/** 1 クリップの最小長 (秒) */
export const MIN_CLIP_SEC = 1;

export type RangeValidation = { ok: true } | { ok: false; message: string };

/** 再生位置として妥当か検査する。妥当でなければ throw (Fail Fast) */
function assertPlayableSeconds(sec: number, label: string): void {
  if (!Number.isFinite(sec) || sec < 0) {
    throw new RangeError(`${label} が再生位置として不正です: ${sec}`);
  }
}

/** 再生位置を m:ss / h:mm:ss 形式に整形する */
export function formatTime(totalSec: number): string {
  assertPlayableSeconds(totalSec, "再生位置");
  const whole = Math.floor(totalSec);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours === 0) {
    return `${minutes}:${ss}`;
  }
  return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
}

/** YouTube URL の t= に載せる整数秒へ変換する */
export function toUrlSeconds(sec: number): number {
  assertPlayableSeconds(sec, "再生位置");
  return Math.floor(sec);
}

/** IN/OUT の組が録画可能な範囲かを検査する */
export function validateRange(
  startSec: number,
  endSec: number,
): RangeValidation {
  assertPlayableSeconds(startSec, "開始位置");
  assertPlayableSeconds(endSec, "終了位置");

  if (endSec <= startSec) {
    return { ok: false, message: "終了位置は開始位置より後にしてください" };
  }

  const duration = endSec - startSec;
  if (duration < MIN_CLIP_SEC) {
    return { ok: false, message: `クリップは ${MIN_CLIP_SEC} 秒以上必要です` };
  }
  if (duration > MAX_CLIP_SEC) {
    return {
      ok: false,
      message: `クリップは ${MAX_CLIP_SEC} 秒までです (現在 ${Math.round(duration)} 秒)`,
    };
  }

  return { ok: true };
}
```

- [ ] **Step 7: 実行して通過を確認**

実行: `npx vitest run tests/shared/time.test.ts && npx tsc --noEmit`
期待: PASS (13 tests) / 型エラーなし

- [ ] **Step 8: commit**

```bash
git -C . add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts manifest.config.ts .gitignore src/shared tests/shared
git -C . commit -m "feat: プロジェクト土台と共有型定義を追加

全コンポーネントが shared/ の型だけを介して通信できるよう、
先に ClipState / ClipEvent / Message を確定させる。以降のタスクを
並列に進めるための土台となる。"
```

---

## Task 2: 本文テンプレート展開

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/shared/template.ts`
- Test: `tests/shared/template.test.ts`

**Interfaces:**
- Consumes: `ClipRange` `VideoMeta` (`@/shared/types`)、`toUrlSeconds` (`@/shared/time`)
- Produces:
  - `DEFAULT_TEMPLATE: string`
  - `buildYouTubeUrl(videoId: string, startSec: number): string`
  - `renderTemplate(template: string, meta: VideoMeta, range: ClipRange): string`

- [ ] **Step 1: 失敗するテストを書く**

`tests/shared/template.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  DEFAULT_TEMPLATE,
  buildYouTubeUrl,
  renderTemplate,
} from "@/shared/template";
import type { ClipRange, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "dQw4w9WgXcQ", title: "サンプル動画" };
const range: ClipRange = { startSec: 75.4, endSec: 105.4 };

describe("buildYouTubeUrl", () => {
  test("開始秒つきの短縮 URL を作る", () => {
    expect(buildYouTubeUrl("dQw4w9WgXcQ", 75.4)).toBe(
      "https://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("先頭からの場合も t=0 を付ける", () => {
    expect(buildYouTubeUrl("abc", 0)).toBe("https://youtu.be/abc?t=0");
  });
});

describe("renderTemplate", () => {
  test("既定テンプレートはタイトルと URL を空行で挟む", () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, meta, range)).toBe(
      "サンプル動画\n\nhttps://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("全変数を展開する", () => {
    const template = "{title}/{videoId}/{start}/{end}/{duration}/{url}";
    expect(renderTemplate(template, meta, range)).toBe(
      "サンプル動画/dQw4w9WgXcQ/1:15/1:45/30/https://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("同じ変数を複数回使える", () => {
    expect(renderTemplate("{title} {title}", meta, range)).toBe(
      "サンプル動画 サンプル動画",
    );
  });

  test("変数を含まないテンプレートはそのまま返す", () => {
    expect(renderTemplate("固定文言", meta, range)).toBe("固定文言");
  });

  test("未知の変数は握り潰さず throw する", () => {
    expect(() => renderTemplate("{channel}", meta, range)).toThrow(
      "テンプレートに未知の変数があります: {channel}",
    );
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/shared/template.test.ts`
期待: FAIL (`Failed to resolve import "@/shared/template"`)

- [ ] **Step 3: template.ts を実装する**

`src/shared/template.ts`:

```typescript
import { formatTime, toUrlSeconds } from "@/shared/time";
import type { ClipRange, VideoMeta } from "@/shared/types";

/** 既定の投稿本文。タイトルと元動画 URL を空行で挟む */
export const DEFAULT_TEMPLATE = "{title}\n\n{url}";

/** 切り抜き開始位置つきの短縮 URL を組み立てる */
export function buildYouTubeUrl(videoId: string, startSec: number): string {
  return `https://youtu.be/${videoId}?t=${toUrlSeconds(startSec)}`;
}

/** テンプレート変数を展開する。未知の変数はバグなので throw する */
export function renderTemplate(
  template: string,
  meta: VideoMeta,
  range: ClipRange,
): string {
  const vars: Record<string, string> = {
    title: meta.title,
    videoId: meta.videoId,
    url: buildYouTubeUrl(meta.videoId, range.startSec),
    start: formatTime(range.startSec),
    end: formatTime(range.endSec),
    duration: String(Math.round(range.endSec - range.startSec)),
  };

  return template.replace(/\{(\w+)\}/g, (matched, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`テンプレートに未知の変数があります: ${matched}`);
    }
    return value;
  });
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/shared/template.test.ts && npx tsc --noEmit`
期待: PASS (7 tests) / 型エラーなし

- [ ] **Step 5: commit**

```bash
git -C . add src/shared/template.ts tests/shared/template.test.ts
git -C . commit -m "feat: 投稿本文テンプレートの展開を追加

未知の変数は既定値で埋めず throw する。テンプレートは設定で
編集可能にするため、typo を黙って空文字にすると原因が
分からなくなるため。"
```

---

## Task 3: 状態機械

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/background/state.ts`
- Test: `tests/background/state.test.ts`

**Interfaces:**
- Consumes: `ClipState` `ClipEvent` (`@/shared/types`)
- Produces:
  - `INITIAL_STATE: ClipState`
  - `reduce(state: ClipState, event: ClipEvent): ClipState`

**設計メモ:** `reduce` は範囲の妥当性を検証しない。`validateRange` の判定は content script 側 (UI で即座にエラー文言を出せる場所) の責務であり、`MARK_OUT` は検証を通ったときだけ送られる。`reduce` は遷移だけに責任を持つ純粋関数に保つ。定義されていない遷移は**プログラミングエラー**なので `failed` (`internal-error`) を返す。

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/state.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { INITIAL_STATE, reduce } from "@/background/state";
import type { ClipRange, ClipState, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "abc123", title: "テスト動画" };
const range: ClipRange = { startSec: 10, endSec: 40 };

const ready: ClipState = { kind: "ready", range, meta };
const preview: ClipState = {
  kind: "preview",
  clipId: "clip-1",
  range,
  meta,
  mimeType: "video/mp4",
};

describe("マーク操作", () => {
  test("初期状態は idle", () => {
    expect(INITIAL_STATE).toEqual({ kind: "idle" });
  });

  test("IN を打つと marking へ進む", () => {
    expect(reduce(INITIAL_STATE, { type: "MARK_IN", sec: 10, meta })).toEqual({
      kind: "marking",
      startSec: 10,
      meta,
    });
  });

  test("OUT を打つと ready へ進む", () => {
    const marking = reduce(INITIAL_STATE, { type: "MARK_IN", sec: 10, meta });
    expect(reduce(marking, { type: "MARK_OUT", sec: 40 })).toEqual(ready);
  });

  test("ready からでも IN を打ち直せる", () => {
    expect(reduce(ready, { type: "MARK_IN", sec: 20, meta })).toEqual({
      kind: "marking",
      startSec: 20,
      meta,
    });
  });

  test("RESET_MARKS で idle に戻る", () => {
    expect(reduce(ready, { type: "RESET_MARKS" })).toEqual({ kind: "idle" });
  });
});

describe("録画フロー", () => {
  test("録画開始で seeking へ進む", () => {
    expect(reduce(ready, { type: "START_RECORDING" })).toEqual({
      kind: "seeking",
      range,
      meta,
    });
  });

  test("seek 完了で recording へ進む", () => {
    const seeking = reduce(ready, { type: "START_RECORDING" });
    expect(reduce(seeking, { type: "SEEK_DONE" })).toEqual({
      kind: "recording",
      range,
      meta,
    });
  });

  test("OUT 到達で encoding へ進む", () => {
    const recording: ClipState = { kind: "recording", range, meta };
    expect(reduce(recording, { type: "OUT_REACHED" })).toEqual({
      kind: "encoding",
      range,
      meta,
    });
  });

  test("Blob 確定で preview へ進む", () => {
    const encoding: ClipState = { kind: "encoding", range, meta };
    expect(
      reduce(encoding, {
        type: "BLOB_READY",
        clipId: "clip-1",
        mimeType: "video/mp4",
      }),
    ).toEqual(preview);
  });

  test("取り直しで ready に戻る", () => {
    expect(reduce(preview, { type: "RETAKE" })).toEqual(ready);
  });
});

describe("投稿と degraded path", () => {
  test("投稿すると composing へ進む", () => {
    expect(reduce(preview, { type: "POST" })).toEqual({
      kind: "composing",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
    });
  });

  test("添付完了で idle に戻る", () => {
    const composing = reduce(preview, { type: "POST" });
    expect(reduce(composing, { type: "ATTACHED" })).toEqual({ kind: "idle" });
  });

  test("MP4 非対応なら preview から downloadable へ退避する", () => {
    expect(
      reduce(preview, { type: "DEGRADE", reason: "mp4-unsupported" }),
    ).toEqual({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
      reason: "mp4-unsupported",
    });
  });

  test("添付失敗なら composing から downloadable へ退避し成果物を保持する", () => {
    const composing = reduce(preview, { type: "POST" });
    const result = reduce(composing, {
      type: "DEGRADE",
      reason: "x-attach-failed",
    });
    expect(result).toEqual({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
  });

  test("downloadable からも取り直せる", () => {
    const degraded = reduce(preview, {
      type: "DEGRADE",
      reason: "mp4-unsupported",
    });
    expect(reduce(degraded, { type: "RETAKE" })).toEqual(ready);
  });
});

describe("失敗と復帰", () => {
  test("録画中の失敗は範囲を保持したまま failed になる", () => {
    const recording: ClipState = { kind: "recording", range, meta };
    expect(reduce(recording, { type: "FAIL", reason: "tab-lost" })).toEqual({
      kind: "failed",
      reason: "tab-lost",
      range,
      meta,
    });
  });

  test("RETRY で ready に戻る", () => {
    const failed = reduce(
      { kind: "seeking", range, meta },
      { type: "FAIL", reason: "seek-failed" },
    );
    expect(reduce(failed, { type: "RETRY" })).toEqual(ready);
  });

  test("範囲を持たない failed からの RETRY は idle に戻る", () => {
    const failed: ClipState = {
      kind: "failed",
      reason: "internal-error",
      range: null,
      meta: null,
    };
    expect(reduce(failed, { type: "RETRY" })).toEqual({ kind: "idle" });
  });

  test("定義されていない遷移は internal-error として明示的に失敗する", () => {
    expect(reduce(INITIAL_STATE, { type: "OUT_REACHED" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      range: null,
      meta: null,
    });
  });

  test("遷移に失敗しても直前の範囲は失われない", () => {
    expect(reduce(ready, { type: "SEEK_DONE" })).toEqual({
      kind: "failed",
      reason: "internal-error",
      range,
      meta,
    });
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/state.test.ts`
期待: FAIL (`Failed to resolve import "@/background/state"`)

- [ ] **Step 3: state.ts を実装する**

`src/background/state.ts`:

```typescript
import type {
  ClipEvent,
  ClipRange,
  ClipState,
  VideoMeta,
} from "@/shared/types";

export const INITIAL_STATE: ClipState = { kind: "idle" };

/** 状態が保持している範囲を取り出す。持たない状態では null */
function rangeOf(state: ClipState): ClipRange | null {
  return "range" in state ? state.range : null;
}

/** 状態が保持しているメタ情報を取り出す。持たない状態では null */
function metaOf(state: ClipState): VideoMeta | null {
  return "meta" in state ? state.meta : null;
}

/** 定義されていない遷移。バグなので握り潰さず失敗状態として表面化させる */
function invalid(state: ClipState): ClipState {
  return {
    kind: "failed",
    reason: "internal-error",
    range: rangeOf(state),
    meta: metaOf(state),
  };
}

/** 状態遷移。副作用を持たない純粋関数 */
export function reduce(state: ClipState, event: ClipEvent): ClipState {
  // 失敗はどの状態からでも受け付ける
  if (event.type === "FAIL") {
    return {
      kind: "failed",
      reason: event.reason,
      range: rangeOf(state),
      meta: metaOf(state),
    };
  }

  // IN の打ち直しはマーク済みのどの段階からでも許す
  if (event.type === "MARK_IN") {
    return { kind: "marking", startSec: event.sec, meta: event.meta };
  }

  switch (state.kind) {
    case "idle":
      return invalid(state);

    case "marking":
      if (event.type === "MARK_OUT") {
        return {
          kind: "ready",
          range: { startSec: state.startSec, endSec: event.sec },
          meta: state.meta,
        };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "ready":
      if (event.type === "START_RECORDING") {
        return { kind: "seeking", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "seeking":
      if (event.type === "SEEK_DONE") {
        return { kind: "recording", range: state.range, meta: state.meta };
      }
      return invalid(state);

    case "recording":
      if (event.type === "OUT_REACHED") {
        return { kind: "encoding", range: state.range, meta: state.meta };
      }
      return invalid(state);

    case "encoding":
      if (event.type === "BLOB_READY") {
        return {
          kind: "preview",
          clipId: event.clipId,
          mimeType: event.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      return invalid(state);

    case "preview":
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "POST") {
        return {
          kind: "composing",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
        };
      }
      if (event.type === "DEGRADE") {
        return {
          kind: "downloadable",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
          reason: event.reason,
        };
      }
      return invalid(state);

    case "composing":
      if (event.type === "ATTACHED") return { kind: "idle" };
      // 録画済みの成果物は捨てずにダウンロードへ退避させる
      if (event.type === "DEGRADE") {
        return {
          kind: "downloadable",
          clipId: state.clipId,
          mimeType: state.mimeType,
          range: state.range,
          meta: state.meta,
          reason: event.reason,
        };
      }
      return invalid(state);

    case "downloadable":
      if (event.type === "RETAKE") {
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);

    case "failed":
      if (event.type === "RETRY") {
        if (state.range === null || state.meta === null) {
          return { kind: "idle" };
        }
        return { kind: "ready", range: state.range, meta: state.meta };
      }
      if (event.type === "RESET_MARKS") return { kind: "idle" };
      return invalid(state);
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/state.test.ts && npx tsc --noEmit`
期待: PASS (20 tests) / 型エラーなし

- [ ] **Step 5: commit**

```bash
git -C . add src/background/state.ts tests/background/state.test.ts
git -C . commit -m "feat: クリップの状態機械を追加

不正な遷移を無視せず internal-error として表面化させる。UI から
想定外のイベントが飛んだとき、状態が黙って据え置かれると
操作不能の原因が追えなくなるため。"
```

---

## Task 4: クリップ保管 (IndexedDB)

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/background/storage.ts`
- Test: `tests/background/storage.test.ts`

**Interfaces:**
- Consumes: `ClipRange` `VideoMeta` (`@/shared/types`)
- Produces:
  - `StoredClip` 型: `{ id: string; blob: Blob; mimeType: string; range: ClipRange; meta: VideoMeta; createdAt: number }`
  - `saveClip(clip: StoredClip): Promise<void>`
  - `getClip(id: string): Promise<StoredClip>`
  - `clearClips(): Promise<void>`
  - `ClipNotFoundError` クラス

**設計メモ:** MVP は常に最新 1 件のみ保持する。`saveClip` は保存前に既存を全削除し、IndexedDB に録画データが溜まり続けるのを防ぐ。複数クリップの管理は将来の拡張。`createdAt` は **UTC epoch ミリ秒** (`Date.now()`)。動画内の再生位置 (`range`) とは別物なので混同しないこと。

**トランザクションの扱いが要点:** 削除と保存は同一トランザクションで行い、解決は `request.onsuccess` ではなく `tx.oncomplete` で行う。別トランザクションに分けると削除成功後の保存失敗で成果物が全損し、`onsuccess` で解決するとコミット段階の失敗が握り潰される。どちらも「録画の成果物を捨てない」制約に直接反する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/storage.test.ts`:

```typescript
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  ClipNotFoundError,
  clearClips,
  getClip,
  saveClip,
  type StoredClip,
} from "@/background/storage";

function makeClip(id: string): StoredClip {
  return {
    id,
    blob: new Blob(["ダミー動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    range: { startSec: 10, endSec: 40 },
    meta: { videoId: "abc123", title: "テスト動画" },
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };
}

describe("クリップ保管", () => {
  beforeEach(async () => {
    await clearClips();
  });

  test("保存したクリップを ID で取り出せる", async () => {
    await saveClip(makeClip("clip-1"));
    const found = await getClip("clip-1");

    expect(found.id).toBe("clip-1");
    expect(found.mimeType).toBe("video/mp4");
    expect(found.range).toEqual({ startSec: 10, endSec: 40 });
    expect(found.meta).toEqual({ videoId: "abc123", title: "テスト動画" });
    expect(found.createdAt).toBe(Date.UTC(2026, 8, 10, 3, 0, 0));
    expect(await found.blob.text()).toBe("ダミー動画データ");
  });

  test("新しいクリップを保存すると古いものは消える", async () => {
    await saveClip(makeClip("clip-1"));
    await saveClip(makeClip("clip-2"));

    await expect(getClip("clip-2")).resolves.toMatchObject({ id: "clip-2" });
    await expect(getClip("clip-1")).rejects.toThrow(ClipNotFoundError);
  });

  test("存在しない ID は握り潰さず throw する", async () => {
    await expect(getClip("missing")).rejects.toThrow(ClipNotFoundError);
  });

  test("clearClips で全件消える", async () => {
    await saveClip(makeClip("clip-1"));
    await clearClips();

    await expect(getClip("clip-1")).rejects.toThrow(ClipNotFoundError);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/storage.test.ts`
期待: FAIL (`Failed to resolve import "@/background/storage"`)

- [ ] **Step 3: storage.ts を実装する**

`src/background/storage.ts`:

```typescript
import type { ClipRange, VideoMeta } from "@/shared/types";

export type StoredClip = {
  id: string;
  blob: Blob;
  mimeType: string;
  range: ClipRange;
  meta: VideoMeta;
  /** 保存時刻 (UTC epoch ミリ秒)。動画内の再生位置とは別物 */
  createdAt: number;
};

export class ClipNotFoundError extends Error {
  constructor(id: string) {
    super(`クリップが見つかりません: ${id}`);
    this.name = "ClipNotFoundError";
  }
}

const DB_NAME = "yt-clip";
const DB_VERSION = 1;
const STORE = "clips";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * トランザクションを 1 つ張って実行し、**コミット完了まで待つ**。
 *
 * `request.onsuccess` で解決してはいけない。リクエスト成功とコミット確定は別で、
 * 容量超過などでコミット段階に abort した場合、先に解決済みの Promise には
 * その失敗が反映されず、書き込めていないのに成功として扱われてしまう。
 * 呼び出し側が結果を受け取れるよう、値は `onsuccess` で拾い `oncomplete` で返す。
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result: T;

      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("トランザクションが中断されました"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * クリップを保存する。MVP は最新 1 件のみ保持するため既存は破棄する。
 *
 * 削除と保存は **同一トランザクション**で行う。別トランザクションに分けると、
 * 削除に成功した後で保存が失敗したとき (動画 Blob は数十 MB になり容量超過は
 * 現実に起きうる) 旧クリップも新クリップも失われる。録画は実時間コストを
 * 払った成果物なので、失敗しても直前のクリップは残さなければならない。
 */
export async function saveClip(clip: StoredClip): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear();
      store.put(clip);

      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("クリップを保存できませんでした"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** クリップを取り出す。存在しない ID の参照はバグなので throw する */
export async function getClip(id: string): Promise<StoredClip> {
  const found = await withStore<StoredClip | undefined>("readonly", (store) =>
    store.get(id),
  );
  if (found === undefined) {
    throw new ClipNotFoundError(id);
  }
  return found;
}

export async function clearClips(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/storage.test.ts && npx tsc --noEmit`
期待: PASS (4 tests) / 型エラーなし

- [ ] **Step 5: commit**

```bash
git -C . add src/background/storage.ts tests/background/storage.test.ts
git -C . commit -m "feat: クリップの IndexedDB 保管を追加

保存時に既存を破棄して最新 1 件のみ保持する。録画データは
数 MB あり、取り直しのたびに溜め込むとブラウザの
ストレージを圧迫するため。"
```

---

## Task 5: 録画エンジン (offscreen document)

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/offscreen/codec.ts`, `src/offscreen/recorder.ts`, `src/offscreen/offscreen.html`, `src/offscreen/main.ts`
- Test: `tests/offscreen/codec.test.ts`

**Interfaces:**
- Consumes: `Message` (`@/shared/messages`)
- Produces:
  - `MP4_MIME` / `WEBM_MIME` 定数
  - `pickMimeType(isTypeSupported?: (type: string) => boolean): CodecChoice` — `CodecChoice` は `{ mimeType: string; mp4: boolean }`
  - `startRecording(streamId: string, mimeType: string, options: RecorderOptions): Promise<RecorderHandle>` — `RecorderHandle` は `{ stop(): Promise<Blob> }`、`RecorderOptions` は `{ onUnexpectedStop(error: Error): void }`
  - offscreen は録画開始時に `recorder/started`、完了時に `recorder/done`、失敗時に `recorder/failed` を sw へ送る

**テスト方針メモ:** `recorder.ts` は `getUserMedia` / `MediaRecorder` / `AudioContext` という jsdom に存在しない API に依存するため、単体テストの対象外とし **Task 11 の E2E スモークで担保する**。単体テストで検証するのは純粋関数の `codec.ts` のみ。この線引きにより、モックだらけで実質何も検証しないテストを書くことを避ける。

- [ ] **Step 1: 失敗するテストを書く**

`tests/offscreen/codec.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { MP4_MIME, WEBM_MIME, pickMimeType } from "@/offscreen/codec";

describe("pickMimeType", () => {
  test("MP4 が使えるなら MP4 を選ぶ", () => {
    const supportsAll = () => true;
    expect(pickMimeType(supportsAll)).toEqual({
      mimeType: MP4_MIME,
      mp4: true,
    });
  });

  test("MP4 が使えなければ WebM へ退避する", () => {
    const supportsWebmOnly = (type: string) => type === WEBM_MIME;
    expect(pickMimeType(supportsWebmOnly)).toEqual({
      mimeType: WEBM_MIME,
      mp4: false,
    });
  });

  test("どちらも使えなければ握り潰さず throw する", () => {
    const supportsNothing = () => false;
    expect(() => pickMimeType(supportsNothing)).toThrow(
      "この環境では動画を録画できません",
    );
  });

  test("MP4 の判定には H.264 と AAC を明示した MIME を使う", () => {
    expect(MP4_MIME).toBe('video/mp4;codecs="avc1.42E01E,mp4a.40.2"');
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/offscreen/codec.test.ts`
期待: FAIL (`Failed to resolve import "@/offscreen/codec"`)

- [ ] **Step 3: codec.ts を実装する**

`src/offscreen/codec.ts`:

```typescript
/** X が受け付ける MP4 (H.264 / AAC) */
export const MP4_MIME = 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"';

/** MP4 非対応環境での退避先。X には直接添付できない */
export const WEBM_MIME = "video/webm;codecs=vp9,opus";

export type CodecChoice = {
  mimeType: string;
  /** X へ直接添付できる形式かどうか */
  mp4: boolean;
};

/**
 * 録画に使う MIME を決める。
 * テストから差し替えられるよう判定関数を引数で受け取る。
 */
export function pickMimeType(
  isTypeSupported: (type: string) => boolean = (type) =>
    MediaRecorder.isTypeSupported(type),
): CodecChoice {
  if (isTypeSupported(MP4_MIME)) {
    return { mimeType: MP4_MIME, mp4: true };
  }
  if (isTypeSupported(WEBM_MIME)) {
    return { mimeType: WEBM_MIME, mp4: false };
  }
  throw new Error("この環境では動画を録画できません");
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/offscreen/codec.test.ts`
期待: PASS (4 tests)

- [ ] **Step 5: recorder.ts を実装する**

`src/offscreen/recorder.ts`:

```typescript
export type RecorderHandle = {
  /** 録画を止めて Blob を確定させる */
  stop(): Promise<Blob>;
};

export type RecorderOptions = {
  /**
   * 明示的な `stop()` より前に録画が終わってしまったときに呼ばれる。
   * 録画中の異常を呼び出し側が即座に知るための唯一の経路であり、
   * これが無いと OUT 到達まで (最大 60 秒) 異常に気付けない。
   */
  onUnexpectedStop(error: Error): void;
};

/** tabCapture の streamId から MediaStream を得るための制約 */
function tabConstraints(streamId: string): MediaStreamConstraints {
  // chromeMediaSource は標準の型定義に存在しないため cast する
  return {
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  } as unknown as MediaStreamConstraints;
}

/**
 * タブの映像・音声を録画する。
 * streamId 以外の文脈 (YouTube / X / 状態機械) を一切知らない。
 *
 * リソース解放の設計:
 * `stop` イベントは明示的な `stop()` 呼び出しだけでなく、録画が致命的エラーで
 * 死んだときにブラウザ側からも発火する。そのため `onstop` は `start()` の直後に
 * 一度だけ装着し、どちらの経路でも必ず解放が走るようにする。`stop()` の中で
 * 装着すると、自動発火を取りこぼしてストリームが解放されないまま残る。
 */
export async function startRecording(
  streamId: string,
  mimeType: string,
  options: RecorderOptions,
): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(
    tabConstraints(streamId),
  );

  let audioContext: AudioContext | null = null;

  /** 取得済みのリソースを解放する。二度呼ばれても安全 */
  function release(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (audioContext !== null) {
      void audioContext.close();
      audioContext = null;
    }
  }

  try {
    // tabCapture 中はタブ音声がスピーカーから消えるため、取得した音声を出力へ流し戻す
    audioContext = new AudioContext();
    audioContext
      .createMediaStreamSource(stream)
      .connect(audioContext.destination);

    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    let recordingError: Error | null = null;
    /** 録画が終わった (自動・明示どちらでも) ときに解決する */
    let settleStopped: (() => void) | null = null;
    let stopped = false;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      recordingError = new Error(`録画中にエラーが発生しました: ${event.type}`);
    };
    recorder.onstop = () => {
      stopped = true;
      release();

      if (settleStopped !== null) {
        settleStopped();
        return;
      }
      // stop() を待たずに終了した = 録画中の異常。呼び出し側へ即座に知らせる
      options.onUnexpectedStop(
        recordingError ?? new Error("録画が予期せず終了しました"),
      );
    };

    // 1 秒ごとに chunk を吐かせ、長い録画でもメモリが一度に膨らまないようにする
    recorder.start(1000);

    return {
      stop() {
        return new Promise<Blob>((resolve, reject) => {
          const finish = (): void => {
            if (recordingError !== null) {
              reject(recordingError);
              return;
            }
            resolve(new Blob(chunks, { type: mimeType }));
          };

          // 既にエラーで停止済みなら、改めて stop() を呼ばずに結果を返す
          if (stopped) {
            finish();
            return;
          }

          settleStopped = finish;
          recorder.stop();
        });
      },
    };
  } catch (error) {
    // 録画を開始できなかった場合、取得済みのストリームを掴んだままにしない
    release();
    throw error;
  }
}
```

- [ ] **Step 6: offscreen document のホストとメッセージ受付を実装する**

`src/offscreen/offscreen.html`:

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>yt-clip recorder</title>
  </head>
  <body>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/offscreen/main.ts`:

```typescript
import { pickMimeType } from "@/offscreen/codec";
import { startRecording, type RecorderHandle } from "@/offscreen/recorder";
import type { Message } from "@/shared/messages";

let handle: RecorderHandle | null = null;

function fail(reason: string): void {
  handle = null;
  void chrome.runtime.sendMessage({
    type: "recorder/failed",
    reason,
  } satisfies Message);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "recorder/start") {
    let mimeType: string;
    try {
      // MediaRecorder を持つのは offscreen だけなので形式判定もここで行う
      mimeType = pickMimeType().mimeType;
    } catch (error) {
      fail(String(error));
      return;
    }
    startRecording(message.streamId, mimeType, {
      // 録画が途中で死んだ場合、stop() を待たずに sw へ知らせる
      onUnexpectedStop: (error) => fail(error.message),
    })
      .then((started) => {
        handle = started;
        // 録画が始まったことを知らせる。sw はこれを待ってから再生を再開させる
        void chrome.runtime.sendMessage({
          type: "recorder/started",
        } satisfies Message);
      })
      .catch((error: unknown) => fail(String(error)));
    return;
  }

  if (message.type === "recorder/stop") {
    if (handle === null) {
      fail("録画が開始されていません");
      return;
    }
    const stopping = handle;
    handle = null;
    stopping
      .stop()
      .then(async (blob) => {
        const buffer = await blob.arrayBuffer();
        void chrome.runtime.sendMessage({
          type: "recorder/done",
          buffer,
          mimeType: blob.type,
        } satisfies Message);
      })
      .catch((error: unknown) => fail(String(error)));
  }
});
```

- [ ] **Step 7: 型チェックとテストを通す**

実行: `npx vitest run tests/offscreen/codec.test.ts && npx tsc --noEmit`
期待: PASS (4 tests) / 型エラーなし

- [ ] **Step 8: commit**

```bash
git -C . add src/offscreen tests/offscreen
git -C . commit -m "feat: offscreen document による録画エンジンを追加

MV3 の service worker は MediaRecorder を持てないため録画を
offscreen に隔離する。tabCapture 中はタブ音声が消えるので
AudioContext 経由で出力へ流し戻している。"
```

---

## Task 6: YouTube プレイヤー制御と IN/OUT UI

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/content/selectors.ts`, `src/content/player.ts`, `src/content/youtube.ts`
- Test: `tests/content/player.test.ts`

**Interfaces:**
- Consumes: `ClipEvent` `VideoMeta` (`@/shared/types`)、`Message` (`@/shared/messages`)、`validateRange` `formatTime` (`@/shared/time`)
- Produces:
  - `YT_SELECTORS` (`@/content/selectors`)
  - `parseVideoId(url: string): string`
  - `getVideo(): HTMLVideoElement`
  - `isAdPlaying(): boolean`
  - `seekTo(video: HTMLVideoElement, sec: number, timeoutMs?: number): Promise<void>`
  - `startPlayback(video: HTMLVideoElement, timeoutMs?: number): Promise<void>`
  - `onReachTime(video: HTMLVideoElement, sec: number, onReach: () => void): () => void`

**設計メモ:** DOM セレクタは `selectors.ts` に集約する。YouTube の DOM 変更時に触る箇所を 1 ファイルに閉じ込めるため。要素が見つからなければ `ElementNotFoundError` を throw し、`youtube.ts` 側が UI にエラーを出す (握り潰さない)。`seekTo` / `startPlayback` には **必ずタイムアウトを設ける**。イベントが永久に来ない場合に録画フローが固まるのを防ぐ。

**seek と再生を分離する理由:** `seeking` 状態では IN へ移動するだけで再生しない。service worker が streamId 取得と offscreen 起動を終えて `MediaRecorder` を開始し、状態が `recording` に変わってから再生を始める。seek 直後に再生してしまうと、録画の準備が終わるまでの数百ミリ秒ぶんクリップの冒頭が欠けるため。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/player.test.ts`:

```typescript
// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ElementNotFoundError,
  getVideo,
  onReachTime,
  parseVideoId,
  seekTo,
} from "@/content/player";
import { YT_SELECTORS } from "@/content/selectors";

describe("parseVideoId", () => {
  test("watch URL から videoId を取り出す", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  test("他のクエリが付いていても取り出せる", () => {
    expect(
      parseVideoId("https://www.youtube.com/watch?v=abc123&list=PL1&index=2"),
    ).toBe("abc123");
  });

  test("videoId が無い URL は throw する", () => {
    expect(() => parseVideoId("https://www.youtube.com/")).toThrow(
      "URL から videoId を取得できません",
    );
  });
});

describe("getVideo", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("video 要素を返す", () => {
    const video = document.createElement("video");
    video.className = "html5-main-video";
    document.body.appendChild(video);

    expect(getVideo()).toBe(video);
  });

  test("見つからなければ握り潰さず throw する", () => {
    expect(() => getVideo()).toThrow(ElementNotFoundError);
  });

  test("セレクタは selectors.ts に集約されている", () => {
    expect(YT_SELECTORS.video).toBe("video.html5-main-video");
  });
});

describe("seekTo", () => {
  test("seeked が来たら解決する", async () => {
    const video = document.createElement("video");
    const promise = seekTo(video, 42);
    video.dispatchEvent(new Event("seeked"));

    await expect(promise).resolves.toBeUndefined();
  });

  test("seeked が来なければタイムアウトで reject する", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const promise = seekTo(video, 42, 5000);
    const assertion = expect(promise).rejects.toThrow(
      "seek がタイムアウトしました",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("onReachTime", () => {
  /** requestVideoFrameCallback を手動で駆動できる video を作る */
  function makeVideoWithFrames() {
    const video = document.createElement("video");
    const pending: Array<(now: number, meta: { mediaTime: number }) => void> =
      [];
    Object.assign(video, {
      requestVideoFrameCallback: (
        cb: (now: number, meta: { mediaTime: number }) => void,
      ) => {
        pending.push(cb);
        return pending.length;
      },
      cancelVideoFrameCallback: () => {
        pending.length = 0;
      },
    });
    const advanceTo = (mediaTime: number) => {
      const callbacks = [...pending];
      pending.length = 0;
      for (const cb of callbacks) cb(0, { mediaTime });
    };
    return { video, advanceTo, pending };
  }

  test("指定位置に到達したらコールバックを呼ぶ", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    onReachTime(video, 40, onReach);

    advanceTo(39.9);
    expect(onReach).not.toHaveBeenCalled();

    advanceTo(40.1);
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  test("解除するとそれ以降呼ばれない", () => {
    const { video, advanceTo } = makeVideoWithFrames();
    const onReach = vi.fn();
    const cancel = onReachTime(video, 40, onReach);

    cancel();
    advanceTo(50);

    expect(onReach).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/player.test.ts`
期待: FAIL (`Failed to resolve import "@/content/player"`)

- [ ] **Step 3: selectors.ts を実装する**

`src/content/selectors.ts`:

```typescript
/**
 * DOM セレクタの集約。
 * YouTube / X の画面構成が変わったとき、修正箇所をこの 1 ファイルに閉じ込める。
 */
export const YT_SELECTORS = {
  video: "video.html5-main-video",
  player: "#movie_player",
  controls: ".ytp-right-controls",
  title: "h1.ytd-watch-metadata yt-formatted-string",
} as const;

export const X_SELECTORS = {
  /** 添付用の input。data-testid が変わる可能性があるため候補を順に試す */
  fileInput: [
    'input[data-testid="fileInput"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ],
  /** 本文の contenteditable */
  editor: [
    'div[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
} as const;
```

- [ ] **Step 4: player.ts を実装する**

`src/content/player.ts`:

```typescript
import { YT_SELECTORS } from "@/content/selectors";
import type { VideoMeta } from "@/shared/types";

export class ElementNotFoundError extends Error {
  constructor(selector: string) {
    super(`要素が見つかりません: ${selector}`);
    this.name = "ElementNotFoundError";
  }
}

/** requestVideoFrameCallback は標準の型定義に含まれないため補う */
type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback(callback: FrameCallback): number;
  cancelVideoFrameCallback(handle: number): void;
};

export function parseVideoId(url: string): string {
  const videoId = new URL(url).searchParams.get("v");
  if (videoId === null || videoId === "") {
    throw new Error(`URL から videoId を取得できません: ${url}`);
  }
  return videoId;
}

export function getVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>(YT_SELECTORS.video);
  if (video === null) {
    throw new ElementNotFoundError(YT_SELECTORS.video);
  }
  return video;
}

/** 広告再生中は player 要素に ad-showing クラスが付く */
export function isAdPlaying(): boolean {
  const player = document.querySelector(YT_SELECTORS.player);
  return player?.classList.contains("ad-showing") ?? false;
}

export function getVideoMeta(): VideoMeta {
  const titleElement = document.querySelector(YT_SELECTORS.title);
  if (titleElement === null) {
    throw new ElementNotFoundError(YT_SELECTORS.title);
  }
  return {
    videoId: parseVideoId(location.href),
    title: titleElement.textContent?.trim() ?? "",
  };
}

/**
 * 指定位置へ seek し、完了を待つ。
 * seeked が来ないまま固まるのを防ぐため必ずタイムアウトを設ける。
 */
export function seekTo(
  video: HTMLVideoElement,
  sec: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`seek がタイムアウトしました: ${sec}秒`));
    }, timeoutMs);

    video.addEventListener("seeked", onSeeked);
    video.currentTime = sec;
  });
}

/**
 * 再生を開始し、実際に再生が始まるまで待つ。
 * seek とは分離してある。録画開始の準備 (streamId 取得と offscreen 起動) が
 * 終わるまで動画を止めておかないと、クリップの冒頭が欠けるため。
 */
export function startPlayback(
  video: HTMLVideoElement,
  timeoutMs = 5000,
): Promise<void> {
  // 倍速のまま録画すると早送り映像が記録されるので等速に戻す
  video.playbackRate = 1;

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("playing", onPlaying);
    };
    const onPlaying = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("再生開始がタイムアウトしました"));
    }, timeoutMs);

    video.addEventListener("playing", onPlaying);
    void video.play();
  });
}

/**
 * 指定位置への到達をフレーム単位で監視する。
 * timeupdate は発火間隔が粗く末尾が伸びるため rVFC を使う。
 * 戻り値を呼ぶと監視を解除する。
 */
export function onReachTime(
  video: HTMLVideoElement,
  sec: number,
  onReach: () => void,
): () => void {
  const target = video as VideoWithFrameCallback;
  let cancelled = false;
  let handle = 0;

  const tick: FrameCallback = (_now, metadata) => {
    if (cancelled) return;
    if (metadata.mediaTime >= sec) {
      onReach();
      return;
    }
    handle = target.requestVideoFrameCallback(tick);
  };

  handle = target.requestVideoFrameCallback(tick);

  return () => {
    cancelled = true;
    target.cancelVideoFrameCallback(handle);
  };
}
```

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/player.test.ts`
期待: PASS (10 tests)

- [ ] **Step 6: youtube.ts で IN/OUT UI を注入する**

`src/content/youtube.ts`:

```typescript
import {
  getVideo,
  getVideoMeta,
  isAdPlaying,
  onReachTime,
  seekTo,
  startPlayback,
} from "@/content/player";
import { YT_SELECTORS } from "@/content/selectors";
import type { Message } from "@/shared/messages";
import { formatTime, validateRange } from "@/shared/time";
import type { ClipEvent } from "@/shared/types";

const BAR_ID = "yt-clip-bar";

/**
 * IN を打った位置と、そのときの動画 ID。
 * YouTube は SPA でページ遷移せずに動画が入れ替わるため、位置だけを覚えていると
 * 別の動画で OUT を打ったときに違う動画同士の範囲が組み上がってしまう。
 */
let markedIn: { sec: number; videoId: string } | null = null;
let cancelWatch: (() => void) | null = null;

function send(event: ClipEvent): void {
  void chrome.runtime.sendMessage({ type: "clip/event", event } satisfies Message);
}

function setStatus(text: string): void {
  const status = document.getElementById(`${BAR_ID}-status`);
  if (status !== null) {
    status.textContent = text;
  }
}

/**
 * クリック操作を包んで、失敗をユーザーに見える形にする。
 * 要素が見つからない・再生位置が不正といった失敗を console に流すだけでは、
 * ボタンが無反応になった理由がユーザーに伝わらない。
 */
function guard(action: () => void): () => void {
  return () => {
    try {
      action();
    } catch (error) {
      setStatus(`操作できませんでした: ${String(error)}`);
    }
  };
}

function onMarkIn(): void {
  const video = getVideo();
  const meta = getVideoMeta();
  markedIn = { sec: video.currentTime, videoId: meta.videoId };
  send({ type: "MARK_IN", sec: markedIn.sec, meta });
  setStatus(`IN ${formatTime(markedIn.sec)}`);
}

function onMarkOut(): void {
  if (markedIn === null) {
    setStatus("先に IN を指定してください");
    return;
  }

  // IN を打った後に別の動画へ移動していた場合、その範囲はもう意味を持たない。
  // ここで RESET_MARKS を送ってはいけない。録画済みで投稿待ち (preview / composing) の
  // ときに届くと状態機械が不正遷移として failed に落ち、録画したクリップへの参照ごと失う。
  // MARK_IN はどの状態からでも受理されるので、次に IN を打てば正しく上書きされる。
  if (getVideoMeta().videoId !== markedIn.videoId) {
    markedIn = null;
    setStatus("動画が変わりました。IN からやり直してください");
    return;
  }

  const endSec = getVideo().currentTime;
  // 範囲の妥当性はここで判定する。状態機械は遷移だけに責任を持つ
  const validation = validateRange(markedIn.sec, endSec);
  if (!validation.ok) {
    setStatus(validation.message);
    return;
  }
  send({ type: "MARK_OUT", sec: endSec });
  setStatus(`${formatTime(markedIn.sec)} 〜 ${formatTime(endSec)}`);
}

/** 録画品質は再生解像度が上限になるため、低いときは事前に知らせる */
const MIN_RECOMMENDED_HEIGHT = 720;

/**
 * 録画の前半。IN へ seek するが再生はしない。
 * service worker が streamId 取得と offscreen 起動を終えるまで動画を進めないため。
 */
async function prepareRecording(startSec: number): Promise<void> {
  // 状態変化から呼ばれるため click の guard が効かない。ここで自分で包む。
  // 握り潰すと sw は seeking のまま固まり、ユーザーには準備中の表示が残り続ける。
  try {
    if (isAdPlaying()) {
      send({ type: "FAIL", reason: "ad-playing" });
      setStatus("広告の再生中です。終了後にやり直してください");
      return;
    }

    const video = getVideo();
    // 画質は録画してからでは上げられないので、この時点で警告する (録画は止めない)
    if (video.videoHeight > 0 && video.videoHeight < MIN_RECOMMENDED_HEIGHT) {
      setStatus(
        `再生画質が低いままです (${video.videoHeight}p)。画質を上げると綺麗に切り抜けます`,
      );
    }
    video.pause();
    await seekTo(video, startSec);

    send({ type: "SEEK_DONE" });
    setStatus("録画の準備をしています…");
  } catch (error) {
    send({ type: "FAIL", reason: "seek-failed" });
    setStatus(`開始位置へ移動できませんでした: ${String(error)}`);
  }
}

/**
 * 録画の後半。録画開始後に呼ばれ、再生して OUT 到達で停止する。
 */
async function runRecording(startSec: number, endSec: number): Promise<void> {
  // prepareRecording と同じ理由で、この関数も自分で例外を拾う
  try {
    const video = getVideo();
    await startPlayback(video);

    setStatus(`録画中… (${Math.round(endSec - startSec)}秒)`);

    cancelWatch = onReachTime(video, endSec, () => {
      cancelWatch = null;
      video.pause();
      send({ type: "OUT_REACHED" });
      setStatus("録画を書き出しています…");
    });
  } catch (error) {
    send({ type: "FAIL", reason: "playback-failed" });
    setStatus(`再生を開始できませんでした: ${String(error)}`);
  }
}

function buildBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.style.cssText =
    "display:flex;gap:8px;align-items:center;padding:8px 0;color:var(--yt-spec-text-primary,#fff);font-size:13px;";

  const inButton = document.createElement("button");
  inButton.textContent = "IN";
  inButton.addEventListener("click", guard(onMarkIn));

  const outButton = document.createElement("button");
  outButton.textContent = "OUT";
  outButton.addEventListener("click", guard(onMarkOut));

  const status = document.createElement("span");
  status.id = `${BAR_ID}-status`;
  status.textContent = "IN を押して開始位置を指定";

  bar.append(inButton, outButton, status);
  return bar;
}

function mount(): void {
  if (document.getElementById(BAR_ID) !== null) return;

  const anchor = document.querySelector(YT_SELECTORS.controls);
  if (anchor === null) return; // プレイヤー未生成。次の observe で再試行する

  anchor.parentElement?.insertBefore(buildBar(), anchor.nextSibling);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type !== "state/changed") return;

  const state = message.state;
  if (state.kind === "seeking") {
    void prepareRecording(state.range.startSec);
    return;
  }
  if (state.kind === "recording") {
    void runRecording(state.range.startSec, state.range.endSec);
    return;
  }
  if (state.kind === "failed" && cancelWatch !== null) {
    cancelWatch();
    cancelWatch = null;
  }
});

// YouTube は SPA 遷移するため DOM 変化を監視して再マウントする
const observer = new MutationObserver(() => mount());
observer.observe(document.body, { childList: true, subtree: true });
mount();
```

- [ ] **Step 7: 型チェックとテストを通す**

実行: `npx vitest run tests/content/player.test.ts && npx tsc --noEmit`
期待: PASS (10 tests) / 型エラーなし

- [ ] **Step 8: commit**

```bash
git -C . add src/content/selectors.ts src/content/player.ts src/content/youtube.ts tests/content/player.test.ts
git -C . commit -m "feat: YouTube の IN/OUT UI とプレイヤー制御を追加

停止判定に timeupdate ではなく requestVideoFrameCallback を使う。
timeupdate は発火間隔が粗く、指定した OUT より末尾が伸びるため。
seek と再生を分離したのは、録画準備が終わるまで動画を進めないため。
待機には必ずタイムアウトを設けている。"
```

---

## Task 7: X への本文プリフィルと動画添付

**依存:** Task 1 (並列実行可)

**Files:**
- Create: `src/content/x.ts`, `src/shared/filename.ts`
- Test: `tests/content/x.test.ts`, `tests/shared/filename.test.ts`
- 参照のみ: `src/content/selectors.ts` (Task 6 が `X_SELECTORS` ごと作成する。Task 6 が未完なら Task 6 Step 3 の内容でこのファイルを作ってから進める)

**Interfaces:**
- Consumes: `X_SELECTORS` (`@/content/selectors`)、`Message` (`@/shared/messages`)
- Produces:
  - `SelectorMissingError` クラス
  - `findElement<T extends HTMLElement>(selectors: readonly string[]): T`
  - `waitForElement<T extends HTMLElement>(selectors: readonly string[], timeoutMs?: number): Promise<T>`
  - `buildClipFileName(videoId: string, startSec: number, mimeType: string): string` (`@/shared/filename` に置く。service worker からも使うため、DOM 副作用を持つ `x.ts` には入れない)
  - `attachFile(input: HTMLInputElement, file: File, createDataTransfer?: () => DataTransfer): void`
  - `insertText(editor: HTMLElement, text: string): void`

**設計メモ:** `selectors.ts` は Task 6 と共有する。SDD で並列実行する場合、**Task 6 と Task 7 が同じファイルを触るため競合しうる**。Task 6 の Step 3 で `YT_SELECTORS` と `X_SELECTORS` の両方を定義済みなので、Task 7 は原則としてこのファイルを変更しない。変更が必要になった場合のみ `X_SELECTORS` の配列に候補を追加する (`YT_SELECTORS` には触らない)。

**投稿ボタンは押さない。** 添付と本文入力までで処理を終える。

- [ ] **Step 1: 失敗するテストを書く**

`tests/content/x.test.ts`:

```typescript
// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  SelectorMissingError,
  attachFile,
  findElement,
  waitForElement,
} from "@/content/x";

describe("findElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("候補のうち最初に見つかったものを返す", () => {
    document.body.innerHTML = '<div id="second"></div>';
    expect(findElement(["#first", "#second"]).id).toBe("second");
  });

  test("先頭の候補を優先する", () => {
    document.body.innerHTML = '<div id="first"></div><div id="second"></div>';
    expect(findElement(["#first", "#second"]).id).toBe("first");
  });

  test("どれも見つからなければ握り潰さず throw する", () => {
    expect(() => findElement(["#none"])).toThrow(SelectorMissingError);
  });
});

describe("waitForElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("既に存在すれば即座に解決する", async () => {
    document.body.innerHTML = '<div id="target"></div>';
    await expect(waitForElement(["#target"])).resolves.toHaveProperty(
      "id",
      "target",
    );
  });

  test("後から現れた要素を拾う", async () => {
    const promise = waitForElement(["#late"]);
    const late = document.createElement("div");
    late.id = "late";
    document.body.appendChild(late);

    await expect(promise).resolves.toBe(late);
  });

  test("現れなければタイムアウトで reject する", async () => {
    vi.useFakeTimers();
    const promise = waitForElement(["#never"], 10000);
    const assertion = expect(promise).rejects.toThrow(SelectorMissingError);
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("attachFile", () => {
  test("DataTransfer 経由でファイルを載せ change を発火する", () => {
    const input = document.createElement("input");
    input.type = "file";
    // jsdom の input.files は書き込めないためテスト用に差し替える
    let assigned: FileList | null = null;
    Object.defineProperty(input, "files", {
      get: () => assigned,
      set: (value: FileList) => {
        assigned = value;
      },
      configurable: true,
    });

    const file = new File(["データ"], "clip.mp4", { type: "video/mp4" });
    const added: File[] = [];
    const fakeFiles = [file] as unknown as FileList;
    const createDataTransfer = () =>
      ({
        items: {
          add: (f: File) => {
            added.push(f);
          },
        },
        files: fakeFiles,
      }) as unknown as DataTransfer;

    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    attachFile(input, file, createDataTransfer);

    expect(added).toEqual([file]);
    expect(assigned).toBe(fakeFiles);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("change イベントは bubbles する", () => {
    const wrapper = document.createElement("div");
    const input = document.createElement("input");
    input.type = "file";
    Object.defineProperty(input, "files", {
      set: () => {},
      configurable: true,
    });
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    const onChange = vi.fn();
    wrapper.addEventListener("change", onChange);

    const file = new File(["データ"], "clip.mp4", { type: "video/mp4" });
    attachFile(
      input,
      file,
      () =>
        ({
          items: { add: () => {} },
          files: [file] as unknown as FileList,
        }) as unknown as DataTransfer,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/content/x.test.ts`
期待: FAIL (`Failed to resolve import "@/content/x"`)

- [ ] **Step 3: filename.ts を実装する**

`src/shared/filename.ts`:

```typescript
/**
 * 添付・ダウンロードに使うファイル名を組み立てる。
 * service worker からも使うため DOM 依存を持たせない。
 */
export function buildClipFileName(
  videoId: string,
  startSec: number,
  mimeType: string,
): string {
  const extension = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("webm")
      ? "webm"
      : null;
  if (extension === null) {
    throw new Error(`未知の動画形式です: ${mimeType}`);
  }
  return `yt-clip-${videoId}-${Math.floor(startSec)}s.${extension}`;
}
```

`tests/shared/filename.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { buildClipFileName } from "@/shared/filename";

describe("buildClipFileName", () => {
  test("MP4 には mp4 拡張子を付ける", () => {
    expect(
      buildClipFileName("dQw4w9WgXcQ", 75.4, 'video/mp4;codecs="avc1"'),
    ).toBe("yt-clip-dQw4w9WgXcQ-75s.mp4");
  });

  test("WebM には webm 拡張子を付ける", () => {
    expect(buildClipFileName("abc", 0, "video/webm;codecs=vp9,opus")).toBe(
      "yt-clip-abc-0s.webm",
    );
  });

  test("未知の形式は throw する", () => {
    expect(() => buildClipFileName("abc", 0, "video/ogg")).toThrow(
      "未知の動画形式です: video/ogg",
    );
  });
});
```

実行: `npx vitest run tests/shared/filename.test.ts`
期待: PASS (3 tests)

- [ ] **Step 4: x.ts を実装する**

`src/content/x.ts`:

```typescript
import { X_SELECTORS } from "@/content/selectors";
import type { Message } from "@/shared/messages";

export class SelectorMissingError extends Error {
  constructor(selectors: readonly string[]) {
    super(`X の画面に要素が見つかりません: ${selectors.join(", ")}`);
    this.name = "SelectorMissingError";
  }
}

/** 候補セレクタを順に試し、最初に見つかった要素を返す */
export function findElement<T extends HTMLElement>(
  selectors: readonly string[],
): T {
  for (const selector of selectors) {
    const found = document.querySelector<T>(selector);
    if (found !== null) return found;
  }
  throw new SelectorMissingError(selectors);
}

/**
 * 要素が現れるまで待つ。
 * 投稿画面は非同期に構築されるため即時取得できないことがある。
 * 永久に待たないよう必ずタイムアウトさせる。
 */
export function waitForElement<T extends HTMLElement>(
  selectors: readonly string[],
  timeoutMs = 10000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tryFind = (): T | null => {
      for (const selector of selectors) {
        const found = document.querySelector<T>(selector);
        if (found !== null) return found;
      }
      return null;
    };

    const immediate = tryFind();
    if (immediate !== null) {
      resolve(immediate);
      return;
    }

    const observer = new MutationObserver(() => {
      const found = tryFind();
      if (found !== null) {
        cleanup();
        resolve(found);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new SelectorMissingError(selectors));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      observer.disconnect();
    };

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/** input[type=file] にファイルを載せる */
export function attachFile(
  input: HTMLInputElement,
  file: File,
  createDataTransfer: () => DataTransfer = () => new DataTransfer(),
): void {
  const transfer = createDataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  // React 側に変更を伝えるため change を明示的に発火する
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 本文を入力する。contenteditable への代入では React の state に反映されない */
export function insertText(editor: HTMLElement, text: string): void {
  editor.focus();
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    throw new Error("本文を入力できませんでした");
  }
}

function notify(message: Message): void {
  void chrome.runtime.sendMessage(message);
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type !== "x/payload") return;

  void (async () => {
    try {
      const input = await waitForElement<HTMLInputElement>(
        X_SELECTORS.fileInput,
      );
      const file = new File([message.buffer], message.fileName, {
        type: message.mimeType,
      });
      attachFile(input, file);

      const editor = await waitForElement<HTMLElement>(X_SELECTORS.editor);
      insertText(editor, message.text);

      // 投稿ボタンは押さない。最終確認はユーザーに委ねる
      notify({ type: "x/attached" });
    } catch (error) {
      notify({ type: "x/failed", reason: String(error) });
    }
  })();
});

// 投稿画面が開かれたことを service worker に知らせる
if (location.pathname.startsWith("/compose/")) {
  notify({ type: "x/ready" });
}
```

- [ ] **Step 5: 実行して通過を確認**

実行: `npx vitest run tests/content/x.test.ts tests/shared/filename.test.ts && npx tsc --noEmit`
期待: PASS (11 tests) / 型エラーなし

- [ ] **Step 6: commit**

```bash
git -C . add src/content/x.ts src/shared/filename.ts tests/content/x.test.ts tests/shared/filename.test.ts
git -C . commit -m "feat: X 投稿画面への本文プリフィルと動画添付を追加

投稿ボタンは押さず添付までで止める。誤投稿は取り返しがつかず、
自動投稿は X の自動化ポリシーにも触れやすいため。添付に失敗
した場合は例外を握り潰さず x/failed で退避経路に回す。"
```

---

## Task 8: タブキャプチャと offscreen ライフサイクル

**依存:** Task 1 (Task 5 の完了は不要。offscreen の URL を文字列で参照するだけのため並列実行可)

**Files:**
- Create: `src/background/capture.ts`
- Test: `tests/background/capture.test.ts`

**Interfaces:**
- Consumes: なし (chrome API のみ)
- Produces:
  - `CapturePermissionError` クラス
  - `CaptureApi` 型 (テスト用に注入する chrome API の最小形)
  - `ensureOffscreen(api?: CaptureApi): Promise<void>`
  - `getStreamId(tabId: number, api?: CaptureApi): Promise<string>`
  - `closeOffscreen(api?: CaptureApi): Promise<void>`

**設計メモ:** chrome API を直接呼ばず `CaptureApi` として注入可能にする。実行時の既定値は本物の `chrome` で、テストではフェイクを渡す。これにより「既に offscreen があれば作り直さない」という分岐を実際に検証できる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/capture.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  CapturePermissionError,
  closeOffscreen,
  ensureOffscreen,
  getStreamId,
  type CaptureApi,
} from "@/background/capture";

function makeApi(overrides: Partial<{
  hasDocument: boolean;
  streamId: string | Error;
}> = {}): { api: CaptureApi; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    createDocument: [],
    closeDocument: [],
    getMediaStreamId: [],
  };
  const api: CaptureApi = {
    offscreen: {
      hasDocument: async () => overrides.hasDocument ?? false,
      createDocument: async (params) => {
        calls.createDocument!.push(params);
      },
      closeDocument: async () => {
        calls.closeDocument!.push(true);
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabCapture: {
      getMediaStreamId: async (options) => {
        calls.getMediaStreamId!.push(options);
        const result = overrides.streamId ?? "stream-abc";
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { api, calls };
}

describe("ensureOffscreen", () => {
  test("offscreen が無ければ USER_MEDIA 理由で作る", async () => {
    const { api, calls } = makeApi({ hasDocument: false });
    await ensureOffscreen(api);

    expect(calls.createDocument).toHaveLength(1);
    expect(calls.createDocument![0]).toMatchObject({
      url: "chrome-extension://test/src/offscreen/offscreen.html",
      reasons: ["USER_MEDIA"],
    });
  });

  test("既に存在すれば作り直さない", async () => {
    const { api, calls } = makeApi({ hasDocument: true });
    await ensureOffscreen(api);

    expect(calls.createDocument).toHaveLength(0);
  });
});

describe("getStreamId", () => {
  test("対象タブの streamId を返す", async () => {
    const { api, calls } = makeApi({ streamId: "stream-xyz" });

    await expect(getStreamId(42, api)).resolves.toBe("stream-xyz");
    expect(calls.getMediaStreamId![0]).toEqual({ targetTabId: 42 });
  });

  test("取得に失敗したら CapturePermissionError にして throw する", async () => {
    const { api } = makeApi({ streamId: new Error("権限がありません") });

    await expect(getStreamId(42, api)).rejects.toThrow(CapturePermissionError);
  });
});

describe("closeOffscreen", () => {
  test("存在するときだけ閉じる", async () => {
    const present = makeApi({ hasDocument: true });
    await closeOffscreen(present.api);
    expect(present.calls.closeDocument).toHaveLength(1);

    const absent = makeApi({ hasDocument: false });
    await closeOffscreen(absent.api);
    expect(absent.calls.closeDocument).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/capture.test.ts`
期待: FAIL (`Failed to resolve import "@/background/capture"`)

- [ ] **Step 3: capture.ts を実装する**

`src/background/capture.ts`:

```typescript
export class CapturePermissionError extends Error {
  constructor(cause: unknown) {
    super(`タブの録画を開始できませんでした: ${String(cause)}`);
    this.name = "CapturePermissionError";
  }
}

/** テストから差し替えられるよう、使う chrome API だけを型にする */
export type CaptureApi = {
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(params: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  runtime: { getURL(path: string): string };
  tabCapture: {
    getMediaStreamId(options: { targetTabId: number }): Promise<string>;
  };
};

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

function defaultApi(): CaptureApi {
  return chrome as unknown as CaptureApi;
}

/** offscreen document が無ければ作る。既にあれば何もしない */
export async function ensureOffscreen(
  api: CaptureApi = defaultApi(),
): Promise<void> {
  if (await api.offscreen.hasDocument()) return;

  await api.offscreen.createDocument({
    url: api.runtime.getURL(OFFSCREEN_PATH),
    reasons: ["USER_MEDIA"],
    justification: "タブの映像と音声を録画して切り抜きを作るため",
  });
}

/** 録画対象タブの streamId を取得する */
export async function getStreamId(
  tabId: number,
  api: CaptureApi = defaultApi(),
): Promise<string> {
  try {
    return await api.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    throw new CapturePermissionError(error);
  }
}

export async function closeOffscreen(
  api: CaptureApi = defaultApi(),
): Promise<void> {
  if (!(await api.offscreen.hasDocument())) return;
  await api.offscreen.closeDocument();
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/capture.test.ts && npx tsc --noEmit`
期待: PASS (5 tests) / 型エラーなし

- [ ] **Step 5: commit**

```bash
git -C . add src/background/capture.ts tests/background/capture.test.ts
git -C . commit -m "feat: tabCapture と offscreen のライフサイクル管理を追加

chrome API を注入可能にして「既に offscreen があれば作り直さない」
分岐を単体テストできるようにした。streamId の取得失敗は
CapturePermissionError に包んで呼び出し側が理由を提示できる形にする。"
```

---

## Task 9: メッセージルーティングと service worker

**依存:** Task 1, 2, 3, 4, 7, 8 (これらの完了後に着手する)

**Files:**
- Create: `src/background/router.ts`, `src/background/sw.ts`
- Test: `tests/background/router.test.ts`

**Interfaces:**
- Consumes: `reduce` `INITIAL_STATE` (`@/background/state`)、`StoredClip` (`@/background/storage`)、`ensureOffscreen` `getStreamId` (`@/background/capture`)、`renderTemplate` `DEFAULT_TEMPLATE` (`@/shared/template`)、`buildClipFileName` (`@/shared/filename`)
- Produces:
  - `RouterDeps` / `RouterSnapshot` / `Router` 型
  - `createRouter(deps: RouterDeps, initial?: RouterSnapshot): Router`

**設計メモ:** ロジックを `router.ts` に集め、`sw.ts` は本物の chrome API を注入するだけの薄いエントリにする。これで「seek 完了だけでは recording に進まない」といった配線を chrome なしで検証できる。

**録画開始の順序が要点:** content から `SEEK_DONE` が届いても即座に状態を進めない。先に offscreen へ `recorder/start` を送り、`recorder/started` が返ってきてはじめて `recording` へ遷移させる。content はその状態変化を見て再生を再開する。この順序により、録画準備中に動画が進んでクリップ冒頭が欠けることを防ぐ。

service worker は停止しうるため、状態は `chrome.storage.session` に永続化し、起動時に復元する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/background/router.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  createRouter,
  type Router,
  type RouterDeps,
} from "@/background/router";
import type { StoredClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import type { ClipRange, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "abc123", title: "テスト動画" };
const range: ClipRange = { startSec: 10, endSec: 40 };

type Harness = {
  router: Router;
  sentToRuntime: Message[];
  sentToTab: Array<{ tabId: number; message: Message }>;
  saved: StoredClip[];
  deps: RouterDeps;
};

function makeHarness(
  overrides: Partial<RouterDeps> = {},
  stored?: StoredClip,
): Harness {
  const sentToRuntime: Message[] = [];
  const sentToTab: Array<{ tabId: number; message: Message }> = [];
  const saved: StoredClip[] = [];

  const deps: RouterDeps = {
    ensureOffscreen: vi.fn(async () => undefined),
    getStreamId: vi.fn(async () => "stream-abc"),
    saveClip: async (clip) => {
      saved.push(clip);
    },
    getClip: async () => {
      if (stored === undefined) throw new Error("クリップがありません");
      return stored;
    },
    sendToRuntime: (message) => {
      sentToRuntime.push(message);
    },
    sendToTab: (tabId, message) => {
      sentToTab.push({ tabId, message });
    },
    openComposeTab: async () => 99,
    loadTemplate: async () => "{title}\n\n{url}",
    now: () => Date.UTC(2026, 8, 10, 3, 0, 0),
    persist: async () => undefined,
    ...overrides,
  };

  return { router: createRouter(deps), sentToRuntime, sentToTab, saved, deps };
}

/** IN/OUT を打って録画直前まで進める */
async function markRange(router: Router, tabId = 7): Promise<void> {
  await router.handle(
    { type: "clip/event", event: { type: "MARK_IN", sec: 10, meta } },
    tabId,
  );
  await router.handle(
    { type: "clip/event", event: { type: "MARK_OUT", sec: 40 } },
    tabId,
  );
}

describe("録画の開始", () => {
  test("録画要求で offscreen を用意し streamId を取る", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    expect(h.deps.ensureOffscreen).toHaveBeenCalledTimes(1);
    expect(h.deps.getStreamId).toHaveBeenCalledWith(7);
    expect(h.router.getState().kind).toBe("seeking");
  });

  test("streamId が取れなければ理由つきで失敗する", async () => {
    const h = makeHarness({
      getStreamId: async () => {
        throw new Error("拒否されました");
      },
    });
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "capture-permission-denied",
    });
  });

  test("seek 完了だけでは recording へ進まず録画開始を指示する", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({
      type: "clip/event",
      event: { type: "SEEK_DONE" },
    });

    // 冒頭欠けを防ぐため、録画が始まるまで seeking のまま留まる
    expect(h.router.getState().kind).toBe("seeking");
    expect(h.sentToRuntime).toContainEqual({
      type: "recorder/start",
      streamId: "stream-abc",
    });
  });

  test("録画開始の通知を受けてはじめて recording へ進む", async () => {
    const h = makeHarness();
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });

    expect(h.router.getState().kind).toBe("recording");
    // content が再生を再開できるよう、録画対象タブへ状態変化を通知する
    expect(h.sentToTab).toContainEqual({
      tabId: 7,
      message: { type: "state/changed", state: h.router.getState() },
    });
  });
});

describe("録画の終了と保存", () => {
  async function recordUntilEncoding(h: Harness): Promise<void> {
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });
  }

  test("OUT 到達で録画停止を指示し encoding へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);

    expect(h.router.getState().kind).toBe("encoding");
    expect(h.sentToRuntime).toContainEqual({ type: "recorder/stop" });
  });

  test("MP4 を受け取ったら保存して preview へ進む", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/mp4",
    });

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      mimeType: "video/mp4",
      range,
      meta,
      createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
    });
    expect(h.router.getState()).toMatchObject({ kind: "preview" });
  });

  test("WebM を受け取ったら保存した上で downloadable へ退避する", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/webm",
    });

    // 録画は成功しているので成果物は捨てない
    expect(h.saved).toHaveLength(1);
    expect(h.router.getState()).toMatchObject({
      kind: "downloadable",
      reason: "mp4-unsupported",
    });
  });

  test("録画側の失敗は握り潰さず failed にする", async () => {
    const h = makeHarness();
    await recordUntilEncoding(h);
    await h.router.handle({
      type: "recorder/failed",
      reason: "デバイスエラー",
    });

    expect(h.router.getState()).toMatchObject({
      kind: "failed",
      reason: "recording-aborted",
    });
  });
});

describe("X への受け渡し", () => {
  const clip: StoredClip = {
    id: "clip-1",
    blob: new Blob(["動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    range,
    meta,
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };

  async function reachComposing(h: Harness): Promise<void> {
    await markRange(h.router);
    await h.router.handle({
      type: "clip/event",
      event: { type: "START_RECORDING" },
    });
    await h.router.handle({ type: "clip/event", event: { type: "SEEK_DONE" } });
    await h.router.handle({ type: "recorder/started" });
    await h.router.handle({
      type: "clip/event",
      event: { type: "OUT_REACHED" },
    });
    await h.router.handle({
      type: "recorder/done",
      buffer: new TextEncoder().encode("動画データ").buffer as ArrayBuffer,
      mimeType: "video/mp4",
    });
    await h.router.handle({ type: "clip/event", event: { type: "POST" } });
  }

  test("投稿タブの準備完了で本文とファイルを送る", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/ready" });

    const payload = h.sentToTab.find(
      (sent) => sent.message.type === "x/payload",
    );
    expect(payload?.tabId).toBe(99);
    expect(payload?.message).toMatchObject({
      type: "x/payload",
      mimeType: "video/mp4",
      fileName: "yt-clip-abc123-10s.mp4",
      text: "テスト動画\n\nhttps://youtu.be/abc123?t=10",
    });
  });

  test("添付完了で idle に戻る", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/attached" });

    expect(h.router.getState()).toEqual({ kind: "idle" });
  });

  test("添付失敗でも成果物は捨てず downloadable へ退避する", async () => {
    const h = makeHarness({}, clip);
    await reachComposing(h);
    await h.router.handle({ type: "x/failed", reason: "セレクタ不一致" });

    const state = h.router.getState();
    expect(state).toMatchObject({
      kind: "downloadable",
      reason: "x-attach-failed",
      mimeType: "video/mp4",
    });
    // 保存済みクリップへの参照が残っていること
    expect(state.kind === "downloadable" && state.clipId).toBeTruthy();
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/background/router.test.ts`
期待: FAIL (`Failed to resolve import "@/background/router"`)

- [ ] **Step 3: router.ts を実装する**

`src/background/router.ts`:

```typescript
import { INITIAL_STATE, reduce } from "@/background/state";
import type { StoredClip } from "@/background/storage";
import { buildClipFileName } from "@/shared/filename";
import type { Message } from "@/shared/messages";
import { renderTemplate } from "@/shared/template";
import type { ClipEvent, ClipState, FailureReason } from "@/shared/types";

/** router が使う外部依存。テストではフェイクを渡す */
export type RouterDeps = {
  ensureOffscreen(): Promise<void>;
  getStreamId(tabId: number): Promise<string>;
  saveClip(clip: StoredClip): Promise<void>;
  getClip(id: string): Promise<StoredClip>;
  /** offscreen / popup 宛。受け手が居ないことは正常なので送信側では扱わない */
  sendToRuntime(message: Message): void;
  sendToTab(tabId: number, message: Message): void;
  openComposeTab(): Promise<number>;
  loadTemplate(): Promise<string>;
  /** UTC epoch ミリ秒 */
  now(): number;
  persist(snapshot: RouterSnapshot): Promise<void>;
};

/** service worker が停止しても復元できるよう保存する内容 */
export type RouterSnapshot = {
  state: ClipState;
  captureTabId: number | null;
  composeTabId: number | null;
};

export type Router = {
  getState(): ClipState;
  handle(message: Message, senderTabId?: number): Promise<void>;
};

export function createRouter(
  deps: RouterDeps,
  initial?: RouterSnapshot,
): Router {
  let state: ClipState = initial?.state ?? INITIAL_STATE;
  let captureTabId: number | null = initial?.captureTabId ?? null;
  let composeTabId: number | null = initial?.composeTabId ?? null;
  let streamId: string | null = null;

  async function commit(event: ClipEvent): Promise<void> {
    state = reduce(state, event);
    await deps.persist({ state, captureTabId, composeTabId });

    const message: Message = { type: "state/changed", state };
    deps.sendToRuntime(message);
    if (captureTabId !== null) {
      deps.sendToTab(captureTabId, message);
    }
  }

  async function fail(reason: FailureReason): Promise<void> {
    await commit({ type: "FAIL", reason });
  }

  /** 録画の下準備。動画はまだ進めない */
  async function prepareCapture(): Promise<void> {
    if (captureTabId === null) {
      await fail("tab-lost");
      return;
    }
    try {
      await deps.ensureOffscreen();
      streamId = await deps.getStreamId(captureTabId);
    } catch {
      await fail("capture-permission-denied");
    }
  }

  /** seek 完了後に録画を始めさせる。状態を進めるのは recorder/started を受けてから */
  async function beginRecording(): Promise<void> {
    if (streamId === null) {
      await fail("capture-permission-denied");
      return;
    }
    deps.sendToRuntime({ type: "recorder/start", streamId });
    streamId = null;
  }

  async function storeRecording(
    buffer: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    if (state.kind !== "encoding") {
      await fail("recording-aborted");
      return;
    }

    const clipId = `clip-${deps.now()}`;
    await deps.saveClip({
      id: clipId,
      blob: new Blob([buffer], { type: mimeType }),
      mimeType,
      range: state.range,
      meta: state.meta,
      createdAt: deps.now(),
    });
    await commit({ type: "BLOB_READY", clipId, mimeType });

    // MP4 でなければ X に添付できないが、録画済みの成果物は捨てない
    if (!mimeType.includes("mp4")) {
      await commit({ type: "DEGRADE", reason: "mp4-unsupported" });
    }
  }

  async function sendPayload(): Promise<void> {
    if (state.kind !== "composing" || composeTabId === null) return;

    const clip = await deps.getClip(state.clipId);
    const template = await deps.loadTemplate();
    deps.sendToTab(composeTabId, {
      type: "x/payload",
      buffer: await clip.blob.arrayBuffer(),
      mimeType: clip.mimeType,
      fileName: buildClipFileName(
        clip.meta.videoId,
        clip.range.startSec,
        clip.mimeType,
      ),
      text: renderTemplate(template, clip.meta, clip.range),
    });
  }

  async function handleEvent(
    event: ClipEvent,
    senderTabId?: number,
  ): Promise<void> {
    if (event.type === "MARK_IN" && senderTabId !== undefined) {
      captureTabId = senderTabId;
    }

    // seek 完了は即座に反映しない。録画が始まってから recording へ進める
    if (event.type === "SEEK_DONE") {
      await beginRecording();
      return;
    }

    await commit(event);

    if (event.type === "START_RECORDING") {
      await prepareCapture();
      return;
    }
    if (event.type === "OUT_REACHED") {
      deps.sendToRuntime({ type: "recorder/stop" });
      return;
    }
    if (event.type === "POST") {
      composeTabId = await deps.openComposeTab();
    }
  }

  return {
    getState: () => state,

    async handle(message: Message, senderTabId?: number): Promise<void> {
      switch (message.type) {
        case "clip/event":
          await handleEvent(message.event, senderTabId);
          return;
        case "recorder/started":
          await commit({ type: "SEEK_DONE" });
          return;
        case "recorder/done":
          await storeRecording(message.buffer, message.mimeType);
          return;
        case "recorder/failed":
          await fail("recording-aborted");
          return;
        case "x/ready":
          await sendPayload();
          return;
        case "x/attached":
          await commit({ type: "ATTACHED" });
          return;
        case "x/failed":
          await commit({ type: "DEGRADE", reason: "x-attach-failed" });
          return;
        default:
          // state/get と state/changed は router の処理対象外
          return;
      }
    },
  };
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/background/router.test.ts`
期待: PASS (11 tests)

- [ ] **Step 5: sw.ts で本物の chrome API を配線する**

`src/background/sw.ts`:

```typescript
import { ensureOffscreen, getStreamId } from "@/background/capture";
import { createRouter, type RouterSnapshot } from "@/background/router";
import { getClip, saveClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import { DEFAULT_TEMPLATE } from "@/shared/template";

const SESSION_KEY = "router-snapshot";
const COMPOSE_URL = "https://x.com/compose/post";

async function loadSnapshot(): Promise<RouterSnapshot | undefined> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] as RouterSnapshot | undefined;
}

// service worker は停止しうるため、保存済みの状態から復元して組み立てる
const ready = loadSnapshot().then((snapshot) =>
  createRouter(
    {
      ensureOffscreen: () => ensureOffscreen(),
      getStreamId: (tabId) => getStreamId(tabId),
      saveClip,
      getClip,
      sendToRuntime: (message) => {
        // popup や offscreen が開いていないだけなら受け手不在は正常
        void chrome.runtime.sendMessage(message).catch(() => undefined);
      },
      sendToTab: (tabId, message) => {
        void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
      },
      openComposeTab: async () => {
        const tab = await chrome.tabs.create({ url: COMPOSE_URL });
        if (tab.id === undefined) {
          throw new Error("投稿タブを開けませんでした");
        }
        return tab.id;
      },
      loadTemplate: async () => {
        const stored = await chrome.storage.sync.get("template");
        const template: unknown = stored.template;
        return typeof template === "string" && template !== ""
          ? template
          : DEFAULT_TEMPLATE;
      },
      now: () => Date.now(),
      persist: async (snapshot) => {
        await chrome.storage.session.set({ [SESSION_KEY]: snapshot });
      },
    },
    snapshot,
  ),
);

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void ready.then(async (router) => {
    if (message.type === "state/get") {
      sendResponse({ state: router.getState() });
      return;
    }
    await router.handle(message, sender.tab?.id);
    sendResponse({ ok: true });
  });
  // 応答が非同期であることを Chrome に伝える
  return true;
});
```

- [ ] **Step 6: 型チェックとテスト全体を通す**

実行: `npx vitest run && npx tsc --noEmit`
期待: 全テスト PASS / 型エラーなし

- [ ] **Step 7: commit**

```bash
git -C . add src/background/router.ts src/background/sw.ts tests/background/router.test.ts
git -C . commit -m "feat: メッセージルーティングと service worker を追加

seek 完了を受けても即座に recording へ進めず、offscreen から
recorder/started が返ってから遷移させる。録画準備の数百ミリ秒で
クリップ冒頭が欠けるのを防ぐため。

ロジックを router.ts に分離して chrome API を注入可能にした。
この順序制約を実機なしでテストできるようにするため。"
```

---

## Task 10: popup

**依存:** Task 1, 2, 4, 9

**Files:**
- Create: `src/popup/view.ts`, `src/popup/popup.html`, `src/popup/popup.ts`
- Test: `tests/popup/view.test.ts`

**Interfaces:**
- Consumes: `ClipState` (`@/shared/types`)、`getClip` (`@/background/storage`)、`buildClipFileName` (`@/shared/filename`)、`formatTime` (`@/shared/time`)
- Produces:
  - `PopupAction` 型: `"record" | "retake" | "post" | "download" | "retry" | "reset"`
  - `PopupView` 型: `{ message: string; actions: PopupAction[]; busy: boolean; showPreview: boolean }`
  - `describeState(state: ClipState): PopupView`

**設計メモ:** 「状態からどう見えるか」を純粋関数 `describeState` に分離し、文言と操作可能なボタンを単体テストで固定する。spec が定めた degraded path の文言はここで逐語的に持つ。

- [ ] **Step 1: 失敗するテストを書く**

`tests/popup/view.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { describeState } from "@/popup/view";
import type { ClipRange, ClipState, VideoMeta } from "@/shared/types";

const meta: VideoMeta = { videoId: "abc123", title: "テスト動画" };
const range: ClipRange = { startSec: 10, endSec: 40 };

describe("マーク前後", () => {
  test("idle では IN の指定を促す", () => {
    const view = describeState({ kind: "idle" });
    expect(view.message).toBe("YouTube の再生画面で IN を押してください");
    expect(view.actions).toEqual([]);
  });

  test("marking では OUT の指定を促す", () => {
    const view = describeState({ kind: "marking", startSec: 10, meta });
    expect(view.message).toBe("0:10 から開始。OUT を押してください");
    expect(view.actions).toEqual([]);
  });

  test("ready では録画と取り消しができる", () => {
    const view = describeState({ kind: "ready", range, meta });
    expect(view.message).toBe("0:10 〜 0:40 (30秒) を録画できます");
    expect(view.actions).toEqual(["record", "reset"]);
  });
});

describe("録画中", () => {
  test("seeking は準備中として操作を止める", () => {
    const view = describeState({ kind: "seeking", range, meta });
    expect(view.message).toBe("開始位置へ移動しています…");
    expect(view.busy).toBe(true);
    expect(view.actions).toEqual([]);
  });

  test("recording は実時間かかることを伝える", () => {
    const view = describeState({ kind: "recording", range, meta });
    expect(view.message).toBe("録画中… 残り 30 秒");
    expect(view.busy).toBe(true);
  });

  test("encoding は書き出し中として扱う", () => {
    const view = describeState({ kind: "encoding", range, meta });
    expect(view.message).toBe("録画を書き出しています…");
    expect(view.busy).toBe(true);
  });
});

describe("プレビューと投稿", () => {
  const preview: ClipState = {
    kind: "preview",
    clipId: "clip-1",
    range,
    meta,
    mimeType: "video/mp4",
  };

  test("preview では投稿と取り直しができる", () => {
    const view = describeState(preview);
    expect(view.showPreview).toBe(true);
    expect(view.actions).toEqual(["post", "retake"]);
  });

  test("composing は投稿画面側の操作を促す", () => {
    const view = describeState({
      kind: "composing",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
    });
    expect(view.message).toBe("X の投稿画面で内容を確認して投稿してください");
    expect(view.actions).toEqual([]);
  });
});

describe("degraded path", () => {
  test("MP4 非対応は spec の文言でダウンロードへ誘導する", () => {
    const view = describeState({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/webm",
      reason: "mp4-unsupported",
    });
    expect(view.message).toBe(
      "この環境では X に直接添付できません。変換してご利用ください",
    );
    expect(view.actions).toEqual(["download", "retake"]);
    expect(view.showPreview).toBe(true);
  });

  test("添付失敗は spec の文言で手動添付へ誘導する", () => {
    const view = describeState({
      kind: "downloadable",
      clipId: "clip-1",
      range,
      meta,
      mimeType: "video/mp4",
      reason: "x-attach-failed",
    });
    expect(view.message).toBe(
      "X の画面構成が変わったため自動添付できませんでした。ファイルをダウンロードして手動で添付してください",
    );
    expect(view.actions).toEqual(["download", "retake"]);
  });
});

describe("失敗", () => {
  test("失敗理由ごとに日本語で提示する", () => {
    const cases = [
      ["capture-permission-denied", "タブの録画が許可されませんでした"],
      ["seek-failed", "開始位置へ移動できませんでした"],
      ["playback-failed", "再生を開始できませんでした"],
      ["ad-playing", "広告の再生中です。終了後にやり直してください"],
      ["tab-lost", "録画対象のタブが見つかりません"],
      ["recording-aborted", "録画が中断されました"],
      ["internal-error", "内部エラーが発生しました"],
    ] as const;

    for (const [reason, message] of cases) {
      const view = describeState({ kind: "failed", reason, range, meta });
      expect(view.message).toBe(message);
      expect(view.actions).toEqual(["retry"]);
    }
  });
});
```

- [ ] **Step 2: 実行して失敗を確認**

実行: `npx vitest run tests/popup/view.test.ts`
期待: FAIL (`Failed to resolve import "@/popup/view"`)

- [ ] **Step 3: view.ts を実装する**

`src/popup/view.ts`:

```typescript
import { formatTime } from "@/shared/time";
import type { ClipState, FailureReason } from "@/shared/types";

export type PopupAction =
  | "record"
  | "retake"
  | "post"
  | "download"
  | "retry"
  | "reset";

export type PopupView = {
  message: string;
  actions: PopupAction[];
  /** 進行中で操作を受け付けない状態か */
  busy: boolean;
  /** 録画済みクリップの再生欄を出すか */
  showPreview: boolean;
};

const FAILURE_MESSAGES: Record<FailureReason, string> = {
  "capture-permission-denied": "タブの録画が許可されませんでした",
  "seek-failed": "開始位置へ移動できませんでした",
  "playback-failed": "再生を開始できませんでした",
  "ad-playing": "広告の再生中です。終了後にやり直してください",
  "tab-lost": "録画対象のタブが見つかりません",
  "recording-aborted": "録画が中断されました",
  "internal-error": "内部エラーが発生しました",
};

const DEGRADED_MESSAGES = {
  "mp4-unsupported":
    "この環境では X に直接添付できません。変換してご利用ください",
  "x-attach-failed":
    "X の画面構成が変わったため自動添付できませんでした。ファイルをダウンロードして手動で添付してください",
} as const;

function durationOf(startSec: number, endSec: number): number {
  return Math.round(endSec - startSec);
}

export function describeState(state: ClipState): PopupView {
  switch (state.kind) {
    case "idle":
      return {
        message: "YouTube の再生画面で IN を押してください",
        actions: [],
        busy: false,
        showPreview: false,
      };

    case "marking":
      return {
        message: `${formatTime(state.startSec)} から開始。OUT を押してください`,
        actions: [],
        busy: false,
        showPreview: false,
      };

    case "ready":
      return {
        message: `${formatTime(state.range.startSec)} 〜 ${formatTime(state.range.endSec)} (${durationOf(state.range.startSec, state.range.endSec)}秒) を録画できます`,
        actions: ["record", "reset"],
        busy: false,
        showPreview: false,
      };

    case "seeking":
      return {
        message: "開始位置へ移動しています…",
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "recording":
      // 録画は実時間かかるため、待ち時間を明示する
      return {
        message: `録画中… 残り ${durationOf(state.range.startSec, state.range.endSec)} 秒`,
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "encoding":
      return {
        message: "録画を書き出しています…",
        actions: [],
        busy: true,
        showPreview: false,
      };

    case "preview":
      return {
        message: "録画できました。内容を確認してください",
        actions: ["post", "retake"],
        busy: false,
        showPreview: true,
      };

    case "composing":
      return {
        message: "X の投稿画面で内容を確認して投稿してください",
        actions: [],
        busy: false,
        showPreview: true,
      };

    case "downloadable":
      return {
        message: DEGRADED_MESSAGES[state.reason],
        actions: ["download", "retake"],
        busy: false,
        showPreview: true,
      };

    case "failed":
      return {
        message: FAILURE_MESSAGES[state.reason],
        actions: ["retry"],
        busy: false,
        showPreview: false,
      };
  }
}
```

- [ ] **Step 4: 実行して通過を確認**

実行: `npx vitest run tests/popup/view.test.ts`
期待: PASS (11 tests)

- [ ] **Step 5: popup の画面を実装する**

`src/popup/popup.html`:

```html
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>yt-clip</title>
    <style>
      body {
        width: 320px;
        margin: 0;
        padding: 12px;
        font-family: system-ui, sans-serif;
        font-size: 13px;
      }
      #message {
        margin-bottom: 10px;
        line-height: 1.5;
      }
      #preview {
        width: 100%;
        margin-bottom: 10px;
        background: #000;
      }
      #actions {
        display: flex;
        gap: 8px;
      }
      button {
        flex: 1;
        padding: 6px;
        cursor: pointer;
      }
      button:disabled {
        cursor: default;
        opacity: 0.5;
      }
    </style>
  </head>
  <body>
    <p id="message"></p>
    <video id="preview" controls hidden></video>
    <div id="actions"></div>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

`src/popup/popup.ts`:

```typescript
import { getClip } from "@/background/storage";
import { describeState, type PopupAction } from "@/popup/view";
import { buildClipFileName } from "@/shared/filename";
import type { Message, MessageResponse } from "@/shared/messages";
import type { ClipEvent, ClipState } from "@/shared/types";

const ACTION_LABELS: Record<PopupAction, string> = {
  record: "録画",
  retake: "取り直し",
  post: "X に投稿",
  download: "ダウンロード",
  retry: "再試行",
  reset: "取り消し",
};

const ACTION_EVENTS: Record<
  Exclude<PopupAction, "download">,
  ClipEvent
> = {
  record: { type: "START_RECORDING" },
  retake: { type: "RETAKE" },
  post: { type: "POST" },
  retry: { type: "RETRY" },
  reset: { type: "RESET_MARKS" },
};

const messageElement = document.getElementById("message") as HTMLElement;
const previewElement = document.getElementById("preview") as HTMLVideoElement;
const actionsElement = document.getElementById("actions") as HTMLElement;

/** プレビュー用に発行した blob URL。差し替え時に解放する */
let previewUrl: string | null = null;

function send(event: ClipEvent): void {
  void chrome.runtime.sendMessage({
    type: "clip/event",
    event,
  } satisfies Message);
}

async function download(state: ClipState): Promise<void> {
  if (state.kind !== "downloadable") return;

  const clip = await getClip(state.clipId);
  const url = URL.createObjectURL(clip.blob);
  await chrome.downloads.download({
    url,
    filename: buildClipFileName(
      clip.meta.videoId,
      clip.range.startSec,
      clip.mimeType,
    ),
    saveAs: true,
  });
}

async function showPreview(state: ClipState): Promise<void> {
  const clipId =
    state.kind === "preview" ||
    state.kind === "composing" ||
    state.kind === "downloadable"
      ? state.clipId
      : null;

  if (clipId === null) {
    previewElement.hidden = true;
    return;
  }

  const clip = await getClip(clipId);
  if (previewUrl !== null) {
    URL.revokeObjectURL(previewUrl);
  }
  previewUrl = URL.createObjectURL(clip.blob);
  previewElement.src = previewUrl;
  previewElement.hidden = false;
}

function render(state: ClipState): void {
  const view = describeState(state);
  messageElement.textContent = view.message;

  actionsElement.replaceChildren(
    ...view.actions.map((action) => {
      const button = document.createElement("button");
      button.textContent = ACTION_LABELS[action];
      button.disabled = view.busy;
      button.addEventListener("click", () => {
        if (action === "download") {
          void download(state);
          return;
        }
        send(ACTION_EVENTS[action]);
      });
      return button;
    }),
  );

  if (view.showPreview) {
    void showPreview(state);
  } else {
    previewElement.hidden = true;
  }
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "state/changed") {
    render(message.state);
  }
});

void chrome.runtime
  .sendMessage({ type: "state/get" } satisfies Message)
  .then((response: MessageResponse) => {
    if ("state" in response) {
      render(response.state);
    }
  });
```

- [ ] **Step 6: 型チェックとテスト全体を通す**

実行: `npx vitest run && npx tsc --noEmit && npm run build`
期待: 全テスト PASS / 型エラーなし / `dist/` が生成される

- [ ] **Step 7: commit**

```bash
git -C . add src/popup tests/popup
git -C . commit -m "feat: popup を追加

状態から表示を決める部分を describeState に切り出し、degraded path
の文言を単体テストで固定した。ユーザーが最初に読むのがこの文言で、
録画に実時間を払った後に何をすべきかを伝える唯一の場所のため。"
```

---

## Task 11: E2E スモークとリリース前手動確認

**依存:** Task 1〜10 すべて (最後に実施する)

**Files:**
- Create: `playwright.config.ts`, `e2e/smoke.spec.ts`, `docs/manual-check.md`, `README.md`

**Interfaces:**
- Consumes: ビルド済みの `dist/`
- Produces: なし (検証タスク)

**設計メモ:** E2E は**ネットワークと YouTube の実 DOM に依存するため CI では実行しない**。`npm run e2e` を明示的に叩いたときだけ走らせ、リリース前のローカル確認に使う。X への添付は**ログイン済みアカウントを要するため自動化せず**、`docs/manual-check.md` のチェックリストで担保する。認証情報をテストに持たせないための線引き。

外部プロセス (ブラウザ) の起動と待機には**必ずタイムアウトを設ける**。

- [ ] **Step 1: Playwright を設定する**

`playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // 録画は実時間かかるうえ拡張の起動も挟むため長めに取る
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // 実ネットワークと YouTube の DOM に依存するため並列実行しない
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
```

`package.json` の `scripts` に E2E がビルド済み成果物を使うことを明示する:

```json
{
  "scripts": {
    "e2e": "npm run build && playwright test"
  }
}
```

- [ ] **Step 2: スモークテストを書く**

`e2e/smoke.spec.ts`:

```typescript
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));

/** 短く安定した公開動画。広告が挟まると録画に混入するため失敗しうる */
const TEST_VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
    // ブラウザ起動が固まったまま待ち続けないようにする
    timeout: 60_000,
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test("拡張がロードされ service worker が起動する", () => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("YouTube の再生画面に IN/OUT UI が注入される", async () => {
  const page = await context.newPage();
  await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const bar = page.locator("#yt-clip-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar.getByRole("button", { name: "IN" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "OUT" })).toBeVisible();

  await page.close();
});

test("IN/OUT を指定して録画するとプレビューまで到達する", async () => {
  const page = await context.newPage();
  await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const bar = page.locator("#yt-clip-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });

  /** 再生位置を動かす。UI 操作ではシークバーの精度が出ないため直接指定する */
  const seek = (sec: number) =>
    page.evaluate((target: number) => {
      const video = document.querySelector<HTMLVideoElement>(
        "video.html5-main-video",
      );
      if (video === null) throw new Error("video 要素が見つかりません");
      video.currentTime = target;
    }, sec);

  // 3 秒のクリップを指定する。録画は実時間かかるので短くする
  await seek(5);
  await bar.getByRole("button", { name: "IN" }).click();
  await seek(8);
  await bar.getByRole("button", { name: "OUT" }).click();

  await expect(page.locator("#yt-clip-bar-status")).toHaveText("0:05 〜 0:08");

  // popup から録画を実行する
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extensionId}/src/popup/popup.html`,
    { timeout: 30_000 },
  );
  await expect(popup.locator("#message")).toHaveText(
    "0:05 〜 0:08 (3秒) を録画できます",
  );

  await popup.getByRole("button", { name: "録画" }).click();

  // 実時間 3 秒の録画と書き出しを待つ
  await expect(popup.locator("#message")).toHaveText(
    "録画できました。内容を確認してください",
    { timeout: 60_000 },
  );
  await expect(popup.locator("#preview")).toBeVisible();

  await popup.close();
  await page.close();
});
```

- [ ] **Step 3: E2E を実行する**

実行: `npm run e2e`
期待: 3 tests PASS

**失敗したときの切り分け:**

| 症状 | 原因の候補 |
|---|---|
| service worker が現れない | `dist/` が未ビルド、または manifest のパス誤り |
| `#yt-clip-bar` が出ない | `YT_SELECTORS.controls` が YouTube の DOM 変更で不一致 |
| status の文言が違う | `formatTime` の出力、または `validateRange` で弾かれている |
| 録画が preview まで進まない | offscreen の起動失敗、MP4 非対応 (この場合は degraded の文言になる)、または広告の混入 |

- [ ] **Step 4: 手動確認チェックリストを書く**

`docs/manual-check.md`:

```markdown
# リリース前 手動確認チェックリスト

E2E で自動化していない範囲を確認する。X への添付はログイン済みアカウントを
必要とするため、認証情報をテストに持たせない方針で手動確認としている。

## 準備

1. `npm run build`
2. `chrome://extensions` を開き、デベロッパーモードを有効にする
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/` を指定する
4. X にログインしておく

## 通常フロー (MP4 対応環境)

- [ ] YouTube の再生画面に IN / OUT ボタンが表示される
- [ ] IN を押すと popup に開始位置が表示される
- [ ] OUT を押すと「〜秒を録画できます」と表示される
- [ ] 「録画」を押すと開始位置へ移動し、そこから再生が始まる
- [ ] **クリップの冒頭が欠けていない** (IN で指定した位置から始まっている)
- [ ] 録画中もタブの音声がスピーカーから聞こえる
- [ ] OUT の位置で録画が止まり、末尾が伸びていない
- [ ] popup でクリップを再生して確認できる
- [ ] 「取り直し」で同じ範囲を録り直せる
- [ ] 「X に投稿」で投稿画面が開き、動画が添付される
- [ ] 本文にタイトルと開始秒つき URL が入っている
- [ ] **投稿ボタンが自動で押されていない**
- [ ] 実際に投稿して、X 上で動画がインライン再生される

## 制約の確認

- [ ] 61 秒以上の範囲を指定するとエラー文言が出て録画に進まない
- [ ] 低画質 (480p 以下) で録画しようとすると画質を上げるよう警告が出る
- [ ] 広告の再生中に録画しようとすると中断され、理由が表示される
- [ ] 録画中に対象タブを閉じると失敗として表示される
- [ ] タブの録画を拒否すると理由が表示される

## degraded path

- [ ] MP4 非対応の環境で「この環境では X に直接添付できません」と表示される
- [ ] その状態でもプレビューでき、WebM をダウンロードできる
- [ ] X の添付に失敗した場合、ダウンロードへ誘導される (クリップが消えない)

## 確認した環境

| 項目 | 値 |
|---|---|
| Chrome バージョン | |
| OS | |
| 確認日 (JST) | |
```

- [ ] **Step 5: README を書く**

`README.md`:

```markdown
# yt-clip

YouTube の切り抜きを作って X に投稿する Chrome 拡張機能。

視聴中に IN / OUT を指定すると、その区間をタブ録画して動画ファイルを作り、
X の投稿画面に本文つきで自動添付する。外部ツール (yt-dlp / ffmpeg) の
インストールは不要。

## 使い方

1. YouTube の再生画面で切り抜きたい場面の頭で **IN**、終わりで **OUT** を押す
2. 拡張のアイコンから **録画** を押す (録画は実時間かかる)
3. プレビューで確認し、**X に投稿** を押す
4. 開いた投稿画面で内容を確認して自分で投稿する

投稿ボタンは自動では押さない。最終確認は必ず手元に残る。

## 制約

- 録画は実時間かかる (30 秒のクリップに 30 秒)
- クリップの最大長は 60 秒
- 画質は再生中の解像度に依存する
- 録画中に広告が挟まると中断される
- MP4 で録画できない環境では WebM のダウンロードのみ対応

## 開発

```bash
npm install
npm run build      # dist/ に拡張を出力
npm test           # 単体テスト
npm run typecheck  # 型チェック
npm run e2e        # E2E (ネットワーク必須。CI では実行しない)
```

`chrome://extensions` でデベロッパーモードを有効にし、`dist/` を
「パッケージ化されていない拡張機能」として読み込む。

設計は [`.claude/specs/2026-09-10-yt-clip-design.md`](.claude/specs/2026-09-10-yt-clip-design.md) を参照。
```

- [ ] **Step 6: 全体を通す**

実行: `npx vitest run && npx tsc --noEmit && npm run build`
期待: 全テスト PASS / 型エラーなし / ビルド成功

- [ ] **Step 7: commit**

```bash
git -C . add playwright.config.ts e2e docs/manual-check.md README.md package.json
git -C . commit -m "test: E2E スモークとリリース前手動確認を追加

X への添付は自動化せず手動確認に回した。ログイン済みアカウントが
必要で、テストに認証情報を持たせたくないため。E2E も実 DOM 依存の
ため CI では動かさず、リリース前のローカル確認に限定する。"
```

---

## 完了条件

すべてのタスクが終わった時点で以下が成り立つこと。

- [ ] `npx vitest run` が全件 PASS する
- [ ] `npx tsc --noEmit` が型エラーなしで通る
- [ ] `npm run build` が `dist/` を生成する
- [ ] `dist/` を Chrome に読み込むと YouTube の再生画面に IN/OUT UI が出る
- [ ] `docs/manual-check.md` の「通常フロー」が全項目チェック済みになる
