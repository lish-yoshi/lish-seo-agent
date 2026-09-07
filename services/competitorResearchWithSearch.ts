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

export const generateCompetitorResearch = async (
  keyword: string
): Promise<CompetitorResearchResult> => {
  const prompt = `You are an SEO analyst. Analyze the top-ranking articles for the keyword "${keyword}" in Japan.

IMPORTANT: You MUST use Google Search to find REAL websites ranking for this keyword. Do NOT use example.com or fake URLs.

Perform the following analysis:
1. Search Google for "${keyword}" in Japanese
2. Find the top 20 organic results (exclude ads, shopping, PDFs)
3. Analyze the top 10 valid articles
4. For each article, extract:
   - Actual URL (NOT example.com)
   - Actual title from the page
   - Summary of content (100-150 characters in Japanese)
   - Character count of main content
   - Heading structure (H1, H2, H3)

Return ONLY valid JSON in this exact format (no comments):
{
  "keyword": "${keyword}",
  "analyzedAt": "${new Date().toISOString()}",
  "totalArticlesScanned": [number of articles scanned],
  "excludedCount": [number of excluded articles],
  "commonTopics": [array of common topics found],
  "recommendedWordCount": {
    "min": [minimum word count],
    "max": [maximum word count],
    "optimal": [optimal word count]
  },
  "validArticles": [
    {
      "rank": [rank number],
      "url": "[REAL URL from search]",
      "title": "[REAL title]",
      "summary": "[actual summary]",
      "characterCount": [actual count],
      "isArticle": true,
      "headingStructure": {
        "h1": "[actual H1]",
        "h2Items": [
          {
            "text": "[actual H2]",
            "h3Items": ["[actual H3]"]
          }
        ]
      }
    }
  ]
}`;

  try {
    console.log(
      "Starting competitor research with Google Search for:",
      keyword
    );

    // Gemini 2.0 Flash with Google Search grounding
    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      generationConfig: {
        temperature: 1.0, // Recommended for search grounding
        maxOutputTokens: 8192,
      },
      tools: [{ googleSearch: {} }], // Enable Google Search
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log("Received response from Gemini API with Google Search");

    // Check for grounding metadata
    const metadata = (response as any).groundingMetadata;
    if (metadata) {
      console.log("Grounding metadata found:", metadata);
    }

    // JSONを抽出してクリーニング
    let jsonText = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (jsonMatch && jsonMatch[1]) {
      jsonText = jsonMatch[1];
    }

    jsonText = cleanJsonString(jsonText);

    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonText);
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);

      // フォールバック
      const fallbackMatch = text.match(/{[\s\S]*}/);
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
