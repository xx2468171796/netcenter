# server-monitor / netcenter — 监控镜像
# 容器内监控宿主机需配合 docker-compose.yml 的 --pid host / --network host / 挂载
FROM node:22-bookworm-slim

ENV NODE_ENV=production

# vnStat(流量) + procps(ps 进程) + docker 静态客户端(读宿主 docker.sock)
RUN apt-get update && apt-get install -y --no-install-recommends \
      vnstat procps curl ca-certificates \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz \
       | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && sed -i -E 's/^;?[[:space:]]*SaveInterval[[:space:]]+[0-9]+/SaveInterval 1/' /etc/vnstat.conf \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod +x /app/entrypoint.sh

EXPOSE 8055
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SM_PORT||8055)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
