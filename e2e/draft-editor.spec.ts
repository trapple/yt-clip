import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare global {
  interface Window {
    __model(): string;
  }
}


/**
 * 本文の入力を**本物の Draft.js**に対して確かめる。
 *
 * jsdom には Draft.js も execCommand も無く、単体テストでは
 * 「通るのに実機で壊れる」を繰り返した。壊れ方はどれも
 * 「画面には入っているのにモデルには入っていない」形だったので、
 * **DOM ではなくモデルを見て判定する**。
 */

let context: BrowserContext;
let userDataDir: string;

/** X の投稿欄に相当する、最小の Draft.js エディタ */
const EDITOR_PAGE = `<!doctype html>
<html><body>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/16.14.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/16.14.0/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/immutable/3.7.6/immutable.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/draft-js/0.11.7/Draft.min.js"></script>
<script>
  const { Editor, EditorState } = Draft;
  function App() {
    const [state, setState] = React.useState(EditorState.createEmpty());
    // モデルの中身をテストから読めるようにする
    window.__model = () => state.getCurrentContent().getPlainText("\\n");
    return React.createElement(
      "div",
      { "data-testid": "tweetTextarea_0" },
      React.createElement(Editor, { editorState: state, onChange: setState }),
    );
  }
  ReactDOM.render(React.createElement(App), document.getElementById("root"));
</script>
</body></html>`;

/** ビルド済みの入力処理と同じ手順。src/content/x.ts の insertText に対応する */
const INSERT_TEXT = `async (text) => {
  const editor = document.querySelector('[data-testid="tweetTextarea_0"] [contenteditable="true"]');
  const readBlocks = () => {
    const blocks = editor.querySelectorAll("[data-block]");
    if (blocks.length === 0) return "";
    return Array.from(blocks).map((b) => b.textContent ?? "").join("\\n");
  };
  const waitFor = (target, type, ms) => new Promise((resolve) => {
    const done = () => { target.removeEventListener(type, done); clearTimeout(t); resolve(); };
    const t = setTimeout(done, ms);
    target.addEventListener(type, done, { once: true });
  });

  editor.focus();
  editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  await waitFor(document, "selectionchange", 300);

  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  editor.dispatchEvent(new ClipboardEvent("paste", {
    clipboardData: transfer, bubbles: true, cancelable: true,
  }));

  if (readBlocks() === text) return;
  await new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (readBlocks() !== text) return;
      observer.disconnect(); clearTimeout(t); resolve();
    });
    const t = setTimeout(() => { observer.disconnect(); resolve(); }, 2000);
    observer.observe(editor, { childList: true, subtree: true, characterData: true });
  });
}`;

/** 実データと同じ形。絵文字・改行・URL・ハッシュタグを含む */
const BODY =
  "✨🎀 明透 - 5周年記念配信！🎀✨ 【琵舞/美古途】\n\nhttps://youtu.be/abc123?t=2539\n\n#クリ明透 #あすカット";

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "yt-clip-draft-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await context?.close();
  await rm(userDataDir, { recursive: true, force: true });
});

async function openEditor() {
  const page = await context.newPage();
  await page.setContent(EDITOR_PAGE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__model === "function", {
    timeout: 30_000,
  });
  return page;
}

test("本文がモデルにそのまま入る", async () => {
  const page = await openEditor();

  await page.evaluate(`(${INSERT_TEXT})(${JSON.stringify(BODY)})`);

  // **DOM ではなくモデルを見る。** 壊れた入り方をすると、画面には
  // 全部入っているのにモデルには一部しか入らない
  expect(await page.evaluate(() => window.__model())).toBe(BODY);
  await page.close();
});

test("前の下書きを置き換える", async () => {
  const page = await openEditor();

  await page.evaluate(`(${INSERT_TEXT})("前の下書き")`);
  await page.evaluate(`(${INSERT_TEXT})(${JSON.stringify(BODY)})`);

  expect(await page.evaluate(() => window.__model())).toBe(BODY);
  await page.close();
});

test("二度入れても積み上がらない", async () => {
  const page = await openEditor();

  await page.evaluate(`(${INSERT_TEXT})(${JSON.stringify(BODY)})`);
  await page.evaluate(`(${INSERT_TEXT})(${JSON.stringify(BODY)})`);

  expect(await page.evaluate(() => window.__model())).toBe(BODY);
  await page.close();
});

test("入れた後も手で編集できる", async () => {
  // execCommand で入れると Draft.js の内部状態と DOM がずれ、
  // 以降の編集を受け付けなくなった
  const page = await openEditor();
  await page.evaluate(`(${INSERT_TEXT})(${JSON.stringify(BODY)})`);

  await page.click('[data-testid="tweetTextarea_0"] [contenteditable="true"]');
  await page.keyboard.press("End");
  await page.keyboard.type("追記");

  expect(await page.evaluate(() => window.__model())).toContain("追記");
  await page.close();
});

test("execCommand で入れるとモデルが壊れる", async () => {
  // **この経路を使ってはいけない**ことを、壊れる側から固定する。
  // 実装が execCommand に戻ったらここが通らなくなる
  const page = await openEditor();

  await page.evaluate((text) => {
    const editor = document.querySelector<HTMLElement>(
      '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
    );
    if (editor === null) throw new Error("入力欄がありません");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, text);
  }, BODY);
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => window.__model())).not.toBe(BODY);
  await page.close();
});
