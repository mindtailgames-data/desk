// Desk, end to end: a real browser (Playwright's Chromium) runs Desk from this folder, and GitHub's API is answered by
// a stand-in made of local git repositories: copies of the factory and release repositories you point it at. Nothing
// reaches the network or the real repositories, and no real token is used. Every write Desk makes (branches, commits,
// pull requests, comments, secrets, builds) really happens in those copies, so the checks look at the result in git.
//
//   node test/e2e.mjs <factory clone> <release clone> [folder for the screenshots]
//
// Needs git (2.38 or newer: merges use "git merge-tree --write-tree") and Playwright with its Chromium
// (npm i -g playwright). This file holds only code: the games and the art come from the clones when it runs.
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [SRC_FAC, SRC_REL, OUT_ARG] = process.argv.slice(2);
if (!SRC_FAC || !SRC_REL) { console.error('Usage: node test/e2e.mjs <factory clone> <release clone> [screenshots folder]'); process.exit(2); }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-'));
const OUT = path.resolve(OUT_ARG || path.join(WORK, 'shots'));
fs.mkdirSync(OUT, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require('playwright'); } catch (e) { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } })();

// the sealing of GitHub secrets: Desk's own code, and TweetNaCl to open what it sealed
// (without a package.json, Node loads the TweetNaCl file as CommonJS: it exports itself instead of setting self.nacl)
globalThis.self = globalThis;
const { blake2b } = await import(path.join(DESK, 'js', 'seal.js'));
const nacl = globalThis.nacl || require(path.join(DESK, 'js', 'vendor', 'nacl-fast.min.js'));

let fails = 0, passes = 0;
const ok = (name, cond, detail) => { if (cond) passes++; else fails++; console.log((cond ? '✓ ' : '✗ ') + name + (detail != null && detail !== '' ? ': ' + String(detail).replace(/\n/g, ' / ') : '')); };

// ---------- git, the stand-in's storage ----------
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 28, env: ENV, ...opts });
const gitS = (dir, ...a) => git(dir, a).toString().trim();
const refOf = (dir, b) => { try { return gitS(dir, 'rev-parse', '--verify', '-q', 'refs/heads/' + b); } catch (e) { return null; } };
const setRef = (dir, b, sha) => git(dir, ['update-ref', 'refs/heads/' + b, sha]);
const blobOf = (dir, buf) => git(dir, ['hash-object', '-w', '--stdin'], { input: buf }).toString().trim();
function makeTree(dir, base, entries) {   // entries: { path, sha (null: remove), mode }
  const idx = path.join(WORK, 'index-' + Math.random().toString(36).slice(2)), env = { ...ENV, GIT_INDEX_FILE: idx };
  execFileSync('git', ['-C', dir, 'read-tree', ...(base ? [base] : ['--empty'])], { env });
  for (const e of entries) execFileSync('git', ['-C', dir, 'update-index', ...(e.sha ? ['--add', '--cacheinfo', (e.mode || '100644') + ',' + e.sha + ',' + e.path] : ['--force-remove', e.path])], { env });
  const t = execFileSync('git', ['-C', dir, 'write-tree'], { env }).toString().trim();
  fs.rmSync(idx, { force: true });
  return t;
}
const commitTree = (dir, tree, parents, msg) => git(dir, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', msg]).toString().trim();
function commitFiles(dir, branch, base, files, msg) {   // files: { path: Buffer | null }
  const parent = refOf(dir, branch) || refOf(dir, base);
  const tree = makeTree(dir, parent ? parent + '^{tree}' : null, Object.entries(files).map(([p, b]) => ({ path: p, sha: b ? blobOf(dir, b) : null })));
  const c = commitTree(dir, tree, parent ? [parent] : [], msg);
  setRef(dir, branch, c);
  return c;
}
const fileAt = (dir, rev, p) => { try { return git(dir, ['show', rev + ':' + p]); } catch (e) { return null; } };
const filesUnder = (srcDir, pre, skip = /(^|\/)(dist|node_modules)(\/|$)/) => {   // a folder on disk as { pre + relative path: Buffer }
  const out = {};
  (function walk(d, rel) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (skip.test(r)) continue; if (fs.statSync(p).isDirectory()) walk(p, r); else out[pre + r] = fs.readFileSync(p); } })(srcDir, '');
  return out;
};

// ---------- the two repositories (copies), and what is in them before Desk is opened ----------
const FAC = path.join(WORK, 'factory'), REL = path.join(WORK, 'release');
for (const [src, dst] of [[SRC_FAC, FAC], [SRC_REL, REL]]) {
  execFileSync('git', ['clone', '-q', '--no-hardlinks', path.resolve(src), dst]);
  const head = gitS(dst, 'rev-parse', 'HEAD'); setRef(dst, 'main', head);
}
const FAC_NAME = 'example-org/factory', REL_NAME = 'example-org/release', REPO = { [FAC_NAME]: FAC, [REL_NAME]: REL };
const T0 = Date.now(), iso = ms => new Date(T0 - ms).toISOString();

