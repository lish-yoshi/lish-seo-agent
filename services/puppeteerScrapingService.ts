// Puppeteerスクレイピングサービス
// 実際のWebページからH2/H3タグを正確に取得

export interface ScrapingResult {
  h1: string;
  h2Items: Array<{
    text: string;
    h3Items: string[];
  }>;
  characterCount: number;
  title: string;
  publishDate?: string; // 公開日
  modifiedDate?: string; // 更新日
}

// 単一URLをスクレイピング
export async function scrapeWithPuppeteer(
  url: string
): Promise<ScrapingResult | null> {
  try {
    console.log(`🔧 Puppeteerでスクレイピング: ${url}`);

    const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;

    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || "";
    const response = await fetch(`${backendUrl}/api/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey && { "x-api-key": apiKey }),
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      throw new Error(`スクレイピングエラー: ${response.status}`);
    }

    const result = await response.json();

    if (result.success && result.data) {
      console.log(`✅ Puppeteer成功: H2数=${result.data.h2Items.length}`);
      return result.data;
    } else {
      console.error(`❌ Puppeteerエラー: ${result.error}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ スクレイピングサービスエラー:`, error);
    return null;
  }
}

// 複数URLを一括スクレイピング
export async function scrapeMultipleWithPuppeteer(
  urls: string[]
): Promise<Map<string, ScrapingResult>> {
  const results = new Map<string, ScrapingResult>();

  try {
    console.log(`🔧 ${urls.length}件のURLを一括スクレイピング`);

    const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;

    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || "";
    const response = await fetch(`${backendUrl}/api/scrape-multiple`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey && { "x-api-key": apiKey }),
      },
      body: JSON.stringify({ urls }),
    });

    if (!response.ok) {
      // 502/503エラーの場合は特別なエラーをthrow
      if (response.status === 502 || response.status === 503) {
        throw new Error(`RENDER_SERVER_DOWN: ${response.status}`);
      }
      throw new Error(`一括スクレイピングエラー: ${response.status}`);
    }

    const data = await response.json();

    if (data.results) {
      data.results.forEach((item: any) => {
        // サーバーのレスポンス形式に合わせて処理
        if (item.success && item.data) {
          // 新しい形式: {url, success, data}
          results.set(item.url, {
            h1: item.data.h1 || "",
            h2Items: item.data.h2Items || [],
            characterCount: item.data.characterCount || 0,
            title: item.data.title || "",
          });
        } else if (item.h2Items) {
          // 旧形式: 直接h2Itemsなどが含まれている
          results.set(item.url, {
            h1: item.h1 || "",
            h2Items: item.h2Items || [],
            characterCount: item.characterCount || 0,
            title: item.title || "",
          });
        }
      });
    }

    console.log(
      `✅ 一括スクレイピング完了: ${results.size}/${urls.length}件成功`
    );
  } catch (error) {
    console.error(`❌ 一括スクレイピングエラー:`, error);

    // 502/503エラーやネットワークエラーの場合は上位に伝播
    if (
      error instanceof Error &&
      (error.message.includes("RENDER_SERVER_DOWN") ||
        error.message.includes("Failed to fetch") ||
        error.message.includes("fetch") ||
        error.message.includes("TypeError"))
    ) {
      console.log("🔄 ネットワークエラーを上位に伝播:", error.message);
      throw new Error(`RENDER_SERVER_DOWN: ${error.message}`);
    }
  }

  return results;
}

// スクレイピングサーバーのヘルスチェック
export async function checkScrapingServerHealth(): Promise<boolean> {
  try {
    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || "";
    const response = await fetch(`${backendUrl}/api/health`);
    const data = await response.json();
    return data.status === "ok";
  } catch (error) {
    console.error("⚠️ スクレイピングサーバーが起動していません");
    return false;
  }
}
