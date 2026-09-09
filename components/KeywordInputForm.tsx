import React, { useState } from "react";
import { SearchIcon } from "./icons";
import { SpreadsheetModeToggle } from "./SpreadsheetModeToggle";
import { SpreadsheetDataViewer } from "./SpreadsheetDataViewer";
import { getActiveClientId } from "../services/clientContext";

interface SpreadsheetKeyword {
  row: number;
  keyword: string;
  status?: string;
  lastUpdated?: string;
}

interface KeywordInputFormProps {
  onGenerate: (keyword: string, includeImages: boolean) => void;
  onGenerateV2?: (keyword: string, includeImages: boolean) => void;
  onGenerateFullAuto?: (keyword: string, includeImages: boolean) => void; // フル自動モード用
  onBatchProcess?: (keywords: SpreadsheetKeyword[]) => void; // 一括処理用
  isLoading: boolean;
  apiUsageToday?: number;
  apiUsageWarning?: string | null;
  apiBaseUrl?: string; // スプレッドシートAPI用
  onOpenImageAgent?: (articleData: {
    title: string;
    content: string;
    keyword: string;
    autoMode?: boolean;
  }) => void; // 画像生成エージェントをiframeで開く
}

const KeywordInputForm: React.FC<KeywordInputFormProps> = ({
  onGenerate,
  onGenerateV2,
  onGenerateFullAuto,
  onBatchProcess,
  isLoading,
  apiUsageToday = 0,
  apiUsageWarning,
  apiBaseUrl = import.meta.env.VITE_API_URL?.replace("/api", "") ||
    import.meta.env.VITE_BACKEND_URL ||
    "",
  onOpenImageAgent,
}) => {
  // デバッグ用ログ
  console.log("🔍 KeywordInputForm Debug:");
  console.log("  VITE_API_URL:", import.meta.env.VITE_API_URL);
  console.log("  apiBaseUrl prop:", apiBaseUrl);
  console.log("  Final apiBaseUrl:", apiBaseUrl);

  const [keyword, setKeyword] = useState("");
  const [includeImages, setIncludeImages] = useState(true);
  const [isFullAutoMode, setIsFullAutoMode] = useState(false); // フル自動モードの状態
  const [isSpreadsheetMode, setIsSpreadsheetMode] = useState(false); // スプレッドシートモード
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGenerate(keyword, includeImages);
  };

  const handleSubmitV2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (isFullAutoMode && onGenerateFullAuto) {
      // フル自動モードで実行
      onGenerateFullAuto(keyword, includeImages);
    } else if (onGenerateV2) {
      // 通常のVer.2実行
      onGenerateV2(keyword, includeImages);
    }
  };

  const handleSpreadsheetModeChange = (enabled: boolean) => {
    setIsSpreadsheetMode(enabled);
    if (!enabled) {
      setSelectedRow(null);
    }
  };

  const handleSpreadsheetDataSelect = (data: {
    keyword: string;
    row: number;
  }) => {
    setKeyword(data.keyword);
    setSelectedRow(data.row);
  };

  const handleBatchProcess = (keywords: SpreadsheetKeyword[]) => {
    if (onBatchProcess) {
      onBatchProcess(keywords);
    }
  };

  return (
    <div className="space-y-4">
      {/* スプレッドシートモードのトグル */}
      <SpreadsheetModeToggle
        onModeChange={handleSpreadsheetModeChange}
        disabled={isLoading}
      />

      {/* スプレッドシートデータビューア */}
      {isSpreadsheetMode && (
        <SpreadsheetDataViewer
          onDataSelect={handleSpreadsheetDataSelect}
          onBatchProcess={onBatchProcess ? handleBatchProcess : undefined}
          apiBaseUrl={apiBaseUrl}
        />
      )}

      {/* フル自動モードのトグル */}
      <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <label
              htmlFor="fullAutoMode"
              className="flex items-center cursor-pointer"
            >
              <input
                id="fullAutoMode"
                type="checkbox"
                checked={isFullAutoMode}
                onChange={(e) => setIsFullAutoMode(e.target.checked)}
                disabled={isLoading}
                className="w-5 h-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
              />
              <div className="ml-3">
                <span className="text-gray-800 font-semibold">
                  フル自動モード
                </span>
                <span className="ml-2 text-xs bg-gradient-to-r from-blue-500 to-indigo-500 text-white px-2 py-1 rounded-full">
                  NEW
                </span>
              </div>
            </label>
          </div>
          <div className="text-gray-500 text-sm">
            {isFullAutoMode ? (
              <span className="text-blue-600">
                構成生成 → 執筆 → 最終校閲まで全自動実行
              </span>
            ) : (
              <span>従来通り各工程を手動で実行</span>
            )}
          </div>
        </div>
        {isFullAutoMode && (
          <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-700">
              <strong>フル自動モードでは以下の処理を連続実行します：</strong>
            </p>
            <ol className="mt-2 text-xs text-gray-600 space-y-1 list-decimal list-inside">
              <li>競合サイト分析（15サイト）</li>
              <li>構成案生成（Ver.2）＋ 構成チェック</li>
              <li>記事執筆（Ver.3 Gemini Pro + Grounding）</li>
              <li>最終校閲（マルチエージェント10個）</li>
            </ol>
            <p className="mt-2 text-xs text-amber-600">
              全工程完了まで約3-5分かかります
            </p>
          </div>
        )}
      </div>

      {/* キーワード入力フォーム */}
      <form
        onSubmit={handleSubmitV2}
        className="flex flex-col sm:flex-row items-center gap-4"
      >
        <div className="relative w-full">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <SearchIcon className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="例: 「React パフォーマンス最適化」"
            className="w-full pl-11 pr-4 py-3.5 bg-white border border-gray-200 rounded-xl text-gray-800 placeholder-gray-400 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 transition duration-200 ease-in-out shadow-sm"
            disabled={isLoading}
          />
          {/* API使用回数の表示 */}
          <div className="absolute -bottom-6 left-0 text-xs text-gray-500">
            本日のCustom Search APIの無料利用分 あと
            {Math.max(0, 50 - apiUsageToday)}回
            {apiUsageToday >= 50 && (
              <span className="text-orange-500 ml-2">
                （以降は従量課金：約1.5円/回）
              </span>
            )}
          </div>
        </div>
        {onGenerateV2 && (
          <button
            type="submit"
            disabled={isLoading}
            className={`w-full sm:w-auto flex items-center justify-center px-6 py-3.5 font-bold rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white transition-all duration-200 ease-in-out disabled:bg-gray-300 disabled:cursor-not-allowed transform hover:scale-105 disabled:scale-100 shadow-md whitespace-nowrap ${
              isFullAutoMode
                ? "bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 text-white hover:from-blue-600 hover:via-indigo-600 hover:to-purple-600 focus:ring-blue-500"
                : "bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-600 hover:to-blue-700 focus:ring-blue-500"
            }`}
          >
            {isLoading ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {isFullAutoMode ? "自動実行中..." : "分析中..."}
              </>
            ) : (
              <>{isFullAutoMode ? "フル自動で開始" : "構成"}</>
            )}
          </button>
        )}
      </form>

      {/* 無料枠超過警告の表示 */}
      {apiUsageWarning && (
        <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-sm text-amber-700">{apiUsageWarning}</p>
        </div>
      )}

