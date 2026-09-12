/**
 * 検証用の断片化 MP4 を組み立てる。
 *
 * `MediaRecorder` が出すものと同じ形 (ftyp + moov[mvex] + moof/mdat の繰り返し)
 * を最小限の box だけで作る。実ファイルを固定データとして持たずに、
 * 断片の境目・キーフレーム・既定値の省略といった条件を狙って作れる。
 */

export type FakeSample = {
  data: Uint8Array;
  duration: number;
  /** 単独で復号できるか (映像のキーフレーム) */
  sync: boolean;
};

export const MOVIE_TIMESCALE = 1000;
export const MEDIA_TIMESCALE = 30000;

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat();
  return [...u32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}

function fullBox(type: string, version: number, flags: number, ...parts: number[][]): number[] {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

/** version 0 の mvhd / mdhd。timescale と duration だけ意味を持たせる */
function versionedHeader(type: string, timescale: number, duration: number, tail: number[]): number[] {
  return fullBox(type, 0, 0, u32(0), u32(0), u32(timescale), u32(duration), tail);
}

export type BuildOptions = {
  /** 断片ごとのサンプル列 */
  fragments: FakeSample[][];
  /**
   * 断片の先頭時刻 (tfdt) に入れる値。
   * 省略すると、直前までのサンプル長の合計をそのまま使う
   */
  decodeTimes?: number[];
  /** サンプル長を trun ではなく trex の既定値で表す */
  useDefaultDuration?: boolean;
  /** 映像トラックの幅と高さ。0 にすると音声トラック扱いになる */
  width?: number;
  height?: number;
  /** 表示変換行列の最後の要素を 0 にする (Chromium が実際に踏むバグの再現) */
  brokenMatrix?: boolean;
};

export function buildFragmentedMp4(
  options: BuildOptions,
): Uint8Array<ArrayBuffer> {
  const {
    fragments,
    decodeTimes,
    useDefaultDuration = false,
    width = 1280,
    height = 720,
    brokenMatrix = true,
  } = options;
  const allSamples = fragments.flat();
  const defaultDuration = useDefaultDuration ? (allSamples[0]?.duration ?? 0) : 0;

  // stsd は remux がそのまま持ち越すだけなので、中身は識別できれば足りる
  const stsd = fullBox("stsd", 0, 0, u32(1), box("avc1", [0xaa, 0xbb, 0xcc, 0xdd]));
  const stbl = box("stbl", stsd);
  const minf = box("minf", fullBox("vmhd", 0, 1, [0, 0, 0, 0, 0, 0, 0, 0]), box("dinf"), stbl);
  // mdhd は長さ 0 (断片化 MP4 の目印)
  const mdhd = versionedHeader("mdhd", MEDIA_TIMESCALE, 0, [0x55, 0xc4, 0, 0]);
  const mdia = box("mdia", mdhd, box("hdlr", u32(0), u32(0), [..."vide"].map((c) => c.charCodeAt(0))), minf);

  // tkhd: version 0。track_id の後に reserved が入り、その次が duration。
  // 行列は Chromium の muxer が captureStream 由来のフレームで作るものと
  // 同じ形にする (最後の要素 w がゼロのまま = 実機で踏むバグ)
  const matrix = [
    ...u32(0x00010000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x00010000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(brokenMatrix ? 0 : 0x40000000),
  ];
  const tkhd = fullBox(
    "tkhd", 0, 7,
    u32(0), u32(0), u32(1), u32(0), u32(0),
    new Array(16).fill(0),
    matrix,
    u32(width << 16), u32(height << 16),
  );
  const trak = box("trak", tkhd, mdia);

  const mvhd = versionedHeader("mvhd", MOVIE_TIMESCALE, 0, new Array(80).fill(0));
  const trex = fullBox("trex", 0, 0, u32(1), u32(1), u32(defaultDuration), u32(0), u32(0));
  const moov = box("moov", mvhd, trak, box("mvex", trex));

  const brand = [..."isom"].map((c) => c.charCodeAt(0));
  const head = box("ftyp", brand, u32(512), brand);
  const out: number[] = [...head, ...moov];

  let elapsed = 0;
  fragments.forEach((samples, index) => {
    const decodeTime = decodeTimes?.[index] ?? elapsed;

    // trun のフラグ: data_offset / サンプル長 / サイズ / フラグ
    const trunFlags = 0x000001 | (useDefaultDuration ? 0 : 0x000100) | 0x000200 | 0x000400;
    const perSample = samples.flatMap((sample) => [
      ...(useDefaultDuration ? [] : u32(sample.duration)),
      ...u32(sample.data.length),
      // 単独で復号できないサンプルには専用のビットを立てる
      ...u32(sample.sync ? 0 : 0x00010000),
    ]);

    // data_offset は moof の先頭からの距離。moof を組んでから確定する
    const withOffset = (offset: number): number[] =>
      box(
        "moof",
        fullBox("mfhd", 0, 0, u32(index + 1)),
        box(
          "traf",
          // tfhd: default-base-is-moof だけを立て、位置は moof 先頭から数える
          fullBox("tfhd", 0, 0x020000, u32(1)),
          fullBox("tfdt", 0, 0, u32(decodeTime)),
          fullBox("trun", 0, trunFlags, u32(samples.length), u32(offset), perSample),
        ),
      );

    const moofSize = withOffset(0).length;
    const moof = withOffset(moofSize + 8); // mdat のヘッダ 8 バイトを足した先が中身
    const payload = samples.flatMap((sample) => [...sample.data]);

    out.push(...moof, ...box("mdat", payload));
    elapsed = decodeTime + samples.reduce((sum, s) => sum + s.duration, 0);
  });

  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}
