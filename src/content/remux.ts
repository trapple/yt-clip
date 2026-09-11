/**
 * 断片化 MP4 を通常の MP4 に組み直す。
 *
 * `MediaRecorder` の MP4 出力は必ず断片化 MP4 (ftyp + moov + moof/mdat の
 * 繰り返し) になり、moov には長さが 0 のまま `mvex` だけが入る。X はこの形式を
 * 受け付けず、アップロード後の変換で失敗する ("問題が発生しました" /
 * "Internal error [131]")。実機で次の 3 通りを試して切り分け済み:
 *
 * | 断片化 | 長さ情報 | X |
 * |--------|----------|---|
 * | あり   | なし     | 失敗 |
 * | あり   | あり     | 失敗 |
 * | なし   | あり     | 成功 |
 *
 * つまり長さを埋めるだけでは足りず、断片を畳んで 1 つの `mdat` と
 * 完全な `stbl` を持つ通常の MP4 にする必要がある。
 */

/** 1 サンプル (映像 1 フレーム / 音声 1 フレーム) の位置と属性 */
type Sample = {
  /** 入力データ内での位置 */
  offset: number;
  size: number;
  duration: number;
  /** 表示時刻と復号時刻のずれ。B フレームが無ければ 0 */
  ctsOffset: number;
  /** 単独で復号できるか (映像のキーフレーム) */
  sync: boolean;
};

/** 1 つの断片が持つ、そのトラック分のサンプル */
type Fragment = {
  /** 断片の先頭サンプルの復号時刻 (tfdt)。無ければ null */
  decodeTime: number | null;
  samples: Sample[];
};

type BoxRef = {
  type: string;
  /** box 先頭 (サイズ欄) の位置 */
  start: number;
  /** サイズ欄と型欄の合計。中身はここから始まる */
  headerSize: number;
  /** ヘッダを含む box 全体の長さ */
  size: number;
};

/** trun が持つフラグ。どの項目がサンプルごとに並ぶかを決める */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

/** tfhd が持つフラグ */
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

/** サンプルフラグのうち「単独では復号できない」を示すビット */
const SAMPLE_IS_NON_SYNC = 0x00010000;

export class RemuxError extends Error {
  constructor(message: string) {
    super(`MP4 を組み直せませんでした: ${message}`);
    this.name = "RemuxError";
  }
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** 指定範囲に並ぶ box を読み出す */
function readBoxes(data: Uint8Array, start: number, end: number): BoxRef[] {
  const dv = view(data);
  const boxes: BoxRef[] = [];
  let cursor = start;

  while (cursor + 8 <= end) {
    let size = dv.getUint32(cursor);
    let headerSize = 8;

    if (size === 1) {
      // 64bit 長。上位 32bit は 4GB 超の box でしか使われない
      const high = dv.getUint32(cursor + 8);
      const low = dv.getUint32(cursor + 12);
      if (high !== 0) throw new RemuxError("4GB を超える box は扱えません");
      size = low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }

    if (size < headerSize || cursor + size > end) {
      throw new RemuxError(`box の長さが壊れています (位置 ${cursor})`);
    }

    boxes.push({
      type: String.fromCharCode(...data.subarray(cursor + 4, cursor + 8)),
      start: cursor,
      headerSize,
      size,
    });
    cursor += size;
  }

  return boxes;
}

function findBox(boxes: BoxRef[], type: string): BoxRef | undefined {
  return boxes.find((box) => box.type === type);
}

function requireBox(boxes: BoxRef[], type: string, where: string): BoxRef {
  const box = findBox(boxes, type);
  if (box === undefined) throw new RemuxError(`${where} に ${type} がありません`);
  return box;
}

/** box の中身 (ヘッダを除く) に並ぶ子 box を読む */
function childrenOf(data: Uint8Array, box: BoxRef): BoxRef[] {
  return readBoxes(data, box.start + box.headerSize, box.start + box.size);
}

function bytesOf(data: Uint8Array, box: BoxRef): Uint8Array {
  return data.subarray(box.start, box.start + box.size);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** box を組み立てる */
function buildBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, body.length + 8);
  for (let i = 0; i < 4; i += 1) header[4 + i] = type.charCodeAt(i);
  return concat([header, body]);
}

/** version と flags だけの前置きを持つ box (full box) */
function buildFullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >> 16) & 0xff;
  head[2] = (flags >> 8) & 0xff;
  head[3] = flags & 0xff;
  return buildBox(type, head, ...parts);
}

