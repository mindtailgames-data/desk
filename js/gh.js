// GitHub, straight from the browser with the signed-in person's own token. Nothing else is contacted.
// GitHub decides what each person may do: a teammate's token reaches only the factory repository.

const API = 'https://api.github.com';
const KEY = 'desk.session';

export class GitHubError extends Error {
  constructor(status, message, path) { super(message); this.status = status; this.path = path; }
}

// ---------- the session (token + repositories), kept only in this browser ----------
export const session = {
  load() {
    for (const s of [sessionStorage, localStorage]) { try { const v = JSON.parse(s.getItem(KEY) || 'null'); if (v && v.token) return v; } catch (e) {} }
    return null;
  },
  save(v, remember) {
    session.clear();
    try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(v)); } catch (e) {}
  },
  clear() { for (const s of [sessionStorage, localStorage]) { try { s.removeItem(KEY); } catch (e) {} } }
};

export function client(token) {
  async function req(method, path, body, opts = {}) {
    const headers = { Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', Accept: opts.accept || 'application/vnd.github+json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
    catch (e) { throw new GitHubError(0, 'Could not reach GitHub. Check the internet connection.', path); }
    if (r.status === 204) return null;
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) {
      let msg = (data && data.message) || ('GitHub answered ' + r.status);
      if (r.status === 401) msg = 'GitHub did not accept the token (expired or revoked). Sign in again with a new token.';
      else if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') msg = 'GitHub\'s hourly limit for this token is used up. Try again in a while.';
      else if (r.status === 403 || r.status === 404) msg = (r.status === 404 ? 'Not found, or this token has no access to it' : 'This token is not allowed to do that') + ' (' + msg + ').';
      throw new GitHubError(r.status, msg, path);
    }
    return data;
  }
  const get = (p, o) => req('GET', p, undefined, o);

  // immutable things (blobs by their hash) are kept in memory for this visit only
  const blobCache = new Map(), treeCache = new Map();
  async function blob(repo, sha) {
    if (!blobCache.has(sha)) blobCache.set(sha, get('/repos/' + repo + '/git/blobs/' + sha).then(b => b64ToBytes(b.content)).catch(e => { blobCache.delete(sha); throw e; }));
    return blobCache.get(sha);
  }
  async function tree(repo, commitSha) {
    if (!treeCache.has(commitSha)) treeCache.set(commitSha, get('/repos/' + repo + '/git/trees/' + commitSha + '?recursive=1').then(t => {
      if (t.truncated) throw new GitHubError(0, 'The repository is too large to read in one go.', '');
      const files = new Map(); for (const e of t.tree) if (e.type === 'blob') files.set(e.path, e); return files;
    }).catch(e => { treeCache.delete(commitSha); throw e; }));
    return treeCache.get(commitSha);
  }
  // a reader of one folder at one commit: { text, bytes, list, has, paths } (what the game builder uses)
  async function reader(repo, commitSha, root) {
    const files = await tree(repo, commitSha), pre = root ? root.replace(/\/?$/, '/') : '';
    const full = p => pre + p.replace(/^\/+/, '');
    const bytes = async p => { const e = files.get(full(p)); if (!e) throw new GitHubError(404, 'Missing file: ' + full(p), p); return blob(repo, e.sha); };
    return {
      bytes,
      text: async p => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await bytes(p)),
      has: p => files.has(full(p)),
      list: async d => {
        const dir = full(d).replace(/\/?$/, '/').replace(/^\/$/, ''), out = new Set();
        for (const k of files.keys()) if (k.startsWith(dir)) out.add(k.slice(dir.length).split('/')[0]);
        return [...out];
      },
      paths: () => [...files.keys()].filter(k => k.startsWith(pre)).map(k => k.slice(pre.length)),
      entry: p => files.get(full(p))
    };
  }

  // one commit that writes and deletes files on a branch (created from `base` when it does not exist yet)
  async function commitFiles(repo, branch, { base, message, write = [], remove = [] }) {
    let parent;
    try { parent = (await get('/repos/' + repo + '/git/ref/heads/' + encodeRef(branch))).object.sha; } catch (e) { if (e.status !== 404) throw e; }
    const exists = !!parent;
    if (!exists) parent = (await get('/repos/' + repo + '/git/ref/heads/' + encodeRef(base))).object.sha;
    const parentCommit = await get('/repos/' + repo + '/git/commits/' + parent);
    const entries = [];
    for (const f of write) {
      const b = await req('POST', '/repos/' + repo + '/git/blobs', { content: bytesToB64(f.bytes), encoding: 'base64' });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
    }
    for (const p of remove) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    const t = await req('POST', '/repos/' + repo + '/git/trees', { base_tree: parentCommit.tree.sha, tree: entries });
    const c = await req('POST', '/repos/' + repo + '/git/commits', { message, tree: t.sha, parents: [parent] });
    if (exists) await req('PATCH', '/repos/' + repo + '/git/refs/heads/' + encodeRef(branch), { sha: c.sha, force: false });
    else await req('POST', '/repos/' + repo + '/git/refs', { ref: 'refs/heads/' + branch, sha: c.sha });
    return { sha: c.sha, created: !exists };
  }

  return { req, get, post: (p, b) => req('POST', p, b), patch: (p, b) => req('PATCH', p, b), put: (p, b) => req('PUT', p, b), del: p => req('DELETE', p),
    blob, tree, reader, commitFiles };
}

const encodeRef = r => r.split('/').map(encodeURIComponent).join('/');
export function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, '')), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function bytesToB64(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
