import { getBrand } from './clientContext';
// セクション単位での記事生成サービス
// 各見出しを個別に生成し、文字数を確実にコントロール

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SeoOutline, FrequencyWord, SubheadingWithNote } from '../types';
import type { WritingRegulation } from './articleWriterService';
import { proofreadArticle, autoFixArticle, autoFixArticleBySection } from './proofreadingAgent';
import { checkFactsForSection, type FactInfo } from './factCheckService';
import { getCompanyInfo, generateCompanyContext } from './companyService';

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// セクションの重要度定義
interface SectionImportance {
  keyword: string;
  heading: string;
  importance: number; // 1.0 = 標準, 1.5 = 重要, 0.8 = 補足的
}

// セクション生成結果
interface SectionResult {
  html: string;
  actualCharCount: number;
  summary: string; // 次のセクションに引き継ぐ要約
  usedExamples: string[]; // 使用した例
}

// 文脈情報
interface WritingContext {
  previousSections: {
    heading: string;
    summary: string;
    usedExamples: string[];
  }[];
  tone: string;
  targetAudience: string;
  frequencyWords: FrequencyWord[];
}

// セクションの重要度を判定
function calculateSectionImportance(
  sectionHeading: string,
  keyword: string,
  sectionIndex: number,
  totalSections: number
): number {
  // キーワードとの関連性をチェック
  const keywordParts = keyword.toLowerCase().split(/[\s　]+/);
  const headingLower = sectionHeading.toLowerCase();
  
  let relevanceScore = 1.0;
  
  // キーワードが含まれているか
  if (keywordParts.every(part => headingLower.includes(part))) {
    relevanceScore = 1.5; // 完全一致
  } else if (keywordParts.some(part => headingLower.includes(part))) {
    relevanceScore = 1.2; // 部分一致
  }
  
  // 位置による調整
  if (sectionIndex === 0) {
    // 最初のセクションは重要
    relevanceScore *= 1.2;
  } else if (sectionIndex >= totalSections - 2) {
    // 最後の方のセクションは少なめ
    relevanceScore *= 0.8;
  }
  
  // 特定のキーワードによる調整
  if (headingLower.includes('とは') || headingLower.includes('基本')) {
    relevanceScore *= 1.3; // 基本説明は重要
  } else if (headingLower.includes('まとめ') || headingLower.includes('最後に')) {
    relevanceScore *= 0.7; // まとめは短め
  } else if (headingLower.includes('メリット') || headingLower.includes('効果')) {
    relevanceScore *= 1.2; // メリットは重要
  } else if (headingLower.includes('注意') || headingLower.includes('デメリット')) {
    relevanceScore *= 0.9; // 注意点は標準的
  }
  
  return Math.min(2.0, Math.max(0.5, relevanceScore)); // 0.5〜2.0の範囲に収める
}

// 詳細な文字数配分を計算
export function calculateDetailedCharDistribution(
  outline: SeoOutline | any,  // Ver.2の構成も受け付ける
  keyword: string
): Map<string, number> {
  // nullチェックを追加
  if (!outline) {
    console.error('calculateDetailedCharDistribution: outline is null or undefined');
    const distribution = new Map<string, number>();
    distribution.set('introduction', 500);
    distribution.set('conclusion', 500);
    return distribution;
  }
  
  // Ver.2の構成の場合も対応
  const totalCharCount = outline?.characterCountAnalysis?.average || 
                        outline?.competitorComparison?.recommendedCharCount ||
                        5000;
  const distribution = new Map<string, number>();
  
  // リード文とまとめの文字数
  const introCharCount = Math.min(500, Math.round(totalCharCount * 0.02));
  const conclusionCharCount = Math.min(1000, Math.round(totalCharCount * 0.03));
  
  distribution.set('introduction', introCharCount);
  distribution.set('conclusion', conclusionCharCount);
  
  // 本文用の文字数
  const bodyCharCount = totalCharCount - introCharCount - conclusionCharCount;
  
  // 各セクションの重要度を計算
  // Ver.1とVer.2の両方に対応
  const sections = outline.outline || outline.sections;
  if (!sections) {
    throw new Error('構成案にセクションデータがありません');
  }
  
  const sectionImportances: SectionImportance[] = sections.map((section, index) => ({
    keyword,
    heading: section.heading,
    importance: calculateSectionImportance(
      section.heading,
      keyword,
      index,
      sections.length
    )
  }));
  
  // 重要度の合計
  const totalImportance = sectionImportances.reduce((sum, s) => sum + s.importance, 0);
  
  // 各セクションに文字数を配分
  sections.forEach((section, index) => {
    const importance = sectionImportances[index].importance;
    const sectionCharCount = Math.round((bodyCharCount * importance) / totalImportance);
    
    // H2全体の文字数
    distribution.set(`h2_${index}_${section.heading}`, sectionCharCount);
    
    // H3がある場合は、さらに細分化
    if (section.subheadings && section.subheadings.length > 0) {
      const h3Count = section.subheadings.length;
      const baseH3CharCount = Math.round(sectionCharCount / (h3Count + 1)); // +1はH2直下の文章分
      
      // H2直下の導入文
      distribution.set(`h2_${index}_intro`, Math.round(baseH3CharCount * 0.5));
      
      // 各H3に配分
      section.subheadings.forEach((subheading, h3Index) => {
        const h3Text = typeof subheading === 'string' ? subheading : subheading.text;
        const h3CharCount = Math.round(baseH3CharCount * 1.2); // H3は少し多めに
        distribution.set(`h3_${index}_${h3Index}_${h3Text}`, h3CharCount);
      });
    }
  });
  
  return distribution;
}

