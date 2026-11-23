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
function chart(rows, today, key = 'n', what = 'Daily active users') {
  const days = [], map = new Map(rows.map(r => [r.day, Number(r[key] || 0)]));
  for (let i = 59; i >= 0; i--) { const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10); days.push({ d, n: map.get(d) || 0 }); }
  const max = Math.max(1, ...days.map(x => x.n)), W = 600, H = 150, bw = W / days.length;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 2)); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', what + ', last 60 days');
  const el = (name, attrs, text) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  el('line', { x1: 0, x2: W, y1: H, y2: H });
  days.forEach((x, i) => {
    if (!x.n) return;
    const h = Math.max(2, Math.round(x.n / max * (H - 14)));
    const r = el('rect', { x: i * bw + 1, y: H - h, width: Math.max(1, bw - 2), height: h });
    const t = document.createElementNS(NS, 'title'); t.textContent = x.d + ': ' + x.n; r.append(t);
  });
  // Labels are HTML so they stay readable when the chart shrinks on a phone.
  const axis = $('div', 'axis'); axis.append($('span', '', days[0].d), $('span', '', 'max ' + num(max)), $('span', '', days[days.length - 1].d));
  const box = $('div'); box.append(svg, axis);
  return box;
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
  tiles.append(tile('DAU', usedRow(yest), 'yesterday; ' + num(usedRow(s.today)) + ' so far today'),
    tile('Active, 30 days', s.rolling.aau30, 'installs that ran a command; ' + num(s.rolling.aau7) + ' in 7 days'),
    tile('Installs', s.installs, 'all time'));
  const share = $('p', 'note', 'DAU is installs that ran an AI command that day. Active, 30 days is installs that ran one in the last 30 days. Installs counts every install that has reported. Active over 30 days: ' + pct(s.rolling.aau30, s.installs) + ' of installs.');
  out.append(tiles, share);
  h2('Daily actives', 'Installs that ran an AI command each day, last 60 days.');
  if (s.daily.length) out.append(chart(s.daily, s.today, 'used')); else out.append($('div', 'empty', 'No data.'));
  h2('Usage minutes', 'A minute counts when an AI command ran in it. A report covers the time since the previous report, so a day can include the tail of the day before. Per actual active user per day.');
  if (s.daily.some(r => r.minutes)) out.append(chart(s.daily, s.today, 'minutes', 'Usage minutes')); else out.append($('div', 'empty', 'No usage minutes yet.'));
  const mt = $('div', 'tiles');
  const mTile = (k, d) => tile(k, d.avg, d.days ? 'median ' + num(d.median) + ', over ' + num(d.days) + ' user-days' : 'no user-days yet');
  mt.append(mTile('Average, 7 days', s.minutes.last7), mTile('Average, 30 days', s.minutes.last30));
  out.append(mt);
  out.append($('p', 'note', 'User-days by minutes, last 30 days.'));
  out.append(bars(s.minutes.buckets.map(b => ({ name: b.label, n: b.n })), r => r.name + ' min'));
  h2('Setup funnel', 'Opt-in installs by the furthest step reported. Progress made after a daily report can show up on a later day.');
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
  h2('Active in the last 30 days, by Firefox language', 'Firefox’s UI language only, without regions. Older reports are counted as Unknown.');
  const languages = new Intl.DisplayNames(['en'], { type: 'language' });
  const byLanguage = s.byLanguage || [];
  out.append(byLanguage.length ? bars(byLanguage, r => r.name === 'unknown' ? 'Unknown' : r.name === 'other' ? 'Other' : languages.of(r.name)) : $('div', 'empty', 'No data.'));
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
