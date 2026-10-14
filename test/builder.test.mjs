// node test/builder.test.mjs <GameFactory folder>: the browser builder must make exactly the page Python makes
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { buildGame } from '../js/builder.js';
const F = process.argv[2];
const reader = root => ({
  text: async p => fs.readFileSync(path.join(root, p), 'utf8'),
  bytes: async p => new Uint8Array(fs.readFileSync(path.join(root, p))),
  list: async d => { const q = path.join(root, d); return fs.existsSync(q) ? fs.readdirSync(q) : []; }
});
const game = path.join(F, 'templates', 'starter');
execFileSync('python3', [path.join(F, 'kit', 'build', 'build_game.py'), game], { stdio: 'pipe' });
let fails = 0;
for (const [bots, file] of [[true, 'dist/index.html'], [false, 'dist/app/index.html']]) {
  const { page } = await buildGame(reader(path.join(F, 'kit')), reader(game), { bots });
  const want = fs.readFileSync(path.join(game, file), 'utf8');
  if (page === want) console.log('✓ identical: ' + file + ' (' + page.length + ' chars)');
  else { fails++; let i = 0; while (page[i] === want[i]) i++; console.log('✗ differs: ' + file + ' at ' + i + '\n  js: ' + JSON.stringify(page.slice(i - 40, i + 80)) + '\n  py: ' + JSON.stringify(want.slice(i - 40, i + 80))); }
}
process.exit(fails ? 1 : 0);
