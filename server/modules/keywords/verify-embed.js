/**
 * embed.js / similarity.js の純関数のテスト（node:assert。API も DB も呼ばない）
 *   node server/modules/keywords/verify-embed.js
 */

const assert = require("node:assert/strict");
const { buildEmbeddingText, toVectorText } = require("./embed");
const { cosine, parseVector, histogram, median } = require("./similarity");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("buildEmbeddingText: タイトル＋H2 を改行で連結し、H3 は含めない", () => {
  const text = buildEmbeddingText({
    title: "ドライヘッドスパの効果",
    headings: [
      { level: 2, text: "ドライヘッドスパとは" },
      { level: 3, text: "水を使わない施術" },
      { level: 2, text: "期待できる効果" },
      { level: 3, text: "睡眠の質" },
    ],
  });
  assert.equal(text, "ドライヘッドスパの効果\nドライヘッドスパとは\n期待できる効果");
  assert.ok(!text.includes("水を使わない施術"));
  assert.ok(!text.includes("睡眠の質"));
});

test("buildEmbeddingText: jsonb 由来のキー順・文字列の level でも同じ結果", () => {
  assert.equal(
    buildEmbeddingText({ title: " T ", headings: [{ text: " A ", level: "2" }, { text: "B", level: 3 }] }),
    "T\nA"
  );
});

test("buildEmbeddingText: H2 が無ければタイトルのみ", () => {
  assert.equal(buildEmbeddingText({ title: "見出しのない記事", headings: [] }), "見出しのない記事");
  assert.equal(buildEmbeddingText({ title: "H3 だけ", headings: [{ level: 3, text: "x" }] }), "H3 だけ");
  assert.equal(buildEmbeddingText({ title: "headings が null", headings: null }), "headings が null");
});

test("buildEmbeddingText: タイトルが空ならスキップ（null）", () => {
  assert.equal(buildEmbeddingText({ title: "", headings: [{ level: 2, text: "A" }] }), null);
  assert.equal(buildEmbeddingText({ title: "   ", headings: [] }), null);
  assert.equal(buildEmbeddingText({ title: null }), null);
  assert.equal(buildEmbeddingText(null), null);
});

test("buildEmbeddingText: 類似度用の接頭辞を呼び出し側で付けない", () => {
  assert.ok(!buildEmbeddingText({ title: "T", headings: [] }).includes("task:"));
});

test("toVectorText / parseVector の往復", () => {
  const v = [0.1, -0.25, 0];
  assert.equal(toVectorText(v), "[0.1,-0.25,0]");
  assert.deepEqual(parseVector(toVectorText(v)), v);
  assert.deepEqual(parseVector(v), v);
  assert.equal(parseVector("not json"), null);
  assert.equal(parseVector(null), null);
});

test("cosine: 同一 = 1、直交 = 0、逆向き = -1、スケールに依らない", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 2, 3], [10, 20, 30]) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
});

test("cosine: 長さ違い・ゼロベクトル・非配列は NaN", () => {
  assert.ok(Number.isNaN(cosine([1, 2], [1, 2, 3])));
  assert.ok(Number.isNaN(cosine([0, 0], [1, 1])));
  assert.ok(Number.isNaN(cosine(null, [1])));
});

test("median と histogram（0.02 刻み。間の空区間も返す）", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(histogram([0.61, 0.615, 0.67, 1]), [
    { range: "0.60-0.62", count: 2 },
    { range: "0.62-0.64", count: 0 },
    { range: "0.64-0.66", count: 0 },
    { range: "0.66-0.68", count: 1 },
    ...Array.from({ length: 15 }, (_, k) => ({ range: `${(0.68 + k * 0.02).toFixed(2)}-${(0.7 + k * 0.02).toFixed(2)}`, count: 0 })),
    { range: "0.98-1.00", count: 1 },
  ]);
  assert.deepEqual(histogram([]), []);
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