/** trex が持つ、断片ごとに省略されうる既定値 */
type TrackDefaults = {
  duration: number;
  size: number;
  flags: number;
};

function readTrackDefaults(
  data: Uint8Array,
  moov: BoxRef,
): Map<number, TrackDefaults> {
  const defaults = new Map<number, TrackDefaults>();
  const mvex = findBox(childrenOf(data, moov), "mvex");
  if (mvex === undefined) return defaults;

  const dv = view(data);
  for (const trex of childrenOf(data, mvex)) {
    if (trex.type !== "trex") continue;
    const at = trex.start + trex.headerSize + 4; // version と flags を飛ばす
    defaults.set(dv.getUint32(at), {
      duration: dv.getUint32(at + 8),
      size: dv.getUint32(at + 12),
      flags: dv.getUint32(at + 16),
    });
  }
  return defaults;
}

/** 1 つの moof を読んで、各トラックのサンプルを集める */
function readFragment(
  data: Uint8Array,
  moof: BoxRef,
  defaults: Map<number, TrackDefaults>,
  into: Map<number, Fragment[]>,
): void {
  const dv = view(data);

  for (const traf of childrenOf(data, moof)) {
    if (traf.type !== "traf") continue;

    const children = childrenOf(data, traf);
    const tfhd = requireBox(children, "tfhd", "traf");
    let at = tfhd.start + tfhd.headerSize;
    const tfhdFlags = dv.getUint32(at) & 0x00ffffff;
    at += 4;
    const trackId = dv.getUint32(at);
    at += 4;

    // 既定では「サンプルの位置は moof の先頭から数える」
    let baseOffset = moof.start;
    if ((tfhdFlags & TFHD_BASE_DATA_OFFSET) !== 0) {
      const high = dv.getUint32(at);
      if (high !== 0) throw new RemuxError("4GB を超える位置は扱えません");
      baseOffset = dv.getUint32(at + 4);
      at += 8;
    } else if ((tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF) === 0) {
      // どちらの指定も無い場合、本来は直前の断片の続きから数える。
      // MediaRecorder の出力では起きないため、黙って誤った位置を読むより止める
      throw new RemuxError("サンプル位置の基準が特定できません");
    }

    if ((tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) !== 0) at += 4;

    const fallback = defaults.get(trackId) ?? { duration: 0, size: 0, flags: 0 };
    let defaultDuration = fallback.duration;
    let defaultSize = fallback.size;
    let defaultFlags = fallback.flags;

    if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION) !== 0) {
      defaultDuration = dv.getUint32(at);
      at += 4;
    }
    if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE) !== 0) {
      defaultSize = dv.getUint32(at);
      at += 4;
    }
    if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS) !== 0) {
      defaultFlags = dv.getUint32(at);
      at += 4;
    }

    const samples: Sample[] = [];

    // tfdt: この断片が動画全体のどの時刻から始まるか。
    // これを見ないと、断片の境目にある僅かな隙間が積み上がって
    // 映像と音声が少しずつずれていく
    let decodeTime: number | null = null;
    const tfdt = findBox(children, "tfdt");
    if (tfdt !== undefined) {
      const p0 = tfdt.start + tfdt.headerSize;
      if (data[p0] === 1) {
        if (dv.getUint32(p0 + 4) !== 0) {
          throw new RemuxError("復号時刻が大きすぎます");
        }
        decodeTime = dv.getUint32(p0 + 8);
      } else {
        decodeTime = dv.getUint32(p0 + 4);
      }
    }

    for (const trun of children) {
      if (trun.type !== "trun") continue;

      let p = trun.start + trun.headerSize;
      const trunFlags = dv.getUint32(p) & 0x00ffffff;
      p += 4;
      const count = dv.getUint32(p);
      p += 4;

      let cursor = baseOffset;
      if ((trunFlags & TRUN_DATA_OFFSET) !== 0) {
        cursor = baseOffset + dv.getInt32(p);
        p += 4;
      }

      let firstFlags: number | null = null;
      if ((trunFlags & TRUN_FIRST_SAMPLE_FLAGS) !== 0) {
        firstFlags = dv.getUint32(p);
        p += 4;
      }

      for (let i = 0; i < count; i += 1) {
        let duration = defaultDuration;
        let size = defaultSize;
        let flags = i === 0 && firstFlags !== null ? firstFlags : defaultFlags;
        let ctsOffset = 0;

        if ((trunFlags & TRUN_SAMPLE_DURATION) !== 0) {
          duration = dv.getUint32(p);
          p += 4;
        }
        if ((trunFlags & TRUN_SAMPLE_SIZE) !== 0) {
          size = dv.getUint32(p);
          p += 4;
        }
        if ((trunFlags & TRUN_SAMPLE_FLAGS) !== 0) {
          if (!(i === 0 && firstFlags !== null)) flags = dv.getUint32(p);
          p += 4;
        }
        if ((trunFlags & TRUN_SAMPLE_CTS) !== 0) {
          // version 1 では符号付き。version 0 でも実用上は同じ値域に収まる
          ctsOffset = dv.getInt32(p);
          p += 4;
        }

        samples.push({
          offset: cursor,
          size,
          duration,
          ctsOffset,
          sync: (flags & SAMPLE_IS_NON_SYNC) === 0,
        });
        cursor += size;
      }
    }

    const fragments = into.get(trackId) ?? [];
    fragments.push({ decodeTime, samples });
    into.set(trackId, fragments);
  }
}

