/**
 * CMS 取り込み（T-07）
 *
 * WordPress の公開済み投稿を articles へ UPSERT する。
 *   - 判定キーは (client_id, url)。url は server/lib/url.js で正規化する
 *   - 診断結果・ターゲット KW・embedding などは payload に含めない（既存値を壊さない）
 *   - タイトルまたは見出しが変わった既存行は embedding を null に戻す（T-11 で再生成させる）
 *   - 今回の取得に現れなかった既存行は削除も変更もしない（件数だけ数える）
 *
 * このファイルは require しただけでは何も実行しない。入口は ../cli.js。
 */

const store = require("../../../clients/store");
const supabase = require("../../../lib/supabase");
const jobs = require("../../../lib/jobs");
const { isEnabled } = require("../../../lib/flags");
const { normalizeArticleUrl } = require("../../../lib/url");
const { extractHeadings, decodeEntities } = require("./headings");
const wp = require("./wpClient");

const UPSERT_CHUNK = 100;
const ID_CHUNK = 100;
const DEFAULT_POST_TYPES = ["post"];

function importError(code, detail) {
  const e = new Error(`CMS 取り込みに失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** "2026-09-06T01:23:07"（GMT・タイムゾーンなし）→ ISO 文字列。無効な値は null */
function gmtToIso(value) {
  if (typeof value !== "string" || !value || value.startsWith("0000")) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * 見出しの比較用の正規形。jsonb はキー順を並べ替えて返すため、
 * JSON.stringify の結果をそのまま比べると毎回「変更あり」になる。
 */
function headingsKey(headings) {
  return (Array.isArray(headings) ? headings : []).map((h) => `${h && h.level}:${h && h.text}`).join("\n");
}

function normalizePostTypes(value) {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

/**
 * @param {object} opts
 * @param {string}   opts.clientId
 * @param {string[]} [opts.postTypes]  省略時は clients.import_post_types → ["post"]
 * @param {number}   [opts.perPage=50]
 * @param {string}   [opts.createdBy]
 * @param {boolean}  [opts.dryRun=false] true なら DB に一切書かない（import_jobs も作らない）
 */
async function importCms({ clientId, postTypes, perPage = 50, createdBy = null, dryRun = false } = {}) {
  // バッチもフィーチャーフラグで止まる（マスター仕様書 §7.0.2）
  if (!isEnabled("ENABLE_KEYWORDS_MODULE")) {
    throw importError("MODULE_DISABLED", "ENABLE_KEYWORDS_MODULE が true ではありません");
  }
  if (!clientId) throw importError("CLIENT_NOT_FOUND", "clientId が指定されていません");

  // enabled=false のクライアントも取り込めるよう findClient を使う（認証情報は実値に解決済み）
  const client = await store.findClient(clientId);
  if (!client) throw importError("CLIENT_NOT_FOUND", `クライアントが見つかりません: ${clientId}`);
  if (client.cms.type !== "wordpress") {
    throw importError("CMS_TYPE_UNSUPPORTED", `cms.type=${client.cms.type} は取り込みに未対応です（対応: wordpress）`);
  }

  // articles.client_id は Supabase の clients を参照する。存在確認を兼ねて取り込み対象の投稿タイプを読む
  const clientRows = await supabase.select("clients", { select: "id,import_post_types", id: `eq.${clientId}` });
  if (!clientRows[0]) {
    throw importError("CLIENT_NOT_FOUND", `Supabase の clients に存在しません: ${clientId}`);
  }

  const fromArg = normalizePostTypes(postTypes);
  const fromDb = normalizePostTypes(clientRows[0].import_post_types);
  const types = fromArg.length ? fromArg : fromDb.length ? fromDb : DEFAULT_POST_TYPES;

  const run = ({ report }) => execute({ client, clientId, types, perPage, dryRun, report });

  if (dryRun) {
    return { dryRun: true, clientId, ...(await run({ report: async () => {} })) };
  }

  const active = await jobs.findActiveJob({ clientId, type: "cms" });
  if (active) {
    throw importError("JOB_ALREADY_RUNNING", `実行中の取り込みがあります: job=${active.id} status=${active.status}`);
  }

  const job = await jobs.createJob({ clientId, type: "cms", createdBy });
  // runJob は例外を投げない。結果は戻り値のジョブ行（completed / failed）で判断する
  const finished = await jobs.runJob(job, ({ report }) => run({ report }));
  if (!finished || finished.status !== "completed") {
    const progress = (finished && finished.progress) || {};
    const e = importError(progress.errorCode || "JOB_FAILED", progress.errorDetail || "");
    e.jobId = job.id;
    throw e;
  }
  return { dryRun: false, clientId, jobId: finished.id, ...finished.progress };
}

async function execute({ client, clientId, types, perPage, dryRun, report }) {
  const restBases = await wp.resolveRestBases(client, types);

  // 既存行（突き合わせ用）。1000 行を超えても取りこぼさないよう selectAll + order
  const existingRows = await supabase.selectAll("articles", {
    select: "id,url,title,headings,source",
    client_id: `eq.${clientId}`,
    order: "id.asc",
  });
  const existingByUrl = new Map(existingRows.map((r) => [r.url, r]));

  const now = new Date().toISOString();
  const payload = [];
  const seenUrls = new Set();
  const resetIds = [];
  const samples = [];
  const counts = { fetched: 0, inserted: 0, updated: 0, unchanged: 0, headingsChanged: 0, skippedBadUrl: 0, skippedDuplicate: 0 };

  for (const { slug, restBase } of restBases) {
    const { rows } = await wp.listAll(client, restBase, {
      perPage,
      onPage: ({ page, totalPages, fetched, total }) => report({ postType: slug, page, totalPages, fetched, total }),
    });

    for (const post of rows) {
      counts.fetched++;
      const url = normalizeArticleUrl(post && post.link);
      if (!url) {
        counts.skippedBadUrl++;
        continue;
      }
      // 同一実行内の重複は後勝ちにしない（どちらが正か判断できないため先着を採る）
      if (seenUrls.has(url)) {
        counts.skippedDuplicate++;
        continue;
      }
      seenUrls.add(url);

      const title = decodeEntities((post.title && post.title.rendered) || "").trim();
      const headings = extractHeadings((post.content && post.content.rendered) || "");
      const existing = existingByUrl.get(url);

      if (!existing) {
        counts.inserted++;
      } else {
        const titleChanged = (existing.title || "") !== title;
        const headingsChanged = headingsKey(existing.headings) !== headingsKey(headings);
        if (headingsChanged) counts.headingsChanged++;
        if (titleChanged || headingsChanged) {
          counts.updated++;
          resetIds.push(existing.id);
        } else {
          counts.unchanged++;
        }
      }

      // articles で NOT NULL かつ default なしの列は client_id と url の 2 つ。どちらも必ず含める。
      // PostgREST の一括 upsert は全行のキーが揃っている必要があるため、値が無い列も null で入れる。
      // target_keyword* / diagnosis_type / rewrite_score / status / embedding* / cluster_id は含めない。
      payload.push({
        client_id: clientId,
        url,
        cms_post_id: String(post.id),
        title,
        headings,
        published_at: gmtToIso(post.date_gmt),
        updated_at: gmtToIso(post.modified_gmt),
        source: (existing && existing.source) || "imported_cms",
        synced_at: now,
      });

      if (samples.length < 5) samples.push({ url, title, headings: headings.length });
    }
  }

  const notSeen = existingRows.filter((r) => !seenUrls.has(r.url)).length;
  const summary = { postTypes: restBases.map((t) => t.slug), ...counts, notSeen };

  if (dryRun) return { ...summary, samples };

  for (const part of chunk(payload, UPSERT_CHUNK)) {
    await supabase.upsert("articles", part, { onConflict: "client_id,url" });
  }

  // タイトルまたは見出しが変わった既存行は embedding を作り直させる
  for (const ids of chunk(resetIds, ID_CHUNK)) {
    await supabase.update("articles", { id: `in.(${ids.join(",")})` }, { embedding: null, embedding_model: null });
  }

  return summary;
}

module.exports = { importCms, headingsKey, gmtToIso };
