# Phase 1: マルチクライアント化

配布版は投稿先・スプレッドシート・ブランド情報のすべてを `.env` の単一値として読む構造でした。
このフェーズでは、それらを `clientId` で切り替わる設定に置き換えます。
記事の構成生成・執筆・校正・画像生成のロジックには一切触れていません。

対象は6〜7サイト（自社2・自社店舗1〜2・クライアント3以上）、うち1サイトはPayload CMS。

---

## 何が変わったか

### 1. クライアント設定層（新規）

`server/clients/store.js`

`clientId` をキーに、投稿先・スプレッドシートID・ブランド情報・実績データフォルダをまとめて引きます。
データソースは環境変数 `CLIENT_STORE` で切り替えます。

| 値 | 読み先 | 使いどころ |
|---|---|---|
| `file`（既定） | `clients.json` | ローカル、および数社まで |
| `supabase` | `clients` テーブル | 運用担当が画面から追加したくなったら |

**認証情報は設定に保存しません。** 設定には「読むべき環境変数の名前」だけを入れます。

```json
"credentials": { "usernameEnv": "WP_USER_CLIENT_A", "passwordEnv": "WP_PASS_CLIENT_A" }
```

こうしておくと、クライアント一覧をGitやDBに置いても資格情報が漏れません。
Cloud Run では同じ名前をシークレット参照として注入します。

### 2. CMSアダプタ（新規）

`server/cms/` — `wordpress.js` / `payload.js` / `index.js`

Payloadが次フェーズに来ると分かっているため、WordPress固有の処理をアダプタとして抜きました。
呼び出し側は投稿先の種類を知りません。Payloadのサイトは `clients.json` に1件足すだけで既存フローに乗ります。

共通インターフェース:

```
uploadMedia({ base64Image, filename, title, altText }) -> { id, url }
createPost({ title, content, slug, status, metaDescription }) -> { id, url, status }
listPosts({ status, limit })                                  -> [ Article ]
updatePost(id, patch)                                         -> { id, url, status }
verify()                                                      -> { ok, as }
```

`listPosts` と `updatePost` は配布版には無かったものです。
Phase 3 の巡回エージェント（下書きを点検して予約投稿へ切り替える層）がこの2つを使います。
`updatePost` に `scheduledAt` を渡すと予約投稿になります。

### 3. APIルート（差し替え）

`server/api/cms.js`

| 新 | 旧 |
|---|---|
| `GET /api/clients` | なし |
| `GET /api/client-config?clientId=` | `GET /api/wordpress/config` |
| `POST /api/cms/upload-image` | `POST /api/wordpress/upload-image` |
| `POST /api/cms/create-post` | `POST /api/wordpress/create-post` |
| `GET /api/cms/posts` | なし（Phase 3用） |
| `PATCH /api/cms/posts/:id` | なし（Phase 3用） |
| `GET /api/cms/verify` | なし |

`clientId` はボディ・クエリ・`x-client-id` ヘッダーのいずれからでも渡せます。
`DEFAULT_CLIENT_ID` を設定すれば省略もできるので、フロントは1画面ずつ移行できます。
`/api/wordpress/config` は互換のため残してありますが、移行が済んだら消してください。

### 4. スプレッドシートID（修正）

`server/api/spreadsheet-mode.js` / `spreadsheet-update.js`

モジュール読み込み時に固定されていた `SPREADSHEET_ID` を、リクエストごとの解決に変えました。
`clientId` が無ければ従来どおり `process.env.SPREADSHEET_ID` に落ちるため、単一運用のままでも挙動は変わりません。

### 5. ブランド情報のランタイム化（修正）— ここが本丸

`services/clientContext.ts`（新規）と、それを使う4ファイル。

`VITE_` 接頭辞の環境変数は Vite のビルド時にJSへ焼き込まれます。
つまり従来は**クライアントごとに別ビルド・別デプロイが必要**でした。
起動後にバックエンドから取得する形へ移したことで、1つのデプロイで全クライアントを扱えます。

置き換えたのは以下だけです。実際の参照箇所は4ファイル・7行しかありませんでした。

| ファイル | 変更前 | 変更後 |
|---|---|---|
| `articleWriterServiceV2.ts` | `import.meta.env.VITE_SERVICE_NAME` | `getBrand().serviceName` |
| `sectionBasedArticleWriter.ts` | 同上 | 同上 |
| `citationUtils.ts` | モジュール定数 `COMPANY_NOTE_URL` 他 | 関数内で `getBrand()` |
| `articleRevisionService.ts` | 同上 | 同上 |

---

## セットアップ

```bash
cp clients.example.json clients.json
echo "clients.json" >> .gitignore
```

`clients.json` を実際のサイトに合わせて編集し、`.env` に認証情報を追加します。

```
CLIENT_STORE=file
DEFAULT_CLIENT_ID=lish-corp

WP_USER_LISH_CORP=...
WP_PASS_LISH_CORP=...
WP_USER_CLIENT_A=...
WP_PASS_CLIENT_A=...
```

接続確認:

```bash
curl "http://localhost:3001/api/clients"
curl "http://localhost:3001/api/cms/verify?clientId=lish-corp"
```

`store.validateAll()` を起動時に呼ぶと、環境変数の設定漏れをその場で洗い出せます。

---

## 残っている作業

### フロントの画面側（対応済み）

- `components/ClientSelector.tsx` をヘッダー直下に配置。選択中の投稿先URLを常時表示する
- `App.tsx` マウント時に前回の選択を復元
- スプレッドシート取得に `x-client-id` を付与
- 画像生成エージェントへは `postMessage` の `clientId` で伝搬。画像生成側は `x-client-id` を付けて `/api/cms/*` を呼ぶ

### APIキーの露出（Phase 1 内で必ず対応）

`.env.example` の `VITE_GEMINI_API_KEY` `VITE_OPENAI_API_KEY` `VITE_INTERNAL_API_KEY` は
ビルド時にフロントへ焼き込まれ、ブラウザから読めます。READMEにも警告があります。

社内スタッフ複数人＋クライアント案件で使う前提なら、Gemini・OpenAI呼び出しを
バックエンド経由に寄せる必要があります。デプロイ後に回すと事故になります。

### Phase 2: Payload対応

`server/cms/payload.js` は実サイト未接続です。以下を実物に合わせて調整してください。

- `collection` / `mediaCollection` / `authCollection` の名前
- `fieldMap`（`title` / `content` / `slug` / `meta.description`）
- 予約投稿。Payloadには組み込みの予約投稿がないため、`publishAt` フィールドとスケジューラで実現する想定

`GET /api/cms/verify?clientId=lish-payload` が通れば接続は取れています。

### Phase 3: 巡回エージェント

`listPosts` と `updatePost` を使って、下書きの点検と予約投稿への切り替えを行う層。
配布版には含まれていないので自前で作ります。AX社が実運用しているのはこの部分です。
