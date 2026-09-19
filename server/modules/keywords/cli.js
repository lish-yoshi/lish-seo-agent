#!/usr/bin/env node
/**
 * キーワード設計モジュールの CLI（T-07）
 *
 *   node server/modules/keywords/cli.js import-cms --client <id> [--post-types post,page] [--per-page 50] [--dry-run] [--verbose]
 *
 * express は起動しない。scraping-server.js は require しない
 * （listen・unhandledRejection での process.exit・ブラウザ起動などの副作用があるため）。
 * 結果の集計を JSON で標準出力に出す。失敗時は message と code だけを出して終了コード 1。
 * 認証情報は出力しない。
 */

const path = require("path");
const os = require("os");

// store.js は require の時点で process.env（CLIENT_STORE 等）を読む。
// そのため、ほかのモジュールを require する前に .env を読み込む。
// このファイルは server/modules/keywords/ にあるので、リポジトリ直下は 3 階層上。
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, flags: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts.flags[key] = true;
    } else {
      opts.flags[key] = next;
      i++;
    }
  }
  return opts;
}

function usage() {
  return [
    "使い方:",
    "  node server/modules/keywords/cli.js import-cms --client <id> [--post-types post,page] [--per-page 50] [--dry-run] [--verbose]",
    "  node server/modules/keywords/cli.js import-csv --client <id> --file <path> [--dry-run] [--force] [--errors-out <path>] [--verbose]",
  ].join("\n");
}

/** CSV の 1 フィールド。カンマ・改行・ダブルクォートを含むときだけ囲む */
function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** エラー行を line,url,reason の CSV（UTF-8・BOM 付き。Excel でそのまま開ける）で書き出す */
function writeErrorsCsv(filePath, errorRows) {
  const fs = require("fs");
  const lines = ["line,url,reason", ...errorRows.map((r) => [r.line, r.url, r.reason].map(csvField).join(","))];
  fs.writeFileSync(filePath, "﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

async function runImportCsv(flags) {
  const fs = require("fs");
  if (typeof flags.file !== "string" || !flags.file) {
    throw Object.assign(new Error("--file <path> は必須です"), { code: "CLI_BAD_ARGS" });
  }
  let buffer;
  try {
    buffer = fs.readFileSync(flags.file);
  } catch (err) {
    throw Object.assign(new Error("CSV ファイルを読めません (CSV_FILE_NOT_FOUND)"), { code: "CSV_FILE_NOT_FOUND", detail: err.message });
  }
  const { importCsv } = require("./import/csv");
  const result = await importCsv({
    clientId: flags.client,
    buffer,
    createdBy: `cli:${osUser()}`,
    dryRun: flags["dry-run"] === true,
    force: flags.force === true,
  });
  if (typeof flags["errors-out"] === "string" && flags["errors-out"]) {
    writeErrorsCsv(flags["errors-out"], result.errorRows);
    result.errorsOut = flags["errors-out"];
  }
  return result;
}

function osUser() {
  try {
    return os.userInfo().username || "unknown";
  } catch (_) {
    return "unknown";
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const verbose = flags.verbose === true;

  try {
    if (!["import-cms", "import-csv"].includes(command)) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }
    if (typeof flags.client !== "string" || !flags.client) {
      console.error("--client <id> は必須です\n" + usage());
      process.exitCode = 1;
      return;
    }

    if (command === "import-csv") {
      console.log(JSON.stringify(await runImportCsv(flags), null, 2));
      return;
    }

    const { importCms } = require("./import/cms");
    const result = await importCms({
      clientId: flags.client,
      postTypes: typeof flags["post-types"] === "string" ? flags["post-types"].split(",") : undefined,
      perPage: typeof flags["per-page"] === "string" ? Number(flags["per-page"]) : undefined,
      createdBy: `cli:${osUser()}`,
      dryRun: flags["dry-run"] === true,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const out = { ok: false, code: (err && err.code) || "ERROR", message: (err && err.message) || "失敗しました" };
    if (err && err.jobId) out.jobId = err.jobId;
    if (verbose && err && err.detail) out.detail = err.detail;
    console.error(JSON.stringify(out, null, 2));
    process.exitCode = 1;
  }
}

main();
