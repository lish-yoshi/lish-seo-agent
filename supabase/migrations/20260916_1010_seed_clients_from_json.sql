-- ============================================================
-- clients 初期データ（T-01: clients.prod.json の 7 件を移行）
--
-- 生成元: clients.prod.json（Secret Manager CLIENTS_JSON v3 と同一内容）
-- 変更点:
--   - id "lish-corp" → "korean-with"（cms.baseUrl が korean-with.com のため）
--   - english-with / local-test / local-test2 は is_test = true
--   - enabled は JSON の値のまま（english-with のみ true）
--   - site_url は cms.baseUrl の正規化値。プレースホルダ（example.com）の
--     3 件（lish-payload / store-01 / client-a）は UNIQUE 衝突を避けるため NULL
--   - lish-payload の "_note" は列が無いためここに転記:
--     「Phase 2 で有効化する。コレクション名とフィールド名は実物に合わせて調整すること。」
--
-- cms.credentials は全て環境変数名（*Env）であることを生成時に検証済み。
-- 再実行時は既存行を上書きしない（on conflict do nothing）。
-- 適用方法: 20260916_1000_create_clients.sql の後に Supabase SQL Editor で実行
-- ============================================================

insert into public.clients
  (id, label, enabled, is_test, site_url, cockpit_client_id,
   brand, cms, spreadsheet_id, company_data_folder_id)
values
  -- lish-corp → korean-with
  ('korean-with', 'LISH コーポレートサイト', false, false,
   'korean-with.com', null,
   '{"companyName":"LISH株式会社","serviceName":"SEO＋AIO対策","noteUrl":"note.com/lish","mediaUrl":"media.lishinc.com","siteUrl":"lishinc.com"}'::jsonb,
   '{"type":"wordpress","baseUrl":"https://korean-with.com","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_LISH_CORP","passwordEnv":"WP_PASS_LISH_CORP"}}'::jsonb,
   '', ''),
  -- lish-payload
  ('lish-payload', '自社案件（Payload CMS）', false, false,
   null, null,
   '{"companyName":"LISH株式会社","serviceName":"","noteUrl":"","mediaUrl":"","siteUrl":""}'::jsonb,
   '{"type":"payload","baseUrl":"https://example.com","collection":"posts","mediaCollection":"media","authCollection":"users","defaultPostStatus":"draft","fieldMap":{"title":"title","content":"content","slug":"slug","metaDescription":"meta.description"},"credentials":{"apiKeyEnv":"PAYLOAD_KEY_SELF"}}'::jsonb,
   '', ''),
  -- store-01
  ('store-01', '自社店舗サイト 1', false, false,
   null, null,
   '{"companyName":"","serviceName":"","noteUrl":"","mediaUrl":"","siteUrl":""}'::jsonb,
   '{"type":"wordpress","baseUrl":"https://example.com","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_STORE_01","passwordEnv":"WP_PASS_STORE_01"}}'::jsonb,
   '', ''),
  -- client-a
  ('client-a', 'クライアントA', false, false,
   null, null,
   '{"companyName":"","serviceName":"","noteUrl":"","mediaUrl":"","siteUrl":""}'::jsonb,
   '{"type":"wordpress","baseUrl":"https://example.com","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_CLIENT_A","passwordEnv":"WP_PASS_CLIENT_A"}}'::jsonb,
   '', ''),
  -- local-test
  ('local-test', 'ローカル検証用', false, true,
   'seo-test.local', null,
   '{"companyName":"","serviceName":"","noteUrl":"","mediaUrl":"","siteUrl":""}'::jsonb,
   '{"type":"wordpress","baseUrl":"http://seo-test.local","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_LOCAL_TEST","passwordEnv":"WP_PASS_LOCAL_TEST"}}'::jsonb,
   '', ''),
  -- local-test2
  ('local-test2', 'ローカル検証2（seo-test2）', false, true,
   'seo-test2.local', null,
   '{"companyName":"検証2","serviceName":"検証2サービス","noteUrl":"","mediaUrl":"","siteUrl":""}'::jsonb,
   '{"type":"wordpress","baseUrl":"http://seo-test2.local","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_LOCAL_TEST2","passwordEnv":"WP_PASS_LOCAL_TEST2"}}'::jsonb,
   '', ''),
  -- english-with
  ('english-with', 'English With', true, true,
   'english-with.com', null,
   '{"companyName":"LISH株式会社","serviceName":"英語学習メディア運営","noteUrl":"","mediaUrl":"english-with.com","siteUrl":"https://english-with.com"}'::jsonb,
   '{"type":"wordpress","baseUrl":"https://english-with.com","defaultPostStatus":"draft","credentials":{"usernameEnv":"WP_USER_ENGLISH_WITH","passwordEnv":"WP_PASSWORD_ENGLISH_WITH"}}'::jsonb,
   '19sXC0obr7Ru3Wz3hIxjwirD7Lanz1HSYd8ISq-lIYVs', '')
on conflict (id) do nothing;
