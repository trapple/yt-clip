import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorker as sharedGetWorker } from "./helpers";

const EXTENSION_PATH = fileURLToPath(new URL("../dist", import.meta.url));

/** 短く安定した公開動画。広告が挟まると録画に混入するため失敗しうる */
const TEST_VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

/**
 * ブラウザを起動し、拡張の id を得る。「オフのまま起動し直す」の項目も同じ userDataDir で呼ぶ
 * (chrome.storage.local は userDataDir に残るので、起動し直してもオフのまま)
 */
async function launch(): Promise<void> {
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
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-e2e-"));
  await launch();
});

test.afterAll(async () => {
  await context?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

/** e2e/helpers.ts の getWorker を、この場のモジュール変数 (context / extensionId) で呼ぶ (telop-check.spec.ts と共有) */
function getWorker(): Promise<Worker> {
  return sharedGetWorker(context, extensionId);
}

/**
 * オン / オフを service worker の文脈から書く (マスタースイッチの spec §8。popup の操作は別の項目で確かめる)。
 * 各項目は先頭でこれを呼んで前提を作り、finally でオンに戻す (前の項目の終わり方に依存しない)
 */
async function writeEnabled(enabled: boolean): Promise<void> {
  const worker = await getWorker();
  await worker.evaluate((value) => chrome.storage.local.set({ enabled: value }), enabled);
}

async function badgeText(): Promise<string> {
  const worker = await getWorker();
  return worker.evaluate(() => chrome.action.getBadgeText({}));
}

/** 拡張が足した要素の数 (spec §1 の測り方)。窓・ドック枠・シークバーの帯・プレビューの canvas を覆う */
function countOurElements(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length,
  );
}

/**
 * service worker が受けるタブからのメッセージを数え始める (spec §8)。数える listener は一度だけ足し、呼ぶたびに数を
 * 0 に戻す。**service worker が止まると listener も数も消える** ので、読むとき (countedTabMessages) に消えていたら落とす
 */
async function startCountingTabMessages(): Promise<void> {
  const worker = await getWorker();
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      ytClipTabMessages?: string[];
      ytClipCounting?: boolean;
    };
    scope.ytClipTabMessages = [];
    if (scope.ytClipCounting === true) return;
    scope.ytClipCounting = true;
    chrome.runtime.onMessage.addListener((message: { type?: unknown }, sender) => {
      if (sender.tab !== undefined) scope.ytClipTabMessages?.push(String(message.type));
    });
  });
}

async function countedTabMessages(): Promise<string[]> {
  const worker = await getWorker();
  return worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & { ytClipTabMessages?: string[] };
    if (scope.ytClipTabMessages === undefined) {
      throw new Error("service worker が止まり、数える listener が消えました。測り直してください");
    }
    return [...scope.ytClipTabMessages];
  });
}

/** 動画ページを開き、バーとタイトルが出るまで待つ (IN を押すとタイトルを読む) */
async function openVideo(page: Page, url: string = TEST_VIDEO): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator("h1.ytd-watch-metadata yt-formatted-string"),
  ).not.toBeEmpty({ timeout: 30_000 });
}

/** 再生位置を動かす。UI 操作ではシークバーの精度が出ないため直接指定する */
async function seekVideo(page: Page, sec: number): Promise<void> {
  await page.evaluate((target: number) => {
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (video === null) throw new Error("video 要素が見つかりません");
    video.currentTime = target;
  }, sec);
}

function videoState(page: Page): Promise<{ currentTime: number; paused: boolean }> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (video === null) throw new Error("video 要素が見つかりません");
    return { currentTime: video.currentTime, paused: video.paused };
  });
}

function isTheater(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector("ytd-watch-flexy")?.hasAttribute("theater") ?? false,
  );
}

/** YouTube のショートカット。入力欄やボタンにフォーカスがあると効かない・文字として入るので、先に外す */
async function pressShortcut(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}

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

