const q = new URLSearchParams(location.search);
const clean = (k, re) => { const v = q.get(k) || ''; return re.test(v) ? v : ''; };
const f = { v: clean('v', /^\d{1,3}\.\d{1,3}\.\d{1,3}$/), os: clean('os', /^(win|mac|linux|other)$/), s: clean('s', /^[012]$/), r: clean('r', /^(missing|old|noanswer|port|stopped|unknown)$/) };
for (const k in f) { const i = document.querySelector('input[name=' + k + ']'); if (i) i.value = f[k]; }
if (q.get('sent')) { const form = document.querySelector('form'); if (form) form.hidden = true; document.getElementById('thanks').hidden = false; }
const issue = document.getElementById('issue');
if (issue) {
  const body = 'What went wrong?\n\n\n---\nAdd-on: ' + (f.v || 'unknown') + '\nOS: ' + (f.os || 'unknown') + '\nSetup stage: ' + (f.s || 'unknown') + (f.r ? '\nHelper: ' + f.r : '') + '\n';
  issue.href = '/go/issue?from=site&title=' + encodeURIComponent('Why I uninstalled') + '&body=' + encodeURIComponent(body);
}
