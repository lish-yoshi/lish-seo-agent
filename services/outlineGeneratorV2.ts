// 構成案生成サービス Ver.2
// SEO構成ワークフローに基づいた新しい構成案生成

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { 
  SeoOutlineV2, 
  CompetitorResearchResult, 
  ArticleAnalysis,
  FrequencyWord,
  OutlineSectionV2,
  IntroductionPatterns,
  CompetitorComparisonSummary
} from '../types';
import { countCharacters, truncateToLength } from '../utils/characterCounter';
import { generateTitleHook, generateFullTitle } from '../utils/titleHookGenerator';
// 自社サービス関連のimportは汎用化のため削除
// import { getCompanyInfo, generateCompanyContext } from './companyService';
// import { curriculumDataService } from './curriculumDataService';
import { getContextForKeywords, isSupabaseAvailable } from './primaryDataService';

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set.");
}
const genAI = new GoogleGenerativeAI(apiKey);

/**
 * キーワードをスマート分割
 *
 * 1. スペースで分割
 * 2. ノイズワード（「生成AI」「AI」など）を除外
 * 3. 重複排除
 * 4. フォールバック: 空配列なら元キーワードをそのまま返す
 */
function smartSplitKeywords(keyword: string): string[] {
  // ノイズワード定義（大文字小文字・全角半角を正規化して比較）
  const noiseWords = ['生成AI', '生成ai', 'AI', 'ai', 'ＡＩ'];

  // 正規化関数（全角→半角、大文字→小文字）
  const normalize = (str: string) =>
    str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
       .toLowerCase();

  // スペースで分割
  const words = keyword.split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean); // 空文字除去

  // スペースで分割できなかった場合（日本語キーワード等）
  if (words.length === 0 || (words.length === 1 && words[0] === keyword)) {
    console.log(`[smartSplitKeywords] スペース分割不可 → 元キーワードで検索: "${keyword}"`);
    return [keyword];
  }

  // ノイズワード除外（正規化して比較）
  const normalizedNoiseWords = noiseWords.map(normalize);
  const filtered = words.filter(w => {
    const normalized = normalize(w);
    return !normalizedNoiseWords.includes(normalized);
  });

  // 重複除去
  const unique = [...new Set(filtered)];

  // フォールバック: 全てノイズワードだった場合
  if (unique.length === 0) {
    console.log(`[smartSplitKeywords] 全てノイズワード → 元キーワードで検索: "${keyword}"`);
    return [keyword];
  }

  console.log(`[smartSplitKeywords] "${keyword}" → ${JSON.stringify(unique)}`);
  return unique;
}

// 競合記事のFAQ有無を判定
function detectCompetitorFAQ(articles: ArticleAnalysis[]): {
  hasFAQ: boolean;
  faqCount: number;
  faqPercentage: number;
} {
  const faqPatterns = /FAQ|よくある質問|Q&A|疑問|質問と回答|お問い合わせ/i;
  
  const articlesWithFAQ = articles.filter(article => {
    return article.headingStructure.h2Items.some(h2 => 
      faqPatterns.test(h2.text)
    );
  });
  
  const faqCount = articlesWithFAQ.length;
  const faqPercentage = (faqCount / articles.length) * 100;
  
  // 30%以上の記事がFAQを含む場合、FAQありと判定
  const hasFAQ = faqPercentage >= 30;
  
  console.log(`📊 FAQ分析: ${faqCount}/${articles.length}記事 (${faqPercentage.toFixed(0)}%) がFAQを含む`);
  console.log(`   判定: ${hasFAQ ? 'FAQ必要' : 'FAQ不要'}`);
  
  return {
    hasFAQ,
    faqCount,
    faqPercentage
  };
}

