// 構成チェックエージェント Ver.2
// 生成された構成案の品質チェックと自動修正

import { GoogleGenerativeAI } from "@google/generative-ai";
// latestAIModelsは汎用化のため削除
import type { 
  SeoOutlineV2, 
  OutlineCheckResult,
  CompetitorResearchResult
} from '../types';
import { countCharacters } from '../utils/characterCounter';
import { generateOutlineV2 } from './outlineGeneratorV2';
// 自社サービス関連のimportは汎用化のため削除
// import { getCompanyInfo } from './companyService';

// ノイズ記事を除外して平均値を計算
function calculateAveragesExcludingNoise(
  articles: CompetitorResearchResult['validArticles'],
  keyword: string
): {
  averageH2Count: number;
  averageH3Count: number;
  excludedArticles: number[];
  originalAverageH2: number;
  originalAverageH3: number;
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
      excludedIndices.push(article.rank); // 順位を保存
      console.log(`🚫 ノイズとして除外: ${article.rank}位 ${article.title}`);
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
  
  // ログ出力
  console.log(`\n📊 ノイズ除外による平均値の変化（チェック時）:`);
  console.log(`   初期対象: ${articles.length}記事（上位15記事まで）`);
  console.log(`   ノイズ除外後: ${filteredArticles.length}記事（${excludedIndices.length}記事除外）`);
  console.log(`   最終分析対象: ${finalArticles.length}記事（最大10記事に制限）`);
  console.log(`   H2平均: ${originalH2Avg.toFixed(1)}個 → ${averageH2Count}個`);
  console.log(`   H3平均: ${originalH3Avg.toFixed(1)}個 → ${averageH3Count}個`);
  if (excludedIndices.length > 0) {
    console.log(`   除外記事: ${excludedIndices.join(', ')}位\n`);
  }
  
  return {
    averageH2Count,
    averageH3Count,
    excludedArticles: excludedIndices,
    originalAverageH2: originalH2Avg,
    originalAverageH3: originalH3Avg
  };
}

const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set.");
}
const genAI = new GoogleGenerativeAI(apiKey);

