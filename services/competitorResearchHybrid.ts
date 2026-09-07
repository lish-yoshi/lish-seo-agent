import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompetitorResearchResult, ArticleAnalysis } from "../types";

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

// URLを抽出する関数
function extractActualUrl(title: string, vertexUrl?: string): string {
  // タイトルから会社名を抽出
  const patterns = [/- (.+?)$/, /｜(.+?)$/, /【(.+?)】/];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return "URL取得不可";
}

export const generateCompetitorResearch = async (
  keyword: string
): Promise<CompetitorResearchResult> => {
  console.log("🔍 Starting hybrid competitor research for:", keyword);

  // Step 1: Google検索で上位サイトを取得
  const searchPrompt = `
「${keyword}」でGoogle検索を実行し、上位20サイトの情報を取得してください。

以下の情報を正確に抽出してください：
1. 検索結果のタイトル（完全なもの）
2. URLまたはドメイン名（可能な限り）
3. 検索結果のスニペット（説明文）

重要な注意事項：
- 実際の検索結果のみを返してください
- ページの詳細内容は推測しないでください
- H2/H3構造は「不明」として扱ってください
- 文字数は「取得不可」として扱ってください

JSONで返してください：
{
  "searchResults": [
    {
      "rank": 1,
      "title": "完全なタイトル",
      "snippet": "検索結果のスニペット",
      "siteName": "サイト名（タイトルから抽出）"
    }
  ]
}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
      },
    });

    const searchResult = await model.generateContent(searchPrompt);
    const searchText = searchResult.response.text();

    // JSONを抽出
    let searchData;
    try {
      const jsonMatch = searchText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        searchData = JSON.parse(cleanJsonString(jsonMatch[0]));
      }
    } catch (e) {
      console.error("Failed to parse search results");
      searchData = { searchResults: [] };
    }

    // Step 2: 結果を整形
    const validArticles: ArticleAnalysis[] = [];
    const searchResults = searchData.searchResults || [];

    for (let i = 0; i < Math.min(10, searchResults.length); i++) {
      const result = searchResults[i];

      validArticles.push({
        rank: i + 1,
        url: result.siteName || extractActualUrl(result.title),
        title: result.title || "タイトル取得失敗",
        summary: result.snippet || "要約なし",
        characterCount: 0, // 取得不可
        isArticle: true,
        headingStructure: {
          h1: result.title || "不明",
          h2Items: [
            {
              text: "詳細なページ分析にはURL直接アクセスが必要です",
              h3Items: ["WebFetchツールまたは手動での分析が必要"],
            },
          ],
        },
      });
    }

    // Step 3: 共通トピックを分析
    const topicsPrompt = `
以下の検索結果から、共通するトピックやテーマを5つ抽出してください：
${searchResults.map((r: any) => `- ${r.title}: ${r.snippet}`).join("\n")}

JSONで返してください：
{
  "commonTopics": ["トピック1", "トピック2", "トピック3", "トピック4", "トピック5"]
}`;

    const topicsResult = await model.generateContent(topicsPrompt);
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

    // 最終結果を返す
    const result: CompetitorResearchResult = {
      keyword,
      analyzedAt: new Date().toISOString(),
      totalArticlesScanned: searchResults.length,
      excludedCount: Math.max(0, 20 - searchResults.length),
      commonTopics,
      recommendedWordCount: {
        min: 0,
        max: 0,
        optimal: 0,
      },
      validArticles,
    };

    console.log("✅ Research completed with limitations noted");
    return result;
  } catch (error: any) {
    console.error("❌ Error in competitor research:", error);
    throw new Error(`競合分析エラー: ${error?.message || String(error)}`);
  }
};
