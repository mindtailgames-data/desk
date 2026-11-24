// The game builder, in the browser: the same page as the factory's own Python build makes.
// Works on any "reader" ({ text(path), bytes(path), list(dir) }), so the website reads the kit from the factory's main branch
// and the game from a submission branch, and a test reads both from disk. Nothing is sent anywhere.

const ORDER = ['economy', 'levels', 'audio', 'haptics', 'analytics', 'settings', 'flows', 'tutorial', 'boosters', 'home', 'milestones', 'splash'];
const ALWAYS = new Set(['economy', 'levels', 'audio', 'haptics', 'analytics', 'settings', 'flows', 'tutorial', 'boosters', 'home', 'milestones', 'splash']);
const FORBIDDEN_KEYS = ['token', 'secret', 'password', 'keystore', 'apikey', 'api_key'];
export const DEFAULT_ECONOMY = { startCoins: 3600, maxLives: 5, lifeMinutes: 30, playOnCost: 300, refillCost: 300, rewards: { normal: 25, hard: 50, superhard: 100 } };
const MIME = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', woff2: 'font/woff2',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/x-wav', m4a: 'audio/mp4' };

export function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const ext = f => (f.includes('.') ? f.slice(f.lastIndexOf('.') + 1) : '').toLowerCase();
const stem = f => (f.includes('.') ? f.slice(0, f.lastIndexOf('.')) : f);
const dataUri = (name, bytes) => 'data:' + (MIME[ext(name)] || 'application/octet-stream') + ';base64,' + base64(bytes);
// Python reads text files with universal newlines
export const pyText = s => s.replace(/\r\n?/g, '\n');
// json.dumps(x, separators=(',', ':')) with Python's default ensure_ascii
export function pyJson(x) {
  return JSON.stringify(x).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function checkPublic(cfg, path = 'cfg') {
  if (Array.isArray(cfg)) cfg.forEach((v, i) => checkPublic(v, path + '[' + i + ']'));
  else if (cfg && typeof cfg === 'object') {
    for (const [k, v] of Object.entries(cfg)) {
      if (FORBIDDEN_KEYS.some(w => k.toLowerCase().replace(/-/g, '_').includes(w)))
        throw new Error('game.json must not contain "' + path + '.' + k + '": credentials go into the Android build secrets, never into the page');
      checkPublic(v, path + '.' + k);
    }
  }
}

// kit: a reader rooted at the factory's kit/ folder
async function first(kit, folder, name, only) {   // (only: one extension, like '.woff2')
  const files = (await kit.list('art/' + folder)).sort();
  const f = files.find(x => stem(x) === name && (!only || x.toLowerCase().endsWith(only)));
  return f ? 'art/' + folder + '/' + f : null;
}
export async function loadArt(kit) {
  const icons = {};
  for (const f of (await kit.list('art/icons')).sort()) {
    const e = ext(f);
    if (e === 'svg') icons[stem(f)] = pyText(await kit.text('art/icons/' + f)).trim();
    else if (e === 'png' || e === 'webp') icons[stem(f)] = '<svg viewBox="0 0 100 100"><image href="' + dataUri(f, await kit.bytes('art/icons/' + f)) + '" width="100" height="100"/></svg>';
  }
  const sounds = {};
  for (const f of (await kit.list('art/sounds')).sort()) if (['mp3', 'ogg', 'm4a', 'wav'].includes(ext(f))) sounds[stem(f)] = dataUri(f, await kit.bytes('art/sounds/' + f));
  const music = await first(kit, 'music', 'music');
  const themeFile = (await kit.list('art')).includes('theme.json');
  return { icons, sounds, music: music ? dataUri(music, await kit.bytes(music)) : null,
    theme: themeFile ? JSON.parse(await kit.text('art/theme.json')) : {} };
}
async function firstPicture(kit, folder, name) {
  const f = await first(kit, folder, name);
  return f && ['png', 'webp'].includes(ext(f)) ? f : null;
}
// a number for CSS: at most 3 decimals, no trailing zeros (the same text as the factory's Python build)
export const num = v => { const s = v.toFixed(3).replace(/0+$/, ''); return s.endsWith('.') ? s.slice(0, -1) : s; };
const SKIN_DECL = {
  stretch: u => 'background:url(' + u + ') center/100% 100% no-repeat;',
  contain: u => 'background:url(' + u + ') center/contain no-repeat;',
  cover: u => 'background:url(' + u + ') center/cover no-repeat;',
  'tile-y': u => 'background:url(' + u + ') center top/100% auto repeat-y;'
};
// the UI skin (kit/core/skin.json): { css, art: {confetti} | null, celebration: the animation's JSON text | null, lottie: the player's code or '' }
export async function loadSkin(kit) {
  const spec = JSON.parse(await kit.text('core/skin.json'));
  const unit = px => 'calc(var(--u)*' + num(px * 100 / spec.reference) + ')';
  const rules = [], extra = {};
  const skinFiles = await kit.list('art/skin');
  for (const slot of spec.slots) {
    const k = slot.kind;
    if (k === 'pieces') {
      const pieces = [];
      for (let i = 1; i <= slot.count; i++) { const f = await firstPicture(kit, 'skin', slot.id + '-' + i); if (f) pieces.push(dataUri(f, await kit.bytes(f))); }
      if (pieces.length) extra.confetti = pieces;
      continue;
    }
    if (k === 'lottie') {
      if (skinFiles.includes(slot.id + '.json')) {   // into the page as the art team made it (checked as JSON first)
        const raw = pyText(await kit.text('art/skin/' + slot.id + '.json')).trim();
        JSON.parse(raw);
        if (raw.toLowerCase().includes('</script')) throw new Error('kit/art/skin/' + slot.id + '.json contains </script');
        extra.celebration = raw;
      }
      continue;
    }
    const f = await firstPicture(kit, 'skin', slot.id);
    if (!f) continue;
    const uri = dataUri(f, await kit.bytes(f));
    let decl;
    if (k === 'nine') { const [t, r, b, l] = slot.slice; decl = 'border-image-source:url(' + uri + ');border-image-slice:' + t + ' ' + r + ' ' + b + ' ' + l + ' fill;border-image-width:' + [t, r, b, l].map(unit).join(' ') + ';border-image-repeat:stretch;'; }
    else decl = SKIN_DECL[k](uri);
    rules.push(slot.selector + '{' + (slot.css || '') + decl + '}' + (slot.extra || ''));
  }
  const celebration = extra.celebration || null; delete extra.celebration;
  return { css: rules.join('\n'), art: Object.keys(extra).length ? extra : null, celebration,
    lottie: celebration ? pyText(await kit.text('vendor/lottie_light_canvas.min.js')) : '' };
}

// the art team's text styles (kit/art/text.json; the styles are in kit/core/text.json): the fonts they use and the
// style variables kit.css reads, '' when nothing is set (the same text as the factory's Python build)
export async function loadText(kit) {
  if (!(await kit.list('art')).includes('text.json')) return '';
  const spec = JSON.parse(await kit.text('core/text.json')), art = JSON.parse(await kit.text('art/text.json'));
  const fontFiles = await kit.list('art/fonts'), fonts = [], decl = [];
  for (const st of spec.styles) {
    const v = art[st.id], i = st.id;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.color) decl.push('--t-' + i + '-c:' + v.color + ';');
    if (v.outline) decl.push('--t-' + i + '-o:' + v.outline + ';');
    if ('outlineWidth' in v) decl.push('--t-' + i + '-ow:calc(var(--u)*' + num(Number(v.outlineWidth)) + ');');
    if (v.font) {
      if (!fontFiles.includes(v.font + '.woff2')) throw new Error('kit/art/text.json: the font "' + v.font + '" (style ' + i + ') is not in kit/art/fonts/');
      if (!fonts.includes(v.font)) fonts.push(v.font);
      decl.push("--t-" + i + "-f:'DKF-" + v.font + "',var(--dk-font);");
    }
    if ('size' in v) decl.push('--t-' + i + '-s:' + num(Number(v.size) / 100) + ';');
    if ('weight' in v) decl.push('--t-' + i + '-w:' + Math.trunc(Number(v.weight)) + ';');
  }
  let css = '';
  for (const n of fonts.slice().sort()) css += "@font-face{font-family:'DKF-" + n + "';src:url(" + dataUri(n + '.woff2', await kit.bytes('art/fonts/' + n + '.woff2')) + ") format('woff2');font-weight:100 900;font-display:block}\n";
  return css + (decl.length ? ':root{' + decl.join('') + '}' : '');
}

