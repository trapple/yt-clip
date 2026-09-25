import type { BrowserContext, Worker } from "@playwright/test";

/**
 * service worker は MV3 で止まりうる。止まっていたら popup を開いて起こす
 * (popup は service worker に状態を問い合わせる)。smoke.spec.ts と telop-check.spec.ts の両方が使う
 * (context と extensionId は呼び出し側のモジュール変数なので、引数で受け取る)
 */
export async function getWorker(context: BrowserContext, extensionId: string): Promise<Worker> {
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
