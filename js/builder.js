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
  let js = pyText(await kit.text('core/kit.js'));
  for (const m of ORDER) if (mods[m]) js += pyText(await kit.text('modules/' + m + '.js'));
  for (const [, code] of gameScripts) if (code.toLowerCase().includes('</script')) throw new Error('a game script contains </script');
  let pre = 'window.DK_ART = ' + pyJson(art) + ';\n';
  if (levels !== null) pre += 'window.DK_LEVELS = ' + pyJson(levels) + ';\n';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n' +
    '<meta name="theme-color" content="' + (theme.bg2 || '#2c2560') + '">\n<title>' + cfg.title + '</title>\n<style>\n' + css + '\n' + gameCss + '\n</style>\n</head>\n<body>\n' +
    '<div id="dk-frame"><div id="dk-game" class="dk-layer">' + gameHtml + '</div><div id="dk-screens" class="dk-layer"></div>' +
    '<div id="dk-pops" class="dk-layer" style="pointer-events:none"></div><div id="dk-toast" class="dk-hidden"></div></div>\n' +
    '<script>\n' + pre + '</script>\n<script>\n' + js + '\n</script>\n' +
    gameScripts.map(([id, code]) => '<script id="' + id + '">\n' + code + '\n</script>').join('\n') +
    '\n<script>\nDK.boot(' + pyJson(cfg) + ');\n</script>\n</body>\n</html>\n';
}

// game: a reader rooted at the game's folder (games/<id>/ or templates/starter/)
export async function buildGame(kit, game, { links = null, bots = true } = {}) {
  const files = await game.list('');
  const cfg = JSON.parse(await game.text('game.json'));
  const lv = JSON.parse(await game.text('levels.json'));
  const levels = Array.isArray(lv) ? lv : lv.levels;
  const gameJs = pyText(await game.text('game.js'));
  const gameCss = files.includes('game.css') ? pyText(await game.text('game.css')) : '';
  const botJs = bots && files.includes('bot.js') ? pyText(await game.text('bot.js')) : null;
  cfg.links = links || { supportEmail: '', terms: '', privacy: '' };
  if (!('analytics' in cfg)) { const a = []; for (let n = 10; n <= levels.length; n += 10) a.push(n); cfg.analytics = { levelAchieved: a }; }
  const wrap = code => '(function () {\n' + code + '\n})();';
  const scripts = [['dk-game', wrap(gameJs)]];
  if (botJs !== null) scripts.push(['dk-bot', 'window.DK_TESTING = true;\n' + wrap(botJs)]);
  return { cfg, levels, page: await buildPage(kit, cfg, { levels, gameCss, gameScripts: scripts }) };
}
