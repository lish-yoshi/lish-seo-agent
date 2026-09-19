-- T-06: article_queries（記事 × 検索クエリの月次実績）
-- 目的: GSC の page × query データを月単位で保持する（マスター仕様書 §6.3 / KW 仕様 3.2）。
--       ターゲット KW 推定・診断・レポートが参照する。
-- 前提: 20260920_1020_create_articles.sql 適用済み
-- 適用: Supabase SQL Editor で手動実行。create table は二重適用に気づけるよう if not exists を付けない。

create table public.article_queries (
  id              uuid primary key default gen_random_uuid(),
  article_id      uuid not null references public.articles(id) on delete cascade,
  client_id       text not null references public.clients(id) on delete restrict,
  query           text not null,
  clicks          int,
  impressions     int,
  position        numeric,
  ctr             numeric,
  is_brand        boolean not null default false,  -- clients.brand_terms との部分一致で付与
  snapshot_month  date not null,                   -- 月初日（例: 2026-09-01）

  constraint article_queries_unique unique (article_id, query, snapshot_month)
);

comment on table public.article_queries is
  'GSC の記事 × クエリ実績（月次）。指名検索は is_brand で分離する。';

create index article_queries_client_month_idx
  on public.article_queries (client_id, snapshot_month);

create index article_queries_article_clicks_idx
  on public.article_queries (article_id, clicks desc);

-- service role のみがアクセスする。ポリシーは作らない
alter table public.article_queries enable row level security;
