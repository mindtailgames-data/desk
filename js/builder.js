// The game builder, in the browser: the same page as the factory's own Python build makes.
// Works on any "reader" ({ text(path), bytes(path), list(dir) }), so the website reads the kit from the factory's main branch
// and the game from a submission branch, and a test reads both from disk. Nothing is sent anywhere.

const ORDER = ['economy', 'levels', 'audio', 'haptics', 'analytics', 'settings', 'flows', 'boosters', 'home', 'splash'];
const ALWAYS = new Set(['economy', 'levels', 'settings', 'flows', 'boosters', 'home', 'splash']);
const FORBIDDEN_KEYS = ['token', 'secret', 'password', 'keystore', 'apikey', 'api_key'];
const DEFAULT_ECONOMY = { startCoins: 2000, maxLives: 5, lifeMinutes: 30, playOnCost: 300, rewards: { normal: 25, hard: 50, superhard: 100 } };
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
async function first(kit, folder, name) {
  const files = (await kit.list('art/' + folder)).sort();
  const f = files.find(x => stem(x) === name);
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

export async function buildPage(kit, cfg, { levels = null, gameCss = '', gameHtml = '', gameScripts = [] } = {}) {
  checkPublic(cfg);
  cfg = JSON.parse(JSON.stringify(cfg));
  if (!cfg.modules) cfg.modules = {};
  const mods = cfg.modules;
  for (const m of ORDER) if (ALWAYS.has(m)) mods[m] = true;
  const eco = Object.assign({}, DEFAULT_ECONOMY, cfg.economy || {}); cfg.economy = eco;
  const art = await loadArt(kit);
  const theme = Object.assign({}, art.theme, cfg.theme || {}); delete art.theme; cfg.theme = theme;
  const font = (await first(kit, 'fonts', 'Fredoka-latin')) || (await first(kit, 'fonts', 'font'));
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

// game: a reader rooted at the game's folder (games/<id>/ or templates/starter/)
export async function buildGame(kit, game, { links = null, bots = true } = {}) {
  const files = await game.list('');
  const cfg = JSON.parse(await game.text('game.json'));
  const lv = JSON.parse(await game.text('levels.json'));
  const submitted = Array.isArray(lv) ? lv : lv.levels;
  const gameJs = pyText(await game.text('game.js'));
  const gameCss = files.includes('game.css') ? pyText(await game.text('game.css')) : '';
  const botJs = bots && files.includes('bot.js') ? pyText(await game.text('bot.js')) : null;
  cfg.links = links || { support: '', terms: '', privacy: '' };
  if (!('analytics' in cfg)) { const a = []; for (let n = 10; n <= submitted.length; n += 10) a.push(n); cfg.analytics = { levelAchieved: a }; }
  const levels = fillLevels(cfg.id, submitted);
  const wrap = code => '(function () {\n' + code + '\n})();';
  const scripts = [['dk-game', wrap(gameJs)]];
  if (botJs !== null) scripts.push(['dk-bot', 'window.DK_TESTING = true;\n' + wrap(botJs)]);
  return { cfg, levels, page: await buildPage(kit, cfg, { levels, gameCss, gameScripts: scripts }) };
}
