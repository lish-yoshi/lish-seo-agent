/**
 * siteUrl から id / cms.baseUrl を提案する純関数（T-01b-2）
 *
 * ルール: ホスト名から www. と TLD（co.jp 等の 2 段 TLD を含む）を落とし、
 * 残りのラベルをハイフンで連結して小文字英数字とハイフンだけにする。
 *   https://www.english-with.com/      → english-with
 *   http://seo-test.local               → seo-test
 *   https://shop.example.co.jp          → shop-example
 */

const MULTI_PART_TLDS = new Set([
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp", "gr.jp", "lg.jp",
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.nz", "co.kr", "com.tw",
]);

/** URL からホスト名だけを取り出す。スキーム・パス・ポートを除き、www. を落として小文字化 */
export function hostFromSiteUrl(value: string): string {
  let s = String(value || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

/** ホスト名から TLD を落としたラベル配列 */
export function labelsWithoutTld(host: string): string[] {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return parts;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_TLDS.has(lastTwo) && parts.length > 2 ? parts.slice(0, -2) : parts.slice(0, -1);
}

export function suggestId(siteUrl: string): string {
  const host = hostFromSiteUrl(siteUrl);
  if (!host) return "";
  return labelsWithoutTld(host)
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** cms.baseUrl の提案。スキームが無ければ https:// を付ける */
export function suggestBaseUrl(siteUrl: string): string {
  const s = String(siteUrl || "").trim();
  if (!s) return "";
  const host = hostFromSiteUrl(s);
  if (!host) return "";
  const scheme = /^http:\/\//i.test(s) ? "http" : "https";
  return `${scheme}://${host}`;
}
