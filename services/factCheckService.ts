// ファクトチェックサービス
// 最新の信頼できる情報を取得して記事の正確性を担保

import { searchGoogle } from './googleSearchService';
import { scrapeWithPuppeteer } from './puppeteerScrapingService';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY || '');

// 信頼できるドメインのリスト（優先順位付き）
const TRUSTED_DOMAINS = {
  // 最高信頼度：政府・公的機関
  government: [
    'go.jp',
    'gov',
    'mhlw.go.jp',
    'meti.go.jp',
    'soumu.go.jp',
    'cao.go.jp',
    'nta.go.jp',
    'mof.go.jp'
  ],
  // 高信頼度：大手メディア・専門機関
  authoritative: [
    'nikkei.com',
    'nhk.or.jp',
    'asahi.com',
    'yomiuri.co.jp',
    'mainichi.jp',
    'jiji.com',
    'kyodo.co.jp',
    'bloomberg.co.jp',
    'reuters.com',
    'nri.com',
    'mizuho-ir.co.jp',
    'murc.jp'
  ],
  // 中信頼度：大手企業・業界団体
  corporate: [
    'toyota.jp',
    'sony.co.jp',
    'panasonic.com',
    'microsoft.com',
    'google.com',
    'amazon.co.jp',
    'rakuten.co.jp',
    'yahoo.co.jp'
  ],
  // 避けるべきドメイン
  avoid: [
    'matome',
    'naver.jp',
    'wiki',
    'chiebukuro',
    'oshiete',
    'okwave',
    'blogspot',
    'fc2.com',
    'ameblo.jp',
    'note.com' // 個人ブログは基本的に避ける
  ]
};

// ドメインの信頼度スコアを計算
export function calculateDomainTrust(url: string): number {
  const domain = new URL(url).hostname.toLowerCase();
  
  // 政府・公的機関：100点
  if (TRUSTED_DOMAINS.government.some(trusted => domain.includes(trusted))) {
    return 100;
  }
  
  // 権威あるメディア：80点
  if (TRUSTED_DOMAINS.authoritative.some(trusted => domain.includes(trusted))) {
    return 80;
  }
  
  // 大手企業：60点
  if (TRUSTED_DOMAINS.corporate.some(trusted => domain.includes(trusted))) {
    return 60;
  }
  
  // 避けるべきドメイン：0点
  if (TRUSTED_DOMAINS.avoid.some(avoid => domain.includes(avoid))) {
    return 0;
  }
  
  // その他：30点
  return 30;
}

