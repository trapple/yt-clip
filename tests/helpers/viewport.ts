/**
 * 窓を置く画面の大きさ (`document.documentElement.clientWidth` / `clientHeight`) を jsdom で決める。
 *
 * jsdom はレイアウトを持たず、どちらも 0 を返す。スクロールバーの無い画面として `innerWidth` / `innerHeight`
 * に揃える (テストが innerWidth を変えれば付いてくる)。`scrollbar` を渡すと、その分だけ狭くする
 * (スクロールバーが画面の幅を食っている場面)
 */
export function stubClientSize(scrollbar: { width?: number; height?: number } = {}): void {
  const root = document.documentElement;
  Object.defineProperty(root, "clientWidth", {
    configurable: true,
    get: () => window.innerWidth - (scrollbar.width ?? 0),
  });
  Object.defineProperty(root, "clientHeight", {
    configurable: true,
    get: () => window.innerHeight - (scrollbar.height ?? 0),
  });
}
