-- T-06: import_jobs（取り込みジョブ）
-- 目的: CMS / GSC / CSV / GA4 取り込みの非同期ジョブの状態と進捗を記録する（マスター仕様書 §6.8）。
--       server/lib/jobs.js が読み書きする。heartbeat_at が一定時間更新されない running は「応答なし」とみなす。
-- 適用: Supabase SQL Editor で手動実行。create table は二重適用に気づけるよう if not exists を付けない。

create table public.import_jobs (
  id            uuid primary key default gen_random_uuid(),
  client_id     text references public.clients(id) on delete restrict,  -- 全クライアント横断のジョブは NULL
  type          text not null check (type in ('cms', 'gsc', 'csv', 'full', 'ga4')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  progress      jsonb not null default '{}'::jsonb,
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,          -- 固定文言＋エラー種別のみ。例外メッセージをそのまま入れない
  created_by    text,
  created_at    timestamptz not null default now(),
  heartbeat_at  timestamptz    -- 進捗更新のたびに now。running のまま止まったジョブの検出に使う
);

comment on table public.import_jobs is
  '取り込みジョブの状態と進捗。履歴として残す。';
comment on column public.import_jobs.error is
  '固定文言＋エラー種別のみ。詳細はマスクしたうえで progress.errorDetail に入れる。';

create index import_jobs_client_created_idx
  on public.import_jobs (client_id, created_at desc);

create index import_jobs_status_idx
  on public.import_jobs (status);

-- service role のみがアクセスする。ポリシーは作らない
alter table public.import_jobs enable row level security;
