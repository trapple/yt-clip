import type { ClipRange, VideoMeta } from "@/shared/types";

export type StoredClip = {
  id: string;
  blob: Blob;
  mimeType: string;
  /** 出力クリップを構成する区間列。古いレコードは `range` しか持たない */
  segments: ClipRange[];
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

/**
 * トランザクションを 1 つ張って実行し、**コミット完了まで待つ**。
 *
 * `request.onsuccess` で解決してはいけない。リクエスト成功とコミット確定は別で、
 * 容量超過などでコミット段階に abort した場合、先に解決済みの Promise には
 * その失敗が反映されず、書き込めていないのに成功として扱われてしまう。
 * 呼び出し側が結果を受け取れるよう、値は `onsuccess` で拾い `oncomplete` で返す。
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result: T;

      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("トランザクションが中断されました"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * クリップを保存する。MVP は最新 1 件のみ保持するため既存は破棄する。
 *
 * 削除と保存は **同一トランザクション**で行う。別トランザクションに分けると、
 * 削除に成功した後で保存が失敗したとき (動画 Blob は数十 MB になり容量超過は
 * 現実に起きうる) 旧クリップも新クリップも失われる。録画は実時間コストを
 * 払った成果物なので、失敗しても直前のクリップは残さなければならない。
 */
export async function saveClip(clip: StoredClip): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear();
      store.put(clip);

      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("クリップを保存できませんでした"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 複数区間に対応する前に保存されたクリップの形 */
type LegacyClip = Omit<StoredClip, "segments"> & { range?: ClipRange };

/**
 * 保存されているクリップを読む形に整える。
 *
 * **古いレコードを黙って落とさない。** `segments` を持たないのは複数区間に
 * 対応する前に録ったクリップで、`range` 1 つ分として読めば投稿には足りる。
 * 理由は残す
 */
function migrateClip(stored: StoredClip | LegacyClip): StoredClip {
  if ("segments" in stored && Array.isArray(stored.segments)) {
    return stored;
  }
  const legacy = stored as LegacyClip;
  if (legacy.range === undefined) {
    throw new Error(`区間を持たないクリップです: ${legacy.id}`);
  }
  console.info(
    `[yt-clip] 区間を持たない古いクリップを 1 区間として読みました: ${legacy.id}`,
  );
  // **`range` は落とす。** 残すと `StoredClip` 型に無いプロパティを持った値が
  // 出回り、型と実体がずれる。読み替えた後の形だけを渡す
  const { range, ...rest } = legacy;
  return { ...rest, segments: [range] };
}

/** クリップを取り出す。存在しない ID の参照はバグなので throw する */
export async function getClip(id: string): Promise<StoredClip> {
  const found = await withStore<StoredClip | LegacyClip | undefined>(
    "readonly",
    (store) => store.get(id),
  );
  if (found === undefined) {
    throw new ClipNotFoundError(id);
  }
  return migrateClip(found);
}

export async function clearClips(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
