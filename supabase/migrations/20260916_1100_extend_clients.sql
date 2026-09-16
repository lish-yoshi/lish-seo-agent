-- ============================================================
-- clients テーブル拡張（T-02: マスター仕様書 §6.1）
--
-- 前提: 20260916_1000_create_clients.sql / 20260916_1010_seed_clients_from_json.sql 適用済み
-- 方針: すべて NULL 許容で追加し、既存 7 件を壊さない（auto_approve_threshold のみ default 0）
--       spreadsheet_id は既存列を流用し、sheet_gid のみ追加する
-- 適用方法: Supabase SQL Editor で実行。再実行しても安全なように冪等に書く
-- ============================================================

-- ---- 運用（KW 仕様） ----
alter table public.clients add column if not exists business_type          text;
alter table public.clients add column if not exists target_areas           text[];
alter table public.clients add column if not exists ng_keywords            text[];
alter table public.clients add column if not exists non_target_services    text[];
alter table public.clients add column if not exists client_sensitivities   text;

-- ---- 計測 ----
alter table public.clients add column if not exists brand_terms                 text[];
alter table public.clients add column if not exists article_url_patterns        text[];
alter table public.clients add column if not exists ga4_property_id             text;
alter table public.clients add column if not exists gsc_property_url            text;
alter table public.clients add column if not exists gsc_property_type           text;
alter table public.clients add column if not exists ga4_retention_before_change text;
alter table public.clients add column if not exists ga4_retention_changed_at    date;
alter table public.clients add column if not exists gsc_bq_export_enabled_at    date;
alter table public.clients add column if not exists billing_cycle_start_day     int;

-- ---- 接続（記事制作シート） ----
-- spreadsheet_id は既存列（text default ''）をそのまま使う
alter table public.clients add column if not exists sheet_gid text;

-- ---- SEO リスク対策（第 8 章） ----
alter table public.clients add column if not exists max_publish_per_month int;
alter table public.clients add column if not exists ng_expressions        jsonb;

-- ---- KW v2 ----
alter table public.clients add column if not exists auto_approve_threshold numeric default 0;
-- 既に列があって default が無い場合にも既定値を揃える
alter table public.clients alter column auto_approve_threshold set default 0;

-- ---- コメント ----
comment on column public.clients.business_type               is 'local_store 等。スコアリング補正に使う';
comment on column public.clients.target_areas                is '対象エリア';
comment on column public.clients.ng_keywords                 is '使わない語';
comment on column public.clients.non_target_services         is '提供終了・対象外サービス';
comment on column public.clients.client_sensitivities        is '自由記述。診断 UI に常時表示';
comment on column public.clients.brand_terms                 is '指名検索の判定用';
comment on column public.clients.article_url_patterns        is '記事ページの判別パターン';
comment on column public.clients.ga4_property_id             is 'GA4 プロパティ ID。NULL 除外で一意';
comment on column public.clients.gsc_property_url            is 'GSC プロパティ URL。NULL 除外で一意';
comment on column public.clients.gsc_property_type           is 'domain / url_prefix';
comment on column public.clients.ga4_retention_before_change is '2months / 14months / unknown。レポートの自動注記に使う';
comment on column public.clients.ga4_retention_changed_at    is 'GA4 保持期間を変更した日';
comment on column public.clients.gsc_bq_export_enabled_at    is 'GSC → BigQuery エクスポート開始日。API で取得できないため手動入力';
comment on column public.clients.billing_cycle_start_day     is '請求月プリセットの開始日';
comment on column public.clients.sheet_gid                   is '記事制作シートの対象タブ gid。現行コードはタブ名「シート1」固定で未使用';
comment on column public.clients.max_publish_per_month       is '公開ペース上限（本/月）';
comment on column public.clients.ng_expressions              is '薬機法・景表法の NG 表現辞書';
comment on column public.clients.auto_approve_threshold      is '自動承認の閾値。初期値 0（v2）';

-- ---- CHECK 制約（NULL は通す） ----
alter table public.clients drop constraint if exists clients_gsc_property_type_check;
alter table public.clients add constraint clients_gsc_property_type_check
  check (gsc_property_type is null or gsc_property_type in ('domain', 'url_prefix'));

alter table public.clients drop constraint if exists clients_ga4_retention_before_change_check;
alter table public.clients add constraint clients_ga4_retention_before_change_check
  check (ga4_retention_before_change is null
         or ga4_retention_before_change in ('2months', '14months', 'unknown'));

-- ---- 重複登録防止（NULL 除外の部分 UNIQUE） ----
create unique index if not exists clients_ga4_property_id_unique_idx
  on public.clients (ga4_property_id)
  where ga4_property_id is not null;

create unique index if not exists clients_gsc_property_url_unique_idx
  on public.clients (gsc_property_url)
  where gsc_property_url is not null;

-- v1 はタブ名固定のため spreadsheet_id 単体でもシートが一意に決まる
create unique index if not exists clients_spreadsheet_id_unique_idx
  on public.clients (spreadsheet_id)
  where spreadsheet_id is not null and spreadsheet_id <> '';

-- spreadsheet_id は既定が '' のため、NULL だけでなく空文字も除外する
create unique index if not exists clients_spreadsheet_sheet_unique_idx
  on public.clients (spreadsheet_id, sheet_gid)
  where spreadsheet_id is not null and spreadsheet_id <> ''
    and sheet_gid is not null;
