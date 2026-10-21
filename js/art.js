// Art: turns the art team's master files (any size) into game-ready files, in the browser, by the factory's rules
// (kit/art/manifest.json). Masters never leave this computer; only the small game files are proposed to GitHub.

export const SPLASH_W = 1080, SPLASH_H = 2340, APP_ICON = 1024;

async function bitmap(file) {
  try { return await createImageBitmap(file); }
  catch (e) { throw new Error(file.name + ': this browser cannot read the picture (use PNG, JPEG or WebP).'); }
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
// draw `img` into w x h: "cover" fills and cuts the edges, "contain" fits whole on transparent
function draw(img, w, h, mode) {
  const c = canvas(w, h), g = c.getContext('2d');
  const k = mode === 'cover' ? Math.max(w / img.width, h / img.height) : Math.min(w / img.width, h / img.height);
  const dw = img.width * k, dh = img.height * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c;
}
const toBlob = (c, type, q) => new Promise(res => c.toBlob(res, type, q));
// the smallest good file under maxBytes: WebP from high quality down; PNG when lossless is wanted or WebP is missing
async function encode(c, maxBytes, { lossless = false } = {}) {
  if (!lossless) {
    for (const q of [0.92, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32]) {
      const b = await toBlob(c, 'image/webp', q);
      if (!b || b.type !== 'image/webp') break;   // this browser cannot write WebP
      if (b.size <= maxBytes) return { blob: b, ext: 'webp', quality: q };
    }
  }
  const p = await toBlob(c, 'image/png');
  if (p.size <= maxBytes) return { blob: p, ext: 'png', quality: 1 };
  throw new Error('Could not make the picture small enough (' + Math.round(maxBytes / 1024) + ' KB). Simplify the artwork or use fewer colors.');
}
// the average color of the picture's outer edge: the color around the splash
function edgeColor(c) {
  const g = c.getContext('2d'), { width: w, height: h } = c, d = g.getImageData(0, 0, w, h).data;
  let r = 0, gg = 0, b = 0, n = 0;
  const add = (x, y) => { const i = (y * w + x) * 4; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; };
  for (let x = 0; x < w; x += 4) { add(x, 0); add(x, 1); add(x, h - 1); add(x, h - 2); }
  for (let y = 0; y < h; y += 4) { add(0, y); add(1, y); add(w - 1, y); add(w - 2, y); }
  const hx = v => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hx(r) + hx(gg) + hx(b);
}
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

export function checkSvg(text, maxBytes) {
  const bad = [];
  if (new TextEncoder().encode(text).length > maxBytes) bad.push('larger than ' + Math.round(maxBytes / 1000) + ' KB');
  if (/<script|javascript:|on\w+\s*=|<image|<foreignObject|xlink:href\s*=\s*["']http|href\s*=\s*["']http/i.test(text)) bad.push('contains scripts, event handlers or embedded/external images');
  if (!/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)"/.test(text)) bad.push('needs a viewBox');
  else { const m = /viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/.exec(text); if (m && Math.abs(+m[1] - +m[2]) > 0.01) bad.push('the viewBox must be square'); }
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) bad.push('is not an SVG file');
  return bad;
}

// One art file in, one game-ready file out: { path, bytes, preview (object URL), note, remove: [paths], extra }
export async function prepare(slot, file, M, current) {
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase();
  if (slot.kind === 'icon') {
    const others = current.filter(p => p.startsWith('icons/') && p.replace(/^icons\//, '').replace(/\.[^.]+$/, '') === slot.name);
    if (ext === 'svg') {
      const text = await file.text(), bad = checkSvg(text, M.icons.maxBytes);
      if (bad.length) throw new Error(name + ': ' + bad.join('; ') + '.');
      const bytes = new TextEncoder().encode(text.trim() + '\n');
      return { path: 'icons/' + slot.name + '.svg', bytes, preview: URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' })), note: 'SVG, ' + bytes.length + ' bytes', remove: others.filter(p => p !== 'icons/' + slot.name + '.svg') };
    }
    const img = await bitmap(file), s = M.icons.pictureSize || 256;
    const out = await encode(draw(img, s, s, 'contain'), M.icons.maxPictureBytes || 60000);
    const path = 'icons/' + slot.name + '.' + out.ext;
    return { path, bytes: await bytesOf(out.blob), preview: URL.createObjectURL(out.blob), note: img.width + ' x ' + img.height + ' → ' + s + ' x ' + s + ' ' + out.ext.toUpperCase() + ', ' + Math.round(out.blob.size / 1024) + ' KB', remove: others.filter(p => p !== path) };
  }
  if (slot.kind === 'splash') {
    const img = await bitmap(file), c = draw(img, SPLASH_W, SPLASH_H, 'cover');
    const out = await encode(c, M.splash.maxBytes);
    const path = 'splash/' + M.splash.file + '.' + out.ext;
    const others = current.filter(p => p.startsWith('splash/' + M.splash.file + '.') && p !== path);
    const ratio = img.width / img.height, want = SPLASH_W / SPLASH_H;
    return { path, bytes: await bytesOf(out.blob), preview: URL.createObjectURL(out.blob), remove: others, extra: { background: edgeColor(c) },
      note: img.width + ' x ' + img.height + ' → ' + SPLASH_W + ' x ' + SPLASH_H + ' ' + out.ext.toUpperCase() + ', ' + Math.round(out.blob.size / 1024) + ' KB' + (Math.abs(ratio - want) > 0.02 ? ' (the master is not 9:19.5: its ' + (ratio > want ? 'sides' : 'top and bottom') + ' were cut)' : '') };
  }
  if (slot.kind === 'appicon') {
    const img = await bitmap(file), c = draw(img, APP_ICON, APP_ICON, 'contain');
    const blob = await toBlob(c, 'image/png');
    return { path: 'app-icon-foreground.png', bytes: await bytesOf(blob), preview: URL.createObjectURL(blob), remove: [], note: img.width + ' x ' + img.height + ' → 1024 x 1024 PNG, ' + Math.round(blob.size / 1024) + ' KB' };
  }
  if (slot.kind === 'font') {
    if (ext !== 'woff2') throw new Error(name + ': the font must be a .woff2 file.');
    if (file.size > M.fonts.maxBytes) throw new Error(name + ': ' + Math.round(file.size / 1024) + ' KB (at most ' + Math.round(M.fonts.maxBytes / 1000) + ' KB). Ask for a Latin-only subset.');
    return { path: 'fonts/' + M.fonts.file + '.woff2', bytes: new Uint8Array(await file.arrayBuffer()), remove: [], note: 'woff2, ' + Math.round(file.size / 1024) + ' KB' };
  }
  if (slot.kind === 'fontAdd') {   // another font for the text styles (or its license as a .txt): fonts/<name>.woff2
    const stem = name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!stem) throw new Error(name + ': name the file with letters or digits (for example Baloo2-Bold.woff2).');
    if (ext === 'txt') {
      if (file.size > 60000) throw new Error(name + ': a license text of at most 60 KB.');
      return { path: 'fonts/' + stem + '.txt', bytes: new Uint8Array(await file.arrayBuffer()), remove: [], note: 'license, ' + Math.round(file.size / 1024) + ' KB' };
    }
    if (ext !== 'woff2') throw new Error(name + ': the font must be a .woff2 file (ask for a woff2, Latin-only subset; or convert it with a webfont tool).');
    if (stem === M.fonts.file) throw new Error(name + ': this is the kit\'s own font: use Replace on it instead.');
    if (file.size > M.fonts.maxBytes) throw new Error(name + ': ' + Math.round(file.size / 1024) + ' KB (at most ' + Math.round(M.fonts.maxBytes / 1000) + ' KB). Ask for a Latin-only subset.');
    return { path: 'fonts/' + stem + '.woff2', bytes: new Uint8Array(await file.arrayBuffer()), remove: [], note: 'woff2, ' + Math.round(file.size / 1024) + ' KB', name: stem };
  }
  if (slot.kind === 'sound' || slot.kind === 'music') {
    const rule = slot.kind === 'sound' ? M.sounds : M.music, base = slot.kind === 'sound' ? slot.name : M.music.file;
    if (!rule.formats.includes(ext)) throw new Error(name + ': must be ' + rule.formats.join(' or ') + '.');
    if (file.size > rule.maxBytes) throw new Error(name + ': ' + Math.round(file.size / 1024) + ' KB (at most ' + Math.round(rule.maxBytes / 1000) + ' KB). Export it shorter or at a lower bitrate.');
    const path = rule.folder + '/' + base + '.' + ext;
    const others = current.filter(p => p.startsWith(rule.folder + '/' + base + '.') && p !== path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { path, bytes, preview: URL.createObjectURL(new Blob([bytes], { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/ogg' })), remove: others, note: ext.toUpperCase() + ', ' + Math.round(file.size / 1024) + ' KB' };
  }
  if (slot.kind === 'skin') return prepareSkin(slot.slot, slot.file || slot.slot.id, file, current);
  throw new Error('Unknown art slot.');
}

// The Lottie rules (the same as the factory's checker): returns the problems, [] when it is fine
export function checkLottie(text, slot) {
  let a; try { a = JSON.parse(text); } catch (e) { return ['not valid JSON']; }
  if (!a || !a.v || !a.fr || a.op == null || a.ip == null || !Array.isArray(a.layers)) return ['not a Lottie animation (export it with Bodymovin or LottieFiles)'];
  const bad = [];
  if (a.w !== slot.size[0] || a.h !== slot.size[1]) bad.push('composition ' + a.w + ' x ' + a.h + ' (must be ' + slot.size.join(' x ') + ')');
  const secs = (a.op - a.ip) / a.fr; if (secs > slot.maxSeconds) bad.push(secs.toFixed(1) + ' seconds (at most ' + slot.maxSeconds + ')');
  for (const as of a.assets || []) if (as.p && !(as.e === 1 || String(as.p).startsWith('data:'))) bad.push('the picture "' + as.p + '" is not embedded (export with images included in the JSON)');
  let expr = 0; (function scan(o) { if (Array.isArray(o)) o.forEach(scan); else if (o && typeof o === 'object') for (const k in o) { if (k === 'x' && typeof o[k] === 'string') expr++; else scan(o[k]); } })(a);
  if (expr) bad.push(expr + ' expression(s): the game\'s player ignores expressions, so bake them into keyframes');
  if (/<\/script/i.test(text)) bad.push('contains </script');
  return bad;
}

// One skin slot (kit/core/skin.json): the master is scaled to the slot's exact size
async function prepareSkin(slot, base, file, current) {
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase(), [w, h] = slot.size;
  const others = p => current.filter(c => c.startsWith('skin/' + base + '.') && c !== p);
  if (slot.kind === 'lottie') {
    const text = await file.text(), bad = checkLottie(text, slot);
    if (file.size > slot.maxBytes) bad.push(Math.round(file.size / 1024) + ' KB (at most ' + Math.round(slot.maxBytes / 1000) + ' KB): fewer layers or smaller embedded pictures');
    if (bad.length) throw new Error(name + ': ' + bad.join('; ') + '.');
    const a = JSON.parse(text), path = 'skin/' + base + '.json';
    return { path, bytes: new TextEncoder().encode(text.trim() + '\n'), remove: others(path), note: 'Lottie, ' + ((a.op - a.ip) / a.fr).toFixed(1) + ' s, ' + Math.round(file.size / 1024) + ' KB' };
  }
  const img = await bitmap(file), ratio = img.width / img.height, want = w / h;
  const fit = slot.kind === 'cover' ? 'cover' : (slot.kind === 'contain' || slot.kind === 'pieces') ? 'contain' : null;
  if (!fit && Math.abs(ratio - want) / want > 0.02)
    throw new Error(name + ': ' + img.width + ' x ' + img.height + ' has other proportions than the slot (' + w + ' x ' + h + '). Draw it at ' + w + ' x ' + h + ' or a multiple (for example ' + (w * 2) + ' x ' + (h * 2) + '), so the corners keep their shape.');
  const c = fit ? draw(img, w, h, fit) : draw(img, w, h, 'cover');
  const out = await encode(c, slot.maxBytes);
  const path = 'skin/' + base + '.' + out.ext;
  return { path, bytes: await bytesOf(out.blob), preview: URL.createObjectURL(out.blob), remove: others(path),
    note: img.width + ' x ' + img.height + ' → ' + w + ' x ' + h + ' ' + out.ext.toUpperCase() + ', ' + Math.round(out.blob.size / 1024) + ' KB' };
}