/**
 * 断片を 1 本のサンプル列にまとめる。
 *
 * 断片の中のサンプル長を足しただけでは、次の断片が始まる時刻 (tfdt) と
 * 食い違うことがある。差を各断片の最後のサンプルへ寄せて、時刻の基準を
 * 断片の側に合わせる。放っておくと映像と音声のずれとして積み上がる。
 */
function flattenFragments(fragments: Fragment[]): Sample[] {
  const out: Sample[] = [];

  fragments.forEach((fragment, index) => {
    const next = fragments[index + 1];
    const last = fragment.samples[fragment.samples.length - 1];

    if (
      last !== undefined &&
      fragment.decodeTime !== null &&
      next?.decodeTime != null
    ) {
      const declared = next.decodeTime - fragment.decodeTime;
      const summed = fragment.samples.reduce((sum, s) => sum + s.duration, 0);
      const gap = declared - summed;
      // 最後の 1 サンプルで吸収する。長さが負になるのは断片が壊れている場合だけ
      if (gap !== 0 && last.duration + gap >= 0) {
        last.duration += gap;
      }
    }

    out.push(...fragment.samples);
  });

  return out;
}

/** 通常の MP4 が必要とするサンプル表を組み立てる */
function buildSampleTable(
  samples: Sample[],
  stsd: Uint8Array,
  chunkOffset: number,
): Uint8Array {
  // stts: 同じ長さが続く区間をまとめる
  const durations: number[] = [];
  for (const sample of samples) {
    const lastCount = durations[durations.length - 2];
    const lastDuration = durations[durations.length - 1];
    if (lastDuration === sample.duration && lastCount !== undefined) {
      durations[durations.length - 2] = lastCount + 1;
    } else {
      durations.push(1, sample.duration);
    }
  }
  const sttsEntries = durations.length / 2;
  const stts = buildFullBox(
    "stts",
    0,
    0,
    u32(sttsEntries),
    concat(durations.map((value) => u32(value))),
  );

  // stsz: サンプルごとの大きさ
  const stsz = buildFullBox(
    "stsz",
    0,
    0,
    u32(0),
    u32(samples.length),
    concat(samples.map((sample) => u32(sample.size))),
  );

  // stsc: 1 トラックにつき 1 かたまりへまとめるので 1 エントリで足りる
  const stsc = buildFullBox(
    "stsc",
    0,
    0,
    u32(1),
    u32(1),
    u32(samples.length),
    u32(1),
  );

  const stco = buildFullBox("stco", 0, 0, u32(1), u32(chunkOffset));

  const parts: Uint8Array[] = [stsd, stts, stsc, stsz, stco];

  // stss: 単独で復号できるサンプルの一覧。全部がそうなら省いてよい
  const syncIndexes: number[] = [];
  samples.forEach((sample, index) => {
    if (sample.sync) syncIndexes.push(index + 1);
  });
  if (syncIndexes.length !== samples.length) {
    parts.push(
      buildFullBox(
        "stss",
        0,
        0,
        u32(syncIndexes.length),
        concat(syncIndexes.map((value) => u32(value))),
      ),
    );
  }

  // ctts: 表示順と復号順がずれるときだけ要る
  if (samples.some((sample) => sample.ctsOffset !== 0)) {
    const entries: number[] = [];
    for (const sample of samples) {
      const lastCount = entries[entries.length - 2];
      const lastOffset = entries[entries.length - 1];
      if (lastOffset === sample.ctsOffset && lastCount !== undefined) {
        entries[entries.length - 2] = lastCount + 1;
      } else {
        entries.push(1, sample.ctsOffset);
      }
    }
    parts.push(
      buildFullBox(
        "ctts",
        0,
        0,
        u32(entries.length / 2),
        concat(entries.map((value) => u32(value))),
      ),
    );
  }

  return buildBox("stbl", ...parts);
}

