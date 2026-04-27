// Shared market hours + agenda library
(function (global) {
  const SYD = 'Australia/Sydney';
  const NY  = 'America/New_York';
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAY_LONG_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const DAY_CN = ['日','一','二','三','四','五','六'];
  const FAV_KEY = 'markets_fav_v1';

  function partsInTz(tz, date) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'short'
    });
    const out = {};
    fmt.formatToParts(date).forEach(p => out[p.type] = p.value);
    let h = parseInt(out.hour, 10); if (h === 24) h = 0;
    out.hour = h;
    out.minute = parseInt(out.minute, 10);
    out.second = parseInt(out.second, 10);
    out.minutes = h * 60 + out.minute;
    out.dayIdx = DAY_NAMES.indexOf(out.weekday);
    return out;
  }

  const pad = n => String(n).padStart(2, '0');
  const fmtClockHMS = p => pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second);
  const fmtClock24 = p => pad(p.hour) + ':' + pad(p.minute);

  function nyWallToDate(y, mIdx, d, h, mn) {
    let guess = Date.UTC(y, mIdx, d, h, mn);
    for (let i = 0; i < 4; i++) {
      const p = partsInTz(NY, new Date(guess));
      const want = h * 60 + mn;
      const have = p.minutes;
      let diff = want - have;
      if (diff > 720) diff -= 1440;
      if (diff < -720) diff += 1440;
      if (Math.abs(diff) < 1) break;
      guess += diff * 60000;
    }
    return new Date(guess);
  }

  // ── Market state ──
  function asxOpenAt(t) {
    const p = partsInTz(SYD, t);
    if (p.dayIdx < 1 || p.dayIdx > 5) return false;
    return p.minutes >= 600 && p.minutes < 960;
  }
  function usSessionAt(t) {
    const p = partsInTz(NY, t);
    if (p.dayIdx < 1 || p.dayIdx > 5) return null;
    const m = p.minutes;
    if (m >= 240 && m < 570)  return 'pre';
    if (m >= 570 && m < 960)  return 'reg';
    if (m >= 960 && m < 1200) return 'post';
    return null;
  }

  function asxStatusText(t) {
    const p = partsInTz(SYD, t);
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: '休市', state: 'off' };
    if (asxOpenAt(t)) return { text: '正在交易', state: 'on' };
    if (p.minutes >= 420 && p.minutes < 600) return { text: '集合竞价', state: 'soon' };
    return { text: '休市', state: 'off' };
  }
  function usStatusText(t) {
    const sess = usSessionAt(t);
    const p = partsInTz(NY, t);
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: '休市', state: 'off' };
    if (sess === 'pre')  return { text: '盘前', state: 'soon' };
    if (sess === 'reg')  return { text: '正常交易', state: 'on' };
    if (sess === 'post') return { text: '盘后', state: 'soon' };
    return { text: '休市', state: 'off' };
  }

  function findNextEvent(now) {
    const startAsx = asxOpenAt(now);
    const startUs  = usSessionAt(now);
    for (let m = 1; m <= 7 * 24 * 60; m++) {
      const t = new Date(now.getTime() + m * 60000);
      const newAsx = asxOpenAt(t);
      const newUs  = usSessionAt(t);
      if (newAsx !== startAsx || newUs !== startUs) {
        let label = '';
        if (newAsx !== startAsx) {
          label = newAsx ? 'ASX 开盘' : 'ASX 收盘';
        } else if (newUs !== startUs) {
          if (startUs === null && newUs === 'pre') label = '美股盘前';
          else if (startUs === 'pre' && newUs === 'reg') label = '美股开盘';
          else if (startUs === 'reg' && newUs === 'post') label = '美股收盘';
          else if (startUs === 'post' && newUs === null) label = '美股盘后结束';
          else label = '美股时段切换';
        }
        return { time: t, label };
      }
    }
    return null;
  }

  // ── Timeline segments ──
  function buildSegments(now, hours) {
    const totalMin = hours * 60;
    const segs = [];
    let cur = null;
    let curStart = 0;
    function classify(t) {
      const isAsx = asxOpenAt(t);
      const usSess = usSessionAt(t);
      if (isAsx) return 'asx';
      if (usSess === 'pre')  return 'us-pre';
      if (usSess === 'reg')  return 'us-reg';
      if (usSess === 'post') return 'us-post';
      return null;
    }
    for (let m = 0; m <= totalMin; m++) {
      const t = new Date(now.getTime() + m * 60000);
      const c = classify(t);
      if (c !== cur) {
        if (cur !== null) segs.push({ type: cur, start: curStart, end: m });
        cur = c;
        curStart = m;
      }
    }
    if (cur !== null) segs.push({ type: cur, start: curStart, end: totalMin });
    return { segs, totalMin };
  }

  const SEG_LABELS = {
    'asx': 'ASX', 'us-pre': '美股盘前',
    'us-reg': '美股开盘', 'us-post': '美股盘后'
  };

  function renderTimeline(now, barEl, axisEl, hours) {
    hours = hours || 12;
    const built = buildSegments(now, hours);
    const total = built.totalMin;
    barEl.querySelectorAll('.tl-seg').forEach(e => e.remove());
    built.segs.forEach(s => {
      if (!s.type) return;
      const widthPct = (s.end - s.start) / total * 100;
      const el = document.createElement('div');
      el.className = 'tl-seg seg-' + s.type;
      if (widthPct < 8) el.classList.add('is-tight');
      if (widthPct < 4) el.classList.add('is-narrow');
      el.style.left = (s.start / total * 100) + '%';
      el.style.width = widthPct + '%';
      el.innerHTML = '<span class="tl-seg-label">' + SEG_LABELS[s.type] + '</span>';
      barEl.appendChild(el);
    });
    axisEl.innerHTML = '';
    const ticks = [0, hours / 4, hours / 2, hours * 3 / 4, hours];
    ticks.forEach((h, i) => {
      const t = new Date(now.getTime() + h * 3600000);
      const p = partsInTz(SYD, t);
      const tick = document.createElement('div');
      tick.className = 'tl-axis-tick';
      if (i === 0 || i === ticks.length - 1) tick.classList.add('is-edge');
      if (h === 0) tick.classList.add('is-now');
      tick.style.left = (h / hours * 100) + '%';
      const num = h === 0 ? '现在' : pad(p.hour) + ':00';
      let label = '';
      if (h === 0) label = pad(partsInTz(SYD, now).hour) + ':' + pad(partsInTz(SYD, now).minute);
      else if (h === hours) label = '+' + hours + 'h';
      else {
        const sydNow = partsInTz(SYD, now);
        const sydThen = partsInTz(SYD, t);
        const sameDay = sydNow.year === sydThen.year && sydNow.month === sydThen.month && sydNow.day === sydThen.day;
        if (sameDay) {
          if (sydThen.hour < 12) label = '今早';
          else if (sydThen.hour < 18) label = '今下午';
          else label = '今晚';
        } else {
          if (sydThen.hour < 6) label = '凌晨';
          else if (sydThen.hour < 12) label = '明早';
          else if (sydThen.hour < 18) label = '明下午';
          else label = '明晚';
        }
      }
      tick.innerHTML = '<span class="num">' + num + '</span><span class="lbl">' + label + '</span>';
      axisEl.appendChild(tick);
    });
  }

  // ── Earnings + macro data ──
  let allEarnings = [];   // flat list of all earnings (s, n, ny, t, maj, eps?)
  let allMacro = [];       // flat list of macro events (name, tag, country, ny)
  let earningsUpdated = null;
  const listeners = [];

  function loadEarnings() {
    return fetch('earnings.json?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject('not found'))
      .then(data => {
        if (data) {
          if (Array.isArray(data.all)) allEarnings = data.all;
          if (Array.isArray(data.macro)) allMacro = data.macro;
          earningsUpdated = data.updated || null;
          listeners.forEach(fn => { try { fn(); } catch(e){} });
        }
      })
      .catch(err => {
        console.log('Could not load earnings.json:', err);
      });
  }
  loadEarnings();

  function fmtSydneyShort(date) {
    const p = partsInTz(SYD, date);
    return '周' + DAY_CN[p.dayIdx] + ' ' + p.day + ' ' + p.month + ' · ' + fmtClock24(p);
  }

  function relativeDay(date, now) {
    const pNow = partsInTz(SYD, now);
    const pThen = partsInTz(SYD, date);
    const dayMs = 24 * 3600 * 1000;
    const sydDateKey = (p) => p.year + '-' + p.month + '-' + p.day;
    if (sydDateKey(pNow) === sydDateKey(pThen)) return '今天';
    const tomorrow = new Date(now.getTime() + dayMs);
    if (sydDateKey(partsInTz(SYD, tomorrow)) === sydDateKey(pThen)) return '明天';
    const dayAfter = new Date(now.getTime() + 2 * dayMs);
    if (sydDateKey(partsInTz(SYD, dayAfter)) === sydDateKey(pThen)) return '后天';
    const diffDays = Math.round((date.getTime() - now.getTime()) / dayMs);
    if (diffDays >= 0 && diffDays <= 30) return diffDays + ' 天后';
    if (diffDays < 0) return Math.abs(diffDays) + ' 天前';
    return null;
  }

  // ── Build unified agenda items (earnings + favourites + macro) ──
  // Each item: { kind: 'earn'|'macro', sydDate, ...rest }
  function buildAgenda(now, opts) {
    opts = opts || {};
    const days = opts.days || 7;
    const includeMinor = !!opts.includeMinor;  // include non-major non-fav earnings
    const cutoff = new Date(now.getTime() - 3 * 3600 * 1000);
    const horizonEnd = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const favs = new Set(getFavourites());
    const items = [];

    allEarnings.forEach(e => {
      const isFav = favs.has(e.s);
      // Filter rule: include if major OR favourite OR (includeMinor=true)
      if (!e.maj && !isFav && !includeMinor) return;
      const d = nyWallToDate(e.ny.y, e.ny.m, e.ny.d, e.ny.h, e.ny.mn);
      if (d < cutoff || d > horizonEnd) return;
      items.push({
        kind: 'earn',
        sydDate: d,
        symbol: e.s,
        name: e.n,
        type: e.t,
        major: !!e.maj,
        favourite: isFav,
        eps: e.eps,
      });
    });

    allMacro.forEach(m => {
      const d = nyWallToDate(m.ny.y, m.ny.m, m.ny.d, m.ny.h, m.ny.mn);
      if (d < cutoff || d > horizonEnd) return;
      items.push({
        kind: 'macro',
        sydDate: d,
        name: m.name,
        tag: m.tag,
        country: m.country,
      });
    });

    items.sort((a, b) => a.sydDate - b.sydDate);
    return items;
  }

  // ── Render unified agenda ──
  function renderAgendaItems(items, container, opts) {
    opts = opts || {};
    const limit = opts.limit || null;
    const showFavBtn = opts.showFavBtn !== false;
    const onChange = opts.onChange;
    const now = new Date();

    container.innerHTML = '';
    let visible = items;
    if (limit) visible = visible.slice(0, limit);

    if (visible.length === 0) {
      const msg = opts.emptyMsg || '暂无即将到来的事件';
      container.innerHTML = '<div class="empty"><div class="empty-icon">📅</div>' + msg + '</div>';
      return;
    }

    visible.forEach(it => {
      const div = document.createElement('div');
      div.className = 'ag-item';

      const rel = relativeDay(it.sydDate, now);
      const diffDays = Math.round((it.sydDate - now) / (24 * 3600 * 1000));
      const diffHours = (it.sydDate - now) / (3600 * 1000);
      let whenClass = '';
      if (diffHours < 6) whenClass = 'is-imminent';
      else if (diffDays <= 1) whenClass = 'is-soon';

      const whenText = fmtSydneyShort(it.sydDate);
      const relText = rel ? ('<div>' + rel + '</div>') : '';

      let iconHTML, titleHTML, metaHTML, favBtnHTML = '';

      if (it.kind === 'earn') {
        const iconClass = it.favourite ? 'is-fav' : (it.major ? 'is-major' : 'is-minor');
        iconHTML = '<div class="ag-icon ' + iconClass + '"><span class="ag-icon-text">' +
                   (it.favourite ? '⭐' : (it.major ? '★' : '·')) + '</span></div>';
        const nameSpan = (it.name && it.name !== it.symbol) ? '<span class="ag-title-name">' + escapeHtml(it.name) + '</span>' : '';
        titleHTML = '<div class="ag-title">' + it.symbol + nameSpan + '</div>';
        const tagText = it.type === 'BMO' ? '盘前' : '盘后';
        const tagClass = it.major ? 'is-major' : '';
        metaHTML = '<div class="ag-meta"><span class="ag-meta-tag ' + tagClass + '">' + tagText + '</span></div>';

        if (showFavBtn) {
          favBtnHTML = '<button class="fav-btn ' + (it.favourite ? 'is-fav' : '') + '" data-sym="' + it.symbol + '">' + starSvg() + '</button>';
        }
      } else {
        // macro
        iconHTML = '<div class="ag-icon is-macro"><span class="ag-icon-text">' + escapeHtml(it.tag) + '</span></div>';
        titleHTML = '<div class="ag-title">' + escapeHtml(it.name) + '</div>';
        metaHTML = '<div class="ag-meta"><span class="ag-meta-tag is-macro">' + escapeHtml(it.country) + '</span></div>';
      }

      div.innerHTML = `
        ${iconHTML}
        <div class="ag-info">
          ${titleHTML}
          ${metaHTML}
        </div>
        <div class="ag-when ${whenClass}">${whenText}${relText}</div>
        ${favBtnHTML}
      `;
      container.appendChild(div);
    });

    // Wire fav buttons
    if (showFavBtn) {
      container.querySelectorAll('.fav-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const sym = btn.getAttribute('data-sym');
          toggleFavourite(sym);
          if (onChange) onChange();
        });
      });
    }
  }

  function starSvg() {
    return '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.95 6.55 7.05.62-5.36 4.65 1.6 6.93L12 17.6l-6.24 3.65 1.6-6.93L2 9.67l7.05-.62z"/></svg>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function onEarningsUpdate(fn) { listeners.push(fn); }

  function fmtCountdown(ms) {
    if (ms < 0) return '现在';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return days + 'd ' + hours + 'h 后';
    if (hours > 0) return hours + 'h ' + pad(mins) + 'm 后';
    return mins + ' 分钟后';
  }

  // ── Favourites (localStorage) ──
  function getFavourites() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function setFavourites(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); }
    catch (e) {}
  }
  function isFavourite(symbol) {
    return getFavourites().includes(symbol.toUpperCase());
  }
  function toggleFavourite(symbol) {
    const sym = symbol.toUpperCase();
    const favs = getFavourites();
    const idx = favs.indexOf(sym);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(sym);
    setFavourites(favs);
    return idx < 0;
  }

  // ── Search ──
  function searchEntries(query, opts) {
    opts = opts || {};
    const q = (query || '').trim().toUpperCase();
    if (!q) return [];
    const symMatch = [];
    const nameMatch = [];
    const seen = new Set();
    allEarnings.forEach(e => {
      if (seen.has(e.s)) return;
      const symU = e.s;
      const nameU = (e.n || '').toUpperCase();
      if (symU.startsWith(q)) {
        symMatch.push(e); seen.add(e.s);
      } else if (nameU.includes(q)) {
        nameMatch.push(e); seen.add(e.s);
      }
    });
    const out = symMatch.concat(nameMatch);
    return out.slice(0, opts.limit || 30);
  }

  function nextEarningsFor(symbol) {
    const sym = symbol.toUpperCase();
    const now = Date.now();
    let best = null;
    let bestTs = Infinity;
    allEarnings.forEach(e => {
      if (e.s !== sym) return;
      const d = nyWallToDate(e.ny.y, e.ny.m, e.ny.d, e.ny.h, e.ny.mn);
      const ts = d.getTime();
      if (ts >= now - 3 * 3600 * 1000 && ts < bestTs) {
        best = Object.assign({}, e, { sydDate: d });
        bestTs = ts;
      }
    });
    return best;
  }

  global.MarketsLib = {
    SYD, NY, DAY_NAMES, DAY_LONG_EN, DAY_CN,
    pad, partsInTz, fmtClockHMS, fmtClock24, fmtSydneyShort, relativeDay,
    asxStatusText, usStatusText, findNextEvent,
    renderTimeline,
    buildAgenda, renderAgendaItems,
    onEarningsUpdate, getEarningsUpdatedAt: () => earningsUpdated,
    getFavourites, isFavourite, toggleFavourite,
    searchEntries, nextEarningsFor,
    fmtCountdown,
  };
})(window);
