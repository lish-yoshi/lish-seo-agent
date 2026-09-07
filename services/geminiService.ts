import { GoogleGenerativeAI } from "@google/generative-ai";
import type { SeoOutline, GroundingChunk } from "../types";

const apiKey =
  import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey || apiKey === "" || apiKey === "undefined") {
  throw new Error("GEMINI_API_KEY not set. Please check your .env file.");
}

if (apiKey.includes("PLACEHOLDER") || apiKey.length < 30) {
  throw new Error("Please set a valid GEMINI_API_KEY in your .env file.");
}

console.log("✅ API key loaded successfully");
const ai = new GoogleGenAI({ apiKey });

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: "記事のキャッチーなタイトル案",
    },
    targetAudience: {
      type: Type.STRING,
      description: "この記事がターゲットとする読者層の説明",
    },
    introduction: {
      type: Type.STRING,
      description: "読者の興味を引き、記事を読み進めてもらうための導入部の要約",
    },
    outline: {
      type: Type.ARRAY,
      description:
        "記事の主要なセクション（H2レベル）とサブセクション（H3レベル）を含む構成案",
      items: {
        type: Type.OBJECT,
        properties: {
          heading: {
            type: Type.STRING,
            description: "H2見出し",
          },
          subheadings: {
            type: Type.ARRAY,
            description: "H3見出しのリスト",
            items: {
              type: Type.STRING,
            },
          },
          imageSuggestion: {
            type: Type.STRING,
            description:
              "このセクションの内容を補足するための、具体的で魅力的な画像やインフォグラフィックの提案。提案が不要な場合は省略してください。",
          },
        },
        required: ["heading", "subheadings"],
      },
    },
    conclusion: {
      type: Type.STRING,
      description: "記事の要点をまとめ、読者に行動を促す結論部分の要約",
    },
    keywords: {
      type: Type.ARRAY,
      description: "記事全体に含めるべき共起語や関連キーワードのリスト",
      items: {
        type: Type.STRING,
      },
    },
    characterCountAnalysis: {
      type: Type.OBJECT,
      description:
        "競合分析に基づく文字数の統計情報。商品ページやサービスページを除外し、純粋な記事コンテンツのみを分析対象とする。",
      properties: {
        average: { type: Type.NUMBER, description: "平均文字数" },
        median: { type: Type.NUMBER, description: "中央値の文字数" },
        min: { type: Type.NUMBER, description: "最小文字数" },
        max: { type: Type.NUMBER, description: "最大文字数" },
        analyzedArticles: {
          type: Type.NUMBER,
          description: "分析対象となった記事の数",
        },
      },
      required: ["average", "median", "min", "max", "analyzedArticles"],
    },
  },
  required: [
    "title",
    "targetAudience",
    "introduction",
    "outline",
    "conclusion",
    "keywords",
    "characterCountAnalysis",
  ],
};

