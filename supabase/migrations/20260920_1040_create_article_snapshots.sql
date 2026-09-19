-- T-06: article_snapshots（記事スナップショット）
-- 目的: リライト前の本文・タイトル・実績を保存し、効果測定とロールバックに使う（マスター仕様書 §6.4 / 計測仕様 4.2）。
-- 前提: 20260920_1020_create_articles.sql 適用済み
-- 適用: Supabase SQL Editor で手動実行。create table は二重適用に気づけるよう if not exists を付けない。

create table public.article_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  -- スナップショットは記事より長生きさせる。記事行を消すとロールバック元が失われるため restrict
  article_id           uuid not null references public.articles(id) on delete restrict,
  snapshot_type        text not null check (snapshot_type in ('before_rewrite', 'periodic')),
  title                text,
  content              text,
  meta_description     text,
  gsc_clicks_30d       int,
  gsc_impressions_30d  int,
  gsc_avg_position     numeric,
  rewrite_type         text,
  created_at           timestamptz not null default now()
);

comment on table public.article_snapshots is
  'リライト前・定期のスナップショット。上書きせず履歴として蓄積する。';

create index article_snapshots_article_created_idx
  on public.article_snapshots (article_id, created_at desc);

-- service role のみがアクセスする。ポリシーは作らない
alter table public.article_snapshots enable row level security;
