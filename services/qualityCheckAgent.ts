// 品質チェックエージェント
// タイトル文字数と見出しの自然さに特化したチェック

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { SeoOutlineV2 } from '../types';

// 初期化
const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY || '');

// 品質チェックの実行
export async function runQualityCheck(
  outline: SeoOutlineV2,
  keyword: string
): Promise<SeoOutlineV2> {
  try {
    console.log('🔍 品質チェックエージェント開始...');
    
    // タイトル文字数をチェック
    const titleLength = outline.title.length;
    console.log(`📏 タイトル文字数: ${titleLength}文字`);
    
    // タイトルが規定内（29-35文字）かチェック
    const isTitleLengthValid = titleLength >= 29 && titleLength <= 35;
    
    // 見出し間の重複チェック（構成チェックエージェントと同様の実装）
    const duplicateIssues = checkHeadingDuplication(outline);
    
    // タイトル文字数が規定内で、見出しも問題なさそうな場合は修正不要
    if (isTitleLengthValid && duplicateIssues.length === 0) {
      console.log('✅ タイトル文字数は規定内です。見出しの自然さをチェックします。');
      
      // 簡易的な見出しチェック（明らかに問題がある場合のみ）
      let hasObviousProblem = false;
      outline.outline?.forEach(section => {
        if (/問題点導入|リスク導入|課題導入/.test(section.title)) {
          hasObviousProblem = true;
        }
      });
      
      if (!hasObviousProblem) {
        console.log('✅ 明らかな問題は見つかりませんでした。品質チェック完了。');
        return outline; // 修正不要でそのまま返す
      }
    }
    
    // 重複が見つかった場合はログ出力
    if (duplicateIssues.length > 0) {
      console.log('⚠️ 見出し間の重複を検出:');
      duplicateIssues.forEach(issue => {
        console.log(`  - ${issue}`);
      });
    }
    
    // 現在年を取得
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    
    // Gemini APIの設定（低温度で一貫性を保つ）
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.6-flash',
      generationConfig: {
        temperature: 0.1,  // さらに低温度で厳密に
        maxOutputTokens: 8192,
      }
    });

    // チェックと修正のプロンプト
    const prompt = `
あなたはSEO記事構成の品質チェック専門家です。
現在は${currentYear}年${currentMonth}月です。
以下の2つの観点のみでチェックと修正を行ってください。

## 入力情報
- キーワード: ${keyword}
- 現在の構成:
${JSON.stringify(outline, null, 2)}

## チェック項目

### 1. タイトル文字数チェック
- 現在: ${titleLength}文字
- 要件: 29〜35文字（理想は32文字前後）
- ${titleLength < 29 ? '⚠️ 短すぎます。内容を追加して29文字以上にしてください。' : ''}
- ${titleLength > 35 ? '⚠️ 長すぎます。簡潔にして35文字以下にしてください。' : ''}
- ${titleLength >= 29 && titleLength <= 35 ? '✅ 適切な文字数です。文字数の修正は不要です。' : ''}

**重要**: 
- 文字数が29-35文字の範囲内の場合、タイトルの文字数は変更しないでください
- 現在${titleLength}文字${titleLength >= 29 && titleLength <= 35 ? 'なので、文字数は適切です。変更不要。' : ''}

### 2. 見出しの自然さチェック
以下の違和感をチェックして修正:
- 不自然な言い回し
- 冗長な表現
- 文法的な誤り
- キーワードの不自然な詰め込み
- 読みにくい表現

### 3. 見出し間の重複チェック
${duplicateIssues.length > 0 ? `
⚠️ 以下の見出しに重複があります:
${duplicateIssues.map(issue => `- ${issue}`).join('\n')}
これらの重複を解消してください。` : '✅ 見出し間の重複はありません。'}

## 修正ルール
1. タイトルが29文字未満の場合のみ、29文字以上に修正
2. タイトルが35文字を超える場合のみ、35文字以下に修正
3. **タイトルが29-35文字の場合は、文字数調整のための修正は絶対に行わない**
4. 見出しの違和感がある場合のみ修正（ただしタイトル文字数を変えないよう注意）
5. 修正は最小限に留める（問題ない部分は変更しない）
6. キーワードは必ず含める
7. **重要**: 年号（${currentYear}年など）は絶対に変更しない
8. **重要**: ${currentYear}年が含まれている場合、それをそのまま維持する
9. **重要**: 過去の年（${currentYear - 1}年以前）に変更しない
10. **最重要**: タイトルが現在${titleLength}文字で規定内の場合、文字数を変更する修正は禁止

## 出力形式
修正後の構成全体をJSON形式で出力してください。
必ず元の構成と同じ構造を維持してください。

**重要な注意事項**:
- JSON内の文字列値（title, metaDescription, heading等）に改行を含めないでください
- 各文字列は必ず1行で記述してください
- 長い文字列でも改行せず、1行で出力してください
- コメントは使用しないでください（JSONの仕様上、コメントは無効です）

\`\`\`json
{
  "title": "修正後のタイトル",
  "metaDescription": "...",
  "introductions": {...},
  "targetAudience": "...",
  "outline": [
    {
      "title": "H2タイトル",
      "content": ["H3タイトル1", "H3タイトル2"],
      "imagePrompt": "..."
    }
  ],
  "conclusion": "...",
  "keywords": [...],
  // 以下、変更がない部分もすべて含める
}
\`\`\`
`;

    // Geminiに修正を依頼
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // JSON部分を抽出
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      console.log('⚠️ 品質チェック: JSON形式の修正案が見つかりませんでした');
      return outline;
    }

    try {
      // コメントを除去してJSONをパース（改行や制御文字も考慮）
      let jsonText = jsonMatch[1]
        .replace(/\/\/[^\n]*/g, '') // 単一行コメントを除去
        .replace(/\/\*[\s\S]*?\*\//g, '') // 複数行コメントを除去
        .replace(/,(\s*[}\]])/g, '$1'); // 末尾のカンマを除去
      
      // 文字列内の制御文字を処理（JSONの文字列値の中の改行をエスケープ）
      // "key": "value の途中で
      // 改行" のようなケースを修正
      jsonText = jsonText.replace(/"([^"]*)\n([^"]*)":/g, '"$1$2":'); // キー内の改行を除去
      jsonText = jsonText.replace(/:\s*"([^"]*)(\n|\r|\t)([^"]*)"/g, (match, p1, p2, p3) => {
        // 値内の改行・タブを除去（複数回適用が必要な場合があるため）
        let cleaned = p1 + p3;
        while (cleaned.includes('\n') || cleaned.includes('\r') || cleaned.includes('\t')) {
          cleaned = cleaned.replace(/[\n\r\t]/g, '');
        }
        return `: "${cleaned}"`;
      });
      
      // さらに念のため、全体的な制御文字のクリーニング（ただし、JSON構造は維持）
      jsonText = jsonText
        .split('\n')
        .map(line => {
          // 文字列値の中にある改行を検出して除去
          if (line.includes('": "') && !line.trim().endsWith('",') && !line.trim().endsWith('"')) {
            // 文字列が途中で切れている可能性
            return line.replace(/\n/g, '');
          }
          return line;
        })
        .join('\n')
        .trim();
      
      // デバッグ用：パース前のJSON文字列の最初の200文字を出力
      console.log('JSON parse attempt (first 200 chars):', jsonText.substring(0, 200));
      
      const fixedOutline = JSON.parse(jsonText) as SeoOutlineV2;
      
      // 修正内容をログ出力
      if (fixedOutline.title !== outline.title) {
        console.log(`✏️ タイトル修正: ${outline.title.length}文字 → ${fixedOutline.title.length}文字`);
        console.log(`  旧: ${outline.title}`);
        console.log(`  新: ${fixedOutline.title}`);
      }
      
      // 見出し修正のログ（Ver.2の構造に対応）
      if (fixedOutline.outline && Array.isArray(fixedOutline.outline)) {
        fixedOutline.outline.forEach((section, i) => {
          if (outline.outline && outline.outline[i] && section.title !== outline.outline[i].title) {
            console.log(`✏️ H2修正: ${section.title}`);
          }
          
          section.content?.forEach((sub, j) => {
            if (outline.outline && outline.outline[i]?.content?.[j] && 
                sub !== outline.outline[i].content![j]) {
              console.log(`✏️ H3修正: ${sub}`);
            }
          });
        });
      }
      
      console.log('✅ 品質チェック完了');
      return fixedOutline;
      
    } catch (error) {
      console.error('❌ 修正案のパースエラー:', error);
      
      // エラー時は元の構成をそのまま返す（エラーでも処理を止めない）
      console.log('⚠️ 品質チェックをスキップして元の構成を使用します');
      return outline;
    }
    
  } catch (error) {
    console.error('❌ 品質チェックエラー:', error);
    return outline;
  }
}