export async function splashBackground(kit) {
  let bg = null;
  if ((await kit.list('art/splash')).includes('splash.json')) bg = JSON.parse(await kit.text('art/splash/splash.json')).background;
  return typeof bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : '#0a1233';
}

export async function buildPage(kit, cfg, { levels = null, gameCss = '', gameHtml = '', gameScripts = [], texts = null, levelsTr = null } = {}) {
  checkPublic(cfg);
  cfg = JSON.parse(JSON.stringify(cfg));
  if (!cfg.modules) cfg.modules = {};
  const mods = cfg.modules;
  for (const m of ORDER) if (ALWAYS.has(m)) mods[m] = true;
  const eco = Object.assign({}, DEFAULT_ECONOMY, cfg.economy || {}); cfg.economy = eco;
  const art = await loadArt(kit);
  const theme = Object.assign({}, art.theme, cfg.theme || {}); delete art.theme; cfg.theme = theme;
  const fontName = JSON.parse(await kit.text('art/manifest.json')).fonts.file, font = (await first(kit, 'fonts', fontName, '.woff2')) || (await first(kit, 'fonts', 'font'));   // the kit's font: the manifest names it (its .woff2, never the license .txt next to it)
  const splash = (await first(kit, 'splash', 'duste-splash')) || (await first(kit, 'splash', 'splash'));
  const fontB64 = base64(await kit.bytes(font)), splashUri = dataUri(splash, await kit.bytes(splash)), splashBg = await splashBackground(kit);
  const css = pyText(await kit.text('core/kit.css')).replaceAll('/*FONT*/', () => fontB64)
    .replaceAll('/*STUDIO_SPLASH*/', () => splashUri).replaceAll('/*SPLASH_BG*/', () => splashBg);
  const skin = await loadSkin(kit);
  let cssAll = css;
  if (skin.css) cssAll += '\n' + skin.css;
  const textCss = await loadText(kit);
  if (textCss) cssAll += '\n' + textCss;
  if (skin.art) art.skin = skin.art;
  let js = (skin.lottie ? skin.lottie + '\n' : '') + pyText(await kit.text('core/kit.js'));
  for (const m of ORDER) if (mods[m]) js += pyText(await kit.text('modules/' + m + '.js'));
  for (const [, code] of gameScripts) if (code.toLowerCase().includes('</script')) throw new Error('a game script contains </script');
  let pre = 'window.DK_ART = ' + pyJson(art) + ';\n';
  if (skin.celebration) pre += 'window.DK_CELEBRATION = ' + skin.celebration + ';\n';
  if (levels !== null) pre += 'window.DK_LEVELS = ' + pyJson(levels) + ';\n';
  if ((cfg.languages || []).includes('tr')) {   // a game in Turkish too: the kit's Turkish, then the game's own (tr.json)
    const tr = Object.assign(JSON.parse(await kit.text('core/lang/tr.json')), texts || {});
    pre += 'window.DK_TEXTS = ' + pyJson({ tr }) + ';\n';
    if (levelsTr !== null) pre += 'window.DK_LEVELS_TR = ' + pyJson(levelsTr) + ';\n';   // its own Turkish levels (levels.tr.json)
  }
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n' +
    '<meta name="theme-color" content="' + (theme.bg2 || '#2c2560') + '">\n<title>' + cfg.title + '</title>\n<style>\n' + cssAll + '\n' + gameCss + '\n</style>\n</head>\n<body>\n' +
    '<div id="dk-frame"><div id="dk-game" class="dk-layer">' + gameHtml + '</div><div id="dk-screens" class="dk-layer"></div>' +
    '<div id="dk-pops" class="dk-layer" style="pointer-events:none"></div><div id="dk-toast" class="dk-hidden"></div></div>\n' +
    '<script>\n' + pre + '</script>\n<script>\n' + js + '\n</script>\n' +
    gameScripts.map(([id, code]) => '<script id="' + id + '">\n' + code + '\n</script>').join('\n') +
    '\n<script>\nDK.boot(' + pyJson(cfg) + ');\n</script>\n</body>\n</html>\n';
}

