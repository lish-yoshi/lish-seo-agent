/**
 * 計測モジュールのルート（/api/metrics/*）
 *
 * ENABLE_METRICS_MODULE=true のときだけ scraping-server.js から require される。
 * 現時点は疎通確認用のスタブのみ。/api 共通の x-api-key 認証の内側にある。
 */

function register(app) {
  app.get("/api/metrics/health", (req, res) => {
    res.json({ module: "metrics", enabled: true });
  });
}

module.exports = { register };
