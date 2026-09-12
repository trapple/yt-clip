/**
 * 設定。
 *
 * **`chrome.storage.sync` の `settings` キー 1 つに全部入れる。** キーを設定
 * ごとに散らすと、読み出しが増えるたびに `get` の呼び出しと既定値の補完を
 * 書き足すことになる。
 *
 * 設定を足すときに触るのは 2 箇所だけ: `Settings` に 1 行、
 * `SETTINGS_FIELDS` に 1 要素。それだけで画面にも出る。
 */

import {
  DEFAULT_MAX_CLIP_SEC,
  MAX_SETTABLE_CLIP_SEC,
  MIN_CLIP_SEC,
} from "@/shared/time";

export const SETTINGS_KEY = "settings";

export type Settings = {
  /** 投稿本文のテンプレート。いまは画面から編集できないが設定ではある */
  template: string;
  /**
   * チャンネルごとの、本文の末尾に付けるハッシュタグ。**`#` は含めない**
   *
   * 共通のタグは持たない。切り抜くチャンネルごとに付けるタグが違うため
   */
  hashtagsByChannel: Record<string, string[]>;
  /**
   * チャンネル別にする前の共通タグ。**移行のためだけにある。**
   *
   * 設定がまだ無いチャンネルではこれを使う (捨てずに引き継ぐ)。一度でも
   * 保存すれば空になり、以降は素直にチャンネル別だけになる
   */
  legacyHashtags: string[];
  /** 1 クリップの最大長 (秒) */
  maxClipSec: number;
};

/** 設定を読み書きするときの文脈。チャンネル別の項目が要る */
export type SettingsContext = {
  /** いま開いている動画のチャンネル。特定できなければ null */
  channel: { id: string; name: string } | null;
};

/** 既定の投稿本文。`{tags}` は自分で区切りを持つ (下記 tagsVariable 参照) */
export const DEFAULT_TEMPLATE = "{title}\n\n{url}{tags}";

export const DEFAULT_SETTINGS: Settings = {
  template: DEFAULT_TEMPLATE,
  hashtagsByChannel: {},
  legacyHashtags: [],
  maxClipSec: DEFAULT_MAX_CLIP_SEC,
};

/** 区切りとして扱う文字。全角空白と読点も含める */
const SEPARATORS = /[\s,、]+/u;

/**
 * 入力欄の文字列をハッシュタグの配列にする。
 *
 * **保存する値に `#` は含めない。** 表示や本文の組み立てで付ける方が、
 * 二重に付く事故が起きない。同じタグが並んだら 1 つにまとめ、順序は入力のまま保つ
 */
export function normalizeHashtags(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const piece of input.split(SEPARATORS)) {
    // 先頭の # は何個付いていても落とす
    const tag = piece.replace(/^#+/u, "").trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** ハッシュタグを本文や入力欄に出す形にする */
export function formatHashtags(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

/**
 * テンプレートの `{tags}` に入る値。
 *
 * **自分で区切りを持つ。** テンプレート側に `\n\n{tags}` と書くと、タグが
 * 未設定のときに本文が空行 2 つで終わってしまう
 */
export function tagsVariable(tags: string[]): string {
  const formatted = formatHashtags(tags);
  return formatted === "" ? "" : `\n\n${formatted}`;
}

/**
 * 入力欄の文字列を最大秒数にする。
 *
 * **通らない理由を返す。** 黙って既定値に倒すと、設定したつもりで録画に進む
 */
export function parseMaxClipSec(
  input: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const text = input.trim();
  if (text === "") {
    return { ok: false, message: "最大秒数を入れてください" };
  }

  // Number("") が 0 になるのは上で弾いてある。ここでは形だけを見る
  const value = Number(text);
  if (!Number.isInteger(value)) {
    return { ok: false, message: `最大秒数は整数で入れてください: ${text}` };
  }
  if (!isSettableClipSec(value)) {
    return {
      ok: false,
      message: `最大秒数は ${MIN_CLIP_SEC}〜${MAX_SETTABLE_CLIP_SEC} 秒です: ${value}`,
    };
  }
  return { ok: true, value };
}

/**
 * そのチャンネルに付けるタグ。
 *
 * **`channelId` が欠けていることを許す。** IndexedDB に残っている古いクリップの
 * `meta` には `channelId` が無い。型の上では `string` だが、保存済みの値は
 * 型を保証しない。
 *
 * 設定がまだ無いチャンネルでは、移行前の共通タグを返す。ここを空にすると、
 * 設定パネルには引き継がれたタグが出ているのに投稿本文には入らない、という
 * 食い違いが起きる。**画面の表示と本文の組み立ては同じ関数から引くこと**
 */
export function hashtagsFor(
  settings: Settings,
  channelId: string | undefined,
): string[] {
  if (channelId === undefined || channelId === "") {
    return settings.legacyHashtags;
  }
  return settings.hashtagsByChannel[channelId] ?? settings.legacyHashtags;
}

/** 設定として受け入れられる最大長かどうか。読み込みと入力の両方で使う */
function isSettableClipSec(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CLIP_SEC &&
    value <= MAX_SETTABLE_CLIP_SEC
  );
}

/** 保存されている値が期待する型かどうか */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** チャンネル ID → タグ の対応表として読めるか */
function isTagMap(value: unknown): value is Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isStringArray);
}

/**
 * 保存されている値を既定値の上に重ねる。
 *
 * **型は保証されない。** 古いバージョンが書いたものや、同期で他の端末から
 * 来たものでありうる。型の合う項目だけを採り、合わないものは既定値のまま
 * 使う。握り潰さず理由は残す
 */
