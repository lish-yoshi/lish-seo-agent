/**
 * 非同期ジョブ基盤（T-06 / T-04 共通ライブラリ）
 *
 * import_jobs テーブルにジョブの状態と進捗を記録する。
 *   createJob → startJob → updateProgress … → completeJob / failJob
 * 定型は runJob(job, handler) にまとめてある。
 *
 * 方針:
 *   - error 列には固定文言＋エラー種別（code）だけを保存する。例外メッセージはそのまま入れない。
 *     詳細はマスクしたうえで progress.errorDetail に入れる
 *   - updateProgress は 2 秒未満の連続呼び出しでは DB に書かない（最後の状態は complete / fail で必ず書く）
 *   - running のまま heartbeat_at が 10 分以上止まった行は、取得時に failed（JOB_STALE）へ更新する。
 *     Cloud Run のインスタンス入れ替えで処理が途切れたジョブを、画面に「実行中」のまま残さないため
 */

const supabase = require("./supabase");
const { readSecret, maskSecrets } = require("./secrets");

const TABLE = "import_jobs";
const JOB_TYPES = ["cms", "gsc", "csv", "full", "ga4"];
const ACTIVE_STATUSES = ["queued", "running"];
const PROGRESS_MIN_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const ERROR_DETAIL_MAX = 500;

// ジョブ ID ごとの、最後に DB へ書いた時刻と最新の進捗（未書き込み分を含む）
const lastWriteAt = new Map();
const lastProgress = new Map();

