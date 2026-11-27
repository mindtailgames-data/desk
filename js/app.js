// Desk: the factory's website. Every view reads live from the private repositories with the signed-in person's own
// token; nothing is stored anywhere but in this browser's memory (and the token in this browser, if asked to).
import { sealForGitHub } from './seal.js';
import { client, session, GitHubError, bytesToB64 } from './gh.js';
import { buildGame, settingsOf, settingsErrors, MILESTONE_LEVELS, filesScript, gameFiles, filesMap } from './builder.js';
import { NETWORKS, SIZES, initialsOf, defaultName, storeUrl, playableHtml, report } from './playable.js';
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
  if (b.startsWith('hand/')) return { kind: 'hand' };
  return { kind: 'other' };
}
async function prs(state) { return S.gh.get(F() + '/pulls?state=' + state + '&sort=updated&direction=desc&per_page=40'); }
// The other open art proposals that change the same art files (paths: kit/art/...). Git cannot combine two versions of
// a picture: once one of them is merged, the other has a conflict and cannot be merged until that is fixed. The
// extension is ignored (home-bg.png and home-bg.webp are the same slot: both would be in the art pack).
async function artOverlaps(paths, except) {
  const keyOf = f => f.replace(/\.[^./]+$/, ''), want = new Set(paths.map(keyOf)), out = [];
  for (const p of (await prs('open')).filter(p => p.head.ref.startsWith('art/') && p.number !== Number(except))) {
    const hit = (await S.gh.get(F() + '/pulls/' + p.number + '/files?per_page=100')).map(f => f.filename).filter(f => f.startsWith('kit/art/') && want.has(keyOf(f)));
    if (hit.length) out.push({ p, hit });
  }
  return out;
}
const overlapList = list => list.map(o => el('span', {}, el('a', { href: '#submission/' + o.p.number, text: '#' + o.p.number }), ' "' + o.p.title + '" by @' + o.p.user.login + ': ' + o.hit.map(f => f.slice(8)).join(', ')));
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
  $('#nav').hidden = true; $('#who').hidden = true; fresh();
  const view = cur;   // (the new page: taken after fresh(), or the form would go into the page just removed)
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
      el('li', {}, 'For the release repository (owner only): Actions: Read and write. Contents: Read-only. Secrets: Read and write (for the Adjust tokens on the Builds page).'),
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
function storageShim(id, level, lang) {
  // the frame has no storage of its own (sealed): give the kit an in-memory one, starting at the chosen level (and language).
  // It is kept in the frame's window.name while this run lasts, so the game's own restart (a new language) keeps it.
  const start = { ['dk.' + id + '.progress']: JSON.stringify({ next: level }) };
  if (lang) start['dk.' + id + '.lang'] = JSON.stringify(lang);
  const run = Math.random().toString(36).slice(2);
  return '<script>(function(){var R=' + JSON.stringify(run) + ',m=null;try{var w=JSON.parse(window.name||"{}");if(w&&w.run===R)m=w.m}catch(e){}if(!m)m=' + JSON.stringify(start) + ';' +
    'var keep=function(){try{window.name=JSON.stringify({run:R,m:m})}catch(e){}};keep();' +
    'var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v);keep()},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};' +
    'try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(e){}})();<\/script>\n';
}
// the frame rate inside the frame, once a second (Desk only, never in a build): frames and the slowest frame. Under 20
// frames a second (a frame over 50 ms), a game that caps its time step plays in slow motion here
const fpsMeter = () => '<script>(function(){var n=0,slow=0,worst=0,last=0,t0=0;function f(t){if(last){var d=t-last;n++;if(d>50)slow++;if(d>worst)worst=d}else t0=t;last=t;' +
  'if(t-t0>=1000){parent.postMessage({desk:"fps",fps:Math.round(n*1000/(t-t0)),slow:slow,worst:Math.round(worst)},"*");n=0;slow=0;worst=0;t0=t}requestAnimationFrame(f)}requestAnimationFrame(f)})();<\/script>\n';
