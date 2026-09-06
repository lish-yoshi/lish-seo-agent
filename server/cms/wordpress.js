/**
 * WordPress アダプタ
 *
 * 既存の /api/wordpress/* の処理をそのまま移し、
 * 環境変数への直接参照を client.cms から受け取る形に置き換えたもの。
 * 挙動は変えていない。
 */

const fetch = require("node-fetch");
const FormData = require("form-data");

function authHeader(cms) {
  const { username, password } = cms.credentials;
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function endpoint(cms, resource) {
  return `${cms.baseUrl}/wp-json/wp/v2/${resource}`;
}

function cmsError(response, body, fallback) {
  const err = new Error(body.message || fallback);
  err.cmsCode = body.code || null;
  err.cmsStatus = body.data?.status ?? response.status;
  err.httpStatus = response.status;
  return err;
}

async function readError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  throw cmsError(response, body, fallback);
}

function createAdapter(client) {
  const cms = client.cms;

  if (!cms.baseUrl || !cms.credentials.username || !cms.credentials.password) {
    throw new Error(
      `[${client.id}] WordPressの接続設定が不完全です（baseUrl / ユーザー名 / アプリケーションパスワード）`
    );
  }

  return {
    type: "wordpress",
    clientId: client.id,

    /** 画像をメディアライブラリへアップロード */
    async uploadMedia({ base64Image, filename, title, altText }) {
      const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      const form = new FormData();
      form.append("file", buffer, { filename, contentType: "image/jpeg" });
      if (title) form.append("title", title);
      if (altText) form.append("alt_text", altText);

      const res = await fetch(endpoint(cms, "media"), {
        method: "POST",
        headers: { Authorization: authHeader(cms), ...form.getHeaders() },
        body: form,
      });

      if (!res.ok) {
        await readError(res, "画像アップロードに失敗しました");
      }

      const data = await res.json();
      return { id: data.id, url: data.source_url };
    },

    /** 記事を作成（既定は下書き） */
    async createPost({ title, content, slug, status, metaDescription }) {
      const payload = {
        title,
        content,
        status: status || cms.defaultPostStatus,
      };
      if (slug) payload.slug = slug;
      // Yoast / All in One SEO などが有効なら meta 経由で入る。
      // 未対応テーマでは無視されるだけなので送っても害はない。
      if (metaDescription) payload.excerpt = metaDescription;

      const res = await fetch(endpoint(cms, "posts"), {
        method: "POST",
        headers: {
          Authorization: authHeader(cms),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        await readError(res, "記事作成に失敗しました");
      }

      const data = await res.json();
      return { id: data.id, url: data.link, status: data.status };
    },

    /** 下書き一覧を取得（Phase 3 の巡回エージェント用） */
    async listPosts({ status = "draft", limit = 50 } = {}) {
      const url = `${endpoint(cms, "posts")}?status=${encodeURIComponent(
        status
      )}&per_page=${Math.min(limit, 100)}&context=edit`;

      const res = await fetch(url, {
        headers: { Authorization: authHeader(cms) },
      });

      if (!res.ok) {
        await readError(res, "記事一覧の取得に失敗しました");
      }

      const rows = await res.json();
      return rows.map((r) => ({
        id: r.id,
        title: r.title?.raw ?? r.title?.rendered ?? "",
        slug: r.slug,
        status: r.status,
        metaDescription: r.excerpt?.raw ?? "",
        content: r.content?.raw ?? "",
        url: r.link,
      }));
    },

    /** 記事を更新（下書き → 予約投稿への切り替えなど） */
    async updatePost(postId, patch) {
      const payload = {};
      if (patch.title !== undefined) payload.title = patch.title;
      if (patch.content !== undefined) payload.content = patch.content;
      if (patch.slug !== undefined) payload.slug = patch.slug;
      if (patch.status !== undefined) payload.status = patch.status;
      if (patch.metaDescription !== undefined)
        payload.excerpt = patch.metaDescription;
      // 予約投稿は status=future と date の組で成立する
      if (patch.scheduledAt !== undefined) {
        payload.date = patch.scheduledAt;
        payload.status = patch.status || "future";
      }

      const res = await fetch(`${endpoint(cms, "posts")}/${postId}`, {
        method: "POST",
        headers: {
          Authorization: authHeader(cms),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        await readError(res, "記事更新に失敗しました");
      }

      const data = await res.json();
      return { id: data.id, url: data.link, status: data.status };
    },

    /** 接続確認 */
    async verify() {
      const res = await fetch(endpoint(cms, "users/me"), {
        headers: { Authorization: authHeader(cms) },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.message || "認証に失敗しました" };
      }
      const me = await res.json();
      return { ok: true, as: me.name || me.slug };
    },
  };
}

module.exports = { createAdapter };
