/** 拡張が足した要素の数 (マスタースイッチの spec §1 の測り方。窓・ドック枠・帯・プレビューの canvas を覆う) */
export function ourElements(): number {
  return document.querySelectorAll('[id^="yt-clip-"], [data-role^="dock-"]').length;
}
