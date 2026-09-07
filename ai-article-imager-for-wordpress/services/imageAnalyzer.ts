import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY! });

// 画像の視覚的特徴を分析
export interface ImageFeatures {
  imageName: string;
  imageB64: string;
  dominantColors: string[];
  style: string; // "business", "nature", "tech", "abstract", etc.
  mood: string; // "professional", "casual", "energetic", "calm", etc.
  elements: string[]; // 主要な要素
  commonTheme?: string; // グループの共通テーマ（後で設定）
}

// 画像グループ
export interface ImageGroup {
  groupId: number;
  images: ImageFeatures[];
  commonStyle: string;
  commonMood: string;
  commonElements: string[];
  bestForTopics: string[]; // このグループが適している話題
}

// 単一画像の特徴を分析
export async function analyzeImageFeatures(imageName: string, imageB64: string): Promise<ImageFeatures> {
  try {
    const prompt = `この画像を分析して、以下の特徴を日本語で簡潔に教えてください。

以下のJSON形式で回答してください：
{
  "dominantColors": ["主要な色1", "主要な色2"],
  "style": "ビジネス|自然|テクノロジー|アブストラクト|イラスト|写真|その他",
  "mood": "プロフェッショナル|カジュアル|エネルギッシュ|落ち着いた|温かい|クール",
  "elements": ["主要な要素1", "主要な要素2", "主要な要素3"]
}

例：
{
  "dominantColors": ["青", "白"],
  "style": "ビジネス",
  "mood": "プロフェッショナル",
  "elements": ["オフィス", "会議", "グラフ"]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: {
        parts: [
          {
            inlineData: {
              data: imageB64.split(',')[1],
              mimeType: 'image/jpeg',
            },
          },
          {
            text: prompt,
          },
        ],
      },
    });

    const text = response.text.trim();
    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const features = JSON.parse(jsonMatch[0]);
      return {
        imageName,
        imageB64,
        ...features
      };
    }

    // フォールバック
    return {
      imageName,
      imageB64,
      dominantColors: ["不明"],
      style: "その他",
      mood: "カジュアル",
      elements: ["一般的な画像"]
    };

  } catch (error) {
    console.error("画像分析エラー:", error);
    return {
      imageName,
      imageB64,
      dominantColors: ["不明"],
      style: "その他",
      mood: "カジュアル",
      elements: ["一般的な画像"]
    };
  }
}

// 複数画像をグループ化
export function groupImagesByStyle(images: ImageFeatures[]): ImageGroup[] {
  const groups: ImageGroup[] = [];
  
  // スタイルとムードの組み合わせでグループ化
  const groupMap = new Map<string, ImageFeatures[]>();
  
  images.forEach(img => {
    const key = `${img.style}_${img.mood}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key)!.push(img);
  });

  // 各グループの共通要素を抽出
  let groupId = 0;
  groupMap.forEach((groupImages, key) => {
    const [style, mood] = key.split('_');
    
    // 共通要素を見つける
    const allElements = groupImages.flatMap(img => img.elements);
    const elementCounts = new Map<string, number>();
    allElements.forEach(elem => {
      elementCounts.set(elem, (elementCounts.get(elem) || 0) + 1);
    });
    
    // 2回以上出現する要素を共通要素とする
    const commonElements = Array.from(elementCounts.entries())
      .filter(([_, count]) => count >= Math.ceil(groupImages.length / 2))
      .map(([elem, _]) => elem);

    // このグループが適している話題を推定
    const bestForTopics = determineBestTopics(style, mood, commonElements);

    groups.push({
      groupId: groupId++,
      images: groupImages,
      commonStyle: style,
      commonMood: mood,
      commonElements: commonElements.length > 0 ? commonElements : groupImages[0].elements.slice(0, 2),
      bestForTopics
    });
  });

  // グループが1つしかない場合、画像を個別グループとして扱う
  if (groups.length === 1 && images.length > 1) {
    return images.map((img, idx) => ({
      groupId: idx,
      images: [img],
      commonStyle: img.style,
      commonMood: img.mood,
      commonElements: img.elements,
      bestForTopics: determineBestTopics(img.style, img.mood, img.elements)
    }));
  }

  return groups;
}

