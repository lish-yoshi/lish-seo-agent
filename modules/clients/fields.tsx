/**
 * クライアント登録・編集フォームの項目定義（T-01b-2）
 * ウィザード（新規）と編集画面で同じセクションを使う。
 */

import React from "react";
import type { AdminClient, AdminClientInput } from "./api";
import { CREDENTIAL_MASK } from "./api";
import { Field, TextInput, TextArea, Select, Toggle, TagsInput } from "./ui";

/** 画面上のフォーム値。API の入れ子（cms.*）は平らにして扱う */
export interface FormValues {
  id: string;
  label: string;
  siteUrl: string;
  cmsType: "wordpress" | "payload";
  cmsBaseUrl: string;
  cmsDefaultPostStatus: string;
  isTest: boolean;
  enabled: boolean;
  // 計測
  ga4PropertyId: string;
  gscPropertyUrl: string;
  gscPropertyType: string;
  ga4RetentionBeforeChange: string;
  ga4RetentionChangedAt: string;
  gscBqExportEnabledAt: string;
  brandTerms: string[];
  articleUrlPatterns: string[];
  // 運用
  spreadsheetId: string;
  sheetGid: string;
  companyDataFolderId: string;
  businessType: string;
  targetAreas: string[];
  ngKeywords: string[];
  nonTargetServices: string[];
  clientSensitivities: string;
  maxPublishPerMonth: string;
  billingCycleStartDay: string;
  username: string;
  password: string;
}

export type FormErrors = Partial<Record<keyof FormValues, string>>;

export type SectionKey = "basic" | "measurement" | "operation";

export const SECTION_FIELDS: Record<SectionKey, (keyof FormValues)[]> = {
  basic: ["id", "label", "siteUrl", "cmsType", "cmsBaseUrl", "cmsDefaultPostStatus", "isTest", "enabled"],
  measurement: [
    "ga4PropertyId",
    "gscPropertyUrl",
    "gscPropertyType",
    "ga4RetentionBeforeChange",
    "ga4RetentionChangedAt",
    "gscBqExportEnabledAt",
    "brandTerms",
    "articleUrlPatterns",
  ],
  operation: [
    "spreadsheetId",
    "sheetGid",
    "companyDataFolderId",
    "businessType",
    "targetAreas",
    "ngKeywords",
    "nonTargetServices",
    "clientSensitivities",
    "maxPublishPerMonth",
    "billingCycleStartDay",
    "username",
    "password",
  ],
};

export function emptyValues(): FormValues {
  return {
    id: "",
    label: "",
    siteUrl: "",
    cmsType: "wordpress",
    cmsBaseUrl: "",
    cmsDefaultPostStatus: "draft",
    isTest: false,
    enabled: true,
    ga4PropertyId: "",
    gscPropertyUrl: "",
    gscPropertyType: "",
    ga4RetentionBeforeChange: "",
    ga4RetentionChangedAt: "",
    gscBqExportEnabledAt: "",
    brandTerms: [],
    articleUrlPatterns: [],
    spreadsheetId: "",
    sheetGid: "",
    companyDataFolderId: "",
    businessType: "",
    targetAreas: [],
    ngKeywords: [],
    nonTargetServices: [],
    clientSensitivities: "",
    maxPublishPerMonth: "",
    billingCycleStartDay: "",
    username: "",
    password: "",
  };
}

