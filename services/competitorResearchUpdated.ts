import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompetitorResearchResult } from '../types';

// API初期化
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === '' || apiKey === 'undefined') {
    throw new Error("GEMINI_API_KEY not set. Please check your .env file.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// JSON文字列からコメントを除去する関数
function cleanJsonString(str: string): string {
  // 文字列を一時的に置換
  const stringTokens: string[] = [];
  let tokenIndex = 0;
  
  // 文字列を一時的にトークンに置換（文字列内のコメント記号を保護）
  str = str.replace(/"([^"\\]|\\.)*"/g, (match) => {
    const token = `__STRING_${tokenIndex}__`;
    stringTokens[tokenIndex] = match;
    tokenIndex++;
    return token;
  });
  
  // コメントを除去
  str = str.replace(/\/\*[\s\S]*?\*\//g, ''); // /* ... */ 形式のコメント
  str = str.replace(/\/\/.*$/gm, ''); // // 形式のコメント
  
  // 文字列を元に戻す
  stringTokens.forEach((string, index) => {
    str = str.replace(`__STRING_${index}__`, string);
  });
  
  // 末尾のカンマを除去
  str = str.replace(/,(\s*[}\]])/g, '$1');
  
  return str.trim();
}

export const generateCompetitorResearch = async (keyword: string): Promise<CompetitorResearchResult> => {
  const prompt = `あなたは熟練のSEOアナリストです。「${keyword}」というキーワードで上位表示されている記事を分析してください。

【重要な指示】
- 純粋なJSONのみを出力してください
- コメント（//や/* */）を含めないでください
- 説明文や前置きは不要です
- 以下の形式に厳密に従ってください
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
      "url": "https://example.com/article1",
      "title": "記事タイトル",
      "summary": "記事の要約（100-150文字）",
      "characterCount": 5000,
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

注意：
- 実際の検索結果を想定して、リアルな内容を生成してください
- ショッピングサイトやPDFは除外してください
- 上位10記事の詳細を含めてください`;

  try {
    console.log('Starting competitor research for keyword:', keyword);
    
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3.6-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      }
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('Received response from Gemini API');
    console.log('Response preview:', text.substring(0, 200));
    
    // JSONを抽出してクリーニング
    let jsonText = text;
    
    // コードブロックからJSONを抽出
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      jsonText = jsonMatch[1];
    }
    
    // JSONをクリーニング
    jsonText = cleanJsonString(jsonText);
    
    console.log('Cleaned JSON preview:', jsonText.substring(0, 200));
    
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Failed JSON:', jsonText.substring(0, 500));
      
      // フォールバックとして、最初の{から最後の}までを抽出
      const fallbackMatch = text.match(/{[\s\S]*}/);
      if (fallbackMatch) {
        const cleanedFallback = cleanJsonString(fallbackMatch[0]);
        parsedJson = JSON.parse(cleanedFallback);
      } else {
        throw new Error('JSONの解析に失敗しました。レスポンス形式が不正です。');
      }
    }
    
    return parsedJson as CompetitorResearchResult;

  } catch (error: any) {
    console.error("❌ Error in competitor research:", error);
    
    if (error?.message?.includes('API key')) {
      throw new Error('API認証エラー: APIキーが無効です。');
    }
    if (error?.message?.includes('quota')) {
      throw new Error('APIクォータエラー: 利用制限に達しました。');
    }
    
    throw new Error(`競合分析エラー: ${error?.message || String(error)}`);
  }
};