/**
 * フィーチャーフラグ（マスター仕様書 §7.0.2）
 *
 * 新モジュールは既存の本番と同じ Cloud Run 上で動くため、既定は無効。
 * 環境変数の値が "true" と完全一致のときだけ有効とみなす（前後の空白・改行は無視）。
 *   ENABLE_KEYWORDS_MODULE / ENABLE_METRICS_MODULE / ENABLE_AUDIT_MODULE
 *
 * ルート登録（scraping-server.js）とバッチ（CLI・ジョブ）の両方が同じ判定を使う。
 */

function isEnabled(name) {
  const raw = process.env[name];
  return typeof raw === "string" && raw.trim() === "true";
}

module.exports = { isEnabled };
