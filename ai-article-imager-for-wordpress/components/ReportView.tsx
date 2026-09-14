import { clientHeaders } from "../services/clientContext";
import React, { useState, useEffect, useRef } from "react";
import { ReportLog, PostConfig, WPConfig, H2Section } from "../types";
import { uploadImage, createPost } from "../services/wordpressService";
import { slackService } from "../services/slackService";

interface ReportViewProps {
  logs: ReportLog[];
  sections: H2Section[];
  articleHtml: string | null;
  postConfig: PostConfig;
  wpConfig: WPConfig;
  metaData?: {
    metaDescription?: string;
    slug?: string;
    keyword?: string;
    spreadsheetRow?: number;
  };
  autoExecute?: boolean;
}

interface PostResult {
  success: boolean;
  message: string;
  link?: string;
}

export const ReportView: React.FC<ReportViewProps> = ({
  logs,
  sections,
  articleHtml,
  postConfig,
  wpConfig,
  metaData,
  autoExecute,
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [postResult, setPostResult] = useState<PostResult | null>(null);
  const [progressMessage, setProgressMessage] = useState("");
  const [finalHtml, setFinalHtml] = useState<string | null>(null);
  const [useBlockEditor, setUseBlockEditor] = useState(true); // デフォルトはブロックエディタ
  const [uploadedSections, setUploadedSections] = useState<
    Map<number, { mediaId: number; sourceUrl: string }>
  >(new Map());
  const [baseHtmlWithImages, setBaseHtmlWithImages] = useState<string | null>(
    null
  );
  const [autoFlowExecuted, setAutoFlowExecuted] = useState(false);
  const autoFlowTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const successfulGenerations = logs.filter(
    (log) => log.status === "success"
  ).length;
  // WordPress認証はサーバー側で処理されるため、wpConfigの検証は不要
  const canPost = successfulGenerations > 0;

  // HTML変換のみを行う関数
  const convertHtmlFormat = (htmlContent: string, toBlockEditor: boolean) => {
    if (!toBlockEditor) {
      // クラシックエディタの場合、ブロックエディタのコメントを削除して画像タグを調整
      let classicHtml = htmlContent;

      // wp:imageブロックをクラシック形式に変換
      classicHtml = classicHtml.replace(
        /<!-- wp:image[^>]*-->[\s\S]*?<img([^>]*)src="([^"]*)"([^>]*)alt="([^"]*)"([^>]*)class="wp-image-(\d+)"([^>]*)\/?>[\s\S]*?<!-- \/wp:image -->/gi,
        (match, attrs1, src, attrs2, alt, attrs3, imageId, attrs4) => {
          return `<img src="${src}" alt="${alt}" class="alignnone size-full wp-image-${imageId}" />`;
        }
      );

      // その他のブロックエディタコメントを削除
      classicHtml = classicHtml.replace(/<!-- wp:[^>]*-->/g, "");
      classicHtml = classicHtml.replace(/<!-- \/wp:[^>]*-->/g, "");

      // wp-block-headingクラスを削除
      classicHtml = classicHtml.replace(/class="wp-block-heading"/g, "");

      // figure要素を削除（画像以外）
      classicHtml = classicHtml.replace(
        /<figure class="wp-block-[^"]*">([^<]*<(?!img)[^>]+>[\s\S]*?)<\/figure>/gi,
        "$1"
      );

      return classicHtml;
    }

    // ブロックエディタ形式に変換
    let converted = htmlContent;

    // H2見出しをブロック化
    converted = converted.replace(
      /<h2([^>]*)>(.+?)<\/h2>/gi,
      (match, attrs, content) => {
        return `<!-- wp:heading {"level":2} -->\n<h2 class="wp-block-heading"${attrs}>${content}</h2>\n<!-- /wp:heading -->`;
      }
    );

    // H3見出しをブロック化
    converted = converted.replace(
      /<h3([^>]*)>(.+?)<\/h3>/gi,
      (match, attrs, content) => {
        return `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading"${attrs}>${content}</h3>\n<!-- /wp:heading -->`;
      }
    );

    // H4見出しをブロック化
    converted = converted.replace(
      /<h4([^>]*)>(.+?)<\/h4>/gi,
      (match, attrs, content) => {
        return `<!-- wp:heading {"level":4} -->\n<h4 class="wp-block-heading"${attrs}>${content}</h4>\n<!-- /wp:heading -->`;
      }
    );

    // 段落をブロック化（既存のwp:imageブロックは除外）
    converted = converted.replace(
      /<p([^>]*)>(.+?)<\/p>/gi,
      (match, attrs, content) => {
        if (match.includes("<!-- wp:")) {
          return match;
        }
        return `<!-- wp:paragraph -->\n<p${attrs}>${content}</p>\n<!-- /wp:paragraph -->`;
      }
    );

    // ulリストをブロック化
    converted = converted.replace(
      /<ul([^>]*)>([\s\S]*?)<\/ul>/gi,
      (match, attrs, content) => {
        if (match.includes("<!-- wp:")) {
          return match;
        }
        return `<!-- wp:list -->\n<ul${attrs}>${content}</ul>\n<!-- /wp:list -->`;
      }
    );

    // olリストをブロック化
    converted = converted.replace(
      /<ol([^>]*)>([\s\S]*?)<\/ol>/gi,
      (match, attrs, content) => {
        if (match.includes("<!-- wp:")) {
          return match;
        }
        return `<!-- wp:list {"ordered":true} -->\n<ol${attrs}>${content}</ol>\n<!-- /wp:list -->`;
      }
    );

    // blockquoteをブロック化
    converted = converted.replace(
      /<blockquote([^>]*)>([\s\S]*?)<\/blockquote>/gi,
      (match, attrs, content) => {
        if (match.includes("<!-- wp:")) {
          return match;
        }
        return `<!-- wp:quote -->\n<blockquote class="wp-block-quote"${attrs}>${content}</blockquote>\n<!-- /wp:quote -->`;
      }
    );

    // tableをブロック化
    converted = converted.replace(
      /<table([^>]*)>([\s\S]*?)<\/table>/gi,
      (match, attrs, content) => {
        if (match.includes("<!-- wp:")) {
          return match;
        }
        return `<!-- wp:table -->\n<figure class="wp-block-table"><table${attrs}>${content}</table></figure>\n<!-- /wp:table -->`;
      }
    );

    return converted;
  };

  // Auto-execute effect
  useEffect(() => {
    if (
      autoExecute &&
      canPost &&
      !autoFlowExecuted &&
      !finalHtml &&
      !postResult
    ) {
      console.log(
        "🚀 自動フロー開始: 画像アップロード処理を3秒後に開始します..."
      );

      // 3秒待ってから自動実行（ユーザーが画面を確認できるように）
      autoFlowTimeoutRef.current = setTimeout(() => {
        console.log("📤 画像アップロード自動実行中...");
        handlePreparePost();
        setAutoFlowExecuted(true);
      }, 3000);
    }

    return () => {
      if (autoFlowTimeoutRef.current) {
        clearTimeout(autoFlowTimeoutRef.current);
      }
    };
  }, [autoExecute, canPost, autoFlowExecuted, finalHtml, postResult]);

  // Auto-post effect
  useEffect(() => {
    if (
      autoExecute &&
      finalHtml &&
      !postResult &&
      !isUploading &&
      autoFlowExecuted
    ) {
      console.log("📝 自動フロー: WordPress投稿を2秒後に実行します...");

      // 2秒待ってから投稿（HTMLレビューの時間を確保）
      const timeout = setTimeout(() => {
        console.log("📮 WordPress投稿自動実行中...");
        handleCreatePost();
      }, 2000);

      return () => clearTimeout(timeout);
    }
  }, [autoExecute, finalHtml, postResult, isUploading, autoFlowExecuted]);

  // 親ウィンドウ（SEOエージェント）に1記事分の結果を通知する。
  // スプレッドシートモードのキューはこの通知で次のキーワードへ進むため、失敗時も必ず送る。
  const notifyParentCompletion = (result: {
    success: boolean;
    keyword?: string;
    row?: number;
    error?: string;
    postUrl?: string;
  }) => {
    const parentOrigin =
      import.meta.env.VITE_MAIN_APP_URL || "http://localhost:5176";

    // iframe内の場合はwindow.parent、別タブの場合はwindow.openerを使用
    const parentWindow = window.parent !== window ? window.parent : window.opener;
    const isIframe = window.parent !== window;

    if (!parentWindow || !(isIframe || (window.opener && !window.opener.closed))) {
      console.warn("⚠️ 親ウィンドウが見つからないか、既に閉じられています");
      return;
    }

    try {
      parentWindow.postMessage({ type: "ARTICLE_COMPLETED", ...result }, parentOrigin);
      console.log(
        `📤 親ウィンドウ (${parentOrigin}) に${result.success ? "完了" : "失敗"}通知を送信しました（${isIframe ? "iframe" : "別タブ"}経由）`
      );
    } catch (notifyError) {
      console.error("❌ 親ウィンドウへの通知に失敗しました:", notifyError);
    }
  };

  const handlePreparePost = async () => {
    if (!articleHtml) {
      setPostResult({
        success: false,
        message: "Original article HTML is missing.",
      });
      return;
    }

    setIsUploading(true);
    setPostResult(null);
    setProgressMessage("Starting process...");
    setFinalHtml(null);

    try {
      const sectionsToUpload = sections.filter(
        (s) => s.status === "success" && s.generatedImage
      );
      const newUploadedSections = new Map<
        number,
        { mediaId: number; sourceUrl: string }
      >();

      for (let i = 0; i < sectionsToUpload.length; i++) {
        const section = sectionsToUpload[i];
        setProgressMessage(
          `Uploading image ${i + 1} of ${sectionsToUpload.length} for "${
            section.h2Text
          }"...`
        );

        try {
          const { id, source_url } = await uploadImage(
            wpConfig,
            section.generatedImage!,
            section
          );
          newUploadedSections.set(section.id, {
            mediaId: id,
            sourceUrl: source_url,
          });

          // 🕐 Xserverのレート制限対策: 各アップロード間に3秒の間隔を設ける
          if (i < sectionsToUpload.length - 1) {
            setProgressMessage(
              `Image ${i + 1} uploaded. Waiting 3 seconds before next upload...`
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        } catch (uploadError) {
          throw new Error(
            `Failed to upload image for "${section.h2Text}": ${
              uploadError instanceof Error
                ? uploadError.message
                : String(uploadError)
            }`
          );
        }
      }

      // アップロード情報を保存
      setUploadedSections(newUploadedSections);

      setProgressMessage("All images uploaded. Building final HTML...");

      const parser = new DOMParser();
      const doc = parser.parseFromString(articleHtml, "text/html");

      // まず画像を挿入
      const h2Elements = doc.querySelectorAll("h2");
      sections.forEach((section) => {
        const matchedH2 = Array.from(h2Elements).find(
          (h2) => h2.textContent?.trim() === section.h2Text
        );
        const uploadedData = newUploadedSections.get(section.id);

        if (matchedH2 && uploadedData) {
          // 画像は常にブロックエディタ形式で挿入（後で必要に応じて変換）
          const imageBlock = `
                      <!-- wp:image {"id":${uploadedData.mediaId},"sizeSlug":"full","linkDestination":"none"} -->
                      <figure class="wp-block-image size-full">
                        <img src="${uploadedData.sourceUrl}" alt="${section.altText}" class="wp-image-${uploadedData.mediaId}" />
                      </figure>
                      <!-- /wp:image -->
                    `;

          matchedH2.insertAdjacentHTML("afterend", imageBlock);
        }
      });

      // 画像挿入後のHTMLを保存
      const htmlWithImages = doc.body.innerHTML;
      setBaseHtmlWithImages(htmlWithImages);

      // 選択されたエディタ形式に応じて変換
      const newFinalHtml = convertHtmlFormat(htmlWithImages, useBlockEditor);
      setFinalHtml(newFinalHtml);
      setProgressMessage("HTML ready for review.");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setPostResult({ success: false, message: errorMessage });
      notifyParentCompletion({
        success: false,
        keyword: metaData?.keyword,
        row: metaData?.spreadsheetRow,
        error: `画像アップロード失敗: ${errorMessage}`,
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleCreatePost = async () => {
    if (!finalHtml) {
      setPostResult({ success: false, message: "HTML content is missing." });
      return;
    }

    setIsPosting(true);
    setPostResult(null);
    setProgressMessage("Creating WordPress post...");

    try {
      const { link } = await createPost(
        wpConfig,
        { ...postConfig, slug: metaData?.slug },
        finalHtml
      );
      setPostResult({
        success: true,
        message: "Post created successfully!",
        link,
      });

      // WordPress投稿完了をSlackに通知（設定されたユーザー宛メンション付き）
      try {
        const uploadedSectionsCount = uploadedSections.size;
        await slackService.notifyWordPressPostComplete({
          title: postConfig.title,
          postUrl: link,
          imageCount: uploadedSectionsCount,
          status: postConfig.status as "draft" | "publish",
          metaDescription: metaData?.metaDescription,
          slug: metaData?.slug,
        });
      } catch (notifyError) {
        console.error("Slack通知エラー:", notifyError);
        // 通知エラーは無視して処理続行
      }

      // スプレッドシート更新（キーワードが存在する場合のみ）
      try {
        const keyword = metaData?.keyword;
        const slug = metaData?.slug;
        const articleTitle = postConfig.title;
        const articleMetaDescription = metaData?.metaDescription;
        if (keyword) {
          console.log(`📊 スプレッドシート更新: キーワード "${keyword}"`);
          console.log(`  - C列（編集用URL）: "${link}"`);
          if (slug) {
            console.log(`  - D列（Slug）: "${slug}"`);
          }
          if (articleTitle) {
            console.log(`  - E列（タイトル）: "${articleTitle}"`);
          }
          if (articleMetaDescription) {
            console.log(`  - G列（メタディスクリプション）: "${articleMetaDescription.substring(0, 50)}..."`);
          }
          const apiUrl =
            import.meta.env.VITE_API_URL || "http://localhost:3001/api";
          const response = await fetch(`${apiUrl}/spreadsheet-mode/update`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": import.meta.env.VITE_INTERNAL_API_KEY || "",
              ...clientHeaders(),
            },
            body: JSON.stringify({
              keyword: keyword,
              // 行番号を渡すと同じキーワードが複数行あっても正しい行が更新される
              row: metaData?.spreadsheetRow,
              url: link,
              slug: slug,
              title: articleTitle,
              metaDescription: articleMetaDescription,
            }),
          });
          const data = await response.json();
          if (data.success) {
            console.log(`✅ スプレッドシート更新成功: 行${data.row}`);
            notifyParentCompletion({ success: true, row: data.row, keyword });
          } else {
            console.error("❌ スプレッドシート更新失敗:", data.error);
            notifyParentCompletion({
              success: false,
              keyword,
              row: metaData?.spreadsheetRow,
              postUrl: link,
              error: `スプレッドシート更新失敗（投稿は完了: ${link}）: ${data.error}`,
            });
          }
        }
      } catch (spreadsheetError) {
        console.error("スプレッドシート更新エラー:", spreadsheetError);
        // 投稿自体は成功しているため、画面上は成功のまま処理を続行する
        notifyParentCompletion({
          success: false,
          keyword: metaData?.keyword,
          row: metaData?.spreadsheetRow,
          postUrl: link,
          error: `スプレッドシート更新エラー（投稿は完了: ${link}）: ${
            spreadsheetError instanceof Error
              ? spreadsheetError.message
              : String(spreadsheetError)
          }`,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred.";
      setPostResult({ success: false, message: errorMessage });
      notifyParentCompletion({
        success: false,
        keyword: metaData?.keyword,
        row: metaData?.spreadsheetRow,
        error: `WordPress投稿失敗: ${errorMessage}`,
      });
    } finally {
      setIsPosting(false);
      setProgressMessage("");
    }
  };

  const handleReset = () => {
    setPostResult(null);
    setFinalHtml(null);
    setProgressMessage("");
  };

  const getStatusClass = (status: "success" | "error" | "skipped") => {
    switch (status) {
      case "success":
        return "bg-green-100 text-green-800";
      case "error":
        return "bg-red-100 text-red-800";
      case "skipped":
        return "bg-yellow-100 text-yellow-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="space-y-8">
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-2xl font-bold text-gray-900">
          Processing Complete
        </h2>
        <p className="mt-1 text-gray-600">
          {successfulGenerations} of {logs.length} sections processed (
          {logs.filter((l) => l.status === "skipped").length} skipped).
        </p>
        {autoExecute && (
          <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
            <p className="text-sm text-blue-700 font-medium">
              🚀 自動フローモード:
              画像アップロードとWordPress投稿を自動実行します
            </p>
          </div>
        )}
      </div>

      {/* メタ情報表示セクション */}
      {metaData &&
        (metaData.metaDescription || metaData.slug || metaData.keyword) && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              📝 記事情報
            </h3>

            {metaData.keyword && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  キーワード
                </label>
                <div className="bg-white px-3 py-2 rounded border border-gray-300 text-gray-800">
                  {metaData.keyword}
                </div>
              </div>
            )}

            {metaData.metaDescription && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  メタディスクリプション
                </label>
                <div className="bg-white px-3 py-2 rounded border border-gray-300">
                  <p className="text-gray-800">{metaData.metaDescription}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {metaData.metaDescription.length}文字
                  </p>
                </div>
              </div>
            )}

            {metaData.slug && (
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  URLスラッグ
                </label>
                <div className="bg-white px-3 py-2 rounded border border-gray-300 font-mono text-sm text-gray-800">
                  {metaData.slug}
                </div>
              </div>
            )}

            <div className="mt-3 text-xs text-gray-600">
              ※ WordPressへの投稿時にslugは自動設定されます
            </div>
          </div>
        )}

      {/* Post to WordPress Section */}
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-xl font-semibold text-gray-800 mb-4">
          Post to WordPress
        </h3>

        {/* Initial state & upload button */}
        {!finalHtml && !postResult && (
          <>
            {autoExecute && !autoFlowExecuted && (
              <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-6">
                <p className="text-sm text-blue-700 font-medium">
                  🎆 自動フロー処理中: 3秒後に画像アップロードを開始します...
                </p>
              </div>
            )}
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
              <p className="text-sm text-yellow-700">
                This will upload generated images to your WordPress site and
                prepare the HTML. You'll have a chance to review and edit the
                HTML before creating the post.
              </p>
            </div>
            <div className="text-center">
              <button
                onClick={handlePreparePost}
                disabled={isUploading || !canPost}
                className="inline-flex items-center px-8 py-3 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isUploading
                  ? "Uploading..."
                  : "1. Upload Images & Prepare HTML"}
              </button>
              {!canPost && (
                <p className="text-sm text-gray-500 mt-2">
                  Please fill in your WordPress credentials and ensure at least
                  one image was successfully generated to enable posting.
                </p>
              )}
              {isUploading && (
                <p className="text-sm text-indigo-600 mt-4 animate-pulse">
                  {progressMessage}
                </p>
              )}
            </div>
          </>
        )}

        {/* Edit and Post state */}
        {finalHtml && !postResult && (
          <div className="space-y-6">
            {autoExecute && (
              <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-4">
                <p className="text-sm text-blue-700 font-medium">
                  📤 自動フロー: 2秒後にWordPressへ投稿します...
                </p>
              </div>
            )}
            <div className="flex items-center justify-between mb-4">
              <label
                htmlFor="final-html"
                className="block text-md font-medium text-gray-700"
              >
                2. Review and Edit Final HTML
              </label>
              <div className="flex items-center space-x-2">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useBlockEditor}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      setUseBlockEditor(newValue);
                      // 画像挿入済みのHTMLがあれば、それを再変換
                      if (baseHtmlWithImages) {
                        const convertedHtml = convertHtmlFormat(
                          baseHtmlWithImages,
                          newValue
                        );
                        setFinalHtml(convertedHtml);
                      }
                    }}
                    className="mr-2 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                  />
                  <span className="text-sm text-gray-700">
                    ブロックエディタ形式で出力（推奨）
                  </span>
                </label>
              </div>
            </div>
            <div>
              <textarea
                id="final-html"
                value={finalHtml}
                onChange={(e) => setFinalHtml(e.target.value)}
                className="w-full h-80 p-3 font-mono text-sm bg-gray-900 text-white rounded-md border border-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Final HTML Content"
              />
            </div>
            <div className="text-center">
              <button
                onClick={handleCreatePost}
                disabled={isPosting}
                className="inline-flex items-center px-8 py-3 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 disabled:bg-gray-400 transition-colors"
              >
                {isPosting ? "Posting..." : "3. Create WordPress Post"}
              </button>
              {isPosting && (
                <p className="text-sm text-indigo-600 mt-4 animate-pulse">
                  {progressMessage}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Result state */}
        {postResult && (
          <div className="text-center">
            <div
              className={`p-4 rounded-md ${
                postResult.success
                  ? "bg-green-50 text-green-800"
                  : "bg-red-50 text-red-800"
              }`}
            >
              <h4 className="font-bold">
                {postResult.success ? "Success!" : "Error"}
              </h4>
              <p>{postResult.message}</p>
              {postResult.link && (
                <a
                  href={postResult.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block font-semibold underline hover:text-green-900"
                >
                  View Post
                </a>
              )}
            </div>
            <button
              onClick={handleReset}
              className="mt-4 px-6 py-2 bg-gray-500 text-white font-semibold rounded-lg shadow-md hover:bg-gray-600"
            >
              Start Over
            </button>
          </div>
        )}
      </div>

      <div className="bg-white p-6 rounded-lg shadow-md">
        <h3 className="text-xl font-semibold text-gray-800 mb-4">
          Generation Report
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  H2 Heading
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {logs.map((log, index) => (
                <tr key={index}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {log.h2Text}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusClass(
                        log.status
                      )}`}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-normal text-sm text-gray-500">
                    {log.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
