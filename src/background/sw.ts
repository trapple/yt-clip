import { createRouter, type RouterSnapshot } from "@/background/router";
import { getClip, saveClip } from "@/background/storage";
import type { Message } from "@/shared/messages";
import { loadSettings } from "@/shared/settings";

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
      saveClip,
      getClip,
      sendToRuntime: (message) => {
        // popup が開いていないだけなら受け手不在は正常
        void chrome.runtime.sendMessage(message).catch(() => undefined);
      },
      // 失敗は握り潰さず router へ返す。content script が居ない場合も、
      // 大きな payload が送れなかった場合もここで reject する。
      // router は録画の工程に応じて tab-lost / ダウンロードへの退避に落とす
      sendToTab: async (tabId, message) => {
        await chrome.tabs.sendMessage(tabId, message);
      },
      openComposeTab: async () => {
        const tab = await chrome.tabs.create({ url: COMPOSE_URL });
        if (tab.id === undefined) {
          throw new Error("投稿タブを開けませんでした");
        }
        return tab.id;
      },
      loadSettings,
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

// 録画対象のタブが閉じられると、録画の続きを進める相手が居なくなる。
// service worker は数十秒で止まるためタイマーによる救済は当てにできず、
// 閉じられたことを知る経路はこのイベントしかない
chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then((router) => router.handleTabRemoved(tabId));
});

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
