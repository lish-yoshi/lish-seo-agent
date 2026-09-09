// ライティングチェックエージェント Ver.3
// 執筆された記事の品質を多角的に評価・改善提案

import { GoogleGenerativeAI } from '@google/generative-ai';
import { curriculumDataService } from './curriculumDataService';
// latestAIModelsは汎用化のため削除

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY!);

interface CheckRequest {
  article: string;
  outline: string;
  keyword: string;
  competitorInfo?: any;
}

interface CheckResult {
  overallScore: number;
  scores: {
    seo: number;
    readability: number;
    accuracy: number;
    structure: number;
    value: number;
  };
  issues: Issue[];
  improvements: Improvement[];
  rewriteSuggestions: RewriteSuggestion[];
}

interface Issue {
  severity: 'critical' | 'major' | 'minor';
  category: string;
  description: string;
  location?: string;
}

interface Improvement {
  priority: 'high' | 'medium' | 'low';
  suggestion: string;
  expectedImpact: string;
}

interface RewriteSuggestion {
  original: string;
  suggested: string;
  reason: string;
}

const CHECK_CRITERIA = `
【最重要チェック項目】🔴
1. 固有名詞の正確性（特に重要）
   - 企業名、サービス名、製品名の表記確認
   - 人名、地名の正確な表記
   - ブランド名の統一性
   - 必ずWeb検索でファクトチェックを実施

2. 定量データ・数値の正確性（特に重要）
   - 統計データ、パーセンテージの正確性
   - 金額、価格情報の妥当性
   - 日付、期限の最新性
   - 実績数値の信頼性
   - 必ずWeb検索で最新情報と照合

【SEOチェック項目】
3. キーワード配置の適切性
   - タイトル、見出し、本文での自然な使用
   - キーワード密度（2-3%が理想）
   - 関連キーワードの使用

4. 構造の正確性と執筆メモ準拠度
   - 構成案との一致度
   - 見出し階層の適切性
   - 各セクションの文字数バランス
   - 執筆メモの要点が記事に反映されているか（8割以上の要素を確認）
   - H2・H3の執筆メモで指定された内容が適切に展開されているか

5. 読みやすさ
   - 文章の明瞭性
   - 段落構成の評価：
     * 200字を超える段落がないか（長すぎる段落の検出）
     * 話題転換で段落分けされているか
     * 「しかし」「一方で」「また」などの接続詞で適切に段落分けされているか
   - 箇条書き化の機会：
     * 並列的な情報（選択肢、メリット・デメリット等）が文章で羅列されていないか
     * 3つ以上の項目が「、」で繋がれていないか
     * ステップや手順が文章で説明されていないか
   - 専門用語の説明
   - 適切な接続詞の使用

6. 情報の正確性と価値
   - 事実の正確性（特に固有名詞と数値）
   - 最新情報の反映
   - 独自の視点や分析
   - 実用的なアドバイス

7. エンゲージメント要素
   - 導入部の魅力
   - 内部リンクの提案
   - ビジュアル要素の提案

【改善フロー】
- 評価が基準値（80点）未満の場合、改善提案を実施
- 特に固有名詞と数値の誤りは即座に修正必須
- 改善後、再評価を実施し、基準値達成まで継続

【見出しタグ内の<strong>タグ使用禁止】
- <h2>〜</h2>タグ内に<strong>タグが含まれていないか確認
- <h3>〜</h3>タグ内に<strong>タグが含まれていないか確認
- 見出しタグ内に<strong>タグが見つかった場合は「major」問題として指摘
- 本文（<p>タグ内など）での<strong>タグ使用は問題なし（むしろ推奨）
`;

