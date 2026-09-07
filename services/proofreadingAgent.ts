import { GoogleGenerativeAI } from '@google/generative-ai';
import type { 
  ProofreadingReport, 
  Violation, 
  ViolationCategory,
  ViolationSeverity,
  ProofreadingConfig,
  ProofreadingStatistics
} from '../types/proofreading';
import type { SeoOutline } from '../types';
import { verifyArticleFacts } from './factCheckService';
import type { WritingRegulation } from './articleWriterService';

const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY || '');

// デフォルトの校閲設定
const DEFAULT_CONFIG: ProofreadingConfig = {
  enabledCategories: [
    'prep_label',
    'sentence_unity',
    'repetition',
    'char_count',
    'wordpress',
    'frequency',
    'readability',
    'forbidden_tags',
    'indentation',
    'numbering'
  ],
  severityThreshold: 'info',
  checkFrequencyWords: true,
  allowedCharCountDeviation: 20 // 20%の誤差を許容
};

/**
 * 記事を校閲して違反レポートを生成
 */
export async function proofreadArticle(
  htmlContent: string,
  outline: SeoOutline,
  regulation: WritingRegulation,
  config: Partial<ProofreadingConfig> = {},
  temperature?: number
): Promise<ProofreadingReport> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  console.log('📝 校閲開始...');
  
  // 複数の検証を並列実行
  const [
    structuralViolations,
    contentViolations,
    geminiViolations,
    factCheckResult
  ] = await Promise.all([
    checkStructuralViolations(htmlContent, finalConfig),
    checkContentViolations(htmlContent, outline, finalConfig),
    checkWithGeminiAPI(htmlContent, outline, regulation, finalConfig, temperature),
    finalConfig.enableFactCheck !== false ? verifyArticleFacts(htmlContent, outline.keywords?.[0] || '') : Promise.resolve({ verified: true, issues: [] })
  ]);
  
  // ファクトチェックの結果を違反として追加
  const factViolations: Violation[] = factCheckResult.issues.map((issue, index) => ({
    id: `fact_${index}`,
    severity: 'warning' as ViolationSeverity,
    category: 'fact_accuracy' as ViolationCategory,
    location: {
      sectionHeading: '記事全体',
      charPosition: { start: 0, end: issue.text.length }
    },
    violatedRule: '事実の正確性',
    actualText: issue.text,
    suggestion: issue.suggestion,
    confidence: 0.8
  }));
  
  // 全ての違反をマージ
  const allViolations = [
    ...structuralViolations,
    ...contentViolations,
    ...geminiViolations,
    ...factViolations
  ];
  
  // 重複を除去（同じ位置の同じカテゴリの違反を統合）
  const uniqueViolations = deduplicateViolations(allViolations);
  
  // レポートを生成
  const report = generateReport(uniqueViolations, htmlContent);
  
  console.log(`✅ 校閲完了: ${report.violations.length}件の違反を検出`);
  
  return report;
}

/**
 * 構造的な違反をチェック（正規表現ベース）
 */
