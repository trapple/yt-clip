import { ensureOffscreen, getStreamId } from "@/background/capture";
import { createRouter, type RouterSnapshot } from "@/background/router";
import { getClip, saveClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import { DEFAULT_TEMPLATE } from "@/shared/template";

const SESSION_KEY = "router-snapshot";
const COMPOSE_URL = "https://x.com/compose/post";

async function loadSnapshot(): Promise<RouterSnapshot | undefined> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] as RouterSnapshot | undefined;
}

// service worker は停止しうるため、保存済みの状態から復元して組み立てる
const ready = loadSnapshot().then((snapshot) =>
  createRouter(
    {
      ensureOffscreen: () => ensureOffscreen(),
      getStreamId: (tabId) => getStreamId(tabId),
      saveClip,
      getClip,
      sendToRuntime: (message) => {
        // popup や offscreen が開いていないだけなら受け手不在は正常
        void chrome.runtime.sendMessage(message).catch(() => undefined);
      },
      sendToTab: (tabId, message) => {
        void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
      },
      openComposeTab: async () => {
        const tab = await chrome.tabs.create({ url: COMPOSE_URL });
        if (tab.id === undefined) {
          throw new Error("投稿タブを開けませんでした");
        }
        return tab.id;
      },
      loadTemplate: async () => {
        const stored = await chrome.storage.sync.get("template");
        const template: unknown = stored.template;
        return typeof template === "string" && template !== ""
          ? template
          : DEFAULT_TEMPLATE;
      },
      now: () => Date.now(),
      persist: async (snapshot) => {
        await chrome.storage.session.set({ [SESSION_KEY]: snapshot });
      },
    },
    snapshot,
  ),
);

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void ready.then(async (router) => {
    if (message.type === "state/get") {
      sendResponse({ state: router.getState() });
      return;
    }
    await router.handle(message, sender.tab?.id);
    sendResponse({ ok: true });
  });
  // 応答が非同期であることを Chrome に伝える
  return true;
});
