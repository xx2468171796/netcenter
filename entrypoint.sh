#!/bin/sh
# 容器启动: 先拉起 vnStat 守护(--network host 下采集宿主网卡流量), 再启动监控服务
mkdir -p /var/lib/vnstat
vnstatd -d 2>/dev/null || true
sleep 1
exec node --disable-warning=ExperimentalWarning server.js
