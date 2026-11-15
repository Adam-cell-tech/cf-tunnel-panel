# 测试

两套端到端测试，都对着**跑着的面板**打真实 HTTP 请求（不是单元测试）。

```bash
# 1) 面板登录密码（必须）。面板开着 Basic 登录，测试会自动带凭据
export PANEL_PASS='你的面板密码'
export PANEL_USER=admin          # 可选，默认 admin
export PANEL_URL=http://127.0.0.1:8090   # 可选

# 2) 装测试依赖（只有 DOM 那套需要 jsdom）
npm i -D jsdom

# 3) 跑
npm test                # 两套都跑
npm run test:api        # 只跑接口（~60 项，含只读账号/流量/历史/通知历史）
npm run test:dom        # 只跑页面（jsdom 渲染 6 个页面，检查轮询不清空输入、导航、主题、分页）
```

说明：

- `test/api.test.mjs` 会临时建 `qa/qapass` 管理员和一个 `ro/ropass1` 只读账号做验证，**结束时恢复成你原来的管理员口令**（用 `PANEL_USER`/`PANEL_PASS` 恢复），不会把面板留在无鉴权状态。
- `test/dom.test.cjs` 在面板开着登录时会自己在 `127.0.0.1:8099` 起一个小代理加 Basic 头，再让 jsdom 通过它访问；跑完自动关掉。
- 接口测试会插一条临时探针规则 `qa-probe`（`/qa` → 演示上游），结束时删掉。
