-- クライアント設定テーブル（CLIENT_STORE=supabase のとき使用）
--
-- 社数が少ないうちは clients.json で足りる。
-- 運用担当が画面から追加したくなった時点でこちらへ移行する。
--
-- 重要: 認証情報そのものはここに保存しない。
-- cms.credentials には「読むべき環境変数の名前」だけを入れ、
-- 実際の値は Cloud Run のシークレット参照で注入する。

create table if not exists public.clients (
  id                       text primary key,
  label                    text not null,
  enabled                  boolean not null default true,

  -- { companyName, serviceName, noteUrl, mediaUrl, siteUrl }
  brand                    jsonb not null default '{}'::jsonb,

  -- { type, baseUrl, defaultPostStatus, collection?, fieldMap?,
  --   credentials: { usernameEnv?, passwordEnv?, apiKeyEnv? } }
  cms                      jsonb not null default '{}'::jsonb,

  spreadsheet_id           text default '',
  company_data_folder_id   text default '',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on column public.clients.cms is
  '認証情報は環境変数名のみ。値そのものは絶対に入れないこと。';

-- CMS種別は明示的に許可したものだけ
alter table public.clients
  add constraint clients_cms_type_check
  check (cms->>'type' in ('wordpress', 'payload'));

-- 投稿先URLは必須
alter table public.clients
  add constraint clients_cms_baseurl_check
  check (coalesce(cms->>'baseUrl', '') <> '');

create index if not exists clients_enabled_idx
  on public.clients (enabled) where enabled;

-- 更新時刻の自動更新
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

-- RLS: サーバーからは service role キーで読むため、
-- anon キーには一切公開しない。
alter table public.clients enable row level security;

-- 動作確認用サンプル
-- insert into public.clients (id, label, brand, cms, spreadsheet_id) values (
--   'lish-corp',
--   'LISH コーポレートサイト',
--   '{"companyName":"LISH株式会社","serviceName":"SEO＋AIO対策","noteUrl":"","mediaUrl":"","siteUrl":"lishinc.com"}',
--   '{"type":"wordpress","baseUrl":"https://lishinc.com","defaultPostStatus":"draft",
--     "credentials":{"usernameEnv":"WP_USER_LISH_CORP","passwordEnv":"WP_PASS_LISH_CORP"}}',
--   ''
-- );
