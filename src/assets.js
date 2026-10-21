import { existsSync, writeFileSync, readFileSync, statSync as fsStatSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import emojiData from 'unicode-emoji-json' with { type: 'json' };
import { ROOT, log, warn, ensureDir, loadJSON, saveJSON, fileExists } from './util.js';
import { searchFreesound, downloadSound, scoreCandidates, findAndDownloadSound } from './freesound.js';
import { askClaude, pickSounds } from './claude.js';

const ICONS_DIR = join(ROOT, 'assets/icons');
const INDEX_PATH = join(ROOT, 'assets/icons/index.json');
const LICENSES_PATH = 'assets/LICENSES.json';
const FLUENT_OWNER = 'microsoft';
const FLUENT_REPO = 'fluentui-emoji';
const SFX_DIR = 'assets/sfx';
const MUSIC_DIR = 'assets/music';

function loadLicenses() {
  if (!fileExists(LICENSES_PATH)) return [];
  try { return loadJSON(LICENSES_PATH); } catch { return []; }
}

function addLicenseEntry(file, url, author, license) {
  const entries = loadLicenses();
  if (entries.find(e => e.file === file)) return;
  entries.push({ file, source: 'fluent-emoji', url, author, license: 'MIT', fetchedAt: new Date().toISOString() });
  saveJSON(LICENSES_PATH, entries);
}

function emojiToCodepoints(emoji) {
  const cps = [];
  for (const cp of emoji) {
    const hex = cp.codePointAt(0).toString(16).toLowerCase();
    if (hex !== 'fe0f') cps.push(hex);
  }
  return cps.join('_');
}

function emojiToName(emoji) {
  const entry = emojiData[emoji];
  if (entry) return entry.name;
  const plain = emoji.replace(/️/g, '');
  const entry2 = emojiData[plain];
  return entry2?.name || null;
}

function nameToFolder(name) {
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export async function buildIconIndex() {
  if (existsSync(INDEX_PATH)) {
    const age = Date.now() - fsStatSync(INDEX_PATH).mtimeMs;
    if (age < 7 * 24 * 60 * 60 * 1000) {
      log('Icon index is fresh, skipping rebuild');
      return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    }
  }

  log('Building Fluent Emoji icon index from GitHub API...');
  const url = `https://api.github.com/repos/${FLUENT_OWNER}/${FLUENT_REPO}/git/trees/main?recursive=1`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
  });

  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
  const data = await res.json();

  const index = {};
  const pngPaths = data.tree
    .filter(t => t.path.match(/\/3D\/.*\.png$/i))
    .filter(t => t.path.includes('/Default/'));

  for (const entry of pngPaths) {
    const parts = entry.path.split('/');
    const assetFolder = parts[1];
    index[assetFolder] = entry.path;
  }

  for (const entry of data.tree) {
    if (!entry.path.match(/\/3D\/.*\.png$/i)) continue;
    if (entry.path.includes('/Default/')) continue;
    const parts = entry.path.split('/');
    const assetFolder = parts[1];
    if (!index[assetFolder]) {
      index[assetFolder] = entry.path;
    }
  }

  ensureDir('assets/icons');
  const fmtIndex = {};
  for (const [folder, path] of Object.entries(index)) {
    fmtIndex[folder.toLowerCase()] = path;
  }

  saveJSON('assets/icons/index.json', fmtIndex);
  log(`Icon index built: ${Object.keys(fmtIndex).length} entries`);
  return fmtIndex;
}