export function valuesFromClient(c: AdminClient): FormValues {
  return {
    id: c.id,
    label: c.label,
    siteUrl: c.siteUrl ?? "",
    cmsType: c.cms.type,
    cmsBaseUrl: c.cms.baseUrl,
    cmsDefaultPostStatus: c.cms.defaultPostStatus || "draft",
    isTest: c.isTest,
    enabled: c.enabled,
    ga4PropertyId: c.ga4PropertyId ?? "",
    gscPropertyUrl: c.gscPropertyUrl ?? "",
    gscPropertyType: c.gscPropertyType ?? "",
    ga4RetentionBeforeChange: c.ga4RetentionBeforeChange ?? "",
    ga4RetentionChangedAt: c.ga4RetentionChangedAt ?? "",
    gscBqExportEnabledAt: c.gscBqExportEnabledAt ?? "",
    brandTerms: c.brandTerms ?? [],
    articleUrlPatterns: c.articleUrlPatterns ?? [],
    spreadsheetId: c.spreadsheetId ?? "",
    sheetGid: c.sheetGid ?? "",
    companyDataFolderId: c.companyDataFolderId ?? "",
    businessType: c.businessType ?? "",
    targetAreas: c.targetAreas ?? [],
    ngKeywords: c.ngKeywords ?? [],
    nonTargetServices: c.nonTargetServices ?? [],
    clientSensitivities: c.clientSensitivities ?? "",
    maxPublishPerMonth: c.maxPublishPerMonth == null ? "" : String(c.maxPublishPerMonth),
    billingCycleStartDay: c.billingCycleStartDay == null ? "" : String(c.billingCycleStartDay),
    username: c.cms.credentials.username ?? "",
    // 設定済みならマスク文字列が入る。空欄のまま保存すれば送らない（既存維持）
    password: c.cms.credentials.password ?? "",
  };
}

const nullIfEmpty = (s: string): string | null => (s.trim() === "" ? null : s.trim());
const intOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

/** 新規登録（ステップ1）の POST 本文 */
export function toCreateInput(v: FormValues): AdminClientInput {
  return {
    id: v.id.trim(),
    label: v.label.trim(),
    siteUrl: v.siteUrl.trim(),
    isTest: v.isTest,
    cms: {
      type: v.cmsType,
      baseUrl: v.cmsBaseUrl.trim(),
      defaultPostStatus: v.cmsDefaultPostStatus || "draft",
    },
  };
}

/**
 * セクション単位の PATCH 本文。original と比べて変わった項目だけ送る。
 * password はマスク文字列・空欄なら送らない（サーバーが既存値を維持する）。
 */
export function toPatch(v: FormValues, original: FormValues, section: SectionKey): AdminClientInput {
  const patch: AdminClientInput = {};
  const changed = (k: keyof FormValues) => JSON.stringify(v[k]) !== JSON.stringify(original[k]);

  if (section === "basic") {
    if (changed("label")) patch.label = v.label.trim();
    if (changed("siteUrl")) patch.siteUrl = nullIfEmpty(v.siteUrl);
    if (changed("isTest")) patch.isTest = v.isTest;
    if (changed("enabled")) patch.enabled = v.enabled;
    const cms: NonNullable<AdminClientInput["cms"]> = {};
    if (changed("cmsType")) cms.type = v.cmsType;
    if (changed("cmsBaseUrl")) cms.baseUrl = v.cmsBaseUrl.trim();
    if (changed("cmsDefaultPostStatus")) cms.defaultPostStatus = v.cmsDefaultPostStatus || "draft";
    if (Object.keys(cms).length) patch.cms = cms;
  }

  if (section === "measurement") {
    if (changed("ga4PropertyId")) patch.ga4PropertyId = nullIfEmpty(v.ga4PropertyId);
    if (changed("gscPropertyUrl")) patch.gscPropertyUrl = nullIfEmpty(v.gscPropertyUrl);
    if (changed("gscPropertyType")) patch.gscPropertyType = nullIfEmpty(v.gscPropertyType);
    if (changed("ga4RetentionBeforeChange")) patch.ga4RetentionBeforeChange = nullIfEmpty(v.ga4RetentionBeforeChange);
    if (changed("ga4RetentionChangedAt")) patch.ga4RetentionChangedAt = nullIfEmpty(v.ga4RetentionChangedAt);
    if (changed("gscBqExportEnabledAt")) patch.gscBqExportEnabledAt = nullIfEmpty(v.gscBqExportEnabledAt);
    if (changed("brandTerms")) patch.brandTerms = v.brandTerms;
    if (changed("articleUrlPatterns")) patch.articleUrlPatterns = v.articleUrlPatterns;
  }

  if (section === "operation") {
    if (changed("spreadsheetId")) patch.spreadsheetId = v.spreadsheetId.trim();
    if (changed("sheetGid")) patch.sheetGid = nullIfEmpty(v.sheetGid);
    if (changed("companyDataFolderId")) patch.companyDataFolderId = v.companyDataFolderId.trim();
    if (changed("businessType")) patch.businessType = nullIfEmpty(v.businessType);
    if (changed("targetAreas")) patch.targetAreas = v.targetAreas;
    if (changed("ngKeywords")) patch.ngKeywords = v.ngKeywords;
    if (changed("nonTargetServices")) patch.nonTargetServices = v.nonTargetServices;
    if (changed("clientSensitivities")) patch.clientSensitivities = v.clientSensitivities;
    if (changed("maxPublishPerMonth")) patch.maxPublishPerMonth = intOrNull(v.maxPublishPerMonth);
    if (changed("billingCycleStartDay")) patch.billingCycleStartDay = intOrNull(v.billingCycleStartDay);

    const credentials: Record<string, string> = {};
    if (changed("username")) credentials.username = v.username.trim();
    if (v.password !== "" && v.password !== CREDENTIAL_MASK && changed("password")) {
      credentials.password = v.password;
    }
    if (Object.keys(credentials).length) patch.cms = { credentials };
  }

  return patch;
}