// A game with fewer than 100 levels is played as 100: the same copies, in the same order, as kit/build/build_game.py
// fill_levels (seeded by the game's id; each copy has the difficulty the pattern asks for, no tutorial, "repeatOf").
const FILL_TO = 100;
const tagFor = n => n <= 10 ? 'normal' : n % 10 === 4 ? 'hard' : n % 10 === 9 ? 'superhard' : 'normal';
export function fillLevels(gameId, levels) {
  if (levels.length >= FILL_TO || levels.length <= 10) return levels;
  let x = 2166136261;
  for (const b of new TextEncoder().encode(gameId)) x = Math.imul(x ^ b, 16777619) >>> 0;
  x = x || 1;
  const rand = () => { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; return x; };
  const pools = {};
  for (let n = 11; n <= levels.length; n++) (pools[levels[n - 1].difficulty || 'normal'] ||= []).push(n);
  const bags = {}, last = {}, out = levels.slice();
  for (let n = levels.length + 1; n <= FILL_TO; n++) {
    const want = (pools[tagFor(n)] || []).length ? tagFor(n) : (pools.normal || []).length ? 'normal' : Object.keys(pools)[0];
    if (!(bags[want] || []).length) {
      const bag = pools[want].slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1) / 4294967296); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      if (bag.length > 1 && bag[bag.length - 1] === last[want]) [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      bags[want] = bag;
    }
    const k = bags[want].pop(); last[want] = k;
    out.push({ ...levels[k - 1], tutorial: [], repeatOf: k });
  }
  return out;
}

