import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT, log, warn, ensureDir, loadJSON, saveJSON, fileExists } from './util.js';

const API_BASE = 'https://freesound.org/apiv2';
const SFX_DIR = 'assets/sfx';
const MUSIC_DIR = 'assets/music';
const SFX_INDEX = 'assets/sfx/index.json';
const MUSIC_INDEX = 'assets/music/index.json';
const LICENSES_PATH = 'assets/LICENSES.json';
const BLOCKLIST_PATH = 'assets/blocklist.json';

function getKey() {
  const k = process.env.FREESOUND_API_KEY;
  if (!k) throw new Error('FREESOUND_API_KEY not set');
  return k;
}

function loadBlocklist() {
  if (!fileExists(BLOCKLIST_PATH)) return [];
  try { return loadJSON(BLOCKLIST_PATH); } catch { return []; }
}

function loadLicenses() {
  if (!fileExists(LICENSES_PATH)) return [];
  try { return loadJSON(LICENSES_PATH); } catch { return []; }
}

function saveLicenses(entries) {
  saveJSON(LICENSES_PATH, entries);
}

function addLicenseEntry(file, source, url, author, license) {
  const entries = loadLicenses();
  if (entries.find(e => e.file === file)) return;
  entries.push({ file, source: 'freesound', url, author, license, fetchedAt: new Date().toISOString() });
  saveLicenses(entries);
}

function loadIndex(path) {
  if (!fileExists(path)) return {};
  try { return loadJSON(path); } catch { return {}; }
}

function saveIndex(path, data) {
  saveJSON(path, data);
}

function normalizeQuery(q) {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function searchFreesound(query, opts = {}) {
  const key = getKey();
  const allowAttribution = opts.allowAttribution || false;
  let licenseFilter = 'license:"Creative Commons 0"';
  if (allowAttribution) {
    licenseFilter = '(license:"Creative Commons 0" OR license:"Attribution")';
  }

  const minDur = opts.minDuration || 0.1;
  const maxDur = opts.maxDuration || 10;
  const filter = `${licenseFilter} duration:[${minDur} TO ${maxDur}]`;
  const fields = 'id,name,tags,description,username,license,duration,avg_rating,num_ratings,num_downloads,previews,url';

  const params = new URLSearchParams({
    query,
    filter,
    fields,
    sort: 'rating_desc',
    page_size: '15',
    token: key,
  });

  const url = `${API_BASE}/search/text/?${params}`;
  log(`Freesound search: "${query}"`);

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url);
    if (res.status === 429) {
      const wait = (attempt + 1) * 15;
      warn(`Freesound rate limited (429), waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Freesound search error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const blocklist = loadBlocklist();
  const results = (data.results || []).filter(r => !blocklist.includes(r.id));

  return results;
}

export async function downloadSound(sound, destDir, opts = {}) {
  const key = getKey();
  const previewUrl = sound.previews?.['preview-hq-mp3'];
  if (!previewUrl) throw new Error(`No preview URL for sound ${sound.id}`);

  ensureDir(destDir);
  const rawPath = join(ROOT, destDir, `${sound.id}_raw.mp3`);
  const outPath = join(ROOT, destDir, `${sound.id}.mp3`);

  if (existsSync(outPath)) {
    log(`Sound ${sound.id} already cached`);
    return outPath;
  }

  const dlUrl = `${previewUrl}?token=${key}`;
  log(`Downloading sound ${sound.id}: ${sound.name}`);

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(dlUrl);
    if (res.status === 429) {
      const wait = (attempt + 1) * 10;
      warn(`Freesound download rate limited (429), waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Download failed ${res.status} for sound ${sound.id}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(rawPath, buffer);

  const maxLen = opts.maxLength || 3;
  processAudio(rawPath, outPath, maxLen);

  try { unlinkSync(rawPath); } catch {}

  addLicenseEntry(
    `${destDir}/${sound.id}.mp3`,
    'freesound',
    sound.url || `https://freesound.org/people/${sound.username}/sounds/${sound.id}/`,
    sound.username,
    sound.license || 'CC0'
  );

  return outPath;
}

function processAudio(inPath, outPath, maxLength) {
  const cmd = [
    'ffmpeg', '-y', '-i', inPath,
    '-af', [
      'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-40dB',
      'areverse',
      'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-40dB',
      'areverse',
      `afade=t=out:st=${Math.max(0, maxLength - 0.15)}:d=0.15`,
      'loudnorm=I=-16:TP=-1.5',
    ].join(','),
    '-t', String(maxLength),
    '-ar', '48000', '-ac', '2',
    outPath,
  ].join(' ');

  execSync(cmd, { stdio: 'pipe', timeout: 30_000 });
}

export function scoreCandidates(candidates) {
  return candidates
    .filter(c => c.avg_rating >= 2 && c.num_ratings >= 1)
    .sort((a, b) => {
      const sa = a.avg_rating * Math.log2(Math.max(2, a.num_downloads));
      const sb = b.avg_rating * Math.log2(Math.max(2, b.num_downloads));
      return sb - sa;
    });
}

export async function findAndDownloadSound(query, destDir, opts = {}) {
  const nq = normalizeQuery(query);
  const index = loadIndex(join(ROOT, destDir === SFX_DIR ? SFX_INDEX : MUSIC_INDEX));

  if (index[nq] && existsSync(join(ROOT, destDir, `${index[nq].id}.mp3`))) {
    log(`Cache hit for "${nq}"`);
    return join(ROOT, destDir, `${index[nq].id}.mp3`);
  }

  const results = await searchFreesound(query, opts);
  if (results.length === 0) {
    const fallbacks = opts.fallbackQueries || (opts.fallbackQuery ? [opts.fallbackQuery] : []);
    if (fallbacks.length > 0) {
      const [next, ...rest] = fallbacks;
      log(`No results for "${query}", trying fallback: "${next}"`);
      return findAndDownloadSound(next, destDir, { ...opts, fallbackQueries: rest, fallbackQuery: undefined });
    }
    throw new Error(`No sounds found for "${query}"`);
  }

  let chosen;
  if (opts.claudePick) {
    chosen = opts.claudePick;
  } else {
    const scored = scoreCandidates(results);
    chosen = scored[0] || results[0];
  }

  const path = await downloadSound(chosen, destDir, opts);

  const idxPath = destDir === SFX_DIR ? SFX_INDEX : MUSIC_INDEX;
  const idx = loadIndex(join(ROOT, idxPath));
  idx[nq] = { id: chosen.id, name: chosen.name, license: chosen.license };
  saveIndex(join(ROOT, idxPath), idx);

  return path;
}
