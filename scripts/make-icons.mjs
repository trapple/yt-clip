/**
 * 拡張のアイコンを描き出す。
 *
 * IN/OUT の括弧の中に再生の三角、という図。**YouTube と X の意匠・色は使わない。**
 * 公式との混同を招くものはウェブストアの審査で落ちる。
 *
 *   node scripts/make-icons.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/** 16px まで縮めても潰れないよう、線は太めに取る */
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect x="0" y="0" width="128" height="128" rx="26" fill="#202124"/>
  <g stroke="#e8eaed" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M40 30 H26 V98 H40"/>
    <path d="M88 30 H102 V98 H88"/>
  </g>
  <path d="M54 44 L84 64 L54 84 Z" fill="#ffb300"/>
</svg>`;

const SIZES = [16, 32, 48, 128];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  mkdirSync("public/icons", { recursive: true });

  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0">${svg(size)}</body>`);
    const png = await page.screenshot({ omitBackground: true });
    writeFileSync(`public/icons/icon-${size}.png`, png);
    console.log(`public/icons/icon-${size}.png (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
