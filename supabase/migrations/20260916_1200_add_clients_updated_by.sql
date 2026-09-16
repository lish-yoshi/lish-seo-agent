-- ============================================================
-- clients.updated_by（T-01b-1: 管理 API で書き込んだ IAP ユーザーを記録）
--
-- 前提: 20260916_1100_extend_clients.sql 適用済み
-- 既存 7 件は NULL のまま。updated_at は既存トリガーが自動更新する
-- 適用方法: Supabase SQL Editor で実行。再実行しても安全（冪等）
-- ============================================================

alter table public.clients add column if not exists updated_by text;

comment on column public.clients.updated_by is
  '最終更新者。IAP の X-Goog-Authenticated-User-Email からプレフィックスを除いたメール。ローカル開発は local-dev';
