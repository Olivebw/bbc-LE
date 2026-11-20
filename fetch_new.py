# -*- coding: utf-8 -*-
"""
BBC 6 Minute English 新一集抓取器（可降级，失败绝不阻断主流程）

数据源
------
默认 RSS: https://podcasts.files.bbci.co.uk/p02pc9tn.rss
可用环境变量覆盖：
  BBC_FEED_URL    备用/镜像 RSS 地址，多个用逗号分隔
  BBC_PROXY       可访问 BBC 的代理，如 http://127.0.0.1:7890
  BBC_SITE_BASE   BBC Learning English 站点根，默认 https://www.bbc.co.uk
  BBC_MAX_NEW     单次最多抓取集数，默认 3

抓取流程
--------
RSS item -> 集号 / 标题 / 音频直链 / 节目页链接
         -> 下载 MP3，解析节目页取 transcript（及 worksheet）PDF
         -> 落盘到 6-minute-english_YYYY/ 并追加 MANIFEST.csv

任何一步失败都不会留下半成品：该集已下载的文件会被清理。
网络整体不可达时输出 SOURCE_UNREACHABLE 并以退出码 0 结束，
保证定时任务仍能继续处理本地资料。

注意：BBC 音频与文稿受版权保护，本脚本仅供个人学习使用；
在无法访问 BBC 的网络环境下会自动降级为「仅报告」。

用法:
  python fetch_new.py               # 抓取并落盘
  python fetch_new.py --dry-run     # 只列出将抓取的集，不下载
  python fetch_new.py --discover    # 只报告新集标题（不下载文件）
"""
import argparse
import csv
import datetime
import email.utils
import os
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlparse, unquote

import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = "6-minute-english_"
DEFAULT_FEED = "https://podcasts.files.bbci.co.uk/p02pc9tn.rss"
SITE_BASE = os.environ.get("BBC_SITE_BASE", "https://www.bbc.co.uk").rstrip("/")
MANIFEST_COLS = ["episode", "title", "transcript", "worksheet", "audio", "page"]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def log(msg):
    print("[fetch_new] " + msg, flush=True)


def proxies():
    p = os.environ.get("BBC_PROXY", "").strip()
    return {"http": p, "https": p} if p else None


def feed_urls():
    raw = os.environ.get("BBC_FEED_URL", "").strip()
    return [u.strip() for u in raw.split(",") if u.strip()] or [DEFAULT_FEED]


def existing_ids():
    ids = set()
    for name in os.listdir(ROOT):
        if not name.startswith(PREFIX):
            continue
        p = os.path.join(ROOT, name, "MANIFEST.csv")
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8-sig", newline="") as f:
                for r in csv.DictReader(f):
                    if (r.get("episode") or "").strip():
                        ids.add(r["episode"].strip())
        except Exception:
            pass
    return ids


def get_feed(session, prx):
    """返回 (items, err)。任一源成功即返回。"""
    items, last = [], ""
    for url in feed_urls():
        try:
            r = session.get(url, headers=UA, proxies=prx, timeout=(8, 20))
            r.raise_for_status()
            root = ET.fromstring(r.content)
            found = root.findall(".//item")
            if not found:
                last = "%s: RSS 无 item" % url
                continue
            log("RSS 可用: %s (%d 条)" % (url, len(found)))
            return found, ""
        except Exception as e:
            last = "%s -> %s" % (url, type(e).__name__)
            log("  源不可用: " + last)
    return [], last


def text_of(item, tag):
    n = item.find(tag)
    return (n.text or "").strip() if n is not None and n.text else ""


def parse_item(item):
    title = re.sub(r"^6\s*Minute\s*English\s*[:：\-]?\s*", "",
                   text_of(item, "title"), flags=re.I).strip()
    link = text_of(item, "link")
    pub = text_of(item, "pubDate")
    enc = item.find("enclosure")
    audio_url = enc.get("url", "") if enc is not None else ""

    ep = ""
    m = re.search(r"ep-(\d{6})", link)
    if m:
        ep = m.group(1)
    if not ep and pub:
        try:
            ep = email.utils.parsedate_to_datetime(pub).strftime("%y%m%d")
        except Exception:
            pass
    if not ep:
        m = re.search(r"\b(\d{6})\b", title + " " + link)
        ep = m.group(1) if m else ""

    year = None
    if ep and len(ep) == 6 and ep.isdigit():
        year = 2000 + int(ep[:2])
    return {"ep": ep, "year": year, "title": title or ("Episode " + ep),
            "link": link, "audio_url": audio_url, "pub": pub}


def download(session, url, dest, prx):
    """下载到 .part 后原子替换；失败清理并返回 False。"""
    if not url:
        return False
    part = dest + ".part"
    try:
        r = session.get(url, headers=UA, proxies=prx,
                        timeout=(8, 60), stream=True)
        r.raise_for_status()
        with open(part, "wb") as f:
            for chunk in r.iter_content(65536):
                if chunk:
                    f.write(chunk)
        if os.path.getsize(part) < 1024:
            raise ValueError("文件过小")
        os.replace(part, dest)
        return True
    except Exception as e:
        log("  下载失败 %s (%s)" % (url[:70], type(e).__name__))
        if os.path.isfile(part):
            try:
                os.remove(part)
            except OSError:
                pass
        return False


