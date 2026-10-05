# ============================================================================
#  ЖКУ · Крым — образ приложения вместе с сервером хранения данных
#  ---------------------------------------------------------------------------
#  Сборка:   docker build -f deploy/Dockerfile -t zhkx-crimea:2.0.0 .
#  Запуск:   docker run -d --name zhkx -p 8000:8000 \
#                 -v zhkx-data:/app/data \
#                 -e ZHKX_TOKEN=свой-секрет \
#                 zhkx-crimea:2.0.0
#  Данные лежат в томе zhkx-data: state.js, история ревизий, auth.json.
# ============================================================================
FROM node:20-alpine

LABEL org.opencontainers.image.title="ЖКУ · Крым" \
      org.opencontainers.image.description="Учёт коммунальных услуг по 6 объектам: данные в data/state.js, синхронизация с браузером, напоминания" \
      org.opencontainers.image.version="2.0.0"

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    ZHKX_DATA_DIR=/app/data

WORKDIR /app

# Приложению не нужны внешние зависимости: только исходники.
COPY index.html manifest.webmanifest sw.js package.json ./
COPY assets ./assets
COPY server ./server
COPY tools ./tools
COPY deploy ./deploy
COPY README.md ./

# Каталог данных создаётся при первом запуске, владелец — node
RUN mkdir -p /app/data && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