/** 長さ欄を書き換えた full box を作る (中身はそのまま持ち越す) */
function withDuration(
  data: Uint8Array,
  box: BoxRef,
  duration: number,
  /** 長さ欄が中身の先頭から何バイト目にあるか (version 0 の場合) */
  offsetV0: number,
  /** version 1 の場合 */
  offsetV1: number,
): Uint8Array {
  const copy = new Uint8Array(bytesOf(data, box));
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const bodyAt = box.headerSize;
  const version = copy[bodyAt];

  if (version === 1) {
    // 上位 32bit は 0。動画の長さがそこへ届くことはない
    dv.setUint32(bodyAt + offsetV1, 0);
    dv.setUint32(bodyAt + offsetV1 + 4, duration);
  } else {
    dv.setUint32(bodyAt + offsetV0, duration);
  }
  return copy;
}

/** mvhd / mdhd の長さ欄の位置。version と flags の 4 バイトを含む */
const VHD_DURATION_V0 = 4 + 4 + 4 + 4; // version+flags, 作成, 更新, timescale
const VHD_DURATION_V1 = 4 + 8 + 8 + 4;
/** tkhd の長さ欄の位置 */
const TKHD_DURATION_V0 = 4 + 4 + 4 + 4 + 4; // ... track_id, reserved
const TKHD_DURATION_V1 = 4 + 8 + 8 + 4 + 4;

function readTimescale(data: Uint8Array, box: BoxRef): number {
  const dv = view(data);
  const bodyAt = box.start + box.headerSize;
  const version = data[bodyAt];
  return dv.getUint32(bodyAt + (version === 1 ? 4 + 8 + 8 : 4 + 4 + 4));
}

/** moov の中の 1 トラックを、サンプル表を備えた通常の形に作り直す */
function rebuildTrack(
  data: Uint8Array,
  trak: BoxRef,
  samples: Sample[],
  chunkOffset: number,
  movieTimescale: number,
): { bytes: Uint8Array; durationInMovieScale: number } {
  const trakChildren = childrenOf(data, trak);
  const mdia = requireBox(trakChildren, "mdia", "trak");
  const mdiaChildren = childrenOf(data, mdia);
  const mdhd = requireBox(mdiaChildren, "mdhd", "mdia");
  const minf = requireBox(mdiaChildren, "minf", "mdia");
  const minfChildren = childrenOf(data, minf);
  const stbl = requireBox(minfChildren, "stbl", "minf");
  const stsd = requireBox(childrenOf(data, stbl), "stsd", "stbl");

  const mediaTimescale = readTimescale(data, mdhd);
  const mediaDuration = samples.reduce((sum, s) => sum + s.duration, 0);
  const durationInMovieScale = Math.round(
    (mediaDuration / mediaTimescale) * movieTimescale,
  );

  // stbl だけ差し替え、それ以外 (vmhd/smhd, dinf など) はそのまま持ち越す
  const newMinf = buildBox(
    "minf",
    ...minfChildren.map((child) =>
      child.type === "stbl"
        ? buildSampleTable(samples, bytesOf(data, stsd), chunkOffset)
        : bytesOf(data, child),
    ),
  );

  const newMdia = buildBox(
    "mdia",
    ...mdiaChildren.map((child) => {
      if (child.type === "mdhd") {
        return withDuration(
          data,
          child,
          mediaDuration,
          VHD_DURATION_V0,
          VHD_DURATION_V1,
        );
      }
      return child.type === "minf" ? newMinf : bytesOf(data, child);
    }),
  );

  const bytes = buildBox(
    "trak",
    ...trakChildren.map((child) => {
      if (child.type === "tkhd") {
        return withDuration(
          data,
          child,
          durationInMovieScale,
          TKHD_DURATION_V0,
          TKHD_DURATION_V1,
        );
      }
      return child.type === "mdia" ? newMdia : bytesOf(data, child);
    }),
  );

  return { bytes, durationInMovieScale };
}

