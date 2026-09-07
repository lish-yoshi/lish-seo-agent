import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompetitorResearchResult, ArticleAnalysis } from "../types";
import { fetchMultiplePages, type PageAnalysis } from "./webFetchService";
import { searchGoogle, formatSearchResults } from "./googleSearchService";
import {
  scrapeMultipleWithPuppeteer,
  checkScrapingServerHealth,
} from "./puppeteerScrapingService";
import { analyzeWordFrequency } from "./wordFrequencyService";

const apiKey =
  import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY not set.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// JSON文字列クリーニング
function cleanJsonString(str: string): string {
  const stringTokens: string[] = [];
  let tokenIndex = 0;

  str = str.replace(/"([^"\\]|\\.)*"/g, (match) => {
    const token = `__STRING_${tokenIndex}__`;
    stringTokens[tokenIndex] = match;
    tokenIndex++;
    return token;
  });

  str = str.replace(/\/\*[\s\S]*?\*\//g, "");
  str = str.replace(/\/\/.*$/gm, "");

  stringTokens.forEach((string, index) => {
    str = str.replace(`__STRING_${index}__`, string);
  });

  str = str.replace(/,(\s*[}\]])/g, "$1");

  return str.trim();
}

// タイトルから実際のURLを推測（使わないようにする）
function guessUrlFromTitle(title: string): string {
  // この関数は基本的に使わない（URLが取得できない場合のみ）
  return "URL_NOT_FOUND";
}