export async function checkArticleV3(request: CheckRequest): Promise<CheckResult> {
  console.log('🔍 ライティングチェックV3 開始');
  
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3.7-flash",
      generationConfig: {
        temperature: 0.3, // より正確な評価のため低めに設定
        maxOutputTokens: 16384, // 4096から16384に拡大（テスト結果より）
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "low" }
      }
    });

    const prompt = `
あなたはSEOとコンテンツマーケティングの専門家です。
以下の記事を厳密に評価し、改善提案を行ってください。

${CHECK_CRITERIA}

【評価対象記事】
${request.article.slice(0, 30000)} // 最初の30000文字

【元の構成案（執筆メモ含む）】
${request.outline}

【ターゲットキーワード】
${request.keyword}

【執筆メモ準拠度の確認指示】
構成案に含まれる「執筆メモ」（writingNote）を確認し、以下を評価してください：
- 各H2・H3の執筆メモで指定された要点が記事に含まれているか
- 特に重要な数値、事例、具体的な内容が反映されているか
- 執筆メモの要素が8割以上記事に反映されているか確認
- もし重要な要素が欠けている場合は、具体的に何が足りないか指摘

【評価タスク】
1. 各項目を100点満点で採点
2. 重大な問題点を3つまで指摘（特に段落が長すぎる箇所を優先的に指摘）
3. 改善提案を5つまで提示（以下を必ず含める）：
   - 200字を超える段落があれば、具体的な分割位置を提案
   - 箇条書きにすべき箇所があれば、具体的な変換例を提示
   - 話題転換での段落分けが必要な箇所を指摘
4. 書き直しが必要な箇所を3つまで特定

【JSON形式で出力】
{
  "overallScore": 85,
  "scores": {
    "seo": 90,
    "readability": 85,
    "accuracy": 88,
    "structure": 92,
    "value": 80
  },
  "issues": [
    {
      "severity": "major",
      "category": "サービス訴求",
      "description": "サービスの強みが十分に訴求されていない",
      "location": "リード文"
    }
  ],
  "improvements": [
    {
      "priority": "high",
      "suggestion": "2箇所のCTA必須配置を確認（リード文末、記事文末）",
      "expectedImpact": "コンバージョン率15%向上"
    }
  ],
  "rewriteSuggestions": [
    {
      "original": "サービスを検討することができます。",
      "suggested": "実践型の研修サービスなら、助成金を活用しながら即戦力人材を育成できます。",
      "reason": "冗長表現の削除とサービスの価値訴求"
    }
  ]
}
`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    try {
      const checkResult = JSON.parse(response) as CheckResult;
      console.log('✅ チェック完了 - 総合スコア:', checkResult.overallScore);
      return checkResult;
    } catch (parseError) {
      console.error('JSONパースエラー:', parseError);
      // フォールバック結果を返す
      return createFallbackResult();
    }

  } catch (error) {
    console.error('❌ チェックエラー:', error);
    throw error;
  }
}

// 競合比較チェック
export async function compareWithCompetitors(
  article: string,
  competitorArticles: string[]
): Promise<{
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
}> {
  console.log('📊 競合比較分析開始');
  
  const model = genAI.getGenerativeModel({
    model: "gemini-3.7-flash",
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: "low" },
    }
  });

  const prompt = `
【自社記事】
${article.slice(0, 5000)}

【競合記事サンプル】
${competitorArticles.map((a, i) => `競合${i + 1}: ${a.slice(0, 1000)}`).join('\n\n')}

以下の観点で比較分析してください：
1. 情報の網羅性
2. 独自性・差別化
3. 実用性
4. 構成・読みやすさ

【分析結果】
強み、弱み、改善機会を箇条書きで提示してください。
`;

  console.log('🔄 競合分析中...');
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  
  // テキストから強み・弱み・機会を抽出（簡易パース）
  const analysisResult = parseCompetitiveAnalysis(text);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ 競合分析完了 (${elapsed}秒)`);
  console.log(`  ・強み: ${analysisResult.strengths.length}点`);
  console.log(`  ・弱み: ${analysisResult.weaknesses.length}点`);
  console.log(`  ・機会: ${analysisResult.opportunities.length}点`);
  
  return analysisResult;
}

// リアルタイム改善提案
export async function getSuggestionForSection(
  section: string,
  context: string
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.7-flash",
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 512,
      thinkingConfig: { thinkingLevel: "low" },
    }
  });

  const prompt = `
【現在のセクション】
${section}

【文脈】
${context.slice(-500)}

このセクションを改善する具体的な提案を1つ提供してください。
簡潔に、実行可能な形で。
`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ヘルパー関数
function createFallbackResult(): CheckResult {
  return {
    overallScore: 70,
    scores: {
      seo: 70,
      readability: 70,
      accuracy: 70,
      structure: 70,
      value: 70
    },
    issues: [
      {
        severity: 'minor',
        category: 'General',
        description: '自動評価を完了できませんでした',
      }
    ],
    improvements: [
      {
        priority: 'medium',
        suggestion: '手動でのレビューを推奨します',
        expectedImpact: '品質向上'
      }
    ],
    rewriteSuggestions: []
  };
}

// JSON生成テスト関数
export async function testJsonGeneration() {
  console.log('🧪 JSON生成テスト開始');
  console.log('=====================================');

  const tests = [
    {
      name: "最小限のテスト（100文字）",
      articleLength: 100,
      useJsonMimeType: true,
      maxOutputTokens: 4096
    },
    {
      name: "短い記事（1000文字）",
      articleLength: 1000,
      useJsonMimeType: true,
      maxOutputTokens: 4096
    },
    {
      name: "中程度の記事（5000文字・16384トークン）",
      articleLength: 5000,
      useJsonMimeType: true,
      maxOutputTokens: 16384
    },
    {
      name: "長い記事（10000文字・16384トークン）",
      articleLength: 10000,
      useJsonMimeType: true,
      maxOutputTokens: 16384
    },
    {
      name: "やや長い記事（15000文字・16384トークン）",
      articleLength: 15000,
      useJsonMimeType: true,
      maxOutputTokens: 16384
    },
    {
      name: "激烈に長い記事（20000文字・16384トークン）",
      articleLength: 20000,
      useJsonMimeType: true,
      maxOutputTokens: 16384
    },
    {
      name: "めちゃくちゃ爆裂に長い記事（50000文字・16384トークン）",
      articleLength: 50000,
      useJsonMimeType: true,
      maxOutputTokens: 16384
    }
  ];

  const results = [];

  for (const test of tests) {
    console.log(`\n📝 テスト: ${test.name}`);
    console.log(`   記事長: ${test.articleLength}文字`);
    console.log(`   MimeType: ${test.useJsonMimeType ? 'application/json' : 'なし'}`);
    console.log(`   MaxTokens: ${test.maxOutputTokens}`);

    try {
      // テスト用の記事を生成
      const testArticle = `<h2>テスト記事</h2>