// 構成案のチェック
export function checkOutline(
  outline: SeoOutlineV2,
  competitorData?: {
    averageH2Count: number;
    averageH3Count: number;
  },
  keyword?: string
): OutlineCheckResult {
  const errors: OutlineCheckResult['errors'] = [];
  const suggestions: string[] = [];
  
  // 1. タイトル文字数チェック（29〜50文字）
  const titleLength = countCharacters(outline.title);
  if (titleLength < 29 || titleLength > 50) {
    errors.push({
      field: 'title',
      message: `タイトルが${titleLength}文字です。29〜50文字の範囲内に調整してください。`,
      severity: 'error'
    });
  } else if (titleLength > 35) {
    suggestions.push(`タイトルが${titleLength}文字です。基本は32文字前後が理想的ですが、現在の長さでも問題ありません。`);
  }
  
  // 2. メタディスクリプション文字数チェック（100-150文字）
  const metaLength = countCharacters(outline.metaDescription);
  if (metaLength < 100 || metaLength > 150) {
    errors.push({
      field: 'metaDescription',
      message: `メタディスクリプションが${metaLength}文字です。100-150文字の範囲に収めてください。`,
      severity: 'error'
    });
  }
  
  // 3. H3の「0 or 2以上」ルールチェック
  outline.outline.forEach((section, index) => {
    const h3Count = section.subheadings.length;
    if (h3Count === 1) {
      errors.push({
        field: `outline[${index}].subheadings`,
        message: `「${section.heading}」のH3が1個です。0個または2個以上にしてください。`,
        severity: 'error'
      });
    }
  });
  
  // 4. ±10%ルールチェック（-10%から+10%の範囲内）
  if (competitorData && competitorData.averageH2Count > 0) {
    // ±10%ルールを適用
    const minH2Count = Math.max(5, Math.ceil(competitorData.averageH2Count * 0.9)); // 最低5個は必要
    const maxH2Count = Math.max(10, Math.floor(competitorData.averageH2Count * 1.1)); // 最大10個は必要
    const minH3Count = Math.max(0, Math.ceil(competitorData.averageH3Count * 0.9));
    const maxH3Count = Math.max(5, Math.floor(competitorData.averageH3Count * 1.1)); // 最大5個は必要
    
    const currentH2Count = outline.outline.length;
    const currentH3Count = outline.outline.reduce((sum, section) => sum + section.subheadings.length, 0);
    
    // H2チェック
    if (currentH2Count < minH2Count) {
      errors.push({
        field: 'outline',
        message: `H2が${currentH2Count}個です。-10%ルールにより最低${minH2Count}個必要です。`,
        severity: 'error'
      });
      suggestions.push(`H2をあと${minH2Count - currentH2Count}個追加してください。`);
    } else if (currentH2Count > maxH2Count) {
      errors.push({
        field: 'outline',
        message: `H2が${currentH2Count}個です。+10%ルールにより最大${maxH2Count}個までです。`,
        severity: 'error'
      });
      suggestions.push(`H2を${currentH2Count - maxH2Count}個削減してください。`);
    }
    
    // H3チェック
    if (currentH3Count < minH3Count) {
      errors.push({
        field: 'outline',
        message: `H3が合計${currentH3Count}個です。-10%ルールにより最低${minH3Count}個必要です。`,
        severity: 'error'
      });
      suggestions.push(`H3をあと${minH3Count - currentH3Count}個追加してください。`);
    } else if (currentH3Count > maxH3Count) {
      errors.push({
        field: 'outline',
        message: `H3が合計${currentH3Count}個です。+10%ルールにより最大${maxH3Count}個までです。`,
        severity: 'error'
      });
      suggestions.push(`H3を${currentH3Count - maxH3Count}個削減してください。`);
    }
  }
  
  // 5. 鮮度チェック
  if (outline.freshnessData?.hasOutdatedInfo) {
    errors.push({
      field: 'freshness',
      message: '古い情報が含まれています。最新情報に更新してください。',
      severity: 'warning'
    });
    outline.freshnessData.outdatedSections?.forEach(section => {
      suggestions.push(`更新推奨: ${section}`);
    });
  }

  // 6. 差分ポイントチェック
  if (outline.competitorComparison.differentiators.length < 3) {
    errors.push({
      field: 'differentiators',
      message: '差分ポイントが3つ未満です。競合との差別化要素を追加してください。',
      severity: 'warning'
    });
  }
  
  // 7. H2-H3の意味重複チェック
  outline.outline.forEach((section, index) => {
    if (section.subheadings && section.subheadings.length > 0) {
      // H2が「〜とは？」「〜とは」の形式かチェック
      const isDefinitionH2 = section.heading.match(/とは[？?]?$|の定義|の概要|について$/);
      
      section.subheadings.forEach(subheading => {
        // H3に「定義」「概要」「〜とは」が含まれているかチェック
        const hasRedundantH3 = subheading.text.match(/の定義|^定義$|の概要|^概要$|とは[？?]?$/);
        
        if (isDefinitionH2 && hasRedundantH3) {
          errors.push({
            field: 'outline',
            message: `H2「${section.heading}」とH3「${subheading.text}」で意味が重複しています。H3は具体的な要素（仕組み、種類、特徴など）にしてください。`,
            severity: 'warning'
          });
          suggestions.push(`例: H3を「基本的な仕組み」「主な種類と特徴」「従来との違い」などに変更`);
        }
        
        // H2とH3で同じキーワードが重複していないかチェック
        // 助詞を除去して実質的な単語を抽出
        const h2Keywords = section.heading.replace(/[のをがはでと？?、。]/g, ' ').split(' ').filter(w => w.length >= 2);
        const h3Keywords = subheading.text.replace(/[のをがはでと？?、。]/g, ' ').split(' ').filter(w => w.length >= 2);
        
        // 重要なキーワードの重複を検出（「方法」「手順」などの一般的な語は除外）
        const commonKeywords = h2Keywords.filter(keyword => 
          h3Keywords.includes(keyword) && 
          !['方法', '手順', 'ポイント', '注意点', '応用', 'まとめ', 'FAQ'].includes(keyword)
        );
        
        // 「基本」「仕組み」など、意味のあるキーワードが2個以上重複している場合はエラー
        // または、1個でも「基本」「仕組み」「概要」「定義」などの重要語が重複している場合もエラー
        const importantKeywords = ['基本', '仕組み', '概要', '定義', '特徴', '種類', '違い'];
        const hasImportantDuplicate = commonKeywords.some(keyword => importantKeywords.includes(keyword));
        
        if (commonKeywords.length >= 2 || hasImportantDuplicate) {
          errors.push({
            field: 'outline',
            message: `H2「${section.heading}」とH3「${subheading.text}」で重要なキーワード（${commonKeywords.join('、')}）が重複しています。H3は異なる観点から具体的に記述してください。`,
            severity: 'error'  // warningからerrorに変更して重要度を上げる
          });
        }
      });
    }
  });
  
  // 8. 画像提案の具体性チェック
  outline.outline.forEach((section, index) => {
    if (section.imageSuggestion && section.imageSuggestion.length < 20) {
      suggestions.push(`「${section.heading}」の画像提案をより具体的にしてください（被写体・構図まで）。`);
    }
  });
  
  // 9. 記事構成の順序チェック（FAQ → まとめ）
  const outlineLength = outline.outline.length;
  if (outlineLength >= 2) {
    const lastSection = outline.outline[outlineLength - 1];
    const secondLastSection = outlineLength >= 2 ? outline.outline[outlineLength - 2] : null;

    // まとめが最後にあるかチェック
    const isLastSummary = lastSection.heading.includes('まとめ') ||
                         lastSection.heading.includes('最後に') ||
                         lastSection.heading.includes('おわりに');

    if (!isLastSummary) {
      errors.push({
        field: 'outline',
        message: '「まとめ」セクションが最後に配置されていません。',
        severity: 'error'
      });
    }

    // まとめ見出しのフォーマットチェック
    if (isLastSummary) {
      const summaryHeading = lastSection.heading;
      const hasColon = summaryHeading.includes('：');
      const hasKeyword = keyword ? summaryHeading.includes(keyword) : true;

      if (!hasColon || summaryHeading === 'まとめ' || summaryHeading === '最後に' || summaryHeading === 'おわりに') {
        errors.push({
          field: 'outline',
          message: 'まとめ見出しは「まとめ：キーワードを含みつつ記事の要点を示すサブタイトル」の形式にしてください。',
          severity: 'error'
        });
        suggestions.push(`例: 「まとめ：${keyword || 'キーワード'}の基本を理解して着実に成果を出そう」`);
        suggestions.push(`例: 「まとめ：${keyword || 'キーワード'}を継続的に改善して長期的な成功へ」`);
      }

      if (!hasKeyword && keyword) {
        errors.push({
          field: 'outline',
          message: `まとめ見出しにキーワード「${keyword}」が含まれていません。`,
          severity: 'warning'
        });
      }
    }

    // FAQがある場合、まとめの前にあるかチェック
    const faqSectionIndex = outline.outline.findIndex(section => {
      const heading = section.heading;

      // 直接的なFAQ表現
      if (heading.includes('FAQ') ||
          heading.includes('よくある質問') ||
          heading.includes('Q&A') ||
          heading.includes('質問')) {
        return true;
      }

      // FAQの内容から判断（H3にQ1, Q2などがある場合）
      const hasQAContent = section.subheadings?.some(sub =>
        sub.text.match(/^Q\d|^質問\d|^疑問/) ||
        sub.text.includes('ですか？') ||
        sub.text.includes('ますか？')
      );

      if (hasQAContent) {
        console.log(`📝 FAQ検出: "${heading}" (H3の内容からFAQと判断)`);
        return true;
      }

      // キーワードベースの判断（FAQ関連の見出しパターン）
      const faqKeywords = ['疑問', '回答', 'お悩み', '不安', 'ご質問'];
      const hasFAQKeyword = faqKeywords.some(keyword => heading.includes(keyword));

      if (hasFAQKeyword) {
        console.log(`📝 FAQ検出: "${heading}" (FAQキーワードから判断)`);
        return true;
      }

      return false;
    });

    if (faqSectionIndex !== -1) {
      const faqHeading = outline.outline[faqSectionIndex].heading;

      // FAQ見出しの品質チェック
      // 1. 短すぎる見出しをチェック
      if (faqHeading === 'FAQ' || faqHeading === 'よくある質問' || faqHeading === 'Q&A') {
        errors.push({
          field: `outline[${faqSectionIndex}].heading`,
          message: 'FAQ見出しが短すぎます。キーワードを含む具体的な見出しにしてください',
          severity: 'high'
        });
      }

      // 2. 不自然な「導入」の使用をチェック（問題系キーワードの場合）
      const hasProblematicKeyword = /問題|課題|リスク|デメリット|欠点|危険|懸念|注意/.test(keyword || '');
      if (hasProblematicKeyword && faqHeading.includes('導入')) {
        errors.push({
          field: `outline[${faqSectionIndex}].heading`,
          message: 'FAQ見出しが不自然です。問題・リスク系のキーワードに「導入」を付けないでください',
          severity: 'high'
        });
        const cleanKeyword = (keyword || '').replace(/\s+/g, '');
        suggestions.push(`FAQ見出しを「${cleanKeyword}に関するよくある質問」に変更することを推奨`);
      }

      // 3. 意味不明な結合をチェック（例：「生成AI問題点導入における」）
      if (/問題点導入|リスク導入|課題導入|欠点導入/.test(faqHeading)) {
        errors.push({
          field: `outline[${faqSectionIndex}].heading`,
          message: 'FAQ見出しが意味不明です。自然な日本語に修正してください',
          severity: 'critical'
        });
      }

      // 位置のチェック：FAQはまとめの前にあるべき
      const summaryIndex = outline.outline.findIndex(section =>
        section.heading.includes('まとめ') ||
        section.heading.includes('最後に') ||
        section.heading.includes('おわりに')
      );

      if (summaryIndex !== -1 && faqSectionIndex > summaryIndex) {
        errors.push({
          field: 'outline',
          message: 'FAQセクションは「まとめ」セクションの前に配置する必要があります。',
          severity: 'error'
        });
        suggestions.push('正しい順序: FAQ → まとめ');
      }
    }
  }
  
  // 10. 執筆メモの文字数チェック
  outline.outline.forEach((section, index) => {
    const h2NoteLength = countCharacters(section.writingNote);
    if (h2NoteLength > 200) {
      errors.push({
        field: `outline[${index}].writingNote`,
        message: `「${section.heading}」の執筆メモが${h2NoteLength}文字です。200文字以内にしてください。`,
        severity: 'warning'
      });
    }
    
    section.subheadings.forEach((sub, subIndex) => {
      if (sub.writingNote) {
        const h3NoteLength = countCharacters(sub.writingNote);
        if (h3NoteLength > 300) {
          errors.push({
            field: `outline[${index}].subheadings[${subIndex}].writingNote`,
            message: `「${sub.text}」の執筆メモが${h3NoteLength}文字です。300文字以内を推奨します。`,
            severity: 'warning'
          });
        }
      }
    });
  });
  
  // 9. 重複チェック - 同じ意図の見出しが複数箇所に存在しないか確認
  const headingIntentMap = new Map<string, string[]>();
  
  // 意図を正規化する関数（類似判定用）
  const normalizeIntent = (heading: string): string => {
    if (!heading || typeof heading !== 'string') {
      return '';
    }
    return heading
      .replace(/[\s　]/g, '') // スペースを削除
      .replace(/[・、。]/g, '') // 区切り文字を削除
      .replace(/とは$/, '') // 「とは」を削除
      .replace(/について$/, '') // 「について」を削除
      .replace(/の?方法$/, '') // 「方法」「の方法」を削除
      .replace(/の?やり方$/, '') // 「やり方」「のやり方」を削除
      .replace(/の?メリット/, 'メリット') // メリットを正規化
      .replace(/の?デメリット/, 'デメリット') // デメリットを正規化
      .replace(/の?効果/, '効果') // 効果を正規化
      .replace(/の?注意点/, '注意点') // 注意点を正規化
      .toLowerCase(); // 小文字化
  };
  
  // すべてのH2とH3を収集
  const allHeadings: { text: string; type: 'H2' | 'H3'; location: string }[] = [];
  
  outline.outline.forEach((section, sectionIndex) => {
    // H2を追加
    allHeadings.push({
      text: section.heading,
      type: 'H2',
      location: `セクション${sectionIndex + 1}`
    });
    
    // H3を追加
    section.subheadings.forEach((sub, subIndex) => {
      allHeadings.push({
        text: sub.text,
        type: 'H3',
        location: `セクション${sectionIndex + 1}のH3-${subIndex + 1}`
      });
    });
  });
  
  // 意図の重複をチェック
  const intentDuplicates: { intent: string; headings: typeof allHeadings }[] = [];
  const processedIntents = new Set<string>();
  
  allHeadings.forEach((heading1, index1) => {
    const intent1 = normalizeIntent(heading1.text);
    
    if (processedIntents.has(intent1)) {
      return; // すでに処理済み
    }
    
    const duplicates = allHeadings.filter((heading2, index2) => {
      if (index1 === index2) return false;
      const intent2 = normalizeIntent(heading2.text);
      
      // 完全一致または部分一致をチェック
      return intent1 === intent2 || 
             (intent1.includes(intent2) && intent2.length > 3) || 
             (intent2.includes(intent1) && intent1.length > 3);
    });
    
    if (duplicates.length > 0) {
      processedIntents.add(intent1);
      duplicates.forEach(dup => processedIntents.add(normalizeIntent(dup.text)));
      
      intentDuplicates.push({
        intent: heading1.text,
        headings: [heading1, ...duplicates]
      });
    }
  });
  
  // 重複エラーを追加
  intentDuplicates.forEach(duplicate => {
    const locations = duplicate.headings.map(h => `「${h.text}」(${h.type}・${h.location})`).join(', ');
    errors.push({
      field: 'duplicates',
      message: `同じ意図の見出しが複数存在: ${locations}`,
      severity: 'error'
    });
    suggestions.push(`重複を解消: ${duplicate.headings[0].text}の内容を1箇所に統合するか、それぞれ異なる切り口に変更してください。`);
  });
  
  return {
    isValid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
    suggestions
  };
}

