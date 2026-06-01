---
title: "netcenter：一条命令搞定的轻量服务器监控面板（中文 / 实时图 / 流量统计）"
date: 2026-06-01
tags: [服务器监控, Docker, 自建, 运维]
---

# netcenter：一条命令搞定的轻量服务器监控面板

每次想看一眼服务器现在 CPU 多高、内存还剩多少、这个月跑了多少流量，要么 SSH 上去敲一堆命令，要么装个又重又全是英文的大家伙。我想要的其实很简单：**中文界面、图好看、能按时间看进出流量、一条命令装好**——找了一圈没有特别趁手的，干脆自己写了一个，叫 **netcenter**。

它是个单文件 Node 服务，零数据库依赖（用 Node 自带的 SQLite），前端用 ECharts 6 画图，自带登录。最重要的是：**目标机器只要装了 Docker，复制一条命令就跑起来了**，不用配环境、不用装 agent。

---

## 一条命令，装好就能用

```bash
docker run -d --name netcenter --restart unless-stopped \
  --pid host --network host --cap-add SYS_PTRACE \
  -e HOST_PROC=/host/proc -e HOST_ROOT=/host \
  -e SM_PORT=8055 -e SM_HOST=0.0.0.0 -e SM_USER=admin -e SM_PASS=123456 \
  -v /proc:/host/proc:ro -v /:/host:ro,rslave \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v netcenter-vnstat:/var/lib/vnstat \
  ghcr.io/xx2468171796/netcenter:latest
```

然后浏览器打开 `http://你的服务器IP:8055`，默认账号 `admin` / `123456`，首次进入会有个初始化向导让你选数据保留多久。完事。

镜像托管在 GitHub 容器仓库（ghcr），公开免费拉取，不用注册任何东西。

---

## 它能看什么

**概览** —— CPU、内存、磁盘、网络上下行、连接数、今日 / 本月流量，进页面一屏全看到。

**实时监控** —— CPU、内存、网络速率、磁盘读写四张实时曲线，刷新频率 1s / 3s / 5s / 10s 自己选，还能切到 1 小时 / 6 小时 / 24 小时 / 7 天的历史。

**流量统计（进 / 出）** —— 这是我最在意的功能。基于 vnStat，能按 1 天 / 1 周 / 15 天 / 1 月 / 3 月 / 当月 / 1 年，或者自定义起止日期，看任意网卡进出多少流量。算带宽账、查异常跑流量，一目了然。

**进程 TOP** —— 按 CPU 或内存排序，谁在吃资源直接看到。

**Docker / PM2** —— 容器（PostgreSQL、Redis、MinIO 这些）和 PM2 进程的存活状态、CPU、内存。

**磁盘分区** —— 每个挂载点的用量条，超 75% 变黄、超 90% 变红。

**网络明细** —— 每块网卡的实时速率、累计收发、连接数，还能切时间档看每块网卡的区间进出。

界面支持**浅色 / 深色**主题，面板能折叠，**手机上也能正常看**。CPU、内存图固定 0-100% 坐标轴，不会因为自动缩放把 3% 的占用画成一座大山。

---

## 截图

> 发布时把下面替换成你自己的截图

![总览与实时图](./screenshot-dashboard.png)

![流量统计](./screenshot-traffic.png)

---

## 为什么轻

- 后端就是一个 Node + Fastify 服务，读 `/proc`、`/sys` 出实时指标，历史采样落到内置 `node:sqlite`，**没有任何需要编译的原生依赖**，镜像也好、原生跑也好，都不折腾。
- 前端单页，ECharts 本地内置，不依赖任何 CDN，内网也能用。
- 实测在一台 48 核的生产机上常驻内存约 70-80MB、CPU 约 1%，基本感知不到。
- 采样数据默认只留 35 天滚动清理（也可以设 60 / 90 天 / 1 年 / 永久），每天自动回收磁盘，跑几个月体积也就几 MB，不会越积越大；想手动收也有一键清理。

---

## 适合谁

- 自己有一两台 VPS / 服务器，想随时用手机或浏览器瞄一眼状态；
- 想按月看带宽用量、算流量账；
- 嫌 netdata 太重、全英文，又不想为了哪吒去配 agent；
- 喜欢「一条命令装好、中文、好看」的人。

监控本机用原生 systemd 部署最直接，监控多台或图省事就用上面那条 Docker 命令。

---

## 开源 / 地址

- 代码：https://github.com/xx2468171796/netcenter
- 镜像：`ghcr.io/xx2468171796/netcenter:latest`

完全开源，欢迎 star、提 issue，或者直接拿去改成你喜欢的样子。

---

## 关于作者

本项目由 **alone** 开发维护。有问题、想反馈、或者想交流自建 / 运维相关的，欢迎进群：

**Telegram 交流群：https://t.me/+RZMe7fnvvUg1OWJl**

如果这个工具帮到了你，点个 star 就是最好的支持。