/**
 * API の field（snake_case / "cms.type" / "cms.credentials.password" 等）を
 * フォームのキーに変換する。不明なら null（上部の共通エラーに回す）。
 */
const FIELD_MAP: Record<string, keyof FormValues> = {
  id: "id",
  label: "label",
  site_url: "siteUrl",
  is_test: "isTest",
  enabled: "enabled",
  "cms.type": "cmsType",
  "cms.baseUrl": "cmsBaseUrl",
  "cms.defaultPostStatus": "cmsDefaultPostStatus",
  "cms.credentials.username": "username",
  "cms.credentials.password": "password",
  ga4_property_id: "ga4PropertyId",
  gsc_property_url: "gscPropertyUrl",
  gsc_property_type: "gscPropertyType",
  ga4_retention_before_change: "ga4RetentionBeforeChange",
  ga4_retention_changed_at: "ga4RetentionChangedAt",
  gsc_bq_export_enabled_at: "gscBqExportEnabledAt",
  brand_terms: "brandTerms",
  article_url_patterns: "articleUrlPatterns",
  spreadsheet_id: "spreadsheetId",
  "spreadsheet_id, sheet_gid": "spreadsheetId",
  sheet_gid: "sheetGid",
  company_data_folder_id: "companyDataFolderId",
  business_type: "businessType",
  target_areas: "targetAreas",
  ng_keywords: "ngKeywords",
  non_target_services: "nonTargetServices",
  client_sensitivities: "clientSensitivities",
  max_publish_per_month: "maxPublishPerMonth",
  billing_cycle_start_day: "billingCycleStartDay",
};

export function formKeyOfApiField(field: string | null | undefined): keyof FormValues | null {
  if (!field) return null;
  return FIELD_MAP[field] ?? null;
}

export function sectionOfField(key: keyof FormValues): SectionKey {
  for (const [section, keys] of Object.entries(SECTION_FIELDS) as [SectionKey, (keyof FormValues)[]][]) {
    if (keys.includes(key)) return section;
  }
  return "basic";
}

/** 記事生成に必要な設定の充足チェック（編集画面上部に表示） */
export function readinessChecks(c: AdminClient): { key: string; label: string; ok: boolean; hint: string }[] {
  const creds = c.cms.credentials;
  const hasCreds =
    c.cms.type === "payload"
      ? Boolean(creds.apiKey || creds.apiKeyEnv)
      : Boolean((creds.username || creds.usernameEnv) && (creds.password || creds.passwordEnv));
  return [
    { key: "baseUrl", label: "投稿先 URL（cms.baseUrl）", ok: Boolean(c.cms.baseUrl), hint: "ステップ1で設定" },
    { key: "credentials", label: "CMS 認証情報", ok: hasCreds, hint: "ステップ3の WordPress 認証情報" },
    { key: "spreadsheet", label: "記事制作スプレッドシート ID", ok: Boolean(c.spreadsheetId), hint: "ステップ3で設定" },
  ];
}

