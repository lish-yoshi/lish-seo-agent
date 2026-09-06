# Cloud Run用 Dockerfile
FROM node:18-slim

# Puppeteer用の依存関係をインストール
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリを設定
WORKDIR /app

# 本番環境フラグとPuppeteerのダウンロードをスキップ
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# package.jsonをコピー
COPY package.json ./

# Cloud Runでは不要な@sparticuz/chromiumを除外してからインストール
# (Render/Vercel用のパッケージで、Cloud RunではシステムChromeを使用)
RUN node -e "const pkg=require('./package.json'); delete pkg.dependencies['@sparticuz/chromium']; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));"

# 依存関係をインストール
RUN npm install --omit=dev --omit=optional

# アプリケーションのソースコードをコピー
COPY . .

# Puppeteerがインストール済みのChromiumを使用するように設定
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# ポートを環境変数から取得（Cloud Runのデフォルト）
ENV PORT=8080

# 非rootユーザーを作成してセキュリティを向上
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads /home/pptruser/.cache \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

# Chrome用の追加設定
RUN chmod 755 /usr/bin/google-chrome-stable

# 非rootユーザーに切り替え
USER pptruser

# アプリケーションを起動
CMD ["node", "scraping-server.js"]