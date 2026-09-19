/**
 * クライアント設定のランタイム取得
 *
 * これまで会社名・サービス名・出典URLは VITE_ 環境変数で持っていたが、
 * VITE_ はビルド時にJSへ焼き込まれるため、クライアントごとに別ビルドが必要だった。
 * 起動後にバックエンドから取得する形へ移すことで、1つのデプロイで
 * 全クライアントを扱えるようにする。
 */

export interface ClientBrand {
  companyName: string;
  serviceName: string;
  noteUrl: string;
  mediaUrl: string;
  siteUrl: string;
}

export interface ClientConfig {
  id: string;
  label: string;
  brand: ClientBrand;
  cms: {
    type: "wordpress" | "payload";
    baseUrl: string;
    defaultPostStatus: string;
    configured: boolean;
  };
  hasSpreadsheet: boolean;
  hasCompanyData: boolean;
}

const FALLBACK_BRAND: ClientBrand = {
  companyName: "当社",
  serviceName: "当社サービス",
  noteUrl: "",
  mediaUrl: "",
  siteUrl: "",
};

export function backendUrl(): string {
  if (import.meta.env.DEV) return "";
  return (
    import.meta.env.VITE_API_URL?.replace("/api", "") ||
    import.meta.env.VITE_BACKEND_URL ||
    ""
  );
}

const STORAGE_KEY = "seo-agent:selected-client";

let activeId: string | null = null;
let activeConfig: ClientConfig | null = null;
let cachedClients: ClientConfig[] = [];
const listeners = new Set<(c: ClientConfig | null) => void>();
const warningListeners = new Set<(msg: string) => void>();
const clientsListeners = new Set<(list: ClientConfig[]) => void>();

/** 選択中のクライアントIDを取得（未選択ならlocalStorageから復元） */
export function getActiveClientId(): string | null {
  if (activeId) return activeId;
  try {
    activeId = localStorage.getItem(STORAGE_KEY);
  } catch {
    activeId = null;
  }
  return activeId;
}

/** 利用可能なクライアント一覧を取得 */
export async function fetchClients(): Promise<ClientConfig[]> {
  const res = await fetch(`${backendUrl()}/api/clients`, {
    headers: clientHeaders(),
  });
  if (!res.ok) throw new Error("クライアント一覧を取得できませんでした");
  const data = await res.json();
  cachedClients = data.clients ?? [];
  clientsListeners.forEach((fn) => {
    try {
      fn(cachedClients);
    } catch (err) {
      console.warn("[clientContext] onClientsChange の購読コールバックで例外:", err);
    }
  });
  return cachedClients;
}

/**
 * クライアント一覧の更新を購読する（画面側の再描画用）。
 * fetchClients() が完了するたびに最新の一覧で呼ばれる。
 * 管理画面で登録・無効化したあと fetchClients() を呼べば、選択 UI が即時に追従する。
 */
export function onClientsChange(fn: (list: ClientConfig[]) => void): () => void {
  clientsListeners.add(fn);
  return () => clientsListeners.delete(fn);
}

/**
 * クライアントを切り替える。
 * 選択は即座に確定し、詳細設定の取得失敗は警告に留める。
 */
export async function setActiveClient(clientId: string): Promise<ClientConfig> {
  // 1. 選択を即座に確定
  activeId = clientId;
  try {
    localStorage.setItem(STORAGE_KEY, clientId);
  } catch {
    // プライベートブラウジング等では保存できないが動作には支障ない
  }

  // 2. キャッシュ済み一覧から暫定設定をセット
  const cached = cachedClients.find((c) => c.id === clientId);
  activeConfig = cached ?? {
    id: clientId,
    label: clientId,
    brand: FALLBACK_BRAND,
    cms: { type: "wordpress", baseUrl: "", defaultPostStatus: "draft", configured: false },
    hasSpreadsheet: false,
    hasCompanyData: false,
  };
  listeners.forEach((fn) => fn(activeConfig));

  // 3. 詳細設定を非同期で取得し、成功したら上書き
  try {
    const res = await fetch(
      `${backendUrl()}/api/client-config?clientId=${encodeURIComponent(clientId)}`,
      { headers: clientHeaders() },
    );
    if (!res.ok) {
      throw new Error(`クライアント設定を読み込めませんでした: ${clientId}`);
    }
    const config: ClientConfig = await res.json();
    // 取得中に別のクライアントに切り替えられていたら上書きしない
    if (activeId === clientId) {
      activeConfig = config;
      listeners.forEach((fn) => fn(config));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warningListeners.forEach((fn) => fn(msg));
  }

  return activeConfig!;
}

/** 読み込み済みの設定を同期的に取得。未読み込みなら null。 */
export function getActiveClient(): ClientConfig | null {
  return activeConfig;
}

/**
 * ブランド情報を同期的に取得する。
 * 未選択でも記事生成が落ちないよう既定値を返す。
 * 旧コードの `import.meta.env.VITE_SERVICE_NAME || '当社サービス'` を
 * `getBrand().serviceName` に置き換える形で移行できる。
 */
export function getBrand(): ClientBrand {
  return activeConfig?.brand ?? FALLBACK_BRAND;
}

/** APIリクエストに付ける共通ヘッダー */
export function clientHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  const id = getActiveClientId();
  if (id) headers["x-client-id"] = id;
  return headers;
}

/** 設定切り替えの購読（画面側の再描画用） */
export function onClientChange(fn: (c: ClientConfig | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 接続警告の購読 */
export function onClientWarning(fn: (msg: string) => void): () => void {
  warningListeners.add(fn);
  return () => warningListeners.delete(fn);
}

/** 起動時の復元。App のマウント時に一度呼ぶ。 */
export async function restoreActiveClient(): Promise<ClientConfig | null> {
  const id = getActiveClientId();
  if (!id) return null;
  try {
    return await setActiveClient(id);
  } catch {
    return null;
  }
}
