/**
 * server/lib の動作確認スクリプト（T-04）
 *
 *   cd <repo> && node server/lib/verify.js
 *
 * 読み取りのみ。値・トークン・ベクトルの中身は出力しない。
 * 各項目は「OK / NG (code)」と、合否判断に必要な数値だけを表示する。
 * いずれかが NG でも残りは続行し、最後に一覧を出す。NG があれば終了コード 1。
 */

const path = require("path");

// scraping-server.js:23 と同じく、リポジトリ直下の .env を読む
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const supabase = require("./supabase");
const gemini = require("./gemini");
const googleAuth = require("./googleAuth");

const EXPECTED_CLIENTS = 7;
const results = [];

function codeOf(err) {
  return (err && err.code) || (err && err.name) || "ERROR";
}

async function step(label, fn) {
  try {
    const { ok, note } = await fn();
    results.push({ label, ok });
    console.log(`${label}: ${ok ? "OK" : "NG"}${note ? ` ${note}` : ""}`);
  } catch (err) {
    results.push({ label, ok: false });
    console.log(`${label}: NG (${codeOf(err)})`);
  }
}

function norm(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
}

(async () => {
  console.log(`server/lib verify (embedding=${gemini.EMBEDDING_MODEL}, text=${gemini.TEXT_MODEL}, dim=${gemini.EMBEDDING_DIM})`);

  await step("a. supabase select clients", async () => {
    const rows = await supabase.select("clients", { select: "id", order: "id.asc" });
    const match = rows.length === EXPECTED_CLIENTS;
    return { ok: true, note: `count=${rows.length}${match ? "" : `（期待値 ${EXPECTED_CLIENTS} と不一致）`}` };
  });

  await step("b. gemini embedText", async () => {
    const v = await gemini.embedText("SEO記事の書き方");
    return { ok: v.length === gemini.EMBEDDING_DIM, note: `length=${v.length} norm=${norm(v).toFixed(4)}` };
  });

  await step("c. gemini similarity", async () => {
    const out = await gemini.embedTexts(["ドライヘッドスパ 効果", "ヘッドスパの効果とは", "法人税の計算方法"]);
    const failed = out.find((r) => !r.ok);
    if (failed) throw failed.error;
    const s12 = cosine(out[0].embedding, out[1].embedding);
    const s13 = cosine(out[0].embedding, out[2].embedding);
    return { ok: s12 > s13, note: `sim(1,2)=${s12.toFixed(4)} sim(1,3)=${s13.toFixed(4)}` };
  });

  await step("d. gemini generateText json", async () => {
    const value = await gemini.generateText('次の JSON だけを返してください: {"ok":true}', { json: true, temperature: 0 });
    return { ok: Boolean(value && value.ok === true) };
  });

  await step("e. googleAuth access token", async () => {
    const token = await googleAuth.getAccessToken([googleAuth.CLOUD_PLATFORM]);
    return { ok: token.startsWith("ya29."), note: token.startsWith("ya29.") ? "" : "(prefix 不一致)" };
  });

  console.log("---");
  for (const r of results) console.log(`${r.ok ? "OK" : "NG"}  ${r.label}`);
  const ng = results.filter((r) => !r.ok).length;
  console.log(ng === 0 ? "ALL OK" : `NG: ${ng} 件`);
  process.exit(ng === 0 ? 0 : 1);
})();
