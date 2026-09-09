// 構成案最適化サービス
// 競合分析データ（記事一覧、頻出単語、H2/H3構造）を基に構成案を最適化

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SeoOutline, CompetitorResearchResult, FrequencyWord, ArticleAnalysis } from '../types';

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// 競合のH2/H3構造を分析して共通パターンを抽出
function analyzeHeadingPatterns(articles: ArticleAnalysis[]): {
  commonH2Topics: string[];
  averageH2Count: number;
  averageH3PerH2: number;
  popularStructures: string[];
} {
  const h2Topics: Map<string, number> = new Map();
  let totalH2Count = 0;
  let totalH3Count = 0;
  
  // H2トピックの集計
  articles.forEach(article => {
    article.headingStructure.h2Items.forEach(h2Item => {
      // 簡易的な正規化（数字や記号を除去）
      const normalizedH2 = h2Item.text
        .replace(/[0-9０-９①-⑩]/g, '')
        .replace(/【】「」『』/g, '')
        .trim();
      
      h2Topics.set(normalizedH2, (h2Topics.get(normalizedH2) || 0) + 1);
      totalH3Count += h2Item.h3Items.length;
    });
    totalH2Count += article.headingStructure.h2Items.length;
  });
  
  // 頻出H2トピックを抽出（3記事以上で使用されているもの）
  const commonH2Topics = Array.from(h2Topics.entries())
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, _]) => topic);
  
  // 人気の構造パターンを特定
  const popularStructures: string[] = [];
  if (commonH2Topics.some(topic => topic.includes('基本') || topic.includes('基礎'))) {
    popularStructures.push('基礎知識 → 実践方法 → 応用・事例');
  }
  if (commonH2Topics.some(topic => topic.includes('メリット') || topic.includes('デメリット'))) {
    popularStructures.push('メリット・デメリットの比較構造');
  }
  if (commonH2Topics.some(topic => topic.includes('方法') || topic.includes('やり方'))) {
    popularStructures.push('ステップバイステップの実践ガイド');
  }
  
  return {
    commonH2Topics,
    averageH2Count: Math.round(totalH2Count / articles.length),
    averageH3PerH2: Math.round(totalH3Count / totalH2Count * 10) / 10,
    popularStructures
  };
}

// 頻出単語から重要なトピックを抽出
function extractImportantTopics(frequencyWords: FrequencyWord[]): {
  mustIncludeWords: string[];
  importantConcepts: string[];
} {
  // 8記事以上で使用されている単語は必須
  const mustIncludeWords = frequencyWords
    .filter(word => word.articleCount >= 8)
    .map(word => word.word)
    .slice(0, 10);
  
  // 5記事以上で使用されている単語は重要概念
  const importantConcepts = frequencyWords
    .filter(word => word.articleCount >= 5 && word.articleCount < 8)
    .map(word => word.word)
    .slice(0, 15);
  
  return {
    mustIncludeWords,
    importantConcepts
  };
}

// 競合の導入文パターンを分析
function analyzeIntroPatterns(articles: ArticleAnalysis[]): string {
  const patterns: string[] = [];
  
  // サマリーから共通パターンを抽出
  const summaries = articles.map(a => a.summary).filter(s => s && s !== "要約なし");
  
  if (summaries.some(s => s.includes('初心者') || s.includes('基本'))) {
    patterns.push('初心者向けの親しみやすい導入');
  }
  if (summaries.some(s => s.includes('解説') || s.includes('説明'))) {
    patterns.push('専門的な解説からスタート');
  }
  if (summaries.some(s => s.includes('方法') || s.includes('手順'))) {
    patterns.push('実践的なアプローチを強調');
  }
  
  return patterns.join('、') || '読者の課題に共感する導入';
}

