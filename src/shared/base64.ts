/**
 * 一度に `String.fromCharCode` へ渡す最大バイト数。
 * 引数が多すぎると呼び出しが失敗するため分割する。
 */
const CHUNK_SIZE = 0x8000;

/**
 * 動画データを base64 にする。
 *
 * **`btoa` は必ず最後に 1 回だけ呼ぶこと。** チャンクごとに呼ぶと、
 * `CHUNK_SIZE` が 3 の倍数でないため境界ごとにパディング (`=`) が挟まり、
 * デコードしたときに壊れたデータになる。
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

/** `encodeBase64` の逆。戻り値の型引数は Blob / File へ渡すために必要 */
export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
