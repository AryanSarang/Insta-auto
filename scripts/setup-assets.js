#!/usr/bin/env node
import 'dotenv/config';
import { join } from 'node:path';
import { ROOT, log, warn, ensureDir } from '../src/util.js';
import { buildIconIndex } from '../src/assets.js';
import { searchFreesound, downloadSound, scoreCandidates } from '../src/freesound.js';
import { askClaude } from '../src/claude.js';
import { readFileSync } from 'node:fs';

const SFX_QUERIES = [
  { query: 'cartoon pop short', style: 'pop', maxLen: 1.2 },
  { query: 'cartoon bloop short', style: 'pop', maxLen: 1.2 },
  { query: 'cartoon boing spring', style: 'boing', maxLen: 1.2 },
  { query: 'soft squeak short cartoon', style: 'squeak', maxLen: 1.2 },
  { query: 'cartoon click short', style: 'pop', maxLen: 1.0 },
  { query: 'bubble pop short', style: 'pop', maxLen: 1.0 },
  { query: 'whoosh short cartoon', style: 'impact', maxLen: 1.5 },
  { query: 'impact thud cartoon short', style: 'impact', maxLen: 1.5 },
  { query: 'magic sparkle chime short', style: 'magic', maxLen: 1.5 },
  { query: 'magic spell cast short', style: 'magic', maxLen: 1.5 },
  { query: 'coin drop metallic short', style: 'pop', maxLen: 1.0 },
  { query: 'water drop plop short', style: 'pop', maxLen: 1.0 },
  { query: 'glass clink short', style: 'pop', maxLen: 1.0 },
  { query: 'cartoon spring boing', style: 'boing', maxLen: 1.2 },
  { query: 'rubber squeak short', style: 'squeak', maxLen: 1.0 },
  { query: 'cork pop short', style: 'pop', maxLen: 1.0 },
  { query: 'slide whistle short up', style: 'cartoon', maxLen: 1.5 },
  { query: 'punch cartoon impact', style: 'impact', maxLen: 1.2 },
  { query: 'explosion cartoon small', style: 'impact', maxLen: 1.5 },
  { query: 'electric zap short', style: 'magic', maxLen: 1.2 },
  { query: 'cash register cha ching', style: 'cartoon', maxLen: 1.5 },
  { query: 'bell ding short notification', style: 'cartoon', maxLen: 1.2 },
  { query: 'drum roll short', style: 'fanfare', maxLen: 2.0 },
  { query: 'tada fanfare short celebration', style: 'fanfare', maxLen: 3.0 },
  { query: 'crowd ooh surprise short', style: 'fanfare', maxLen: 3.0 },
  { query: 'crowd aww cute short', style: 'fanfare', maxLen: 3.0 },
  { query: 'record scratch comedy', style: 'fanfare', maxLen: 2.0 },
  { query: 'sad trombone cartoon', style: 'fanfare', maxLen: 3.0 },
  { query: 'victory jingle short game', style: 'fanfare', maxLen: 3.0 },
  { query: 'level up game retro', style: 'magic', maxLen: 2.0 },
  { query: 'power up game 8bit', style: 'magic', maxLen: 1.5 },
  { query: 'laser beam cartoon', style: 'magic', maxLen: 1.2 },
  { query: 'wind gust whoosh', style: 'impact', maxLen: 1.5 },
  { query: 'crunch bite short', style: 'impact', maxLen: 1.0 },
  { query: 'splat splash short', style: 'impact', maxLen: 1.2 },
  { query: 'click switch toggle', style: 'pop', maxLen: 0.8 },
  { query: 'duck quack short funny', style: 'voice', maxLen: 1.2 },
  { query: 'fart short cartoon comedy', style: 'cartoon', maxLen: 1.0 },
  { query: 'burp short funny', style: 'cartoon', maxLen: 1.0 },
  { query: 'applause crowd short', style: 'fanfare', maxLen: 3.0 },
];