// 情報の鮮度スコアを計算（0-100点）
export function calculateFreshnessScore(dateString: string | null): number {
  if (!dateString) return 50; // 日付不明の場合は中間値
  
  try {
    const publishDate = new Date(dateString);
    const now = new Date();
    const daysDiff = Math.floor((now.getTime() - publishDate.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysDiff < 0) return 50; // 未来の日付は無効
    if (daysDiff <= 30) return 100; // 1ヶ月以内：100点
    if (daysDiff <= 60) return 80;  // 2ヶ月以内：80点
    if (daysDiff <= 90) return 60;  // 3ヶ月以内：60点
    if (daysDiff <= 180) return 40; // 6ヶ月以内：40点
    if (daysDiff <= 365) return 20; // 1年以内：20点
    return 10; // 1年以上前：10点
  } catch {
    return 50; // パースエラーの場合
  }
}

// 総合スコアを計算（ドメイン信頼度 × 鮮度）
export function calculateTotalScore(url: string, dateString: string | null): number {
  const domainScore = calculateDomainTrust(url);
  const freshnessScore = calculateFreshnessScore(dateString);
  
  // 重み付け：ドメイン60%、鮮度40%
  return Math.round(domainScore * 0.6 + freshnessScore * 0.4);
}

// ファクト情報の型定義
export interface FactInfo {
  topic: string;
  facts: Array<{
    fact: string;
    source: string;
    url: string;
    trustScore: number;
    date?: string;
  }>;
  summary: string;
}

// 検索クエリの生成（より正確な情報を取得するため）
function generateFactCheckQueries(topic: string, keyword: string): string[] {
  // 年月を付けずに、本来のキーワードで検索
  // 鮮度は検索結果の日付情報から判定する
  return [
    `${topic} とは`,
    `${topic} 最新`,
    `${topic} 統計 データ`,
    `${topic} 定義`,
    `${topic} 事例`,
    `${topic} メリット デメリット`,
    `${keyword} 最新情報`,
    `${keyword} 動向 トレンド`
  ];
}

// セクション用のファクトチェック
export async function checkFactsForSection(
  sectionHeading: string,
  keyword: string,
  subheadings?: string[]
): Promise<FactInfo> {
  console.log(`📊 ファクトチェック開始: ${sectionHeading}`);
  
  try {
    // 複数のクエリで検索
    const queries = generateFactCheckQueries(sectionHeading, keyword);
    const allSearchResults = [];
    
    for (const query of queries.slice(0, 3)) { // 最初の3クエリのみ（API制限対策）
      try {
        const results = await searchGoogle(query, '', '', 10);
        allSearchResults.push(...results);
      } catch (error) {
        console.warn(`検索スキップ: ${query}`, error);
      }
    }
    
    // 日付を抽出（スニペットから簡易的に）
    const extractDateFromSnippet = (snippet: string): string | null => {
      // 2024年12月、2024/12/15、2024-12-15 などのパターンを検出
      const patterns = [
        /(\d{4}年\d{1,2}月\d{1,2}日)/,
        /(\d{4}年\d{1,2}月)/,
        /(\d{4}\/\d{1,2}\/\d{1,2})/,
        /(\d{4}-\d{1,2}-\d{1,2})/
      ];
      
      for (const pattern of patterns) {
        const match = snippet.match(pattern);
        if (match) return match[1];
      }
      return null;
    };
    
    // 総合スコアでソート（ドメイン信頼度 + 鮮度）
    const trustedResults = allSearchResults
      .map(result => {
        const dateString = extractDateFromSnippet(result.snippet || '');
        const totalScore = calculateTotalScore(result.link, dateString);
        return {
          ...result,
          trustScore: totalScore,
          publishDate: dateString
        };
      })
      .filter(result => result.trustScore > 30) // 総合スコア30点以上
      .sort((a, b) => b.trustScore - a.trustScore)
      .slice(0, 5); // 上位5件
    
    // 信頼できるソースから詳細情報を取得
    const factData: FactInfo = {
      topic: sectionHeading,
      facts: [],
      summary: ''
    };
    
    // スクレイピングで詳細取得（上位3件）
    for (const result of trustedResults.slice(0, 3)) {
      try {
        console.log(`📝 詳細取得: ${result.link} (信頼度: ${result.trustScore})`);
        const scrapedData = await scrapeWithPuppeteer(result.link);
        
        if (scrapedData && scrapedData.characterCount > 500) {
          // スクレイピングで取得した日付があればそれを優先
          const effectiveDate = scrapedData.modifiedDate || scrapedData.publishDate || result.publishDate;
          const updatedScore = calculateTotalScore(result.link, effectiveDate);
          
          // AIでファクト抽出
          const facts = await extractFactsWithAI(
            sectionHeading,
            scrapedData.h1,
            scrapedData.h2Items.map(h2 => h2.text).join('\n'),
            result.link,
            updatedScore
          );
          
          factData.facts.push(...facts);
        }
      } catch (error) {
        console.warn(`スクレイピングスキップ: ${result.link}`);
      }
    }
    
    // サマリー生成
    if (factData.facts.length > 0) {
      factData.summary = await generateFactSummary(sectionHeading, factData.facts);
    } else {
      // フォールバック：検索結果のスニペットから生成
      factData.summary = trustedResults
        .slice(0, 3)
        .map(r => r.snippet)
        .join(' ');
    }
    
    console.log(`✅ ファクトチェック完了: ${factData.facts.length}件の事実を収集`);
    return factData;
    
  } catch (error) {
    console.error('ファクトチェックエラー:', error);
    return {
      topic: sectionHeading,
      facts: [],
      summary: ''
    };
  }
}

// AIを使ってファクトを抽出
async function extractFactsWithAI(
  topic: string,
  h1: string,
  h2Contents: string,
  sourceUrl: string,
  trustScore: number
): Promise<Array<{ fact: string; source: string; url: string; trustScore: number; date?: string }>> {
  const prompt = `
以下のWebページから「${topic}」に関する重要な事実のみを抽出してください。

【ページタイトル】
${h1}

【コンテンツ概要】
${h2Contents.substring(0, 1000)}

【抽出ルール】
1. 数値データ、統計、年代を含む事実を優先
2. 具体的な企業名、製品名、事例を含む事実を抽出
3. 定義や基本的な説明も重要
4. 意見や推測ではなく、事実のみ
5. 最新の情報を優先

【出力形式】
JSON配列で以下の形式：
[
  {
    "fact": "抽出した事実（50文字以内）",
    "date": "該当する年月（あれば）"
  }
]

JSONのみ出力、説明不要。
`;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: {
        temperature: 0.1, // 事実抽出なので低温度
        maxOutputTokens: 1024,
      }
    });
    
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // JSON抽出
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const extractedFacts = JSON.parse(jsonMatch[0]);
    
    return extractedFacts.map((item: any) => ({
      fact: item.fact,
      source: h1,
      url: sourceUrl,
      trustScore: trustScore,
      date: item.date
    }));
    
  } catch (error) {
    console.error('AI事実抽出エラー:', error);
    return [];
  }
}