// 単一セクションを生成
async function generateSection(
  sectionIndex: number,
  section: any,
  targetCharCount: number,
  keyword: string,
  context: WritingContext,
  regulation: WritingRegulation,
  enableFactCheck: boolean = true
): Promise<SectionResult> {
  // ファクトチェック実行（オプション）
  let factInfo: FactInfo | null = null;
  if (enableFactCheck) {
    try {
      console.log(`🔍 セクション「${section.heading}」のファクトチェック中...`);
      factInfo = await checkFactsForSection(
        section.heading,
        keyword,
        section.subheadings
      );
      console.log(`✅ ${factInfo.facts.length}件の事実を収集`);
    } catch (error) {
      console.warn('ファクトチェックをスキップ:', error);
    }
  }
  
  // 前のセクションの要約を作成
  const previousContext = context.previousSections.length > 0
    ? `\n【これまでの内容】\n${context.previousSections.map(s => 
        `- ${s.heading}: ${s.summary}`
      ).join('\n')}\n`
    : '';
  
  // 使用済みの例を列挙
  const usedExamples = context.previousSections.flatMap(s => s.usedExamples);
  const usedExamplesText = usedExamples.length > 0
    ? `\n【既に使用した例】\n${usedExamples.join(', ')}（これらとは異なる例を使用）\n`
    : '';
  
  // ファクト情報をプロンプトに追加
  const factContext = factInfo && factInfo.facts.length > 0
    ? `\n【参考にすべき最新情報】\n${factInfo.facts
        .filter(f => f.trustScore >= 50) // 総合スコア50以上のみ使用
        .slice(0, 5)
        .map(f => {
          const dateInfo = f.date ? `、${f.date}` : '';
          return `- ${f.fact}（信頼度: ${f.trustScore}点${dateInfo}）`;
        })
        .join('\n')}\n`
    : '';
  
  // サービス訴求セクションか判定（自社サービス名を環境変数から取得）
  const serviceName = getBrand().serviceName;
  const isServiceSection = section.heading.includes(serviceName) || section.heading.includes('サービス訴求');

  let prompt = '';

  if (isServiceSection) {
    // サービス訴求セクション用の特別なプロンプト
    const companyInfo = getCompanyInfo();
    prompt = `
あなたはSEOライターです。サービス訴求セクションを執筆してください。

【記事のキーワード】
${keyword}

【ターゲット読者】
${context.targetAudience}

【文体】
${context.tone}
${previousContext}

【今回執筆するセクション】
見出し: ${section.heading}
${section.subheadings && section.subheadings.length > 0 ? `
サブ見出し:
${section.subheadings.map((sub: any) => {
  if (typeof sub === 'string') {
    return `- ${sub}`;
  } else {
    return `- ${sub.text}${sub.writingNote ? `\n  執筆指示: ${sub.writingNote}` : ''}`;
  }
}).join('\n')}
` : ''}

【サービス情報】
- サービス名: ${companyInfo.company.service_name || serviceName}
- 会社名: ${companyInfo.company.name || ''}
- 対象: 法人向けサービス

【導入事例】（業種名で記載、社名は出さない）
${companyInfo.case_studies.map(cs => {
  const industry = cs.industry || '企業';
  return `- ${industry}: ${cs.result}`;
}).join('\n')}

【目標文字数】
${targetCharCount}文字（厳守）

【執筆ルール】
1. 必ず${targetCharCount}文字程度で執筆（±10%以内）
2. HTML形式で出力（h2, h3, p, ul, li, strong タグを使用）
3. 検索意図「${keyword}」に自然につながる内容
4. 具体的な料金は記載しない
5. 無料相談への誘導にフォーカス
6. 企業名は出さず、業種名で記載（例：広告代理店様、メディア運営企業様）
7. 成果の数値は含めてOK（例：10万円→0円、24時間→10秒）
8. 前のセクションから自然に続くように書く`;
  } else {
    // 通常セクションのプロンプト
    prompt = `
あなたはSEOライターです。以下の指示に従って、記事の一部を執筆してください。

【記事のキーワード】
${keyword}

【ターゲット読者】
${context.targetAudience}

【文体】
${context.tone}
${previousContext}
${usedExamplesText}
${factContext}

【今回執筆するセクション】
見出し: ${section.heading}
${section.subheadings && section.subheadings.length > 0 ? `
サブ見出し:
${section.subheadings.map((sub: any) => {
  if (typeof sub === 'string') {
    return `- ${sub}`;
  } else {
    return `- ${sub.text}${sub.writingNote ? `\n  執筆指示: ${sub.writingNote}` : ''}`;
  }
}).join('\n')}
` : ''}
${section.writingNote ? `\n執筆指示: ${section.writingNote}` : ''}

【目標文字数】
${targetCharCount}文字（厳守）

【執筆ルール】
1. 必ず${targetCharCount}文字程度で執筆（±10%以内）
2. HTML形式で出力（h2, h3, p, ul, li, strong タグを使用）
3. 前のセクションから自然に続くように書く
4. PREP法の構造を使うが、ラベルは絶対に使用禁止：
   【禁止例】
   - 「結論：○○です」→ NG
   - 「理由：なぜなら○○」→ NG  
   - 「具体例：例えば○○」→ NG
   - 「まとめ：以上から○○」→ NG
   【正しい例】
   - 「○○です」→ OK（ラベルなしで直接述べる）
   - 「なぜなら○○」→ OK（接続詞だけ使う）
   - 「例えば○○」→ OK（接続詞だけ使う）
5. 一文一意、同じ語尾の3回以上の繰り返し禁止
6. 具体例を必ず含める（使用した例を記録）
7. 段落分けの基準：
   - 話題が変わるとき→新しい<p>タグ
   - 視点が変わるとき（総論→各論、メリット→デメリット等）→新しい<p>タグ
   - 時系列が変わるとき→新しい<p>タグ
   - 1段落は2-4文程度
8. H2直下には必ず導入文を配置（H3がある場合）：
   - 100-200文字程度の<p>タグ
   - そのセクションの概要と読者が得られる価値を説明
   - 「〜について解説します」のパターンは避ける
9. 最新情報を優先：
   - 提供された参考情報を積極的に活用
   - 古い情報は避け、2024年以降の情報を優先
   - 具体的な数値や事例を含める

【頻出キーワード】
${context.frequencyWords.slice(0, 10).map(w => w.word).join(', ')}

【出力形式】
以下のJSON形式で出力:
{
  "html": "<h2>見出し</h2><p>本文...</p>",
  "summary": "このセクションの要約（50文字程度）",
  "usedExamples": ["使用した具体例1", "使用した具体例2"],
  "actualCharCount": 実際の文字数
}
`;
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: Math.ceil(targetCharCount * 2), // 余裕を持たせる
      }
    });

    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // JSONを抽出
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to extract JSON from section response');
    }
    
    const sectionData = JSON.parse(jsonMatch[0]);
    
    // 文字数が目標に届かない場合は再生成（最大2回）
    let actualCharCount = sectionData.html.replace(/<[^>]*>/g, '').length;
    const tolerance = targetCharCount * 0.1; // 10%の許容範囲
    
    if (actualCharCount < targetCharCount - tolerance) {
      console.log(`セクション${sectionIndex}の文字数不足: ${actualCharCount}/${targetCharCount}。再生成します。`);
      
      // 不足分を追加で生成
      const additionalCharCount = targetCharCount - actualCharCount;
      const additionalContent = await generateAdditionalContent(
        section,
        sectionData.html,
        additionalCharCount,
        keyword,
        context
      );
      
      if (additionalContent) {
        sectionData.html += additionalContent.html;
        sectionData.usedExamples.push(...additionalContent.usedExamples);
        actualCharCount = sectionData.html.replace(/<[^>]*>/g, '').length;
      }
    }
    
    return {
      html: sectionData.html,
      actualCharCount,
      summary: sectionData.summary || `${section.heading}について説明`,
      usedExamples: sectionData.usedExamples || []
    };
    
  } catch (error) {
    console.error(`セクション生成エラー (${section.heading}):`, error);
    // エラー時は最小限の内容を返す
    return {
      html: `<h2>${section.heading}</h2><p>このセクションの生成に失敗しました。</p>`,
      actualCharCount: 50,
      summary: 'エラー',
      usedExamples: []
    };
  }
}