function jobError(code, detail) {
  const e = new Error(`ジョブ処理に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

const nowIso = () => new Date().toISOString();

function knownSecrets() {
  return ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "GEMINI_API_KEY", "INTERNAL_API_KEY"].map(readSecret);
}

function forget(id) {
  lastWriteAt.delete(id);
  lastProgress.delete(id);
}

async function patchJob(id, patch, extraFilter) {
  const rows = await supabase.update(TABLE, { id: `eq.${id}`, ...(extraFilter || {}) }, patch);
  return rows[0] || null;
}

/** running のまま応答が止まった行を failed に更新し、更新後の行を返す。対象外ならそのまま返す */
async function sweepIfStale(job) {
  if (!job || job.status !== "running") return job;
  const beat = Date.parse(job.heartbeat_at || job.started_at || job.created_at || "");
  if (!Number.isFinite(beat) || Date.now() - beat < STALE_AFTER_MS) return job;

  // 別プロセスが同時に更新しても二重に書かないよう、status=running を条件に付ける
  const updated = await patchJob(
    job.id,
    {
      status: "failed",
      finished_at: nowIso(),
      error: "ジョブが応答なしのため失敗扱いにしました (JOB_STALE)",
      progress: { ...(job.progress || {}), errorCode: "JOB_STALE" },
    },
    { status: "eq.running" }
  );
  forget(job.id);
  if (updated) return updated;
  // 条件に合わなかった＝他で更新済み。最新を取り直す
  const rows = await supabase.select(TABLE, { select: "*", id: `eq.${job.id}` });
  return rows[0] || null;
}

/** ジョブを queued で作成する */
async function createJob({ clientId = null, type, createdBy = null } = {}) {
  if (!JOB_TYPES.includes(type)) {
    throw jobError("JOB_BAD_TYPE", `type は ${JOB_TYPES.join(" / ")} のいずれかで指定してください`);
  }
  const rows = await supabase.insert(TABLE, {
    client_id: clientId,
    type,
    status: "queued",
    progress: {},
    created_by: createdBy,
  });
  if (!rows[0]) throw jobError("JOB_CREATE_FAILED", "作成した行が返りませんでした");
  return rows[0];
}

async function startJob(id) {
  const now = nowIso();
  const job = await patchJob(id, { status: "running", started_at: now, heartbeat_at: now });
  if (!job) throw jobError("JOB_NOT_FOUND", `ジョブが見つかりません: ${id}`);
  lastWriteAt.set(id, Date.now());
  lastProgress.set(id, job.progress || {});
  return job;
}

/**
 * 進捗を置き換える。前回の書き込みから 2 秒未満なら DB には書かず、メモリにだけ保持する。
 * 戻り値: 書き込んだときは更新後の行、スキップしたときは null
 */
async function updateProgress(id, progress) {
  lastProgress.set(id, progress || {});
  const last = lastWriteAt.get(id) || 0;
  if (Date.now() - last < PROGRESS_MIN_INTERVAL_MS) return null;
  lastWriteAt.set(id, Date.now());
  return patchJob(id, { progress: progress || {}, heartbeat_at: nowIso() });
}

/** 完了。progress を省略したときは、最後に updateProgress へ渡された値を書く */
async function completeJob(id, progress) {
  const finalProgress = progress !== undefined ? progress : lastProgress.get(id) || {};
  const now = nowIso();
  const job = await patchJob(id, {
    status: "completed",
    progress: finalProgress || {},
    finished_at: now,
    heartbeat_at: now,
    error: null,
  });
  forget(id);
  if (!job) throw jobError("JOB_NOT_FOUND", `ジョブが見つかりません: ${id}`);
  return job;
}

/**
 * 失敗。error 列には固定文言＋code のみ。
 * 詳細はマスクして progress.errorDetail に入れる（最後の進捗は保持する）。
 */
async function failJob(id, error) {
  const code = (error && error.code) || "JOB_FAILED";
  const rawDetail = (error && (error.detail || error.message)) || "";
  const errorDetail = maskSecrets(String(rawDetail), knownSecrets()).slice(0, ERROR_DETAIL_MAX);
  const now = nowIso();
  const job = await patchJob(id, {
    status: "failed",
    progress: { ...(lastProgress.get(id) || {}), errorCode: code, errorDetail },
    finished_at: now,
    heartbeat_at: now,
    error: `ジョブが失敗しました (${code})`,
  });
  forget(id);
  if (!job) throw jobError("JOB_NOT_FOUND", `ジョブが見つかりません: ${id}`);
  return job;
}

/** 1 件取得。無ければ null。応答なしの running は failed に更新してから返す */
async function getJob(id) {
  const rows = await supabase.select(TABLE, { select: "*", id: `eq.${id}` });
  return sweepIfStale(rows[0] || null);
}

/** 新しい順に取得。clientId を省略すると全クライアント */
async function listJobs({ clientId, limit = 20 } = {}) {
  const query = { select: "*", order: "created_at.desc", limit: Math.max(1, Math.min(Number(limit) || 20, 200)) };
  if (clientId !== undefined) query.client_id = clientId === null ? "is.null" : `eq.${clientId}`;
  const rows = await supabase.select(TABLE, query);
  const out = [];
  for (const row of rows) out.push(await sweepIfStale(row));
  return out.filter(Boolean);
}

/**
 * 同一 client・同一 type の queued / running を返す（二重起動の防止用）。無ければ null。
 * 応答なしの running は failed に更新したうえで対象から外す。
 */
async function findActiveJob({ clientId = null, type } = {}) {
  const rows = await supabase.select(TABLE, {
    select: "*",
    client_id: clientId === null ? "is.null" : `eq.${clientId}`,
    type: `eq.${type}`,
    status: `in.(${ACTIVE_STATUSES.join(",")})`,
    order: "created_at.desc",
  });
  for (const row of rows) {
    const job = await sweepIfStale(row);
    if (job && ACTIVE_STATUSES.includes(job.status)) return job;
  }
  return null;
}

/**
 * 定型: startJob → handler({ job, report }) → completeJob。例外時は failJob。
 *   - report(progress) は updateProgress を呼ぶ（2 秒未満の連続呼び出しは DB に書かない）
 *   - handler がオブジェクトを返したら、それを最終の progress として保存する
 *   - この関数は例外を投げない。バックグラウンド実行で未処理の拒否（unhandledRejection）を
 *     起こすとサーバーごと落ちるため、結果は戻り値のジョブ行（completed / failed）で判断する
 */
async function runJob(job, handler) {
  const id = job && job.id;
  try {
    const started = await startJob(id);
    const report = (progress) =>
      updateProgress(id, progress).catch((err) => {
        console.warn(`⚠️ [jobs] 進捗の保存に失敗 (${id}): ${(err && err.code) || "ERROR"}`);
        return null;
      });
    const result = await handler({ job: started, report });
    const finalProgress = result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
    return await completeJob(id, finalProgress);
  } catch (err) {
    console.error(`❌ [jobs] ジョブ失敗 (${id}): ${(err && err.code) || "JOB_FAILED"}`);
    try {
      return await failJob(id, err);
    } catch (failErr) {
      console.error(`❌ [jobs] 失敗の記録にも失敗 (${id}): ${(failErr && failErr.code) || "ERROR"}`);
      return null;
    }
  }
}

module.exports = {
  createJob,
  startJob,
  updateProgress,
  completeJob,
  failJob,
  getJob,
  listJobs,
  findActiveJob,
  runJob,
  JOB_TYPES,
  STALE_AFTER_MS,
};