function checkStructuralViolations(
  htmlContent: string,
  config: ProofreadingConfig
): Violation[] {
  const violations: Violation[] = [];
  let violationId = 0;
  
  // 1. WordPress禁止タグのチェック
  if (config.enabledCategories.includes('wordpress')) {
    const forbiddenTags = [
      /<article[^>]*>/gi,
      /<section[^>]*>/gi,
      /<h1[^>]*>/gi,
      /<!--.*?-->/gs,
      /<meta[^>]*>/gi,
      /<!DOCTYPE[^>]*>/gi,
      /<html[^>]*>/gi,
      /<head[^>]*>/gi,
      /<body[^>]*>/gi
    ];
    
    forbiddenTags.forEach(pattern => {
      const matches = htmlContent.matchAll(pattern);
      for (const match of matches) {
        violations.push({
          id: `violation_${++violationId}`,
          severity: 'critical',
          category: 'wordpress',
          location: {
            sectionHeading: '全体',
            charPosition: {
              start: match.index || 0,
              end: (match.index || 0) + match[0].length
            }
          },
          violatedRule: 'WordPress禁止タグの使用',
          actualText: match[0].substring(0, 50) + '...',
          suggestion: 'このタグを削除してください',
          confidence: 1.0
        });
      }
    });
  }
  
  // 2. H2タグの番号付けチェック
  if (config.enabledCategories.includes('numbering')) {
    const h2Pattern = /<h2[^>]*>(\d+[\.\s].*?)<\/h2>/gi;
    const matches = htmlContent.matchAll(h2Pattern);
    for (const match of matches) {
      violations.push({
        id: `violation_${++violationId}`,
        severity: 'warning',
        category: 'numbering',
        location: {
          sectionHeading: match[1],
          charPosition: {
            start: match.index || 0,
            end: (match.index || 0) + match[0].length
          }
        },
        violatedRule: 'H2タグへの番号付け',
        actualText: match[0],
        suggestion: '番号を削除してください（例: "1. タイトル" → "タイトル"）',
        confidence: 0.9
      });
    }
  }
  
  // 3. インデントのチェック
  if (config.enabledCategories.includes('indentation')) {
    const lines = htmlContent.split('\n');
    lines.forEach((line, index) => {
      if (line.match(/^[\s\t]+<[^>]+>/)) {
        violations.push({
          id: `violation_${++violationId}`,
          severity: 'info',
          category: 'indentation',
          location: {
            sectionHeading: '全体',
            lineNumber: index + 1
          },
          violatedRule: '不要なインデント',
          actualText: line.substring(0, 50),
          suggestion: 'HTMLタグのインデントを削除してください',
          confidence: 0.8
        });
      }
    });
  }
  
  // 4. コードブロック記法のチェック
  if (config.enabledCategories.includes('forbidden_tags')) {
    const codeBlockPattern = /```[\s\S]*?```/g;
    const matches = htmlContent.matchAll(codeBlockPattern);
    for (const match of matches) {
      violations.push({
        id: `violation_${++violationId}`,
        severity: 'critical',
        category: 'forbidden_tags',
        location: {
          sectionHeading: '全体',
          charPosition: {
            start: match.index || 0,
            end: (match.index || 0) + match[0].length
          }
        },
        violatedRule: 'マークダウンコードブロックの使用',
        actualText: match[0].substring(0, 30) + '...',
        suggestion: 'コードブロック記法を削除してください',
        confidence: 1.0
      });
    }
  }
  
  return violations;
}

/**
 * コンテンツの違反をチェック
 */