<p>これはテスト用の記事です。${"あいうえお".repeat(Math.floor(test.articleLength / 10))}</p>
<h3>サブセクション</h3>
<p>詳細な内容がここに入ります。</p>`;

      const generationConfig: any = {
        temperature: 0.3,
        maxOutputTokens: test.maxOutputTokens,
        thinkingConfig: { thinkingLevel: "low" },
      };

      if (test.useJsonMimeType) {
        generationConfig.responseMimeType = "application/json";
      }

      const model = genAI.getGenerativeModel({
        model: "gemini-3.7-flash",
        generationConfig
      });

      const prompt = `
以下の記事を評価して、JSON形式で結果を返してください。

【評価対象記事】
${testArticle.slice(0, test.articleLength)}

【評価項目】
- 総合スコア（0-100）
- 改善点（3つまで）

【JSON形式】
{
  "overallScore": 数値,
  "issues": [
    {
      "severity": "major/minor",
      "description": "問題の説明"
    }
  ],
  "testInfo": {
    "receivedLength": 実際に受信した文字数,
    "processedSuccessfully": true/false
  }
}`;

      const startTime = Date.now();
      const result = await model.generateContent(prompt);
      const response = result.response.text();
      const elapsed = Date.now() - startTime;

      console.log(`   ✅ レスポンス受信: ${response.length}文字（${elapsed}ms）`);

      // JSONパースを試みる
      try {
        const parsed = JSON.parse(response);
        console.log(`   ✅ JSONパース成功`);
        console.log(`   スコア: ${parsed.overallScore}`);
        results.push({
          test: test.name,
          success: true,
          responseLength: response.length,
          time: elapsed,
          score: parsed.overallScore
        });
      } catch (parseError) {
        console.log(`   ❌ JSONパースエラー: ${parseError.message}`);
        console.log(`   レスポンス冒頭: ${response.slice(0, 100)}...`);
        results.push({
          test: test.name,
          success: false,
          responseLength: response.length,
          time: elapsed,
          error: parseError.message
        });
      }

    } catch (error) {
      console.log(`   ❌ API呼び出しエラー: ${error.message}`);
      results.push({
        test: test.name,
        success: false,
        error: error.message
      });
    }

    // API制限を考慮して少し待機
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 結果サマリー
  console.log('\n=====================================');
  console.log('📊 テスト結果サマリー');
  console.log('=====================================');

  const successCount = results.filter(r => r.success).length;
  console.log(`成功: ${successCount}/${results.length}`);

  console.log('\n詳細:');
  results.forEach(r => {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} ${r.test}`);
    if (r.success) {
      console.log(`   - レスポンス: ${r.responseLength}文字`);
      console.log(`   - 処理時間: ${r.time}ms`);
      console.log(`   - スコア: ${r.score}`);
    } else {
      console.log(`   - エラー: ${r.error}`);
    }
  });

  return results;
}

function parseCompetitiveAnalysis(text: string): {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
} {
  // 簡易的なテキスト解析
  const lines = text.split('\n');
  const result = {
    strengths: [] as string[],
    weaknesses: [] as string[],
    opportunities: [] as string[]
  };
  
  let currentSection = '';
  
  for (const line of lines) {
    if (line.includes('強み') || line.includes('Strengths')) {
      currentSection = 'strengths';
    } else if (line.includes('弱み') || line.includes('Weaknesses')) {
      currentSection = 'weaknesses';
    } else if (line.includes('機会') || line.includes('Opportunities')) {
      currentSection = 'opportunities';
    } else if (line.trim().startsWith('-') || line.trim().startsWith('・')) {
      const item = line.replace(/^[\-・]\s*/, '').trim();
      if (item && currentSection) {
        result[currentSection as keyof typeof result].push(item);
      }
    }
  }
  
  return result;
}