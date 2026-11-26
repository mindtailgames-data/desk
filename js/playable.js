// Desk's Playable tab: one game level as a playable ad, in the file a network expects. The game page is built by the
// same builder as the player (builder.js), then made a playable: the kit's playable mode (GameFactory
// kit/modules/playable.js) put in before the game starts, its settings (window.DK_PLAYABLE), a storage of its own in
// memory (nothing is kept between two showings of the ad), only the picture files the level uses, and a loading
// indicator. Everything is inside the one file: no request leaves it.
// Networks: AppLovin (a single .html; the ad injects MRAID itself, so no mraid.js is loaded; the store opens with
// mraid.open(url), written in plain text in the file as networks check for it).

export const NETWORKS = { applovin: { name: 'AppLovin', ext: 'html' } };
export const SIZES = [
  { id: '9x16', label: '9:16 (1080 × 1920)', aspect: [9, 16] },
  { id: '9x19.5', label: '9:19.5 (1080 × 2340)', aspect: [9, 19.5] },
  { id: '9x20', label: '9:20 (1080 × 2400)', aspect: [9, 20] }];

// a game's initials for the file name: its capitals (MeowDog! -> MD), else the first letter of each word (Glass Sort -> GS)
export function initialsOf(title) {
  const t = String(title || '').replace(/[^A-Za-z0-9 ]/g, ' ');
  const caps = (t.match(/[A-Z]/g) || []).join('');
  if (caps.length >= 2) return caps.slice(0, 4);
  return t.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 4) || 'GM';
}
export const defaultName = (initials, size, lang) => (initials || 'GM') + '_Playable_PureGP_' + size + '_' + String(lang || 'en').toUpperCase();
export const storeUrl = pkg => 'https://play.google.com/store/apps/details?id=' + pkg;

const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// a storage of the playable's own, in memory, starting with the game's level and language
function storageScript(seed) {
  return '<script>(function(){var m=' + safeJson(seed) + ',s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};' +
    'try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(e){}})();<\/script>\n';
}
// the loading indicator (networks ask for one): a ring, until the level stands
const LOADER = '<style>html:not(.pk-ready)::after{content:"";position:fixed;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
  'border:4px solid rgba(255,255,255,.25);border-top-color:#fff;animation:pk-spin .8s linear infinite;z-index:2147483647}@keyframes pk-spin{to{transform:rotate(360deg)}}</style>\n';

// playableHtml({ page, files: { path: dataUri } (only the ones the level uses), module: kit/modules/playable.js,
//   id, level, lang, settings: DK_PLAYABLE without level, network, title }) -> the file's text
export function playableHtml({ page, files, module, id, level, lang, settings, network, title }) {
  if (!NETWORKS[network]) throw new Error('Unknown network: ' + network);
  if (!page.includes('<head>\n') || !page.includes('<script>\nDK.boot(')) throw new Error('the game page is not the kit\'s');
  if (/<\/script/i.test(module)) throw new Error('the playable module must not contain </script');
  const cfg = Object.assign({}, settings, { level }), seed = { ['dk.' + id + '.progress']: JSON.stringify({ next: level }) };
  if (lang) seed['dk.' + id + '.lang'] = JSON.stringify(lang);
  const head = '<head>\n' + LOADER + storageScript(seed) + '<script>window.DK_PLAYABLE=' + safeJson(cfg) + ';<\/script>\n' +
    (files && Object.keys(files).length ? '<script>window.DK_FILES=' + safeJson(files) + ';<\/script>\n' : '');
  let html = page.replace('<head>\n', () => head);
  html = html.replace('<script>\nDK.boot(', () => '<script>\n' + module + '\n<\/script>\n<script>\nDK.boot(');
  if (title) html = html.replace(/<title>[^<]*<\/title>/, () => '<title>' + String(title).replace(/[<&]/g, '') + '</title>');
  return html;
}

// what a reviewer of the file looks for: its size, nothing loaded from outside, the store call
export function report(html, files) {
  const bytes = new TextEncoder().encode(html).length;
  const outside = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)].map(m => m[0]).filter(u => !/w3\.org/.test(u)).slice(0, 5);
  return { bytes, mb: bytes / 1048576, under5: bytes <= 5 * 1048576, outside, mraidOpen: html.includes('mraid.open('), files: Object.keys(files || {}).length };
}