// ノイズ記事を除外して平均値を計算（FAQ調整付き）
function calculateAveragesExcludingNoise(
  articles: ArticleAnalysis[],
  keyword: string
): {
  averageH2Count: number;
  averageH3Count: number;
  averageCharCount: number;
  excludedArticles: number[];
  originalAverageH2: number;
  originalAverageH3: number;
  filteredArticles: ArticleAnalysis[];
  faqDetection: { hasFAQ: boolean; faqCount: number; faqPercentage: number };
  adjustedH2Count: number;  // 調整後のH2数
  adjustedH3Count: number;  // 調整後のH3数
} {
  // Step 1: 全記事での平均値を計算（除外前）
  const originalH2Avg = articles.reduce((sum, a) => sum + a.headingStructure.h2Items.length, 0) / articles.length;
  const originalH3Avg = articles.reduce((sum, a) => 
    sum + a.headingStructure.h2Items.reduce((h3Sum, h2) => h3Sum + h2.h3Items.length, 0), 0
  ) / articles.length;
  const originalCharAvg = articles.reduce((sum, a) => sum + a.characterCount, 0) / articles.length;
  
  // Step 2: 閾値を設定（平均の30%以下をノイズとする）
  const h2Threshold = originalH2Avg * 0.3;
  const h3Threshold = originalH3Avg * 0.3;
  const charThreshold = originalCharAvg * 0.2; // 文字数は20%以下を除外
  
  // Step 3: ノイズ記事を除外
  const excludedIndices: number[] = [];
  const filteredArticles = articles.filter((article, index) => {
    const h2Count = article.headingStructure.h2Items.length;
    const h3Count = article.headingStructure.h2Items.reduce((sum, h2) => sum + h2.h3Items.length, 0);
    const charCount = article.characterCount;
    
    // 除外条件：H2またはH3が閾値以下、または文字数が極端に少ない
    const shouldExclude = h2Count < h2Threshold || h3Count < h3Threshold || charCount < charThreshold;
    
    if (shouldExclude) {
      excludedIndices.push(index + 1); // 順位（1-based）
      console.log(`🚫 ノイズとして除外: ${index + 1}位 ${article.title}`);
      console.log(`   理由: H2=${h2Count}個(閾値${h2Threshold.toFixed(1)}), H3=${h3Count}個(閾値${h3Threshold.toFixed(1)}), 文字数=${charCount}(閾値${charThreshold.toFixed(0)})`);
    }
    
    return !shouldExclude;
  });
  
  // Step 4: フィルタ後の記事を最大10記事に制限（良質な記事を十分確保）
  const maxArticlesForAnalysis = 10;
  const finalArticles = filteredArticles.slice(0, maxArticlesForAnalysis);
  
  // Step 5: 最終的な平均値を計算
  const averageH2Count = Math.round(
    finalArticles.reduce((sum, a) => sum + a.headingStructure.h2Items.length, 0) / finalArticles.length
  );
  const averageH3Count = Math.round(
    finalArticles.reduce((sum, a) => 
      sum + a.headingStructure.h2Items.reduce((h3Sum, h2) => h3Sum + h2.h3Items.length, 0), 0
    ) / finalArticles.length
  );
  const averageCharCount = Math.round(
    finalArticles.reduce((sum, a) => sum + a.characterCount, 0) / finalArticles.length
  );
  
  // ログ出力
  console.log(`\n📊 ノイズ除外による平均値の変化（${keyword}）:`);
  console.log(`   初期対象: ${articles.length}記事（上位15記事まで）`);
  console.log(`   ノイズ除外後: ${filteredArticles.length}記事（${excludedIndices.length}記事除外）`);
  console.log(`   最終分析対象: ${finalArticles.length}記事（最大10記事に制限）`);
  console.log(`   H2平均: ${originalH2Avg.toFixed(1)}個 → ${averageH2Count}個`);
  console.log(`   H3平均: ${originalH3Avg.toFixed(1)}個 → ${averageH3Count}個`);
  console.log(`   文字数平均: ${originalCharAvg.toFixed(0)}文字 → ${averageCharCount}文字`);
  if (excludedIndices.length > 0) {
    console.log(`   除外記事: ${excludedIndices.join(', ')}位`);
  }
  
  // Step 6: FAQ検出
  const faqDetection = detectCompetitorFAQ(finalArticles);

  // Step 7: 調整後の数を計算
  // FAQは競合の状況に応じて追加
  const faqH2Addition = faqDetection.hasFAQ ? 0 : 0; // FAQは競合にある場合は平均に含まれているので追加しない
  const faqH3Addition = faqDetection.hasFAQ ? 0 : 0; // FAQのH3も同様

  const adjustedH2Count = averageH2Count + faqH2Addition;
  const adjustedH3Count = averageH3Count + faqH3Addition;

  console.log(`\n📊 最終調整後の目標値:`);
  console.log(`   基本H2数: ${averageH2Count}個`);
  console.log(`   + FAQ調整: ${faqH2Addition}個`);
  console.log(`   = 調整後H2数: ${adjustedH2Count}個`);
  console.log(`   基本H3数: ${averageH3Count}個`);
  console.log(`   = 調整後H3数: ${adjustedH3Count}個`)
  console.log('');
  
  return {
    averageH2Count,
    averageH3Count,
    averageCharCount,
    excludedArticles: excludedIndices,
    originalAverageH2: originalH2Avg,
    originalAverageH3: originalH3Avg,
    filteredArticles: finalArticles,  // 最大10記事に制限した最終的な記事リスト
    faqDetection,
    adjustedH2Count,
    adjustedH3Count
  };
}