{/* 開発用テストボタン - コメントアウト
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <h3 className="text-amber-700 font-semibold mb-2">開発用テスト</h3>
        <button
          onClick={() => {
            const testArticleData = {
              title: `【2025年最新】${keyword || "テストキーワード"}完全ガイド | 初心者から上級者まで徹底解説`,
              htmlContent: `<h1>${keyword || "テストキーワード"}完全ガイド</h1>...`,
              metaDescription: `${keyword || "テストキーワード"}について、基礎から応用まで幅広くカバーした完全ガイドです。`,
              keyword: keyword || "テストキーワード",
              slug: "test-article-for-image-generation",
              isTestMode: true,
            };
            console.log("🧪 テスト用記事データで画像生成エージェントを起動");
            localStorage.setItem("articleDataForImageGen_5176", JSON.stringify(testArticleData));
            if (onOpenImageAgent) {
              onOpenImageAgent({
                title: testArticleData.title,
                content: testArticleData.htmlContent,
                keyword: testArticleData.keyword,
                autoMode: false,
                metaDescription: testArticleData.metaDescription,
                slug: testArticleData.slug,
                isTestMode: true,
              });
            } else {
              const imageGenUrl = import.meta.env.VITE_IMAGE_GEN_URL || "http://localhost:5177";
              const activeClientId = getActiveClientId();
              if (!activeClientId) {
                console.warn("⚠️ clientId が未選択の状態で画像生成エージェントを起動します");
              }
              const urlWithClient = activeClientId
                ? `${imageGenUrl}${imageGenUrl.includes("?") ? "&" : "?"}clientId=${encodeURIComponent(activeClientId)}`
                : imageGenUrl;
              const newWindow = window.open(urlWithClient, "_blank");
              if (newWindow) {
                setTimeout(() => {
                  newWindow.postMessage({ type: "ARTICLE_DATA", clientId: activeClientId, data: testArticleData }, imageGenUrl);
                }, 2000);
              }
            }
          }}
          disabled={isLoading}
          className="w-full px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg hover:from-amber-600 hover:to-orange-600 focus:outline-none focus:ring-2 focus:ring-amber-400 transition-all duration-200 ease-in-out disabled:bg-gray-300 disabled:cursor-not-allowed font-medium"
        >
          画像生成テスト（記事作成なし）
        </button>
        <p className="text-xs text-gray-500 mt-2">
          記事作成をスキップして、テスト用データで画像生成エージェントを直接起動します
        </p>
      </div>
      */}
    </div>
  );
};

export default KeywordInputForm;
