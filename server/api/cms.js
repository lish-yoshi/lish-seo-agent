/**
 * クライアント対応のCMS APIルート
 *
 * 既存の /api/wordpress/* を置き換える。違いは1点だけで、
 * 投稿先を環境変数ではなくリクエストの clientId から決めること。
 *
 * 旧エンドポイントは DEFAULT_CLIENT_ID にフォールバックさせて残してあるので、
 * フロント側は1画面ずつ移行できる。
 */

const store = require("../clients/store");
const { createCmsAdapter } = require("../cms");
const DEFAULT_CLIENT_ID = require("../clients/resolveDefaultClientId");

/** クエリ・ボディ・ヘッダーのいずれからでも clientId を拾う */
function readClientId(req) {
  return (
    req.body?.clientId ||
    req.query?.clientId ||
    req.headers["x-client-id"] ||
    DEFAULT_CLIENT_ID ||
    null
  );
}

/**
 * clientId を解決してアダプタを組み立てる。
 * 失敗した理由がフロントで分かるよう、状態コードを打ち分ける。
 */
async function resolve(req, res) {
  const clientId = readClientId(req);

  if (!clientId) {
    res.status(400).json({
      error: "clientId が指定されていません",
      hint: "リクエストに clientId を含めるか、DEFAULT_CLIENT_ID を設定してください",
    });
    return null;
  }

  const client = await store.getClient(clientId);
  if (!client) {
    res.status(404).json({ error: `クライアントが見つかりません: ${clientId}` });
    return null;
  }

  try {
    return { client, cms: createCmsAdapter(client) };
  } catch (err) {
    res.status(500).json({ error: err.message });
    return null;
  }
}

/** 例外を握って本番ではメッセージを伏せる共通ハンドラ */
function handle(res, err, label, ctx) {
  console.error(`❌ ${label}:`, err.message);
  console.log(JSON.stringify({
    event: "cms_error",
    label,
    clientId: ctx?.client?.id ?? null,
    baseUrl: ctx?.client?.cms?.baseUrl ?? null,
    error: err.message,
    cmsCode: err.cmsCode ?? null,
    cmsStatus: err.cmsStatus ?? null,
    timestamp: new Date().toISOString(),
  }));
  // 上流CMSの 401/403/404 は 502（Bad Gateway）として返す
  const httpStatus = [401, 403, 404].includes(err.httpStatus) ? 502 : 500;
  res.status(httpStatus).json({
    error:
      process.env.NODE_ENV === "production" ? `${label}に失敗しました` : err.message,
    cmsCode: err.cmsCode ?? null,
    cmsStatus: err.cmsStatus ?? null,
  });
}

function register(app) {
  // ---- クライアント一覧・設定 ----

  app.get("/api/clients", async (req, res) => {
    try {
      const clients = await store.listClients();
      res.json({ clients: clients.filter((c) => c.enabled).map(store.toPublic) });
    } catch (err) {
      handle(res, err, "クライアント一覧の取得");
    }
  });

  app.get("/api/client-config", async (req, res) => {
    const clientId = readClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: "clientId が指定されていません" });
    }
    try {
      const client = await store.getClient(clientId);
      if (!client) {
        return res
          .status(404)
          .json({ error: `クライアントが見つかりません: ${clientId}` });
      }
      res.json(store.toPublic(client));
    } catch (err) {
      handle(res, err, "クライアント設定の取得");
    }
  });

  // ---- CMS操作 ----

  app.post("/api/cms/upload-image", async (req, res) => {
    const { base64Image, filename, title, altText } = req.body;
    if (!base64Image || !filename) {
      return res
        .status(400)
        .json({ error: "base64Image と filename は必須です" });
    }

    const ctx = await resolve(req, res);
    if (!ctx) return;

    try {
      const result = await ctx.cms.uploadMedia({
        base64Image,
        filename,
        title,
        altText,
      });
      console.log(`✅ [${ctx.client.id}] 画像アップロード成功: ${result.id}`);
      console.log(JSON.stringify({
        event: "cms_upload_image",
        clientId: ctx.client.id,
        baseUrl: ctx.client.cms.baseUrl,
        resourceId: result.id,
        timestamp: new Date().toISOString(),
      }));
      res.json({ ...result, source_url: result.url });
    } catch (err) {
      handle(res, err, "画像アップロード", ctx);
    }
  });

  app.post("/api/cms/create-post", async (req, res) => {
    const { title, content, slug, status, metaDescription } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: "title と content は必須です" });
    }

    const ctx = await resolve(req, res);
    if (!ctx) return;

    try {
      const result = await ctx.cms.createPost({
        title,
        content,
        slug,
        status,
        metaDescription,
      });
      console.log(`✅ [${ctx.client.id}] 記事作成成功: ${result.id}`);
      console.log(JSON.stringify({
        event: "cms_create_post",
        clientId: ctx.client.id,
        baseUrl: ctx.client.cms.baseUrl,
        resourceId: result.id,
        timestamp: new Date().toISOString(),
      }));
      res.json({ ...result, link: result.url });
    } catch (err) {
      handle(res, err, "記事作成", ctx);
    }
  });

  // Phase 3 の巡回エージェントが使う読み取り・更新
  app.get("/api/cms/posts", async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    try {
      const posts = await ctx.cms.listPosts({
        status: req.query.status || "draft",
        limit: Number(req.query.limit) || 50,
      });
      res.json({ posts });
    } catch (err) {
      handle(res, err, "記事一覧の取得", ctx);
    }
  });

  app.patch("/api/cms/posts/:id", async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    try {
      const result = await ctx.cms.updatePost(req.params.id, req.body);
      console.log(`✅ [${ctx.client.id}] 記事更新成功: ${req.params.id}`);
      console.log(JSON.stringify({
        event: "cms_update_post",
        clientId: ctx.client.id,
        baseUrl: ctx.client.cms.baseUrl,
        resourceId: req.params.id,
        timestamp: new Date().toISOString(),
      }));
      res.json(result);
    } catch (err) {
      handle(res, err, "記事更新", ctx);
    }
  });

  app.get("/api/cms/verify", async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    try {
      res.json(await ctx.cms.verify());
    } catch (err) {
      handle(res, err, "接続確認", ctx);
    }
  });

  // ---- 旧エンドポイントの互換維持（移行が済んだら削除する） ----

  app.get("/api/wordpress/config", async (req, res) => {
    const clientId = readClientId(req);
    const client = clientId ? await store.getClient(clientId) : null;
    if (!client) {
      return res.json({ baseUrl: "", username: "", defaultPostStatus: "draft" });
    }
    res.json({
      baseUrl: client.cms.baseUrl,
      username: client.cms.credentials.username || "",
      defaultPostStatus: client.cms.defaultPostStatus,
    });
  });
}

module.exports = { register, readClientId };
