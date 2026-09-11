import React, { useState, useRef, useEffect } from "react";
import type { SeoOutline, SeoOutlineV2, SubheadingWithNote } from "../types";
import { getActiveClientId } from "../services/clientContext";
import { buildImageGenUrl, getImageGenOrigin } from "../utils/imageAgentUrl";
import {
  generateArticle,
  regenerateSection,
  type WritingRegulation,
} from "../services/articleWriterService";
import { generateArticleBySection } from "../services/sectionBasedArticleWriter";
import {
  generateArticleV2,
  type WritingRegulationV2,
} from "../services/articleWriterServiceV2";
import { generateArticleV3 } from "../services/writingAgentV3";
import { checkArticleV3 } from "../services/writingCheckerV3";
import { proofreadArticle } from "../services/proofreadingAgent";
import {
  performFinalProofread,
  checkImplementationStatus,
  // runMultiAgentProofread,  // ← コメントアウト
} from "../services/finalProofreadingAgent";
import { MultiAgentOrchestrator } from "../services/finalProofreadingAgents/MultiAgentOrchestrator";
import type {
  IntegrationResult,
  Issue,
} from "../services/finalProofreadingAgents/types";
import {
  reviseSpecificIssue,
  reviseBatchIssues,
} from "../services/articleRevisionService";
import { testArticle, testOutline } from "../testData/sampleArticle";
import type { ProofreadingReport } from "../types/proofreading";
import ProofreadingReportComponent from "./ProofreadingReport";
import LoadingSpinner from "./LoadingSpinner";
import { slackNotifier } from "../services/slackNotificationService";
import { extractCautionNotes } from "../utils/extractCautionNotes";
import { generateSlug } from "../services/slugGenerator";

/**
 * Issueオブジェクトのoriginalフィールドを安全に文字列化
 * @param issue - Issue オブジェクト
 * @returns 安全な文字列（null/undefinedの場合は空文字）
 */
function getSafeOriginal(issue: Issue): string {
  const original = issue.original;

  if (original === null || original === undefined) {
    return "";
  }

  if (typeof original === "string") {
    return original;
  }

  if (
    typeof original === "number" ||
    typeof original === "boolean" ||
    typeof original === "bigint"
  ) {
    return String(original);
  }

  if (Array.isArray(original)) {
    return original.join(", ");
  }

  if (typeof original === "object") {
    return JSON.stringify(original);
  }

  return String(original);
}

// クリーンアップ処理用のヘルパー関数
function cleanupArticleContent(content: string): string {
  console.log("🧹 記事クリーンアップ処理開始");

  // 1. アスタリスク（*）を削除
  let cleaned = content.replace(/\*/g, "");

  // 2. <b>タグを<strong>タグに変換
  cleaned = cleaned
    .replace(/<b>/gi, "<strong>")
    .replace(/<\/b>/gi, "</strong>");

  // 変更内容をログ出力
  const asteriskCount = (content.match(/\*/g) || []).length;
  const bCount = (content.match(/<b>/gi) || []).length;

  if (asteriskCount > 0) {
    console.log(`  ✅ アスタリスク削除: ${asteriskCount}箇所`);
  }
  if (bCount > 0) {
    console.log(`  ✅ bタグ→strongタグ変換: ${bCount}箇所`);
  }

  console.log("🧹 クリーンアップ処理完了");
  return cleaned;
}

interface ArticleWriterProps {
  outline: SeoOutline | SeoOutlineV2; // Ver.1とVer.2両方の構成を受け付ける
  keyword: string;
  onClose: () => void;
  writingMode?: "v1" | "v2" | "v3"; // 執筆モード（Ver.3追加）
  testMode?: boolean; // テストモード（最終校閲テスト用）
  revisionTestMode?: boolean; // 修正サービステストモード
  onArticleGenerated?: (article: {
    title: string;
    metaDescription: string;
    htmlContent: string;
    plainText: string;
  }) => void;
  isAutoMode?: boolean; // フル自動モードかどうか
  onAutoComplete?: () => void; // フル自動モード完了時のコールバック
  onAutoRevisionStart?: () => void; // 自動修正開始時のコールバック
  skipAutoGenerate?: boolean; // 自動生成をスキップ（編集再開時用）
  onOpenImageAgent?: (articleData: {
    title: string;
    content: string;
    keyword: string;
    autoMode?: boolean;
  }) => void; // 画像生成エージェントをiframeで開く
}

