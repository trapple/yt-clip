import { describe, expect, test } from "vitest";
import { RemuxError, remuxToProgressiveMp4 } from "@/content/remux";
import {
  MEDIA_TIMESCALE,
  MOVIE_TIMESCALE,
  buildFragmentedMp4,
  type FakeSample,
} from "../helpers/fragmented-mp4";

function sample(byte: number, duration: number, sync = false): FakeSample {
  return { data: new Uint8Array([byte, byte, byte]), duration, sync };
}

/** box を辿って中身を取り出す。テストが構造を直接確かめるために使う */
function findBox(data: Uint8Array, type: string): Uint8Array | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const walk = (start: number, end: number): Uint8Array | null => {
    let at = start;
    while (at + 8 <= end) {
      const size = dv.getUint32(at);
      const name = String.fromCharCode(...data.subarray(at + 4, at + 8));
      if (size < 8) return null;
      if (name === type) return data.subarray(at + 8, at + size);
      // 中身に子 box を持ちうるものだけ降りる
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(name)) {
        const found = walk(at + 8, at + size);
        if (found !== null) return found;
      }
      at += size;
    }
    return null;
  };
  return walk(0, data.length);
}

function u32At(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
}

describe("remuxToProgressiveMp4", () => {
  test("断片を畳んで moof と mvex を落とす", () => {
    // X は断片化 MP4 を受け付けない。実機で 3 通り試して確定した条件
    const input = buildFragmentedMp4({
      fragments: [
        [sample(1, 100, true), sample(2, 100)],
        [sample(3, 100), sample(4, 100)],
      ],
    });
    const out = remuxToProgressiveMp4(input);

    const text = String.fromCharCode(...out);
    expect(text).not.toContain("moof");
    expect(text).not.toContain("mvex");
    expect(findBox(out, "mdat")).not.toBeNull();
  });

  test("サンプルの中身を順番どおり 1 つの mdat へ集める", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true)], [sample(2, 100)], [sample(3, 100)]],
    });
    const mdat = findBox(remuxToProgressiveMp4(input), "mdat");

    expect(Array.from(mdat ?? [])).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  test("本当の長さを moov に書き込む", () => {
    // 断片化 MP4 の moov は長さ 0 のまま。これを埋めないと変換側が扱えない
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 3000, true), sample(2, 3000)]],
    });
    const out = remuxToProgressiveMp4(input);

    // version+flags, 作成, 更新, timescale と続いた次が長さ
    const mdhd = findBox(out, "mdhd");
    expect(u32At(mdhd!, 16)).toBe(6000);

    // mvhd は動画全体の時間軸。6000 / 30000 秒 = 0.2 秒 = 200
    const mvhd = findBox(out, "mvhd");
    expect(u32At(mvhd!, 16)).toBe(Math.round((6000 / MEDIA_TIMESCALE) * MOVIE_TIMESCALE));
  });

  test("サンプルの大きさと数を stsz に並べる", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true), sample(2, 100)], [sample(3, 100)]],
    });
    const stsz = findBox(remuxToProgressiveMp4(input), "stsz");

    expect(u32At(stsz!, 8)).toBe(3);
    expect([u32At(stsz!, 12), u32At(stsz!, 16), u32At(stsz!, 20)]).toEqual([3, 3, 3]);
  });

  test("同じ長さが続く区間を stts でまとめる", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true), sample(2, 100), sample(3, 250)]],
    });
    const stts = findBox(remuxToProgressiveMp4(input), "stts");

    expect(u32At(stts!, 4)).toBe(2);
    expect([u32At(stts!, 8), u32At(stts!, 12)]).toEqual([2, 100]);
    expect([u32At(stts!, 16), u32At(stts!, 20)]).toEqual([1, 250]);
  });

  test("単独で復号できるサンプルを stss に書く", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true), sample(2, 100)], [sample(3, 100, true)]],
    });
    const stss = findBox(remuxToProgressiveMp4(input), "stss");

    expect(u32At(stss!, 4)).toBe(2);
    expect([u32At(stss!, 8), u32At(stss!, 12)]).toEqual([1, 3]);
  });

  test("全部が復号できるなら stss を省く", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true), sample(2, 100, true)]],
    });
    expect(findBox(remuxToProgressiveMp4(input), "stss")).toBeNull();
  });

  test("mdat の位置を stco が指している", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(9, 100, true), sample(8, 100)]],
    });
    const out = remuxToProgressiveMp4(input);
    const offset = u32At(findBox(out, "stco")!, 8);

    // その位置から読んだ中身が、実際のサンプルと一致すること
    expect(Array.from(out.subarray(offset, offset + 6))).toEqual([9, 9, 9, 8, 8, 8]);
  });

  test("断片の境目の隙間を最後のサンプルへ寄せる", () => {
    // tfdt が「断片の先頭時刻」を持つ。サンプル長の合計と食い違うとき、
    // 放っておくとずれが積み上がって映像と音声が合わなくなる
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 100, true), sample(2, 100)], [sample(3, 100, true)]],
      decodeTimes: [0, 250], // 合計 200 のはずが次は 250 から始まる
    });
    const stts = findBox(remuxToProgressiveMp4(input), "stts");

    // 2 本目の長さが 100 → 150 に伸びて隙間を埋める
    expect([u32At(stts!, 8), u32At(stts!, 12)]).toEqual([1, 100]);
    expect([u32At(stts!, 16), u32At(stts!, 20)]).toEqual([1, 150]);
  });

  test("サンプル長が省かれていれば trex の既定値で補う", () => {
    const input = buildFragmentedMp4({
      fragments: [[sample(1, 512, true), sample(2, 512)]],
      useDefaultDuration: true,
    });
    const stts = findBox(remuxToProgressiveMp4(input), "stts");

    expect([u32At(stts!, 8), u32At(stts!, 12)]).toEqual([2, 512]);
  });

  test("stsd はそのまま持ち越す", () => {
    // コーデックの設定が入っている。作り直すと再生できなくなる
    const input = buildFragmentedMp4({ fragments: [[sample(1, 100, true)]] });
    const stsd = findBox(remuxToProgressiveMp4(input), "stsd");

    expect(String.fromCharCode(...stsd!.subarray(12, 16))).toBe("avc1");
    expect(Array.from(stsd!.subarray(16, 20))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  test("既に通常の MP4 ならそのまま返す", () => {
    const input = buildFragmentedMp4({ fragments: [[sample(1, 100, true)]] });
    const once = remuxToProgressiveMp4(input);
    expect(remuxToProgressiveMp4(once)).toBe(once);
  });

  test("MP4 でないデータは握り潰さず throw する", () => {
    const notMp4 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => remuxToProgressiveMp4(notMp4)).toThrow(RemuxError);
  });
});
