# -*- coding: utf-8 -*-
"""
把 6-minute-english_YYYY/ 下的原始 MP3 转码为语音级轻量版本，
输出到 audio/YYYY/（文件名保持不变），供 GitHub Pages 上线使用。

- 单声道 22.05kHz / 48kbps MP3，体积约为原始文件的 1/4
- 增量执行：目标已存在且不比源旧则跳过，适合定时任务反复运行
- 原始 MP3 完全不改动，本地 file:// 打开时依然可用原文件

用法:
    python compress_audio.py                # 增量转码全部
    python compress_audio.py --limit 2      # 只处理前 2 个（测试用）
    python compress_audio.py --force        # 强制重转
"""
import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import imageio_ffmpeg

ROOT = os.path.dirname(os.path.abspath(__file__))
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
BITRATE = "48k"
WORKERS = 4
PREFIX = "6-minute-english_"


def year_dirs():
    out = []
    for name in sorted(os.listdir(ROOT)):
        if not name.startswith(PREFIX):
            continue
        year = name[len(PREFIX):]
        if year.isdigit() and os.path.isdir(os.path.join(ROOT, name)):
            out.append((name, year))
    return out


def collect():
    items = []
    for dirname, year in year_dirs():
        src_dir = os.path.join(ROOT, dirname)
        for f in sorted(os.listdir(src_dir)):
            if f.lower().endswith(".mp3"):
                items.append((
                    os.path.join(src_dir, f),
                    os.path.join(ROOT, "audio", year, f),
                ))
    return items


def convert(pair, force=False):
    src, dst = pair
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if (not force and os.path.isfile(dst)
            and os.path.getmtime(dst) >= os.path.getmtime(src)):
        return "skip", src, dst, os.path.getsize(src), os.path.getsize(dst)

    tmp = dst + ".tmp.mp3"
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
           "-i", src, "-vn", "-ac", "1", "-ar", "22050",
           "-codec:a", "libmp3lame", "-b:a", BITRATE, tmp]
    try:
        p = subprocess.run(cmd, stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE, timeout=180)
        if p.returncode != 0 or not os.path.isfile(tmp):
            if os.path.isfile(tmp):
                os.remove(tmp)
            return "fail", src, dst, 0, 0
        os.replace(tmp, dst)
        return "ok", src, dst, os.path.getsize(src), os.path.getsize(dst)
    except Exception:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return "fail", src, dst, 0, 0


def human(n):
    return "%.1f MB" % (n / 1024.0 / 1024.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    items = collect()
    if args.limit:
        items = items[:args.limit]
    print("扫描到 %d 个源 MP3，输出目录 audio/<year>/" % len(items))
    print("ffmpeg: %s" % FFMPEG)
    print("-" * 62)

    t0 = time.time()
    stat = {"ok": 0, "skip": 0, "fail": 0}
    src_sum = dst_sum = 0
    fails = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(convert, it, args.force): it for it in items}
        done = 0
        for fu in as_completed(futs):
            status, src, dst, s1, s2 = fu.result()
            stat[status] += 1
            done += 1
            if status == "fail":
                fails.append(src)
            if s1:
                src_sum += s1
                dst_sum += s2
            if done % 20 == 0 or done == len(items):
                print("  进度 %3d/%d  新转:%d 跳过:%d 失败:%d"
                      % (done, len(items), stat["ok"], stat["skip"], stat["fail"]))

    # 汇总全部输出体积
    total_out = 0
    for _, year in year_dirs():
        d = os.path.join(ROOT, "audio", year)
        if os.path.isdir(d):
            total_out += sum(os.path.getsize(os.path.join(d, f))
                            for f in os.listdir(d) if f.lower().endswith(".mp3"))
    print("-" * 62)
    print("本次: 新转 %d / 跳过 %d / 失败 %d，耗时 %.1fs"
          % (stat["ok"], stat["skip"], stat["fail"], time.time() - t0))
    if src_sum:
        print("本次转码: %s -> %s (压缩到 %.1f%%)"
              % (human(src_sum), human(dst_sum), 100.0 * dst_sum / src_sum))
    print("audio/ 总体积: %s" % human(total_out))
    if fails:
        print("失败文件:")
        for f in fails[:20]:
            print("  !", os.path.relpath(f, ROOT))
        sys.exit(1)


if __name__ == "__main__":
    main()
