/**
 * 記事 URL の正規化（T-07 CMS 取り込み / T-08 GSC 取り込みで共用）
 *
 * CMS が返す link と GSC が返す page を同じ記事として突き合わせるため、
 * 表記ゆれだけを吸収する。スキームと www はサイトごとに正しい値が違うので触らない。
 *
 *   - ホストは小文字
 *   - フラグメント（# 以降）を除去
 *   - 計測・AMP 用のクエリ（utm_* / gclid / fbclid / yclid / msclkid / _ga / _gl / amp）を除去。
 *     残りが空なら ? ごと除去。それ以外（?p=123 など）は順序を保って残す
 *   - パス末尾の /amp セグメントを除去
 *   - パス末尾のスラッシュを除去（ルート "/" は残す）
 *   - パスの % エンコード表記を統一（日本語スラッグの %e3 と %E3 を同一視）
 *   - 冪等: normalize(normalize(x)) === normalize(x)
 *   - 不正な URL は null
 */

const DROP_QUERY_KEYS = new Set(["gclid", "fbclid", "yclid", "msclkid", "_ga", "_gl", "amp"]);

// decodeURI が復号せずに残す予約文字のエスケープ（; / ? : @ & = + $ , #）。
// これらを含む部分に encodeURI を掛けると "%" が "%25" に二重エンコードされるため、分割して別扱いにする。
const RESERVED_ESCAPE = /(%(?:3B|2F|3F|3A|40|26|3D|2B|24|2C|23))/i;

function shouldDropQueryKey(rawKey) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch (_) {
    /* 復号できないキーはそのまま比較する */
  }
  key = key.toLowerCase();
  return key.startsWith("utm_") || DROP_QUERY_KEYS.has(key);
}

function normalizeQuery(search) {
  const raw = String(search || "").replace(/^\?/, "");
  if (!raw) return "";
  return raw
    .split("&")
    .filter((pair) => pair !== "" && !shouldDropQueryKey(pair.split("=")[0]))
    .join("&");
}

/** decodeURI → encodeURI で % エンコードの表記を統一する。復号できなければ元のまま */
function normalizePathEncoding(pathname) {
  try {
    return pathname
      .split(RESERVED_ESCAPE)
      .map((part, i) => (i % 2 === 1 ? part.toUpperCase() : encodeURI(decodeURI(part))))
      .join("");
  } catch (_) {
    return pathname;
  }
}

function normalizePath(pathname) {
  let p = pathname || "/";
  p = p.replace(/\/+$/, "");          // 末尾スラッシュ
  p = p.replace(/\/amp$/i, "");       // 末尾の /amp セグメント
  p = p.replace(/\/+$/, "");          // /amp を外したあとに残るスラッシュ
  if (p === "") p = "/";
  return normalizePathEncoding(p);
}

function normalizeArticleUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;

  const host = u.host.toLowerCase(); // ポートを含む
  const path = normalizePath(u.pathname);
  const query = normalizeQuery(u.search);
  return `${u.protocol}//${host}${path}${query ? `?${query}` : ""}`;
}

module.exports = { normalizeArticleUrl };
