// node test/builder.test.mjs <factory folder>: the browser builder must make exactly the page Python makes
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { buildGame, settingsErrors } from '../js/builder.js';
import os from 'os';
const F = process.argv[2];
const reader = root => ({
  text: async p => fs.readFileSync(path.join(root, p), 'utf8'),
  bytes: async p => new Uint8Array(fs.readFileSync(path.join(root, p))),
  list: async d => { const q = path.join(root, d); return fs.existsSync(q) ? fs.readdirSync(q) : []; }
});
// the starter and every game in the factory (each built by Python first)
const G = path.join(F, 'games');
const gamesDirs = [path.join(F, 'templates', 'starter')].concat(fs.existsSync(G) ? fs.readdirSync(G).map(d => path.join(G, d)).filter(d => fs.existsSync(path.join(d, 'game.json'))) : []);
let fails = 0;
// the build settings (Desk's Builds page): every one set, and a few only
const FULL = { flow: 10, startCoins: 1234, playOnCost: 250, refillCost: 400, rewards: { normal: 30, hard: 60, superhard: 120 }, boosterStart: 2, boosterPrice: 450,
  milestones: [10, 20, 30, 40, 50].map((level, i) => ({ level, coins: 100 * (i + 1), boosters: i + 1 })) };
const SOME = { flow: 0, playOnCost: 200 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-settings-'));
const file = st => { const f = path.join(tmp, 's.json'); fs.writeFileSync(f, JSON.stringify(st)); return f; };
for (const game of gamesDirs) {
  for (const settings of [null, FULL, SOME]) {
    execFileSync('python3', [path.join(F, 'kit', 'build', 'build_game.py'), game].concat(settings ? ['--settings', file(settings)] : []), { stdio: 'pipe' });
    for (const [bots, file] of [[true, 'dist/index.html'], [false, 'dist/app/index.html']]) {
      const { page } = await buildGame(reader(path.join(F, 'kit')), reader(game), { bots, settings });
      const want = fs.readFileSync(path.join(game, file), 'utf8'), name = path.basename(game) + '/' + file + (settings ? ' with settings ' + (settings === FULL ? '(all)' : '(some)') : '');
      if (page === want) console.log('✓ identical: ' + name + ' (' + page.length + ' chars)');
      else { fails++; let i = 0; while (page[i] === want[i]) i++; console.log('✗ differs: ' + name + ' at ' + i + '\n  js: ' + JSON.stringify(page.slice(i - 40, i + 80)) + '\n  py: ' + JSON.stringify(want.slice(i - 40, i + 80))); }
    }
  }
  execFileSync('python3', [path.join(F, 'kit', 'build', 'build_game.py'), game], { stdio: 'pipe' });   // (the game's dist/ as it was: without settings)
}
// bad settings: both refuse them, with the same reasons
const BAD = [{ flow: 1 }, { flow: 16 }, { startCoins: -1 }, { startCoins: 1.5 }, { startCoins: '100' }, { boosterStart: 100 }, { rewards: { normal: 1, hard: 2 } },
  { milestones: [{ level: 10, coins: 1, boosters: 1 }] }, { color: 'red' }, [], { flow: true }];
for (const st of BAD) {
  const out = execFileSync('python3', ['-c', 'import sys,json; sys.path.insert(0, sys.argv[1]); import build_game as b; print(json.dumps(b.settings_errors(json.load(open(sys.argv[2])))))', path.join(F, 'kit', 'build'), file(st)]).toString().trim();
  const js = JSON.stringify(settingsErrors(st));
  if (out === js && JSON.parse(js).length) console.log('✓ refused by both: ' + JSON.stringify(st));
  else { fails++; console.log('✗ settings ' + JSON.stringify(st) + '\n  js: ' + js + '\n  py: ' + out); }
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
