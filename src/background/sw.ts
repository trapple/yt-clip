import { ensureOffscreen, getStreamId } from "@/background/capture";
import { createRouter, type RouterSnapshot } from "@/background/router";
import { getClip } from "@/background/storage";
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
      getClip,
      sendToRuntime: (message) => {
        // popup や offscreen が開いていないだけなら受け手不在は正常
        void chrome.runtime.sendMessage(message).catch(() => undefined);
      },
      sendToTab: (tabId, message) => {
        void chrome.tabs.sendMessage(tabId, message).catch((error: unknown) => {
          // content script がまだ居ない場合もあるが、大きな payload が
          // 送れなかった場合もここに来る。理由を残さないと区別できない
          console.error(
            "タブへの送信に失敗しました",
            tabId,
            message.type,
            error,
          );
        });
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
      startTimer: (ms, onFire) => {
        const id = setTimeout(onFire, ms);
        return () => clearTimeout(id);
      },
    },
    snapshot,
  ),
);

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void ready.then(async (router) => {
    if (message.type !== "state/get") {
      await router.handle(message, sender.tab?.id);
    }
    // 常に最新の状態を返す。受け付けられなかった操作では状態が変わらず
    // state/changed も飛ばないため、送り手が結果を知る手段がこれしかない
    sendResponse({ state: router.getState() });
  });
  // 応答が非同期であることを Chrome に伝える
  return true;
});
