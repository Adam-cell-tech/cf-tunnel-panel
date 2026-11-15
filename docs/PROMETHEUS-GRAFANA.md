# 把面板接进 Prometheus / Grafana

面板自带一个免登录的指标端点，`GET /metrics`，格式是标准 Prometheus 文本格式，
不用装任何 exporter。

## 1. 指标清单

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `cf_tunnel_panel_up` | gauge | 面板自身是否在线（恒为 1，用来判断抓取是否成功） |
| `cf_tunnel_running` | gauge | 正在运行的隧道出口数 |
| `cf_tunnel_routes` | gauge | 当前真正下发给 Caddy、生效中的规则数 |
| `cf_caddy_ok` | gauge | Caddy 配置下发是否成功（0 通常说明 Caddy 挂了或配置有错） |
| `cf_tunnel_up{id,name}` | gauge | 单个出口是否在线，1=在线 |
| `cf_tunnel_requests_total{status}` | counter | 访问日志按状态码分组的请求数（`2xx` / `3xx` / `4xx` / `5xx` / `其他`） |

> `cf_tunnel_routes` 是「生效」数，不等于你配的规则数：绑定到离线出口的规则、被
> `enabled` 关掉的规则都不会算进去（面板规则页顶部的黄条会列出被跳过的规则）。

## 2. 一条 curl 验证

```bash
curl -s http://127.0.0.1:8090/metrics
```

## 3. Prometheus 抓取

在 `prometheus.yml` 里加一个 job：

```yaml
scrape_configs:
  - job_name: cf-tunnel-panel
    scrape_interval: 30s
    static_configs:
      - targets: ['192.168.1.55:8090']   # 换成你面板的地址
```

如果面板开了登录（设置页 · 面板登录），`/metrics` 依然是免登录的，不需要配
`basic_auth`；想收紧的话，用防火墙或反代限制来源 IP。

## 4. Grafana 导入面板

1. Grafana → Dashboards → New → **Import**
2. 上传 `docs/grafana-dashboard.json`（或把内容粘进去）
3. 选择你的 Prometheus 数据源 → Import

面板里包含：

- **出口在线**（stat，`cf_tunnel_up`）—— 每一条隧道出口一个数字，掉线立刻变红
- **运行中出口数 / 生效规则数 / Caddy 状态**（三个 stat）
- **访问量（按状态码）**（timeseries，`rate(cf_tunnel_requests_total[5m])`）

## 5. 建议的两个告警

```yaml
groups:
  - name: cf-tunnel-panel
    rules:
      - alert: TunnelExitDown
        expr: cf_tunnel_up == 0
        for: 3m
        labels: { severity: warning }
        annotations:
          summary: '出口 {{ $labels.name }} 掉线超过 3 分钟'
      - alert: CaddyConfigBroken
        expr: cf_caddy_ok == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: 'Caddy 配置下发失败，代理规则可能已失效'
```

面板自己也带轻量通知（设置页 · 通知：掉线 / 换域名 / Caddy 失败，支持冷却和静默时段），
不想上 Prometheus 时用那个就够了；上了 Prometheus 就把它当成第二道防线。
