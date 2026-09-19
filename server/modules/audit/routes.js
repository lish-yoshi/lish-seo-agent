/**
 * 設定チェックモジュールのルート（/api/audit/*）
 *
 * ENABLE_AUDIT_MODULE=true のときだけ scraping-server.js から require される。
 * 現時点は疎通確認用のスタブのみ。/api 共通の x-api-key 認証の内側にある。
 */

function register(app) {
  app.get("/api/audit/health", (req, res) => {
    res.json({ module: "audit", enabled: true });
  });
}

module.exports = { register };
