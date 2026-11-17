#!/usr/bin/env python3
"""把 CHANGELOG.md 里每个版本的段落同步成对应 GitHub Release 的正文。

为什么要这个脚本：tag 是后来才补的，历史上那些 tag 的 workflow 当时还不会建 Release，
或者建出来的正文是退化的（CHANGELOG 当时的标题是 `## v0.20.0 — 说明文字`，旧正则匹配不到）。
现在统一用「当前 CHANGELOG」重写一遍所有 Release 的正文。

用法：
  python3 tools/sync-release-notes.py --dry     # 只打印差异，不写
  GITHUB_TOKEN=xxx python3 tools/sync-release-notes.py   # 真写（CI 里用 GITHUB_TOKEN）

约定：
- 有 CHANGELOG 段的版本 → 正文 = 该段
- 0.29.3 及之后有镜像 → 追加「镜像」小节；更老的版本追加「历史版本：只记录发布点」提示
- tag 名在 DROP_TAGS 里的（诊断用）→ 直接删 Release 与 tag
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPO = os.environ.get('REPO') or 'jianghugs/cf-tunnel-panel'
TOKEN = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or ''
API = 'https://api.github.com'
DRY = '--dry' in sys.argv
DROP_TAGS = {'v0.0.1-diag'}          # 诊断/误建的 tag，顺手清掉
IMAGE_FROM = (0, 29, 3)               # 从这个版本起发布过 ghcr 镜像
SHORT_TAG_FROM = (0, 29, 4)           # 从这个版本起镜像才有「不带 v 的短 tag」（0.29.3 只有 v0.29.3）


def api(method, path, payload=None):
    url = API + path if path.startswith('/') else path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    req.add_header('User-Agent', 'cf-tunnel-panel-release-sync')
    if TOKEN:
        req.add_header('Authorization', 'Bearer ' + TOKEN)
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return json.loads(body) if body.strip() else None


def vkey(ver):
    main, _, pre = ver.partition('-')
    try:
        parts = tuple(int(x) for x in main.split('.'))
    except ValueError:
        return (0, 0, 0, 0)
    return parts + ((1,) if pre else (0,))


def load_changelog():
    text = open('CHANGELOG.md', encoding='utf-8').read()
    out = {}
    for m in re.finditer(r'^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b[^\n]*$(.*?)(?=^##\s|\Z)', text, re.S | re.M):
        out[m.group(1)] = m.group(2).strip()
    return out


def compose(ver, section):
    out = [section, '', '---', '']
    if vkey(ver) >= IMAGE_FROM:
        tag = ver if vkey(ver) >= SHORT_TAG_FROM else 'v' + ver
        out += ['**镜像**（linux/amd64 + linux/arm64）', '', '```bash',
                'docker pull ghcr.io/%s:%s' % (REPO, tag),
                'docker pull ghcr.io/%s:latest' % REPO, '```']
    else:
        out += ['> 历史版本：这个 tag 只记录当时的发布点，没有构建镜像。']
    return '\n'.join(out).strip() + '\n'


def main():
    sections = load_changelog()
    print('CHANGELOG 覆盖版本数：%d' % len(sections))
    releases, page = [], 1
    while True:
        batch = api('GET', '/repos/%s/releases?per_page=100&page=%d' % (REPO, page)) or []
        releases += batch
        if len(batch) < 100:
            break
        page += 1

    dry_run_api = bool(DRY) or not TOKEN
    if dry_run_api:
        print('（未提供 GITHUB_TOKEN 或 --dry：只读模式，不会修改任何东西）')

    updated = skipped = dropped = 0
    for r in releases:
        tag = r['tag_name']
        if tag in DROP_TAGS:
            if dry_run_api:
                print('· 将删除 Release 与 tag：%s' % tag)
            else:
                api('DELETE', '/repos/%s/releases/%d' % (REPO, r['id']))
                try:
                    api('DELETE', '/repos/%s/git/refs/tags/%s' % (REPO, tag))
                except urllib.error.HTTPError as e:
                    print('  tag 删除失败（可忽略）：%s' % e)
                print('- 已删除 %s' % tag)
            dropped += 1
            continue
        ver = tag[1:] if tag.startswith('v') else tag
        section = sections.get(ver)
        if not section:
            skipped += 1
            continue
        want = compose(ver, section)
        if (r.get('body') or '').strip() == want.strip():
            skipped += 1
            continue
        if dry_run_api:
            print('· 将更新 %s（%d → %d 字符）' % (tag, len(r.get('body') or ''), len(want)))
        else:
            api('PATCH', '/repos/%s/releases/%d' % (REPO, r['id']), {'body': want})
            print('- 已更新 %s' % tag)
        updated += 1

    print('\n汇总：更新 %d，跳过 %d，删除 %d，共 %d 个 Release' % (updated, skipped, dropped, len(releases)))


if __name__ == '__main__':
    main()
