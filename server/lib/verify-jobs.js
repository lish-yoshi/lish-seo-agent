/**
 * T-06 の動作確認スクリプト（テーブル適用後に実行）
 *
 *   cd <repo> && node server/lib/verify-jobs.js
 *
 * settings の読み取り、import_jobs のライフサイクル、articles の vector 列の読み書きを確認する。
 * 検証用に作った行は必ず削除する。値・キー・ベクトルの中身は出力しない。
 * いずれかが NG でも残りは続行し、最後に一覧を出す。NG があれば終了コード 1。
 */

const path = require("path");

// verify.js / scraping-server.js:23 と同じく、リポジトリ直下の .env を読む
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const supabase = require("./supabase");
const jobs = require("./jobs");

const EXPECTED_SETTINGS = 6;
const VERIFY_CLIENT = "local-test";
const VERIFY_URL = "https://verify.invalid/t06";
const DIM = 768;

const results = [];
let createdJobId = null;

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

(async () => {
  console.log("server/lib verify-jobs (T-06)");

  await step("a. settings select", async () => {
    const rows = await supabase.select("settings", { select: "key,value", order: "key.asc" });
    const row = rows.find((r) => r.key === "cannibal_embedding_threshold");
    const match = rows.length === EXPECTED_SETTINGS;
    return {
      ok: Boolean(row),
      note: `count=${rows.length}${match ? "" : `（期待値 ${EXPECTED_SETTINGS} と不一致）`} cannibal_embedding_threshold=${row ? JSON.stringify(row.value) : "なし"}`,
    };
  });

  await step("b. job lifecycle", async () => {
    const job = await jobs.createJob({ clientId: VERIFY_CLIENT, type: "csv", createdBy: "verify" });
    createdJobId = job.id;
    await jobs.startJob(job.id);
    await jobs.updateProgress(job.id, { done: 1, total: 2 });
    await jobs.completeJob(job.id, { done: 2, total: 2 });
    const got = await jobs.getJob(job.id);
    return {
      ok: Boolean(got && got.status === "completed" && got.finished_at),
      note: `status=${got ? got.status : "なし"} progress=${got ? JSON.stringify(got.progress) : "-"}`,
    };
  });

  await step("c. findActiveJob is null", async () => {
    const active = await jobs.findActiveJob({ clientId: VERIFY_CLIENT, type: "csv" });
    return { ok: active === null, note: active ? `(残存: status=${active.status})` : "" };
  });

  await step("d. remove job", async () => {
    if (!createdJobId) throw Object.assign(new Error("no job"), { code: "NO_JOB_CREATED" });
    const removed = await supabase.remove("import_jobs", { id: `eq.${createdJobId}` });
    const after = await jobs.getJob(createdJobId);
    return { ok: removed.length === 1 && after === null, note: `removed=${removed.length}` };
  });

  await step("e. articles vector round trip", async () => {
    const filter = { client_id: `eq.${VERIFY_CLIENT}`, url: `eq.${VERIFY_URL}` };
    // 前回の実行が途中で止まっていた場合の残りを先に消す
    await supabase.remove("articles", filter);

    const vectorText = `[${new Array(DIM).fill(0.001).join(",")}]`;
    let insertedId = null;
    try {
      const inserted = await supabase.insert("articles", {
        client_id: VERIFY_CLIENT,
        url: VERIFY_URL,
        title: "verify t06",
        source: "manual",
        embedding: vectorText,
        embedding_model: "verify",
      });
      insertedId = inserted[0] && inserted[0].id;

      const rows = await supabase.select("articles", { select: "id,status,embedding", ...filter });
      const raw = rows[0] && rows[0].embedding;
      // PostgREST は vector を "[...]" 形式の文字列で返す（環境によっては配列）
      const values = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
      return {
        ok: rows.length === 1 && values.length === DIM && rows[0].status === "未対応",
        note: `rows=${rows.length} dim=${values.length} default_status=${rows[0] ? rows[0].status : "-"}`,
      };
    } finally {
      const removed = await supabase.remove("articles", filter);
      if (insertedId && removed.length !== 1) console.log("   （注意）検証行の削除件数が 1 ではありません");
    }
  });

  console.log("---");
  for (const r of results) console.log(`${r.ok ? "OK" : "NG"}  ${r.label}`);
  const ng = results.filter((r) => !r.ok).length;
  console.log(ng === 0 ? "ALL OK" : `NG: ${ng} 件`);
  process.exit(ng === 0 ? 0 : 1);
})();
