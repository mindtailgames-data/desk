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
  if (slot.kind === 'sound' || slot.kind === 'music') {
    const rule = slot.kind === 'sound' ? M.sounds : M.music, base = slot.kind === 'sound' ? slot.name : M.music.file;
    if (!rule.formats.includes(ext)) throw new Error(name + ': must be ' + rule.formats.join(' or ') + '.');
    if (file.size > rule.maxBytes) throw new Error(name + ': ' + Math.round(file.size / 1024) + ' KB (at most ' + Math.round(rule.maxBytes / 1000) + ' KB). Export it shorter or at a lower bitrate.');
    const path = rule.folder + '/' + base + '.' + ext;
    const others = current.filter(p => p.startsWith(rule.folder + '/' + base + '.') && p !== path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { path, bytes, preview: URL.createObjectURL(new Blob([bytes], { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/ogg' })), remove: others, note: ext.toUpperCase() + ', ' + Math.round(file.size / 1024) + ' KB' };
  }
  throw new Error('Unknown art slot.');
}
