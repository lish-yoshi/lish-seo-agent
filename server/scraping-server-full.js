// [DEPRECATED] Phase 1 マルチクライアント実装を含まない旧エントリポイント。
// 本番・開発とも scraping-server.js を使用すること。削除は移行完了後に判断する。
//
// スクレイピングサーバー
// 役割：URLを受け取って、実際のH2/H3タグを正確に取得する

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const puppeteer = require("puppeteer");
const fetch = require("node-fetch");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3001; // Cloud Runでは環境変数PORTを使用

// Cloud Run等のリバースプロキシ経由でのアクセスを正しく処理
// これにより、express-rate-limitがユーザーのIPを正しく識別できる
app.set('trust proxy', true);

// セキュリティヘッダー設定
app.use(
  helmet({
    contentSecurityPolicy: false, // Puppeteerとの互換性のため無効化
  })
);

// CORS設定（許可するオリジンのみ）
const allowedOrigins = [
  // ローカル開発環境
  "http://localhost:5176",
  "http://127.0.0.1:5176",
  "http://localhost:5177", // 画像生成エージェント
  "http://127.0.0.1:5177",
  // 環境変数で追加設定（本番環境用）
  process.env.PRODUCTION_DOMAIN,   // 本番ドメイン
  process.env.SEO_FRONTEND_URL,    // SEOエージェントのURL
  process.env.IMAGE_AGENT_URL,     // 画像生成エージェントのURL
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // originがundefinedの場合（同じサーバーからのリクエスト）は許可
      if (!origin) return callback(null, true);

      // 許可されたオリジンリストをチェック
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Vercelドメインの動的チェック（*.vercel.app）
      if (origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }

      // Cloud Runドメインの動的チェック（*.run.app）
      if (origin.endsWith(".run.app")) {
        return callback(null, true);
      }

      console.warn(`🚫 CORS blocked: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
    exposedHeaders: ["Content-Range", "X-Content-Range"],
    maxAge: 86400, // 24時間キャッシュ
  })
);

// JSONペイロードのサイズ制限を50MBに設定（画像のbase64データ対応）
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// リクエストログミドルウェア
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    // 本番環境：簡略化したログ（機密情報を含めない）
    console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.url}`);
  } else {
    // 開発環境：詳細ログ
    console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.url} from ${req.ip}`);
    console.log(`   Origin: ${req.headers.origin || "NO_ORIGIN"}`);
  }
  next();
});

// Rate Limiting（レート制限）
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 最大100リクエスト
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 認証ミドルウェア（APIキー認証）
const authenticate = (req, res, next) => {
  // 本番環境では簡略化したログ
  if (process.env.NODE_ENV !== "production") {
    console.log(`🔐 Auth check for: ${req.method} ${req.path}`);
  }

  // ヘルスチェックは認証不要
  if (req.path === "/health") {
    return next();
  }

  const apiKey = req.headers["x-api-key"];
  const validApiKey = process.env.INTERNAL_API_KEY;

  if (!validApiKey) {
    console.error("⚠️ INTERNAL_API_KEY が設定されていません");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (!apiKey || apiKey !== validApiKey) {
    console.warn(`🚫 認証失敗: ${req.ip} - ${req.path}`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

// 全APIエンドポイントに認証とRate Limitingを適用
app.use("/api", authenticate);
app.use("/api", apiLimiter);

// 検索API設定（Serper API または Google Custom Search API）
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;
const SEARCH_ENGINE_ID =
  process.env.GOOGLE_SEARCH_ENGINE_ID ||
  process.env.VITE_GOOGLE_SEARCH_ENGINE_ID;
const USE_SERPER = !!SERPER_API_KEY;
const USE_GOOGLE_SEARCH = !!(GOOGLE_API_KEY && SEARCH_ENGINE_ID);

// ブラウザインスタンスを保持（高速化のため）
let browser = null;
let browserInitialized = false;

// URL検証関数（SSRF攻撃対策）
function isValidUrl(url) {
  try {
    const parsed = new URL(url);

    // HTTPまたはHTTPSのみ許可
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        valid: false,
        error: "無効なプロトコルです。httpまたはhttpsのみ許可されています。",
      };
    }

    // hostnameの取得
    const hostname = parsed.hostname.toLowerCase();

    // プライベートIPアドレスとlocalhostをブロック（SSRF対策）
    const blockedPatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./, // リンクローカル
      /^::1$/, // IPv6 localhost
      /^fc00:/, // IPv6 private
      /^fe80:/, // IPv6 link-local
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(hostname)) {
        return {
          valid: false,
          error: "内部ネットワークへのアクセスは許可されていません。",
        };
      }
    }

    // URLの長さ制限（DoS対策）
    if (url.length > 2048) {
      return { valid: false, error: "URLが長すぎます。" };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: "無効なURL形式です。" };
  }
}

// ブラウザを起動（遅延初期化）
async function initBrowser() {
  // 既存のブラウザが閉じているか確認
  if (browser) {
    try {
      // ブラウザが生きているかテスト
      await browser.version();
    } catch (e) {
      console.log("⚠️ ブラウザが閉じていたため再起動します");
      browser = null;
      browserInitialized = false;
    }
  }

  if (!browser) {
    console.log("🚀 Puppeteerブラウザを起動中...");
    try {
      browser = await puppeteer.launch({
        headless: "new", // ヘッドレスモード（画面なし）
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
        ],
        timeout: 30000, // 30秒タイムアウト
      });
      browserInitialized = true;
      console.log("✅ ブラウザ起動完了");
    } catch (error) {
      console.error("❌ ブラウザ起動失敗:", error.message);
      throw error;
    }
  }
  return browser;
}

// スクレイピング処理
async function scrapeHeadings(url) {
  // PDFファイルの場合は特別処理
  if (url.toLowerCase().endsWith(".pdf") || url.includes(".pdf?")) {
    console.log(`📑 PDFファイル検出: ${url}`);
    return {
      success: false,
      data: {
        h1: "PDFコンテンツ",
        h2Items: [
          {
            text: "PDFファイルはHTML構造を持たないため、見出し構造を抽出できません",
            h3Items: [],
          },
        ],
        characterCount: 0,
      },
      error: "PDF file cannot be scraped for HTML structure",
    };
  }

  const browser = await initBrowser();
  let page = null;

  try {
    page = await browser.newPage();
    console.log(`📄 スクレイピング開始: ${url}`);

    // ページにアクセス
    await page.goto(url, {
      waitUntil: "networkidle2", // ネットワークが落ち着くまで待つ
      timeout: 10000, // 10秒でタイムアウト（デバッグ用に短縮）
    });

    // ページ内でH1, H2, H3タグを取得
    const headings = await page.evaluate(() => {
      // H1を取得
      const h1Element = document.querySelector("h1");
      const h1 = h1Element ? h1Element.textContent.trim() : "";

      // H2とその配下のH3を取得
      const h2Elements = document.querySelectorAll("h2");
      const h2Items = [];

      h2Elements.forEach((h2, index) => {
        const h2Text = h2.textContent.trim();

        // このH2の後、次のH2までのH3を探す
        const h3Items = [];
        let nextElement = h2.nextElementSibling;

        while (nextElement && nextElement.tagName !== "H2") {
          if (nextElement.tagName === "H3") {
            h3Items.push(nextElement.textContent.trim());
          }

          // 子要素にH3がある場合も考慮
          const childH3s = nextElement.querySelectorAll("h3");
          childH3s.forEach((h3) => {
            h3Items.push(h3.textContent.trim());
          });

          nextElement = nextElement.nextElementSibling;
        }

        h2Items.push({
          text: h2Text,
          h3Items: h3Items,
        });
      });

      // 文字数も計算
      const bodyText = document.body.innerText || "";
      const characterCount = bodyText.length;

      return {
        h1,
        h2Items,
        characterCount,
        title: document.title,
      };
    });

    console.log(`✅ スクレイピング成功: ${url}`);
    console.log(`  - H1: ${headings.h1}`);
    console.log(`  - H2数: ${headings.h2Items.length}`);
    const totalH3Count = headings.h2Items.reduce(
      (sum, h2) => sum + h2.h3Items.length,
      0
    );
    console.log(`  - H3数: ${totalH3Count}`);
    console.log(`  - 文字数: ${headings.characterCount}`);

    return {
      success: true,
      data: headings,
    };
  } catch (error) {
    console.error(`❌ スクレイピングエラー: ${url}`, error.message);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        console.log("⚠️ ページクローズエラー（無視）:", closeError.message);
      }
    }
  }
}

// APIエンドポイント：単一URLのスクレイピング
app.post("/api/scrape", async (req, res) => {
  console.log("📥 スクレイピングリクエスト受信:", req.body);
  console.log("📊 リクエストヘッダー:", req.headers);

  const { url } = req.body;

  if (!url) {
    console.log("❌ URLが指定されていません");
    return res.status(400).json({ error: "URLが必要です" });
  }

  // URL検証
  const validation = isValidUrl(url);
  if (!validation.valid) {
    console.log(`❌ 無効なURL: ${url} - ${validation.error}`);
    return res.status(400).json({ error: validation.error });
  }

  console.log(`🔍 スクレイピング開始: ${url}`);

  try {
    const result = await scrapeHeadings(url);
    console.log(`✅ スクレイピング完了: ${url}`);
    res.json(result);
  } catch (error) {
    console.error("❌ スクレイピングエラー:", error);
    console.error("❌ エラースタック:", error.stack);
    res.status(500).json({
      success: false,
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
});

// APIエンドポイント：複数URLの一括スクレイピング
app.post("/api/scrape-multiple", async (req, res) => {
  const { urls } = req.body;

  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: "URLの配列が必要です" });
  }

  // URL数の上限チェック（DoS対策）
  if (urls.length > 50) {
    return res.status(400).json({ error: "一度に処理できるURLは50個までです" });
  }

  // 全URLの検証
  for (const url of urls) {
    const validation = isValidUrl(url);
    if (!validation.valid) {
      return res.status(400).json({
        error: `無効なURLが含まれています: ${url} - ${validation.error}`,
      });
    }
  }

  try {
    console.log(`📋 ${urls.length}件のURLをスクレイピング開始`);

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`[${i + 1}/${urls.length}] 処理中...`);

      // PDFファイルはスキップ
      if (url.toLowerCase().endsWith(".pdf")) {
        console.log(`⚠️ PDFファイルをスキップ: ${url}`);
        results.push({
          url,
          h1: "",
          h2Items: [],
          characterCount: 0,
          error: "PDFファイルはスクレイピングできません",
        });
        continue;
      }

      const result = await scrapeHeadings(url);
      if (result.success) {
        results.push({
          url,
          ...result.data,
        });
      } else {
        console.log(`⚠️ スキップ: ${url} - ${result.error}`);
        results.push({
          url,
          h1: "",
          h2Items: [],
          characterCount: 0,
          error: result.error,
        });
      }

      // サイトに優しく（1秒待機）
      if (i < urls.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log("✅ 全てのスクレイピング完了");
    res.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error("❌ 一括スクレイピングエラー:", error);
    res.status(500).json({
      success: false,
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
});

// ルートエンドポイント
app.get("/", (req, res) => {
  res.json({
    message: "🎉 Scraping Server is running!",
    version: "1.0.0",
    endpoints: {
      health: "/api/health",
      scrape: "POST /api/scrape",
      scrapeMultiple: "POST /api/scrape-multiple",
      googleSearch: "POST /api/google-search",
      slackNotify: "POST /api/slack-notify",
    },
    timestamp: new Date().toISOString(),
  });
});

// テスト用エンドポイント
app.post("/api/test", (req, res) => {
  console.log("🧪 テストエンドポイント呼び出し");
  console.log("📋 Headers:", req.headers);
  console.log("📋 Body:", req.body);
  res.json({
    success: true,
    message: "テストエンドポイント正常動作",
    timestamp: new Date().toISOString(),
    headers: req.headers,
    body: req.body,
  });
});

// ヘルスチェック
app.get("/api/health", async (req, res) => {
  try {
    const healthData = {
      status: "ok",
      message: "スクレイピングサーバーは正常に動作しています",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      browser: {
        initialized: browserInitialized,
        available: browser !== null,
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        port: PORT,
        puppeteerPath: process.env.PUPPETEER_EXECUTABLE_PATH,
      },
    };

    // ブラウザの状態もチェック（軽量）
    if (browser) {
      try {
        await browser.version();
        healthData.browser.status = "running";
      } catch (e) {
        healthData.browser.status = "error";
        healthData.browser.error = e.message;
      }
    } else {
      healthData.browser.status = "not_initialized";
    }

    res.json(healthData);
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// 検索APIエンドポイント（Serper API / Google Custom Search API 自動切り替え）
app.post("/api/google-search", async (req, res) => {
  const { query, numResults = 20 } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  if (!USE_SERPER && !USE_GOOGLE_SEARCH) {
    console.error("検索APIが未設定です（SERPER_API_KEY または GOOGLE_API_KEY + GOOGLE_SEARCH_ENGINE_ID が必要）");
    return res.status(500).json({
      error: "検索APIが設定されていません。SERPER_API_KEY または GOOGLE_API_KEY + GOOGLE_SEARCH_ENGINE_ID を .env に設定してください。",
    });
  }

  try {
    if (USE_SERPER) {
      // --- Serper API ---
      console.log(`🔍 Serper Search for: ${query}`);
      const results = [];

      const firstResponse = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query, num: 10, gl: "jp", hl: "ja" }),
      });

      if (!firstResponse.ok) {
        const errorData = await firstResponse.json().catch(() => ({}));
        console.error("Serper API error:", errorData);
        return res.status(firstResponse.status).json({
          error:
            process.env.NODE_ENV === "production"
              ? "Search service error"
              : errorData.message || "Serper API error",
        });
      }

      const firstData = await firstResponse.json();
      if (firstData.organic) {
        results.push(
          ...firstData.organic.map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet,
          }))
        );
      }

      if (numResults > 10 && results.length >= 10) {
        const secondResponse = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query, num: 10, page: 2, gl: "jp", hl: "ja" }),
        });

        if (secondResponse.ok) {
          const secondData = await secondResponse.json();
          if (secondData.organic) {
            results.push(
              ...secondData.organic.map((item) => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet,
              }))
            );
          }
        }
      }

      console.log(`✅ Serper Search completed: ${results.length} results`);
      res.json({ success: true, results });
    } else {
      // --- Google Custom Search API ---
      console.log(`🔍 Google Custom Search for: ${query}`);
      const results = [];

      const firstUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(
        query
      )}&num=10&lr=lang_ja&gl=jp`;
      const firstResponse = await fetch(firstUrl);

      if (!firstResponse.ok) {
        const errorData = await firstResponse.json();
        console.error("Google Search API error:", errorData);
        return res.status(firstResponse.status).json({
          error:
            process.env.NODE_ENV === "production"
              ? "Search service error"
              : errorData.error?.message || "Google Search API error",
        });
      }

      const firstData = await firstResponse.json();
      if (firstData.items) {
        results.push(...firstData.items);
      }

      if (numResults > 10 && firstData.items?.length === 10) {
        const secondUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(
          query
        )}&num=10&start=11&lr=lang_ja&gl=jp`;
        const secondResponse = await fetch(secondUrl);

        if (secondResponse.ok) {
          const secondData = await secondResponse.json();
          if (secondData.items) {
            results.push(...secondData.items);
          }
        }
      }

      console.log(`✅ Google Custom Search completed: ${results.length} results`);
      res.json({ success: true, results });
    }
  } catch (error) {
    console.error("Search error:", error.message);
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : "Failed to perform search",
    });
  }
});

// Google Drive実績データAPIエンドポイント
const companyDataHandler = require("./api/company-data.js");
app.get("/api/company-data", companyDataHandler);

// スプレッドシートモードAPIエンドポイント
const {
  getMarkedKeywords,
  getInternalLinkMap,
} = require("./api/spreadsheet-mode.js");
const { updateSpreadsheetCell } = require("./api/spreadsheet-update.js");
app.get("/api/spreadsheet-mode/keywords", getMarkedKeywords);
app.get("/api/spreadsheet-mode/internal-links", getInternalLinkMap);
app.post("/api/spreadsheet-mode/update", updateSpreadsheetCell);

// Slack通知プロキシエンドポイント（CORSを回避）
app.post("/api/slack-notify", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.VITE_SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error("❌ Slack Webhook URLが設定されていません");
    return res.status(500).json({ error: "Slack webhook URL not configured" });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    if (response.ok) {
      console.log("✅ Slack通知送信成功");
      res.json({ success: true });
    } else {
      console.error(
        "❌ Slack通知送信失敗:",
        response.status,
        response.statusText
      );
      res.status(500).json({
        error:
          process.env.NODE_ENV === "production"
            ? "Notification service error"
            : "Failed to send Slack notification",
      });
    }
  } catch (error) {
    console.error("❌ Slack通知エラー:", error.message);
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
});

// WordPress 設定取得エンドポイント
app.get("/api/wordpress/config", (req, res) => {
  console.log("📋 WordPress設定を取得中...");

  // WordPress設定を環境変数から取得
  const wpBaseUrl = process.env.WP_BASE_URL || process.env.VITE_WP_BASE_URL;
  const wpUsername = process.env.WP_USERNAME || process.env.VITE_WP_USERNAME;
  const wpDefaultPostStatus =
    process.env.WP_DEFAULT_POST_STATUS ||
    process.env.VITE_WP_DEFAULT_POST_STATUS ||
    "draft";

  console.log("✅ WordPress設定を返却:", {
    baseUrl: wpBaseUrl ? "設定済み" : "未設定",
    username: wpUsername ? "設定済み" : "未設定",
    defaultPostStatus: wpDefaultPostStatus,
  });

  res.json({
    baseUrl: wpBaseUrl || "",
    username: wpUsername || "",
    defaultPostStatus: wpDefaultPostStatus,
  });
});

// WordPress プロキシエンドポイント（画像アップロード）
app.post("/api/wordpress/upload-image", async (req, res) => {
  const { base64Image, filename, title, altText } = req.body;

  if (!base64Image || !filename) {
    return res
      .status(400)
      .json({ error: "base64Image and filename are required" });
  }

  // WordPress設定を環境変数から取得
  const wpBaseUrl = process.env.WP_BASE_URL || process.env.VITE_WP_BASE_URL;
  const wpUsername = process.env.WP_USERNAME || process.env.VITE_WP_USERNAME;
  const wpAppPassword =
    process.env.WP_APP_PASSWORD || process.env.VITE_WP_APP_PASSWORD;

  if (!wpBaseUrl || !wpUsername || !wpAppPassword) {
    console.error("❌ WordPress設定が不完全です");
    return res
      .status(500)
      .json({ error: "WordPress configuration is incomplete" });
  }

  try {
    // Base64をBufferに変換
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    // FormDataを作成（node-fetchはFormDataをサポートしていないため、手動で構築）
    const FormData = require("form-data");
    const formData = new FormData();
    formData.append("file", buffer, {
      filename: filename,
      contentType: "image/jpeg",
    });

    if (title) formData.append("title", title);
    if (altText) formData.append("alt_text", altText);

    // WordPress REST APIにアップロード
    const apiUrl = wpBaseUrl.replace(/\/+$/, "") + "/wp-json/wp/v2/media";
    const authHeader =
      "Basic " +
      Buffer.from(`${wpUsername}:${wpAppPassword}`).toString("base64");

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ message: "Upload failed" }));
      console.error("❌ WordPress画像アップロード失敗:", errorData);
      return res.status(response.status).json({
        error:
          process.env.NODE_ENV === "production"
            ? "Failed to upload image"
            : errorData.message || "Upload failed",
      });
    }

    const data = await response.json();
    console.log("✅ WordPress画像アップロード成功:", data.id);
    res.json({ id: data.id, source_url: data.source_url });
  } catch (error) {
    console.error("❌ WordPress画像アップロードエラー:", error.message);
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
});

// WordPress プロキシエンドポイント（記事作成）
app.post("/api/wordpress/create-post", async (req, res) => {
  const { title, content, status, slug } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }

  // WordPress設定を環境変数から取得
  const wpBaseUrl = process.env.WP_BASE_URL || process.env.VITE_WP_BASE_URL;
  const wpUsername = process.env.WP_USERNAME || process.env.VITE_WP_USERNAME;
  const wpAppPassword =
    process.env.WP_APP_PASSWORD || process.env.VITE_WP_APP_PASSWORD;

  if (!wpBaseUrl || !wpUsername || !wpAppPassword) {
    console.error("❌ WordPress設定が不完全です");
    return res
      .status(500)
      .json({ error: "WordPress configuration is incomplete" });
  }

  try {
    const postData = {
      title,
      content,
      status: status || "draft",
    };

    if (slug) postData.slug = slug;

    // WordPress REST APIに投稿
    const apiUrl = wpBaseUrl.replace(/\/+$/, "") + "/wp-json/wp/v2/posts";
    const authHeader =
      "Basic " +
      Buffer.from(`${wpUsername}:${wpAppPassword}`).toString("base64");

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ message: "Post creation failed" }));
      console.error("❌ WordPress記事作成失敗:", errorData);
      return res.status(response.status).json({
        error:
          process.env.NODE_ENV === "production"
            ? "Failed to create post"
            : errorData.message || "Post creation failed",
      });
    }

    const data = await response.json();
    console.log("✅ WordPress記事作成成功:", data.id);
    res.json({ link: data.link, id: data.id });
  } catch (error) {
    console.error("❌ WordPress記事作成エラー:", error.message);
    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Internal server error"
          : error.message,
    });
  }
});

// グローバルエラーハンドラー
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

console.log("🚀 サーバー起動開始...");
console.log("📊 環境変数チェック:");
console.log("  - PORT:", PORT);
console.log("  - NODE_ENV:", process.env.NODE_ENV);
console.log(
  "  - PUPPETEER_SKIP_CHROMIUM_DOWNLOAD:",
  process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
);
console.log(
  "  - PUPPETEER_EXECUTABLE_PATH:",
  process.env.PUPPETEER_EXECUTABLE_PATH
);

// Chrome実行ファイルの存在確認
const fs = require("fs");
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable";
if (fs.existsSync(chromePath)) {
  console.log("✅ Chrome実行ファイル確認済み:", chromePath);
} else {
  console.log("❌ Chrome実行ファイルが見つかりません:", chromePath);
}

// メモリ使用量の確認
const memUsage = process.memoryUsage();
console.log("💾 初期メモリ使用量:");
console.log(`  - RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
console.log(`  - Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
console.log(
  `  - Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`
);

// サーバー起動（Cloud Run用に0.0.0.0でバインド）
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`
🎉 スクレイピングサーバー起動完了！
📡 URL: http://0.0.0.0:${PORT}
📝 エンドポイント:
   - POST /api/scrape (単一URL)
   - POST /api/scrape-multiple (複数URL)
   - POST /api/google-search (Google検索)
   - GET /api/company-data (Google Drive実績データ)
   - GET /api/spreadsheet-mode/keywords (スプシからキーワード取得)
   - GET /api/spreadsheet-mode/internal-links (内部リンクマップ取得)
   - POST /api/spreadsheet-mode/update (スプシ更新)
   - POST /api/slack-notify (Slack通知プロキシ)
   - GET /api/wordpress/config (WordPress設定取得)
   - POST /api/wordpress/upload-image (WordPress画像アップロード)
   - POST /api/wordpress/create-post (WordPress記事作成)
   - GET /api/health (ヘルスチェック)
  `);

  // 検索API設定の確認
  if (USE_SERPER) {
    console.log("✅ 検索API: Serper API 設定済み");
  } else if (USE_GOOGLE_SEARCH) {
    console.log("✅ 検索API: Google Custom Search API 設定済み");
    console.log(`   - Search Engine ID: ${SEARCH_ENGINE_ID}`);
  } else {
    console.log("⚠️  検索API: 未設定");
    console.log("   SERPER_API_KEY または GOOGLE_API_KEY + GOOGLE_SEARCH_ENGINE_ID を設定してください");
  }

  // 認証設定の確認
  if (process.env.INTERNAL_API_KEY) {
    console.log("✅ 認証: 有効");
  } else {
    console.log("⚠️  認証: 無効（INTERNAL_API_KEYが未設定）");
  }

  // サーバー起動完了を明示的に出力
  console.log(`✅ Server is listening on port ${PORT}`);
  console.log(`✅ Server startup completed at ${new Date().toISOString()}`);
});

// プロセスエラーハンドリング
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  // サーバーを停止せずに継続
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  // サーバーを停止せずに継続
});

// 終了時の処理
process.on("SIGINT", async () => {
  console.log("\n👋 サーバーを終了します...");
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.log("⚠️ ブラウザクローズエラー（無視）:", error.message);
    }
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n👋 SIGTERM受信 - サーバーを終了します...");
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.log("⚠️ ブラウザクローズエラー（無視）:", error.message);
    }
  }
  process.exit(0);
});
