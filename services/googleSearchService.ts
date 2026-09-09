// Google Custom Search API Service
// 正確なURLを取得するためのサービス

interface SearchResult {
  title: string;
  link: string; // 正確なURL
  snippet: string;
  displayLink: string; // ドメイン名
}

interface GoogleSearchResponse {
  items: SearchResult[];
}

export async function searchGoogle(
  query: string,
  apiKey: string, // 使用しない（サーバー側で管理）
  searchEngineId: string, // 使用しない（サーバー側で管理）
  numResults: number = 20
): Promise<SearchResult[]> {
  try {
    console.log("🔍 Calling server Google search endpoint...");

    // 認証ヘッダーを取得
    const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;

    // サーバーのエンドポイントを呼び出す
    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || "";
    const response = await fetch(`${backendUrl}/api/google-search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey && { "x-api-key": apiKey }),
      },
      body: JSON.stringify({ query, numResults }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data = await response.json();

    if (data.success && data.results) {
      console.log(`✅ Got ${data.results.length} results from server`);
      return data.results.slice(0, numResults);
    }

    throw new Error("Invalid response from server");
  } catch (error) {
    console.error("❌ Google Custom Search API error:", error);
    throw error;
  }
}

// 検索結果をフォーマット
export function formatSearchResults(results: SearchResult[]) {
  return results.map((result, index) => ({
    rank: index + 1,
    title: result.title,
    url: result.link, // 正確なURL！
    snippet: result.snippet,
    domain: result.displayLink,
  }));
}