// 構成案の自動修正
export async function fixOutline(
  outline: SeoOutlineV2,
  checkResult: OutlineCheckResult,
  keyword: string,
  competitorResearch: CompetitorResearchResult,
  attemptNumber: number = 0
): Promise<SeoOutlineV2> {
  // エラーがない場合はそのまま返す
  if (checkResult.isValid && checkResult.errors.length === 0) {
    return outline;
  }
  
  // H3数不足の場合は、より具体的な指示を追加
  const h3Errors = checkResult.errors.filter(e => e.message.includes('H3が'));
  const h3Shortage = h3Errors.length > 0 ? h3Errors[0].message.match(/最低(\d+)個/)?.[1] : null;
  
  const fixPrompt = `
以下の構成案のエラーを修正してください。

【現在の構成案】
${JSON.stringify(outline, null, 2)}

【修正が必要な箇所】
${checkResult.errors.map(e => `- ${e.field}: ${e.message}`).join('\n')}

【修正の提案】
${checkResult.suggestions.join('\n')}

${h3Shortage ? `
【重要：H3の追加指示】
現在のH3数が不足しています。以下の方法でH3を追加してください：
1. 各H2（まとめ以外）に最低4-6個のH3を配置
2. 重要なH2には8-10個のH3を配置
3. 合計で最低${h3Shortage}個のH3が必要です
4. H3の内容は具体的で実践的なものにしてください
` : ''}

【要件】
- タイトル: 29〜50文字（理想: 35文字前後）
- メタディスクリプション: 100〜150文字（理想: 125文字前後）
- H3: 0個または2個以上（1個は禁止）
- まとめH2にはH3を0個にする
- 文字数は全角=1、半角=0.5で計算
- 重複禁止: 同じ意図の見出しを複数箇所に配置しない

【読みやすさルール】
- タイトルでは漢字の単語同士が直接つながらないよう、適切な助詞（の、を、で、と等）を使用
- 悪い例：生成AI活用事例紹介、業務効率化実現方法
- 良い例：生成AIの活用事例を紹介、業務効率化を実現する方法
- 漢字が4文字以上連続しないよう配慮する
- 【】を使用する場合は必ずタイトルの最初に配置

修正した構成案をJSON形式で出力してください。
`;

  try {
    // 修正回数に応じて温度とtop_pを下げる（より正確性を重視）
    // temperature: 1回目: 0.4, 2回目: 0.2
    // top_p: 1回目: 0.95, 2回目: 0.85
    const temperature = attemptNumber === 0 ? 0.4 : 0.2;
    const topP = attemptNumber === 0 ? 0.95 : 0.85;
    
    const model = genAI.getGenerativeModel({
      model: "gemini-3.7-flash",
      generationConfig: {
        temperature, // 修正回数に応じて正確性を高める
        topP,        // 修正回数に応じて確実性を高める
        maxOutputTokens: 16000, // 大きな構成にも対応
        responseMimeType: "application/json"
      }
    });

    const result = await model.generateContent(fixPrompt);
    let responseText = result.response.text();
    
    // JSONの前後の不要な文字を削除
    responseText = responseText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    responseText = responseText.trim();
    
    // JSONパースを試みる
    let fixedOutline;
    try {
      fixedOutline = JSON.parse(responseText);
    } catch (parseError) {
      console.error('修正時のJSONパースエラー:', parseError);
      console.error('Response text (first 500 chars):', responseText.substring(0, 500));
      // パースに失敗した場合は元の構成を返す
      return outline;
    }
    
    // 修正後の構成を再度チェック
    const reCheckResult = checkOutline(fixedOutline, {
      averageH2Count: outline.competitorComparison.averageH2Count,
      averageH3Count: outline.competitorComparison.averageH3Count
    });
    
    // まだエラーがある場合は、構成を再生成
    if (!reCheckResult.isValid) {
      console.warn('1回目の修正後もエラーが残っています。構成を再生成します。');
      
      // 構成を再生成（より厳密な要件で）
      const regeneratedOutline = await generateOutlineV2(
        keyword,
        competitorResearch,
        true,
        true
      );
      
      return regeneratedOutline;
    }
    
    return fixedOutline;
    
  } catch (error) {
    console.error('構成案の修正エラー:', error);
    // 修正に失敗した場合は元の構成を返す
    return outline;
  }
}

