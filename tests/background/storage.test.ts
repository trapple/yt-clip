import "fake-indexeddb/auto";
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
    range: { startSec: 10, endSec: 40 },
    meta: { videoId: "abc123", title: "テスト動画" },
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
    expect(found.range).toEqual({ startSec: 10, endSec: 40 });
    expect(found.meta).toEqual({ videoId: "abc123", title: "テスト動画" });
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
});
