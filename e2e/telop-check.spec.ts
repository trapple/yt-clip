import {
  chromium,
  type Browser,
  expect,
  test,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * テロップの実機確認 (docs/manual-check.md の「テロップ」節)。**手動実行専用。**
 *
 * `npm run check:telop` で走らせる。本物の YouTube と実時間の録画に依存し、
 * 数分かかるうえ広告で落ちうるので、通常の `npm run e2e` には入れない。
 *
 * 結果は `test-results/telop-check/` に残す。見た目 (焼き込みとプレビューの一致、
 * 360p と 1080p の比率) と音ズレは機械で判定しきれないため、画像と mp4 を
 * 残して人が見る。ここで pass/fail を付けるのは数値で決められる項目だけ。
 */
test.skip(!process.env.YT_CLIP_TELOP_CHECK, "手動実行専用");
// 押せないボタンを押しに行ったまま、テスト全体の上限 (15 分) まで待ち続けない
//
// 失敗時の trace / video / screenshot は切る。trace のスクリーンショットと video は
// ページに screencast を掛け、それがページを表示中のまま保つ (タブが隠れなくなる)。
// 証拠は自前で test-results/telop-check/ に残す
test.use({ actionTimeout: 30_000, trace: "off", video: "off", screenshot: "off" });

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));
const OUT_DIR = fileURLToPath(
  new URL("../test-results/telop-check", import.meta.url),
);

/** Big Buck Bunny 60fps (10 分)。1080p60 まであり、テロップの縁取りの見え方も確かめやすい */
const TEST_VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

/** 2 区間で合計 6 秒。区間の間の繋ぎ目も通す */
const SEGMENTS = [
  { startSec: 60, endSec: 63 },
  { startSec: 120, endSec: 123 },
];
/** 1 つは 2 行にして、行の積み方も画像で見られるようにする */
const TELOPS = [
  { startSec: 60.5, text: "テロップの確認\n2 行目です" },
  { startSec: 120.5, text: "2 つ目の区間のテロップ" },
];
const EXPECTED_SEC = 6;
/**
 * 区間の繋ぎと末尾のフレームで MediaRecorder の出力は少し揺れる (§9.1 の実測で
 * 6.02〜6.12 秒)。区間 1 つ分の欠落や重複 (秒単位) は確実に弾ける幅にする
 */
const TOLERANCE_SEC = 0.5;

/**
 * 焼き込みと比べる時刻。出力の秒 (区間を詰めた後の時刻) と、それに対応する元動画の秒。
 * テロップ 1 は元 60.5〜63 → 出力 0.5〜3、テロップ 2 は元 120.5〜123 → 出力 3.5〜6
 */
const COMPARE_POINTS = [
  { name: "t1", sourceSec: 61.5, outputSec: 1.5 },
  { name: "t2", sourceSec: 121.5, outputSec: 4.5 },
];

const TAB_HIDDEN_MESSAGE =
  "テロップ付きの録画中はタブを表示したままにしてください。もう一度録り直してください";

type CheckResult = { pass: boolean; values: Record<string, unknown>; note?: string };
const results: Record<string, CheckResult> = {};

function record(
  name: string,
  pass: boolean,
  values: Record<string, unknown>,
  note?: string,
): void {
  results[name] = { pass, values, ...(note === undefined ? {} : { note }) };
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(values)}`);
}

/** ページと service worker のログ。失敗 (特に「内部エラー」) の理由はここにしか出ない */
const consoleLines: string[] = [];
function logConsole(source: string, type: string, text: string): void {
  consoleLines.push(`${new Date().toISOString()} [${source}] ${type}: ${text}`);
}

async function writeResults(): Promise<void> {
  await writeFile(join(OUT_DIR, "console.log"), consoleLines.join("\n"));
  await writeFile(
    join(OUT_DIR, "results.json"),
    JSON.stringify(results, null, 2),
  );
}

/**
 * 1 項目の失敗で残りを確かめられなくしない。例外も fail として残し、先へ進める。
 * 最後にまとめて expect するので、握りつぶしにはならない
 */
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    record(name, false, { error: String(error) });
  }
  await writeResults();
}

/**
 * CDP の応答を待つ処理に上限を付ける。Chrome が無応答だと Playwright の send / close は
 * 返らず、フックのタイムアウトまで止まる
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} が ${ms / 1000} 秒で返りません`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** ffmpeg / ffprobe は引数の抜け 1 つで暴走しうるので必ず timeout を付ける */
function runTool(command: string, args: string[]): string {
  return execFileSync(command, args, { timeout: 60_000, encoding: "utf8" });
}

