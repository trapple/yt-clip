import "fake-indexeddb/auto";
import { makeVideoMeta } from "../helpers/fixtures";
import { beforeEach, describe, expect, test } from "vitest";
import {
  ClipNotFoundError,
  clearClips,
  getClip,
  saveClip,
  type StoredClip,
} from "@/background/storage";

function makeClip(id: string): StoredClip {
  return {
    id,
    blob: new Blob(["ダミー動画データ"], { type: "video/mp4" }),
    mimeType: "video/mp4",
    segments: [{ startSec: 10, endSec: 40 }],
    meta: makeVideoMeta(),
    createdAt: Date.UTC(2026, 8, 10, 3, 0, 0),
  };
}

describe("クリップ保管", () => {
  beforeEach(async () => {
    await clearClips();
  });

  test("保存したクリップを ID で取り出せる", async () => {
    await saveClip(makeClip("clip-1"));
    const found = await getClip("clip-1");

    expect(found.id).toBe("clip-1");
    expect(found.mimeType).toBe("video/mp4");
    expect(found.segments).toEqual([{ startSec: 10, endSec: 40 }]);
    expect(found.meta).toEqual(makeVideoMeta());
    expect(found.createdAt).toBe(Date.UTC(2026, 8, 10, 3, 0, 0));
    expect(await found.blob.text()).toBe("ダミー動画データ");
  });

  test("新しいクリップを保存すると古いものは消える", async () => {
    await saveClip(makeClip("clip-1"));
    await saveClip(makeClip("clip-2"));

    await expect(getClip("clip-2")).resolves.toMatchObject({ id: "clip-2" });
    await expect(getClip("clip-1")).rejects.toThrow(ClipNotFoundError);
  });

  test("存在しない ID は握り潰さず throw する", async () => {
    await expect(getClip("missing")).rejects.toThrow(ClipNotFoundError);
  });

  test("clearClips で全件消える", async () => {
    await saveClip(makeClip("clip-1"));
    await clearClips();

    await expect(getClip("clip-1")).rejects.toThrow(ClipNotFoundError);
  });

  test("保存が失敗しても直前のクリップは失われない (アトミック性)", async () => {
    await saveClip(makeClip("clip-1"));

    // 容量超過などで put のコミットが失敗するケースを模擬する。
    // IDBObjectStore.prototype.put を差し替え、実際に put request は
    // 発行しつつ、それを含むトランザクションを次のマイクロタスクで
    // 強制 abort させる。put だけをピンポイントで失敗させることで、
    // 「clear() は別トランザクションで先に確定済みなので消えない」
    // という誤った実装 (clear と put が別トランザクション) では
    // このテストが red になり、同一トランザクションで両方 abort される
    // 正しい実装だけが green になる。
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = originalPut.apply(this, args);
      const tx = this.transaction;
      queueMicrotask(() => {
        try {
          tx.abort();
        } catch {
          // 既に完了/中断済みなら何もしない
        }
      });
      return request;
    };

    try {
      await expect(saveClip(makeClip("clip-2"))).rejects.toThrow();
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    await expect(getClip("clip-1")).resolves.toMatchObject({ id: "clip-1" });
    await expect(getClip("clip-2")).rejects.toThrow(ClipNotFoundError);
  });
});

describe("複数区間より前に保存されたクリップ", () => {
  test("range 1 つ分の区間として読む", async () => {
    // 投稿には先頭区間の秒しか要らないので、読み替えれば使える
    await saveClip({
      id: "legacy-1",
      blob: new Blob(["x"]),
      mimeType: "video/mp4",
      range: { startSec: 10, endSec: 40 },
      meta: makeVideoMeta(),
      createdAt: 0,
    } as unknown as StoredClip);

    const found = await getClip("legacy-1");

    expect(found.segments).toEqual([{ startSec: 10, endSec: 40 }]);
    // 読み替えた後の形だけを渡す。残すと型と実体がずれる
    expect("range" in found).toBe(false);
  });

  test("区間も range も無ければ握り潰さず throw する", async () => {
    await saveClip({
      id: "broken-1",
      blob: new Blob(["x"]),
      mimeType: "video/mp4",
      meta: makeVideoMeta(),
      createdAt: 0,
    } as unknown as StoredClip);

    await expect(getClip("broken-1")).rejects.toThrow(/区間を持たない/u);
  });
});