async function checkContentViolations(
  htmlContent: string,
  outline: SeoOutline,
  config: ProofreadingConfig
): Promise<Violation[]> {
  const violations: Violation[] = [];
  let violationId = 1000; // 別系統のIDを使用
  
  // HTMLタグを除去してプレーンテキストを取得
  const plainText = htmlContent.replace(/<[^>]*>/g, '');
  
  // 1. 文字数チェック
  if (config.enabledCategories.includes('char_count') && config.targetCharCount) {
    const actualCharCount = plainText.length;
    const targetCharCount = config.targetCharCount || outline.characterCountAnalysis?.average || 30000;
    const deviation = Math.abs(actualCharCount - targetCharCount) / targetCharCount * 100;
    
    if (deviation > (config.allowedCharCountDeviation || 20)) {
      violations.push({
        id: `violation_${++violationId}`,
        severity: actualCharCount < targetCharCount * 0.5 ? 'critical' : 'warning',
        category: 'char_count',
        location: {
          sectionHeading: '記事全体'
        },
        violatedRule: '目標文字数との乖離',
        actualText: `現在: ${actualCharCount}文字 / 目標: ${targetCharCount}文字`,
        suggestion: `${targetCharCount - actualCharCount}文字${actualCharCount < targetCharCount ? '追加' : '削減'}が必要です`,
        confidence: 1.0
      });
    }
  }
  
  // 2. 語尾の重複チェック
  if (config.enabledCategories.includes('repetition')) {
    const sentences = plainText.split(/[。！？]/);
    const endings = sentences.map(s => s.trim().slice(-3)).filter(e => e.length > 0);
    
    for (let i = 0; i < endings.length - 2; i++) {
      if (endings[i] === endings[i + 1] && endings[i] === endings[i + 2]) {
        violations.push({
          id: `violation_${++violationId}`,
          severity: 'warning',
          category: 'repetition',
          location: {
            sectionHeading: 'テキスト内',
            paragraphIndex: Math.floor(i / 5) // 概算
          },
          violatedRule: '同じ語尾の3回以上の繰り返し',
          actualText: `「${endings[i]}」が3回連続`,
          suggestion: '語尾を変更して文章に変化をつけてください',
          confidence: 0.9
        });
      }
    }
  }
  
  // 3. 頻出単語の使用チェック
  if (config.enabledCategories.includes('frequency') && 
      config.checkFrequencyWords && 
      outline.competitorResearch?.frequencyWords) {
    
    const topWords = outline.competitorResearch.frequencyWords
      .slice(0, 10)
      .map(w => w.word);
    
    const missingWords = topWords.filter(word => 
      !plainText.includes(word)
    );
    
    if (missingWords.length > 5) {
      violations.push({
        id: `violation_${++violationId}`,
        severity: 'warning',
        category: 'frequency',
        location: {
          sectionHeading: '記事全体'
        },
        violatedRule: '重要キーワードの未使用',
        actualText: `未使用: ${missingWords.join(', ')}`,
        suggestion: 'これらの頻出単語を記事に含めることを検討してください',
        confidence: 0.7
      });
    }
  }
  
  return violations;
}

/**
 * Gemini APIを使用した高度な校閲
 */
async function checkWithGeminiAPI(
  htmlContent: string,
  outline: SeoOutline,
  regulation: WritingRegulation,
  config: ProofreadingConfig,
  temperature?: number
): Promise<Violation[]> {
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-3.6-flash',
    generationConfig: {
      temperature: temperature || 0.3,
      maxOutputTokens: 8192,
    }
  });
  
  const prompt = `
あなたはSEO記事の校閲エージェントです。
以下の記事を分析し、執筆レギュレーション違反を検出してください。

【記事HTML】
${htmlContent}

【執筆レギュレーション】
1. PREP法で論理的に構成するが、ラベルは絶対に禁止
2. 一文一意を原則とする
3. 同じ語尾の3回以上の繰り返しは禁止
4. WordPress用のクリーンなHTML（article, section, h1タグ禁止）
5. インデント無し、番号付け無し
6. 段落分けの基準：
   - 話題が変わるとき
   - 視点が変わるとき（総論→各論、メリット→デメリット等）
   - 時系列が変わるとき
   - 新しい<p>タグで区切る
7. H2直下には必ず導入文を配置（H3がある場合）：
   - 100-200文字程度
   - そのセクションの概要と読者が得られる価値を説明
   - 各H2で言い回しのパターンを変える（「〜について解説します」を繰り返さない）

【ラベル禁止の詳細】
以下のパターンはすべて違反とする：
- 「結論：」「理由：」「具体例：」「まとめ：」などのコロン付きラベル
- 「結論として」「理由は」「例として」などの接続詞的ラベル
- 「Point:」「Reason:」「Example:」などの英語ラベル
- その他PREP法の構造を明示するラベル

【検出すべき違反】
- PREP法のラベル使用（上記パターンすべて）
- 一文に複数の意味が含まれている箇所
- 読みにくい長文（100文字以上）
- 不自然な文章の流れ
- 専門用語の説明不足
- 段落分けが不適切（長すぎる段落、話題転換時の未分割）
- H2直下に導入文がない（H3がある場合）
- H2導入文が不適切（文字数不足、内容が不明瞭、パターンの重複）

【出力形式】
JSON形式で以下の構造で出力してください：
{
  "violations": [
    {
      "severity": "critical|warning|info",
      "category": "prep_label|sentence_unity|readability|paragraph|h2_intro",
      "sectionHeading": "該当セクションのH2タイトル",
      "violatedRule": "違反したルール",
      "actualText": "実際のテキスト（50文字以内）",
      "suggestion": "改善提案",
      "confidence": 0.0-1.0
    }
  ]
}

必ずJSON形式のみを出力し、他の説明は不要です。
`;
  
  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // JSONを抽出
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('Gemini APIからのレスポンスにJSONが含まれていません');
      return [];
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Violation型に変換
    return parsed.violations.map((v: any, index: number) => ({
      id: `gemini_${index + 1}`,
      severity: v.severity as ViolationSeverity,
      category: v.category as ViolationCategory,
      location: {
        sectionHeading: v.sectionHeading
      },
      violatedRule: v.violatedRule,
      actualText: v.actualText,
      suggestion: v.suggestion,
      confidence: v.confidence
    }));
    
  } catch (error) {
    console.error('Gemini API校閲エラー:', error);
    return [];
  }
}