// a game made from the starter (templates/starter), with its own id and title
const starter = path.join(FAC, 'templates', 'starter');
function gameFiles(id, title, pre) {
  const f = filesUnder(starter, pre || '');
  const cfg = JSON.parse(f[(pre || '') + 'game.json']); cfg.id = id; cfg.title = title;
  f[(pre || '') + 'game.json'] = Buffer.from(JSON.stringify(cfg, null, 2) + '\n');
  return f;
}
function gameFolder(id, title, drop) {   // the same, as a folder on disk (what a teammate submits)
  const dir = path.join(WORK, 'submit', id);
  for (const [p, b] of Object.entries(gameFiles(id, title))) { if (drop && drop.includes(p)) continue; fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  return dir;
}
const gamesOnMain = () => gitS(FAC, 'ls-tree', '-r', '--name-only', 'main', 'games').split('\n').filter(p => /^games\/[^/]+\/game\.json$/.test(p)).length;

// pictures for the tests (made in the browser, below)
let PNG = {};

// ---------- the people ----------
const PEOPLE = {
  'tok-owner': { login: 'owner-person', admin: true, release: true },
  'tok-team': { login: 'teammate-b', admin: false, release: false }
};

// ---------- pull requests, comments, checks, builds, secrets (GitHub's side, in memory) ----------
const pulls = [];
let nextPr = 12;
const comments = {};   // number -> [comment]
const checks = {};     // sha -> { status, conclusion }
const runs = [];       // release builds
const secrets = new Map();   // name -> { value (opened), updated_at }
const KEYS = nacl.box.keyPair();
const calls = [];      // every write Desk makes
const outside = [];    // anything Desk tried to reach besides GitHub's API and its own files

function prJson(p) {
  return { number: p.number, title: p.title, state: p.state, merged_at: p.merged_at || null, mergeable: p.mergeable === undefined ? true : p.mergeable,
    user: { login: p.user }, head: { ref: p.ref, sha: refOf(FAC, p.ref) || p.sha || refOf(FAC, 'main') }, base: { ref: 'main' },
    updated_at: p.updated_at, html_url: 'https://github.com/' + FAC_NAME + '/pull/' + p.number };
}
function prFiles(p) {
  const head = refOf(FAC, p.ref); if (!head) return [];
  const base = gitS(FAC, 'merge-base', 'main', head);
  return gitS(FAC, 'diff', '--name-status', base, head).split('\n').filter(Boolean).map(l => { const [s, f] = l.split('\t'); return { filename: f, status: s === 'A' ? 'added' : s === 'D' ? 'removed' : 'modified' }; });
}

// ---------- the stand-in for api.github.com ----------
function api(who, method, url, body) {
  const u = new URL(url), p = decodeURIComponent(u.pathname), q = u.searchParams;
  if (!who) return [401, { message: 'Bad credentials' }];
  if (p === '/user') return [200, { login: who.login }];
  const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p); if (!m) return [404, { message: 'Not Found' }];
  const repo = m[1], rest = m[2] || '', dir = REPO[repo];
  if (!dir || (repo === REL_NAME && !who.release)) return [404, { message: 'Not Found' }];
  if (method !== 'GET') calls.push({ who: who.login, method, repo, path: rest, body });
  if (rest === '') return [200, { full_name: repo, permissions: { admin: who.admin, push: true } }];
  let x;
  // git data
  if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) { const s = refOf(dir, x[1]); return s ? [200, { ref: 'refs/heads/' + x[1], object: { sha: s, type: 'commit' } }] : [404, { message: 'Not Found' }]; }
  if ((x = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
    const tree = gitS(dir, 'ls-tree', '-r', '-l', x[1]).split('\n').filter(Boolean).map(l => { const [meta, fp] = l.split('\t'); const [mode, type, sha, size] = meta.trim().split(/\s+/); return { path: fp, mode, type, sha, size: +size || 0 }; });
    return [200, { sha: x[1], tree, truncated: false }];
  }
  if ((x = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) return [200, { sha: x[1], encoding: 'base64', content: git(dir, ['cat-file', 'blob', x[1]]).toString('base64') }];
  if ((x = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') return [200, { sha: x[1], tree: { sha: gitS(dir, 'rev-parse', x[1] + '^{tree}') } }];
  if (rest === '/git/blobs' && method === 'POST') return [201, { sha: blobOf(dir, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) }];
  if (rest === '/git/trees' && method === 'POST') return [201, { sha: makeTree(dir, body.base_tree, body.tree.map(e => ({ path: e.path, sha: e.sha, mode: e.mode }))) }];
  if (rest === '/git/commits' && method === 'POST') return [201, { sha: commitTree(dir, body.tree, body.parents, body.message) }];
  if (rest === '/git/refs' && method === 'POST') { const b = body.ref.replace(/^refs\/heads\//, ''); if (refOf(dir, b)) return [422, { message: 'Reference already exists' }]; setRef(dir, b, body.sha); return [201, { ref: body.ref, object: { sha: body.sha } }]; }
  if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
    if (method === 'PATCH') { const old = refOf(dir, x[1]); if (!old) return [422, { message: 'Reference does not exist' }]; if (!body.force && gitS(dir, 'merge-base', old, body.sha) !== old) return [422, { message: 'Update is not a fast forward' }]; setRef(dir, x[1], body.sha); return [200, { object: { sha: body.sha } }]; }
    if (method === 'DELETE') { if (!refOf(dir, x[1])) return [422, { message: 'Reference does not exist' }]; git(dir, ['update-ref', '-d', 'refs/heads/' + x[1]]); return [204, null]; }
  }
  // the factory: pull requests and comments
  if (rest === '/pulls' && method === 'GET') {
    let list = pulls.filter(pr => pr.state === (q.get('state') || 'open'));
    if (q.get('head')) list = list.filter(pr => q.get('head') === repo.split('/')[0] + ':' + pr.ref);
    return [200, list.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(prJson)];
  }
  if (rest === '/pulls' && method === 'POST') {
    if (pulls.some(pr => pr.state === 'open' && pr.ref === body.head)) return [422, { message: 'A pull request already exists for ' + body.head }];
    if (!refOf(dir, body.head)) return [422, { message: 'head does not exist' }];
    const pr = { number: nextPr++, title: body.title, state: 'open', ref: body.head, user: who.login, updated_at: new Date().toISOString(), body: body.body };
    pulls.push(pr); return [201, prJson(pr)];
  }
  if ((x = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest))) {
    const pr = pulls.find(y => y.number === +x[1]); if (!pr) return [404, { message: 'Not Found' }];
    const sub = x[2] || '';
    if (sub === '' && method === 'GET') return [200, prJson(pr)];
    if (sub === '' && method === 'PATCH') {
      if (body.state === 'open' && !refOf(dir, pr.ref)) return [422, { message: 'the branch was deleted' }];
      if (body.state) { pr.state = body.state; pr.updated_at = new Date().toISOString(); }
      return [200, prJson(pr)];
    }
    if (sub.startsWith('/files')) return [200, prFiles(pr)];
    if (sub === '/merge' && method === 'PUT') {
      const head = refOf(dir, pr.ref);
      if (pr.state !== 'open') return [405, { message: 'Pull Request is not mergeable' }];
      if (body.sha !== head) return [409, { message: 'Head branch was modified' }];
      let tree; try { tree = gitS(dir, 'merge-tree', '--write-tree', 'main', head).split('\n')[0]; } catch (e) { return [405, { message: 'Merge conflict' }]; }
      setRef(dir, 'main', commitTree(dir, tree, [refOf(dir, 'main')], pr.title + ' (#' + pr.number + ')'));
      Object.assign(pr, { state: 'closed', merged_at: new Date().toISOString(), sha: head });
      return [200, { merged: true }];
    }
  }
  if ((x = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
    const list = comments[x[1]] = comments[x[1]] || [];
    if (method === 'POST') { const c = { user: { login: who.login, type: 'User' }, body: body.body, created_at: new Date().toISOString() }; list.push(c); return [201, c]; }
    return [200, list];
  }
  if (rest === '/actions/runs') {
    const c = checks[q.get('head_sha')];
    return [200, { workflow_runs: c ? [{ name: 'Factory check', event: 'pull_request', status: c.status, conclusion: c.conclusion || null, created_at: iso(600e3), html_url: 'https://github.com/' + FAC_NAME + '/actions/runs/1' }] : [] }];
  }
  // the release repository: builds and secrets
  if (rest.startsWith('/actions/workflows/release.yml/runs')) return [200, { workflow_runs: runs.slice().reverse() }];
  if (rest === '/actions/workflows/release.yml/dispatches' && method === 'POST') {
    runs.push({ status: 'queued', conclusion: null, display_title: 'Release ' + body.inputs.game, run_number: runs.length + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), html_url: 'https://github.com/' + REL_NAME + '/actions/runs/' + (runs.length + 1) });
    return [204, null];
  }
  if (rest.startsWith('/actions/secrets/public-key')) return [200, { key_id: 'key-1', key: Buffer.from(KEYS.publicKey).toString('base64') }];
  if (rest.startsWith('/actions/secrets') && method === 'GET') return [200, { total_count: secrets.size, secrets: [...secrets].map(([name, s]) => ({ name, updated_at: s.updated_at })) }];
  if ((x = /^\/actions\/secrets\/([A-Z0-9_]+)$/.exec(rest)) && method === 'PUT') {
    if (body.key_id !== 'key-1') return [422, { message: 'wrong key' }];
    const all = Buffer.from(body.encrypted_value, 'base64'), epk = all.subarray(0, 32), box = all.subarray(32);
    const opened = nacl.box.open(new Uint8Array(box), blake2b(new Uint8Array([...epk, ...KEYS.publicKey]), 24), new Uint8Array(epk), KEYS.secretKey);
    secrets.set(x[1], { value: opened ? Buffer.from(opened).toString('utf8') : null, updated_at: new Date().toISOString() });
    return [201, null];
  }
  return [404, { message: 'Not Found (stand-in): ' + method + ' ' + rest }];
}

// ---------- Desk's own files ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(DESK, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(DESK) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const errors = [];
async function person(token) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await c.route('**/*', async route => {
    const r = route.request(), url = r.url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:srcdoc') return route.continue();
    if (!url.startsWith('https://api.github.com/')) { outside.push(url); return route.abort(); }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const auth = (r.headers().authorization || '').replace(/^Bearer /, '');
    let body; try { body = r.postData() ? JSON.parse(r.postData()) : undefined; } catch (e) { body = undefined; }
    let status, data;
    try { [status, data] = api(PEOPLE[auth], r.method(), url, body); } catch (e) { status = 500; data = { message: 'stand-in error: ' + e.message }; console.log('! stand-in: ' + r.method() + ' ' + url + ': ' + e.message); }
    await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: data == null ? '' : JSON.stringify(data) });
  });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(token + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(token + ': ' + m.text()); });
  return { c, p };
}
let shotN = 0;
const shot = (p, name) => p.screenshot({ path: path.join(OUT, String(++shotN).padStart(2, '0') + '-' + name + '.png'), fullPage: true }).catch(() => {});
const signIn = async (p, token, opts = {}) => {
  await p.goto(ORIGIN + '/'); await p.fill('#token', token); await p.fill('#factory', FAC_NAME); await p.fill('#release', opts.release ? REL_NAME : '');
  if (opts.remember) await p.check('#remember');
  await p.click('button:has-text("Sign in")');
};
const viewText = p => p.innerText('#view');
const until = (p, text, timeout = 20000) => p.waitForSelector('#view >> text=' + text, { timeout }).then(() => true, () => false);
const frame = p => p.frameLocator('#player-frame');

