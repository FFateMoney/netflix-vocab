// ==UserScript==
// @name         Netflix 生词注释
// @namespace    local.netflix-vocab
// @version      0.9
// @description  截获 Netflix 英文字幕文件，提前翻译生词，播放时在词上方或词后括号里显示中文
// @match        https://www.netflix.com/*
// @updateURL    https://raw.githubusercontent.com/FFateMoney/netflix-vocab/main/netflix-vocab.user.js
// @downloadURL  https://raw.githubusercontent.com/FFateMoney/netflix-vocab/main/netflix-vocab.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 默认配置 ----------
  // 播放页右侧的设置面板里改过的项会覆盖这里的值；面板里点“恢复默认”后回到这里的值
  const MODE = 1;             // 1 = 词上方小字；2 = 词后括号
  const KNOWN_TOP_N = 5000;   // 词频前 N 个视为“认识”，越大标注越少
  const MIN_LEN = 4;          // 太短的词不标
  const TARGET_LANG = 'zh-CN';
  const BATCH_SIZE = 20;      // 每次请求翻译的词数
  const CONCURRENCY = 3;      // 同时进行的翻译请求数
  const FREQ_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt';
  // --------------------------

  const DEFAULTS = { enabled: true, mode: MODE, topN: KNOWN_TOP_N, minLen: MIN_LEN, size: 55, color: '#ffd54a', ignore: '' };

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存储已满或被禁用 */ }
    },
  };

  const saved = store.get('vv_settings', {});          // 只记录在面板里改过的项
  const settings = Object.assign({}, DEFAULTS, saved);
  let ignore = new Set();
  function parseIgnore() {
    ignore = new Set(String(settings.ignore).toLowerCase().split(/[\s,，;；]+/).filter(Boolean));
  }
  parseIgnore();

  // ---------- 词频与专有名词 ----------
  let freqList = [];
  let freqLoaded = false;
  let freqReady = null;       // Promise，词频表加载完成
  const known = new Set();

  function rebuildKnown() {
    known.clear();
    freqList.slice(0, settings.topN).forEach(w => known.add(w));
  }

  function loadFreq() {
    if (!freqReady) {
      freqReady = fetch(FREQ_URL).then(r => r.text()).then(txt => {
        freqList = txt.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
        rebuildKnown();
        freqLoaded = true;
      });
    }
    return freqReady;
  }

  // 简单还原词形：复数/过去式/进行时/副词
  function baseForms(w) {
    const cands = [];
    if (w.endsWith('ies')) cands.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) cands.push(w.slice(0, -2));
    if (w.endsWith('s')) cands.push(w.slice(0, -1));
    if (w.endsWith('ed')) cands.push(w.slice(0, -2), w.slice(0, -1));
    if (w.endsWith('ing')) cands.push(w.slice(0, -3), w.slice(0, -3) + 'e');
    if (w.endsWith('ly')) cands.push(w.slice(0, -2));
    if (w.endsWith('er')) cands.push(w.slice(0, -2));
    return cands;
  }

  const isKnown = w => known.has(w) || baseForms(w).some(c => known.has(c));
  // “我认识的词”同样按词形还原：认识 homicide，homicides 也不再标
  const isIgnored = w => ignore.has(w) || baseForms(w).some(c => ignore.has(c));

  function saveIgnore() {
    settings.ignore = [...ignore].join(' ');
    saved.ignore = settings.ignore;
    store.set('vv_settings', saved);
  }

  // 专有名词判断：一个词在字幕里只以大写形式出现在句中（如 “Tell Skyler”），
  // 而从没以小写出现过，就认为是人名/地名。跨集记住，下次遇到单独一个名字也能认出
  const capMid = new Map();   // 词 -> 句中大写出现次数
  const lowerCnt = new Map(); // 词 -> 小写出现次数
  const names = new Set(store.get('vv_names', []));

  function isName(w) {
    if (lowerCnt.get(w) > 0) return false;
    return capMid.get(w) > 0 || names.has(w);
  }

  const WORD_SPLIT = /([A-Za-z][A-Za-z'’]*)/;
  const WORDS_G = /[A-Za-z][A-Za-z'’]*/g;
  const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'vs']);

  // 切成片段：单词带 lower 和 sentStart（是否句首）；其余是标点/空格
  function splitText(text) {
    const out = [];
    let sentStart = true;
    let prev = '';
    for (const part of text.split(WORD_SPLIT)) {
      if (!part) continue;
      if (!/^[A-Za-z]/.test(part)) {
        out.push({ text: part });
        // “Mr.” 之后的句点不算句末
        if (/[.!?…]/.test(part) && !(ABBR.has(prev) && /^\./.test(part))) sentStart = true;
        continue;
      }
      const lower = part.toLowerCase().split(/['’]/)[0];
      out.push({ text: part, lower, sentStart });
      sentStart = false;
      prev = lower;
    }
    return out;
  }

  function collectCaps(text) {
    if (!/[a-z]/.test(text)) return;   // 全大写的行没法判断
    for (const p of splitText(text)) {
      if (!p.lower) continue;
      if (/^[A-Z]/.test(p.text)) {
        if (!p.sentStart) capMid.set(p.lower, (capMid.get(p.lower) || 0) + 1);
      } else {
        lowerCnt.set(p.lower, (lowerCnt.get(p.lower) || 0) + 1);
      }
    }
  }

  function saveNames() {
    capMid.forEach((n, w) => { if (w.length >= 3 && !lowerCnt.has(w)) names.add(w); });
    store.set('vv_names', [...names].slice(-10000));
  }

  // 把一段文字切成 [{text, word}]；word 为需要标注的小写词，否则为 null
  // lone：这条字幕只有一个词（常是单独喊一个人名）
  function tokenize(text, lone) {
    const allCaps = !/[a-z]/.test(text);
    return splitText(text).map(p => {
      if (!p.lower) return { text: p.text, word: null };
      const cap = !allCaps && /^[A-Z]/.test(p.text);
      const properNoun = cap && (!p.sentStart || isName(p.lower) || (lone && !(lowerCnt.get(p.lower) > 0)));
      const skip = p.lower.length < settings.minLen || properNoun || isIgnored(p.lower) ||
        isKnown(p.lower) || (allCaps && isName(p.lower));
      return { text: p.text, word: skip ? null : p.lower };
    });
  }

  // ---------- 翻译：批量 + 队列 ----------
  const cache = new Map(Object.entries(store.get('vv_cache', {})));
  const inflight = new Set();
  const failed = new Set();
  const tries = new Map();
  const queue = [];
  let running = 0;
  let backoffUntil = 0;
  let saveTimer = null;
  let total = 0;      // 本轮预加载需要翻译的词数

  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('vv_cache', Object.fromEntries(cache)), 2000);
  }

  function parseBatch(t) {
    // 每行一个词，返回 {原文: 译文}
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
    words.forEach(w => { if (map[w]) cache.set(w, map[w]); else failed.add(w); });
    saveCache();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      if (Date.now() < backoffUntil) { setTimeout(pump, backoffUntil - Date.now() + 100); return; }
      const batch = queue.splice(0, BATCH_SIZE);
      running++;
      translateBatch(batch)
        .catch(() => {
          // 失败的词重试，最多 3 次，之后放弃（不再死循环）
          batch.forEach(w => {
            if (cache.has(w)) return;
            const n = (tries.get(w) || 0) + 1;
            tries.set(w, n);
            if (n < 3) queue.push(w); else failed.add(w);
          });
        })
        .finally(() => {
          batch.forEach(w => { if (!queue.includes(w)) inflight.delete(w); });
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
        else if (failed.has(word)) { waiting.delete(check); resolve(''); }
        else if (!inflight.has(word) && !queue.includes(word)) { queue.unshift(word); inflight.add(word); pump(); }
      };
      waiting.add(check);
      check();
    });
  }

  function enqueue(words) {
    for (const w of words) {
      if (cache.has(w) || inflight.has(w) || failed.has(w)) continue;
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
  let cues = [];              // [{begin, text, lone}]
  let planned = new Set();    // 当前阈值下这集所有需要翻译的生词
  let plannedList = [];       // 同上，带出现时间和次数，按剧情顺序
  let plannedVersion = 0;     // 每次重新计算加一，面板据此决定要不要重绘列表

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

  // 按当前设置重新计算这集的生词并排队翻译；从当前播放位置开始往后翻，其余排在后面
  function planWords() {
    const video = document.querySelector('video');
    const now = video ? video.currentTime : 0;
    const sorted = cues.slice().sort((a, b) => (a.begin >= now ? 0 : 1) - (b.begin >= now ? 0 : 1) || a.begin - b.begin);
    const ordered = [];
    const info = new Map();     // 词 -> {word, begin（首次出现的时间）, n（出现次数）}
    for (const c of sorted) {
      for (const t of tokenize(c.text, c.lone)) {
        if (!t.word) continue;
        const it = info.get(t.word);
        if (it) { it.n++; it.begin = Math.min(it.begin, c.begin); }
        else { info.set(t.word, { word: t.word, begin: c.begin, n: 1 }); ordered.push(t.word); }
      }
    }
    planned = new Set(ordered);
    plannedList = [...info.values()].sort((a, b) => a.begin - b.begin);   // 面板里按剧情顺序展示
    plannedVersion++;
    total = 0;
    enqueue(ordered);
    return ordered.length;
  }

  // 面板里“认识 / 不认识”的操作：改完立刻重新计算本集生词并刷新屏幕上的字幕
  function afterIgnoreChange() {
    saveIgnore();
    if (cues.length) planWords();
    rerender();
  }
  function addIgnore(word) {
    word = String(word).toLowerCase().trim();
    if (!/^[a-z][a-z'’-]*$/.test(word) || ignore.has(word)) return false;
    ignore.add(word);
    afterIgnoreChange();
    return true;
  }
  function removeIgnore(word) {
    if (!ignore.delete(word)) return false;
    afterIgnoreChange();
    return true;
  }

  async function handleSubtitle(xml) {
    const sig = xml.length + xml.slice(0, 200);
    if (seenFiles.has(sig)) return;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'tt') return;
    if (!/^en/i.test(root.getAttribute('xml:lang') || '')) return;
    seenFiles.add(sig);

    await loadFreq();
    const tick = Number(root.getAttribute('ttp:tickRate')) || 10000000;
    const list = [];
    for (const p of doc.getElementsByTagName('p')) {
      const m = /^(\d+)t$/.exec(p.getAttribute('begin') || '');
      const text = cueText(p);
      const lone = (text.match(WORDS_G) || []).length === 1;
      list.push({ begin: m ? Number(m[1]) / tick : 0, text, lone });
    }
    // 先统计整集里哪些词是专有名词，再挑生词
    list.forEach(c => collectCaps(c.text));
    saveNames();
    cues = list;
    const n = planWords();
    console.log('[netflix-vocab] 字幕 ' + cues.length + ' 句，待翻译生词 ' + n + ' 个');
    rerender();
  }

  // 钩住 XHR / fetch，按内容识别 TTML 字幕
  const looksLikeTTML = t => typeof t === 'string' && /^\s*(<\?xml|<tt[\s>])/.test(t.slice(0, 200));

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
  const style = document.createElement('style');
  style.textContent =
    '.vv-note{color:var(--vv-color);font-weight:normal}' +
    'rt.vv-note{font-size:calc(var(--vv-size) * 1em)}' +
    'rt.vv-note:empty{display:none}' +
    // 括号模式沿用 ruby 结构（和上方小字模式的 DOM 完全一致），只把排版改成行内，括号用伪元素加
    'ruby.vv-paren,ruby.vv-paren>rt.vv-note{display:inline}' +
    'ruby.vv-paren>rt.vv-note{font-size:calc(var(--vv-size) * 1.25em);margin-left:.1em}' +
    'ruby.vv-paren>rt.vv-note::before{content:"("}' +
    'ruby.vv-paren>rt.vv-note::after{content:")"}';
  document.documentElement.appendChild(style);

  function applyStyle() {
    document.documentElement.style.setProperty('--vv-size', String(settings.size / 100));
    document.documentElement.style.setProperty('--vv-color', settings.color);
  }
  applyStyle();

  // 处理过的文本节点不再重复处理（否则注释后剩下的片段会被当成句首重新判断）
  let done = new WeakSet();

  function annotate(node, lone) {
    const frag = document.createDocumentFragment();
    let changed = false;
    const addText = text => {
      const t = document.createTextNode(text);
      done.add(t);
      return t;
    };
    const paren = settings.mode === 2 && !loopBroken;
    for (const tok of tokenize(node.nodeValue, lone)) {
      if (!tok.word) { frag.appendChild(addText(tok.text)); continue; }
      changed = true;
      const wrap = document.createElement('ruby');
      wrap.className = paren ? 'vv-wrap vv-paren' : 'vv-wrap';
      wrap.appendChild(addText(tok.text));
      const note = document.createElement('rt');
      note.className = 'vv-note';
      wrap.appendChild(note);
      frag.appendChild(wrap);
      need(tok.word).then(zh => { if (zh) note.textContent = zh; });
    }
    if (changed) { node.replaceWith(frag); noteAnnotation(); }
    else done.add(node);
  }

  // 保险：如果 Netflix 因为我们改了字幕布局而不停重绘字幕，我们又不停重新标注，就会一直闪。
  // 1 秒内标注次数异常多时，判定为循环：先退回上方小字（不改变行宽），仍然循环就暂停 5 秒
  let loopBroken = false;
  let pausedUntil = 0;
  const passes = [];
  function noteAnnotation() {
    const now = Date.now();
    passes.push(now);
    while (passes.length && now - passes[0] > 1000) passes.shift();
    if (passes.length <= 8) return;
    console.warn('[netflix-vocab] 字幕被反复重绘（1 秒内标注 ' + passes.length + ' 次），' +
      (loopBroken || settings.mode !== 2 ? '暂停 5 秒' : '括号模式暂时改用上方小字'));
    passes.length = 0;
    if (loopBroken || settings.mode !== 2) {
      pausedUntil = now + 5000;
    } else {
      loopBroken = true;
      toast('括号模式与 Netflix 渲染冲突，已临时改用上方小字');
    }
    setTimeout(rerender, 0);
  }

  function scan() {
    if (!settings.enabled || !freqLoaded || Date.now() < pausedUntil) return;
    // 直接遍历字幕区域里的文本节点，不依赖 span 的层级结构（多行字幕会有换行节点）
    document.querySelectorAll('.player-timedtext').forEach(root => {
      const lone = (root.textContent.match(WORDS_G) || []).length === 1;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const n of nodes) {
        if (!done.has(n) && n.nodeValue.trim() && !n.parentElement.closest('.vv-wrap')) annotate(n, lone);
      }
    });
  }

  function clearAnnotations() {
    document.querySelectorAll('.vv-wrap').forEach(w => w.replaceWith(document.createTextNode(w.firstChild.nodeValue)));
    done = new WeakSet();
  }

  function rerender() {
    clearAnnotations();
    scan();
  }

  // ---------- 设置面板：收在右侧边缘，鼠标移上去滑出，点击展开 ----------
  const PANEL_HTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}
  .tab{position:fixed;top:38%;right:0;width:30px;height:52px;display:flex;align-items:center;justify-content:center;
    background:rgba(20,20,20,.85);color:#ffd54a;font-size:16px;font-weight:600;border-radius:8px 0 0 8px;
    cursor:pointer;user-select:none;transform:translateX(22px);opacity:.6;transition:transform .2s,opacity .2s}
  .tab:hover,.tab.open{transform:none;opacity:1}
  .panel{position:fixed;top:12vh;right:40px;width:320px;max-height:76vh;overflow:auto;padding:12px 14px;
    background:rgba(20,20,20,.94);color:#eee;font-size:13px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.6)}
  .panel[hidden]{display:none}
  .hd{display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:14px;margin-bottom:8px;color:#ffd54a}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0}
  .col{margin:8px 0}
  .col span{display:block;margin-bottom:4px}
  input[type=range]{width:130px;accent-color:#ffd54a}
  select,textarea,button{background:#333;color:#eee;border:1px solid #555;border-radius:4px;font-size:12px}
  select{padding:3px}
  textarea{width:100%;padding:4px;resize:vertical}
  button{padding:4px 8px;cursor:pointer}
  button:hover{background:#444}
  .x{border:none;background:none;font-size:16px;color:#aaa}
  .btns{display:flex;gap:8px;margin-top:10px}
  .st{margin-top:8px;font-size:12px;color:#aaa;line-height:1.5}
  input[type=color]{width:40px;height:24px;border:none;padding:0;background:none}
  .tabs{display:flex;gap:4px;margin-bottom:6px}
  .tabs button{flex:1;padding:5px 2px;font-size:12px}
  .tabs button.on{background:#ffd54a;color:#111;border-color:#ffd54a}
  [hidden]{display:none!important}
  input[type=text]{width:100%;padding:5px 6px;background:#333;color:#eee;border:1px solid #555;border-radius:4px;font-size:12px}
  .hint{margin:6px 0;font-size:12px;color:#aaa;line-height:1.5}
  .list{max-height:46vh;overflow:auto;margin-top:6px;border-top:1px solid #333}
  .item{display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid #2a2a2a}
  .item .w{flex:0 0 38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .item .zh{flex:1;color:#ffd54a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .item .n{color:#888;font-size:11px}
  .item .rm{padding:1px 7px;font-size:14px;line-height:1.2}
  .empty{padding:14px 0;text-align:center;color:#888}
</style>
<div class="tab" title="生词注释设置">译</div>
<div class="panel" hidden>
  <div class="hd"><span>生词注释</span><button class="x" id="close">×</button></div>
  <div class="tabs">
    <button data-tab="settings" class="on">设置</button>
    <button data-tab="episode">本集生词 <span id="cnt-ep"></span></button>
    <button data-tab="known">我认识的词 <span id="cnt-known"></span></button>
  </div>
  <div id="pane-settings">
    <label class="row"><span>启用</span><input type="checkbox" id="enabled"></label>
    <div class="row"><span>显示方式</span>
      <select id="mode"><option value="1">1 上方小字</option><option value="2">2 词后括号</option></select></div>
    <div class="row"><span>认识的词频 <b id="topN-v"></b></span><input type="range" id="topN" min="500" max="10000" step="500"></div>
    <div class="row"><span>最短词长 <b id="minLen-v"></b></span><input type="range" id="minLen" min="3" max="8" step="1"></div>
    <div class="row"><span>注释大小 <b id="size-v"></b>%</span><input type="range" id="size" min="30" max="100" step="5"></div>
    <div class="row"><span>注释颜色</span><input type="color" id="color"></div>
    <div class="st" id="status"></div>
    <div class="btns"><button id="clearCache">清空翻译缓存</button><button id="reset">恢复默认</button></div>
    <div class="hint">“恢复默认”只重置上面的显示设置，不会清掉“我认识的词”。</div>
  </div>
  <div id="pane-episode" hidden>
    <input type="text" id="filter-ep" placeholder="筛选单词">
    <div class="hint">按剧情顺序。点 × 表示“我认识”，以后任何一集都不再标注。</div>
    <div class="list" id="list-ep"></div>
  </div>
  <div id="pane-known" hidden>
    <input type="text" id="add-word" placeholder="输入单词，回车添加为“我认识”">
    <input type="text" id="filter-known" placeholder="筛选" style="margin-top:6px">
    <div class="hint">点 × 把词移出，之后遇到又会重新标注。</div>
    <div class="list" id="list-known"></div>
  </div>
</div>`;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'vv-ui';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = PANEL_HTML;
    const $ = id => root.getElementById(id);
    const tab = root.querySelector('.tab');
    const panel = root.querySelector('.panel');

    // 不让点击/键盘/滚轮穿到 Netflix 播放器上（避免暂停、快捷键、音量被触发）
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'keydown', 'keyup', 'keypress']
      .forEach(ev => host.addEventListener(ev, e => e.stopPropagation()));

    function refreshStatus() {
      let n = 0;
      planned.forEach(w => { if (cache.has(w)) n++; });
      $('status').textContent = cues.length
        ? '字幕 ' + cues.length + ' 句 · 生词 ' + planned.size + ' 个 · 已翻译 ' + n + '（缓存共 ' + cache.size + '）'
        : '还没有截获到字幕（请刷新播放页）';
    }

    function fillForm() {
      $('enabled').checked = settings.enabled;
      $('mode').value = String(settings.mode);
      ['topN', 'minLen', 'size'].forEach(k => { $(k).value = settings[k]; $(k + '-v').textContent = settings[k]; });
      $('color').value = settings.color;
      refreshStatus();
    }

    // ---- 两个词表页 ----
    let tabName = 'settings';
    let drawnVersion = -1;      // 本集生词列表对应的 plannedVersion
    let drawnKnown = '';        // “我认识的词”列表对应的内容，变了才重绘
    const zhCells = new Map();  // 词 -> 译文所在的元素（翻译到了就原地更新，不重绘列表）

    function makeRow(word, zhText, count, onRemove, title) {
      const row = document.createElement('div');
      row.className = 'item';
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = word;
      row.appendChild(w);
      if (zhText != null) {
        const zh = document.createElement('span');
        zh.className = 'zh';
        zh.textContent = zhText;
        row.appendChild(zh);
        zhCells.set(word, zh);
      } else {
        const sp = document.createElement('span');
        sp.style.flex = '1';
        row.appendChild(sp);
      }
      if (count > 1) {
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = '×' + count;
        row.appendChild(n);
      }
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = title;
      rm.addEventListener('click', () => onRemove(word));
      row.appendChild(rm);
      return row;
    }

    function showEmpty(list, text) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = text;
      list.replaceChildren(d);
    }

    function drawEpisode() {
      const q = $('filter-ep').value.trim().toLowerCase();
      const list = $('list-ep');
      zhCells.clear();
      const items = plannedList.filter(it => !q || it.word.includes(q));
      const top = list.scrollTop;   // 连续删词时保持滚动位置
      if (!items.length) { showEmpty(list, cues.length ? '没有生词了' : '还没有截获到字幕（请刷新播放页）'); }
      else {
        const frag = document.createDocumentFragment();
        items.forEach(it => frag.appendChild(makeRow(it.word, cache.has(it.word) ? cache.get(it.word) : '…', it.n, markKnown, '我认识，以后不再标注')));
        list.replaceChildren(frag);
        list.scrollTop = top;
      }
      drawnVersion = plannedVersion;
      $('cnt-ep').textContent = '(' + plannedList.length + ')';
    }

    function drawKnown() {
      const q = $('filter-known').value.trim().toLowerCase();
      const list = $('list-known');
      const words = [...ignore].filter(w => !q || w.includes(q)).sort();
      const top = list.scrollTop;
      if (!words.length) showEmpty(list, ignore.size ? '没有匹配的词' : '还没有“我认识的词”');
      else {
        const frag = document.createDocumentFragment();
        words.forEach(w => frag.appendChild(makeRow(w, null, 0, unmarkKnown, '移出，之后重新标注')));
        list.replaceChildren(frag);
        list.scrollTop = top;
      }
      drawnKnown = [...ignore].join(' ');
      $('cnt-known').textContent = '(' + ignore.size + ')';
    }

    // 列表只在内容变了才重绘；译文翻译到了就原地更新，不打断滚动和点击
    function refreshLists() {
      $('cnt-ep').textContent = '(' + plannedList.length + ')';
      $('cnt-known').textContent = '(' + ignore.size + ')';
      if (tabName === 'episode') {
        if (drawnVersion !== plannedVersion) drawEpisode();
        zhCells.forEach((el, w) => { if (el.textContent === '…' && cache.has(w)) el.textContent = cache.get(w); });
      } else if (tabName === 'known' && drawnKnown !== [...ignore].join(' ')) {
        drawKnown();
      }
    }

    function switchTab(name) {
      tabName = name;
      root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
      ['settings', 'episode', 'known'].forEach(n => { $('pane-' + n).hidden = n !== name; });
      drawnVersion = -1;
      drawnKnown = '';
      if (name === 'settings') fillForm();
      refreshLists();
    }

    // 改完词表立刻刷新列表，不等定时刷新
    const markKnown = word => { addIgnore(word); refreshLists(); };
    const unmarkKnown = word => { removeIgnore(word); refreshLists(); };

    root.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('filter-ep').addEventListener('input', () => { drawnVersion = -1; refreshLists(); });
    $('filter-known').addEventListener('input', () => { drawnKnown = ''; refreshLists(); });
    $('add-word').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (addIgnore(e.target.value)) { e.target.value = ''; refreshLists(); }
    });

    let timer = null;
    // 改变会影响“哪些词算生词”的设置：稍等一下再重新计算，避免拖动滑块时频繁重算
    function recompute(delay) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        rebuildKnown();
        if (cues.length) planWords();
        rerender();
        refreshStatus();
      }, delay);
    }

    function change(key, value) {
      settings[key] = value;
      saved[key] = value;
      store.set('vv_settings', saved);
      if (key === 'size' || key === 'color') { applyStyle(); return; }
      recompute(key === 'topN' || key === 'minLen' ? 300 : 0);
    }

    $('enabled').addEventListener('change', e => {
      change('enabled', e.target.checked);
      if (!e.target.checked) clearAnnotations();
    });
    $('mode').addEventListener('change', e => { loopBroken = false; change('mode', Number(e.target.value)); });
    ['topN', 'minLen', 'size'].forEach(k => $(k).addEventListener('input', e => {
      $(k + '-v').textContent = e.target.value;
      change(k, Number(e.target.value));
    }));
    $('color').addEventListener('input', e => change('color', e.target.value));
    $('clearCache').addEventListener('click', () => {
      cache.clear();
      failed.clear();
      tries.clear();
      store.set('vv_cache', {});
      if (cues.length) planWords();
      rerender();
      refreshStatus();
    });
    $('reset').addEventListener('click', () => {
      // 只重置显示设置，“我认识的词”保留
      Object.keys(saved).forEach(k => { if (k !== 'ignore') delete saved[k]; });
      store.set('vv_settings', saved);
      Object.assign(settings, DEFAULTS, { ignore: settings.ignore });
      applyStyle();
      fillForm();
      recompute(0);
    });

    function toggle(open) {
      panel.hidden = !open;
      tab.classList.toggle('open', open);
      if (open) switchTab(tabName);
    }
    tab.addEventListener('click', () => toggle(panel.hidden));
    $('close').addEventListener('click', () => toggle(false));

    // 只在播放页显示；全屏时挂到全屏元素里才看得见
    function place() {
      host.style.display = location.pathname.startsWith('/watch') ? '' : 'none';
      const parent = document.fullscreenElement || document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
      if (!panel.hidden) { refreshStatus(); refreshLists(); }
    }
    document.addEventListener('fullscreenchange', place);
    setInterval(place, 1000);
    place();
  }

  function start() {
    loadFreq().then(() => {
      // Netflix 大约每秒会把整句字幕的 DOM 换掉一次。必须在同一个微任务里立刻重新标注，
      // 不能防抖/延时，否则浏览器会先画出几帧没有标注的字幕，表现为闪烁
      const inSubtitle = n => n.nodeType === 1 && (n.matches('.player-timedtext') || n.querySelector('.player-timedtext'));
      new MutationObserver(records => {
        for (const r of records) {
          const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
          if ((el && el.closest('.player-timedtext')) || [...r.addedNodes].some(inSubtitle)) { scan(); return; }
        }
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scan();
    });
    buildUI();
  }
  start();
})();