// 追加コンテンツを生成
async function generateAdditionalContent(
  section: any,
  existingHtml: string,
  targetCharCount: number,
  keyword: string,
  context: WritingContext
): Promise<{ html: string; usedExamples: string[] } | null> {
  const prompt = `
以下のセクションに、${targetCharCount}文字分の内容を追加してください。

【既存の内容】
${existingHtml}

【追加する内容の指針】
- より詳しい説明を追加
- 具体例を追加
- 関連する補足情報を追加
- 自然に続くように記述

【出力形式】
追加するHTMLのみを出力（pタグなどで）
`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: Math.ceil(targetCharCount * 2),
      }
    });

    const result = await model.generateContent(prompt);
    const additionalHtml = result.response.text();
    
    return {
      html: additionalHtml,
      usedExamples: []
    };
  } catch (error) {
    console.error('追加コンテンツ生成エラー:', error);
    return null;
  }
}

// リード文を生成
async function generateIntroduction(
  keyword: string,
  targetCharCount: number,
  outline: SeoOutline
): Promise<string> {
  const prompt = `
「${keyword}」についての記事のリード文を執筆してください。

【ターゲット読者】
${outline.targetAudience}

【記事の概要】
${outline.introduction || (outline.introductions?.conclusionFirst || outline.introductions?.empathy) || ''}

【文字数】
${targetCharCount}文字（厳守）

【執筆ルール】
1. 読者の悩みや疑問から始める
2. この記事で得られる情報を明確に示す
3. 読み進めたくなる文章にする
4. HTML形式（pタグのみ使用）

HTMLタグのみを直接出力してください。
`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 1000,
      }
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error('リード文生成エラー:', error);
    return `<p>${keyword}について詳しく解説します。</p>`;
  }
}