export async function resolveIcon(emoji, index) {
  const cp = emojiToCodepoints(emoji);
  const localPath = join(ICONS_DIR, `${cp}.png`);

  if (existsSync(localPath)) return localPath;

  const name = emojiToName(emoji);
  if (!name) {
    log(`No CLDR name for ${emoji}, using emoji font fallback`);
    return renderEmojiWithFont(emoji, cp);
  }

  const folderName = nameToFolder(name);
  const lowerName = folderName.toLowerCase();

  let ghPath = index?.[lowerName];
  if (!ghPath) {
    const snake = name.replace(/\s+/g, '_').toLowerCase();
    ghPath = index?.[snake];
  }
  if (!ghPath) {
    const kebab = name.replace(/\s+/g, '-').toLowerCase();
    ghPath = index?.[kebab];
  }
  if (!ghPath) {
    for (const [k, v] of Object.entries(index || {})) {
      if (k.includes(name.split(' ')[0].toLowerCase())) {
        ghPath = v;
        break;
      }
    }
  }

  if (!ghPath) {
    log(`No Fluent Emoji for "${name}" (${emoji}), using font fallback`);
    return renderEmojiWithFont(emoji, cp);
  }

  const url = `https://raw.githubusercontent.com/${FLUENT_OWNER}/${FLUENT_REPO}/main/${ghPath}`;
  log(`Downloading icon: ${name} → ${cp}.png`);

  const res = await fetch(url);
  if (!res.ok) {
    warn(`Failed to download icon ${url}: ${res.status}`);
    return renderEmojiWithFont(emoji, cp);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir('assets/icons');
  writeFileSync(localPath, buf);

  addLicenseEntry(
    `assets/icons/${cp}.png`,
    `https://github.com/${FLUENT_OWNER}/${FLUENT_REPO}`,
    'Microsoft',
    'MIT'
  );

  return localPath;
}

function renderEmojiWithFont(emoji, cp) {
  const outPath = join(ICONS_DIR, `${cp}.png`);
  if (existsSync(outPath)) return outPath;

  ensureDir('assets/icons');
  try {
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
        font-family="'Noto Color Emoji', 'Apple Color Emoji', sans-serif"
        font-size="100">${emoji}</text>
</svg>`;
    const tmpSvg = join(ICONS_DIR, `${cp}_tmp.svg`);
    writeFileSync(tmpSvg, svgContent);

    execSync(`convert -background none -size 128x128 ${tmpSvg} ${outPath}`, {
      stdio: 'pipe', timeout: 10_000,
    });
    try { unlinkSync(tmpSvg); } catch {}
  } catch {
    const canvas = `convert -size 128x128 xc:transparent -font "Noto-Color-Emoji" -pointsize 96 -gravity center -annotate 0 "${emoji}" ${outPath}`;
    try {
      execSync(canvas, { stdio: 'pipe', timeout: 10_000 });
    } catch {
      log(`Font fallback failed for ${emoji}, creating placeholder`);
      execSync(`convert -size 128x128 xc:"#cccccc" -gravity center -pointsize 40 -annotate 0 "?" ${outPath}`, {
        stdio: 'pipe', timeout: 10_000,
      });
    }
  }
  return outPath;
}

export async function resolveAllIcons(spec, index) {
  const icons = {};
  for (const tier of spec.tiers) {
    icons[tier.icon] = await resolveIcon(tier.icon, index);
    if (tier.accessory) {
      icons[tier.accessory] = await resolveIcon(tier.accessory, index);
    }
  }
  return icons;
}

export async function resolveAllSounds(spec, config = {}) {
  const sounds = {};
  const allQueries = [];

  if (spec.sounds.bounce) {
    allQueries.push({ key: 'bounce', query: spec.sounds.bounce.query, style: spec.sounds.bounce.style || 'pop', type: 'bounce' });
  }

  for (const [i, ms] of spec.sounds.merge.entries()) {
    allQueries.push({ key: `merge_${i}`, query: ms.query, style: ms.style, type: 'merge' });
  }
  allQueries.push({ key: 'final', query: spec.sounds.final.query, style: spec.sounds.final.style, type: 'final' });

  let claudePicks = null;
  try {
    const candidates = {};
    for (const q of allQueries) {
      const minD = q.type === 'bounce' ? 0.05 : q.type === 'merge' ? 0.1 : 0.5;
      const maxD = q.type === 'bounce' ? 0.8 : q.type === 'merge' ? 2 : 5;
      const results = await searchFreesound(q.query, {
        minDuration: minD,
        maxDuration: maxD,
        allowAttribution: config.allowAttribution,
      });
      candidates[q.key] = results.slice(0, 8).map(r => ({
        id: r.id, name: r.name, tags: (r.tags || []).slice(0, 10),
        description: (r.description || '').slice(0, 200),
        duration: r.duration, rating: r.avg_rating, downloads: r.num_downloads,
      }));
    }

    const pickPromptPath = join(ROOT, 'prompts/pick-sounds.md');
    const pickPrompt = readFileSync(pickPromptPath, 'utf8');
    const pickMsg = `Here are the sound candidates for each slot. For each, pick the best one whose name, tags and description clearly match the item and style. Prefer sounds that are a little funny but make sense. Return a JSON object mapping each key to the chosen candidate's "id", or null if none fit.\n\nSpec title: ${spec.title}\nTiers: ${spec.tiers.map(t => t.name).join(' → ')}\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}`;

    const picks = await pickSounds(pickPrompt, pickMsg);
    claudePicks = picks;
    log('Claude picked sounds:', JSON.stringify(picks));
  } catch (e) {
    warn('Claude sound picking unavailable, using rating-based selection:', e.message);
  }

  for (const q of allQueries) {
    const maxLen = q.type === 'bounce' ? 0.3 : q.type === 'merge' ? 1.2 : 3;
    const minD = q.type === 'bounce' ? 0.05 : q.type === 'merge' ? 0.1 : 0.5;
    const maxD = q.type === 'bounce' ? 0.8 : q.type === 'merge' ? 2 : 5;
    const fallbackQuery = `cartoon ${q.style} short`;

    try {
      let pickedSound = null;
      if (claudePicks && claudePicks[q.key]) {
        const results = await searchFreesound(q.query, { minDuration: minD, maxDuration: maxD, allowAttribution: config.allowAttribution });
        pickedSound = results.find(r => r.id === claudePicks[q.key]);
      }

      const path = await findAndDownloadSound(q.query, SFX_DIR, {
        maxLength: maxLen,
        minDuration: minD,
        maxDuration: maxD,
        fallbackQuery,
        claudePick: pickedSound,
        allowAttribution: config.allowAttribution,
      });
      sounds[q.key] = path;
    } catch (e) {
      warn(`Could not find sound for "${q.query}": ${e.message}`);
      const generic = findGenericSound(q.style, q.type);
      if (generic) {
        sounds[q.key] = generic;
      } else {
        warn(`No generic fallback for ${q.key}, will be silent`);
        sounds[q.key] = null;
      }
    }
  }

  return sounds;
}

function findGenericSound(style, type) {
  const dir = join(ROOT, SFX_DIR);
  const index = fileExists(SFX_DIR + '/index.json') ? loadJSON(SFX_DIR + '/index.json') : {};
  const styleMap = {
    pop: 'cartoon pop', boing: 'cartoon boing', squeak: 'cartoon squeak',
    voice: 'cartoon voice', impact: 'cartoon impact', magic: 'magic chime',
    cartoon: 'cartoon sound effect', fanfare: 'tada fanfare',
  };
  const fallbackKey = styleMap[style] || 'cartoon pop';
  const entry = index[fallbackKey];
  if (entry && existsSync(join(dir, `${entry.id}.mp3`))) {
    return join(dir, `${entry.id}.mp3`);
  }
  return null;
}

export async function resolveMusicTrack(mood, recentTracks = []) {
  const index = fileExists(MUSIC_DIR + '/index.json') ? loadJSON(MUSIC_DIR + '/index.json') : {};
  const moodTracks = Object.entries(index)
    .filter(([k]) => k.startsWith(mood))
    .map(([k, v]) => ({ key: k, ...v }));

  if (moodTracks.length === 0) {
    warn(`No music tracks for mood "${mood}"`);
    return null;
  }

  const available = moodTracks.filter(t => !recentTracks.includes(t.id));
  const pick = available.length > 0 ? available[0] : moodTracks[0];
  const path = join(ROOT, MUSIC_DIR, `${pick.id}.mp3`);

  if (!existsSync(path)) {
    warn(`Music file missing: ${path}`);
    return null;
  }

  return { path, id: pick.id, name: pick.name };
}
