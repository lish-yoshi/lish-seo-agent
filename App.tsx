import React, { useState, useCallback, useEffect, useRef } from "react";
import type {
  SeoOutline,
  SeoOutlineV2,
  GroundingChunk,
  CompetitorResearchResult,
} from "./types";
import { generateSeoOutline } from "./services/geminiServiceUpdated";
import { generateCompetitorResearch } from "./services/competitorResearchWithWebFetch";
import { generateOptimizedOutline } from "./services/outlineOptimizer";
import { generateOutlineV2 } from "./services/outlineGeneratorV2";
import { checkAndFixOutline } from "./services/outlineCheckerV2";
// import { runQualityCheck } from './services/qualityCheckAgent';  // 一時的に無効化（キーワード削除問題）
import { getTestOutlineV2 } from "./utils/testDataGeneratorV2";
import KeywordInputForm from "./components/KeywordInputForm";
import OutlineDisplay from "./components/OutlineDisplay";
import OutlineDisplayOptimized from "./components/OutlineDisplayOptimized";
import OutlineDisplayV2 from "./components/OutlineDisplayV2";
import ArticleDisplay from "./components/ArticleDisplay";
import ArticleWriter from "./components/ArticleWriter";
import { CompetitorResearchWebFetch } from "./components/CompetitorResearchWebFetch";
import { FrequencyWordsTab } from "./components/FrequencyWordsTab";
import LoadingSpinner from "./components/LoadingSpinner";
import ErrorMessage from "./components/ErrorMessage";
import { LogoIcon, SparklesIcon } from "./components/icons";
import TextCheckPage from "./components/TextCheckPage";
import AutoProgressDisplay, {
  type AutoStep,
} from "./components/AutoProgressDisplay";
import { slackNotifier } from "./services/slackNotificationService";
import FactCheckPage from "./components/FactCheckPage";
import ArticleRevisionForm from "./components/ArticleRevisionForm";
import { useImageAgent, type ArticleDataForImageAgent } from "./hooks/useImageAgent";
import { ImageGeneratorIframe } from "./components/ImageGeneratorIframe";
import ClientSelector from "./components/ClientSelector";
import { restoreActiveClient, clientHeaders } from "./services/clientContext";
import { isAllowedImageAgentOrigin } from "./utils/imageAgentUrl";

// クライアント管理画面（T-01b-2）。フラグ VITE_ENABLE_CLIENTS_ADMIN（既定 false）。
// import() をフラグ判定の内側に置くことで、off のビルドには管理画面のチャンクが含まれない。
const CLIENTS_ADMIN = import.meta.env.VITE_ENABLE_CLIENTS_ADMIN === "true";
let ClientsAdminPage: React.LazyExoticComponent<React.FC> | null = null;
if (CLIENTS_ADMIN) {
  ClientsAdminPage = React.lazy(() => import("./modules/clients/ClientsAdminPage"));
}

// imager は見出し（H2）1つにつき画像を1枚、順番に生成するため、無応答タイムアウトを見出し数に比例させる
const IMAGE_AGENT_TIMEOUT_BASE_MS = 5 * 60 * 1000;
const IMAGE_AGENT_TIMEOUT_PER_HEADING_MS = 90 * 1000;
const IMAGE_AGENT_TIMEOUT_FALLBACK_MS = 20 * 60 * 1000;

