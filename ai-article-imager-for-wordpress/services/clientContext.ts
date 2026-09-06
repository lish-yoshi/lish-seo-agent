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
  const headers: Record<string, string> = {};
  const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  if (clientId) headers["x-client-id"] = clientId;
  return headers;
}

/**
 * 投稿系の操作前に clientId が指定されていることを検証する。
 * null の場合は例外を投げて処理を中断する。
 */
export function requireClientId(): string {
  if (!clientId) {
    throw new Error(
      "投稿先クライアントが指定されていません。メインアプリから起動してください。"
    );
  }
  return clientId;
}
