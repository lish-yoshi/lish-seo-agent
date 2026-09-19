/**
 * 記事の Embedding 生成（T-11）
 *
 * 入力テキストは「タイトル＋H2」のみ。H3 と本文は使わない
 * （本文まで入れるとノイズが増え、カニバリ判定の精度が落ちる。マスター仕様書 T-11）。
 * 類似度用の接頭辞は server/lib/gemini.js が内部で付けるので、ここでは何も付けない。
 *
 * ジョブ記録について: import_jobs.type の CHECK 制約は cms / gsc / csv / full / ga4 のみで
 * "embedding" を受け付けない。マイグレーションは足さない方針のため、この処理はジョブを記録せず、
 * 結果を戻り値（CLI では標準出力）で返すだけにしている。
 */

const supabase = require("../../lib/supabase");
const gemini = require("../../lib/gemini");
const { isEnabled } = require("../../lib/flags");

const BATCH_SIZE = 20;
const CONCURRENCY = 2;

function embedError(code, detail) {
  const e = new Error(`Embedding の生成に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/**
 * Embedding の入力テキスト。タイトル＋H2 を改行で連結する。
 * H2 が無ければタイトルのみ。タイトルが空なら null（呼び出し側でスキップ）。
 */
function buildEmbeddingText(article) {
  const title = String((article && article.title) || "").trim();
  if (!title) return null;
  const h2 = (Array.isArray(article.headings) ? article.headings : [])
    .filter((h) => h && Number(h.level) === 2 && typeof h.text === "string" && h.text.trim() !== "")
    .map((h) => h.text.trim());
  return [title, ...h2].join("\n");
}

/** pgvector へ送る "[...]" 形式の文字列 */
function toVectorText(values) {
  return `[${values.join(",")}]`;
}

/**
 * @param {object}  opts
 * @param {string}  opts.clientId
 * @param {boolean} [opts.force=false]  true なら生成済みの行も作り直す
 * @param {number}  [opts.limit]        対象件数の上限
 * @param {boolean} [opts.dryRun=false] true なら API を呼ばず、DB にも書かない
 */
async function embedArticles({ clientId, force = false, limit, dryRun = false } = {}) {
  if (!isEnabled("ENABLE_KEYWORDS_MODULE")) {
    throw embedError("MODULE_DISABLED", "ENABLE_KEYWORDS_MODULE が true ではありません");
  }
  if (!clientId) throw embedError("CLIENT_NOT_FOUND", "clientId が指定されていません");

  const clientRows = await supabase.select("clients", { select: "id", id: `eq.${clientId}` });
  if (!clientRows[0]) throw embedError("CLIENT_NOT_FOUND", `Supabase の clients に存在しません: ${clientId}`);

  const model = gemini.EMBEDDING_MODEL;
  const query = { select: "id,title,headings,embedding_model", client_id: `eq.${clientId}`, order: "id.asc" };
  if (!force) {
    // 未生成、またはモデルが現行と違う行だけを対象にする（embedding 本体は重いので select しない）
    query.or = `(embedding.is.null,embedding_model.is.null,embedding_model.neq.${model})`;
  }
  let targets = await supabase.selectAll("articles", query);
  const max = Number(limit);
  if (Number.isInteger(max) && max > 0) targets = targets.slice(0, max);

  const result = {
    model,
    dim: gemini.EMBEDDING_DIM,
    target: targets.length,
    embedded: 0,
    skippedNoTitle: 0,
    failed: 0,
    failedCodes: {},
  };

  const items = [];
  for (const article of targets) {
    const text = buildEmbeddingText(article);
    if (text === null) result.skippedNoTitle++;
    else items.push({ id: article.id, text });
  }

  if (dryRun) return { dryRun: true, ...result, wouldEmbed: items.length };

  const fail = (code) => {
    result.failed++;
    result.failedCodes[code] = (result.failedCodes[code] || 0) + 1;
  };

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const embedded = await gemini.embedTexts(batch.map((b) => b.text), { concurrency: CONCURRENCY });
    for (let j = 0; j < batch.length; j++) {
      const out = embedded[j];
      if (!out || !out.ok) {
        fail((out && out.error && out.error.code) || "GEMINI_FAILED");
        continue;
      }
      try {
        // 1 件の失敗で全体を止めない
        const rows = await supabase.update(
          "articles",
          { id: `eq.${batch[j].id}` },
          { embedding: toVectorText(out.embedding), embedding_model: model }
        );
        if (rows.length === 1) result.embedded++;
        else fail("ARTICLE_NOT_FOUND");
      } catch (err) {
        fail((err && err.code) || "SUPABASE_FAILED");
      }
    }
  }

  return { dryRun: false, ...result };
}

module.exports = { embedArticles, buildEmbeddingText, toVectorText };