// まとめを生成
async function generateConclusion(
  keyword: string,
  targetCharCount: number,
  outline: SeoOutline,
  allSections: SectionResult[]
): Promise<string> {
  const mainPoints = allSections.map(s => s.summary).join('、');
  
  const prompt = `
「${keyword}」についての記事のまとめを執筆してください。

【記事で扱った内容】
${mainPoints}

【まとめの方向性】
${outline.conclusion}

【文字数】
${targetCharCount}文字（厳守）

【執筆ルール】
1. 記事の要点を簡潔にまとめる
2. 読者への行動喚起を含める
3. 前向きな締めくくりにする
4. HTML形式（h2, p タグを使用）

HTMLタグのみを直接出力してください。
`;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2000,
      }
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error('まとめ生成エラー:', error);
    return `<h2>まとめ</h2><p>${keyword}について解説しました。</p>`;
  }
}

// メイン: セクション単位で記事を生成
export async function generateArticleBySection(
  outline: SeoOutline | any,  // Ver.2の構成も受け付ける
  keyword: string,
  regulation: WritingRegulation = {}
): Promise<{
  title: string;
  metaDescription: string;
  htmlContent: string;
  plainText: string;
  sectionStats: {
    sectionName: string;
    targetChars: number;
    actualChars: number;
  }[];
}> {
  console.log('📝 セクション単位での記事生成を開始');
  
  // nullチェックを追加
  if (!outline) {
    console.error('generateArticleBySection: outline is null or undefined');
    throw new Error('構成案データが見つかりません');
  }
  
  console.log('Outline type:', outline.competitorComparison ? 'Ver.2' : 'Ver.1');
  console.log('Outline keys:', Object.keys(outline || {}));
  
  // 文字数配分を計算
  const charDistribution = calculateDetailedCharDistribution(outline, keyword);
  console.log('📊 文字数配分:', Array.from(charDistribution.entries()));
  
  // 文脈情報の初期化
  const context: WritingContext = {
    previousSections: [],
    tone: 'です・ます調',
    targetAudience: outline.targetAudience,
    frequencyWords: outline.competitorResearch?.frequencyWords || outline.competitorComparison?.frequencyWords || []
  };
  
  const sectionResults: SectionResult[] = [];
  const sectionStats: any[] = [];
  
  // 遅延処理のヘルパー関数（API レート制限対策）
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const API_DELAY_MS = 6500; // 6.5秒の遅延（1分10リクエスト制限を考慮）
  
  // 1. リード文を生成
  console.log('📝 リード文を生成中...');
  const introCharCount = charDistribution.get('introduction') || 500;
  const introduction = await generateIntroduction(keyword, introCharCount, outline);
  
  // API レート制限対策: リード文生成後に遅延
  await delay(API_DELAY_MS);
  
  // 2. 各セクションを順次生成
  // Ver.1とVer.2の両方に対応
  const allSections = outline.outline || outline.sections;
  if (!allSections) {
    throw new Error('構成案にセクションデータがありません');
  }
  
  for (let i = 0; i < allSections.length; i++) {
    const section = allSections[i];
    const sectionKey = `h2_${i}_${section.heading}`;
    const targetCharCount = charDistribution.get(sectionKey) || 3000;
    
    console.log(`📝 セクション${i + 1}/${allSections.length}を生成中: ${section.heading} (目標: ${targetCharCount}文字)`);
    
    const sectionResult = await generateSection(
      i,
      section,
      targetCharCount,
      keyword,
      context,
      regulation
    );
    
    sectionResults.push(sectionResult);
    sectionStats.push({
      sectionName: section.heading,
      targetChars: targetCharCount,
      actualChars: sectionResult.actualCharCount
    });
    
    // 文脈を更新
    context.previousSections.push({
      heading: section.heading,
      summary: sectionResult.summary,
      usedExamples: sectionResult.usedExamples
    });
    
    console.log(`✅ セクション${i + 1}完了: ${sectionResult.actualCharCount}文字`);
    
    // API レート制限対策: 各セクション生成後に遅延（最後のセクション以外）
    if (i < allSections.length - 1) {
      console.log(`⏳ APIレート制限対策: ${API_DELAY_MS / 1000}秒待機中...`);
      await delay(API_DELAY_MS);
    }
  }
  
  // 3. まとめを生成
  console.log('⏳ APIレート制限対策: まとめ生成前に待機中...');
  await delay(API_DELAY_MS);
  console.log('📝 まとめを生成中...');
  const conclusionCharCount = charDistribution.get('conclusion') || 1000;
  const conclusion = await generateConclusion(
    keyword,
    conclusionCharCount,
    outline,
    sectionResults
  );
  
  // 4. 全体を結合
  let htmlContent = [
    introduction,
    ...sectionResults.map(r => r.html),
    conclusion
  ].join('\n\n');
  
  // 5. タイトルとメタディスクリプションを生成
  const title = `【2025年最新】${keyword}完全ガイド｜${allSections[0].heading}から${allSections[allSections.length - 1].heading}まで徹底解説`;
  const metaDescription = `${keyword}について、${allSections.map(s => s.heading).slice(0, 3).join('、')}など、初心者にもわかりやすく解説。2025年最新情報を網羅した完全ガイドです。`;
  
  // プレーンテキスト版を生成
  const plainText = htmlContent
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  
  const totalActualChars = plainText.length;
  const totalTargetChars = outline.characterCountAnalysis?.average || 5000;
  
  console.log(`✅ 記事生成完了: ${totalActualChars}文字 / 目標${totalTargetChars}文字`);
  
  // 修正前の記事をバックアップ
  const originalHtmlContent = htmlContent;
  const originalPlainText = plainText;
  
  // 6. 自動校閲と修正を実行
  if (regulation?.enableAutoProofreading !== false) { // デフォルトで有効
    console.log('📋 自動校閲を開始します...');
    
    // APIレート制限対策
    await delay(6500);
    
    // 校閲を実行
    const proofreadingReport = await proofreadArticle(htmlContent, outline, regulation || {});
    console.log(`📊 校閲結果: ${proofreadingReport.violations.length}件の違反を検出`);
    console.log(`  スコア: ${proofreadingReport.overallScore}点`);
    
    // 違反がある場合は自動修正を実行
    if (proofreadingReport.violations.length > 0 && proofreadingReport.overallScore < 90) {
      console.log('🔧 自動修正を開始します...');
      
      // APIレート制限対策
      await delay(6500);
      
      // セクション単位で修正（新バージョン）
      const fixResult = await autoFixArticleBySection(
        htmlContent,
        proofreadingReport.violations,
        outline,
        regulation || {},
        3 // 最大3回試行
      );
      
      // 修正後のコンテンツを使用
      htmlContent = fixResult.fixedContent;
      
      // プレーンテキストを再生成
      const fixedPlainText = htmlContent
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      
      console.log(`✅ 自動修正完了: ${fixResult.attempts}回の試行`);
      console.log(`  最終スコア: ${fixResult.finalReport.overallScore}点`);
      console.log(`  残存違反数: ${fixResult.finalReport.violations.length}`);
      console.log(`  修正後の文字数: ${fixedPlainText.length}文字`);
      
      // 修正後のHTMLが完全かチェック
      const lastTag = htmlContent.slice(-20);
      console.log(`  HTML末尾確認: ${lastTag}`);
      
      // デバッグ用：各セクションの状態を確認
      const sections = htmlContent.match(/<h2[^>]*>.*?(?=<h2|$)/gs) || [];
      console.log(`  修正後のセクション数: ${sections.length}`);
      if (sections.length > 0) {
        console.log(`  最後のセクションの文字数: ${sections[sections.length - 1].length}文字`);
      }
      
      // 期待されるセクション数を動的に計算
      const expectedSections = allSections.length;
      const minAcceptableSections = Math.max(3, Math.floor(expectedSections * 0.7)); // 最低でも70%のセクションは必要
      
      // 修正後の記事が壊れていないかチェック
      const isArticleBroken = (
        fixedPlainText.length < originalPlainText.length * 0.5 || // 文字数が半分以下になった
        sections.length < minAcceptableSections || // セクション数が期待値の70%未満
        !htmlContent.includes('</h2>') || // h2タグが閉じていない
        htmlContent.endsWith('...') || // 省略記号で終わっている
        !htmlContent.trim().endsWith('>') // HTMLタグで終わっていない
      );
      
      if (isArticleBroken) {
        console.warn('⚠️ 修正後の記事が不完全なため、修正前の記事を使用します');
        console.warn(`  修正前: ${originalPlainText.length}文字 → 修正後: ${fixedPlainText.length}文字`);
        console.warn(`  セクション数: ${sections.length}/${expectedSections} (最低必要: ${minAcceptableSections})`);
        
        return {
          title,
          metaDescription,
          htmlContent: originalHtmlContent,
          plainText: originalPlainText,
          sectionStats,
          proofreadingReport: proofreadingReport, // 元の校閲レポート
          warning: '修正プロセスで記事が破損したため、修正前の記事を返しています'
        };
      }
      
      return {
        title,
        metaDescription,
        htmlContent,
        plainText: fixedPlainText,
        sectionStats,
        proofreadingReport: fixResult.finalReport // 最終レポートを含める
      };
    }
    
    return {
      title,
      metaDescription,
      htmlContent,
      plainText,
      sectionStats,
      proofreadingReport // 初回レポートを含める
    };
  }
  
  return {
    title,
    metaDescription,
    htmlContent,
    plainText,
    sectionStats
  };
}