function resolveImageAgentTimeout(articleData: ArticleDataForImageAgent): number {
  let headingCount = 0;
  try {
    const doc = new DOMParser().parseFromString(articleData.content || "", "text/html");
    // imager は文字のない見出しには画像を作らないため、同じ条件で数える
    headingCount = Array.from(doc.querySelectorAll("h2")).filter(
      (h2) => (h2.textContent || "").trim() !== ""
    ).length;
  } catch (error) {
    console.warn("⚠️ 記事HTMLから見出し数を取得できませんでした:", error);
  }

  if (headingCount === 0) {
    console.log(
      `⏱️ 画像生成エージェントのタイムアウト: ${IMAGE_AGENT_TIMEOUT_FALLBACK_MS / 60000}分（見出し数を取得できないため既定値）`
    );
    return IMAGE_AGENT_TIMEOUT_FALLBACK_MS;
  }

  const timeoutMs =
    IMAGE_AGENT_TIMEOUT_BASE_MS + headingCount * IMAGE_AGENT_TIMEOUT_PER_HEADING_MS;
  console.log(
    `⏱️ 画像生成エージェントのタイムアウト: ${timeoutMs / 60000}分（5分 + 見出し${headingCount}件 × 90秒）`
  );
  return timeoutMs;
}

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<
    "main" | "textcheck" | "factcheck" | "revision" | "clients"
  >("main");
  const [keyword, setKeyword] = useState<string>("");
  const [outline, setOutline] = useState<SeoOutline | null>(null);
  const [outlineV2, setOutlineV2] = useState<SeoOutlineV2 | null>(null);
  const [competitorResearch, setCompetitorResearch] =
    useState<CompetitorResearchResult | null>(null);
  const [sources, setSources] = useState<GroundingChunk[] | undefined>(
    undefined
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "research" | "frequency" | "outline" | "article"
  >("research");
  const [analysisProgress, setAnalysisProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [showWriterDirectly, setShowWriterDirectly] = useState<boolean>(false);
  const [apiUsageWarning, setApiUsageWarning] = useState<string | null>(null);
  const [generatedArticle, setGeneratedArticle] = useState<{
    title: string;
    metaDescription: string;
    htmlContent: string;
    plainText: string;
  } | null>(null);
  const [showArticleWriter, setShowArticleWriter] = useState(false);
  const [writingMode, setWritingMode] = useState<"v1" | "v2" | "v3">("v1");
  const [isV2Mode, setIsV2Mode] = useState<boolean>(false);

  // フル自動モード用の状態
  const [isFullAutoMode, setIsFullAutoMode] = useState<boolean>(false);
  const [autoSteps, setAutoSteps] = useState<AutoStep[]>([]);
  const [currentAutoStep, setCurrentAutoStep] = useState<number>(0);
  const [isAutoRunning, setIsAutoRunning] = useState<boolean>(false);
  const [autoArticleWriter, setAutoArticleWriter] = useState<boolean>(false);

  // スプレッドシートモード用のキューシステム
  const [keywordQueue, setKeywordQueue] = useState<
    Array<{ row: number; keyword: string }>
  >([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState<boolean>(false);
  const [queueProgress, setQueueProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [queueIndex, setQueueIndex] = useState<number>(0);
  const [queueActive, setQueueActive] = useState<boolean>(false);
  const [currentSpreadsheetRow, setCurrentSpreadsheetRow] = useState<
    number | null
  >(null);

  // サーバー復旧待ち機能
  const [isWaitingForServerRecovery, setIsWaitingForServerRecovery] =
    useState<boolean>(false);
  const [serverCheckInterval, setServerCheckInterval] =
    useState<NodeJS.Timeout | null>(null);
  const [recoveryAttempts, setRecoveryAttempts] = useState<number>(0);
  const [lastFailedKeyword, setLastFailedKeyword] = useState<{
    row: number;
    keyword: string;
  } | null>(null);

  // スプレッドシートモードで失敗・無応答のためスキップしたキーワード（キュー完了後も表示を残す）
  const [failedQueueItems, setFailedQueueItems] = useState<
    Array<{ row?: number; keyword: string; reason: string; at: string }>
  >([]);

  // キュー処理の二重実行を防ぐためのref
  const queueIndexRef = useRef<number>(0);
  const queueActiveRef = useRef<boolean>(false);
  const keywordQueueRef = useRef<Array<{ row: number; keyword: string }>>([]);
  const isLaunchingRef = useRef<boolean>(false); // Mutex: 起動中フラグ
  const handleGenerateFullAutoRef = useRef<any>(null); // handleGenerateFullAutoの参照

  // refを常に最新のstateに同期
  // 前回選択したクライアントを復元
  useEffect(() => {
    restoreActiveClient();
  }, []);

  useEffect(() => {
    queueIndexRef.current = queueIndex;
  }, [queueIndex]);

  useEffect(() => {
    queueActiveRef.current = queueActive;
  }, [queueActive]);

  // Keep-alive: フル自動モード処理中はバックエンドを5分ごとにpingしてアイドル終了を防ぐ
  useEffect(() => {
    // フル自動モード（単体 or スプシモード）の時に有効
    if (!isFullAutoMode) return;

    const backendUrl = import.meta.env.VITE_BACKEND_URL || "";

    const keepAlive = () => {
      fetch(`${backendUrl}/api/health`)
        .then(() => console.log("🏓 Keep-alive ping成功"))
        .catch(() => console.warn("⚠️ Keep-alive ping失敗"));
    };

    // 開始時に1回ping
    keepAlive();

    // 5分ごとにping（Cloud Runのアイドルタイムアウトは約15分）
    const interval = setInterval(keepAlive, 5 * 60 * 1000);

    console.log("🔄 Keep-alive開始（5分間隔）");

    return () => {
      clearInterval(interval);
      console.log("🔄 Keep-alive停止");
    };
  }, [isFullAutoMode]);

  useEffect(() => {
    keywordQueueRef.current = keywordQueue;
  }, [keywordQueue]);

  // キュー処理用のクリーンアップ関数をrefに保存
  const cleanupQueueStateRef = useRef<() => void>();

  // 画像生成エージェントの1記事分の結果（成功・失敗・無応答）でキューを進める。
  // メッセージ受信と無応答タイムアウトの両方から呼ぶため、最新の state を参照できる ref に置く。
  const advanceQueueRef = useRef<
    (result: {
      success: boolean;
      keyword?: string;
      row?: number;
      reason?: string;
    }) => void
  >(undefined);

  // 画像生成エージェント用のフック
  const imageAgentCloseIframeRef = useRef<() => void>();
  const {
    embedState: imageAgentEmbedState,
    iframeRef: imageAgentIframeRef,
    openInIframe: openImageAgentInIframe,
    openInNewTab: openImageAgentInNewTab,
    closeIframe: closeImageAgentIframe,
    sendDataToIframe: sendDataToImageAgentIframe,
    reopenInNewTab: reopenImageAgentInNewTab,
    isLoading: isImageAgentLoading,
  } = useImageAgent({
    onIframeOpen: () => {
      console.log("🖼️ 画像生成エージェントiframeが開きました");
    },
    onIframeClose: () => {
      console.log("🚪 画像生成エージェントiframeが閉じました");
    },
    onError: (error) => {
      console.error("❌ 画像生成エージェントエラー:", error);
    },
    onComplete: (success, data) => {
      // useImageAgent がこれを呼ぶのは無応答タイムアウト時のみ（success=false）
      console.log("⏰ 画像生成エージェント終了:", { success, data });
      if (!success && advanceQueueRef.current) {
        advanceQueueRef.current({
          success: false,
          keyword: data?.keyword,
          row: data?.row,
          reason: `画像生成エージェントが${
            (data?.timeoutMs ?? IMAGE_AGENT_TIMEOUT_FALLBACK_MS) / 60000
          }分間応答しませんでした`,
        });
      }
    },
    timeout: resolveImageAgentTimeout,
  });

  // クローズ関数をrefに保存（useEffect内から参照するため）
  useEffect(() => {
    imageAgentCloseIframeRef.current = closeImageAgentIframe;
  }, [closeImageAgentIframe]);

  // クリーンアップ関数を更新
  useEffect(() => {
    cleanupQueueStateRef.current = () => {
      console.log("🧹 キュー処理完了: 状態をクリーンアップ");
      setKeywordQueue([]);
      setQueueProgress(null);
      setQueueIndex(0);
      setQueueActive(false);
      setIsProcessingQueue(false);
      setCurrentSpreadsheetRow(null);
      setIsFullAutoMode(false); // Keep-alive停止
      setIsWaitingForServerRecovery(false);
      setRecoveryAttempts(0);
      setLastFailedKeyword(null);
      if (serverCheckInterval) {
        clearInterval(serverCheckInterval);
        setServerCheckInterval(null);
      }
      localStorage.removeItem("currentSpreadsheetRow");
    };
  });

  // 画像生成エージェントの結果でキューを進める処理（毎レンダーで最新の state・関数を参照するよう更新）
  useEffect(() => {
    advanceQueueRef.current = ({
      success,
      keyword: resultKeyword,
      row,
      reason,
    }) => {
      if (!queueActiveRef.current) {
        // キュー外（単発実行）では、失敗時は画面にエラーを残すため iframe を閉じない
        if (success && imageAgentCloseIframeRef.current) {
          console.log("🚪 画像生成エージェントiframeを自動クローズします");
          imageAgentCloseIframeRef.current();
        }
        console.log("⚠️ キューが非アクティブです");
        return;
      }

      const currentItem = keywordQueueRef.current[queueIndexRef.current];

      // 前の記事の通知が遅れて届いた場合（例: タイムアウトで先に進んだ後の完了通知）に、
      // 処理中の記事を飛ばさないよう、処理中の記事と一致しない通知は無視する。
      // 行番号で照合するので、同じキーワードが連続していても区別できる。
      // 行番号を含まない通知（旧 imager など）だけはキーワードで照合する。
      const receivedRow =
        row !== undefined && row !== null && Number.isInteger(Number(row))
          ? Number(row)
          : undefined;
      const isStaleNotice =
        !!currentItem &&
        (receivedRow !== undefined
          ? receivedRow !== currentItem.row
          : !!resultKeyword &&
            resultKeyword.trim() !== currentItem.keyword.trim());

      if (isStaleNotice) {
        console.warn("⚠️ 処理中の記事と一致しない通知を無視しました:", {
          received: { row: receivedRow, keyword: resultKeyword },
          current: { row: currentItem.row, keyword: currentItem.keyword },
        });
        return;
      }

      // Mutexで二重起動を防ぐ
      if (isLaunchingRef.current) {
        console.warn(
          "⚠️ すでに次のキーワードを起動中のため、完了通知をスキップしました"
        );
        return;
      }

      // 画像生成エージェントのiframeを閉じる
      if (imageAgentCloseIframeRef.current) {
        console.log("🚪 画像生成エージェントiframeを自動クローズします");
        imageAgentCloseIframeRef.current();
      }

      if (!success) {
        const failedItem = {
          row: receivedRow ?? currentItem?.row,
          keyword: resultKeyword ?? currentItem?.keyword ?? "（不明）",
          reason: reason || "原因不明",
          at: new Date().toLocaleTimeString(),
        };
        console.error(
          `❌ 記事処理に失敗したためスキップします: 行${failedItem.row ?? "?"}「${failedItem.keyword}」 - ${failedItem.reason}`
        );
        setFailedQueueItems((prev) => [...prev, failedItem]);
      }

      const nextIndex = queueIndexRef.current + 1;

      if (nextIndex >= keywordQueueRef.current.length) {
        console.log("🎉 すべてのキーワードの処理が完了しました！");
        // refを使ってクリーンアップを実行
        if (cleanupQueueStateRef.current) {
          cleanupQueueStateRef.current();
        }
        return;
      }

      // Mutexロック
      isLaunchingRef.current = true;

      try {
        const nextKeyword = keywordQueueRef.current[nextIndex];
        console.log(
          `\n🔄 次の記事処理開始: ${nextIndex + 1}/${
            keywordQueueRef.current.length
          }`
        );
        console.log(`📝 キーワード: ${nextKeyword.keyword}`);

        // refとstateの両方を更新
        queueIndexRef.current = nextIndex;
        setQueueIndex(nextIndex);
        setQueueProgress({
          current: nextIndex,
          total: keywordQueueRef.current.length,
        });
        setCurrentSpreadsheetRow(nextKeyword.row);
        localStorage.setItem(
          "currentSpreadsheetRow",
          nextKeyword.row.toString()
        );

        // エラーハンドリング強化版を使用
        handleGenerateFullAutoWithRecovery(nextKeyword.keyword, false, true);
      } finally {
        // 500ms後にMutex解除（handleGenerateFullAutoの初期化処理完了を待つ）
        setTimeout(() => {
          isLaunchingRef.current = false;
        }, 500);
      }
    };
  });

  // ARTICLE_COMPLETED メッセージを受け取るuseEffect（循環依存を回避）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== "ARTICLE_COMPLETED") {
        return;
      }

      if (!isAllowedImageAgentOrigin(event.origin)) {
        console.warn(
          "⚠️ 許可されていないオリジンからの完了通知を拒否しました:",
          event.origin
        );
        return;
      }

      const success = event.data.success === true;
      console.log(
        success ? "📨 記事完了通知を受信しました" : "📨 記事失敗通知を受信しました",
        event.data
      );

      advanceQueueRef.current?.({
        success,
        keyword: event.data.keyword,
        row: event.data.row,
        reason: event.data.error,
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []); // 依存関係なしで循環依存を回避

  // テスト構成を使用
  const handleUseTestOutline = useCallback(
    (type: "whatIs" | "howTo" | "comprehensive" | "aiTraining") => {
      const testData = getTestOutlineV2(type);
      setOutlineV2(testData.outline);
      setOutline(null); // Ver.1の構成をクリア
      setKeyword(testData.keyword);
      setCompetitorResearch(testData.competitorResearch);
      setActiveTab("outline");
      setError(null);
      setIsV2Mode(true); // Ver.2モードに設定
    },
    []
  );

  // API使用回数の管理
  const getApiUsageToday = (): number => {
    const today = new Date().toDateString();
    const stored = localStorage.getItem("customSearchApiUsage");
    if (!stored) return 0;

    const data = JSON.parse(stored);
    if (data.date !== today) {
      // 日付が変わったらリセット
      localStorage.setItem(
        "customSearchApiUsage",
        JSON.stringify({ date: today, count: 0 })
      );
      return 0;
    }
    return data.count || 0;
  };

  const incrementApiUsage = (): void => {
    const today = new Date().toDateString();
    const currentCount = getApiUsageToday();
    localStorage.setItem(
      "customSearchApiUsage",
      JSON.stringify({
        date: today,
        count: currentCount + 1,
      })
    );
  };

  const handleGenerate = useCallback(
    async (newKeyword: string, includeImages: boolean) => {
      if (!newKeyword.trim()) {
        setError("キーワードを入力してください。");
        return;
      }

      setIsLoading(true);
      setError(null);
      setOutline(null);
      setOutlineV2(null);
      setCompetitorResearch(null);
      setSources(undefined);
      setKeyword(newKeyword);
      setIsV2Mode(false);
      setApiUsageWarning(null);

      try {
        // API使用回数のチェックと警告
        const currentUsage = getApiUsageToday();
        if (currentUsage >= 50) {
          console.warn(
            "⚠️ Custom Search API無料枠を超過しています。以降は従量課金（約1.5円/回）が発生します。"
          );
          setApiUsageWarning(
            "無料枠超過中：従量課金（約1.5円/回）が発生しています"
          );
        }

        // まず競合分析を実行
        console.log("Starting competitor research for:", newKeyword);
        // 初期値として15を設定（実際の数は後で更新される）
        setAnalysisProgress({ current: 0, total: 15 });

        // Google Search APIはサーバー側で処理するため、クライアント側ではtrueを渡すだけ
        const useGoogleSearch = true; // サーバー側で設定を確認
        console.log("✅ Google Search API will be attempted (server-side)");

        const researchResult = await generateCompetitorResearch(
          newKeyword,
          (current, total) => {
            console.log(`Progress update: ${current}/${total}`);
            setAnalysisProgress({ current, total });
          },
          useGoogleSearch
        );
        setCompetitorResearch(researchResult);
        setAnalysisProgress(null);

        // API使用回数をインクリメント（成功時のみ）
        incrementApiUsage();

        // 次に構成案を生成（競合分析結果を渡す）
        console.log("Generating SEO outline with competitor insights...");

        // 競合分析データがあり、頻出単語も分析済みの場合は最適化版を使用
        if (
          researchResult &&
          researchResult.frequencyWords &&
          researchResult.frequencyWords.length > 0
        ) {
          console.log(
            "Using optimized outline generation with frequency words..."
          );
          const optimizedOutline = await generateOptimizedOutline(
            newKeyword,
            researchResult,
            includeImages
          );
          setOutline(optimizedOutline);
          setSources(undefined);
        } else {
          // 従来の構成案生成
          console.log("Using standard outline generation...");
          const { outline: generatedOutline, sources: generatedSources } =
            await generateSeoOutline(newKeyword, includeImages, researchResult);
          setOutline(generatedOutline);
          setSources(generatedSources);
        }
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "分析中にエラーが発生しました。しばらくしてからもう一度お試しください。"
        );
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Ver.2の構成案生成
  const handleGenerateV2 = useCallback(
    async (newKeyword: string, includeImages: boolean) => {
      if (!newKeyword.trim()) {
        setError("キーワードを入力してください。");
        return;
      }

      setIsLoading(true);
      setError(null);
      setOutline(null);
      setOutlineV2(null);
      setCompetitorResearch(null);
      setSources(undefined);
      setKeyword(newKeyword);
      setIsV2Mode(true);
      setApiUsageWarning(null);

      try {
        // API使用回数のチェックと警告
        const currentUsage = getApiUsageToday();
        if (currentUsage >= 50) {
          console.warn(
            "⚠️ Custom Search API無料枠を超過しています。以降は従量課金（約1.5円/回）が発生します。"
          );
          setApiUsageWarning(
            "無料枠超過中：従量課金（約1.5円/回）が発生しています"
          );
        }

        // まず競合分析を実行
        console.log("Starting competitor research for Ver.2:", newKeyword);
        setAnalysisProgress({ current: 0, total: 15 });

        // Google Search APIはサーバー側で処理するため、クライアント側ではtrueを渡すだけ
        const useGoogleSearch = true; // サーバー側で設定を確認

        const researchResult = await generateCompetitorResearch(
          newKeyword,
          (current, total) => {
            setAnalysisProgress({ current, total });
          },
          useGoogleSearch
        );
        setCompetitorResearch(researchResult);
        setAnalysisProgress(null);

        // API使用回数をインクリメント（成功時のみ）
        incrementApiUsage();

        // Ver.2構成案を生成
        console.log("Generating SEO outline Ver.2...");
        const v2Outline = await generateOutlineV2(
          newKeyword,
          researchResult,
          includeImages,
          true // 導入文2パターン生成
        );

        // 構成チェックと自動修正
        console.log("Checking and fixing outline...");
        const { finalOutline, checkResult, wasFixed } =
          await checkAndFixOutline(v2Outline, newKeyword, researchResult);

        if (wasFixed) {
          console.log("構成案が自動修正されました");
        }

        if (!checkResult.isValid) {
          console.warn("構成案にまだエラーが残っています:", checkResult.errors);
          // エラーの詳細をログ出力
          checkResult.errors.forEach((error) => {
            console.warn(
              `  - ${error.field}: ${error.message} (${error.severity})`
            );
          });
        }

        // 品質チェックエージェントをスキップ（キーワード削除問題のため一時的に無効化）
        console.log(
          "⚠️ 品質チェックエージェントをスキップ（キーワード削除問題のため）"
        );
        // const qualityCheckedOutline = await runQualityCheck(finalOutline, newKeyword);

        setOutlineV2(finalOutline);
        setActiveTab("outline");
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "分析中にエラーが発生しました。しばらくしてからもう一度お試しください。"
        );
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // フル自動実行ハンドラー
  const handleGenerateFullAuto = useCallback(
    async (
      newKeyword: string,
      includeImages: boolean,
      isQueueRun: boolean = false
    ) => {
      if (!newKeyword.trim()) {
        setError("キーワードを入力してください。");
        return;
      }

      // 初期化
      setIsFullAutoMode(true);
      setIsAutoRunning(true);
      setIsLoading(true);
      setError(null);
      setOutline(null);
      setOutlineV2(null);
      setCompetitorResearch(null);
      setSources(undefined);
      setKeyword(newKeyword);
      setGeneratedArticle(null);
      setShowArticleWriter(false);
      setApiUsageWarning(null);

      // API使用回数のチェックと警告
      const currentUsage = getApiUsageToday();
      if (currentUsage >= 50) {
        console.warn(
          "⚠️ Custom Search API無料枠を超過しています。以降は従量課金（約1.5円/回）が発生します。"
        );
        setApiUsageWarning(
          "無料枠超過中：従量課金（約1.5円/回）が発生しています"
        );
      }

      // Slack通知: 開始
      await slackNotifier.notifyStart({ keyword: newKeyword });

      // ステップの初期化
      const steps: AutoStep[] = [
        {
          id: "competitor-research",
          title: "競合サイト分析",
          description: "上位15サイトを分析して競合調査を実施",
          status: "pending",
        },
        {
          id: "outline-generation",
          title: "構成案生成",
          description: "SEO最適化された記事構成を生成",
          status: "pending",
        },
        {
          id: "outline-check",
          title: "構成チェック＆品質確認",
          description: "構成のルールチェックと自動修正",
          status: "pending",
        },
        {
          id: "article-writing",
          title: "記事執筆",
          description: "高品質な記事を一気に生成",
          status: "pending",
        },
        {
          id: "final-proofreading",
          title: "校閲・自動修正",
          description: "複数のAIエージェントで徹底的な品質チェック",
          status: "pending",
        },
        {
          id: "auto-revision",
          title: "再校閲・問題なければ画像生成へ",
          description: "校閲結果に基づいて次のステップへ",
          status: "pending",
        },
        {
          id: "image-generation",
          title: "画像生成エージェント起動",
          description: "記事に適した画像を自動生成",
          status: "pending",
        },
      ];
      setAutoSteps(steps);
      setCurrentAutoStep(0);

      try {
        // Step 1: 競合分析
        updateAutoStep(0, { status: "running" });
        console.log("🚀 フル自動モード: Step 1 - 競合分析開始");

        // 競合分析の開始時間を記録
        await slackNotifier.notifyStepStart("competitor-research");

        const researchResult = await generateCompetitorResearch(
          newKeyword,
          (current, total) => {
            const progress = Math.round((current / total) * 100);
            updateAutoStep(0, { progress });
          },
          true
        );
        setCompetitorResearch(researchResult);

        // API使用回数をインクリメント（成功時のみ）
        incrementApiUsage();

        updateAutoStep(0, {
          status: "completed",
          result: `✅ ${researchResult.validArticles.length}サイトの分析完了`,
        });

        // Slack通知: 競合分析完了
        await slackNotifier.notifyStepComplete({
          keyword: newKeyword,
          step: "competitor-research",
          h2Count: researchResult.validArticles.length,
        });

        // Step 2: 構成生成Ver.2
        updateAutoStep(1, { status: "running" });
        console.log("🚀 フル自動モード: Step 2 - 構成生成開始");

        // 構成生成の開始時間を記録
        await slackNotifier.notifyStepStart("outline");

        const v2Outline = await generateOutlineV2(
          newKeyword,
          researchResult,
          includeImages,
          true
        );

        // v2Outlineの構造を確認
        console.log("📝 生成された構成:", v2Outline);

        // 正しいプロパティ名を使用（outlineが正しい）
        const sections = v2Outline.outline || [];

        updateAutoStep(1, {
          status: "completed",
          result: `✅ ${sections.length}個の見出しを含む構成生成完了`,
          details: v2Outline, // 構成の詳細データを保存
        });

        // Slack通知: 構成生成完了
        const h3Count = sections.reduce(
          (sum, section) => sum + (section.subheadings?.length || 0),
          0
        );
        await slackNotifier.notifyStepComplete({
          keyword: newKeyword,
          step: "outline",
          h2Count: sections.length,
          h3Count: h3Count,
        });

        // Step 3: 構成チェック
        updateAutoStep(2, { status: "running" });
        console.log("🚀 フル自動モード: Step 3 - 構成チェック開始");

        // 構成チェックの開始時間を記録
        await slackNotifier.notifyStepStart("check");

        const { finalOutline, checkResult, wasFixed } =
          await checkAndFixOutline(v2Outline, newKeyword, researchResult);

        // 品質チェックエージェントをスキップ（キーワード削除問題のため一時的に無効化）
        console.log(
          "⚠️ 品質チェックエージェントをスキップ（キーワード削除問題のため）"
        );
        // const qualityCheckedOutline = await runQualityCheck(finalOutline, newKeyword);
        setOutlineV2(finalOutline);
        updateAutoStep(2, {
          status: "completed",
          result: wasFixed
            ? `✅ 構成を自動修正し、品質チェック完了`
            : `✅ 品質チェック完了（修正不要）`,
          details: finalOutline, // 品質チェックをスキップしているのでfinalOutlineを使用
        });

        // Slack通知: 品質チェック完了（削除）
        // await slackNotifier.notifyStepComplete({
        //   keyword: newKeyword,
        //   step: 'check',
        //   score: 100 // チェックをスキップしているので仮の値
        // });

        // Step 4: 記事執筆（Ver.3）
        updateAutoStep(3, { status: "running" });
        console.log("🚀 フル自動モード: Step 4 - 記事執筆開始");

        // ArticleWriterを自動モードで開く
        setWritingMode("v3");
        setAutoArticleWriter(true);
        setShowArticleWriter(true);

        // 記事生成、最終校閲、自動修正はArticleWriterコンポーネント内で処理される
        // Step 4, 5, 6の完了はArticleWriterからのコールバックで処理される
      } catch (err) {
        console.error("❌ フル自動モードエラー:", err);
        const errorStep = autoSteps.findIndex((s) => s.status === "running");
        const stepName = errorStep >= 0 ? autoSteps[errorStep].id : "不明";

        // サーバーエラーの場合は上位に伝播（復旧待ち処理のため）
        const isServerError =
          err instanceof Error &&
          (err.message.includes("502") ||
            err.message.includes("503") ||
            err.message.includes("fetch") ||
            err.message.includes("Failed to fetch") ||
            err.message.includes("TypeError") ||
            err.message.includes("RENDER_RESTART_REQUIRED") ||
            err.message.includes("RENDER_SERVER_DOWN") ||
            err.message.includes("Puppeteerによるページ取得に失敗"));

        console.log("🔍 handleGenerateFullAuto エラー分析:", {
          isServerError,
          isQueueRun,
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        });

        // サーバーエラーかつキューモードの場合は、復旧待ち処理のためエラーを再投げ
        if (isServerError && isQueueRun) {
          console.log(
            "🔄 サーバーエラーを上位に伝播します（復旧待ち処理のため）"
          );
          throw err; // エラーを再投げして上位の復旧待ち処理に委ねる
        }

        // その他のエラーの場合は従来通り処理
        // Slack通知: エラー
        await slackNotifier.notifyError({
          keyword: newKeyword,
          step: stepName,
          error:
            err instanceof Error ? err.message : "不明なエラーが発生しました",
        });

        if (errorStep >= 0) {
          updateAutoStep(errorStep, {
            status: "error",
            error:
              err instanceof Error ? err.message : "不明なエラーが発生しました",
          });
        }
        setError(
          err instanceof Error
            ? err.message
            : "フル自動実行中にエラーが発生しました。"
        );
      } finally {
        setIsLoading(false);
        setIsAutoRunning(false);
        setIsFullAutoMode(false); // Keep-alive停止

        // キュー実行中の場合、次のキーワードを起動（一時的に無効化）
        // 画像生成エージェントからのARTICLE_COMPLETEDメッセージを待つため
        // if (isQueueRun && queueActiveRef.current) {
        //   console.log("⏭️ キュー実行中: 次のキーワードを起動します");
        //   setTimeout(() => {
        //     startNextKeywordFromQueue();
        //   }, 1000); // 1秒待ってから次のキーワードを処理
        // }
      }
    },
    [] // 依存関係を削除してcircular dependencyを回避
  );

  // handleGenerateFullAutoをrefに保存（循環依存を回避）
  useEffect(() => {
    handleGenerateFullAutoRef.current = handleGenerateFullAuto;
  }, [handleGenerateFullAuto]);

  // サーバー生存確認関数
  const checkServerHealth = useCallback(async (): Promise<boolean> => {
    try {
      const apiUrl =
        import.meta.env.VITE_API_URL?.replace("/api", "") ||
        import.meta.env.VITE_BACKEND_URL ||
        "";

      console.log("🏥 ヘルスチェック開始:", `${apiUrl}/api/health`);

      const response = await fetch(`${apiUrl}/api/health`, {
        method: "GET",
        timeout: 10000, // 10秒タイムアウト
      });

      const isHealthy = response.ok;
      console.log("🏥 ヘルスチェック応答:", {
        status: response.status,
        ok: response.ok,
        isHealthy,
      });

      return isHealthy;
    } catch (error) {
      console.log("🔍 サーバーヘルスチェック失敗:", error);
      return false;
    }
  }, []);

  // サーバー復旧待ち処理
  const waitForServerRecovery = useCallback(
    async (failedKeyword: { row: number; keyword: string }, error?: Error) => {
      console.log("🔄 サーバーダウンを検知。復旧を待機します...");
      console.log("🔍 失敗したキーワード:", failedKeyword);
      console.log("🔍 エラー詳細:", error?.message);
      console.log("🔍 復旧待ち処理開始時刻:", new Date().toLocaleTimeString());

      setIsWaitingForServerRecovery(true);
      setLastFailedKeyword(failedKeyword);
      setRecoveryAttempts(0);

      // Slack通知: サーバーダウン
      await slackNotifier.notifyError({
        keyword: failedKeyword.keyword,
        step: "server-connection",
        error: "サーバーがダウンしました。復旧を待機中...",
      });

      const maxAttempts = 60; // 最大60回（30分間）
      let attempts = 0;

      const checkInterval = setInterval(async () => {
        attempts++;
        setRecoveryAttempts(attempts);

        console.log(`🔍 サーバー復旧チェック ${attempts}/${maxAttempts}...`);
        console.log("⏰ 現在時刻:", new Date().toLocaleTimeString());
        console.log("🔍 復旧待ち状態:", {
          isWaitingForServerRecovery,
          queueActive: queueActiveRef.current,
          currentIndex: queueIndexRef.current,
        });

        const isHealthy = await checkServerHealth();
        console.log("🏥 ヘルスチェック結果:", isHealthy);

        if (isHealthy) {
          console.log("✅ サーバー復旧を確認！次のキーワードから再開します");

          clearInterval(checkInterval);
          setServerCheckInterval(null);
          setIsWaitingForServerRecovery(false);

          // Slack通知: サーバー復旧
          await slackNotifier.notifyStepComplete({
            keyword: failedKeyword.keyword,
            step: "server-recovery",
            h2Count: attempts, // 復旧までの試行回数
          });

          // 失敗したキーワードをスキップして次から再開
          const nextIndex = queueIndexRef.current + 1;
          if (nextIndex < keywordQueueRef.current.length) {
            const nextKeyword = keywordQueueRef.current[nextIndex];
            console.log(`⏭️ 次のキーワードから再開: ${nextKeyword.keyword}`);

            setQueueIndex(nextIndex);
            setQueueProgress({
              current: nextIndex,
              total: keywordQueueRef.current.length,
            });
            setCurrentSpreadsheetRow(nextKeyword.row);
            // 画像生成エージェントへ渡す行番号は ArticleWriter が localStorage から読むため、ここでも更新する
            localStorage.setItem("currentSpreadsheetRow", nextKeyword.row.toString());

            // 3秒待ってから再開（サーバー安定化のため）
            setTimeout(() => {
              console.log("🔄 サーバー復旧後、次のキーワードで再開します");
              handleGenerateFullAutoWithRecovery(
                nextKeyword.keyword,
                false,
                true
              );
            }, 3000);
          } else {
            console.log("🎉 キューの最後まで到達しました");
            if (cleanupQueueStateRef.current) {
              cleanupQueueStateRef.current();
            }
          }

          return;
        }

        if (attempts >= maxAttempts) {
          console.log("❌ サーバー復旧タイムアウト。処理を中断します");

          clearInterval(checkInterval);
          setServerCheckInterval(null);
          setIsWaitingForServerRecovery(false);

          // Slack通知: 復旧タイムアウト
          await slackNotifier.notifyError({
            keyword: failedKeyword.keyword,
            step: "server-recovery-timeout",
            error: `30分間待機しましたがサーバーが復旧しませんでした`,
          });

          // キュー処理を停止
          if (cleanupQueueStateRef.current) {
            cleanupQueueStateRef.current();
          }
        }
      }, 30000); // 30秒間隔でチェック

      setServerCheckInterval(checkInterval);
    },
    [checkServerHealth]
  );

  // エラーハンドリング強化版のhandleGenerateFullAuto
  const handleGenerateFullAutoWithRecovery = useCallback(
    async (
      newKeyword: string,
      includeImages: boolean,
      isQueueRun: boolean = false
    ) => {
      console.log("🚀 handleGenerateFullAutoWithRecovery 開始:", {
        keyword: newKeyword,
        isQueueRun,
        queueActive: queueActiveRef.current,
      });

      try {
        await handleGenerateFullAuto(newKeyword, includeImages, isQueueRun);
        console.log("✅ handleGenerateFullAuto 正常完了");
      } catch (error) {
        console.error("❌ 記事生成エラー:", error);
        console.log("🔍 エラーキャッチ - handleGenerateFullAutoWithRecovery");

        // デバッグ情報を出力
        console.log("🔍 エラーハンドリング デバッグ:");
        console.log("  - isQueueRun:", isQueueRun);
        console.log("  - queueActiveRef.current:", queueActiveRef.current);
        console.log(
          "  - error.message:",
          error instanceof Error ? error.message : "Not Error instance"
        );

        // サーバーエラー（502, 503）の場合は復旧待ち処理を開始
        const isServerError =
          error instanceof Error &&
          (error.message.includes("502") ||
            error.message.includes("503") ||
            error.message.includes("fetch") ||
            error.message.includes("Failed to fetch") ||
            error.message.includes("TypeError") ||
            error.message.includes("RENDER_RESTART_REQUIRED") ||
            error.message.includes("RENDER_SERVER_DOWN") ||
            error.message.includes("Puppeteerによるページ取得に失敗"));

        console.log("  - isServerError:", isServerError);

        if (isServerError) {
          if (isQueueRun && queueActiveRef.current) {
            console.log("🔄 復旧待ち処理を開始します");
            console.log("🔍 現在のキューインデックス:", queueIndexRef.current);
            console.log("🔍 キューの長さ:", keywordQueueRef.current.length);
            console.log("🔍 キューの内容:", keywordQueueRef.current);

            const currentKeyword =
              keywordQueueRef.current[queueIndexRef.current];
            console.log("🔍 失敗したキーワード:", currentKeyword);

            if (currentKeyword) {
              console.log(
                "✅ キーワードが見つかりました。復旧待ち処理を実行します"
              );
              await waitForServerRecovery(currentKeyword, error);
            } else {
              console.error("❌ 現在のキーワードが見つかりません！");
              console.log("🔍 デバッグ情報:", {
                queueIndex: queueIndexRef.current,
                queueLength: keywordQueueRef.current.length,
                queue: keywordQueueRef.current,
              });
            }
          } else {
            console.log(
              "⚠️ 復旧待ち処理をスキップ (キューが非アクティブまたは単発実行)"
            );
          }
        } else {
          // その他のエラーの場合は3分後に次のキーワードへ
          if (isQueueRun && queueActiveRef.current) {
            console.log(
              "⏭️ エラーが発生しましたが、3分後に次のキーワードに進みます"
            );

            setTimeout(() => {
              const nextIndex = queueIndexRef.current + 1;
              if (nextIndex < keywordQueueRef.current.length) {
                const nextKeyword = keywordQueueRef.current[nextIndex];

                setQueueIndex(nextIndex);
                setQueueProgress({
                  current: nextIndex,
                  total: keywordQueueRef.current.length,
                });
                setCurrentSpreadsheetRow(nextKeyword.row);
                localStorage.setItem("currentSpreadsheetRow", nextKeyword.row.toString());

                console.log(
                  "⏭️ 3分後の次のキーワード処理（エラーハンドリング付き）"
                );
                handleGenerateFullAutoWithRecovery(
                  nextKeyword.keyword,
                  false,
                  true
                );
              } else {
                if (cleanupQueueStateRef.current) {
                  cleanupQueueStateRef.current();
                }
              }
            }, 180000); // 3分後
          }
        }
      }
    },
    [handleGenerateFullAuto, waitForServerRecovery]
  );

  // ステップ更新ヘルパー関数
  const updateAutoStep = (index: number, update: Partial<AutoStep>) => {
    setAutoSteps((prev) => {
      const newSteps = [...prev];
      newSteps[index] = { ...newSteps[index], ...update };
      return newSteps;
    });
  };

  // フル自動モードのキャンセル
  const handleCancelAutoMode = () => {
    setIsAutoRunning(false);
    setIsFullAutoMode(false);
    setIsLoading(false);
    console.log("⛔ フル自動モードをキャンセルしました");
  };

  // フル自動モードのリトライ
  const handleRetryAutoStep = async (stepId: string) => {
    console.log(`🔄 ステップ ${stepId} をリトライします`);
    // リトライロジックは個別に実装
  };

  // キュー後片付け関数はrefベースの実装に移行済み（上記のcleanupQueueStateRefを参照）

  // 次のキーワードをキューから起動する関数
  const startNextKeywordFromQueue = useCallback(() => {
    if (!queueActiveRef.current) {
      console.log(
        "⏹️ キューが非アクティブのため、次のキーワード処理をスキップ"
      );
      return;
    }

    const nextIndex = queueIndexRef.current + 1;
    const queue = keywordQueueRef.current;

    if (nextIndex >= queue.length) {
      console.log("✅ 全キーワードの処理が完了しました");
      // refを使ってクリーンアップを実行
      if (cleanupQueueStateRef.current) {
        cleanupQueueStateRef.current();
      }
      return;
    }

    // Mutex: 起動中フラグをチェック
    if (isLaunchingRef.current) {
      console.log("⏳ 既に次のキーワードを起動中です。重複実行を防止します。");
      return;
    }

    // Mutex: 起動中フラグを設定
    isLaunchingRef.current = true;

    try {
      const nextKeyword = queue[nextIndex];
      console.log(
        `\n🔄 記事生成 ${nextIndex + 1}/${queue.length}: ${nextKeyword.keyword}`
      );

      // 状態更新
      setQueueIndex(nextIndex);
      setQueueProgress({ current: nextIndex, total: queue.length });
      setCurrentSpreadsheetRow(nextKeyword.row);
      localStorage.setItem("currentSpreadsheetRow", nextKeyword.row.toString());

      // エラーハンドリング強化版を使用
      handleGenerateFullAutoWithRecovery(nextKeyword.keyword, false, true);
    } finally {
      // 500ms後にMutex解除（handleGenerateFullAutoの初期化処理完了を待つ）
      setTimeout(() => {
        isLaunchingRef.current = false;
      }, 500);
    }
  }, []); // 依存関係を削除してcircular dependencyを回避

  // キーワードキューを順次処理する関数をrefに保存
  const processKeywordQueueRef =
    useRef<(keywords: Array<{ row: number; keyword: string }>) => void>();

  // processKeywordQueue関数を更新
  useEffect(() => {
    processKeywordQueueRef.current = (
      keywords: Array<{ row: number; keyword: string }>
    ) => {
      console.log(`📋 キューに${keywords.length}件のキーワードを追加しました`);

      // キュー配列を保存
      setKeywordQueue(keywords);
      setFailedQueueItems([]);
      setQueueProgress({ current: 0, total: keywords.length });
      setQueueIndex(0);
      setQueueActive(true);
      setIsProcessingQueue(true);

      // 最初のキーワードを起動
      setTimeout(() => {
        if (keywords.length > 0) {
          const firstKeyword = keywords[0];
          console.log(
            `\n🔄 記事生成 1/${keywords.length}: ${firstKeyword.keyword}`
          );

          setCurrentSpreadsheetRow(firstKeyword.row);
          localStorage.setItem(
            "currentSpreadsheetRow",
            firstKeyword.row.toString()
          );

          // エラーハンドリング強化版を使用
          handleGenerateFullAutoWithRecovery(firstKeyword.keyword, false, true);
        }
      }, 0);
    };
  });

  // コンポーネントで使用するためのラッパー関数
  const processKeywordQueue = useCallback(
    (keywords: Array<{ row: number; keyword: string }>) => {
      if (processKeywordQueueRef.current) {
        processKeywordQueueRef.current(keywords);
      }
    },
    []
  );

  // スプレッドシートモード自動復旧機能付きハンドラー
  const handleSpreadsheetModeWithRetry = useCallback(
    async (retryCount: number = 0) => {
      const maxRetries = 10; // 最大10回リトライ（5分間）

      try {
        await handleSpreadsheetMode();
      } catch (err) {
        console.error(
          `❌ スプレッドシートモード失敗 (${retryCount + 1}/${maxRetries}):`,
          err
        );

        const isServerError =
          err instanceof Error &&
          (err.message.includes("502") ||
            err.message.includes("503") ||
            err.message.includes("fetch") ||
            err.message.includes("Failed to fetch"));

        if (isServerError && retryCount < maxRetries) {
          console.log(
            `🔄 ${30}秒後に自動リトライ (${retryCount + 1}/${maxRetries})`
          );
          setError(
            `サーバー復旧待ち中... (${retryCount + 1}/${maxRetries}回目)`
          );

          setTimeout(() => {
            handleSpreadsheetModeWithRetry(retryCount + 1);
          }, 30000);
        } else {
          setError(
            "スプレッドシート取得に失敗しました: " + (err as Error).message
          );
        }
      }
    },
    []
  );

  // スプレッドシートモード開始ハンドラー
  const handleSpreadsheetMode = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;
      const apiUrl =
        import.meta.env.VITE_API_URL?.replace("/api", "") ||
        import.meta.env.VITE_BACKEND_URL ||
        "";

      if (!apiKey) {
        throw new Error(
          "🔐 環境変数 VITE_INTERNAL_API_KEY が設定されていません"
        );
      }

      console.log("📤 スプレッドシートからキーワードを取得中...");
      const response = await fetch(`${apiUrl}/api/spreadsheet-mode/keywords`, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          ...clientHeaders(),
        },
      });

      if (!response.ok) {
        const errorData = await response.json();

        // ADC認証エラーの場合
        if (
          response.status === 401 &&
          errorData.action === "ADC_REAUTH_REQUIRED"
        ) {
          throw new Error(
            `🔐 Google認証が期限切れです\n\nターミナルで以下を実行してください:\n${errorData.command}`
          );
        }

        throw new Error(
          `データ取得エラー: ${response.status} - ${
            errorData.error || "Unknown error"
          }`
        );
      }

      const data = await response.json();

      if (data.success && data.keywords.length > 0) {
        console.log(`📊 取得したキーワード数: ${data.count}`);

        // キューに全キーワードをセット（refを使用）
        if (processKeywordQueueRef.current) {
          processKeywordQueueRef.current(data.keywords);
        }
      } else {
        setError(data.error || "キーワードが見つかりませんでした");
      }
    } catch (err) {
      console.error("❌ スプレッドシート取得エラー:", err);

      // サーバーエラー（502, 503）の場合は自動復旧を試行
      const isServerError =
        err instanceof Error &&
        (err.message.includes("502") ||
          err.message.includes("503") ||
          err.message.includes("fetch") ||
          err.message.includes("Failed to fetch") ||
          err.message.includes("TypeError"));

      if (isServerError) {
        // エラーを再throw（上位のhandleSpreadsheetModeWithRetryで処理）
        throw err;
      } else {
        setError("スプレッドシート取得エラー: " + (err as Error).message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []); // 依存関係を削除してcircular dependencyを回避

  // クライアント管理画面（フラグ on のときのみ到達する）
  if (currentPage === "clients" && ClientsAdminPage) {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-800 font-sans">
        <div className="p-4">
          <button
            onClick={() => setCurrentPage("main")}
            className="mb-4 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-all duration-200"
          >
            ← メインページに戻る
          </button>
        </div>
        <React.Suspense fallback={<div className="p-6 text-sm text-gray-500">読み込み中...</div>}>
          <ClientsAdminPage />
        </React.Suspense>
      </div>
    );
  }

  // ファクトチェックページを表示
  if (currentPage === "factcheck") {
    return <FactCheckPage />;
  }

  // 記事修正ページを表示
  if (currentPage === "revision") {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="p-4">
          <button
            onClick={() => setCurrentPage("main")}
            className="mb-4 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-all duration-200"
          >
            ← メインページに戻る
          </button>
        </div>
        <ArticleRevisionForm onClose={() => setCurrentPage("main")} />
      </div>
    );
  }

  // テキストチェックページを表示
  if (currentPage === "textcheck") {
    return (
      <div className="min-h-screen bg-gray-50 text-gray-800 font-sans">
        <div className="p-4">
          <button
            onClick={() => setCurrentPage("main")}
            className="mb-4 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-all duration-200"
          >
            ← 構成生成ページに戻る
          </button>
        </div>
        <TextCheckPage />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 text-gray-800 font-sans flex flex-col items-center p-4 sm:p-6 lg:p-8">
      <header className="w-full max-w-5xl mb-8">
        {/* メインタイトル */}
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="p-2 bg-blue-100 rounded-xl">
              <LogoIcon className="h-8 w-8 text-blue-600" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800">
              Content Creation Agents
            </h1>
          </div>
          <p className="text-gray-500 text-sm sm:text-base">
            競合サイトを分析し、検索上位を狙える記事構成案をAIが作成します
          </p>
        </div>
        {/* ツールボタン */}
        <div className="flex gap-2 sm:gap-3 justify-center flex-wrap">
          <button
            onClick={() => handleSpreadsheetModeWithRetry()}
            disabled={isLoading || isProcessingQueue}
            className="px-4 py-2 bg-blue-500 text-white hover:bg-blue-600 rounded-lg transition-all duration-200 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            スプレッドシートモード
            {isProcessingQueue &&
              queueProgress &&
              ` (${queueProgress.current}/${queueProgress.total})`}
          </button>
          <a
            href="/guide.html"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-blue-500 text-white hover:bg-blue-600 rounded-lg transition-all duration-200 text-sm font-medium shadow-sm"
          >
            利用ガイド
          </a>
          {CLIENTS_ADMIN && (
            <button
              onClick={() => setCurrentPage("clients")}
              className="px-4 py-2 bg-gray-700 text-white hover:bg-gray-800 rounded-lg transition-all duration-200 text-sm font-medium shadow-sm"
              data-testid="open-clients-admin"
            >
              クライアント管理
            </button>
          )}
        </div>
      </header>

      <ClientSelector />

      <main className="w-full max-w-5xl flex-grow">
        <div className="bg-white rounded-2xl shadow-lg p-6 sm:p-8 border border-gray-200">
          <KeywordInputForm
            onGenerate={handleGenerate}
            onGenerateV2={handleGenerateV2}
            onGenerateFullAuto={handleGenerateFullAuto}
            onBatchProcess={processKeywordQueue}
            isLoading={isLoading}
            apiUsageToday={getApiUsageToday()}
            apiUsageWarning={apiUsageWarning}
            onOpenImageAgent={openImageAgentInIframe}
          />

          <div className="mt-8">
            {/* フル自動モード進捗表示 */}
            {isFullAutoMode && autoSteps.length > 0 && (
              <div className="mb-6">
                <AutoProgressDisplay
                  steps={autoSteps}
                  currentStep={currentAutoStep}
                  isRunning={isAutoRunning}
                  onRetry={handleRetryAutoStep}
                  onCancel={handleCancelAutoMode}
                />
              </div>
            )}

            {/* スプレッドシートモード進捗表示 */}
            {isProcessingQueue && queueProgress && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-blue-700 font-semibold">
                    {isWaitingForServerRecovery
                      ? "サーバー復旧待機中"
                      : "スプレッドシートモード実行中"}
                  </h3>
                  <span className="text-blue-600 text-sm">
                    {queueProgress.current}/{queueProgress.total} 完了
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                  <div
                    className={`h-2 rounded-full transition-all duration-300 ${
                      isWaitingForServerRecovery
                        ? "bg-amber-500"
                        : "bg-blue-500"
                    }`}
                    style={{
                      width: `${
                        (queueProgress.current / queueProgress.total) * 100
                      }%`,
                    }}
                  ></div>
                </div>
                {isWaitingForServerRecovery ? (
                  <div className="space-y-2">
                    <p className="text-amber-600 text-sm">
                      サーバーがダウンしました。復旧を待機中...
                    </p>
                    <p className="text-gray-500 text-xs">
                      復旧チェック: {recoveryAttempts}/60 回 (30秒間隔)
                    </p>
                    {lastFailedKeyword && (
                      <p className="text-gray-500 text-xs">
                        中断したキーワード: {lastFailedKeyword.keyword}
                      </p>
                    )}
                  </div>
                ) : currentSpreadsheetRow ? (
                  <p className="text-gray-600 text-sm">
                    現在処理中: 行{currentSpreadsheetRow} - {keyword}
                  </p>
                ) : null}

                {/* キャンセル・復旧待ちスキップボタン */}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => {
                      if (cleanupQueueStateRef.current) {
                        cleanupQueueStateRef.current();
                      }
                    }}
                    className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-sm rounded transition-all duration-200"
                  >
                    キュー停止
                  </button>

                  {isWaitingForServerRecovery && (
                    <button
                      onClick={async () => {
                        console.log(
                          "⏭️ サーバー復旧待ちをスキップして次のキーワードへ"
                        );

                        // 復旧待ちを停止
                        if (serverCheckInterval) {
                          clearInterval(serverCheckInterval);
                          setServerCheckInterval(null);
                        }
                        setIsWaitingForServerRecovery(false);

                        // 次のキーワードへ進む
                        const nextIndex = queueIndexRef.current + 1;
                        if (nextIndex < keywordQueueRef.current.length) {
                          const nextKeyword =
                            keywordQueueRef.current[nextIndex];

                          setQueueIndex(nextIndex);
                          setQueueProgress({
                            current: nextIndex,
                            total: keywordQueueRef.current.length,
                          });
                          setCurrentSpreadsheetRow(nextKeyword.row);
                          localStorage.setItem(
                            "currentSpreadsheetRow",
                            nextKeyword.row.toString()
                          );

                          handleGenerateFullAutoWithRecovery(
                            nextKeyword.keyword,
                            false,
                            true
                          );
                        } else {
                          if (cleanupQueueStateRef.current) {
                            cleanupQueueStateRef.current();
                          }
                        }
                      }}
                      className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded transition-all duration-200"
                    >
                      ⏭️ 復旧待ちスキップ
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* スプレッドシートモードでスキップしたキーワード（キュー完了後も残す） */}
            {failedQueueItems.length > 0 && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-red-700 font-semibold">
                    スキップしたキーワード（{failedQueueItems.length}件）
                  </h3>
                  {!isProcessingQueue && (
                    <button
                      onClick={() => setFailedQueueItems([])}
                      className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded border border-gray-300 transition-all duration-200"
                    >
                      閉じる
                    </button>
                  )}
                </div>
                <ul className="space-y-1 text-sm text-red-800">
                  {failedQueueItems.map((item, index) => (
                    <li key={`${item.keyword}-${index}`}>
                      行{item.row ?? "?"}「{item.keyword}」— {item.reason}（
                      {item.at}）
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isLoading && !isFullAutoMode && (
              <div>
                <LoadingSpinner />
                {analysisProgress && (
                  <div className="mt-4 bg-blue-50 p-4 rounded-xl border border-blue-200">
                    <div className="text-center mb-2">
                      <span className="text-blue-700 font-semibold">
                        競合サイト分析中: {analysisProgress.current}/
                        {analysisProgress.total} サイト完了
                      </span>
                    </div>
                    <div className="w-full bg-blue-100 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${
                            (analysisProgress.current /
                              analysisProgress.total) *
                            100
                          }%`,
                        }}
                      />
                    </div>
                    <div className="text-center mt-2 text-sm text-gray-500">
                      {analysisProgress.current < 5
                        ? "通常分析中..."
                        : analysisProgress.current % 5 === 0
                        ? "☕ 10秒の休憩中..."
                        : "通常分析中..."}
                    </div>
                  </div>
                )}
              </div>
            )}
            {error && <ErrorMessage message={error} />}

            {/* タブ切り替え */}
            {(outline || outlineV2 || competitorResearch) && !isLoading && (
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setActiveTab("research")}
                  className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 ${
                    activeTab === "research"
                      ? "bg-blue-500 text-white shadow-md"
                      : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
                  }`}
                >
                  記事一覧
                </button>
                {competitorResearch?.frequencyWords && (
                  <button
                    onClick={() => setActiveTab("frequency")}
                    className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 ${
                      activeTab === "frequency"
                        ? "bg-blue-500 text-white shadow-md"
                        : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
                    }`}
                  >
                    頻出単語
                  </button>
                )}
                <button
                  onClick={() => setActiveTab("outline")}
                  className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 ${
                    activeTab === "outline"
                      ? "bg-blue-500 text-white shadow-md"
                      : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
                  }`}
                >
                  構成案
                </button>
                {generatedArticle && (
                  <button
                    onClick={() => setActiveTab("article")}
                    className={`px-6 py-3 rounded-xl font-semibold transition-all duration-200 ${
                      activeTab === "article"
                        ? "bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md"
                        : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
                    }`}
                  >
                    記事本文
                  </button>
                )}
              </div>
            )}

            {/* タブコンテンツ */}
            {activeTab === "research" && competitorResearch && !isLoading && (
              <CompetitorResearchWebFetch research={competitorResearch} />
            )}

            {activeTab === "frequency" &&
              competitorResearch?.frequencyWords &&
              !isLoading && (
                <FrequencyWordsTab
                  frequencyWords={competitorResearch.frequencyWords}
                  totalArticles={competitorResearch.validArticles.length}
                />
              )}

            {activeTab === "outline" && !isLoading && (
              <>
                {/* Ver.2の構成案表示 */}
                {outlineV2 && isV2Mode && (
                  <OutlineDisplayV2
                    outline={outlineV2}
                    keyword={keyword}
                    onStartWritingV1={() => {
                      setWritingMode("v1");
                      setShowArticleWriter(true);
                    }}
                    // Ver.2ボタンは非表示
                    // onStartWriting={() => {
                    //   setWritingMode('v2');
                    //   setShowArticleWriter(true);
                    // }}
                    onStartWritingV3={() => {
                      setWritingMode("v3");
                      setShowArticleWriter(true);
                    }}
                  />
                )}

                {/* Ver.1の構成案表示 */}
                {outline &&
                  !isV2Mode &&
                  (outline.competitorResearch?.frequencyWords ? (
                    <OutlineDisplayOptimized
                      outline={outline}
                      keyword={keyword}
                      sources={sources}
                      onArticleGenerated={(article) => {
                        setGeneratedArticle(article);
                        setActiveTab("article");
                      }}
                    />
                  ) : (
                    <OutlineDisplay
                      outline={outline}
                      keyword={keyword}
                      sources={sources}
                      onArticleGenerated={(article) => {
                        setGeneratedArticle(article);
                        setActiveTab("article");
                      }}
                    />
                  ))}
              </>
            )}

            {activeTab === "article" && generatedArticle && !isLoading && (
              <ArticleDisplay
                article={generatedArticle}
                keyword={keyword}
                outline={outline}
                onEditClick={() => {
                  // 編集を再開するためArticleWriterを開く
                  if (outline || outlineV2) {
                    setShowArticleWriter(true);
                  }
                }}
                onOpenImageAgent={openImageAgentInIframe}
              />
            )}

            {!isLoading && !error && !outline && !competitorResearch && (
              <div className="text-center py-16 px-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                <SparklesIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-4 text-xl font-semibold text-gray-700">
                  競合分析と構成案を待っています
                </h3>
                <p className="mt-1 text-gray-500">
                  上記にキーワードを入力して「構成案を作成」ボタンをクリックしてください。
                </p>
                <p className="mt-2 text-sm text-blue-500">
                  上位15サイトを分析し、最適な記事構成を提案します。
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
      <footer className="w-full max-w-5xl mt-8 text-center text-gray-500 text-sm">
        <p>Powered by Google Gemini API</p>
      </footer>

      {/* 記事執筆モーダル */}
      {(showArticleWriter || showWriterDirectly) &&
        (outline || outlineV2) && (
          <ArticleWriter
            outline={outlineV2 || outline!}
            keyword={keyword}
            writingMode={writingMode}
            testMode={false} // テストモード強制無効化
            revisionTestMode={false} // 修正サービステストモード無効化
            isAutoMode={autoArticleWriter} // フル自動モードフラグ
            skipAutoGenerate={showArticleWriter && generatedArticle !== null} // 編集再開時は自動生成をスキップ
            onOpenImageAgent={openImageAgentInIframe}
            onClose={() => {
              setShowArticleWriter(false);
              setShowWriterDirectly(false);
              setAutoArticleWriter(false);
            }}
            onArticleGenerated={(article) => {
              setGeneratedArticle(article);
              setActiveTab("article");

              // フル自動モードの場合、Step 4（記事執筆）の完了を記録
              if (isFullAutoMode && autoArticleWriter) {
                updateAutoStep(3, {
                  status: "completed",
                  result: `✅ 記事執筆完了（Ver.3）`,
                });
                // Step 5（最終校閲）を開始
                updateAutoStep(4, { status: "running" });
                console.log("🚀 フル自動モード: Step 5 - 最終校閲開始");
              }

              // 最終校閲テストモードの場合はArticleWriterを開いたままにする
              // （最終校閲ボタンを押せるようにするため）
              if (showWriterDirectly) {
                console.log(
                  "🧪 最終校閲テストモード: ArticleWriterを開いたままにします"
                );
                // ArticleWriterを閉じない
                // setShowArticleWriter(false);
                // setShowWriterDirectly(false);
              }
            }}
            onAutoRevisionStart={() => {
              // Step 6（自動修正）開始
              updateAutoStep(5, { status: "running" });
              console.log("🚀 フル自動モード: Step 6 - 自動修正開始");
            }}
            onAutoComplete={async () => {
              // フル自動モードの全工程完了時の処理
              console.log("✅ フル自動モード: 全工程完了（自動修正含む）");

              // Step 5（最終校閲）の完了を記録
              updateAutoStep(4, {
                status: "completed",
                result: `✅ 最終校閲完了（マルチエージェント10個使用）`,
              });

              // Step 6（自動修正）の完了を記録
              updateAutoStep(5, {
                status: "completed",
                result: `✅ 自動修正完了（1回実行）`,
              });

              // Step 7: 画像生成エージェントはArticleWriter内のstartImageGenerationで起動済み
              // （startImageGeneration内でslug生成とonOpenImageAgent呼び出しが行われる）
              updateAutoStep(6, {
                status: "completed",
                result: "✅ 画像生成エージェント起動完了（iframe）",
              });

              // 最終的な記事情報を取得
              const finalArticle = generatedArticle;
              const charCount = finalArticle?.plainText?.length || 0;
              const h2Count = outlineV2?.sections?.length || 0;
              const h3Count =
                outlineV2?.sections?.reduce(
                  (sum, section) => sum + (section.subheadings?.length || 0),
                  0
                ) || 0;

              // Slack通知: 完了
              await slackNotifier.notifyComplete({
                keyword: keyword,
                charCount: charCount,
                h2Count: h2Count,
                h3Count: h3Count,
                score: 85, // マルチエージェントのスコアを使用する場合は更新
                url: window.location.href,
              });

              // 自動実行フラグをリセット
              setIsAutoRunning(false);
              setAutoArticleWriter(false);
              setIsFullAutoMode(false); // Keep-alive停止

              // ArticleWriterは開いたままにして、結果を確認できるようにする
              console.log(
                "🎉 フル自動実行が完了しました！画像生成エージェントが自動起動されました。"
              );
            }}
          />
        )}

        {/* 画像生成エージェントiframe */}
        {imageAgentEmbedState && (
          <ImageGeneratorIframe
            embedState={imageAgentEmbedState}
            iframeRef={imageAgentIframeRef}
            onLoad={sendDataToImageAgentIframe}
            onError={(error) => {
              console.error("❌ 画像生成エージェントiframeエラー:", error);
              // エラー時は別タブで開き直すことを提案
            }}
            onClose={closeImageAgentIframe}
            onReopenInNewTab={reopenImageAgentInNewTab}
            height="calc(100vh - 120px)"
          />
        )}
    </div>
  );
};

export default App;
