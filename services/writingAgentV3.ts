// ライティングエージェント Ver.3
// 構成案を基に高品質な記事を自動生成
//
// 現在の実装状況:
// - Gemini 2.5 Pro（GA版）を使用
// - Grounding機能有効（Google検索で最新情報を取得）
// - カスタムインストラクション機能を強化

import { GoogleGenerativeAI } from "@google/generative-ai";
import { companyDataService } from "./companyDataService";
import { curriculumDataService } from "./curriculumDataService";
import { getContextForKeywords, isSupabaseAvailable } from "./primaryDataService";
import { clientHeaders } from "./clientContext";
// latestAIModelsは汎用化のため削除

const API_KEY =
  import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

console.log("🔑 Gemini API初期化チェック:");
console.log(
  "  - import.meta.env.VITE_GEMINI_API_KEY:",
  import.meta.env.VITE_GEMINI_API_KEY ? "設定済み" : "未設定"
);
console.log(
  "  - process.env.GEMINI_API_KEY:",
  process.env.GEMINI_API_KEY ? "設定済み" : "未設定"
);
console.log("  - 最終的なAPIキー:", API_KEY ? "利用可能" : "利用不可");

if (!API_KEY) {
  console.error("❌ Gemini APIキーが設定されていません");
  throw new Error("Gemini API key is not configured");
}

console.log("✅ Gemini API初期化成功");
const genAI = new GoogleGenerativeAI(API_KEY);