// タイトル文字数の検証
export function validateTitleLength(title: string): {
  isValid: boolean;
  length: number;
  message: string;
} {
  const length = title.length;
  
  if (length < 29) {
    return {
      isValid: false,
      length,
      message: `タイトルが短すぎます（${length}文字）。29文字以上にしてください。`
    };
  }
  
  if (length > 35) {
    return {
      isValid: false,
      length,
      message: `タイトルが長すぎます（${length}文字）。35文字以下にしてください。`
    };
  }
  
  return {
    isValid: true,
    length,
    message: `タイトル文字数は適切です（${length}文字）。`
  };
}

// 見出し間の重複チェック（構成チェックエージェントから移植）
function checkHeadingDuplication(outline: SeoOutlineV2): string[] {
  const issues: string[] = [];
  
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
  
  outline.outline?.forEach((section, sectionIndex) => {
    // H2を追加
    if (section.title) {
      allHeadings.push({
        text: section.title,
        type: 'H2',
        location: `セクション${sectionIndex + 1}`
      });
    }
    
    // H3を追加（content配列形式）
    section.content?.forEach((h3Text, subIndex) => {
      if (h3Text) {
        allHeadings.push({
          text: h3Text,
          type: 'H3',
          location: `セクション${sectionIndex + 1}のH3-${subIndex + 1}`
        });
      }
    });
  });
  
  // 意図の重複をチェック
  const processedPairs = new Set<string>();
  
  allHeadings.forEach((heading1, index1) => {
    const intent1 = normalizeIntent(heading1.text);
    
    allHeadings.forEach((heading2, index2) => {
      if (index1 >= index2) return; // 同じペアを2回チェックしない
      
      const intent2 = normalizeIntent(heading2.text);
      const pairKey = `${index1}-${index2}`;
      
      if (processedPairs.has(pairKey)) return;
      
      // 完全一致または部分一致をチェック
      if (intent1 === intent2 || 
          (intent1.includes(intent2) && intent2.length > 3) || 
          (intent2.includes(intent1) && intent1.length > 3)) {
        processedPairs.add(pairKey);
        issues.push(
          `「${heading1.text}」(${heading1.type}・${heading1.location}) と「${heading2.text}」(${heading2.type}・${heading2.location}) が重複`
        );
      }
    });
  });
  
  return issues;
}

