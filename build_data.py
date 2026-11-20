# -*- coding: utf-8 -*-
"""
BBC 6 Minute English -> 结构化课程数据生成器
从各年份目录的 MANIFEST.csv 读取清单，用 PyMuPDF 按字体解析 transcript PDF，
输出 data/episodes.js (内嵌 JS，file:// 可直接打开) 与 data/episodes.json。

年份目录自动发现：新增 6-minute-english_YYYY/ 并放入 MANIFEST.csv 后，
重跑本脚本即可纳入，无需修改代码。
音频字段指向 audio/YYYY/ 下的压缩版；原始 MP3 路径保留在 audioLocal。
"""
import csv
import datetime
import json
import os
import re
import sys
from collections import Counter

import pymupdf

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = "6-minute-english_"
AUDIO_WEB_DIR = "audio"
OUT_DIR = os.path.join(ROOT, "data")


def find_years():
    """动态发现年份目录，新增年份资料后无需改代码。"""
    years = []
    for name in sorted(os.listdir(ROOT)):
        if not name.startswith(PREFIX):
            continue
        y = name[len(PREFIX):]
        if y.isdigit() and os.path.isfile(
                os.path.join(ROOT, name, "MANIFEST.csv")):
            years.append(int(y))
    return years


YEARS = find_years()

NOISE_EXACT = {
    "6 Minute English",
    "6 Minute English worksheet",
    "BBC LEARNING ENGLISH",
    "VOCABULARY",
    "This is not a word-for-word transcript",
    "This is not a word-for-word transcript.",
}
NOISE_PREFIX = (
    "©British Broadcasting Corporation",
    "© British Broadcasting Corporation",
    "bbclearningenglish.com",
    "Page ",
)


def clean(s):
    return s.replace("\u00a0", " ").strip()


def line_items(page):
    """把一页拆成 (font_size, is_bold, text, bold_spans) 的行序列。"""
    out = []
    for block in page.get_text("dict")["blocks"]:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            spans = [s for s in line["spans"] if clean(s["text"])]
            if not spans:
                continue
            first = spans[0]
            txt = clean(" ".join(clean(s["text"]) for s in spans))
            if not txt:
                continue
            out.append({
                "size": round(first["size"], 1),
                "bold": "Bold" in first["font"],
                "text": txt,
                "boldSpans": [clean(s["text"]) for s in spans
                              if "Bold" in s["font"] and clean(s["text"])],
            })
    return out


