// Desk: the factory's website. Every view reads live from the private repositories with the signed-in person's own
// token; nothing is stored anywhere but in this browser's memory (and the token in this browser, if asked to).
import { client, session, GitHubError } from './gh.js';
import { buildGame } from './builder.js';
import { render as renderMd, esc } from './md.js';
import { prepare } from './art.js';

const $ = s => document.querySelector(s);
const root = $('#view');
let cur = root;   // each page draws into its own container (captured when the page starts), so a page still loading cannot draw into the next one
function fresh() { cur = document.createElement('div'); cur.className = 'page'; root.replaceChildren(cur); }
let S = null;   // { gh, token, user, factory, release, admin, canBuild }

// ---------- small DOM helpers (text always goes in as text, never as HTML) ----------
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;   // only for our own markup or the escaped report renderer
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const chip = (cls, text) => el('span', { class: 'chip ' + cls, text });
const note = (cls, ...kids) => el('div', { class: 'note ' + (cls || '') }, ...kids);
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now'; if (s < 5400) return Math.round(s / 60) + ' min ago'; if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
// Every time is shown in Istanbul time, whatever the viewer's computer is set to
const TZ = 'Europe/Istanbul';
const fmtShort = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtFull = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const when = iso => fmtShort.format(new Date(iso));                  // 14 Oct, 16:58
const full = d => fmtFull.format(d instanceof Date ? d : new Date(d)); // 2026-10-14 16:58
const relDate = s => new Date(String(s).replace(' UTC', 'Z').replace(' ', 'T'));   // releases.json: "2026-10-14 13:58 UTC"
const ISTANBUL = 'Times are Istanbul time.';
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
function page(view, title, sub, ...actions) {
  view.replaceChildren(el('div', { class: 'head' }, el('div', {}, el('h1', { text: title }), sub ? el('p', { class: 'muted', text: sub }) : null), el('div', { class: 'row' }, ...actions)));
}
const loading = (view, text) => view.append(el('p', { class: 'muted', text: text || 'Loading…' }));
function fail(view, e) {
  if (e instanceof GitHubError && e.status === 401) { signOut(); return; }
  view.append(note('bad', e.message || String(e)));
  console.error(e);
}

// ---------- the factory, read from GitHub ----------
const F = () => '/repos/' + S.factory, R = () => '/repos/' + S.release;
async function mainSha(repo) { return (await S.gh.get('/repos/' + (repo || S.factory) + '/git/ref/heads/main')).object.sha; }
async function games(sha) {
  const all = await S.gh.reader(S.factory, sha || await mainSha(), '');
  const ids = [...new Set(all.paths().filter(p => /^games\/[^/]+\/game\.json$/.test(p)).map(p => p.split('/')[1]))];
  return pool(ids, 4, async id => {
    const g = { id };
    try { const c = JSON.parse(await all.text('games/' + id + '/game.json')); g.title = c.title; g.version = c.version; } catch (e) { g.title = id; g.error = 'game.json unreadable'; }
    try { const l = JSON.parse(await all.text('games/' + id + '/levels.json')); g.levels = (Array.isArray(l) ? l : l.levels || []).length; } catch (e) { g.levels = null; }
    return g;
  });
}
function prKind(pr) {
  const b = pr.head.ref;
  if (b.startsWith('submit/')) return { kind: 'game', id: b.slice(7) };
  if (b.startsWith('art/')) return { kind: 'art' };
  return { kind: 'other' };
}
async function prs(state) { return S.gh.get(F() + '/pulls?state=' + state + '&sort=updated&direction=desc&per_page=40'); }
// the factory check on a commit: { state: running|green|red|none, url }
async function checkOf(sha) {
  const r = await S.gh.get(F() + '/actions/runs?head_sha=' + sha + '&per_page=20');
  const runs = (r.workflow_runs || []).filter(x => x.name === 'Factory check').sort((a, b) => (b.event === 'pull_request') - (a.event === 'pull_request') || new Date(b.created_at) - new Date(a.created_at));
  const x = runs[0];
  if (!x) return { state: 'none' };
  if (x.status !== 'completed') return { state: 'running', url: x.html_url };
  return { state: x.conclusion === 'success' ? 'green' : 'red', url: x.html_url };
}
const checkChip = c => c.state === 'green' ? chip('good', 'All green') : c.state === 'red' ? chip('bad', 'Needs fixes') : c.state === 'running' ? chip('warn run', 'Checking…') : chip('', 'Not checked');
async function releases() {
  if (!S.canBuild) return [];
  try { const rd = await S.gh.reader(S.release, await mainSha(S.release), ''); return rd.has('releases.json') ? JSON.parse(await rd.text('releases.json')) : []; }
  catch (e) { return []; }
}

