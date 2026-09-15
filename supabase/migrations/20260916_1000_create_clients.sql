-- ============================================================
-- clients テーブル（T-01: clients.json → Supabase 移行）
--
-- 出典: db/clients.sql（Phase 1 の参考定義）を基に以下を追加
--   - is_test            テストサイトフラグ（既定 false）
--   - site_url           cms.baseUrl の正規化値。NULL を除いて UNIQUE
--   - cockpit_client_id  将来の COCKPIT 参照用（NULL 可）
--   - updated_at 自動更新トリガー
--
-- brand / cms の jsonb 構造は clients.prod.json と同一。
-- server/clients/store.js の loadFromSupabase() は
--   id, label, enabled, brand, cms, spreadsheet_id, company_data_folder_id
-- をそのまま normalize() に渡すため、列名はこの通りにすること。
--
-- 重要: cms.credentials には「読むべき環境変数の名前」だけを入れる。
--       実際の値は Cloud Run のシークレット参照で注入する。
--
-- 適用方法: Supabase SQL Editor で実行（CLI リンクはしない）
-- 再実行しても安全なように if not exists / drop if exists で書いている。
-- ============================================================

create table if not exists public.clients (
  id                       text primary key,
  label                    text not null,
  enabled                  boolean not null default true,

  -- { companyName, serviceName, noteUrl, mediaUrl, siteUrl }
  brand                    jsonb not null default '{}'::jsonb,

  -- { type, baseUrl, defaultPostStatus, collection?, mediaCollection?,
  --   authCollection?, fieldMap?, credentials: { usernameEnv?, passwordEnv?, apiKeyEnv? } }
  cms                      jsonb not null default '{}'::jsonb,

  spreadsheet_id           text default '',
  company_data_folder_id   text default '',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- db/clients.sql を先に適用していた場合に備えて列は個別に追加する
alter table public.clients
  add column if not exists is_test boolean not null default false;

alter table public.clients
  add column if not exists site_url text;

alter table public.clients
  add column if not exists cockpit_client_id text;

comment on table  public.clients is
  'クライアントマスタ。記事生成・キーワード設計の両モジュールが参照する単一の正典。';
comment on column public.clients.cms is
  '認証情報は環境変数名のみ。値そのものは絶対に入れないこと。';
comment on column public.clients.is_test is
  'テストサイト。true の場合は月次バッチ・レポート集計・重複チェックの対象外。';
comment on column public.clients.site_url is
  'cms.baseUrl の正規化値（プロトコル・www・末尾スラッシュを除去、小文字）。NULL を除いて一意。';
comment on column public.clients.cockpit_client_id is
  '将来の COCKPIT 側クライアントIDとの対応付け用。現時点では未使用。';

-- ------------------------------------------------------------
-- 制約
-- ------------------------------------------------------------

-- CMS種別は明示的に許可したものだけ
alter table public.clients drop constraint if exists clients_cms_type_check;
alter table public.clients
  add constraint clients_cms_type_check
  check (cms->>'type' in ('wordpress', 'payload'));

-- 投稿先URLは必須
alter table public.clients drop constraint if exists clients_cms_baseurl_check;
alter table public.clients
  add constraint clients_cms_baseurl_check
  check (coalesce(cms->>'baseUrl', '') <> '');

-- site_url は NULL を除いて一意（同一サイトの二重登録防止）
create unique index if not exists clients_site_url_unique_idx
  on public.clients (site_url)
  where site_url is not null;

create index if not exists clients_enabled_idx
  on public.clients (enabled) where enabled;

-- ------------------------------------------------------------
-- site_url の正規化関数
--   'https://www.Example.com/'  → 'example.com'
--   'http://seo-test.local'     → 'seo-test.local'
--   ''（空文字）/ NULL           → NULL
-- ------------------------------------------------------------
create or replace function public.normalize_site_url(raw text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(trim(raw)), '^[a-z]+://', ''),  -- プロトコル除去
        '^www\.', ''                                          -- www. 除去
      ),
      '/+$', ''                                               -- 末尾スラッシュ除去
    ),
    ''
  );
$$;

-- ------------------------------------------------------------
-- トリガー
--   1) updated_at の自動更新
--   2) site_url を保存前に必ず正規化（NULL のままなら触らない。
--      自動補完はしない。example.com 等のプレースホルダが衝突するため、
--      site_url を入れるかどうかは登録側（T-01b）が明示的に決める）
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();

create or replace function public.clients_normalize_site_url()
returns trigger language plpgsql as $$
begin
  if new.site_url is not null then
    new.site_url = public.normalize_site_url(new.site_url);
  end if;
  return new;
end $$;

drop trigger if exists clients_normalize_site_url on public.clients;
create trigger clients_normalize_site_url
  before insert or update of site_url on public.clients
  for each row execute function public.clients_normalize_site_url();

-- ------------------------------------------------------------
-- RLS: サーバーからは service role キーで読むため、anon には一切公開しない。
-- ポリシーを作らないことで anon / authenticated からのアクセスは全て拒否される。
-- ------------------------------------------------------------
alter table public.clients enable row level security;