const ArticleWriter: React.FC<ArticleWriterProps> = ({
  outline,
  keyword,
  onClose,
  writingMode = "v1",
  testMode = false,
  revisionTestMode = false,
  onArticleGenerated,
  isAutoMode = false,
  onAutoComplete,
  onAutoRevisionStart,
  skipAutoGenerate = false,
  onOpenImageAgent,
}) => {
  // デバッグ：受け取ったデータを確認
  console.log("ArticleWriter received:", {
    outline: outline,
    outlineExists: !!outline,
    outlineType:
      outline && "competitorComparison" in outline ? "Ver.2" : "Ver.1",
    outlineKeys: outline ? Object.keys(outline) : [],
    hasCharacterCountAnalysis: outline
      ? !!(outline as any).characterCountAnalysis
      : false,
    hasCompetitorComparison: outline
      ? !!(outline as any).competitorComparison
      : false,
    keyword,
    writingMode,
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [article, setArticle] = useState<{
    title: string;
    metaDescription: string;
    htmlContent: string;
    plainText: string;
  } | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "code">("code");
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [regeneratingSection, setRegeneratingSection] = useState<string | null>(
    null
  );
  const [generationMethod, setGenerationMethod] = useState<
    "standard" | "section"
  >("section"); // デフォルトをセクション単位に
  const [generationProgress, setGenerationProgress] = useState<string>("");
  const [proofreadingReport, setProofreadingReport] =
    useState<ProofreadingReport | null>(null);
  const [isProofreading, setIsProofreading] = useState(false);
  const [showProofreadingReport, setShowProofreadingReport] = useState(false);
  const [isFinalProofreading, setIsFinalProofreading] = useState(false);
  const [finalProofStatus, setFinalProofStatus] = useState<string>("");
  const [useMultiAgent, setUseMultiAgent] = useState(true); // マルチエージェントモードのトグル（デフォルトON）
  const [multiAgentResult, setMultiAgentResult] =
    useState<IntegrationResult | null>(null);

  // multiAgentResultの変更を監視
  useEffect(() => {
    console.log(
      "📊 multiAgentResult変更:",
      multiAgentResult
        ? `結果あり（スコア: ${multiAgentResult.overallScore}）`
        : "null"
    );
  }, [multiAgentResult]);
  const [isRevising, setIsRevising] = useState(false); // 修正処理中フラグ
  const [revisionProgress, setRevisionProgress] = useState<string>(""); // 修正進捗メッセージ
  const [revisedIssues, setRevisedIssues] = useState<Set<string>>(new Set()); // 修正済み課題のID管理
  const [revisingIssueId, setRevisingIssueId] = useState<string | null>(null); // 現在修正中の課題ID
  const [showRestoreDialog, setShowRestoreDialog] = useState(false); // 復元ダイアログの表示状態
  const [savedData, setSavedData] = useState<any>(null); // 保存されているデータ
  const [lastSaveTime, setLastSaveTime] = useState<Date | null>(null); // 最後の保存時刻

  // フルオート関連のステート
  const [autoMode, setAutoMode] = useState<
    "manual" | "semi-auto" | "full-auto"
  >("full-auto"); // 自動修正モード（デフォルト：フルオート）
  const [autoFlowProgress, setAutoFlowProgress] = useState<{
    isRunning: boolean;
    currentStep:
      | "idle"
      | "proofreading"
      | "analyzing"
      | "revising"
      | "completed";
    percentage: number;
    message: string;
  }>({
    isRunning: false,
    currentStep: "idle",
    percentage: 0,
    message: "",
  });

  // レギュレーション設定（今後カスタマイズ可能）
  const [regulation] = useState<WritingRegulationV2>({
    enableInternalLinks: false,
    // internalLinkBaseUrl: 'https://example.com',
    // Ver.2用の設定
    enableInstructionTags: writingMode === "v2",
    strictBulletPoints: writingMode === "v2",
    useLeadTemplate: writingMode === "v2",
    addSectionSummary: writingMode === "v2",
  });

  // 記事を生成
  const handleGenerateArticle = async () => {
    // 重複実行防止
    if (isGenerating) {
      console.log("⚠️ 既に記事生成中です。重複実行を防止しました。");
      return;
    }

    setIsGenerating(true);
    setGenerationProgress("");

    try {
      let generatedArticle;

      // Ver.3モードの場合（Gemini Pro + Grounding）
      if (writingMode === "v3") {
        setGenerationProgress(
          "Ver.3モード（Gemini Pro + Grounding）で記事を生成中..."
        );

        // テスト構成(Ver.2)からの実行の場合、outlineがnullの可能性があるので確認
        const actualOutline = outline || {
          title: `${keyword}完全ガイド`,
          metaDescription: `${keyword}について詳しく解説。基礎から応用まで網羅的に紹介します。`,
          targetAudience: "ビジネスパーソン、マーケター、経営者",
          headings: [],
        };

        // 構成案をマークダウン形式に変換
        const outlineMarkdown = convertOutlineToMarkdown(
          actualOutline,
          keyword
        );

        // Ver.3エージェントで生成
        const v3Result = await generateArticleV3({
          outline: outlineMarkdown,
          keyword: keyword,
          targetAudience: actualOutline.targetAudience,
          tone: "professional",
          useGrounding: true, // Grounding機能有効（最新情報を検索しながら執筆）
        });

        // 一時的に保存（チェック後にクリーンアップするため）
        console.log("✅ Ver.3生成完了（Grounding機能使用）");

        // 品質チェックも実行
        const checkResult = await checkArticleV3({
          article: v3Result,
          outline: outlineMarkdown,
          keyword: keyword,
        });

        console.log(`📊 品質スコア: ${checkResult.overallScore}/100`);
        console.log("📝 改善提案:", checkResult.improvements);

        // クリーンアップ処理を実行
        const cleanedContent = cleanupArticleContent(v3Result);

        // クリーンアップ後のコンテンツでHTMLとプレーンテキストを再生成
        const cleanedHtmlContent = convertMarkdownToHtml(cleanedContent);
        const cleanedPlainText = cleanedContent.replace(/[#*`\[\]]/g, "");

        // generatedArticleを更新（クリーンアップ済みのコンテンツを使用）
        generatedArticle = {
          title: actualOutline.title || `${keyword}について`,
          metaDescription:
            actualOutline.metaDescription ||
            `${keyword}に関する詳細な解説記事です。`,
          htmlContent: cleanedHtmlContent,
          plainText: cleanedPlainText,
        };
      }
      // Ver.2モードの場合
      else if (writingMode === "v2") {
        setGenerationProgress("Ver.2モードで記事を生成中...");
        const v2Result = await generateArticleV2(outline, keyword, regulation);

        generatedArticle = {
          title: v2Result.title,
          metaDescription: v2Result.metaDescription,
          htmlContent: v2Result.htmlContent,
          plainText: v2Result.plainText,
        };

        console.log(
          `📊 Ver.2生成完了: ${v2Result.characterCount}文字（指示タグ除外）`
        );
      }
      // Ver.1モード（従来版）
      else if (generationMethod === "section") {
        // セクション単位で生成
        setGenerationProgress("セクション単位で記事を生成中...");
        const sectionResult = await generateArticleBySection(
          outline,
          keyword,
          regulation
        );

        // セクション統計情報をコンソールに表示
        if (sectionResult.sectionStats) {
          console.log("📊 セクション別文字数統計:");
          sectionResult.sectionStats.forEach((stat) => {
            const rate = Math.round(
              (stat.actualChars / stat.targetChars) * 100
            );
            console.log(
              `  ${stat.sectionName}: ${stat.actualChars}/${stat.targetChars}文字 (${rate}%)`
            );
          });
        }

        generatedArticle = {
          title: sectionResult.title,
          metaDescription: sectionResult.metaDescription,
          htmlContent: sectionResult.htmlContent,
          plainText: sectionResult.plainText,
        };
      } else {
        // 従来の一括生成
        setGenerationProgress("記事を一括生成中...");
        generatedArticle = await generateArticle(outline, keyword, regulation);
      }

      // proofreadingInfoを除外してsetArticle用のオブジェクトを作成
      const articleForState = {
        title: generatedArticle.title,
        metaDescription: generatedArticle.metaDescription,
        htmlContent: generatedArticle.htmlContent,
        plainText: generatedArticle.plainText,
      };

      setArticle(articleForState);
      setEditedContent(generatedArticle.htmlContent);
      setGenerationProgress("");

      // 記事が生成されたことを親コンポーネントに通知
      if (onArticleGenerated) {
        onArticleGenerated(articleForState);
      }

      // 推敲情報があればコンソールに表示
      if (
        "proofreadingInfo" in generatedArticle &&
        generatedArticle.proofreadingInfo
      ) {
        console.log("推敲情報:", generatedArticle.proofreadingInfo);
      }

      // フル自動モードの場合、Slack通知を送信
      if (isAutoMode) {
        await slackNotifier.notifyStepComplete({
          keyword: keyword,
          step: "writing",
          charCount: articleForState.plainText.length,
        });
      }

      // フル自動モードの場合の処理はuseEffectで行う（article確定後に実行）
    } catch (error) {
      console.error("記事生成エラー詳細:", error);
      console.error(
        "エラースタック:",
        error instanceof Error ? error.stack : "スタックなし"
      );
      alert(
        `記事の生成に失敗しました: ${
          error instanceof Error ? error.message : "不明なエラー"
        }`
      );
    } finally {
      setIsGenerating(false);
      setGenerationProgress("");
    }
  };

  // 初回レンダリング時に自動生成（重複実行防止付き）
  const isGeneratingRef = useRef(false); // useRefで即座に反映

  // 自動保存用のキーを生成（キーワードベース）
  const STORAGE_KEY = `articleWriter_draft_${keyword.replace(/\s+/g, "_")}`;

  // 自動保存機能（60秒ごとに保存、修正中は一時停止）
  useEffect(() => {
    if (!article || !editedContent) return;

    // 修正中は自動保存を停止
    if (isRevising) {
      console.log("⏸️ 修正中のため自動保存を一時停止");
      return;
    }

    // フル自動モードまたはスプレッドシートモードの場合はドラフト自動保存を無効化
    if (isAutoMode) {
      console.log("🚀 フル自動モード: ドラフト自動保存を無効化");
      return;
    }

    const saveTimer = setInterval(() => {
      // 修正中でないことを再確認
      if (isRevising) {
        console.log("⏸️ 修正中のため自動保存をスキップ");
        return;
      }

      const dataToSave = {
        article,
        editedContent,
        multiAgentResult,
        revisedIssues: Array.from(revisedIssues),
        timestamp: new Date().toISOString(),
        keyword,
        outline: outline || null,
      };

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
        setLastSaveTime(new Date());
        console.log("💾 記事を自動保存しました");
      } catch (error) {
        console.warn("⚠️ ドラフト自動保存スキップ（容量不足）");
      }
    }, 60000); // 60秒ごとに保存

    return () => clearInterval(saveTimer);
  }, [
    article,
    editedContent,
    multiAgentResult,
    revisedIssues,
    keyword,
    outline,
    STORAGE_KEY,
    isRevising,
    isAutoMode,
  ]);

  // 初回マウント時に保存データをチェック、またはテストモードの場合はテスト記事を設定
  useEffect(() => {
    // テストモードの場合は、testArticleを使用
    if (testMode) {
      console.log("🧪 テストモード: 改善されたテスト記事を設定");
      const testArticleData = {
        title: testOutline.title,
        metaDescription: `${testOutline.keyword}について詳しく解説。テスト記事です。`,
        htmlContent: testArticle,
        plainText: testArticle.replace(/<[^>]*>/g, ""), // HTMLタグを除去
        characterCount: testArticle.replace(/<[^>]*>/g, "").length,
      };
      setArticle(testArticleData);
      setEditedContent(testArticle);
      return; // テストモードの場合はここで終了
    }

    // 通常モード: 保存データをチェック
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsedData = JSON.parse(saved);
        // 24時間以内のデータのみ復元対象とする
        const saveTime = new Date(parsedData.timestamp);
        const now = new Date();
        const hoursDiff =
          (now.getTime() - saveTime.getTime()) / (1000 * 60 * 60);

        if (hoursDiff < 24) {
          setSavedData(parsedData);
          // フル自動モードの場合は復元ダイアログを表示せず、新規作成を続行
          if (!isAutoMode) {
            setShowRestoreDialog(true);
          } else {
            console.log(
              "🚀 フル自動モード: 保存データを無視して新規作成を続行"
            );
            localStorage.removeItem(STORAGE_KEY);
          }
        } else {
          // 古いデータは削除
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        console.error("保存データの読み込みに失敗:", error);
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, [STORAGE_KEY, testMode]);

  // データ復元処理
  const handleRestore = () => {
    if (savedData) {
      setArticle(savedData.article);
      setEditedContent(savedData.editedContent);
      setMultiAgentResult(savedData.multiAgentResult || null);
      setRevisedIssues(new Set(savedData.revisedIssues || []));
      setShowRestoreDialog(false);
      console.log("✅ 前回の編集内容を復元しました");
    }
  };

  // 復元をスキップ
  const handleSkipRestore = () => {
    localStorage.removeItem(STORAGE_KEY);
    setShowRestoreDialog(false);
    setSavedData(null);
  };

  useEffect(() => {
    // テストモードの場合はテスト記事を即座にセット
    if (testMode) {
      console.log("🧪 テストモード: テスト記事を即座にセット");

      // 修正サービステストモードの場合は、模擬データもインポート
      if (revisionTestMode) {
        console.log("🔧 修正サービステストモード: 模擬校閲結果を設定");
        // 動的インポートで模擬データを読み込み
        import("../utils/mockProofreadingResult").then((module) => {
          const { mockProofreadingResult, mockArticleContent } = module;

          // テスト記事をセット
          const testArticleData = {
            htmlContent: mockArticleContent,
            plainText: mockArticleContent.replace(/<[^>]*>/g, ""),
            characterCount: mockArticleContent.replace(/<[^>]*>/g, "").length,
            sections: testOutline.sections,
            title: testOutline.title,
            metaDescription: `${testOutline.keyword}について詳しく解説。テスト記事です。`,
          };

          setArticle(testArticleData);
          setEditedContent(mockArticleContent);

          // 模擬校閲結果をセット
          setMultiAgentResult(mockProofreadingResult);
          console.log(
            "✅ 模擬校閲結果をセット完了（スコア:",
            mockProofreadingResult.overallScore,
            "）"
          );

          // 親コンポーネントに記事生成完了を通知
          if (onArticleGenerated) {
            onArticleGenerated({
              title: testArticleData.title,
              metaDescription: testArticleData.metaDescription,
              htmlContent: testArticleData.htmlContent,
              plainText: testArticleData.plainText,
            });
          }
        });
      } else {
        // 通常のテストモード（最終校閲テスト）
        const testArticleData = {
          htmlContent: testArticle,
          plainText: testArticle.replace(/<[^>]*>/g, ""),
          characterCount: testArticle.replace(/<[^>]*>/g, "").length,
          sections: testOutline.sections,
          title: testOutline.title,
          metaDescription: `${testOutline.keyword}について詳しく解説。テスト記事です。`,
        };

        setArticle(testArticleData);
        setEditedContent(testArticle);

        // 親コンポーネントに記事生成完了を通知
        if (onArticleGenerated) {
          onArticleGenerated({
            title: testArticleData.title,
            metaDescription: testArticleData.metaDescription,
            htmlContent: testArticleData.htmlContent,
            plainText: testArticleData.plainText,
          });
        }
      }

      return; // 記事生成をスキップ
    }

    // 既に開始している場合はスキップ（useRefで即座にチェック）
    if (isGeneratingRef.current) {
      console.log("⚠️ 記事生成は既に開始されています（ref check）。");
      return;
    }

    // 生成中フラグもチェック
    if (isGenerating) {
      console.log("⚠️ 記事生成中です。");
      return;
    }

    // skipAutoGenerateがtrueの場合は生成をスキップ
    if (skipAutoGenerate) {
      console.log("📝 編集再開モード: 自動生成をスキップ");
      return;
    }

    // フラグを立ててから生成開始
    isGeneratingRef.current = true;
    handleGenerateArticle();
  }, [skipAutoGenerate, revisionTestMode]); // skipAutoGenerateとrevisionTestModeを依存配列に追加

  // フル自動モード: articleが設定されたら自動で最終校閲を実行
  // フル自動モードで初回記事生成時のみ最終校閲を自動実行
  const hasStartedProofreadingRef = useRef(false); // 校閲開始フラグ

  useEffect(() => {
    if (
      article &&
      isAutoMode &&
      writingMode === "v3" &&
      !isFinalProofreading &&
      !hasStartedProofreadingRef.current
    ) {
      // 初回のみ実行（自動修正後の再実行を防ぐ）
      hasStartedProofreadingRef.current = true;
      console.log(
        "📝 フル自動モード: 記事生成完了を検知、3秒後に最終校閲を開始"
      );
      const timer = setTimeout(() => {
        console.log("🚀 フル自動モード: 最終校閲を自動実行");
        handleFinalProofread();
      }, 3000); // 3秒待つ（ユーザーが記事を確認できる時間）

      return () => clearTimeout(timer); // クリーンアップ
    }
  }, [article, isAutoMode, writingMode, isFinalProofreading]); // 依存配列にarticleを含める

  // セクションの再生成
  const handleRegenerateSection = async (sectionIndex: number) => {
    if (!article || !outline.competitorResearch) return;

    const sections = outline.outline || outline.sections;
    if (!sections) return;
    const section = sections[sectionIndex];
    setRegeneratingSection(section.heading);

    try {
      const newSectionHtml = await regenerateSection(
        section.heading,
        section.subheadings || [],
        3000, // 仮の文字数
        {
          keyword,
          targetAudience: outline.targetAudience,
          frequencyWords: outline.competitorResearch.frequencyWords,
          regulation,
        }
      );

      // 該当セクションを置換（簡易的な実装）
      const updatedContent = editedContent.replace(
        new RegExp(`<h2[^>]*>${section.heading}.*?(?=<h2|</article)`, "s"),
        newSectionHtml
      );
      setEditedContent(updatedContent);

      if (article) {
        setArticle({
          ...article,
          htmlContent: updatedContent,
        });
      }
    } catch (error) {
      console.error("セクション再生成エラー:", error);
      alert("セクションの再生成に失敗しました");
    } finally {
      setRegeneratingSection(null);
    }
  };

  // ダウンロード機能
  const handleDownload = () => {
    if (!article) return;

    const content = `タイトル: ${article.title}

メタディスクリプション: ${article.metaDescription}

---

${article.plainText}`;

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${keyword.replace(/\s+/g, "_")}_article.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // HTMLダウンロード
  const handleDownloadHtml = () => {
    if (!article) return;

    const fullHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${article.metaDescription}">
  <title>${article.title}</title>
  <style>
    body { font-family: sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    h2 { color: #0066cc; margin-top: 30px; }
    h3 { color: #666; }
  </style>
</head>
<body>
  <h1>${article.title}</h1>
  ${article.htmlContent}
</body>
</html>`;

    const blob = new Blob([fullHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${keyword.replace(/\s+/g, "_")}_article.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // コピー機能
  const handleCopyHtml = () => {
    if (!article) return;
    navigator.clipboard.writeText(article.htmlContent);
    alert("HTMLコードをコピーしました");
  };

  // 最終校閲機能（マルチエージェント10エージェント版）
  const handleFinalProofread = async () => {
    console.log("🔘 最終校閲ボタンがクリックされました");
    console.log("  - article:", !!article);
    console.log("  - outline:", !!outline);

    if (!article || !outline) {
      console.log("⚠️ articleまたはoutlineが存在しないため処理を中止");
      return;
    }

    // 初回校閲の場合、カウントをリセット
    const currentCount = (window as any).__proofreadCount || 0;
    if (currentCount === 0) {
      console.log("📊 初回校閲を開始（カウントリセット）");
    } else {
      console.log(`📊 ${currentCount + 1}回目の校閲を開始`);
    }

    console.log("🤖 最終校閲開始 - 強制マルチエージェントモード");
    console.log("📊 writingMode:", writingMode);
    console.log("📊 useMultiAgent状態:", useMultiAgent);
    console.log("🔥 強制マルチエージェント有効化済み");
    setIsFinalProofreading(true);

    // Ver.3では絶対にマルチエージェントモードを使用
    // 緊急対応：一時的に常にマルチエージェントを使用
    const isV3Mode = writingMode === "v3";
    const forceMultiAgent = true; // 一時的に強制ON

    console.log("🔥 Ver.3モード?:", isV3Mode);
    console.log("📊 forceMultiAgent計算結果:", forceMultiAgent);
    console.log(
      "📊 実際の動作モード:",
      forceMultiAgent ? "マルチエージェント" : "シングルエージェント"
    );

    // Ver.3なら絶対にマルチエージェントを実行
    if (isV3Mode) {
      console.log("🚀 Ver.3モードのため、強制的にマルチエージェント実行！");
    }

    let proofResult: IntegrationResult | null = null;

    if (forceMultiAgent) {
      // マルチエージェントモード
      console.log("✅ マルチエージェントモードで実行");
      setFinalProofStatus("🤖 マルチエージェント校閲実行中...");

      try {
        const orchestrator = new MultiAgentOrchestrator({
          enableLegalCheck: true,
          parallel: true,
          timeout: 180000, // 3分（180秒）に延長
          onProgress: (message, progress) => {
            setFinalProofStatus(`${message} (${progress}%)`);
          },
        });

        const result = await orchestrator.execute(editedContent);
        proofResult = result;
        console.log("✅ マルチエージェント実行完了:", {
          overallScore: result.overallScore,
          passed: result.passed,
          criticalIssues: result.criticalIssues.length,
          majorIssues: result.majorIssues.length,
        });

        // 🔍 デバッグ：sourceInsertionsの詳細確認
        if (result.sourceInsertions && result.sourceInsertions.length > 0) {
          console.log("📍 ======= 出典配置デバッグ =======");
          console.log(`📊 出典数: ${result.sourceInsertions.length}件`);
          result.sourceInsertions.forEach((insertion, index) => {
            console.log(
              `[${index + 1}] 場所: "${insertion.location}" → URL: ${
                insertion.url
              }`
            );
          });
          console.log("📍 ================================");

          // ブラウザで簡単に確認できるように
          (window as any).debugSourceInsertions = result.sourceInsertions;
          console.log(
            "💡 ブラウザコンソールで確認: window.debugSourceInsertions"
          );
        }

        setMultiAgentResult(result);
        console.log("📝 multiAgentResultをセットしました");

        // フル自動モードの場合、Slack通知を送信
        if (isAutoMode) {
          await slackNotifier.notifyStepComplete({
            keyword: keyword,
            step: "final",
            score: result.overallScore,
          });
        }

        // 結果を表示
        const message = `
========================================
🤖 マルチエージェント校閲完了
========================================

📊 総合スコア: ${result.overallScore}/100点
判定: ${result.passed ? "✅ 合格" : "❌ 要修正"}

【スコア内訳】
• ファクトチェック: ${result.regulationScore.factChecking}/45点
• 信頼性・引用: ${result.regulationScore.reliability}/25点
• 構成ルール: ${result.regulationScore.structureRules}/18点
• 法的コンプライアンス: ${result.regulationScore.legalCompliance}/7点
• 総合品質: ${result.regulationScore.overallQuality}/5点

【検出された問題】
• 重大: ${result.criticalIssues.length}件
• 主要: ${result.majorIssues.length}件
• 軽微: ${result.minorIssues.length}件

${
  result.criticalIssues.length > 0
    ? `
🔴 重大な問題（必ず修正）:
${result.criticalIssues
  .map(
    (issue, idx) =>
      `${idx + 1}. [${issue.agentName}] ${issue.description}
   場所: ${issue.location || "不明"}
   原文: "${issue.original || "-"}"
   提案: "${issue.suggestion || "-"}"`
  )
  .join("\n\n")}`
    : ""
}

${
  result.majorIssues.length > 0
    ? `
🟡 主要な問題（修正推奨）:
${result.majorIssues
  .slice(0, 5)
  .map(
    (issue, idx) =>
      `${idx + 1}. [${issue.agentName}] ${issue.description}
   場所: ${issue.location || "不明"}
   提案: "${issue.suggestion || "-"}"`
  )
  .join("\n\n")}
${
  result.majorIssues.length > 5 ? `...他${result.majorIssues.length - 5}件` : ""
}`
    : ""
}

【改善提案】
${
  result.improvementPlan
    ? result.improvementPlan
        .slice(0, 3)
        .map((plan, idx) => `${idx + 1}. ${plan}`)
        .join("\n")
    : "改善提案なし"
}

【実行サマリー】
• 成功: ${result.executionSummary.successfulAgents}エージェント
• 失敗: ${result.executionSummary.failedAgents}エージェント
• 実行時間: ${result.executionSummary.totalTime}ms

推奨: ${
          result.recommendation === "publish"
            ? "✅ 公開可能"
            : result.recommendation === "revise"
            ? "⚠️ 修正推奨"
            : "❌ 大幅な修正が必要"
        }
========================================
        `;

        console.log(message);
        setFinalProofStatus(message);

        // フルオート/セミオートの処理
        // 修正が必要な問題があるかチェック
        const hasIssues =
          (result.criticalIssues?.length || 0) > 0 ||
          (result.majorIssues?.length || 0) > 0 ||
          (result.minorIssues?.length || 0) > 0;

        if (autoMode === "semi-auto" && hasIssues) {
          const shouldAutoRevise = result.overallScore >= 60;

          if (shouldAutoRevise) {
            const confirmRevise = confirm(
              `🤖 自動修正を実行しますか？\n\n` +
                `総合スコア: ${result.overallScore}/100点\n` +
                `重大な問題: ${result.criticalIssues.length}件\n` +
                `主要な問題: ${result.majorIssues.length}件`
            );

            if (!confirmRevise) {
              setAutoFlowProgress({
                isRunning: false,
                currentStep: "idle",
                percentage: 0,
                message: "",
              });
              return;
            }

            await executeAutoRevision(result, editedContent);
          } else {
            console.log(
              `⚠️ 自動修正をスキップ\n` +
                `総合スコア: ${result.overallScore}/100点\n` +
                `セミオート自動修正は60点以上で実行します。`
            );
          }
        } else if (result.passed) {
          // 手動モードの場合のみアラート表示
          if (autoMode === "manual") {
            alert(
              `✅ マルチエージェント校閲完了！\n\n総合スコア: ${result.overallScore}/100点\n\n記事は公開可能な品質です。`
            );
          } else {
            console.log(
              `✅ マルチエージェント校閲完了！ スコア: ${result.overallScore}/100点`
            );
          }
        } else if (autoMode === "manual") {
          alert(
            `⚠️ マルチエージェント校閲完了\n\n総合スコア: ${result.overallScore}/100点\n\n${result.criticalIssues.length}件の重大な問題が検出されました。修正が必要です。`
          );
        }
      } catch (error) {
        console.error("❌ マルチエージェントエラー:", error);
        setFinalProofStatus(
          `エラー: ${error instanceof Error ? error.message : "不明なエラー"}`
        );
        alert(
          `❌ エラーが発生しました\n\n${
            error instanceof Error ? error.message : "不明なエラー"
          }`
        );
      }
    } else {
      // 従来のシングルエージェントモード
      setFinalProofStatus("OpenAI APIで校閲中...");

      try {
        // 最終校閲を実行
        const result = await performFinalProofread({
          article: editedContent,
          outline: JSON.stringify(outline),
          keyword: keyword,
          enableWebSearch: true,
          enableDeepFactCheck: true,
          targetScore: 95,
        });

        console.log("📊 最終校閲結果:", result);

        // 結果を表示
        if (result.finalArticle) {
          // 修正された記事を反映
          setEditedContent(result.finalArticle);
          console.log("✅ 記事が自動修正されました");
        }

        // スコアと結果を表示
        const resultMessage = `
========================================
🤖 最終校閲完了 (GPT-5)
========================================

📊 総合スコア: ${result.overallScore}/100

【詳細スコア】
• SEO最適化: ${result.scores.seo}/100
• 読みやすさ: ${result.scores.readability}/100
• 正確性: ${result.scores.accuracy}/100
• 構造: ${result.scores.structure}/100
• 価値: ${result.scores.value}/100

【検出された問題】
${
  result.issues
    .map((issue) => `• [${issue.severity}] ${issue.description}`)
    .join("\n") || "問題は検出されませんでした"
}

【ファクトチェック結果】
${
  result.factCheckResults
    ?.map(
      (item) =>
        `• ${item.claim}
  判定: ${item.verdict} (信頼度: ${item.confidence}%)`
    )
    .join("\n\n") || "ファクトチェック結果なし"
}

【変更履歴】
${
  result.changeLog
    ?.map(
      (log) =>
        `• ${log.original} → ${log.corrected}
  理由: ${log.reason}`
    )
    .join("\n\n") || "変更なし"
}

========================================
        `;

        console.log(resultMessage);
        setFinalProofStatus(resultMessage);

        // 成功メッセージ（旧エージェントは使用されないため削除）
        // console.log(`🤖 最終校閲完了！ スコア: ${result.overallScore}/100`);
      } catch (error) {
        console.error("❌ 最終校閲エラー:", error);
        setFinalProofStatus(
          `エラー: ${error instanceof Error ? error.message : "不明なエラー"}`
        );
        alert(
          `❌ エラーが発生しました\n\n${
            error instanceof Error ? error.message : "不明なエラー"
          }\n\nAPIキーが正しく設定されているか確認してください。`
        );
      }
    }

    setIsFinalProofreading(false);

    if ((useMultiAgent || writingMode === "v3") && proofResult) {
      await handleAutoModeAfterProof(proofResult);
    }
  };

  // 個別問題の修正処理
  const handleSingleIssueRevision = async (issue: Issue) => {
    if (isRevising) return; // 修正中の場合は処理しない

    // 一意のIDを生成（エージェント名と説明から）
    const issueId = `${issue.agentName}-${issue.description}`;

    console.log(`🔧 個別修正開始: ${issue.description}`);

    // デバッグ: 問題の詳細を確認
    console.log("📋 問題の詳細確認:");
    const safeOriginal = getSafeOriginal(issue);
    console.log(
      "  - original:",
      safeOriginal ? `"${safeOriginal.slice(0, 100)}..."` : "N/A (原文なし)"
    );
    console.log("  - suggestion:", issue.suggestion || "⚠️ 提案なし");
    console.log("  - location:", issue.location || "⚠️ 場所不明");
    console.log("  - type:", issue.type);
    console.log("  - severity:", issue.severity);

    setIsRevising(true);
    setRevisingIssueId(issueId); // 現在修正中の課題をセット
    setRevisionProgress(`${issue.description} を修正中...`);

    try {
      console.log("📤 修正サービスを呼び出し中...");
      const revisedArticle = await reviseSpecificIssue({
        originalArticle: editedContent,
        issue: issue,
      });

      // デバッグ: 修正結果を確認
      console.log("📥 修正サービスからの応答:");
      console.log(
        "  - 応答の長さ:",
        revisedArticle ? revisedArticle.length : 0
      );
      console.log(
        "  - 空かどうか:",
        !revisedArticle || revisedArticle.length === 0
      );

      if (!revisedArticle || revisedArticle.length === 0) {
        console.error("❌ 修正結果が空です！");
        throw new Error("修正サービスから空の結果が返されました");
      }

      // 修正前後の比較
      if (editedContent === revisedArticle) {
        console.warn(
          "⚠️ 修正前後で記事内容が全く同じです！修正が適用されていない可能性があります。"
        );
      } else {
        console.log("✅ 記事内容に変更があります");
        console.log(`  - 変更前: ${editedContent.length}文字`);
        console.log(`  - 変更後: ${revisedArticle.length}文字`);
        console.log(
          `  - 差分: ${revisedArticle.length - editedContent.length}文字`
        );
      }

      // クリーンアップ処理を適用
      const cleanedArticle = cleanupArticleContent(revisedArticle);
      console.log("✨ 個別修正後のクリーンアップ完了");

      setEditedContent(cleanedArticle);
      if (article) {
        const updatedArticle = {
          ...article,
          htmlContent: cleanedArticle,
          plainText: cleanedArticle.replace(/<[^>]*>/g, ""),
        };
        setArticle(updatedArticle);

        // 親コンポーネント（ArticleDisplay）に修正後の記事を通知
        if (onArticleGenerated) {
          onArticleGenerated({
            title: updatedArticle.title,
            metaDescription: updatedArticle.metaDescription,
            htmlContent: updatedArticle.htmlContent,
            plainText: updatedArticle.plainText,
          });
        }
      }

      // 修正済みリストに追加
      setRevisedIssues((prev) => new Set([...prev, issueId]));

      // 修正完了後、すぐに保存
      const dataToSave = {
        article: cleanedArticle, // cleanedArticleが正しい変数名
        editedContent: cleanedArticle,
        multiAgentResult,
        revisedIssues: Array.from(new Set([...revisedIssues, issueId])),
        timestamp: new Date().toISOString(),
        keyword,
        outline: outline || null,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
      console.log("✅ 修正完了後、記事を保存しました");

      console.log(`✅ 修正完了: ${issue.description}`);
      setRevisionProgress("修正が完了しました");
      setTimeout(() => setRevisionProgress(""), 3000);
    } catch (error) {
      console.error("❌ 修正エラー詳細:", error);
      console.error(
        "エラースタック:",
        error instanceof Error ? error.stack : "スタックなし"
      );

      // エラーの詳細を表示
      const errorMessage =
        error instanceof Error ? error.message : "不明なエラー";
      const detailedError = `修正に失敗しました。\n\n【エラー内容】\n${errorMessage}\n\n【問題の詳細】\n- 原文: ${
        issue.original ? "あり" : "なし"
      }\n- 提案: ${
        issue.suggestion ? "あり" : "なし"
      }\n\nコンソールログで詳細を確認してください。`;

      alert(`❌ ${detailedError}`);
      setRevisionProgress("");
    } finally {
      setIsRevising(false);
      setRevisingIssueId(null); // 修正中の課題をクリア
    }
  };

  // 🔧 自動修正実行関数（新しい3段階ロジック）
  const executeAutoRevision = async (
    proofreadResult: IntegrationResult,
    articleContent: string = editedContent,
    scoreType: "high-score" | "mid-score" | number = 0
  ) => {
    console.log(`🔧 自動修正を開始します...`);
    console.log(`📊 現在のスコア: ${proofreadResult.overallScore}点`);
    console.log(`🎯 処理タイプ: ${scoreType}`);

    const criticalCount = proofreadResult.criticalIssues.length;
    const majorCount = proofreadResult.majorIssues.length;
    const totalProblems = criticalCount + majorCount;

    if (totalProblems === 0) {
      console.log("✅ 修正すべき問題がありません");

      // スコアタイプに応じて分岐
      if (scoreType === "high-score") {
        // 75点以上: 問題なしなら直接画像生成
        console.log("🎨 75点以上で問題なし → 画像生成へ");
        await startImageGeneration(
          proofreadResult.overallScore,
          keyword,
          article,
          outline,
          articleContent,
          onAutoComplete,
          onOpenImageAgent
        );
      } else {
        // 70-74点: 問題なしでも再校閲が必要
        console.log("📋 70-74点で問題なし → 再校閲を実行");
        await performReProofread(articleContent, scoreType, 0);
      }
      return;
    }

    console.log(
      `🔍 修正対象: 重大${criticalCount}件 + 主要${majorCount}件 = 計${totalProblems}件`
    );

    // 進捗更新
    const progressMessage =
      scoreType === "high-score"
        ? `自動修正中（75点以上）- ${totalProblems}件の問題を修正`
        : `自動修正中（70-74点）- ${totalProblems}件の問題を修正`;

    setAutoFlowProgress({
      isRunning: true,
      currentStep: "revising",
      percentage: 50,
      message: progressMessage,
    });

    let currentArticle = articleContent;
    let totalProcessed = 0;
    const BATCH_SIZE = 10; // 10件ずつ処理

    try {
      // Step 1: 重大な問題を修正
      if (criticalCount > 0) {
        console.log(`\n🔴 重大な問題${criticalCount}件を修正開始`);
        let processedCount = 0;
        // 10件ずつバッチ処理
        while (processedCount < criticalCount) {
          const batchStart = processedCount;
          const batchEnd = Math.min(processedCount + BATCH_SIZE, criticalCount);
          const currentBatch = proofreadResult.criticalIssues.slice(
            batchStart,
            batchEnd
          );
          const batchNumber = Math.floor(processedCount / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(criticalCount / BATCH_SIZE);

          console.log(
            `🔄 重大バッチ ${batchNumber}/${totalBatches}: ${currentBatch.length}件を修正中...`
          );

          // 進捗更新
          const scoreLabel =
            scoreType === "high-score" ? "75点以上" : "70-74点";
          setAutoFlowProgress({
            isRunning: true,
            currentStep: "revising",
            percentage: 50 + Math.floor((totalProcessed / totalProblems) * 20),
            message: `重大な問題を自動修正中（${scoreLabel}）- (${
              batchStart + 1
            }-${batchEnd}/${criticalCount}件)`,
          });

          // 一括修正を実行
          const revisedArticle = await reviseBatchIssues({
            originalArticle: currentArticle,
            issues: currentBatch,
            category: "critical",
            detailedReport: proofreadResult.detailedReport,
            sourceInsertions: proofreadResult.sourceInsertions,
            keyword: keyword,
          });

          // クリーンアップ処理
          currentArticle = cleanupArticleContent(revisedArticle);
          processedCount = batchEnd;
          totalProcessed += currentBatch.length;

          console.log(`✅ 重大バッチ ${batchNumber}/${totalBatches} 完了`);
        }
      }

      // Step 2: 主要な問題を修正
      if (majorCount > 0) {
        console.log(`\n🟡 主要な問題${majorCount}件を修正開始`);
        let processedCount = 0;
        // 10件ずつバッチ処理
        while (processedCount < majorCount) {
          const batchStart = processedCount;
          const batchEnd = Math.min(processedCount + BATCH_SIZE, majorCount);
          const currentBatch = proofreadResult.majorIssues.slice(
            batchStart,
            batchEnd
          );
          const batchNumber = Math.floor(processedCount / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(majorCount / BATCH_SIZE);

          console.log(
            `🔄 主要バッチ ${batchNumber}/${totalBatches}: ${currentBatch.length}件を修正中...`
          );

          // 進捗更新
          const scoreLabel =
            scoreType === "high-score" ? "75点以上" : "70-74点";
          setAutoFlowProgress({
            isRunning: true,
            currentStep: "revising",
            percentage: 60 + Math.floor((totalProcessed / totalProblems) * 20),
            message: `主要な問題を自動修正中（${scoreLabel}）- (${
              batchStart + 1
            }-${batchEnd}/${majorCount}件)`,
          });

          // 一括修正を実行
          const revisedArticle = await reviseBatchIssues({
            originalArticle: currentArticle,
            issues: currentBatch,
            category: "major",
            detailedReport: proofreadResult.detailedReport,
            sourceInsertions: proofreadResult.sourceInsertions,
            keyword: keyword,
          });

          // クリーンアップ処理
          currentArticle = cleanupArticleContent(revisedArticle);
          processedCount = batchEnd;
          totalProcessed += currentBatch.length;

          console.log(`✅ 主要バッチ ${batchNumber}/${totalBatches} 完了`);
        }
      }

      // 修正完了後、記事を更新
      setEditedContent(currentArticle);
      if (article) {
        const updatedArticle = {
          ...article,
          htmlContent: currentArticle,
          plainText: currentArticle.replace(/<[^>]*>/g, ""),
        };
        setArticle(updatedArticle);

        // 自動修正結果をArticleDisplayに反映
        if (onArticleGenerated) {
          onArticleGenerated({
            title: updatedArticle.title,
            metaDescription: article.metaDescription,
            htmlContent: currentArticle,
            plainText: currentArticle.replace(/<[^>]*>/g, ""),
            characterCount: currentArticle.replace(/<[^>]*>/g, "").length,
          });
          console.log("📤 自動修正結果をArticleDisplayに反映");
        }
      }

      console.log(`✅ 修正完了`);
      console.log(`• 重大な問題: ${criticalCount}件修正`);
      console.log(`• 主要な問題: ${majorCount}件修正`);

      // 🎯 修正後の分岐処理
      if (scoreType === "high-score") {
        // ✅ 75点以上: 修正 → 画像生成
        console.log("🎨 75点以上の修正完了 → 画像生成へ進みます");

        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: "✅ 修正完了（75点以上）→ 画像生成へ",
        });

        await startImageGeneration(
          proofreadResult.overallScore,
          keyword,
          article,
          outline,
          currentArticle,
          onAutoComplete,
          onOpenImageAgent
        );
        return;
      } else if (scoreType === "mid-score") {
        // ⚠️ 70-74点: 修正 → 再校閲
        console.log("📋 70-74点の修正完了 → 再校閲を実行します");
        await performReProofread(currentArticle, scoreType, 0);
        return;
      }
    } catch (error) {
      console.error(`❌ 自動修正エラー:`, error);

      setAutoFlowProgress({
        isRunning: false,
        currentStep: "idle",
        percentage: 0,
        message: "エラーが発生しました",
      });

      alert(
        `❌ 自動修正中にエラーが発生しました\n\n` +
          `${error instanceof Error ? error.message : "不明なエラー"}\n\n` +
          `手動で修正してください。`
      );
    }
  };

  // � 修校正処理のみを実行する関数
  const performAutoRevision = async (
    proofResult: IntegrationResult,
    articleContent: string,
    retryCount: number
  ) => {
    console.log(`🔧 自動修正を実行中... (${retryCount + 1}回目)`);

    setAutoFlowProgress({
      isRunning: true,
      currentStep: "revising",
      percentage: 60 + retryCount * 5,
      message: `修正中... (${retryCount + 1}回目)`,
    });

    try {
      // 批判的・重大な問題を優先的に修正
      const criticalIssues = [
        ...(proofResult.criticalIssues || []),
        ...(proofResult.majorIssues || []),
      ];

      if (criticalIssues.length === 0) {
        console.log("⚠️ 修正対象の問題が見つかりませんでした");

        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: "修正対象なし",
        });
        return;
      }

      // 最初の問題を修正
      const firstIssue = criticalIssues[0];
      console.log(`🔧 問題を修正中: ${firstIssue.description}`);

      const revisedContent = await reviseSpecificIssue({
        originalArticle: articleContent,
        issue: firstIssue,
      });

      if (revisedContent && revisedContent.trim() !== articleContent.trim()) {
        setArticle(revisedContent);
        console.log(`✅ 修正完了 (${retryCount + 1}回目) → 再校閲を実行`);

        // 修正後に再校閲を実行
        await performReProofread(revisedContent, "mid-score", retryCount);
      } else {
        console.log("⚠️ 修正内容が変更されませんでした");

        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: "修正内容なし",
        });
      }
    } catch (error) {
      console.error(`❌ 修正エラー (${retryCount + 1}回目):`, error);

      setAutoFlowProgress({
        isRunning: false,
        currentStep: "idle",
        percentage: 0,
        message: "エラーが発生しました",
      });

      alert(
        `❌ 修正中にエラーが発生しました (${retryCount + 1}回目)\n\n` +
          `${error instanceof Error ? error.message : "不明なエラー"}\n\n` +
          `手動で修正してください。`
      );
    }
  };

  // 🔄 再校閲実行関数（70-74点用のループ処理）
  const performReProofread = async (
    articleContent: string,
    scoreType: "mid-score" | string,
    retryCount: number = 0
  ) => {
    const MAX_RETRIES = 3; // 最大3回まで修正→再校閲を繰り返す

    console.log(`📋 再校閲を実行中... (${retryCount + 1}回目)`);

    setAutoFlowProgress({
      isRunning: true,
      currentStep: "proofreading",
      percentage: 70 + retryCount * 10,
      message: `再校閲中... (${retryCount + 1}/${MAX_RETRIES}回目)`,
    });

    try {
      // マルチエージェント校閲を実行
      const orchestrator = new MultiAgentOrchestrator({
        enableLegalCheck: true,
        timeout: 180000, // 3分
        onProgress: (message, progress) => {
          setAutoFlowProgress({
            isRunning: true,
            currentStep: "proofreading",
            percentage: 70 + retryCount * 10 + Math.floor(progress / 10),
            message: `${message} (${retryCount + 1}回目)`,
          });
        },
      });

      const reCheckResult = await orchestrator.execute(articleContent);
      console.log(
        `📊 再校閲結果 (${retryCount + 1}回目): ${reCheckResult.overallScore}点`
      );

      // 🎯 再校閲後の判定
      if (reCheckResult.overallScore >= 75) {
        // ✅ 75点以上 → 画像生成へ
        console.log(
          `🎉 再校閲で75点達成！ スコア${reCheckResult.overallScore}点で画像生成へ進みます`
        );

        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: `✅ 再校閲成功 (${reCheckResult.overallScore}点)`,
        });

        await startImageGeneration(
          reCheckResult.overallScore,
          keyword,
          article,
          outline,
          articleContent,
          onAutoComplete,
          onOpenImageAgent
        );
        return;
      } else if (
        reCheckResult.overallScore >= 70 &&
        retryCount < MAX_RETRIES - 1
      ) {
        // ⚠️ 70-74点 & まだリトライ可能 → 再度修正
        console.log(
          `⚠️ スコア${
            reCheckResult.overallScore
          }点のため、再度修正を実行します (${
            retryCount + 2
          }/${MAX_RETRIES}回目)`
        );

        // 修正処理を実行してから再校閲を継続
        await performAutoRevision(
          reCheckResult,
          articleContent,
          retryCount + 1
        );
        return;
      } else {
        // ❌ 70点未満 または リトライ上限 → 修正失敗
        console.log(
          `❌ ${
            retryCount + 1
          }回の修正→再校閲でも75点に達しませんでした (最終スコア: ${
            reCheckResult.overallScore
          }点)`
        );

        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: `⚠️ 修正完了 (${reCheckResult.overallScore}点 - 目標未達成)`,
        });

        alert(
          `⚠️ ${
            retryCount + 1
          }回の修正→再校閲を実行しましたが、目標スコア75点に達しませんでした。\n\n` +
            `最終スコア: ${reCheckResult.overallScore}点\n\n` +
            `手動で追加修正を行うか、現在の状態で画像生成に進むことができます。`
        );

        // 手動再校閲または画像生成の選択肢を提供
        const userChoice = window.confirm(
          `最終スコア${reCheckResult.overallScore}点（75点未満）です。\n\n` +
            `OK: 手動で再校閲を行う\n` +
            `キャンセル: 現在の状態で画像生成に進む`
        );

        if (userChoice) {
          // 手動再校閲を行う場合
          console.log("✏️ 手動再校閲モードに切り替え");
          setIsFinalProofreading(false);
          setAutoMode("manual");
        } else {
          // 画像生成に進む
          console.log("🎨 スコア未達成だが画像生成に進みます");
          await startImageGeneration(
            reCheckResult.overallScore,
            keyword,
            article,
            outline,
            articleContent,
            onAutoComplete,
            onOpenImageAgent
          );
        }

        if (onAutoComplete) {
          onAutoComplete();
        }
        return;
      }
    } catch (error) {
      console.error(`❌ 再校閲エラー (${retryCount + 1}回目):`, error);

      setAutoFlowProgress({
        isRunning: false,
        currentStep: "idle",
        percentage: 0,
        message: "エラーが発生しました",
      });

      alert(
        `❌ 再校閲中にエラーが発生しました (${retryCount + 1}回目)\n\n` +
          `${error instanceof Error ? error.message : "不明なエラー"}\n\n` +
          `手動で修正してください。`
      );
    }
  };

  const handleAutoModeAfterProof = async (proofResult: IntegrationResult) => {
    if (!isAutoMode) {
      return;
    }

    const criticalCount = proofResult.criticalIssues?.length || 0;
    const majorCount = proofResult.majorIssues?.length || 0;
    const minorCount = proofResult.minorIssues?.length || 0;
    const issueCount = criticalCount + majorCount + minorCount;
    const hasIssues = issueCount > 0;

    if (autoMode === "semi-auto") {
      if (!hasIssues) {
        setAutoFlowProgress({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: "校閲完了（修正不要）",
        });
      }
      return;
    }

    if (autoMode !== "full-auto") {
      if (!hasIssues) {
        setAutoFlowProgress((prev) => ({
          isRunning: false,
          currentStep: "completed",
          percentage: 100,
          message: "校閲完了",
        }));
      }
      return;
    }

    setAutoFlowProgress((prev) => ({
      isRunning: true,
      currentStep: "analyzing",
      percentage: Math.max(prev.percentage, 55),
      message: hasIssues ? "校閲結果を分析中..." : "修正は不要です",
    }));

    // 🎯 新しいロジック: スコアベースの3段階判定
    console.log(`📊 初回校閲結果: ${proofResult.overallScore}点`);

    if (proofResult.overallScore >= 75) {
      // ✅ 75点以上: 修正 → 画像生成
      console.log(
        `🎉 スコア${proofResult.overallScore}点（75点以上）: 修正後に画像生成へ進みます`
      );

      if (onAutoRevisionStart) {
        onAutoRevisionStart();
      }
      await executeAutoRevision(proofResult, editedContent, "high-score");
      return;
    } else if (proofResult.overallScore >= 70) {
      // ⚠️ 70-74点: 修正 → 再校閲 → 判定ループ
      console.log(
        `⚠️ スコア${proofResult.overallScore}点（70-74点）: 修正→再校閲ループを開始します`
      );

      if (onAutoRevisionStart) {
        onAutoRevisionStart();
      }
      await executeAutoRevision(proofResult, editedContent, "mid-score");
      return;
    } else {
      // ❌ 70点未満: 何もしない
      console.log(
        `❌ スコア${proofResult.overallScore}点（70点未満）: 自動修正を実行しません`
      );

      setAutoFlowProgress({
        isRunning: false,
        currentStep: "completed",
        percentage: 100,
        message: `校閲完了（スコア${proofResult.overallScore}点 - 修正対象外）`,
      });

      alert(
        `📊 校閲完了\n\n` +
          `スコア: ${proofResult.overallScore}点（70点未満）\n\n` +
          `自動修正の対象外です。手動で修正を行ってください。`
      );

      if (onAutoComplete) {
        onAutoComplete();
      }
      return;
    }

    try {
      if (onAutoComplete) {
        await onAutoComplete();
      }
      console.log("✅ フル自動モード: 合格スコアで完了");
    } catch (error) {
      console.error("❌ onAutoComplete実行エラー:", error);
    }
  };

  // 新機能統合テスト関数
  const handleTestAllFeatures = async () => {
    console.log("🧪 === 新機能統合テスト開始 ===");

    // テスト用の記事とアウトラインを自動生成
    const testKeyword = "AI 研修";
    const testOutline = {
      title: "AI研修の導入で業務効率化を実現する方法",
      metaDescription:
        "AI研修の導入により業務効率化を実現する方法を解説。成功事例や費用、選び方のポイントまで詳しく紹介します。",
      sections: [
        {
          h2: "AI研修とは？基本概念と重要性",
          h3: ["AI研修の定義と目的", "なぜ今AI研修が必要なのか"],
        },
        {
          h2: "おすすめのAI研修サービス",
          h3: ["実践的なカリキュラム", "導入企業の成功事例"],
        },
        {
          h2: "まとめ：AI研修で組織を変革する",
          h3: [],
        },
      ],
    };

    const testArticle = {
      title: testOutline.title,
      metaDescription: testOutline.metaDescription,
      content: `
<h2>AI研修とは？基本概念と重要性</h2>
<p>AI研修は、人工知能技術を<b>実務で活用するためのスキル</b>を身につける教育プログラムです。ChatGPTやClaudeなどの生成AIツールを使いこなし、業務効率を大幅に向上させることが目的です。</p>

<h3>AI研修の定義と目的</h3>
<p>AI研修とは、<b>AIツールの基本操作から実践的な活用方法</b>まで体系的に学ぶ研修プログラムです。プロンプトエンジニアリングやAPI連携など、実務に直結するスキルを習得します。</p>

<h3>なぜ今AI研修が必要なのか</h3>
<p>2024年現在、<b>企業の約70%がAI導入を検討</b>しています。競争優位性を保つためには、全社員のAIリテラシー向上が不可欠となっています。</p>

<h2>おすすめのAI研修サービス</h2>
<p>実践的なAI研修サービスでは、<b>企業のDXを効果的に支援</b>します。豊富な導入実績と高い満足度を誇る研修プログラムを選ぶことが重要です。</p>

<h3>実践的なカリキュラム</h3>
<p>座学だけでなく、<b>実際の業務シーンを想定した演習</b>を多数用意。受講者は研修終了後すぐに現場でAIを活用できるようになります。</p>

<h3>導入企業の成功事例</h3>
<p>導入企業では<b>LP制作費を10万円から0円に削減</b>した事例や、原稿執筆時間を大幅に短縮するなど、劇的な成果を実現しています。</p>

<h2>まとめ：AI研修で組織を変革する</h2>
<p>AI研修は単なるツールの使い方講座ではありません。<b>組織全体の生産性を飛躍的に向上させる投資</b>です。実践的な研修プログラムを導入して、貴社のDXを加速させましょう。まずは無料相談から始めてみませんか。</p>
`,
      plainText: "テスト記事のプレーンテキスト版です。",
    };

    // テスト用データを設定
    setKeyword(testKeyword);
    setOutline(testOutline as any);
    setArticle(testArticle as any);
    setEditedContent(testArticle.content);

    console.log("✅ テスト用記事を設定しました");
    console.log("  キーワード:", testKeyword);
    console.log("  タイトル:", testArticle.title);
    console.log("  H2数:", testOutline.sections.length);

    // 少し待ってから処理を続行
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      // Step 1: slug生成テスト
      console.log("\n📝 Step 1: Slug生成テスト");
      const { generateSlug } = await import("../services/slugGenerator");
      const testSlug = await generateSlug(keyword);
      console.log(`  キーワード: "${keyword}" → Slug: "${testSlug}"`);

      // Step 2: 最終校閲はスキップ（時間短縮のため）
      console.log(
        "\n🤖 Step 2: マルチエージェント校閲をスキップ（テストのため）"
      );
      const mockMultiAgentResult = {
        overallScore: 85,
        passed: true,
        criticalIssues: [],
        majorIssues: [],
      };
      setMultiAgentResult(mockMultiAgentResult as any);
      console.log("  モックスコア: 85点（合格）");

      // Step 3: 画像生成エージェントへのデータ送信準備
      console.log("\n🖼️ Step 3: 画像生成エージェントへのデータ準備");
      const spreadsheetRow = localStorage.getItem("currentSpreadsheetRow");
      const imageGenData = {
        keyword: keyword,
        title: article?.title || "",
        metaDescription: outline?.metaDescription || "",
        slug: testSlug,
        htmlContent: editedContent,
        plainText: editedContent.replace(/<[^>]*>/g, ""),
        outline: outline,
        score: multiAgentResult?.overallScore || 0,
        timestamp: new Date().toISOString(),
        autoExecute: true, // 自動実行フラグを追加
        spreadsheetRow: spreadsheetRow ? parseInt(spreadsheetRow) : null, // スプレッドシート行番号を追加
      };

      console.log("  送信データ:");
      console.log("    - キーワード:", imageGenData.keyword);
      console.log("    - タイトル:", imageGenData.title);
      console.log(
        "    - メタディスクリプション:",
        imageGenData.metaDescription?.substring(0, 50) + "..."
      );
      console.log("    - Slug:", imageGenData.slug);
      console.log(
        "    - HTMLコンテンツ長:",
        imageGenData.htmlContent.length,
        "文字"
      );
      console.log(
        "    - プレーンテキスト長:",
        imageGenData.plainText.length,
        "文字"
      );
      console.log("    - スコア:", imageGenData.score);
      console.log("    - 自動実行:", imageGenData.autoExecute);

      // Step 4: 画像生成エージェントを開く
      console.log(
        "\n🚀 Step 4: 画像生成エージェントを起動（自動フローモード）"
      );

      // localStorageに保存
      localStorage.setItem(
        "articleDataForImageGen",
        JSON.stringify(imageGenData)
      );
      console.log("  ✅ localStorageにデータ保存完了");

      // 🌐 画像生成エージェントを開く（iframe版）
      if (onOpenImageAgent) {
        console.log("  🖼️ 画像生成エージェントをiframeで開きます...");
        onOpenImageAgent({
          title: imageGenData.title,
          content: imageGenData.htmlContent,
          keyword: imageGenData.keyword,
          autoMode: true,
          metaDescription: imageGenData.metaDescription,
          slug: imageGenData.slug,
          isTestMode: false, // テスト用ボタンだが自動実行
          plainText: imageGenData.plainText,
          score: imageGenData.score,
          spreadsheetRow: imageGenData.spreadsheetRow || undefined,
        });

        console.log("\n✨ === テスト完了 ===");
        console.log("画像生成エージェントで以下の自動フローが実行されます:");
        console.log("  1. 画像自動生成");
        console.log("  2. WordPress画像アップロード（3秒後）");
        console.log("  3. WordPress記事投稿（2秒後）");
        console.log("  4. Slug自動設定");
      } else {
        // フォールバック: 別タブで開く
        const activeClientId = getActiveClientId();
        if (!activeClientId) {
          console.warn("⚠️ clientId が未選択の状態で画像生成エージェントを起動します");
        }
        const urlWithClient = buildImageGenUrl(activeClientId);
        const newWindow = window.open(urlWithClient, "_blank");

        if (newWindow) {
          setTimeout(() => {
            console.log("  📤 postMessageでデータ送信中...");
            newWindow.postMessage(
              {
                type: "ARTICLE_DATA",
                clientId: activeClientId,
                data: imageGenData,
              },
              getImageGenOrigin()
            );
            console.log("  ✅ データ送信完了");
          }, 2000);
        } else {
          console.error("❌ 新しいタブを開けませんでした");
          alert(
            "❌ ポップアップがブロックされました。ブラウザ設定を確認してください。"
          );
        }
      }
    } catch (error) {
      console.error("❌ テスト中にエラー:", error);
      alert(
        `❌ テストエラー: ${
          error instanceof Error ? error.message : "不明なエラー"
        }`
      );
    }
  };

  // カテゴリ一括修正処理
  const handleBatchRevision = async (category: "critical" | "major") => {
    if (!multiAgentResult || isRevising) return;

    const allIssues =
      category === "critical"
        ? multiAgentResult.criticalIssues
        : multiAgentResult.majorIssues;

    // 既に修正済みの問題を除外
    const unrevvisedIssues = allIssues.filter((issue) => {
      const issueId = `${issue.agentName}-${issue.description}`;
      return !revisedIssues.has(issueId);
    });

    if (unrevvisedIssues.length === 0) {
      alert(
        `${
          category === "critical" ? "重大な" : "主要な"
        }未修正の問題はありません。`
      );
      return;
    }

    // 10件制限の通知
    const issuesToProcess = unrevvisedIssues.slice(0, 10);
    const remainingCount = unrevvisedIssues.length - issuesToProcess.length;

    if (remainingCount > 0) {
      console.log(
        `⚠️ 10件制限により、${unrevvisedIssues.length}件中${issuesToProcess.length}件を処理します。残り${remainingCount}件は次回処理してください。`
      );
      setRevisionProgress(
        `${category === "critical" ? "重大な" : "主要な"}問題 ${
          unrevvisedIssues.length
        }件中${issuesToProcess.length}件を修正中...（残り${remainingCount}件）`
      );
    } else {
      console.log(`🔧 一括修正開始: ${category} (${issuesToProcess.length}件)`);
      setRevisionProgress(
        `${category === "critical" ? "重大な" : "主要な"}問題 ${
          issuesToProcess.length
        }件を修正中...`
      );
    }

    setIsRevising(true);

    try {
      const revisedArticle = await reviseBatchIssues({
        originalArticle: editedContent,
        issues: issuesToProcess, // 未修正の問題のみを送信
        category: category,
        detailedReport: multiAgentResult.detailedReport,
        sourceInsertions: multiAgentResult.sourceInsertions, // 構造化された出典データを追加
        keyword: keyword, // キーワードを追加
      });

      // クリーンアップ処理を適用
      const cleanedArticle = cleanupArticleContent(revisedArticle);
      console.log("✨ 一括修正後のクリーンアップ完了");

      setEditedContent(cleanedArticle);
      if (article) {
        const updatedArticle = {
          ...article,
          htmlContent: cleanedArticle,
          plainText: cleanedArticle.replace(/<[^>]*>/g, ""),
        };
        setArticle(updatedArticle);

        // 親コンポーネント（ArticleDisplay）に修正後の記事を通知
        if (onArticleGenerated) {
          onArticleGenerated({
            title: updatedArticle.title,
            metaDescription: updatedArticle.metaDescription,
            htmlContent: updatedArticle.htmlContent,
            plainText: updatedArticle.plainText,
          });
        }
      }

      // 修正済みリストに追加（実際に処理した問題のみ）
      const processedIssueIds = issuesToProcess.map(
        (issue) => `${issue.agentName}-${issue.description}`
      );
      setRevisedIssues((prev) => new Set([...prev, ...processedIssueIds]));

      // 一括修正完了後、すぐに保存
      const dataToSave = {
        article: cleanedArticle, // cleanedArticleが正しい変数名
        editedContent: cleanedArticle,
        multiAgentResult,
        revisedIssues: Array.from(
          new Set([...revisedIssues, ...processedIssueIds])
        ),
        timestamp: new Date().toISOString(),
        keyword,
        outline: outline || null,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
      console.log("✅ 一括修正完了後、記事を保存しました");

      // 実際に処理した件数を表示
      console.log(`✅ ${issuesToProcess.length}件の問題を一括修正完了`);
      if (remainingCount > 0) {
        setRevisionProgress(
          `${issuesToProcess.length}件を修正完了。残り${remainingCount}件は再度「一括修正」をクリックしてください`
        );
        setTimeout(() => setRevisionProgress(""), 5000); // 長めに表示
      } else {
        setRevisionProgress(`${issuesToProcess.length}件の問題を修正しました`);
        setTimeout(() => setRevisionProgress(""), 3000);
      }
    } catch (error) {
      console.error("一括修正エラー:", error);
      alert(
        `❌ 一括修正に失敗しました\n\n${
          error instanceof Error ? error.message : "不明なエラー"
        }`
      );
      setRevisionProgress("");
    } finally {
      setIsRevising(false);
    }
  };

  // 校閲機能
  const handleProofread = async () => {
    if (!article || !outline) return;

    setIsProofreading(true);
    try {
      const report = await proofreadArticle(
        editedContent,
        outline,
        regulation,
        {
          targetCharCount: outline.characterCountAnalysis?.average || 30000,
          checkFrequencyWords: true,
        }
      );

      setProofreadingReport(report);
      setShowProofreadingReport(true);

      // 違反が多い場合は警告
      if (report.statistics.criticalCount > 0) {
        console.warn(
          `⚠️ ${report.statistics.criticalCount}件の重大な違反が見つかりました`
        );
      }
    } catch (error) {
      console.error("校閲エラー:", error);
      alert("校閲に失敗しました");
    } finally {
      setIsProofreading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* 復元確認ダイアログ */}
      {showRestoreDialog && savedData && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-xl p-6 max-w-md mx-4 border border-gray-200 shadow-lg">
            <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
              前回の編集内容を復元しますか？
            </h3>
            <div className="text-gray-600 mb-6 space-y-2">
              <p>
                キーワード:{" "}
                <span className="text-blue-600 font-medium">{savedData.keyword}</span>
              </p>
              <p>
                保存日時:{" "}
                <span className="text-gray-500">
                  {new Date(savedData.timestamp).toLocaleString("ja-JP")}
                </span>
              </p>
              <p className="text-sm text-gray-500 mt-3">
                前回の編集内容が保存されています。復元すると、現在の内容は破棄されます。
              </p>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleSkipRestore}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
              >
                新規作成
              </button>
              <button
                onClick={handleRestore}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors font-semibold"
              >
                復元する
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl w-full max-w-7xl h-[90vh] flex flex-col shadow-xl border border-gray-200">
        {/* ヘッダー */}
        <div className="bg-gray-50 p-4 rounded-t-xl border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              記事執筆
              <span className="text-sm text-gray-500">- {keyword}</span>
              {lastSaveTime && (
                <span className="text-xs text-green-600 ml-2">
                  自動保存済み ({lastSaveTime.toLocaleTimeString("ja-JP")})
                </span>
              )}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 transition-colors"
            >
              ✕
            </button>
          </div>

          {article && (
            <div className="mt-4 flex items-center gap-4">
              {/* 表示モード切り替え */}
              <div className="flex gap-2">
                <button
                  onClick={() => setViewMode("preview")}
                  className={`px-4 py-2 rounded-lg ${
                    viewMode === "preview"
                      ? "bg-blue-500 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
                  }`}
                >
                  プレビュー
                </button>
                <button
                  onClick={() => setViewMode("code")}
                  className={`px-4 py-2 rounded-lg ${
                    viewMode === "code"
                      ? "bg-blue-500 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
                  }`}
                >
                  HTMLコード
                </button>
              </div>

              {/* モード選択とプログレス表示（マルチエージェントモードの場合のみ表示） */}
              {(useMultiAgent || writingMode === "v3") && (
                <div className="flex items-center gap-4 mr-4">
                  {/* モード選択 */}
                  <div className="flex items-center gap-2 p-2 bg-gray-100 rounded-lg">
                    <span className="text-xs text-gray-500">修正モード:</span>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="autoMode"
                        value="manual"
                        checked={autoMode === "manual"}
                        onChange={() => setAutoMode("manual")}
                        className="text-blue-600"
                        disabled={
                          isFinalProofreading || autoFlowProgress.isRunning
                        }
                      />
                      <span className="text-xs text-gray-600">手動</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="autoMode"
                        value="full-auto"
                        checked={autoMode === "full-auto"}
                        onChange={() => setAutoMode("full-auto")}
                        className="text-blue-600"
                        disabled={
                          isFinalProofreading || autoFlowProgress.isRunning
                        }
                      />
                      <span className="text-xs text-gray-600">フルオート</span>
                    </label>
                  </div>

                  {/* プログレス表示 */}
                  {autoFlowProgress.isRunning && (
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-gray-500">
                        {autoFlowProgress.currentStep === "proofreading" &&
                          "校閲中..."}
                        {autoFlowProgress.currentStep === "analyzing" &&
                          "結果分析中..."}
                        {autoFlowProgress.currentStep === "revising" &&
                          "自動修正中..."}
                        {autoFlowProgress.currentStep === "completed" &&
                          "完了"}
                      </div>
                      <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300"
                          style={{ width: `${autoFlowProgress.percentage}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">
                        {autoFlowProgress.percentage}%
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* アクションボタン */}
              <div className="flex gap-2 ml-auto">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleFinalProofread}
                    disabled={isFinalProofreading}
                    className="px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 disabled:from-gray-300 disabled:to-gray-300 text-white rounded-lg transition-all flex items-center gap-2 font-semibold shadow-md"
                    title={
                      writingMode === "v3"
                        ? "マルチエージェント校閲（10の専門エージェント）"
                        : useMultiAgent
                        ? "マルチエージェント校閲（10の専門エージェント）"
                        : "シングルエージェント校閲（従来版）"
                    }
                  >
                    {isFinalProofreading ? (
                      <>
                        <span className="animate-pulse">🤖</span>
                        {useMultiAgent ? "9エージェント実行中..." : "確認中..."}
                      </>
                    ) : (
                      <>
                        🤖 最終校閲 Ver.2.0
                        <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
                          マルチエージェント
                        </span>
                      </>
                    )}
                  </button>

                  {/* Ver.3では常にマルチエージェントモード */}
                  {writingMode !== "v3" && (
                    <label className="flex items-center gap-1 text-sm text-gray-400">
                      <input
                        type="checkbox"
                        checked={useMultiAgent}
                        onChange={(e) => setUseMultiAgent(e.target.checked)}
                        disabled={isFinalProofreading}
                        className="rounded"
                      />
                      <span>マルチ</span>
                    </label>
                  )}
                </div>
                <button
                  onClick={() => {
                    setIsEditing(!isEditing);

                    // 編集完了時、親コンポーネントに更新を通知
                    if (isEditing && article && onArticleGenerated) {
                      const updatedArticle = {
                        ...article,
                        htmlContent: editedContent,
                        plainText: editedContent.replace(/<[^>]*>/g, ""),
                      };
                      setArticle(updatedArticle);

                      // ArticleDisplayに反映
                      onArticleGenerated(updatedArticle);
                      console.log(
                        "✏️ 手動編集内容をArticleDisplayに反映しました"
                      );
                    }
                  }}
                  className="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors shadow-sm"
                >
                  {isEditing ? "編集完了" : "編集"}
                </button>
                <button
                  onClick={handleCopyHtml}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors border border-gray-300"
                >
                  HTMLコピー
                </button>
                <button
                  onClick={handleDownload}
                  className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors shadow-sm"
                >
                  テキストDL
                </button>
                <button
                  onClick={handleDownloadHtml}
                  className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors shadow-sm"
                >
                  HTML DL
                </button>
              </div>
            </div>
          )}
        </div>

        {/* コンテンツエリア */}
        <div className="flex-1 overflow-hidden flex">
          {isGenerating ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <LoadingSpinner />
                <p className="mt-4 text-gray-600">
                  {generationProgress || "セクション単位で記事を生成中..."}
                </p>
                <p className="text-sm text-gray-500 mt-2">
                  約{outline.characterCountAnalysis?.average.toLocaleString()}
                  文字の記事を作成しています
                </p>
                <p className="text-xs text-gray-600 mt-2">
                  （セクション単位生成により、目標文字数により近い記事を生成します）
                </p>
              </div>
            </div>
          ) : article ? (
            <>
              {/* メインコンテンツ */}
              <div className="flex-1 overflow-auto p-6">
                {viewMode === "preview" ? (
                  // プレビューモード
                  <div className="bg-white rounded-lg p-8 text-gray-900">
                    <h1 className="text-3xl font-bold mb-4 pb-4 border-b-2 border-blue-600">
                      {article.title}
                    </h1>
                    <div className="mb-4 p-4 bg-gray-100 rounded">
                      <p className="text-sm text-gray-600">
                        <strong>メタディスクリプション:</strong>{" "}
                        {article.metaDescription}
                      </p>
                    </div>
                    <div
                      className="prose prose-lg max-w-none
                        prose-h2:text-2xl prose-h2:font-bold prose-h2:text-blue-900 prose-h2:mt-8 prose-h2:mb-4 prose-h2:pb-2 prose-h2:border-b-2 prose-h2:border-blue-200
                        prose-h3:text-xl prose-h3:font-bold prose-h3:text-blue-700 prose-h3:mt-6 prose-h3:mb-3
                        prose-p:text-gray-700 prose-p:leading-relaxed
                        prose-strong:text-blue-900 prose-strong:font-bold
                        prose-ul:my-4 prose-li:my-1"
                      dangerouslySetInnerHTML={{ __html: editedContent }}
                    />
                  </div>
                ) : (
                  // コードモード
                  <div className="h-full">
                    {isEditing ? (
                      <textarea
                        value={editedContent}
                        onChange={(e) => setEditedContent(e.target.value)}
                        className="w-full h-full bg-gray-50 text-gray-800 font-mono text-sm p-4 rounded-lg border border-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
                        spellCheck={false}
                      />
                    ) : (
                      <pre className="bg-gray-50 text-gray-800 font-mono text-sm p-4 rounded-lg border border-gray-200 overflow-auto h-full">
                        <code>{editedContent}</code>
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {/* サイドパネル（セクション再生成） */}
              <div className="w-80 bg-gray-50 p-4 overflow-auto border-l border-gray-200">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">
                  セクション管理
                </h3>
                <div className="space-y-2">
                  {(outline.outline || outline.sections || []).map(
                    (section, index) => (
                      <div key={index} className="bg-white p-3 rounded-lg border border-gray-200">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="text-sm text-gray-800 font-medium">
                              {section.heading}
                            </p>
                            {section.subheadings &&
                              section.subheadings.length > 0 && (
                                <p className="text-xs text-gray-500 mt-1">
                                  {section.subheadings.length}個のH3
                                </p>
                              )}
                          </div>
                          <button
                            onClick={() => handleRegenerateSection(index)}
                            disabled={regeneratingSection === section.heading}
                            className="ml-2 px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white text-xs rounded-lg transition-colors"
                          >
                            {regeneratingSection === section.heading
                              ? "生成中..."
                              : "再生成"}
                          </button>
                        </div>
                      </div>
                    )
                  )}
                </div>

                {/* 記事情報 */}
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <h4 className="text-sm font-semibold text-gray-600 mb-2">
                    記事情報
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-gray-500">推奨文字数:</span>
                      <span className="ml-2 text-gray-800">
                        {outline.characterCountAnalysis?.average.toLocaleString()}
                        文字
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">現在の文字数:</span>
                      <span className="ml-2 text-gray-800">
                        {editedContent
                          .replace(/<[^>]*>/g, "")
                          .length.toLocaleString()}
                        文字
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* マルチエージェント校閲結果パネル */}
              {multiAgentResult && (
                <div className="w-96 bg-gray-50 p-4 overflow-auto border-l border-gray-200">
                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                      最終校閲結果
                      <span
                        className={`text-sm px-2 py-1 rounded ${
                          multiAgentResult.passed
                            ? "bg-green-600"
                            : "bg-red-600"
                        }`}
                      >
                        {multiAgentResult.overallScore}/100点
                      </span>
                    </h3>
                    <button
                      onClick={() => {
                        setMultiAgentResult(null);
                        setRevisedIssues(new Set());
                      }}
                      className="text-gray-500 hover:text-gray-700 transition-colors"
                      title="校閲結果を閉じる"
                    >
                      ✕
                    </button>
                  </div>

                  {/* 修正進捗表示 */}
                  {(isRevising || revisionProgress) && (
                    <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="flex items-center gap-2">
                        {isRevising && (
                          <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                        )}
                        <p className="text-sm text-blue-700">
                          {revisionProgress || "修正処理中..."}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* スコア内訳 */}
                  <div className="mb-4 p-3 bg-white rounded-lg border border-gray-200">
                    <h4 className="text-sm font-semibold text-gray-600 mb-2">
                      スコア内訳
                    </h4>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-gray-500">ファクトチェック:</span>
                        <span className="text-gray-800">
                          {multiAgentResult.regulationScore.factChecking}/45
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">信頼性・引用:</span>
                        <span className="text-gray-800">
                          {multiAgentResult.regulationScore.reliability}/25
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">構成ルール:</span>
                        <span className="text-gray-800">
                          {multiAgentResult.regulationScore.structureRules}/18
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">
                          法的コンプライアンス:
                        </span>
                        <span className="text-gray-800">
                          {multiAgentResult.regulationScore.legalCompliance}/7
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">総合品質:</span>
                        <span className="text-gray-800">
                          {multiAgentResult.regulationScore.overallQuality}/5
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 重大な問題 */}
                  {multiAgentResult.criticalIssues.length > 0 && (
                    <div className="mb-4">
                      <div className="flex justify-between items-center mb-2">
                        <h4 className="text-sm font-semibold text-red-400 flex items-center gap-1">
                          🔴 重大な問題 (
                          {multiAgentResult.criticalIssues.length}件)
                        </h4>
                        <button
                          onClick={() => handleBatchRevision("critical")}
                          className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="重大な問題をすべて修正"
                          disabled={isRevising}
                        >
                          🔨 一括修正
                        </button>
                      </div>
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {multiAgentResult.criticalIssues.map((issue, idx) => {
                          const issueId = `${issue.agentName}-${issue.description}`;
                          const isRevised = revisedIssues.has(issueId);
                          const isRevising = revisingIssueId === issueId;
                          return (
                            <div
                              key={idx}
                              className={`p-2 border rounded text-xs transition-all ${
                                isRevised
                                  ? "bg-green-900/20 border-green-800"
                                  : isRevising
                                  ? "bg-yellow-900/20 border-yellow-700 animate-pulse"
                                  : "bg-red-900/20 border-red-800"
                              }`}
                            >
                              <div className="flex justify-between items-start mb-1">
                                <div
                                  className={`font-semibold flex items-center gap-2 ${
                                    isRevised
                                      ? "text-green-300"
                                      : isRevising
                                      ? "text-yellow-300"
                                      : "text-red-300"
                                  }`}
                                >
                                  [{issue.agentName}]
                                  {isRevised && (
                                    <span className="text-green-400">
                                      ✅ 修正済
                                    </span>
                                  )}
                                  {isRevising && (
                                    <span className="flex items-center gap-1 text-yellow-400">
                                      <span className="inline-block w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin"></span>
                                      修正中...
                                    </span>
                                  )}
                                </div>
                                <button
                                  onClick={() =>
                                    handleSingleIssueRevision(issue)
                                  }
                                  className={`px-2 py-1 text-white text-xs rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                    isRevised
                                      ? "bg-gray-400 hover:bg-gray-500"
                                      : "bg-red-500 hover:bg-red-600"
                                  }`}
                                  title={
                                    isRevised
                                      ? "修正済み"
                                      : isRevising
                                      ? "修正中..."
                                      : revisingIssueId
                                      ? "他の項目を修正中"
                                      : "この問題を修正"
                                  }
                                  disabled={
                                    isRevising || revisingIssueId !== null
                                  }
                                >
                                  {isRevised
                                    ? "✅ 済"
                                    : isRevising
                                    ? "⏳"
                                    : "修正"}
                                </button>
                              </div>
                              <div className="text-gray-600 mb-1">
                                {issue.description}
                              </div>
                              {issue.location && (
                                <div className="text-gray-500">
                                  📍 {issue.location}
                                </div>
                              )}
                              {issue.suggestion && (
                                <div className="text-blue-500 mt-1">
                                  💡 {issue.suggestion}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 主要な問題 */}
                  {multiAgentResult.majorIssues.length > 0 && (
                    <div className="mb-4">
                      <div className="flex justify-between items-center mb-2">
                        <h4 className="text-sm font-semibold text-yellow-400 flex items-center gap-1">
                          🟡 主要な問題 ({multiAgentResult.majorIssues.length}
                          件)
                        </h4>
                        <button
                          onClick={() => handleBatchRevision("major")}
                          className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="主要な問題をすべて修正"
                          disabled={isRevising}
                        >
                          🔨 一括修正
                        </button>
                      </div>
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {multiAgentResult.majorIssues.map((issue, idx) => {
                          const issueId = `${issue.agentName}-${issue.description}`;
                          const isRevised = revisedIssues.has(issueId);
                          return (
                            <div
                              key={idx}
                              className={`p-2 border rounded text-xs ${
                                isRevised
                                  ? "bg-green-900/20 border-green-800"
                                  : "bg-yellow-900/20 border-yellow-800"
                              }`}
                            >
                              <div className="flex justify-between items-start mb-1">
                                <div
                                  className={`font-semibold ${
                                    isRevised
                                      ? "text-green-300"
                                      : "text-yellow-300"
                                  }`}
                                >
                                  [{issue.agentName}] {isRevised && "✅ 修正済"}
                                </div>
                                <button
                                  onClick={() =>
                                    handleSingleIssueRevision(issue)
                                  }
                                  className={`px-2 py-1 text-white text-xs rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                    isRevised
                                      ? "bg-gray-400 hover:bg-gray-500"
                                      : "bg-amber-500 hover:bg-amber-600"
                                  }`}
                                  title={
                                    isRevised
                                      ? "修正済み"
                                      : isRevising
                                      ? "修正中..."
                                      : revisingIssueId
                                      ? "他の項目を修正中"
                                      : "この問題を修正"
                                  }
                                  disabled={
                                    isRevising || revisingIssueId !== null
                                  }
                                >
                                  {isRevised
                                    ? "✅ 済"
                                    : isRevising
                                    ? "⏳"
                                    : "修正"}
                                </button>
                              </div>
                              <div className="text-gray-600 mb-1">
                                {issue.description}
                              </div>
                              {issue.location && (
                                <div className="text-gray-500">
                                  📍 {issue.location}
                                </div>
                              )}
                              {issue.suggestion && (
                                <div className="text-blue-500 mt-1">
                                  💡 {issue.suggestion}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 改善提案（全部表示） */}
                  {multiAgentResult.improvementPlan &&
                    multiAgentResult.improvementPlan.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-semibold text-blue-600 mb-2">
                          改善提案 ({multiAgentResult.improvementPlan.length}
                          件)
                        </h4>
                        <div className="space-y-2 max-h-60 overflow-y-auto">
                          {multiAgentResult.improvementPlan.map((plan, idx) => (
                            <div
                              key={idx}
                              className="p-2 bg-blue-50 border border-blue-200 rounded-lg text-xs"
                            >
                              <div className="text-gray-600">
                                {idx + 1}. {plan}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  {/* 推奨アクション */}
                  <div className="mt-4 p-3 bg-white rounded-lg border border-gray-200">
                    <div
                      className={`text-sm font-semibold ${
                        multiAgentResult.recommendation === "publish"
                          ? "text-green-600"
                          : multiAgentResult.recommendation === "revise"
                          ? "text-amber-600"
                          : "text-red-600"
                      }`}
                    >
                      {multiAgentResult.recommendation === "publish"
                        ? "公開可能"
                        : multiAgentResult.recommendation === "revise"
                        ? "修正推奨"
                        : "大幅な修正が必要"}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-500">記事の生成に失敗しました</p>
            </div>
          )}
        </div>

        {/* 校閲レポートモーダル */}
        {showProofreadingReport && proofreadingReport && (
          <ProofreadingReportComponent
            report={proofreadingReport}
            onClose={() => setShowProofreadingReport(false)}
          />
        )}
      </div>
    </div>
  );
};

// 構成案をマークダウン形式に変換するヘルパー関数
function convertOutlineToMarkdown(outline: any, keyword: string): string {
  let markdown = `# ${outline.title || keyword}\n\n`;

  // 見出し構造をマークダウンに変換
  if (outline.outline && Array.isArray(outline.outline)) {
    outline.outline.forEach((section: any) => {
      markdown += `## ${section.heading}\n`;
      markdown += `文字数目標: ${section.characterCount || 1000}文字\n`;

      if (section.notes) {
        markdown += `執筆メモ: ${section.notes}\n`;
      }

      if (section.subheadings && Array.isArray(section.subheadings)) {
        section.subheadings.forEach((sub: any) => {
          if (typeof sub === "string") {
            markdown += `### ${sub}\n`;
          } else if (sub.text) {
            markdown += `### ${sub.text}\n`;
            if (sub.note) {
              markdown += `執筆メモ: ${sub.note}\n`;
            }
          }
        });
      }

      markdown += "\n";
    });
  }

  // 競合情報があれば追加
  if (outline.competitorResearch) {
    markdown += "\n## 競合分析情報\n";
    markdown += `- 平均文字数: ${
      outline.competitorResearch.avgCharCount || 5000
    }文字\n`;
    markdown += `- 頻出キーワード: ${
      outline.competitorResearch.frequencyWords?.join(", ") || "なし"
    }\n`;
  }

  return markdown;
}

// マークダウンをHTMLに変換するヘルパー関数
function convertMarkdownToHtml(markdown: string): string {
  let html = markdown;

  // 見出しの変換
  html = html.replace(/^### (.*?)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*?)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*?)$/gm, "<h1>$1</h1>");

  // リストの変換
  html = html.replace(/^\- (.*?)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*?<\/li>\n)+/g, "<ul>$&</ul>");

  // 段落の変換
  html = html.replace(/\n\n/g, "</p><p>");
  html = "<p>" + html + "</p>";

  // 不要なタグの修正
  html = html.replace(/<p><h/g, "<h");
  html = html.replace(/<\/h(\d)><\/p>/g, "</h$1>");
  html = html.replace(/<p><ul>/g, "<ul>");
  html = html.replace(/<\/ul><\/p>/g, "</ul>");

  // 太字・斜体の変換
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");

  return html;
}

// 🎨 統一された画像生成エージェント起動関数
const startImageGeneration = async (
  finalScore: number,
  keyword: string,
  article: any,
  outline: any,
  editedContent: string,
  onAutoComplete?: () => void,
  onOpenImageAgent?: (articleData: {
    title: string;
    content: string;
    keyword: string;
    autoMode?: boolean;
    metaDescription?: string;
    slug?: string;
    isTestMode?: boolean;
    plainText?: string;
    score?: number;
    spreadsheetRow?: number;
  }) => void
) => {
  console.log(
    `🎨 画像生成エージェントを起動します... (スコア: ${finalScore}点)`
  );

  try {
    // slug生成
    const slug = await generateSlug(keyword);
    const spreadsheetRow = localStorage.getItem("currentSpreadsheetRow");

    // 記事データを準備（フルサイズで送信）
    const imageGenData = {
      keyword: keyword,
      title: article?.title || "",
      metaDescription: outline?.metaDescription || "",
      slug: slug,
      htmlContent: editedContent,
      plainText: editedContent.replace(/<[^>]*>/g, ""),
      outline: outline,
      score: finalScore,
      timestamp: new Date().toISOString(),
      isAutoMode: true,
      autoExecute: true,
      isTestMode: false, // フル自動モードフラグを明示
      spreadsheetRow: spreadsheetRow ? parseInt(spreadsheetRow) : null,
    };

    console.log("📦 画像生成用データ準備完了:");
    console.log("  - キーワード:", imageGenData.keyword);
    console.log("  - タイトル:", imageGenData.title);
    console.log("  - スコア:", imageGenData.score);
    console.log("  - 自動実行:", imageGenData.autoExecute);
    console.log("  - テストモード:", imageGenData.isTestMode);
    console.log("📊 データサイズ確認:");
    console.log("  - HTMLコンテンツ長:", editedContent.length);
    console.log("  - plainText長:", imageGenData.plainText.length);
    console.log(
      "  - 送信データサイズ:",
      JSON.stringify(imageGenData).length,
      "bytes"
    );

    // 🌐 画像生成エージェントを開く（iframe版）
    // ※ postMessageで直接データを渡すため、localStorageへの保存は不要
    if (onOpenImageAgent) {
      console.log("🖼️ 画像生成エージェントをiframeで開きます...");
      onOpenImageAgent({
        title: imageGenData.title,
        content: imageGenData.htmlContent,
        keyword: imageGenData.keyword,
        autoMode: true,
        metaDescription: imageGenData.metaDescription,
        slug: imageGenData.slug,
        isTestMode: imageGenData.isTestMode,
        plainText: imageGenData.plainText,
        score: imageGenData.score,
        spreadsheetRow: imageGenData.spreadsheetRow || undefined,
      });
      console.log("✅ iframe起動完了");
    } else {
      // フォールバック: 別タブで開く
      const activeClientId = getActiveClientId();
      if (!activeClientId) {
        console.warn("⚠️ clientId が未選択の状態で画像生成エージェントを起動します");
      }
      const urlWithClient = buildImageGenUrl(activeClientId);
      const newWindow = window.open(urlWithClient, "_blank");

      if (newWindow) {
        setTimeout(() => {
          console.log("📤 画像生成エージェントにデータを送信中...");
          try {
            newWindow.postMessage(
              {
                type: "ARTICLE_DATA",
                clientId: activeClientId,
                data: imageGenData,
              },
              getImageGenOrigin()
            );
            console.log("✅ データ送信完了");
          } catch (error) {
            console.error("❌ データ送信エラー:", error);
          }
        }, 2000);
      }
    }

    // フル自動モードの場合はSlack通知
    try {
      console.log("🔍 slackNotifier詳細確認:");
      console.log("  - slackNotifier exists:", !!slackNotifier);
      console.log("  - slackNotifier type:", typeof slackNotifier);
      console.log(
        "  - notifyImageGeneration type:",
        typeof slackNotifier?.notifyImageGeneration
      );

      if (slackNotifier) {
        console.log(
          "  - Available methods:",
          Object.getOwnPropertyNames(slackNotifier)
        );
        console.log("  - Constructor name:", slackNotifier.constructor.name);
      }

      if (
        slackNotifier &&
        typeof slackNotifier.notifyImageGeneration === "function"
      ) {
        console.log("✅ Slack通知を送信中...");
        await slackNotifier.notifyImageGeneration({
          keyword,
          score: finalScore,
          title: article?.title || "",
        });
        console.log("✅ Slack通知送信成功");
      } else {
        console.warn("⚠️ slackNotifier.notifyImageGeneration is not available");
        console.warn("  - slackNotifier:", slackNotifier);
        console.warn(
          "  - Available methods:",
          slackNotifier ? Object.getOwnPropertyNames(slackNotifier) : "N/A"
        );
      }
    } catch (error) {
      console.error("❌ Slack通知エラー:", error);
      console.error("  - Error name:", error.name);
      console.error("  - Error message:", error.message);
      console.error("  - Error stack:", error.stack);
    }

    console.log(
      `✅ 画像生成エージェント起動完了！ スコア: ${finalScore}点\n` +
        `画像生成が自動で開始されます...`
    );

    // フル自動モード完了通知
    if (onAutoComplete) {
      console.log("✅ フル自動モード: 全工程完了を通知");
      try {
        await onAutoComplete();
        console.log("✅ onAutoComplete実行完了");
      } catch (error) {
        console.error("❌ onAutoComplete実行エラー:", error);
      }
    }
  } catch (error) {
    console.error("❌ 画像生成エージェント起動エラー:", error);
    alert(
      `❌ 画像生成エージェントの起動に失敗しました\n\n` +
        `${error instanceof Error ? error.message : "不明なエラー"}`
    );
  }
};

export default ArticleWriter;
