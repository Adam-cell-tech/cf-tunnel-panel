# 本机监控栈（Prometheus + Grafana）

面板首页的「监控面板」卡要用 Grafana 的图，这个目录就是把那套东西一键起起来的。

```bash
cd tools/monitoring
docker compose up -d          # Grafana: http://<本机IP>:3000   Prometheus: http://127.0.0.1:9090
```

起来之后面板侧只需三步：设置 → 监控嵌入 → 填地址/仪表盘/panelId（下面有现成值）。

## 里面有什么

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | Prometheus + Grafana，都是 host 网络、`restart: unless-stopped` |
| `prometheus/prometheus.yml` | 抓 `127.0.0.1:8090` 与 `:8095`（blue/green 谁在跑谁有数据） |
| `prometheus/alerts.yml` | 与 `docs/prometheus-alerts.yml` 同一份告警规则 |
| `provisioning/datasources/prom.yml` | 数据源 uid `prom-main` → `http://127.0.0.1:9090` |
| `provisioning/dashboards/dash.yml` | 自动导入 `dashboards/` 下的 json |
| `dashboards/cf-tunnel-panel.json` | 由 `docs/grafana-dashboard.json` 生成（数据源已固定） |

## Grafana 里开的两件事（compose 已用 env 设好）

- `GF_SECURITY_ALLOW_EMBEDDING=true` → 允许被 iframe 嵌
- `GF_AUTH_ANONYMOUS_ENABLED=true` + `GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer` → 匿名只读，打开就是图不是登录页

> 匿名只读的后果：同网段任何人都能看这些图（看不到面板配置，也改不了任何东西）。

## 面板里填什么

```
Grafana 地址:        http://<本机IP>:3000
仪表盘 uid/slug:     cfp-main/a650163        # 导入后 /d/ 后面那两段，slug 由 Grafana 生成
panelId:             1  (主实例) / 7 (集群角色时间线) / 9 (业务请求)
```

`panelId` 对照表在 `docs/ROADMAP.md` 的 v0.21.0 一节，或 Grafana 里 View panel → Inspect → Panel JSON 的 `id`。

## 第一次启动踩过的坑

数据目录必须归 uid 1000 所有，否则 Grafana 报
`GF_PATHS_DATA='/var/lib/grafana' is not writable`、Prometheus 在 `promql.NewActiveQueryTracker` 崩。
宿主没有 root，所以用容器里的 root 改属主：

```bash
docker run --rm -u 0 --entrypoint sh -v "$PWD/grafana-data:/d" grafana/grafana:11.3.0 \
  -c 'rm -rf /d/* ; chown -R 1000:1000 /d'
docker run --rm -u 0 --entrypoint sh -v "$PWD/prometheus-data:/d" prom/prometheus:v2.55.1 \
  -c 'rm -rf /d/* ; chown -R 1000:1000 /d'
```

注意 `--entrypoint sh`：不加它会执行镜像的 `/run.sh`，直接把 Grafana 当服务跑起来并抢 3000 端口。