// 最適化された構成案を生成
export async function generateOptimizedOutline(
  keyword: string,
  competitorResearch: CompetitorResearchResult,
  includeImages: boolean = false
): Promise<SeoOutline> {
  
  // 競合分析データから洞察を抽出
  const headingPatterns = analyzeHeadingPatterns(competitorResearch.validArticles);
  const importantTopics = competitorResearch.frequencyWords 
    ? extractImportantTopics(competitorResearch.frequencyWords)
    : { mustIncludeWords: [], importantConcepts: [] };
  const introPattern = analyzeIntroPatterns(competitorResearch.validArticles);
  
  // 上位5記事の詳細な見出し構造（H3数も含む）
  const topArticlesStructure = competitorResearch.validArticles
    .slice(0, 5)
    .map(article => ({
      rank: article.rank,
      title: article.title,
      h2Count: article.headingStructure.h2Items.length,
      h2Topics: article.headingStructure.h2Items.map(h2 => h2.text),
      h2WithH3Count: article.headingStructure.h2Items.map(h2 => 
        `${h2.text}（H3: ${h2.h3Items.length}個）`
      ),
      characterCount: article.characterCount
    }));
  
  // タイトルパターンを分析
  const titlePatterns = topArticlesStructure.map(a => a.title);
  const currentYear = new Date().getFullYear();
  
  const prompt = `
あなたはSEOエキスパートです。以下の競合分析データに基づいて、「${keyword}」で検索上位を獲得できる最適な記事構成案を作成してください。
現在は${currentYear}年です。

【上位記事のタイトル例】
${titlePatterns.map((title, i) => `${i + 1}位: ${title}`).join('\n')}

【競合分析の重要な洞察】
1. 頻出単語分析
   - 必須キーワード（8記事以上で使用）: ${importantTopics.mustIncludeWords.join(', ')}
   - 重要概念（5-7記事で使用）: ${importantTopics.importantConcepts.join(', ')}

2. 見出し構造の分析
   - 推奨H2数: ${headingPatterns.averageH2Count}個前後
   - 共通のH2トピック: ${headingPatterns.commonH2Topics.join(', ')}
   - 人気の構成パターン: ${headingPatterns.popularStructures.join(', ')}
   
   【重要】H3の数は検索意図と内容の必要性に応じて決定してください：
   - 「〇〇10選」のような列挙型 → 10個のH3
   - 「〇〇の方法」のようなハウツー型 → 手順数に応じたH3
   - 「〇〇とは」のような解説型 → 説明の深さに応じて0〜多数
   - 必ずしもすべてのH2にH3を付ける必要はない
   - 読者の検索意図を満たすために必要な数だけ設定する

3. 上位記事のH2-H3構造パターン（実際の競合サイトより）
   - 「〇〇とは」系のH2 → H3は0〜1個
   - 「具体的施策・方法」系のH2 → 内容の項目数に応じてH3を設定（5〜15個）  
   - 「メリット・デメリット」系のH2 → メリット数＋デメリット数のH3
   - 「仕組み・手順」系のH2 → プロセス数に応じたH3（3〜5個）
   - 「事例紹介」系のH2 → 事例数に応じたH3
   
4. 上位3記事のH2-H3構造（参考にすべき実例）
${topArticlesStructure.slice(0, 3).map(a => `
   【${a.rank}位】${a.title}（全${a.h2Count}個のH2）
   ${a.h2WithH3Count.join('\n   ')}
`).join('')}

4. 推奨仕様
   - 推奨文字数: ${competitorResearch.recommendedWordCount.optimal}文字
   - 導入文スタイル: ${introPattern}
   - 共通トピック: ${competitorResearch.commonTopics.join(', ')}

【作成指示】
1. タイトル: 
   - 上位記事のタイトルを直接参考にする
   - 最新の年度表記がある場合は現在の年（${currentYear}年など）を使用
   - 頻出単語を含む魅力的なタイトル

2. ターゲット: 上位記事が想定している読者層を明確に定義

3. 導入文: 競合の導入パターンを参考に、読者を引き込む導入

4. 見出し構成の鉄則:
   【1見出し1テーマの原則】
   - 各H2は1つの明確なテーマに絞る
   - H2で数を明示した場合（「3つの方法」等）、H3は必ずその数と一致させる
   - H2に数字がある場合、H3は「1. ○○」「2. ××」と番号を振る
   - H2に数字がない場合、H3は簡潔な名詞形にする
   
   【頻出単語の必須使用】
   - 上位20個の頻出単語のうち、最低15個（3/4）を見出しに含める
   - 必須キーワード（8記事以上）は必ず使用
   - 重要概念（5-7記事）も積極的に使用
   
   【H3数の設定】
   - 上記の「上位3記事のH2-H3構造」を参考に、競合の実例に合わせる
   - H2は${headingPatterns.averageH2Count}個前後（最後の1つは「まとめ」見出し）
   - 最後の「まとめ」H2にはH3を付けない（subheadingsは空配列）

5. 見出しの簡潔性と執筆メモ:
   【絶対的ルール】
   - H2: 最大15文字程度（数字を含む場合は「○○の3つ」形式）
   - H3: 最大10文字程度（番号付きの場合は「1. ○○」形式）
   - 説明や補足は見出しに含めない
   - コロン（：）やカッコ（）での説明追加は禁止
   
   【執筆メモの活用】
   - 見出しで説明したい詳細は「writingNote」に記載
   - 執筆時に触れるべきポイントを具体的に伝える
   - 例：「サイト速度、モバイルフレンドリー、構造化データについて解説」
   
   【良い例】
   H2: SEO対策のメリット・デメリット
   H3: 1. SEO対策のメリット
   H3writingNote: 「集客力向上、ブランド認知度向上、競合優位性について詳しく解説」
   H3: 2. SEO対策のデメリット  
   H3writingNote: 「時間と労力、専門知識の必要性、効果測定の難しさについて説明」
   
   【悪い例】
   H2: SEO対策のメリット・デメリット
   H3: 1. メリット：集客力向上、ブランド認知度向上、競合優位性（見出しに詰め込み）
   H3: 2. デメリット：時間と労力、専門知識の必要性、効果測定の難しさ（説明過多）
6. まとめ見出し: 最後のH2として「まとめ」を含む見出しを追加。バリエーション例：
   - 「まとめ：${keyword}を成功させるために」
   - 「${keyword}のまとめと今後の展望」
   - 「まとめ：${keyword}で押さえるべきポイント」
   - 「${keyword}についてのまとめ」
   - 「まとめ：${keyword}の活用方法」
   記事の内容に合わせて自然な表現を選択すること

${includeImages ? '各H2セクションに画像提案を含める' : '画像提案は不要'}

JSON形式で出力：
{
  "title": "タイトル",
  "targetAudience": "ターゲット読者",  
  "introduction": "導入文",
  "outline": [
    {
      "heading": "SEO対策のメリット・デメリット",
      "subheadings": [
        {
          "text": "1. SEO対策のメリット",
          "writingNote": "集客力向上、ブランド認知度向上、競合優位性について詳しく解説"
        },
        {
          "text": "2. SEO対策のデメリット",
          "writingNote": "時間と労力、専門知識の必要性、効果測定の難しさについて説明"
        }
      ],
      "writingNote": "メリット・デメリットを公平に説明し、読者が判断できるようにする",
      ${includeImages ? '"imageSuggestion": "画像提案"' : ''}
    },
    {
      "heading": "具体的な施策",
      "subheadings": [
        {"text": "テクニカルSEO", "writingNote": "サイト速度、モバイル対応、構造化データ等"},
        {"text": "コンテンツSEO", "writingNote": "キーワード最適化、高品質コンテンツ作成"},
        {"text": "外部SEO", "writingNote": "被リンク獲得、サイテーション、SNS活用"}
      ],
      "writingNote": "各施策の実践的な手法を解説",
      ${includeImages ? '"imageSuggestion": "画像提案"' : ''}
    },
    {
      "heading": "まとめ：（記事内容に応じた自然な表現）",
      "subheadings": [],
      ${includeImages ? '"imageSuggestion": "まとめのインフォグラフィック"' : ''}
    }
  ],
  "conclusion": "まとめの内容（本文）",
  "keywords": ["関連キーワード"],
  "characterCountAnalysis": {
    "average": ${competitorResearch.recommendedWordCount.optimal},
    "median": ${competitorResearch.recommendedWordCount.optimal},
    "min": ${competitorResearch.recommendedWordCount.min},
    "max": ${competitorResearch.recommendedWordCount.max},
    "analyzedArticles": ${competitorResearch.validArticles.length}
  }
}`;

  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3.6-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      }
    });

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // JSONを抽出
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from response');
    }
    
    const outline = JSON.parse(jsonMatch[0]);
    
    // 競合分析結果を追加
    outline.competitorResearch = competitorResearch;
    
    return outline;
    
  } catch (error) {
    console.error('構成案生成エラー:', error);
    throw error;
  }
}

// 既存の構成案を競合データで強化
export function enhanceOutlineWithCompetitorData(
  existingOutline: SeoOutline,
  competitorResearch: CompetitorResearchResult
): SeoOutline {
  const enhancedOutline = { ...existingOutline };
  
  // 競合分析データを追加
  enhancedOutline.competitorResearch = competitorResearch;
  
  // 頻出単語をキーワードに追加
  if (competitorResearch.frequencyWords) {
    const topWords = competitorResearch.frequencyWords
      .slice(0, 10)
      .map(w => w.word);
    
    enhancedOutline.keywords = [
      ...new Set([...enhancedOutline.keywords, ...topWords])
    ];
  }
  
  // 文字数分析を更新
  enhancedOutline.characterCountAnalysis = {
    average: competitorResearch.recommendedWordCount.optimal,
    median: competitorResearch.recommendedWordCount.optimal,
    min: competitorResearch.recommendedWordCount.min,
    max: competitorResearch.recommendedWordCount.max,
    analyzedArticles: competitorResearch.validArticles.length
  };
  
  return enhancedOutline;
}