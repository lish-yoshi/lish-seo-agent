-- T-06: articles（記事マスタ）
-- 目的: CMS から取り込んだ既存記事と、その診断結果を保持する（マスター仕様書 §6.2）。
--       キーワード設計・計測の両モジュールが参照する。記事生成ツール側はこのテーブルを使わない。
-- 前提: 20260919_2350_enable_pgvector.sql 適用済み（vector 型は extensions スキーマ）
-- 適用: Supabase SQL Editor で手動実行。create table は二重適用に気づけるよう if not exists を付けない。

create table public.articles (
  id                         uuid primary key default gen_random_uuid(),
  client_id                  text not null references public.clients(id) on delete restrict,
  cms_post_id                text,
  url                        text not null,
  title                      text,
  headings                   jsonb,          -- H2 / H3 の配列
  published_at               timestamptz,    -- CMS 側の公開日時
  updated_at                 timestamptz,    -- CMS 側の更新日時（このテーブルの行の更新時刻ではない）
  source                     text check (source in ('imported_cms', 'manual', 'tool_generated')),

  target_keyword             text,
  target_keyword_confidence  text check (target_keyword_confidence in ('high', 'medium', 'low')),
  target_keyword_source      text check (target_keyword_source in ('csv', 'gsc_clicks', 'gsc_impressions', 'llm', 'manual')),

  embedding                  extensions.vector(768),  -- タイトル＋H2 から生成。本文全体は使わない
  embedding_model            text,                    -- 生成に使ったモデル名。モデル変更時の再生成判定に使う

  gsc_clicks_3m              int,
  gsc_impressions_3m         int,
  gsc_avg_position           numeric,
  gsc_ctr_3m                 numeric,

  diagnosis_type             text check (diagnosis_type in ('A', 'B', 'C', 'D', 'none')),
  rewrite_score              numeric,
  status                     text not null default '未対応'
                               check (status in ('未対応', '対応中', '対応済', '対応不要', '保留')),

  cluster_id                 uuid,           -- v2 用。v1 では NULL 固定

  created_at                 timestamptz not null default now(),
  synced_at                  timestamptz,    -- CMS から最後に同期した時刻

  constraint articles_client_url_unique unique (client_id, url)
);

comment on table public.articles is
  '記事マスタ。CMS 取り込み結果と診断結果を保持する。';
comment on column public.articles.updated_at is
  'CMS 側の更新日時。行の更新時刻ではないためトリガーで自動更新しない。';
comment on column public.articles.cluster_id is
  'v2（クラスタリング）用。v1 では NULL 固定。';

create index articles_client_rewrite_score_idx
  on public.articles (client_id, rewrite_score desc nulls last);

create index articles_client_cms_post_idx
  on public.articles (client_id, cms_post_id);

-- ベクトル検索用。仕様書は ivfflat だが、空テーブルで作成しても再構築が不要な HNSW を採用。
-- （ivfflat はデータ投入後にリスト数を決めて作り直す必要がある。v1 の規模では HNSW の構築コストは問題にならない）
create index articles_embedding_hnsw_idx
  on public.articles using hnsw (embedding extensions.vector_cosine_ops);

-- service role のみがアクセスする。ポリシーは作らない
alter table public.articles enable row level security;
