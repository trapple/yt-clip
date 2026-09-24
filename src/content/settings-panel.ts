import { PANEL_STYLE } from "@/content/styles";
import {
  SETTINGS_FIELDS,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsContext,
  type SettingsField,
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

/** 入力欄として振る舞う要素。`value` と `disabled` はどちらも持つ */
export type FieldInput = HTMLInputElement | HTMLSelectElement;

/**
 * 項目 1 つ分の入力欄を作る。
 *
 * **分岐するのは `control` だけ。** `key` を見て分岐すると、項目を足すたびに
 * ここへ戻ってくることになる (`scope` による分岐が `fill` に 1 箇所あるのと
 * 同じで、field 側が宣言した値しか見ない)
 */
export function createFieldInput(field: SettingsField): FieldInput {
  const id = `yt-clip-setting-${field.key}`;

  if (field.control.kind === "select") {
    const select = document.createElement("select");
    select.id = id;
    select.style.cssText = PANEL_STYLE.input;
    select.append(
      ...field.control.options.map((option) => {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        return element;
      }),
    );
    return select;
  }

  const input = document.createElement("input");
  input.id = id;
  input.type = field.control.kind === "color" ? "color" : "text";
  input.style.cssText = PANEL_STYLE.input;
  if (field.control.kind === "text" && field.control.suggestions !== undefined) {
    // 候補の箱は `createFieldExtras` が作る。id の決め方をここと揃える
    input.setAttribute("list", `${id}-suggestions`);
  }
  return input;
}

/**
 * 入力欄の隣に置く要素。いまは候補の `datalist` だけ。
 *
 * **`createFieldInput` の返り値を変えない。** 入力欄として振る舞う要素を 1 つ返す
 * 形はテストと保存処理が前提にしている。候補の箱は DOM に置かないと効かないので、
 * パネルが入力欄と並べて置く
 */
export function createFieldExtras(field: SettingsField): HTMLElement[] {
  if (field.control.kind !== "text" || field.control.suggestions === undefined) {
    return [];
  }
  const datalist = document.createElement("datalist");
  datalist.id = `yt-clip-setting-${field.key}-suggestions`;
  datalist.append(
    ...field.control.suggestions.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
  return [datalist];
}

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

    const input = createFieldInput(field);

    // 文言は文脈で変わる (どのチャンネルのタグか)。中身は開くときに入れる
    const hint = document.createElement("div");
    hint.style.cssText = PANEL_STYLE.hint;

    wrapper.append(label, input, ...createFieldExtras(field), hint);
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
