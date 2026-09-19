/**
 * ターゲット KW 台帳 CSV のパーサー（T-09）。依存なし。
 *
 *   - 入力は Buffer。UTF-8（不正なバイト列はエラー扱い）で復号し、失敗したら Shift_JIS で復号する。
 *     Excel で保存した CSV は Shift_JIS であることが多いため
 *   - RFC 4180 相当: ダブルクォート囲み、"" のエスケープ、クォート内のカンマと改行、CRLF / LF
 *   - 1 行目はヘッダー必須。列名は前後の空白を除いて小文字で比較。
 *     url と target_keyword は必須、note は任意。余分な列は無視
 *   - 空行（全フィールドが空）は無視
 *
 * 戻り値: { encoding: "utf-8" | "shift_jis", rows: [{ line, url, target_keyword, note }] }
 *   line はファイル上の行番号（1 始まり。ヘッダーが 1 行目）
 */

function csvError(code, detail) {
  const e = new Error(`CSV の取り込みに失敗しました (${code})`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

/** Buffer を文字列へ。UTF-8 で読めなければ Shift_JIS */
function decodeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw csvError("CSV_BAD_FORMAT", "入力が Buffer ではありません");
  let text;
  let encoding = "utf-8";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (_) {
    encoding = "shift_jis";
    text = new TextDecoder("shift_jis").decode(buffer);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  return { text, encoding };
}

/** 文字列を { line, fields }[] に分解する */
function parseRecords(text) {
  const records = [];
  let fields = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = "";
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "" && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }

  if (inQuotes) throw csvError("CSV_BAD_FORMAT", `${recordLine} 行目: ダブルクォートが閉じていません`);
  if (field !== "" || fields.length > 0 || quotedField) endRecord();

  // 空行（全フィールドが空）は無視する
  return records.filter((r) => r.fields.some((f) => f.trim() !== ""));
}

function parseCsv(buffer) {
  const { text, encoding } = decodeBuffer(buffer);
  const records = parseRecords(text);
  if (records.length === 0) throw csvError("CSV_BAD_HEADER", "ヘッダー行がありません");

  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const urlIdx = header.indexOf("url");
  const kwIdx = header.indexOf("target_keyword");
  const noteIdx = header.indexOf("note");
  const missing = [];
  if (urlIdx === -1) missing.push("url");
  if (kwIdx === -1) missing.push("target_keyword");
  if (missing.length) {
    throw csvError("CSV_BAD_HEADER", `必須の列がありません: ${missing.join(", ")}（1 行目: ${header.join(", ").slice(0, 200)}）`);
  }

  const rows = records.slice(1).map((r) => ({
    line: r.line,
    url: (r.fields[urlIdx] ?? "").trim(),
    target_keyword: r.fields[kwIdx] ?? "",
    note: noteIdx === -1 ? "" : (r.fields[noteIdx] ?? "").trim(),
  }));
  return { encoding, rows };
}

module.exports = { parseCsv, decodeBuffer, parseRecords };
