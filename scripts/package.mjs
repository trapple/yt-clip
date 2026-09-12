/**
 * ウェブストアへ上げる zip を作る。
 *
 *   npm run package
 *
 * `dist` の中身をそのまま固める。**`dist` を含む階層ごと固めてはいけない。**
 * ウェブストアは zip の直下に manifest.json があることを期待する。
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
/** zip が応答を返さないまま固まるのを防ぐ。既定は無制限 */
const TIMEOUT_MS = 60_000;

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
const name = `yt-clip-${manifest.version}.zip`;

mkdirSync("release", { recursive: true });
// 同じ版で作り直したとき、zip は既存の書庫に追記してしまう
rmSync(`release/${name}`, { force: true });

// -X: macOS の拡張属性を入れない (審査で不要なファイルとして目に付く)
await run("zip", ["-r", "-X", `../release/${name}`, "."], {
  cwd: "dist",
  timeout: TIMEOUT_MS,
});

const { stdout } = await run("unzip", ["-l", `release/${name}`], {
  timeout: TIMEOUT_MS,
});
console.log(stdout);
console.log(`release/${name} を作りました`);
