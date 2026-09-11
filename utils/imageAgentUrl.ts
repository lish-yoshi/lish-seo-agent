/**
 * 画像生成エージェント（imager）のURL解決
 *
 * imager は独立サブドメイン（本番: https://imager.lishinc.co.jp）で配信する。
 * postMessage の targetOrigin には絶対オリジンしか渡せず、"/imager" のような
 * パスを渡すと送信自体が例外で失敗するため、URLの決定とオリジンの抽出を
 * このモジュールに集約する。
 */

const FALLBACK_URL = "http://localhost:5177";

/**
 * imager のURLを絶対URLで返す。
 * VITE_IMAGE_GEN_URL に相対パスが設定されていても自オリジン基準で正規化する。
 */
export function getImageGenUrl(): string {
  const raw = import.meta.env.VITE_IMAGE_GEN_URL || FALLBACK_URL;
  return new URL(raw, window.location.origin).toString();
}

/**
 * postMessage の targetOrigin に渡すオリジン。
 * クエリ付きURLを渡してもオリジンだけが抽出される。
 */
export function getImageGenOrigin(): string {
  return new URL(getImageGenUrl()).origin;
}

/** clientId を付与した起動URLを組み立てる（未選択なら付与しない） */
export function buildImageGenUrl(clientId?: string | null): string {
  const url = new URL(getImageGenUrl());
  if (clientId) {
    url.searchParams.set("clientId", clientId);
  }
  return url.toString();
}