// ファクトのサマリー生成
async function generateFactSummary(
  topic: string,
  facts: Array<{ fact: string; source: string; trustScore: number }>
): Promise<string> {
  if (facts.length === 0) return '';
  
  const highTrustFacts = facts
    .filter(f => f.trustScore >= 60)
    .map(f => f.fact)
    .slice(0, 5);
  
  const prompt = `
以下の事実を基に、「${topic}」について50文字程度でまとめてください。

【信頼できる事実】
${highTrustFacts.join('\n')}

一文でシンプルにまとめてください。
`;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 256,
      }
    });
    
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
    
  } catch (error) {
    console.error('サマリー生成エラー:', error);
    return highTrustFacts[0] || '';
  }
}

// 記事全体のファクトチェック（執筆後のチェック用）
export async function verifyArticleFacts(
  htmlContent: string,
  keyword: string
): Promise<{
  verified: boolean;
  issues: Array<{
    text: string;
    issue: string;
    suggestion: string;
  }>;
}> {
  // 数値、年代、固有名詞を抽出してチェック
  const factsToCheck = extractVerifiableStatements(htmlContent);
  const issues = [];
  
  for (const statement of factsToCheck.slice(0, 5)) { // API制限のため5件まで
    try {
      const searchResults = await searchGoogle(
        `${statement} 事実確認`,
        '', 
        '', 
        5
      );
      
      // 信頼できるソースで確認できない場合は問題として記録
      const hasTrustedSource = searchResults.some(
        result => calculateDomainTrust(result.link) >= 60
      );
      
      if (!hasTrustedSource) {
        issues.push({
          text: statement,
          issue: '信頼できるソースで確認できません',
          suggestion: '公的機関や権威あるメディアのデータを参照してください'
        });
      }
    } catch (error) {
      console.warn(`事実確認スキップ: ${statement}`);
    }
  }
  
  return {
    verified: issues.length === 0,
    issues
  };
}

// 検証可能な文を抽出
function extractVerifiableStatements(htmlContent: string): string[] {
  const plainText = htmlContent.replace(/<[^>]*>/g, '');
  
  // 数値を含む文、年代を含む文、「によると」を含む文を抽出
  const patterns = [
    /\d+[％%][\s\S]{0,50}/g,
    /\d{4}年[\s\S]{0,50}/g,
    /約?\d+[万億千百]/g,
    /第\d+位/g,
    /によると[\s\S]{0,50}/g
  ];
  
  const statements = new Set<string>();
  
  patterns.forEach(pattern => {
    const matches = plainText.match(pattern) || [];
    matches.forEach(match => {
      const cleaned = match.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 10 && cleaned.length < 100) {
        statements.add(cleaned);
      }
    });
  });
  
  return Array.from(statements);
}