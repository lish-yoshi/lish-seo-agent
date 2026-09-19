-- T-06: settings（システム設定）
-- 目的: 診断・スコアリングの閾値や係数をコードに埋め込まず、ここから読む（マスター仕様書 §6.10）。
-- 適用: Supabase SQL Editor で手動実行。create table は二重適用に気づけるよう if not exists を付けない。

create table public.settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz default now()
);

comment on table public.settings is
  '診断・スコアリングの閾値と係数。コードに埋め込まず、必ずここから読む。';

-- service role のみがアクセスする。ポリシーは作らない（anon / authenticated からは全拒否）
alter table public.settings enable row level security;

insert into public.settings (key, value, description) values
  ('ctr_benchmark',
   '{"1":0.25,"2":0.15,"3":0.10,"4":0.07,"5":0.05,"6_10":0.03}'::jsonb,
   '順位別の CTR 基準値。型B（CTR 低迷）の判定で、実 CTR がこの値の 50% 未満かを見る。キーは順位（6_10 は 6〜10 位）'),
  ('position_weight',
   '{"11_20":1.5,"4_10":1.2,"21_30":0.8,"1_3":0.3,"31_plus":0.2}'::jsonb,
   'リライトスコアの順位帯係数。11〜20 位（あと一歩）を最も重く、1〜3 位は触らない前提で低くする'),
  ('type_weight',
   '{"B":1.4,"A":1.3,"C":1.0,"D":0.9,"none":0.5}'::jsonb,
   'リライトスコアの診断型係数。A=あと一歩 / B=CTR 低迷 / C=狙いズレ / D=カニバリ / none=該当なし'),
  ('cannibal_embedding_threshold',
   '0.90'::jsonb,
   '型D（カニバリ）判定。同一クライアント内で記事同士の embedding コサイン類似度がこの値以上なら該当。gemini-embedding-2 / 768次元での仮値。自社サイトの実データで確定させる'),
  ('intent_drift_threshold',
   '0.70'::jsonb,
   '型C（狙いズレ）判定。target_keyword と最多クリッククエリの embedding コサイン類似度がこの値未満なら該当。gemini-embedding-2 / 768次元での仮値。自社サイトの実データで確定させる'),
  ('local_area_bonus',
   '1.3'::jsonb,
   '店舗系クライアント（business_type = local_store 等）で、対象エリア名を含むキーワードに掛けるスコア補正');
