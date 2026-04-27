// Shared market hours + agenda library (English UI)
(function (global) {
  const SYD = 'Australia/Sydney';
  const NY  = 'America/New_York';
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAY_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: 'Closed', state: 'off' };
    if (asxOpenAt(t)) return { text: 'Open', state: 'on' };
    if (p.minutes >= 420 && p.minutes < 600) return { text: 'Pre-open', state: 'soon' };
    return { text: 'Closed', state: 'off' };
  }
  function usStatusText(t) {
    const sess = usSessionAt(t);
    const p = partsInTz(NY, t);
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: 'Closed', state: 'off' };
    if (sess === 'pre')  return { text: 'Pre-market', state: 'soon' };
    if (sess === 'reg')  return { text: 'Open', state: 'on' };
    if (sess === 'post') return { text: 'Post-market', state: 'soon' };
    return { text: 'Closed', state: 'off' };
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
          label = newAsx ? 'ASX opens' : 'ASX closes';
        } else if (newUs !== startUs) {
          if (startUs === null && newUs === 'pre') label = 'US pre-market';
          else if (startUs === 'pre' && newUs === 'reg') label = 'US opens';
          else if (startUs === 'reg' && newUs === 'post') label = 'US closes';
          else if (startUs === 'post' && newUs === null) label = 'US post-market ends';
          else label = 'US session change';
        }
        return { time: t, label };
      }
    }
    return null;
  }

  // ── Timeline ──
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
    'asx': 'ASX', 'us-pre': 'Pre',
    'us-reg': 'US Open', 'us-post': 'Post'
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
      const num = h === 0 ? 'Now' : pad(p.hour) + ':00';
      let label = '';
      if (h === 0) label = pad(partsInTz(SYD, now).hour) + ':' + pad(partsInTz(SYD, now).minute);
      else if (h === hours) label = '+' + hours + 'h';
      else {
        const sydNow = partsInTz(SYD, now);
        const sydThen = partsInTz(SYD, t);
        const sameDay = sydNow.year === sydThen.year && sydNow.month === sydThen.month && sydNow.day === sydThen.day;
        if (sameDay) {
          if (sydThen.hour < 12) label = 'morning';
          else if (sydThen.hour < 18) label = 'afternoon';
          else label = 'tonight';
        } else {
          if (sydThen.hour < 6) label = 'overnight';
          else if (sydThen.hour < 12) label = 'tmrw AM';
          else if (sydThen.hour < 18) label = 'tmrw PM';
          else label = 'tmrw eve';
        }
      }
      tick.innerHTML = '<span class="num">' + num + '</span><span class="lbl">' + label + '</span>';
      axisEl.appendChild(tick);
    });
  }

  // ── Earnings data ──
  let allEarnings = [];
  let earningsUpdated = null;
  const listeners = [];

  function loadEarnings() {
    return fetch('earnings.json?t=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject('not found'))
      .then(data => {
        if (data && Array.isArray(data.all)) {
          allEarnings = data.all;
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
    return DAY_NAMES[p.dayIdx] + ' ' + p.day + ' ' + p.month + ' · ' + fmtClock24(p);
  }

  function relativeDay(date, now) {
    const pNow = partsInTz(SYD, now);
    const pThen = partsInTz(SYD, date);
    const dayMs = 24 * 3600 * 1000;
    const sydDateKey = (p) => p.year + '-' + p.month + '-' + p.day;
    if (sydDateKey(pNow) === sydDateKey(pThen)) return 'today';
    const tomorrow = new Date(now.getTime() + dayMs);
    if (sydDateKey(partsInTz(SYD, tomorrow)) === sydDateKey(pThen)) return 'tomorrow';
    const dayAfter = new Date(now.getTime() + 2 * dayMs);
    if (sydDateKey(partsInTz(SYD, dayAfter)) === sydDateKey(pThen)) return 'in 2 days';
    const diffDays = Math.round((date.getTime() - now.getTime()) / dayMs);
    if (diffDays >= 0 && diffDays <= 30) return 'in ' + diffDays + ' days';
    if (diffDays < 0) return Math.abs(diffDays) + ' days ago';
    return null;
  }

  // Build agenda items (only major + favourites, no macro events)
  // Auto-expands window if not enough items found in 7 days
  function buildAgenda(now, opts) {
    opts = opts || {};
    const minItems = opts.minItems || 5;
    const maxItems = opts.maxItems || 12;
    const cutoff = new Date(now.getTime() - 3 * 3600 * 1000);
    const favs = new Set(getFavourites());

    // Try expanding windows: 7 days, 14, 30, 60, 180
    const windows = [7, 14, 30, 60, 180];
    let items = [];
    let usedDays = 7;

    for (const days of windows) {
      const horizonEnd = new Date(now.getTime() + days * 24 * 3600 * 1000);
      items = [];
      const seenSym = new Set();
      allEarnings.forEach(e => {
        const isFav = favs.has(e.s);
        if (!e.maj && !isFav) return;
        const d = nyWallToDate(e.ny.y, e.ny.m, e.ny.d, e.ny.h, e.ny.mn);
        if (d < cutoff || d > horizonEnd) return;
        // Dedupe: keep only the earliest occurrence per symbol within window
        if (seenSym.has(e.s)) return;
        seenSym.add(e.s);
        items.push({
          sydDate: d,
          symbol: e.s,
          name: e.n,
          type: e.t,
          major: !!e.maj,
          favourite: isFav,
        });
      });
      if (items.length >= minItems) {
        usedDays = days;
        break;
      }
      usedDays = days;
    }

    items.sort((a, b) => a.sydDate - b.sydDate);
    if (items.length > maxItems) items = items.slice(0, maxItems);
    return { items, days: usedDays };
  }

  // Group items by (date in Sydney, session type) so same-day same-session
  // earnings (e.g. META + MSFT + GOOGL + AMZN all Wed AMC) display together.
  function groupItemsByDateSession(items) {
    const groups = new Map();
    items.forEach(it => {
      const p = partsInTz(SYD, it.sydDate);
      const key = p.year + '-' + p.month + '-' + p.day + '-' + it.type;
      if (!groups.has(key)) {
        groups.set(key, {
          sydDate: it.sydDate,
          type: it.type,
          companies: [],
        });
      }
      groups.get(key).companies.push(it);
    });
    // Sort groups chronologically; within each group, favs first then majors then alpha
    const out = Array.from(groups.values());
    out.sort((a, b) => a.sydDate - b.sydDate);
    out.forEach(g => {
      g.companies.sort((a, b) => {
        if (a.favourite && !b.favourite) return -1;
        if (!a.favourite && b.favourite) return 1;
        if (a.major && !b.major) return -1;
        if (!a.major && b.major) return 1;
        return a.symbol.localeCompare(b.symbol);
      });
    });
    return out;
  }

  // Render grouped agenda (same-day earnings clustered together)
  function renderAgendaItems(items, container, opts) {
    opts = opts || {};
    const showFavBtn = opts.showFavBtn !== false;
    const onChange = opts.onChange;
    const now = new Date();

    container.innerHTML = '';

    if (items.length === 0) {
      const msg = opts.emptyMsg || 'No upcoming earnings';
      container.innerHTML = '<div class="empty"><div class="empty-icon">📅</div>' + msg + '</div>';
      return;
    }

    const groups = groupItemsByDateSession(items);

    groups.forEach(group => {
      const div = document.createElement('div');
      div.className = 'ag-group';

      const rel = relativeDay(group.sydDate, now);
      const diffHours = (group.sydDate - now) / (3600 * 1000);
      let whenClass = '';
      if (diffHours < 6 && diffHours > -1) whenClass = 'is-imminent';
      else if (diffHours < 36) whenClass = 'is-soon';

      const tagText = group.type === 'BMO' ? 'Pre-market' : 'After close';
      const relSpan = rel ? '<span class="ag-group-when-rel">· ' + rel + '</span>' : '';

      let companiesHTML = '<div class="ag-companies">';
      group.companies.forEach(it => {
        const symClass = it.favourite ? 'is-fav' : '';
        const nameSpan = (it.name && it.name !== it.symbol)
          ? '<span class="ag-company-name">' + escapeHtml(it.name) + '</span>'
          : '';
        const favBtn = showFavBtn
          ? '<button class="fav-btn ' + (it.favourite ? 'is-fav' : '') + '" data-sym="' + it.symbol + '">' + starSvg() + '</button>'
          : '';
        companiesHTML += `
          <div class="ag-company">
            <div class="ag-company-info">
              <span class="ag-company-sym ${symClass}">${it.symbol}</span>
              ${nameSpan}
            </div>
            ${favBtn}
          </div>
        `;
      });
      companiesHTML += '</div>';

      div.innerHTML = `
        <div class="ag-group-head">
          <span class="ag-group-when ${whenClass}">${fmtSydneyShort(group.sydDate)}${relSpan}</span>
          <span class="ag-group-tag">${tagText}</span>
        </div>
        ${companiesHTML}
      `;
      container.appendChild(div);
    });

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
    if (ms < 0) return 'now';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return 'in ' + days + 'd ' + hours + 'h';
    if (hours > 0) return 'in ' + hours + 'h ' + pad(mins) + 'm';
    return 'in ' + mins + ' min';
  }

  // ── Favourites ──
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

  // ── Search (case-insensitive on both ticker AND name) ──
  function searchEntries(query, opts) {
    opts = opts || {};
    const q = (query || '').trim().toUpperCase();
    if (!q) return [];

    // Dedupe by symbol — keep earliest upcoming earnings for each ticker
    const now = Date.now() - 3 * 3600 * 1000;
    const bySym = new Map();
    allEarnings.forEach(e => {
      const d = nyWallToDate(e.ny.y, e.ny.m, e.ny.d, e.ny.h, e.ny.mn).getTime();
      if (d < now) return;
      const existing = bySym.get(e.s);
      if (!existing || d < existing._ts) {
        bySym.set(e.s, Object.assign({}, e, { _ts: d }));
      }
    });

    const symMatch = [];
    const nameMatch = [];
    bySym.forEach(e => {
      const symU = e.s.toUpperCase();
      const nameU = (e.n || '').toUpperCase();
      // Prefix match on ticker
      if (symU.startsWith(q)) {
        symMatch.push(e);
      }
      // Substring match on name (only if not already a ticker match)
      else if (nameU.includes(q)) {
        nameMatch.push(e);
      }
    });

    // Sort each group: majors first, then alphabetical
    const sortFn = (a, b) => {
      if (a.maj && !b.maj) return -1;
      if (!a.maj && b.maj) return 1;
      return a.s.localeCompare(b.s);
    };
    symMatch.sort(sortFn);
    nameMatch.sort(sortFn);

    return symMatch.concat(nameMatch).slice(0, opts.limit || 20);
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
    SYD, NY, DAY_NAMES, DAY_LONG, MONTH_SHORT,
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