// 見出しの自然さチェック
export function checkHeadingNaturalness(heading: string): {
  isNatural: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  
  // 不自然なパターンのチェック
  
  // 1. 過度な記号の使用
  if ((heading.match(/[【】｜・]/g) || []).length > 2) {
    issues.push('記号が多すぎます');
  }
  
  // 2. 重複表現
  const words = heading.split(/[のをがでと]/);
  const duplicates = words.filter((word, index) => 
    word.length > 2 && words.indexOf(word) !== index
  );
  if (duplicates.length > 0) {
    issues.push('重複表現があります');
  }
  
  // 3. 冗長な表現
  const redundantPatterns = [
    /について説明/,
    /に関する説明/,
    /を解説する/,
    /を詳しく/,
    /について詳しく/
  ];
  
  if (redundantPatterns.some(pattern => pattern.test(heading))) {
    issues.push('冗長な表現があります');
  }
  
  // 4. 文法的な誤り
  if (/ををと|がが|のの|ですです/.test(heading)) {
    issues.push('文法的な誤りがあります');
  }
  
  // 5. 不自然な助詞の連続
  if (/[をのがでにへとから]{3,}/.test(heading)) {
    issues.push('助詞が連続しています');
  }
  
  return {
    isNatural: issues.length === 0,
    issues
  };
}