// ---------------------------------------------------------------
// セクション描画
// ---------------------------------------------------------------

interface SectionProps {
  values: FormValues;
  errors: FormErrors;
  onChange: (patch: Partial<FormValues>) => void;
  mode: "create" | "edit";
  /** create のとき、id 欄をユーザーが触ったら提案を止めるための通知 */
  onIdTouched?: () => void;
}

export const BasicFields: React.FC<SectionProps> = ({ values, errors, onChange, mode, onIdTouched }) => (
  <>
    <Field label="サイト URL" htmlFor="f-siteUrl" required error={errors.siteUrl} hint="例: https://english-with.com。id と投稿先 URL を自動で提案します">
      <TextInput
        id="f-siteUrl"
        value={values.siteUrl}
        invalid={Boolean(errors.siteUrl)}
        placeholder="https://example.com"
        onChange={(e) => onChange({ siteUrl: e.target.value })}
      />
    </Field>
    <Field label="クライアント ID" htmlFor="f-id" required error={errors.id} hint={mode === "create" ? "小文字英数字とハイフン。登録後は変更できません" : "変更できません"}>
      <TextInput
        id="f-id"
        value={values.id}
        invalid={Boolean(errors.id)}
        disabled={mode === "edit"}
        onChange={(e) => {
          onIdTouched?.();
          onChange({ id: e.target.value });
        }}
      />
    </Field>
    <Field label="表示名" htmlFor="f-label" required error={errors.label}>
      <TextInput
        id="f-label"
        value={values.label}
        invalid={Boolean(errors.label)}
        placeholder="例: English With"
        onChange={(e) => onChange({ label: e.target.value })}
      />
    </Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="CMS 種別" htmlFor="f-cmsType" required error={errors.cmsType}>
        <Select
          id="f-cmsType"
          value={values.cmsType}
          invalid={Boolean(errors.cmsType)}
          options={[
            { value: "wordpress", label: "WordPress" },
            { value: "payload", label: "Payload CMS" },
          ]}
          onChange={(e) => onChange({ cmsType: e.target.value as FormValues["cmsType"] })}
        />
      </Field>
      <Field label="既定の投稿ステータス" htmlFor="f-status" error={errors.cmsDefaultPostStatus}>
        <Select
          id="f-status"
          value={values.cmsDefaultPostStatus}
          options={[
            { value: "draft", label: "下書き（draft）" },
            { value: "pending", label: "レビュー待ち（pending）" },
            { value: "publish", label: "公開（publish）" },
          ]}
          onChange={(e) => onChange({ cmsDefaultPostStatus: e.target.value })}
        />
      </Field>
    </div>
    <Field label="投稿先 URL（cms.baseUrl）" htmlFor="f-cmsBaseUrl" required error={errors.cmsBaseUrl} hint="WordPress のサイト URL。REST API の起点になります">
      <TextInput
        id="f-cmsBaseUrl"
        value={values.cmsBaseUrl}
        invalid={Boolean(errors.cmsBaseUrl)}
        placeholder="https://example.com"
        onChange={(e) => onChange({ cmsBaseUrl: e.target.value })}
      />
    </Field>
    <Toggle
      id="f-isTest"
      checked={values.isTest}
      label="テストサイト"
      description="ON にすると月次バッチ・レポート集計・クライアント間の重複チェックの対象外になります"
      onChange={(v) => onChange({ isTest: v })}
    />
    {mode === "edit" && (
      <Toggle
        id="f-enabled"
        checked={values.enabled}
        label="有効"
        description="OFF にするとクライアント選択に出なくなり、記事生成の投稿先に選べません"
        onChange={(v) => onChange({ enabled: v })}
      />
    )}
  </>
);

