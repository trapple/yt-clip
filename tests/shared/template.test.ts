import { describe, expect, test } from "vitest";
import { makeVideoMeta } from "../helpers/fixtures";
import {
  DEFAULT_TEMPLATE,
  buildYouTubeUrl,
  renderTemplate,
} from "@/shared/template";
import type { ClipRange } from "@/shared/types";

const meta = makeVideoMeta({ videoId: "dQw4w9WgXcQ", title: "サンプル動画" });
const range: ClipRange = { startSec: 75.4, endSec: 105.4 };
const segments = [range];

describe("buildYouTubeUrl", () => {
  test("開始秒つきの短縮 URL を作る", () => {
    expect(buildYouTubeUrl("dQw4w9WgXcQ", 75.4)).toBe(
      "https://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("先頭からの場合も t=0 を付ける", () => {
    expect(buildYouTubeUrl("abc", 0)).toBe("https://youtu.be/abc?t=0");
  });
});

describe("renderTemplate", () => {
  test("既定テンプレートはタイトルと URL を空行で挟む", () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, meta, segments)).toBe(
      "サンプル動画\n\nhttps://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("全変数を展開する", () => {
    const template = "{title}/{videoId}/{start}/{end}/{duration}/{url}";
    expect(renderTemplate(template, meta, segments)).toBe(
      "サンプル動画/dQw4w9WgXcQ/1:15/1:45/30/https://youtu.be/dQw4w9WgXcQ?t=75",
    );
  });

  test("同じ変数を複数回使える", () => {
    expect(renderTemplate("{title} {title}", meta, segments)).toBe(
      "サンプル動画 サンプル動画",
    );
  });

  test("変数を含まないテンプレートはそのまま返す", () => {
    expect(renderTemplate("固定文言", meta, segments)).toBe("固定文言");
  });

  test("未知の変数は握り潰さず throw する", () => {
    expect(() => renderTemplate("{channel}", meta, segments)).toThrow(
      "テンプレートに未知の変数があります: {channel}",
    );
  });
});

describe("複数区間の本文", () => {
  const two = [
    { startSec: 83, endSec: 98 },
    { startSec: 242, endSec: 250 },
  ];

  test("URL と開始は先頭区間から取る", () => {
    expect(renderTemplate("{url} {start}", meta, two)).toBe(
      "https://youtu.be/dQw4w9WgXcQ?t=83 1:23",
    );
  });

  test("終了は最終区間から取る", () => {
    expect(renderTemplate("{end}", meta, two)).toBe("4:10");
  });

  test("長さは合計。元動画上の幅ではない", () => {
    // 15 + 8 = 23。元動画上の幅 (242-83=159) ではない
    expect(renderTemplate("{duration}", meta, two)).toBe("23");
  });

  test("区間が無ければ握り潰さず throw する", () => {
    expect(() => renderTemplate("{url}", meta, [])).toThrow(
      /区間を持たないクリップ/u,
    );
  });
});