// スタイルとムードから適した話題を推定
function determineBestTopics(style: string, mood: string, elements: string[]): string[] {
  const topics: string[] = [];

  // スタイルベースの話題
  const styleTopics: Record<string, string[]> = {
    'ビジネス': ['導入方法', '活用事例', 'ROI', '業務効率化', '戦略'],
    '自然': ['環境', '持続可能性', 'リラックス', '健康', 'ライフスタイル'],
    'テクノロジー': ['技術仕様', 'AI', 'デジタル', '革新', 'ツール'],
    'アブストラクト': ['概念', '理論', 'アイデア', 'クリエイティブ', 'デザイン'],
    'イラスト': ['説明', 'ガイド', 'チュートリアル', '手順', '比較'],
    '写真': ['実例', '現実', '具体例', 'ケーススタディ', '実績']
  };

  // ムードベースの話題
  const moodTopics: Record<string, string[]> = {
    'プロフェッショナル': ['企業向け', 'ビジネス', '専門的', '実績', '成果'],
    'カジュアル': ['入門', '基礎', '初心者向け', '簡単', '楽しい'],
    'エネルギッシュ': ['成長', '革新', 'スピード', '効率', '成功'],
    '落ち着いた': ['詳細', '分析', '検討', '比較', '選択'],
    '温かい': ['サポート', 'ヘルプ', 'ガイド', 'コミュニティ', '共有'],
    'クール': ['最新', 'トレンド', '先進的', 'スタイリッシュ', 'モダン']
  };

  if (styleTopics[style]) {
    topics.push(...styleTopics[style]);
  }
  if (moodTopics[mood]) {
    topics.push(...moodTopics[mood]);
  }

  // 要素から追加の話題を推定
  elements.forEach(elem => {
    if (elem.includes('グラフ') || elem.includes('チャート')) {
      topics.push('データ', '分析', '統計');
    }
    if (elem.includes('人') || elem.includes('チーム')) {
      topics.push('組織', 'コラボレーション', '人材');
    }
    if (elem.includes('コンピュータ') || elem.includes('スマホ')) {
      topics.push('デジタル', 'IT', 'ソフトウェア');
    }
  });

  // 重複を削除
  return [...new Set(topics)];
}

// H2の内容に最適な画像グループを選択
export async function selectBestImageForH2(
  h2Text: string,
  paragraphText: string,
  imageGroups: ImageGroup[]
): Promise<{ selectedGroup: ImageGroup; selectedImage: ImageFeatures; matchReason: string }> {
  
  // H2とパラグラフからキーワードを抽出
  const prompt = `以下の見出しと文章から、主要なトピックやキーワードを5つ抽出してください。

見出し: ${h2Text}
文章: ${paragraphText}

回答は以下の形式で：
キーワード1, キーワード2, キーワード3, キーワード4, キーワード5`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
    });
    
    const keywords = response.text.trim().split(',').map(k => k.trim());
    
    // 各グループとのマッチ度を計算
    let bestGroup = imageGroups[0];
    let bestScore = 0;
    let bestReason = "デフォルト選択";

    for (const group of imageGroups) {
      let score = 0;
      const reasons: string[] = [];

      // キーワードとbestForTopicsのマッチング
      keywords.forEach(keyword => {
        group.bestForTopics.forEach(topic => {
          if (keyword.includes(topic) || topic.includes(keyword)) {
            score += 2;
            reasons.push(`「${keyword}」が「${topic}」にマッチ`);
          }
        });
      });

      // H2テキストと共通要素のマッチング
      group.commonElements.forEach(element => {
        if (h2Text.includes(element) || paragraphText.includes(element)) {
          score += 1;
          reasons.push(`要素「${element}」が含まれる`);
        }
      });

      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
        bestReason = reasons.length > 0 ? reasons.join('、') : `${group.commonStyle}スタイルが適合`;
      }
    }

    // グループから画像を選択（ラウンドロビン or ランダム）
    const selectedImage = bestGroup.images[Math.floor(Math.random() * bestGroup.images.length)];

    return {
      selectedGroup: bestGroup,
      selectedImage,
      matchReason: bestReason
    };

  } catch (error) {
    console.error("H2マッチングエラー:", error);
    // フォールバック：最初のグループの最初の画像
    return {
      selectedGroup: imageGroups[0],
      selectedImage: imageGroups[0].images[0],
      matchReason: "フォールバック選択"
    };
  }
}

// プロンプトに共通スタイル要素を強調追加
export function enhancePromptWithGroupStyle(
  basePrompt: string,
  group: ImageGroup,
  matchReason: string
): string {
  const styleEmphasis = `

# 画像グループの共通スタイル指示
この画像は「${group.commonStyle}」スタイルで「${group.commonMood}」な雰囲気を持つグループから選ばれました。
${matchReason ? `選択理由: ${matchReason}` : ''}

## 必ず守るべきスタイル要素：
- スタイル: ${group.commonStyle}
- ムード: ${group.commonMood}
- 共通要素: ${group.commonElements.join('、')}

これらの要素を活かしつつ、ベース画像の画風を参考にして、統一感のあるイラストを生成してください。`;

  return basePrompt + styleEmphasis;
}