export const MeasurementFields: React.FC<SectionProps> = ({ values, errors, onChange }) => (
  <>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="GA4 プロパティ ID" htmlFor="f-ga4" error={errors.ga4PropertyId} hint="例: 123456789">
        <TextInput id="f-ga4" value={values.ga4PropertyId} invalid={Boolean(errors.ga4PropertyId)} onChange={(e) => onChange({ ga4PropertyId: e.target.value })} />
      </Field>
      <Field label="GSC プロパティ URL" htmlFor="f-gsc" error={errors.gscPropertyUrl} hint="例: sc-domain:example.com または https://example.com/">
        <TextInput id="f-gsc" value={values.gscPropertyUrl} invalid={Boolean(errors.gscPropertyUrl)} onChange={(e) => onChange({ gscPropertyUrl: e.target.value })} />
      </Field>
      <Field label="GSC プロパティ種別" htmlFor="f-gscType" error={errors.gscPropertyType}>
        <Select
          id="f-gscType"
          value={values.gscPropertyType}
          invalid={Boolean(errors.gscPropertyType)}
          options={[
            { value: "", label: "未設定" },
            { value: "domain", label: "ドメイン（domain）" },
            { value: "url_prefix", label: "URL プレフィックス（url_prefix）" },
          ]}
          onChange={(e) => onChange({ gscPropertyType: e.target.value })}
        />
      </Field>
      <Field label="GA4 変更前のデータ保持期間" htmlFor="f-ret" error={errors.ga4RetentionBeforeChange} hint="レポートに「◯月以前のデータは存在しません」と注記するために使います">
        <Select
          id="f-ret"
          value={values.ga4RetentionBeforeChange}
          invalid={Boolean(errors.ga4RetentionBeforeChange)}
          options={[
            { value: "", label: "未設定" },
            { value: "2months", label: "2ヶ月" },
            { value: "14months", label: "14ヶ月" },
            { value: "unknown", label: "不明" },
          ]}
          onChange={(e) => onChange({ ga4RetentionBeforeChange: e.target.value })}
        />
      </Field>
      <Field label="GA4 保持期間の変更日" htmlFor="f-retAt" error={errors.ga4RetentionChangedAt}>
        <TextInput id="f-retAt" type="date" value={values.ga4RetentionChangedAt} invalid={Boolean(errors.ga4RetentionChangedAt)} onChange={(e) => onChange({ ga4RetentionChangedAt: e.target.value })} />
      </Field>
      <Field label="GSC → BigQuery エクスポート開始日" htmlFor="f-bq" error={errors.gscBqExportEnabledAt} hint="API で取得できないため手動で入力します">
        <TextInput id="f-bq" type="date" value={values.gscBqExportEnabledAt} invalid={Boolean(errors.gscBqExportEnabledAt)} onChange={(e) => onChange({ gscBqExportEnabledAt: e.target.value })} />
      </Field>
    </div>
    <Field label="ブランド語（指名検索の判定用）" htmlFor="f-brandTerms" error={errors.brandTerms} hint="カンマ区切り。例: English With, イングリッシュウィズ">
      <TagsInput id="f-brandTerms" value={values.brandTerms} invalid={Boolean(errors.brandTerms)} onChange={(v) => onChange({ brandTerms: v })} />
    </Field>
    <Field label="記事ページの URL パターン" htmlFor="f-urlPatterns" error={errors.articleUrlPatterns} hint="カンマ区切り。例: /blog/, /column/">
      <TagsInput id="f-urlPatterns" value={values.articleUrlPatterns} invalid={Boolean(errors.articleUrlPatterns)} onChange={(v) => onChange({ articleUrlPatterns: v })} />
    </Field>
  </>
);