function showFps(d) {
  const c = $('#player-fps'), bad = d.fps < 20 || d.slow > 0;
  c.textContent = d.fps + ' fps' + (d.slow ? ' · ' + d.slow + ' slow frame' + (d.slow > 1 ? 's' : '') + ' (longest ' + d.worst + ' ms)' : '');
  c.className = 'chip ' + (bad ? 'bad' : 'good');
}
// the kit's screens on request (art previews): the factory's own list, kit/preview/screens.js, goes into the page; the
// page sends its list once loaded (the Show menu is made from it) and then answers this page only
const screensOf = async (kit, built) => Object.assign(built, { screens: await kit.text('preview/screens.js').catch(() => null) });
window.addEventListener('message', e => {
  if (!playing || e.source !== $('#player-frame').contentWindow || !e.data) return;
  if (e.data.desk === 'fps' && [e.data.fps, e.data.slow, e.data.worst].every(Number.isFinite)) return showFps(e.data);
  if (e.data.desk !== 'screens' || !Array.isArray(e.data.list)) return;
  const sel = $('#player-screen'), groups = new Map();
  for (const x of e.data.list.slice(0, 80)) { const g = String(x.group || ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  sel.replaceChildren(el('option', { value: '', text: 'Show…' }), ...[...groups].map(([g, xs]) => el('optgroup', { label: g }, ...xs.map(x => el('option', { value: String(x.id), text: String(x.title) })))));
});
function showGame() {
  const lvl = Math.max(1, parseInt($('#player-level').value, 10) || 1);
  const lang = playing.langs.length > 1 ? $('#player-lang').value : null;
  const flow = parseInt($('#player-flow').value, 10);   // (non-stop to try: the kit reads DK_FLOW_TRY before its own settings)
  const flowTry = Number.isInteger(flow) && flow >= 2 && flow <= 15 ? '<script>window.DK_FLOW_TRY=' + flow + ';<\/script>\n' : '';
  let page = playing.page.replace('<head>\n', () => '<head>\n' + storageShim(playing.id, lvl, lang) + flowTry + fpsMeter() + playing.files);
  $('#player-fps').textContent = '… fps'; $('#player-fps').className = 'chip';
  if (playing.screens) page = page.replace(/<\/body>\n<\/html>\n$/, () => '<script>\n' + playing.screens + '\n</script>\n</body>\n</html>\n');
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
    const { page, cfg, screens, files } = await makePage();
    playing = { title, page, files: typeof files === 'string' ? files : '', id: cfg.id, screens: opts && opts.screens && screens && !screens.toLowerCase().includes('</script') ? screens : null, langs: Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages : ['en'] };
    $('#player-screen').hidden = !playing.screens;
    // a game in two languages: play it in either (the game's own Settings can switch too)
    $('#player-lang').replaceChildren(...playing.langs.map(l => el('option', { value: l, text: ({ en: 'English', tr: 'Türkçe' })[l] || l })));
    $('#player-lang').closest('label').hidden = playing.langs.length < 2;
    $('#player-msg').textContent = cfg.title + ' · built in this browser from GitHub · progress is not saved';
    showGame();
  } catch (e) { $('#player-msg').textContent = ''; $('#player-frame').srcdoc = '<p style="font:14px system-ui;color:#f88;padding:16px">' + esc(e.message || e) + '</p>'; }
}
$('#player-restart').addEventListener('click', () => { if (playing) showGame(); });
$('#player-lang').addEventListener('change', () => { if (playing) showGame(); });
$('#player-flow').append(...Array.from({ length: 14 }, (_, k) => el('option', { value: String(k + 2), text: 'to level ' + (k + 2) })));
$('#player-flow').addEventListener('change', () => { if (playing) { $('#player-level').value = '1'; showGame(); } });   // (non-stop starts at level 1: a fresh start)
$('#player-close').addEventListener('click', () => { $('#player').hidden = true; $('#player-frame').srcdoc = ''; playing = null; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#player').hidden) $('#player-close').click(); });
async function gamePage(gameSha, id, kitOverlay, settings) {
  const kitSha = await mainSha();
  let kit = await S.gh.reader(S.factory, kitSha, 'kit');
  if (kitOverlay) kit = kitOverlay(kit);
  const game = id === '@starter' ? await S.gh.reader(S.factory, kitSha, 'templates/starter') : await S.gh.reader(S.factory, gameSha, 'games/' + id);
  return buildGame(kit, game, { bots: false, settings: settings || null });
}

// ---------- downloads: the "downloads" branch of a repository (test apps of submissions; files of release builds) ----------
async function downloadsReader(repo) {
  try { return await S.gh.reader(repo, (await S.gh.get('/repos/' + repo + '/git/ref/heads/downloads')).object.sha, ''); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
const MIME = { mp4: 'video/mp4', apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', html: 'text/html', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', json: 'application/json' };
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
        el('span', { class: 'tag', text: k.kind === 'game' ? 'Game' : k.kind === 'art' ? 'Art' : k.kind === 'hand' ? 'Hand' : 'Factory' }),
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
    if (k.kind === 'other') { const g = files.map(f => /^games\/([^/]+)\//.exec(f.filename)).find(Boolean); if (g) { k.kind = 'game'; k.id = g[1]; } else if (files.every(f => f.filename.startsWith('kit/art/'))) k.kind = 'art'; else if (files.every(f => f.filename.startsWith('marketing/hands/'))) k.kind = 'hand'; }
    const report = comments.filter(c => c.user && c.user.type === 'Bot' && /Factory check|Art pack/.test(c.body)).slice(-1)[0];
    view.replaceChildren();
    const open = p.state === 'open';
    const stateChip = open ? checkChip(check) : chip(p.merged_at ? 'good' : '', p.merged_at ? 'Approved and merged' : 'Declined');
    view.append(el('div', { class: 'head' }, el('div', {}, el('span', { class: 'tag', text: k.kind === 'game' ? 'Game · ' + k.id : k.kind === 'art' ? 'Art' : k.kind === 'hand' ? 'Hand for videos' : 'Factory' }), el('h1', { text: p.title }),
      el('p', { class: 'muted', text: '#' + n + ' by ' + p.user.login + ' · branch ' + p.head.ref + ' · updated ' + ago(p.updated_at) + ' (' + full(p.updated_at) + ', Istanbul)' })),
      el('div', { class: 'row' }, stateChip, el('a', { href: p.html_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on GitHub' }))));

    const act = el('div', { class: 'row' }), msg = el('div', { class: 'stack' });
    if (k.kind === 'game') act.append(el('button', { type: 'button', text: 'Play this version', onclick: () => play(p.title, () => gamePage(p.head.sha, k.id)) }));
    if (k.kind === 'hand') {
      const rd = await S.gh.reader(S.factory, p.head.sha, 'marketing/hands');
      const ids = files.map(f => /^marketing\/hands\/([a-z0-9-]+)\.png$/.exec(f.filename)).filter(Boolean).map(m => m[1]).filter(i => rd.has(i + '.json'));
      for (const i of ids) { try { const c = JSON.parse(await rd.text(i + '.json')), tip = Array.isArray(c.tip) ? c.tip : [0.5, 0.05]; act.append(el('figure', { class: 'hand' }, el('div', { class: 'hand-pic' }, el('img', { src: 'data:image/png;base64,' + bytesToB64(await rd.bytes(i + '.png')), alt: '' }), typeof c.bend === 'number' ? el('span', { class: 'hand-bend', style: 'top:' + c.bend * 100 + '%' }) : null, el('span', { class: 'hand-tip', style: 'left:' + tip[0] * 100 + '%;top:' + tip[1] * 100 + '%' })), el('figcaption', { class: 'small', text: String(c.name || i) + ' (red dot: the fingertip; dashed line: the finger joint)' }))); } catch (e) {} }
    }
    if (k.kind === 'art') act.append(el('button', { type: 'button', text: 'Preview the art on the kit screens', onclick: () => play('Art preview: ' + p.title, async () => {
      const kit = await S.gh.reader(S.factory, p.head.sha, 'kit'), starter = await S.gh.reader(S.factory, p.head.sha, 'templates/starter');
      return screensOf(kit, await buildGame(kit, starter, { bots: false }));
    }, { screens: true }) }));
    // an art proposal: a conflict with main (another proposal changed the same pictures and was approved first), or
    // other open proposals that change the same pictures (approving one gives the other a conflict)
    const conflict = open && p.mergeable === false, clash = open && k.kind === 'art' ? await artOverlaps(files.map(f => f.filename), n).catch(() => []) : [];
    if (open && S.admin) {
      const green = check.state === 'green' && !conflict;
      act.append(el('button', { type: 'button', text: 'Approve and merge', disabled: !green, title: green ? '' : conflict ? 'It has a conflict with main' : 'Only a green submission can be approved', onclick: () => confirmBox(msg, 'Merge "' + p.title + '" into main? It becomes part of the factory.', 'Merge', async () => {
        await S.gh.put(F() + '/pulls/' + n + '/merge', { merge_method: 'squash', sha: p.head.sha });
        try { await S.gh.del(F() + '/git/refs/heads/' + p.head.ref.split('/').map(encodeURIComponent).join('/')); } catch (e) {}
        route();
      }) }));
      act.append(el('button', { type: 'button', class: 'ghost', text: 'Decline', onclick: () => declineBox(msg, n) }));
      if (k.kind === 'game' && green && S.canBuild) act.append(el('a', { href: '#builds', onclick: () => { try { sessionStorage.setItem('desk.prefill', JSON.stringify({ game: k.id, source: p.head.ref })); } catch (e) {} }, text: 'Sandbox build from this branch' }));
    }
    view.append(el('section', { class: 'card' }, act, msg,
      check.state === 'running' ? note('', 'The factory check is running, then the test app is built (about 10 minutes in all). Reload this page to see the result.') : null,
      conflict ? note('bad', 'This ' + (k.kind === 'art' ? 'proposal' : 'submission') + ' has a conflict with main: something approved after it was made changed the same files, so it cannot be merged as it is. ' + (k.kind === 'art' ? 'Decline it and propose its files again in Art (Art always starts from the current main), or have the conflict fixed on its branch.' : 'Submit it again (it updates in place), or have the conflict fixed on its branch.')) : null,
      clash.length ? note('warn', el('div', { class: 'stack' }, el('strong', { text: 'Another open art proposal changes the same pictures' }), ...overlapList(clash),
        el('span', { class: 'small', text: 'Approve only one of them: the other then gets a conflict. Decline that one and propose its pictures again in Art if they are still wanted.' }))) : null,
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
  // the picture files (pictures in subfolders, kit/build/build_game.py): at most 200, 50 MB in all
  const pics = files.filter(f => f.rel.includes('/') && !f.rel.startsWith('tools/') && /\.(png|webp)$/i.test(f.rel)), picBytes = pics.reduce((a, f) => a + f.file.size, 0);
  if (pics.length > 200) problems.push(pics.length + ' picture files in subfolders (at most 200): pack small pictures into sprite sheets');
  if (picBytes > 50 * 1048576) problems.push('picture files ' + (picBytes / 1048576).toFixed(1) + ' MB in all (at most 50 MB)');
  const badPath = pics.filter(f => !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_.-]+\.(png|webp)$/.test(f.rel)).map(f => f.rel);
  if (badPath.length) problems.push('use only letters, digits, - _ . in folder and file names: ' + badPath.slice(0, 5).join(', '));
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
      if (c.unchanged && mine) {   // the same folder again: bring the submission up to date with the factory's main, so its check runs again with today's checker and kit
        let msg;
        try { await S.gh.put(F() + '/pulls/' + mine.number + '/update-branch', { expected_head_sha: c.sha }); msg = 'Nothing changed in the folder: submission #' + mine.number + ' is brought up to date with the factory, and its check runs again in a few minutes.'; }
        catch (e) { if (e.status !== 422) throw e; msg = 'Nothing changed in the folder, and submission #' + mine.number + ' is already up to date with the factory: there is nothing to update.'; }
        status.replaceChildren(note('good', el('span', { text: msg }))); go.disabled = false; return;
      }
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
// ---------- build settings: the non-stop flow and the economy of one game's builds (they win over game.json) ----------
// Remembered for each game: the form starts from the newest of the settings last started from this browser and the
// settings of the game's last build (releases.json, so also on another computer); else from what the game plays with
// today (game.json over the kit's defaults).
const SETTINGS_KEY = id => 'desk.settings.' + id;
function savedSettings(id, rel) {
  let local = null; try { local = JSON.parse(localStorage.getItem(SETTINGS_KEY(id)) || 'null'); } catch (e) {}
  const last = rel.filter(r => r.game === id && r.settings && typeof r.settings === 'object').slice(-1)[0];
  const relAt = last ? Date.parse(String(last.date).replace(' UTC', 'Z').replace(' ', 'T')) || 0 : 0;
  const pick = local && local.settings && (!last || (local.at || 0) >= relAt) ? { settings: local.settings, from: 'the last build started from this browser' }
    : last ? { settings: last.settings, from: 'the last build (' + last.versionCode + ', ' + last.environment + ')' } : null;
  return pick && !settingsErrors(pick.settings).length ? pick : null;
}
function settingsCard(gameSelect, rel, playIt) {
  const box = el('div', { class: 'stack wide', id: 'b-settings' });
  let ask = 0, base = null, fields = null;
  const num = (id, label, help) => { const i = el('input', { id, type: 'number', min: '0', step: '1', inputmode: 'numeric' }); return { i, l: el('label', { for: id }, label, i, ...(help ? [el('span', { class: 'small muted', text: help })] : [])) }; };
  const read = () => {   // the form as settings (NaN where a field is not a whole number: settingsErrors names it)
    const v = f => { const t = f.i.value.trim(); return /^\d+$/.test(t) ? parseInt(t, 10) : NaN; };
    return { flow: fields.flowOn.checked ? parseInt(fields.flowTo.value, 10) : 0, startCoins: v(fields.startCoins), playOnCost: v(fields.playOnCost), refillCost: v(fields.refillCost),
      rewards: { normal: v(fields.normal), hard: v(fields.hard), superhard: v(fields.superhard) }, boosterStart: v(fields.boosterStart), boosterPrice: v(fields.boosterPrice),
      milestones: MILESTONE_LEVELS.map((level, k) => ({ level, coins: v(fields.ms[k][0]), boosters: v(fields.ms[k][1]) })) };
  };
  const fill = st => {
    fields.flowOn.checked = !!st.flow; fields.flowTo.value = String(st.flow || 10); fields.flowTo.disabled = !st.flow;
    for (const k of ['startCoins', 'playOnCost', 'refillCost', 'boosterStart', 'boosterPrice']) fields[k].i.value = st[k];
    for (const k of ['normal', 'hard', 'superhard']) fields[k].i.value = st.rewards[k];
    st.milestones.forEach((m, k) => { fields.ms[k][0].i.value = m.coins; fields.ms[k][1].i.value = m.boosters; });
  };
  const draw = async () => {
    const n = ++ask, id = gameSelect.value;
    box.replaceChildren(el('h3', { text: 'Game settings for this build' }), el('p', { class: 'muted small', text: 'Loading…' }));
    let cfg = {}, bundle = 3, boosters = 0;
    try { const rd = await S.gh.reader(S.factory, await mainSha(), 'games/' + id); cfg = JSON.parse(await rd.text('game.json')); } catch (e) {
      try { const p = (await prs('open')).find(x => x.head.ref === 'submit/' + id); if (p) cfg = JSON.parse(await (await S.gh.reader(S.factory, p.head.sha, 'games/' + id)).text('game.json')); } catch (x) {}
    }
    if (n !== ask) return;
    base = settingsOf(cfg); boosters = (cfg.boosters || []).length; bundle = ((cfg.boosters || [])[0] || {}).bundle || 3;
    const saved = savedSettings(id, rel);
    fields = { flowOn: el('input', { type: 'checkbox', id: 'b-flow' }), flowTo: el('select', { id: 'b-flow-to', style: 'width:auto' }, ...Array.from({ length: 14 }, (_, k) => el('option', { value: String(k + 2), text: 'up to level ' + (k + 2) }))),
      startCoins: num('b-coins', 'Starting coins'), playOnCost: num('b-playon', 'Play On cost', 'coins_below_threshold is sent when the coins drop below this'), refillCost: num('b-refill', 'Refill cost (all lives back)'),
      normal: num('b-r-normal', 'Win reward: normal level'), hard: num('b-r-hard', 'Win reward: hard level'), superhard: num('b-r-superhard', 'Win reward: super hard level'),
      boosterStart: num('b-bstart', 'Starting boosters (of each booster)'), boosterPrice: num('b-bprice', 'Price for ' + bundle + ' boosters'),
      ms: MILESTONE_LEVELS.map(lv => [num('b-ms' + lv + '-c', 'Level ' + lv + ' milestone: coins'), num('b-ms' + lv + '-b', 'Level ' + lv + ' milestone: boosters (of each)')]) };
    fields.flowOn.addEventListener('change', () => { fields.flowTo.disabled = !fields.flowOn.checked; });
    fill(saved ? saved.settings : base);
    const reset = el('button', { type: 'button', class: 'ghost', text: 'Back to the game\'s own values', onclick: () => fill(base) });
    const tryIt = el('button', { type: 'button', class: 'ghost', text: 'Play with these settings', onclick: () => { const st = read(), errs = settingsErrors(st); if (errs.length) { tryMsg.replaceChildren(note('bad', 'Check the settings: ' + errs.join('; ') + '.')); return; } tryMsg.replaceChildren(); playIt(st); } });
    const tryMsg = el('div', { class: 'stack' });
    box.replaceChildren(el('h3', { text: 'Game settings for this build' }),
      el('p', { class: 'small muted', text: (saved ? 'From ' + saved.from + '.' : 'The game\'s own values (game.json, else the kit\'s defaults).') + ' These win over game.json in this build (and in the checklist it runs). Remembered for this game: the next build starts from them.' }),
      el('div', { class: 'stack' }, el('div', { class: 'row' }, el('label', { class: 'inline', for: 'b-flow' }, fields.flowOn, 'Non-stop flow'), fields.flowTo),
        el('p', { class: 'small muted', text: 'First launch: from the splash straight into level 1. Levels before the chosen one: no win screen, the next level slides in (life and coins as always). The chosen level: the win screen, then home. Quit or a closed FAILED: home, and Play goes on in the flow. A later launch opens home.' })),
      el('div', { class: 'form' }, ...['startCoins', 'playOnCost', 'refillCost', 'normal', 'hard', 'superhard'].map(k => fields[k].l)),
      el('div', { class: 'form' }, fields.boosterStart.l, fields.boosterPrice.l, ...(boosters ? [] : [el('p', { class: 'small muted wide', text: 'This game has no boosters: the two booster settings change nothing.' })])),
      el('div', { class: 'form' }, ...fields.ms.flatMap(([c, b]) => [c.l, b.l])),
      el('div', { class: 'row' }, tryIt, reset), tryMsg);
  };
  gameSelect.addEventListener('change', draw); draw();
  return { box, read: () => fields ? read() : null, remember: (id, st) => { try { localStorage.setItem(SETTINGS_KEY(id), JSON.stringify({ at: Date.now(), settings: st })); } catch (e) {} } };
}

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
    // production: warn when the game changed since its last production build but game.json "version" did not
    const verNote = el('div', { class: 'wide', id: 'b-version' }); let verAsk = 0, verMsg = '';
    const checkVersion = async () => {
      const ask = ++verAsk; verNote.replaceChildren(); verMsg = '';
      if (!envP.checked || source.value !== 'main') return;
      const id = game.value, last = rel.filter(r => r.game === id && r.environment === 'production' && r.factory_sha).slice(-1)[0];
      if (!last) return;
      try {
        const files = async sha => { const t = await S.gh.tree(S.factory, sha), dir = 'games/' + id + '/', m = new Map();
          for (const [p, e] of t) if (p.startsWith(dir) && !p.startsWith(dir + 'dist/')) m.set(p.slice(dir.length), e.sha); return m; };
        const now = await mainSha(), [a, b] = await Promise.all([files(last.factory_sha), files(now)]);
        const changed = [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p)).sort();
        if (!changed.length || !b.has('game.json')) return;
        const ver = async sha => { try { return JSON.parse(await (await S.gh.reader(S.factory, sha, 'games/' + id)).text('game.json')).version; } catch (e) { return null; } };
        const [v0, v1] = await Promise.all([ver(last.factory_sha), ver(now)]);
        if (ask !== verAsk || v0 !== v1) return;
        verMsg = 'The game changed since its last production build (' + last.versionCode + ': ' + changed.slice(0, 4).join(', ') + (changed.length > 4 ? ' and ' + (changed.length - 4) + ' more' : '') + ') but its version is still ' + v1 + '.';
        verNote.replaceChildren(note('warn', verMsg + ' If players will notice the change, raise "version" in game.json (e.g. ' + v1 + ' → a higher number) and resubmit before this build. You can still build it as it is.'));
      } catch (e) { /* the reminder is only a help: no warning if it cannot be checked */ }
    };
    const syncEnv = () => { const branch = source.value !== 'main'; envP.disabled = branch; if (branch) envS.checked = true; checkVersion(); };
    game.addEventListener('change', sync); source.addEventListener('change', syncEnv); envS.addEventListener('change', checkVersion); envP.addEventListener('change', checkVersion); sync();
    const setts = settingsCard(game, rel, st => {
      const id = game.value, br = open.find(p => p.head.ref === source.value);
      play(id + ' · with the build settings', async () => gamePage(br ? br.head.sha : await mainSha(), id, null, st));
    });
    const msg = el('div', { class: 'stack' });
    const start = el('button', { type: 'button', text: 'Review and start' });
    start.addEventListener('click', () => {
      const env = envP.checked ? 'production' : 'sandbox';
      const errs = [];
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg.value.trim())) errs.push('Package name like com.duste.' + game.value);
      if (!/^https:\/\/\S+$/.test(email.value.trim()) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) errs.push('A Support link starting with https:// (or an e-mail address)');
      for (const [n, f] of [['Terms', terms], ['Privacy', privacy]]) if (!/^https:\/\/\S+$/.test(f.value.trim())) errs.push(n + ' URL starting with https://');
      const st = setts.read();
      if (!st) errs.push('the game settings (still loading)'); else errs.push(...settingsErrors(st).map(x => 'Game settings: ' + x));
      if (errs.length) { msg.replaceChildren(note('bad', 'Still needed: ' + errs.join('; ') + '.')); return; }
      const inputs = { game: game.value, source: source.value, package: pkg.value.trim(), support_url: email.value.trim(), terms_url: terms.value.trim(), privacy_url: privacy.value.trim(), adjust_environment: env, settings: JSON.stringify(st) };
      if (vc.value) inputs.version_code = String(parseInt(vc.value, 10));
      confirmBox(msg, 'Start a ' + env + ' build of ' + inputs.game + ' from ' + inputs.source + ' as ' + inputs.package + (st.flow ? ', non-stop flow up to level ' + st.flow : ', no non-stop flow') + '?' + (env === 'production' ? ' (Production: the Adjust events count in the real numbers.)' : '') + (env === 'production' && verMsg ? ' Note: ' + verMsg : ''), 'Start the build', async () => {
        await S.gh.post(R() + '/actions/workflows/release.yml/dispatches', { ref: 'main', inputs });
        setts.remember(inputs.game, st);
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
        el('div', { class: 'stack wide' }, el('span', { class: 'small muted', text: 'Adjust environment' }),
          el('div', { class: 'row' }, el('label', { class: 'inline', for: 'b-sandbox' }, envS, 'Sandbox (testing)'), el('label', { class: 'inline', for: 'b-production' }, envP, 'Production (store; only from main)'))), verNote, setts.box),
      el('p', { class: 'small muted', text: 'The package name and the three links are filled in for you (package: ' + (defaults.packagePrefix || 'com.duste.') + '<game id>; links: defaults.json in the release repository). Change any of them for this build if needed.' }),
      el('div', { class: 'row' }, start), msg));
    if (ids.length) view.append(adjustCard(game));
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
      if (all.includes('game.html')) out.append(el('button', { type: 'button', text: 'Play', onclick: () => play(r.game + ' · ' + r.versionCode + ' · ' + r.environment, async () => {
        const pics = all.filter(x => x.startsWith('files/')).map(x => x.slice(6));   // (the build's picture files, if the game has them)
        return { page: await bdl.text(dir + 'game.html'), cfg: { id: r.game, title: r.game + ' ' + r.versionCode }, files: pics.length ? await filesScript({ bytes: p => bdl.bytes(dir + 'files/' + p) }, pics) : '' };
      }) }));
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
// ---------- Adjust tokens: GitHub secrets of the release repository, written from here ----------
// Each value is encrypted in this browser with the repository's public key (js/seal.js) and sent only to GitHub; it is
// never shown, kept or readable again (GitHub keeps secrets write-only). The build reads them by the game's id:
// ADJUST_APP_TOKEN_<ID> and ADJUST_EVENTS_<ID> (one "event_name=token" per line).
const DAY_EVENTS = ['day_1_login', 'day_2_login', 'day_3_login'];
// the kit's own events (kit/modules/analytics.js): the same in every game
const EARLY_LEVELS = [1, 2, 3, 5], KIT_EVENTS = ['played_5_mins', 'played_10_mins', 'coins_below_threshold'];
const TOKEN_RE = /^[A-Za-z0-9]{4,64}$/;
function adjustCard(gameSelect) {
  const box = el('section', { class: 'card', id: 'adjust' });
  let ask = 0;
  const draw = async () => {
    const n = ++ask, id = gameSelect.value, ID = id.toUpperCase();
    box.replaceChildren(el('h2', { text: 'Adjust tokens' }), el('p', { class: 'muted', text: 'Loading…' }));
    let have = null, events = [10, 20, 30, 40, 50];
    try { const r = await S.gh.get(R() + '/actions/secrets?per_page=100'); have = new Map((r.secrets || []).map(x => [x.name, x.updated_at])); } catch (e) { have = e; }
    try {   // as the build does: game.json "analytics", else one event every 10 submitted levels
      const rd = await S.gh.reader(S.factory, await mainSha(), 'games/' + id), c = JSON.parse(await rd.text('game.json'));
      if (c.analytics && Array.isArray(c.analytics.levelAchieved)) events = c.analytics.levelAchieved;
      else { const l = JSON.parse(await rd.text('levels.json')), n = (Array.isArray(l) ? l : l.levels || []).length; events = []; for (let k = 10; k <= n; k += 10) events.push(k); }
    } catch (e) {}
    const lastResult = await lastCheck(id);
    if (n !== ask) return;
    const levels = [...new Set(EARLY_LEVELS.concat(events))].sort((a, b) => a - b);
    const names = ['level_1_started'].concat(levels.map(k => 'level_' + k + '_achieved'), KIT_EVENTS, DAY_EVENTS);
    const appName = 'ADJUST_APP_TOKEN_' + ID, evName = 'ADJUST_EVENTS_' + ID;
    const state = name => have instanceof Map ? (have.has(name) ? chip('good', 'Set ' + when(have.get(name))) : chip('warn', 'Not set')) : chip('', 'Unknown');
    const field = (name, label) => { const i = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-event': name, placeholder: 'token' }); return [i, el('label', {}, label, i)]; };
    const [appIn, appLabel] = field(null, 'App token');
    const evFields = names.map(nm => field(nm, nm));
    const msg = el('div', { class: 'stack' });
    const save = async (secret, value, btn, done) => {
      btn.disabled = true;
      try {
        const key = await S.gh.get(R() + '/actions/secrets/public-key');
        await S.gh.put(R() + '/actions/secrets/' + secret, sealForGitHub(value, key));
        done(); msg.replaceChildren(note('good', secret + ' saved. The next build of ' + id + ' uses it.')); setTimeout(draw, 1500);
      } catch (e) { msg.replaceChildren(note('bad', e.status === 403 || e.status === 404 ? 'GitHub refused (' + e.message + ') Your token needs "Secrets: Read and write" on the release repository.' : e.message)); }
      btn.disabled = false;
    };
    const appBtn = el('button', { type: 'button', text: 'Save the app token' });
    appBtn.addEventListener('click', () => {
      const v = appIn.value.trim();
      if (!TOKEN_RE.test(v)) { msg.replaceChildren(note('bad', 'The app token has only letters and digits (Adjust > the app > App token).')); return; }
      confirmBox(msg, 'Replace ' + appName + ' for ' + id + '?', 'Save', () => save(appName, v, appBtn, () => { appIn.value = ''; }));
    });
    const evBtn = el('button', { type: 'button', text: 'Save the event tokens' });
    evBtn.addEventListener('click', () => {
      const lines = [], empty = [], bad = [];
      for (const [i] of evFields) { const v = i.value.trim(); if (!v) empty.push(i.dataset.event); else if (!TOKEN_RE.test(v)) bad.push(i.dataset.event); else lines.push(i.dataset.event + '=' + v); }
      if (bad.length) { msg.replaceChildren(note('bad', 'Only letters and digits in a token: ' + bad.join(', ') + '.')); return; }
      if (!lines.length) { msg.replaceChildren(note('bad', 'Enter the event tokens first.')); return; }
      confirmBox(msg, 'Replace ' + evName + ' with ' + lines.length + ' event token' + (lines.length > 1 ? 's' : '') + '?' + (empty.length ? ' These stay empty and will not be sent: ' + empty.join(', ') + '.' : ''), 'Save', () => save(evName, lines.join('\n'), evBtn, () => evFields.forEach(([i]) => { i.value = ''; })));
    });
    // which events have a token: the last check, and a button to check again (names only, on GitHub: a minute)
    const checkOut = el('div', {}, checkResult(lastResult)), checkBtn = el('button', { type: 'button', class: 'ghost', text: 'Check the tokens' });
    checkBtn.addEventListener('click', () => checkTokens(id, checkOut, checkBtn));
    if (checking.has(id)) { const w = checking.get(id); w.out = checkOut; w.btn = checkBtn; checkBtn.disabled = true; checkOut.replaceChildren(CHECKING()); }
    box.replaceChildren(el('h2', { text: 'Adjust tokens' }),
      el('p', { class: 'small muted', text: 'For ' + id + ': written as GitHub secrets of the release repository, encrypted in this browser. GitHub never shows them again, so the fields are always empty; saving replaces the old value. Event tokens are saved together: enter all of them each time.' }),
      ...(have instanceof Error ? [note('warn', 'Cannot see which secrets are set (' + have.message + ') Your token needs "Secrets: Read and write" on the release repository.')] : []),
      el('div', { class: 'row' }, el('strong', { text: appName }), state(appName)),
      el('div', { class: 'form' }, appLabel), el('div', { class: 'row' }, appBtn),
      el('div', { class: 'row' }, el('strong', { text: evName }), state(evName)),
      el('div', { class: 'stack' }, checkOut, el('div', { class: 'row' }, checkBtn)),
      el('p', { class: 'small muted', text: 'Make each event in Adjust (the app > Events), then copy its token here. Each one is sent at most once per player (per installation). level_1_started: level 1 starts the first time. level_N_achieved: level N won. played_5_mins / played_10_mins: the game was open and in front that long, all sessions together. coins_below_threshold: the coins drop below the Play On cost the first time. day_N_login: a session N calendar days (Istanbul time) after the first open.' }),
      el('div', { class: 'form' }, ...evFields.map(f => f[1])), el('div', { class: 'row' }, evBtn), msg);
  };
  gameSelect.addEventListener('change', draw); draw();
  return box;
}
// ---------- Check Adjust tokens: which events have a token (names only), without a build ----------
// GitHub never shows a secret again, so a small workflow of the release repository (.github/workflows/adjust-check.yml)
// looks inside it and writes <game>.json (event names, each with or without a token; never a token) to its
// "adjust-checks" branch, which is read here
async function lastCheck(id) {
  try { const f = await S.gh.get(R() + '/contents/' + id + '.json?ref=adjust-checks'); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\s/g, '')), c => c.charCodeAt(0)))); }
  catch (e) { return null; }
}
function checkResult(r) {
  if (!r) return el('p', { class: 'small muted', text: 'Not checked yet.' });
  const n = r.events.length, ok = r.events.filter(e => e.token).length;
  const head = !r.eventsSecret ? chip('bad', 'No event tokens saved') : ok === n ? chip('good', 'All ' + n + ' events have a token') : chip('warn', ok + ' of ' + n + ' events have a token');
  return el('div', { class: 'stack' },
    el('div', { class: 'row' }, head, r.appToken ? chip('good', 'App token set') : chip('bad', 'No app token'),
      el('a', { class: 'small muted', href: r.run, target: '_blank', rel: 'noopener noreferrer', text: 'checked ' + when(r.at) })),
    ...(r.missing.length && r.eventsSecret ? [el('p', { class: 'small', text: 'No token: ' + r.missing.join(', ') + '. Enter all ' + n + ' tokens below and save once (a save replaces the whole list).' })] : []),
    ...(r.extra.length ? [el('p', { class: 'small muted', text: 'Saved but never sent by this game (a typo, or another game\'s list?): ' + r.extra.join(', ') })] : []));
}
// a check under way, per game: the card may be drawn again meanwhile (e.g. after a save), so the result goes to the
// place it shows now (checking.get(id).out), and a card drawn meanwhile shows "Checking…"
const checking = new Map();
const CHECKING = () => note('', 'Checking on GitHub… (usually under a minute)');
function checkTokens(id, out, btn) {
  const req = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), started = Date.now(), w = { out, btn };
  checking.set(id, w); btn.disabled = true; out.replaceChildren(CHECKING());
  const done = node => { if (checking.get(id) === w) checking.delete(id); w.btn.disabled = false; w.out.replaceChildren(node); };
  S.gh.post(R() + '/actions/workflows/adjust-check.yml/dispatches', { ref: 'main', inputs: { game: id, request: req } }).then(() => {
    const poll = async () => {
      if (checking.get(id) !== w) return;   // (a newer check of the same game took over)
      const r = await lastCheck(id); if (r && r.request === req) return done(checkResult(r));
      try {   // a failed run: say so at once (with its link) rather than wait
        const runs = await S.gh.get(R() + '/actions/workflows/adjust-check.yml/runs?per_page=5');
        const bad = (runs.workflow_runs || []).find(x => new Date(x.created_at) >= started - 60000 && x.status === 'completed' && x.conclusion !== 'success');
        if (bad) return done(el('div', {}, note('bad', 'The check failed on GitHub. '), el('a', { href: bad.html_url, target: '_blank', rel: 'noopener noreferrer', text: 'See what went wrong' })));
      } catch (e) {}
      if (Date.now() - started > 5 * 60000) return done(note('bad', 'No result after 5 minutes. Look at Actions > "Check Adjust tokens" on GitHub.'));
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 8000);
  }).catch(e => done(note('bad', e.message)));
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
const loadedFonts = new Set();   // fonts already loaded into this page for the samples (name:version)
const again = () => { const y = window.scrollY; fresh(); artView().then(() => window.scrollTo(0, y)); };
let artPreview = () => {};   // set by the Art page: the starter game with the art pack (and the staged changes)
async function artView() {
  const view = cur;
  page(view, 'Art', 'The art every game uses. Replace any file with a master of any size: the website makes the game-ready version, and the change is proposed for approval. Every version of a UI skin slot and icon is kept: pick the one every game uses.',
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
      const status = el('div', { class: 'stack' }), clash = el('div');
      const propose = el('button', { type: 'button', text: 'Propose for approval' });
      artOverlaps([...staged.keys()].map(k => 'kit/art/' + k)).then(list => {   // (another open proposal changes the same files)
        if (!list.length || !tray.contains(clash)) return;
        clash.replaceChildren(note('warn', el('div', { class: 'stack' }, el('strong', { text: 'Also changed in an open art proposal' }), ...overlapList(list),
          el('span', { class: 'small', text: 'Two proposals cannot both change the same picture: whichever is approved second gets a conflict and cannot be approved. Approve or decline that proposal first and then propose this one, or leave these files out of it.' }))));
        propose.textContent = 'Propose anyway';
      }).catch(() => {});
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
        el('label', { for: 'art-title' }, 'Title', titleIn), clash,
        el('div', { class: 'row' }, propose, el('button', { type: 'button', class: 'ghost', text: 'Preview on the kit screens', onclick: () => play('Art preview', async () => {
          const starter = await S.gh.reader(S.factory, sha, 'templates/starter');
          return screensOf(kit, await buildGame(overlay(kit), starter, { bots: false }));
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
      return screensOf(kit, await buildGame(overlay(kit), starter, { bots: false }));
    }, { screens: true });
    // the library (kit/art/library/<folder>/<name>/<version>.<ext>): every version of a skin slot or icon is kept; the one in
    // use is also kit/art/<folder>/<name>.<ext> (what the build reads) and is named in library/selected.json
    const SELP = 'library/selected.json';
    const selBase = current.includes(SELP) ? JSON.parse(await kit.text('art/' + SELP)) : { selected: {} };
    const selNow = () => staged.has(SELP) ? JSON.parse(new TextDecoder().decode(staged.get(SELP).bytes)) : selBase;
    const setSel = (key, v) => { const o = JSON.parse(JSON.stringify(selNow())); if (v == null) delete o.selected[key]; else o.selected[key] = v;   // (null: no picture, the kit's drawing)
      o.selected = Object.fromEntries(Object.entries(o.selected).sort());
      staged.set(SELP, { bytes: new TextEncoder().encode(JSON.stringify(o, null, 1) + '\n'), note: 'versions in use' }); };
    const versionsOf = key => [...new Set(current.filter(p => p.startsWith('library/' + key + '/')).concat([...staged.keys()].filter(p => p.startsWith('library/' + key + '/') && staged.get(p).bytes)))]
      .map(p => p.slice(('library/' + key + '/').length)).filter(f => !f.includes('/')).sort();
    const stem = f => f.replace(/\.[^.]+$/, '');
    const libBytes = async p => staged.has(p) && staged.get(p).bytes ? staged.get(p).bytes : await kit.bytes('art/' + p);
    const useVersion = async (key, f, label) => {   // every game uses this version: it becomes the file in use
      const [folder, name] = key.split('/'), ext = f.split('.').pop(), active = folder + '/' + name + '.' + ext;
      for (const p of current.concat([...staged.keys()])) if (p.startsWith(folder + '/' + name + '.') && p !== active) staged.set(p, { bytes: null, label });
      const bytes = await libBytes('library/' + key + '/' + f);
      staged.set(active, { bytes, preview: URL.createObjectURL(new Blob([bytes], { type: ext === 'svg' ? 'image/svg+xml' : 'image/' + ext })), note: 'version ' + stem(f), label });
      setSel(key, stem(f)); again();
    };
    // the versions of a slot: a small picture each, the one in use marked; a tap uses another
    const versionStrip = async (key, label) => {
      const vs = versionsOf(key), on = selNow().selected[key];
      if (!vs.length) return null;
      const items = await Promise.all(vs.map(async f => el('button', { type: 'button', class: 'ver' + (stem(f) === on ? ' on' : ''), title: stem(f) === on ? stem(f) + ' (in use)' : 'Use ' + stem(f) + ' in every game',
        onclick: () => { if (stem(f) !== on) useVersion(key, f, label); } }, f.endsWith('.json') ? el('span', { class: 'small', text: 'json' }) : el('img', { alt: stem(f), src: URL.createObjectURL(new Blob([await libBytes('library/' + key + '/' + f)], { type: f.endsWith('.svg') ? 'image/svg+xml' : 'image/' + f.split('.').pop() })) }), el('span', { class: 'small', text: stem(f) }))));
      return el('div', { class: 'versions' }, el('div', { class: 'small muted', text: vs.length + ' version' + (vs.length === 1 ? '' : 's') + ' · tap one to use it' }), el('div', { class: 'ver-row' }, ...items));
    };
    const stage = (r, label) => {
      for (const p of r.remove || []) staged.set(p, { bytes: null });
      staged.set(r.path, { bytes: r.bytes, preview: r.preview, note: r.note, label });
      // a new skin picture or icon is also kept in the library as a new version (the old ones stay there to go back to)
      const m = /^(skin|icons)\/([^/]+)\.(\w+)$/.exec(r.path);
      if (m && r.bytes) {
        const key = m[1] + '/' + m[2], have = versionsOf(key).map(stem), d = new Date();
        let v = 'upload-' + d.toISOString().slice(0, 10).replace(/-/g, ''), k = 1;
        while (have.includes(k === 1 ? v : v + '-' + k)) k++;
        if (k > 1) v += '-' + k;
        staged.set('library/' + key + '/' + v + '.' + m[3], { bytes: r.bytes, note: 'kept as a version' });
        setSel(key, v);
      }
    };
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
    const iconNames = [...new Set(M.icons.required.concat(M.icons.optional || [], current.filter(p => p.startsWith('icons/')).map(p => p.slice(6).replace(/\.[^.]+$/, ''))))].sort();
    const icons = await pool(iconNames, 6, async n => {
      const p = [...staged.keys()].find(k => k.startsWith('icons/' + n + '.') && staged.get(k).bytes) || current.find(k => k.startsWith('icons/' + n + '.') && !(staged.has(k) && !staged.get(k).bytes));
      const changed = [...staged.keys()].some(k => k.startsWith('icons/' + n + '.'));
      return el('div', { class: 'art-item' + (changed ? ' staged' : '') },
        el('div', { class: 'swatch', style: 'background:' + theme.bg2 }, p ? el('img', { alt: n, src: await urlOf(p) }) : el('span', { class: 'small muted', text: 'missing' })),
        el('div', { class: 'nm', text: n }), el('div', { class: 'small muted', text: p ? p.split('.').pop().toUpperCase() : '' }),
        await versionStrip('icons/' + n, 'icon ' + n),
        ...picker({ kind: 'icon', name: n }, '.svg,image/*', 'icon ' + n));
    });
    view.append(el('section', { class: 'card' }, el('h2', { text: 'Icons' }), el('p', { class: 'small muted', text: 'SVG stays sharp at any size (best). A picture of any size becomes a 256 x 256 transparent picture.' }), el('div', { class: 'art-grid' }, ...icons)));

    // app icon, fonts, sounds
    const appP = 'app-icon-foreground.png';
    const fontNames = [...new Set([...current.filter(p => /^fonts\/[^/]+\.woff2$/.test(p) && !(staged.has(p) && !staged.get(p).bytes)), ...[...staged.keys()].filter(k => /^fonts\/[^/]+\.woff2$/.test(k) && staged.get(k).bytes)].map(p => p.slice(6, -6)))].sort((a, b) => (b === M.fonts.file) - (a === M.fonts.file) || a.localeCompare(b));
    await Promise.all(fontNames.map(async n => { try { const key = n + ':' + (staged.has('fonts/' + n + '.woff2') ? 'staged' + staged.get('fonts/' + n + '.woff2').bytes.length : sha); if (loadedFonts.has(key)) return; loadedFonts.add(key);
      const bytes = staged.has('fonts/' + n + '.woff2') ? staged.get('fonts/' + n + '.woff2').bytes : await kit.bytes('art/fonts/' + n + '.woff2');
      const f = new FontFace('DeskF-' + n, bytes, { weight: '100 900' }); await f.load(); document.fonts.add(f); } catch (e) { /* (a broken font shows in the system font) */ } }));
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
      el('section', { class: 'card' + ([...staged.keys()].some(k => k.startsWith('fonts/')) ? ' staged' : '') }, el('h2', { text: 'Fonts' }),
        el('p', { class: 'small muted', text: 'woff2, at most ' + Math.round(M.fonts.maxBytes / 1000) + ' KB each, with a license that allows use in apps (add it too, as a .txt). The kit\'s font is used by every text unless its style (Texts, below) chooses another; only the fonts a style uses go into the games.' }),
        el('div', { class: 'files' }, ...fontNames.map(n => el('div', { class: 'row small' }, el('span', { class: 'font-sample', style: 'font-family:"DeskF-' + n + '"', text: 'Aa 123' }), el('span', { text: n + (n === M.fonts.file ? '  (the kit\'s font)' : '') }), staged.has('fonts/' + n + '.woff2') ? chip('warn', 'new') : null))),
        el('div', { class: 'row' }, ...picker({ kind: 'font' }, '.woff2', 'font').map(x => x.tagName === 'BUTTON' ? Object.assign(x, { textContent: 'Replace the kit\'s font…' }) : x),
          ...picker({ kind: 'fontAdd' }, '.woff2,.txt', 'font').map(x => x.tagName === 'BUTTON' ? Object.assign(x, { textContent: 'Add a font or its license…' }) : x)))));
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
    // text styles: every text the kit writes (kit/core/text.json), as the art team sets them (kit/art/text.json)
    const TS = JSON.parse(await kit.text('core/text.json'));
    const textBase = current.includes('text.json') ? JSON.parse(await kit.text('art/text.json')) : {};
    const textNow = staged.has('text.json') ? JSON.parse(new TextDecoder().decode(staged.get('text.json').bytes)) : textBase;
    const setText = (id, patch) => {
      const t = JSON.parse(JSON.stringify(textNow)), v = Object.assign({}, t[id] || {}, patch);
      for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
      if (Object.keys(v).length) t[id] = v; else delete t[id];
      if (JSON.stringify(t) === JSON.stringify(textBase)) staged.delete('text.json');
      else staged.set('text.json', { bytes: new TextEncoder().encode(JSON.stringify(t, null, 1) + '\n'), note: Object.keys(t).length + ' style(s) set', label: 'texts' });
      setTimeout(again);   // (after the event: a number box sends "change" while it loses focus, and the page is redrawn)
    };
    const kitColor = c => /^theme: /.test(c) ? themeNow[c.slice(7)] || '#ffffff' : c || '#000000';
    const textRow = st => {
      const v = textNow[st.id] || {}, d = st.default, set = Object.keys(v).length > 0;
      const col = v.color || kitColor(d.color), out = (v.outline || kitColor(d.outline) || '#000000'), outRgb = out.slice(0, 7), outA = out.length === 9 ? Math.round(parseInt(out.slice(7), 16) / 2.55) : 100;
      const ow = 'outlineWidth' in v ? v.outlineWidth : d.outlineWidth, size = 'size' in v ? v.size : 100, weight = 'weight' in v ? v.weight : d.weight, font = v.font || '';
      const inp = (attrs, on) => { const i = el('input', attrs); i.addEventListener('change', () => on(i)); return i; };
      const cIn = inp({ type: 'color', value: col, 'aria-label': st.title + ': color', class: 'color' in v ? '' : 'kit' }, i => setText(st.id, { color: i.value }));
      const oIn = inp({ type: 'color', value: outRgb, 'aria-label': st.title + ': outline color', class: 'outline' in v ? '' : 'kit' }, i => setText(st.id, { outline: i.value + (outA < 100 ? Math.round(outA * 2.55).toString(16).padStart(2, '0') : '') }));
      const oA = inp({ type: 'number', min: 0, max: 100, step: 5, value: outA, class: 'num', 'aria-label': st.title + ': outline opacity %', title: 'Outline opacity %' }, i => { const a = Math.max(0, Math.min(100, +i.value || 0)); setText(st.id, { outline: outRgb + (a < 100 ? Math.round(a * 2.55).toString(16).padStart(2, '0') : '') }); });
      const owIn = inp({ type: 'number', min: 0, max: 4, step: 0.1, value: ow, class: 'num', 'aria-label': st.title + ': outline width', title: 'Outline width (0 = none)' }, i => setText(st.id, { outlineWidth: Math.max(0, Math.min(4, Math.round((+i.value || 0) * 10) / 10)) }));
      const fIn = el('select', { 'aria-label': st.title + ': font' }, el('option', { value: '', text: 'The kit\'s font', selected: !font }), ...fontNames.filter(n => n !== M.fonts.file).map(n => el('option', { value: n, text: n, selected: font === n })));
      fIn.addEventListener('change', () => setText(st.id, { font: fIn.value || undefined }));
      const sIn = inp({ type: 'number', min: 50, max: 200, step: 5, value: size, class: 'num', 'aria-label': st.title + ': size %' }, i => setText(st.id, { size: Math.max(50, Math.min(200, Math.round(+i.value || 100))) }));
      const wIn = el('select', { 'aria-label': st.title + ': weight' }, ...[[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semi-bold'], [700, 'Bold'], [800, 'Extra-bold'], [900, 'Black']].map(([w, n]) => el('option', { value: w, text: n, selected: weight === w })));
      wIn.addEventListener('change', () => setText(st.id, { weight: +wIn.value }));
      const light = /panel-ink/.test(d.color), px = Math.min(34, d.size * 3.9 * size / 100), uPx = 3.9;
      const sample = el('span', { class: 'text-sample' + (light ? ' light' : ''), text: st.id.startsWith('map-number') ? '14' : st.id === 'pill' ? '2000' : 'Aa 123',
        style: 'color:' + col + ';font-family:"DeskF-' + (font || M.fonts.file) + '",system-ui;font-weight:' + weight + ';font-size:' + px.toFixed(1) + 'px;-webkit-text-stroke:' + (ow * uPx).toFixed(1) + 'px ' + (ow > 0 ? out : 'transparent') + ';paint-order:stroke fill' });
      const fb = st.fallsBack ? TS.styles.find(x => x.id === st.fallsBack) : null;
      return el('tr', { class: set || (staged.has('text.json') && JSON.stringify(textNow[st.id]) !== JSON.stringify(textBase[st.id])) ? 'set' : '' },
        el('td', {}, el('strong', { text: st.title }), el('div', { class: 'small muted', text: st.note }), fb && !set ? el('div', { class: 'small muted', text: 'Until set: like ' + fb.title }) : null),
        el('td', {}, sample), el('td', {}, cIn), el('td', {}, el('div', { class: 'row tight' }, oIn, oA, el('span', { class: 'small muted', text: '%' })), el('div', { class: 'row tight' }, owIn, el('span', { class: 'small muted', text: 'width' }))),
        el('td', {}, fIn), el('td', {}, el('div', { class: 'row tight' }, sIn, el('span', { class: 'small muted', text: '%' }))), el('td', {}, wIn),
        el('td', {}, set ? el('button', { type: 'button', class: 'link small', text: 'Back to the kit\'s look', onclick: () => { const t = JSON.parse(JSON.stringify(textNow)); delete t[st.id]; if (JSON.stringify(t) === JSON.stringify(textBase)) staged.delete('text.json'); else staged.set('text.json', { bytes: new TextEncoder().encode(JSON.stringify(t, null, 1) + '\n'), note: Object.keys(t).length + ' style(s) set', label: 'texts' }); setTimeout(again); } }) : el('span', { class: 'small muted', text: 'kit\'s look' })));
    };
    const textSec = el('section', { class: 'card' + (staged.has('text.json') ? ' staged' : '') }, el('div', { class: 'row' }, el('h2', { text: 'Texts' }), staged.has('text.json') ? chip('warn', 'changed') : null),
      el('p', { class: 'small muted', text: 'Every text the kit writes, as a style: color, outline (color, opacity, width in kit units; 0 = none), font, size (% of the kit\'s size) and weight. A style you do not set keeps the kit\'s look (shown in grey). The tutorial follows the other popups until you set its styles. "The game\'s own texts" is the style games use for what they draw themselves (Moves 30). See them all in the preview: its Show menu reaches every screen.' }));
    for (const g of [...new Set(TS.styles.map(x => x.group))]) textSec.append(el('h3', { text: g }), el('div', { class: 'table' }, el('table', { class: 'texts' },
      el('thead', {}, el('tr', {}, ...['Style', 'Sample', 'Color', 'Outline', 'Font', 'Size', 'Weight', ''].map(t => el('th', { text: t })))),
      el('tbody', {}, ...TS.styles.filter(x => x.group === g).map(textRow)))));
    view.append(textSec);
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
      } else shown = el('span', { class: 'small muted', text: sl.kind === 'cover' && /dim/.test(sl.selector) ? 'The kit\'s dark layer' : sl.id === 'tutorial-art' ? 'Not shown' : 'Drawn by the kit' });
      const reset = f ? el('button', { type: 'button', class: 'link small', text: 'Back to the kit\'s look', onclick: () => { for (const k of current.filter(k => k.startsWith('skin/' + base + '.'))) staged.set(k, { bytes: null, label }); for (const k of [...staged.keys()]) if (k.startsWith('skin/' + base + '.') && staged.get(k).bytes) staged.delete(k); setSel('skin/' + base, null); again(); } }) : null;
      return el('div', { class: 'art-item skin' + (changed ? ' staged' : '') }, el('div', { class: 'swatch skin-swatch' }, shown),
        el('div', { class: 'nm', text: label }), el('div', { class: 'small muted', text: sl.size.join(' x ') + ' · ' + kindText(sl) }),
        f ? null : el('div', { class: 'small muted', text: sl.id === 'tutorial-art' ? 'No picture: the cards show none' : sl.kind === 'lottie' || sl.kind === 'pieces' ? 'No picture: the kit\'s default' : 'No picture yet: the kit\'s drawing (above)' }),
        await versionStrip('skin/' + base, label),
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
    skinSec.append(el('p', { class: 'small muted', text: 'Tip: the preview\'s Show menu reaches every screen and popup of the kit (the splash, the home screen in all its states, the tutorial cards, levels of every difficulty, every popup and fail step, the win).' }));
    view.append(skinSec);
    view.append(tray); renderTray();
  } catch (e) { fail(view, e); }
}

// ---------- Record: videos of a level for marketing ----------
// You play a level here; the cloud plays it again exactly and films it at the phone's real pixels, 60 frames a second,
// with the game's sound (the release repository's "Record a video" workflow). GameFactory marketing/recorder/runtime.js
// runs in both places (here live, there frame by frame): the same game clock, random numbers and storage, every touch
// written down with its frame, and state checks that make the cloud stop rather than film something else. The videos
// are on the release repository's "videos" branch (the last 20). Hands for the videos: marketing/hands/<id>.png and
// <id>.json in the factory, proposed for approval like art.
const PHONES = [
  { id: '1080x2400', w: 360, h: 800, label: '1080 × 2400 · 20:9 (most Android phones)' },
  { id: '1080x2340', w: 360, h: 780, label: '1080 × 2340 · 19.5:9 (Samsung Galaxy S)' },
  { id: '1080x1920', w: 360, h: 640, label: '1080 × 1920 · 16:9 (older phones; the 9:16 ad size)' }];
const REC_MAX = 60, REC_OPEN_MAX = 10 * 60;   // seconds filmed at most (the runtime stops by itself), and a game open at most before filming ends
let filming = null;   // the game open in the Record tab
const recPrefs = () => { try { return JSON.parse(localStorage.getItem('desk.record') || '{}') || {}; } catch (e) { return {}; } };
const saveRecPrefs = p => { try { localStorage.setItem('desk.record', JSON.stringify(Object.assign(recPrefs(), p))); } catch (e) {} };
const recPending = () => { try { const a = JSON.parse(localStorage.getItem('desk.record.pending') || '[]'); return Array.isArray(a) ? a.filter(x => x && Date.now() - x.at < 3 * 3600000) : []; } catch (e) { return []; } };
const saveRecPending = a => { try { localStorage.setItem('desk.record.pending', JSON.stringify(a)); } catch (e) {} };
async function handsAt(sha) {
  const rd = await S.gh.reader(S.factory, sha, 'marketing/hands');
  const ids = (await rd.list('')).filter(n => /^[a-z0-9][a-z0-9-]*\.json$/.test(n)).map(n => n.slice(0, -5)).filter(i => rd.has(i + '.png')).sort();
  return (await pool(ids, 4, async id => {
    try { const c = JSON.parse(await rd.text(id + '.json')); const tip = Array.isArray(c.tip) ? c.tip : [0.5, 0.05];
      return { id, name: String(c.name || id), tip, bend: typeof c.bend === 'number' ? c.bend : tip[1] + 0.4 * (1 - tip[1]), src: 'data:image/png;base64,' + bytesToB64(await rd.bytes(id + '.png')) }; }
    catch (e) { return null; }
  })).filter(Boolean);
}
async function videosReader() { try { return await S.gh.reader(S.release, (await S.gh.get(R() + '/git/ref/heads/videos')).object.sha, ''); } catch (e) { if (e.status === 404) return null; throw e; } }
async function packRecording(obj) {
  const s = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return bytesToB64(new Uint8Array(await new Response(s).arrayBuffer()));
}
const filmedOf = log => { const at = k => { const e = (log || []).find(x => x[1] === k); return e ? e[0] : -1; }; return { from: at('s'), to: at('e') }; };
window.addEventListener('message', e => {
  const fr = document.getElementById('rec-frame');
  if (!filming || !fr || e.source !== fr.contentWindow || !e.data || typeof e.data.rec !== 'string') return;
  const d = e.data, f = filming;
  if (d.rec === 'frame' && Number.isInteger(d.frame)) f.frame = d.frame;
  else if (d.rec === 'started' && Number.isInteger(d.frame)) { f.from = d.frame; f.state = 'filming'; }
  else if (d.rec === 'log' && Array.isArray(d.log)) { f.log = d.log; f.frame = d.frame; f.state = 'done'; }
  else if (d.rec === 'restart') f.state = 'restarted';
  else return;
  if (f.update) f.update();
});

async function recordView() {
  const view = cur;
  page(view, 'Record', 'Videos of a level for marketing, exactly as a phone shows it. Play the level here; the cloud plays it again the same way and films it at the phone\'s real pixels (1080 across, 60 frames a second), with the game\'s sound.');
  if (!S.canBuild) { view.append(note('warn', 'Recording needs the release repository in your token (Actions: Read and write; Contents: Read-only). Sign out and sign in with such a token.')); return; }
  loading(view);
  try {
    const sha = await mainSha();
    const [list, hands] = await Promise.all([games(sha), handsAt(sha).catch(() => [])]);
    view.lastChild.remove();
    const titles = new Map(list.map(g => [g.id, g.title || g.id]));
    const pref = recPrefs();
    // ----- what to film
    const game = el('select', { id: 'rec-game' }, ...list.filter(g => !g.error).map(g => el('option', { value: g.id, text: (g.title || g.id) + ' (' + g.id + ')' })));
    if (list.some(g => g.id === pref.game)) game.value = pref.game;
    const level = el('input', { id: 'rec-level', type: 'number', min: '1', value: String(Math.max(1, parseInt(pref.level, 10) || 1)) });
    const phone = el('select', { id: 'rec-phone' }, ...PHONES.map(p => el('option', { value: p.id, text: p.label })));
    if (PHONES.some(p => p.id === pref.size)) phone.value = pref.size;
    // ----- the top bar and the boosters on the video (fixed from the game's opening: hidden boosters can't be tapped, so
    // the cloud must hide them from the start too; a change restarts the game)
    const topBar = el('input', { id: 'rec-topbar', type: 'checkbox' }); topBar.checked = pref.topBar !== false;
    const boosters = el('input', { id: 'rec-boosters', type: 'checkbox' }); boosters.checked = pref.boosters !== false;
    const hudCfg = () => ({ topBar: topBar.checked, boosters: boosters.checked });
    for (const x of [topBar, boosters]) x.addEventListener('change', () => { saveRecPrefs(hudCfg()); if (filming && filming.state !== 'filming') load(); });
    // ----- the finger on the video
    const kind = el('select', { id: 'rec-kind' }, el('option', { value: 'none', text: 'Nothing: only the game' }), el('option', { value: 'circle', text: 'A circle' }), el('option', { value: 'hand', text: 'A hand', disabled: !hands.length }));
    kind.value = ['none', 'circle', 'hand'].includes(pref.kind) && (pref.kind !== 'hand' || hands.length) ? pref.kind : 'circle';
    const hand = el('select', { id: 'rec-hand' }, ...hands.map(h => el('option', { value: h.id, text: h.name })));
    if (hands.some(h => h.id === pref.hand)) hand.value = pref.hand;
    const handPic = el('img', { class: 'rec-hand-pic', alt: '' });
    const size = el('input', { id: 'rec-size', type: 'range', min: '30', max: '220', step: '2', value: String(Math.min(220, Math.max(30, parseInt(pref.fsize, 10) || 90))) });
    const sizeOut = el('span', { class: 'small muted' });
    const handRow = el('label', {}, 'Hand', el('div', { class: 'row' }, hand, handPic));
    const fingerCfg = () => {
      const k = kind.value, h = hands.find(x => x.id === hand.value), s = parseInt(size.value, 10);
      return k === 'hand' && h ? { kind: 'hand', hand: h.id, size: s, src: h.src, tip: h.tip, bend: h.bend } : k === 'circle' ? { kind: 'circle', size: s } : { kind: 'none' };
    };
    const fingerChanged = () => {
      const h = hands.find(x => x.id === hand.value);
      handRow.hidden = kind.value !== 'hand'; if (h) handPic.src = h.src;
      sizeOut.textContent = size.value + ' px on the phone screen = ' + size.value * 3 + ' pixels in the video';
      size.closest('label').hidden = kind.value === 'none';
      saveRecPrefs({ kind: kind.value, hand: hand.value, fsize: parseInt(size.value, 10) });
      const fr = document.getElementById('rec-frame');
      if (filming && fr && fr.contentWindow) fr.contentWindow.postMessage({ rec: 'finger', finger: fingerCfg() }, '*');
    };
    for (const x of [kind, hand]) x.addEventListener('change', fingerChanged);
    size.addEventListener('input', fingerChanged);
    const open = el('button', { type: 'button', id: 'rec-open', text: 'Open the game' });
    view.append(el('section', { class: 'card' }, el('h2', { text: 'New video' }),
      el('div', { class: 'form' },
        el('label', {}, 'Game', game), el('label', {}, 'Start at level', level), el('label', {}, 'Phone', phone),
        el('label', {}, 'Touches on the video', kind), handRow,
        el('label', {}, 'Size of the circle or hand', size, sizeOut)),
      el('label', { class: 'check' }, topBar, ' Top bar (the level and the settings button)'),
      el('label', { class: 'check' }, boosters, ' Boosters'),
      el('p', { class: 'small muted', text: 'The touches can be changed any time, also after filming: the cloud draws the ones chosen when you press "Make the video". The top bar and boosters are fixed when the game opens (changing them starts the game again). The game is the latest approved version (main).' }),
      el('div', { class: 'row' }, open)));
    fingerChanged();

    // ----- the game, at the phone's own size
    const frame = el('iframe', { id: 'rec-frame', title: 'Game', sandbox: 'allow-scripts' });
    const box = el('div', { class: 'rec-phone' }, frame);
    const msg = el('div', { class: 'stack' }), ctl = el('div', { class: 'row' }), lang = el('select', { id: 'rec-lang' }), langRow = el('label', { class: 'inline' }, 'Language ', lang);
    const stage = el('section', { class: 'card rec-stage', id: 'rec-stage', hidden: true }, box, el('div', { class: 'stack' }, el('h2', { id: 'rec-title' }), langRow, msg, ctl,
      el('p', { class: 'small muted', text: 'Everything from the moment the game opens is played again in the cloud, but only the part between "Start filming" and "Stop filming" is in the video (' + REC_MAX + ' seconds at most: it stops by itself). Play as on a phone: click to tap, hold the button to drag. Change the language here, not in the game\'s Settings (that restarts the game).' })));
    view.append(stage);
    const fit = () => {
      if (!filming) return;
      const p = PHONES.find(x => x.id === filming.size), k = Math.max(0.45, Math.min(1.15, (window.innerHeight - 110) / p.h, (stage.clientWidth || 800) < 700 ? ((stage.clientWidth || 360) - 40) / p.w : 9));
      frame.style.width = p.w + 'px'; frame.style.height = p.h + 'px'; frame.style.transform = 'scale(' + k + ')';
      box.style.width = Math.round(p.w * k) + 'px'; box.style.height = Math.round(p.h * k) + 'px';
    };
    window.addEventListener('resize', () => { if (frame.isConnected) fit(); });
    const load = () => {
      const f = filming;
      f.seed = (Math.random() * 4294967296) >>> 0; f.base = Math.floor(Date.now() / 1000) * 1000;
      f.lang = f.langs.length > 1 ? lang.value : f.langs[0];
      f.storage = { ['dk.' + f.id + '.progress']: JSON.stringify({ next: f.level }) };
      if (f.langs.length > 1) f.storage['dk.' + f.id + '.lang'] = JSON.stringify(f.lang);
      f.log = null; f.from = -1; f.frame = 0; f.state = 'playing';
      f.hud = hudCfg();
      const cfg = { mode: 'live', seed: f.seed, base: f.base, storage: f.storage, finger: fingerCfg(), hud: f.hud };
      frame.srcdoc = f.built.page.replace('<head>\n', () => '<head>\n<script>window.__REC=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';<\/script>\n<script>' + f.runtime + '<\/script>\n' + f.built.files);
      fit(); f.update();
    };
    const secs = n => (n / 60).toFixed(1) + ' s';
    let shown = '';   // (what is drawn now: the frame reports, twice a second, redraw only when it changes; the filming clock updates in place)
    const update = () => {
      const f = filming; if (!f || !stage.isConnected) return;
      topBar.disabled = boosters.disabled = f.state === 'filming';   // (not while filming: it would start the game again)
      const key = f.state + (f.state === 'playing' ? ':' + (f.frame > REC_OPEN_MAX * 60) + (f.frame >= 1) : '') + ':' + (f.log ? f.log.length : 0) + ':' + f.seed;
      if (key === shown) { if (f.state === 'filming') { const t = document.getElementById('rec-time'); if (t) t.textContent = secs(Math.max(0, f.frame - f.from)) + ' of ' + REC_MAX + ' s'; } return; }
      shown = key;
      const make = el('button', { type: 'button', id: 'rec-make', text: 'Make the video' }), again = el('button', { type: 'button', class: 'ghost', id: 'rec-again', text: 'Start over', onclick: load });
      if (f.state === 'playing') {
        const tooLong = f.frame > REC_OPEN_MAX * 60;
        msg.replaceChildren(tooLong ? note('warn', 'The game has been open for over 10 minutes: start over (the cloud plays everything from the moment it opens).') : el('p', { text: 'Playing; nothing is filmed yet. Get to where the video should begin, then press Start filming.' }));
        ctl.replaceChildren(el('button', { type: 'button', id: 'rec-start', text: 'Start filming', disabled: tooLong || f.frame < 1, onclick: () => frame.contentWindow.postMessage({ rec: 'start' }, '*') }), again);
      } else if (f.state === 'filming') {
        msg.replaceChildren(el('p', {}, el('strong', { class: 'rec-live', text: '● Filming ' }), el('span', { id: 'rec-time', text: secs(Math.max(0, f.frame - f.from)) + ' of ' + REC_MAX + ' s' })));
        ctl.replaceChildren(el('button', { type: 'button', id: 'rec-stop', text: 'Stop filming', onclick: () => frame.contentWindow.postMessage({ rec: 'stop' }, '*') }));
      } else if (f.state === 'done') {
        const r = filmedOf(f.log), out = el('div', { class: 'stack' });
        msg.replaceChildren(el('p', { id: 'rec-filmed', text: 'Filmed ' + secs(r.to - r.from) + '. The video starts where you pressed Start filming.' }), out);
        make.addEventListener('click', () => makeVideo(make, out));
        ctl.replaceChildren(make, again);
      } else {
        msg.replaceChildren(note('bad', 'The game restarted itself (its language was changed in its own Settings), so this recording cannot be played again. Choose the language here and start over.'));
        ctl.replaceChildren(again);
      }
    };
    lang.addEventListener('change', () => { if (filming) load(); });
    const makeVideo = async (btn, out) => {
      const f = filming, fc = fingerCfg(), r = filmedOf(f.log);
      btn.disabled = true; out.replaceChildren(el('p', { class: 'muted', text: 'Sending…' }));
      try {
        const recording = { game: f.id, level: f.level, lang: f.lang, size: f.size, seed: f.seed, base: f.base, storage: f.storage, hud: f.hud, finger: fc.kind === 'hand' ? { kind: 'hand', hand: fc.hand, size: fc.size } : fc.kind === 'circle' ? { kind: 'circle', size: fc.size } : { kind: 'none' }, log: f.log };
        const packed = await packRecording(recording);
        if (packed.length > 60000) throw new Error('This recording is too big to send to GitHub (' + Math.round(packed.length / 1000) + ' KB of 60). Film a shorter part, or press Start filming sooner after opening the game.');
        const req = f.id + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        await S.gh.post(R() + '/actions/workflows/record.yml/dispatches', { ref: 'main', inputs: { game: f.id, sha: f.sha, recording: packed, request: req } });
        saveRecPending(recPending().concat([{ req, game: f.id, level: f.level, size: f.size, seconds: +((r.to - r.from) / 60).toFixed(1), at: Date.now() }]));
        out.replaceChildren(note('good', 'Sent. The cloud is filming it: it appears under Videos below in about ' + Math.max(5, Math.round(4 + (r.to - r.from) / 60 / 5)) + ' minutes (you can leave this page).'));
        refreshVideos();
      } catch (e) { out.replaceChildren(note('bad', e.message)); btn.disabled = false; }
    };
    open.addEventListener('click', async () => {
      saveRecPrefs({ game: game.value, level: Math.max(1, parseInt(level.value, 10) || 1), size: phone.value });
      stage.hidden = false; msg.replaceChildren(el('p', { class: 'muted', text: 'Building the game from GitHub…' })); ctl.replaceChildren(); open.disabled = true;
      try {
        const sha = await mainSha();
        const [kit, g, rt] = await Promise.all([S.gh.reader(S.factory, sha, 'kit'), S.gh.reader(S.factory, sha, 'games/' + game.value), S.gh.reader(S.factory, sha, 'marketing/recorder')]);
        const built = await buildGame(kit, g, { bots: false });
        const runtime = await rt.text('runtime.js');
        if (/<\/script/i.test(runtime)) throw new Error('marketing/recorder/runtime.js must not contain </script');
        const langs = Array.isArray(built.cfg.languages) && built.cfg.languages.length ? built.cfg.languages : ['en'];
        filming = { id: built.cfg.id, title: built.cfg.title, sha, built: { page: built.page, files: typeof built.files === 'string' ? built.files : '' }, runtime, langs, size: phone.value, level: Math.max(1, parseInt(level.value, 10) || 1), update };
        $('#rec-title').textContent = built.cfg.title + ' · level ' + filming.level + ' · ' + PHONES.find(p => p.id === phone.value).label.split(' · ')[0];
        lang.replaceChildren(...langs.map(l => el('option', { value: l, text: ({ en: 'English', tr: 'Türkçe' })[l] || l }))); langRow.hidden = langs.length < 2;
        load(); stage.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (e) { msg.replaceChildren(note('bad', e.message)); }
      open.disabled = false;
    });

    // ----- the videos made
    const vids = el('section', { class: 'card', id: 'rec-videos' }, el('h2', { text: 'Videos' }), el('p', { class: 'small muted', text: 'The last 20 (the release repository\'s "videos" branch). ' + ISTANBUL }));
    const vlist = el('div', { class: 'list' }); vids.append(vlist); view.append(vids);
    let timer = 0;
    const refreshVideos = async () => {
      clearTimeout(timer);
      try {
        const dl = await videosReader();
        const dirs = dl ? [...new Set(dl.paths().filter(p => /^rec-[^/]+\/video\.json$/.test(p)).map(p => p.split('/')[0]))] : [];
        const infos = (await pool(dirs, 4, async d => { try { return Object.assign(JSON.parse(await dl.text(d + '/video.json')), { dir: d }); } catch (e) { return null; } })).filter(Boolean).sort((a, b) => (b.run || 0) - (a.run || 0));
        const done = new Set(infos.map(v => v.request)), waiting = recPending().filter(p => !done.has(p.req));
        saveRecPending(waiting);
        let runs = [];
        if (waiting.length) try { runs = (await S.gh.get(R() + '/actions/workflows/record.yml/runs?per_page=30')).workflow_runs || []; } catch (e) {}
        const rows = waiting.map(p => {
          const run = runs.find(x => (x.display_title || '').endsWith(p.req));
          const failed = run && run.status === 'completed' && run.conclusion !== 'success';
          return el('div', { class: 'item' }, failed ? chip('bad', 'Failed') : chip('warn run', run && run.status === 'in_progress' ? 'Filming' : 'Waiting'),
            el('span', { class: 'title', text: (titles.get(p.game) || p.game) + ' · level ' + p.level }),
            el('span', { class: 'meta', text: p.size.replace('x', ' × ') + ' · ' + p.seconds + ' s · sent ' + when(new Date(p.at).toISOString()) }),
            run ? el('a', { href: run.html_url, target: '_blank', rel: 'noopener noreferrer', class: 'small', text: failed ? 'See why on GitHub' : 'On GitHub' }) : null);
        });
        for (const v of infos) {
          const name = (v.game || 'game') + '-level' + (v.level || '') + '-' + (v.size || '') + '-' + v.request.split('-').slice(-2).join('');
          const watch = el('div', { class: 'rec-video' });
          const acts = v.ok ? el('div', { class: 'row' },
            el('button', { type: 'button', class: 'ghost', text: 'Watch', onclick: async ev => {
              const b = ev.target; if (watch.firstChild) { watch.replaceChildren(); b.textContent = 'Watch'; return; }
              b.disabled = true; b.textContent = 'Loading…';
              try { const url = URL.createObjectURL(new Blob([await dl.bytes(v.dir + '/video.mp4')], { type: 'video/mp4' })); watch.replaceChildren(el('video', { src: url, controls: true, autoplay: true, playsinline: true })); b.textContent = 'Close'; }
              catch (e) { watch.replaceChildren(note('bad', e.message)); b.textContent = 'Watch'; }
              b.disabled = false;
            } }),
            dlButton(dl, v.dir + '/video.mp4', name + '.mp4', 'Download .mp4' + fileSize(dl, v.dir + '/video.mp4'), ''),
            dlButton(dl, v.dir + '/poster.png', name + '.png', 'First frame (.png)')) : null;
          rows.push(el('div', { class: 'stack rec-row' }, el('div', { class: 'item' }, v.ok ? chip('good', 'Ready') : chip('bad', 'No video'),
            el('span', { class: 'title', text: (titles.get(v.game) || v.game) + ' · level ' + v.level }),
            el('span', { class: 'meta', title: v.date, text: [v.size ? v.size.replace('x', ' × ') : '', v.seconds ? v.seconds + ' s' : '', v.ok ? (v.sound ? 'with sound' : 'no sound') : '', v.finger && v.finger !== 'none' ? (v.finger === 'hand' ? 'a hand' : 'a circle') : '', v.by, v.date ? full(relDate(v.date)) : ''].filter(Boolean).join(' · ') })),
            v.ok ? null : note('bad', (v.error || 'The cloud could not make it.') + ' '), acts, watch));
        }
        vlist.replaceChildren(...(rows.length ? rows : [el('p', { class: 'muted', text: 'No videos yet.' })]));
        if (waiting.length && vlist.isConnected) timer = setTimeout(() => vlist.isConnected && refreshVideos(), 20000);
      } catch (e) { vlist.replaceChildren(note('bad', e.message)); }
    };
    refreshVideos();

    // ----- the hands
    view.append(handsCard(hands));
  } catch (e) { fail(view, e); }
}
// the hands for the videos, and a new one proposed for approval (marketing/hands/<id>.png + <id>.json)
function handsCard(hands) {
  const pic = h => el('div', { class: 'hand-pic' }, el('img', { src: h.src, alt: '' }),
    typeof h.bend === 'number' ? el('span', { class: 'hand-bend', style: 'top:' + h.bend * 100 + '%' }) : null,
    el('span', { class: 'hand-tip', style: 'left:' + h.tip[0] * 100 + '%;top:' + h.tip[1] * 100 + '%' }));
  const file = el('input', { type: 'file', id: 'hand-file', accept: 'image/png,image/webp' }), name = el('input', { type: 'text', id: 'hand-name', maxlength: '60', placeholder: 'e.g. Cartoon hand, light skin' });
  const preview = el('div', { class: 'hand-pick', hidden: true }), status = el('div', { class: 'stack' });
  const propose = el('button', { type: 'button', id: 'hand-propose', text: 'Propose for approval', disabled: true });
  let made = null;   // { bytes, src, tip, bend }; the next click sets: 'tip', then 'bend'
  let placing = 'tip';
  const ready = () => { propose.disabled = !(made && typeof made.bend === 'number' && name.value.trim()); };
  file.addEventListener('change', async () => {
    status.replaceChildren(); made = null; preview.hidden = true; ready();
    const f = file.files && file.files[0]; if (!f) return;
    try {
      const bmp = await createImageBitmap(f), k = Math.min(1, 512 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      if (Math.min(w, h) < 64) throw new Error('The picture is too small: at least 64 pixels each way.');
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
      const corner = g.getImageData(0, 0, 1, 1).data[3];
      const bytes = new Uint8Array(await (await new Promise(ok => c.toBlob(ok, 'image/png'))).arrayBuffer());
      made = { bytes, src: c.toDataURL('image/png'), tip: [0.5, 0.05], bend: null }; placing = 'tip';
      const draw = () => preview.replaceChildren(el('p', { class: 'small', id: 'hand-step', text: placing === 'tip'
        ? '1. Click the fingertip: the point that touches the screen on the video.'
        : '2. Click where the finger joins the hand (its knuckle): on a tap, everything above that line bends toward it, as a finger pressing the glass. Click again to change either point (fingertip first).' }), pic(made));
      draw(); preview.hidden = false;
      preview.onclick = ev => {
        const img = preview.querySelector('img'); if (!img || !made) return;
        const r = img.getBoundingClientRect(), fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)), k = v => Math.round(v * 1000) / 1000;
        if (placing === 'tip') { made.tip = [k(fx), k(fy)]; made.bend = null; placing = 'bend'; }
        else if (fy > made.tip[1] + 0.03 && fy < 0.98) { made.bend = k(fy); placing = 'tip'; }
        draw(); ready();
      };
      if (corner > 0) status.replaceChildren(note('warn', 'The picture does not look see-through around the hand (its corner is not transparent). A hand on a background shows that background on the video: a PNG with a transparent background is best.'));
      ready();
    } catch (e) { status.replaceChildren(note('bad', e.message || 'This file cannot be read as a picture.')); }
  });
  name.addEventListener('input', ready);
  propose.addEventListener('click', async () => {
    propose.disabled = true; status.replaceChildren(el('p', { class: 'muted', text: 'Uploading…' }));
    try {
      const title = name.value.trim().slice(0, 60);
      let id = (title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'hand').slice(0, 30);
      const taken = new Set(hands.map(h => h.id)); if (taken.has(id)) { let n = 2; while (taken.has(id + '-' + n)) n++; id += '-' + n; }
      const branch = 'hand/' + id + '-' + Math.random().toString(36).slice(2, 6);
      await S.gh.commitFiles(S.factory, branch, { base: 'main', message: 'Hand for videos: ' + title, write: [
        { path: 'marketing/hands/' + id + '.png', bytes: made.bytes },
        { path: 'marketing/hands/' + id + '.json', bytes: new TextEncoder().encode(JSON.stringify({ name: title, tip: made.tip, bend: made.bend }) + '\n') }] });
      const pr = await S.gh.post(F() + '/pulls', { title: 'Hand: ' + title, head: branch, base: 'main', body: 'Proposed from Desk by @' + S.user.login + ': a hand for marketing videos (Record tab).\n\nmarketing/hands/' + id + '.png, fingertip at ' + made.tip.join(', ') + ' (0-1 across, down), finger joint at ' + made.bend + ' (down).' });
      status.replaceChildren(note('good', el('span', {}, 'Proposed: ', el('a', { href: '#submission/' + pr.number, text: 'submission #' + pr.number }), '. It can be chosen here once the owner approves it.')));
      made = null; file.value = ''; name.value = ''; preview.hidden = true;
    } catch (e) { status.replaceChildren(note('bad', e.message)); propose.disabled = false; }
  });
  return el('section', { class: 'card', id: 'rec-hands' }, el('h2', { text: 'Hands' }),
    el('p', { class: 'small muted', text: 'The hands a video can show. The red dot is the fingertip: the point that touches. The dashed line is the finger joint: on a tap, the part above it bends toward it (the palm stays still). Add one: a PNG with a transparent background (it is made at most 512 pixels on its longer side), its name, a click on its fingertip and one on its finger joint; it is proposed for approval like art.' }),
    hands.length ? el('div', { class: 'hands' }, ...hands.map(h => el('figure', { class: 'hand' }, pic(h), el('figcaption', { class: 'small', text: h.name })))) : el('p', { class: 'muted', text: 'No hands yet.' }),
    el('h3', { text: 'Add a hand' }), el('div', { class: 'form' }, el('label', {}, 'Picture', file), el('label', {}, 'Name', name)), preview, el('div', { class: 'row' }, propose), status);
}

// ---------- Playable: one level of a game as a playable ad (js/playable.js; the kit's playable mode) ----------
// Everything happens in this browser: the game is built from GitHub (main), made a playable with the settings here, shown
// in the preview exactly as the file (only the store is not opened: the preview says so) and saved as the network's file.
// The settings are remembered per game on this computer.
const PL_KEY = id => 'desk.playable.' + id;
const plPrefs = id => { try { return JSON.parse(localStorage.getItem(PL_KEY(id)) || '{}') || {}; } catch (e) { return {}; } };
const savePlPrefs = (id, p) => { try { localStorage.setItem(PL_KEY(id), JSON.stringify(p)); } catch (e) {} };
const PL_TEXTS = { en: { success: 'Success', fail: 'Fail', play: 'Play' }, tr: { success: 'Başarılı', fail: 'Başarısız', play: 'Oyna' } };
const ALL_FILES_MAX = 1.5 * 1048576;   // a game's picture files up to this size all go into the file; above it, only the ones its level uses
let plBuilt = null;   // { key: sha + id, built, game reader, files, icon }
async function playableView() {
  const view = cur;
  page(view, 'Playable', 'One level of a game as a playable ad, in the file the ad network expects. Choose the game and its level, set it up, try it in the preview (it is the file itself), and save the file.');
  loading(view);
  try {
    const sha = await mainSha();
    const [list, rel] = await Promise.all([games(sha), releases()]);
    view.lastChild.remove();
    const last = (() => { try { return localStorage.getItem('desk.playable.game'); } catch (e) { return null; } })();
    const game = el('select', { id: 'pl-game' }, ...list.filter(g => !g.error).map(g => el('option', { value: g.id, text: (g.title || g.id) + ' (' + g.id + ')' })));
    if (list.some(g => g.id === last)) game.value = last;
    const body = el('div', { class: 'pl-wrap' });
    view.append(el('section', { class: 'card' }, el('div', { class: 'form' }, el('label', {}, 'Game', game)), el('p', { class: 'small muted', text: 'The latest approved version (main). Its settings here are remembered on this computer.' })), body);
    let loading_ = 0;   // (only the latest choice draws: a game still building when another is chosen is dropped)
    const load = async () => {
      const mine = ++loading_;
      try { localStorage.setItem('desk.playable.game', game.value); } catch (e) {}
      body.replaceChildren(el('p', { class: 'muted', text: 'Building ' + game.value + ' from GitHub…' }));
      try { await playableEditor(body, game.value, list.find(g => g.id === game.value), sha, rel, () => mine === loading_ && body.isConnected); }
      catch (e) { if (mine === loading_) body.replaceChildren(note('bad', e.message)); }
    };
    game.addEventListener('change', load); load();
  } catch (e) { fail(view, e); }
}
async function playableEditor(body, id, info, sha, rel, current) {
  const key = sha + ':' + id;
  if (!plBuilt || plBuilt.key !== key) {
    const [kit, g, all] = await Promise.all([S.gh.reader(S.factory, sha, 'kit'), S.gh.reader(S.factory, sha, 'games/' + id), S.gh.reader(S.factory, sha, '')]);
    const built = await buildGame(kit, g, { bots: true });
    const module = await kit.text('modules/playable.js');
    const paths = await gameFiles(g);
    let size = 0; for (const p of paths) { const e = g.entry(p); size += e && e.size ? e.size : 0; }
    const uri = async (rd, p) => 'data:' + (p.endsWith('.png') ? 'image/png' : 'image/webp') + ';base64,' + bytesToB64(await rd.bytes(p));
    const ig = await g.list('');
    const icon = ig.includes('icon-foreground.png') ? await uri(g, 'icon-foreground.png') : (all.has('kit/art/app-icon-foreground.png') ? await uri(kit, 'art/app-icon-foreground.png') : null);
    const ibName = ['icon-background.webp', 'icon-background.png'].find(f => ig.includes(f));
    if (!current()) return;   // (another game was chosen meanwhile)
    plBuilt = { key, built, g, module, paths, size, icon, iconBg: ibName ? await uri(g, ibName) : null, iconColor: built.cfg.iconBackground || (built.cfg.theme && built.cfg.theme.bg1) || '#1F62DD', used: new Set(), fileCache: null };
  }
  if (!current()) return;
  const B = plBuilt, cfg = B.built.cfg, langs = Array.isArray(cfg.languages) && cfg.languages.length ? cfg.languages : ['en'];
  const levels = (info && info.levels) || 50, boosters = (cfg.boosters || []).length;   // (the game's own levels, not the repeats after them)
  const r = (rel || []).filter(x => x.game === id && x.package).slice(-1)[0];
  const P = Object.assign({ level: 1, lang: langs[0], size: '9x16', tutorial: true, howto: false, canLose: true, topBar: true, boost: true, boostN: 3, clicksOn: true, clicks: 25, secondsOn: false, seconds: 50,
    pkg: r ? r.package : 'com.duste.' + id, initials: initialsOf(cfg.title), endBg: 'image', endColor: '#1F62DD', endOpacity: 60, outside: '#0E0B26', texts: {}, boxes: [] }, plPrefs(id));
  if (!Array.isArray(P.boxes)) P.boxes = [];
  const txt = () => Object.assign({}, PL_TEXTS[P.lang] || PL_TEXTS.en, P.texts[P.lang] || {});
  const save = () => savePlPrefs(id, P);
  // ----- the controls
  const inp = (k, props) => { const i = el('input', Object.assign({ id: 'pl-' + k }, props)); return i; };
  const level = inp('level', { type: 'number', min: '1', max: String(levels), value: String(Math.min(levels, P.level)) });
  const lang = el('select', { id: 'pl-lang' }, ...langs.map(l => el('option', { value: l, text: ({ en: 'English', tr: 'Türkçe' })[l] || l }))); lang.value = langs.includes(P.lang) ? P.lang : langs[0];
  const size = el('select', { id: 'pl-size' }, ...SIZES.map(s => el('option', { value: s.id, text: s.label }))); size.value = P.size;
  const tutorial = inp('tutorial', { type: 'checkbox' }); tutorial.checked = P.tutorial !== false;
  const howto = inp('howto', { type: 'checkbox' }); howto.checked = !!P.howto;
  const canLose = inp('canlose', { type: 'checkbox' }); canLose.checked = P.canLose !== false;
  const topBar = inp('topbar', { type: 'checkbox' }); topBar.checked = P.topBar;
  const boost = inp('boost', { type: 'checkbox', disabled: !boosters }); boost.checked = P.boost && !!boosters;
  const boostN = inp('boostn', { type: 'number', min: '0', max: '9', value: String(P.boostN) });
  const clicksOn = inp('clickson', { type: 'checkbox' }); clicksOn.checked = P.clicksOn;
  const clicks = inp('clicks', { type: 'number', min: '1', max: '100', value: String(P.clicks) });
  const secondsOn = inp('secondson', { type: 'checkbox' }); secondsOn.checked = P.secondsOn;
  const seconds = inp('seconds', { type: 'number', min: '1', max: '100', value: String(P.seconds) });
  const pkg = inp('pkg', { type: 'text', value: P.pkg, spellcheck: 'false' });
  const success = inp('success', { type: 'text', maxlength: '24' }), failT = inp('fail', { type: 'text', maxlength: '24' }), play = inp('play', { type: 'text', maxlength: '20' });
  const endBg = el('select', { id: 'pl-endbg' }, el('option', { value: 'image', text: 'The game\'s home background' }), el('option', { value: 'color', text: 'A color' })); endBg.value = P.endBg;
  const endColor = inp('endcolor', { type: 'color', value: P.endColor }), endOpacity = inp('endopacity', { type: 'range', min: '0', max: '100', value: String(P.endOpacity) }), opOut = el('span', { class: 'small muted' });
  const outside = inp('outside', { type: 'color', value: P.outside });
  const initials = inp('initials', { type: 'text', maxlength: '6', value: P.initials });
  const name = inp('name', { type: 'text', spellcheck: 'false' });
  const network = el('select', { id: 'pl-network' }, ...Object.entries(NETWORKS).map(([k, n]) => el('option', { value: k, text: n.name })));
  const lvl = () => Math.max(1, Math.min(levels, parseInt(level.value, 10) || 1));
  const fillTexts = () => { const t = txt(); success.value = t.success; failT.value = t.fail; play.value = t.play; };
  fillTexts();
  let nameTouched = !!P.nameFor && P.nameFor === [P.initials, P.size, P.lang].join('|') && !!P.name;
  const defName = () => defaultName(initials.value.trim() || initialsOf(cfg.title), size.value, lang.value);
  name.value = nameTouched ? P.name : defName();
  name.addEventListener('input', () => { nameTouched = name.value.trim() !== '' && name.value !== defName(); });
  // ----- the preview: the file itself (only the store is reported here instead of opened)
  const frame = el('iframe', { id: 'pl-frame', title: 'Playable', sandbox: 'allow-scripts' });
  const box = el('div', { class: 'pl-phone' }, frame), turn = el('button', { type: 'button', class: 'ghost', id: 'pl-turn', text: 'Turn to landscape' });
  const restart = el('button', { type: 'button', class: 'ghost', id: 'pl-restart', text: 'Start again' });
  const events = el('div', { class: 'pl-log small', id: 'pl-log' }), counters = el('div', { class: 'small', id: 'pl-count' });
  let landscape = false, presses = 0, opens = [];
  const PHONE = [360, 760];   // (a phone's screen in the preview: a common 9:19 one)
  const fit = () => { const [w, h] = landscape ? [PHONE[1], PHONE[0]] : PHONE; frame.style.width = w + 'px'; frame.style.height = h + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px'; turn.textContent = landscape ? 'Turn to portrait' : 'Turn to landscape'; };
  const settings = preview => {
    const t = { success: success.value.trim() || txt().success, fail: failT.value.trim() || txt().fail, play: play.value.trim() || txt().play };
    return { aspect: SIZES.find(s => s.id === size.value).aspect, outside: outside.value, tutorial: tutorial.checked, howto: howto.checked, canLose: canLose.checked, topBar: topBar.checked, boosters: { show: boost.checked, count: Math.max(0, Math.min(9, parseInt(boostN.value, 10) || 0)) },
      clicks: clicksOn.checked ? Math.max(1, Math.min(100, parseInt(clicks.value, 10) || 25)) : 0, seconds: secondsOn.checked ? Math.max(1, Math.min(100, parseInt(seconds.value, 10) || 50)) : 0,
      store: storeUrl(pkg.value.trim()), badges: { success: t.success, fail: t.fail }, texts: boxTexts(),
      end: { bg: endBg.value, color: endColor.value, opacity: (parseInt(endOpacity.value, 10) || 0) / 100, play: t.play, icon: B.icon, iconBg: B.iconBg, iconColor: B.iconColor }, preview: !!preview };
  };
  const allFiles = async () => { if (!B.fileCache) B.fileCache = await filesMap(B.g, B.paths); return B.fileCache; };
  // into the file: all the game's picture files when they are small; else only the ones this level asked for in the preview
  const files = async () => B.size <= ALL_FILES_MAX ? allFiles() : Object.fromEntries(Object.entries(await allFiles()).filter(([p]) => B.used.has(lvl() + ':' + p)));
  const make = async preview => playableHtml({ page: B.built.page, files: preview ? await allFiles() : await files(),
    module: B.module, id, level: lvl(), lang: langs.length > 1 ? lang.value : null, settings: settings(preview), network: network.value, title: cfg.title });
  let timer = 0;
  const show = () => { clearTimeout(timer); timer = setTimeout(async () => { presses = 0; opens = []; logUp(); try { frame.srcdoc = await make(true); } catch (e) { events.replaceChildren(note('bad', e.message)); } }, 250); };
  const logUp = () => { counters.textContent = 'Taps: ' + presses + (opens.length ? ' · the store opened ' + opens.length + '×' : ''); };
  window.onmessage = e => {   // (one listener: the tab's own)
    if (e.source !== frame.contentWindow || !e.data || typeof e.data.pk !== 'string') return;
    const d = e.data;
    if (d.pk === 'press') { presses = d.presses; logUp(); }
    else if (d.pk === 'file' && typeof d.path === 'string') B.used.add(lvl() + ':' + d.path);
    else if (d.pk === 'store') { opens.push(d.reason); logUp(); events.prepend(el('div', { text: '→ the store opens (' + ({ clicks: 'after ' + clicks.value + ' taps', time: seconds.value + ' s after the first tap', endcard: 'Play on the end card' }[d.reason] || 'a tap after the store opened once') + ')' })); }
    else if (d.pk === 'ended') events.prepend(el('div', { text: d.kind === 'win' ? 'Level won: Success badge, then the end card' : 'Level failed: Fail badge, then the end card' }));
    else if (d.pk === 'endcard') events.prepend(el('div', { text: 'End card shown' }));
    else if (d.pk === 'lesson') lessonNote(d);
    else if (d.pk === 'textmove' && P.boxes[d.i]) { const b = P.boxes[d.i]; b.x = d.x; b.y = d.y; save(); for (const k of ['x', 'y']) { const c = $('#pl-box' + d.i + '-' + k); if (c) { c.value = String(b[k]); if (c.nextSibling) c.nextSibling.textContent = b[k] + '%'; } } }
    else if (d.pk === 'nofail') { const t = $('#pl-nofail'); if (t) { t.textContent = d.on && !d.supported ? 'This game doesn\'t hide its moves or hearts yet: a lost level goes on with its Play On instead, so the player sees them come back (its chat must update it; the checker\'s F5 says so).' : ''; t.className = d.on && !d.supported ? 'small warn-text' : 'small muted'; } }
    else if (d.pk === 'continued') events.prepend(el('div', { text: 'Level lost: it goes on (the game\'s Play On, free)' + (d.times > 1 ? ' · ' + d.times + '×' : '') }));
  };
  // ----- export
  const out = el('div', { class: 'stack', id: 'pl-out' }), exp = el('button', { type: 'button', id: 'pl-export', text: 'Save the file' });
  exp.addEventListener('click', async () => {
    exp.disabled = true; out.replaceChildren(el('p', { class: 'muted', text: 'Making the file…' }));
    try {
      if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(pkg.value.trim())) throw new Error('The store package is not a package name (e.g. com.duste.' + id + ').');
      if (B.paths.length && B.size > ALL_FILES_MAX && ![...B.used].some(u => u.startsWith(lvl() + ':'))) throw new Error('Let the preview load the level first (its picture files are taken from what the level uses).');
      const html = await make(false), rp = report(html, await files());
      const fname = (name.value.trim() || defName()).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.html?$/i, '') + '.' + NETWORKS[network.value].ext;
      const a = el('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: fname }); document.body.append(a); a.click(); a.remove();
      P.name = name.value; P.nameFor = [initials.value, size.value, lang.value].join('|'); save();
      out.replaceChildren(note(rp.under5 && !rp.outside.length && rp.mraidOpen ? 'good' : 'warn', el('div', { class: 'stack' },
        el('strong', { text: 'Saved ' + fname }),
        el('span', { text: (rp.mb).toFixed(2) + ' MB' + (rp.under5 ? ' (under 5 MB)' : ' (over 5 MB: networks may refuse it)') + '; ' + (rp.files ? rp.files + ' picture file(s) of the game inside' : 'no picture files needed') }),
        el('span', { text: rp.outside.length ? 'It loads from outside: ' + rp.outside.join(', ') : 'Nothing is loaded from outside: everything is inside the file.' }),
        el('span', { text: rp.mraidOpen ? 'The store opens with mraid.open (' + storeUrl(pkg.value.trim()) + ').' : 'The store call (mraid.open) is missing.' }))));
    } catch (e) { out.replaceChildren(note('bad', e.message)); }
    exp.disabled = false;
  });
  // ----- text boxes (up to 3): the layout shared, the words per language; every change shows in the preview at once
  const BOX = { x: 50, y: 15, w: 80, h: 0, size: 22, color: '#ffffff', stroke: '#1a1240', strokeW: 2, bg: '#000000', bgOp: 0, shown: 'fixed', seconds: 3 };
  const boxTexts = () => P.boxes.map(b => ({ text: (b.text && b.text[lang.value]) || '', x: b.x, y: b.y, w: b.w, h: b.h, size: b.size, color: b.color, stroke: b.stroke, strokeW: b.strokeW,
    bg: b.bg, bgOpacity: (+b.bgOp || 0) / 100, shown: b.shown, seconds: b.seconds }));
  const boxLive = () => { save(); try { frame.contentWindow.postMessage({ pkTexts: boxTexts() }, '*'); } catch (e) {} };
  const boxList = el('div', { class: 'stack', id: 'pl-boxes' }), addBox = el('button', { type: 'button', class: 'ghost', id: 'pl-addbox', text: 'Add a text box' });
  const drawBoxes = () => {
    boxList.replaceChildren(...P.boxes.map((b, i) => {
      const f = (k, label, props, conv) => { const c = el('input', Object.assign({ id: 'pl-box' + i + '-' + k, value: String(b[k]) }, props)); const out = props.type === 'range' ? el('span', { class: 'small muted', text: b[k] + (props.unit || '') }) : null;
        c.addEventListener('input', () => { b[k] = conv ? conv(c.value) : c.value; if (out) out.textContent = c.value + (props.unit || ''); boxLive(); }); return el('label', {}, label, c, out); };
      const n = v => parseFloat(v) || 0;
      const text = el('textarea', { id: 'pl-box' + i + '-text', rows: '2', placeholder: 'The words (' + lang.value.toUpperCase() + ')' }); text.value = (b.text && b.text[lang.value]) || '';
      text.addEventListener('input', () => { b.text = Object.assign({}, b.text, { [lang.value]: text.value }); boxLive(); });
      const shown = el('select', { id: 'pl-box' + i + '-shown' }, el('option', { value: 'fixed', text: 'All the time' }), el('option', { value: 'timed', text: 'Until N seconds after the first tap' })); shown.value = b.shown;
      const secs = f('seconds', 'N (seconds)', { type: 'number', min: '1', max: '100' }, v => Math.max(1, Math.min(100, parseInt(v, 10) || 3)));
      const showSecs = () => { secs.hidden = shown.value !== 'timed'; }; showSecs();
      shown.addEventListener('change', () => { b.shown = shown.value; showSecs(); boxLive(); });
      const del = el('button', { type: 'button', class: 'ghost', text: 'Remove' }); del.addEventListener('click', () => { P.boxes.splice(i, 1); drawBoxes(); boxLive(); });
      return el('fieldset', { class: 'pl-box' }, el('legend', { text: 'Text box ' + (i + 1) }), el('label', {}, 'Text', text), el('div', { class: 'form' },
        f('x', 'Across (centre)', { type: 'range', min: '0', max: '100', unit: '%' }, n), f('y', 'Down (centre)', { type: 'range', min: '0', max: '100', unit: '%' }, n),
        f('w', 'Box width', { type: 'range', min: '10', max: '100', unit: '%' }, n), f('h', 'Box height (0: fits the text)', { type: 'range', min: '0', max: '100', unit: '%' }, n),
        f('size', 'Text size (px)', { type: 'number', min: '8', max: '60' }, v => Math.max(8, Math.min(60, n(v) || 22))),
        f('color', 'Text color', { type: 'color' }), f('stroke', 'Stroke color', { type: 'color' }), f('strokeW', 'Stroke thickness (px)', { type: 'number', min: '0', max: '8', step: '0.5' }, v => Math.max(0, Math.min(8, n(v)))),
        f('bg', 'Background color', { type: 'color' }), f('bgOp', 'Background opacity', { type: 'range', min: '0', max: '100', unit: '%' }, n),
        el('label', {}, 'Shown', shown), secs), el('div', { class: 'row' }, del));
    }));
    addBox.disabled = P.boxes.length >= 3;
  };
  addBox.addEventListener('click', () => { if (P.boxes.length >= 3) return; P.boxes.push(Object.assign({ text: {} }, BOX, { y: [15, 30, 85][P.boxes.length] })); drawBoxes(); boxLive(); });
  drawBoxes();
  // ----- layout
  const row = (...k) => el('div', { class: 'row' }, ...k);
  body.replaceChildren(el('div', { class: 'pl-grid' },
    el('div', { class: 'stack' },
      el('section', { class: 'card' }, el('h2', { text: 'Level' }), el('div', { class: 'form' },
        el('label', {}, 'Level (1-' + levels + ')', level), langs.length > 1 ? el('label', {}, 'Language', lang) : null, el('label', {}, 'Size', size),
        el('label', {}, 'Color around the game', outside)),
        el('label', { class: 'check' }, tutorial, ' Tutorial: level 1\'s lesson (its hand steps and texts), on this level'),
        el('label', { class: 'check' }, howto, ' Then level 1\'s How to play card (if it has one)'),
        el('p', { class: 'small muted', id: 'pl-lesson' }),
        el('label', { class: 'check' }, canLose, ' The player can lose (the Fail badge, then the end card). Off: no moves, hearts or timer on screen, and the level can\'t be lost'),
        el('p', { class: 'small muted', id: 'pl-nofail' }),
        el('label', { class: 'check' }, topBar, ' Top bar (the level and the settings button)'),
        boosters ? el('label', { class: 'check' }, boost, ' Boosters, ', boostN, ' of each') : el('p', { class: 'small muted', text: 'This game has no boosters.' })),
      el('section', { class: 'card' }, el('h2', { text: 'Store' }), el('div', { class: 'form' }, el('label', {}, 'Store package', pkg)),
        el('p', { class: 'small muted', id: 'pl-url' }),
        el('label', { class: 'check' }, clicksOn, ' Open the store after ', clicks, ' taps (that tap, and every tap after it)'),
        el('label', { class: 'check' }, secondsOn, ' Open the store ', seconds, ' seconds after the first tap (once; then every tap)'),
        el('p', { class: 'small muted', text: 'The end card comes when the level is won or failed, or once the last chosen trigger has opened the store.' })),
      el('section', { class: 'card' }, el('h2', { text: 'Badges and end card' }), el('div', { class: 'form' },
        el('label', {}, 'Success badge', success), el('label', {}, 'Fail badge', failT), el('label', {}, 'Play button', play),
        el('label', {}, 'End card background', endBg), el('label', {}, 'Its color', endColor), el('label', {}, 'Its opacity', endOpacity, opOut))),
      el('section', { class: 'card' }, el('h2', { text: 'Text boxes' }), el('p', { class: 'small muted', text: 'Up to 3, anywhere on the level, in the game\'s font. Drag a box in the preview to move it; taps go through it to the game. The words are kept per language.' }),
        boxList, row(addBox)),
      el('section', { class: 'card' }, el('h2', { text: 'File' }), el('div', { class: 'form' },
        el('label', {}, 'Game initials', initials), el('label', {}, 'File name', name), el('label', {}, 'Network', network)),
        row(exp), out)),
    el('section', { class: 'card pl-side' }, el('h2', { text: 'Preview' }), el('p', { class: 'small muted', text: 'The file itself, on a phone. Taps, the store and the end card are reported below.' }),
      box, row(turn, restart), counters, events)));
  // what the tutorial did on this level (the kit reports it): level 1's lesson fits, after the game prepared it, or not
  const lessonNote = d => {
    const t = $('#pl-lesson'); if (!t) return;
    if (!tutorial.checked || !d.want) { t.textContent = ''; return; }
    if (d.fit < 0) { t.textContent = 'Level 1\'s lesson can\'t be given on this level (the game finds no way to fit it): choose another level for the tutorial.'; t.className = 'small warn-text'; return; }
    const prep = d.fit > 0 ? ' The game made ' + d.fit + ' correct move(s) first, so the lesson fits.' : '';
    if (!d.done) { t.textContent = 'Level 1\'s lesson: ' + d.want + ' hand step(s).' + prep; t.className = 'small muted'; return; }
    t.textContent = d.shown >= d.want ? 'Level 1\'s lesson: all ' + d.want + ' hand step(s) shown.' + prep : 'Only ' + d.shown + ' of level 1\'s ' + d.want + ' hand steps came: this game doesn\'t give its lesson on other levels yet (its chat must update it; the checker\'s T5 says what is missing).';
    t.className = d.shown >= d.want ? 'small muted' : 'small warn-text';
  };
  const urlNote = () => { $('#pl-url').textContent = storeUrl(pkg.value.trim()); };
  urlNote(); opOut.textContent = endOpacity.value + '%'; fit();
  const changed = () => {
    Object.assign(P, { level: lvl(), lang: lang.value, size: size.value, tutorial: tutorial.checked, howto: howto.checked, canLose: canLose.checked, topBar: topBar.checked, boost: boost.checked, boostN: parseInt(boostN.value, 10) || 0, clicksOn: clicksOn.checked, clicks: parseInt(clicks.value, 10) || 25,
      secondsOn: secondsOn.checked, seconds: parseInt(seconds.value, 10) || 50, pkg: pkg.value.trim(), initials: initials.value.trim(), endBg: endBg.value, endColor: endColor.value, endOpacity: parseInt(endOpacity.value, 10) || 0, outside: outside.value });
    P.texts[P.lang] = { success: success.value, fail: failT.value, play: play.value };
    if (!nameTouched) name.value = defName();
    urlNote(); opOut.textContent = endOpacity.value + '%'; save(); show();
  };
  for (const c of [level, size, tutorial, howto, canLose, topBar, boost, boostN, clicksOn, clicks, secondsOn, seconds, pkg, success, failT, play, endBg, endColor, endOpacity, outside, initials]) c.addEventListener(c.type === 'text' || c.type === 'range' || c.type === 'color' ? 'input' : 'change', changed);
  lang.addEventListener('change', () => { P.lang = lang.value; fillTexts(); drawBoxes(); changed(); });
  turn.addEventListener('click', () => { landscape = !landscape; fit(); });
  restart.addEventListener('click', show);
  show();
}

// ---------- routing ----------
const VIEWS = { dashboard: dashboardView, submissions: submissionsView, submission: submissionView, submit: submitView, builds: buildsView, record: recordView, playable: playableView, art: artView };
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
