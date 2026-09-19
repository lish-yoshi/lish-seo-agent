/**
 * headings.js のテスト（node:assert。フレームワークなし）
 *   node server/modules/keywords/import/verify-headings.js
 */

const assert = require("node:assert/strict");
const { extractHeadings, decodeEntities } = require("./headings");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("属性つき・span のネスト", () => {
  assert.deepEqual(extractHeadings('<h2 class="x"><span>見出し</span></h2>'), [{ level: 2, text: "見出し" }]);
});

test("<strong> や <a> のネスト", () => {
  assert.deepEqual(
    extractHeadings('<h2>ヘッドスパの<strong>効果</strong>と<a href="/x">料金</a></h2>'),
    [{ level: 2, text: "ヘッドスパの効果と料金" }]
  );
});

test("エンティティ: &amp; &#8217; &#038; &nbsp; と 16 進", () => {
  assert.deepEqual(
    extractHeadings("<h2>Q&amp;A</h2><h3>It&#8217;s A&#038;B</h3><h3>料金&nbsp;&nbsp;一覧</h3><h3>&#x2019;quote&#x2019; &lt;tag&gt; &quot;q&quot; &apos;a&apos;</h3>"),
    [
      { level: 2, text: "Q&A" },
      { level: 3, text: "It’s A&B" },
      { level: 3, text: "料金 一覧" },
      { level: 3, text: "’quote’ <tag> \"q\" 'a'" },
    ]
  );
});

test("二重に復号しない・未知のエンティティはそのまま", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeEntities("&unknown; &#0; &#xZZ;"), "&unknown; &#0; &#xZZ;");
  assert.equal(decodeEntities("A &#038; B &#8211; C"), "A & B – C");
});

test("改行・連続空白を 1 つに畳む", () => {
  assert.deepEqual(extractHeadings("<h2>\n  1行目\n  <br>2行目\t\t続き  </h2>"), [{ level: 2, text: "1行目 2行目 続き" }]);
});

test("<script> / <style> / <noscript> / コメント内の偽の見出しを拾わない", () => {
  const html = [
    "<script>var s = '<h2>偽物1</h2>';</script>",
    "<style>/* <h2>偽物2</h2> */</style>",
    "<noscript><h2>偽物3</h2></noscript>",
    "<!-- <h2>偽物4</h2> -->",
    "<!--\n<h3>偽物5</h3>\n-->",
    "<h2>本物</h2>",
  ].join("\n");
  assert.deepEqual(extractHeadings(html), [{ level: 2, text: "本物" }]);
});

test("空の見出しは捨てる", () => {
  assert.deepEqual(extractHeadings("<h2></h2><h2>  </h2><h2>&nbsp;</h2><h3><span></span></h3><h2>残る</h2>"), [{ level: 2, text: "残る" }]);
});

test("h1・h4・h5・h6 は拾わない", () => {
  assert.deepEqual(
    extractHeadings("<h1>H1</h1><h2>H2</h2><h4>H4</h4><h5>H5</h5><h6>H6</h6><h3>H3</h3><h20>x</h20>"),
    [
      { level: 2, text: "H2" },
      { level: 3, text: "H3" },
    ]
  );
});

test("h2 と h3 の順序（文書順）と大文字タグ", () => {
  const html = "<h2>A</h2><p>本文</p><h3>A-1</h3><h3>A-2</h3><H2>B</H2><h3 id='b1'>B-1</h3 >";
  assert.deepEqual(extractHeadings(html), [
    { level: 2, text: "A" },
    { level: 3, text: "A-1" },
    { level: 3, text: "A-2" },
    { level: 2, text: "B" },
    { level: 3, text: "B-1" },
  ]);
});

test("WordPress のブロック出力", () => {
  const html =
    '\n<h2 class="wp-block-heading" id="a">ドライヘッドスパとは</h2>\n\n<p>本文</p>\n\n<h3 class="wp-block-heading">期待できる<strong>効果</strong> &amp; 注意点</h3>\n';
  assert.deepEqual(extractHeadings(html), [
    { level: 2, text: "ドライヘッドスパとは" },
    { level: 3, text: "期待できる効果 & 注意点" },
  ]);
});

test("空・非文字列の入力", () => {
  assert.deepEqual(extractHeadings(""), []);
  assert.deepEqual(extractHeadings(null), []);
  assert.deepEqual(extractHeadings(undefined), []);
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
