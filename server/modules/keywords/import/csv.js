/**
 * ターゲット KW の CSV 取り込み（T-09）
 *
 * 手動時代の KW 台帳（url,target_keyword,note）を articles に反映する。
 *   - url は articleUrlKey（スキームと www を無視したキー）で articles と突き合わせる
 *   - 一致した行に target_keyword / confidence=high / source=csv を書く。note は保存しない
 *   - 人が画面で直した行（target_keyword_source = "manual"）は force でない限り上書きしない
 *   - articles に無い URL は新規作成せず、エラー行として返す
 *
 * 入力はファイルパスではなく Buffer（画面からのアップロードでも同じ関数を使うため）。
 */

const supabase = require("../../../lib/supabase");
const jobs = require("../../../lib/jobs");
const { isEnabled } = require("../../../lib/flags");
const { articleUrlKey } = require("../../../lib/url");
const { parseCsv } = require("./csvParse");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;
const UPSERT_CHUNK = 100;
const PROGRESS_ERROR_ROWS = 200;

function csvError(code, detail) {
  const e = new Error(`CSV の取り込みに失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 前後の空白を除き、連続する空白（全角を含む）を半角 1 つに畳む */
function normalizeKeyword(value) {
  return String(value ?? "").replace(/[\s　]+/g, " ").trim();
}

/**
 * @param {object}  opts
 * @param {string}  opts.clientId
 * @param {Buffer}  opts.buffer
 * @param {string}  [opts.createdBy]
 * @param {boolean} [opts.dryRun=false] true なら DB に一切書かない（import_jobs も作らない）
 * @param {boolean} [opts.force=false]  true なら source=manual の行も上書きする
 */
async function importCsv({ clientId, buffer, createdBy = null, dryRun = false, force = false } = {}) {
  if (!isEnabled("ENABLE_KEYWORDS_MODULE")) {
    throw csvError("MODULE_DISABLED", "ENABLE_KEYWORDS_MODULE が true ではありません");
  }
  if (!clientId) throw csvError("CLIENT_NOT_FOUND", "clientId が指定されていません");
  if (!Buffer.isBuffer(buffer)) throw csvError("CSV_BAD_FORMAT", "buffer が指定されていません");
  if (buffer.length > MAX_BYTES) {
    throw csvError("CSV_TOO_LARGE", `ファイルサイズが上限（${MAX_BYTES} バイト）を超えています: ${buffer.length}`);
  }

  const parsed = parseCsv(buffer);
  if (parsed.rows.length > MAX_ROWS) {
    throw csvError("CSV_TOO_LARGE", `行数が上限（${MAX_ROWS} 行）を超えています: ${parsed.rows.length}`);
  }

  const clientRows = await supabase.select("clients", { select: "id", id: `eq.${clientId}` });
  if (!clientRows[0]) throw csvError("CLIENT_NOT_FOUND", `Supabase の clients に存在しません: ${clientId}`);

  // errorRows の全件は戻り値にだけ含める（ジョブの progress には先頭 200 件）
  let full = null;
  const run = async () => {
    full = await execute({ clientId, parsed, dryRun, force });
    return { ...full, errorRows: full.errorRows.slice(0, PROGRESS_ERROR_ROWS) };
  };

  if (dryRun) {
    await run();
    return { dryRun: true, clientId, ...full };
  }

  const active = await jobs.findActiveJob({ clientId, type: "csv" });
  if (active) {
    throw csvError("JOB_ALREADY_RUNNING", `実行中の取り込みがあります: job=${active.id} status=${active.status}`);
  }

  const job = await jobs.createJob({ clientId, type: "csv", createdBy });
  const finished = await jobs.runJob(job, run);
  if (!finished || finished.status !== "completed") {
    const progress = (finished && finished.progress) || {};
    const e = csvError(progress.errorCode || "JOB_FAILED", progress.errorDetail || "");
    e.jobId = job.id;
    throw e;
  }
  return { dryRun: false, clientId, jobId: finished.id, ...full };
}

async function execute({ clientId, parsed, dryRun, force }) {
  const articles = await supabase.selectAll("articles", {
    select: "id,url,target_keyword,target_keyword_confidence,target_keyword_source",
    client_id: `eq.${clientId}`,
    order: "id.asc",
  });

  // articleUrlKey → 行。DB 側でキーが衝突する場合（http と https の両方が入っている等）は先着を採る
  const byKey = new Map();
  let duplicateKeysInDb = 0;
  for (const a of articles) {
    const key = articleUrlKey(a.url);
    if (!key) continue;
    if (byKey.has(key)) duplicateKeysInDb++;
    else byKey.set(key, a);
  }

  const errorRows = [];
  const payload = [];
  const seenKeys = new Set();
  let updated = 0;
  let unchanged = 0;
  let skippedManual = 0;

  const reject = (row, reason) => errorRows.push({ line: row.line, url: row.url, reason });

  for (const row of parsed.rows) {
    if (!row.url) {
      reject(row, "EMPTY_URL");
      continue;
    }
    const key = articleUrlKey(row.url);
    if (!key) {
      reject(row, "BAD_URL");
      continue;
    }
    const keyword = normalizeKeyword(row.target_keyword);
    if (!keyword) {
      reject(row, "EMPTY_KEYWORD");
      continue;
    }
    if (seenKeys.has(key)) {
      reject(row, "DUPLICATE_IN_CSV");
      continue;
    }
    seenKeys.add(key);

    const article = byKey.get(key);
    if (!article) {
      reject(row, "NOT_FOUND");
      continue;
    }
    if (article.target_keyword_source === "manual" && !force) {
      skippedManual++;
      reject(row, "SKIPPED_MANUAL");
      continue;
    }

    const same =
      article.target_keyword === keyword &&
      article.target_keyword_confidence === "high" &&
      article.target_keyword_source === "csv";
    if (same) {
      unchanged++;
      continue;
    }

    updated++;
    // url は DB に入っている値をそのまま使う（CSV の表記で送ると新規行ができてしまう）。
    // articles で NOT NULL かつ default なしの列は client_id と url の 2 つで、どちらも含めている。
    payload.push({
      client_id: clientId,
      url: article.url,
      target_keyword: keyword,
      target_keyword_confidence: "high",
      target_keyword_source: "csv",
    });
  }

  if (!dryRun) {
    for (const part of chunk(payload, UPSERT_CHUNK)) {
      await supabase.upsert("articles", part, { onConflict: "client_id,url" });
    }
  }

  return {
    encoding: parsed.encoding,
    totalRows: parsed.rows.length,
    updated,
    unchanged,
    skippedManual,
    errors: errorRows.length,
    duplicateKeysInDb,
    errorRows,
  };
}

module.exports = { importCsv, normalizeKeyword, MAX_BYTES, MAX_ROWS };