test("IN を指定するとページ内で録画を始められる", async () => {
  const page = await context.newPage();
  await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const bar = page.locator("#yt-clip-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // バーの表示とタイトルの読み込みは別々に進む。バーはプレイヤーのコントロールが
  // 出た時点で挿入されるが、IN を押すと読まれる動画タイトルはもう少し後に埋まる。
  // 待たずに押すとメタ情報を取れず「操作できませんでした」で終わる
  await expect(
    page.locator("h1.ytd-watch-metadata yt-formatted-string"),
  ).not.toBeEmpty({ timeout: 30_000 });

  /** 再生位置を動かす。UI 操作ではシークバーの精度が出ないため直接指定する */
  const seek = (sec: number) =>
    page.evaluate((target: number) => {
      const video = document.querySelector<HTMLVideoElement>(
        "video.html5-main-video",
      );
      if (video === null) throw new Error("video 要素が見つかりません");
      video.currentTime = target;
    }, sec);

  // IN を押すと既定 15 秒の範囲ができる
  await seek(5);
  await bar.getByRole("button", { name: "IN" }).click();

  await expect(page.locator("#yt-clip-bar-status")).toHaveText(
    "0:05 〜 0:20 (15秒)",
  );

  // 操作はページ内で完結する。録画はここから始められる
  await expect(bar.getByRole("button", { name: "● 録画" })).toBeEnabled();

  // popup が持つ操作はオン / オフのスイッチだけ (role は switch なので button には当たらない)。
  // 状態を映すのは、YouTube 以外のタブにいるときの逃げ道として残す
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extensionId}/src/popup/popup.html`,
    { timeout: 30_000 },
  );
  await expect(popup.locator("#message")).toHaveText(
    "0:05 〜 0:20 (15秒) を録画できます",
  );
  await expect(popup.getByRole("button")).toHaveCount(0);

  // ここから先 (実際の録画) は自動化していない。録画は実時間かかるうえ、
  // 生成された動画の中身 (音声トラックの有無・解像度など) は目や耳で確認
  // するしかない。録画以降は docs/manual-check.md の手動確認で担保する。

  await popup.close();
  await page.close();
});

test("オフにすると 1 秒以内に拡張の要素が消え、YouTube はそのまま動き、開き直しても何も出ず、メッセージも来ない。オンに戻すと読み込み直さずに戻る", async () => {
  test.setTimeout(240_000);
  // 前提を自分で作る: オン・覚えた窓の配置なし (最初の配置 = バーは下の枠)
  await writeEnabled(true);
  await (await getWorker()).evaluate(() => chrome.storage.local.remove("windowLayout"));
  const page = await context.newPage();
  // オフにした後にページのコンソールへ出た拡張の行 (判断メモ 21)。**空振りしうる**: Playwright が content script の
  // 隔離された world の console を console イベントに載せないなら、拡張が出しても 0 行のまま通る (拾えていることの正例は
  // 作れていない)。そのため manual-check の「オン / オフ」で DevTools のコンソールを目で見る
  const extensionLogs: string[] = [];
  let watchingLogs = false;
  page.on("console", (message) => {
    if (!watchingLogs) return;
    const fromExtension = message.location().url.startsWith(`chrome-extension://${extensionId}/`);
    if (fromExtension || message.text().includes("[yt-clip]")) extensionLogs.push(message.text());
  });
  try {
    await openVideo(page);
    await seekVideo(page, 5);
    await page.locator("#yt-clip-bar").getByRole("button", { name: "IN" }).click();
    await expect(page.locator("#yt-clip-bar-status")).toHaveText("0:05 〜 0:20 (15秒)");
    expect(await countOurElements(page)).toBeGreaterThan(0);

    // オフに書く直前に数え始める (オンの間に送った分は数えない。spec §8)
    await startCountingTabMessages();
    const offAt = Date.now();
    watchingLogs = true;
    await writeEnabled(false);
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await expect.poll(badgeText, { timeout: 5_000 }).toBe("OFF");

    // YouTube 自身の動作が変わらない (代表: 再生が進む・k で一時停止と再生・t でシアターモード)
    await page.bringToFront();
    await page.evaluate(() =>
      document.querySelector<HTMLVideoElement>("video.html5-main-video")?.play(),
    );
    const before = await videoState(page);
    await page.waitForTimeout(1_500);
    expect((await videoState(page)).currentTime).toBeGreaterThan(before.currentTime);
    await pressShortcut(page, "k");
    await expect.poll(async () => (await videoState(page)).paused, { timeout: 5_000 }).toBe(true);
    await pressShortcut(page, "k");
    await expect.poll(async () => (await videoState(page)).paused, { timeout: 5_000 }).toBe(false);
    const theaterBefore = await isTheater(page);
    await pressShortcut(page, "t");
    await expect.poll(() => isTheater(page), { timeout: 10_000 }).toBe(!theaterBefore);
    await pressShortcut(page, "t");
    await expect.poll(() => isTheater(page), { timeout: 10_000 }).toBe(theaterBefore);
    expect(await countOurElements(page)).toBe(0);

    // オフのまま動画ページを開き直す (content script は読み込まれるが何もしない。判断メモ 19)
    await page.goto(`${TEST_VIDEO}&t=3s`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#below").waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(5_000);
    expect(await countOurElements(page)).toBe(0);

    // オフにしてから 10 秒以上、タブから service worker へ 1 通も来ない
    const rest = 10_000 - (Date.now() - offAt);
    if (rest > 0) await page.waitForTimeout(rest);
    expect(await countedTabMessages()).toEqual([]);
    expect(extensionLogs).toEqual([]);

    // オンに戻す。読み込み直さない (page.reload を呼ばない)。同じ動画なので IN の範囲も戻る
    watchingLogs = false;
    await writeEnabled(true);
    await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 1_000 });
    await expect(page.locator("#yt-clip-bar-status")).toHaveText("0:05 〜 0:20 (15秒)", {
      timeout: 5_000,
    });
    // 最初の配置なので、バーは下の枠 (#below の中) に戻る
    expect(
      await page.evaluate(
        () => document.getElementById("yt-clip-bar-window")?.closest("#yt-clip-dock-below") != null,
      ),
    ).toBe(true);
    await expect.poll(badgeText, { timeout: 5_000 }).toBe("");
  } finally {
    await writeEnabled(true);
    await page.close();
  }
});

