// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { createSettingsPanel } from "@/content/settings-panel";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, type Settings } from "@/shared/settings";

function makeDeps(initial: Partial<Settings> = {}) {
  const store: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const saved: Partial<Settings>[] = [];
  return {
    store,
    saved,
    deps: {
      load: () => Promise.resolve({ ...store }),
      save: (patch: Partial<Settings>) => {
        saved.push(patch);
        Object.assign(store, patch);
        return Promise.resolve();
      },
    },
  };
}

function inputOf(panel: { element: HTMLElement }, key: string): HTMLInputElement {
  const input = panel.element.querySelector<HTMLInputElement>(
    `#yt-clip-setting-${key}`,
  );
  if (input === null) throw new Error(`入力欄がありません: ${key}`);
  return input;
}

function saveButton(panel: { element: HTMLElement }): HTMLButtonElement {
  const button = panel.element.querySelector<HTMLButtonElement>(
    "[data-role=save]",
  );
  if (button === null) throw new Error("保存ボタンがありません");
  return button;
}

/** click の中の非同期処理を流す */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("createSettingsPanel", () => {
  test("項目定義の数だけ入力欄が出る", () => {
    // 設定を足すときに触るのは SETTINGS_FIELDS だけ、という約束を固定する
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);

    expect(panel.element.querySelectorAll("input")).toHaveLength(
      SETTINGS_FIELDS.length,
    );
  });

  test("最初は閉じている", () => {
    const { deps } = makeDeps();
    expect(createSettingsPanel(deps).element.hidden).toBe(true);
  });

  test("開くと保存済みの値が入る", async () => {
    const { deps } = makeDeps({ hashtags: ["切り抜き", "VTuber"] });
    const panel = createSettingsPanel(deps);

    panel.toggle();
    await flush();

    expect(panel.element.hidden).toBe(false);
    expect(inputOf(panel, "hashtags").value).toBe("#切り抜き #VTuber");
  });

  test("もう一度押すと閉じる", () => {
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);

    panel.toggle();
    panel.toggle();

    expect(panel.element.hidden).toBe(true);
  });

  test("保存すると正規化された値が書き込まれる", async () => {
    const { saved, deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    inputOf(panel, "hashtags").value = "切り抜き #VTuber、切り抜き";
    saveButton(panel).click();
    await flush();

    expect(saved).toEqual([{ hashtags: ["切り抜き", "VTuber"] }]);
  });

  test("保存した後は正規化された形が入力欄に出る", async () => {
    // 何が保存されたかを見せる。# の有無や重複がどう扱われたか分かる
    const { deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    inputOf(panel, "hashtags").value = "切り抜き 切り抜き";
    saveButton(panel).click();
    await flush();

    expect(inputOf(panel, "hashtags").value).toBe("#切り抜き");
  });

  test("開き直すと読み直す", async () => {
    // 別のタブで変えた設定を、古い値で上書きしないため
    const { store, deps } = makeDeps();
    const panel = createSettingsPanel(deps);
    panel.toggle();
    await flush();

    panel.toggle();
    store.hashtags = ["あとで変えた"];
    panel.toggle();
    await flush();

    expect(inputOf(panel, "hashtags").value).toBe("#あとで変えた");
  });

  test("保存できなければ黙らずに伝える", async () => {
    // 保存できていないのに黙っていると、設定したつもりで投稿してしまう
    const panel = createSettingsPanel({
      load: () => Promise.resolve(DEFAULT_SETTINGS),
      save: () => Promise.reject(new Error("書き込めません")),
    });
    panel.toggle();
    await flush();

    saveButton(panel).click();
    await flush();

    expect(panel.element.textContent).toContain("保存できませんでした");
  });
});
