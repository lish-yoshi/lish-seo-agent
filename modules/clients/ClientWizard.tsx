/**
 * 新規登録ウィザード（3ステップ）
 * ステップ1だけで登録が完了する。2・3は「あとで」で飛ばせ、編集画面からいつでも埋められる。
 */

import React, { useCallback, useState } from "react";
import { ApiError, createAdminClient, updateAdminClient, type AdminClient } from "./api";
import {
  BasicFields,
  MeasurementFields,
  OperationFields,
  emptyValues,
  formKeyOfApiField,
  sectionOfField,
  toCreateInput,
  toPatch,
  valuesFromClient,
  type FormErrors,
  type FormValues,
  type SectionKey,
} from "./fields";
import { suggestBaseUrl, suggestId } from "./suggestId";
import { Button, Notice, Section } from "./ui";

const STEPS: { key: SectionKey; no: number; title: string; description: string }[] = [
  { key: "basic", no: 1, title: "基本", description: "この項目だけで登録が完了します" },
  { key: "measurement", no: 2, title: "計測", description: "GA4 / GSC の設定。あとから入力できます" },
  { key: "operation", no: 3, title: "運用", description: "記事制作シートと WordPress 認証情報。記事生成にはこの2つが必要です" },
];

interface Props {
  onDone: (id: string | null) => void;
  onAuthError: (message: string) => void;
  onSaved: () => void;
}

const ClientWizard: React.FC<Props> = ({ onDone, onAuthError, onSaved }) => {
  const [step, setStep] = useState<SectionKey>("basic");
  const [values, setValues] = useState<FormValues>(emptyValues());
  const [saved, setSaved] = useState<FormValues>(emptyValues());
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [idTouched, setIdTouched] = useState(false);
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);

  const update = useCallback(
    (patch: Partial<FormValues>) => {
      setValues((prev) => {
        const next = { ...prev, ...patch };
        // siteUrl から id と cms.baseUrl を提案。ユーザーが触った欄は上書きしない
        if (patch.siteUrl !== undefined && createdId === null) {
          if (!idTouched) next.id = suggestId(patch.siteUrl);
          if (!baseUrlTouched) next.cmsBaseUrl = suggestBaseUrl(patch.siteUrl);
        }
        if (patch.cmsBaseUrl !== undefined && patch.siteUrl === undefined) setBaseUrlTouched(true);
        return next;
      });
      // 触った項目のエラーは消す
      setErrors((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(patch) as (keyof FormValues)[]) delete next[k];
        return next;
      });
    },
    [createdId, idTouched, baseUrlTouched]
  );

  const handleApiError = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.isAuth) {
        onAuthError(err.message);
        return;
      }
      const key = formKeyOfApiField(err.field);
      if (key) {
        setErrors((prev) => ({ ...prev, [key]: err.message }));
        setStep(sectionOfField(key));
        return;
      }
      setFormError(err.message);
      return;
    }
    setFormError((err as Error).message);
  };

  const create = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await createAdminClient(toCreateInput(values));
      applyCreated(res.client, res.warnings);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const applyCreated = (client: AdminClient, warn: string[]) => {
    const v = valuesFromClient(client);
    setValues(v);
    setSaved(v);
    setCreatedId(client.id);
    setWarnings(warn);
    setErrors({});
    onSaved();
    setStep("measurement");
  };

  const saveStep = async (section: SectionKey, nextStep: SectionKey | null) => {
    if (!createdId) return;
    const patch = toPatch(values, saved, section);
    if (Object.keys(patch).length === 0) {
      if (nextStep) setStep(nextStep);
      else onDone(createdId);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await updateAdminClient(createdId, patch);
      const v = valuesFromClient(res.client);
      setValues(v);
      setSaved(v);
      setWarnings(res.warnings);
      onSaved();
      if (nextStep) setStep(nextStep);
      else onDone(createdId);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const current = STEPS.find((s) => s.key === step)!;

  return (
    <div>
      <ol className="flex flex-wrap gap-2 mb-6 text-sm">
        {STEPS.map((s) => {
          const active = s.key === step;
          const done = createdId !== null && s.no === 1;
          return (
            <li
              key={s.key}
              className={`rounded-full px-3 py-1 border ${active ? "border-blue-500 bg-blue-50 text-blue-700" : done ? "border-green-300 bg-green-50 text-green-700" : "border-gray-200 text-gray-500"}`}
            >
              {s.no}. {s.title}
              {done && " ✓"}
            </li>
          );
        })}
      </ol>

      {formError && (
        <Notice tone="error" onClose={() => setFormError(null)}>
          {formError}
        </Notice>
      )}
      {warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}
      {createdId && step !== "basic" && (
        <Notice tone="success">
          <span className="font-mono">{createdId}</span> を登録しました。続けて設定するか、「あとで」で一覧に戻れます。
        </Notice>
      )}

      <Section title={`ステップ ${current.no}: ${current.title}`} description={current.description}>
        {step === "basic" && (
          <BasicFields values={values} errors={errors} onChange={update} mode="create" onIdTouched={() => setIdTouched(true)} />
        )}
        {step === "measurement" && <MeasurementFields values={values} errors={errors} onChange={update} mode="create" />}
        {step === "operation" && <OperationFields values={values} errors={errors} onChange={update} mode="create" />}

        <div className="flex flex-wrap justify-between gap-2 mt-6 pt-4 border-t border-gray-100">
          <Button variant="ghost" onClick={() => onDone(createdId)} disabled={busy}>
            {createdId ? "あとで（一覧に戻る）" : "キャンセル"}
          </Button>
          <div className="flex gap-2">
            {step === "basic" && (
              <Button onClick={create} busy={busy} data-testid="wizard-create">
                登録
              </Button>
            )}
            {step === "measurement" && (
              <>
                <Button variant="secondary" onClick={() => setStep("operation")} disabled={busy}>
                  スキップ
                </Button>
                <Button onClick={() => saveStep("measurement", "operation")} busy={busy}>
                  保存して次へ
                </Button>
              </>
            )}
            {step === "operation" && (
              <Button onClick={() => saveStep("operation", null)} busy={busy}>
                保存して完了
              </Button>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
};

export default ClientWizard;
