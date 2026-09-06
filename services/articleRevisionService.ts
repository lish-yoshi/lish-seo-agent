// 記事修正サービス（Gemini 2.5 Pro使用）
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Issue } from "./finalProofreadingAgents/types";
import {
  parseArticleElements,
  insertSourcesAtElements,
} from "./finalProofreadingAgents/utils/articleParser";
import { slackNotifier } from "./slackNotificationService";
import { curriculumDataService } from "./curriculumDataService";
// latestAIModelsは汎用化のため削除

// Gemini APIクライアントの初期化
const genAI = new GoogleGenerativeAI(
  import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ""
);

// 環境変数から自社URLパターンを取得（出典優先順位に使用）
import { getBrand } from "./clientContext";

// 出典URL優先順位ルールを動的に生成
function getCitationPriorityRules(): string {
  const { noteUrl: COMPANY_NOTE_URL, mediaUrl: COMPANY_MEDIA_URL } = getBrand();
  if (!COMPANY_NOTE_URL && !COMPANY_MEDIA_URL) {
    // 環境変数が未設定の場合は汎用的なルール
    return `## 出典URL優先順位ルール（厳守）
- 【優先順位】自社一次情報（note等）> 自社メディア記事 > 外部ソース
- 【自社URL】必ずaタグで埋め込み（ベタ貼り禁止）
  - 形式：（出典：<a href="https://..." target="_blank" rel="noopener noreferrer">タイトル</a>）
- 【外部URL】出典として使う場合はaタグ、内部リンクとしてのベタ貼りは別途保護`;
  }

  const noteRule = COMPANY_NOTE_URL
    ? `${COMPANY_NOTE_URL} の事例・インタビュー`
    : "自社note";
  const mediaRule = COMPANY_MEDIA_URL
    ? `${COMPANY_MEDIA_URL} の記事`
    : "自社メディア記事";

  return `## 出典URL優先順位ルール（厳守）
- 【優先順位】${noteRule} > ${mediaRule}
- 【note URL】必ずaタグで埋め込み（ベタ貼り禁止）
  - 形式：（出典：<a href="https://..." target="_blank" rel="noopener noreferrer">タイトル</a>）
- 【media URL】出典として使う場合はaタグ、内部リンクとしてのベタ貼りは別途保護
- 【フォールバック】noteがない場合のみ自社メディアを使用
- 【両方ある場合】必ずnoteを優先的に採用`;
}

// 内部リンク保護ルールを動的に生成
function getInternalLinkProtectionRule(): string {
  const { noteUrl: COMPANY_NOTE_URL, mediaUrl: COMPANY_MEDIA_URL } = getBrand();
  if (COMPANY_MEDIA_URL) {
    return `【内部リンク保護】見出し間に配置されたURLベタ貼り（https://${COMPANY_MEDIA_URL}/...）は絶対に削除・変更しない`;
  }
  return `【内部リンク保護】見出し間に配置されたURLベタ貼り（自社サイトへのリンク）は絶対に削除・変更しない`;
}

// 出典URL優先順位の修正ルールを動的に生成
function getCitationPriorityRevisionRule(): string {
  const { noteUrl: COMPANY_NOTE_URL, mediaUrl: COMPANY_MEDIA_URL } = getBrand();
  if (!COMPANY_NOTE_URL && !COMPANY_MEDIA_URL) {
    return `【出典URL優先順位】自社一次情報（note等）があれば、自社メディアより優先して採用する（URLは必ずaタグで埋め込み、ベタ貼り禁止）`;
  }
  const noteRef = COMPANY_NOTE_URL || "自社note";
  const mediaRef = COMPANY_MEDIA_URL || "自社メディア";
  return `【出典URL優先順位】${noteRef} の事例・インタビューがあれば、${mediaRef} より優先して採用する（note URLは必ずaタグで埋め込み、ベタ貼り禁止）`;
}

// リード文の「」前後を改行する後処理関数
// 参考記事のリード文は「」で無駄に改行されていないため、
// この処理を無効化し、元のテキストをそのまま返す
function formatLeadQuotes(text: string): string {
  return text;
}

// HTML形式のテキストで「」を改行処理（現在は未使用）
function formatHtmlQuotes(text: string): string {
  // 無効化：参考記事準拠
  return text;
}

// プレーンテキストで「」を改行処理（現在は未使用）
function formatPlainQuotes(text: string): string {
  // 無効化：参考記事準拠
  return text;
}