// 検索意図の分類
function classifySearchIntent(keyword: string): { primary: string; secondary?: string } {
  const lowerKeyword = keyword.toLowerCase();
  
  // KNOW意図のパターン
  if (lowerKeyword.includes('とは') || lowerKeyword.includes('意味') || 
      lowerKeyword.includes('違い') || lowerKeyword.includes('理由')) {
    return { primary: 'KNOW' };
  }
  
  // DO意図のパターン
  if (lowerKeyword.includes('やり方') || lowerKeyword.includes('方法') || 
      lowerKeyword.includes('手順') || lowerKeyword.includes('使い方') ||
      lowerKeyword.includes('登録') || lowerKeyword.includes('料金')) {
    return { primary: 'DO' };
  }
  
  // NAV意図のパターン
  if (lowerKeyword.includes('公式') || lowerKeyword.includes('ログイン')) {
    return { primary: 'NAV' };
  }
  
  // LOCAL意図のパターン
  if (lowerKeyword.includes('近く') || lowerKeyword.includes('店舗') || 
      lowerKeyword.includes('営業時間')) {
    return { primary: 'LOCAL' };
  }
  
  // デフォルトはKNOW
  return { primary: 'KNOW' };
}

// FAQ見出しの生成（キーワードの種類に応じて適切な見出しを生成）
function generateFAQHeading(keyword: string): string {
  // キーワードの種類を判定
  const isProblematic = /問題|課題|リスク|デメリット|欠点|危険|懸念|注意/.test(keyword);
  const isComparison = /比較|違い|選び方|選定|検討/.test(keyword);
  const isBenefit = /メリット|効果|利点|価値|成果|効率/.test(keyword);
  const isImplementation = /導入|活用|実装|使い方|始め方|やり方/.test(keyword);
  const isBasic = /とは|基本|基礎|入門|初心者/.test(keyword);
  
  // 問題・課題系のキーワード
  if (isProblematic) {
    // キーワードから不要な部分を削除して整形
    const cleanKeyword = keyword.replace(/\s+/g, '').replace(/導入/, '');
    return `${cleanKeyword}に関するよくある質問`;
  }
  
  // 比較・選定系のキーワード
  if (isComparison) {
    return `${keyword}のよくある質問`;
  }
  
  // メリット・効果系のキーワード
  if (isBenefit) {
    return `${keyword}検討時のよくある質問`;
  }
  
  // 導入・活用系のキーワード（問題系でない場合のみ）
  if (isImplementation && !isProblematic) {
    return `${keyword}時のよくある質問`;
  }
  
  // 基本・入門系のキーワード
  if (isBasic) {
    // 問題系の場合は特別な処理
    if (isProblematic) {
      const cleanKeyword = keyword.replace(/\s+/g, '');
      return `${cleanKeyword}のよくある疑問を解決`;
    }
    return `${keyword}のよくある疑問を解決`;
  }
  
  // デフォルト（上記に該当しない場合）
  return `${keyword}に関するFAQ`;
}

// 上位3記事のH2順序の多数派を特定
function determineH2Order(topArticles: ArticleAnalysis[]): string[] {
  // 上位3記事を取得
  const top3 = topArticles.slice(0, 3);
  
  // H2のパターンを収集
  const h2Patterns: Map<string, number> = new Map();
  
  top3.forEach(article => {
    const h2Sequence = article.headingStructure.h2Items
      .map(item => {
        // 正規化（数字や記号を除去）
        return item.text
          .replace(/[0-9０-９①-⑩]/g, '')
          .replace(/【】「」『』\[\]/g, '')
          .replace(/^\d+\.\s*/, '')
          .trim();
      })
      .join(' → ');
    
    h2Patterns.set(h2Sequence, (h2Patterns.get(h2Sequence) || 0) + 1);
  });
  
  // 最も多いパターンを選択
  let maxCount = 0;
  let bestPattern = '';
  
  h2Patterns.forEach((count, pattern) => {
    if (count > maxCount) {
      maxCount = count;
      bestPattern = pattern;
    }
  });
  
  // パターンを個別のH2に分解
  return bestPattern.split(' → ').filter(h2 => h2.length > 0);
}

// -10%ルールに基づいてH2/H3数を調整
function applyMinusTenPercentRule(
  averageH2Count: number, 
  averageH3Count: number
): { minH2Count: number; minH3Count: number } {
  // -10%の下限を計算（切り上げ）
  const minH2Count = Math.ceil(averageH2Count * 0.9);
  const minH3Count = Math.ceil(averageH3Count * 0.9);
  
  return { minH2Count, minH3Count };
}

// H3の「0 or 2以上」ルールを適用
function adjustH3Count(h3Count: number): number {
  if (h3Count === 1) {
    return 0; // 1個の場合は0個にする
  }
  return h3Count;
}

// 鮮度判定
function checkFreshness(articles: ArticleAnalysis[]): {
  hasOutdatedInfo: boolean;
  outdatedSections: string[];
} {
  const currentYear = new Date().getFullYear();
  const outdatedSections: string[] = [];
  
  articles.forEach((article, index) => {
    // タイトルや内容に古い年号がある場合
    if (article.title.match(/20[12][0-9]/)) {
      const year = parseInt(article.title.match(/20[12][0-9]/)![0]);
      if (year < currentYear - 1) {
        outdatedSections.push(`記事${index + 1}: ${year}年の情報を含む`);
      }
    }
  });
  
  return {
    hasOutdatedInfo: outdatedSections.length > 0,
    outdatedSections
  };
}

