import { PANEL_STYLE } from "@/content/styles";
import {
  SETTINGS_FIELDS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsContext,
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
  /**
   * いま開いている動画の文脈。**開くたびに読む。**
   * SPA 遷移で別のチャンネルの動画に移っていることがある
   */
  getContext(): SettingsContext;
};

const defaultDeps: PanelDeps = {
  load: loadSettings,
  save: saveSettings,
  getContext: () => ({ channel: null }),
};

export function createSettingsPanel(
  overrides: Partial<PanelDeps> = {},
): SettingsPanel {
  const deps: PanelDeps = { ...defaultDeps, ...overrides };
  const element = document.createElement("div");
  element.style.cssText = PANEL_STYLE.root;
  element.hidden = true;

  // 項目・入力欄・説明を組で持つ。鍵で引き直す形にすると、必ず存在するものに
  // 対して undefined チェックが要るうえ、項目が増えるたびに Map が 1 本増える
  const rows = SETTINGS_FIELDS.map((field) => {
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

    // 文言は文脈で変わる (どのチャンネルのタグか)。中身は開くときに入れる
    const hint = document.createElement("div");
    hint.style.cssText = PANEL_STYLE.hint;

    wrapper.append(label, input, hint);
    element.append(wrapper);
    return { field, input, hint };
  });

  const result = document.createElement("span");
  result.style.cssText = PANEL_STYLE.result;

  const save = document.createElement("button");
  save.textContent = "保存";
  save.dataset.role = "save";

  const footer = document.createElement("div");
  footer.style.cssText = PANEL_STYLE.footer;
  footer.append(result, save);
  element.append(footer);

  /**
   * 保存済みの値を入力欄へ流し込む。
   *
   * 読んだばかりの設定と文脈があれば渡すこと。**保存の直後に読み直すと、
   * 1 回の保存で storage を何度も往復する**
   */
  async function fill(
    loaded?: Settings,
    loadedContext?: SettingsContext,
  ): Promise<void> {
    const settings = loaded ?? (await deps.load());
    const context = loadedContext ?? deps.getContext();

    for (const { field, input, hint } of rows) {
      // **分岐するのは scope だけ。** key を見て分岐すると、項目を足すたびに
      // ここへ戻ってくることになる
      const unavailable = field.scope === "channel" && context.channel === null;
      input.disabled = unavailable;
      input.value = unavailable ? "" : field.toText(settings, context);
      hint.textContent = field.hint(context);
    }
  }

  save.addEventListener("click", () => {
    void (async () => {
      try {
        // 差分の土台は**保存されている現在の設定**。チャンネル別の項目は
        // 他のチャンネル分を残したまま 1 件だけ差し替える必要がある
        const settings = await deps.load();
        const context = deps.getContext();

        // 項目ごとの差分をまとめて 1 回で書く
        let patch: Partial<Settings> = {};
        for (const { field, input } of rows) {
          // 入力させていない項目は保存の対象にしない。空のまま送ると、
          // チャンネルを特定できない画面を開いただけでタグが消える
          if (input.disabled) continue;

          const converted = field.fromText(input.value, settings, context);
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
        // 正規化した結果を出す。何が保存されたかを見せる。
        // 読んだばかりのものを渡して、storage の往復とチャンネルの再取得を省く
        await fill({ ...settings, ...patch }, context);
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
