/**
 * 録画した MP4 の、映像トラックの表示変換行列を直す。
 *
 * `<video>.captureStream()` で録ったフレームは変換メタデータ (回転 0) を持つ。
 * Chromium の MP4 muxer はこれを見て行列を 1 要素ずつ書き写す分岐に入るが、
 * **その分岐は最後の要素 `w` を書き忘れており、ゼロ初期化のまま残る**
 * (`media/muxers/mp4_muxer_delegate.cc`)。`tabCapture` のフレームは
 * 変換メタデータを持たないため単位行列を丸ごと書く分岐に入り、正常になる。
 *
 * `w` は同次変換行列の最後の要素で、本来 1.0 (`0x40000000`) でなければ
 * ならない。0 だと表示サイズの計算が 0 除算になるため、X はアップロード後の
 * 変換に失敗する ("Internal error[131]")。
 *
 * 実機で 9 本のファイルを X に投げ、成否がこの 1 要素と完全に一致することを
 * 確認した。さらに、失敗するファイルの当該 4 バイトだけを直すと通り、
 * 成功するファイルの同じ 4 バイトだけを壊すと落ちることも確かめてある。
 *
 * 音声トラックの行列は全ゼロのままでも通るので触らない。
 */

/** 2.30 固定小数の 1.0。変換行列の最後の要素が取るべき値 */
const FIXED_POINT_ONE = 0x40000000;

/** tkhd の中身の先頭から行列までの距離 */
const MATRIX_OFFSET_V0 = 4 + 20 + 16;
const MATRIX_OFFSET_V1 = 4 + 32 + 16;
/** 行列 9 要素 (各 4 バイト) の後ろに幅と高さが続く */
const MATRIX_BYTES = 36;

export class DisplayMatrixError extends Error {
  constructor(message: string) {
    super(`表示行列を直せませんでした: ${message}`);
    this.name = "DisplayMatrixError";
  }
}

type BoxRef = { type: string; start: number; headerSize: number; size: number };

function readBoxes(data: Uint8Array, start: number, end: number): BoxRef[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: BoxRef[] = [];
  let cursor = start;

  while (cursor + 8 <= end) {
    let size = dv.getUint32(cursor);
    let headerSize = 8;

    if (size === 1) {
      if (dv.getUint32(cursor + 8) !== 0) {
        throw new DisplayMatrixError("4GB を超える box は扱えません");
      }
      size = dv.getUint32(cursor + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }

    if (size < headerSize || cursor + size > end) {
      throw new DisplayMatrixError(`box の長さが壊れています (位置 ${cursor})`);
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

function childrenOf(data: Uint8Array, box: BoxRef): BoxRef[] {
  return readBoxes(data, box.start + box.headerSize, box.start + box.size);
}

/**
 * 映像トラックの行列を直した MP4 を返す。
 *
 * **長さは変えない**ので、box の位置を指している値 (stco など) は
 * そのまま有効なまま保たれる。直す必要が無ければ入力をそのまま返す。
 */
export function fixVideoDisplayMatrix(
  input: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const top = readBoxes(input, 0, input.length);
  const moov = top.find((box) => box.type === "moov");
  if (moov === undefined) throw new DisplayMatrixError("moov がありません");

  const targets: number[] = [];

  for (const trak of childrenOf(input, moov)) {
    if (trak.type !== "trak") continue;

    const tkhd = childrenOf(input, trak).find((box) => box.type === "tkhd");
    if (tkhd === undefined) continue;

    const body = tkhd.start + tkhd.headerSize;
    const version = input[body];
    const matrixAt =
      body + (version === 1 ? MATRIX_OFFSET_V1 : MATRIX_OFFSET_V0);
    const widthAt = matrixAt + MATRIX_BYTES;

    if (widthAt + 8 > tkhd.start + tkhd.size) {
      throw new DisplayMatrixError("tkhd が想定より短いです");
    }

    const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
    // 幅が 0 でないトラックを映像とみなす。音声の行列は全ゼロのままでも通る
    if (dv.getUint32(widthAt) === 0) continue;

    const w = matrixAt + 8 * 4;
    if (dv.getUint32(w) !== FIXED_POINT_ONE) targets.push(w);
  }

  if (targets.length === 0) return input;

  const out = new Uint8Array(input);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const at of targets) outView.setUint32(at, FIXED_POINT_ONE);
  return out;
}