def join_lines(lines):
    """把被 PDF 硬换行拆开的台词重新拼成段落。"""
    parts = []
    for t in lines:
        t = t.strip()
        if not t:
            continue
        if t.endswith("-"):
            parts.append(t[:-1])
        else:
            parts.append(t)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def parse_transcript(path):
    """返回 (pdf_title, dialogue, vocab, inline_vocab, stats)"""
    doc = pymupdf.open(path)
    dialogue = []          # [{s: speaker, t: text}]
    vocab = []             # [{term, def}]
    pdf_title = ""
    speaker = None
    buf = []
    v_term = None
    v_buf = []
    mode = "dialogue"      # dialogue | vocab
    fonts = Counter()
    bold_terms = []        # 对话中加粗的重点词（用于无独立词表的变体排版）
    speakers = []

    for page in doc:
        for it in line_items(page):
            size, bold, text = it["size"], it["bold"], it["text"]
            fonts[(size, bold)] += 1

            # 封面大标题
            if size >= 18 and text not in NOISE_EXACT and not text.startswith("BBC LEARNING"):
                if not text.startswith("6 Minute English"):
                    pdf_title = text
                continue

            # 页眉页脚（10.x 号字）
            if size < 11.5:
                continue

            # 词汇表标题：VOCABULARY / Vocabulary（不区分大小写）
            if bold and text.strip().upper() == "VOCABULARY":
                if speaker is not None and buf:
                    dialogue.append({"s": speaker, "t": join_lines(buf)})
                    speaker, buf = None, []
                if v_term is not None and v_buf:
                    vocab.append({"term": v_term, "def": join_lines(v_buf)})
                    v_term, v_buf = None, []
                mode = "vocab"
                continue

            if text in NOISE_EXACT or text.startswith(NOISE_PREFIX):
                continue

            if mode == "dialogue":
                if bold and len(text) < 60 and not re.search(r"[.!?,:;]", text):
                    # 新的说话人
                    if speaker is not None and buf:
                        dialogue.append({"s": speaker, "t": join_lines(buf)})
                    speaker, buf = text, []
                    if speaker not in speakers:
                        speakers.append(speaker)
                else:
                    if speaker is not None:
                        buf.append(text)
                    for bs in it["boldSpans"]:
                        if len(bs) < 60 and bs.strip().upper() != "VOCABULARY":
                            bold_terms.append(bs)
            else:
                if bold and len(text) < 90:
                    if v_term is not None and v_buf:
                        vocab.append({"term": v_term, "def": join_lines(v_buf)})
                    v_term, v_buf = text, []
                else:
                    if v_term is not None:
                        v_buf.append(text)

    if speaker is not None and buf:
        dialogue.append({"s": speaker, "t": join_lines(buf)})
    if v_term is not None and v_buf:
        vocab.append({"term": v_term, "def": join_lines(v_buf)})

    # 无独立词表时，用对话中的加粗词作为「本集重点表达」
    inline_vocab = []
    if not vocab:
        seen = set()
        for t in bold_terms:
            t = t.strip()
            key = t.lower()
            if (not t or key in seen or t in speakers
                    or len(t) > 55 or re.search(r"[.!?]$", t)
                    or key in {"6 minute english", "bbc learning english"}):
                continue
            seen.add(key)
            inline_vocab.append(t)

    doc.close()
    return pdf_title, dialogue, vocab, inline_vocab, fonts


def read_manifest(year):
    d = "%s%d" % (PREFIX, year)
    path = os.path.join(ROOT, d, "MANIFEST.csv")
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return d, rows


def resolve(directory, filename):
    if not filename:
        return None
    filename = filename.strip()
    p = os.path.join(ROOT, directory, filename)
    return directory + "/" + filename if os.path.isfile(p) else None


