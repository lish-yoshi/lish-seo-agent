import React, { useState, useEffect } from "react";
import { clientHeaders } from "../services/clientContext";

interface SpreadsheetKeyword {
  row: number;
  keyword: string;
  status?: string;
  lastUpdated?: string;
}

interface SpreadsheetDataViewerProps {
  onDataSelect: (data: { keyword: string; row: number }) => void;
  onBatchProcess?: (keywords: SpreadsheetKeyword[]) => void;
  apiBaseUrl: string;
}

export const SpreadsheetDataViewer: React.FC<SpreadsheetDataViewerProps> = ({
  onDataSelect,
  onBatchProcess,
  apiBaseUrl,
}) => {
  const [keywords, setKeywords] = useState<SpreadsheetKeyword[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<number>>(
    new Set()
  );
  const [currentRow, setCurrentRow] = useState<number | null>(null);

  const fetchSpreadsheetData = async () => {
    setLoading(true);
    setError(null);

    try {
      console.log("📤 APIリクエスト送信中...");
      console.log("  URL:", `${apiBaseUrl}/api/spreadsheet-mode/keywords`);

      const response = await fetch(
        `${apiBaseUrl}/api/spreadsheet-mode/keywords`,
        {
          method: "GET",
          headers: clientHeaders(),
        }
      );

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

      if (data.success && data.keywords) {
        setKeywords(data.keywords);
        console.log(`📊 ${data.keywords.length}件のキーワードを取得しました`);
      } else {
        throw new Error(data.error || "キーワードデータが見つかりませんでした");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "データ取得に失敗しました";
      setError(errorMessage);
      console.error("スプレッドシートデータ取得エラー:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSpreadsheetData();
  }, [apiBaseUrl]);

  const handleKeywordSelect = (keyword: SpreadsheetKeyword) => {
    setCurrentRow(keyword.row);
    onDataSelect({ keyword: keyword.keyword, row: keyword.row });
  };

  const handleCheckboxChange = (row: number) => {
    const newSelected = new Set(selectedKeywords);
    if (newSelected.has(row)) {
      newSelected.delete(row);
    } else {
      newSelected.add(row);
    }
    setSelectedKeywords(newSelected);
  };

  const handleBatchProcess = () => {
    if (onBatchProcess && selectedKeywords.size > 0) {
      const selectedData = keywords.filter((k) => selectedKeywords.has(k.row));
      onBatchProcess(selectedData);
    }
  };

  const handleSelectAll = () => {
    if (selectedKeywords.size === keywords.length) {
      setSelectedKeywords(new Set());
    } else {
      setSelectedKeywords(new Set(keywords.map((k) => k.row)));
    }
  };

  if (loading) {
    return (
      <div className="p-6 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-center space-x-2">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
          <span className="text-gray-600">
            スプレッドシートからキーワードを読み込み中...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-white rounded-xl border border-red-200 shadow-sm">
        <div className="text-red-600 mb-4">
          <h3 className="font-medium">データ取得エラー</h3>
          <pre className="text-sm mt-2 whitespace-pre-wrap">{error}</pre>
        </div>
        <button
          onClick={fetchSpreadsheetData}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm"
        >
          再試行
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-800">
          スプレッドシートキーワード ({keywords.length}件)
        </h3>
        <div className="flex gap-2">
          <button
            onClick={fetchSpreadsheetData}
            className="px-3 py-1 text-sm bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 border border-gray-200"
          >
            更新
          </button>
          {onBatchProcess && (
            <button
              onClick={handleSelectAll}
              className="px-3 py-1 text-sm bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 border border-gray-200"
            >
              {selectedKeywords.size === keywords.length
                ? "全選択解除"
                : "全選択"}
            </button>
          )}
        </div>
      </div>

      {keywords.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <p>スプレッドシートにキーワードが見つかりませんでした</p>
          <p className="text-sm mt-1">B列にキーワードを入力してください</p>
        </div>
      ) : (
        <>
          <div className="space-y-2 max-h-96 overflow-y-auto mb-4">
            {keywords.map((keywordData, index) => (
              <div
                key={keywordData.row}
                className={`p-3 border rounded-xl transition-colors ${
                  currentRow === keywordData.row
                    ? "border-blue-400 bg-blue-50"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3 flex-1">
                    {onBatchProcess && (
                      <input
                        type="checkbox"
                        checked={selectedKeywords.has(keywordData.row)}
                        onChange={() => handleCheckboxChange(keywordData.row)}
                        className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                      />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-500">
                          行{keywordData.row}:
                        </span>
                        <span className="text-gray-800 font-medium">
                          {keywordData.keyword}
                        </span>
                      </div>
                      {keywordData.status && (
                        <div className="mt-1">
                          <span
                            className={`text-xs px-2 py-1 rounded ${
                              keywordData.status === "完了"
                                ? "bg-green-100 text-green-700"
                                : keywordData.status === "処理中"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {keywordData.status}
                          </span>
                          {keywordData.lastUpdated && (
                            <span className="text-xs text-gray-500 ml-2">
                              {keywordData.lastUpdated}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleKeywordSelect(keywordData)}
                    className="px-3 py-1 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                  >
                    選択
                  </button>
                </div>
              </div>
            ))}
          </div>

          {onBatchProcess && selectedKeywords.size > 0 && (
            <div className="border-t border-gray-200 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">
                  {selectedKeywords.size}件選択中
                </span>
                <button
                  onClick={handleBatchProcess}
                  className="px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-xl hover:from-blue-600 hover:to-indigo-600 font-medium shadow-sm"
                >
                  選択したキーワードで一括処理開始
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
