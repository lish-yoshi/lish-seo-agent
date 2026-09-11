/**
 * 親アプリ（SEOエージェント）からの postMessage を受け付けるオリジンの判定
 *
 * event.origin は常に「スキーム + ホスト + ポート」の絶対オリジンなので、
 * 設定値も new URL(...).origin で正規化してから比較する。
 * 末尾スラッシュやパスが混入していても一致判定が壊れない。
 *
 * 本番のオリジンは次の環境変数で渡す（どちらもビルド時に焼き込まれる）:
 *   VITE_MAIN_APP_URL            … メインアプリのURL（ReportView の返信先にも使う）
 *   VITE_ALLOWED_PARENT_ORIGINS  … 追加で許可するオリジン（カンマ区切り）
 */

// ローカルでメインアプリと imager を起動した場合のオリジン
const DEV_ORIGINS = [
  "http://localhost:5178", // 現行開発環境
  "http://localhost:5176", // レガシー（互換性）
  "http://localhost:5177", // 画像生成エージェント
  "http://127.0.0.1:5176",
  "http://127.0.0.1:5177",
  "http://127.0.0.1:5178",
];

// 相対パス（旧設定の "/" など）は base を補うと imager 自身のオリジンに解決され、
// 設定ミスが黙って通ってしまう。絶対URL以外は無効として警告し、許可リストに含めない。
function toOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    console.warn("⚠️ 許可オリジンの設定値が絶対URLではないため無視します:", value);
    return null;
  }
}

let cached: string[] | null = null;

export function getAllowedParentOrigins(): string[] {
  if (cached) return cached;

  const configured = [
    import.meta.env.VITE_MAIN_APP_URL,
    ...(import.meta.env.VITE_ALLOWED_PARENT_ORIGINS?.split(",") ?? []),
  ].filter((v): v is string => typeof v === "string" && v.trim() !== "");

  const origins = [...DEV_ORIGINS, ...configured]
    .map(toOrigin)
    .filter((v): v is string => v !== null);

  cached = [...new Set(origins)];
  return cached;
}

export function isAllowedParentOrigin(origin: string): boolean {
  return getAllowedParentOrigins().includes(origin);
}