/**
 * 重複する違反を除去
 */
function deduplicateViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter(v => {
    const key = `${v.category}_${v.location.sectionHeading}_${v.actualText.substring(0, 20)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * 校閲レポートを生成
 */
function generateReport(violations: Violation[], htmlContent: string): ProofreadingReport {
  // 統計情報を計算
  const statistics: ProofreadingStatistics = {
    totalViolations: violations.length,
    criticalCount: violations.filter(v => v.severity === 'critical').length,
    warningCount: violations.filter(v => v.severity === 'warning').length,
    infoCount: violations.filter(v => v.severity === 'info').length,
    byCategory: {} as Record<ViolationCategory, number>
  };
  
  // カテゴリ別の集計
  violations.forEach(v => {
    statistics.byCategory[v.category] = (statistics.byCategory[v.category] || 0) + 1;
  });
  
  // スコア計算（違反の重要度に応じて減点）
  let score = 100;
  violations.forEach(v => {
    if (v.severity === 'critical') score -= 10;
    else if (v.severity === 'warning') score -= 5;
    else score -= 2;
  });
  score = Math.max(0, score);
  
  // 記事情報を抽出
  const plainText = htmlContent.replace(/<[^>]*>/g, '');
  const h2Count = (htmlContent.match(/<h2[^>]*>/gi) || []).length;
  const h3Count = (htmlContent.match(/<h3[^>]*>/gi) || []).length;
  
  return {
    violations: violations.sort((a, b) => {
      // 重要度でソート
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    statistics,
    overallScore: score,
    timestamp: new Date().toISOString(),
    articleInfo: {
      totalCharacters: plainText.length,
      sectionCount: h2Count,
      h2Count,
      h3Count
    }
  };
}

/**
 * 遅延処理のヘルパー関数（API レート制限対策）
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 記事を自動修正する（段階的修正アプローチ）
 */
export async function autoFixArticle(
  htmlContent: string,
  violations: Violation[],
  outline: SeoOutline,
  regulation: WritingRegulation,
  maxAttempts: number = 3
): Promise<{
  fixedContent: string;
  finalReport: ProofreadingReport;
  attempts: number;
}> {
  console.log('🔧 自動修正を開始します...');
  
  let currentContent = htmlContent;
  let currentViolations = violations;
  let attemptCount = 0;
  let finalReport: ProofreadingReport | null = null;
  
  // 修正時の温度パラメータ（0.4 → 0.3 → 0.2）
  const fixTemperatures = [0.4, 0.3, 0.2];
  // 再チェック時の温度パラメータ（0.3 → 0.2 → 0.2）
  const checkTemperatures = [0.3, 0.2, 0.2];
  
  while (attemptCount < maxAttempts && currentViolations.length > 0) {
    attemptCount++;
    const fixTemperature = fixTemperatures[attemptCount - 1] || 0.2;
    const checkTemperature = checkTemperatures[attemptCount - 1] || 0.2;
    
    console.log(`📝 修正試行 ${attemptCount}/${maxAttempts} (修正温度: ${fixTemperature}, チェック温度: ${checkTemperature})`);
    console.log(`  現在の違反数: ${currentViolations.length}`);
    
    // 1. まず簡単な自動修正を適用
    currentContent = applySimpleFixes(currentContent, currentViolations);
    
    // APIレート制限対策
    await delay(6500);
    
    // 2. AIによる高度な修正
    if (hasComplexViolations(currentViolations)) {
      currentContent = await applyAIFixes(
        currentContent, 
        currentViolations, 
        outline,
        fixTemperature
      );
      
      // APIレート制限対策
      await delay(6500);
    }
    
    // 3. 修正後の再チェック（温度を下げてより厳密にチェック）
    console.log(`🔍 修正後の再チェック中... (温度: ${checkTemperature})`);
    finalReport = await proofreadArticle(currentContent, outline, regulation, {}, checkTemperature);
    currentViolations = finalReport.violations;
    
    // スコアが90点以上になったら完了
    if (finalReport.overallScore >= 90) {
      console.log(`✅ スコア ${finalReport.overallScore}点に到達。修正完了！`);
      break;
    }
    
    // 致命的な違反がなくなったら完了
    if (finalReport.statistics.criticalCount === 0 && attemptCount >= 2) {
      console.log(`✅ 致命的な違反が解消されました。修正完了！`);
      break;
    }
    
    // APIレート制限対策
    if (attemptCount < maxAttempts) {
      console.log(`⏳ 次の修正試行まで待機中...`);
      await delay(6500);
    }
  }
  
  console.log(`🎯 自動修正完了: ${attemptCount}回の試行`);
  console.log(`  最終スコア: ${finalReport?.overallScore || 0}点`);
  console.log(`  残存違反数: ${currentViolations.length}`);
  
  return {
    fixedContent: currentContent,
    finalReport: finalReport || await proofreadArticle(currentContent, outline, regulation, {}, 0.2),
    attempts: attemptCount
  };
}

/**
 * 簡単な自動修正を適用（正規表現ベース）
 */
function applySimpleFixes(content: string, violations: Violation[]): string {
  let fixed = content;
  
  violations.forEach(v => {
    try {
      switch (v.category) {
        case 'wordpress':
          // WordPress禁止タグを除去
          fixed = fixed.replace(/<article([^>]*)>/gi, '<div$1>');
          fixed = fixed.replace(/<\/article>/gi, '</div>');
          fixed = fixed.replace(/<section([^>]*)>/gi, '<div$1>');
          fixed = fixed.replace(/<\/section>/gi, '</div>');
          fixed = fixed.replace(/<h1([^>]*)>/gi, '<h2$1>');
          fixed = fixed.replace(/<\/h1>/gi, '</h2>');
          fixed = fixed.replace(/<!--.*?-->/gs, '');
          break;
          
        case 'numbering':
          // 番号付けを除去
          fixed = fixed.replace(/^(\d+\.|[①-⑩]|\(\d+\))\s*/gm, '');
          break;
          
        case 'indentation':
          // 不要なインデントを除去
          fixed = fixed.replace(/^[\s\t]+/gm, '');
          break;
          
        case 'forbidden_tags':
          // コードブロック記法を除去
          fixed = fixed.replace(/```[^`]*```/g, '');
          break;
      }
    } catch (error) {
      console.warn(`簡易修正エラー (${v.category}):`, error);
    }
  });
  
  return fixed;
}

