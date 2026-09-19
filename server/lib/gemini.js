/**
 * Gemini API クライアント（T-04 共通ライブラリ）
 *
 * バックエンドからのみ呼ぶ。SDK は使わず REST を node-fetch で直接叩く
 * （本番の Node 18 では新 SDK @google/genai が要件を満たさないため）。
 * API キーは必ず x-goog-api-key ヘッダーで送り、URL のクエリには載せない。
 *
 * エラーは code 付き Error。message は固定文言、詳細は detail（キーをマスク済み）。
 *   GEMINI_CONFIG_MISSING / GEMINI_FETCH_FAILED / GEMINI_HTTP_<status> /
 *   GEMINI_BAD_RESPONSE / GEMINI_BAD_DIMENSION
 */

const fetch = require("node-fetch");
const { readSecret, maskSecrets } = require("./secrets");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 429 / 5xx のみ。最大 3 回リトライ

const EMBEDDING_MODEL = readSecret("GEMINI_EMBEDDING_MODEL") || "gemini-embedding-2";
const TEXT_MODEL = readSecret("GEMINI_TEXT_MODEL") || "gemini-3.6-flash";
const EMBEDDING_DIM = 768; // articles.embedding は vector(768)

// gemini-embedding-2 は task_type パラメータが使えないため、用途を本文の接頭辞で指定する。
// 記事同士の類似度（カニバリ判定・重複チェック）に使うので sentence similarity 固定。
// 接頭辞は必ずここで付ける。呼び出し側には書かせない。
const EMBEDDING_PREFIX = "task: sentence similarity | query: ";

function aiError(code, detail, extra) {
  const e = new Error(`AI 処理に失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  if (extra) Object.assign(e, extra);
  return e;
}

function apiKey() {
  let key = readSecret("GEMINI_API_KEY");
  // ローカル検証用のフォールバック。本番では使わない。
  // TODO: T-05b 完了時に削除（フロントの VITE_GEMINI_API_KEY を廃止するタイミング）
  if (!key && process.env.NODE_ENV !== "production") {
    key = readSecret("VITE_GEMINI_API_KEY");
  }
  if (!key) throw aiError("GEMINI_CONFIG_MISSING", "GEMINI_API_KEY が未設定です");
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** models/<model>:<action> を POST し、パース済み JSON を返す。429 / 5xx はリトライ */
async function post(model, action, body) {
  const key = apiKey();
  const endpoint = `${BASE_URL}/models/${encodeURIComponent(model)}:${action}`;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    let text = "";
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const reason = err && err.name === "AbortError" ? `timeout (${TIMEOUT_MS}ms)` : err.message;
      throw aiError("GEMINI_FETCH_FAILED", maskSecrets(reason, [key]));
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch (err) {
        throw aiError("GEMINI_BAD_RESPONSE", maskSecrets(`JSON を解釈できません: ${err.message}`, [key]));
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw aiError(`GEMINI_HTTP_${res.status}`, maskSecrets(text.slice(0, 500), [key]), {
      status: res.status,
      attempts: attempt + 1,
    });
  }
}

/**
 * 1 文を埋め込み、長さ EMBEDDING_DIM の number[] を返す。
 * 用途は記事・クエリ同士の類似度計算。
 */
async function embedText(text) {
  const input = String(text ?? "").trim();
  if (!input) throw aiError("GEMINI_BAD_RESPONSE", "埋め込み対象のテキストが空です");

  const data = await post(EMBEDDING_MODEL, "embedContent", {
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text: EMBEDDING_PREFIX + input }] },
    output_dimensionality: EMBEDDING_DIM,
  });

  const values = data && data.embedding && data.embedding.values;
  if (!Array.isArray(values) || !values.every((v) => typeof v === "number")) {
    throw aiError("GEMINI_BAD_RESPONSE", "embedding.values がありません");
  }
  if (values.length !== EMBEDDING_DIM) {
    throw aiError("GEMINI_BAD_DIMENSION", `次元数が ${values.length} です（期待値 ${EMBEDDING_DIM}）`);
  }
  return values;
}

/**
 * 複数の文を埋め込む。入力と同じ順序で { ok, embedding, error } を返す。
 * 1 件失敗しても全体は失敗にしない（error は code 付き Error）。
 */
async function embedTexts(texts, { concurrency = 2 } = {}) {
  const list = Array.isArray(texts) ? texts : [];
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      const i = next++;
      try {
        results[i] = { ok: true, embedding: await embedText(list[i]), error: null };
      } catch (err) {
        results[i] = { ok: false, embedding: null, error: err };
      }
    }
  }

  const workers = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * テキスト生成。json: true のときは JSON で返させ、パース済みの値を返す。
 */
async function generateText(prompt, { model, temperature, maxOutputTokens, json = false } = {}) {
  const input = String(prompt ?? "").trim();
  if (!input) throw aiError("GEMINI_BAD_RESPONSE", "プロンプトが空です");

  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
  if (json) generationConfig.responseMimeType = "application/json";

  const data = await post(model || TEXT_MODEL, "generateContent", {
    contents: [{ role: "user", parts: [{ text: input }] }],
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  });

  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  // 思考過程（thought: true）の part は出力に含めない
  const text = parts
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");

  if (!text) {
    const reason = (candidate && candidate.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || "unknown";
    throw aiError("GEMINI_BAD_RESPONSE", `本文が空です (finishReason: ${reason})`);
  }
  if (!json) return text;

  try {
    return JSON.parse(text);
  } catch (err) {
    throw aiError("GEMINI_BAD_RESPONSE", `JSON を解釈できません: ${err.message}`);
  }
}

module.exports = {
  embedText,
  embedTexts,
  generateText,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  TEXT_MODEL,
};