function probe(file: string): { durationSec: number; width: number; height: number } {
  const json = JSON.parse(
    runTool("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      file,
    ]),
  ) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number }[];
  };
  const video = json.streams.find((s) => s.codec_type === "video");
  return {
    durationSec: Number(json.format.duration),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}

function extractFrame(clip: string, outputSec: number, out: string): void {
  runTool("ffmpeg", [
    "-v", "error", "-y",
    "-ss", String(outputSec),
    "-i", clip,
    "-frames:v", "1",
    out,
  ]);
}

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/**
 * service worker は MV3 で止まりうる。止まっていたら popup を開いて起こす
 * (popup は service worker に状態を問い合わせる)
 */
async function getWorker(): Promise<Worker> {
  const found = context
    .serviceWorkers()
    .find((w) => new URL(w.url()).host === extensionId);
  if (found !== undefined) return found;
  const waiting = context.waitForEvent("serviceworker", { timeout: 30_000 });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const worker = await waiting;
  await popup.close();
  return worker;
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  const worker = await getWorker();
  await worker.evaluate(
    (value) => chrome.storage.sync.set({ settings: value }),
    settings,
  );
}

type SavedClip = { id: string; createdAt: number; mimeType: string; base64: string };

/** 拡張の IndexedDB から最新のクリップを取り出す。Blob は evaluate の外に出せないので base64 で */
async function readLatestClip(): Promise<SavedClip | null> {
  const worker = await getWorker();
  return worker.evaluate(async () => {
    // **開く前に有るかを確かめる。** 無い DB を open すると空の DB (store 無し) が
    // version 1 で作られ、拡張の側では onupgradeneeded が走らず保存に失敗する
    const names = (await indexedDB.databases()).map((d) => d.name);
    if (!names.includes("yt-clip")) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("yt-clip");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const all = await new Promise<
        { id: string; createdAt: number; mimeType: string; blob: Blob }[]
      >((resolve, reject) => {
        if (!db.objectStoreNames.contains("clips")) {
          resolve([]);
          return;
        }
        const request = db.transaction("clips").objectStore("clips").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (all.length === 0) return null;
      const latest = all.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      const bytes = new Uint8Array(await latest.blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return {
        id: latest.id,
        createdAt: latest.createdAt,
        mimeType: latest.mimeType,
        base64: btoa(binary),
      };
    } finally {
      db.close();
    }
  });
}

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser: Browser;
let chromeProcess: ChildProcess | undefined;

/**
 * Chrome は自前で起動し、Playwright には CDP で繋ぐ。launchPersistentContext を使わない理由:
 *
 * - **タブが隠れなくなる。** Playwright は開いた全ページに Emulation.setFocusEmulationEnabled を
 *   掛け、これがページを表示中のまま保つ。別のタブを前に出しても、ウィンドウを最小化しても
 *   visibilityState が visible のままで、「タブが隠れたら中断」を確かめられない。
 *   connectOverCDP の noDefaults を付けると、既定のコンテキストのページには掛けない
 * - **拡張を --load-extension で入れられない。** Google Chrome (137 以降) はこのフラグを
 *   無視する (同梱の Chromium は H.264 を持たず MP4 で録れないので使えない)。代わりに
 *   CDP の Extensions.loadUnpacked で入れる。これには --enable-unsafe-extension-debugging が要る
 */
async function launchChrome(): Promise<void> {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-telop-"));
  chromeProcess = spawn(
    CHROME_PATH,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging",
      // **自動操作の印を消す。** navigator.webdriver が立っていると、YouTube は最初の
      // 位置の再生だけ通し、シーク先の読み込みを返さない (readyState が 1 のまま止まり、
      // やがて「Something went wrong」になる)。タブの表示・非表示には関わらない
      "--disable-blink-features=AutomationControlled",
      "--autoplay-policy=no-user-gesture-required",
      // **タブの切り替えで隠れる動作を変えるフラグは付けない** (--disable-renderer-backgrounding 等)。
      // タブが隠れたら中断する、を本物の挙動で確かめるため。
      // occluded-windows だけは付ける。ウィンドウが他のウィンドウに覆われただけで
      // hidden になり、関係の無い項目まで中断で落ちるのを防ぐ
      "--disable-backgrounding-occluded-windows",
      "--window-size=1920,1200",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  // 起動した Chrome は使う port を user-data-dir に書き出す。固定 port にしないのは、
  // 普段使いの Chrome や前回の残りとぶつからないようにするため
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  let port = "";
  while (port === "") {
    if (Date.now() > deadline) throw new Error("Chrome の起動を待ちきれません");
    port = await readFile(portFile, "utf8").then(
      (text) => text.split("\n")[0] ?? "",
      () => "",
    );
    if (port === "") await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP({
    endpointURL: `http://127.0.0.1:${port}`,
    timeout: 30_000,
    // 公開の型には無いが Playwright が受け付ける (上のコメント参照)
    noDefaults: true,
  } as { endpointURL: string; timeout: number });
  const first = browser.contexts()[0];
  if (first === undefined) throw new Error("Chrome の既定のコンテキストがありません");
  context = first;
}

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  await launchChrome();
  const cdp = await browser.newBrowserCDPSession();
  const loaded = (await withTimeout(
    cdp.send("Extensions.loadUnpacked" as never, { path: EXTENSION_PATH } as never),
    30_000,
    "拡張の読み込み (Extensions.loadUnpacked)",
  )) as { id: string };
  await cdp.detach();
  extensionId = loaded.id;
  // service worker は読み込んだだけでは起動しないことがある。getWorker が起こす
  await getWorker();
});

test.afterAll(async () => {
  try {
    await writeResults();
    // connectOverCDP の close は切断するだけで Chrome は残る。**切断は best-effort。**
    // Chrome が無応答だと close が返らず、後ろの停止と削除まで進めなくなる。
    // Chrome の停止は CDP の応答に頼らずプロセスへのシグナルで行う
    if (browser !== undefined) {
      await withTimeout(browser.close(), 5_000, "CDP の切断").catch((error: unknown) =>
        console.warn(`CDP の切断に失敗しました (Chrome は止めに行く): ${String(error)}`),
      );
    }
  } finally {
    // **終わるまで待ってから**消す。待たないと終了中の Chrome がキャッシュを書き足し、
    // rm が ENOTEMPTY で落ちる
    const proc = chromeProcess;
    if (proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.kill();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    if (userDataDir !== undefined) {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

test("テロップの実機確認", async () => {
  // 録画 4 本 (各 6 秒 + 準備) と画質の切り替え待ちを含む
  test.setTimeout(900_000);

  await writeSettings({ mode: "edit" });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.on("console", (m) => {
    // YouTube 自身のログは多いので、拡張 (yt-clip) の出すものと警告・エラーだけ残す
    if (m.type() === "error" || m.type() === "warning" || m.text().includes("yt-clip")) {
      logConsole("page", m.type(), m.text());
    }
  });
  page.on("pageerror", (e) => logConsole("page", "pageerror", String(e)));
  (await getWorker()).on("console", (m) => logConsole("sw", m.type(), m.text()));
  await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const bar = page.locator("#yt-clip-bar");
  const status = page.locator("#yt-clip-bar-status");
  await expect(bar).toBeVisible({ timeout: 60_000 });
  // IN / ＋ 区間を追加 は動画タイトルを読む。埋まる前に押すと操作できない
  await expect(
    page.locator("h1.ytd-watch-metadata yt-formatted-string"),
  ).not.toBeEmpty({ timeout: 30_000 });

  const button = (name: string) => bar.getByRole("button", { name, exact: true });
  const segmentRows = bar.locator("[data-role=segment]");
  const telopRows = bar.locator("[data-role=telop]");

  /** 広告が出ている間は操作も録画も意味を持たない。消えるまで待つ */
  async function waitNoAd(): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (
      await page.evaluate(() =>
        document.getElementById("movie_player")?.classList.contains("ad-showing") ?? false,
      )
    ) {
      if (Date.now() > deadline) throw new Error("広告が 3 分経っても終わりません");
      const skip = page.locator(".ytp-skip-ad-button, .ytp-ad-skip-button-modern");
      if (await skip.first().isVisible().catch(() => false)) {
        await skip.first().click().catch(() => undefined);
      }
      await page.waitForTimeout(1000);
    }
  }

  /**
   * 一時停止して指定の秒へ動かし、フレームが出るまで待つ。UI のシークバーでは精度が出ない。
   * video.currentTime を直接書かずプレイヤーの seekTo を使う。直接書くと、読み込んで
   * いない位置へ飛んだときに YouTube のプレイヤーが「Something went wrong」で止まった
   */
  async function seekPaused(sec: number): Promise<void> {
    await waitNoAd();
    await page.evaluate(async (target: number) => {
      const player = document.getElementById("movie_player") as unknown as {
        pauseVideo(): void;
        seekTo(sec: number, allowSeekAhead: boolean): void;
      } | null;
      const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
      if (player === null || video === null) throw new Error("プレイヤーが見つかりません");
      player.pauseVideo();
      player.seekTo(target, true);
      const deadline = Date.now() + 30_000;
      while (
        video.seeking ||
        video.readyState < 2 ||
        Math.abs(video.currentTime - target) > 0.1
      ) {
        if (document.querySelector(".ytp-error") !== null) {
          throw new Error("YouTube のプレイヤーがエラーを出しました");
        }
        if (Date.now() > deadline) {
          throw new Error(`${target} 秒へ移動できません (いま ${video.currentTime})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      video.pause();
    }, sec);
  }

  const videoState = () =>
    page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
      if (video === null) throw new Error("video 要素が見つかりません");
      return {
        paused: video.paused,
        currentTime: video.currentTime,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      };
    });

  /**
   * 画質を固定し、実際に切り替わったことを videoHeight で確かめる。
   * 切り替えは再生しないと進まないので、区間から離れた位置で少し流す
   */
  async function setQuality(quality: string, height: number): Promise<number> {
    await waitNoAd();
    await page.evaluate((q: string) => {
      const player = document.getElementById("movie_player") as unknown as {
        setPlaybackQualityRange(min: string, max: string): void;
      } | null;
      if (player === null) throw new Error("movie_player が見つかりません");
      player.setPlaybackQualityRange(q, q);
    }, quality);
    await seekPaused(20);
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.play(),
    );
    const deadline = Date.now() + 60_000;
    let current = 0;
    while (Date.now() < deadline) {
      await waitNoAd();
      current = (await videoState()).videoHeight;
      if (current === height) break;
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.pause(),
    );
    return current;
  }

  /** テロップの文言を入れて確定する (change は blur で送られる) */
  async function setTelopText(index: number, text: string): Promise<void> {
    const textarea = telopRows.nth(index).locator("textarea");
    await textarea.fill(text);
    await textarea.blur();
    // 状態機械からの通知が返ってくるのを待つ。文言そのものは textarea に残って
    // いるので DOM では見分けられない
    await page.waitForTimeout(500);
  }

  async function buildSegments(): Promise<void> {
    for (const [i, segment] of SEGMENTS.entries()) {
      await seekPaused(segment.startSec);
      await button("＋ 区間を追加").click();
      await expect(segmentRows).toHaveCount(i + 1);
      await seekPaused(segment.endSec);
      await button("OUT").click();
      await expect(segmentRows.nth(i)).toContainText("(3秒)");
    }
  }

  async function addTelops(): Promise<void> {
    for (const [i, telop] of TELOPS.entries()) {
      await seekPaused(telop.startSec);
      await bar.locator("[data-role=add-telop]").click();
      await expect(telopRows).toHaveCount(i + 1);
      await setTelopText(i, telop.text);
    }
  }

  /** 録画して保存されたクリップを返す。「取り直す」が出たら成功、「再試行」なら失敗 */
  async function recordClip(): Promise<{ clip: SavedClip | null; status: string }> {
    await waitNoAd();
    const before = await readLatestClip();
    await button("● 録画").click();
    const done = button("取り直す");
    const failed = button("再試行");
    await expect(done.or(failed)).toBeVisible({ timeout: 120_000 });
    const text = (await status.textContent()) ?? "";
    if (await failed.isVisible()) return { clip: null, status: text };
    const clip = await readLatestClip();
    if (clip === null || clip.id === before?.id) {
      throw new Error("録画は終わったのにクリップが保存されていません");
    }
    return { clip, status: text };
  }

  async function saveClip(clip: SavedClip, name: string): Promise<string> {
    const file = join(OUT_DIR, name);
    await writeFile(file, Buffer.from(clip.base64, "base64"));
    return file;
  }

  /** 焼き込みの比較用に、プレビュー (元動画の同じ時刻) をプレイヤーごと撮る */
  async function previewShots(label: string): Promise<string[]> {
    const files: string[] = [];
    for (const point of COMPARE_POINTS) {
      await seekPaused(point.sourceSec);
      // 一時停止中の描き直しは seeked を受けてから。描き終わるのを少し待つ
      await page.waitForTimeout(500);
      const file = join(OUT_DIR, `preview-${label}-${point.name}.png`);
      await page.locator("#movie_player").screenshot({ path: file });
      files.push(file);
    }
    return files;
  }

  async function recordAndInspect(label: string, expectedHeight: number): Promise<void> {
    const { clip, status: text } = await recordClip();
    if (clip === null) {
      record(`録画 ${label}: 出力の長さ = 区間の合計`, false, { status: text });
      await page.screenshot({ path: join(OUT_DIR, `record-${label}-failed.png`) });
      // 次の項目を ready から始められるよう戻す
      await button("再試行").click();
      await expect(button("● 録画")).toBeVisible();
      return;
    }
    const file = await saveClip(clip, `clip-${label}.mp4`);
    const info = probe(file);
    const frames: string[] = [];
    for (const point of COMPARE_POINTS) {
      const out = join(OUT_DIR, `frame-${label}-${point.name}.png`);
      extractFrame(file, point.outputSec, out);
      frames.push(out);
    }
    record(
      `録画 ${label}: 出力の長さ = 区間の合計`,
      Math.abs(info.durationSec - EXPECTED_SEC) <= TOLERANCE_SEC &&
        clip.mimeType.startsWith("video/mp4"),
      { ...info, mimeType: clip.mimeType, file, frames },
    );
    record(`録画 ${label}: 出力の解像度`, info.height === expectedHeight, {
      expectedHeight,
      height: info.height,
      width: info.width,
    });
    await button("取り直す").click();
    await expect(button("● 録画")).toBeVisible();
  }

  // --- 準備: 1080p で 2 区間と 2 テロップを作る ------------------------------
  await waitNoAd();
  const height1080 = await setQuality("hd1080", 1080);
  record("画質 1080p に切り替わった", height1080 === 1080, { videoHeight: height1080 });
  await buildSegments();
  await addTelops();

  // --- プレビューの見た目 (1080p) --------------------------------------------
  await check("プレビューのスクリーンショット 1080p", async () => {
    const files = await previewShots("1080");
    const canvas = await page.locator("#yt-clip-telop-preview").count();
    record("プレビューのスクリーンショット 1080p", canvas === 1, { files });
  });

  // --- 入力中にショートカットが発火しない ------------------------------------
  await check("入力中にショートカットが発火しない", async () => {
    await seekPaused(61);
    const textarea = telopRows.nth(0).locator("textarea");
    const original = await textarea.inputValue();
    const before = await videoState();
    await textarea.focus();
    await page.keyboard.press("f");
    await page.keyboard.press("Space");
    await page.waitForTimeout(1000);
    const after = await videoState();
    const fullscreen = await page.evaluate(() => document.fullscreenElement !== null);
    const typed = await textarea.inputValue();
    // 打った文字は捨てる。blur 前に元に戻せば change は起きない
    await textarea.fill(original);
    await textarea.blur();
    record(
      "入力中にショートカットが発火しない",
      !fullscreen && before.paused === after.paused,
      { fullscreen, pausedBefore: before.paused, pausedAfter: after.paused, typed },
    );
  });

  // --- 一時停止中の描き直し ----------------------------------------------------
  await check("一時停止中に文言を変えるとプレビューが描き直される", async () => {
    await seekPaused(61.5);
    await page.waitForTimeout(500);
    const snapshot = () =>
      page.evaluate(() => {
        const canvas = document.getElementById("yt-clip-telop-preview") as HTMLCanvasElement | null;
        if (canvas === null) throw new Error("プレビューの canvas がありません");
        const data = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        // 全画素を比べる代わりに要約する (FNV-1a と不透明な画素の数)
        let hash = 0x811c9dc5;
        let opaque = 0;
        for (let i = 0; i < data.length; i += 1) {
          hash = Math.imul(hash ^ data[i]!, 0x01000193) >>> 0;
          if (i % 4 === 3 && data[i]! > 0) opaque += 1;
        }
        return { hash, opaque, width: canvas.width, height: canvas.height };
      });
    const before = await snapshot();
    await setTelopText(0, "描き直しの確認");
    const after = await snapshot();
    const paused = (await videoState()).paused;
    await setTelopText(0, TELOPS[0]!.text);
    record(
      "一時停止中に文言を変えるとプレビューが描き直される",
      paused && before.hash !== after.hash && after.opaque > 0,
      { before, after, paused },
    );
  });

  // --- シアターモードでのプレビューの位置 --------------------------------------
  await check("シアターモードでプレビューが動画に重なる", async () => {
    const rects = () =>
      page.evaluate(() => {
        const r = (el: Element | null) => {
          if (el === null) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        };
        return {
          video: r(document.querySelector("video.html5-main-video")),
          canvas: r(document.getElementById("yt-clip-telop-preview")),
        };
      });
    await seekPaused(61.5);
    const normal = await rects();
    await page.locator(".ytp-size-button").click();
    await page.waitForTimeout(1500);
    const theater = await rects();
    const file = join(OUT_DIR, "preview-theater-t1.png");
    await page.locator("#movie_player").screenshot({ path: file });
    await page.locator(".ytp-size-button").click();
    await page.waitForTimeout(1500);
    const same = (x: typeof theater) =>
      x.video !== null &&
      x.canvas !== null &&
      Math.abs(x.video.x - x.canvas.x) < 1 &&
      Math.abs(x.video.y - x.canvas.y) < 1 &&
      Math.abs(x.video.width - x.canvas.width) < 1 &&
      Math.abs(x.video.height - x.canvas.height) < 1;
    record(
      "シアターモードでプレビューが動画に重なる",
      same(normal) && same(theater) &&
        (theater.video?.width ?? 0) !== (normal.video?.width ?? 0),
      { normal, theater, file },
    );
  });

  // --- 1080p で録画 ------------------------------------------------------------
  await check("録画 1080: 出力の長さ = 区間の合計", () =>
    recordAndInspect("1080", 1080),
  );

  // --- 360p で録画 -------------------------------------------------------------
  await check("録画 360: 出力の長さ = 区間の合計", async () => {
    // YouTube の画質名は small = 240p、medium = 360p
    const height360 = await setQuality("medium", 360);
    record("画質 360p に切り替わった", height360 === 360, { videoHeight: height360 });
    const files = await previewShots("360");
    record("プレビューのスクリーンショット 360p", true, { files });
    await recordAndInspect("360", 360);
  });

  // --- テロップ付きの録画中にタブが隠れたら中断する ----------------------------
  await check("録画中にタブが隠れたら中断し、再試行で区間とテロップが残る", async () => {
    await waitNoAd();
    const clipBefore = await readLatestClip();
    await page.evaluate(() => {
      const log: string[] = [];
      (window as unknown as { __visLog: string[] }).__visLog = log;
      document.addEventListener("visibilitychange", () =>
        log.push(document.visibilityState),
      );
    });
    await button("● 録画").click();
    await page.waitForTimeout(1000);
    const other = await context.newPage();
    await other.bringToFront();
    await other.waitForTimeout(3000);
    await page.bringToFront();
    await other.close();
    const retry = button("再試行");
    await expect(retry.or(button("取り直す"))).toBeVisible({ timeout: 60_000 });
    const visLog = await page.evaluate(
      () => (window as unknown as { __visLog: string[] }).__visLog,
    );
    const statusText = (await status.textContent()) ?? "";
    const failedAsExpected = await retry.isVisible();
    const clipAfter = await readLatestClip();
    const screenshot = join(OUT_DIR, "tab-hidden-status.png");
    await page.screenshot({ path: screenshot });
    let segmentsAfter = -1;
    let telopTexts: string[] = [];
    if (failedAsExpected) {
      await retry.click();
      await expect(button("● 録画")).toBeVisible();
      segmentsAfter = await segmentRows.count();
      telopTexts = await telopRows.locator("textarea").evaluateAll((els) =>
        els.map((el) => (el as HTMLTextAreaElement).value),
      );
    } else {
      await button("取り直す").click();
    }
    record(
      "録画中にタブが隠れたら中断し、再試行で区間とテロップが残る",
      visLog.includes("hidden") &&
        failedAsExpected &&
        statusText === TAB_HIDDEN_MESSAGE &&
        clipAfter?.id === clipBefore?.id &&
        segmentsAfter === SEGMENTS.length &&
        JSON.stringify(telopTexts) === JSON.stringify(TELOPS.map((t) => t.text)),
      {
        visLog,
        statusText,
        failedAsExpected,
        newClipSaved: clipAfter?.id !== clipBefore?.id,
        segmentsAfter,
        telopTexts,
        screenshot,
      },
    );
  });

  // --- テロップなしの録画 ------------------------------------------------------
  await check("テロップなしの録画: 出力の長さ = 区間の合計", async () => {
    while ((await telopRows.count()) > 0) {
      const count = await telopRows.count();
      await telopRows.first().locator("[data-role=remove]").click();
      await expect(telopRows).toHaveCount(count - 1);
    }
    const { videoHeight } = await videoState();
    const { clip, status: text } = await recordClip();
    if (clip === null) {
      record("テロップなしの録画: 出力の長さ = 区間の合計", false, { status: text });
      await button("再試行").click();
      await expect(button("● 録画")).toBeVisible();
      return;
    }
    const file = await saveClip(clip, "clip-notelop.mp4");
    const info = probe(file);
    record(
      "テロップなしの録画: 出力の長さ = 区間の合計",
      Math.abs(info.durationSec - EXPECTED_SEC) <= TOLERANCE_SEC,
      { ...info, playerVideoHeight: videoHeight, mimeType: clip.mimeType, file },
    );
    await button("取り直す").click();
    await expect(button("● 録画")).toBeVisible();
  });

  // --- 最後の 1 区間の ✕ が止まる ----------------------------------------------
  await check("テロップが残っているとき最後の区間の ✕ が止まる", async () => {
    // テロップが無いので 2 つ目の区間は消せる
    await segmentRows.nth(1).locator("[data-role=remove]").click();
    await expect(segmentRows).toHaveCount(1);
    await seekPaused(TELOPS[0]!.startSec);
    await bar.locator("[data-role=add-telop]").click();
    await expect(telopRows).toHaveCount(1);
    await segmentRows.nth(0).locator("[data-role=remove]").click();
    await page.waitForTimeout(500);
    const statusText = (await status.textContent()) ?? "";
    const segmentsAfter = await segmentRows.count();
    record(
      "テロップが残っているとき最後の区間の ✕ が止まる",
      statusText === "テロップが 1 件残っています。先にテロップを消してください" &&
        segmentsAfter === 1,
      { statusText, segmentsAfter },
    );
  });

  // --- シンプルモードでは一覧が出ない ------------------------------------------
  await check("シンプルモードでテロップの一覧が出ない", async () => {
    await writeSettings({ mode: "simple" });
    await expect(bar.locator("[data-role=add-telop]")).toBeHidden({ timeout: 10_000 });
    const visible = await bar.locator("[data-role=add-telop]").isVisible();
    record("シンプルモードでテロップの一覧が出ない", !visible, { addTelopVisible: visible });
  });

  await writeResults();
  const failed = Object.entries(results)
    .filter(([, r]) => !r.pass)
    .map(([name]) => name);
  expect(failed).toEqual([]);
});
