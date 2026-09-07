import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SeoOutline, GroundingChunk, CompetitorResearchResult } from '../types';

// 環境変数チェック（本番環境ではログ出力しない）
if (process.env.NODE_ENV !== 'production') {
  console.log('=== Environment Variable Debug ===');
  console.log('- GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
  console.log('- GEMINI_API_KEY value:', process.env.GEMINI_API_KEY ? '****' : 'NOT FOUND');
}

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey || apiKey === '' || apiKey === 'undefined') {
    throw new Error("GEMINI_API_KEY not set. Please check your .env file.");
}

if (process.env.NODE_ENV !== 'production') {
  console.log('✅ API key loaded successfully');
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

export const generateSeoOutline = async (
  keyword: string, 
  includeImages: boolean,
  competitorResearch?: CompetitorResearchResult
): Promise<{ outline: SeoOutline, sources: GroundingChunk[] | undefined }> => {
  const imageInstruction = includeImages
    ? `\n- 競合分析に基づき、各H2見出しセクションに対して内容を視覚的に補強する画像やインフォグラフィックの具体的なアイデアを提案してください。("imageSuggestion"フィールドに記載)`
    : `\n- 画像やインフォグラフィックの提案は一切含めないでください。`;

  // 競合分析データから情報を抽出
  const competitorData = competitorResearch ? `
【競合分析結果】
- 分析した上位サイト数: ${competitorResearch.validArticles.length}サイト
- 推奨文字数: ${competitorResearch.recommendedWordCount.optimal}文字（最小: ${competitorResearch.recommendedWordCount.min}文字、最大: ${competitorResearch.recommendedWordCount.max}文字）
- 共通トピック: ${competitorResearch.commonTopics.join(', ')}
- 上位サイトの見出し構造:
${competitorResearch.validArticles.slice(0, 5).map(article => 
  `  ${article.rank}位: ${article.title}
    文字数: ${article.characterCount}文字
    H2見出し数: ${article.headingStructure.h2Items.length}`
).join('\n')}
` : '';

  const prompt = `あなたはSEOエキスパートです。「${keyword}」というキーワードで検索上位を獲得できるブログ記事の構成案を作成してください。
${competitorData}

【重要な指示】
- 純粋なJSONのみを出力してください
- コメント（//や/* */）を含めないでください
- 説明文や前置きは不要です
${competitorResearch ? '- 上記の競合分析結果を必ず参考にして、より競争力のある構成を作成してください' : ''}
${competitorResearch ? '- 推奨文字数は競合分析に基づいて設定してください' : ''}

以下の要素を含む構成案を作成してください：
1. 魅力的なタイトル案
2. ターゲット読者層の定義
3. 導入部の要約
4. H2とH3から成る詳細な見出し構成${imageInstruction}
   - 最後のH2は「まとめ」を含む見出しにする
   - まとめ見出しは記事内容に応じて多様な表現を使う
     例：「まとめ：実践のポイント」「〇〇のまとめと注意点」「まとめ：成功への道筋」など
   - まとめ見出しにはH3（subheadings）を付けない
5. 結論部（まとめの本文内容）
6. 記事内に含めるべき共起語・関連キーワード
7. 推奨文字数の統計情報

【重要】以下のJSON形式で出力してください：
{
  "title": "記事タイトル",
  "targetAudience": "ターゲット読者",
  "introduction": "導入部",
  "outline": [
    {
      "heading": "H2見出し",
      "subheadings": ["H3見出し1", "H3見出し2"],
      ${includeImages ? '"imageSuggestion": "画像提案"' : ''}
    }
  ],
  "conclusion": "結論",
  "keywords": ["キーワード1", "キーワード2"],
  "characterCountAnalysis": {
    "average": ${competitorResearch ? competitorResearch.recommendedWordCount.optimal : 5000},
    "median": ${competitorResearch ? competitorResearch.recommendedWordCount.optimal : 4500},
    "min": ${competitorResearch ? competitorResearch.recommendedWordCount.min : 3000},
    "max": ${competitorResearch ? competitorResearch.recommendedWordCount.max : 7000},
    "analyzedArticles": ${competitorResearch ? competitorResearch.validArticles.length : 10}
  }
}`;

  try {
    console.log('Generating SEO outline for:', keyword);
    
    // Gemini Pro モデルを使用
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
    
    // 仮のsources（実際のGoogle Searchは別途実装が必要）
    const sources: GroundingChunk[] = [];
    
    return { outline: parsedJson as SeoOutline, sources };

  } catch (error: any) {
    console.error("❌ Error generating SEO outline:", error);
    
    if (error?.message?.includes('API key')) {
      throw new Error('API認証エラー: APIキーが無効です。');
    }
    if (error?.message?.includes('quota')) {
      throw new Error('APIクォータエラー: 利用制限に達しました。');
    }
    
    throw new Error(`構成案生成エラー: ${error?.message || String(error)}`);
  }
};