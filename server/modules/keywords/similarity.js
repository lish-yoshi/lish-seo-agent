/**
 * 記事間の類似度レポート（T-11）
 *
 * settings.cannibal_embedding_threshold（型D カニバリ）と intent_drift_threshold（型C 狙いズレ）を
 * 実データで決めるための材料。同一クライアントの全ペアのコサイン類似度を Node 側で計算する。
 * DB には何も書かない。ベクトルの中身は出力しない。
 */

const supabase = require("../../lib/supabase");
const gemini = require("../../lib/gemini");
const { isEnabled } = require("../../lib/flags");

const BIN = 0.02;
const MAX_ARTICLES = 3000; // 全ペア計算は件数の 2 乗。これを超えるなら DB 側（pgvector）で計算する

function reportError(code, detail) {
  const e = new Error(`類似度レポートの作成に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/** コサイン類似度。長さが違う・ゼロベクトルは NaN */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** PostgREST は vector を "[...]" 形式の文字列で返す（環境によっては配列） */
function parseVector(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

const round4 = (n) => Math.round(n * 10000) / 10000;

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 0.02 刻みのヒストグラム。最小の区間から最大の区間まで、件数 0 の区間も含めて返す */
function histogram(values) {
  if (values.length === 0) return [];
  const indexOf = (v) => Math.min(Math.floor((v + 1e-9) / BIN), Math.round(1 / BIN) - 1);
  const counts = new Map();
  for (const v of values) counts.set(indexOf(v), (counts.get(indexOf(v)) || 0) + 1);
  const keys = [...counts.keys()];
  const out = [];
  for (let i = Math.min(...keys); i <= Math.max(...keys); i++) {
    out.push({ range: `${(i * BIN).toFixed(2)}-${((i + 1) * BIN).toFixed(2)}`, count: counts.get(i) || 0 });
  }
  return out;
}

async function similarityReport({ clientId, top = 20 } = {}) {
  if (!isEnabled("ENABLE_KEYWORDS_MODULE")) {
    throw reportError("MODULE_DISABLED", "ENABLE_KEYWORDS_MODULE が true ではありません");
  }
  if (!clientId) throw reportError("CLIENT_NOT_FOUND", "clientId が指定されていません");

  const model = gemini.EMBEDDING_MODEL;
  const rows = await supabase.selectAll(
    "articles",
    {
      select: "id,url,title,embedding",
      client_id: `eq.${clientId}`,
      embedding_model: `eq.${model}`,
      embedding: "not.is.null",
      order: "id.asc",
    },
    { pageSize: 200 }
  );
  if (rows.length > MAX_ARTICLES) {
    throw reportError("TOO_MANY_ARTICLES", `対象が ${rows.length} 件あります（上限 ${MAX_ARTICLES}）`);
  }

  const articles = rows
    .map((r) => ({ url: r.url, title: r.title, vector: parseVector(r.embedding) }))
    .filter((a) => a.vector && a.vector.length === gemini.EMBEDDING_DIM);

  const pairs = [];
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const s = cosine(articles[i].vector, articles[j].vector);
      if (Number.isFinite(s)) pairs.push({ s, i, j });
    }
  }

  const values = pairs.map((p) => p.s).sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const limit = Math.max(0, Math.min(Number(top) || 20, pairs.length));

  return {
    clientId,
    model,
    articles: articles.length,
    pairs: pairs.length,
    min: values.length ? round4(values[0]) : null,
    max: values.length ? round4(values[values.length - 1]) : null,
    mean: values.length ? round4(sum / values.length) : null,
    median: values.length ? round4(median(values)) : null,
    histogram: histogram(values),
    topPairs: [...pairs]
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((p) => ({
        similarity: round4(p.s),
        titleA: articles[p.i].title,
        urlA: articles[p.i].url,
        titleB: articles[p.j].title,
        urlB: articles[p.j].url,
      })),
  };
}

module.exports = { similarityReport, cosine, parseVector, histogram, median };
