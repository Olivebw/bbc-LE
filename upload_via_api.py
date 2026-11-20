# -*- coding: utf-8 -*-
"""
通过 GitHub REST API (Git Data API) 推送站点文件 —— git push 的可靠替代。

适用环境：git 协议端点（github.com/*.git）不可达，但 api.github.com 可达。
支持首次全量与日常增量，且天然幂等：
  - 本地按 git 规则计算 blob sha，与远端 tree 对比，只上传真正变化的文件
  - 基于 base_tree 生成新 tree，创建 commit，更新 refs/heads/main
  - 无变化时直接跳过，不会产生空提交

文件列表取自 `git ls-files`（与仓库暂存内容一致，自动遵循 .gitignore），
因此原始 1.9G MP3、.workbuddy/、.verify/ 都不会上传。

用法:
  python upload_via_api.py                 # 增量推送
  python upload_via_api.py --dry-run      # 只报告将上传的文件，不实际写入
  python upload_via_api.py --message MSG  # 自定义提交信息

环境变量:
  BBC_REPO       仓库，默认 Olivebw/bbc-LE
  GITHUB_TOKEN   凭据；未设置时读取 ~/.git-credentials
  BBC_API_PROXY  访问 api.github.com 的代理（默认沿用系统代理）
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("BBC_REPO", "Olivebw/bbc-LE")
BRANCH = "main"
API = "https://api.github.com"
WORKERS = 10


def log(msg):
    print("[api] " + msg, flush=True)


def token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    p = os.path.expanduser("~/.git-credentials")
    try:
        for line in open(p, encoding="utf-8", errors="ignore"):
            m = re.match(r"https?://[^:/@]+:([^@]+)@github\.com", line.strip())
            if m:
                return m.group(1)
    except OSError:
        pass
    raise RuntimeError("未找到 GitHub 凭据（GITHUB_TOKEN 或 ~/.git-credentials）")


def headers():
    return {
        "Authorization": "token " + token(),
        "Accept": "application/vnd.github+json",
        "User-Agent": "bbc-le-uploader",
    }


def api(method, path, expect=None, **kw):
    url = API + path
    last = None
    for attempt in range(4):
        try:
            r = requests.request(method, url, headers=headers(),
                                 timeout=(15, 180), **kw)
            if r.status_code in (429, 502, 503, 504):
                last = "%d %s" % (r.status_code, r.text[:120])
                time.sleep(2 * (attempt + 1))
                continue
            if expect and r.status_code not in expect:
                raise RuntimeError("%s %s -> %d %s"
                                   % (method, path, r.status_code, r.text[:300]))
            return r
        except requests.RequestException as e:
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("API 重试失败 %s %s: %s" % (method, path, last))


def local_files():
    if os.path.isdir(os.path.join(ROOT, ".git")):
        out = subprocess.run(["git", "ls-files"], cwd=ROOT,
                             capture_output=True, text=True).stdout
        files = [l.strip().replace("\\", "/") for l in out.splitlines() if l.strip()]
    else:
        skip_dirs = {".git", ".workbuddy", ".verify", "__pycache__"}
        files = []
        for base, dirs, names in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for n in names:
                rel = os.path.relpath(os.path.join(base, n), ROOT).replace("\\", "/")
                if re.match(r"^6-minute-english_\d{4}/.*\.mp3$", rel):
                    continue  # 原始大 MP3 不上传
                files.append(rel)
    return sorted(f for f in files if os.path.isfile(os.path.join(ROOT, f)))


def blob_sha(path):
    with open(os.path.join(ROOT, path), "rb") as f:
        data = f.read()
    h = hashlib.sha1()
    h.update(b"blob " + str(len(data)).encode() + b"\0")
    h.update(data)
    return h.hexdigest(), data


def remote_state():
    r = api("GET", "/repos/%s/branches/%s" % (REPO, BRANCH),
            expect=(200, 404))
    if r.status_code == 404:
        return None, None, {}
    j = r.json()
    head = j["commit"]["sha"]
    tree_sha = j["commit"]["commit"]["tree"]["sha"]
    t = api("GET", "/repos/%s/git/trees/%s?recursive=1" % (REPO, tree_sha),
            expect=(200,))
    paths = {e["path"]: e["sha"] for e in t.json().get("tree", [])
             if e.get("type") == "blob"}
    return head, tree_sha, paths


def upload_blob(item):
    path, sha, data = item
    r = api("POST", "/repos/%s/git/blobs" % REPO,
            expect=(200, 201),
            json={"content": base64.b64encode(data).decode("ascii"),
                  "encoding": "base64"})
    got = r.json()["sha"]
    if got != sha:
        raise RuntimeError("blob sha 不一致: %s" % path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--message", default="")
    args = ap.parse_args()

    files = local_files()
    log("本地待同步文件: %d 个" % len(files))
    head, base_tree, remote = remote_state()
    log("远端: %s" % ("空仓库，执行全量上传" if head is None
                    else "HEAD %s / 已收录 %d 个文件" % (head[:8], len(remote))))

    changes, unchanged = [], 0
    for f in files:
        sha, data = blob_sha(f)
        if remote.get(f) == sha:
            unchanged += 1
        else:
            changes.append((f, sha, data))
    local_set = set(files)
    deletions = [p for p in remote if p not in local_set]

    total_mb = sum(len(c[2]) for c in changes) / 1024.0 / 1024.0
    log("变化: 新增/修改 %d 个 (%.1f MB) | 删除 %d 个 | 未变 %d 个"
        % (len(changes), total_mb, len(deletions), unchanged))
    if not changes and not deletions:
        log("NO_CHANGE — 远端已是最新，无需提交")
        return 0
    if args.dry_run:
        for f, _, _ in changes[:20]:
            log("  + " + f)
        log("--dry-run：不执行上传")
        return 0

    log("开始上传 blobs（%d 并发）..." % WORKERS)
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(upload_blob, c): c[0] for c in changes}
        for fu in as_completed(futs):
            fu.result()   # 抛错即中止
            done += 1
            if done % 25 == 0 or done == len(changes):
                log("  已上传 %d/%d" % (done, len(changes)))

    entries = [{"path": p, "mode": "100644", "type": "blob", "sha": s}
               for p, s, _ in changes]
    entries += [{"path": p, "mode": "100644", "type": "blob", "sha": None}
                for p in deletions]
    body = {"tree": entries}
    if base_tree:
        body["base_tree"] = base_tree
    r = api("POST", "/repos/%s/git/trees" % REPO, expect=(200, 201), json=body)
    new_tree = r.json()["sha"]
    log("新 tree: %s" % new_tree[:8])

    today = datetime.date.today().isoformat()
    msg = args.message or ("Update %s: %d files changed" % (today, len(changes)))
    cbody = {"message": msg, "tree": new_tree}
    if head:
        cbody["parents"] = [head]
    r = api("POST", "/repos/%s/git/commits" % REPO,
            expect=(200, 201), json=cbody)
    new_commit = r.json()["sha"]
    log("新 commit: %s" % new_commit[:8])

    if head:
        api("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
            expect=(200,), json={"sha": new_commit})
    else:
        api("POST", "/repos/%s/git/refs" % REPO,
            expect=(200, 201),
            json={"ref": "refs/heads/" + BRANCH, "sha": new_commit})
    log("已更新 refs/heads/%s，GitHub Pages 将自动重新部署" % BRANCH)
    log("DONE: %s" % msg)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log("失败: %s: %s" % (type(e).__name__, e))
        sys.exit(1)
