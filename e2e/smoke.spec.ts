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