export function mergeSettings(stored: unknown): Settings {
  if (stored === null || typeof stored !== "object") return DEFAULT_SETTINGS;

  const source = stored as Record<string, unknown>;
  const settings: Settings = { ...DEFAULT_SETTINGS };

  if (typeof source.template === "string" && source.template !== "") {
    settings.template = source.template;
  } else if (source.template !== undefined) {
    console.warn("[yt-clip] 保存された template が使えないため既定値を使います");
  }

  if (isTagMap(source.hashtagsByChannel)) {
    settings.hashtagsByChannel = source.hashtagsByChannel;
  } else if (source.hashtagsByChannel !== undefined) {
    console.warn(
      "[yt-clip] 保存された hashtagsByChannel が使えないため既定値を使います",
    );
  }

  // 共通タグからチャンネル別への移行。**捨てない。**
  // 保存し直した後は legacyHashtags 側だけが残る (古い hashtags キーは消える)
  if (isStringArray(source.legacyHashtags)) {
    settings.legacyHashtags = source.legacyHashtags;
  } else if (isStringArray(source.hashtags)) {
    settings.legacyHashtags = source.hashtags;
    if (source.hashtags.length > 0) {
      console.info(
        `[yt-clip] 共通のハッシュタグ (${formatHashtags(source.hashtags)}) をチャンネル別設定へ引き継ぎます。保存すると引き継ぎは終わります`,
      );
    }
  } else if (source.hashtags !== undefined) {
    console.warn("[yt-clip] 保存された hashtags が使えないため既定値を使います");
  }

  if (isSettableClipSec(source.maxClipSec)) {
    settings.maxClipSec = source.maxClipSec;
  } else if (source.maxClipSec !== undefined) {
    console.warn(
      `[yt-clip] 保存された maxClipSec が使えないため既定値を使います: ${String(source.maxClipSec)}`,
    );
  }

  return settings;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

/** 一部だけ差し替える。他の項目は保存されているものを残す */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

/**
 * 入力欄 1 つ分の変換結果。
 *
 * **通らない入力を黙って捨てない。** `RangeValidation` と同じ判別可能ユニオンで、
 * 通らなかった理由をそのまま画面に出せる形にする
 */
export type FieldResult =
  | { ok: true; patch: Partial<Settings> }
  | { ok: false; message: string };

export type SettingsField = {
  /** 入力欄を識別する。DOM の id にも使う */
  key: string;
  label: string;
  /**
   * チャンネルが必要な項目かどうか。
   * `channel` の項目は、チャンネルを特定できない画面では入力させない。
   * **パネルが分岐するのはここだけ。** `key` を見て分岐してはいけない
   */
  scope: "global" | "channel";
  /**
   * 入力欄の下に出す短い説明。
   * 文脈と設定の両方で変わるので関数にする (どのチャンネルのタグか、
   * いま引き継ぎ中かどうか)
   */
  hint(settings: Settings, context: SettingsContext): string;
  /** 保存されている値を入力欄の文字列にする */
  toText(settings: Settings, context: SettingsContext): string;
  /**
   * 入力欄の文字列から、設定の一部を作る。
   *
   * **現在の設定を受け取る。** チャンネル別の項目は、他のチャンネル分を
   * 残したまま 1 件だけ差し替える必要がある
   */
  fromText(
    text: string,
    settings: Settings,
    context: SettingsContext,
  ): FieldResult;
};

/**
 * 画面に出す設定項目。
 *
 * パネルはこれを並べるだけで、項目ごとの分岐を持たない
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    key: "hashtags",
    label: "ハッシュタグ",
    scope: "channel",
    hint: (settings, context) => {
      if (context.channel === null) {
        return "チャンネルを特定できないため設定できません";
      }
      const base = `空白区切り。# は省略できます (${context.channel.name} のタグ)`;
      // 引き継ぎ中であることを画面に出す。ログだけでは利用者は見ない
      const inherited =
        settings.hashtagsByChannel[context.channel.id] === undefined &&
        settings.legacyHashtags.length > 0;
      return inherited
        ? `${base}。以前の共通設定から引き継いでいます。保存すると引き継ぎは終わります`
        : base;
    },
    toText: (settings, context) =>
      formatHashtags(hashtagsFor(settings, context.channel?.id)),
    fromText: (text, settings, context) => {
      if (context.channel === null) {
        return {
          ok: false,
          message: "チャンネルを特定できないため保存できません",
        };
      }
      return {
        ok: true,
        patch: {
          // 他のチャンネル分は残す。丸ごと差し替えると、別のチャンネルで
          // 設定したタグが消える
          hashtagsByChannel: {
            ...settings.hashtagsByChannel,
            [context.channel.id]: normalizeHashtags(text),
          },
          // 一度保存すれば引き継ぎは終わり。残すと新しいチャンネルを開くたびに
          // 同じタグが出続け、「チャンネル別のみ」という決定と食い違う
          legacyHashtags: [],
        },
      };
    },
  },
  {
    key: "maxClipSec",
    label: "最大秒数",
    scope: "global",
    hint: () =>
      `${MIN_CLIP_SEC}〜${MAX_SETTABLE_CLIP_SEC} 秒。X の動画の上限が ${MAX_SETTABLE_CLIP_SEC} 秒です`,

    toText: (settings) => String(settings.maxClipSec),
    fromText: (text) => {
      const parsed = parseMaxClipSec(text);
      return parsed.ok
        ? { ok: true, patch: { maxClipSec: parsed.value } }
        : { ok: false, message: parsed.message };
    },
  },
];