test("オフ → オンで、浮かせて置いた窓は同じ位置に、枠に入れた窓は同じ枠に出る", async () => {
  // 前提を自分で作る: エディットモード (区間・テロップの窓は区間があるときだけ出る) と、区間・テロップの窓を
  // 浮かせて (200, 150) に置き、バーを下の枠に入れた配置
  await writeEnabled(true);
  await (await getWorker()).evaluate(() =>
    Promise.all([
      chrome.storage.sync.set({ settings: { mode: "edit" } }),
      chrome.storage.local.set({
        windowLayout: {
          version: 2,
          float: { list: { left: 200, top: 150, width: 360, height: 300 } },
          docks: { below: { tabs: ["bar"] } },
        },
      }),
    ]),
  );
  const page = await context.newPage();
  /** 区間・テロップの窓の置き場所と、バーが下の枠にあるか */
  const placement = () =>
    page.evaluate(() => {
      const list = document.getElementById("yt-clip-list");
      return {
        left: list?.style.left ?? null,
        top: list?.style.top ?? null,
        floating: list?.parentElement === document.body,
        barInBelow:
          document.getElementById("yt-clip-bar-window")?.closest("#yt-clip-dock-below") != null,
      };
    });
  try {
    await openVideo(page);
    await page.locator("#yt-clip-bar").getByRole("button", { name: "＋ 区間を追加" }).click();
    const list = page.locator("#yt-clip-list");
    await expect(list).toBeVisible();
    const before = await placement();
    expect(before).toEqual({ left: "200px", top: "150px", floating: true, barInBelow: true });

    await writeEnabled(false);
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await writeEnabled(true);
    await expect(list).toBeVisible({ timeout: 5_000 });
    expect(await placement()).toEqual(before);
  } finally {
    await (await getWorker()).evaluate(() =>
      Promise.all([
        chrome.storage.sync.remove("settings"),
        chrome.storage.local.remove("windowLayout"),
      ]),
    );
    await writeEnabled(true);
    await page.close();
  }
});

test("popup のスイッチを押すと 1 秒以内に YouTube のタブから拡張の要素が消え、もう一度押すと戻る。ボタンは持たない", async () => {
  // 前提を自分で作る: オン・覚えた窓の配置なし
  await writeEnabled(true);
  await (await getWorker()).evaluate(() => chrome.storage.local.remove("windowLayout"));
  const page = await context.newPage();
  const popup = await context.newPage();
  try {
    await openVideo(page);
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      timeout: 30_000,
    });
    const toggle = popup.locator("#enabled");
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect.poll(() => countOurElements(page), { timeout: 1_000 }).toBe(0);
    await expect(toggle).not.toBeChecked();
    await expect(popup.locator("#message")).toHaveText(
      "オフです。YouTube と X のページには何も出ません",
    );
    await expect(popup.getByRole("button")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.locator("#yt-clip-bar")).toBeVisible({ timeout: 5_000 });
  } finally {
    await writeEnabled(true);
    await popup.close();
    await page.close();
  }
});

// **この項目はファイルの最後に置く** (ブラウザを起動し直す。context と extensionId を作り直す)
test("オフのまま起動し直してもオフのまま。バッジも OFF で、動画ページに何も出ない", async () => {
  test.setTimeout(240_000);
  await writeEnabled(false);
  try {
    // chrome.runtime.reload() の代わりに、同じ userDataDir で起動し直す (spec §8)
    await context.close();
    await launch();
    const worker = await getWorker();
    expect(await worker.evaluate(() => chrome.storage.local.get("enabled"))).toEqual({
      enabled: false,
    });
    await expect.poll(badgeText, { timeout: 10_000 }).toBe("OFF");

    const page = await context.newPage();
    await page.goto(TEST_VIDEO, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#below").waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(5_000);
    expect(await countOurElements(page)).toBe(0);
    await page.close();
  } finally {
    await writeEnabled(true);
  }
});