const MUSIC_QUERIES = {
  light: [
    'quirky ukulele loop upbeat',
    'funny happy loop background',
    'playful pizzicato loop',
    'whistling happy tune loop',
  ],
  dark: [
    'dark ambient loop mysterious',
    'suspense tension loop',
    'eerie dark loop cinematic',
    'ominous deep bass loop',
  ],
  rock: [
    'rock guitar riff loop energetic',
    'punk rock short loop',
    'electric guitar distortion loop',
    'rock drums bass loop',
  ],
  romantic: [
    'romantic piano loop gentle',
    'soft acoustic guitar loop',
    'love ballad piano loop',
    'strings romantic loop gentle',
  ],
  loud: [
    'energetic edm loop bass',
    'electronic dance beat loop',
    'dubstep drop loop short',
    'trap beat loop hard',
  ],
};

async function setupSFX() {
  log('=== Setting up generic SFX library ===');
  ensureDir('assets/sfx');
  let downloaded = 0;

  const allCandidates = {};
  for (const q of SFX_QUERIES) {
    try {
      const results = await searchFreesound(q.query, {
        minDuration: 0.1,
        maxDuration: q.maxLen + 1,
      });
      if (results.length > 0) {
        allCandidates[q.query] = results.slice(0, 8).map(r => ({
          id: r.id, name: r.name, tags: (r.tags || []).slice(0, 8),
          description: (r.description || '').slice(0, 150),
          duration: r.duration, rating: r.avg_rating,
        }));
      }
    } catch (e) {
      warn(`Search failed for "${q.query}": ${e.message}`);
    }
  }

  let claudePicks = {};
  try {
    const pickPrompt = readFileSync(join(ROOT, 'prompts/pick-sounds.md'), 'utf8');
    const msg = `Pick the best sound for each query. Return a JSON object mapping each query string to the chosen candidate's "id".\n\nCandidates:\n${JSON.stringify(allCandidates, null, 2)}`;
    claudePicks = await askClaude(pickPrompt, msg);
    if (typeof claudePicks === 'string') {
      const { extractJSON } = await import('../src/util.js');
      claudePicks = extractJSON(claudePicks);
    }
    log('Claude picked generic sounds');
  } catch (e) {
    warn(`Claude unavailable for picks: ${e.message}`);
  }

  for (const q of SFX_QUERIES) {
    try {
      const results = await searchFreesound(q.query, {
        minDuration: 0.1,
        maxDuration: q.maxLen + 1,
      });
      if (results.length === 0) {
        warn(`No results for "${q.query}"`);
        continue;
      }

      let chosen;
      const pickId = claudePicks[q.query];
      if (pickId) {
        chosen = results.find(r => r.id === pickId);
      }
      if (!chosen) {
        const scored = scoreCandidates(results);
        chosen = scored[0] || results[0];
      }

      await downloadSound(chosen, 'assets/sfx', { maxLength: q.maxLen });
      downloaded++;
    } catch (e) {
      warn(`Failed "${q.query}": ${e.message}`);
    }
  }

  log(`SFX setup complete: ${downloaded}/${SFX_QUERIES.length} sounds downloaded`);
}

async function setupMusic() {
  log('=== Setting up music library ===');
  ensureDir('assets/music');
  let downloaded = 0;

  for (const [mood, queries] of Object.entries(MUSIC_QUERIES)) {
    for (const query of queries) {
      try {
        const results = await searchFreesound(query, {
          minDuration: 30,
          maxDuration: 180,
        });

        if (results.length === 0) {
          warn(`No music for "${query}"`);
          continue;
        }

        const loopResults = results.filter(r =>
          (r.tags || []).some(t => t.toLowerCase().includes('loop'))
        );
        const pick = loopResults[0] || results[0];

        await downloadSound(pick, 'assets/music', { maxLength: 180 });
        downloaded++;
      } catch (e) {
        warn(`Music failed "${query}": ${e.message}`);
      }
    }
  }

  log(`Music setup complete: ${downloaded} tracks downloaded`);
}

async function main() {
  log('=== Asset Setup ===');

  try {
    log('Building icon index...');
    await buildIconIndex();
  } catch (e) {
    warn(`Icon index failed: ${e.message}`);
  }

  await setupSFX();
  await setupMusic();

  log('=== Setup complete ===');
}

main().catch(e => {
  console.error('Setup failed:', e);
  process.exitCode = 1;
});