/**
 * 複雑な違反があるかチェック
 */
function hasComplexViolations(violations: Violation[]): boolean {
  const complexCategories: ViolationCategory[] = [
    'prep_label',
    'sentence_unity',
    'repetition',
    'readability',
    'frequency'
  ];
  
  return violations.some(v => complexCategories.includes(v.category));
}

/**
 * セクション単位で記事を自動修正する（新バージョン）
 */
export async function autoFixArticleBySection(
  htmlContent: string,
  violations: Violation[],
  outline: SeoOutline,
  regulation: WritingRegulation,
  maxAttempts: number = 3
): Promise<{
  fixedContent: string;
  finalReport: ProofreadingReport;
  attempts: number;
}> {
  console.log('🔧 セクション単位での自動修正を開始します...');
  
  // セクションを抽出
  const sections = htmlContent.split(/<h2[^>]*>/);
  if (sections.length <= 1) {
    console.log('セクションが見つからないため、通常の修正を実行します');
    return autoFixArticle(htmlContent, violations, outline, regulation, maxAttempts);
  }
  
  // 最初の要素（h2タグ前の部分）を保持
  const beforeFirstH2 = sections.shift() || '';
  
  // 各セクションを処理
  const fixedSections: string[] = [beforeFirstH2];
  let totalAttempts = 0;
  
  for (let i = 0; i < sections.length; i++) {
    const sectionContent = '<h2' + sections[i];
    // h2タグの内容を正確に抽出
    const headingMatch = sectionContent.match(/<h2[^>]*>([^<]+)<\/h2>/);
    const sectionHeading = headingMatch ? headingMatch[1].trim() : `セクション${i + 1}`;
    
    console.log(`📝 セクション ${i + 1}/${sections.length} を修正中: ${sectionHeading}`);
    
    // このセクションに関連する違反を抽出
    const sectionViolations = violations.filter(v => {
      // セクション内のテキストが違反に含まれているかチェック
      const plainText = sectionContent.replace(/<[^>]*>/g, '');
      return plainText.includes(v.actualText) || 
             (v.location && typeof v.location === 'string' && v.location.includes(sectionHeading));
    });
    
    if (sectionViolations.length === 0) {
      console.log(`  ✅ 違反なし`);
      fixedSections.push(sectionContent);
      continue;
    }
    
    console.log(`  違反数: ${sectionViolations.length}`);
    
    // セクションごとに修正を実行
    let fixedSection = sectionContent;
    let attemptCount = 0;
    const fixTemperatures = [0.4, 0.3, 0.2];
    
    while (attemptCount < maxAttempts && sectionViolations.length > 0) {
      attemptCount++;
      totalAttempts++;
      const temperature = fixTemperatures[attemptCount - 1] || 0.2;
      
      // 簡単な修正を適用
      fixedSection = applySimpleFixes(fixedSection, sectionViolations);
      
      // APIレート制限対策
      await delay(2000);
      
      // AIによる修正（セクション単位なので確実に処理可能）
      if (hasComplexViolations(sectionViolations)) {
        fixedSection = await applyAIFixesForSection(
          fixedSection,
          sectionViolations,
          temperature
        );
      }
      
      // このセクションが十分改善されたか確認
      const remainingViolations = sectionViolations.filter(v => 
        fixedSection.includes(v.actualText)
      );
      
      if (remainingViolations.length === 0) {
        console.log(`  ✅ セクション修正完了`);
        break;
      }
      
      sectionViolations.splice(0, sectionViolations.length, ...remainingViolations);
    }
    
    fixedSections.push(fixedSection);
    
    // APIレート制限対策
    await delay(3000);
  }
  
  // 修正済みセクションを結合
  const fixedContent = fixedSections.join('');
  
  // 最終チェック
  console.log('🔍 最終チェック中...');
  const finalReport = await proofreadArticle(fixedContent, outline, regulation, {}, 0.2);
  
  console.log(`🎯 セクション単位の修正完了`);
  console.log(`  最終スコア: ${finalReport.overallScore}点`);
  console.log(`  残存違反数: ${finalReport.violations.length}`);
  
  return {
    fixedContent,
    finalReport,
    attempts: totalAttempts
  };
}

