import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompetitorResearchResult, ArticleAnalysis, HeadingStructure } from '../types';

// API初期化
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY;
if (!apiKey || apiKey === '' || apiKey === 'undefined') {
    throw new Error("GEMINI_API_KEY not set. Please check your .env file.");
}

const genAI = new GoogleGenerativeAI(apiKey);

// 競合分析用のレスポンススキーマ
// 注: 現在は使用していませんが、将来的な型安全性のために残しています
const competitorResearchSchema = {
  properties: {
    keyword: { type: "string" },
    analyzedAt: { type: "string" },
    totalArticlesScanned: { type: "number" },
    excludedCount: { type: "number" },
    commonTopics: {
      type: "array",
      items: { type: "string" }
    },
    recommendedWordCount: {
      type: "object",
      properties: {
        min: { type: "number" },
        max: { type: "number" },
        optimal: { type: "number" }
      },
      required: ["min", "max", "optimal"]
    },
    validArticles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "number" },
          url: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          characterCount: { type: "number" },
          isArticle: { type: "boolean" },
          excludeReason: { type: "string" },
          headingStructure: {
            type: "object",
            properties: {
              h1: { type: "string" },
              h2Items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    h3Items: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["text", "h3Items"]
                }
              }
            },
            required: ["h1", "h2Items"]
          }
        },
        required: ["rank", "url", "title", "summary", "characterCount", "isArticle", "headingStructure"]
      }
    }
  },
  required: ["keyword", "analyzedAt", "totalArticlesScanned", "excludedCount", "commonTopics", "recommendedWordCount", "validArticles"]
};

export const generateCompetitorResearch = async (keyword: string): Promise<CompetitorResearchResult> => {
  const prompt = `あなたは熟練のSEOアナリストです。以下の手順で「${keyword}」に関する競合分析を実行してください。

## 分析手順

1. **Google検索の実行**
   - キーワード「${keyword}」で日本のGoogle検索を実行
   - 検索結果の上位20位までを取得
   - スポンサー広告（リスティング広告）は除外

2. **記事の分類とフィルタリング**
   - 各URLにアクセスして内容を確認
   - 以下は除外対象：
     * ショッピングサイト（ECサイト、商品販売ページ）
     * PDFファイル
     * 動画コンテンツ
     * SNS投稿
     * 求人情報
     * 企業の会社概要ページ
   - コラム記事、ブログ記事、解説記事、ハウツー記事のみを対象とする

3. **上位10記事の詳細分析**
   - 有効な記事から上位10個を選定
   - 各記事について以下を抽出：
     * URL
     * タイトル（ページタイトル）
     * 記事の要約（100-150文字程度）
     * 本文の総文字数（日本語の文字数）
     * H1タグの内容
     * H2タグとその配下のH3タグの階層構造

4. **共通トピックの抽出**
   - 上位記事に共通して含まれるトピックやテーマを特定
   - 読者が求めている情報を分析

5. **推奨文字数の算出**
   - 有効な記事の文字数分布から最適な文字数を提案

## 出力形式

以下のJSON形式で出力してください：

{
  "keyword": "${keyword}",
  "analyzedAt": "現在の日時（ISO形式）",
  "totalArticlesScanned": 検査した記事の総数,
  "excludedCount": 除外した記事の数,
  "commonTopics": ["共通トピック1", "共通トピック2", ...],
  "recommendedWordCount": {
    "min": 最小推奨文字数,
    "max": 最大推奨文字数,
    "optimal": 最適文字数
  },
  "validArticles": [
    {
      "rank": 順位,
      "url": "記事のURL",
      "title": "記事のタイトル",
      "summary": "記事の要約",
      "characterCount": 文字数,
      "isArticle": true,
      "headingStructure": {
        "h1": "H1タグの内容",
        "h2Items": [
          {
            "text": "H2の内容",
            "h3Items": ["H3の内容1", "H3の内容2"]
          }
        ]
      }
    }
  ]
}

注意事項：
- 必ず実際のGoogle検索結果を使用してください
- 見出し構造は実際のHTML構造を正確に反映してください
- 文字数は本文のみをカウント（ヘッダー、フッター、ナビゲーションは除外）
- 要約は記事の主要な内容を簡潔にまとめてください`;

  try {
    console.log('Starting competitor research for keyword:', keyword);
    
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3.6-flash"
    });
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    console.log('Received response from Gemini API');
    
    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from response');
    }
    
    // JSONをパース
    const parsedJson = JSON.parse(jsonMatch[0]);
    
    return parsedJson as CompetitorResearchResult;

  } catch (error: any) {
    console.error("❌ Error in competitor research:", error);
    
    // エラーハンドリング
    if (error?.message) {
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        throw new Error('API認証エラー: APIキーが無効です。');
      }
      if (error.message.includes('429')) {
        throw new Error('レート制限エラー: しばらくしてから再度お試しください。');
      }
    }
    
    throw new Error(`競合分析エラー: ${error?.message || String(error)}`);
  }
};