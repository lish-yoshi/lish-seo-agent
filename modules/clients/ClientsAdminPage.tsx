/**
 * クライアント管理画面（T-01b-2）
 *
 * App.tsx から React.lazy で読み込まれる。VITE_ENABLE_CLIENTS_ADMIN=true のときだけ
 * import() が残るため、フラグ off のビルドにはこのチャンクが含まれない。
 */

import React, { useCallback, useEffect, useState } from "react";
import { fetchClients } from "../../services/clientContext";
import { ApiError, listAdminClients, type AdminClient } from "./api";
import ClientEditor from "./ClientEditor";
import ClientList from "./ClientList";
import ClientWizard from "./ClientWizard";
import { Button, Notice, Spinner } from "./ui";

type View = { mode: "list" } | { mode: "new" } | { mode: "edit"; id: string };

const ClientsAdminPage: React.FC = () => {
  const [view, setView] = useState<View>({ mode: "list" });
  const [clients, setClients] = useState<AdminClient[] | null>(null);
  const [writable, setWritable] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listAdminClients();
      setClients(res.clients);
      setWritable(res.writable);
      setListError(null);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) {
        setAuthError(err.message);
      } else {
        setListError((err as Error).message);
      }
      setClients([]);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 保存・無効化のあと、一覧と既存のクライアント選択 UI を更新する */
  const afterSave = useCallback(() => {
    reload();
    fetchClients().catch(() => {
      /* 選択 UI 側の更新失敗は画面に影響しない */
    });
  }, [reload]);

  const onAuthError = useCallback((message: string) => setAuthError(message || "IAP 認証が必要です"), []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">クライアント管理</h1>
          <p className="text-sm text-gray-500">記事生成の投稿先と計測・運用の設定を登録します</p>
        </div>
        {view.mode === "list" && (
          <Button onClick={() => setView({ mode: "new" })} disabled={!writable} data-testid="new-client">
            新規登録
          </Button>
        )}
      </div>

      {authError && (
        <Notice tone="error">
          <strong>IAP 認証が必要です。</strong> {authError}
        </Notice>
      )}
      {!writable && (
        <Notice tone="warning">このサーバーのクライアントストアは読み取り専用です（CLIENT_STORE=file）。登録・変更はできません。</Notice>
      )}

      {view.mode === "list" && (
        <>
          {listError && <Notice tone="error">{listError}</Notice>}
          {clients === null ? <Spinner /> : <ClientList clients={clients} onSelect={(id) => setView({ mode: "edit", id })} />}
        </>
      )}

      {view.mode === "new" && (
        <ClientWizard
          onAuthError={onAuthError}
          onSaved={afterSave}
          onDone={() => {
            // 「あとで」「キャンセル」はどちらも一覧へ。続きは一覧の行クリックから編集できる
            reload();
            setView({ mode: "list" });
          }}
        />
      )}

      {view.mode === "edit" && (
        <ClientEditor
          id={view.id}
          onAuthError={onAuthError}
          onSaved={afterSave}
          onBack={() => {
            reload();
            setView({ mode: "list" });
          }}
        />
      )}
    </div>
  );
};

export default ClientsAdminPage;