/**
 * セクション用のAI修正関数
 */
async function applyAIFixesForSection(
  sectionContent: string,
  violations: Violation[],
  temperature: number
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: {
      temperature,
      maxOutputTokens: 8192, // セクション単位なので8192で十分
    }
  });
  
  // 複雑な違反のみを抽出
  const complexViolations = violations.filter(v => 
    ['prep_label', 'sentence_unity', 'repetition', 'readability', 'frequency'].includes(v.category)
  );
  
  if (complexViolations.length === 0) return sectionContent;
  
  const prompt = `
あなたはSEO記事の修正エージェントです。
以下のセクションの違反箇所を修正してください。

【現在のセクション】
${sectionContent}

【検出された違反】
${complexViolations.map(v => `
- カテゴリ: ${v.category}
- 問題: ${v.violatedRule}
- 該当箇所: ${v.actualText}
- 修正提案: ${v.suggestion}
`).join('\n')}

【修正ルール】
1. 違反箇所のみをピンポイントで修正
2. 元の文章の良さは可能な限り保持
3. 自然な文章の流れを維持
4. PREPラベルの完全削除：
   - 「結論：○○」→「○○」（ラベル削除）
   - 「理由：」→ 削除して「なぜなら」等の自然な接続詞に
   - 「具体例：」→ 削除して「例えば」等の自然な接続詞に
   - 「まとめ：」→ 削除して文章を自然に開始
5. 語尾の重複は別の表現に変更
6. 長文は適切に分割（60文字目安）
7. 一文一意を守る

【重要】
- HTML構造は変更しない
- 見出しタグ（h2, h3）の内容は変更しない
- セクション全体の文字数は大きく変えない（±10%以内）
- セクション全体を出力すること

修正後のセクション全体をHTML形式で出力してください。
説明は不要で、HTMLのみを出力してください。
`;

  try {
    const result = await model.generateContent(prompt);
    const fixedContent = result.response.text();
    
    // HTMLタグが含まれているか確認
    if (!fixedContent.includes('<h2') || !fixedContent.includes('</h2>')) {
      console.warn('AI修正結果にセクションの見出しが含まれていません');
      return sectionContent;
    }
    
    return fixedContent;
  } catch (error) {
    console.error('セクションAI修正エラー:', error);
    return sectionContent;
  }
}

