/**
 * Payload CMS アダプタ（Phase 2）
 *
 * WordPressアダプタと同じインターフェースを実装している。
 * 呼び出し側のコードは type を見る必要がなく、Payloadのサイトを
 * clients.json に追加するだけで既存フローに乗る。
 *
 * 状態: 実サイト未接続。フィールド名（title / content / slug / _status）は
 * Payload側のコレクション定義に合わせて調整が必要。
 * fieldMap で吸収できるようにしてある。
 */

const fetch = require("node-fetch");
const FormData = require("form-data");

const DEFAULT_FIELD_MAP = {
  title: "title",
  content: "content",
  slug: "slug",
  metaDescription: "meta.description",
};

function setByPath(target, dottedPath, value) {
  const keys = dottedPath.split(".");
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    node[keys[i]] = node[keys[i]] || {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

function getByPath(source, dottedPath) {
  return dottedPath
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), source);
}

function createAdapter(client) {
  const cms = client.cms;
  const collection = cms.collection || "posts";
  const fieldMap = { ...DEFAULT_FIELD_MAP, ...(cms.fieldMap || {}) };

  if (!cms.baseUrl || !cms.credentials.apiKey) {
    throw new Error(
      `[${client.id}] Payloadの接続設定が不完全です（baseUrl / APIキー）`
    );
  }

  // Payloadは "users API-Key <key>" 形式。認証コレクション名は設定で変えられる。
  const authCollection = cms.authCollection || "users";
  const headers = {
    Authorization: `${authCollection} API-Key ${cms.credentials.apiKey}`,
  };

  const url = (resource) => `${cms.baseUrl}/api/${resource}`;

  async function readError(res, fallback) {
    const body = await res.json().catch(() => ({}));
    return body.errors?.[0]?.message || body.message || fallback;
  }

  function toArticle(doc) {
    return {
      id: doc.id,
      title: getByPath(doc, fieldMap.title) || "",
      slug: getByPath(doc, fieldMap.slug) || "",
      status: doc._status || "draft",
      metaDescription: getByPath(doc, fieldMap.metaDescription) || "",
      content: getByPath(doc, fieldMap.content) || "",
      url: doc.url || `${cms.baseUrl}/${getByPath(doc, fieldMap.slug) || ""}`,
    };
  }

  function toDoc({ title, content, slug, status, metaDescription }) {
    const doc = {};
    if (title !== undefined) setByPath(doc, fieldMap.title, title);
    if (content !== undefined) setByPath(doc, fieldMap.content, content);
    if (slug !== undefined) setByPath(doc, fieldMap.slug, slug);
    if (metaDescription !== undefined)
      setByPath(doc, fieldMap.metaDescription, metaDescription);
    if (status !== undefined) {
      // Payloadのdrafts機能では published / draft の2値
      doc._status = status === "publish" ? "published" : "draft";
    }
    return doc;
  }

  return {
    type: "payload",
    clientId: client.id,

    async uploadMedia({ base64Image, filename, title, altText }) {
      const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      const form = new FormData();
      form.append("file", buffer, { filename, contentType: "image/jpeg" });
      form.append(
        "_payload",
        JSON.stringify({ alt: altText || title || filename })
      );

      const res = await fetch(url(cms.mediaCollection || "media"), {
        method: "POST",
        headers: { ...headers, ...form.getHeaders() },
        body: form,
      });

      if (!res.ok) {
        throw new Error(await readError(res, "画像アップロードに失敗しました"));
      }

      const body = await res.json();
      const doc = body.doc || body;
      return { id: doc.id, url: doc.url };
    },

    async createPost(input) {
      const doc = toDoc({
        ...input,
        status: input.status || cms.defaultPostStatus,
      });

      const res = await fetch(url(collection), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });

      if (!res.ok) {
        throw new Error(await readError(res, "記事作成に失敗しました"));
      }

      const body = await res.json();
      return toArticle(body.doc || body);
    },

    async listPosts({ status = "draft", limit = 50 } = {}) {
      const payloadStatus = status === "publish" ? "published" : "draft";
      const query = `where[_status][equals]=${payloadStatus}&limit=${limit}&draft=true`;

      const res = await fetch(`${url(collection)}?${query}`, { headers });
      if (!res.ok) {
        throw new Error(await readError(res, "記事一覧の取得に失敗しました"));
      }

      const body = await res.json();
      return (body.docs || []).map(toArticle);
    },

    async updatePost(postId, patch) {
      const doc = toDoc(patch);
      if (patch.scheduledAt !== undefined) {
        // Payloadには予約投稿が組み込まれていない。
        // publishAt フィールド＋スケジューラで実現する想定。
        doc[cms.publishAtField || "publishAt"] = patch.scheduledAt;
      }

      const res = await fetch(`${url(collection)}/${postId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });

      if (!res.ok) {
        throw new Error(await readError(res, "記事更新に失敗しました"));
      }

      const body = await res.json();
      return toArticle(body.doc || body);
    },

    async verify() {
      const res = await fetch(`${url(collection)}?limit=1`, { headers });
      if (!res.ok) {
        return { ok: false, error: await readError(res, "認証に失敗しました") };
      }
      return { ok: true, as: `${authCollection} API-Key` };
    },
  };
}

module.exports = { createAdapter };