export const OperationFields: React.FC<SectionProps> = ({ values, errors, onChange }) => (
  <>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="記事制作スプレッドシート ID" htmlFor="f-sheet" error={errors.spreadsheetId} hint="URL の /d/ と /edit の間の文字列。記事生成に必須">
        <TextInput id="f-sheet" value={values.spreadsheetId} invalid={Boolean(errors.spreadsheetId)} onChange={(e) => onChange({ spreadsheetId: e.target.value })} />
      </Field>
      <Field label="シート gid" htmlFor="f-gid" error={errors.sheetGid} hint="現在はタブ名「シート1」固定のため未使用。将来用">
        <TextInput id="f-gid" value={values.sheetGid} invalid={Boolean(errors.sheetGid)} onChange={(e) => onChange({ sheetGid: e.target.value })} />
      </Field>
      <Field label="自社データフォルダ ID（Google Drive）" htmlFor="f-folder" error={errors.companyDataFolderId}>
        <TextInput id="f-folder" value={values.companyDataFolderId} invalid={Boolean(errors.companyDataFolderId)} onChange={(e) => onChange({ companyDataFolderId: e.target.value })} />
      </Field>
      <Field label="業種" htmlFor="f-biz" error={errors.businessType} hint="例: local_store">
        <TextInput id="f-biz" value={values.businessType} invalid={Boolean(errors.businessType)} onChange={(e) => onChange({ businessType: e.target.value })} />
      </Field>
      <Field label="公開ペース上限（本/月）" htmlFor="f-maxPub" error={errors.maxPublishPerMonth}>
        <TextInput id="f-maxPub" type="number" min={0} value={values.maxPublishPerMonth} invalid={Boolean(errors.maxPublishPerMonth)} onChange={(e) => onChange({ maxPublishPerMonth: e.target.value })} />
      </Field>
      <Field label="請求月の開始日" htmlFor="f-bill" error={errors.billingCycleStartDay} hint="1〜31">
        <TextInput id="f-bill" type="number" min={1} max={31} value={values.billingCycleStartDay} invalid={Boolean(errors.billingCycleStartDay)} onChange={(e) => onChange({ billingCycleStartDay: e.target.value })} />
      </Field>
    </div>
    <Field label="対象エリア" htmlFor="f-areas" error={errors.targetAreas} hint="カンマ区切り。例: 熊本市, 合志市">
      <TagsInput id="f-areas" value={values.targetAreas} invalid={Boolean(errors.targetAreas)} onChange={(v) => onChange({ targetAreas: v })} />
    </Field>
    <Field label="使わない語（NG キーワード）" htmlFor="f-ng" error={errors.ngKeywords} hint="カンマ区切り">
      <TagsInput id="f-ng" value={values.ngKeywords} invalid={Boolean(errors.ngKeywords)} onChange={(v) => onChange({ ngKeywords: v })} />
    </Field>
    <Field label="提供終了・対象外サービス" htmlFor="f-nts" error={errors.nonTargetServices} hint="カンマ区切り">
      <TagsInput id="f-nts" value={values.nonTargetServices} invalid={Boolean(errors.nonTargetServices)} onChange={(v) => onChange({ nonTargetServices: v })} />
    </Field>
    <Field label="クライアントの注意点（自由記述）" htmlFor="f-sens" error={errors.clientSensitivities} hint="診断画面に常時表示されます">
      <TextArea id="f-sens" rows={3} value={values.clientSensitivities} invalid={Boolean(errors.clientSensitivities)} onChange={(e) => onChange({ clientSensitivities: e.target.value })} />
    </Field>

    <h3 className="text-sm font-semibold text-gray-700 mt-6 mb-2">WordPress 認証情報</h3>
    <p className="text-xs text-gray-500 mb-3">
      アプリケーションパスワードを推奨します。パスワードは保存後に表示されず、空欄のまま保存すると変更されません。
    </p>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="ユーザー名" htmlFor="f-user" error={errors.username}>
        <TextInput id="f-user" autoComplete="off" value={values.username} invalid={Boolean(errors.username)} onChange={(e) => onChange({ username: e.target.value })} />
      </Field>
      <Field label="パスワード" htmlFor="f-pass" error={errors.password} hint={values.password === CREDENTIAL_MASK ? "設定済み。変更する場合のみ入力" : undefined}>
        <TextInput
          id="f-pass"
          type="password"
          autoComplete="new-password"
          value={values.password}
          invalid={Boolean(errors.password)}
          onFocus={(e) => {
            if (e.target.value === CREDENTIAL_MASK) onChange({ password: "" });
          }}
          onChange={(e) => onChange({ password: e.target.value })}
        />
      </Field>
    </div>
  </>
);