/**
 * 断片化 MP4 を通常の MP4 に組み直す。
 *
 * 断片 (moof/mdat) に散らばっているサンプルを 1 つの mdat へ集め、
 * moov に完全なサンプル表と本当の長さを持たせる。
 * 入力が既に通常の MP4 (moof が無い) なら、そのまま返す。
 */
export function remuxToProgressiveMp4(input: Uint8Array): Uint8Array {
  const top = readBoxes(input, 0, input.length);
  const ftyp = requireBox(top, "ftyp", "ファイル先頭");
  const moov = requireBox(top, "moov", "ファイル");
  const fragments = top.filter((box) => box.type === "moof");

  if (fragments.length === 0) return input;

  const defaults = readTrackDefaults(input, moov);
  const fragmentsByTrack = new Map<number, Fragment[]>();
  for (const moof of fragments) {
    readFragment(input, moof, defaults, fragmentsByTrack);
  }
  const samplesByTrack = new Map<number, Sample[]>();
  for (const [trackId, list] of fragmentsByTrack) {
    samplesByTrack.set(trackId, flattenFragments(list));
  }
  if (samplesByTrack.size === 0) {
    throw new RemuxError("断片からサンプルを 1 つも読めませんでした");
  }

  const moovChildren = childrenOf(input, moov);
  const mvhd = requireBox(moovChildren, "mvhd", "moov");
  const movieTimescale = readTimescale(input, mvhd);

  const traks = moovChildren.filter((box) => box.type === "trak");
  const dv = view(input);

  /** trak と、その中身の並び順を保ったサンプル列 */
  const tracks = traks.map((trak) => {
    const tkhd = requireBox(childrenOf(input, trak), "tkhd", "trak");
    const bodyAt = tkhd.start + tkhd.headerSize;
    const version = input[bodyAt];
    const trackId = dv.getUint32(bodyAt + (version === 1 ? 4 + 16 : 4 + 8));
    return { trak, samples: samplesByTrack.get(trackId) ?? [] };
  });

  const totalSampleBytes = tracks.reduce(
    (sum, track) => sum + track.samples.reduce((n, s) => n + s.size, 0),
    0,
  );

  /**
   * moov の大きさは中身の値に依らず決まるので、仮の位置で 1 度組んで
   * 大きさを測り、本当の位置でもう 1 度組む
   */
  function assembleMoov(chunkOffsets: number[]): Uint8Array {
    let longest = 0;
    const trakBytes = tracks.map((track, index) => {
      const built = rebuildTrack(
        input,
        track.trak,
        track.samples,
        chunkOffsets[index] ?? 0,
        movieTimescale,
      );
      longest = Math.max(longest, built.durationInMovieScale);
      return built.bytes;
    });

    const newMvhd = withDuration(
      input,
      mvhd,
      longest,
      VHD_DURATION_V0,
      VHD_DURATION_V1,
    );

    // mvex は断片化 MP4 であることの目印なので落とす
    const others = moovChildren.filter(
      (box) => box.type !== "mvhd" && box.type !== "trak" && box.type !== "mvex",
    );

    return buildBox(
      "moov",
      newMvhd,
      ...trakBytes,
      ...others.map((box) => bytesOf(input, box)),
    );
  }

  const ftypBytes = bytesOf(input, ftyp);
  const moovSize = assembleMoov(tracks.map(() => 0)).length;
  const mdatStart = ftypBytes.length + moovSize + 8;

  if (mdatStart + totalSampleBytes > 0xffffffff) {
    throw new RemuxError("4GB を超える動画は扱えません");
  }

  // 各トラックのサンプルを続けて置き、その先頭を chunk の位置とする
  const chunkOffsets: number[] = [];
  let at = mdatStart;
  for (const track of tracks) {
    chunkOffsets.push(at);
    at += track.samples.reduce((sum, sample) => sum + sample.size, 0);
  }

  const moovBytes = assembleMoov(chunkOffsets);
  if (moovBytes.length !== moovSize) {
    // 位置の値によって大きさが変わることは無い。変わったなら組み立てが壊れている
    throw new RemuxError("moov の大きさが安定しませんでした");
  }

  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, totalSampleBytes + 8);
  mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"

  const payload = new Uint8Array(totalSampleBytes);
  let writeAt = 0;
  for (const track of tracks) {
    for (const sample of track.samples) {
      payload.set(input.subarray(sample.offset, sample.offset + sample.size), writeAt);
      writeAt += sample.size;
    }
  }

  return concat([ftypBytes, moovBytes, mdatHeader, payload]);
}