export const generateSeoOutline = async (
  keyword: string,
  includeImages: boolean
): Promise<{ outline: SeoOutline; sources: GroundingChunk[] | undefined }> => {
  const imageInstruction = includeImages
    ? `\n- 競合分析に基づき、各H2見出しセクションに対して内容を視覚的に補強する画像やインフォグラフィックの具体的なアイデアを提案してください。("imageSuggestion"フィールドに記載)`
    : `\n- 画像やインフォグラフィックの提案は一切含めないでください。`;

  const agentSpec = `
name: SEO_SERP_Audit_Agent
version: "1.1"
role: >
  あなたは優秀なSEOストラテジスト兼テクニカルアナリストです。
  指定キーワードのGoogle上位サイトを解析し、見出し構造・共通トピック/検索意図・本文の文字数・
  タイトル頻出語を抽出して、後続の構成案に活用できる詳細レポートを日本語で出力します。

inputs:
  keyword: "${keyword}"   # ←絶対に変更しないこと
  locale: "ja-JP"
  region: "JP"
  search_engine:
    provider: "google"
    google_host: "google.co.jp"
    params:
      hl: "ja"
      gl: "JP"
      num_results_target: 10         # 唯一ドメイン化後も10件を目標
      exclude_verticals: ["news", "discussions", "shopping"]  # ニュース/掲示板/ショッピングを除外
      time_range: null               # 期間指定なし（必要なら上書き可）
  serp_selection:
    dedupe_same_domain: true         # 同一ドメインは最上位のみ採用
    max_serp_pages_scan: 3           # ユニークドメイン10件確保のため奥まで走査
    exclude_domains:
      - "*.go.jp"                    # 政府系ドメインを除外
  crawling:
    obey_robots_txt: true
    allow_pdf: false                 # PDF/スライドは含めない
    js_rendering: "off"              # JSレンダリングは行わない（必要ページはFAILED_JS_RENDER）
    timeout_sec: 25
    max_fetch_concurrency: 4
    max_redirects: 5
    user_agent_hint: "desktop"
  extraction:
    headings_levels: [1, 2, 3]       # H1/H2/H3を取得
    article_body_only: true          # 記事件名本文に限定
    article_selectors_priority:      # 本文候補の優先セレクタ（上から評価）
      - "main article"
      - "article"
      - "[role='main'] article"
      - "[itemtype*='Article']"
      - ".article-body, .entry-content, .post-content, .content__article-body, .single-body"
      - "main"
    article_exclude_selectors:       # 本文から必ず除外
      - "header, nav, footer, aside"
      - "[role='contentinfo'], [aria-label*='breadcrumb'], .breadcrumb, .breadcrumbs"
      - "[id*='sidebar'], [class*='sidebar']"
      - "[id*='footer'], [class*='footer']"
      - "[id*='globalnav'], [class*='globalnav'], [class*='gnav']"
      - ".toc, .table-of-contents, [id*='toc']"    # 目次
      - ".related, .recommend, .pickup, .ranking"  # 関連/おすすめ
      - ".ad, [class*='ads'], [id*='ads'], .sponsored"
      - ".comment, #comments"
    normalize_text:
      collapse_whitespace: true
      trim_boilerplate: true
      remove_breadcrumbs: true
      remove_captions: true
    include_images_text: false        # 画像内テキストは除外
  counting_rules:
    body_char_count:
      exclude_whitespace: true
      include_punctuation: true
      scope: "article_body_only"      # 本文抽出後にカウント
  nlp:
    tokenizer: "ja-morphological"     # 形態素（IPA/Sudachi相当、利用環境に合わせ自動選択）
    keep_numbers: true                # 数字や年号は保持
    synonym_groups:                   # 同義語の代表化（必要に応じ拡張）
      - ["メリット", "利点", "長所"]
      - ["デメリット", "欠点", "短所"]
      - ["料金", "価格", "費用", "コスト"]
      - ["比較", "違い", "差"]
      - ["始め方", "やり方", "手順", "方法"]
  title_keyword_extraction:
    remove_stopwords: true
    normalize_katakana_variants: true
    lowercase_alnum: true
    exclude_brand_or_site_names: true   # ブランド名/サイト名は除外
    brand_detection:
      from_domain: true                 # ドメイン/サブドメイン由来語を除外候補に追加
      from_title_suffix_patterns:       # 例: 「｜」「-」「—」以降のサイト名
        - "｜"
        - "-"
        - "—"
        - "│"
  retries:
    fetch_retry: 1                      # 取得失敗は1回だけ再試行
  reporting:
    language: "ja"
    outputs: ["markdown_report", "json_summary"]
    constraints:
      - "数値には根拠（n件/対象URL数）を明記"
      - "推測は『推定』と注記"
      - "取得不能は FAILED_FETCH / FAILED_JS_RENDER 等で記録"
      - "プレースホルダー ${keyword} は本文でも絶対に改変しない"
      - "文字数カウントは、情報提供を主目的とする記事・コラム形式のページのみを対象とし、商品ページ、比較・ランキングページ、サービス紹介ページは除外する"
    copyright_compliance:
      quote_policy:
        headings_quote_ok: true         # 見出しは短文引用として可
        long_quote_limit_chars: 120     # 長文の逐語転載は避け、必要時は要約
        always_cite_source: true        # URL/サイト名を明記
        no_fullpage_reproduction: true

objectives:
  - Google有機検索のユニークドメイン上位10件を対象に、以下を収集・要約する:
    1) 各サイトのH1/H2/H3見出し
    2) 共通トピックと推定検索意図（同義語はsynonym_groupsで統合）
    3) 本文の具体的な文字数（記事本文のみ）と平均値/中央値/範囲
    4) タイトルで頻出するキーワード（ブランド/サイト名を除外し出現頻度順に提示）

procedure:
  - step_1_serp_collect:
      description: "${keyword}" で google.co.jp を検索し、指定の除外/重複排除ルールで最大10件のユニークドメインを確保。
      outputs: [rank, url, domain, title]
  - step_2_fetch_and_extract:
      description: 各URLを取得し、本文・見出し（H1/H2/H3）を抽出。本文は article_selectors_priority に基づき抽出し、article_exclude_selectors を除去。
      failure_cases:
        - "タイムアウト/403等: FAILED_FETCH"
        - "JS必須で本文取得不可: FAILED_JS_RENDER"
  - step_3_measure_and_tokenize:
      description: 本文の文字数を counting_rules に従って計測。見出し/本文から名詞・重要語を抽出し正規化。
  - step_4_topic_intent_commonality:
      description: サイト別の主要トピック上位10と、全体での共通トピック（サイト出現比%）を算出。
      intent_labels: ["情報収集","比較検討","取引/購入","ハウツー","問題解決","レビュー","その他"]
  - step_5_title_keyword_stats:
      description: タイトルからブランド/サイト名を除外した重要語を頻度順に列挙（数字は保持）。
  - step_6_aggregate_stats:
      description: 本文文字数の平均・中央値・最小・最大・nを算出。
  - step_7_reporting:
      description: 日本語で詳細レポートと機械可読JSONを同時出力。

validation:
  - Ensure: ユニークドメインのSERPレコードが1件以上
  - Ensure: H1/H2/H3配列はnull不可（空配列は許容）
  - Ensure: body_char_countは非負整数でNaNにならない
  - Ensure: 除外ルール（*.go.jp, verticals）が遵守されている

outputs:
  markdown_report:
    structure:
      - "概要（キーワード、対象件数、地域/言語、除外条件、注意点）"
      - "サイト別サマリー表（rank/domain/url/title/body_char_count/備考）"
      - "見出し一覧（サイトごとにH1→H2→H3）"
      - "共通トピックと検索意図（サイトカバレッジ%）"
      - "タイトル頻出キーワードTOP20（ブランド/サイト名除外済み）"
      - "本文文字数の統計（平均・中央値・範囲・n）"
      - "示唆（構成案に活かすポイント）"
  json_summary_schema:
    type: object
    required: [keyword, serp, pages, aggregates, title_keyword_stats, common_topics, common_intents]
    properties:
      keyword: {type: string}
      serp:
        type: array
        items:
          type: object
          required: [rank, url, domain, title]
          properties:
            rank: {type: integer}
            url: {type: string}
            domain: {type: string}
            title: {type: string}
      pages:
        type: array
        items:
          type: object
          required: [rank, url, h1, h2, h3, body_char_count]
          properties:
            rank: {type: integer}
            url: {type: string}
            h1: {type: array, items: {type: string}}
            h2: {type: array, items: {type: string}}
            h3: {type: array, items: {type: string}}
            body_char_count: {type: integer}
            topics: {type: array, items: {type: string}}
            intents: {type: array, items: {type: string}}
            notes: {type: string}        # 例: FAILED_JS_RENDER/FAILED_FETCHの理由
      aggregates:
        type: object
        properties:
          body_char_count:
            type: object
            properties:
              mean: {type: number}
              median: {type: number}
              min: {type: integer}
              max: {type: integer}
              n: {type: integer}
      title_keyword_stats:
        type: array
        items:
          type: object
          properties:
            term: {type: string}
            count: {type: integer}
      common_topics:
        type: array
        items:
          type: object
          properties:
            topic: {type: string}
            coverage_pct: {type: number}
      common_intents:
        type: array
        items:
          type: object
          properties:
            intent: {type: string}
            coverage_pct: {type: number}

notes:
  - 本プロンプト内のキーワードは常に "${keyword}" を使用（絶対変更禁止）
  - ニュース/掲示板/ショッピング/政府系ドメイン（*.go.jp）は対象外
  - 本文のみを厳密抽出（サイドバー/フッター/ナビ/関連記事/広告は除外）
  - JSレンダリングが必要なページは対象外として記録
  - 出力は「詳細レポート（Markdown）」と「json_summary」の2形態
`;

  const prompt = `あなたは、以下の仕様で定義された「SEO_SERP_Audit_Agent」として機能してください。
あなたのタスクは、まず指定されたキーワードでGoogle検索を使い徹底的なSERP分析を行い、その分析結果に基づいて、検索上位を獲得できる最高のブログ記事構成案を作成することです。

--- エージェントの仕様 ---
${agentSpec}
--- エージェントの仕様ここまで ---

上記の仕様に従って、Google検索ツールを使いSERP分析を実行してください。
その徹底的な分析から得られたすべての洞察（共通トピック、検索意図、競合の見出し構造、文字数、頻出キーワードなど）を活用して、これから指定するJSONスキーマに沿ったブログ記事の構成案を作成してください。

分析の一環として、各競合サイトが「情報提供記事」か「商品・サービスページ」かを判断し、前者のみを文字数カウントの対象としてください。この結果は\`characterCountAnalysis\`フィールドに格納してください。

キーワード: "${keyword}"

作成する構成案には、分析結果を反映した以下の要素を必ず含めてください:
- 分析に基づいた、読者のクリックを誘う魅力的なタイトル案
- 分析から推定される、ターゲットとなる読者層の明確な定義
- 競合分析を反映し、読者の課題に共感し解決策を提示する導入部
- 競合の優れた点を取り入れ、網羅的かつ論理的な流れを持つH2とH3から成る詳細な見出し構成${imageInstruction}
- 記事全体の要約と、読者に行動を促す結論部
- SERP分析で明らかになった、記事内に自然に盛り込むべき共起語と関連キーワードのリスト
- 競合分析から導き出した、適切な記事ボリューム（文字数）の統計情報

【最重要】
最終的なアウトプットは、以下のJSONスキーマに厳密に従った有効なJSONオブジェクト**のみ**を出力してください。
分析過程のレポート（Markdownや中間結果）は出力に含めず、最終的なJSON構成案のみを返してください。
説明や前置き、コードブロックの囲み(\`\`\`json ... \`\`\`)は絶対に含めないでください。

JSON Schema:
${JSON.stringify(responseSchema, null, 2)}
`;

  let jsonToParse: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.7,
      },
    });

    const sources = response.candidates?.[0]?.groundingMetadata
      ?.groundingChunks as GroundingChunk[] | undefined;
    const rawText = response.text.trim();

    // The API might return the JSON wrapped in markdown code fences.
    // We need to extract the JSON content before parsing.
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]+)\s*```/);
    jsonToParse = jsonMatch && jsonMatch[1] ? jsonMatch[1].trim() : rawText;

    const parsedJson = JSON.parse(jsonToParse);

    return { outline: parsedJson as SeoOutline, sources };
  } catch (error) {
    console.error("Error generating SEO outline:", error);

    // More detailed error logging
    if (error instanceof SyntaxError) {
      console.error("JSON Parse Error - Response text:", jsonToParse);
      throw new Error(
        `JSON parsing failed. Raw response: ${jsonToParse?.substring(
          0,
          200
        )}...`
      );
    }

    if (error instanceof Error) {
      // Check for common API errors
      if (error.message.includes("API_KEY")) {
        throw new Error(
          "API key is invalid or missing. Please check your GEMINI_API_KEY in the .env file."
        );
      }
      if (error.message.includes("quota")) {
        throw new Error(
          "API quota exceeded. Please check your Gemini API usage limits."
        );
      }
      if (error.message.includes("permission")) {
        throw new Error(
          "Permission denied. Please verify your API key has the correct permissions."
        );
      }
      if (
        error.message.includes("network") ||
        error.message.includes("fetch")
      ) {
        throw new Error(
          "Network error. Please check your internet connection and try again."
        );
      }

      throw new Error(`Gemini API error: ${error.message}`);
    }

    throw new Error(
      "Unknown error occurred while generating SEO outline from Gemini API."
    );
  }
};