/**
 * AIによる高度な修正を適用（旧バージョン - 全体修正用）
 */
async function applyAIFixes(
  content: string,
  violations: Violation[],
  outline: SeoOutline,
  temperature: number
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: {
      temperature,
      maxOutputTokens: 16384,
    }
  });
  
  // 複雑な違反のみを抽出
  const complexViolations = violations.filter(v => 
    ['prep_label', 'sentence_unity', 'repetition', 'readability', 'frequency'].includes(v.category)
  );
  
  if (complexViolations.length === 0) return content;
  
  const prompt = `
あなたはSEO記事の修正エージェントです。
以下の記事の違反箇所を修正してください。

【現在の記事】
${content}

【検出された違反】
${complexViolations.map(v => `
- カテゴリ: ${v.category}
- 問題: ${v.violatedRule}
- 該当箇所: ${v.actualText}
- 修正提案: ${v.suggestion}
`).join('\n')}

【修正ルール】
1. 違反箇所のみをピンポイントで修正
2. 元の文章の良さは可能な限り保持
3. 自然な文章の流れを維持
4. PREPラベルの完全削除：
   - 「結論：○○」→「○○」（ラベル削除）
   - 「理由：」→ 削除して「なぜなら」等の自然な接続詞に
   - 「具体例：」→ 削除して「例えば」等の自然な接続詞に
   - 「まとめ：」→ 削除して文章を自然に開始
5. 語尾の重複は別の表現に変更
6. 長文は適切に分割（60文字目安）
7. 一文一意を守る

【重要】
- HTML構造は変更しない
- 見出しタグ（h2, h3）の内容は変更しない
- 全体の文字数は大きく変えない（±5%以内）

修正後の記事全体をHTML形式で出力してください。
説明は不要で、HTMLのみを出力してください。
`;

  try {
    const result = await model.generateContent(prompt);
    const fixedContent = result.response.text();
    
    // HTMLタグが含まれているか確認
    if (!fixedContent.includes('<') || !fixedContent.includes('>')) {
      console.warn('AI修正結果にHTMLが含まれていません');
      return content;
    }
    
    return fixedContent;
  } catch (error) {
    console.error('AI修正エラー:', error);
    return content;
  }
}