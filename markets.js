// Shared market hours + earnings data
(function (global) {
  const SYD = 'Australia/Sydney';
  const NY  = 'America/New_York';
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAY_LONG_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const DAY_CN = ['日','一','二','三','四','五','六'];

  function partsInTz(tz, date) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'short'
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
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: '休市 · 周末', state: 'closed' };
    if (asxOpenAt(t)) return { text: '正在交易', state: 'open' };
    if (p.minutes >= 420 && p.minutes < 600) return { text: '集合竞价', state: 'soon' };
    return { text: '休市', state: 'closed' };
  }
  function usStatusText(t) {
    const sess = usSessionAt(t);
    const p = partsInTz(NY, t);
    if (p.dayIdx === 0 || p.dayIdx === 6) return { text: '休市 · 周末', state: 'closed' };
    if (sess === 'pre')  return { text: '盘前交易', state: 'soon' };
    if (sess === 'reg')  return { text: '正常交易', state: 'open' };
    if (sess === 'post') return { text: '盘后交易', state: 'soon' };
    return { text: '休市', state: 'closed' };
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
          if (startUs === null && newUs === 'pre') label = '美股盘前开始';
          else if (startUs === 'pre' && newUs === 'reg') label = '美股正式开盘';
          else if (startUs === 'reg' && newUs === 'post') label = '美股收盘 · 盘后开始';
          else if (startUs === 'post' && newUs === null) label = '美股盘后结束';
          else label = '美股时段切换';
        }
        return { time: t, label };
      }
    }
    return null;
  }

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
    'asx': 'ASX',
    'us-pre': '美股盘前',
    'us-reg': '美股开盘',
    'us-post': '美股盘后'
  };

  function renderTimeline(now, barEl, axisEl, hours) {
    hours = hours || 24;
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
      tick.style.left = (h / hours * 100) + '%';

      const num = h === 0 ? '现在' : pad(p.hour) + ':00';
      let label = '';
      if (h === 0) label = pad(partsInTz(SYD, now).hour) + ':' + pad(partsInTz(SYD, now).minute);
      else if (h === hours) label = hours + '小时后';
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

  // ── Earnings data ──
  // NY release time → Sydney landing time
  const earningsData = [
    {
      ny: { y: 2026, m: 3, d: 27, h: 17, mn: 0 }, type: 'AMC',
      major: false,
      cos: ['Welltower', 'Whirlpool', 'Cadence', 'Brown & Brown']
    },
    {
      ny: { y: 2026, m: 3, d: 28, h: 7, mn: 0 }, type: 'BMO',
      major: true,
      cos: ['Visa', 'Coca-Cola'],
      extra: 'Spotify, Starbucks, UPS, Mondelez, T-Mobile, BP, Novartis'
    },
    {
      ny: { y: 2026, m: 3, d: 29, h: 17, mn: 0 }, type: 'AMC',
      major: true,
      cos: ['Microsoft', 'Meta', 'Alphabet', 'Amazon'],
      extra: 'Qualcomm, AbbVie',
      event: 'FOMC 利率决议'
    },
    {
      ny: { y: 2026, m: 3, d: 30, h: 17, mn: 0 }, type: 'AMC',
      major: true,
      cos: ['Apple', 'Eli Lilly'],
      extra: 'Mastercard, Caterpillar, Merck, Amgen, SanDisk',
      event: '美国 Q1 GDP 初值 · 欧央行利率决议'
    },
    {
      ny: { y: 2026, m: 4, d: 1, h: 7, mn: 0 }, type: 'BMO',
      major: false,
      cos: ['ExxonMobil', 'Chevron'],
      extra: 'Colgate-Palmolive',
      event: 'ISM 制造业 PMI'
    }
  ];

  function fmtSydneyForAgenda(date) {
    const p = partsInTz(SYD, date);
    return '周' + DAY_CN[p.dayIdx] + ' ' + p.day + ' ' + p.month + ' · ' + fmtClock24(p);
  }

  function relativeDay(date, now) {
    const pNow = partsInTz(SYD, now);
    const pThen = partsInTz(SYD, date);
    const dayMs = 24 * 3600 * 1000;
    const sydDateKey = (p) => p.year + '-' + p.month + '-' + p.day;
    const diffDays = Math.round((date.getTime() - now.getTime()) / dayMs);
    if (sydDateKey(pNow) === sydDateKey(pThen)) return '今天';
    const tomorrow = new Date(now.getTime() + dayMs);
    if (sydDateKey(partsInTz(SYD, tomorrow)) === sydDateKey(pThen)) return '明天';
    const dayAfter = new Date(now.getTime() + 2 * dayMs);
    if (sydDateKey(partsInTz(SYD, dayAfter)) === sydDateKey(pThen)) return '后天';
    if (diffDays >= 0 && diffDays <= 6) return diffDays + ' 天后';
    if (diffDays < 0) return Math.abs(diffDays) + ' 天前';
    return null;
  }

  function renderAgenda(now, container, opts) {
    opts = opts || {};
    const limit = opts.limit || null;
    container.innerHTML = '';
    let items = earningsData
      .map(e => Object.assign({}, e, { sydDate: nyWallToDate(e.ny.y, e.ny.m, e.ny.d, e.ny.h, e.ny.mn) }))
      .filter(e => e.sydDate.getTime() > now.getTime() - 3 * 3600 * 1000)
      .sort((a, b) => a.sydDate - b.sydDate);

    if (limit) items = items.slice(0, limit);

    if (items.length === 0) {
      container.innerHTML = '<p class="agenda-cos" style="color: var(--text-2);">本周暂无重要财报。</p>';
      return;
    }

    items.forEach(e => {
      const div = document.createElement('div');
      div.className = 'agenda-item';
      const tagClass = e.major ? 'agenda-tag is-major' : 'agenda-tag';
      const tagText = e.type === 'BMO' ? '美股盘前' : '美股盘后';

      const rel = relativeDay(e.sydDate, now);
      const relSpan = rel ? ' <span class="agenda-time-rel">· ' + rel + '</span>' : '';

      let html = '';
      html += '<div class="agenda-when">';
      html += '<span class="agenda-time">' + fmtSydneyForAgenda(e.sydDate) + relSpan + '</span>';
      html += '<span class="' + tagClass + '">' + tagText + '</span>';
      html += '</div>';
      html += '<p class="agenda-cos' + (e.major ? ' is-major' : '') + '">' + e.cos.join(', ') + '</p>';
      if (e.extra) html += '<p class="agenda-extra">+ ' + e.extra + '</p>';
      if (e.event) html += '<p class="agenda-event">' + e.event + '</p>';

      div.innerHTML = html;
      container.appendChild(div);
    });
  }

  function fmtCountdown(ms) {
    if (ms < 0) return '现在';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return days + ' 天 ' + hours + ' 小时后';
    if (hours > 0) return hours + ' 小时 ' + pad(mins) + ' 分钟后';
    return mins + ' 分钟后';
  }

  global.MarketsLib = {
    SYD, NY, DAY_NAMES, DAY_LONG_EN, DAY_CN,
    pad, partsInTz, fmtClockHMS, fmtClock24,
    asxStatusText, usStatusText, findNextEvent,
    renderTimeline, renderAgenda, fmtCountdown
  };
})(window);