// SEOコンテンツ執筆のカスタムインストラクション（三段セルフリファイン + ファクトチェック強化版）
const WRITING_INSTRUCTIONS = `
meta:
  name: "SEOライター：三段セルフリファイン + ファクトチェック強化（完全版）"
  version: "2025-09-06"
  language: "ja"
  audience: "法人の決裁者・推進担当・現場マネジャー"
  output_visibility: "final-only"            # 中間物は一切出力しない
  retry_policy:
    auto_refine_retries: 2                   # 自動リトライ最大回数

role: |
  あなたは専門的なSEOライター兼編集者です。
  以後の出力は本文のみを返し、工程やメタ説明は一切出力しません。

identity:
  role: "SEOコンテンツの専門ライター"
  company: ""
  service: ""
  stance: "専門的かつ中立な比較・出典提示を行う"
  output_style:
    - "本文ではH3の事例として1〜3文で要約"
    - "主要数値は<strong>太字</strong>で強調（例：<strong>24時間→10秒</strong>）"
    - "出典は本文近傍にdofollowでリンク付き明記（タイトル/年）"
  fallback: "該当がない場合は自社実績セクションを省略し、CTAのみ残す"

language:
  target_language: "ja-JP"
  style: "です・ます調。断定は根拠とセット。自己言及・作業解説は出力に含めない"
  audience: "法人の決裁者・推進担当・現場マネジャー"

scope:
  purpose: "SEO記事の『ライティング』ガイドを適用して本文を生成"
  include: ["文章設計","文体・可読性","強調/リンク","画像alt/出典","AIらしさ回避"]
  exclude: ["構成の設計そのもの","Hタグ枚数・順序指定","内部リンク戦略の設計","公開後のリライト運用"]

tone_style:
  base: ["明快","具体","読者の課題起点","専門用語は定義してから使用"]
  ng: ["抽象的な一般論の羅列","婉曲表現の多用","権威付けだけで中身が薄い"]
  variation: "語尾・書き出しを意図的に分散（同型3連続を禁止）"

readability_rules:
  sentence:
    one_idea_per_sentence: true
    length_avg: "40〜60字"
    length_max: 80
    subject_predicate_distance: "2〜3句以内"
  paragraph:
    sentences_per_paragraph: "2〜4文"
    paragraph_start:
      intent: "読者の関心を引く要点から始める"
      variations:
        - "直接的な答え（疑問形H2の場合）"
        - "最も重要な事実"
        - "読者の利益・メリット"
        - "意外性のある事実"
        - "具体的な数値や事例"
      avoid: "『結論』という単語の直接使用"
    paragraph_end: "次段落へのブリッジ一句"
  breaks_lists:
    when_to_break: ["話題転換","3句点以上の連続","列挙が3点以上の時は箇条書き化"]
    bullet_style: "名詞始まり/文末表記の統一"
    bullet_length_rule: |
      【重要】箇条書きの文字数制限ルール

      ■ 基本ルール
      - 箇条書き1項目は日本語全角10文字以内
      - 単語・熟語のみを記載（説明文は含めない）
      - 詳細説明は箇条書きの後に通常文章で記述

      ■ 悪い例 ❌
      ・Webサイト・SNSコンテンツ制作：ブログの挿絵やSNS投稿用の画像を、外注することなく低コストかつ短時間で作成できます。
      ・広告・マーケティング素材：広告バナーやプレゼンテーション資料に使うイメージ画像を、デザインの専門知識がなくても手軽に用意できます。

      問題点：
      - 「：」以降の説明文が含まれている
      - 1項目が30文字以上になっている
      - スマホで複数行に渡って表示される

      ■ 良い例 ✅
      ・Webサイト・SNSコンテンツ制作
      ・広告・マーケティング素材
      ・製品デザインの試作

      ユースケースとしては、上記のような場面が考えられます。

      ブログの挿絵やSNS投稿用の画像を、外注することなく低コストかつ短時間で作成が可能。広告バナーやプレゼンテーション資料に使うイメージ画像を、デザインの専門知識がなくても手軽に用意できます。

      ■ 構造パターン
      [導入文]

      ・項目1（10文字以内）
      ・項目2（10文字以内）
      ・項目3（10文字以内）

      [つなぎ文]（例：上記のような場面が考えられます）

      [詳細説明の通常文章]
  trimming_examples:
    - "〜することができる → 〜できる"
    - "〜といったような → 〜など"
    - "まず最初に → まず"

logic_methods:
  preferred: ["SDS","PREP（連打禁止）","Q→A→Why→How（用途で使い分け）"]

writing_prohibitions:
  labels: ["結論：", "理由：", "例：", "ポイント：", "答え：", "具体例：", "注意点："]
  message: "ラベル付けは禁止。自然な文章として展開すること"
  patterns_to_avoid:
     - "結論から言うと"      # 使用禁止（特に冒頭）
    - "結論として"          # 使用禁止（特に冒頭）
    - "結論から申し上げると"  # 使用禁止
    - "まず結論ですが"      # 使用禁止
    - "先に結論を言うと"    # 使用禁止
    - "結論を先に述べると"  # 使用禁止
    - "結論から述べると"    # 使用禁止
    - "結論から言えば"      # 使用禁止


lead_section:
  goal: "検索意図への即応＋読む理由の提示"
  length: "200〜350字"
  structure: ["悩みの代弁","解決策（結論）","読むベネフィット","読み進め促し"]
  html_format: |
    【重要】リード文は一文ごとに<p>タグで囲む

    ■ 基本ルール
    - リード文の各文を個別の<p>タグで囲む
    - 複数文を1つの<p>タグにまとめない
    - これにより読みやすさとスマホでの表示が向上

    ■ HTMLフォーマット例
    良い例:
    <p>AI導入を検討しているものの、何から始めればよいかわからないと悩んでいませんか。</p>
    <p>本記事では、中小企業でも実践できるAI導入のステップを詳しく解説します。</p>
    <p>読み終える頃には、自社に最適なAI活用の第一歩が明確になるはずです。</p>

    悪い例:
    <p>AI導入を検討しているものの、何から始めればよいかわからないと悩んでいませんか。本記事では、中小企業でも実践できるAI導入のステップを詳しく解説します。読み終える頃には、自社に最適なAI活用の第一歩が明確になるはずです。</p>
  service_mention:
    approach: "読者の課題と解決策の接点を見つける"
    tone: "押し付けではなく、参考になる情報があるという選択肢の提示"
    strength_focus: "記事テーマと関連する具体的な解決策に言及"
    goal: "「ちょっと見てみようかな」と思える軽い興味喚起"


section_guides:
  h2:
    policy: ["読者の関心事に即答","見出しテーマの答えを冒頭2文で明示（自然な文章で）"]
    must_include: ["定義/ポイント","手順またはチェックリスト","注意点/落とし穴"]
  h3:
    role: "H2の補足・分解（事例/比較表/計算例など）"
  
  h2_opening_patterns:
    definition_type: # "〜とは"型
      start: "定義や概要を端的に述べる"
      example: "生成AIは、大量のデータから学習して新しいコンテンツを生成する技術です。"
      
    question_type: # "〜？"型  
      start: "質問に直接答える（結論という言葉は使わない）"
      example: "はい、中小企業でも生成AIは十分活用可能です。"
      
    method_type: # "〜の方法"型
      start: "手順の全体像や前提から"
      example: "生成AIの導入は、3つのステップで進めることができます。"
      
    comparison_type: # "〜選"型
      start: "選定の観点や基準から"
      example: "用途と予算に応じて、最適なツールは異なります。"
      
    benefit_type: # メリット・効果型
      start: "最大の利点を具体的に"
      example: "業務時間を最大70%削減できることが、最大のメリットです。"

emphasis_rules:
  bold_tag: "<strong>"
  apply_to: ["各見出しの結論文","数値・条件・判断基準"]
  per_heading: "1〜3箇所"
  max_ratio: "同一段落文字数の10%以内"
  quotes: "公式定義/ガイドラインは短文引用＋近傍に出典リンク"
  heading_restriction: |
    【重要】見出しタグ内での<strong>使用禁止
    - <h2>〜</h2>タグの中では<strong>タグを使用しない
    - <h3>〜</h3>タグの中では<strong>タグを使用しない
    - 見出しタグ以降の本文（<p>タグ内など）では<strong>タグの使用を推奨

    例：
    ❌ 悪い例: <h2>AIで<strong>業務効率化</strong>を実現</h2>
    ✅ 良い例: <h2>AIで業務効率化を実現</h2>
    ✅ 良い例: <p>AIは<strong>業務効率化</strong>に大きく貢献します。</p>

link_citation:
  policy: "原則dofollow。一次情報を優先（公式/省庁/学協会/大手メディア/自社資料）"
  placement: "本文近傍に出典を明示（タイトル/組織名＋年を含む自然文アンカー）"
  internal_refs: "用語集や関連ページへ自然な導線を挿入"
  anchor_text: "クリック後の内容を正確に表す自然文"
  self_data: "添付ファイル・自社実績も一次情報として使用可（数値・条件を明記）"

images_tables:
  when: "理解促進に資する場合（図解/比較表/簡易表）"
  caption: "図の要点と結論を10〜30字で要約"
  alt_policy: "該当H2の主要語を含む自然文（例：『[H2主題]の要件を示す概念図』）"

natural_flow_examples:
  good:
    - "生成AIの導入により、業務効率は飛躍的に向上します。実際に、当社のクライアント企業では..."
    - "多くの企業が悩む人材不足の問題。この解決策として注目されているのが..."
    - "中小企業にとって最大の課題は導入コストです。しかし、最近では月額数千円から..."
  
  bad:
    - "結論：生成AIは有効です。理由：コストが安いからです。"
    - "ポイント1：効率化。ポイント2：コスト削減。"
    - "答え：AIは中小企業でも使えます。例：A社のケース。"

transition_words:
  cause_effect: ["そのため", "したがって", "この結果", "これにより"]
  addition: ["さらに", "また", "加えて", "それだけでなく"]
  contrast: ["一方で", "ただし", "しかし", "とはいえ"]
  example: ["例えば", "実際に", "具体的には", "事例として"]
  emphasis: ["特に", "とりわけ", "中でも", "最も重要なのは"]
  
instruction: "接続詞を使って文章を自然につなぐ。ラベル付けではなく文脈で論理を示す"

ai_like_avoidance:
  symptoms:
    - "同一語尾/書き出しの連続"
    - "テンプレPREPの連打"
    - "不自然な高踏語（例：示唆されます/勘案できます）"
    - "過度な比喩・メタファー（羅針盤、道筋、架け橋など）"
    - "回りくどい表現（成功に導くための羅針盤を示します→成功させる方法を説明します）"
    - "格調高すぎる表現（提示する、示唆する→説明する、紹介する）"

  ng_words:
    metaphors: ["羅針盤", "道筋", "架け橋", "礎", "道標", "灯台", "指針"]
    pompous: ["示唆されます", "勘案できます", "提示します", "提供します", "において", "における"]
    redundant: ["〜することが可能です", "〜ということができます", "〜という観点から"]

  countermeasures:
    - "語尾ローテーション表を内的に適用して変化をつける"
    - "各段落に新情報or角度差分を必ず1つ入れる"
    - "NGワード辞書で自動置換："
    - "  『示唆されます→〜と言えます』"
    - "  『勘案できます→考慮できます』"
    - "  『〜することが可能です→〜できます』"
    - "  『羅針盤を示します→方法を説明します』"
    - "  『道筋を提供します→手順を紹介します』"
    - "  『において重要→〜で重要』"
    - "直接的でシンプルな表現を優先（カッコつけない）"

numbers_terms:
  terminology: "専門用語は初出で簡潔に定義。略語は展開後に使用"
  numbers: "数値は前提・条件・出所とセットで提示（単位・分母・時点を明記）"
  formulas: "必要時は条件を明示し簡潔に"
  company_results:
    instruction: "【自社実績データ】が提供された場合は必ず記事内で活用"
    examples: []
    usage: "数値を示す際は実績データを引用し説得力を高める（前提・時点・分母を併記）"

conclusion_section_rule: |
    【まとめセクション執筆ルール（重要）】

    ■ 基本構造
    - H3は0個
    - 記事要点の総括

    ■ 執筆の流れ
    1. 記事の要点を3-5点で簡潔にまとめ
    2. 次のアクションを促す一文で締める

    【OK例】
    - 「記事で紹介した施策を確実に実現」
    - 「詳しい実装方法は専門家にご相談」

    【NG例】
    - 記事内容と無関係な訴求
    - 過度な売り込み

research_policy:
  priority_order:
    - "省庁・官公庁・官報・法令"
    - "学協会・査読論文・公的統計"
    - "上場企業IR/有価証券報告書・公式発表"
    - "大手メディア（一次情報の裏取り用途）"
    - "自社一次資料"
  rules:
    - "年・数値・条件を本文に明記（例：時点YYYY年MM月/分母/単位）"
    - "Web参照/ファイル参照は能動的に実施。不一致は一次情報を採用"
    - "統計/白書は最新版優先（なければ最新版−1版まで）"
    - "法令は施行日・改正日を明記"
    - "企業数値は出典の期（年度/四半期）を明記"
  combine_sources: "常にWeb上の一次情報＋プロジェクト内ファイルの両方を参照し、最新性と正確性を担保"
  freshness: "年次が絡む数値・制度・市場動向は最新年を優先し、日付を本文に明記"
  citation_style: "本文近傍で自然文アンカー。出典名（年）を含む"
  conflict_resolution: "出典間で不一致があれば一次資料（法令/公式）を優先し、前提を注記"
  disallowed_sources:
    - "匿名ブログ/出典不明の二次まとめ"
    - "出典と年の明記がないグラフ/画像"

self_data_auto_extraction:
  enabled: true
  sources: "プロジェクト内の実績・取材PDF/ノートの索引（例：/mnt/data/pdf_segments_index.csv 等）"
  trigger: "投入フォーマットで『自社実績』が auto または未指定のとき発火"
  keyword_hints:
    - "導入事例"
    - "外注費|コスト|費用"
    - "→|円|%|時間|日|件|削減|自動化|短縮"
    - "お話を伺った方|代表|事業内容"
  extraction_rules:
    - "候補行を数値・記号（→, 円, %, 時間, 日）でスコアリングし、近傍±3行を要約"
    - "会社名・役職・事業内容を『お話を伺った方/代表/事業内容』近傍から抽出"
    - "効果はBefore/After/Deltaを分離（例：24時間→10秒、10万円→0円、毎日2時間→自動化等）"
    - "期間・前提（例：3営業日・毎日・1本あたりなど）があれば併記"
    - "出典はタイトル＋ページ番号（可能なら公開URL）で近傍に自然文アンカー"
  schema:
    company: string
    industry: string?
    challenge: string
    actions: string
    result:
      before: string
      after: string
      delta: string?
    timeframe: string?
    source:
      title: string
      page: integer?
  output_style:
    - "本文ではH3の事例として1〜3文で要約"
    - "主要数値は<strong>太字</strong>で強調（例：<strong>24時間→10秒</strong>）"
    - "出典は本文近傍にdofollowで明記（タイトル/年）"
  fallback: "該当がない場合は自社実績セクションを省略し、CTAのみ残す"

input_format_expected:
  required_keys:
    - "キーワード"
    - "検索意図"
    - "タイトル"
    - "メタディスクリプション"
    - "構成メモ"
  optional_keys:
    - "上位記事の共通トピック"
    - "目標文字数"
    - "リサーチデータ"
    - "自社実績（'auto' 推奨）"
  behavior:
    - "上記入力に基づき本文のみを出力（メタ情報や手順の説明は出さない）"
    - "『自社実績』が auto/未指定なら self_data_auto_extraction を用いる"

output_contract:
  format: |
    完全なHTML形式で出力。以下の規則を厳守：
    【必須HTML形式】
    - 見出し: <h2>見出しテキスト</h2>、<h3>小見出し</h3>
    - 段落: <p>テキスト</p>
      重要：段落分けの指針
      * 1つの<p>タグは最大200字程度を目安
      * 話題が変わったら必ず新しい<p>タグ
      * 「しかし」「一方で」「また」「さらに」などの接続詞が来たら段落分けを検討
      * 具体例を挙げる前は新しい段落にする
    - 太字: <strong>重要部分</strong>
    - 箇条書き（以下の場合は積極的に使用）:
      * 3つ以上の選択肢や項目を並列で示す時
      * メリット・デメリットを列挙する時
      * ステップや手順を説明する時
      <ul>
        <li>項目1</li>
        <li>項目2</li>
      </ul>
    - 表（重要）: マークダウン記法（|や---）は絶対使用禁止。必ず以下の形式：
      <table>
        <thead>
          <tr>
            <th>見出し1</th>
            <th>見出し2</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>データ1</td>
            <td>データ2</td>
          </tr>
        </tbody>
      </table>
    【禁止事項】
    - マークダウン記法（#、##、*、-、|）の使用は一切禁止
    - コードブロック記法も禁止
  length_control: "目標文字数が与えられた場合は±5%で寄せる。なければ適切な長文（目安8,000〜20,000字）"
  per_heading_requirements:
    - "冒頭2文で結論"
    - "数値/条件/手順のいずれかを含む"
    - "1ブロック以上の事例/比較/具体例を入れる"
    - "太字1〜3箇所"

  forbid: ["自己言及","作業手順の列挙","『この記事では〜を解説します』等のメタ文言","マークダウン記法"]

self_refine:
  enabled: true
  visibility:
    intermediate_outputs: "do-not-output"     # 下書き/診断は表示しない
  loops: "1–2"
  phases:
    - name: "draft"
      role: "天才SEOライター"
      goal: "構成メモに沿って本文を一気通貫で下書き"
      deliverable: "draft_text"                # 非表示
    - name: "analysis"
      role: "プロのアナリスト"
      input: "draft_text"
      checks:
        - "ファクト整合: 一次情報で裏取り（年・数値・出典を明記）"
        - "見出しごとに『冒頭2文で結論』『数値/条件/手順/事例のいずれか』"
        - "一文≤80字、平均40–60字、2–4文/段落"
        - "強調<strong>は各見出し1–3箇所・過剰10%未満"
        - "語尾/書き出し同型3連続なし（ai_like_avoidance適用）"
      tasks:
        - "entity_numeric_extraction: 下書きから全『固有名詞／日付／数値表現（%・人・社・円・件・年・時間など）』を抽出し fact_ledger に記録"
        - "name_check: 公式表記・英名・略称を一次情報で確認（省庁名、企業名、製品名、法令名、IR正式名）"
        - "quant_check: 数値の桁・単位・換算・割合計算・時点（YYYY年MM月DD日）を検算。分母の明記がない率はNG"
        - "source_verify: 一次情報で裏取り。二次情報は補助のみ"
        - "citation_map: 主張→出典(タイトル/年/URL)の対応表を作成。重複・不明瞭な出典は禁止"
        - "contradiction_scan: セクション間で名称・数値の不一致を検出し review_notes に修正指示"
      deliverables:
        - "review_notes"      # 非表示・修正指示
        - "fact_ledger"       # 非表示・固有名詞/数値台帳
        - "citation_map"      # 非表示・主張と出典の対応表
    - name: "edit"
      role: "プロの編集者"
      input: ["draft_text","review_notes","fact_ledger","citation_map"]
      actions:
        - "review_notesをすべて反映して全面推敲"
        - "事実不一致は公式一次情報に統一（research_policy準拠）"
        - "見出し単位で不足要素（事例/比較/手順）を追補"
        - "fact_ledger と citation_map の全項目を本文へ反映。未検証の主張は削除または保留に書き換え"
        - "固有名詞は初出で公式表記（必要なら英名/略称併記）に統一"
        - "数値は単位・時点・分母を併記。導出値は式を内部で検算し矛盾を解消"
        - "出典アンカーは本文近傍にdofollowで『タイトル/年』を明記"
      deliverable: "final_text"                # 出力するのはこの完成稿のみ
  stop_condition: "self_checklist と per_heading_requirements を全項目で満たす"
  failure_mode: "満たさない場合はanalysis→editをもう1ループ（最大2回）"

self_checklist:
  factuality:
    - "[ ] fact_ledger の全行が『本文のどこに反映されたか』対応づけ済み"
    - "[ ] 出典は近傍にdofollowでタイトル/年を記載し、citation_mapと一致"
    - "[ ] 率・増減は分母/基準年が本文に明記されている"
    - "[ ] ドキュメント内で数値・名称の矛盾がない（contradiction_scanを通過）"
  structure:
    - "[ ] 各H2で結論先出し（冒頭2文）"
    - "[ ] 各H2に数値/条件/手順/事例のいずれかを含む"
    - "[ ] 段落は2–4文で1論点"
  readability:
    - "[ ] 一文≤80字/平均40–60字"
    - "[ ] 主述ねじれ無し・語尾/書き出し同型3連続回避"
    - "[ ] 箇条書き1項目は10文字以内・説明文なし・コロン（:）禁止"
  emphasis_links:
    - "[ ] 各見出しの<strong>は1–3箇所、本文全体で10%未満"
  examples_minimums:
    - "[ ] H3の事例を1つ以上（1–3文、定量値を含む）"

per_heading_requirements:
  - "各H2: 結論→根拠（数値/条件/手順のいずれか）→近傍出典の順で成立"
  - "各H2: H3の事例を1つ以上。1〜3文、少なくとも1つの定量値を含む"
  - "各H2: 固有名詞の初出は公式表記。略称のみの使用は禁止"

internal_guards:
  visibility: "do-not-output"                  # 内部検査。表示禁止
  patterns:
    number_detection: "\\d+(\\.\\d+)?(万|億|%|人|社|円|件|年|ヶ月|時間|秒)"
    date_detection: "(20\\d{2}|19\\d{2})年(\\d{1,2}月)?(\\d{1,2}日)?"
  recency_policy:
    stats_whitepaper: "最新>最新版−1版"
    laws_and_notices: "施行日・改正日を本文に明記"
    corporate_info: "IR/有報優先。期（年度/四半期）を併記"

quality_gates:
  seo:
    - "見出しは検索意図に合致（主要キーワードをH2前半に）"
    - "冒頭500字に要点・数値・固有名詞を配置"
  readability:
    - "箇条書きは3〜7点を目安"
    - "箇条書き1項目は10文字以内（説明文・コロン禁止）"
    - "1段落は2–4文"
    - "冗長な副詞の連発を避ける"

micro_templates:
  conclusion_snippet: "結論：<strong>〜</strong>。"
  decision_snippet: "〜なら、〜を選ぶべきです。理由は〜。"
  steps_intro: "最短手順は次の3つです。"
  caution_snippet: "よくある失敗は〜。避けるには〜。"
  action_snippet: "今すぐ〜を試して、〜を確認しましょう。"

samples:
  sample_paragraph: |
    <strong>業務効率化の成否は"課題に最適化した設計"が最短で成果に直結します</strong>。
    部門ごとに優先課題が異なるためです。現場担当は実務フローの改善を重視し、管理部門はコスト削減を優先します。
  sample_criteria: |
    - <strong>費用対効果</strong>：投資額あたりの削減コスト/時間
    - <strong>業務適合度</strong>：自社フローへの適用可否
    - <strong>拡張性</strong>：他業務への展開可能性
`;

