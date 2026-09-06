/**
 * CMSアダプタ ファクトリ
 *
 * 呼び出し側は clientId さえ渡せばよく、投稿先がWordPressかPayloadかを
 * 意識しない。新しいCMSを足すときはここに1行追加する。
 *
 * すべてのアダプタが実装する共通インターフェース:
 *   uploadMedia({ base64Image, filename, title, altText }) -> { id, url }
 *   createPost({ title, content, slug, status, metaDescription }) -> { id, url, status }
 *   listPosts({ status, limit })                                  -> [ Article ]
 *   updatePost(id, patch)                                         -> { id, url, status }
 *   verify()                                                      -> { ok, as } | { ok:false, error }
 */

const wordpress = require("./wordpress");
const payload = require("./payload");

const ADAPTERS = {
  wordpress: wordpress.createAdapter,
  payload: payload.createAdapter,
};

/**
 * クライアント設定からアダプタを生成する。
 * 未対応のCMS種別は、対応済みの一覧を添えて分かる形で落とす。
 */
function createCmsAdapter(client) {
  const factory = ADAPTERS[client.cms.type];
  if (!factory) {
    throw new Error(
      `[${client.id}] 未対応のCMS種別です: ${client.cms.type}（対応: ${Object.keys(
        ADAPTERS
      ).join(", ")}）`
    );
  }
  return factory(client);
}

module.exports = { createCmsAdapter, supportedTypes: Object.keys(ADAPTERS) };