// 執筆ルール（三段セルフリファイン強化版）
const WRITING_STYLE = `
meta:
  name: "記事修正サービス：三段セルフリファイン + 人間らしさ強化版"
  version: "2025-09-10"
  language: "ja"
  audience: "法人の決裁者・推進担当・現場マネジャー"
  output_visibility: "final-only"  # 中間物は一切出力しない

# あなたの立ち位置と執筆スタイル

## 基本設定
- あなたはSEOコンテンツの専門ライター
- 読者は法人の決裁者・推進担当・現場マネジャー
- 修正時も全体の流れと自然さを最優先する

## 文体とトーン
- です・ます調で丁寧に、明快・具体的に
- 専門用語は適切に使いつつ、初心者にも理解できるよう定義してから使用
- 断定的な表現は根拠とセットで使用
- 読者の悩みに寄り添い、解決策を提示する姿勢
- 禁止事項：抽象的な一般論の羅列、婉曲表現の多用、権威付けだけで中身が薄い内容
- variation: "語尾・書き出しを意図的に分散（同型3連続を禁止）"

## 文章・段落構成ルール
### 文章ルール
- 一文一義（1つの文に1つのアイデア）
- 文長：平均40-60字（最大80字）
- 主語と述語の距離：2-3句以内
- 語尾・書き出しの変化（同型3連続を禁止）

### 段落ルール
- 1段落2-4文
- 段落開始：要点一句（結論/ベネフィット）
- 段落終了：次段落へのブリッジ一句
- 話題転換時は改行、3句点以上の連続は避ける
- 列挙が3点以上の場合は箇条書き化

### HTML構造ルール（修正時厳守）
- HTMLタグ構造は絶対に保持する
- <p>タグ：1段落は必ず1つの<p>タグで囲む
- 段落の区切り：</p>と<p>の間に改行を入れる
- 見出し後：必ず<p>タグから開始
- 改行処理：<p>タグ内での<br>は使用しない（段落分けは<p>タグで）
- リスト：3項目以上は<ul>または<ol>タグを使用
- 出典：段落末尾に（出典：<a href="URL">タイトル</a>）形式

## リード文の構成（200-350字）
1. 読者の悩みを代弁
2. 解決策の提示（結論）
3. 読むベネフィットの明示
4. 読み進めを促す一文
- CTAショートコード：[リード文下]をリード文末に必須配置
- 【重要】リード文は一文ごとに<p>タグで囲む（複数文を1つの<p>にまとめない）

## 強調ルール
- HTMLタグ：<strong>タグで重要部分を強調
- 強調対象：各見出しの結論文、数値・条件・判断基準
- 頻度：1見出しあたり1-3箇所
- 制限：同一段落文字数の10%以内
- 公式定義/ガイドラインは短文引用＋近傍に出典リンク
- 【重要】見出しタグ内での<strong>使用禁止：
  - <h2>〜</h2>タグの中では<strong>タグを削除する
  - <h3>〜</h3>タグの中では<strong>タグを削除する
  - 見出しタグ以降の本文（<p>タグ内など）では<strong>タグは維持する

## 出典・引用ルール
- 原則dofollow（信頼できるサイトへのリンク）
- 一次情報を優先（公式/省庁/学協会/大手メディア/自社資料）
- 本文近傍に出典を明示（タイトル/組織名の自然文アンカー）
- HTML形式：（出典：<a href="URL" target="_blank" rel="noopener noreferrer">タイトル</a>）
- 内部リンク：用語集や関連ページへ自然な導線を挿入
- アンカーテキスト：クリック後の内容を正確に表す自然文

## 研究・リサーチポリシー
### 優先順位（必ず守る）
1. 省庁・官公庁・官報・法令（.go.jp）
2. 学協会・査読論文・公的統計
3. 上場企業IR/有価証券報告書・公式発表
4. 大手メディア（日経新聞、東洋経済、ITmedia等）※一次情報の裏取り用途
5. 自社一次資料（実績データ）

### ルール
- 年・数値・条件を本文に明記（例：2024年10月時点、分母1000社中、単位：円）
- Web参照とファイル参照を併用し、最新性と正確性を担保
- 統計/白書は最新版優先（なければ最新版-1版まで）
- 法令は施行日・改正日を明記
- 企業数値は出典の期（年度/四半期）を明記
- 出典間で不一致があれば一次資料（法令/公式）を優先し、前提を注記

### 禁止ソース
- 匿名ブログ/出典不明の二次まとめ
- 出典と年の明記がないグラフ/画像

## AIらしさ回避ルール
### 症状の検出
- 同一語尾/書き出しの連続
- テンプレPREPの連打
- 不自然な高踏語（例：示唆されます、勘案できます、〜することが可能です）

### 対策
- 語尾ローテーション表を内的に適用して変化をつける
- 各段落に新情報or角度差分を必ず1つ入れる
- NGワード自動置換：
  - 「示唆されます」→「〜と言えます」
  - 「勘案できます」→「考慮できます」
  - 「〜することが可能です」→「〜できます」
  - 「〜することができる」→「〜できる」
  - 「〜といったような」→「〜など」
  - 「まず最初に」→「まず」

## 自社実績データの活用（オプション）
### 実績データの記載ルール
- 数値は前提・条件・出所とセットで提示（単位・分母・時点を明記）
- Before/After/Deltaを分離して明確に記載
- 期間・前提（例：3営業日・毎日・1本あたりなど）があれば併記
- 主要数値は<strong>太字</strong>で強調（例：<strong>24時間→10秒</strong>）
- 出典は本文近傍にdofollowで明記（タイトル）

### サービスの特徴
- カスタマイズ研修（企業ごとに最適化）
- ハンズオン形式（実践重視）
- 継続的サポート（研修後のフォローアップ）
- 最新AI技術の活用（GPT-4、Claude、Gemini等）

## H2/H3見出しの要件
### H2見出し（必須要件）
- 冒頭2文で見出しテーマの答えを明示（結論先出し）
- 定義/ポイント、手順またはチェックリスト、注意点/落とし穴を含む
- 数値/条件/手順/事例のいずれかを必ず含む

### H3見出し
- H2の補足・分解（事例/比較表/計算例など）
- H3の事例を1つ以上（1-3文、少なくとも1つの定量値を含む）

## 画像・表の扱い
- 理解促進に資する場合に使用（図解/比較表/簡易表）

## 表・箇条書き・リストの活用ルール（重要）
### 表の活用場面
- 3項目以上の比較・対照時
- サービス/プラン/料金の一覧表示
- Before/Afterの対比
- 手順やフローの整理
- HTMLの<table>タグで実装

### 箇条書きの活用場面
- 3点以上の要素を列挙する時は必ず箇条書き化
- 名詞始まり/文末表記の統一
- <ul>タグまたは<ol>タグを使用
- 各項目は簡潔に（1-2行以内）

### 番号付きリストの活用場面
- 手順・ステップを示す時
- 優先順位がある項目
- 時系列の流れを示す時
- <ol>タグで実装

### リスト使用時の注意点
- 前文で「以下の○点」など項目数を明示
- 各項目の粒度を揃える
- 項目間の論理的な関係性を保つ
- リスト後には必ず総括文を配置

## 数値・用語の扱い
- 専門用語は初出で簡潔に定義、略語は展開後に使用
- 数値は前提・条件・出所とセットで提示（単位・分母・時点を明記）
- 固有名詞は初出で公式表記（必要なら英名/略称併記）
- 率・増減は分母/基準年が本文に明記

## 内部リンク保護ルール（厳守）
- 【絶対禁止】見出し間に配置されたURLベタ貼り（https://...）の削除
- 【絶対禁止】URLベタ貼りの形式変更（aタグへの変換など）
- 【保持必須】段落終了後、見出し前に配置されたURLベタ貼りは完全保持
- 理由：これらは記事執筆時にwritingAgentV3が自動挿入した関連記事へのリンク
- 例外：新しい内部リンクを追加してはいけない（既存のもののみ保持）

## 出典URL優先順位ルール（厳守）
- 【優先順位】自社一次情報（note等）> 自社メディア記事 > 外部ソース
- 【自社URL】必ずaタグで埋め込み（ベタ貼り禁止）
  - 形式：（出典：<a href="https://..." target="_blank" rel="noopener noreferrer">タイトル</a>）
- 【外部URL】出典として使う場合はaタグ、内部リンクとしてのベタ貼りは別途保護
- 【フォールバック】noteがない場合のみ自社メディアを使用
- 【両方ある場合】必ず自社一次情報を優先的に採用

## 内部リンク戦略
- 関連する用語集ページへのリンク
- 関連記事への内部リンク（読者の次のアクションを促す）

## 論理展開の多様性
logic_methods:
  preferred: ["SDS", "PREP（連打禁止）", "Q→A→Why→How（用途で使い分け）"]
  
## micro_templates（文章パターン集）
micro_templates:
  conclusion_snippet: "結論：<strong>〜</strong>。"
  decision_snippet: "〜なら、〜を選ぶべきです。理由は〜。"
  steps_intro: "最短手順は次の3つです。"
  caution_snippet: "よくある失敗は〜。避けるには〜。"
  action_snippet: "今すぐ〜を試して、〜を確認しましょう。"

## samples（具体的な文章例）
samples:
  sample_paragraph: |
    結論：<strong>業務効率化の成否は"課題に最適化した設計"が最短で成果に直結します</strong>。
    部門ごとに優先課題が異なるためです。現場担当は実務フローの改善を重視し、管理部門はコスト削減を優先します。
  sample_criteria: |
    - <strong>費用対効果</strong>：投資額あたりの削減コスト/時間
    - <strong>業務適合度</strong>：自社フローへの適用可否
    - <strong>拡張性</strong>：他業務への展開可能性

## quality_gates（品質ゲート）
quality_gates:
  seo:
    - "見出しは検索意図に合致（主要キーワードをH2前半に）"
    - "冒頭500字に要点・数値・固有名詞を配置"
  readability:
    - "箇条書きは3〜7点を目安"
    - "1段落は2–4文"
    - "冗長な副詞の連発を避ける"

## self_checklist（詳細チェックリスト）
self_checklist:
  factuality:
    - "[ ] 出典は近傍にdofollowでタイトルを記載"
    - "[ ] 率・増減は分母/基準年が本文に明記されている"
    - "[ ] ドキュメント内で数値・名称の矛盾がない"
  structure:
    - "[ ] 各H2で結論先出し（冒頭2文）"
    - "[ ] 各H2に数値/条件/手順/事例のいずれかを含む"
    - "[ ] 段落は2–4文で1論点"
  readability:
    - "[ ] 一文≤80字/平均40–60字"
    - "[ ] 主述ねじれ無し・語尾/書き出し同型3連続回避"
  emphasis_links:
    - "[ ] 各見出しの<strong>は1–3箇所、本文全体で10%未満"

## per_heading_requirements（見出し単位の要件）
per_heading_requirements:
  - "各H2: 結論→根拠（数値/条件/手順のいずれか）→近傍出典の順で成立"
  - "各H2: H3の事例を1つ以上。1〜3文、少なくとも1つの定量値を含む"
  - "各H2: 固有名詞の初出は公式表記。略称のみの使用は禁止"

## 禁止事項
- 自己言及（「この記事では〜を解説します」等のメタ文言）
- 作業手順の列挙
- 同型文末3連続
- 抽象的な一般論の羅列
- 婉曲表現の多用
- 出典不明の数値や主張
- HTMLタグの削除や構造変更（<p>タグを削除して改行のみにする等）
- 段落内での不適切な改行（\nを<p>タグ内に入れる等）

## 三段セルフリファイン（修正時に適用）
self_refine:
  enabled: true
  visibility:
    intermediate_outputs: "do-not-output"  # 下書き/診断は表示しない
  phases:
    - name: "analysis"
      role: "プロのアナリスト"
      tasks:
        - "修正要件の確認：最終校閲エージェントからの指摘事項を全て把握"
        - "entity_numeric_extraction: 固有名詞／日付／数値表現を抽出"
        - "contradiction_scan: セクション間での矛盾を検出"
        - "語尾/書き出しパターンの確認"
    - name: "draft_revision"
      role: "天才SEOライター"
      goal: "修正要件を満たしつつ、人間らしい自然な文章に改善"
      actions:
        - "最終校閲の指摘箇所を確実に修正"
        - "micro_templatesを活用して文章パターンを多様化"
        - "語尾ローテーション表を内的に適用"
        - "各段落に新情報or角度差分を必ず1つ追加"
    - name: "final_polish"
      role: "プロの編集者"
      actions:
        - "修正箇所と周辺文脈の整合性確認"
        - "段落開始：要点一句、段落終了：次段落へのブリッジ一句"
        - "self_checklistの全項目確認"
        - "quality_gatesの通過確認"
  stop_condition: "修正要件を満たし、かつ人間らしさスコア80%以上"`;