def pdf_links(session, page_url, prx):
    """从节目页提取 transcript / worksheet PDF 直链。"""
    try:
        r = session.get(page_url, headers=UA, proxies=prx, timeout=(8, 25))
        r.raise_for_status()
        html = r.text
    except Exception as e:
        log("  节目页不可达 (%s)" % type(e).__name__)
        return None, None
    urls = set()
    for m in re.finditer(r"""(?:href|src|data-url)\s*=\s*["']([^"']+\.pdf[^"']*)["']""",
                         html, flags=re.I):
        u = urljoin(page_url, m.group(1))
        if u.lower().split("?")[0].endswith(".pdf"):
            urls.add(u)
    transcript = worksheet = None
    for u in sorted(urls):
        low = u.lower()
        if "worksheet" in low and not worksheet:
            worksheet = u
        elif "worksheet" not in low and not transcript:
            transcript = u
    return transcript, worksheet


def ensure_manifest(year):
    d = os.path.join(ROOT, "%s%d" % (PREFIX, year))
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "MANIFEST.csv")
    if not os.path.isfile(p):
        with open(p, "w", encoding="utf-8-sig", newline="") as f:
            csv.DictWriter(f, fieldnames=MANIFEST_COLS).writeheader()
        log("新建年份目录与清单: %s%d/MANIFEST.csv" % (PREFIX, year))
    return d, p


def append_manifest(path, row):
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = reader.fieldnames or MANIFEST_COLS
    with open(path, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writerow({c: row.get(c, "") for c in cols})


def safe_name(ep, url, fallback_suffix):
    name = unquote(os.path.basename(urlparse(url).path))
    name = re.sub(r"[^\w.\-]", "_", name)
    if not name.lower().endswith(".pdf") and not name.lower().endswith(".mp3"):
        name = "%s_6_minute_english_%s" % (ep, fallback_suffix)
    if not name.startswith(ep):
        name = ep + "_" + name
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--discover", action="store_true")
    args = ap.parse_args()

    session = requests.Session()
    prx = proxies()
    max_new = int(os.environ.get("BBC_MAX_NEW", "3"))

    items, err = get_feed(session, prx)
    if not items:
        log("SOURCE_UNREACHABLE — 所有 RSS 源均不可达: " + err)
        log("提示: 当前网络若无法访问 BBC，可设置 BBC_FEED_URL 指向可达镜像，"
            "或设置 BBC_PROXY 指向可访问 BBC 的代理。")
        print("RESULT: SOURCE_UNREACHABLE")
        return 0

    have = existing_ids()
    candidates = []
    for it in items:
        d = parse_item(it)
        if not d["ep"] or not d["year"] or d["ep"] in have:
            continue
        candidates.append(d)
        have.add(d["ep"])

    if not candidates:
        log("NO_NEW — RSS 中的集均已收录（本地 %d 集）" % len(have))
        print("RESULT: NO_NEW")
        return 0

    candidates = candidates[:max_new]
    log("发现 %d 个新集:" % len(candidates))
    for d in candidates:
        log("  %s  %s" % (d["ep"], d["title"]))

    if args.dry_run or args.discover:
        print("RESULT: DISCOVERED %d" % len(candidates))
        return 0

    added = 0
    for d in candidates:
        ep, year = d["ep"], d["year"]
        dirname, manpath = ensure_manifest(year)
        created = []

        # 1) 音频
        if not d["audio_url"]:
            log("  %s 无音频直链，跳过" % ep)
            continue
        mp3_name = safe_name(ep, d["audio_url"], "download.mp3")
        mp3_path = os.path.join(dirname, mp3_name)
        if not download(session, d["audio_url"], mp3_path, prx):
            continue
        created.append(mp3_path)

        # 2) 文稿 PDF
        tr_url, ws_url = (None, None)
        if d["link"]:
            tr_url, ws_url = pdf_links(session, d["link"], prx)
        if not tr_url:
            log("  %s 未找到 transcript PDF 直链，回滚本集" % ep)
            for f in created:
                os.remove(f)
            continue
        tr_name = safe_name(ep, tr_url, "transcript.pdf")
        tr_path = os.path.join(dirname, tr_name)
        if not download(session, tr_url, tr_path, prx):
            for f in created:
                os.remove(f)
            continue
        created.append(tr_path)

        # 3) 练习册（可选，失败不影响）
        ws_name = ""
        if ws_url:
            ws_name = safe_name(ep, ws_url, "worksheet.pdf")
            if not download(session, ws_url, os.path.join(dirname, ws_name), prx):
                ws_name = ""

        append_manifest(manpath, {
            "episode": ep,
            "title": d["title"],
            "transcript": tr_name,
            "worksheet": ws_name,
            "audio": mp3_name,
            "page": d["link"],
        })
        added += 1
        log("  %s 已收录（音频 + 文稿%s）" % (ep, " + 练习册" if ws_name else ""))

    print("RESULT: ADDED %d" % added)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log("未预期异常，降级跳过: %s: %s" % (type(e).__name__, e))
        print("RESULT: SOURCE_UNREACHABLE")
        sys.exit(0)