// 具体的な画像提案を生成
function generateConcreteImageSuggestion(h2Title: string, searchIntent: string): string {
  const suggestions: { [key: string]: string } = {
    '基本': '3つの基本要素を示すベン図＋各要素に簡潔な説明テキスト',
    '種類': '各種類を比較する表形式のインフォグラフィック＋特徴アイコン',
    'メリット': 'メリットを示す上昇矢印グラフ＋数値データの注釈',
    'デメリット': '注意点を示すチェックリスト形式の図解＋対策方法の吹き出し',
    '手順': 'ステップバイステップのフローチャート＋各ステップの所要時間',
    '方法': '実践方法を示すスクリーンショット＋操作箇所への赤枠と番号',
    '事例': '成功事例のビフォーアフター比較図＋改善ポイントの強調',
    '比較': '競合比較表＋優位性を示す星評価とコメント',
    'ツール': 'ツール画面のスクリーンショット＋主要機能への注釈矢印',
    '費用': '料金プランの比較表＋おすすめプランのハイライト'
  };
  
  // キーワードに基づいて最適な提案を選択
  for (const [key, suggestion] of Object.entries(suggestions)) {
    if (h2Title.includes(key)) {
      return suggestion;
    }
  }
  
  // デフォルトの提案
  return `${h2Title}の概念を視覚的に説明する図解＋重要ポイント3つの注釈`;
}

