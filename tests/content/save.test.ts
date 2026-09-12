// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";
import { saveToDownloads, type SaveDeps } from "@/content/save";

function makeDeps(): {
  anchor: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; style: { display: string } };
  revoked: string[];
  deps: SaveDeps;
} {
  const anchor = {
    href: "",
    download: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const revoked: string[] = [];
  return {
    anchor,
    revoked,
    deps: {
      createObjectURL: (): string => "blob:fake",
      revokeObjectURL: (url: string): void => {
        revoked.push(url);
      },
      createAnchor: () => anchor as unknown as HTMLAnchorElement,
    },
  };
}

describe("saveToDownloads", () => {
  test("ファイル名を付けて保存する", () => {
    const { anchor, deps } = makeDeps();

    saveToDownloads(
      new Uint8Array([1, 2, 3]),
      "yt-clip-abc123-10s.mp4",
      "video/mp4",
      deps,
    );

    expect(anchor.download).toBe("yt-clip-abc123-10s.mp4");
    expect(anchor.href).toBe("blob:fake");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  test("使い終わった URL を解放する", () => {
    // 解放しないと、録るたびにメモリを掴んだままになる
    const { revoked, deps } = makeDeps();

    saveToDownloads(new Uint8Array([1]), "a.mp4", "video/mp4", deps);

    expect(revoked).toEqual(["blob:fake"]);
  });

  test("保存できなくても投げない", () => {
    // 録画は実時間のコストを払い終えている。保存は後処理に過ぎないため、
    // ここで投げると録画ごと失われる
    const { deps } = makeDeps();
    const broken: SaveDeps = {
      ...deps,
      createAnchor: () => {
        throw new Error("要素を作れません");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      saveToDownloads(new Uint8Array([1]), "a.mp4", "video/mp4", broken),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("録画を保存できませんでした"),
    );
    warn.mockRestore();
  });

  test("途中で失敗しても URL は解放する", () => {
    const { revoked, deps } = makeDeps();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    saveToDownloads(new Uint8Array([1]), "a.mp4", "video/mp4", {
      ...deps,
      createAnchor: () => {
        throw new Error("要素を作れません");
      },
    });

    expect(revoked).toEqual(["blob:fake"]);
    warn.mockRestore();
  });
});
