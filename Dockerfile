# SEOエージェント フロントエンド用 Dockerfile
  FROM node:20-alpine AS builder

  WORKDIR /app

  # 依存関係インストール
  COPY package*.json ./
  RUN npm ci

  # ソースコードをコピー
  COPY . .

  # ビルド時の環境変数（ARGで受け取る）
  ARG VITE_GEMINI_API_KEY
  ARG VITE_BACKEND_URL
  ARG VITE_INTERNAL_API_KEY
  ARG VITE_IMAGE_GEN_URL
  ARG VITE_OPENAI_API_KEY
  ARG VITE_SLACK_WEBHOOK_URL
  ARG VITE_ENABLE_SLACK_NOTIFICATIONS
  ARG VITE_SUPABASE_URL
  ARG VITE_SUPABASE_ANON_KEY
  ARG VITE_ENABLE_CLIENTS_ADMIN

  # .env ファイルを作成（Viteが読み込めるように）
  RUN echo "GEMINI_API_KEY=${VITE_GEMINI_API_KEY}" > .env && \
      echo "VITE_GEMINI_API_KEY=${VITE_GEMINI_API_KEY}" >> .env && \
      echo "VITE_BACKEND_URL=${VITE_BACKEND_URL}" >> .env && \
      echo "VITE_API_URL=${VITE_BACKEND_URL}/api" >> .env && \
      echo "VITE_INTERNAL_API_KEY=${VITE_INTERNAL_API_KEY}" >> .env && \
      echo "VITE_IMAGE_GEN_URL=${VITE_IMAGE_GEN_URL}" >> .env && \
      echo "VITE_OPENAI_API_KEY=${VITE_OPENAI_API_KEY}" >> .env && \
      echo "VITE_SLACK_WEBHOOK_URL=${VITE_SLACK_WEBHOOK_URL}" >> .env && \
      echo "VITE_ENABLE_SLACK_NOTIFICATIONS=${VITE_ENABLE_SLACK_NOTIFICATIONS}" >> .env && \
      echo "VITE_SUPABASE_URL=${VITE_SUPABASE_URL}" >> .env && \
      echo "VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}" >> .env && \
      echo "VITE_ENABLE_CLIENTS_ADMIN=${VITE_ENABLE_CLIENTS_ADMIN}" >> .env

  # ビルド
  RUN npm run build

  # 本番用イメージ
  FROM nginx:alpine

  # ビルド成果物をコピー
  COPY --from=builder /app/dist /usr/share/nginx/html

  # nginx設定
  COPY nginx.conf /etc/nginx/conf.d/default.conf

  EXPOSE 8080

  CMD ["nginx", "-g", "daemon off;"]