export const generateCompetitorResearch = async (
  keyword: string,
  onProgress?: (current: number, total: number) => void,
  useGoogleSearch: boolean = false
): Promise<CompetitorResearchResult> => {
  console.log("🔍 Starting competitor research for:", keyword);

  // URLパラメータでモックモードをチェック
  const urlParams = new URLSearchParams(window.location.search);
  const useMockData = urlParams.get("mock") === "true";

  if (useMockData) {
    console.log("🎭 モックモード: 固定データを返します");
    return getMockCompetitorResearch(keyword);
  }

  // Google Search APIはサーバー側で設定を確認するため、クライアント側では常にtrue
  const canUseGoogleSearch = true; // サーバー側が判断

  // Step 1: Google検索で上位サイトを取得
  const searchPrompt = `
「${keyword}」でGoogle検索を実行し、上位20サイトの情報を取得してください。

取得する情報：
- title: ページのタイトル（完全なもの）
- snippet: 検索結果の説明文
- domain: サイトのドメイン名（分かる場合）

ショッピングサイトやPDFは除外してください。

JSON形式で返してください（必ず15件以上）：
{
  "searchResults": [
    {
      "rank": 1,
      "title": "SEO対策とは？初心者でもわかる基本から実践まで｜サクラサクマーケティング",
      "snippet": "SEO対策の基本から実践的な方法まで...",
      "domain": "サクラサクマーケティング"
    }
  ]
}`;

  try {
    let searchResults: any[] = [];

    // Google Custom Search APIを使用（利用可能な場合）
    if (useGoogleSearch && canUseGoogleSearch) {
      console.log("📡 Using Google Custom Search API for exact URLs...");
      try {
        // APIキーはサーバー側で管理されるため、ダミー値を渡す
        const googleResults = await searchGoogle(keyword, "", "", 15);
        console.log("   Raw Google results:", googleResults.length);
        searchResults = formatSearchResults(googleResults);
        console.log(
          `✅ Got ${searchResults.length} results with exact URLs from Google`
        );
      } catch (error: any) {
        console.error("❌ Google Search API failed:", error);

        // エラーの種類に応じて適切なメッセージを返す
        if (error?.message?.includes("quota")) {
          throw new Error(
            "本日のCustom Search API無料利用分を超過しました。これ以降は従量課金（約1.5円/回）が発生します。"
          );
        }
        if (
          error?.message?.includes("API key") ||
          error?.message?.includes("Invalid")
        ) {
          throw new Error(
            "Google Search API の設定エラーです。APIキーと検索エンジンIDを確認してください。"
          );
        }
        if (
          error?.message?.includes("network") ||
          error?.message?.includes("fetch")
        ) {
          throw new Error(
            "ネットワークエラーが発生しました。接続を確認してください。"
          );
        }

        // その他のエラー
        throw new Error(
          `競合分析サービスでエラーが発生しました: ${
            error?.message || "Unknown error"
          }`
        );
      }
    } else {
      // Google Search APIが明示的に無効化されている場合
      throw new Error(
        "Google Search APIが無効です。品質保証のため、競合分析を実行できません。"
      );
    }

    // 検索結果が取得できなかった場合はエラー
    if (searchResults.length === 0) {
      throw new Error(
        "検索結果を取得できませんでした。Google Search APIの設定を確認してください。"
      );
    }

    // Geminiフォールバックは削除（以下のコードは使用しない）
    if (false) {
      console.log("📡 Using Gemini search (URLs may not be exact)...");
      const model = genAI.getGenerativeModel({
        model: "gemini-3.6-flash",
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384, // 増やして不完全なJSONを防ぐ
        },
      });

      const searchResult = await model.generateContent(searchPrompt);
      const searchText = searchResult.response.text();

      // JSONを抽出
      let searchData;
      try {
        // 複数のJSON抽出パターンを試す
        let jsonMatch = searchText.match(/\{[\s\S]*\}/);

        // より厳密なパターンを試す（配列を含む場合）
        if (!jsonMatch) {
          jsonMatch = searchText.match(
            /\{\s*"searchResults"\s*:\s*\[[\s\S]*?\]\s*\}/
          );
        }

        if (jsonMatch) {
          const cleanedJson = cleanJsonString(jsonMatch[0]);
          searchData = JSON.parse(cleanedJson);
        } else {
          console.warn("JSON extraction failed, using empty results");
          searchData = { searchResults: [] };
        }
      } catch (e) {
        console.error("Failed to parse search results:", e.message);
        console.error(
          "Raw text (first 500 chars):",
          searchText.substring(0, 500)
        );

        // フォールバック: シンプルなテキスト解析
        try {
          const results = [];
          const lines = searchText.split("\n");
          let currentResult = null;

          for (const line of lines) {
            if (line.includes('"rank":')) {
              if (currentResult) results.push(currentResult);
              currentResult = {
                rank: results.length + 1,
                title: "",
                snippet: "",
              };
            } else if (currentResult && line.includes('"title":')) {
              const titleMatch = line.match(/"title"\s*:\s*"([^"]*)"/);
              if (titleMatch) currentResult.title = titleMatch[1];
            } else if (currentResult && line.includes('"snippet":')) {
              const snippetMatch = line.match(/"snippet"\s*:\s*"([^"]*)"/);
              if (snippetMatch) currentResult.snippet = snippetMatch[1];
            }
          }
          if (currentResult) results.push(currentResult);

          searchData = { searchResults: results };
          console.log(`Fallback parsing recovered ${results.length} results`);
        } catch (fallbackError) {
          console.error("Fallback parsing also failed");
          searchData = { searchResults: [] };
        }
      }

      searchResults = searchData.searchResults || [];
    }
    console.log(`✅ Found ${searchResults.length} search results`);

    // 検索結果が少ない場合の警告
    if (searchResults.length < 10) {
      console.warn(
        `⚠️ Only ${searchResults.length} search results returned. Expected at least 15.`
      );
    }

    // デバッグ: URLの状態を確認
    console.log("🔍 URL availability check:");
    let urlCount = 0;
    searchResults.forEach((result: any, i: number) => {
      if (result.url && result.url !== "URL取得不可") {
        urlCount++;
      }
    });
    console.log(`  - Valid URLs: ${urlCount}/${searchResults.length}`);

    // Step 2: 各ページの準備（最大15サイト、URLがなくてもタイトルで検索）
    const targetCount = Math.min(searchResults.length, 15);
    const pagesToFetch = searchResults
      .slice(0, targetCount)
      .map((result: any, index: number) => {
        const url = result.url || "URL_NOT_FOUND";
        console.log(
          `  ${index + 1}. Title: ${result.title} ${
            url !== "URL_NOT_FOUND" ? `(URL: ${url})` : "(タイトル検索)"
          }`
        );
        return {
          url: url,
          title: result.title,
          rank: index + 1,
        };
      });

    console.log("🌐 Preparing to fetch actual page content...");
    console.log(`Pages to analyze: ${pagesToFetch.length} sites`);
    console.log(
      "Expected time: ~",
      Math.ceil(
        pagesToFetch.length * 3 + Math.floor(pagesToFetch.length / 5) * 10
      ),
      "seconds"
    );

    // Step 3: スクレイピング方法を選択
    let pageAnalyses: PageAnalysis[] = [];

    // Puppeteerサーバーが利用可能かチェック
    const puppeteerAvailable = await checkScrapingServerHealth();

    if (puppeteerAvailable && useGoogleSearch && searchResults.length > 0) {
      // Puppeteerを使用（Google Search APIでURLが取得できた場合）
      console.log("\n🎯 Using Puppeteer for accurate H2/H3 extraction...");

      try {
        // URLのリストを作成
        const urlsToScrape = pagesToFetch
          .filter((page) => page.url && !page.url.includes("URL_NOT_FOUND"))
          .map((page) => page.url);

        // Puppeteerで一括スクレイピング
        const scrapingResults = await scrapeMultipleWithPuppeteer(urlsToScrape);

        // 結果をPageAnalysis形式に変換
        pageAnalyses = pagesToFetch.map((page) => {
          const scrapingData = scrapingResults.get(page.url);
          if (scrapingData) {
            return {
              url: page.url,
              title: page.title,
              h1: scrapingData.h1 || page.title,
              h2Items: scrapingData.h2Items,
              characterCount: scrapingData.characterCount,
              fetchSuccess: true,
            };
          } else {
            return {
              url: page.url,
              title: page.title,
              h1: page.title,
              h2Items: [],
              characterCount: 0,
              fetchSuccess: false,
              error: "Puppeteerスクレイピング失敗",
            };
          }
        });

        // 進捗更新
        if (onProgress) {
          onProgress(urlsToScrape.length, urlsToScrape.length);
        }

        // 成功したページが0の場合
        const successCount = pageAnalyses.filter((p) => p.fetchSuccess).length;
        if (successCount === 0) {
          console.error("⚠️ Puppeteerで全てのページの取得に失敗しました");
          console.error("🔧 対処法:");
          console.error(
            "   1. スクレイピングサーバーが起動しているか確認（npm run server）"
          );
          console.error("   2. ネットワーク接続を確認");
          console.error("   3. 対象サイトがアクセス可能か確認");

          // エラーを投げて処理を停止
          throw new Error(
            "Puppeteerによるページ取得に失敗しました。上記の対処法を確認してください。"
          );
        }
      } catch (error) {
        console.error("❌ Puppeteer error:", error);
        console.error("🔧 対処法:");
        console.error("   1. スクレイピングサーバーを再起動: npm run server");
        console.error("   2. エラーメッセージを確認: ", error.message);

        // エラーを再投げして、上位で適切に処理させる
        throw error;
      }
    } else {
      // Puppeteerが利用できない場合はエラー
      throw new Error(
        "スクレイピングサービスが利用できません。サーバーを起動してください（cd server && node scraping-server.js）"
      );
    }

    // Step 4: 結果を整形
    const validArticles: ArticleAnalysis[] = [];
    let totalCharCount = 0;
    let successfulFetches = 0;

    for (let i = 0; i < Math.min(searchResults.length, targetCount); i++) {
      const searchResult = searchResults[i];
      const pageAnalysis = pageAnalyses[i];

      if (pageAnalysis && pageAnalysis.fetchSuccess) {
        successfulFetches++;
        totalCharCount += pageAnalysis.characterCount;
      }

      // WebFetchで実際のURLが取得できた場合はそれを使用
      const finalUrl =
        pageAnalysis?.url && pageAnalysis.url !== "URL_NOT_FOUND"
          ? pageAnalysis.url
          : searchResult.url || "URL取得中...";

      validArticles.push({
        rank: i + 1,
        url: finalUrl,
        title: searchResult.title || "タイトル取得失敗",
        summary: searchResult.snippet || "要約なし",
        characterCount: pageAnalysis?.characterCount || 0,
        isArticle: true,
        headingStructure: {
          h1: pageAnalysis?.h1 || searchResult.title,
          h2Items: pageAnalysis?.h2Items || [
            {
              text: pageAnalysis?.fetchSuccess
                ? "コンテンツ取得成功"
                : "コンテンツ取得失敗",
              h3Items: pageAnalysis?.error ? [pageAnalysis.error] : [],
            },
          ],
        },
      });
    }

    console.log(
      `\n✅ WebFetch completed: ${successfulFetches}/${validArticles.length} pages successfully analyzed`
    );

    // デバッグ: 最初の記事のH2/H3構造を表示
    if (validArticles.length > 0) {
      const firstArticle = validArticles[0];
      console.log("\n📋 1位記事の見出し構造:");
      console.log(`  H1: ${firstArticle.headingStructure.h1}`);
      firstArticle.headingStructure.h2Items.slice(0, 3).forEach((h2, index) => {
        console.log(`  H2[${index + 1}]: ${h2.text}`);
        if (h2.h3Items && h2.h3Items.length > 0) {
          console.log(`    → ${h2.h3Items.length}個のH3あり`);
          h2.h3Items.slice(0, 2).forEach((h3, h3Index) => {
            console.log(`    H3[${h3Index + 1}]: ${h3}`);
          });
          if (h2.h3Items.length > 2) {
            console.log(`    ... 他${h2.h3Items.length - 2}個のH3`);
          }
        } else {
          console.log(`    → H3なし`);
        }
      });
      if (firstArticle.headingStructure.h2Items.length > 3) {
        console.log(
          `  ... 他${firstArticle.headingStructure.h2Items.length - 3}個のH2`
        );
      }

      // H3の統計情報
      const totalH3Count = firstArticle.headingStructure.h2Items.reduce(
        (sum, h2) => sum + (h2.h3Items ? h2.h3Items.length : 0),
        0
      );
      console.log(`  📊 H3合計: ${totalH3Count}個`);
    }

    // Step 5: 文字数の統計を計算
    const avgCharCount =
      successfulFetches > 0
        ? Math.round(totalCharCount / successfulFetches)
        : 0;

    // Step 6: 共通トピックを分析
    const topicsPrompt = `
以下の検索結果から、共通するトピックやテーマを5つ抽出してください：
${searchResults.map((r: any) => `- ${r.title}: ${r.snippet}`).join("\n")}

JSONで返してください：
{
  "commonTopics": ["トピック1", "トピック2", "トピック3", "トピック4", "トピック5"]
}`;

    // Geminiモデルを初期化
    const topicsModel = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    });

    const topicsResult = await topicsModel.generateContent(topicsPrompt);
    const topicsText = topicsResult.response.text();

    let commonTopics = [
      "SEO基礎",
      "内部対策",
      "外部対策",
      "コンテンツSEO",
      "テクニカルSEO",
    ];
    try {
      const topicsMatch = topicsText.match(/\{[\s\S]*\}/);
      if (topicsMatch) {
        const topicsData = JSON.parse(cleanJsonString(topicsMatch[0]));
        commonTopics = topicsData.commonTopics || commonTopics;
      }
    } catch (e) {
      console.error("Failed to parse topics");
    }

    // 頻出単語を分析
    const frequencyWords = await analyzeWordFrequency(validArticles);
    console.log(
      `📊 Analyzed frequency words: Top ${frequencyWords.length} words extracted`
    );

    // 最終結果を返す
    const result: CompetitorResearchResult = {
      keyword,
      analyzedAt: new Date().toISOString(),
      totalArticlesScanned: searchResults.length,
      excludedCount: 0,
      commonTopics,
      recommendedWordCount: {
        min: Math.max(3000, avgCharCount - 2000),
        max: avgCharCount + 3000,
        optimal: avgCharCount || 5000,
      },
      validArticles,
      frequencyWords,
    };

    console.log("\n🎉 Research completed with actual page content!");
    console.log(`📊 Statistics:`);
    console.log(`  - Total sites analyzed: ${validArticles.length}`);
    console.log(`  - Successful fetches: ${successfulFetches}`);
    console.log(
      `  - Average character count: ${avgCharCount.toLocaleString()} characters`
    );
    console.log(
      `  - Success rate: ${Math.round(
        (successfulFetches / validArticles.length) * 100
      )}%`
    );

    return result;
  } catch (error: any) {
    console.error("❌ Error in competitor research:", error);

    // ネットワークエラーやサーバーエラーの場合はフォールバック
    const isNetworkError =
      error?.message?.includes("fetch") ||
      error?.message?.includes("Failed to fetch") ||
      error?.message?.includes("TypeError") ||
      error?.message?.includes("network") ||
      error?.message?.includes("503") ||
      error?.message?.includes("502") ||
      error?.message?.includes("CORS") ||
      error?.message?.includes("RENDER_SERVER_DOWN") ||
      error?.message?.includes("Puppeteerによるページ取得に失敗");

    if (isNetworkError) {
      console.log("🔄 ネットワークエラー検出、Render自動復旧を試行");
      console.log("🔍 エラー詳細:", error?.message);
      throw new Error("RENDER_RESTART_REQUIRED");
    }

    throw new Error(`競合分析エラー: ${error?.message || String(error)}`);
  }
};
