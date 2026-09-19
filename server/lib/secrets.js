/**
 * 秘密値の読み取りとマスク（T-04 共通ライブラリ）
 *
 * server/clients/store.js の readSecret / maskSecrets と同じ仕様の複製。
 * store.js 側は変更せず、新規モジュール（keywords / metrics / audit）はこちらを使う。
 */

/**
 * Secret Manager 由来の値を読む。
 * 登録時に末尾の改行や制御文字が混ざることがあり、そのまま HTTP ヘッダーに
 * 載せると fetch が「不正なヘッダー」で失敗する。制御文字を除去して trim する。
 * 未設定は空文字を返す。
 */
function readSecret(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return "";
  return raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** 秘密値をログやエラー文から伏せる。8 文字未満・空の値は対象外 */
function maskSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets || []) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out;
}

module.exports = { readSecret, maskSecrets };
