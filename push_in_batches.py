# -*- coding: utf-8 -*-
"""
首次上线：把大体积站点拆成多批 commit 依次 push。

背景：本机 github.com 的 git 端点直连可用，但单次 458MB 的
git-receive-pack POST 会挂起；小包（几 MB）可秒级完成。
因此按累计体积分批提交、逐批 fast-forward 推送。

前置：远端 main 已存在（含初始化 commit），本脚本会先 fetch 并以它为
基准重建本地提交链，避免 non-fast-forward。

用法:
  python push_in_batches.py              # 正式执行
  python push_in_batches.py --dry-run    # 只显示分批计划
"""
import argparse
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
BRANCH = "main"
BATCH_LIMIT = 30 * 1024 * 1024      # 每批约 30MB
PUSH_TIMEOUT = 240                  # 单批 push 超时（秒）


def log(msg):
    print("[batch] " + msg, flush=True)


def token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    for line in open(os.path.expanduser("~/.git-credentials"),
                     encoding="utf-8", errors="ignore"):
        m = re.match(r"https?://[^:/@]+:([^@]+)@github\.com", line.strip())
        if m:
            return m.group(1)
    raise RuntimeError("未找到 GitHub 凭据")


def clean_env():
    e = os.environ.copy()
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "ALL_PROXY", "all_proxy"):
        e.pop(k, None)
    e["NO_PROXY"] = e["no_proxy"] = "github.com"
    e["GIT_TERMINAL_PROMPT"] = "0"
    return e


def git(args, timeout=180, network=False, url=None):
    """network=True 时显式禁用 helper 与代理，走 github.com 直连。"""
    cmd = ["git"]
    if network:
        cmd += ["-c", "credential.helper=",
                "-c", "http.proxy=", "-c", "https.proxy="]
    cmd += args
    try:
        return subprocess.run(cmd, cwd=ROOT, env=clean_env(),
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def mask(s):
    return re.sub(r"ghp_[A-Za-z0-9]+", "ghp_***", s or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    url = "https://x-access-token:%s@github.com/Olivebw/bbc-LE.git" % token()

    # 1) 保存当前完整文件清单（reset 之前）
    p = subprocess.run(["git", "ls-files"], cwd=ROOT,
                       capture_output=True, text=True)
    files = [f.strip().replace("\\", "/") for f in p.stdout.splitlines() if f.strip()]
    files = [f for f in files if os.path.isfile(os.path.join(ROOT, f))]
    sizes = {f: os.path.getsize(os.path.join(ROOT, f)) for f in files}
    log("待上线文件 %d 个，合计 %.1f MB"
        % (len(files), sum(sizes.values()) / 1024.0 / 1024.0))

    # 2) 分批：小文件优先，音频按路径顺序
    ordered = sorted(files, key=lambda f: (1 if f.startswith("audio/") else 0, f))
    batches, cur, total = [], [], 0
    for f in ordered:
        s = sizes[f]
        if cur and total + s > BATCH_LIMIT:
            batches.append(cur)
            cur, total = [], 0
        cur.append(f)
        total += s
    if cur:
        batches.append(cur)
    log("拆分为 %d 批（每批上限 %d MB）"
        % (len(batches), BATCH_LIMIT // 1024 // 1024))
    for i, b in enumerate(batches, 1):
        log("  批次 %2d: %3d 个文件 / %5.1f MB  (%s ...)"
            % (i, len(b), sum(sizes[f] for f in b) / 1024.0 / 1024.0, b[0][:52]))
    if args.dry_run:
        log("--dry-run：不执行")
        return 0

    # 3) 以远端 main 为基准重建本地提交链
    log("fetch 远端 %s ..." % BRANCH)
    p = git(["fetch", url, BRANCH], timeout=180, network=True)
    if p is None or p.returncode != 0:
        log("fetch 失败: " + mask((p.stderr if p else "timeout") or "")[:300])
        return 1
    head = subprocess.run(["git", "rev-parse", "FETCH_HEAD"], cwd=ROOT,
                          capture_output=True, text=True).stdout.strip()
    log("远端 HEAD: %s" % head[:8])
    p = git(["reset", "--mixed", head], timeout=120)
    if p is None or p.returncode != 0:
        log("reset 失败: " + mask((p.stderr if p else "timeout") or "")[:300])
        return 1
    log("已以远端 HEAD 为基准重置索引（工作区文件不变）")

    # 4) 逐批 add / commit / push
    for i, batch in enumerate(batches, 1):
        add = subprocess.run(["git", "add", "--"] + batch, cwd=ROOT,
                             capture_output=True, text=True)
        if add.returncode != 0:
            log("批次 %d git add 失败: %s" % (i, add.stderr[:200]))
            return 1
        st = git(["status", "--porcelain"], timeout=60)
        if not (st.stdout or "").strip():
            log("批次 %2d/%d 无变更，跳过" % (i, len(batches)))
            continue
        c = git(["commit", "-m",
                 "Add learning site files (batch %d/%d)" % (i, len(batches))],
                timeout=120)
        if c is None or c.returncode != 0:
            log("批次 %d commit 失败: %s"
                % (i, mask((c.stderr if c else "timeout") or "")[:200]))
            return 1

        ok = False
        for attempt in range(1, 4):
            p = git(["push", url, "HEAD:refs/heads/" + BRANCH],
                    timeout=PUSH_TIMEOUT, network=True)
            if p is not None and p.returncode == 0:
                ok = True
                break
            reason = "timeout" if p is None else mask((p.stderr or "")[:200])
            log("批次 %d 第 %d 次 push 失败: %s" % (i, attempt, reason))
            time.sleep(2)
        if not ok:
            log("批次 %d 推送最终失败，已停止。可重跑本脚本继续。" % i)
            return 1
        log("批次 %2d/%d 已推送 (%d 个文件, %.1f MB)"
            % (i, len(batches), len(batch),
               sum(sizes[f] for f in batch) / 1024.0 / 1024.0))

    log("全部 %d 批推送完成" % len(batches))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log("失败: %s: %s" % (type(e).__name__, e))
        sys.exit(1)
