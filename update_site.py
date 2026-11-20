# -*- coding: utf-8 -*-
"""
BBC 6 Minute English 学习站 —— 一键 / 定时更新流水线

执行顺序：
  1. fetch_new.py         尝试抓取 BBC 新一集（网络不可达时自动降级，不影响后续）
  2. register_local_new   扫描本地新增 PDF/MP3，自动登记进 MANIFEST.csv
  3. compress_audio.py    增量转码新音频（已转过的自动跳过）
  4. build_data.py        重新生成 data/episodes.js / .json
  5. 校验                 所有音频 / 文稿 / 练习册路径存在
  6. git commit + push    仅在有变更时提交，GitHub Pages 随之自动重新部署

日常使用：把新下载的 PDF / MP3 放进 6-minute-english_YYYY/ 目录，
然后运行本脚本即可；无需手工改清单、无需手工压缩、无需手工推送。

推送通道：默认原生 git push（github.com 直连，小增量包很快）；
失败时自动回退 GitHub REST API（只依赖 api.github.com）。

用法:
  python update_site.py               # 完整流水线
  python update_site.py --skip-fetch  # 跳过在线抓取（网络受限时更快）
  python update_site.py --no-push     # 只更新本地数据，不提交推送（调试用）

环境变量:
  BBC_REMOTE       覆盖远端仓库地址，默认 https://github.com/Olivebw/bbc-LE.git
  GITHUB_TOKEN     推送凭据；未设置时读取 ~/.git-credentials
  BBC_PUSH_METHOD  默认 git；设为 api 则强制只用 REST API
  BBC_HTTP_PROXY   仅 git 推送且必须走代理时设置
  BBC_PROXY / BBC_FEED_URL   供 fetch_new.py 抓取 BBC 使用
"""
import argparse
import csv
import datetime
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = "6-minute-english_"
REMOTE = os.environ.get("BBC_REMOTE", "https://github.com/Olivebw/bbc-LE.git")
BRANCH = "main"
MANIFEST_COLS = ["episode", "title", "transcript", "worksheet", "audio", "page"]


def log(msg):
    print("[update] " + msg, flush=True)