// チェックと修正を統合したワークフロー
export async function checkAndFixOutline(
  outline: SeoOutlineV2,
  keyword: string,
  competitorResearch: CompetitorResearchResult
): Promise<{
  finalOutline: SeoOutlineV2;
  checkResult: OutlineCheckResult;
  wasFixed: boolean;
}> {
  let currentOutline = outline;
  let wasFixed = false;
  const maxAttempts = 2; // 修正回数を2回に変更（1回目で大きなエラー、2回目で細かい調整）
  
  // ノイズ除外した平均値を計算（上位15記事から開始）
  const top15Articles = competitorResearch.validArticles.slice(0, Math.min(15, competitorResearch.validArticles.length));
  const { averageH2Count, averageH3Count } = calculateAveragesExcludingNoise(top15Articles, keyword);
  
  // 最大2回まで修正を試みる
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // チェック（ノイズ除外後の平均値を使用）
    const checkResult = checkOutline(currentOutline, {
      averageH2Count,
      averageH3Count
    }, keyword);
    
    // エラーがなければ成功
    if (checkResult.isValid && checkResult.errors.filter(e => e.severity === 'error').length === 0) {
      return {
        finalOutline: currentOutline,
        checkResult,
        wasFixed
      };
    }
    
    // エラーがある場合は修正
    if (attempt === 0) {
      console.log('構成案にエラーが見つかりました。自動修正を開始します...');
    } else {
      console.log(`${attempt}回目の修正後もエラーが残っています。再修正を試みます...`);
    }
    
    currentOutline = await fixOutline(currentOutline, checkResult, keyword, competitorResearch, attempt);
    wasFixed = true;
  }
  
  // 2回修正してもダメな場合の最終チェック
  const finalCheck = checkOutline(currentOutline, {
    averageH2Count: currentOutline.competitorComparison.averageH2Count,
    averageH3Count: currentOutline.competitorComparison.averageH3Count
  });
  
  if (!finalCheck.isValid) {
    console.warn('2回の修正後もエラーが残っていますが、現在の構成を返します。');
  }
  
  return {
    finalOutline: currentOutline,
    checkResult: finalCheck,
    wasFixed
  };
}