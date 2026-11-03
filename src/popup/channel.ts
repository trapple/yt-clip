import type { ChannelResponse, Message } from "@/shared/messages";
import type { SettingsContext } from "@/shared/settings";

/**
 * 応答を待つ上限。content script は同期で答えるので、これを超えるのは受け手が答えない (固まっている) ときだけ。
 * **待ち続けない**: 待つ間は設定を保存できない (settings-in-popup spec §2)
 */
export const CHANNEL_TIMEOUT_MS = 1000;

export type ChannelDeps = {
  /** いまの窓の前のタブの id。無ければ undefined */
  activeTabId(): Promise<number | undefined>;
  /** タブの content script へ送る。受け手が居なければ reject する */
  sendToTab(tabId: number, message: Message): Promise<unknown>;
  timeoutMs: number;
};

const defaultDeps: ChannelDeps = {
  // `tabs` 権限なしでも id は返る (url / title は返らない。要らない)
  activeTabId: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  timeoutMs: CHANNEL_TIMEOUT_MS,
};

function isChannelResponse(value: unknown): value is ChannelResponse {
  if (value === null || typeof value !== "object" || !("channel" in value)) return false;
  const channel = value.channel;
  if (channel === null) return true;
  return (
    typeof channel === "object" &&
    "id" in channel &&
    "name" in channel &&
    typeof channel.id === "string" &&
    channel.id !== "" &&
    typeof channel.name === "string"
  );
}

/**
 * 設定の文脈 = いま開いているタブの動画のチャンネル (spec §2)。**reject しない。** 分からなければ channel: null
 * (ハッシュタグ欄だけ入力できなくなり、ほかの項目は保存できる)。分からないのは: YouTube 以外のタブ・受け手が居ない
 * (オフ / 拡張の更新後に読み込み直していない)・動画の再生画面以外・応答が上限までに来ない・応答の形が違う
 */
export async function readTabContext(overrides: Partial<ChannelDeps> = {}): Promise<SettingsContext> {
  const deps: ChannelDeps = { ...defaultDeps, ...overrides };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tabId = await deps.activeTabId();
    if (tabId === undefined) return { channel: null };
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deps.timeoutMs);
    });
    const response = await Promise.race([
      deps.sendToTab(tabId, { type: "channel/get" } satisfies Message),
      timeout,
    ]);
    return { channel: isChannelResponse(response) ? response.channel : null };
  } catch {
    // 受け手が居ない (YouTube 以外・オフ) は普通に起きる。騒がない
    return { channel: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