// Google Drive実績データを取得する関数
async function fetchCompanyData(): Promise<any> {
  try {
    const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;

    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
    const response = await fetch(`${backendUrl}/api/company-data`, {
      headers: {
        ...(apiKey && { "x-api-key": apiKey }),
      },
    });

    if (!response.ok) {
      console.warn("Google Drive データ取得失敗、フォールバック使用");
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("Google Drive データ取得エラー:", error);
    return null;
  }
}

// 自然言語での修正指示を処理する関数
export async function reviseArticle(
  articleContent: string,
  instruction: string
): Promise<{ success: boolean; revised?: string; error?: string }> {
  try {
    console.log("📝 記事修正処理を開始");
    console.log("  - 記事の長さ:", articleContent.length, "文字");
    console.log("  - 修正指示:", instruction);

    // Google Drive実績データを取得（タイムアウト付き）
    let companyData = null;
    try {
      console.log("📂 実績データ取得を試行中...");
      // タイムアウトPromiseを作成（5秒）
      const timeoutPromise = new Promise<any>((_, reject) => {
        setTimeout(() => reject(new Error("実績データ取得タイムアウト")), 5000);
      });

      // fetchCompanyDataとタイムアウトをraceさせる
      companyData = await Promise.race([fetchCompanyData(), timeoutPromise]);

      if (companyData) {
        console.log("✅ 実績データ取得成功");
      }
    } catch (error) {
      console.warn(
        "⚠️ Google Drive データ取得失敗:",
        error instanceof Error ? error.message : "Unknown error"
      );
      companyData = null; // フォールバック
    }

    // カリキュラムデータを取得
    const curriculumData = curriculumDataService.getAllCurriculumData();
    const curriculumInfo = curriculumData
      .map((item) => {
        const modulesList = item.modules
          .map((m) => `    - ${m.title}: ${m.description}`)
          .join("\n");
        return `  【${item.title}】\n  ${item.description}\n  モジュール:\n${modulesList}`;
      })
      .join("\n\n");

    // モデル設定（既存の修正関数と同じ設定）
    const modelConfig: any = {
      model: "gemini-2.5-pro",
      generationConfig: {
        temperature: 0.3, // 低めの温度で正確性重視
        maxOutputTokens: 16384, // 長文対応
      },
    };

    const model = genAI.getGenerativeModel(modelConfig);

    const prompt = `あなたはSEO記事修正の専門家です。以下の記事を、ユーザーの修正指示に従って修正してください。

## 修正指示
${instruction}

## 修正時の重要ルール

### 内部リンク保護ルール（最優先）
- 【絶対禁止】見出し間に配置されたURLベタ貼り（https://...）の削除
- 【絶対禁止】URLベタ貼りの形式変更（aタグへの変換など）
- 【保持必須】段落終了後、見出し前に配置されたURLベタ貼りは完全保持
- 理由：これらは記事執筆時にwritingAgentV3が自動挿入した関連記事へのリンク
- 例外：新しい内部リンクを追加してはいけない（既存のもののみ保持）

### 修正指示の解釈
1. **該当箇所の特定**
   - 「〜の部分を」という指示から、修正対象を正確に特定
   - 文脈から判断して最も適切な箇所を選択
   - 複数該当する場合はすべて修正

2. **修正範囲の判断**
   - 指示された箇所のみを修正（必要最小限）
   - ただし、整合性のため関連箇所も調整が必要な場合は同時修正
   - 例：「8選」→「7選」の場合、H3の数も調整

3. **文体・構造の維持**
   - 元記事の文体（です・ます調）を維持
   - HTMLタグ構造をそのまま保持
   - 段落構成や改行位置を変更しない

### 出力形式
- 修正後の記事全文をそのまま出力
- 説明や注釈は一切不要
- HTMLタグはすべて保持

${
  companyData
    ? `
## 実績データ（参考用）
${JSON.stringify(companyData.segments?.slice(0, 5), null, 2)}
`
    : ""
}

## カリキュラム情報
${curriculumInfo}

## 修正ガイドライン
- 記事の品質と正確性を最優先に修正
- HTMLタグ構造を維持
- 出典情報を適切に追加

## 元記事
${articleContent}

## 修正実行
上記の修正指示に従って、記事を修正してください。修正後の記事全文のみを出力してください。`;

    // 処理時間の計測開始
    const startTime = Date.now();
    console.log("⏱️ Gemini API呼び出し開始...");

    const result = await model.generateContent(prompt);

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ API応答受信（処理時間: ${elapsedTime}秒）`);

    const revisedContent = result.response.text();

    if (!revisedContent) {
      throw new Error("修正結果が生成されませんでした");
    }

    // リード文の「」前後の改行処理
    const formattedContent = formatLeadQuotes(revisedContent);

    // <b>タグを<strong>タグに変換
    const tagConvertedContent = formattedContent
      .replace(/<b>/gi, "<strong>")
      .replace(/<\/b>/gi, "</strong>");

    console.log("✅ 記事修正完了");
    console.log("  - 修正後の長さ:", tagConvertedContent.length, "文字");

    return {
      success: true,
      revised: tagConvertedContent,
    };
  } catch (error) {
    console.error("❌ 記事修正エラー:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "記事修正中にエラーが発生しました",
    };
  }
}

// 単一の問題を修正
export async function reviseSpecificIssue(params: {
  originalArticle: string;
  issue: Issue;
}): Promise<string> {
  const { originalArticle, issue } = params;

  // デバッグ: 受け取ったデータを確認
  console.log("🔍 修正サービス: 受信データ確認");
  console.log("  - 記事の長さ:", originalArticle ? originalArticle.length : 0);
  console.log(
    "  - 問題のoriginal:",
    issue.original ? `あり(${issue.original.length}文字)` : "なし"
  );
  console.log("  - 問題のsuggestion:", issue.suggestion ? "あり" : "なし");

  if (!originalArticle || originalArticle.length === 0) {
    console.error("❌ 元記事が空です！");
    throw new Error("修正対象の記事が提供されていません");
  }

  // Google Driveから実績データを取得（エラーハンドリング付き）
  let companyDataContext = "";
  try {
    console.log("📂 実績データ取得を試行中...");
    // タイムアウトPromiseを作成（5秒）
    const timeoutPromise = new Promise<any>((_, reject) => {
      setTimeout(() => reject(new Error("実績データ取得タイムアウト")), 5000);
    });

    // fetchCompanyDataとタイムアウトをraceさせる
    const companyData = await Promise.race([
      fetchCompanyData(),
      timeoutPromise,
    ]);

    console.log("✅ 実績データ取得成功");

    if (companyData && companyData.segments) {
      // 関連する実績データを抽出
      const relevantSegments = companyData.segments
        .filter((seg: any) => seg.company || seg.result)
        .slice(0, 5); // 最大5件まで

      if (relevantSegments.length > 0) {
        companyDataContext = `【利用可能な自社実績データ（Google Driveより）】
${relevantSegments
  .map(
    (seg: any) =>
      `- ${seg.company || "自社"}：${
        seg.result || seg.text?.substring(0, 100)
      }`
  )
  .join("\n")}`;
      }
    }
  } catch (error) {
    console.warn(
      "⚠️ 実績データ取得をスキップ:",
      error instanceof Error ? error.message : "Unknown error"
    );
    // 実績データなしで続行
    companyDataContext = "";
  }

  const modelConfig: any = {
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.3, // 低めの温度で正確性重視
      maxOutputTokens: 16384, // 長文対応（8192→16384）
    },
    // Grounding機能を有効化（最新情報を取得）
    tools: [
      {
        googleSearch: {}, // Gemini 2.5 Pro対応の新形式
      },
    ],
  };

  const model = genAI.getGenerativeModel(modelConfig);

  // actionTypeによってプロンプトを調整
  const actionType = (issue as any).actionType || "add-source";
  const cautionNote = (issue as any).cautionNote;

  let specificInstruction = "";
  if (actionType === "rephrase") {
    specificInstruction = `
【重要：出典なし箇所の処理】
この問題は信頼できる出典が見つからなかった箇所です。
元の表現: "${cautionNote || issue.original}"

以下の方針で修正してください：
1. 具体的な数値や断定的表現を削除
2. より一般的・控えめな表現に言い換え
3. 修正箇所の直後に以下のHTMLコメントを追加：
   <!-- 要確認：${cautionNote || issue.original} -->

例：
- 「売上200%増」→「急成長している」<!-- 要確認：売上200%増 -->
- 「業界No.1」→「業界トップクラス」<!-- 要確認：業界No.1 -->
- 「シェア50%」→「高いシェアを獲得」<!-- 要確認：シェア50% -->
`;
  }

  const prompt = `
${WRITING_STYLE}

${companyDataContext}

【検出された問題】
エージェント: ${issue.agentName}
問題の種類: ${issue.type}
重要度: ${issue.severity}
場所: ${issue.location || "不明"}
説明: ${issue.description}
原文: "${issue.original || "該当箇所を特定してください"}"
修正提案: "${issue.suggestion || "適切に修正してください"}"
処理タイプ: ${actionType}

${specificInstruction}

【元の記事】
${originalArticle}

【修正要件】
1. 【最優先】最終校閲エージェントからの問題を確実に修正する
2. 【内部リンク保護】見出し間に配置されたURLベタ貼り（自社サイトへのリンク）は絶対に削除・変更しない
   - URLベタ貼りの形式変更（aタグへの変換など）は絶対禁止
   - 段落終了後、見出し前に配置されたURLベタ貼りは完全保持
   - 理由：これらは記事執筆時にwritingAgentV3が自動挿入した関連記事へのリンク
3. 【リード文必須】冒頭のリード文（200-350字）を必ず保持する
   - リード文は最初のH2見出しの前に必ず配置
   - リード文が存在しない場合は元の構成から判断して追加
   - リード文の内容：悩みの代弁→解決策→読むベネフィット→読み進め促し
   - 【重要】リード文は一文ごとに<p>タグで囲む（複数文を1つの<p>にまとめない）
4. 【HTML構造厳守】以下の形式を厳密に守る
   - 各段落を必ず<p>タグで囲む（タグを削除しない）
   - 段落間は</p>\n<p>で区切る（\n\nや<br>は使わない）
   - 見出し直後は必ず<p>タグから開始
   - リスト項目は<ul><li>または<ol><li>タグ使用
6. 三段セルフリファインを適用し、人間らしい自然な文章に仕上げる
7. micro_templatesを活用して文章パターンを多様化
8. 語尾ローテーション表を内的に適用（同型3連続禁止）
9. 各段落に新情報or角度差分を必ず1つ追加
10. 段落開始：要点一句、段落終了：次段落へのブリッジ一句
11. SEOライターとしての視点を保つ
12. 自社実績を適切に活用する（Before→After形式）
13. 他の部分との整合性を保つ
14. HTMLタグは適切に維持する
15. 出典が必要な場合はHTML形式で追加する：（出典：<a href="URL" target="_blank" rel="noopener noreferrer">タイトル</a>）
16. AIらしさを徹底回避（NGワード置換、語尾変化、新情報追加）
17. 研究ポリシーの優先順位を守る（省庁→学協会→企業IR→大手メディア→自社資料）
18. logic_methodsを活用（SDS、PREP（連打禁止）、Q→A→Why→How）
19. quality_gatesとself_checklistの全項目を満たす
20. 【内部リンク保護】見出し間に配置されたURLベタ貼り（自社サイトへのリンク）は絶対に削除・変更しない
21. 【出典URL優先順位】自社一次情報（note等）があれば、自社メディアより優先して採用する（URLは必ずaタグで埋め込み、ベタ貼り禁止）

【出力形式】
1. 修正された記事全文をHTMLで出力
2. 必ずリード文（導入文）から始まり、その後にH2見出しが続く構成
3. HTML構造の維持：
   - 各段落は<p>〜</p>タグで囲む
   - 段落間は</p>と<p>で区切る（改行のみは禁止）
   - リストは<ul><li>または<ol><li>タグを使用
   - 見出しタグ<h2><h3>の構造を保持
4. 修正箇所は自然に文章に溶け込ませ、全体の流れを重視

【HTML出力例】
<p>これは最初の段落です。文章が続きます。</p>
<p>これは次の段落です。段落間は適切に区切られています。</p>
<h2>見出し</h2>
<p>見出しの後は必ずpタグから始まります。</p>
<ul>
  <li>リスト項目1</li>
  <li>リスト項目2</li>
</ul>`;

  try {
    console.log("🔍 修正処理開始...");
    console.log("📋 修正対象の問題:");
    console.log(`  - エージェント: ${issue.agentName}`);
    console.log(`  - 問題タイプ: ${issue.type}`);
    console.log(`  - 重要度: ${issue.severity}`);
    console.log(`  - 説明: ${issue.description}`);
    if (issue.location) {
      console.log(`  - 場所: ${issue.location}`);
    }
    if (issue.original) {
      console.log(
        `  - 原文: "${issue.original.substring(0, 100)}${
          issue.original.length > 100 ? "..." : ""
        }"`
      );
    }
    if (issue.suggestion) {
      console.log(`  - 修正提案: "${issue.suggestion}"`);
    }

    // 処理時間の計測開始
    const startTime = Date.now();
    console.log("⏱️ Gemini API呼び出し開始...");

    // シンプルにAPIを呼び出し（執筆エージェントと同じ方式）
    const result = await model.generateContent(prompt);

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ API応答受信（処理時間: ${elapsedTime}秒）`);

    const response = await result.response;
    let revisedArticle = response.text();

    console.log("📝 修正記事の長さ:", revisedArticle.length);

    // デバッグ: 応答の最初の部分を確認
    console.log("📄 応答の冒頭100文字:", revisedArticle.substring(0, 100));

    // 応答が説明文のみでHTMLが含まれていないかチェック
    if (!revisedArticle.includes("<h") && !revisedArticle.includes("<p")) {
      console.error("❌ 応答にHTMLタグが含まれていません！");
      console.log("応答全文:", revisedArticle.substring(0, 500));
    }

    // 不要なマークダウンや説明文を除去
    revisedArticle = revisedArticle.replace(/```html/g, "").replace(/```/g, "");
    revisedArticle = revisedArticle.replace(/^[\s\S]*?<h/m, "<h"); // 最初のHTMLタグまでの説明文を除去

    // 修正が実際に適用されたか確認
    if (!revisedArticle || revisedArticle.length < 100) {
      console.error("⚠️ 修正記事が短すぎます:", revisedArticle);
      throw new Error("修正記事の生成に失敗しました");
    }

    // 🔍 リード文の保持処理（単一修正版）
    // 元記事から最初のH2の位置を検出
    const originalFirstH2Index = originalArticle.search(/<h2[^>]*>/i);
    let originalLeadText = "";

    if (originalFirstH2Index > 0) {
      // 元記事にリード文がある場合
      originalLeadText = originalArticle
        .substring(0, originalFirstH2Index)
        .trim();
      console.log(`📄 元記事のリード文を検出: ${originalLeadText.length}文字`);
    }

    // 修正後の記事から最初のH2の位置を検出
    const revisedFirstH2Index = revisedArticle.search(/<h2[^>]*>/i);

    if (revisedFirstH2Index === 0 || revisedFirstH2Index === -1) {
      // 修正後の記事にリード文がない場合
      console.log("⚠️ 修正後の記事にリード文がありません");

      if (originalLeadText) {
        // 元のリード文を先頭に追加
        console.log("✅ 元のリード文を復元します");
        revisedArticle = originalLeadText + "\n\n" + revisedArticle;
      } else {
        console.log("📝 元記事にもリード文がないため、そのまま処理を続行");
      }
    } else if (revisedFirstH2Index > 0) {
      // 修正後の記事にもリード文がある場合
      const revisedLeadText = revisedArticle
        .substring(0, revisedFirstH2Index)
        .trim();
      console.log(
        `✅ 修正後もリード文が保持されています: ${revisedLeadText.length}文字`
      );
    }

    // 修正箇所の差分を検出（簡易版）
    if (issue.original && revisedArticle.includes(issue.original)) {
      console.warn(
        "⚠️ 原文がまだ残っています。修正が適用されていない可能性があります。"
      );
    } else if (issue.original) {
      console.log("✅ 原文が修正されました");
    }

    // 修正内容のプレビュー（最初の変更箇所）
    const previewLength = 200;
    if (
      originalArticle.substring(0, previewLength) !==
      revisedArticle.substring(0, previewLength)
    ) {
      console.log("📝 修正プレビュー（冒頭の変更）:");
      console.log("  変更前:", originalArticle.substring(0, 100) + "...");
      console.log("  変更後:", revisedArticle.substring(0, 100) + "...");
    }

    // 「」「」の連続を改行する後処理
    const formattedArticle = formatLeadQuotes(revisedArticle);

    // <b>タグを<strong>タグに変換
    const tagConvertedArticle = formattedArticle
      .replace(/<b>/gi, "<strong>")
      .replace(/<\/b>/gi, "</strong>");

    console.log("✅ 修正完了");
    return tagConvertedArticle;
  } catch (error) {
    console.error("❌ 記事修正エラー:", error);
    console.error(
      "エラー詳細:",
      error instanceof Error ? error.message : error
    );

    if (error instanceof Error && error.message.includes("タイムアウト")) {
      throw new Error(
        "修正処理がタイムアウトしました。記事が長すぎる可能性があります。"
      );
    }

    throw new Error(
      `記事の修正に失敗しました: ${
        error instanceof Error ? error.message : "不明なエラー"
      }`
    );
  }
}

// 出典を確実に挿入する後処理関数
export async function insertSourcesAfterRevision(
  article: string,
  sourceInsertions: SourceInsertion[]
): Promise<string> {
  console.log("📌 出典挿入後処理を開始...");
  console.log(`📎 受信した構造化データ: ${sourceInsertions.length}件`);

  // デバッグモード（環境変数またはフラグで制御）
  const DEBUG_MODE =
    process.env.NODE_ENV === "development" ||
    (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
    false;

  if (sourceInsertions.length === 0) {
    console.log("ℹ️ 出典挿入データが見つかりません");
    return article;
  }

  // 1. 見出し内の装飾タグ(<b>, <i>, <strong>等)を自動除去
  console.log("🧹 見出し内の装飾タグを除去中...");
  let modifiedArticle = article
    // すべての装飾タグを一括除去（b, i, strong, em, u, span等）
    .replace(/<h([23])>(.*?)<\/h\1>/gi, (match, level, content) => {
      // ネストされたタグも含めてすべて除去
      const cleanContent = content
        .replace(/<\/?b>/gi, "")
        .replace(/<\/?i>/gi, "")
        .replace(/<\/?strong>/gi, "")
        .replace(/<\/?em>/gi, "")
        .replace(/<\/?u>/gi, "")
        .replace(/<\/?span[^>]*>/gi, "")
        .trim();
      return `<h${level}>${cleanContent}</h${level}>`;
    });

  // 要素番号ベースの挿入を試みる
  const hasElementIndex = sourceInsertions.some(
    (s) => s.elementIndex !== undefined
  );

  if (hasElementIndex) {
    console.log("📋 要素番号ベースで出典を挿入");

    // 記事を要素に分解
    const parsedElements = parseArticleElements(modifiedArticle);
    console.log(`📊 ${parsedElements.length}個の要素に分解`);

    // 要素番号ベースの挿入データを作成
    const elementInsertions = sourceInsertions
      .filter((s) => s.elementIndex !== undefined)
      .map((s) => ({
        elementIndex: s.elementIndex!,
        sourceHtml: `<p>（出典：<a href="${s.url}" target="_blank" rel="noopener noreferrer">${s.title}</a>）</p>`,
      }));

    // 🎯 デバッグログ：要素番号ベースの挿入データ
    console.log("🎯 要素番号ベース挿入データ:");
    elementInsertions.slice(0, 3).forEach((e, idx) => {
      console.log(`  [挿入${idx + 1}]`, {
        elementIndex: e.elementIndex,
        sourceHtml: e.sourceHtml.substring(0, 100) + "...", // 最初の100文字
      });
    });
    if (elementInsertions.length > 3) {
      console.log(`  ... 他${elementInsertions.length - 3}件`);
    }

    // 要素番号ベースで挿入
    modifiedArticle = insertSourcesAtElements(
      modifiedArticle,
      parsedElements,
      elementInsertions
    );
    console.log(`✅ 要素番号ベースで${elementInsertions.length}件の出典を挿入`);
    return modifiedArticle;
  }

  // 従来の処理（要素番号がない場合のフォールバック）
  console.log(`📌 構造化データから出典を挿入: ${sourceInsertions.length}件`);
  let insertedCount = 0;
  const insertionErrors: string[] = []; // エラー情報を収集

  // 挿入位置を事前に計算して配列に格納
  const insertions: Array<{
    position: number;
    html: string;
    heading: string;
    title: string;
  }> = [];

  for (const source of sourceInsertions) {
    // headingプロパティが未設定の場合、h2またはh3から設定
    if (!source.heading) {
      source.heading = source.h3 || source.h2 || "要素不明";
    }

    // 🎯 デバッグログ：従来方式の挿入データ（1件ずつ）
    console.log("🎯 従来方式挿入データ:", {
      heading: source.heading,
      h2: source.h2,
      h3: source.h3,
      title: source.title, // ← ここでtitleの中身を確認
      url: source.url,
    });

    // 統一フォーマットで出典HTMLを作成
    const sourceHtml = `<p>（出典：<a href="${source.url}" target="_blank" rel="noopener noreferrer">${source.title}</a>）</p>`;

    // H3があるかどうかで判定
    let targetHeading: string;
    let searchPattern: RegExp;

    if (source.h3 && source.h3.trim() !== "") {
      // H3がある場合：H3セクションの末尾に挿入
      targetHeading = source.h3;
      console.log(`  🎯 H3セクションを対象: ${targetHeading}`);
      // <strong>タグが含まれている可能性も考慮してパターンを柔軟に
      const escapedH3 = targetHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchPattern = new RegExp(
        `<h3[^>]*>\\s*(?:<strong>)?${escapedH3}(?:</strong>)?\\s*</h3>`,
        "i"
      );
    } else if (source.h2 && source.h2.trim() !== "") {
      // H3がない場合：H2セクションの末尾に挿入
      targetHeading = source.h2;
      console.log(`  🎯 H2セクションを対象: ${targetHeading}`);
      const escapedH2 = targetHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchPattern = new RegExp(
        `<h2[^>]*>\\s*(?:<strong>)?${escapedH2}(?:</strong>)?\\s*</h2>`,
        "i"
      );
    } else if (source.h2 === "" && source.h3 === "") {
      // 空の見出しの場合
      console.log(`  🎯 空の見出しを対象`);
      searchPattern = /<h[23][^>]*>\s*<\/h[23]>/i;
      targetHeading = "（空の見出し）";
    } else {
      const displayHeading = source.heading || "undefined";
      console.warn(`  ⚠️ H2もH3も指定されていません: ${displayHeading}`);
      console.warn(`    - source.h2: "${source.h2 || "undefined"}"`);
      console.warn(`    - source.h3: "${source.h3 || "undefined"}"`);
      console.warn(`    - source.heading: "${source.heading || "undefined"}"`);
      console.warn(`    - source.title: "${source.title || "undefined"}"`);
      insertionErrors.push(
        `見出し情報不足: ${displayHeading} (H2: ${source.h2 || "なし"}, H3: ${
          source.h3 || "なし"
        })`
      );
      continue;
    }

    // 記事内から見出しを探す
    const flexibleMatch = modifiedArticle.match(searchPattern);

    if (!flexibleMatch) {
      const errorMsg = `見出し「${targetHeading}」が見つかりません`;
      console.warn(`  ⚠️ ${errorMsg}`);
      insertionErrors.push(errorMsg);
      continue;
    }

    const actualHeading = flexibleMatch[0];
    const headingIndex = modifiedArticle.indexOf(actualHeading);

    console.log(`  📍 見出しを発見: ${actualHeading}`);

    // セクションの範囲を特定
    let insertPosition: number;
    const startPos = headingIndex + actualHeading.length;

    if (source.h3 && source.h3.trim() !== "") {
      // H3の場合：次のH2またはH3まで（ただし同じH2セクション内）
      const nextH3Pattern = /<h3[^>]*>/g;
      nextH3Pattern.lastIndex = startPos;
      const nextH3Match = nextH3Pattern.exec(modifiedArticle);

      const nextH2Pattern = /<h2[^>]*>/g;
      nextH2Pattern.lastIndex = startPos;
      const nextH2Match = nextH2Pattern.exec(modifiedArticle);

      if (
        nextH3Match &&
        (!nextH2Match || nextH3Match.index < nextH2Match.index)
      ) {
        // 次のH3が次のH2より前にある場合
        insertPosition = nextH3Match.index;
      } else if (nextH2Match) {
        // 次のH2がある場合
        insertPosition = nextH2Match.index;
      } else {
        // どちらもない場合は記事の最後
        insertPosition = modifiedArticle.length;
      }
    } else {
      // H2の場合：最初のH3または次のH2まで
      const nextH3Pattern = /<h3[^>]*>/g;
      nextH3Pattern.lastIndex = startPos;
      const nextH3Match = nextH3Pattern.exec(modifiedArticle);

      const nextH2Pattern = /<h2[^>]*>/g;
      nextH2Pattern.lastIndex = startPos;
      const nextH2Match = nextH2Pattern.exec(modifiedArticle);

      if (
        nextH3Match &&
        (!nextH2Match || nextH3Match.index < nextH2Match.index)
      ) {
        // H3が次のH2より前にある場合、H3の前に挿入
        insertPosition = nextH3Match.index;
      } else if (nextH2Match) {
        // 次のH2がある場合
        insertPosition = nextH2Match.index;
      } else {
        // まとめセクションの前に挿入
        const summaryMatch = modifiedArticle.indexOf("<h2>まとめ");
        if (summaryMatch !== -1 && summaryMatch > headingIndex) {
          insertPosition = summaryMatch;
        } else {
          insertPosition = modifiedArticle.length;
        }
      }
    }

    // 既に出典が挿入されているかチェック（URLで判定）
    const sectionContent = modifiedArticle.substring(
      headingIndex,
      insertPosition
    );
    if (sectionContent.includes(source.url)) {
      console.log(`  ℹ️ 既に出典が存在: ${source.heading}`);
      continue;
    }

    // 挿入情報を配列に追加
    console.log(
      `  📊 挿入位置: ${insertPosition} (見出し位置: ${headingIndex})`
    );
    insertions.push({
      position: insertPosition,
      html: sourceHtml,
      heading: targetHeading,
      title: source.title,
    });
  }

  // 位置の降順でソート（後ろから挿入するため）
  insertions.sort((a, b) => b.position - a.position);

  // 後ろから順に挿入（位置ずれを防ぐため）
  for (const insertion of insertions) {
    modifiedArticle =
      modifiedArticle.substring(0, insertion.position) +
      insertion.html +
      "\n" +
      modifiedArticle.substring(insertion.position);

    insertedCount++;
    console.log(`  ✅ 出典を挿入: ${insertion.heading} → ${insertion.title}`);
  }

  // デバッグ情報の出力
  if (DEBUG_MODE) {
    console.log("🔍 出典挿入デバッグ情報:", {
      input: {
        総件数: sourceInsertions.length,
        データ: sourceInsertions.map((s) => ({
          h2: s.h2,
          h3: s.h3,
          url: s.url,
        })),
      },
      output: {
        成功件数: insertedCount,
        失敗件数: insertionErrors.length,
      },
      errors: insertionErrors,
    });
  }

  // エラーがあった場合は警告を表示
  if (insertionErrors.length > 0) {
    console.warn(`⚠️ 出典挿入で${insertionErrors.length}件のエラーが発生:`);
    insertionErrors.forEach((error, idx) => {
      console.warn(`  [${idx + 1}] ${error}`);
    });
  }

  console.log(
    `📌 構造化データによる出典挿入完了: ${insertedCount}/${sourceInsertions.length}件`
  );

  // 📊 デバッグログ：重複チェック
  const sourceCount = (modifiedArticle.match(/（出典：/g) || []).length;
  console.log(`📊 最終的な出典数: ${sourceCount}個`);
  console.log(`📊 挿入しようとした数: ${sourceInsertions.length}個`);
  if (sourceCount > sourceInsertions.length) {
    console.warn("⚠️ 出典が重複している可能性があります！");
    console.warn(`   差分: ${sourceCount - sourceInsertions.length}個の重複`);
  }

  return modifiedArticle;
}

// 複数の問題を一括修正
export async function reviseBatchIssues(params: {
  originalArticle: string;
  issues: Issue[];
  category: "critical" | "major";
  detailedReport?: string;
  sourceInsertions?: SourceInsertion[]; // 構造化された出典挿入データを追加
  isManualFactCheck?: boolean; // 手動ファクトチェックモード
  keyword?: string; // Slack通知用のキーワード
}): Promise<string> {
  const {
    originalArticle,
    issues,
    category,
    detailedReport,
    isManualFactCheck,
    keyword,
  } = params;

  // デバッグ: 受け取ったデータを確認
  console.log("🔍 一括修正サービス: 受信データ確認");
  console.log("  - 記事の長さ:", originalArticle ? originalArticle.length : 0);
  console.log("  - 問題数:", issues.length);
  console.log("  - カテゴリ:", category);

  // 問題数が多すぎる場合は分割処理を推奨
  if (issues.length > 10) {
    console.warn(
      `⚠️ 修正対象が${issues.length}件と多いため、処理に時間がかかる可能性があります`
    );
    // 最初の10件のみ処理（優先度の高いものから）
    const priorityIssues = issues.slice(0, 10);
    console.log(`📝 最初の10件を処理します`);
    return reviseBatchIssues({
      originalArticle,
      issues: priorityIssues,
      category,
      keyword,
    });
  }

  // Google Driveから実績データを取得（エラーハンドリング付き）
  let companyDataContext = "";
  try {
    console.log("📂 実績データ取得を試行中...");
    // タイムアウトPromiseを作成（5秒）
    const timeoutPromise = new Promise<any>((_, reject) => {
      setTimeout(() => reject(new Error("実績データ取得タイムアウト")), 5000);
    });

    // fetchCompanyDataとタイムアウトをraceさせる
    const companyData = await Promise.race([
      fetchCompanyData(),
      timeoutPromise,
    ]);

    console.log("✅ 実績データ取得成功");

    if (companyData && companyData.segments) {
      // 関連する実績データを抽出
      const relevantSegments = companyData.segments
        .filter((seg: any) => seg.company || seg.result)
        .slice(0, 10); // 一括修正では多めに10件まで

      if (relevantSegments.length > 0) {
        companyDataContext = `
【利用可能な自社実績データ（Google Driveより）】
${relevantSegments
  .map(
    (seg: any) =>
      `- ${seg.company || "自社"}：${
        seg.result || seg.text?.substring(0, 100)
      }`
  )
  .join("\n")}

【動画コンテンツ】
- AI秘書の作り方（詳細な実装手順あり）
- AI活用事例集
`;
      }
    }
  } catch (error) {
    console.warn(
      "⚠️ 実績データ取得をスキップ:",
      error instanceof Error ? error.message : "Unknown error"
    );
    // 実績データなしで続行
    companyDataContext = "";
  }

  const modelConfig: any = {
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 16384, // 長文対応（8192→16384）
    },
    // Grounding機能を有効化（最新情報を取得）
    tools: [
      {
        googleSearch: {}, // Gemini 2.5 Pro対応の新形式
      },
    ],
  };

  const model = genAI.getGenerativeModel(modelConfig);

  // デバッグ: 受け取った問題を確認
  console.log("📋 修正サービスが受け取った問題:");
  issues.forEach((issue, idx) => {
    console.log(`  問題${idx + 1}:`, {
      issue: issue.issue,
      original: (issue as any).original,
      suggestion: issue.suggestion,
      metadata: (issue as any).metadata,
    });
  });

  // 問題リストを整形
  const issuesList = issues
    .map(
      (issue) => `
【問題 ${issues.indexOf(issue) + 1}】
- エージェント: ${(issue as any).metadata?.agentName || "不明"}
- 種類: ${issue.type}
- 深刻度: ${issue.severity}
- 場所: ${issue.location?.sectionHeading || "全体"}
- 説明: ${issue.issue}
- 原文: "${(issue as any).original || "（検出箇所）"}"
- 修正案: "${issue.suggestion || "適切に修正"}"
- 信頼度: ${(issue as any).metadata?.confidence || 50}%`
    )
    .join("\n");

  // 手動ファクトチェックモード用の簡潔なプロンプト
  const manualFactCheckPrompt = `
【タスク】
以下の短い文章の事実誤認のみを修正してください。

【検出された問題】
${issuesList}

【元の文章】
${originalArticle}

【修正ルール】
1. 指摘された誤りのみを修正（例：「Web制作・コンサルティング」→「リスティング広告運用」）
2. 文章の長さや構造は変更しない
3. 新しい情報を追加しない
4. 見出しを追加しない
5. CTAタグ（[cta]など）を追加しない
6. 元の文章形式（HTMLタグがあれば保持）を維持
7. 出典がある場合は（出典：<a href="URL">タイトル</a>）形式で追加

【出力】
修正後の文章のみを出力。説明や前置きは不要。
`;

  const fullRevisionPrompt = `
${WRITING_STYLE}

${companyDataContext}

【検出された問題一覧】（${category === "critical" ? "重大問題" : "主要問題"}）
${issuesList}

【マルチエージェントが検証済みの出典URL】
${
  detailedReport
    ? `※以下のURLのみ使用可能です。新しいURLを作らないでください：
${
  detailedReport.match(/✅ https?:\/\/[^\s<>]+/g)?.join("\n") ||
  "検証済みURLなし"
}`
    : "※出典URLの検証情報がありません。新しいURLを創作せず、必要な場合は「（参考値）」とのみ記載してください。"
}

【元の記事】
${originalArticle}

【修正要件】
1. 【最優先】最終校閲エージェントからのすべての問題を確実に修正する
   - 特に「原文」→「修正案」の指示は必ず反映すること
   - 例：原文「Web制作・コンサルティング」→修正案「リスティング広告運用」の場合
     必ず「リスティング広告運用」に置き換える
   - 信頼度が高い（80%以上）修正案は必ず適用
2. 【リード文必須】冒頭のリード文（200-350字）を必ず保持する
   - リード文は最初のH2見出しの前に必ず配置
   - リード文が存在しない場合は元の構成から判断して追加
   - リード文の内容：悩みの代弁→解決策→読むベネフィット→読み進め促し
   - 【重要】リード文は一文ごとに<p>タグで囲む（複数文を1つの<p>にまとめない）
2.5 【中間見出しCTA必須】[中間見出し]ショートコードを絶対に削除・移動しない
   - [中間見出し]は奇数番（3つ目、5つ目、7つ目...）のH2見出しの直前に配置
   - writingAgentV3が自動挿入したCTA配置指標のため完全保持
   - このマーカーは画像挿入の重要な指標なので絶対に削除しないこと
3. 【HTML構造厳守】以下の形式を厳密に守る
   - 各段落を必ず<p>タグで囲む（タグを削除しない）
   - 段落間は</p>\n<p>で区切る（\n\nや<br>は使わない）
   - 見出し直後は必ず<p>タグから開始
   - リスト項目は<ul><li>または<ol><li>タグ使用
4. 三段セルフリファインを適用し、人間らしい自然な文章に仕上げる
5. micro_templatesを活用して文章パターンを多様化（一括修正でも必須）
6. 語尾ローテーション表を内的に適用（同型3連続禁止）
7. 各段落に新情報or角度差分を必ず1つ追加
8. 段落開始：要点一句、段落終了：次段落へのブリッジ一句
9. SEOライターとしての視点を保つ
10. 自社実績がある場合は活用する（Before→After形式で記載）
11. 記事全体の一貫性を保つ
12. HTMLタグは適切に維持する
13. 【重要】出典について：
    - マルチエージェントが提供した実在のURLのみを使用すること
    - 新しいURLを創作しないこと（404エラーの原因となる）
    - 出典が不明な場合は「（参考値）」とだけ記載し、URLは付けない
14. 修正箇所が多い場合も、自然な文章の流れを優先する
15. AIらしさを徹底回避（NGワード置換、語尾変化、各段落に新情報追加）
16. 研究ポリシーの優先順位厳守（省庁→学協会→企業IR→大手メディア→自社資料）
17. 主語述語の距離を2-3句以内に保つ
18. logic_methodsを活用（SDS、PREP（連打禁止）、Q→A→Why→How）
19. quality_gatesとself_checklistの全項目を満たす
20. per_heading_requirementsを遵守（各H2に結論先出し、数値/条件/手順/事例のいずれか）

【出力形式】
1. 修正された記事全文をHTMLで出力
2. 必ずリード文（導入文）から始まり、その後にH2見出しが続く構成
3. HTML構造の維持：
   - 各段落は<p>〜</p>タグで囲む
   - 段落間は</p>と<p>で区切る（改行のみは禁止）
   - リストは<ul><li>または<ol><li>タグを使用
   - 見出しタグ<h2><h3>の構造を保持
4. すべての修正を適用しつつ、全体の流れと自然さを最優先

【HTML出力例】
<p>これは最初の段落です。文章が続きます。</p>
<p>これは次の段落です。段落間は適切に区切られています。</p>
<h2>見出し</h2>
<p>見出しの後は必ずpタグから始まります。</p>
<ul>
  <li>リスト項目1</li>
  <li>リスト項目2</li>
</ul>`;

  // プロンプトを選択
  const prompt = isManualFactCheck ? manualFactCheckPrompt : fullRevisionPrompt;

  try {
    console.log("🔍 一括修正処理開始...");
    if (isManualFactCheck) {
      console.log("📝 手動ファクトチェックモード（最小限の修正）");
    }
    console.log(
      `📋 修正対象: ${issues.length}件の${
        category === "critical" ? "重大な" : "主要な"
      }問題`
    );
    console.log("========================================");

    // 各問題の詳細をログ出力
    issues.forEach((issue, index) => {
      console.log(`\n【問題 ${index + 1}/${issues.length}】`);
      console.log(`  🤖 エージェント: ${issue.agentName}`);
      console.log(`  📌 タイプ: ${issue.type}`);
      console.log(`  ⚠️ 重要度: ${issue.severity}`);
      console.log(`  📝 説明: ${issue.description}`);
      if (issue.location) {
        console.log(`  📍 場所: ${issue.location}`);
      }
      if (issue.original && issue.original.length > 0) {
        const preview = issue.original.substring(0, 80);
        console.log(
          `  📄 原文: "${preview}${issue.original.length > 80 ? "..." : ""}"`
        );
      }
      if (issue.suggestion) {
        console.log(`  💡 提案: ${issue.suggestion}`);
      }
    });

    console.log("\n========================================");
    console.log("🚀 Gemini APIに一括修正を依頼中...");

    // 処理時間の計測開始
    const startTime = Date.now();
    console.log("⏱️ Gemini API呼び出し開始（一括修正）...");

    // シンプルにAPIを呼び出し（執筆エージェントと同じ方式）
    const result = await model.generateContent(prompt);

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ API応答受信（処理時間: ${elapsedTime}秒）`);

    console.log("✅ 一括修正API応答受信");

    const response = await result.response;
    let revisedArticle = response.text();

    console.log("📝 一括修正記事の長さ:", revisedArticle.length);

    // 不要なマークダウンや説明文を除去
    revisedArticle = revisedArticle.replace(/```html/g, "").replace(/```/g, "");
    revisedArticle = revisedArticle.replace(/^[\s\S]*?<h/m, "<h");

    // 修正が実際に適用されたか確認
    if (!revisedArticle || revisedArticle.length < 100) {
      console.error("⚠️ 一括修正記事が短すぎます:", revisedArticle);
      throw new Error("一括修正記事の生成に失敗しました");
    }

    // 手動ファクトチェックモードではリード文処理をスキップ
    if (!isManualFactCheck) {
      // 🔍 リード文の保持処理
      // 元記事から最初のH2の位置を検出
      const originalFirstH2Index = originalArticle.search(/<h2[^>]*>/i);
      let originalLeadText = "";
      let originalBodyText = originalArticle;

      if (originalFirstH2Index > 0) {
        // 元記事にリード文がある場合
        originalLeadText = originalArticle
          .substring(0, originalFirstH2Index)
          .trim();
        originalBodyText = originalArticle.substring(originalFirstH2Index);
        console.log(
          `📄 元記事のリード文を検出: ${originalLeadText.length}文字`
        );
      }

      // 修正後の記事から最初のH2の位置を検出
      const revisedFirstH2Index = revisedArticle.search(/<h2[^>]*>/i);

      if (revisedFirstH2Index === 0 || revisedFirstH2Index === -1) {
        // 修正後の記事にリード文がない場合
        console.log("⚠️ 修正後の記事にリード文がありません");

        if (originalLeadText) {
          // 元のリード文を先頭に追加
          console.log("✅ 元のリード文を復元します");
          revisedArticle = originalLeadText + "\n\n" + revisedArticle;
        } else {
          console.log("📝 元記事にもリード文がないため、そのまま処理を続行");
        }
      } else if (revisedFirstH2Index > 0) {
        // 修正後の記事にもリード文がある場合
        const revisedLeadText = revisedArticle
          .substring(0, revisedFirstH2Index)
          .trim();
        console.log(
          `✅ 修正後もリード文が保持されています: ${revisedLeadText.length}文字`
        );
      }
    }

    // 🎯 出典挿入処理を追加
    if (params.sourceInsertions && params.sourceInsertions.length > 0) {
      console.log(
        `\n📌 出典挿入処理を開始: ${params.sourceInsertions.length}件`
      );
      revisedArticle = await insertSourcesAfterRevision(
        revisedArticle,
        params.sourceInsertions
      );
      console.log("✅ 出典挿入処理完了");
    } else {
      console.log("📝 出典挿入データなし（スキップ）");
    }

    // 各問題の修正状況を確認
    console.log("\n📊 修正結果の確認:");
    let fixedCount = 0;
    let unfixedCount = 0;

    // Slack通知用のデータを収集
    const revisionErrors: Array<{
      original: string;
      description: string;
      suggestion: string;
      location: string;
    }> = [];

    issues.forEach((issue, index) => {
      if (issue.original && issue.original.length > 0) {
        if (revisedArticle.includes(issue.original)) {
          console.warn(
            `  ❌ 問題${index + 1}: "${
              issue.description
            }" - 原文が残っている可能性`
          );
          unfixedCount++;
          // Slack通知用にエラー情報を収集
          revisionErrors.push({
            original: issue.original,
            description: issue.description,
            suggestion: issue.suggestion || "",
            location: issue.location,
          });
        } else {
          console.log(
            `  ✅ 問題${index + 1}: "${issue.description}" - 修正済み`
          );
          fixedCount++;
        }
      } else {
        console.log(
          `  ⏭️ 問題${index + 1}: "${
            issue.description
          }" - 原文なしのため確認スキップ`
        );
      }
    });

    // 修正エラーがある場合はSlack通知を送信
    if (revisionErrors.length > 0 && keyword) {
      for (const error of revisionErrors) {
        try {
          await slackNotifier.notifyRevisionError({
            keyword: keyword,
            location: error.location,
            originalText: error.original,
            problemDescription: error.description,
            suggestedText: error.suggestion,
            revisedContent: revisedArticle,
          });
        } catch (slackError) {
          console.error("Slack通知の送信に失敗しました:", slackError);
        }
      }
    }

    console.log(
      `\n📈 修正統計: ${fixedCount}件修正済み, ${unfixedCount}件要確認`
    );

    // 記事の変化量を確認
    const originalLength = originalArticle.length;
    const revisedLength = revisedArticle.length;
    const lengthDiff = revisedLength - originalLength;
    const percentChange = ((lengthDiff / originalLength) * 100).toFixed(1);

    console.log(
      `📏 文字数変化: ${originalLength} → ${revisedLength} (${
        lengthDiff > 0 ? "+" : ""
      }${lengthDiff}文字, ${percentChange}%)`
    );

    // 「」「」の連続を改行する後処理
    const formattedArticle = formatLeadQuotes(revisedArticle);

    // <b>タグを<strong>タグに変換
    const tagConvertedArticle = formattedArticle
      .replace(/<b>/gi, "<strong>")
      .replace(/<\/b>/gi, "</strong>");

    console.log("✅ 一括修正完了");

    return tagConvertedArticle;
  } catch (error) {
    console.error("❌ 一括修正エラー:", error);
    console.error(
      "エラー詳細:",
      error instanceof Error ? error.message : error
    );

    if (error instanceof Error && error.message.includes("タイムアウト")) {
      throw new Error(
        "修正処理がタイムアウトしました。問題数が多すぎる可能性があります。個別修正をお試しください。"
      );
    }
    throw new Error(
      `記事の一括修正に失敗しました: ${
        error instanceof Error ? error.message : "不明なエラー"
      }`
    );
  }
}