// a tutorial card's "image" (a file next to levels.json) goes into the page as a data: URI (as build_game.py inline_images)
const CARD_IMAGE = /^[A-Za-z0-9_-]+\.(png|webp)$/;
async function inlineImages(game, files, levels) {
  for (const lv of levels) for (const c of lv.tutorial || []) {
    if (c && typeof c === 'object' && typeof c.image === 'string' && CARD_IMAGE.test(c.image) && files.includes(c.image)) c.image = dataUri(c.image, await game.bytes(c.image));
  }
  return levels;
}

// ---------- the game's picture files: .png/.webp in subfolders (kit/build/build_game.py game_files) ----------
// The build puts them next to the page (files/<path>); this site's player has no files next to its page, so it hands them
// to the game as window.DK_FILES (path -> data: URI; kit.js DK.file).
export async function gameFiles(game) {
  const out = [];
  const walk = async (dir, top) => {
    for (const n of (await game.list(dir)).sort()) {
      if (top && (n === 'dist' || n === 'node_modules' || n === 'tools')) continue;
      if (n.startsWith('.')) continue;
      const p = dir ? dir + '/' + n : n;
      if (/\.(png|webp)$/i.test(n)) { if (!top) out.push(p); }
      else { let sub = []; try { sub = await game.list(p); } catch (e) {} if (sub.length) await walk(p, false); }   // (a folder: its pictures too)
    }
  };
  await walk('', true);
  return out.sort();
}
export async function filesScript(game, paths) {
  const m = {};
  for (const p of paths) m[p] = 'data:' + (MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream') + ';base64,' + base64(await game.bytes(p));
  return '<script>window.DK_FILES=' + JSON.stringify(m).replace(/</g, '\\u003c') + ';<\/script>\n';
}

// ---------- build settings (the Builds page; the release build's "settings"): they win over game.json ----------
// The same as kit/build/build_game.py settings_errors() and apply_settings(). Each one is optional:
// { flow: X (2-15; 0 off), startCoins, playOnCost, refillCost, rewards: { normal, hard, superhard }, boosterStart, boosterPrice,
//   milestones: [{ level: 10, coins, boosters }, ... 20, 30, 40, 50] }
export const MILESTONE_LEVELS = [10, 20, 30, 40, 50];
// the kit's defaults when nothing is set (kit/modules/boosters.js, kit/modules/milestones.js)
export const DEFAULT_BOOSTER = { start: 4, bundle: 3, price: 500 };
export const DEFAULT_MILESTONES = [{ level: 10, coins: 500, boosters: 1 }, { level: 20, coins: 1000, boosters: 2 }, { level: 30, coins: 2000, boosters: 3 }, { level: 40, coins: 3000, boosters: 4 }, { level: 50, coins: 5000, boosters: 5 }];
// what a game plays with today, as build settings: game.json over the kit's defaults (the non-stop flow off)
export function settingsOf(cfg) {
  const eco = Object.assign({}, DEFAULT_ECONOMY, cfg.economy || {}), b = Object.assign({}, DEFAULT_BOOSTER, (cfg.boosters || [])[0] || {});
  const r = Object.assign({}, DEFAULT_ECONOMY.rewards, eco.rewards || {});
  return { flow: cfg.flow && cfg.flow.upTo || 0, startCoins: eco.startCoins, playOnCost: eco.playOnCost, refillCost: eco.refillCost, rewards: { normal: r.normal, hard: r.hard, superhard: r.superhard },
    boosterStart: b.start, boosterPrice: b.price, milestones: (Array.isArray(cfg.milestones) && cfg.milestones.length === 5 ? cfg.milestones : DEFAULT_MILESTONES).map(x => ({ level: x.level, coins: x.coins, boosters: x.boosters })) };
}
export function settingsErrors(st) {
  if (!st || typeof st !== 'object' || Array.isArray(st)) return ['the settings must be a JSON object'];
  const errs = [], whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi, has = k => Object.prototype.hasOwnProperty.call(st, k);
  const known = ['flow', 'startCoins', 'playOnCost', 'refillCost', 'rewards', 'boosterStart', 'boosterPrice', 'milestones'];
  for (const k of Object.keys(st)) if (!known.includes(k)) errs.push('unknown setting "' + k + '"');
  if (has('flow') && !(whole(st.flow, 0, 15) && st.flow !== 1)) errs.push('flow: 0 (off) or a level from 2 to 15');
  for (const k of ['startCoins', 'playOnCost', 'refillCost', 'boosterPrice']) if (has(k) && !whole(st[k], 0, 1000000)) errs.push(k + ': a whole number from 0 to 1000000');
  if (has('boosterStart') && !whole(st.boosterStart, 0, 99)) errs.push('boosterStart: a whole number from 0 to 99');
  if (has('rewards')) {
    const r = st.rewards;
    if (!(r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).sort().join() === 'hard,normal,superhard' && Object.values(r).every(v => whole(v, 0, 1000000))))
      errs.push('rewards: { "normal", "hard", "superhard" }, whole numbers from 0 to 1000000');
  }
  if (has('milestones')) {
    const m = st.milestones;
    if (!(Array.isArray(m) && m.map(x => x && typeof x === 'object' ? x.level : null).join() === MILESTONE_LEVELS.join()
      && m.every(x => Object.keys(x).sort().join() === 'boosters,coins,level' && whole(x.coins, 0, 1000000) && whole(x.boosters, 0, 99))))
      errs.push('milestones: levels 10, 20, 30, 40, 50, each { "level", "coins" (0-1000000), "boosters" (0-99) }');
  }
  return errs;
}
export function applySettings(cfg, st) {
  const has = k => Object.prototype.hasOwnProperty.call(st, k);
  if (has('flow')) { if (st.flow) cfg.flow = { upTo: st.flow }; else delete cfg.flow; }
  const eco = Object.assign({}, cfg.economy || {});
  for (const k of ['startCoins', 'playOnCost', 'refillCost']) if (has(k)) eco[k] = st[k];
  if (has('rewards')) eco.rewards = { normal: st.rewards.normal, hard: st.rewards.hard, superhard: st.rewards.superhard };
  if (Object.keys(eco).length) cfg.economy = eco;
  if (Array.isArray(cfg.boosters) && cfg.boosters.length) {
    cfg.boosters = cfg.boosters.map(b => { const c = Object.assign({}, b); if (has('boosterStart')) c.start = st.boosterStart; if (has('boosterPrice')) c.price = st.boosterPrice; return c; });
  }
  if (has('milestones')) cfg.milestones = st.milestones.map(x => ({ level: x.level, coins: x.coins, boosters: x.boosters }));
  return cfg;
}