try {
  // ---------- pictures for the tests, drawn in the browser ----------
  {
    const { p } = await person('tok-owner');
    const draw = (w, h, kind) => p.evaluate(([w, h, kind]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      if (kind === 'shapes') { g.fillStyle = '#2a3a8c'; g.fillRect(0, 0, w, h); for (let i = 0; i < 300; i++) { g.fillStyle = 'hsl(' + ((Math.random() * 360) | 0) + ',70%,60%)'; g.beginPath(); g.ellipse(Math.random() * w, Math.random() * h, 10 + Math.random() * 120, 10 + Math.random() * 120, 0, 0, 7); g.fill(); } g.fillStyle = '#ffc828'; g.fillRect(w * 0.2, h * 0.45, w * 0.6, h * 0.1); }
      else if (kind === 'noise') { const d = g.createImageData(w, h); for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : (Math.random() * 256) | 0; g.putImageData(d, 0, 0); g.fillStyle = '#ffc828'; g.fillRect(w * 0.2, h * 0.45, w * 0.6, h * 0.1); }
      else if (kind === 'button') { g.fillStyle = '#50c8ff'; g.beginPath(); g.roundRect(0, 0, w, h, h * 0.3); g.fill(); }
      else if (kind === 'coin') { g.fillStyle = '#ffd040'; g.beginPath(); g.arc(w / 2, h / 2, w * 0.45, 0, 7); g.fill(); }
      else { g.fillStyle = kind; g.fillRect(0, 0, w, h); }
      return c.toDataURL('image/png').split(',')[1];
    }, [w, h, kind]).then(b => Buffer.from(b, 'base64'));
    PNG = { noise: await draw(3000, 6000, 'noise'), splash: await draw(3000, 6000, 'shapes'), button: await draw(800, 320, 'button'), wrong: await draw(500, 500, '#ff0000'), coin: await draw(2000, 2000, 'coin'), green: await draw(400, 160, '#20a040'), tiny: await draw(64, 64, '#8040ff') };
    await p.context().close();
  }
  const save = (name, buf) => { const f = path.join(WORK, 'files', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f; };

  // ---------- the factory before Desk is opened ----------
  // #7: a green game submission (Sort Demo), with its report and test app on the downloads branch
  const sortSha = commitFiles(FAC, 'submit/sortdemo', 'main', gameFiles('sortdemo', 'Sort Demo', 'games/sortdemo/'), 'Submit Sort Demo');
  pulls.push({ number: 7, title: 'Game: Sort Demo', state: 'open', ref: 'submit/sortdemo', user: 'teammate-a', updated_at: iso(3600e3) });
  checks[sortSha] = { status: 'completed', conclusion: 'success' };
  comments[7] = [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body: '## Factory check: sortdemo\n\n✓ S1 Files: all there\n✓ E2 No errors in the browser\n\n## ✓ Ready for the .aab', created_at: iso(3000e3) },
    { user: { login: 'owner-person', type: 'User' }, body: 'Looks good, testing the app.', created_at: iso(2000e3) }];
  // #9: a declined submission of "mygame" by someone else (its branch is still there)
  commitFiles(FAC, 'submit/mygame', 'main', gameFiles('mygame', 'My Game (old)', 'games/mygame/'), 'Submit My Game');
  pulls.push({ number: 9, title: 'Game: My Game', state: 'closed', ref: 'submit/mygame', user: 'teammate-a', updated_at: iso(86400e3) });
  // #10: a red submission
  const redSha = commitFiles(FAC, 'submit/redgame', 'main', gameFiles('redgame', 'Red Game', 'games/redgame/'), 'Submit Red Game');
  pulls.push({ number: 10, title: 'Game: Red Game', state: 'open', ref: 'submit/redgame', user: 'teammate-b', updated_at: iso(7200e3) });
  checks[redSha] = { status: 'completed', conclusion: 'failure' };
  // #11: an open art proposal of the green button, with a conflict with main
  const artSha = commitFiles(FAC, 'art/202610230900-artist', 'main', { 'kit/art/skin/button-green.png': PNG.green }, 'Art: new green button');
  pulls.push({ number: 11, title: 'Art: new green button', state: 'open', ref: 'art/202610230900-artist', user: 'artist-a', updated_at: iso(5400e3), mergeable: false });
  checks[artSha] = { status: 'completed', conclusion: 'success' };
  // #5: an approved art proposal (closed)
  pulls.push({ number: 5, title: 'Art: new coin', state: 'closed', merged_at: iso(86400e3 * 2), ref: 'art/202610140900-artist', user: 'artist-a', updated_at: iso(86400e3 * 2), sha: refOf(FAC, 'main') });
  // the downloads branch: the kit's photos of its slots (when the factory made them) and #7's test app
  const dl = { 'pr-7/info.json': Buffer.from(JSON.stringify({ game: 'sortdemo', sha: sortSha, date: '2026-10-14 10:35 UTC' })), 'pr-7/sortdemo-test.apk': Buffer.from('PK\x03\x04 test apk'), 'pr-7/game.html': Buffer.from('<!doctype html><title>Sort Demo</title>') };
  const prevDir = path.join(path.resolve(SRC_FAC), 'kit', 'art', 'dist', 'previews');
  if (fs.existsSync(prevDir)) for (const n of fs.readdirSync(prevDir)) dl['previews/' + n] = fs.readFileSync(path.join(prevDir, n));
  commitFiles(FAC, 'downloads', null, dl, 'downloads');
  // the release repository: a downloads branch with the files of the last build in releases.json
  const rels = JSON.parse(fileAt(REL, 'main', 'releases.json') || '[]'), lastRel = rels[rels.length - 1];
  if (lastRel) {
    const runId = String(lastRel.run).split('/').pop(), d = 'run-' + runId + '/';
    commitFiles(REL, 'downloads', null, { [d + 'info.json']: Buffer.from('{}'), [d + 'game.html']: Buffer.from('<!doctype html><title>build</title><p>build</p>'), [d + lastRel.game + '.apk']: Buffer.from('PK apk'),
      [d + lastRel.game + '.aab']: Buffer.from('PK aab'), [d + 'report.md']: Buffer.from('# report'), [d + 'store/icon-512.png']: PNG.tiny }, 'downloads');
  }
  runs.push({ status: 'completed', conclusion: 'success', display_title: 'Release sortdemo', run_number: 1, created_at: iso(7200e3), run_started_at: iso(7200e3), updated_at: iso(6600e3), html_url: 'https://github.com/' + REL_NAME + '/actions/runs/1' });
  secrets.set('ADJUST_APP_TOKEN_SORTDEMO', { value: 'old', updated_at: iso(86400e3) });

  // =====================================================================
  // sign-in
  // =====================================================================
  const O = await person('tok-owner'), p = O.p;
  await signIn(p, 'tok-wrong', { release: true });
  ok('sign-in: a wrong token is refused with a reason', await p.waitForSelector('.note.bad', { timeout: 10000 }).then(() => true, () => false) && !(await p.isVisible('#nav')));
  await p.fill('#factory', 'not a repository'); await p.fill('#token', 'tok-owner'); await p.click('button:has-text("Sign in")');
  ok('sign-in: a malformed repository name is refused', /organization\/repository/.test(await p.innerText('.signin')));
  await signIn(p, 'tok-owner', { release: true });
  ok('sign-in: the owner gets the dashboard, the Builds tab and "owner"', await until(p, 'Games on main') && await p.isVisible('#nav a[data-v="builds"]') && (await p.innerText('#who')).includes('owner-person · owner'));
  ok('sign-in: not kept on this device unless asked (session only)', await p.evaluate(() => !localStorage.getItem('desk.session') && !!sessionStorage.getItem('desk.session')));
  ok('sign-in: the token is not left in the page', !(await p.content()).includes('tok-owner'));
  await shot(p, 'dashboard');

  // =====================================================================
  // dashboard and submissions
  // =====================================================================
  const dash = await viewText(p);
  ok('dashboard: the games on main, counted from the factory', dash.includes('Games on main\n' + gamesOnMain()) || dash.includes('Games on main ' + gamesOnMain()) || new RegExp('Games on main\\s+' + gamesOnMain()).test(dash), 'expected ' + gamesOnMain());
  ok('dashboard: open submissions with their checks (3 open: 2 green, 1 to fix)', /Open submissions\s+3/.test(dash) && dash.includes('2 green') && dash.includes('1 to fix'), dash.split('\n').slice(0, 12).join(' | '));
  await p.goto(ORIGIN + '/#submissions'); await until(p, 'Game: Sort Demo');
  const subs = await viewText(p);
  ok('submissions: the open ones with kind and check', subs.includes('Game: Sort Demo') && subs.includes('Art: new green button') && subs.includes('Game: Red Game') && subs.includes('All green') && subs.includes('Needs fixes'));
  await p.click('#view a:has-text("Closed")'); await until(p, 'Art: new coin');
  ok('submissions: the closed ones, approved and declined', (await viewText(p)).includes('Approved') && (await viewText(p)).includes('Declined'));

  // a game submission: report, notes, play, test app
  await p.goto(ORIGIN + '/#submission/7'); await until(p, 'Factory check report');
  const s7 = await viewText(p);
  ok('submission: the report (from the check\'s comment) and the notes', s7.includes('Ready for the .aab') && s7.includes('Looks good, testing the app.') && /game · sortdemo/i.test(s7));
  ok('submission: the changed files', /\d+ changed files/.test(s7) && s7.includes('games/sortdemo/game.json'));
  await shot(p, 'submission');
  await p.click('button:has-text("Play this version")');
  ok('submission: "Play this version" builds the game in the browser and runs it (sealed frame)', await frame(p).locator('#dk-home').waitFor({ timeout: 60000 }).then(() => true, () => false) && (await p.innerText('#player-msg')).includes('Sort Demo'));
  ok('the player\'s frame is sealed (scripts only: no network, no storage, no access to Desk)', await p.getAttribute('#player-frame', 'sandbox') === 'allow-scripts');
  await shot(p, 'player');
  await p.click('#player-close');
  const [apk] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('button:has-text("Download the test app (.apk)")')]);
  ok('submission: the test app downloads from the downloads branch, named with the version', apk.suggestedFilename() === 'sortdemo-test-' + sortSha.slice(0, 7) + '.apk', apk.suggestedFilename());

  // a red submission: approve is off
  await p.goto(ORIGIN + '/#submission/10'); await until(p, 'Not green');
  ok('submission: a red one cannot be approved', await p.isDisabled('button:has-text("Approve and merge")'));

  // =====================================================================
  // approve, decline
  // =====================================================================
  const mainBefore = refOf(FAC, 'main'), gamesBefore = gamesOnMain();
  await p.goto(ORIGIN + '/#submission/7'); await until(p, 'Factory check report');
  await p.click('button:has-text("Approve and merge")'); await p.click('button.danger:has-text("Merge")');
  await p.waitForFunction(() => document.querySelector('#view') && /Approved and merged/.test(document.querySelector('#view').innerText), null, { timeout: 15000 }).catch(() => {});
  const merge = calls.find(c => c.method === 'PUT' && c.path === '/pulls/7/merge');
  ok('approve: squash merge at the reviewed commit', merge && merge.body.merge_method === 'squash' && merge.body.sha === sortSha);
  ok('approve: the game is on main now, and its branch is deleted', refOf(FAC, 'main') !== mainBefore && gamesOnMain() === gamesBefore + 1 && !!fileAt(FAC, 'main', 'games/sortdemo/game.json') && !refOf(FAC, 'submit/sortdemo'));
  await p.goto(ORIGIN + '/#submission/10'); await until(p, 'Not green');
  await p.click('button:has-text("Decline")'); await p.fill('#decline-why', 'The levels 4-6 cannot be solved.'); await p.click('button.danger:has-text("Decline")');
  await p.waitForFunction(() => /Declined/.test(document.querySelector('#view').innerText), null, { timeout: 15000 }).catch(() => {});
  ok('decline: the note is posted and the submission closed', (comments[10] || []).some(c => c.body === 'The levels 4-6 cannot be solved.') && pulls.find(x => x.number === 10).state === 'closed');

  // =====================================================================
  // submit (the owner): a folder that is not ready, then a declined game's resubmission, then an update
  // =====================================================================
  await p.goto(ORIGIN + '/#submit'); await p.waitForSelector('#folder', { state: 'attached' });
  await p.setInputFiles('#folder', gameFolder('broken', 'Broken', ['bot.js']));
  ok('submit: a folder without bot.js is stopped before anything is sent', await until(p, 'Fix these before submitting') && (await viewText(p)).includes('missing bot.js') && !(await p.isVisible('button:has-text("Submit")')));
  const mine = gameFolder('mygame', 'My Game');
  await p.goto(ORIGIN + '/#dashboard'); await p.goto(ORIGIN + '/#submit'); await p.waitForSelector('#folder', { state: 'attached' });
  await p.setInputFiles('#folder', mine); await until(p, 'resubmits the declined submission #9');
  const sv = await viewText(p);
  ok('submit: the owner is warned the id belongs to someone else\'s submission', sv.includes('belongs to teammate-a\'s submission #9'));
  const listed = await p.$$eval('#view .files div', d => d.map(x => x.textContent));
  ok('submit: the files are listed, dist/ left out', listed.includes('game.json') && listed.includes('levels.json') && !listed.some(f => f.startsWith('dist/')), listed.length + ' files');
  await shot(p, 'submit');
  await p.click('button:has-text("Play it here first")');
  ok('submit: "Play it here first" runs the folder with the kit from main', await frame(p).locator('#dk-home').waitFor({ timeout: 60000 }).then(() => true, () => false));
  await p.click('#player-close');
  await p.click('button:has-text("Resubmit #9")'); await until(p, 'Resubmitted and reopened');
  const b9 = refOf(FAC, 'submit/mygame');
  ok('resubmit: the declined #9 is reopened (no new pull request), with a note', pulls.find(x => x.number === 9).state === 'open' && !calls.some(c => c.method === 'POST' && c.path === '/pulls') && (comments[9] || []).some(c => /Resubmitted from Desk/.test(c.body)));
  ok('resubmit: the branch holds the folder as it is now', JSON.parse(fileAt(FAC, b9, 'games/mygame/game.json')).title === 'My Game' && !!fileAt(FAC, b9, 'games/mygame/bot.js'));
  // an update removes files that are gone from the folder
  fs.rmSync(path.join(mine, 'tools'), { recursive: true, force: true });
  const hadTools = gitS(FAC, 'ls-tree', '-r', '--name-only', b9, 'games/mygame/tools').length > 0;
  await p.goto(ORIGIN + '/#dashboard'); await p.goto(ORIGIN + '/#submit'); await p.waitForSelector('#folder', { state: 'attached' });
  await p.setInputFiles('#folder', mine); await until(p, 'This updates the open submission #9');
  await p.click('button:has-text("Update submission #9")'); await until(p, 'Updated (');
  const b9b = refOf(FAC, 'submit/mygame');
  ok('update: one new commit on the same branch, after the last one', b9b !== b9 && gitS(FAC, 'rev-parse', b9b + '^') === b9);
  ok('update: files gone from the folder are removed from the submission', !hadTools || gitS(FAC, 'ls-tree', '-r', '--name-only', b9b, 'games/mygame/tools') === '');

  // =====================================================================
  // a teammate: no builds, no approving, no taking someone else's id, a new game
  // =====================================================================
  const Tm = await person('tok-team'), t = Tm.p;
  await signIn(t, 'tok-team');
  ok('teammate: signed in without the release repository: no Builds tab, not "owner"', await until(t, 'Games on main') && !(await t.isVisible('#nav a[data-v="builds"]')) && !(await t.innerText('#who')).includes('owner'));
  await t.goto(ORIGIN + '/#submission/9'); await until(t, 'Factory check report');
  ok('teammate: no Approve or Decline', !(await t.isVisible('button:has-text("Approve and merge")')) && !(await t.isVisible('button:has-text("Decline")')));
  await t.goto(ORIGIN + '/#submit'); await t.waitForSelector('#folder', { state: 'attached' });
  await t.setInputFiles('#folder', mine);
  ok('teammate: someone else\'s id is refused', await until(t, 'Fix these before submitting') && (await viewText(t)).includes('is used by teammate-a\'s submission #9'));
  await t.goto(ORIGIN + '/#dashboard'); await t.goto(ORIGIN + '/#submit'); await t.waitForSelector('#folder', { state: 'attached' });
  await t.setInputFiles('#folder', gameFolder('newgame', 'New Game')); await until(t, 'The basics look right');
  await t.click('button:has-text("Submit")'); await until(t, 'Submitted (');
  const np = calls.find(c => c.method === 'POST' && c.path === '/pulls' && c.body.head === 'submit/newgame');
  ok('teammate: a new game opens a pull request from its own branch', np && np.body.title === 'Game: New Game' && np.who === 'teammate-b' && !!fileAt(FAC, 'submit/newgame', 'games/newgame/levels.json'));
  await shot(t, 'teammate-submitted');
  await t.goto(ORIGIN + '/#builds'); await t.waitForSelector('#view .note', { timeout: 10000 });
  ok('teammate: the Builds page says builds need the release repository', (await viewText(t)).includes('Only the owner has access'));

  // =====================================================================
  // builds (the owner): the form, a build, the Adjust secrets, the release history
  // =====================================================================
  await p.goto(ORIGIN + '/#builds'); await until(p, 'New build');
  const defs = JSON.parse(fileAt(REL, 'main', 'defaults.json') || '{}');
  await p.selectOption('#b-game', 'sortdemo');
  const pkgNow = await p.inputValue('#b-pkg'), lastPkg = rels.filter(r => r.game === 'sortdemo' && !/factorytest/.test(r.package)).slice(-1)[0];
  ok('builds: the links start from defaults.json, the package from the last build or the prefix', await p.inputValue('#b-terms') === (defs.terms || '') && await p.inputValue('#b-privacy') === (defs.privacy || '') && pkgNow === (lastPkg ? lastPkg.package : (defs.packagePrefix || 'com.duste.') + 'sortdemo'), pkgNow);
  await p.fill('#b-terms', 'ftp://wrong'); await p.click('button:has-text("Review and start")');
  ok('builds: a wrong link is caught before anything starts', (await viewText(p)).includes('Terms URL starting with https://') && !calls.some(c => c.path.endsWith('/dispatches')));
  await p.fill('#b-terms', 'https://example.com/terms'); await p.fill('#b-vc', '1234');
  await p.click('button:has-text("Review and start")'); await p.click('button.danger:has-text("Start the build")'); await until(p, 'Started.');
  const disp = calls.find(c => c.path.endsWith('/dispatches'));
  ok('builds: the build starts with exactly the form\'s values', disp && disp.repo === REL_NAME && disp.body.inputs.game === 'sortdemo' && disp.body.inputs.source === 'main' && disp.body.inputs.terms_url === 'https://example.com/terms' && disp.body.inputs.version_code === '1234' && disp.body.inputs.adjust_environment === 'sandbox', disp && JSON.stringify(disp.body.inputs));
  ok('builds: the recent builds list', await p.waitForSelector('#view >> text=Release sortdemo', { timeout: 15000 }).then(() => true, () => false));
  // Adjust tokens: sealed in the browser, opened only by "GitHub" (the stand-in, with its own key)
  await p.waitForSelector('#adjust button:has-text("Save the app token")');
  ok('adjust: which secrets are set', (await p.innerText('#adjust')).includes('ADJUST_APP_TOKEN_SORTDEMO') && (await p.innerText('#adjust')).includes('Set ') && (await p.innerText('#adjust')).includes('Not set'));
  await p.fill('#adjust label:has-text("App token") input', 'bad token!'); await p.click('#adjust button:has-text("Save the app token")');
  ok('adjust: a token with other characters is refused', (await p.innerText('#adjust')).includes('only letters and digits'));
  await p.fill('#adjust label:has-text("App token") input', 'abc123XYZ789'); await p.click('#adjust button:has-text("Save the app token")'); await p.click('#adjust button.danger:has-text("Save")');
  await p.waitForSelector('#adjust >> text=ADJUST_APP_TOKEN_SORTDEMO saved', { timeout: 10000 }).catch(() => {});
  const putApp = calls.find(c => c.method === 'PUT' && c.path === '/actions/secrets/ADJUST_APP_TOKEN_SORTDEMO');
  ok('adjust: the app token reaches GitHub sealed, and opens to exactly what was typed', putApp && !JSON.stringify(putApp.body).includes('abc123XYZ789') && secrets.get('ADJUST_APP_TOKEN_SORTDEMO').value === 'abc123XYZ789');
  await p.waitForSelector('#adjust input[data-event="day_1_login"]', { timeout: 10000 });
  await p.fill('#adjust input[data-event="day_1_login"]', 'aaa111'); await p.fill('#adjust input[data-event="level_10_achieved"]', 'bbb222');
  await p.click('#adjust button:has-text("Save the event tokens")');
  ok('adjust: before saving, it says which events stay empty', (await p.innerText('#adjust')).includes('These stay empty and will not be sent'));
  await p.click('#adjust button.danger:has-text("Save")'); await p.waitForSelector('#adjust >> text=ADJUST_EVENTS_SORTDEMO saved', { timeout: 10000 }).catch(() => {});
  const ev = (secrets.get('ADJUST_EVENTS_SORTDEMO') || {}).value || '';
  ok('adjust: the event tokens are saved together, one event=token per line', ev.split('\n').sort().join(',') === 'day_1_login=aaa111,level_10_achieved=bbb222', ev);
  await shot(p, 'builds');
  if (lastRel) {
    const hist = await viewText(p);
    ok('builds: the release history from releases.json', hist.includes('Release history') && hist.includes(String(lastRel.versionCode)));
    const [aab] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.click('#view tr:has-text("' + lastRel.versionCode + '") button:has-text(".aab")')]);
    ok('builds: a build\'s files download from the release downloads branch', aab.suggestedFilename() === lastRel.game + '.aab', aab.suggestedFilename());
  }

  // =====================================================================
  // art: replace, refuse, text styles, fonts, preview, the overlap warning, propose
  // =====================================================================
  await p.goto(ORIGIN + '/#art'); await p.waitForSelector('#view >> text=UI skin', { timeout: 30000 });
  const pick = async (cardText, file) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.locator('.art-item:has(.nm:text-is("' + cardText + '")) button:has-text("Replace")').click()]); await fc.setFiles(file); };
  // splash: a big master of another shape
  const splashPick = async f => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.locator('section:has(h2:text-is("Splash")) button:has-text("Replace")').click()]); await fc.setFiles(f); };
  await splashPick(save('splash-noise.png', PNG.noise));
  ok('art: a picture that cannot be made small enough (pure noise) is refused with the reason', await p.waitForSelector('text=Could not make the picture small enough', { timeout: 60000 }).then(() => true, () => false) && !(await p.isVisible('.tray')));
  ok('art: the splash master for the next check is big (several MB)', PNG.splash.length > 1e6, Math.round(PNG.splash.length / 1e6) + ' MB');
  await splashPick(save('splash-master.png', PNG.splash));
  ok('art: a big splash master is made 1080 x 2340, its color taken from its edges', await p.waitForSelector('.tray >> text=splash/', { timeout: 60000 }).then(() => true, () => false) && /1080 x 2340/.test(await p.innerText('.tray')) && (await p.innerText('.tray')).includes('splash/splash.json'));
  await pick('coin', save('coin-master.png', PNG.coin)); await p.waitForSelector('.tray >> text=icons/coin', { timeout: 30000 });
  ok('art: an icon master becomes 256 x 256', /icons\/coin\.\w+ .*256 x 256/.test(await p.innerText('.tray')));
  // skin: a master of the wrong shape, then a right one, then a Lottie
  const skinCount = await p.locator('.art-item.skin').count(), SK = JSON.parse(fileAt(FAC, 'main', 'kit/core/skin.json'));
  const wantCards = SK.slots.reduce((n, s) => n + (s.kind === 'pieces' ? s.count : 1), 0);
  ok('art: one card per skin slot (pieces: one each)', skinCount === wantCards, skinCount + ' of ' + wantCards);
  const hasPic = new Set(gitS(FAC, 'ls-tree', '--name-only', 'main', 'kit/art/skin/').split('\n').filter(Boolean).map(f => path.basename(f).replace(/\.[^.]+$/, '')));
  const photos = new Set(Object.keys(dl).filter(k => k.startsWith('previews/')).map(k => path.basename(k, '.png')));
  const drawnWant = SK.slots.filter(s => s.kind !== 'lottie' && s.kind !== 'pieces' && !hasPic.has(s.id) && photos.has(s.id)).length;
  ok('art: slots without a picture show the kit\'s drawing (its photo)', await p.locator('.skin-thumb.drawn').count() === drawnWant, (await p.locator('.skin-thumb.drawn').count()) + ' of ' + drawnWant);
  const green = SK.slots.find(s => s.id === 'button-green');
  await pick(green.title, save('button-wrong.png', PNG.wrong));
  ok('art: a master with other proportions is refused, with the size to draw', await p.waitForSelector('text=has other proportions than the slot', { timeout: 20000 }).then(() => true, () => false));
  await pick(green.title, save('button-master.png', PNG.button));
  ok('art: a right master is scaled to the slot\'s exact size', await p.waitForSelector('.tray >> text=skin/button-green', { timeout: 20000 }).then(() => true, () => false) && /skin\/button-green\.\w+ .*800 x 320 → 400 x 160/.test(await p.innerText('.tray')));
  const cel = SK.slots.find(s => s.kind === 'lottie');
  if (cel) {
    await pick(cel.title, save('celebration.json', Buffer.from(JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: cel.size[0], h: cel.size[1], layers: [] }))));
    ok('art: a Lottie animation is taken as it is', await p.waitForSelector('.tray >> text=skin/' + cel.id + '.json', { timeout: 20000 }).then(() => true, () => false));
  }
  // a font and a text style that uses it
  const [fcF] = await Promise.all([p.waitForEvent('filechooser'), p.locator('button:has-text("Add a font or its license")').click()]);
  await fcF.setFiles(save('Fraunces-Test.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(2000, 7)])));
  await p.waitForSelector('.tray >> text=fonts/Fraunces-Test.woff2', { timeout: 20000 });
  const TS = JSON.parse(fileAt(FAC, 'main', 'kit/core/text.json')), st = TS.styles.find(s => s.id === 'title') || TS.styles[0];
  const row = p.locator('table.texts tr:has(td strong:text-is("' + st.title + '"))').first();
  await row.locator('input[type=color]').first().evaluate(i => { i.value = '#00ff7f'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(800);
  await p.locator('table.texts tr:has(td strong:text-is("' + st.title + '")) select').first().selectOption('Fraunces-Test'); await p.waitForTimeout(800);
  await p.locator('table.texts tr:has(td strong:text-is("' + st.title + '")) input[aria-label$="size %"]').first().evaluate(i => { i.value = '120'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await p.waitForTimeout(800);
  ok('art: a text style\'s color, font and size are kept as one change (text.json)', (await p.innerText('.tray')).includes('text.json'));
  // the open proposal #11 changes the same green button
  ok('art: warns about an open proposal that changes the same picture', await p.waitForSelector('.tray >> text=Also changed in an open art proposal', { timeout: 15000 }).then(() => true, () => false) && (await p.innerText('.tray')).includes('#11') && await p.isVisible('.tray button:has-text("Propose anyway")'));
  await shot(p, 'art');
  // the preview: every screen of the kit's list, with the changes
  await p.click('.tray button:has-text("Preview on the kit screens")');
  await p.waitForSelector('#player-screen:not([hidden]) option[value="win"]', { state: 'attached', timeout: 90000 });
  const scrSrc = fileAt(FAC, 'main', 'kit/preview/screens.js').toString(), scrWant = (scrSrc.match(/^  \['/gm) || []).length;
  const opts = await p.$$eval('#player-screen option', o => o.map(x => x.value).filter(Boolean));
  ok('preview: the Show menu has the factory\'s screen list', opts.length === scrWant, opts.length + ' of ' + scrWant);
  const WANT = { splash: '#dk-splash', home: '#dk-home .dk-node.cur', 'home-hard': '.dk-node.hard', 'home-superhard': '.dk-node.superhard',
    'home-lives': '[data-lives] .dk-plus:not(.dk-hidden)', 'home-done': '#dk-home .done', toast: '#dk-toast:not(.dk-hidden)', settings: '.dk-set',
    tutorial: '.dk-panel.tut .dk-btn:has-text("Got it")', 'tutorial-next': '.dk-panel.tut .dk-btn:has-text("Next")', 'tutorial-focus': '#dk-tut:not(.dk-hidden) .bubble',
    'tutorial-booster': '.dk-panel.tut.booster .tut-pic', 'tutorial-booster-use': '#dk-tut:not(.dk-hidden) .bubble:has-text("Tap to use")', 'tutorial-obstacle': '.dk-panel.tut.obstacle .tut-pic img',
    'booster-locked': '.dk-booster.locked', level: '#dk-hud .lvl.normal', 'level-hard': '#dk-hud .lvl.hard', 'level-superhard': '#dk-hud .lvl.superhard',
    'boosters-empty': '.dk-booster .cnt.plus', paused: '#dk-pops .dk-btn.red', quit: '.dk-panel.fail .msg:has-text("lose one life")', booster: '#dk-pops .booster-art',
    'booster-nocoins': '#dk-pops .note.warn:not(.dk-hidden)', fail: '#dk-pops .amount', 'fail-art': '#dk-pops .fail-art img', 'fail-nocoins': '#dk-pops .note.warn:not(.dk-hidden)',
    fail2: '.dk-panel.fail .msg:has-text("lose one life")', failed: '.dk-panel .lost', nolives: '.dk-heart', refill: '.dk-heart b:has-text("2")',
    'refill-nocoins': '#dk-pops .note.warn:not(.dk-hidden)', 'milestones-home': '.dk-ms-bar:not(.dk-hidden)', milestones: '.ms-row', 'milestone-reward': '.dk-win.ms-reward',
    'milestones-gone': '#dk-home:has(.dk-ms-bar.dk-hidden) .dk-node.cur', win: '.dk-win:not(.ms-reward)' };
  const missing = [], unknown = opts.filter(id => !WANT[id]);
  for (const id of opts) {
    await p.selectOption('#player-screen', id); await p.waitForTimeout(1300);
    let vis = false; try { vis = await frame(p).locator(WANT[id] || 'nothing').first().isVisible(); } catch (e) {}
    if (!vis) missing.push(id);
    if (id === 'settings' || id === 'quit' || id === 'milestones') await shot(p, 'show-' + id);
  }
  ok('preview: every screen opens with its own content', !missing.length, 'missing: ' + missing.join(', ') + (unknown.length ? ' (new screens this test does not know yet: add them to WANT)' : ''));
  await p.selectOption('#player-screen', 'settings'); await p.waitForTimeout(800);
  const ttl = await frame(p).locator('.dk-panel > .dk-title').first().evaluate(e => ({ c: getComputedStyle(e).color, f: getComputedStyle(e).fontFamily }));
  ok('preview: the changed text style shows (color and font)', st.id !== 'title' || (ttl.c === 'rgb(0, 255, 127)' && ttl.f.includes('DKF-Fraunces-Test')), JSON.stringify(ttl));
  ok('preview: the new button picture is used', await frame(p).locator('.dk-btn').first().evaluate(e => { const s = getComputedStyle(e); return s.backgroundImage.startsWith('url(') || s.borderImageSource.startsWith('url('); }));
  await p.click('#player-close');
  // propose
  await p.fill('#art-title', 'New splash, coin, button and title style');
  await p.click('.tray button:has-text("Propose anyway")'); await p.waitForSelector('.tray >> text=Proposed.', { timeout: 60000 });
  const artPr = calls.filter(c => c.method === 'POST' && c.path === '/pulls').map(c => c.body).find(b => b.head.startsWith('art/'));
  const ab = artPr && refOf(FAC, artPr.head), changed = ab ? gitS(FAC, 'diff', '--name-only', 'main', ab).split('\n') : [];
  ok('propose: one art branch and pull request, titled', !!ab && artPr.title === 'Art: New splash, coin, button and title style');
  ok('propose: only the game-ready files (art pack only)', changed.length > 0 && changed.every(f => f.startsWith('kit/art/')), changed.join(', '));
  const splashFile = changed.find(f => /^kit\/art\/splash\/[^/]+\.(webp|png)$/.test(f)), splashBytes = splashFile ? fileAt(FAC, ab, splashFile) : null;
  ok('propose: the splash is under 300 KB', !!splashBytes && splashBytes.length <= 300000, splashBytes && Math.round(splashBytes.length / 1024) + ' KB');
  const tj = JSON.parse(fileAt(FAC, ab, 'kit/art/text.json') || '{}');
  ok('propose: text.json has the style as set', tj[st.id] && tj[st.id].color === '#00ff7f' && tj[st.id].font === 'Fraunces-Test' && tj[st.id].size === 120, JSON.stringify(tj[st.id]));
  ok('propose: the font and the skin files are in', changed.includes('kit/art/fonts/Fraunces-Test.woff2') && changed.some(f => f.startsWith('kit/art/skin/button-green.')));
  // #11 now: its conflict, and the new proposal changing the same picture
  await p.goto(ORIGIN + '/#submission/11'); await until(p, 'has a conflict with main');
  const s11 = await viewText(p);
  ok('art submission with a conflict: says so, Approve is off', s11.includes('has a conflict with main') && await p.isDisabled('button:has-text("Approve and merge")'));
  ok('art submission: lists the other open proposal that changes the same picture, not itself', s11.includes('Another open art proposal changes the same pictures') && s11.includes('#' + (nextPr - 1)) && !/#11 "/.test(s11));
  await shot(p, 'art-conflict');

  // =====================================================================
  // remember me, sign out, an expired token
  // =====================================================================
  await p.click('#logout'); await p.waitForSelector('#token', { timeout: 10000 }).catch(() => {});
  const out = await p.evaluate(() => ({ form: !!document.querySelector('#token'), local: localStorage.getItem('desk.session'), session: sessionStorage.getItem('desk.session'), nav: !document.querySelector('#nav').hidden }));
  ok('sign out: back to sign-in, nothing kept', out.form && !out.local && !out.session && !out.nav, JSON.stringify(out));
  await signIn(p, 'tok-owner', { release: true, remember: true }); await until(p, 'Games on main');
  ok('remember: kept on this device when asked', await p.evaluate(() => !!localStorage.getItem('desk.session')));
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('desk.session')); v.token = 'tok-expired'; localStorage.setItem('desk.session', JSON.stringify(v)); });
  await p.reload(); await p.waitForSelector('#token', { timeout: 15000 }).catch(() => {});
  ok('an expired token: back to sign-in with the reason', await p.isVisible('#token') && /expired|revoked/.test(await p.innerText('.signin')));

  // =====================================================================
  // nothing else
  // =====================================================================
  ok('no request left the page except to GitHub\'s API and its own files', !outside.length, outside.slice(0, 5).join(', '));
  ok('no errors in the pages', !errors.length, errors.slice(0, 5).join(' | '));
} catch (e) {
  fails++; console.log('✗ the test stopped: ' + (e && e.stack || e));
} finally {
  await browser.close(); server.close();
  console.log('\n' + passes + ' passed, ' + fails + ' failed. Screenshots: ' + OUT);
  if (!OUT_ARG) console.log('(the copies of the repositories: ' + WORK + ')');
  process.exit(fails ? 1 : 0);
}
