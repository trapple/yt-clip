import { PANEL_STYLE } from "@/content/styles";
import {
  SETTINGS_FIELDS,
  loadSettings,
  saveSettings,
  type Settings,
} from "@/shared/settings";

/**
 * ⚙ で開く設定パネル。
 *
 * **項目ごとの分岐を持たない。** `SETTINGS_FIELDS` を並べるだけにしてあるので、
 * 設定を足すときはそちらに 1 要素足せばここに出る。
 */
export type SettingsPanel = {
  element: HTMLElement;
  /** 開閉を切り替える。開くときは保存済みの値を流し込む */
  toggle(): void;
};

export type PanelDeps = {
  load(): Promise<Settings>;
  save(patch: Partial<Settings>): Promise<void>;
};

const defaultDeps: PanelDeps = { load: loadSettings, save: saveSettings };

export function createSettingsPanel(
  deps: PanelDeps = defaultDeps,
): SettingsPanel {
  const element = document.createElement("div");
  element.style.cssText = PANEL_STYLE.root;
  element.hidden = true;

  const inputs = new Map<string, HTMLInputElement>();

  for (const field of SETTINGS_FIELDS) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = PANEL_STYLE.field;

    const label = document.createElement("label");
    label.style.cssText = PANEL_STYLE.label;
    label.textContent = field.label;
    label.htmlFor = `yt-clip-setting-${field.key}`;

    const input = document.createElement("input");
    input.id = `yt-clip-setting-${field.key}`;
    input.type = "text";
    input.style.cssText = PANEL_STYLE.input;

    const hint = document.createElement("div");
    hint.style.cssText = PANEL_STYLE.hint;
    hint.textContent = field.hint;

    wrapper.append(label, input, hint);
    element.append(wrapper);
    inputs.set(field.key, input);
  }

  const result = document.createElement("span");
  result.style.cssText = PANEL_STYLE.result;

  const save = document.createElement("button");
  save.textContent = "保存";
  save.dataset.role = "save";

  const footer = document.createElement("div");
  footer.style.cssText = PANEL_STYLE.footer;
  footer.append(result, save);
  element.append(footer);

  async function fill(): Promise<void> {
    const settings = await deps.load();
    for (const field of SETTINGS_FIELDS) {
      const input = inputs.get(field.key);
      if (input !== undefined) input.value = field.toText(settings);
    }
  }

  save.addEventListener("click", () => {
    void (async () => {
      try {
        // 項目ごとの差分をまとめて 1 回で書く
        let patch: Partial<Settings> = {};
        for (const field of SETTINGS_FIELDS) {
          const input = inputs.get(field.key);
          if (input === undefined) continue;

          const converted = field.fromText(input.value);
          // **1 つでも通らなければ何も保存しない。** 一部だけ書き込むと、
          // エラーを見た利用者が「何が保存されて何が保存されなかったか」を
          // 画面から判断できない
          if (!converted.ok) {
            result.textContent = `${field.label}: ${converted.message}`;
            return;
          }
          patch = { ...patch, ...converted.patch };
        }
        await deps.save(patch);
        // 正規化した結果を出す。何が保存されたかを見せる
        await fill();
        result.textContent = "保存しました";
      } catch (error) {
        // 保存できていないのに黙っていると、設定したつもりで投稿してしまう
        result.textContent = `保存できませんでした: ${String(error)}`;
      }
    })();
  });

  return {
    element,
    toggle(): void {
      element.hidden = !element.hidden;
      result.textContent = "";
      // 開くたびに読み直す。別のタブで変えた設定を古いまま上書きしない
      if (!element.hidden) void fill();
    },
  };
}

export { PANEL_STYLE };
