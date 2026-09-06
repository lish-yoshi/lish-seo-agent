/**
 * 画像生成エージェント側のクライアント文脈
 *
 * メインアプリから postMessage で受け取った clientId を保持し、
 * バックエンド呼び出しに x-client-id ヘッダーとして付ける。
 * 別タブで開かれた場合のために URL の ?clientId= も見る。
 */
let clientId: string | null =
  new URLSearchParams(window.location.search).get("clientId");

export function setClientId(id: string | null | undefined): void {
  if (id) clientId = id;
}

export function getClientId(): string | null {
  return clientId;
}

export function clientHeaders(): Record<string, string> {
  return clientId ? { "x-client-id": clientId } : {};
}
