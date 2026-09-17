import React, { useEffect, useState } from "react";
import {
  fetchClients,
  setActiveClient,
  getActiveClient,
  onClientChange,
  onClientWarning,
  onClientsChange,
  type ClientConfig,
} from "../services/clientContext";

/**
 * クライアント切り替え
 *
 * 選択中の投稿先URLを常時表示する。
 * どのサイトへ入稿されるか見えない状態でクライアント案件を回すと誤爆するため、
 * これは装飾ではなく安全装置として置いている。
 */
const ClientSelector: React.FC = () => {
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [active, setActive] = useState<ClientConfig | null>(getActiveClient());
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchClients()
      .then(setClients)
      .catch((e) => setError(e.message));
    const unsubChange = onClientChange(setActive);
    const unsubWarning = onClientWarning(setError);
    // 管理画面で登録・無効化したあとの一覧更新に追従する
    const unsubClients = onClientsChange(setClients);
    return () => { unsubChange(); unsubWarning(); unsubClients(); };
  }, []);

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id) return;
    setBusy(true);
    setError("");
    await setActiveClient(id);
    setBusy(false);
  };

  return (
    <div className="w-full max-w-5xl mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm">
      <label className="font-medium text-gray-700">投稿先</label>
      <select
        value={active?.id ?? ""}
        onChange={handleChange}
        disabled={busy || clients.length === 0}
        className="rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
      >
        <option value="">クライアントを選択</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>

      {active ? (
        <span className="text-gray-600">
          <span className="font-mono">{active.cms.baseUrl}</span>
          <span className="ml-2 text-xs text-gray-400">
            {active.cms.type} / {active.cms.defaultPostStatus}
          </span>
          {!active.cms.configured && (
            <span className="ml-2 text-xs text-amber-700">認証情報が未設定</span>
          )}
        </span>
      ) : (
        <span className="text-amber-700">
          未選択。入稿前に必ず投稿先を選んでください
        </span>
      )}

      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
};

export default ClientSelector;
