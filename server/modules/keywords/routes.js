/**
 * キーワード設計モジュールのルート（/api/keywords/*）
 *
 * ENABLE_KEYWORDS_MODULE=true のときだけ scraping-server.js から require される。
 * 現時点は疎通確認用のスタブのみ。/api 共通の x-api-key 認証の内側にある。
 */

function register(app) {
  app.get("/api/keywords/health", (req, res) => {
    res.json({ module: "keywords", enabled: true });
  });
}

module.exports = { register };
