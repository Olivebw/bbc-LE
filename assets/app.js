/* BBC 6 Minute English 学习库 — 应用逻辑（无框架，file:// 可直接运行） */
(function () {
  'use strict';

  var DATA = window.BBC_DATA;
  var EPISODES = DATA.episodes;
  var META = DATA.meta;
  var BY_ID = {};
  EPISODES.forEach(function (e, i) { BY_ID[e.id] = e; e._i = i; });

  /* ---------------- 本地存储 ---------------- */
  var K_PROGRESS = 'bbc6.progress.v1';
  var K_WORDS = 'bbc6.words.v1';
  var K_TRANS = 'bbc6.trans.v1';      // 段落译文缓存（可手动修正）
  var K_DICT = 'bbc6.dict.v1';        // 词典查询缓存
  var K_SETTINGS = 'bbc6.settings.v1';
  function load(k, def) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var progress = load(K_PROGRESS, {});
  var myWords = load(K_WORDS, []);       // 大写归一化的词条 key 数组
  var transCache = load(K_TRANS, {});
  var dictCache = load(K_DICT, {});
  var settings = load(K_SETTINGS, { follow: true, headSec: 8 });
  function wordKey(t) { return String(t).toLowerCase().trim(); }
  function isStar(wk) { return myWords.indexOf(wk) >= 0; }
  function transKey(ep, i) { return ep + ':' + i; }
  function bump(id, patch) {
    var p = progress[id] || {};
    for (var k in patch) p[k] = patch[k];
    p.at = Date.now();
    progress[id] = p;
    save(K_PROGRESS, progress);
  }

  /* ---------------- 索引 ---------------- */
  var ALL_VOCAB = [];
  EPISODES.forEach(function (e) {
    (e.vocab || []).forEach(function (v) {
      ALL_VOCAB.push({ term: v.term, def: v.def, ep: e.id, title: e.title, date: e.date, year: e.year, inline: false });
    });
    (e.inlineVocab || []).forEach(function (t) {
      ALL_VOCAB.push({ term: t, def: '', ep: e.id, title: e.title, date: e.date, year: e.year, inline: true });
    });
    e._search = [
      e.id, e.title, e.pdfTitle, e.date, (e.speakers || []).join(' '),
      (e.dialogue || []).map(function (d) { return d.t; }).join(' '),
      (e.vocab || []).map(function (v) { return v.term + ' ' + v.def; }).join(' '),
      (e.inlineVocab || []).join(' ')
    ].join(' ').toLowerCase();
  });
  var VOCAB_SEARCH = ALL_VOCAB.map(function (v) {
    return (v.term + ' ' + v.def + ' ' + v.title + ' ' + v.year).toLowerCase();
  });

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function asset(p) { return p ? encodeURI(p) : ''; }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtDate(d) { return d ? d.slice(0, 4) + '.' + d.slice(5, 7) + '.' + d.slice(8, 10) : ''; }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }
  var ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="m12 17.3-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>'
  };
  function speakerColor(name) {
    var palette = ['#bb1919', '#2f6da8', '#7a52a8', '#2f8a63', '#c47a1c', '#b8477d', '#3d8a9c', '#6b6bb5'];
    var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  /* ---------------- 分词 / 在线词典 / 翻译 ----------------
     词典与翻译走免 Key 公共接口并缓存到 localStorage；
     离线时查词与翻译不可用，但生词本、朗读、音频、文稿均不受影响。      */
  var DICT_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
  var TRANS_API = 'https://api.mymemory.translated.net/get?q=';

  function tokenize(text) {
    return String(text).split(/([A-Za-z][A-Za-z'\u2019\-]*)/g).map(function (part) {
      if (!part) return '';
      if (/^[A-Za-z][A-Za-z'\u2019\-]*$/.test(part)) {
        return '<span class="w" data-word="' + esc(wordKey(part)) + '">' + esc(part) + '</span>';
      }
      return esc(part);
    }).join('');
  }
  function fetchJSON(url, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('请求超时')); }
      }, ms || 12000);
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(j);
      }).catch(function (err) {
        if (done) return;
        done = true; clearTimeout(timer); reject(err);
      });
    });
  }
  function splitForTranslate(text, max) {
    var sents = String(text).match(/[^.!?]+[.!?]?\s*/g) || [String(text)];
    var chunks = [], cur = '';
    sents.forEach(function (s) {
      if ((cur + s).length > (max || 420) && cur) { chunks.push(cur); cur = s; }
      else cur += s;
    });
    if (cur.trim()) chunks.push(cur);
    return chunks.length ? chunks : [String(text)];
  }
  function translateEn2Zh(text) {
    var chunks = splitForTranslate(text);
    return chunks.reduce(function (chain, c) {
      return chain.then(function (acc) {
        return fetchJSON(TRANS_API + encodeURIComponent(c) + '&langpair=en%7Czh-CN')
          .then(function (j) {
            if (!j || !j.responseData || !j.responseData.translatedText)
              throw new Error('翻译服务未返回译文');
            if (j.responseStatus && j.responseStatus !== 200 && j.responseStatus !== '200')
              throw new Error(j.responseDetails || '翻译额度不足');
            return acc + j.responseData.translatedText;
          });
      });
    }, Promise.resolve(''));
  }
  function dictLookup(word) {
    var wk = wordKey(word);
    if (dictCache[wk]) return Promise.resolve(dictCache[wk]);
    return fetchJSON(DICT_API + encodeURIComponent(wk.replace(/'/g, ''))).then(function (j) {
      var item = Array.isArray(j) ? j[0] : null;
      if (!item) throw new Error('词典未收录该词');
      var phonetic = item.phonetic || '', audioUrl = '';
      (item.phonetics || []).some(function (p) {
        if (!phonetic && p.text) phonetic = p.text;
        if (p.audio) { audioUrl = p.audio; return true; }
        return false;
      });
      if (audioUrl && audioUrl.indexOf('//') === 0) audioUrl = 'https:' + audioUrl;
      var out = {
        word: item.word || word,
        phonetic: phonetic,
        audio: audioUrl,
        meanings: (item.meanings || []).slice(0, 3).map(function (m) {
          return { pos: m.partOfSpeech || '', defs: (m.definitions || []).slice(0, 2).map(function (d) { return d.definition; }) };
        })
      };
      dictCache[wk] = out; save(K_DICT, dictCache);
      return out;
    });
  }

  /* 词典浮层 */
  function closeDict() {
    var pop = document.getElementById('dictPop');
    if (pop) { pop.classList.add('hidden'); pop.innerHTML = ''; }
  }
  function positionDict(anchor) {
    var pop = document.getElementById('dictPop');
    if (!pop || !anchor || !anchor.getBoundingClientRect) return;
    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth || 330, ph = pop.offsetHeight || 250;
    var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    var left = Math.max(12, Math.min(r.left, vw - pw - 12));
    var top = r.bottom + 8;
    if (top + ph > vh - 12) top = Math.max(12, r.top - ph - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function openDict(word, anchor) {
    var pop = document.getElementById('dictPop');
    if (!pop) return;
    pop.innerHTML = '<div class="dict-head"><span class="dict-word">' + esc(word) +
      '</span><button class="dict-close" data-action="dict-close" aria-label="关闭">×</button></div>' +
      '<div class="dict-loading">正在查询词典…</div>';
    pop.classList.remove('hidden');
    positionDict(anchor);
    dictLookup(word).then(function (d) {
      if (!pop.classList.contains('hidden')) renderDict(d, word, anchor);
    }).catch(function (err) {
      if (pop.classList.contains('hidden')) return;
      var starred = isStar(wordKey(word));
      pop.innerHTML = '<div class="dict-head"><span class="dict-word">' + esc(word) +
        '</span><button class="dict-close" data-action="dict-close" aria-label="关闭">×</button></div>' +
        '<div class="dict-err">词典查询失败：' + esc(err.message || '网络不可用') +
        '<br>仍可加入生词本，联网后重试查询。</div>' +
        '<div class="dict-actions"><button class="btn sm' + (starred ? ' on' : '') +
        '" data-action="star-word" data-w="' + esc(word) + '">' +
        (starred ? '已在生词本' : '加入生词本') + '</button></div>';
      positionDict(anchor);
    });
  }
  function renderDict(d, word, anchor) {
    var pop = document.getElementById('dictPop');
    var starred = isStar(wordKey(word));
    var h = '<div class="dict-head"><span class="dict-word">' + esc(d.word || word) +
      '</span><button class="dict-close" data-action="dict-close" aria-label="关闭">×</button></div>';
    if (d.phonetic || d.audio) {
      h += '<div class="dict-phon">' + esc(d.phonetic || '') +
        (d.audio ? ' <button class="dict-audio" data-action="dict-speak" data-src="' + esc(d.audio) + '">发音</button>' : '') +
        '</div>';
    }
    h += '<div class="dict-body">';
    (d.meanings || []).forEach(function (m) {
      h += '<div class="dict-pos">' + esc(m.pos) + '</div><ul class="dict-defs">';
      (m.defs || []).forEach(function (x) { h += '<li>' + esc(x) + '</li>'; });
      h += '</ul>';
    });
    h += '</div><div id="dictCn" class="dict-cn"></div>' +
      '<div class="dict-actions">' +
      '<button class="btn sm' + (starred ? ' on' : '') + '" data-action="star-word" data-w="' + esc(word) + '">' +
      (starred ? '已在生词本' : '加入生词本') + '</button>' +
      '<button class="btn sm" data-action="dict-trans" data-w="' + esc(word) + '">中文释义</button>' +
      '</div>';
    pop.innerHTML = h;
    positionDict(anchor || pop);
  }

  /* ---------------- 路由 ---------------- */
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').filter(Boolean);
    if (parts[0] === 'ep' && parts[1]) return { name: 'episode', id: parts[1] };
    if (parts[0] === 'vocab') return { name: 'vocab' };
    if (parts[0] === 'stats') return { name: 'stats' };
    return { name: 'library' };
  }
  function routeKey(r) { return r.name + (r.id || ''); }
  var lastRouteKey = '';

  var lib = { year: 'all', status: 'all', q: '', sort: 'new', page: 1, per: 24 };
  var vocabState = { tab: 'all', q: '', page: 1, per: 30 };
  var epTab = 'dialogue';
  var maskLines = false;
  var maskDefs = false;
  var quiz = { active: false, list: [], i: 0, show: false, known: 0, again: 0, scope: 'all' };

  function updateNav(name) {
    var map = { library: 'library', episode: 'library', vocab: 'vocab', stats: 'stats' };
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) {
      a.classList.toggle('active', a.dataset.nav === map[name]);
    });
  }
  function learnedCount() {
    return Object.keys(progress).filter(function (k) { return progress[k] && progress[k].learned; }).length;
  }
  function updateTopStatus() {
    var el = document.getElementById('topStatus');
    el.innerHTML = '已学 <b>' + learnedCount() + '</b> / ' + META.total + ' 集 · 生词 <b>' + myWords.length + '</b>';
  }

  /* ---------------- 音频播放器 ---------------- */
  var audio = document.getElementById('audioEl');
  var dock = document.getElementById('dock');
  var currentEpId = null;
  var pendingPos = 0;
  var rates = [0.75, 1, 1.25, 1.5, 2];
  var rateIdx = 1;
  var saveTick = 0;

  /* 音频—文本跟随：原始资料无时间轴字幕，按段落词数估算，可校准片头偏移 */
  var timelineCache = {};
  var lastFollowIdx = -1;
  var userScrollAt = 0;
  var autoScrolling = false;
  function getTimeline(ep) {
    if (!ep) return [];
    if (timelineCache[ep.id]) return timelineCache[ep.id];
    var weights = (ep.dialogue || []).map(function (d) {
      return Math.max(1, String(d.t).split(/\s+/).length);
    });
    var total = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    var acc = 0;
    var tl = weights.map(function (w) { var s = acc / total; acc += w; return [s, acc / total]; });
    timelineCache[ep.id] = tl;
    return tl;
  }
  function clearFollowHighlight() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg.active'), function (s) {
      s.classList.remove('active');
    });
    lastFollowIdx = -1;
    var now = document.getElementById('followNow');
    if (now) now.textContent = '';
  }
  function followAudio(force) {
    var r = parseRoute();
    if (r.name !== 'episode' || r.id !== currentEpId || epTab !== 'dialogue') return;
    if (!settings.follow && !force) { clearFollowHighlight(); return; }
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    var head = Math.min(settings.headSec || 0, d * 0.2);
    var pr = (audio.currentTime - head) / Math.max(1, d - head);
    pr = Math.max(0, Math.min(0.999999, pr));
    var tl = getTimeline(BY_ID[r.id]);
    if (!tl.length) return;
    var idx = tl.length - 1;
    for (var i = 0; i < tl.length; i++) { if (pr < tl[i][1]) { idx = i; break; } }
    var segs = document.querySelectorAll('.seg');
    if (!segs.length) return;
    if (idx !== lastFollowIdx || force) {
      Array.prototype.forEach.call(segs, function (s, k) { s.classList.toggle('active', k === idx); });
      lastFollowIdx = idx;
      var now = document.getElementById('followNow');
      if (now) now.textContent = '跟读定位：第 ' + (idx + 1) + ' / ' + tl.length + ' 段';
      if (settings.follow && Date.now() - userScrollAt > 5000 && segs[idx].scrollIntoView) {
        autoScrolling = true;
        try { segs[idx].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        setTimeout(function () { autoScrolling = false; }, 800);
      }
    }
  }
  window.addEventListener('scroll', function () {
    if (!autoScrolling) { userScrollAt = Date.now(); closeDict(); }
  }, { passive: true });
  window.addEventListener('wheel', function () { userScrollAt = Date.now(); }, { passive: true });
  window.addEventListener('touchmove', function () { userScrollAt = Date.now(); }, { passive: true });

  function renderDock(ep) {
    document.getElementById('dockTitle').textContent = ep.id + ' · ' + ep.title;
    document.getElementById('dockTitle').setAttribute('href', '#/ep/' + ep.id);
  }
  function setPlayIcon(playing) {
    document.getElementById('iconPlay').classList.toggle('hidden', playing);
    document.getElementById('iconPause').classList.toggle('hidden', !playing);
  }
  function playEpisode(id, restart) {
    var ep = BY_ID[id];
    if (!ep || !ep.audio) { toast('本集缺少音频文件'); return; }
    var changed = currentEpId !== id;
    if (changed) {
      currentEpId = id;
      pendingPos = restart ? 0 : (progress[id] && progress[id].pos) || 0;
      audio.src = asset(ep.audio);
      audio.load();
      var onMeta = function () {
        if (pendingPos > 0 && isFinite(audio.duration)) {
          try { audio.currentTime = Math.min(pendingPos, Math.max(0, audio.duration - 1)); } catch (e) {}
        }
        audio.removeEventListener('loadedmetadata', onMeta);
      };
      audio.addEventListener('loadedmetadata', onMeta);
      renderDock(ep);
    }
    dock.classList.remove('hidden');
    audio.playbackRate = rates[rateIdx];
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () { toast('无法播放音频，请检查文件是否存在'); });
    bump(id, {});
    updateTopStatus();
  }
  function togglePlay() {
    if (!currentEpId) return;
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  }
  function closeDock() {
    audio.pause();
    if (currentEpId) bump(currentEpId, { pos: audio.currentTime || 0 });
    dock.classList.add('hidden');
    currentEpId = null;
    clearFollowHighlight();
    audio.removeAttribute('src'); audio.load();
  }
  function updateSeek() {
    var d = audio.duration || 0, c = audio.currentTime || 0;
    var pct = d ? (c / d * 100) : 0;
    var seek = document.getElementById('seek');
    seek.value = pct;
    seek.style.setProperty('--p', pct + '%');
    document.getElementById('timeNow').textContent = fmtTime(c);
    document.getElementById('timeTotal').textContent = d ? fmtTime(d) : '0:00';
  }
  audio.addEventListener('play', function () { setPlayIcon(true); });
  audio.addEventListener('pause', function () {
    setPlayIcon(false);
    if (currentEpId) bump(currentEpId, { pos: audio.currentTime || 0 });
  });
  audio.addEventListener('timeupdate', function () {
    updateSeek();
    followAudio(false);
    if (Date.now() - saveTick > 4000) {
      saveTick = Date.now();
      if (currentEpId) bump(currentEpId, { pos: audio.currentTime || 0 });
    }
  });
  audio.addEventListener('loadedmetadata', function () { updateSeek(); followAudio(true); });
  audio.addEventListener('seeked', function () { followAudio(true); });
  audio.addEventListener('ended', function () {
    if (!currentEpId) return;
    bump(currentEpId, { pos: 0, learned: true });
    updateTopStatus();
    toast('本集已听完，已标记为「已学」');
    var r = parseRoute();
    if (r.name === 'episode' && r.id === currentEpId) render();
  });
  document.getElementById('btnPlay').addEventListener('click', togglePlay);
  document.getElementById('btnBack').addEventListener('click', function () { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  document.getElementById('btnFwd').addEventListener('click', function () { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); });
  document.getElementById('seek').addEventListener('input', function () {
    if (audio.duration) audio.currentTime = audio.duration * (this.value / 100);
  });
  document.getElementById('btnRate').addEventListener('click', function () {
    rateIdx = (rateIdx + 1) % rates.length;
    audio.playbackRate = rates[rateIdx];
    this.textContent = rates[rateIdx].toFixed(2).replace(/0$/, '') + 'x';
  });
  document.getElementById('btnCloseDock').addEventListener('click', closeDock);
  document.addEventListener('keydown', function (e) {
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    if (e.code === 'Space' && currentEpId) { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft' && currentEpId) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
    if (e.code === 'ArrowRight' && currentEpId) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
  });

  /* ---------------- 课程库 ---------------- */
  function filterEpisodes() {
    var q = lib.q.trim().toLowerCase();
    var out = EPISODES.filter(function (e) {
      if (lib.year !== 'all' && e.year !== +lib.year) return false;
      var p = progress[e.id] || {};
      if (lib.status === 'learned' && !p.learned) return false;
      if (lib.status === 'unlearned' && p.learned) return false;
      if (lib.status === 'fav' && !p.fav) return false;
      if (q && e._search.indexOf(q) < 0) return false;
      return true;
    });
    if (lib.sort === 'old') out = out.slice().reverse();
    return out;
  }
  function epCard(e) {
    var p = progress[e.id] || {};
    var tags = '<span class="tag">' + e.vocab.length + ' 词汇</span>';
    if (e.worksheet) tags += '<span class="tag green">练习册</span>';
    if (e.inlineVocab && e.inlineVocab.length) tags += '<span class="tag">内嵌词表</span>';
    return '<article class="ep-card' + (p.learned ? ' learned' : '') + '">' +
      '<div class="ep-meta"><span>EP ' + esc(e.id) + '</span><span class="dot"></span><span>' + fmtDate(e.date) + '</span><span class="dot"></span><span>' + e.year + '</span></div>' +
      '<a href="#/ep/' + e.id + '"><h3>' + esc(e.title) + '</h3></a>' +
      '<div class="ep-sub">' + esc((e.speakers || []).slice(0, 4).join(' · ')) + '</div>' +
      '<div class="ep-foot">' + tags +
        '<div class="ep-actions">' +
          '<button class="mini-btn" data-action="quick-play" data-id="' + e.id + '" title="播放本集">' + ICON.play + '</button>' +
          '<button class="mini-btn' + (p.fav ? ' active' : '') + '" data-action="toggle-fav" data-id="' + e.id + '" title="收藏">' + ICON.star + '</button>' +
          '<button class="mini-btn' + (p.learned ? ' active ok' : '') + '" data-action="toggle-learned" data-id="' + e.id + '" title="标记已学">' + ICON.check + '</button>' +
        '</div>' +
      '</div></article>';
  }
  function pagerHTML(total, page, per) {
    var pages = Math.ceil(total / per) || 1;
    if (pages <= 1) return '';
    var list = [], i;
    if (pages <= 7) { for (i = 1; i <= pages; i++) list.push(i); }
    else {
      var s = Math.max(1, Math.min(page - 3, pages - 6));
      for (i = s; i <= s + 6; i++) list.push(i);
    }
    var h = '<div class="pager">';
    h += '<button data-action="page" data-p="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>';
    list.forEach(function (n) {
      h += '<button data-action="page" data-p="' + n + '" class="' + (n === page ? 'active' : '') + '">' + n + '</button>';
    });
    h += '<button data-action="page" data-p="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
    h += '<span class="pg-info">' + page + ' / ' + pages + ' 页</span></div>';
    return h;
  }
  function renderLibrary() {
    var app = document.getElementById('app');
    app.innerHTML =
      '<div class="page-head"><div class="eyebrow">BBC Learning English</div>' +
      '<h1>6 Minute English 学习库</h1>' +
      '<p>2022—2025 全 ' + META.total + ' 集 · 逐集音频、完整对话文稿、核心词汇与练习册，一站式学习。</p></div>' +
      '<div class="stat-strip">' +
        '<div class="stat-cell"><div class="num">' + META.total + '</div><div class="lbl">课程总集数</div></div>' +
        '<div class="stat-cell"><div class="num">' + META.years.length + '<em>个年份</em></div><div class="lbl">2022 — 2025</div></div>' +
        '<div class="stat-cell"><div class="num">' + META.vocabCount + '</div><div class="lbl">核心词汇与表达</div></div>' +
        '<div class="stat-cell"><div class="num">' + META.withWorksheet + '</div><div class="lbl">配套练习册</div></div>' +
      '</div>' +
      '<div class="filters" id="libFilters">' +
        '<div class="search-box">' + ICON.search + '<input id="libSearch" type="search" placeholder="搜索标题、话题、词汇或对话内容…" value="' + esc(lib.q) + '"></div>' +
        '<div class="tabs" id="yearTabs">' +
          ['all', '2022', '2023', '2024', '2025'].map(function (y) {
            return '<button data-action="year" data-y="' + y + '" class="' + (lib.year === y ? 'active' : '') + '">' + (y === 'all' ? '全部' : y) + '</button>';
          }).join('') +
        '</div>' +
        '<select class="select-sm" id="statusSel">' +
          [['all', '全部状态'], ['unlearned', '未学'], ['learned', '已学'], ['fav', '已收藏']].map(function (o) {
            return '<option value="' + o[0] + '"' + (lib.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select>' +
        '<select class="select-sm" id="sortSel">' +
          [['new', '最新优先'], ['old', '最早优先']].map(function (o) {
            return '<option value="' + o[0] + '"' + (lib.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select>' +
      '</div>' +
      '<div id="libResultLine" class="result-line"></div>' +
      '<div id="libResults"></div><div id="libPager"></div>';
    document.getElementById('libSearch').addEventListener('input', function () {
      lib.q = this.value; lib.page = 1; updateLibraryResults();
    });
    document.getElementById('statusSel').addEventListener('change', function () {
      lib.status = this.value; lib.page = 1; updateLibraryResults();
    });
    document.getElementById('sortSel').addEventListener('change', function () {
      lib.sort = this.value; lib.page = 1; updateLibraryResults();
    });
    updateLibraryResults();
  }
  function updateLibraryResults() {
    var list = filterEpisodes();
    var pages = Math.ceil(list.length / lib.per) || 1;
    if (lib.page > pages) lib.page = pages;
    var start = (lib.page - 1) * lib.per;
    var slice = list.slice(start, start + lib.per);
    var q = lib.q.trim();
    document.getElementById('libResultLine').textContent =
      '共 ' + list.length + ' 集' + (q ? '（搜索「' + q + '」）' : '') + ' · 第 ' + lib.page + ' / ' + pages + ' 页';
    document.getElementById('libResults').innerHTML = slice.length
      ? '<div class="card-grid">' + slice.map(epCard).join('') + '</div>'
      : '<div class="empty"><strong>没有找到匹配的课程</strong>试试更换关键词或筛选条件</div>';
    document.getElementById('libPager').innerHTML = pagerHTML(list.length, lib.page, lib.per);
  }

  /* ---------------- 单集页 ---------------- */
  function renderEpisode(id) {
    var e = BY_ID[id];
    var app = document.getElementById('app');
    if (!e) {
      app.innerHTML = '<div class="page-head"><h1>未找到该集</h1><p><a class="btn" href="#/">返回课程库</a></p></div>';
      return;
    }
    var p = progress[id] || {};
    var older = EPISODES[e._i + 1], newer = EPISODES[e._i - 1];
    var dl = e.dialogue || [];
    app.innerHTML =
      '<div class="crumb"><a href="#/">课程库</a><span>/</span><span>' + e.year + '</span><span>/</span><span>EP ' + e.id + '</span></div>' +
      '<div class="ep-hero">' +
        '<div class="kicker"><span class="tag red">EP ' + esc(e.id) + '</span><span>' + fmtDate(e.date) + '</span><span>·</span><span>' + e.year + ' 年</span></div>' +
        '<h1>' + esc(e.title) + '</h1>' +
        (e.pdfTitle && e.pdfTitle.toLowerCase() !== e.title.toLowerCase()
          ? '<div class="pdf-title">' + esc(e.pdfTitle) + '</div>' : '') +
        '<div class="hero-actions">' +
          '<button class="btn primary" data-action="play" data-id="' + e.id + '">播放本集音频</button>' +
          '<button class="btn' + (p.learned ? ' on' : '') + '" data-action="toggle-learned" data-id="' + e.id + '">' + (p.learned ? '已学 ✓' : '标记已学') + '</button>' +
          '<button class="btn' + (p.fav ? ' on' : '') + '" data-action="toggle-fav" data-id="' + e.id + '">' + (p.fav ? '已收藏' : '收藏') + '</button>' +
          (e.page ? '<a class="btn ghost" href="' + esc(e.page) + '" target="_blank" rel="noopener">BBC 原页面 ↗</a>' : '') +
        '</div>' +
        '<div class="hero-stats">' +
          '<span>主持人 / 嘉宾：<b>' + esc((e.speakers || []).join('、')) + '</b></span>' +
          '<span>对话：<b>' + dl.length + ' 段 / ' + e.words + ' 词</b></span>' +
          '<span>核心词汇：<b>' + e.vocab.length + ' 条</b></span>' +
          '<span>练习册：<b>' + (e.worksheet ? '有' : '无') + '</b></span>' +
          (p.pos ? '<span>上次播放到：<b>' + fmtTime(p.pos) + '</b></span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="tabbar" id="epTabs">' +
        [['dialogue', '对话原文', dl.length], ['vocab', '核心词汇', e.vocab.length + (e.inlineVocab || []).length],
         ['docs', '文稿与练习', (e.transcript ? 1 : 0) + (e.worksheet ? 1 : 0)]].map(function (t) {
          return '<button data-action="ep-tab" data-t="' + t[0] + '" class="' + (epTab === t[0] ? 'active' : '') + '">' + t[1] + '<span class="count">' + t[2] + '</span></button>';
        }).join('') +
      '</div>' +
      '<div id="epTabContent"></div>' +
      '<div class="ep-nav">' +
        (older ? '<a href="#/ep/' + older.id + '"><span>← 更早一集</span><strong>' + esc(older.title) + '</strong></a>' : '<span></span>') +
        (newer ? '<a class="next" href="#/ep/' + newer.id + '"><span>更晚一集 →</span><strong>' + esc(newer.title) + '</strong></a>' : '<span></span>') +
      '</div>';
    renderEpTab(e);
    bump(id, {});
  }

  function renderEpTab(e) {
    var box = document.getElementById('epTabContent');
    if (!box) return;
    if (epTab === 'dialogue') {
      var rows = (e.dialogue || []).map(function (d, i) {
        var cached = transCache[transKey(e.id, i)];
        return '<div class="seg" data-i="' + i + '">' +
          '<div class="who"><i style="background:' + speakerColor(d.s) + '"></i>' + esc(d.s) + '</div>' +
          '<div class="seg-main">' +
            '<div class="line' + (maskLines ? ' masked' : '') + '" data-action="reveal">' + tokenize(d.t) + '</div>' +
            '<div class="trans' + (cached ? '' : ' hidden') + '" data-trans="' + i + '">' +
              (cached ? '<span class="trans-label">译文</span><span class="trans-text" data-action="edit-trans" data-i="' + i + '" title="点击可修正译文">' + esc(cached) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="seg-tools">' +
            '<button data-action="play-from" data-i="' + i + '">从此播放</button>' +
            '<button data-action="speak" data-i="' + i + '">朗读</button>' +
            '<button data-action="copy" data-i="' + i + '">复制</button>' +
            '<button data-action="translate-seg" data-i="' + i + '">' + (cached ? '重译' : '翻译') + '</button>' +
          '</div></div>';
      }).join('');
      box.innerHTML =
        '<div class="tool-row">' +
          '<button class="btn sm' + (maskLines ? ' on' : '') + '" data-action="mask-lines">' + (maskLines ? '显示全部台词' : '遮住台词自测') + '</button>' +
          '<button class="btn sm" data-action="stop-speak">停止朗读</button>' +
          '<button class="btn sm" data-action="translate-all" id="btnTransAll">翻译全段</button>' +
          '<button class="btn sm' + (settings.follow ? ' on' : '') + '" data-action="follow-toggle" id="btnFollow">' + (settings.follow ? '跟随滚动：开' : '跟随滚动：关') + '</button>' +
          '<span class="hint">点击单词查词典 · 悬停段落可播放 / 朗读 / 复制 / 翻译</span>' +
          '<span id="transProgress" class="hint"></span>' +
        '</div>' +
        '<div class="follow-bar">' +
          '<span class="fb-title">同步校准</span>' +
          '<label>片头 <input type="range" id="headRange" min="0" max="20" step="1" value="' + settings.headSec + '"> <b id="headVal">' + settings.headSec + 's</b></label>' +
          '<span class="fb-note">按段落词数估算时间轴，声音与高亮错位时调整此处。</span>' +
          '<span id="followNow" class="fb-now"></span>' +
        '</div>' +
        '<div class="dialogue">' + rows + '</div>';
      var hr = document.getElementById('headRange');
      if (hr) hr.addEventListener('input', function () {
        settings.headSec = +this.value;
        save(K_SETTINGS, settings);
        var hv = document.getElementById('headVal');
        if (hv) hv.textContent = settings.headSec + 's';
        timelineCache = {};
        followAudio(true);
      });
      lastFollowIdx = -1;
      followAudio(true);
    } else if (epTab === 'vocab') {
      var cards = (e.vocab || []).map(function (v) {
        var wk = wordKey(v.term);
        return '<div class="v-card"><div class="v-top">' +
          '<div class="term">' + esc(v.term) + '</div>' +
          '<button class="star-btn' + (isStar(wk) ? ' active' : '') + '" data-action="star-word" data-w="' + esc(v.term) + '" title="加入生词本">' + ICON.star + '</button>' +
          '</div><div class="def' + (maskDefs ? ' masked' : '') + '" data-action="reveal-def">' + esc(v.def) + '</div>' +
          '<div class="src">EP ' + e.id + ' · <a href="#/vocab">在词汇本中查看</a></div></div>';
      }).join('');
      var inline = (e.inlineVocab || []).length
        ? '<div class="divider"></div><div class="section-title">本集重点表达</div>' +
          '<div class="note-box">该集采用早期排版，词汇直接内嵌在对话讲解中，没有独立的词汇释义表。以下为文稿中加粗标出的重点词与表达。</div>' +
          '<div class="inline-vocab">' + e.inlineVocab.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>'
        : '';
      box.innerHTML =
        '<div class="tool-row">' +
          '<button class="btn sm' + (maskDefs ? ' on' : '') + '" data-action="mask-defs">' + (maskDefs ? '显示全部释义' : '遮住释义自测') + '</button>' +
          '<span class="hint">点击释义可显示 / 隐藏 · 星标可加入生词本</span>' +
        '</div>' +
        (cards ? '<div class="vocab-grid">' + cards + '</div>' : '') + inline;
    } else {
      var docs = '';
      if (e.transcript) {
        docs += '<div class="doc-card"><h3>完整文稿 Transcript</h3>' +
          '<p>BBC 官方逐字稿 PDF，含完整对话与 VOCABULARY 词汇表。可在下方直接预览，或在新窗口打开 / 下载。</p>' +
          '<div class="doc-actions">' +
            '<button class="btn sm primary" data-action="show-pdf" data-src="' + esc(asset(e.transcript)) + '">内嵌预览</button>' +
            '<a class="btn sm" href="' + esc(asset(e.transcript)) + '" target="_blank" rel="noopener">新窗口打开 ↗</a>' +
            '<a class="btn sm ghost" href="' + esc(asset(e.transcript)) + '" download>下载 PDF</a>' +
          '</div></div>';
      }
      if (e.worksheet) {
        docs += '<div class="doc-card"><h3>配套练习册 Worksheet</h3>' +
          '<p>听前思考、听力任务、词汇练习与答案，适合作为精听后的巩固材料。</p>' +
          '<div class="doc-actions">' +
            '<button class="btn sm primary" data-action="show-pdf" data-src="' + esc(asset(e.worksheet)) + '">内嵌预览</button>' +
            '<a class="btn sm" href="' + esc(asset(e.worksheet)) + '" target="_blank" rel="noopener">新窗口打开 ↗</a>' +
            '<a class="btn sm ghost" href="' + esc(asset(e.worksheet)) + '" download>下载 PDF</a>' +
          '</div></div>';
      }
      if (!docs) docs = '<div class="empty"><strong>本集暂无 PDF 文稿</strong></div>';
      box.innerHTML = '<div class="doc-grid">' + docs + '</div><div id="pdfHolder"></div>';
    }
  }

  /* ---------------- 词汇本 ---------------- */
  function renderVocab() {
    var app = document.getElementById('app');
    app.innerHTML =
      '<div class="page-head"><div class="eyebrow">Vocabulary Bank</div>' +
      '<h1>词汇本</h1>' +
      '<p>全部 ' + ALL_VOCAB.length + ' 条词汇与表达（含 ' + META.vocabCount + ' 条带释义的核心词汇），支持全文检索、生词收藏与自测。</p></div>' +
      '<div class="quiz-box" id="quizBox"></div>' +
      '<div class="filters">' +
        '<div class="search-box">' + ICON.search + '<input id="vocabSearch" type="search" placeholder="搜索单词、释义或所属课程…" value="' + esc(vocabState.q) + '"></div>' +
        '<div class="tabs" id="vocabTabs">' +
          [['all', '全部词汇'], ['mine', '我的生词本 (' + myWords.length + ')']].map(function (t) {
            return '<button data-action="vocab-tab" data-t="' + t[0] + '" class="' + (vocabState.tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div id="vocabResultLine" class="result-line"></div>' +
      '<div id="vocabResults"></div><div id="vocabPager"></div>';
    document.getElementById('vocabSearch').addEventListener('input', function () {
      vocabState.q = this.value; vocabState.page = 1; updateVocabResults();
    });
    renderQuiz();
    updateVocabResults();
  }
  function vocabFiltered() {
    var q = vocabState.q.trim().toLowerCase();
    return ALL_VOCAB.filter(function (v, i) {
      if (vocabState.tab === 'mine' && !isStar(wordKey(v.term))) return false;
      if (q && VOCAB_SEARCH[i].indexOf(q) < 0) return false;
      return true;
    });
  }
  function updateVocabResults() {
    var list = vocabFiltered();
    var pages = Math.ceil(list.length / vocabState.per) || 1;
    if (vocabState.page > pages) vocabState.page = pages;
    var start = (vocabState.page - 1) * vocabState.per;
    var slice = list.slice(start, start + vocabState.per);
    document.getElementById('vocabResultLine').textContent = '共 ' + list.length + ' 条 · 第 ' + vocabState.page + ' / ' + pages + ' 页';
    document.getElementById('vocabResults').innerHTML = slice.length
      ? '<div class="vocab-list">' + slice.map(function (v) {
          var wk = wordKey(v.term);
          return '<div class="v-row"><div class="term">' + esc(v.term) + '</div>' +
            '<div class="def">' + (v.def ? esc(v.def) : '<span class="muted">重点表达（文稿内嵌，无独立释义）</span>') + '</div>' +
            '<div class="src"><a href="#/ep/' + v.ep + '">EP ' + v.ep + ' · ' + esc(v.title) + '</a>' +
            '<button class="star-btn' + (isStar(wk) ? ' active' : '') + '" data-action="star-word" data-w="' + esc(v.term) + '" title="加入生词本">' + ICON.star + '</button></div></div>';
        }).join('') + '</div>'
      : '<div class="empty"><strong>' + (vocabState.tab === 'mine' ? '生词本还是空的' : '没有找到匹配的词汇') + '</strong>' +
        (vocabState.tab === 'mine' ? '在课程页或词汇列表中点击星标即可加入' : '试试更换关键词') + '</div>';
    document.getElementById('vocabPager').innerHTML = pagerHTML(list.length, vocabState.page, vocabState.per);
  }
  function renderQuiz() {
    var box = document.getElementById('quizBox');
    if (!box) return;
    if (!quiz.active) {
      box.innerHTML = '<div class="q-head"><div><h3>词汇自测</h3><div class="muted" style="font-size:12.5px;margin-top:4px">随机抽取 10 条，先看词回忆释义，再翻卡核对。</div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn sm" data-action="quiz-start" data-scope="all">全库抽测</button>' +
        '<button class="btn sm" data-action="quiz-start" data-scope="mine">只测生词本</button></div></div>';
      return;
    }
    if (quiz.i >= quiz.list.length) {
      box.innerHTML = '<div class="q-head"><h3>本轮完成</h3></div>' +
        '<div class="quiz-card"><div class="q-term">认识 ' + quiz.known + ' · 待复习 ' + quiz.again + '</div>' +
        '<div class="q-def">共 ' + quiz.list.length + ' 条词汇</div></div>' +
        '<div class="quiz-actions"><button class="btn primary" data-action="quiz-start" data-scope="' + quiz.scope + '">再来一轮</button>' +
        '<button class="btn" data-action="quiz-exit">结束</button></div>';
      return;
    }
    var v = quiz.list[quiz.i];
    box.innerHTML = '<div class="q-head"><h3>词汇自测</h3><span class="quiz-score">第 ' + (quiz.i + 1) + ' / ' + quiz.list.length +
      ' 题 · 认识 ' + quiz.known + ' · 待复习 ' + quiz.again + '</span></div>' +
      '<div class="quiz-card"><div class="q-term">' + esc(v.term) + '</div>' +
      (quiz.show ? '<div class="q-def">' + (v.def ? esc(v.def) : '重点表达，请回到对应课程的对话中查看用法') + '</div>' : '') +
      '<div class="q-from">EP ' + v.ep + ' · ' + esc(v.title) + '</div></div>' +
      '<div class="quiz-actions">' +
      (quiz.show
        ? '<button class="btn primary" data-action="quiz-answer" data-v="known">认识</button>' +
          '<button class="btn" data-action="quiz-answer" data-v="again">待复习</button>'
        : '<button class="btn primary" data-action="quiz-flip">显示释义</button>') +
      '<button class="btn ghost" data-action="quiz-exit">结束</button></div>';
  }

  /* ---------------- 学习进度 ---------------- */
  function renderStats() {
    var app = document.getElementById('app');
    var learned = learnedCount();
    var favs = Object.keys(progress).filter(function (k) { return progress[k] && progress[k].fav; }).length;
    var recent = Object.keys(progress)
      .filter(function (k) { return progress[k] && progress[k].at; })
      .sort(function (a, b) { return progress[b].at - progress[a].at; }).slice(0, 12);
    var bars = META.years.map(function (y) {
      var all = EPISODES.filter(function (e) { return e.year === y; });
      var done = all.filter(function (e) { return progress[e.id] && progress[e.id].learned; }).length;
      var pct = all.length ? Math.round(done / all.length * 100) : 0;
      return '<div class="bar-row"><div class="bar-top"><span>' + y + ' 年（' + all.length + ' 集）</span><span>' + done + ' / ' + all.length + ' · ' + pct + '%</span></div>' +
        '<div class="bar-track"><div class="bar-fill ok" style="width:' + pct + '%"></div></div></div>';
    }).join('');
    app.innerHTML =
      '<div class="page-head"><div class="eyebrow">My Progress</div><h1>学习进度</h1>' +
      '<p>学习记录保存在本机浏览器（localStorage），不会上传到任何服务器。</p></div>' +
      '<div class="stat-strip">' +
        '<div class="stat-cell"><div class="num">' + learned + '</div><div class="lbl">已学集数</div></div>' +
        '<div class="stat-cell"><div class="num">' + favs + '</div><div class="lbl">收藏课程</div></div>' +
        '<div class="stat-cell"><div class="num">' + myWords.length + '</div><div class="lbl">生词本词条</div></div>' +
        '<div class="stat-cell"><div class="num">' + Math.round(learned / META.total * 100) + '<em>%</em></div><div class="lbl">总完成度</div></div>' +
      '</div>' +
      '<div class="progress-grid">' +
        '<div class="p-card"><h3>按年份完成情况</h3>' + bars + '</div>' +
        '<div class="p-card"><h3>累计学习</h3>' +
          '<div class="big-num">' + learned + '<small>/ ' + META.total + ' 集</small></div>' +
          '<div class="p-sub">按每集约 6 分钟估算，累计听力约 ' + (learned * 6) + ' 分钟。</div>' +
          '<div class="divider"></div>' +
          '<button class="btn sm" data-action="quiz-start" data-scope="mine">用生词本自测</button> ' +
          '<a class="btn sm" href="#/vocab">打开词汇本</a>' +
          '<div class="divider"></div>' +
          '<a class="danger-link" data-action="clear-data" href="javascript:void(0)">清空本机学习记录</a>' +
        '</div>' +
      '</div>' +
      '<div class="p-card"><h3>最近学习</h3>' +
        (recent.length ? '<ul class="recent">' + recent.map(function (id) {
          var e = BY_ID[id], p = progress[id];
          if (!e) return '';
          var d = new Date(p.at);
          var ds = (d.getMonth() + 1) + '/' + d.getDate();
          return '<li><span class="r-date">' + ds + '</span><a href="#/ep/' + id + '">' + esc(e.title) + '</a>' +
            '<span class="tag' + (p.learned ? ' green' : '') + '">' + (p.learned ? '已学' : '学习中') + '</span></li>';
        }).join('') + '</ul>' : '<div class="muted" style="font-size:13.5px">还没有学习记录，去课程库开始第一集吧。</div>') +
      '</div>';
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var r = parseRoute();
    var key = routeKey(r);
    if (key !== lastRouteKey) {
      window.scrollTo(0, 0);
      lastRouteKey = key;
      epTab = 'dialogue'; maskLines = false; maskDefs = false;
    }
    updateNav(r.name);
    updateTopStatus();
    if (r.name === 'episode') renderEpisode(r.id);
    else if (r.name === 'vocab') renderVocab();
    else if (r.name === 'stats') renderStats();
    else renderLibrary();
  }
  window.addEventListener('hashchange', render);

  /* ---------------- 段落翻译 ---------------- */
  function setTrans(ep, i, text) {
    var k = transKey(ep.id, i);
    transCache[k] = text;
    save(K_TRANS, transCache);
    var box = document.querySelector('.seg[data-i="' + i + '"] .trans');
    if (!box) return;
    if (!text) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<span class="trans-label">译文</span>' +
      '<span class="trans-text" data-action="edit-trans" data-i="' + i + '" title="点击可修正译文">' + esc(text) + '</span>';
  }
  function transFail(i, btn, err) {
    if (btn) { btn.disabled = false; btn.textContent = '重试翻译'; }
    var box = document.querySelector('.seg[data-i="' + i + '"] .trans');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = '<span class="trans-label">译文</span>' +
        '<input class="trans-input" data-i="' + i + '" placeholder="联网翻译失败，可手动填写译文后按回车保存">';
    }
    toast('翻译失败：' + (err && err.message ? err.message : '网络不可用'));
  }
  function translateSegment(ep, i, btn, force) {
    if (!ep || !ep.dialogue || !ep.dialogue[i]) return Promise.resolve();
    var k = transKey(ep.id, i);
    if (!force && transCache[k]) { setTrans(ep, i, transCache[k]); return Promise.resolve(); }
    if (btn) { btn.disabled = true; btn.textContent = '翻译中…'; }
    return translateEn2Zh(ep.dialogue[i].t).then(function (t) {
      setTrans(ep, i, t);
      if (btn) { btn.disabled = false; btn.textContent = '重译'; }
    }).catch(function (err) { transFail(i, btn, err); });
  }
  function translateAll(ep) {
    if (!ep) return;
    var idxs = [];
    (ep.dialogue || []).forEach(function (d, i) {
      if (!transCache[transKey(ep.id, i)]) idxs.push(i);
    });
    if (!idxs.length) { toast('本集所有段落已有译文'); return; }
    toast('开始批量翻译，共 ' + idxs.length + ' 段');
    var n = 0;
    function next() {
      if (n >= idxs.length) { toast('批量翻译完成'); return; }
      var i = idxs[n++];
      translateSegment(ep, i, null, false).then(function () {
        var bar = document.getElementById('transProgress');
        if (bar) bar.textContent = '翻译进度 ' + n + ' / ' + idxs.length;
        setTimeout(next, 150);
      });
    }
    next();
  }
  function saveTransInput(ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains('trans-input')) return;
    var r = parseRoute(), ep = BY_ID[r.id], i = +t.dataset.i;
    if (!ep) return;
    var v = t.value.trim();
    setTrans(ep, i, v);
    if (v) toast('译文已保存');
  }
  document.addEventListener('change', saveTransInput);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.classList &&
        ev.target.classList.contains('trans-input')) saveTransInput(ev);
  });

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener('click', function (ev) {
    var tgt = ev.target;
    var wordEl = tgt && tgt.closest ? tgt.closest('.w') : null;
    if (wordEl) {
      var ln = wordEl.closest('.line');
      if (ln && ln.classList.contains('masked')) {
        ln.classList.remove('masked'); ln.classList.add('revealed');
      }
      openDict(wordEl.dataset.word, wordEl);
      return;
    }
    if (!(tgt && tgt.closest && tgt.closest('#dictPop'))) closeDict();
    var el = tgt && tgt.closest ? tgt.closest('[data-action]') : null;
    if (!el) return;
    var a = el.dataset.action, id = el.dataset.id, r = parseRoute();

    switch (a) {
      case 'year':
        lib.year = el.dataset.y; lib.page = 1;
        Array.prototype.forEach.call(document.querySelectorAll('#yearTabs button'), function (b) {
          b.classList.toggle('active', b.dataset.y === lib.year);
        });
        updateLibraryResults(); break;
      case 'page': {
        var p = +el.dataset.p;
        if (r.name === 'vocab') { vocabState.page = p; updateVocabResults(); }
        else { lib.page = p; updateLibraryResults(); }
        window.scrollTo({ top: 220, behavior: 'smooth' });
        break;
      }
      case 'quick-play': playEpisode(id, false); break;
      case 'play': playEpisode(id, false); break;
      case 'toggle-fav': {
        var cur = !!(progress[id] && progress[id].fav);
        bump(id, { fav: !cur });
        toast(!cur ? '已加入收藏' : '已取消收藏');
        render(); break;
      }
      case 'toggle-learned': {
        var c2 = !!(progress[id] && progress[id].learned);
        bump(id, { learned: !c2 });
        toast(!c2 ? '已标记为已学' : '已取消已学标记');
        render(); break;
      }
      case 'ep-tab':
        epTab = el.dataset.t;
        Array.prototype.forEach.call(document.querySelectorAll('#epTabs button'), function (b) {
          b.classList.toggle('active', b.dataset.t === epTab);
        });
        renderEpTab(BY_ID[r.id]); break;
      case 'mask-lines': maskLines = !maskLines; renderEpTab(BY_ID[r.id]); break;
      case 'mask-defs': maskDefs = !maskDefs; renderEpTab(BY_ID[r.id]); break;
      case 'reveal':
        if (el.classList.contains('masked')) { el.classList.remove('masked'); el.classList.add('revealed'); }
        else if (el.classList.contains('revealed')) { el.classList.remove('revealed'); el.classList.add('masked'); }
        break;
      case 'reveal-def':
        if (el.classList.contains('masked')) el.classList.remove('masked');
        else if (maskDefs) el.classList.add('masked');
        break;
      case 'speak': {
        var e2 = BY_ID[r.id], seg = e2 && e2.dialogue[+el.dataset.i];
        if (!seg || !window.speechSynthesis) { toast('当前浏览器不支持语音朗读'); break; }
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(seg.t);
        u.lang = 'en-GB'; u.rate = 0.95;
        Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (s) { s.classList.remove('speaking'); });
        var row = el.closest('.seg'); if (row) row.classList.add('speaking');
        u.onend = function () { if (row) row.classList.remove('speaking'); };
        speechSynthesis.speak(u);
        break;
      }
      case 'stop-speak':
        if (window.speechSynthesis) speechSynthesis.cancel();
        Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (s) { s.classList.remove('speaking'); });
        break;
      case 'copy': {
        var e3 = BY_ID[r.id], s3 = e3 && e3.dialogue[+el.dataset.i];
        if (!s3) break;
        var txt = s3.t;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () { toast('已复制该段台词'); },
            function () { fallbackCopy(txt); });
        } else fallbackCopy(txt);
        break;
      }
      case 'play-from': {
        var eP = BY_ID[r.id];
        if (!eP) break;
        var tlP = getTimeline(eP), iP = +el.dataset.i;
        var seekTo = function () {
          var dd = audio.duration;
          if (!isFinite(dd) || dd <= 0) return;
          var hd = Math.min(settings.headSec || 0, dd * 0.2);
          audio.currentTime = hd + tlP[iP][0] * Math.max(1, dd - hd);
          followAudio(true);
        };
        if (currentEpId !== r.id) {
          playEpisode(r.id, true);
          var onM = function () { audio.removeEventListener('loadedmetadata', onM); seekTo(); };
          audio.addEventListener('loadedmetadata', onM);
        } else {
          seekTo();
          if (audio.paused) audio.play();
        }
        toast('已从本段开始播放');
        break;
      }
      case 'translate-seg': {
        translateSegment(BY_ID[r.id], +el.dataset.i, el, el.textContent.trim() === '重译');
        break;
      }
      case 'translate-all': translateAll(BY_ID[r.id]); break;
      case 'follow-toggle': {
        settings.follow = !settings.follow;
        save(K_SETTINGS, settings);
        el.classList.toggle('on', settings.follow);
        el.textContent = settings.follow ? '跟随滚动：开' : '跟随滚动：关';
        if (!settings.follow) clearFollowHighlight(); else followAudio(true);
        break;
      }
      case 'edit-trans': {
        var sp = el, iEdit = +el.dataset.i;
        var old = transCache[transKey(r.id, iEdit)] || sp.textContent;
        var inp = document.createElement('input');
        inp.className = 'trans-input'; inp.value = old; inp.dataset.i = iEdit;
        if (sp.replaceWith) sp.replaceWith(inp);
        inp.focus(); if (inp.select) inp.select();
        break;
      }
      case 'dict-close': closeDict(); break;
      case 'dict-speak': {
        var srcS = el.dataset.src;
        if (srcS) {
          try {
            var au = new Audio(srcS);
            var pp = au.play();
            if (pp && pp.catch) pp.catch(function () { toast('发音播放失败'); });
          } catch (e2) { toast('发音播放失败'); }
        } else if (window.speechSynthesis) {
          speechSynthesis.cancel();
          var uu = new SpeechSynthesisUtterance(el.dataset.w || '');
          uu.lang = 'en-GB'; speechSynthesis.speak(uu);
        }
        break;
      }
      case 'dict-trans': {
        var cD = dictCache[wordKey(el.dataset.w)];
        var srcD = cD && cD.meanings && cD.meanings[0] && cD.meanings[0].defs && cD.meanings[0].defs[0];
        var cn = document.getElementById('dictCn');
        if (!cn) break;
        if (!srcD) { cn.textContent = '暂无可翻译的释义'; break; }
        cn.textContent = '翻译中…';
        el.disabled = true;
        translateEn2Zh(srcD).then(function (t) {
          cn.innerHTML = '<span>中文释义</span>' + esc(t);
          el.disabled = false;
        }).catch(function (err) {
          cn.textContent = '释义翻译失败：' + (err.message || '网络不可用');
          el.disabled = false;
        });
        break;
      }
      case 'star-word': {
        var wRaw = el.dataset.w, wk = wordKey(wRaw);
        var idx = myWords.indexOf(wk);
        if (idx >= 0) { myWords.splice(idx, 1); toast('已从生词本移除'); }
        else { myWords.push(wk); toast('已加入生词本'); }
        save(K_WORDS, myWords);
        var nowStar = idx < 0;
        Array.prototype.forEach.call(document.querySelectorAll('[data-action="star-word"]'), function (b) {
          if (wordKey(b.dataset.w) !== wk) return;
          b.classList.toggle('active', nowStar);
          if (b.classList.contains('btn')) {
            b.classList.toggle('on', nowStar);
            b.textContent = nowStar ? '已在生词本' : '加入生词本';
          }
        });
        updateTopStatus();
        if (r.name === 'vocab') { renderQuiz(); }
        break;
      }
      case 'show-pdf': {
        var holder = document.getElementById('pdfHolder');
        if (!holder) break;
        holder.innerHTML = '<div class="divider"></div><div class="section-title">PDF 预览</div>' +
          '<iframe class="pdf-frame" src="' + el.dataset.src + '#view=FitH" title="PDF 预览"></iframe>' +
          '<div class="pdf-fallback">若上方无法显示，请改用「新窗口打开」或「下载 PDF」。</div>';
        holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'vocab-tab':
        vocabState.tab = el.dataset.t; vocabState.page = 1;
        Array.prototype.forEach.call(document.querySelectorAll('#vocabTabs button'), function (b) {
          b.classList.toggle('active', b.dataset.t === vocabState.tab);
        });
        updateVocabResults(); break;
      case 'quiz-start': {
        var scope = el.dataset.scope || 'all';
        var pool = scope === 'mine'
          ? ALL_VOCAB.filter(function (v) { return isStar(wordKey(v.term)); })
          : ALL_VOCAB.slice();
        if (!pool.length) { toast('生词本为空，请先添加生词'); break; }
        var shuffled = pool.sort(function () { return Math.random() - 0.5; }).slice(0, 10);
        quiz = { active: true, list: shuffled, i: 0, show: false, known: 0, again: 0, scope: scope };
        if (r.name !== 'vocab') { location.hash = '#/vocab'; setTimeout(renderQuiz, 60); }
        else renderQuiz();
        break;
      }
      case 'quiz-flip': quiz.show = true; renderQuiz(); break;
      case 'quiz-answer':
        if (el.dataset.v === 'known') quiz.known++; else quiz.again++;
        quiz.i++; quiz.show = false; renderQuiz(); break;
      case 'quiz-exit': quiz.active = false; renderQuiz(); break;
      case 'clear-data':
        if (confirm('确定清空本机的学习记录吗？已学标记、收藏、生词本与播放进度都会被删除，且无法恢复。')) {
          progress = {}; myWords = [];
          save(K_PROGRESS, progress); save(K_WORDS, myWords);
          toast('学习记录已清空'); render();
        }
        break;
    }
  });
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制该段台词'); }
    catch (e) { toast('复制失败，请手动选择文本'); }
    document.body.removeChild(ta);
  }

  render();
})();