interface WritingRequest {
  outline: string; // マークダウン形式の構成案
  keyword: string; // ターゲットキーワード
  targetAudience?: string; // ターゲット読者
  tone?: "formal" | "casual" | "professional";
  useGrounding?: boolean; // Grounding機能を使うか
  useCompanyData?: boolean; // 自社データを使うか
  useCurriculum?: boolean; // カリキュラムデータを使うか
}

// 内部リンクマップを取得する関数
async function fetchInternalLinkMap(): Promise<Map<string, string>> {
  const linkMap = new Map<string, string>();

  try {
    const API_KEY = import.meta.env.VITE_INTERNAL_API_KEY;
    if (!API_KEY) {
      console.warn(
        "⚠️ INTERNAL_API_KEY未設定のため、内部リンクマップを取得できません"
      );
      return linkMap;
    }

    const API_URL =
      import.meta.env.VITE_API_URL?.replace("/api", "") ||
      import.meta.env.VITE_BACKEND_URL ||
      "";
    const response = await fetch(
      `${API_URL}/api/spreadsheet-mode/internal-links`,
      {
        headers: {
          ...clientHeaders(),
        },
      }
    );

    if (!response.ok) {
      console.warn(`⚠️ 内部リンクマップ取得失敗: ${response.status}`);
      return linkMap;
    }

    const data = await response.json();

    if (data.success && data.linkMap) {
      data.linkMap.forEach((item: { keyword: string; url: string }) => {
        linkMap.set(item.keyword, item.url);
      });
      console.log(`✅ 内部リンクマップ取得成功: ${linkMap.size}件`);
    }

    return linkMap;
  } catch (error) {
    console.error("❌ 内部リンクマップ取得エラー:", error);
    return linkMap;
  }
}

