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
