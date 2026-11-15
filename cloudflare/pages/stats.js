const out = document.getElementById('out'), meta = document.getElementById('meta');
const $ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const num = n => Number(n || 0).toLocaleString('en');
const h2 = (text, note) => { out.append($('h2', '', text)); if (note) out.append($('p', 'note', note)); };
function tile(k, n, d) { const t = $('div', 'tile'); t.append($('div', 'k', k), $('div', 'n', num(n)), $('div', 'd', d)); return t; }
function bars(rows, label) {
  const box = $('div'), max = Math.max(1, ...rows.map(r => r.n));
  for (const r of rows) {
    const row = $('div', 'bar'), i = $('i'), track = $('div');
    i.style.width = r.n ? Math.max(1, Math.round(r.n / max * 100)) + '%' : '0';
    track.append(i);
    row.append($('span', '', label(r)), track, $('b', '', num(r.n)));
    box.append(row);
  }
  return box;
}
function chart(rows, today) {
  const days = [], map = new Map(rows.map(r => [r.day, r.n]));
  for (let i = 59; i >= 0; i--) { const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10); days.push({ d, n: map.get(d) || 0 }); }
  const max = Math.max(1, ...days.map(x => x.n)), W = 600, H = 150, bw = W / days.length;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 20)); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Daily active users, last 60 days');
  const el = (name, attrs, text) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  el('line', { x1: 0, x2: W, y1: H, y2: H });
  days.forEach((x, i) => {
    if (!x.n) return;
    const h = Math.max(2, Math.round(x.n / max * (H - 14)));
    const r = el('rect', { x: i * bw + 1, y: H - h, width: Math.max(1, bw - 2), height: h });
    const t = document.createElementNS(NS, 'title'); t.textContent = x.d + ': ' + x.n; r.append(t);
  });
  el('text', { x: 0, y: H + 14 }, days[0].d); el('text', { x: W, y: H + 14, 'text-anchor': 'end' }, days[days.length - 1].d); el('text', { x: W, y: 10, 'text-anchor': 'end' }, 'max ' + max);
  return svg;
}
const REASON = { missing: 'Helper not installed', old: 'Helper or add-on too old', noanswer: 'Helper started, never answered', port: 'Helper cannot listen (port)', stopped: 'Helper stopped', unknown: 'Other' };
const AGE = { '0': 'day 0', '1-6': 'days 1 to 6', '7+': '7 days or more', na: 'age unknown' };
fetch('/endpoint/stats', { credentials: 'same-origin', cache: 'no-store' }).then(r => {
  if (r.status === 401) { location.href = '/stats/login'; throw 0; }
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}).then(s => {
  const nothing = !s.users && !s.downloads.assets.length && !s.clicks.length && !(s.feedback && s.feedback.total);
  meta.textContent = s.users ? 'Counting installs since ' + s.since + '. Installs with Firefox usage data turned off, or on an older version, are not counted. Installs from before 0.6.0 count from their first report.' : 'No reports yet.';
  if (nothing) out.append($('div', 'empty', 'Nothing counted yet. Numbers appear after the first add-on report.'));
  const dayRow = d => (s.daily.find(r => r.day === d) || { n: 0 }).n;
  const yest = new Date(Date.parse(s.today + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
  const tiles = $('div', 'tiles');
  const usedRow = d => Number((s.daily.find(r => r.day === d) || {}).used || 0);
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : 'n/a';
  tiles.append(tile('DAU', dayRow(yest), 'installs that reported yesterday; ' + num(dayRow(s.today)) + ' so far today'),
    tile('AAU', usedRow(yest), 'installs where an AI command ran yesterday; ' + num(s.rolling.aau7) + ' in 7 days, ' + num(s.rolling.aau30) + ' in 30 days'),
    tile('MAU', s.rolling.mau, 'installs that reported in 30 days; ' + num((s.months[0] || {}).n) + ' this calendar month'),
    tile('Unique installs', s.installs, 'all time'));
  const share = $('p', 'note', 'AAU share yesterday: ' + pct(usedRow(yest), dayRow(yest)) + ' of DAU. Over 30 days: ' + pct(s.rolling.aau30, s.installs) + ' of all installs, ' + pct(s.rolling.aau30, s.rolling.mau) + ' of MAU.');
  out.append(tiles, share);
  h2('Daily actives', 'Installs that reported, last 60 days.');
  if (s.daily.length) out.append(chart(s.daily, s.today)); else out.append($('div', 'empty', 'No data.'));
  h2('Setup funnel', 'Installs by the furthest step they reached.');
  const f = s.funnel;
  out.append(bars([{ k: 'Add-on installed', n: f.installed }, { k: 'Helper connected', n: f.helper }, { k: 'First AI command', n: f.command }], r => r.k));
  h2('Stuck at the helper', 'Installs that never got the helper connected, by reason and days since their first report.');
  if (!s.stuck.length) out.append($('div', 'empty', 'None counted.'));
  else out.append(bars(s.stuck.slice().sort((a, b) => b.n - a.n), r => (REASON[r.reason] || r.reason) + ', ' + (AGE[r.age] || r.age)));
  h2('Retention', 'Of installs first seen at least that many days ago, the share that reported again on that exact day, and the share where an AI command ran.');
  const ret = $('div'); out.append(ret);
  for (const r of s.retention) ret.append($('p', '', 'Day ' + r.day + ': ' + (r.cohort ? Math.round(r.kept / r.cohort * 100) + '% (' + num(r.kept) + ' of ' + num(r.cohort) + '), command ran ' + Math.round(r.keptUsed / r.cohort * 100) + '%' : 'no installs old enough yet')));
  h2('Active in the last 30 days, by version');
  out.append(s.byVersion.length ? bars(s.byVersion, r => r.name) : $('div', 'empty', 'No data.'));
  h2('Active in the last 30 days, by OS');
  out.append(s.byOs.length ? bars(s.byOs, r => r.name) : $('div', 'empty', 'No data.'));
  h2('Harnesses', 'Installs that connected an AI client of each kind in the last 30 days, against how many picked it on the setup page.');
  if (!s.harnesses.length) out.append($('div', 'empty', 'None counted.'));
  else out.append(bars(s.harnesses.map(r => ({ name: r.name, n: r.used30, picked: r.picked, y: r.usedYesterday })), r => r.name + ' (picked ' + num(r.picked) + ', yesterday ' + num(r.y) + ')'));
  h2('Helper downloads', 'Redirects to GitHub, not unique people. Per asset, all time.');
  if (!s.downloads.assets.length) out.append($('div', 'empty', 'No downloads counted.'));
  else out.append(bars(s.downloads.assets, r => r.name + ' (' + num(r.recent) + ' in 30 days)'));
  h2('Link clicks', 'Clicks on links that go through /go, by where the link was. Clicks, not people. All time.');
  if (!s.clicks.length) out.append($('div', 'empty', 'No clicks counted.'));
  else out.append(bars(s.clicks, r => r.target + ' from ' + r.src + ' (' + num(r.recent) + ' in 30 days)'));
  if (s.feedback) {
    h2('Feedback', s.feedback.total + ' stored, newest 100 shown.');
    if (!s.feedback.items.length) out.append($('div', 'empty', 'No feedback yet.'));
    for (const i of s.feedback.items) {
      const d = $('div', 'feedback-item');
      d.append($('div', 'note', [i.at, i.v && 'v' + i.v, i.os, i.stage && 'stage ' + i.stage, i.reason, i.age].filter(Boolean).join(' · ')), $('p', '', i.text));
      out.append(d);
    }
  }
}).catch(e => { if (e !== 0) meta.textContent = 'Could not load the numbers.'; });
