import type { ClipRange, VideoMeta } from "@/shared/types";

export type StoredClip = {
  id: string;
  blob: Blob;
  mimeType: string;
  range: ClipRange;
  meta: VideoMeta;
  /** 保存時刻 (UTC epoch ミリ秒)。動画内の再生位置とは別物 */
  createdAt: number;
};

export class ClipNotFoundError extends Error {
  constructor(id: string) {
    super(`クリップが見つかりません: ${id}`);
    this.name = "ClipNotFoundError";
  }
}

const DB_NAME = "yt-clip";
const DB_VERSION = 1;
const STORE = "clips";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** トランザクションを 1 つ張って実行し、完了を待つ */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** クリップを保存する。MVP は最新 1 件のみ保持するため既存は破棄する */
export async function saveClip(clip: StoredClip): Promise<void> {
  await clearClips();
  await withStore("readwrite", (store) => store.put(clip));
}

/** クリップを取り出す。存在しない ID の参照はバグなので throw する */
export async function getClip(id: string): Promise<StoredClip> {
  const found = await withStore<StoredClip | undefined>("readonly", (store) =>
    store.get(id),
  );
  if (found === undefined) {
    throw new ClipNotFoundError(id);
  }
  return found;
}

export async function clearClips(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
