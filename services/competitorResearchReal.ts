import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompetitorResearchResult } from "../types";

// API初期化
const apiKey =
  import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === "" || apiKey === "undefined") {
  throw new Error("GEMINI_API_KEY not set. Please check your .env file.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// JSON文字列からコメントを除去する関数
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

// タイトルからドメインを推測する関数
function extractDomainFromTitle(title: string): string {
  // 一般的なパターンから会社名やサイト名を抽出
  const patterns = [
    /- (.+?)$/, // 「- サイト名」パターン
    /｜(.+?)$/, // 「｜サイト名」パターン
    /【(.+?)】/, // 「【サイト名】」パターン
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return "不明";
}

export const generateCompetitorResearch = async (
  keyword: string
): Promise<CompetitorResearchResult> => {
  const prompt = `「${keyword}」でGoogle検索を実行し、上位20サイトを分析してください。

以下の手順で分析を行ってください：
1. Google検索で「${keyword}」を検索
2. 広告、ショッピング、PDF、動画を除外
3. 上位の記事系コンテンツ10個を詳細分析
4. 各記事について以下を抽出：
   - タイトル（完全なページタイトル）
   - サイト名または会社名
   - コンテンツの要約（100-150文字）
   - 推定文字数
   - 見出し構造の分析

必ず以下のJSON形式で出力してください（コメントなし）：
{
  "keyword": "${keyword}",
  "analyzedAt": "${new Date().toISOString()}",
  "totalArticlesScanned": 20,
  "excludedCount": 10,
  "commonTopics": ["トピック1", "トピック2", "トピック3"],
  "recommendedWordCount": {
    "min": 3000,
    "max": 7000,
    "optimal": 5000
  },
  "validArticles": [
    {
      "rank": 1,
      "url": "サイト名またはドメイン",
      "title": "実際のページタイトル",
      "summary": "コンテンツの要約",
      "characterCount": 5000,
      "isArticle": true,
      "headingStructure": {
        "h1": "メインの見出し",
        "h2Items": [
          {
            "text": "H2見出し",
            "h3Items": ["H3見出し1", "H3見出し2"]
          }
        ]
      }
    }
  ]
}`;

  try {
    console.log("Starting real competitor research for:", keyword);

    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      tools: [
        {
          googleSearch: {},
        },
      ],
      generationConfig: {
        temperature: 1.0,
        maxOutputTokens: 8192,
      },
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("Received response from Gemini API with Google Search");
    console.log("Response preview:", text.substring(0, 200));

    // JSONを抽出してクリーニング
    let jsonText = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (jsonMatch && jsonMatch[1]) {
      jsonText = jsonMatch[1];
    } else {
      // コードブロックがない場合、JSONオブジェクトを直接探す
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonText = objectMatch[0];
      }
    }

    jsonText = cleanJsonString(jsonText);

    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonText);

      // URLがvertexaisearchの場合、タイトルからドメインを抽出
      if (parsedJson.validArticles) {
        parsedJson.validArticles = parsedJson.validArticles.map(
          (article: any) => {
            if (article.url && article.url.includes("vertexaisearch")) {
              // タイトルからサイト名を抽出
              const siteName = extractDomainFromTitle(article.title);
              article.url = siteName;
            }
            return article;
          }
        );
      }
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);
      console.error("Failed JSON:", jsonText.substring(0, 500));

      // フォールバック
      const fallbackMatch = text.match(/\{[\s\S]*\}/);
      if (fallbackMatch) {
        const cleanedFallback = cleanJsonString(fallbackMatch[0]);
        parsedJson = JSON.parse(cleanedFallback);
      } else {
        throw new Error("JSONの解析に失敗しました。");
      }
    }

    return parsedJson as CompetitorResearchResult;
  } catch (error: any) {
    console.error("❌ Error in competitor research:", error);

    if (error?.message?.includes("API key")) {
      throw new Error("API認証エラー: APIキーが無効です。");
    }
    if (error?.message?.includes("quota")) {
      throw new Error("APIクォータエラー: 利用制限に達しました。");
    }

    throw new Error(`競合分析エラー: ${error?.message || String(error)}`);
  }
};
