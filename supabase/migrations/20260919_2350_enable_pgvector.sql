-- T-03: pgvector を有効化（articles.embedding 用。Supabase 推奨の extensions スキーマに配置）
create extension if not exists vector with schema extensions;
