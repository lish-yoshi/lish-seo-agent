/**
 * スプレッドシート更新API
 *
 * スプレッドシートフォーマット:
 * A列: No.
 * B列: KW（キーワード）
 * C列: 編集用URL（処理後に記事編集URLを書き込む）
 * D列: Slug
 * E列: タイトル
 * F列: 公開用URL（内部リンクURL）※読取専用
 * G列: メタディスクリプション
 */

const { google } = require("googleapis");

const store = require("../clients/store");

/**
 * リクエストの clientId からスプレッドシートIDを解決する。
 * clientId が無い場合は従来どおり環境変数へフォールバックするので、
 * 単一クライアント運用のままでも動作は変わらない。
 */
async function resolveSpreadsheetId(req) {
  const clientId =
    req.body?.clientId ||
    req.query?.clientId ||
    req.headers?.["x-client-id"] ||
    require("../clients/resolveDefaultClientId") ||
    null;

  if (clientId) {
    try {
      const client = await store.getClient(clientId);
      if (client && client.spreadsheetId) return client.spreadsheetId;
      console.warn(`⚠️ [${clientId}] spreadsheetId が未設定です`);
    } catch (err) {
      console.error("❌ クライアント設定の読み込みに失敗:", err.message);
    }
  }
  return process.env.SPREADSHEET_ID || "";
}

/**
 * スプレッドシートのキーワードに一致する行を更新
 * C列（編集用URL）、D列（Slug）、E列（タイトル）、G列（メタディスクリプション）
 */
async function updateSpreadsheetCell(req, res) {
  const spreadsheetId = await resolveSpreadsheetId(req);
  try {
    const { keyword, url, slug, title, metaDescription } = req.body;

    if (!keyword || !url) {
      return res.status(400).json({
        success: false,
        error: "keyword と url は必須です",
      });
    }

    console.log(`📝 スプレッドシート更新: キーワード "${keyword}"`);
    console.log(`  - C列（編集用URL）: "${url}"`);
    if (slug) {
      console.log(`  - D列（Slug）: "${slug}"`);
    }
    if (title) {
      console.log(`  - E列（タイトル）: "${title}"`);
    }
    if (metaDescription) {
      console.log(`  - G列（メタディスクリプション）: "${metaDescription.substring(0, 50)}..."`);
    }

    // デバッグ: 環境変数の確認
    console.log("🔍 環境変数デバッグ:");
    console.log(
      "  GOOGLE_APPLICATION_CREDENTIALS_JSON:",
      !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    );
    console.log("  GOOGLE_API_KEY:", !!process.env.GOOGLE_API_KEY);
    console.log("  NODE_ENV:", process.env.NODE_ENV);

    // ADC認証（環境変数対応）- spreadsheet-mode.jsと同じ方式
    let auth;

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      // Render環境: 環境変数から直接認証情報を使用
      const credentials = JSON.parse(
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
      );
      auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive",
        ],
      });
      console.log("🔐 ADC認証（環境変数から認証情報を読み込み）");
    } else {
      // ローカル環境: 通常のADC認証
      auth = new google.auth.GoogleAuth({
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive",
        ],
      });
      console.log("🔐 ADC認証（ローカル環境）");
    }

    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    // B列（キーワード列）全体を取得
    const searchRange = "シート1!B:B";
    const searchResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: searchRange,
    });

    const rows = searchResponse.data.values || [];

    // キーワードが一致する行を探す
    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === keyword) {
        targetRow = i + 1; // 1-indexed
        break;
      }
    }

    if (targetRow === -1) {
      return res.status(404).json({
        success: false,
        error: `キーワード "${keyword}" が見つかりませんでした`,
      });
    }

    console.log(`✅ キーワード "${keyword}" を行${targetRow}で発見`);

    // C列（編集用URL）を更新
    const urlUpdateRange = `シート1!C${targetRow}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: urlUpdateRange,
      valueInputOption: "RAW",
      resource: {
        values: [[url]],
      },
    });
    console.log(`✅ C列更新完了: "${url}"`);

    // D列（Slug）を更新（slugが提供されている場合のみ）
    if (slug) {
      const slugUpdateRange = `シート1!D${targetRow}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: slugUpdateRange,
        valueInputOption: "RAW",
        resource: {
          values: [[slug]],
        },
      });
      console.log(`✅ D列更新完了: "${slug}"`);
    }

    // E列（タイトル）を更新（titleが提供されている場合のみ）
    if (title) {
      const titleUpdateRange = `シート1!E${targetRow}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: titleUpdateRange,
        valueInputOption: "RAW",
        resource: {
          values: [[title]],
        },
      });
      console.log(`✅ E列更新完了: "${title}"`);
    }

    // G列（メタディスクリプション）を更新（metaDescriptionが提供されている場合のみ）
    if (metaDescription) {
      const metaDescUpdateRange = `シート1!G${targetRow}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: metaDescUpdateRange,
        valueInputOption: "RAW",
        resource: {
          values: [[metaDescription]],
        },
      });
      console.log(`✅ G列更新完了: "${metaDescription.substring(0, 50)}..."`);
    }

    console.log(`✅ スプレッドシート更新完了: 行${targetRow}`);

    res.json({
      success: true,
      row: targetRow,
      keyword: keyword,
      url: url,
      slug: slug || null,
      title: title || null,
      metaDescription: metaDescription || null,
    });
  } catch (error) {
    console.error("❌ スプレッドシート更新エラー:", error.message);

    // ADC認証エラーの場合は自動で再認証を促す
    if (
      error.message.includes("invalid_grant") ||
      error.message.includes("invalid_rapt") ||
      error.message.includes("reauth") ||
      error.message.includes("insufficient authentication scopes")
    ) {
      console.log(
        "🔐 ADC認証が期限切れ、またはスコープ不足です。再認証を実行してください:"
      );
      console.log(
        "   gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive"
      );

      return res.status(401).json({
        success: false,
        error: "Google認証が期限切れ、またはスコープ不足です",
        action: "ADC_REAUTH_REQUIRED",
        command:
          "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

module.exports = { updateSpreadsheetCell };
