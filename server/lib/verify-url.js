/**
 * server/lib/url.js のテスト（node:assert。フレームワークなし）
 *   node server/lib/verify-url.js
 */

const assert = require("node:assert/strict");
const { normalizeArticleUrl: n } = require("./url");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("末尾スラッシュを除去", () => {
  assert.equal(n("https://example.com/blog/post/"), "https://example.com/blog/post");
  assert.equal(n("https://example.com/blog/post"), "https://example.com/blog/post");
  assert.equal(n("https://example.com/blog/post///"), "https://example.com/blog/post");
});

test("ルートの / は残す", () => {
  assert.equal(n("https://example.com/"), "https://example.com/");
  assert.equal(n("https://example.com"), "https://example.com/");
});

test("ホストは小文字。スキームと www は残す", () => {
  assert.equal(n("https://WWW.Example.COM/Post/"), "https://www.example.com/Post");
  assert.equal(n("http://example.com/a"), "http://example.com/a");
  assert.notEqual(n("https://www.example.com/a"), n("https://example.com/a"));
  assert.notEqual(n("http://example.com/a"), n("https://example.com/a"));
});

test("utm などの計測クエリを除去し、空なら ? ごと除去", () => {
  assert.equal(n("https://example.com/post/?utm_source=x&utm_medium=y"), "https://example.com/post");
  assert.equal(n("https://example.com/post?gclid=1&fbclid=2&yclid=3&msclkid=4&_ga=5&_gl=6"), "https://example.com/post");
  assert.equal(n("https://example.com/post?UTM_Campaign=a"), "https://example.com/post");
});

test("?p=123 などは順序を保って残す", () => {
  assert.equal(n("https://example.com/?p=123"), "https://example.com/?p=123");
  assert.equal(n("https://example.com/?p=123&utm_source=x"), "https://example.com/?p=123");
  assert.equal(n("https://example.com/list?b=2&utm_source=x&a=1"), "https://example.com/list?b=2&a=1");
});

test("フラグメントを除去", () => {
  assert.equal(n("https://example.com/post/#section-2"), "https://example.com/post");
  assert.equal(n("https://example.com/?p=123#top"), "https://example.com/?p=123");
});

test("AMP（/amp と ?amp=1）を除去", () => {
  assert.equal(n("https://example.com/post/amp/"), "https://example.com/post");
  assert.equal(n("https://example.com/post/amp"), "https://example.com/post");
  assert.equal(n("https://example.com/post/?amp=1"), "https://example.com/post");
  assert.equal(n("https://example.com/post/?amp"), "https://example.com/post");
  assert.equal(n("https://example.com/amp/"), "https://example.com/");
  // 途中のセグメントや別の語は触らない
  assert.equal(n("https://example.com/amp/post"), "https://example.com/amp/post");
  assert.equal(n("https://example.com/camp"), "https://example.com/camp");
  assert.equal(n("https://example.com/post?ample=1"), "https://example.com/post?ample=1");
});

test("日本語スラッグの %e3 と %E3 が同じ結果になる", () => {
  const lower = n("https://example.com/%e3%83%98%e3%83%83%e3%83%89%e3%82%b9%e3%83%91/");
  const upper = n("https://example.com/%E3%83%98%E3%83%83%E3%83%89%E3%82%B9%E3%83%91/");
  const raw = n("https://example.com/ヘッドスパ/");
  assert.equal(lower, upper);
  assert.equal(raw, upper);
  assert.equal(upper, "https://example.com/%E3%83%98%E3%83%83%E3%83%89%E3%82%B9%E3%83%91");
});

test("予約文字のエスケープを二重エンコードしない", () => {
  assert.equal(n("https://example.com/a%2fb"), "https://example.com/a%2Fb");
  assert.equal(n("https://example.com/a%2Fb"), "https://example.com/a%2Fb");
  assert.equal(n("https://example.com/100%25off"), "https://example.com/100%25off");
});

test("復号できないパスは元のまま", () => {
  assert.equal(n("https://example.com/bad%E3%81/"), "https://example.com/bad%E3%81");
});

test("冪等", () => {
  const inputs = [
    "https://WWW.Example.com/Blog/Post/?utm_source=x&p=1#frag",
    "https://example.com/%e3%83%98%e3%83%83%e3%83%89/amp/?amp=1",
    "https://example.com/a%2fb/?b=2&a=1",
    "https://example.com/100%25off/",
    "https://example.com/bad%E3%81/",
    "http://seo-test.local/hello-world/",
    "https://example.com:8443/x/",
  ];
  for (const input of inputs) {
    const once = n(input);
    assert.equal(n(once), once, input);
  }
});

test("不正な URL は null", () => {
  for (const bad of ["", "   ", "not a url", "/relative/path", "ftp://example.com/a", "mailto:a@example.com", null, undefined, 123, {}]) {
    assert.equal(n(bad), null, String(bad));
  }
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`OK  ${name}`);
  } catch (err) {
    failed++;
    console.log(`NG  ${name}\n    ${String(err.message).split("\n").join("\n    ")}`);
  }
}
console.log(failed === 0 ? `ALL OK (${cases.length})` : `NG: ${failed} / ${cases.length}`);
process.exit(failed === 0 ? 0 : 1);