// ---------- sign-in ----------
function signInView(msg) {
  const view = cur;
  $('#nav').hidden = true; $('#who').hidden = true; fresh();
  const saved = (() => { try { return JSON.parse(localStorage.getItem('desk.repos') || 'null'); } catch (e) { return null; } })() || {};
  const token = el('input', { id: 'token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
  const factory = el('input', { id: 'factory', placeholder: 'organization/repository', value: saved.factory || '', spellcheck: 'false' });
  const release = el('input', { id: 'release', placeholder: 'organization/repository (owner only)', value: saved.release || '', spellcheck: 'false' });
  const remember = el('input', { id: 'remember', type: 'checkbox' });
  const status = el('p', { class: 'small muted', role: 'status' });
  const go = el('button', { type: 'submit', text: 'Sign in' });
  const form = el('form', { class: 'card signin stack', onsubmit: async ev => {
    ev.preventDefault(); go.disabled = true; status.textContent = 'Checking with GitHub…';
    try {
      const v = { token: token.value.trim(), factory: factory.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''), release: release.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') };
      if (!v.token || !/^[\w.-]+\/[\w.-]+$/.test(v.factory)) throw new Error('Enter your token and the factory repository as organization/repository.');
      if (v.release && !/^[\w.-]+\/[\w.-]+$/.test(v.release)) throw new Error('The release repository must look like organization/repository, or stay empty.');
      await start(v);
      session.save(v, remember.checked);
      try { localStorage.setItem('desk.repos', JSON.stringify({ factory: v.factory, release: v.release })); } catch (e) {}
      token.value = '';
      route();
    } catch (e) { status.textContent = ''; status.append(note('bad', e.message)); go.disabled = false; S = null; }
  } },
    el('h1', { text: 'Sign in' }),
    el('p', { class: 'muted', text: 'Use your own GitHub token. It stays in this browser and is sent only to GitHub.' }),
    msg ? note('warn', msg) : null,
    el('label', { for: 'token' }, 'GitHub token', token),
    el('label', { for: 'factory' }, 'Factory repository', factory),
    el('label', { for: 'release' }, 'Release repository (leave empty unless you build releases)', release),
    el('label', { class: 'inline', for: 'remember' }, remember, 'Keep me signed in on this device'),
    el('div', { class: 'row' }, go), status,
    el('details', {}, el('summary', { text: 'How to make a token' }), tokenHelp()));
  view.replaceChildren(form);
}
function tokenHelp() {
  return el('div', { class: 'stack small' },
    el('ol', { class: 'steps' },
      el('li', {}, 'On GitHub: your picture > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.'),
      el('li', {}, 'Resource owner: the organization. Expiration: the longest your organization allows (you renew it when it ends).'),
      el('li', {}, 'Repository access: Only select repositories: the factory repository (and the release repository if you build releases).'),
      el('li', {}, 'Permissions for the factory repository: Contents: Read and write. Pull requests: Read and write. Actions: Read-only.'),
      el('li', {}, 'For the release repository (owner only): Actions: Read and write. Contents: Read-only.'),
      el('li', {}, 'Generate, copy it, and paste it here. GitHub shows it only once; never send it to anyone.')));
}
async function start(v) {
  const gh = client(v.token);
  const user = await gh.get('/user');
  let repo;
  try { repo = await gh.get('/repos/' + v.factory); } catch (e) { throw new Error('This token cannot open the factory repository (' + v.factory + '). Check the name and the token\'s repository access.'); }
  let canBuild = false;
  if (v.release) { try { await gh.get('/repos/' + v.release); canBuild = true; } catch (e) { throw new Error('This token cannot open the release repository. Leave that field empty unless you build releases.'); } }
  S = { gh, token: v.token, user, factory: v.factory, release: v.release || null, admin: !!(repo.permissions && repo.permissions.admin), push: !!(repo.permissions && repo.permissions.push), canBuild };
}
function signOut() { session.clear(); S = null; location.hash = ''; signInView(); }
$('#logout').addEventListener('click', signOut);

// ---------- the player: a game in a sealed frame ----------
let playing = null;   // { title, page, id }
function storageShim(id, level) {
  // the frame has no storage of its own (sealed): give the kit an in-memory one, starting at the chosen level
  return '<script>(function(){var m={};m[' + JSON.stringify('dk.' + id + '.progress') + ']=' + JSON.stringify(JSON.stringify({ next: level })) + ';' +
    'var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};' +
    'try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(e){}})();<\/script>\n';
}
// the kit's screens on request (art previews): the page listens to this page only, and only for these names
const SCREEN_SCRIPT = '<script>(function(){var lvl=function(){DK.pop.close();if(DK.game&&DK.game.stop)DK.game.stop();DK.screen.show("home");DK.store.set("progress",{next:14});DK.economy._set({lives:5});DK.flow.play();setTimeout(function(){DK.pop.close();},50);};' +
  'var A={home:function(){DK.pop.close();if(DK.game&&DK.game.stop)DK.game.stop();DK.screen.show("home");},settings:function(){A.home();DK.settingsUI.open(false);},level:lvl,' +
  'paused:function(){lvl();setTimeout(function(){DK.flow.pause();},120);},booster:function(){lvl();setTimeout(function(){DK.boosters.list().forEach(function(b){DK.boosters.add(b.id,-DK.boosters.count(b.id));});var b=DK.boosters.list()[0];if(b)DK.boosters.use(b.id);},120);},' +
  'fail:function(){lvl();setTimeout(function(){DK.flow.failed({reason:"Out of moves!",offer:"Play On: 5 more moves"});},120);},' +
  'fail2:function(){A.fail();setTimeout(function(){var x=document.querySelector("#dk-pops .dk-panel > .dk-round.x");if(x)x.click();},300);},' +
  'failed:function(){A.fail2();setTimeout(function(){var x=document.querySelector("#dk-pops .dk-panel > .dk-round.x");if(x)x.click();},600);},' +
  'win:function(){lvl();setTimeout(function(){DK.flow.won();},120);},nolives:function(){A.home();DK.economy._set({lives:0});DK.flow.play();}};' +
  'addEventListener("message",function(e){if(e.source!==parent||typeof e.data!=="object"||!e.data||e.data.desk!=="screen"||!A.hasOwnProperty(e.data.name))return;try{A[e.data.name]();}catch(x){}});})();<\/script>\n';
function showGame() {
  const lvl = Math.max(1, parseInt($('#player-level').value, 10) || 1);
  let page = playing.page.replace('<head>\n', () => '<head>\n' + storageShim(playing.id, lvl));
  if (playing.screens) page = page.replace(/<\/body>\n<\/html>\n$/, () => SCREEN_SCRIPT + '</body>\n</html>\n');
  $('#player-frame').srcdoc = page;
}
$('#player-screen').addEventListener('change', e => {
  const v = e.target.value; e.target.value = '';
  if (v && playing) $('#player-frame').contentWindow.postMessage({ desk: 'screen', name: v }, '*');
});
async function play(title, makePage, opts) {
  $('#player').hidden = false; $('#player-title').textContent = title; $('#player-msg').textContent = 'Building the game from GitHub…';
  $('#player-frame').srcdoc = '<p style="font:14px system-ui;color:#999;padding:16px">Building…</p>';
  try {
    const { page, cfg } = await makePage();
    playing = { title, page, id: cfg.id, screens: !!(opts && opts.screens) };
    $('#player-screen').hidden = !playing.screens;
    $('#player-msg').textContent = cfg.title + ' · built in this browser from GitHub · progress is not saved';
    showGame();
  } catch (e) { $('#player-msg').textContent = ''; $('#player-frame').srcdoc = '<p style="font:14px system-ui;color:#f88;padding:16px">' + esc(e.message || e) + '</p>'; }
}
$('#player-restart').addEventListener('click', () => { if (playing) showGame(); });
$('#player-close').addEventListener('click', () => { $('#player').hidden = true; $('#player-frame').srcdoc = ''; playing = null; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#player').hidden) $('#player-close').click(); });
async function gamePage(gameSha, id, kitOverlay) {
  const kitSha = await mainSha();
  let kit = await S.gh.reader(S.factory, kitSha, 'kit');
  if (kitOverlay) kit = kitOverlay(kit);
  const game = id === '@starter' ? await S.gh.reader(S.factory, kitSha, 'templates/starter') : await S.gh.reader(S.factory, gameSha, 'games/' + id);
  return buildGame(kit, game, { bots: false });
}

// ---------- downloads: the "downloads" branch of a repository (test apps of submissions; files of release builds) ----------
async function downloadsReader(repo) {
  try { return await S.gh.reader(repo, (await S.gh.get('/repos/' + repo + '/git/ref/heads/downloads')).object.sha, ''); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
const MIME = { apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', html: 'text/html', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', json: 'application/json' };
// a file from a downloads branch, saved by the browser under `name`
async function saveFile(dl, filePath, name, btn) {
  const label = btn && btn.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
    const bytes = await dl.bytes(filePath);
    const url = URL.createObjectURL(new Blob([bytes], { type: MIME[name.split('.').pop()] || 'application/octet-stream' }));
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alertNote(btn, e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}
function alertNote(near, msg) { if (near && near.parentNode) near.parentNode.append(note('bad', msg)); }
const dlButton = (dl, filePath, name, text, cls) => { const b = el('button', { type: 'button', class: cls || 'ghost', text }); b.addEventListener('click', () => saveFile(dl, filePath, name, b)); return b; };
const fileSize = (dl, p) => { const e = dl.entry(p); return e && e.size ? ' · ' + (e.size > 1e6 ? (e.size / 1e6).toFixed(1) + ' MB' : Math.round(e.size / 1024) + ' KB') : ''; };

// ---------- Dashboard ----------
async function dashboardView() {
  const view = cur;
  page(view, 'Dashboard', S.canBuild ? 'Games on main, open submissions and releases.' : 'Games on main and open submissions.');
  loading(view);
  try {
    const [list, open, rel] = await Promise.all([games(), prs('open'), releases()]);
    const checks = await pool(open, 4, p => checkOf(p.head.sha).catch(() => ({ state: 'none' })));
    view.lastChild.remove();
    const count = s => checks.filter(c => c.state === s).length;
    view.append(el('div', { class: 'grid' },
      el('div', { class: 'card stat' }, el('span', { class: 'muted small', text: 'Games on main' }), el('b', { text: list.length })),
      el('div', { class: 'card stat' }, el('span', { class: 'muted small', text: 'Open submissions' }), el('b', { text: open.length }),
        el('div', { class: 'row small' }, chip('good', count('green') + ' green'), chip('bad', count('red') + ' to fix'), chip('warn', count('running') + ' checking'))),
      S.canBuild ? el('div', { class: 'card stat' }, el('span', { class: 'muted small', text: 'Builds (last 30 days)' }), el('b', { text: rel.filter(r => Date.now() - relDate(r.date) < 30 * 864e5).length })) : null));
    const latest = (id, env) => rel.filter(r => r.game === id && r.environment === env).slice(-1)[0];
    const openFor = id => open.find(p => prKind(p).id === id);
    const rows = list.sort((a, b) => String(a.title).localeCompare(b.title)).map(g => {
      const sub = openFor(g.id), s = latest(g.id, 'sandbox'), p = latest(g.id, 'production');
      return el('tr', {},
        el('td', {}, el('strong', { text: g.title }), el('div', { class: 'muted small', text: g.id })),
        el('td', { class: 'num', text: g.levels == null ? '?' : g.levels }), el('td', { class: 'num', text: g.version || '' }),
        S.canBuild ? el('td', { class: 'small' }, s ? s.versionCode + ' · ' + fmtDay.format(relDate(s.date)) : '–') : null,
        S.canBuild ? el('td', { class: 'small' }, p ? p.versionCode + ' · ' + fmtDay.format(relDate(p.date)) : '–', p ? el('div', { class: 'muted', text: p.package }) : null) : null,
        el('td', {}, sub ? el('a', { href: '#submission/' + sub.number, text: 'Update open (#' + sub.number + ')' }) : el('span', { class: 'muted small', text: '–' })),
        el('td', {}, el('button', { class: 'ghost', type: 'button', text: 'Play', onclick: async () => play(g.title, async () => gamePage(await mainSha(), g.id)) })));
    });
    view.append(el('section', { class: 'card' }, el('h2', { text: 'Games on main' }),
      list.length ? el('div', { class: 'table' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Game', 'Levels', 'Version'].concat(S.canBuild ? ['Last sandbox', 'Last production'] : []).concat(['Submission', '']).map(t => el('th', { text: t })))), el('tbody', {}, rows)))
        : el('p', { class: 'muted', text: 'No games yet. Approved submissions appear here.' })));
  } catch (e) { view.lastChild && view.lastChild.tagName === 'P' && view.lastChild.remove(); fail(view, e); }
}

// ---------- Submissions ----------
async function submissionsView(state) {
  const view = cur;
  state = state === 'closed' ? 'closed' : 'open';
  page(view, 'Submissions', 'Every submission is a pull request; the factory check runs on each one.',
    el('a', { href: '#submissions', class: state === 'open' ? '' : 'muted', text: 'Open' }), el('a', { href: '#submissions/closed', class: state === 'closed' ? '' : 'muted', text: 'Closed' }));
  loading(view);
  try {
    const list = await prs(state);
    const checks = state === 'open' ? await pool(list, 4, p => checkOf(p.head.sha).catch(() => ({ state: 'none' }))) : [];
    view.lastChild.remove();
    const box = el('section', { class: 'card list' });
    if (!list.length) box.append(el('p', { class: 'muted', text: state === 'open' ? 'Nothing waiting. New submissions appear here.' : 'No closed submissions.' }));
    list.forEach((p, i) => {
      const k = prKind(p);
      box.append(el('a', { class: 'item', href: '#submission/' + p.number },
        el('span', { class: 'tag', text: k.kind === 'game' ? 'Game' : k.kind === 'art' ? 'Art' : 'Factory' }),
        el('span', { class: 'title', text: p.title }),
        state === 'open' ? checkChip(checks[i]) : chip(p.merged_at ? 'good' : '', p.merged_at ? 'Approved' : 'Declined'),
        el('span', { class: 'meta', title: full(p.updated_at) + ' (Istanbul)', text: '#' + p.number + ' · ' + p.user.login + ' · updated ' + ago(p.updated_at) })));
    });
    view.append(box);
  } catch (e) { fail(view, e); }
}
async function submissionView(n) {
  const view = cur;
  page(view, 'Submission #' + n, '');
  loading(view);
  try {
    const p = await S.gh.get(F() + '/pulls/' + n);
    const k = prKind(p), check = await checkOf(p.head.sha).catch(() => ({ state: 'none' }));
    const comments = await S.gh.get(F() + '/issues/' + n + '/comments?per_page=100');
    const files = await S.gh.get(F() + '/pulls/' + n + '/files?per_page=100');
    if (k.kind === 'other') { const g = files.map(f => /^games\/([^/]+)\//.exec(f.filename)).find(Boolean); if (g) { k.kind = 'game'; k.id = g[1]; } else if (files.every(f => f.filename.startsWith('kit/art/'))) k.kind = 'art'; }
    const report = comments.filter(c => c.user && c.user.type === 'Bot' && /Factory check|Art pack/.test(c.body)).slice(-1)[0];
    view.replaceChildren();
    const open = p.state === 'open';
    const stateChip = open ? checkChip(check) : chip(p.merged_at ? 'good' : '', p.merged_at ? 'Approved and merged' : 'Declined');
    view.append(el('div', { class: 'head' }, el('div', {}, el('span', { class: 'tag', text: k.kind === 'game' ? 'Game · ' + k.id : k.kind === 'art' ? 'Art' : 'Factory' }), el('h1', { text: p.title }),
      el('p', { class: 'muted', text: '#' + n + ' by ' + p.user.login + ' · branch ' + p.head.ref + ' · updated ' + ago(p.updated_at) + ' (' + full(p.updated_at) + ', Istanbul)' })),
      el('div', { class: 'row' }, stateChip, el('a', { href: p.html_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on GitHub' }))));

    const act = el('div', { class: 'row' }), msg = el('div', { class: 'stack' });
    if (k.kind === 'game') act.append(el('button', { type: 'button', text: 'Play this version', onclick: () => play(p.title, () => gamePage(p.head.sha, k.id)) }));
    if (k.kind === 'art') act.append(el('button', { type: 'button', text: 'Preview the art on the kit screens', onclick: () => play('Art preview: ' + p.title, async () => {
      const kit = await S.gh.reader(S.factory, p.head.sha, 'kit'), starter = await S.gh.reader(S.factory, p.head.sha, 'templates/starter');
      return buildGame(kit, starter, { bots: false });
    }, { screens: true }) }));
    if (open && S.admin) {
      const green = check.state === 'green';
      act.append(el('button', { type: 'button', text: 'Approve and merge', disabled: !green, title: green ? '' : 'Only a green submission can be approved', onclick: () => confirmBox(msg, 'Merge "' + p.title + '" into main? It becomes part of the factory.', 'Merge', async () => {
        await S.gh.put(F() + '/pulls/' + n + '/merge', { merge_method: 'squash', sha: p.head.sha });
        try { await S.gh.del(F() + '/git/refs/heads/' + p.head.ref.split('/').map(encodeURIComponent).join('/')); } catch (e) {}
        route();
      }) }));
      act.append(el('button', { type: 'button', class: 'ghost', text: 'Decline', onclick: () => declineBox(msg, n) }));
      if (k.kind === 'game' && green && S.canBuild) act.append(el('a', { href: '#builds', onclick: () => { try { sessionStorage.setItem('desk.prefill', JSON.stringify({ game: k.id, source: p.head.ref })); } catch (e) {} }, text: 'Sandbox build from this branch' }));
    }
    view.append(el('section', { class: 'card' }, act, msg,
      check.state === 'running' ? note('', 'The factory check is running, then the test app is built (about 10 minutes in all). Reload this page to see the result.') : null,
      open && check.state === 'red' ? note('bad', S.admin ? 'Not green: decline it with a short note, or wait for the submitter to fix it.' : 'Not green yet: fix what the report says and submit again. Your submission updates in place.') : null));
    if (k.kind === 'game') {
      const dl = await downloadsReader(S.factory).catch(() => null), dir = 'pr-' + n + '/';
      const info = dl && dl.has(dir + 'info.json') ? JSON.parse(await dl.text(dir + 'info.json')) : null;
      const box = el('section', { class: 'card' }, el('h2', { text: 'Test app' }));
      if (info && dl.has(dir + info.game + '-test.apk')) {
        const current = info.sha === p.head.sha;
        box.append(current ? el('p', { class: 'small muted', text: 'Built from this version on ' + full(relDate(info.date)) + ' (Istanbul).' }) : note('warn', 'These files are from an earlier version of this submission (' + full(relDate(info.date)) + '). The new ones appear when the check of the latest version is green.'),
          el('div', { class: 'row' },
            dlButton(dl, dir + info.game + '-test.apk', info.game + '-test-' + info.sha.slice(0, 7) + '.apk', 'Download the test app (.apk)' + fileSize(dl, dir + info.game + '-test.apk'), ''),
            dlButton(dl, dir + 'game.html', info.game + '-' + info.sha.slice(0, 7) + '.html', 'Download the game page (.html)' + fileSize(dl, dir + 'game.html'))),
          el('p', { class: 'small muted', text: 'The .apk installs on an Android phone (allow installing from your browser or files app when asked). It is a test build: signed with a test key, no Adjust, named "' + info.game + '" with the package com.duste.test.' + info.game + ', so it does not touch a store version on the same phone. The .html opens in any browser.' }));
      } else box.append(el('p', { class: 'muted', text: check.state === 'running' || check.state === 'none' ? 'The test app is built after a green check (about 10 minutes after submitting). Reload this page then.' : check.state === 'red' ? 'Only a green submission gets a test app. Fix what the report says and submit again.' : 'The test app is being built, or its build failed: see the check on GitHub.' }));
      view.append(box);
    }
    view.append(el('section', { class: 'card report' }, el('h2', { text: 'Factory check report' }),
      report ? el('div', { html: renderMd(report.body) }) : el('p', { class: 'muted', text: check.state === 'running' ? 'The report appears when the check finishes.' : 'No report yet.' }),
      check.url ? el('a', { href: check.url, target: '_blank', rel: 'noopener noreferrer', text: 'The check on GitHub (logs, test page download)' }) : null));
    view.append(el('section', { class: 'card' }, el('h2', { text: files.length + ' changed file' + (files.length === 1 ? '' : 's') }),
      el('div', { class: 'files' }, ...files.map(f => el('div', { text: f.status.padEnd(9) + ' ' + f.filename })))));
    const people = comments.filter(c => !(c.user && c.user.type === 'Bot'));
    if (people.length) view.append(el('section', { class: 'card' }, el('h2', { text: 'Notes' }), el('p', { class: 'small muted', text: ISTANBUL }), ...people.map(c => el('div', { class: 'stack' }, el('span', { class: 'muted small', text: c.user.login + ' · ' + when(c.created_at) }), el('p', { text: c.body })))));
  } catch (e) { fail(view, e); }
}
function confirmBox(box, question, label, fn) {
  const go = el('button', { type: 'button', class: 'danger', text: label }), status = el('span', { class: 'small muted' });
  go.addEventListener('click', async () => { go.disabled = true; status.textContent = 'Working…'; try { await fn(); } catch (e) { status.textContent = ''; box.append(note('bad', e.message)); go.disabled = false; } });
  box.replaceChildren(note('warn', el('div', { class: 'stack' }, el('span', { text: question }), el('div', { class: 'row' }, go, el('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => box.replaceChildren() }), status))));
}
function declineBox(box, n) {
  const why = el('textarea', { id: 'decline-why', placeholder: 'What to fix (the submitter sees this note).' });
  confirmBox(box, 'Decline this submission?', 'Decline', async () => {
    if (why.value.trim()) await S.gh.post(F() + '/issues/' + n + '/comments', { body: why.value.trim() });
    await S.gh.patch(F() + '/pulls/' + n, { state: 'closed' });
    route();
  });
  box.firstChild.firstChild.insertBefore(why, box.firstChild.firstChild.children[1]);
}

// ---------- Submit ----------
const SKIP = /(^|\/)(dist|node_modules|\.git)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;
const ALLOWED = ['.json', '.js', '.css', '.png', '.webp', '.md', '.txt'];
async function filesFromInput(list) {
  const files = [...list].map(f => ({ rel: f.webkitRelativePath || f.name, file: f }));
  return trimRoot(files);
}
async function filesFromDrop(items) {
  const out = [];
  async function walk(entry, pre) {
    if (entry.isFile) await new Promise(res => entry.file(f => { out.push({ rel: pre + entry.name, file: f }); res(); }, res));
    else if (entry.isDirectory) { const r = entry.createReader(); let batch; do { batch = await new Promise(res => r.readEntries(res, () => res([]))); for (const e of batch) await walk(e, pre + entry.name + '/'); } while (batch.length); }
  }
  for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) await walk(e, ''); }
  return trimRoot(out);
}
function trimRoot(files) {   // the chosen folder's own name is not part of the paths
  const tops = new Set(files.map(f => f.rel.split('/')[0]));
  if (tops.size === 1 && files.every(f => f.rel.includes('/'))) files.forEach(f => { f.rel = f.rel.slice(f.rel.indexOf('/') + 1); });
  return files.filter(f => !SKIP.test(f.rel));
}
function localReader(files) {
  const map = new Map(files.map(f => [f.rel, f.file]));
  const bytes = async p => { const f = map.get(p); if (!f) throw new Error('Missing file: ' + p); return new Uint8Array(await f.arrayBuffer()); };
  return { bytes, text: async p => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await bytes(p)),
    list: async d => { const pre = d ? d.replace(/\/?$/, '/') : ''; return [...new Set([...map.keys()].filter(k => k.startsWith(pre)).map(k => k.slice(pre.length).split('/')[0]))]; } };
}
async function precheck(files) {
  const names = files.map(f => f.rel), problems = [];
  for (const r of ['game.json', 'levels.json', 'game.js', 'bot.js']) if (!names.includes(r)) problems.push('missing ' + r);
  const odd = names.filter(n => !ALLOWED.includes(n.slice(n.lastIndexOf('.')).toLowerCase()));
  if (odd.length) problems.push('file types the factory does not take: ' + odd.join(', '));
  const big = files.filter(f => f.file.size > 5e6).map(f => f.rel);
  if (big.length) problems.push('files over 5 MB: ' + big.join(', '));
  let cfg = null, levels = null;
  if (names.includes('game.json')) { try { cfg = JSON.parse(await files.find(f => f.rel === 'game.json').file.text()); } catch (e) { problems.push('game.json is not valid JSON (' + e.message + ')'); } }
  if (cfg && !/^[a-z][a-z0-9]{2,29}$/.test(cfg.id || '')) problems.push('game.json "id" must be 3-30 lowercase letters/digits, starting with a letter');
  if (cfg && !cfg.title) problems.push('game.json needs a "title"');
  if (names.includes('levels.json')) { try { const l = JSON.parse(await files.find(f => f.rel === 'levels.json').file.text()); levels = Array.isArray(l) ? l : l.levels; if (!Array.isArray(levels)) problems.push('levels.json must be { "levels": [ ... ] }'); } catch (e) { problems.push('levels.json is not valid JSON (' + e.message + ')'); } }
  return { cfg, levels, problems };
}
function submitView() {
  const view = cur;
  page(view, 'Submit a game', 'Choose your game folder. The website checks the basics here, then the full factory check runs on GitHub.');
  const input = el('input', { type: 'file', id: 'folder', webkitdirectory: true, multiple: true, hidden: true });
  const drop = el('div', { class: 'drop' }, el('strong', { text: 'Drop the game folder here' }), el('span', { class: 'muted small', text: 'or' }),
    el('button', { type: 'button', class: 'ghost', text: 'Choose the folder', onclick: () => input.click() }),
    el('span', { class: 'muted small', text: 'The folder with game.json, levels.json, game.js and bot.js. dist/ and node_modules/ are left out.' }));
  const out = el('div', { class: 'stack' });
  view.append(el('section', { class: 'card' }, drop, input), out);
  const take = async files => { out.replaceChildren(el('p', { class: 'muted', text: 'Reading…' })); try { await reviewSubmission(files, out); } catch (e) { out.replaceChildren(note('bad', e.message)); } };
  input.addEventListener('change', async () => take(await filesFromInput(input.files)));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('over'); take(await filesFromDrop([...e.dataTransfer.items])); });
}
async function reviewSubmission(files, out) {
  const { cfg, levels, problems } = await precheck(files);
  const id = cfg && cfg.id;
  const [open, sha] = await Promise.all([prs('open'), mainSha()]);
  const mine = id ? open.find(p => p.head.ref === 'submit/' + id) : null;
  // a declined submission of the same game: the resubmission reopens it (same history, same notes)
  const declined = id && !mine ? (await S.gh.get(F() + '/pulls?state=closed&per_page=10&head=' + encodeURIComponent(S.factory.split('/')[0] + ':submit/' + id))).find(p => !p.merged_at) : null;
  const earlier = mine || declined;
  // an id is one game: a teammate cannot overwrite someone else's submission (the owner can, after a warning)
  const taken = earlier && earlier.user.login !== S.user.login ? earlier.user.login : null;
  if (taken && !S.admin) problems.push('the id "' + id + '" is used by ' + taken + '\'s submission #' + earlier.number + '. Use your own id in game.json (and the folder name), or ask ' + taken + '.');
  const onMain = id ? (await S.gh.reader(S.factory, sha, '')).has('games/' + id + '/game.json') : false;
  const total = files.reduce((s, f) => s + f.file.size, 0);
  out.replaceChildren();
  out.append(el('section', { class: 'card' },
    el('div', { class: 'row' }, el('h2', { text: cfg && cfg.title ? cfg.title : 'Your folder' }), id ? el('span', { class: 'tag', text: id }) : null,
      levels ? el('span', { class: 'muted small', text: levels.length + ' levels' }) : null, el('span', { class: 'muted small', text: files.length + ' files · ' + Math.round(total / 1024) + ' KB' })),
    problems.length ? note('bad', el('div', { class: 'stack' }, el('strong', { text: 'Fix these before submitting:' }), el('ul', {}, ...problems.map(p => el('li', { text: p }))))) : note('good', 'The basics look right. The full factory check runs after you submit.'),
    taken && S.admin ? note('warn', 'This id belongs to ' + taken + '\'s submission #' + earlier.number + ': submitting changes their submission.') : null,
    mine ? note('', 'This updates the open submission #' + mine.number + ' (the report updates too).') : declined ? note('', 'This resubmits the declined submission #' + declined.number + ' and reopens it (its notes stay).') : null,
    onMain ? note('warn', 'A game with the id "' + id + '" is already on main: this submission updates it.') : null,
    el('div', { class: 'files' }, ...files.map(f => el('div', { text: f.rel })))));
  if (problems.length) return;
  const status = el('div', { class: 'stack' });
  const go = el('button', { type: 'button', text: mine ? 'Update submission #' + mine.number : declined ? 'Resubmit #' + declined.number : 'Submit' });
  const tryIt = el('button', { type: 'button', class: 'ghost', text: 'Play it here first', onclick: () => play(cfg.title + ' (your folder)', async () => {
    const kit = await S.gh.reader(S.factory, await mainSha(), 'kit'); return buildGame(kit, localReader(files), { bots: false });
  }) });
  go.addEventListener('click', async () => {
    go.disabled = true; status.replaceChildren(el('p', { class: 'muted', text: 'Uploading ' + files.length + ' files…' }));
    try {
      const branch = 'submit/' + id, dir = 'games/' + id + '/';
      let current = [];
      try { const head = (await S.gh.get(F() + '/git/ref/heads/' + 'submit/' + encodeURIComponent(id))).object.sha; current = (await S.gh.reader(S.factory, head, dir)).paths(); }
      catch (e) { if (e.status !== 404) throw e; current = onMain ? (await S.gh.reader(S.factory, sha, dir)).paths() : []; }
      const write = await Promise.all(files.map(async f => ({ path: dir + f.rel, bytes: new Uint8Array(await f.file.arrayBuffer()) })));
      const keep = new Set(files.map(f => f.rel));
      const remove = current.filter(p => !keep.has(p) && !SKIP.test(p)).map(p => dir + p);
      const c = await S.gh.commitFiles(S.factory, branch, { base: 'main', message: (mine ? 'Update ' : 'Submit ') + cfg.title + ' (' + id + ')', write, remove });
      let pr = mine;
      if (!pr && declined) {
        try { pr = await S.gh.patch(F() + '/pulls/' + declined.number, { state: 'open' }); await S.gh.post(F() + '/issues/' + declined.number + '/comments', { body: 'Resubmitted from Desk by @' + S.user.login + ' (' + c.sha.slice(0, 7) + ').' }); }
        catch (e) { pr = null; }   // (it cannot be reopened, e.g. its branch was deleted: a new submission is opened instead)
      }
      if (!pr) pr = await S.gh.post(F() + '/pulls', { title: 'Game: ' + cfg.title, head: branch, base: 'main', body: 'Submitted from Desk by @' + S.user.login + '.\n\n' + levels.length + ' levels, ' + files.length + ' files.' });
      status.replaceChildren(note('good', el('div', { class: 'stack' }, el('span', { text: (mine ? 'Updated' : declined && pr.number === declined.number ? 'Resubmitted and reopened' : 'Submitted') + ' (' + c.sha.slice(0, 7) + '). The factory check starts in a moment and takes about 5 minutes.' }), el('a', { href: '#submission/' + pr.number, text: 'Open submission #' + pr.number }))));
    } catch (e) { status.replaceChildren(note('bad', e.message)); go.disabled = false; }
  });
  out.append(el('section', { class: 'card' }, el('div', { class: 'row' }, go, tryIt), status));
}

// ---------- Builds (owner) ----------
async function buildsView() {
  const view = cur;
  if (!S.canBuild) { page(view, 'Builds', ''); view.append(note('warn', 'Builds need the release repository. Only the owner has access to it.')); return; }
  page(view, 'Builds', 'Start a signed Android build and follow it. The links start from defaults.json in the release repository; check them before each build.');
  loading(view);
  try {
    const [list, rel, open, defaults] = await Promise.all([games(), releases(), prs('open'), buildDefaults()]);
    view.lastChild.remove();
    const pre = (() => { try { const v = JSON.parse(sessionStorage.getItem('desk.prefill') || 'null'); sessionStorage.removeItem('desk.prefill'); return v; } catch (e) { return null; } })() || {};
    const ids = [...new Set(list.map(g => g.id).concat(pre.game ? [pre.game] : []))];
    if (pre.game && !list.some(g => g.id === pre.game)) {   // a game that is only in a submission: its title from the branch
      try { const br = open.find(p => p.head.ref === pre.source); if (br) list.push({ id: pre.game, title: JSON.parse(await (await S.gh.reader(S.factory, br.head.sha, 'games/' + pre.game)).text('game.json')).title }); } catch (e) {}
    }
    if (!ids.length) view.append(note('', 'Nothing to build yet: a game can be built once its submission is approved (or, as a sandbox test, from a green submission).'));
    const game = el('select', { id: 'b-game' }, ...ids.map(id => el('option', { value: id, text: (list.find(g => g.id === id) || { title: id }).title + ' (' + id + ')', selected: id === pre.game })));
    const source = el('select', { id: 'b-source' }), pkg = el('input', { id: 'b-pkg', spellcheck: 'false' });
    const email = el('input', { id: 'b-email', type: 'text', placeholder: 'https://…', spellcheck: 'false' }), terms = el('input', { id: 'b-terms', type: 'url', placeholder: 'https://…' }), privacy = el('input', { id: 'b-privacy', type: 'url', placeholder: 'https://…' });
    const envS = el('input', { type: 'radio', name: 'env', id: 'b-sandbox', value: 'sandbox', checked: true }), envP = el('input', { type: 'radio', name: 'env', id: 'b-production', value: 'production' });
    const vc = el('input', { id: 'b-vc', type: 'number', min: '1', placeholder: 'auto' });
    const whats = el('textarea', { id: 'b-whats', rows: 3, placeholder: 'One change per line, for players (e.g. "20 new levels"). Empty for a first release.' });
    // the links start from the defaults (change them here for one build, or in defaults.json for all)
    if (typeof defaults.support === 'string') email.value = defaults.support;
    if (typeof defaults.terms === 'string') terms.value = defaults.terms;
    if (typeof defaults.privacy === 'string') privacy.value = defaults.privacy;
    const sync = () => {
      const id = game.value, branches = open.filter(p => p.head.ref === 'submit/' + id);
      source.replaceChildren(el('option', { value: 'main', text: 'main (approved)' }), ...branches.map(p => el('option', { value: p.head.ref, text: p.head.ref + ' (submission #' + p.number + ', sandbox only)', selected: p.head.ref === pre.source })));
      const last = rel.filter(r => r.game === id && !/factorytest/.test(r.package)).slice(-1)[0];
      pkg.value = last ? last.package : (defaults.packagePrefix || 'com.duste.') + id;
      syncEnv();
    };
    const syncEnv = () => { const branch = source.value !== 'main'; envP.disabled = branch; if (branch) envS.checked = true; };
    game.addEventListener('change', sync); source.addEventListener('change', syncEnv); sync();
    const msg = el('div', { class: 'stack' });
    const start = el('button', { type: 'button', text: 'Review and start' });
    start.addEventListener('click', () => {
      const env = envP.checked ? 'production' : 'sandbox';
      const errs = [];
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg.value.trim())) errs.push('Package name like com.duste.' + game.value);
      if (!/^https:\/\/\S+$/.test(email.value.trim()) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) errs.push('A Support link starting with https:// (or an e-mail address)');
      for (const [n, f] of [['Terms', terms], ['Privacy', privacy]]) if (!/^https:\/\/\S+$/.test(f.value.trim())) errs.push(n + ' URL starting with https://');
      const notes = whats.value.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
      if (notes.length > 500) errs.push("What's new: at most 500 characters (now " + notes.length + ')');
      if (errs.length) { msg.replaceChildren(note('bad', 'Still needed: ' + errs.join('; ') + '.')); return; }
      const inputs = { game: game.value, source: source.value, package: pkg.value.trim(), support_url: email.value.trim(), terms_url: terms.value.trim(), privacy_url: privacy.value.trim(), adjust_environment: env };
      if (vc.value) inputs.version_code = String(parseInt(vc.value, 10));
      if (notes) inputs.whats_new = notes;
      confirmBox(msg, 'Start a ' + env + ' build of ' + inputs.game + ' from ' + inputs.source + ' as ' + inputs.package + '?' + (env === 'production' ? ' (Production: the Adjust events count in the real numbers.)' : ''), 'Start the build', async () => {
        await S.gh.post(R() + '/actions/workflows/release.yml/dispatches', { ref: 'main', inputs });
        msg.replaceChildren(note('good', 'Started. It appears in the list below within a few seconds and takes about 10–15 minutes.'));
        setTimeout(() => refreshRuns(runs), 4000);
      });
    });
    if (ids.length) view.append(el('section', { class: 'card' }, el('h2', { text: 'New build' }),
      el('div', { class: 'form' },
        el('label', { for: 'b-game' }, 'Game', game), el('label', { for: 'b-source' }, 'From', source),
        el('label', { for: 'b-pkg' }, 'Package name (never changes after the first upload)', pkg),
        el('label', { for: 'b-vc' }, 'versionCode (empty: automatic)', vc),
        el('label', { for: 'b-email' }, 'Support link (the Support button in Settings)', email), el('label', { for: 'b-terms' }, 'Terms of use URL', terms), el('label', { for: 'b-privacy' }, 'Privacy policy URL', privacy),
        el('label', { for: 'b-whats', class: 'wide' }, "What's new for players (Google Play's release notes; also goes to the store pipeline)", whats),
        el('div', { class: 'stack wide' }, el('span', { class: 'small muted', text: 'Adjust environment' }),
          el('div', { class: 'row' }, el('label', { class: 'inline', for: 'b-sandbox' }, envS, 'Sandbox (testing)'), el('label', { class: 'inline', for: 'b-production' }, envP, 'Production (store; only from main)')))),
      el('p', { class: 'small muted', text: 'The package name and the three links are filled in for you (package: ' + (defaults.packagePrefix || 'com.duste.') + '<game id>; links: defaults.json in the release repository). Change any of them for this build if needed.' }),
      el('div', { class: 'row' }, start), msg));
    const runs = el('div', { class: 'list' });
    view.append(el('section', { class: 'card' }, el('div', { class: 'row' }, el('h2', { text: 'Recent builds' }), el('span', { class: 'small muted', text: ISTANBUL }), el('button', { type: 'button', class: 'ghost', text: 'Refresh', onclick: () => refreshRuns(runs) })), runs));
    refreshRuns(runs);
    const hist = rel.slice().reverse();
    const bdl = await downloadsReader(S.release).catch(() => null);
    const filesOf = r => { const id = String(r.run || '').split('/').pop(), dir = 'run-' + id + '/'; return bdl && bdl.has(dir + 'info.json') ? dir : null; };
    const buildFiles = (r, dir) => {
      const all = bdl.paths().filter(x => x.startsWith(dir)).map(x => x.slice(dir.length));
      const pick = re => all.find(x => re.test(x));
      const out = el('div', { class: 'row small' });
      if (all.includes('game.html')) out.append(el('button', { type: 'button', text: 'Play', onclick: () => play(r.game + ' · ' + r.versionCode + ' · ' + r.environment, async () => ({ page: await bdl.text(dir + 'game.html'), cfg: { id: r.game, title: r.game + ' ' + r.versionCode } })) }));
      for (const [re, label] of [[/\.apk$/, '.apk'], [/\.aab$/, '.aab'], [/^(play|store)\/[^/]*icon[^/]*\.png$/, 'Store icon'], [/^(play|store)\/[^/]*feature[^/]*\.(jpg|png)$/, 'Feature graphic'], [/-store\.zip$/, 'Store input (zip)'], [/^report\.md$/, 'Report']]) {
        const f = pick(re); if (f) out.append(dlButton(bdl, dir + f, f.split('/').pop(), label + fileSize(bdl, dir + f)));
      }
      return out;
    };
    view.append(el('section', { class: 'card' }, el('h2', { text: 'Release history' }), el('p', { class: 'small muted', text: ISTANBUL }), hist.length ? el('div', { class: 'table' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Date', 'Game', 'Environment', 'versionCode', 'Package', 'From', 'Play and files'].map(t => el('th', { text: t })))),
      el('tbody', {}, ...hist.map(r => el('tr', {}, el('td', { class: 'small', text: full(relDate(r.date)) }), el('td', { text: r.game }), el('td', {}, chip(r.environment === 'production' ? 'good' : '', r.environment)),
        el('td', { class: 'num', text: r.versionCode }), el('td', { class: 'small', text: r.package }), el('td', { class: 'small', text: r.source }),
        el('td', {}, filesOf(r) ? buildFiles(r, filesOf(r)) : el('a', { href: r.run, target: '_blank', rel: 'noopener noreferrer', text: 'On GitHub', title: 'Built before downloads were kept here, or older than the last 12 builds' }))))))) : el('p', { class: 'muted', text: 'No releases yet.' })),
      el('p', { class: 'small muted', text: 'Play runs the exact game page inside that build. The files of the last 12 builds are kept here.' }));
  } catch (e) { fail(view, e); }
}
// what a new build's form starts with: defaults.json in the release repository (editable there)
async function buildDefaults() {
  try { const rd = await S.gh.reader(S.release, await mainSha(S.release), ''); return rd.has('defaults.json') ? JSON.parse(await rd.text('defaults.json')) : {}; }
  catch (e) { return {}; }
}
async function refreshRuns(box) {
  try {
    const r = await S.gh.get(R() + '/actions/workflows/release.yml/runs?per_page=12');
    box.replaceChildren(...(r.workflow_runs || []).map(x => el('a', { class: 'item', href: x.html_url, target: '_blank', rel: 'noopener noreferrer' },
      x.status !== 'completed' ? chip('warn run', x.status === 'queued' ? 'Queued' : 'Building') : x.conclusion === 'success' ? chip('good', 'Done') : chip('bad', x.conclusion === 'cancelled' ? 'Cancelled' : 'Failed'),
      el('span', { class: 'title', text: x.display_title }),
      el('span', { class: 'small muted', text: 'Downloads on GitHub' }),
      el('span', { class: 'meta', text: '#' + x.run_number + ' · started ' + when(x.run_started_at || x.created_at) + (x.status === 'completed' ? ' · ' + Math.round((new Date(x.updated_at) - new Date(x.run_started_at || x.created_at)) / 60000) + ' min' : '') }))));
    if (!box.children.length) box.append(el('p', { class: 'muted', text: 'No builds yet.' }));
    if ((r.workflow_runs || []).some(x => x.status !== 'completed') && box.isConnected) setTimeout(() => box.isConnected && refreshRuns(box), 20000);
  } catch (e) { box.replaceChildren(note('bad', e.message)); }
}

// ---------- Art ----------
let staged = new Map();   // path in kit/art -> { bytes, preview, note, label } ; bytes null = delete
const again = () => { const y = window.scrollY; fresh(); artView().then(() => window.scrollTo(0, y)); };
let artPreview = () => {};   // set by the Art page: the starter game with the art pack (and the staged changes)
async function artView() {
  const view = cur;
  page(view, 'Art', 'The art every game uses. Replace any file with a master of any size: the website makes the game-ready version, and the change is proposed for approval.',
    el('button', { type: 'button', class: 'ghost', text: 'Preview the current art', onclick: () => artPreview(false) }));
  loading(view);
  try {
    const sha = await mainSha(), kit = await S.gh.reader(S.factory, sha, 'kit');
    const M = JSON.parse(await kit.text('art/manifest.json'));
    const current = kit.paths().filter(p => p.startsWith('art/')).map(p => p.slice(4));
    const theme = JSON.parse(await kit.text('art/theme.json'));
    const splashBg = current.includes('splash/splash.json') ? JSON.parse(await kit.text('art/splash/splash.json')).background : '#0a1233';
    view.lastChild.remove();
    const urlOf = async p => { const st = staged.get(p); if (st && st.preview) return st.preview; const b = await kit.bytes('art/' + p); return URL.createObjectURL(new Blob([b], { type: { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[p.split('.').pop()] || '' })); };
    const tray = el('section', { class: 'card tray', hidden: true });
    const renderTray = () => {
      tray.hidden = !staged.size;
      if (!staged.size) return;
      const titleIn = el('input', { id: 'art-title', placeholder: 'What changed (for example: New splash and coin icon)' });
      const status = el('div', { class: 'stack' });
      const propose = el('button', { type: 'button', text: 'Propose for approval' });
      propose.addEventListener('click', async () => {
        propose.disabled = true; status.replaceChildren(el('p', { class: 'muted', text: 'Uploading…' }));
        try {
          const write = [], remove = [];
          for (const [p, s] of staged) (s.bytes ? write.push({ path: 'kit/art/' + p, bytes: s.bytes }) : remove.push('kit/art/' + p));
          const title = titleIn.value.trim() || 'Art: ' + [...staged.values()].filter(s => s.label).map(s => s.label).join(', ');
          const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
          const branch = 'art/' + stamp + '-' + S.user.login.toLowerCase().replace(/[^a-z0-9-]/g, '');
          await S.gh.commitFiles(S.factory, branch, { base: 'main', message: title, write, remove });
          const pr = await S.gh.post(F() + '/pulls', { title: title.startsWith('Art') ? title : 'Art: ' + title, head: branch, base: 'main', body: 'Proposed from Desk by @' + S.user.login + '.\n\n' + [...staged.entries()].map(([p, s]) => '- ' + (s.bytes ? 'kit/art/' + p + (s.note ? ' (' + s.note + ')' : '') : 'remove kit/art/' + p)).join('\n') });
          staged = new Map();
          status.replaceChildren(note('good', el('div', { class: 'stack' }, el('span', { text: 'Proposed. The factory check runs on it; the owner approves it in Submissions.' }), el('a', { href: '#submission/' + pr.number, text: 'Open #' + pr.number }))));
        } catch (e) { status.replaceChildren(note('bad', e.message)); propose.disabled = false; }
      });
      tray.replaceChildren(el('div', { class: 'row' }, el('h2', { text: staged.size + ' change' + (staged.size === 1 ? '' : 's') + ' ready' }), el('button', { type: 'button', class: 'ghost', text: 'Discard all', onclick: () => { staged = new Map(); again(); } })),
        el('div', { class: 'files' }, ...[...staged.entries()].map(([p, s]) => el('div', { text: (s.bytes ? '✎ ' : '✕ ') + p + (s.note ? '  ·  ' + s.note : '') }))),
        el('label', { for: 'art-title' }, 'Title', titleIn),
        el('div', { class: 'row' }, propose, el('button', { type: 'button', class: 'ghost', text: 'Preview on the kit screens', onclick: () => play('Art preview', async () => {
          const starter = await S.gh.reader(S.factory, sha, 'templates/starter');
          return buildGame(overlay(kit), starter, { bots: false });
        }, { screens: true }) })), status);
    };
    // the kit with the staged changes on top (for the preview)
    const overlay = base => ({
      bytes: async p => { const k = p.replace(/^art\//, ''); if (p.startsWith('art/') && staged.has(k) && staged.get(k).bytes) return staged.get(k).bytes; return base.bytes(p); },
      text: async p => { const k = p.replace(/^art\//, ''); if (p.startsWith('art/') && staged.has(k) && staged.get(k).bytes) return new TextDecoder().decode(staged.get(k).bytes); return base.text(p); },
      list: async d => {
        const names = new Set(await base.list(d)), pre = d.replace(/^art\/?/, '').replace(/\/?$/, '/').replace(/^\/$/, '');
        if (d === 'art' || d.startsWith('art/')) for (const [p, s] of staged) if (p.startsWith(pre) && !p.slice(pre.length).includes('/')) { const n = p.slice(pre.length); if (s.bytes) names.add(n); else names.delete(n); }
        return [...names];
      }
    });
    artPreview = () => play(staged.size ? 'Art preview (with your ' + staged.size + ' change' + (staged.size === 1 ? '' : 's') + ')' : 'The current art', async () => {
      const starter = await S.gh.reader(S.factory, sha, 'templates/starter');
      return buildGame(overlay(kit), starter, { bots: false });
    }, { screens: true });
    const stage = (r, label) => { for (const p of r.remove || []) staged.set(p, { bytes: null }); staged.set(r.path, { bytes: r.bytes, preview: r.preview, note: r.note, label }); };
    const picker = (slot, accept, label, after) => {
      const inp = el('input', { type: 'file', accept, hidden: true }), err = el('div', {});
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; if (!f) return; err.replaceChildren(el('span', { class: 'small muted', text: 'Preparing…' }));
        try { const r = await prepare(slot, f, M, current.concat([...staged.keys()])); stage(r, label); if (after) after(r); again(); }
        catch (e) { err.replaceChildren(note('bad', e.message)); }
      });
      return [el('button', { type: 'button', class: 'ghost', text: 'Replace…', onclick: () => inp.click() }), inp, err];
    };

    // splash
    const splashPath = current.find(p => p.startsWith('splash/' + M.splash.file + '.') && !staged.has(p)) || [...staged.keys()].find(p => p.startsWith('splash/' + M.splash.file + '.'));
    const stagedSplash = [...staged.entries()].find(([p, s]) => p.startsWith('splash/' + M.splash.file + '.') && s.bytes);
    const splashUrl = stagedSplash ? stagedSplash[1].preview : splashPath ? await urlOf(splashPath) : '';
    const bgNow = staged.has('splash/splash.json') ? JSON.parse(new TextDecoder().decode(staged.get('splash/splash.json').bytes)).background : splashBg;
    const bgIn = el('input', { type: 'color', id: 'splash-bg', value: bgNow });
    bgIn.addEventListener('change', () => { staged.set('splash/splash.json', { bytes: new TextEncoder().encode(JSON.stringify({ background: bgIn.value, about: "The color around the splash picture and shown while the app starts: use the color of the picture's edges." }, null, 1) + '\n'), note: bgIn.value, label: 'splash color' }); again(); });
    const setBg = r => { if (r.extra && r.extra.background) staged.set('splash/splash.json', { bytes: new TextEncoder().encode(JSON.stringify({ background: r.extra.background, about: "The color around the splash picture and shown while the app starts: use the color of the picture's edges." }, null, 1) + '\n'), note: r.extra.background + ' (from the picture\'s edges)', label: 'splash color' }); };
    view.append(el('section', { class: 'card' + (stagedSplash ? ' staged' : '') }, el('div', { class: 'row' }, el('h2', { text: 'Splash' }), stagedSplash ? chip('warn', 'changed') : null),
      el('p', { class: 'small muted', text: 'Any size and shape; it becomes ' + 1080 + ' x ' + 2340 + '. The dashed box is the safe area on every phone shape: keep the logo inside it.' }),
      el('div', { class: 'shapes' }, ...[['5:8', 8 / 5], ['9:16', 16 / 9], ['1:2', 2], ['9:19.5', 19.5 / 9], ['9:21', 21 / 9]].map(([n, r]) => el('div', { class: 'shape' }, el('div', { style: 'height:' + Math.round(84 * r) + 'px;background-color:' + bgNow + ';background-image:url(' + splashUrl + ')' }), n))),
      el('div', { class: 'row' }, ...picker({ kind: 'splash' }, 'image/*', 'splash', setBg), el('label', { class: 'inline', for: 'splash-bg' }, bgIn, 'Color around it (also while the app starts)'))));

    // icons
    const iconNames = [...new Set(M.icons.required.concat(current.filter(p => p.startsWith('icons/')).map(p => p.slice(6).replace(/\.[^.]+$/, ''))))].sort();
    const icons = await pool(iconNames, 6, async n => {
      const p = [...staged.keys()].find(k => k.startsWith('icons/' + n + '.') && staged.get(k).bytes) || current.find(k => k.startsWith('icons/' + n + '.') && !(staged.has(k) && !staged.get(k).bytes));
      const changed = [...staged.keys()].some(k => k.startsWith('icons/' + n + '.'));
      return el('div', { class: 'art-item' + (changed ? ' staged' : '') },
        el('div', { class: 'swatch', style: 'background:' + theme.bg2 }, p ? el('img', { alt: n, src: await urlOf(p) }) : el('span', { class: 'small muted', text: 'missing' })),
        el('div', { class: 'nm', text: n }), el('div', { class: 'small muted', text: p ? p.split('.').pop().toUpperCase() : '' }),
        ...picker({ kind: 'icon', name: n }, '.svg,image/*', 'icon ' + n));
    });
    view.append(el('section', { class: 'card' }, el('h2', { text: 'Icons' }), el('p', { class: 'small muted', text: 'SVG stays sharp at any size (best). A picture of any size becomes a 256 x 256 transparent picture.' }), el('div', { class: 'art-grid' }, ...icons)));

    // app icon, font, sounds
    const appP = 'app-icon-foreground.png';
    const sounds = await pool(M.sounds.names.concat(['music']), 4, async n => {
      const folder = n === 'music' ? M.music.folder : M.sounds.folder, base = n === 'music' ? M.music.file : n;
      const p = [...staged.keys()].find(k => k.startsWith(folder + '/' + base + '.') && staged.get(k).bytes) || current.find(k => k.startsWith(folder + '/' + base + '.'));
      return el('tr', {}, el('td', { text: n }), el('td', {}, p ? el('audio', { controls: true, preload: 'none', src: await urlOf(p) }) : el('span', { class: 'muted small', text: 'built-in placeholder' })),
        el('td', {}, ...picker({ kind: n === 'music' ? 'music' : 'sound', name: n }, 'audio/mpeg,audio/ogg,.mp3,.ogg', n)));
    });
    view.append(el('div', { class: 'grid' },
      el('section', { class: 'card' + (staged.has(appP) ? ' staged' : '') }, el('h2', { text: 'App icon (for games without one)' }),
        el('div', { class: 'row' }, el('div', { style: 'width:96px;height:96px;border-radius:22px;background:' + theme.bg2 + ' center/150% no-repeat;background-image:url(' + (current.includes(appP) || staged.has(appP) ? await urlOf(appP) : '') + ')' }),
          el('p', { class: 'small muted', text: 'Becomes 1024 x 1024 with a transparent background. Keep the drawing in the middle 61%: phones cut icons into circles and other shapes.' })),
        el('div', { class: 'row' }, ...picker({ kind: 'appicon' }, 'image/*', 'app icon'))),
      el('section', { class: 'card' }, el('h2', { text: 'Font' }), el('p', { class: 'small', text: 'fonts/' + M.fonts.file + '.woff2' }),
        el('p', { class: 'small muted', text: 'woff2, at most ' + Math.round(M.fonts.maxBytes / 1000) + ' KB, with a license that allows use in apps.' }), el('div', { class: 'row' }, ...picker({ kind: 'font' }, '.woff2', 'font')))));
    view.append(el('section', { class: 'card' }, el('h2', { text: 'Sounds and music' }),
      el('p', { class: 'small muted', text: 'MP3 or OGG. Sounds at most ' + Math.round(M.sounds.maxBytes / 1000) + ' KB; music one seamless loop at most ' + (M.music.maxBytes / 1e6) + ' MB, licensed for apps.' }),
      el('div', { class: 'table' }, el('table', {}, el('tbody', {}, ...sounds)))));

    // colors
    const themeNow = staged.has('theme.json') ? JSON.parse(new TextDecoder().decode(staged.get('theme.json').bytes)) : theme;
    const colorInputs = Object.entries(themeNow).filter(([, v]) => /^#[0-9a-fA-F]{6}$/.test(v)).map(([k, v]) => {
      const i = el('input', { type: 'color', id: 'c-' + k, value: v });
      i.addEventListener('change', () => { const t = Object.assign({}, themeNow, { [k]: i.value }); staged.set('theme.json', { bytes: new TextEncoder().encode(JSON.stringify(t, null, 1) + '\n'), note: 'colors', label: 'colors' }); again(); });
      return el('label', { for: 'c-' + k }, i, k);
    });
    view.append(el('section', { class: 'card' + (staged.has('theme.json') ? ' staged' : '') }, el('h2', { text: 'Colors' }), el('p', { class: 'small muted', text: 'The default colors of every game (a game can change its own).' }), el('div', { class: 'colors' }, ...colorInputs)));
    // UI skin: every element the kit draws can take a picture (kit/core/skin.json)
    const SK = JSON.parse(await kit.text('core/skin.json'));
    const previews = await downloadsReader(S.factory).catch(() => null);
    const live = p => staged.has(p) ? !!staged.get(p).bytes : current.includes(p);
    const fileOf = base => [...staged.keys()].find(k => k.startsWith('skin/' + base + '.') && staged.get(k).bytes) || current.find(k => k.startsWith('skin/' + base + '.') && live(k));
    const kindText = sl => sl.kind === 'nine' ? '9-slice, corners ' + sl.slice.join(' / ') + ' px' : sl.kind === 'lottie' ? 'Lottie (.json), at most ' + sl.maxSeconds + ' s' : sl.kind === 'pieces' ? 'up to ' + sl.count + ' pictures' : sl.kind;
    const skinCard = async (sl, base, label) => {
      const f = fileOf(base), changed = [...staged.keys()].some(k => k.startsWith('skin/' + base + '.'));
      let shown;
      if (sl.kind === 'lottie') shown = el('span', { class: 'small muted', text: f ? 'Animation set (' + f.split('/')[1] + ')' : 'Drawn by the kit (confetti only)' });
      else if (f) {
        const box = el('div', { class: 'skin-thumb' }, el('img', { alt: label, src: await urlOf(f) }));
        if (sl.kind === 'nine') { const [t, r, b, l] = sl.slice, [w, h] = sl.size; box.append(el('i', { class: 'g h', style: 'top:' + (t / h * 100) + '%' }), el('i', { class: 'g h', style: 'top:' + (100 - b / h * 100) + '%' }), el('i', { class: 'g v', style: 'left:' + (l / w * 100) + '%' }), el('i', { class: 'g v', style: 'left:' + (100 - r / w * 100) + '%' })); }
        shown = box;
      } else if (sl.kind !== 'pieces' && previews && previews.has('previews/' + base + '.png')) {
        // the kit's current drawing of this element, photographed by the factory check (downloads branch)
        const url = URL.createObjectURL(new Blob([await previews.bytes('previews/' + base + '.png')], { type: 'image/png' }));
        shown = el('div', { class: 'skin-thumb drawn', title: 'The kit\'s current drawing (no picture yet)' }, el('img', { alt: label + ' (drawn by the kit)', src: url }));
      } else shown = el('span', { class: 'small muted', text: 'Drawn by the kit' });
      const reset = f ? el('button', { type: 'button', class: 'link small', text: 'Back to the kit\'s look', onclick: () => { for (const k of current.filter(k => k.startsWith('skin/' + base + '.'))) staged.set(k, { bytes: null, label }); for (const k of [...staged.keys()]) if (k.startsWith('skin/' + base + '.') && staged.get(k).bytes) staged.delete(k); again(); } }) : null;
      return el('div', { class: 'art-item skin' + (changed ? ' staged' : '') }, el('div', { class: 'swatch skin-swatch' }, shown),
        el('div', { class: 'nm', text: label }), el('div', { class: 'small muted', text: sl.size.join(' x ') + ' · ' + kindText(sl) }),
        f ? null : el('div', { class: 'small muted', text: sl.kind === 'lottie' || sl.kind === 'pieces' ? 'No picture: the kit\'s default' : 'No picture yet: the kit\'s drawing (above)' }),
        ...picker({ kind: 'skin', slot: sl, file: base }, sl.kind === 'lottie' ? '.json,application/json' : 'image/*', label), reset);
    };
    const groups = [...new Set(SK.slots.map(sl => sl.group))];
    const skinSec = el('section', { class: 'card' }, el('h2', { text: 'UI skin' }),
      el('p', { class: 'small muted', text: 'Every element the kit draws can take a picture instead. A master of any size works if it has the same proportions as the slot; it is scaled to the exact size. 9-slice: the corners stay as drawn (dashed lines), the edges and the middle stretch. Remove a picture to go back to the kit\'s drawn look.' }));
    for (const g of groups) {
      const items = [];
      for (const sl of SK.slots.filter(x => x.group === g)) {
        if (sl.kind === 'pieces') { for (let i = 1; i <= sl.count; i++) items.push(await skinCard(sl, sl.id + '-' + i, sl.title.replace(/ pieces$/, ' piece') + ' ' + i)); }
        else items.push(await skinCard(sl, sl.id, sl.title));
      }
      skinSec.append(el('h3', { text: g }), el('div', { class: 'art-grid' }, ...items));
    }
    skinSec.append(el('p', { class: 'small muted', text: 'Tip: "Preview on the kit screens" has a Show menu to jump to any screen (settings, a level, popups, the fail steps, the win screen).' }));
    view.append(skinSec);
    view.append(tray); renderTray();
  } catch (e) { fail(view, e); }
}

// ---------- routing ----------
const VIEWS = { dashboard: dashboardView, submissions: submissionsView, submission: submissionView, submit: submitView, builds: buildsView, art: artView };
async function route() {
  if (!S) {
    const v = session.load();
    if (!v) return signInView();
    try { await start(v); } catch (e) { session.clear(); return signInView(e instanceof GitHubError && e.status === 401 ? 'Your token has expired or was revoked. Make a new one and sign in again.' : e.message); }
  }
  $('#nav').hidden = false; $('#who').hidden = false; $('#who-name').textContent = S.user.login + (S.admin ? ' · owner' : '');
  document.querySelectorAll('[data-owner]').forEach(a => { a.hidden = !S.canBuild; });
  const [name, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === name || (name === 'submission' && a.dataset.v === 'submissions')));
  fresh();
  (VIEWS[name] || dashboardView)(arg);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
