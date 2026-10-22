// ==UserScript==
// @name         Netflix 生词注释
// @namespace    local.netflix-vocab
// @version      0.3
// @description  截获 Netflix 英文字幕文件，提前翻译生词，播放时在词上方显示中文小字
// @match        https://www.netflix.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 配置 ----------
  const KNOWN_TOP_N = 2000;   // 词频前 N 个视为“认识”，越大标注越少
  const MIN_LEN = 4;          // 太短的词不标
  const TARGET_LANG = 'zh-CN';
  const BATCH_SIZE = 20;      // 每次请求翻译的词数
  const CONCURRENCY = 3;      // 同时进行的翻译请求数
  const FREQ_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt';
  // --------------------------

  const known = new Set();
  let freqReady = null;       // Promise，词频表加载完成
  const cache = new Map();
  const inflight = new Set();
  const queue = [];
  let running = 0;
  let backoffUntil = 0;
  let saveTimer = null;

  try {
    Object.entries(JSON.parse(localStorage.getItem('vv_cache')) || {}).forEach(([k, v]) => cache.set(k, v));
  } catch (e) { /* 缓存损坏就忽略 */ }

  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('vv_cache', JSON.stringify(Object.fromEntries(cache))); } catch (e) { /* 存储已满 */ }
    }, 2000);
  }

  function loadFreq() {
    if (!freqReady) {
      freqReady = fetch(FREQ_URL).then(r => r.text()).then(txt => {
        txt.split('\n').slice(0, KNOWN_TOP_N).forEach(w => known.add(w.trim().toLowerCase()));
      });
    }
    return freqReady;
  }

  function isKnown(w) {
    if (known.has(w)) return true;
    // 简单还原词形：复数/过去式/进行时/副词
    const cands = [];
    if (w.endsWith('ies')) cands.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) cands.push(w.slice(0, -2));
    if (w.endsWith('s')) cands.push(w.slice(0, -1));
    if (w.endsWith('ed')) cands.push(w.slice(0, -2), w.slice(0, -1));
    if (w.endsWith('ing')) cands.push(w.slice(0, -3), w.slice(0, -3) + 'e');
    if (w.endsWith('ly')) cands.push(w.slice(0, -2));
    if (w.endsWith('er')) cands.push(w.slice(0, -2));
    return cands.some(c => known.has(c));
  }

  // 把一段文字切成 [{text, word}]；word 为需要标注的小写词，否则为 null
  function tokenize(text) {
    const out = [];
    let first = true;
    for (const part of text.split(/([A-Za-z][A-Za-z'’]*)/)) {
      if (!part) continue;
      if (!/^[A-Za-z]/.test(part)) { out.push({ text: part, word: null }); continue; }
      const lower = part.toLowerCase().split(/['’]/)[0];
      const isCap = /^[A-Z]/.test(part);
      const skip = lower.length < MIN_LEN || (isCap && !first) || isKnown(lower);
      first = false;
      out.push({ text: part, word: skip ? null : lower });
    }
    return out;
  }

  // ---------- 翻译：批量 + 队列 ----------
  function parseBatch(t) {
    // 每行一个词，返回 [[译文, 原文, ...], ...]，按原文对应
    const map = {};
    for (const seg of JSON.parse(t)[0] || []) {
      if (seg && seg[0] && seg[1]) map[seg[1].trim().toLowerCase()] = seg[0].trim();
    }
    return map;
  }

  async function translateBatch(words) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
      TARGET_LANG + '&dt=t&q=' + encodeURIComponent(words.join('\n'));
    const res = await fetch(url);
    if (res.status === 429) { backoffUntil = Date.now() + 30000; throw new Error('rate limited'); }
    const map = parseBatch(await res.text());
    words.forEach(w => { if (map[w]) cache.set(w, map[w]); });
    saveCache();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      if (Date.now() < backoffUntil) { setTimeout(pump, backoffUntil - Date.now() + 100); return; }
      const batch = queue.splice(0, BATCH_SIZE);
      running++;
      translateBatch(batch)
        .catch(() => { queue.push(...batch.filter(w => !cache.has(w))); })
        .finally(() => {
          batch.forEach(w => inflight.delete(w));
          running--;
          waiting.forEach(fn => fn());
          if (!queue.length && running === 0 && total > 0) reportDone();
          setTimeout(pump, 150);
        });
    }
  }

  // 等待某个词的翻译：已缓存则立即返回，否则排到队首（正在显示的词优先）
  const waiting = new Set();
  function need(word) {
    return new Promise(resolve => {
      const check = () => {
        if (cache.has(word)) { waiting.delete(check); resolve(cache.get(word)); }
        else if (!inflight.has(word) && !queue.includes(word)) { queue.unshift(word); inflight.add(word); pump(); }
      };
      waiting.add(check);
      check();
    });
  }

  let total = 0;      // 本轮预加载需要翻译的词数
  function enqueue(words) {
    for (const w of words) {
      if (cache.has(w) || inflight.has(w)) continue;
      inflight.add(w);
      queue.push(w);
      total++;
    }
    pump();
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:8px 12px;' +
      'border-radius:6px;background:rgba(0,0,0,.75);color:#ffd54a;font:14px sans-serif;' +
      'pointer-events:none;transition:opacity .5s;';
    (document.fullscreenElement || document.documentElement).appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 600); }, 4000);
  }

  function reportDone() {
    console.log('[netflix-vocab] 翻译完成，共 ' + total + ' 个生词');
    toast('生词翻译完成（' + total + ' 个）');
    total = 0;
  }

  // ---------- 截获字幕文件并预翻译 ----------
  const seenFiles = new Set();

  function cueText(p) {
    let s = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeName.toLowerCase() === 'br') s += ' ';
        else walk(c);
      }
    })(p);
    return s;
  }

  async function handleSubtitle(xml) {
    if (seenFiles.has(xml.length + xml.slice(0, 200))) return;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'tt') return;
    if (!/^en/i.test(root.getAttribute('xml:lang') || '')) return;
    seenFiles.add(xml.length + xml.slice(0, 200));

    await loadFreq();
    const tick = Number(root.getAttribute('ttp:tickRate')) || 10000000;
    const cues = [];
    for (const p of doc.getElementsByTagName('p')) {
      const m = /^(\d+)t$/.exec(p.getAttribute('begin') || '');
      const begin = m ? Number(m[1]) / tick : 0;
      const words = tokenize(cueText(p)).map(t => t.word).filter(Boolean);
      if (words.length) cues.push({ begin, words });
    }
    // 从当前播放位置开始往后翻译，其余排在后面
    const video = document.querySelector('video');
    const now = video ? video.currentTime : 0;
    cues.sort((a, b) => (a.begin >= now ? 0 : 1) - (b.begin >= now ? 0 : 1) || a.begin - b.begin);
    const ordered = [];
    const seen = new Set();
    cues.forEach(c => c.words.forEach(w => { if (!seen.has(w)) { seen.add(w); ordered.push(w); } }));
    enqueue(ordered);
    console.log('[netflix-vocab] 字幕 ' + cues.length + ' 句，待翻译生词 ' + ordered.length + ' 个');
  }

  // 钩住 XHR / fetch，按内容识别 TTML 字幕
  const looksLikeTTML = t => typeof t === 'string' && /^\s*(<\?xml|<tt[\s>])/.test(t.slice(0, 200));

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          if (looksLikeTTML(this.responseText)) handleSubtitle(this.responseText);
        }
      } catch (e) { /* 忽略 */ }
    });
    return origSend.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function () {
    const p = origFetch.apply(this, arguments);
    p.then(r => {
      const type = r.headers.get('content-type') || '';
      if (/xml|ttml|text/i.test(type)) r.clone().text().then(t => { if (looksLikeTTML(t)) handleSubtitle(t); });
    }).catch(() => {});
    return p;
  };

  // ---------- 渲染：给屏幕上的字幕加注释 ----------
  function annotate(span) {
    const frag = document.createDocumentFragment();
    let changed = false;
    for (const tok of tokenize(span.textContent)) {
      if (!tok.word) { frag.appendChild(document.createTextNode(tok.text)); continue; }
      changed = true;
      const ruby = document.createElement('ruby');
      ruby.appendChild(document.createTextNode(tok.text));
      const rt = document.createElement('rt');
      rt.style.cssText = 'font-size:0.5em;color:#ffd54a;font-weight:normal;';
      ruby.appendChild(rt);
      frag.appendChild(ruby);
      need(tok.word).then(zh => { rt.textContent = zh; });
    }
    if (changed) span.replaceChildren(frag);
  }

  function scan() {
    document.querySelectorAll('.player-timedtext span').forEach(span => {
      // 只处理叶子 span；处理过的已含子元素，不会重复处理
      if (span.children.length === 0 && span.textContent.trim()) annotate(span);
    });
  }

  function start() {
    loadFreq().then(() => {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scan();
    });
  }
  start();
})();