def main():
    if not YEARS:
        print("未发现任何 %sYYYY/MANIFEST.csv，退出。" % PREFIX)
        sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    episodes = []
    problems = []
    font_summary = Counter()

    for year in YEARS:
        directory, rows = read_manifest(year)
        files = os.listdir(os.path.join(ROOT, directory))
        pdfs = [f for f in files if f.lower().endswith(".pdf")]
        mp3s = [f for f in files if f.lower().endswith(".mp3")]

        for r in rows:
            ep = (r.get("episode") or "").strip()
            if not ep:
                continue
            title = (r.get("title") or "").strip()
            date = "20%s-%s-%s" % (ep[:2], ep[2:4], ep[4:6])

            transcript = resolve(directory, r.get("transcript"))
            audio_local = resolve(directory, r.get("audio"))
            worksheet = resolve(directory, r.get("worksheet"))

            # 站点使用 audio/YYYY/ 下的压缩版；原始 1.9G 大文件不上传。
            # 压缩版缺失时回退到本地原始路径并报警，避免线上引用失效。
            audio = audio_local
            if audio_local:
                web = "%s/%d/%s" % (AUDIO_WEB_DIR, year,
                                    os.path.basename(audio_local))
                if os.path.isfile(os.path.join(ROOT, web)):
                    audio = web
                else:
                    problems.append(
                        "%s 缺少压缩音频，请先运行 compress_audio.py: %s"
                        % (ep, web))

            # worksheet 兜底：按集号在磁盘上找 *_worksheet*.pdf
            if not worksheet:
                cand = [f for f in pdfs
                        if f.startswith(ep) and "worksheet" in f.lower()]
                if cand:
                    worksheet = directory + "/" + sorted(cand)[0]

            # transcript 兜底：按集号找非 worksheet 的 pdf
            if not transcript:
                cand = [f for f in pdfs
                        if f.startswith(ep) and "worksheet" not in f.lower()
                        and "transcript" in f.lower()]
                if not cand:
                    cand = [f for f in pdfs
                            if f.startswith(ep) and "worksheet" not in f.lower()]
                if cand:
                    transcript = directory + "/" + sorted(cand)[0]

            pdf_title, dialogue, vocab, inline_vocab, fonts = "", [], [], [], Counter()
            if transcript:
                try:
                    pdf_title, dialogue, vocab, inline_vocab, fonts = parse_transcript(
                        os.path.join(ROOT, transcript))
                except Exception as e:
                    problems.append("%s PDF 解析失败: %s" % (ep, e))
            if not dialogue:
                problems.append("%s 未提取到对话" % ep)
            if not vocab and not inline_vocab:
                problems.append("%s 未提取到词汇" % ep)
            if not audio:
                problems.append("%s 缺少音频" % ep)
            if not transcript:
                problems.append("%s 缺少 transcript PDF" % ep)

            font_summary.update(fonts)
            speakers = []
            for seg in dialogue:
                if seg["s"] not in speakers:
                    speakers.append(seg["s"])

            episodes.append({
                "id": ep,
                "year": year,
                "date": date,
                "title": title,
                "pdfTitle": pdf_title,
                "page": (r.get("page") or "").strip(),
                "audio": audio,
                "audioLocal": audio_local,
                "transcript": transcript,
                "worksheet": worksheet,
                "speakers": speakers,
                "dialogue": dialogue,
                "vocab": vocab,
                "inlineVocab": inline_vocab,
                "words": sum(len(x["t"].split()) for x in dialogue),
            })

    episodes.sort(key=lambda e: e["id"], reverse=True)

    meta = {
        "generated": datetime.date.today().isoformat(),
        "source": "BBC Learning English — 6 Minute English",
        "total": len(episodes),
        "years": YEARS,
        "audioWebCount": sum(1 for e in episodes
                             if e["audio"] and e["audio"].startswith(AUDIO_WEB_DIR + "/")),
        "withWorksheet": sum(1 for e in episodes if e["worksheet"]),
        "vocabCount": sum(len(e["vocab"]) for e in episodes),
        "inlineVocabCount": sum(len(e["inlineVocab"]) for e in episodes),
        "noVocabEpisodes": sum(1 for e in episodes
                               if not e["vocab"] and not e["inlineVocab"]),
        "dialogueSegments": sum(len(e["dialogue"]) for e in episodes),
    }
    payload = {"meta": meta, "episodes": episodes}

    with open(os.path.join(OUT_DIR, "episodes.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT_DIR, "episodes.js"), "w", encoding="utf-8") as f:
        f.write("/* 自动生成，请勿手工编辑。运行 build_data.py 重新生成。 */\n")
        f.write("window.BBC_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    # 报告
    print("=" * 62)
    print("总集数: %d | 词汇: %d | 对话段: %d | 含练习册: %d"
          % (meta["total"], meta["vocabCount"],
             meta["dialogueSegments"], meta["withWorksheet"]))
    for y in YEARS:
        sub = [e for e in episodes if e["year"] == y]
        print("  %d: %2d 集, 对话 %4d 段, 词汇 %4d 条, 练习册 %2d 份"
              % (y, len(sub), sum(len(e["dialogue"]) for e in sub),
                 sum(len(e["vocab"]) for e in sub),
                 sum(1 for e in sub if e["worksheet"])))
    print("-" * 62)
    print("字体分布(前8):", font_summary.most_common(8))
    print("线上压缩音频: %d / %d" % (meta["audioWebCount"], meta["total"]))
    print("异常数: %d" % len(problems))
    for p in problems[:40]:
        print("  !", p)
    print("输出: data/episodes.js (%.1f KB)"
          % (os.path.getsize(os.path.join(OUT_DIR, "episodes.js")) / 1024))


if __name__ == "__main__":
    main()
