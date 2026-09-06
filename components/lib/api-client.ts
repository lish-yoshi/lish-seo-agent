// [UNUSED] Next.js からの流用。process.env 参照のためVite環境では動作しない。
// 使用する場合は clientHeaders() ベースに書き換えること。
//
// GCP Cloud Run APIクライアント

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

// APIリクエストのヘッダー設定
const getHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (INTERNAL_API_KEY) {
    headers["x-api-key"] = INTERNAL_API_KEY;
  }

  return headers;
};

// スクレイピングAPI
export const scrapeUrl = async (url: string) => {
  const response = await fetch(`${API_BASE_URL}/api/scrape`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    throw new Error(`スクレイピングエラー: ${response.statusText}`);
  }

  return response.json();
};

// 複数URL一括スクレイピングAPI
export const scrapeMultipleUrls = async (urls: string[]) => {
  const response = await fetch(`${API_BASE_URL}/api/scrape-multiple`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ urls }),
  });

  if (!response.ok) {
    throw new Error(`一括スクレイピングエラー: ${response.statusText}`);
  }

  return response.json();
};

// Google検索API
export const googleSearch = async (query: string, numResults = 20) => {
  const response = await fetch(`${API_BASE_URL}/api/google-search`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ query, numResults }),
  });

  if (!response.ok) {
    throw new Error(`Google検索エラー: ${response.statusText}`);
  }

  return response.json();
};

// ヘルスチェック
export const healthCheck = async () => {
  const response = await fetch(`${API_BASE_URL}/api/health`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`ヘルスチェックエラー: ${response.statusText}`);
  }

  return response.json();
};