// game: a reader rooted at the game's folder (games/<id>/ or templates/starter/)
export async function buildGame(kit, game, { links = null, bots = true, settings = null } = {}) {
  const files = await game.list('');
  const cfg = JSON.parse(await game.text('game.json'));
  const lv = JSON.parse(await game.text('levels.json'));
  const submitted = Array.isArray(lv) ? lv : lv.levels;
  const gameJs = pyText(await game.text('game.js'));
  let gameCss = files.includes('game.css') ? pyText(await game.text('game.css')) : '';
  // the game's own home screen background (optional: home-bg.webp or home-bg.png in its folder), over the art team's
  const homeBg = ['home-bg.webp', 'home-bg.png'].find(f => files.includes(f));
  if (homeBg) gameCss = (gameCss ? gameCss + '\n' : '') + '#dk-home{background:url(' + dataUri(homeBg, await game.bytes(homeBg)) + ') center/cover no-repeat;}';
  const botJs = bots && files.includes('bot.js') ? pyText(await game.text('bot.js')) : null;
  cfg.links = links || { support: '', terms: '', privacy: '' };
  if (!('analytics' in cfg)) { const a = []; for (let n = 10; n <= submitted.length; n += 10) a.push(n); cfg.analytics = { levelAchieved: a }; }
  if (settings != null) { const errs = settingsErrors(settings); if (errs.length) throw new Error('build settings: ' + errs.join('; ')); applySettings(cfg, settings); }
  const levels = fillLevels(cfg.id, await inlineImages(game, files, submitted));
  let texts = null, levelsTr = null;
  if ((cfg.languages || []).includes('tr')) {
    texts = files.includes('tr.json') ? JSON.parse(await game.text('tr.json')) : {};
    if (files.includes('levels.tr.json')) { const lt = JSON.parse(await game.text('levels.tr.json')); levelsTr = fillLevels(cfg.id, await inlineImages(game, files, Array.isArray(lt) ? lt : lt.levels)); }
  }
  const wrap = code => '(function () {\n' + code + '\n})();';
  const scripts = [['dk-game', wrap(gameJs)]];
  if (botJs !== null) scripts.push(['dk-bot', 'window.DK_TESTING = true;\n' + wrap(botJs)]);
  const page = await buildPage(kit, cfg, { levels, gameCss, gameScripts: scripts, texts, levelsTr });
  const paths = await gameFiles(game);   // (the picture files: for this site's player only, never in the page)
  return { cfg, levels, page, files: paths.length ? await filesScript(game, paths) : '' };
}
