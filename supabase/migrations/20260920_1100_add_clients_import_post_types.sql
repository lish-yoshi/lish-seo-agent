alter table public.clients add column import_post_types text[];
comment on column public.clients.import_post_types is 'CMS取り込み対象の投稿タイプ（WordPressのtypeスラッグ。例: {post,page}）。NULLは {post} 扱い';
