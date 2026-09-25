import {
  chromium,
  type Browser,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Worker,
} from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorker as sharedGetWorker } from "./helpers";

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
/**
 * 受け入れ条件の確認 (1440x795) で足す 5 区間の頭。既定の長さ (15 秒) で重ならない
 * よう 30 秒ずつ離す。合計は上限 (60 秒) を超えるが、録画はしないので構わない
 */
const LAYOUT_SEGMENT_STARTS = [200, 230, 260, 290, 320];
/**
 * 受け入れ条件の確認で足す 5 つのテロップの頭 (フロートの窓の spec A.4 / B)。**後ろの 3 つは同じ時刻に
 * 重ねる**: 最後に足した区間 (320〜335) が拡大バーに選ばれていて、その窓 (312.5〜342.5) に 3 つが
 * 重なって入るので、帯の段が最大 (2 段 + 「+1」) になる。前の 2 つのうち 201 は帯の確認 (区間 1 を
 * 選び直して動かす) に使う。231 は区間 2 の中に置き、5 つの数を揃えるだけ
 */
const LAYOUT_TELOP_STARTS = [201, 231, 321, 321, 321];
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

/** e2e/helpers.ts の getWorker を、この場のモジュール変数 (context / extensionId) で呼ぶ (smoke.spec.ts と共有) */
function getWorker(): Promise<Worker> {
  return sharedGetWorker(context, extensionId);
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
  // 区間とテロップの一覧は区間・テロップの窓、設定は設定の窓にある (窓の分割の spec C1.1)。
  // バーには拡大バーと操作の行だけ
  const listWindow = page.locator("#yt-clip-list");
  const settingsWindow = page.locator("#yt-clip-settings");
  const segmentRows = listWindow.locator("[data-role=segment]");
  const telopRows = listWindow.locator("[data-role=telop]");

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
      await listWindow.locator("[data-role=add-telop]").click();
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
    await listWindow.locator("[data-role=add-telop]").click();
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
        // ドック枠の差す先 (窓の分割の spec C2.1)。#below の上の余白と右の列の幅の出所。人が読んで dock.ts に書き写す
        below: box("#below"),
        secondaryInner: box("#secondary-inner"),
        player: box("#movie_player"),
        theater: document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? null,
      };
    });
    // 値そのものは人が読んで panel-window.ts のコメントに書き写す。ここでは読めたかだけ見る
    record(
      "窓の位置の出所 (YouTube の実測)",
      measured.masthead !== null &&
        measured.secondary !== null &&
        measured.list !== null &&
        measured.below !== null &&
        measured.secondaryInner !== null,
      measured,
    );
  });

  // --- シンプルモードでは一覧が出ない ------------------------------------------
  await check("シンプルモードでテロップの一覧が出ない", async () => {
    await writeSettings({ mode: "simple" });
    const addTelop = listWindow.locator("[data-role=add-telop]");
    // **有ることを先に確かめる。** toBeHidden は見つからない要素でも通るので、
    // 探す場所を間違えていても素通りしてしまう
    await expect(addTelop).toHaveCount(1, { timeout: 10_000 });
    await expect(addTelop).toBeHidden({ timeout: 10_000 });
    const count = await addTelop.count();
    const visible = await addTelop.isVisible();
    record("シンプルモードでテロップの一覧が出ない", count === 1 && !visible, {
      addTelopCount: count,
      addTelopVisible: visible,
    });
  });

  /**
   * 拡張が覚えた窓の位置 (何も覚えていなければ null)。受け入れ条件の記録にも使うので、
   * その検査より前に置く
   */
  async function readWindowLayout(): Promise<Record<string, unknown> | null> {
    const worker = await getWorker();
    return worker.evaluate(async () => {
      const stored = await chrome.storage.local.get("windowLayout");
      return (stored.windowLayout as Record<string, unknown> | undefined) ?? null;
    });
  }

  // --- 受け入れ条件 (窓の分割の spec C2.10。フロートの窓の spec A.4・C1.5 を最初の配置 (ドック) で測る): 1440x795 で、
  // 覚えた配置が無いとき、バーは下の枠 (#below の先頭) に入ってページの先頭で画面に収まり、区間・テロップと設定は
  // 右の枠 (#secondary-inner の先頭) にタブで入ってプレイヤーに重ならない ---------------------------------------------
  // 1920x1080 の確認がすべて済んでから切り替え、最後に戻す
  const ACCEPTANCE_1440 =
    "受け入れ条件 1440x795: 最初の配置 (ドック) のまま帯の段が最大 (2 段 + 「+N」) で設定を開いても、下の枠のバーがプレイヤーの下で画面に収まり、右の枠の区間・テロップと設定がプレイヤーに重ならない";
  await check(ACCEPTANCE_1440, async () => {
    // 前提を自分で作る: 覚えた配置を消して読み込み直す (最初の配置になる)。区間はまだ無い (直前の項目でシンプルに
    // 切り替えた) ので reloadAndWaitList は使わない
    const worker = await getWorker();
    await worker.evaluate(() => chrome.storage.local.remove("windowLayout"));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await expect(bar).toBeVisible({ timeout: 60_000 });
      await waitNoAd();
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
      // 設定も開く (右の枠で設定のタブが前に出る)
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
        const player = document.getElementById("movie_player");
        const below = document.getElementById("yt-clip-dock-below");
        const side = document.getElementById("yt-clip-dock-side");
        if (player === null || below === null || side === null) {
          throw new Error("プレイヤーかドック枠がありません");
        }
        const p = player.getBoundingClientRect();
        const inSlot = (slot: HTMLElement, id: string) => {
          const element = document.getElementById(id);
          return element !== null && slot.contains(element);
        };
        const belowTabs = below.querySelector<HTMLElement>("[data-role=dock-tabs]");
        const sideTabs = [...side.querySelectorAll<HTMLElement>("[data-role=dock-tab]")].filter(
          (tab) => getComputedStyle(tab).display !== "none",
        );
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          // **枠の外形で測る。** 中身の根 (#yt-clip-bar) ではない (spec A.4 / C2.10)
          below: rect("yt-clip-dock-below"),
          side: rect("yt-clip-dock-side"),
          barInBelow: inSlot(below, "yt-clip-bar-window"),
          belowFirst: below.parentElement?.id === "below" && below.parentElement.firstElementChild === below,
          belowTabsShown: belowTabs !== null && getComputedStyle(belowTabs).display !== "none",
          listInSide: inSlot(side, "yt-clip-list"),
          settingsInSide: inSlot(side, "yt-clip-settings"),
          sideFirst:
            side.parentElement?.id === "secondary-inner" && side.parentElement.firstElementChild === side,
          sideLabels: sideTabs.map((tab) => tab.textContent ?? ""),
          sideActive: sideTabs.find((tab) => tab.dataset.active === "true")?.textContent ?? null,
          playerBottom: p.bottom,
          playerRight: p.right,
          mastheadBottom:
            document.getElementById("masthead-container")?.getBoundingClientRect().bottom ?? null,
          // C2.10 の予算の出所 (#below の上の余白) と C2.5 の右の列の幅 (1440x795)。人が読んで dock.ts に書き写す
          belowTop: document.getElementById("below")?.getBoundingClientRect().top ?? null,
          secondaryInnerWidth:
            document.getElementById("secondary-inner")?.getBoundingClientRect().width ?? null,
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
      // **記録だけ (合否には入れない)。** 落ちたときに、覚えた配置が本当に消えていたか (最初の配置か) を後から読めるようにする
      const windowLayout = await readWindowLayout().catch((error: unknown) => ({
        error: String(error),
      }));
      const file = join(OUT_DIR, "layout-1440x795.png");
      await page.screenshot({ path: file });
      record(
        ACCEPTANCE_1440,
        measured.scrollY === 0 &&
          measured.barInBelow &&
          measured.belowFirst &&
          !measured.belowTabsShown &&
          measured.playerBottom <= measured.below.top &&
          measured.below.bottom <= measured.innerHeight &&
          measured.listInSide &&
          measured.settingsInSide &&
          measured.sideFirst &&
          measured.side.left >= measured.playerRight &&
          measured.side.top >= (measured.mastheadBottom ?? Number.POSITIVE_INFINITY) &&
          JSON.stringify(measured.sideLabels) === JSON.stringify(["区間・テロップ", "設定"]) &&
          measured.sideActive === "設定" &&
          measured.telopBands === 2 &&
          measured.telopLanes === 2 &&
          measured.telopOverflow === "+1",
        {
          ...measured,
          belowGap: measured.belowTop === null ? null : measured.belowTop - measured.playerBottom,
          windowLayout,
          file,
        },
      );
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });

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

  /**
   * 点 at の当たり判定が、ページの要素に届くようになるまで待つ。**読み込み直した直後の 1〜2 秒は、窓の上を押しても
   * 当たり判定が根 (html) にしか当たらない** (実機で、⠿ の箱の中の点の elementsFromPoint が [html] だけを返し、
   * pointerdown も html に届いた。300ms ほど待つと ⠿ に当たる)。page.mouse は locator の操作と違って当たるまで
   * 待たないので、押す前にここで待つ。押す点はいつも yt-clip の要素 (⠿・見出し・タブ・つまみ) の上
   */
  async function waitForHitTest(at: { x: number; y: number }): Promise<void> {
    await page.waitForFunction(
      (point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && hit !== document.documentElement;
      },
      at,
      { timeout: 10_000 },
    );
  }

  /** from を押して to まで動かして離す。途中も刻んで動かし、pointermove を届ける */
  async function dragFromTo(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> {
    await waitForHitTest(from);
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

  /**
   * ⚙ を押す前にバーの窓を前に出す。⚙ はバーの右端にあり、区間・テロップの窓や設定の窓を
   * 動かした後は同じ座標に重なりうる (触った順で重なり順が決まるため、⚙ の上に他の窓が乗ると
   * click が塞がれて 30 秒 timeout する。実機の確認で実際に踏んだ)。grip は左端にあり他の窓と
   * 重ならないので、押して離すだけ (位置は変わらず覚え直しもしない) で確実にバーを前に出せる
   * (「右下をドラッグ…」の項目が元から使っていた idiom)
   */
  async function bringBarToFront(): Promise<void> {
    await barGrip.click();
  }

  /**
   * 設定が開いているか。**窓が見えているかでは判定しない**: ドック中で後ろのタブにいる設定の窓は、開いているが
   * 見えない (枠の中の箱が隠れている)。開閉は窓の hidden (出す条件) で見る (窓の分割の spec C2.8)
   */
  async function isSettingsOpen(): Promise<boolean> {
    return settingsWindow.evaluate((element) => !(element as HTMLElement).hidden);
  }

  /**
   * 設定の窓が閉じていれば ⚙ を押して開く。**既に開いていれば何もしない**
   * (トグルを盲目的に押すと、開いているつもりで押して閉じてしまう)。押す前にバーを前に出すので、
   * 他の窓が ⚙ の上に重なっていても掴める
   */
  async function openSettings(): Promise<void> {
    if (await isSettingsOpen()) return;
    await bringBarToFront();
    await button("⚙").click();
    await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
  }

  /** 設定の窓が開いていれば ⚙ を押して閉じる。既に閉じていれば何もしない */
  async function closeSettings(): Promise<void> {
    if (!(await isSettingsOpen())) return;
    await bringBarToFront();
    await button("⚙").click();
    await expect(settingsWindow).toBeHidden({ timeout: 10_000 });
  }

  // --- ドック枠の確認のヘルパ (窓の分割の spec C2) ---------------------------------------------------------------
  type Point = { x: number; y: number };
  const belowSlot = page.locator("#yt-clip-dock-below");
  const sideSlot = page.locator("#yt-clip-dock-side");
  /** 3 つとも浮いた窓 (最初の位置) の配置。浮いた窓の確認の前提に使う (判断メモ 34) */
  const FLOAT_LAYOUT = { version: 2, float: {}, docks: {} };

  /** 枠の中の、文言が label のタブ */
  const tabIn = (slot: Locator, label: string) =>
    slot.locator("[data-role=dock-tab]", { hasText: label });
  /** 覚えた配置の docks (v2 でなければ null) */
  const docksOf = (saved: Record<string, unknown> | null): Record<string, unknown> | null =>
    saved !== null && saved.version === 2 && typeof saved.docks === "object" && saved.docks !== null
      ? (saved.docks as Record<string, unknown>)
      : null;
  /**
   * 鍵の順を揃えた JSON (配列の順は残す)。**chrome.storage.local から読んだ値は鍵が名前順に並び替わって返る**
   * (実機で `{ tabs, active }` と書いたものが `{ active, tabs }` で返った)。鍵の順で食い違わないようにする
   */
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  const sameJson = (a: unknown, b: unknown) =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

  /** 覚えた配置を書いてから読み込み直す (前提を作る。区間 5 つが残っていることが要る) */
  async function setLayoutAndReload(layout: Record<string, unknown>): Promise<void> {
    const worker = await getWorker();
    await worker.evaluate((value) => chrome.storage.local.set({ windowLayout: value }), layout);
    await reloadAndWaitList();
  }

  /** 覚えた配置を消してから読み込み直す (最初の配置 = ドックになる) */
  async function resetLayoutAndReload(): Promise<void> {
    const worker = await getWorker();
    await worker.evaluate(() => chrome.storage.local.remove("windowLayout"));
    await reloadAndWaitList();
  }

  /**
   * from で押し、detour を通ってから slot の落とし先の帯の中心で離す。**帯へは一度その外から入れる** (始めたときに
   * 帯の中にあった指は、一度出るまで当たらない。C2.3)。**帯はドラッグを始めた後で測る** (隠れている枠の目印は、
   * ドラッグの間だけページの流れに出る)
   */
  async function dropInto(from: Point, detour: Point, slot: Locator): Promise<void> {
    await waitForHitTest(from);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(detour.x, detour.y, { steps: 8 });
    const band = centerOf(await boxOf(slot.locator("[data-drop-target=true]")));
    await page.mouse.move(band.x, band.y, { steps: 8 });
    await page.mouse.up();
    // 覚える (chrome.storage.local への保存) のは指を離した後に非同期で走る
    await page.waitForTimeout(500);
  }

  /** 枠の様子: 差した先・先頭か・箱・タブの列が出ているか・出ているタブの文言と前のタブ・中の窓 */
  async function slotState(slot: "below" | "side") {
    return page.evaluate((id) => {
      const root = document.getElementById(`yt-clip-dock-${id}`);
      if (root === null) return null;
      const b = root.getBoundingClientRect();
      const row = root.querySelector<HTMLElement>("[data-role=dock-tabs]");
      const tabs = [...root.querySelectorAll<HTMLElement>("[data-role=dock-tab]")].filter(
        (tab) => getComputedStyle(tab).display !== "none",
      );
      return {
        shown: getComputedStyle(root).display !== "none",
        parentId: root.parentElement?.id ?? null,
        first: root.parentElement?.firstElementChild === root,
        box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
        tabsShown: row !== null && getComputedStyle(row).display !== "none",
        labels: tabs.map((tab) => tab.textContent ?? ""),
        active: tabs.find((tab) => tab.dataset.active === "true")?.textContent ?? null,
        windows: ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].filter((windowId) => {
          const element = document.getElementById(windowId);
          return element !== null && root.contains(element);
        }),
      };
    }, slot);
  }

  /** プレイヤー・ヘッダー・差す先の箱と、シアターモードか (C2.1 の余白・C2.5 の幅の出所) */
  async function pageBoxes() {
    return page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const b = element.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width };
      };
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollY: window.scrollY,
        player: box("#movie_player"),
        masthead: box("#masthead-container"),
        below: box("#below"),
        secondary: box("#secondary"),
        secondaryInner: box("#secondary-inner"),
        theater: document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? null,
      };
    });
  }

  /** 3 つの窓がどれも body の直下 (浮いた窓) か */
  async function allFloating(): Promise<boolean> {
    return page.evaluate(() =>
      ["yt-clip-bar-window", "yt-clip-list", "yt-clip-settings"].every(
        (id) => document.getElementById(id)?.parentElement === document.body,
      ),
    );
  }

  await check("⚙ で設定が別の窓に開閉し、区間・テロップの窓はそのまま", async () => {
    // 前提: 3 つとも浮いた窓の最初の位置 (最初の配置はドックなので、覚えた配置を枠なしにして読み込み直す。判断メモ 34)
    await setLayoutAndReload(FLOAT_LAYOUT);
    await page.evaluate(() => window.scrollTo(0, 0));
    // 前提を自分で作る (前の項目の終わり方に依存しない)。受け入れ条件の確認で開いたまま
    // 終わっているはずだが、閉じていれば開く。どちらの窓もまだ動かしていない (1920x1080 の最初の位置)
    await openSettings();
    const listOpen = await boxOf(listWindow);
    const settingsOpen = await boxOf(settingsWindow);

    await bringBarToFront();
    await button("⚙").click();
    await expect(settingsWindow).toBeHidden({ timeout: 10_000 });
    const listClosed = await boxOf(listWindow);

    await bringBarToFront();
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
    // 前提: 3 つとも浮いた窓の最初の位置 (最初の配置はドックなので、覚えた配置を枠なしにして読み込み直す。判断メモ 34)
    await setLayoutAndReload(FLOAT_LAYOUT);
    await page.evaluate(() => window.scrollTo(0, 0));
    // 前提を自分で作る。設定の窓を動かすので開いていることが要る (直前の項目で開いたままの
    // はずだが、閉じていれば開く)。設定の窓は区間・テロップの窓に下へ 32px ずれて重なり、前に出ている
    await openSettings();
    const barStart = await boxOf(barWindow);
    const listStart = await boxOf(listWindow);
    const settingsStart = await boxOf(settingsWindow);

    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: grip.x + 80, y: grip.y + 40 });
    // 設定の窓を先に動かす。下へ 80px 送り、区間・テロップの窓の見出しの行 (上の 32px) から離す
    const settingsAt = headerPoint(await boxOf(settingsHeader));
    await dragFromTo(settingsAt, { x: settingsAt.x - 200, y: settingsAt.y + 80 });
    // 区間・テロップの窓の見出しは、設定の窓の上に出ている (カスケード)。プレイヤーの上まで左へ動かし、右の枠の帯の外で離す
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 200, y: listAt.y + 40 });
    const barMoved = await boxOf(barWindow);
    const listMoved = await boxOf(listWindow);
    const settingsMoved = await boxOf(settingsWindow);
    const saved = await readWindowLayout();

    await reloadAndWaitList();
    const barAfter = await boxOf(barWindow);
    const listAfter = await boxOf(listWindow);
    // 設定の開閉は覚えない (読み込み直すと閉じている)。⚙ で開いて、覚えた位置に出るかを見る。
    // 覚えた位置はバーの ⚙ に重なりうるので、openSettings がバーを前に出してから押す
    await openSettings();
    const settingsAfter = await boxOf(settingsWindow);
    // 後の項目は設定を閉じた状態から始める (設定の窓が区間・テロップの窓の右下の角を覆わないように)
    await closeSettings();

    const float = floatOf(saved);
    record(
      "窓を動かすと、読み込み直しても同じ位置に出る",
      near(barMoved.x, barStart.x + 80) &&
        near(barMoved.y, barStart.y + 40) &&
        near(listMoved.x, listStart.x - 200) &&
        near(listMoved.y, listStart.y + 40) &&
        near(settingsMoved.x, settingsStart.x - 200) &&
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
    // 前提: 3 つとも浮いた窓の最初の位置 (最初の配置はドックなので、覚えた配置を枠なしにして読み込み直す。判断メモ 34)
    await setLayoutAndReload(FLOAT_LAYOUT);
    // 前提を自分で作る。設定の窓は区間・テロップの窓と同じ幅で (0, +32) に重なるので、開いたまま
    // だと区間・テロップの窓の右下のつまみを覆ってドラッグが届かない (C1.3 のカスケードの帰結)。
    // 閉じてから大きさを変える
    await closeSettings();
    // バーの窓を上にしておく (右下の角が区間・テロップの窓の下に潜っていても掴めるように)。
    // 押して離すだけなので、位置は変わらず覚え直しもしない
    await bringBarToFront();
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
    // 前提: 3 つとも浮いた窓の最初の位置 (最初の配置はドックなので、覚えた配置を枠なしにして読み込み直す。判断メモ 34)
    await setLayoutAndReload(FLOAT_LAYOUT);
    // 前提を自分で作る (前の項目の終わり方に依存しない)。設定の窓が開いていると区間・テロップの
    // 窓の見出しに重なりうる
    await closeSettings();
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

  await check("掴む場所をダブルクリックすると最初の配置の枠 (ドック) に戻り、覚えた位置も消える", async () => {
    // 前提: 3 つとも浮いた窓にして、どれも動かしておく (どの帯の外で離す)
    await setLayoutAndReload(FLOAT_LAYOUT);
    await page.evaluate(() => window.scrollTo(0, 0));
    await closeSettings();
    const grip = centerOf(await boxOf(barGrip));
    await dragFromTo(grip, { x: grip.x + 80, y: grip.y + 40 });
    const listAt = headerPoint(await boxOf(listHeader));
    await dragFromTo(listAt, { x: listAt.x - 200, y: listAt.y + 40 });
    await openSettings();
    const settingsAt = headerPoint(await boxOf(settingsHeader));
    await dragFromTo(settingsAt, { x: settingsAt.x - 200, y: settingsAt.y + 160 });
    const savedMoved = await readWindowLayout();

    await barGrip.dblclick();
    const listHeaderBox = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: listHeaderBox.height / 2 } });
    const settingsHeaderBox = await boxOf(settingsHeader);
    await settingsHeader.dblclick({ position: { x: 40, y: settingsHeaderBox.height / 2 } });
    await page.waitForTimeout(500);
    const below = await slotState("below");
    const side = await slotState("side");
    const saved = await readWindowLayout();
    // 後の項目 (帯) は区間・テロップの窓の行を押す。設定は閉じておく (右の枠では区間・テロップのタブが前に出る)
    await closeSettings();

    const movedFloat = floatOf(savedMoved);
    const float = floatOf(saved);
    record(
      "掴む場所をダブルクリックすると最初の配置の枠 (ドック) に戻り、覚えた位置も消える",
      movedFloat !== null &&
        Object.keys(movedFloat).length === 3 &&
        below !== null &&
        below.windows.includes("yt-clip-bar-window") &&
        side !== null &&
        side.windows.includes("yt-clip-list") &&
        side.windows.includes("yt-clip-settings") &&
        sameJson(side.labels, ["区間・テロップ", "設定"]) &&
        side.active === "設定" &&
        float !== null &&
        Object.keys(float).length === 0 &&
        sameJson(docksOf(saved), {
          below: { tabs: ["bar"], active: "bar" },
          side: { tabs: ["list", "settings"], active: "settings" },
        }),
      { savedMoved, below, side, saved },
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

    // 後の項目 (帯) のために最初の配置 (右の枠) へ戻す。戻すと v2 の組で書かれる。バーと設定は v1 に位置が無いので最初から枠の中
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

  // --- 拡大バー上のテロップの帯 (フロートの窓の spec B.4) ---------------------------------
  // 窓の確認の後 (3 つの窓は最初の配置の枠に入り、設定は閉じている)。受け入れ条件の確認で足した区間 5 つと
  // テロップ 5 つ (201・231・321×3) が残っている。区間 1 (200〜215) を選び直すと拡大バーの窓は
  // 192.5〜222.5 になり、テロップ 1 (201〜204) だけが帯で出る (ほかの帯と重ならない)
  type TelopTimes = { startSec: number; endSec: number; text: string };

  /** 状態機械が持つテロップ (service worker が chrome.storage.session に置く写し。sw.ts の SESSION_KEY) */
  async function readTelops(): Promise<TelopTimes[]> {
    const worker = await getWorker();
    return worker.evaluate(async () => {
      const stored = await chrome.storage.session.get("router-snapshot");
      const snapshot = stored["router-snapshot"] as
        | { state?: { telops?: { startSec: number; endSec: number; text: string }[] } }
        | undefined;
      return snapshot?.state?.telops ?? [];
    });
  }

  async function firstTelop(): Promise<TelopTimes> {
    const telop = (await readTelops())[0];
    if (telop === undefined) throw new Error("テロップ 1 がありません");
    return telop;
  }

  /**
   * テロップ 1 の時刻が before から変わるまで待って返す (10 秒で諦めて、その時点の値を返す。合否は
   * 呼び出し側の record が決める)。**dragFromTo の末尾の 500ms は窓の位置の保存 (chrome.storage.local)
   * を待つためのもの**で、帯の UPDATE_TELOP が状態機械に届いて chrome.storage.session に保存される
   * までを待つ保証にはならない。遅い環境で古い値を読まないよう、変わるまで読み直す
   */
  async function waitTelopChanged(before: TelopTimes): Promise<TelopTimes> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const now = await firstTelop();
      if (now.startSec !== before.startSec || now.endSec !== before.endSec) return now;
      if (Date.now() > deadline) return now;
      await page.waitForTimeout(200);
    }
  }

  /** m:ss (拡大バー・一覧と同じ書き方。この動画は 1 時間未満) */
  const clock = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  const firstBand = bar.locator("[data-role=telop-band][data-index='0']");

  await check("帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    // 区間 1 を選ぶ。行の左の文字 (区間の時刻) を押す。右の ▶ / ✕ を押すと再生・削除になる
    await segmentRows.nth(0).locator("span").first().click();
    await expect(firstBand).toBeVisible({ timeout: 10_000 });
    // 帯のドラッグ中のシークは video.currentTime への直接の書き込み (拡大バーのハンドルと同じ onScrub)。
    // 直前の項目でページを読み込み直しているので、読み込んでいない位置へ直接飛ぶと YouTube のプレイヤーが
    // 止まりうる (seekPaused のコメント)。先にプレイヤーの seekTo で近くを読み込ませておく
    await seekPaused(201);
    const before = await firstTelop();
    const box = await boxOf(firstBand);
    const from = centerOf(box);
    // 帯の段は約 1180px で 30 秒 (約 39px/秒)。60px で 1.5 秒ほど後ろへ
    await dragFromTo(from, { x: from.x + 60, y: from.y });
    const after = await waitTelopChanged(before);
    // 一覧の行の文言も状態の通知で描き直される。変わるまで待ってから読む (待ちきれなくても合否は record で見る)
    await expect(telopRows.nth(0))
      .toContainText(`${clock(after.startSec)} 〜 ${clock(after.endSec)}`, { timeout: 10_000 })
      .catch(() => undefined);
    const label = (await telopRows.nth(0).textContent()) ?? "";
    record(
      "帯の中をドラッグすると長さを保って動き、一覧の時刻も変わる",
      after.startSec > before.startSec + 0.5 &&
        Math.abs(after.endSec - after.startSec - (before.endSec - before.startSec)) < 0.01 &&
        label.includes(`${clock(after.startSec)} 〜 ${clock(after.endSec)}`),
      { before, after, label, box },
    );
  });

  await check("帯の端をドラッグすると開始 / 終了だけが変わる", async () => {
    const before = await firstTelop();
    // 右端。端として掴めるのは min(6px, 帯の幅の 1/3)。端から 2px の所を掴む
    const endBox = await boxOf(firstBand);
    const endAt = { x: endBox.x + endBox.width - 2, y: endBox.y + endBox.height / 2 };
    await dragFromTo(endAt, { x: endAt.x + 60, y: endAt.y });
    const afterEnd = await waitTelopChanged(before);
    // 左端
    const startBox = await boxOf(firstBand);
    const startAt = { x: startBox.x + 2, y: startBox.y + startBox.height / 2 };
    await dragFromTo(startAt, { x: startAt.x - 40, y: startAt.y });
    const afterStart = await waitTelopChanged(afterEnd);
    record(
      "帯の端をドラッグすると開始 / 終了だけが変わる",
      afterEnd.startSec === before.startSec &&
        afterEnd.endSec > before.endSec + 0.5 &&
        afterStart.endSec === afterEnd.endSec &&
        afterStart.startSec < afterEnd.startSec - 0.5,
      { before, afterEnd, afterStart, endBox, startBox },
    );
  });

  await check("帯を押して離すと、そのテロップの頭から再生する", async () => {
    const telop = await firstTelop();
    // テロップから離れた位置で止めておく (再生が始まった場所で、頭から再生したことを見分ける)
    await seekPaused(212);
    await firstBand.click();
    await page.waitForTimeout(1000);
    const played = await videoState();
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.pause(),
    );
    record(
      "帯を押して離すと、そのテロップの頭から再生する",
      !played.paused &&
        played.currentTime >= telop.startSec - 0.1 &&
        played.currentTime < telop.startSec + 3,
      { telop, ...played },
    );
  });

  // --- ドック枠とタブ (窓の分割の spec C2.10) ---------------------------------------------------------------
  // 帯の確認の後 (末尾) に行う。受け入れ条件の確認で足した区間 5 つ・テロップ 5 つが残っている。**各項目は前提 (覚えた
  // 配置・設定の開閉・画面の大きさ) を自分で作る**: 覚えた配置を書いて (消して) から読み込み直す
  const DOCK_NO_SUCK =
    "ドック: 浮いた窓を少し動かしてもドックされない (見出しを 20px 下・⠿ を 20px 右。1440x795)";
  await check(DOCK_NO_SUCK, async () => {
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await setLayoutAndReload(FLOAT_LAYOUT);
      await page.evaluate(() => window.scrollTo(0, 0));
      // 受け入れ条件と同じく設定も開く (浮いた設定の窓は一覧の窓の下へ 32px ずれて前に出る。一覧の見出しは見えている)
      await openSettings();
      const floatingBefore = await allFloating();
      // 見出しの上端から 4px の点 (帯の外から始まる、最も吸い込まれやすい経路。C2.10)
      const header = await boxOf(listHeader);
      const headerFrom = { x: header.x + 40, y: header.y + 4 };
      await dragFromTo(headerFrom, { x: headerFrom.x, y: headerFrom.y + 20 });
      const grip = centerOf(await boxOf(barGrip));
      await dragFromTo(grip, { x: grip.x + 20, y: grip.y });
      const floatingAfter = await allFloating();
      const saved = await readWindowLayout();
      const boxes = await pageBoxes();
      record(DOCK_NO_SUCK, floatingBefore && floatingAfter && sameJson(docksOf(saved), {}), {
        floatingBefore,
        floatingAfter,
        saved,
        headerFrom,
        grip,
        boxes,
      });
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });

  const DOCK_BAR_BELOW =
    "ドック: 浮いたバーを下の枠に落とすと #below の先頭に入り、ページの先頭でプレイヤーの下に画面に収まる。読み込み直しても入ったまま、⠿ で引き出してダブルクリックすると下の枠に戻る (1440x795)";
  await check(DOCK_BAR_BELOW, async () => {
    await page.setViewportSize({ width: 1440, height: 795 });
    try {
      await setLayoutAndReload(FLOAT_LAYOUT);
      await closeSettings();
      await page.evaluate(() => window.scrollTo(0, 0));
      // ⠿ をプレイヤーの中 (上方向) へ外してから (どの帯の外。下の枠の目印は #below の幅いっぱいなので、横へ動かすだけ
      // では帯を出られない位置から始まることがある。判断メモ 39)、プレイヤーの直下の目印 (#below の先頭) へ
      const grip = centerOf(await boxOf(barGrip));
      const player = await boxOf(page.locator("#movie_player"));
      await dropInto(grip, { x: grip.x, y: player.y + player.height / 2 }, belowSlot);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const docked = await slotState("below");
      const boxes = await pageBoxes();
      const saved = await readWindowLayout();
      const file = join(OUT_DIR, "dock-bar-below-1440x795.png");
      await page.screenshot({ path: file });

      await reloadAndWaitList();
      await page.evaluate(() => window.scrollTo(0, 0));
      const afterReload = await slotState("below");

      // ⠿ で引き出してプレイヤーの上に置き、⠿ をダブルクリックすると下の枠 (最初の配置) に戻る
      const dockedGrip = centerOf(await boxOf(barGrip));
      await dragFromTo(dockedGrip, { x: dockedGrip.x + 100, y: player.y + player.height / 2 });
      const pulled = await page.evaluate(
        () => document.getElementById("yt-clip-bar-window")?.parentElement === document.body,
      );
      await barGrip.dblclick();
      await page.waitForTimeout(500);
      const reset = await slotState("below");
      const savedAfterReset = await readWindowLayout();

      const playerBottom = boxes.player?.bottom ?? Number.POSITIVE_INFINITY;
      record(
        DOCK_BAR_BELOW,
        docked !== null &&
          boxes.scrollY === 0 &&
          docked.parentId === "below" &&
          docked.first &&
          docked.windows.includes("yt-clip-bar-window") &&
          !docked.tabsShown &&
          playerBottom <= docked.box.top &&
          docked.box.bottom <= boxes.innerHeight &&
          sameJson(docksOf(saved), { below: { tabs: ["bar"], active: "bar" } }) &&
          afterReload !== null &&
          afterReload.windows.includes("yt-clip-bar-window") &&
          pulled &&
          reset !== null &&
          reset.windows.includes("yt-clip-bar-window") &&
          sameJson(docksOf(savedAfterReset), { below: { tabs: ["bar"], active: "bar" } }) &&
          !("bar" in (floatOf(savedAfterReset) ?? { bar: true })),
        {
          docked,
          boxes,
          belowGap:
            boxes.below !== null && boxes.player !== null
              ? boxes.below.top - boxes.player.bottom
              : null,
          saved,
          afterReload,
          pulled,
          reset,
          savedAfterReset,
          file,
        },
      );
    } finally {
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  });

  const DOCK_SIDE_TABS =
    "ドック: 浮いた区間・テロップの窓と設定の窓を右の枠に落とすとタブが 2 つ並び、後から落とした方が前。⚙ とタブで切り替わり、読み込み直しても並びが同じ";
  await check(DOCK_SIDE_TABS, async () => {
    await setLayoutAndReload(FLOAT_LAYOUT);
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    // プレイヤーの上はどの帯の外
    const detour = centerOf(await boxOf(page.locator("#movie_player")));
    await dropInto(headerPoint(await boxOf(listHeader)), detour, sideSlot);
    // 設定は浮いた窓で開く (最初の位置)。見出しを右の枠のタブの列へ
    await openSettings();
    await dropInto(headerPoint(await boxOf(settingsHeader)), detour, sideSlot);
    const docked = await slotState("side");
    const boxes = await pageBoxes();
    const shown = { list: await listWindow.isVisible(), settings: await settingsWindow.isVisible() };

    // ⚙ で閉じると設定のタブが消え、もう一度押すと設定のタブが前に出る
    await closeSettings();
    const closed = await slotState("side");
    await openSettings();
    const reopened = await slotState("side");
    // 区間・テロップのタブを押すと一覧が出て設定が隠れる
    await tabIn(sideSlot, "区間・テロップ").click();
    await page.waitForTimeout(500);
    const listFront = {
      state: await slotState("side"),
      list: await listWindow.isVisible(),
      settings: await settingsWindow.isVisible(),
    };
    const saved = await readWindowLayout();

    // 読み込み直しても並びが同じ。設定の開閉は覚えないので、読み込み直した直後は一覧のタブだけ。⚙ で開いて並びを見る
    await reloadAndWaitList();
    const afterReload = await slotState("side");
    await openSettings();
    const afterReloadOpened = await slotState("side");
    await closeSettings();

    const mastheadBottom = boxes.masthead?.bottom ?? Number.POSITIVE_INFINITY;
    const playerRight = boxes.player?.right ?? Number.POSITIVE_INFINITY;
    record(
      DOCK_SIDE_TABS,
      docked !== null &&
        docked.parentId === "secondary-inner" &&
        docked.first &&
        docked.box.left >= playerRight &&
        docked.box.top >= mastheadBottom &&
        sameJson(docked.labels, ["区間・テロップ", "設定"]) &&
        docked.active === "設定" &&
        !shown.list &&
        shown.settings &&
        closed !== null &&
        sameJson(closed.labels, ["区間・テロップ"]) &&
        reopened !== null &&
        reopened.active === "設定" &&
        listFront.state !== null &&
        listFront.state.active === "区間・テロップ" &&
        listFront.list &&
        !listFront.settings &&
        sameJson(docksOf(saved), { side: { tabs: ["list", "settings"], active: "list" } }) &&
        afterReload !== null &&
        sameJson(afterReload.labels, ["区間・テロップ"]) &&
        afterReloadOpened !== null &&
        sameJson(afterReloadOpened.labels, ["区間・テロップ", "設定"]),
      { docked, boxes, shown, closed, reopened, listFront, saved, afterReload, afterReloadOpened },
    );
  });

  const DOCK_TAB_TO_BELOW =
    "ドック: 最初の配置から区間・テロップのタブを下の枠 (バーの上の目印) へ落とすと、下の枠にタブが 2 つ (バー / 区間・テロップ) 出て、右の枠は設定だけになる。タブを押すと切り替わる";
  await check(DOCK_TAB_TO_BELOW, async () => {
    // 前提: 最初の配置 (下の枠 [bar] / 右の枠 [list, settings])
    await resetLayoutAndReload();
    // 設定を開く (右の枠で設定のタブが前に出る)。バーは下の枠にバーだけで入っていて、⚙ が見えている
    await openSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const detour = centerOf(await boxOf(page.locator("#movie_player")));
    await dropInto(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), detour, belowSlot);
    const below = await slotState("below");
    const side = await slotState("side");
    // バーのタブを押すとバーが出て、一覧が隠れる
    await tabIn(belowSlot, "バー").click();
    await page.waitForTimeout(500);
    const barFront = {
      state: await slotState("below"),
      bar: await barWindow.isVisible(),
      list: await listWindow.isVisible(),
    };
    const saved = await readWindowLayout();
    record(
      DOCK_TAB_TO_BELOW,
      below !== null &&
        sameJson(below.labels, ["バー", "区間・テロップ"]) &&
        below.active === "区間・テロップ" &&
        side !== null &&
        sameJson(side.labels, ["設定"]) &&
        barFront.state !== null &&
        barFront.state.active === "バー" &&
        barFront.bar &&
        !barFront.list &&
        sameJson(docksOf(saved), {
          below: { tabs: ["bar", "list"], active: "bar" },
          side: { tabs: ["settings"], active: "settings" },
        }),
      { below, side, barFront, saved },
    );
  });

  const DOCK_PULL_OUT =
    "ドック: 最初の配置からタブを枠の外 (プレイヤーの上) へ引き出して離すとフロートになり、見出しのダブルクリックで右の枠 (最初の配置) に戻る。引き出してから右の枠の帯へ落としても戻る";
  await check(DOCK_PULL_OUT, async () => {
    await resetLayoutAndReload();
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const target = centerOf(await boxOf(page.locator("#movie_player")));
    await dragFromTo(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), target);
    const pulled = {
      floating: await page.evaluate(
        () => document.getElementById("yt-clip-list")?.parentElement === document.body,
      ),
      side: await slotState("side"),
    };
    const savedPulled = await readWindowLayout();

    // 浮いた窓の見出しをダブルクリックすると最初の配置 (右の枠) に戻り、覚えた位置も消える
    const header = await boxOf(listHeader);
    await listHeader.dblclick({ position: { x: 40, y: header.height / 2 } });
    await page.waitForTimeout(500);
    const reset = await slotState("side");
    const savedReset = await readWindowLayout();

    // 設定を開いて右の枠にタブの列を出してから (spec C2.10「タブの列へ落としても戻る」)、もう一度引き出し、見出しをタブの列へ落として戻す
    await openSettings();
    await dragFromTo(centerOf(await boxOf(tabIn(sideSlot, "区間・テロップ"))), target);
    await dropInto(headerPoint(await boxOf(listHeader)), { x: target.x, y: target.y + 100 }, sideSlot);
    const back = await slotState("side");
    await closeSettings();

    const floatPulled = floatOf(savedPulled);
    const floatReset = floatOf(savedReset);
    record(
      DOCK_PULL_OUT,
      pulled.floating &&
        pulled.side !== null &&
        !pulled.side.shown &&
        floatPulled !== null &&
        "list" in floatPulled &&
        sameJson(docksOf(savedPulled), {
          below: { tabs: ["bar"] },
          side: { tabs: ["settings"] },
        }) &&
        reset !== null &&
        reset.windows.includes("yt-clip-list") &&
        sameJson(reset.labels, ["区間・テロップ"]) &&
        floatReset !== null &&
        !("list" in floatReset) &&
        sameJson(docksOf(savedReset), {
          below: { tabs: ["bar"] },
          side: { tabs: ["list", "settings"], active: "list" },
        }) &&
        back !== null &&
        back.windows.includes("yt-clip-list") &&
        sameJson(back.labels, ["設定", "区間・テロップ"]) &&
        back.active === "区間・テロップ",
      { pulled, savedPulled, reset, savedReset, back },
    );
  });

  // シアターモードは YouTube が覚える (次の読み込みにも残る) ので、最後に置き、戻してから終える
  const DOCK_THEATER =
    "ドック: 最初の配置のまま t でシアターモードにすると、右の枠は動画の下へ回ってドックされたまま。戻すと元の位置";
  await check(DOCK_THEATER, async () => {
    await resetLayoutAndReload();
    await closeSettings();
    await page.evaluate(() => window.scrollTo(0, 0));
    const measure = async () => ({ slot: await slotState("side"), boxes: await pageBoxes() });
    /** YouTube のショートカット t。入力欄やボタンにフォーカスがあると効かない・文字として入るので、先に外す */
    const toggleTheater = async (theater: boolean): Promise<void> => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("t");
      await page.waitForFunction(
        (expected) =>
          (document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? false) === expected,
        theater,
        { timeout: 10_000 },
      );
      // レイアウトが落ち着くのを待つ (プレイヤーの大きさの変化で placeUnmovedWindows も走る)
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollTo(0, 0));
    };
    const normal = await measure();
    await toggleTheater(true);
    const theater = await measure();
    await toggleTheater(false);
    const restored = await measure();
    const inSlot = (m: typeof normal) =>
      m.slot !== null && m.slot.windows.includes("yt-clip-list");
    const infinity = Number.POSITIVE_INFINITY;
    record(
      DOCK_THEATER,
      inSlot(normal) &&
        normal.boxes.theater === false &&
        (normal.slot?.box.left ?? -infinity) >= (normal.boxes.player?.right ?? infinity) &&
        inSlot(theater) &&
        theater.boxes.theater === true &&
        (theater.slot?.box.top ?? -infinity) >= (theater.boxes.player?.bottom ?? infinity) &&
        inSlot(restored) &&
        restored.boxes.theater === false &&
        (restored.slot?.box.left ?? -infinity) >= (restored.boxes.player?.right ?? infinity),
      { normal, theater, restored },
    );
  });

  await writeResults();
  const failed = Object.entries(results)
    .filter(([, r]) => !r.pass)
    .map(([name]) => name);
  expect(failed).toEqual([]);
});