export async function generateArticleV3(
  request: WritingRequest
): Promise<string> {
  console.log("📝 ライティングエージェントV3 起動");
  console.log(`📌 対象キーワード: ${request.keyword}`);
  console.log("📊 リクエスト詳細:");
  console.log(
    "  - outline長:",
    request.outline ? request.outline.length : "null"
  );
  console.log("  - targetAudience:", request.targetAudience);
  console.log("  - tone:", request.tone);
  console.log("  - useGrounding:", request.useGrounding);
  console.log("  - useCompanyData:", request.useCompanyData);
  console.log("  - useCurriculum:", request.useCurriculum);

  // 構成内容をパースして進捗管理用の情報を取得
  if (!request.outline) {
    console.error("❌ outline が null または undefined です");
    throw new Error("outline is required");
  }

  if (typeof request.outline !== "string") {
    console.error("❌ outline が文字列ではありません:", typeof request.outline);
    throw new Error("outline must be a string");
  }

  console.log(
    "🔍 outline内容の先頭200文字:",
    request.outline.substring(0, 200)
  );

  const outlineLines = request.outline.split("\n");
  const h2Sections: string[] = [];
  let currentH2Count = 0;

  outlineLines.forEach((line) => {
    if (line.startsWith("## ")) {
      h2Sections.push(line.substring(3));
    }
  });

  const totalSections = h2Sections.length;
  console.log(`📊 執筆予定: ${totalSections}個のH2セクション`);
  h2Sections.forEach((section, index) => {
    console.log(`  ${index + 1}. ${section}`);
  });

  const startTime = Date.now();

  try {
    // 自社データの取得（オプション）
    let companyDataText = "";
    if (request.useCompanyData !== false) {
      // デフォルトで有効（Google Drive設定時に自動で使用）
      try {
        console.log("\n🔄 [1/4] 自社実績データを取得中...");
        const dataStartTime = Date.now();
        const companyData = await companyDataService.fetchCompanyData();
        const relevantData = companyDataService.searchRelevantData(
          request.keyword,
          companyData
        );

        if (relevantData.length > 0) {
          companyDataText = `
【自社実績データ（事例セクションで使用必須）】
※重要：以下の${
            relevantData.length
          }社の事例データのみを使用してください。他の企業事例は絶対に追加しないでください。

${relevantData
  .map(
    (d, index) =>
      `【使用必須事例 ${index + 1}】\n${companyDataService.formatAsMarkdown(d)}`
  )
  .join("\n\n")}
`;
          const dataTime = ((Date.now() - dataStartTime) / 1000).toFixed(1);
          console.log(
            `✅ [1/4] 完了: ${relevantData.length}件の関連実績を取得 (${dataTime}秒)`
          );
        } else {
          console.log("ℹ️ [1/4] 完了: キーワードに関連する実績なし");
        }
      } catch (error) {
        console.error("⚠️ [1/4] エラー: 自社データ取得失敗:", error);
        // エラーがあっても続行
      }
    } else {
      console.log("⏭️ [1/4] スキップ: 自社データ使用しない設定");
    }

    // Supabase一次情報の取得（オプション）
    let primaryDataText = "";
    if (isSupabaseAvailable()) {
      try {
        console.log("\n🔄 [1.6/4] Supabase一次情報を検索中...");
        const primaryStartTime = Date.now();
        const primaryContext = await getContextForKeywords([request.keyword], { limit: 15 });

        if (primaryContext) {
          primaryDataText = `\n【一次情報データベースからの補足情報】\n${primaryContext}`;
          const primaryTime = ((Date.now() - primaryStartTime) / 1000).toFixed(1);
          console.log(`✅ [1.6/4] 完了: 関連一次情報を取得 (${primaryTime}秒)`);
        } else {
          console.log("ℹ️ [1.6/4] 完了: キーワードに関連する一次情報なし");
        }
      } catch (error) {
        console.error("⚠️ [1.6/4] エラー: 一次情報取得失敗:", error);
        // エラーがあっても続行
      }
    } else {
      console.log("⏭️ [1.6/4] スキップ: Supabase未設定");
    }

    // 内部リンクマップの取得
    let internalLinkText = "";
    try {
      console.log("\n🔄 [1.7/4] 内部リンクマップを取得中...");
      const linkStartTime = Date.now();
      const internalLinkMap = await fetchInternalLinkMap();

      if (internalLinkMap.size > 0) {
        const linkList = Array.from(internalLinkMap.entries())
          .map(([keyword, url]) => `- ${keyword}: ${url}`)
          .join("\n");

        internalLinkText = `
【内部リンク挿入指示（重要）】
以下は当サイトの公開予定記事URLのマップです。記事執筆時、見出し（H2/H3）の終わり、次の見出しに入る前に、関連する内部リンクをURLベタ貼りで挿入してください。

■ 挿入ルール：
1. 挿入位置: 各見出し（H2/H3）の本文が終わった後、次の見出しタグの直前
2. 挿入形式: URLのみをベタ貼り（<a>タグ不要、テキスト説明不要）
3. 判定基準: 「この見出しの話題をより詳しく書いている記事があるか？」
4. 挿入数: 1記事あたり3〜5個（記事ボリュームが大きければ7〜10個）
5. 関連性: 見出しの内容と下記キーワードの関連性が高いもののみ挿入

■ 挿入例：
<h2>生成AIの著作権問題</h2>
<p>生成AIによる著作権侵害のリスクは...</p>
<p>具体的な対策としては...</p>
https://example.com/generative-ai-copyright
<h2>次の見出し</h2>

■ 利用可能な内部リンク一覧：
${linkList}

重要：上記リスト内のURLのみを使用し、存在しないURLは絶対に挿入しないこと。
`;
        const linkTime = ((Date.now() - linkStartTime) / 1000).toFixed(1);
        console.log(
          `✅ [1.7/4] 完了: 内部リンクマップ取得 ${internalLinkMap.size}件 (${linkTime}秒)`
        );
      } else {
        console.log("ℹ️ [1.7/4] 完了: 内部リンクなし");
      }
    } catch (error) {
      console.error("⚠️ [1.7/4] エラー: 内部リンクマップ取得失敗:", error);
      // エラーがあっても続行
    }

    // カリキュラムデータの取得（オプション）
    let curriculumDataText = "";
    if (request.useCurriculum !== false) {
      // デフォルトでは使用する
      try {
        console.log("\n🔄 [1.5/4] カリキュラムデータを検索中...");
        const currStartTime = Date.now();
        const curriculumContext = curriculumDataService.buildArticleContext(
          request.keyword
        );

        if (curriculumContext) {
          curriculumDataText = curriculumContext;
          const currTime = ((Date.now() - currStartTime) / 1000).toFixed(1);
          console.log(
            `✅ [1.5/4] 完了: 関連カリキュラム情報を取得 (${currTime}秒)`
          );
        } else {
          console.log("ℹ️ [1.5/4] 完了: キーワードに関連するカリキュラムなし");
        }
      } catch (error) {
        console.error("⚠️ [1.5/4] エラー: カリキュラムデータ取得失敗:", error);
        // エラーがあっても続行
      }
    }

    // モデル設定
    const modelConfig: any = {
      model: "gemini-3.7-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 16384, // 20,000文字まで対応（8192→16384に増加）
        topP: 0.9,
        thinkingConfig: { thinkingLevel: "low" },
      },
    };

    // Grounding機能（Google検索による最新情報取得）
    // 無料枠：
    // - Google AI Studio: 完全無料（1日1,500クエリまで）
    // - Vertex AI: 1日10,000クエリ無料（その後$35/1000クエリ）
    if (request.useGrounding) {
      modelConfig.tools = [
        {
          googleSearch: {}, // Gemini 2.0以降の新形式
        },
      ];
      console.log(
        "\n🔄 [2/4] Grounding機能を有効化（最新情報を検索しながら執筆）"
      );
    } else {
      console.log("\n⏭️ [2/4] スキップ: Grounding機能未使用");
    }

    const model = genAI.getGenerativeModel(modelConfig);

    console.log("\n🔄 [3/4] プロンプト構築中...");

    // プロンプトの構築
    const prompt = `
${WRITING_INSTRUCTIONS}

＜構成内容＞

${request.outline}

【メインキーワード】
${request.keyword}

${request.targetAudience ? `【ターゲット読者】\n${request.targetAudience}` : ""}
${companyDataText}
${curriculumDataText}
${internalLinkText}
${primaryDataText}
【執筆指示】
上記の構成案とカスタムインストラクションに基づいて、SEOに最適化された記事を執筆してください。

【重要】執筆メモの活用について：
- 各H2セクションの「執筆メモ」に記載された要点は必ず記事内で触れてください
- H3の執筆メモがある場合は、その内容を具体的に展開してください
- 執筆メモは「何を書くべきか」の重要な指針なので、8割以上の要素を反映させてください
- ただし、執筆メモの内容を機械的にコピーするのではなく、自然な文章として展開してください

${
  companyDataText
    ? `
【重要】企業事例について：
- 「導入事例」「成功事例」セクションでは、以下に提供された実績データの企業のみを使用すること
- 以下で提供されていない企業を勝手に追加しないこと（提供データ以外の企業は使用禁止）
- 必ず提供されたデータの中から3社を使用し、それぞれの具体的な数値や成果を正確に記載すること
- 企業名、数値、成果内容は提供されたデータのまま使用すること（改変禁止）`
    : ""
}
${
  request.useGrounding
    ? "※ 最新情報はウェブ検索で確認しながら執筆してください。"
    : ""
}
`;

    console.log("✅ [3/4] 完了: プロンプト構築完了");

    // 記事生成
    console.log("\n🔄 [4/4] AI執筆中...");
    console.log("⏳ 予想時間: 約30-60秒");

    const generationStartTime = Date.now();

    // 進捗表示用のタイマー
    const progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - generationStartTime) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        console.log(`⏳ 執筆中... ${elapsed}秒経過`);
      }
    }, 10000);

    try {
      const result = await model.generateContent(prompt);
      clearInterval(progressInterval);

      const response = result.response;
      const text = response.text();

      const generationTime = (
        (Date.now() - generationStartTime) /
        1000
      ).toFixed(1);
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

      // 生成された文字数とセクション数をカウント
      const charCount = text.length;
      // Markdown形式とHTML形式の両方をカウント
      const h2MarkdownCount = (text.match(/^## /gm) || []).length;
      const h2HtmlCount = (text.match(/<h2[^>]*>/gi) || []).length;
      const h2Count = h2MarkdownCount + h2HtmlCount;

      const h3MarkdownCount = (text.match(/^### /gm) || []).length;
      const h3HtmlCount = (text.match(/<h3[^>]*>/gi) || []).length;
      const h3Count = h3MarkdownCount + h3HtmlCount;

      console.log("\n✅ [4/4] 完了: AI執筆完了");
      console.log("\n📊 執筆結果:");
      console.log(`  ・文字数: ${charCount.toLocaleString()}文字`);
      console.log(`  ・H2セクション: ${h2Count}個`);
      console.log(`  ・H3セクション: ${h3Count}個`);
      console.log(`  ・生成時間: ${generationTime}秒`);
      console.log(`  ・合計時間: ${totalTime}秒`);

      // リード文の「」「」連続を改行処理
      const formattedText = formatLeadQuotes(text);

      return formattedText;
    } catch (error) {
      clearInterval(progressInterval);
      throw error;
    }
  } catch (error) {
    const errorTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ ライティングエラー (${errorTime}秒後):`, error);
    throw error;
  }
}

// セクション単位での執筆（長文記事対応）
export async function generateSectionV3(
  sectionOutline: string,
  previousContext: string,
  request: WritingRequest
): Promise<string> {
  console.log("\n📝 セクション単位執筆モード開始");

  // セクション名を抽出
  const sectionMatch = sectionOutline.match(/^##\s+(.+)/m);
  const sectionName = sectionMatch ? sectionMatch[1] : "不明なセクション";
  console.log(`📌 執筆セクション: ${sectionName}`);

  const startTime = Date.now();

  try {
    const modelConfig: any = {
      model: "gemini-3.7-flash",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192, // セクション分割時も増加（4096→8192）
        thinkingConfig: { thinkingLevel: "low" },
      },
    };

    if (request.useGrounding) {
      modelConfig.tools = [
        {
          googleSearchRetrieval: {
            dynamicRetrievalConfig: {
              mode: "MODE_DYNAMIC",
              dynamicThreshold: 0.3,
            },
          },
        },
      ];
    }

    const model = genAI.getGenerativeModel(modelConfig);

    const prompt = `
${WRITING_INSTRUCTIONS}

【これまでの文脈】
${previousContext.slice(-1000)} // 最後の1000文字のみ

【今回執筆するセクション】
${sectionOutline}

【キーワード】
${request.keyword}

このセクションのみを執筆してください。前のセクションとの繋がりを意識し、
自然な流れで内容を展開してください。
`;

    console.log("🔄 セクション執筆中...");
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ セクション執筆完了: ${sectionName} (${elapsed}秒)`);

    return text;
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`❌ セクション執筆エラー (${elapsed}秒後):`, error);
    throw error;
  }
}

// カスタムインストラクションの管理
export function updateCustomInstructions(newInstructions: string): void {
  // カスタムインストラクションを更新（将来的にはDBやローカルストレージに保存）
  console.log("📋 カスタムインストラクション更新");
  // TODO: 実装
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

// 執筆品質のセルフチェック
export async function selfCheckQuality(
  article: string,
  outline: string
): Promise<{
  score: number;
  issues: string[];
  suggestions: string[];
}> {
  // 内部品質チェック機能
  const issues: string[] = [];
  const suggestions: string[] = [];

  // 文字数チェック
  const charCount = article.length;
  if (charCount < 3000) {
    issues.push("文字数が少なすぎます（3000文字未満）");
    suggestions.push("各セクションの内容をより詳細に展開してください");
  }

  // キーワード密度チェック
  // TODO: 実装

  // 見出し構造チェック
  // TODO: 実装

  const score = 100 - issues.length * 10;

  return { score, issues, suggestions };
}