// メイン生成関数
export async function generateOutlineV2(
  keyword: string,
  competitorResearch: CompetitorResearchResult,
  includeImages: boolean = true,
  generateTwoIntroductions: boolean = true // 導入文を2パターン生成するか
): Promise<SeoOutlineV2> {
  const searchIntent = classifySearchIntent(keyword);
  const validArticles = competitorResearch.validArticles;
  
  // 上位15記事から分析を開始（ノイズ除外後に良質な記事を十分確保）
  const top15Articles = validArticles.slice(0, Math.min(15, validArticles.length));
  const { 
    averageH2Count, 
    averageH3Count,
    averageCharCount,
    excludedArticles,
    filteredArticles,
    faqDetection,
    adjustedH2Count,
    adjustedH3Count
  } = calculateAveragesExcludingNoise(top15Articles, keyword);
  
  // -10%ルールの適用（調整後の値に対して適用）
  const { minH2Count, minH3Count } = applyMinusTenPercentRule(adjustedH2Count, adjustedH3Count);
  
  // H2順序の決定（上位3記事の多数派）
  const top3Articles = validArticles.slice(0, 3);
  const h2Order = determineH2Order(top3Articles);
  
  // 鮮度チェック
  const freshnessData = checkFreshness(validArticles);
  
  // 頻出単語から必須キーワードを抽出
  const mustIncludeWords = competitorResearch.frequencyWords
    ?.filter(w => w.articleCount >= 8)
    .map(w => w.word)
    .slice(0, 10) || [];
  
  // Geminiで構成案を生成
  // 現在の年を動的に取得
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  
  // 自社サービス情報は外部設定で管理（汎用版）
  
  // FAQ見出しを生成
  const faqHeading = generateFAQHeading(keyword);

  // Supabase一次情報を取得（補強目的）
  let primaryDataContext = '';
  if (isSupabaseAvailable()) {
    console.log('[OutlineV2] Supabaseから一次情報を取得中...');

    // キーワードをスマート分割（ノイズワード除外 + OR検索）
    const searchKeywords = smartSplitKeywords(keyword);
    console.log(`[OutlineV2] 検索キーワード: ${JSON.stringify(searchKeywords)}`);

    // キーワードから関連する一次情報を検索（最大10件）
    primaryDataContext = await getContextForKeywords(searchKeywords, { limit: 10 });
    if (primaryDataContext) {
      console.log('[OutlineV2] Supabase一次情報の取得成功');
    } else {
      console.log('[OutlineV2] 関連する一次情報が見つかりませんでした');
    }
  }

  const prompt = `
あなたはSEOに精通したコンテンツプランナーです。
現在は${currentYear}年${currentMonth}月です。必ず最新の${currentYear}年の情報を基に構成を作成してください。
以下の要件に従って、「${keyword}」の記事構成案を作成してください。

【⚠️ 最重要：絶対禁止事項 ⚠️】
制約条件:
  H2への番号付け禁止:
    - H2に順序番号（1. 2. 3.）を付けない
    - 例外: 「○選」「○つのポイント」型のH2のみ番号OK
    ❌悪い例: "1. 生成AIとは？" "2. 導入方法"
    ✅良い例: "生成AIとは？" "おすすめツール12選"
    
  H2_H3関係の絶対禁止パターン:
    - pattern: "H2が質問形 → H3が定義・概要"
      ❌悪い例:
        H2: "生成AIとは？"
        H3: ["生成AIの定義", "生成AIの概要", "生成AIについて"]
      ✅良い例:
        H2: "生成AIとは？"
        H3: ["基本的な仕組み", "主な種類と特徴", "従来のAIとの違い"]
    
    - pattern: "H2とH3が同じ意味"
      ❌悪い例:
        H2: "メリット"
        H3: ["利点", "良い点", "メリット1"]
      ✅良い例:
        H2: "メリット"
        H3: ["業務効率化", "コスト削減", "品質向上"]
    
    - pattern: "H2の言い換えをH3にする"
      ❌悪い例:
        H2: "実施方法"
        H3: ["やり方", "方法", "手法"]
      ✅良い例:
        H2: "実施方法"
        H3: ["事前準備", "環境構築", "実行手順"]

【✅ 正しいJSON構造の例】
以下のようにH2には番号を付けず、H3の関係を明確に分離してください：
{
  "outline": [
    {
      "heading": "SEO対策とは？基本から理解する",  // ← 番号なし
      "subheadings": [
        { "text": "検索エンジンの仕組みと役割" },
        { "text": "Googleアルゴリズムの評価基準" },
        { "text": "オーガニック検索と有料広告の違い" }
      ]
    },
    {
      "heading": "おすすめSEOツール5選",  // ← 「○選」型は番号なしでOK
      "subheadings": [
        { "text": "1. Google Search Console" },  // ← H3には通し番号
        { "text": "2. Ahrefs" },
        { "text": "3. SEMrush" },
        { "text": "4. Moz Pro" },
        { "text": "5. Ubersuggest" }
      ]
    }
  ]
}
※H2には順序番号を付けない。「○選」型のH3のみ通し番号

【重要な注意事項】
- 現在は${currentYear}年です。情報の鮮度が重要な場合のみ「${currentYear}年」を含めてください
- 古い情報や${currentYear - 1}年以前の情報は使用しないでください

【競合分析データ】
- 上位10記事の平均H2数（ノイズ除外後）: ${averageH2Count}
- 上位10記事の平均H3数（ノイズ除外後）: ${averageH3Count}
- 調整後のH2数: ${adjustedH2Count}
- 調整後のH3数: ${adjustedH3Count}
- 最小H2数（-10%ルール）: ${minH2Count}
- 最小H3数（-10%ルール）: ${minH3Count}
- FAQ判定: ${faqDetection.hasFAQ ? `必要（${faqDetection.faqPercentage.toFixed(0)}%の記事が含む）` : '不要'}
- 上位3記事のH2順序パターン: ${h2Order.join(' → ')}
- 頻出キーワード: ${mustIncludeWords.join(', ')}
- 除外されたノイズ記事数: ${excludedArticles.length}

【重要：上位10記事の実際の見出し構造】
${validArticles.slice(0, 10).map((article, idx) => `
${idx + 1}位：${article.title}
${article.headingStructure.h2Items.map((h2, h2Idx) => {
  const h3Count = h2.h3Items?.length || 0;
  const h3Preview = h3Count > 0 
    ? `\n    → H3: ${h2.h3Items.slice(0, 3).map(h3 => h3).join(', ')}${h3Count > 3 ? ` 他${h3Count - 3}個` : ''}`
    : '';
  return `  H2[${h2Idx + 1}]: ${h2.text}（H3: ${h3Count}個）${h3Preview}`;
}).join('\n')}
`).join('\n')}

【分析のポイント】
${(() => {
  // 「おすすめ○選」パターンの検出（上位10記事から）
  const recommendPatterns = validArticles.slice(0, 10).flatMap(article => 
    article.headingStructure.h2Items.filter(h2 => 
      h2.text.match(/おすすめ|選|比較|ランキング|厳選/)
    )
  );
  
  if (recommendPatterns.length > 0) {
    const numbers = recommendPatterns.map(h2 => {
      const match = h2.text.match(/(\d+)[選個社つ]/);
      return match ? parseInt(match[1]) : null;
    }).filter(n => n !== null);
    
    const avgNumber = numbers.length > 0 
      ? Math.round(numbers.reduce((a, b) => a + b, 0) / numbers.length)
      : 15;
    
    // 実際に使われているサービス名を抽出
    const serviceNames = recommendPatterns.flatMap(h2 => 
      h2.h3Items ? h2.h3Items.map(h3 => {
        // 番号や記号を除去してサービス名を抽出
        const cleanName = h3.replace(/^[\d①-⑳【】\.\s]+/, '').replace(/[【】].*$/, '').trim();
        return cleanName;
      }).filter(name => name.length > 0) : []
    );
    
    const uniqueServices = [...new Set(serviceNames)].slice(0, 20);
    
    return `- 競合は「おすすめ${avgNumber}選」のような具体的なサービス紹介を含んでいます
- このようなH2では、各H3に具体的なサービス名・企業名を列挙してください
- 競合が実際に紹介しているサービス例: ${uniqueServices.slice(0, 10).join('、')}${uniqueServices.length > 10 ? ` 他${uniqueServices.length - 10}社` : ''}
- 必ず番号付きで${avgNumber}個前後の具体的なサービス名を記載してください
- 例：「1. インソース」「2. トレノケート」「3. リクルートマネジメントソリューションズ」など`;
  }
  
  return '- 競合の見出し構造を参考に、同様の情報量を確保してください';
})()}

【タイトルフックの指示】
${(() => {
  // 競合タイトルを取得（上位10記事）
  const competitorTitles = validArticles.slice(0, 10).map(a => a.title);
  // フックを生成
  const hook = generateTitleHook(keyword, competitorTitles, []);
  return `- 推奨フック: ${hook}
- 検索意図と競合分析に基づいて適切なフックを選択してください
- 情報の鮮度が重要な場合のみ「${currentYear}年」を含めてください`;
})()}


${primaryDataContext ? `
【補足：一次情報データベースからの関連情報】
以下は、社内データベースから取得した関連情報です。構成案に組み込める場合は活用してください（必須ではありません）：

${primaryDataContext}

注意事項：
- 上記の一次情報は信頼できる社内データですが、SEO検索意図を最優先してください
- 関連性が低い場合は無理に使用せず、検索意図に沿った構成を優先
- 使用する場合は、H2やH3の執筆メモに「一次情報より」と明記
` : ''}

【要件】
構成要件:
  タイトル:
    文字数: 
      min: 29
      max: 50
      ideal: 35
    キーワード位置: "冒頭5-10文字以内"
    禁止: ["自社サービス名"]
    隅付き括弧【】ルール:
      - "【】を使用する場合は、必ずタイトルの最初に配置"
      - "タイトルの途中や最後での【】使用は禁止"
      - "良い例：【${currentYear}年版】AI研修の導入ガイド"
      - "悪い例：AI研修の【${currentYear}年版】導入ガイド"
    読みやすさルール:
      - "漢字の単語同士が直接つながらないよう、適切な助詞（の、を、で、と等）を使用"
      - "悪い例：生成AI活用事例紹介、業務効率化実現方法"
      - "良い例：生成AIの活用事例を紹介、業務効率化を実現する方法"
      - "漢字が4文字以上連続しないよう配慮する"
    
  メタディスクリプション:
    文字数:
      min: 100
      max: 150
      target: 125
    必須: ["キーワード含有"]
    
  H2数:
    min: ${minH2Count}
    max: ${Math.floor(adjustedH2Count * 1.1)}
    ideal: ${adjustedH2Count}
    特殊ルール: "まとめH2は必須、H3は0個"

  H3総数:
    min: ${minH3Count}（競合平均の90%以上を確保）
    上限: なし（最小数を満たせば自由に設定可能）
    配分ルール:
      - "各H2: 0個 or 2個以上（1個禁止）"
      - "重要H2: 多めに配分"
      - "標準H2: 適度に配分"
      - "まとめH2: 必ず0個（絶対厳守）"
    重要: "まとめは例外なくH3を0個にすること。他のH2でH3数を調整する。"
その他のルール:
  見出しの重複禁止:
    - "同じ意図の見出しを別のH2/H3で繰り返さない"
    - "H2とその配下のH3で意味が重複しないよう注意"
    
  H2順序: "上位3記事の多数派順序を優先（最後2つは固定）"

  キーワード含有:
    方針: "自然に置き換え可能な場合のみH2に含める"
    優先度: "SEO効果と自然さのバランス重視"

  執筆メモ:
    H2: "最大200字"
    H3: "200-300字目安"
  固定順序:
    最後2つ: ["FAQ（ある場合）", "まとめ"]
    FAQ:
      位置: "まとめの前（ある場合のみ）"
      見出し形式: "キーワードを含めた具体的な見出し（15-25文字程度）"
      推奨見出し: "${faqHeading}"
      重要: "上記の推奨見出しを使用してください。これはキーワードの種類に応じて最適化されています"

      注意事項:
        - 「問題点」や「リスク」を含むキーワードに「導入」を付けない
        - キーワードの意味を理解して自然な日本語にする
        - 機械的な結合を避ける

      H3数: "3-5個（具体的な質問形式）"
    まとめ:
      フォーマット: "まとめ：${keyword}を含むサブタイトル"
      H3数: 0
      
  数字付き見出し:
    条件: "「○選」「○つのポイント」など内容として数を示す場合のみ"
    禁止: "単なる順序番号（1. 2. 3.）をH2に付けること"
    正しい例: "おすすめ生成AIツール12選【${currentYear}年最新】"
    間違い例: "1. 生成AIとは？"
    ルール:
      - "「○選」型のH2の場合、H3には通し番号必須（例：1. Jasper、2. Copy.ai）"
      - "H3数とH2タイトルの数字を一致させる"
      - "通常のH2には番号を付けない"

【JSON形式で出力】
重要: outline配列内のsubheadingsの総数が${minH3Count}個以上になるようにしてください（上限なし）。
注意: H2とH3で意味が重複しないよう、H3は具体的な要素分解にすること。

{
  "title": "タイトル",
  "metaDescription": "メタディスクリプション",
  "introductions": {
    "empathy": "共感型の導入文"
  },
  "targetAudience": "ターゲット読者",
  "outline": [
    {
      "heading": "SEO対策とは？基本から理解する",
      "subheadings": [
        { "text": "検索エンジンの仕組みと役割", "writingNote": "クローラー、インデックス、ランキングアルゴリズムの解説" },
        { "text": "Googleアルゴリズムの評価基準", "writingNote": "E-E-A-T、Core Web Vitals等の主要指標" },
        { "text": "オーガニック検索と有料広告の違い", "writingNote": "SEOとSEMの比較、それぞれのメリット" },
        { "text": "モバイルファーストインデックスの重要性", "writingNote": "スマホ対応が必須な理由と影響" },
        { "text": "ローカルSEOと音声検索への対応", "writingNote": "地域ビジネスと新しい検索形態" }
      ],
      "writingNote": "SEOの概念を要素分解して説明。「とは」の答えとなる具体的な仕組みや特徴を各H3で展開"
    },
    {
      "heading": "効果的なSEO対策の実践方法",
      "subheadings": [
        { "text": "キーワード選定の基本戦略", "writingNote": "検索ボリューム、競合性、関連性の分析方法" },
        { "text": "コンテンツ最適化のポイント", "writingNote": "タイトル、見出し、本文の最適化手法" },
        { "text": "内部リンク構造の設計", "writingNote": "サイト構造とリンクジュースの流れ" },
        { "text": "ページスピードの改善手法", "writingNote": "Core Web Vitalsの改善方法" },
        { "text": "モバイルユーザビリティの向上", "writingNote": "レスポンシブデザインとUX改善" }
      ],
      "writingNote": "実践的な対策方法を具体的に解説。各H3で異なる施策を説明"
    }
    // 他のH2も同様に、H2の問いや主題に対する具体的な要素をH3で展開
  ],
  "conclusion": "まとめの内容",
  "keywords": ["キーワード1", "キーワード2"],
  "differentiators": ["差分1", "差分2", "差分3"]
}`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3.7-flash",
      generationConfig: {
        temperature: 0.5, // バランス重視（創造性と正確性）
        maxOutputTokens: 16000, // トークン数を増やして詳細な構成を生成可能に
        responseMimeType: "application/json"
      }
    });

    const result = await model.generateContent(prompt);
    let responseText = result.response.text();
    
    // JSONの前後の不要な文字を削除
    responseText = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    responseText = responseText.trim();
    
    // JSONパースを試みる
    let generatedData;
    try {
      generatedData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('JSONパースエラー:', parseError);
      console.error('Response text:', responseText.substring(0, 500));
      throw new Error('構成案の生成でJSONパースに失敗しました');
    }
    
    // タイトルの隅付き括弧【】の位置を修正
    let processedTitle = generatedData.title;
    
    // タイトル中央や最後にある【】を検出して修正
    const bracketMatch = processedTitle.match(/(.+?)(【.+?】)(.+)/);
    if (bracketMatch) {
      // 【】が途中にある場合、先頭に移動
      console.log(`⚠️ タイトルの【】位置を修正: ${processedTitle}`);
      
      // 【】を先頭に移動し、適切な接続を判断
      const bracketContent = bracketMatch[2];
      const beforeBracket = bracketMatch[1].trim();
      const afterBracket = bracketMatch[3].trim();
      
      // 文脈に応じて最適な接続を選択
      let connector = '';
      
      // 後続が「解説」「紹介」「説明」の場合は「を」
      if (afterBracket.match(/^(解説|紹介|説明|徹底解説|詳細説明|完全解説)/)) {
        connector = 'を';
      }
      // 後続が「比較」の場合は「の」
      else if (afterBracket.match(/^(比較|違い|メリット|デメリット|特徴|ポイント)/)) {
        connector = 'の';
      }
      // 後続が動詞的な名詞の場合は「で」
      else if (afterBracket.match(/^(実現|達成|成功|改善|向上|効率化)/)) {
        connector = 'で';
      }
      // 並列関係の場合は「と」
      else if (beforeBracket.match(/\d+[選個つ]$/) && afterBracket.match(/^(導入|活用|実践|選び方|使い方)/)) {
        connector = 'と';
      }
      // 前後が名詞で並列の場合は「・」
      else if (beforeBracket.match(/方法$|手法$|事例$/) && afterBracket.match(/^(注意点|ポイント|コツ)/)) {
        connector = '・';
      }
      // デフォルトは接続なし（文脈で自然に繋がる場合）
      else {
        // 漢字が連続する場合のみ「の」を追加
        const lastCharBefore = beforeBracket.slice(-1);
        const firstCharAfter = afterBracket.slice(0, 1);
        if (lastCharBefore.match(/[\u4e00-\u9faf]/) && firstCharAfter.match(/[\u4e00-\u9faf]/)) {
          connector = 'の';
        }
      }
      
      // タイトルを再構成
      processedTitle = `${bracketContent}${beforeBracket}${connector}${afterBracket}`;
      console.log(`✅ 修正後: ${processedTitle}`);
    }
    
    // タイトルとメタディスクリプションの文字数調整
    const adjustedTitle = truncateToLength(processedTitle, 50);  // 32→50に変更（最大50文字まで許容）
    
    // メタディスクリプションの文字数チェックと調整
    let adjustedMetaDescription = generatedData.metaDescription;
    const metaDescLength = countCharacters(adjustedMetaDescription);
    
    if (metaDescLength < 100) {
      console.warn(`⚠️ メタディスクリプションが短すぎます: ${metaDescLength}文字`);
      // キーワードを追加して100文字以上にする
      const additionalText = `${keyword}について詳しく解説します。`;
      adjustedMetaDescription = adjustedMetaDescription + additionalText;
    }
    
    // 150文字を超える場合は切り捨て
    adjustedMetaDescription = truncateToLength(adjustedMetaDescription, 150);
    
    // 最終的な文字数をログ出力（切り捨て後）
    const finalLength = countCharacters(adjustedMetaDescription);
    if (metaDescLength < 100) {
      console.log(`✅ 補完・調整後: ${finalLength}文字（100-150文字の範囲内）`);
    }
    
    // 導入文の処理（後方互換性を保つため、conclusionFirstも含める）
    const introductions: IntroductionPatterns = {
      conclusionFirst: generatedData.introductions.conclusionFirst || generatedData.introductions.empathy || '',
      empathy: generatedData.introductions.empathy || ''
    };
    
    // H3の「0 or 2以上」ルールを適用（1個の場合は0個にする）
    const adjustedOutline: OutlineSectionV2[] = generatedData.outline.map((section: any, index: number) => {
      const h3Count = section.subheadings?.length || 0;
      
      // まとめ見出しの判定（最後の見出し、または「まとめ」を含む）
      const isLastSection = index === generatedData.outline.length - 1;
      const isSummarySection = section.heading.includes('まとめ') || 
                              section.heading.includes('最後に') || 
                              section.heading.includes('おわりに');
      
      // まとめ見出しの場合はH3を0個に、それ以外は1個の場合のみ0個にする
      let adjustedSubheadings;
      if (isLastSection || isSummarySection) {
        adjustedSubheadings = []; // まとめ見出しは必ずH3なし
      } else {
        adjustedSubheadings = h3Count === 1 ? [] : (section.subheadings || []);
      }
      
      // 画像提案を具体化
      const imageSuggestion = includeImages 
        ? generateConcreteImageSuggestion(section.heading, searchIntent.primary)
        : '';
      
      return {
        heading: section.heading,
        subheadings: adjustedSubheadings,
        imageSuggestion,
        writingNote: section.writingNote || ''
      };
    });
    
    // H3の総数をチェック
    const currentH3Total = adjustedOutline.reduce((sum, section) => sum + section.subheadings.length, 0);
    
    // H3が不足している場合は警告のみ（チェックエージェントで修正）
    if (currentH3Total < minH3Count) {
      console.warn(`⚠️ H3数が不足: ${currentH3Total}個 / 必要${minH3Count}個`);
      console.log('チェックエージェントで修正します...');
    }
    
    // 競合比較サマリの作成
    const competitorComparison: CompetitorComparisonSummary = {
      averageH2Count,
      averageH3Count,
      ourH2Count: adjustedOutline.length,
      ourH3Count: currentH3Total,
      freshnessRisks: freshnessData.outdatedSections,
      differentiators: generatedData.differentiators || [
        `最新の${currentYear}年情報を反映`,
        '競合より詳細な実践手順を提供',
        '独自の成功事例を3件追加'
      ]
    };
    
    return {
      title: adjustedTitle,
      metaDescription: adjustedMetaDescription,
      introductions,
      targetAudience: generatedData.targetAudience,
      outline: adjustedOutline,
      conclusion: generatedData.conclusion,
      keywords: [...mustIncludeWords, ...generatedData.keywords].slice(0, 15),
      characterCountAnalysis: {
        average: averageCharCount || competitorResearch.recommendedWordCount?.optimal || 5000,
        median: averageCharCount || competitorResearch.recommendedWordCount?.optimal || 5000,
        min: competitorResearch.recommendedWordCount?.min || 3000,
        max: competitorResearch.recommendedWordCount?.max || 8000,
        analyzedArticles: validArticles.length || 10
      },
      competitorComparison,
      searchIntent,
      freshnessData: {
        hasOutdatedInfo: freshnessData.hasOutdatedInfo,
        outdatedSections: freshnessData.outdatedSections
      }
    };
    
  } catch (error) {
    console.error('構成案生成エラー:', error);
    throw new Error('構成案の生成に失敗しました');
  }
}