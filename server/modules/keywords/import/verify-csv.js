/**
 * csvParse.js / csv.js（純関数部分）のテスト（node:assert。フレームワークなし。DB には接続しない）
 *   node server/modules/keywords/import/verify-csv.js
 */

const assert = require("node:assert/strict");
const { parseCsv } = require("./csvParse");
const { normalizeKeyword } = require("./csv");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const buf = (s) => Buffer.from(s, "utf8");

test("基本形と行番号", () => {
  const r = parseCsv(buf("url,target_keyword,note\nhttps://a.example/x,キーワード1,メモ\nhttps://a.example/y,キーワード2,\n"));
  assert.equal(r.encoding, "utf-8");
  assert.deepEqual(r.rows, [
    { line: 2, url: "https://a.example/x", target_keyword: "キーワード1", note: "メモ" },
    { line: 3, url: "https://a.example/y", target_keyword: "キーワード2", note: "" },
  ]);
});

test("クォート内のカンマ・改行、\"\" エスケープ", () => {
  const csv = 'url,target_keyword,note\n"https://a.example/x","Q&A, よくある質問","1行目\n2行目"\nhttps://a.example/y,"彼は ""OK"" と言った",\n';
  const r = parseCsv(buf(csv));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].target_keyword, "Q&A, よくある質問");
  assert.equal(r.rows[0].note, "1行目\n2行目");
  assert.equal(r.rows[0].line, 2);
  // クォート内の改行ぶん、次のレコードの行番号が進む
  assert.equal(r.rows[1].line, 4);
  assert.equal(r.rows[1].target_keyword, '彼は "OK" と言った');
});

test("BOM 付き UTF-8", () => {
  const r = parseCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf("url,target_keyword\nhttps://a.example/x,kw\n")]));
  assert.equal(r.encoding, "utf-8");
  assert.deepEqual(r.rows, [{ line: 2, url: "https://a.example/x", target_keyword: "kw", note: "" }]);
});

test("CRLF と末尾の空行", () => {
  const r = parseCsv(buf("url,target_keyword\r\nhttps://a.example/x,kw1\r\nhttps://a.example/y,kw2\r\n\r\n\r\n"));
  assert.deepEqual(r.rows.map((x) => [x.line, x.target_keyword]), [[2, "kw1"], [3, "kw2"]]);
});

test("途中の空行とカンマだけの行は無視し、行番号は保つ", () => {
  const r = parseCsv(buf("url,target_keyword\n\nhttps://a.example/x,kw1\n,,\nhttps://a.example/y,kw2"));
  assert.deepEqual(r.rows.map((x) => [x.line, x.target_keyword]), [[3, "kw1"], [5, "kw2"]]);
});

test("Shift_JIS のバッファ", () => {
  // "ヘッドスパ 効果" の Shift_JIS バイト列
  const sjisKeyword = Buffer.from("83778362836883588370208cf889ca", "hex");
  const b = Buffer.concat([Buffer.from("url,target_keyword\r\nhttp://a.example/x,", "ascii"), sjisKeyword, Buffer.from("\r\n", "ascii")]);
  const r = parseCsv(b);
  assert.equal(r.encoding, "shift_jis");
  assert.deepEqual(r.rows, [{ line: 2, url: "http://a.example/x", target_keyword: "ヘッドスパ 効果", note: "" }]);
});

test("ヘッダーの大文字・空白、列順の入れ替え、余分な列", () => {
  const r = parseCsv(buf(" Note , Target_Keyword ,extra, URL \nメモ,kw,無視,https://a.example/x\n"));
  assert.deepEqual(r.rows, [{ line: 2, url: "https://a.example/x", target_keyword: "kw", note: "メモ" }]);
});

test("note 列なし・列が足りない行", () => {
  const r = parseCsv(buf("url,target_keyword\nhttps://a.example/x,kw\nhttps://a.example/y\n"));
  assert.deepEqual(r.rows, [
    { line: 2, url: "https://a.example/x", target_keyword: "kw", note: "" },
    { line: 3, url: "https://a.example/y", target_keyword: "", note: "" },
  ]);
});

test("必須列の欠落は CSV_BAD_HEADER", () => {
  for (const csv of ["url,note\nhttps://a.example/x,メモ\n", "target_keyword\nkw\n", "", "\n\n"]) {
    assert.throws(() => parseCsv(buf(csv)), (e) => e.code === "CSV_BAD_HEADER", JSON.stringify(csv));
  }
});

test("閉じていないクォートは CSV_BAD_FORMAT", () => {
  assert.throws(() => parseCsv(buf('url,target_keyword\nhttps://a.example/x,"閉じない\n')), (e) => e.code === "CSV_BAD_FORMAT");
  assert.throws(() => parseCsv("文字列"), (e) => e.code === "CSV_BAD_FORMAT");
});

test("エラー文に固定文言と code だけが入る", () => {
  try {
    parseCsv(buf("a,b\n1,2\n"));
    assert.fail("例外が出るはず");
  } catch (e) {
    assert.equal(e.message, "CSV の取り込みに失敗しました (CSV_BAD_HEADER)");
    assert.ok(e.detail.includes("url"));
  }
});

test("normalizeKeyword: 前後の空白除去と連続空白（全角含む）の畳み込み", () => {
  assert.equal(normalizeKeyword("  ヘッドスパ　　効果  "), "ヘッドスパ 効果");
  assert.equal(normalizeKeyword("ヘッドスパ \t\n 料金"), "ヘッドスパ 料金");
  assert.equal(normalizeKeyword("　"), "");
  assert.equal(normalizeKeyword(null), "");
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
