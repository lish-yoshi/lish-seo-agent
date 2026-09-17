/**
 * 既存クライアントの編集（3セクション＋無効化）
 * セクション単位で保存し、変更した項目だけ PATCH する。
 */

import React, { useCallback, useEffect, useState } from "react";
import { ApiError, disableAdminClient, getAdminClient, updateAdminClient, type AdminClient } from "./api";
import {
  BasicFields,
  MeasurementFields,
  OperationFields,
  formKeyOfApiField,
  readinessChecks,
  toPatch,
  valuesFromClient,
  type FormErrors,
  type FormValues,
  type SectionKey,
} from "./fields";
import { Button, ConfirmDialog, Notice, Section, Spinner } from "./ui";

interface Props {
  id: string;
  onBack: () => void;
  onAuthError: (message: string) => void;
  onSaved: () => void;
}

const ClientEditor: React.FC<Props> = ({ id, onBack, onAuthError, onSaved }) => {
  const [client, setClient] = useState<AdminClient | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [saved, setSaved] = useState<FormValues | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busySection, setBusySection] = useState<SectionKey | "disable" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await getAdminClient(id);
      const v = valuesFromClient(c);
      setClient(c);
      setValues(v);
      setSaved(v);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) onAuthError(err.message);
      setLoadError((err as Error).message);
    }
  }, [id, onAuthError]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (patch: Partial<FormValues>) => {
    setValues((prev) => (prev ? { ...prev, ...patch } : prev));
    setErrors((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(patch) as (keyof FormValues)[]) delete next[k];
      return next;
    });
  };

  const handleApiError = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.isAuth) return onAuthError(err.message);
      const key = formKeyOfApiField(err.field);
      if (key) return setErrors((prev) => ({ ...prev, [key]: err.message }));
      return setFormError(err.message);
    }
    setFormError((err as Error).message);
  };

  const saveSection = async (section: SectionKey) => {
    if (!values || !saved) return;
    const patch = toPatch(values, saved, section);
    if (Object.keys(patch).length === 0) {
      setNotice("変更はありません");
      return;
    }
    setBusySection(section);
    setFormError(null);
    setNotice(null);
    try {
      const res = await updateAdminClient(id, patch);
      const v = valuesFromClient(res.client);
      setClient(res.client);
      setValues(v);
      setSaved(v);
      setWarnings(res.warnings);
      setNotice("保存しました");
      onSaved();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusySection(null);
    }
  };

  const disable = async () => {
    setBusySection("disable");
    setFormError(null);
    try {
      await disableAdminClient(id);
      setConfirmOpen(false);
      onSaved();
      onBack();
    } catch (err) {
      setConfirmOpen(false);
      handleApiError(err);
    } finally {
      setBusySection(null);
    }
  };

  if (loadError) {
    return (
      <div>
        <Notice tone="error">{loadError}</Notice>
        <Button variant="secondary" onClick={onBack}>
          一覧に戻る
        </Button>
      </div>
    );
  }
  if (!client || !values) return <Spinner />;

  const checks = readinessChecks(client);
  const allOk = checks.every((c) => c.ok);
  const sectionActions = (section: SectionKey) => (
    <Button onClick={() => saveSection(section)} busy={busySection === section} data-testid={`save-${section}`}>
      保存
    </Button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">
            {client.label} <span className="ml-2 font-mono text-sm text-gray-500">{client.id}</span>
          </h2>
          <p className="text-xs text-gray-500">
            最終更新: {client.updatedAt ?? "—"}{client.updatedBy ? `（${client.updatedBy}）` : ""}
            {!client.enabled && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-gray-700">無効</span>}
          </p>
        </div>
        <Button variant="secondary" onClick={onBack}>
          一覧に戻る
        </Button>
      </div>

      <div
        className={`rounded-xl border px-4 py-3 mb-6 text-sm ${allOk ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}
        data-testid="readiness"
        data-ready={allOk ? "true" : "false"}
      >
        <p className={`font-semibold mb-2 ${allOk ? "text-green-800" : "text-red-800"}`}>
          記事生成に必要な設定{allOk ? "：すべて揃っています" : "：不足があります"}
        </p>
        <ul className="grid gap-1 sm:grid-cols-3">
          {checks.map((c) => (
            <li key={c.key} className={c.ok ? "text-green-700" : "text-red-700"}>
              {c.ok ? "✓" : "✗"} {c.label}
              {!c.ok && <span className="block text-xs text-red-600/80">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>

      {formError && (
        <Notice tone="error" onClose={() => setFormError(null)}>
          {formError}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      {warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      <Section title="1. 基本" actions={sectionActions("basic")}>
        <BasicFields values={values} errors={errors} onChange={update} mode="edit" />
      </Section>
      <Section title="2. 計測" description="GA4 / GSC の設定" actions={sectionActions("measurement")}>
        <MeasurementFields values={values} errors={errors} onChange={update} mode="edit" />
      </Section>
      <Section title="3. 運用" description="記事制作シートと WordPress 認証情報" actions={sectionActions("operation")}>
        <OperationFields values={values} errors={errors} onChange={update} mode="edit" />
      </Section>

      {client.enabled && (
        <Section title="無効化" description="物理削除はしません。クライアント選択から外れ、記事生成の投稿先に選べなくなります。基本セクションの「有効」から戻せます。">
          <Button variant="danger" onClick={() => setConfirmOpen(true)} data-testid="disable-button">
            このクライアントを無効化
          </Button>
        </Section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="クライアントを無効化しますか？"
        confirmLabel="無効化する"
        busy={busySection === "disable"}
        onConfirm={disable}
        onCancel={() => setConfirmOpen(false)}
      >
        <p className="mb-2">
          <span className="font-mono">{client.id}</span>（{client.label}）
        </p>
        <p className="font-mono text-xs text-gray-500">{client.cms.baseUrl}</p>
        <p className="mt-3">データは残り、いつでも再有効化できます。</p>
      </ConfirmDialog>
    </div>
  );
};

export default ClientEditor;