def run(cmd, env=None, check=False, timeout=None):
    try:
        p = subprocess.run(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if check and p.returncode != 0:
        raise RuntimeError("%s 失败: %s" % (" ".join(cmd[:3]),
                                           (p.stderr or p.stdout).strip()[:500]))
    return p


def run_step(label, script, extra=None):
    cmd = [sys.executable, os.path.join(ROOT, script)] + (extra or [])
    p = run(cmd)
    if p is None:
        log("%s 超时" % label)
        return 1
    out = (p.stdout or "").strip()
    if out:
        for line in out.splitlines()[-14:]:
            print("    " + line)
    if p.returncode != 0:
        log("%s 返回 %d（已记录，继续后续步骤）: %s"
            % (label, p.returncode, (p.stderr or "").strip()[:200]))
    else:
        log("%s 完成" % label)
    return p.returncode


def guess_title(filename):
    s = re.sub(r"^\d{6}_", "", filename)
    s = re.sub(r"\.pdf$", "", s, flags=re.I)
    s = re.sub(r"_?6_?minute_?english_?", "", s, flags=re.I)
    s = re.sub(r"_?(transcript|worksheet|download)_?$", "", s, flags=re.I)
    s = re.sub(r"_+", " ", s).strip()
    return " ".join(w.capitalize() for w in s.split()) or "Untitled"


def register_local_new():
    """把目录里尚未登记进 MANIFEST.csv 的新资料自动补一行。"""
    added = 0
    for name in sorted(os.listdir(ROOT)):
        if not name.startswith(PREFIX) or not os.path.isdir(os.path.join(ROOT, name)):
            continue
        d = os.path.join(ROOT, name)
        mpath = os.path.join(d, "MANIFEST.csv")
        if not os.path.isfile(mpath):
            continue
        with open(mpath, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            cols = reader.fieldnames or MANIFEST_COLS
            used = {r["episode"].strip() for r in reader
                    if (r.get("episode") or "").strip()}

        groups = {}
        for fn in os.listdir(d):
            if not fn.lower().endswith((".pdf", ".mp3")):
                continue
            m = re.match(r"^(\d{6})_", fn)
            if m:
                groups.setdefault(m.group(1), []).append(fn)

        for ep in sorted(groups, reverse=True):
            if ep in used:
                continue
            g = groups[ep]
            trans = sorted(
                [f for f in g if f.lower().endswith(".pdf")
                 and "worksheet" not in f.lower()],
                key=lambda f: (0 if "transcript" in f.lower() else 1, f))
            ws = [f for f in g if "worksheet" in f.lower()
                  and f.lower().endswith(".pdf")]
            audio = [f for f in g if f.lower().endswith(".mp3")]
            if not trans or not audio:
                log("  %s 缺文稿或音频，暂不登记" % ep)
                continue
            row = {
                "episode": ep,
                "title": guess_title(trans[0]),
                "transcript": trans[0],
                "worksheet": ws[0] if ws else "",
                "audio": audio[0],
                "page": "",
            }
            with open(mpath, "a", encoding="utf-8-sig", newline="") as f:
                csv.DictWriter(f, fieldnames=cols).writerow(
                    {c: row.get(c, "") for c in cols})
            used.add(ep)
            added += 1
            log("  登记新集 %s — %s" % (ep, row["title"]))
    return added


def validate():
    p = os.path.join(ROOT, "data", "episodes.json")
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    miss = []
    for e in d["episodes"]:
        for rel in (e.get("audio"), e.get("transcript"), e.get("worksheet")):
            if rel and not os.path.isfile(os.path.join(ROOT, rel)):
                miss.append(rel)
    return d["meta"], miss


def load_token():
    env = os.environ.get("GITHUB_TOKEN", "").strip()
    if env:
        return env
    p = os.path.expanduser("~/.git-credentials")
    try:
        for line in open(p, encoding="utf-8", errors="ignore"):
            m = re.match(r"https?://[^:/@]+:([^@]+)@github\.com", line.strip())
            if m:
                return m.group(1)
    except OSError:
        pass
    return None


def git_sync(added, meta):
    """同步到 GitHub：默认 git push，失败自动回退 REST API。"""
    has_git = os.path.isdir(os.path.join(ROOT, ".git"))
    if has_git:
        run(["git", "add", "-A"])
        st = run(["git", "status", "--porcelain"])
        if (st is not None and not (st.stdout or "").strip()
                and os.environ.get("BBC_PUSH_METHOD", "git").strip().lower() == "git"):
            log("无文件变更，跳过提交与推送")
            return False
    today = datetime.date.today().isoformat()
    msg = "Update %s: %d episodes, %d new" % (today, meta["total"], added)

    method = os.environ.get("BBC_PUSH_METHOD", "git").strip().lower()
    if method == "api":
        return _push_via_api(msg)

    # 先本地提交，保持本地与远端历史一致
    if has_git:
        c = run(["git", "commit", "-m", msg])
        if c is None or c.returncode != 0:
            log("本地提交失败或跳过: " + ((c.stderr if c else "timeout") or "").strip()[:200])
    ok = _push_via_git(msg)
    if not ok:
        log("git push 失败，自动回退 REST API 推送")
        ok = _push_via_api(msg)
    return ok


def _push_via_api(msg):
    """GitHub REST API 增量推送（按 blob sha 对比，只上传变化文件）。"""
    p = run([sys.executable, os.path.join(ROOT, "upload_via_api.py"),
             "--message", msg])
    if p is None:
        log("API 推送超时")
        return False
    for line in (p.stdout or "").strip().splitlines()[-10:]:
        print("    " + line)
    if p.returncode != 0:
        log("API 推送失败: " + (p.stderr or "").strip()[:300])
        return False
    log("已通过 API 推送到 GitHub，Pages 将自动重新部署")
    return True


def _push_via_git(msg):
    """原生 git push（github.com 直连，禁用代理与 credential helper）。"""
    tok = load_token()
    if not tok:
        log("未找到 GitHub 凭据")
        return False
    u = urlparse(REMOTE)
    push_url = "https://x-access-token:%s@%s%s" % (tok, u.netloc, u.path)
    env = os.environ.copy()
    custom = os.environ.get("BBC_HTTP_PROXY", "").strip()
    if custom:
        env["HTTPS_PROXY"] = env["https_proxy"] = custom
        proxy_flags = ["-c", "http.proxy=" + custom]
    else:
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy",
                  "https_proxy", "ALL_PROXY", "all_proxy"):
            env.pop(k, None)
        env["NO_PROXY"] = env["no_proxy"] = "github.com"
        proxy_flags = ["-c", "http.proxy=", "-c", "https.proxy="]
    env["GIT_TERMINAL_PROMPT"] = "0"
    p = run(["git", "-c", "credential.helper="] + proxy_flags +
            ["push", push_url, "HEAD:refs/heads/" + BRANCH],
            env=env, timeout=180)
    if p is None:
        log("git push 超时")
        return False
    if p.returncode != 0:
        log("git push 失败: " + (p.stderr or "").strip()[:300])
        return False
    log("git push 成功，Pages 将自动重新部署")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()

    log("=" * 58)
    log("开始更新 %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    # 1) 在线抓取（可降级）
    if not args.skip_fetch:
        run_step("在线抓取", "fetch_new.py")
    else:
        log("跳过在线抓取（--skip-fetch）")

    # 2) 本地新增资料登记
    added = register_local_new()
    log("本地新增登记: %d 集" % added)

    # 3) 增量压缩音频
    run_step("音频压缩", "compress_audio.py")

    # 4) 重建课程数据
    rc = run_step("数据重建", "build_data.py")
    if rc != 0:
        log("数据重建失败，终止推送")
        return 1

    # 5) 校验
    meta, miss = validate()
    log("校验: %d 集 / %d 条词汇 / 缺失资源 %d"
        % (meta["total"], meta["vocabCount"], len(miss)))
    if miss:
        for m in miss[:10]:
            log("  ! 缺失 " + m)
        log("存在缺失资源，终止推送（本地数据已生成）")
        return 1

    # 6) 提交推送
    if not args.no_push:
        git_sync(added, meta)
    else:
        log("--no-push：跳过提交推送")

    log("更新完成")
    log("=" * 58)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log("未预期异常: %s: %s" % (type(e).__name__, e))
        sys.exit(1)
