#!/usr/bin/env node
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ROOT, log, warn, loadConfig, BackendError, timestamp, ensureDir, loadJSON } from './util.js';
import { validateSpec } from './spec.js';
import { generateSpec, reviewFrames as claudeReviewFrames } from './claude.js';
import { buildIconIndex, resolveAllIcons, resolveAllSounds, resolveMusicTrack } from './assets.js';
import { renderSpec } from './render.js';
import { mixAudio, verifyOutput } from './audio.js';
import { checkToken, publishReel } from './instagram.js';
import { initQueue, dequeue, markUsed, markRejected, enqueue, queueSize } from './queue.js';
import { addPost, recentTitles, recentTracks, recentPillars } from './history.js';
import { notifySuccess, notifyError, sendAlert } from './notify.js';

const { values: flags } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'slot': { type: 'string', default: '' },
    'pillar': { type: 'string', default: '' },
    'source': { type: 'string', default: '' },
    'spec': { type: 'string', default: '' },
    'no-review': { type: 'boolean', default: false },
    'fill-queue': { type: 'string', default: '' },
  },
  strict: false,
});

const LOCK_FILE = join(ROOT, '.lock');

async function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    const { statSync } = await import('node:fs');
    const lockAge = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 30 * 60 * 1000) throw new Error('Another run is in progress (lock file exists)');
    warn('Stale lock file found, removing');
  }
  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try { rmSync(LOCK_FILE); } catch {}
}

function cleanOldRuns() {
  const outBase = join(ROOT, 'out');
  if (!existsSync(outBase)) return;
  const runs = readdirSync(outBase)
    .filter(d => d.startsWith('run-'))
    .sort()
    .reverse();
  for (const old of runs.slice(10)) {
    try { rmSync(join(outBase, old), { recursive: true, force: true }); } catch {}
  }
}

function getCurrentSlot() {
  if (flags.slot) return flags.slot;
  const hour = new Date().getHours();
  return hour < 14 ? 'morning' : 'evening';
}

function pickPillar(config) {
  if (flags.pillar) return flags.pillar;
  const pillars = config.pillars || [];
  if (pillars.length === 0) return 'general';
  const recent = recentPillars(pillars.length);
  const unused = pillars.filter(p => !recent.includes(p));
  return unused.length > 0 ? unused[0] : pillars[0];
}

function buildCaption(spec, config) {
  const parts = [spec.caption || ''];
  const alwaysTags = config.hashtags?.always || [];
  const specTags = spec.hashtags || [];
  const maxTags = config.hashtags?.max || 8;
  const allTags = [...new Set([...alwaysTags, ...specTags])].slice(0, Math.min(maxTags, 30));

  if (spec._attribution) parts.push('', spec._attribution);
  parts.push('', allTags.join(' '));

  let caption = parts.join('\n').trim();
  if (caption.length > 2200) caption = caption.slice(0, 2197) + '...';
  return caption;
}

function fillThemePrompt(config, pillar) {
  const template = readFileSync(join(ROOT, 'prompts/theme.md'), 'utf8');
  const titles = recentTitles(30);
  const queued = [];
  try {
    const queueFiles = readdirSync(join(ROOT, 'queue')).filter(f => f.endsWith('.json'));
    for (const f of queueFiles) {
      try {
        const q = JSON.parse(readFileSync(join(ROOT, 'queue', f), 'utf8'));
        if (q.title) queued.push(q.title);
      } catch {}
    }
  } catch {}

  return template
    .replace('{{niche}}', config.account?.niche || 'EDIT ME')
    .replace('{{audience}}', config.account?.audience || 'EDIT ME')
    .replace('{{voice}}', config.account?.voice || 'EDIT ME')
    .replace('{{language}}', config.account?.language || 'English')
    .replace('{{cta}}', config.account?.cta || 'EDIT ME')
    .replace('{{pillar}}', pillar)
    .replace('{{recentTitles}}', titles.length ? titles.join(', ') : '(none yet)')
    .replace('{{queuedTitles}}', queued.length ? queued.join(', ') : '(none)');
}

async function generateLive(config, pillar, iconIndex) {
  const themePrompt = fillThemePrompt(config, pillar);
  const userMsg = `Create one theme spec for the "${pillar}" pillar. Be creative, funny, and surprising. Return ONLY the JSON object.`;

  log('Generating theme spec via Claude...');
  const rawSpec = await generateSpec(themePrompt, userMsg);
  const { valid, errors, spec } = validateSpec(rawSpec);

  if (!valid) {
    log(`Spec validation failed: ${errors.join('; ')}`);
    throw new Error(`Invalid spec: ${errors.join('; ')}`);
  }

  return spec;
}

async function processSpec(spec, config, outDir, opts = {}) {
  log(`Processing: "${spec.title}"`);

  log('Building icon index...');
  let iconIndex;
  try {
    iconIndex = await buildIconIndex();
  } catch (e) {
    warn(`Icon index build failed (will use fallbacks): ${e.message}`);
    iconIndex = {};
  }

  log('Resolving icons...');
  const icons = await resolveAllIcons(spec, iconIndex);

  log('Resolving sounds...');
  const sounds = await resolveAllSounds(spec, config.assets || {});

  log('Rendering simulation...');
  const renderResult = await renderSpec(spec, icons, outDir, {
    fps: config.video?.fps || 30,
    maxSeconds: config.video?.maxSeconds || 90,
    minSeconds: config.video?.minSeconds || 30,
  });

  log('Resolving music...');
  const musicTrack = await resolveMusicTrack(spec.mood, recentTracks());

  log('Mixing audio...');
  const finalPath = await mixAudio(
    renderResult.videoPath,
    renderResult.events,
    sounds,
    musicTrack,
    outDir,
    { duration: renderResult.duration, mood: spec.mood }
  );

  log('Verifying output...');
  const verify = verifyOutput(finalPath);
  if (!verify.valid) {
    throw new Error(`Output verification failed: ${verify.checks.join('; ')}`);
  }
  log(`Output OK: ${verify.resolution}, ${verify.duration.toFixed(1)}s`);

  const captionText = buildCaption(spec, config);
  writeFileSync(join(outDir, 'caption.txt'), captionText);

  return {
    videoPath: finalPath,
    caption: captionText,
    reviewFrames: renderResult.reviewFrames,
    duration: verify.duration,
    musicTrack,
  };
}

async function reviewReel(outDir, frameFiles, config) {
  if (flags['no-review'] || !config.review?.enabled) {
    log('Review skipped');
    return { pass: true, score: 10, issues: [], status: 'skipped' };
  }

  try {
    const result = await claudeReviewFrames(outDir, frameFiles);
    log(`Review: score=${result.score}, pass=${result.pass}, issues=${(result.issues || []).join('; ')}`);
    return { ...result, status: 'reviewed' };
  } catch (e) {
    if (e instanceof BackendError || e.backend) {
      const policy = config.review?.ifUnavailable || 'post';
      warn(`Reviewer unavailable: ${e.message}`);
      if (policy === 'post') {
        log('Review unavailable, proceeding with technical checks only');
        return { pass: true, score: 0, issues: [], status: 'unavailable-posted' };
      }
      return { pass: false, score: 0, issues: ['Reviewer unavailable'], status: 'unavailable-skipped' };
    }
    throw e;
  }
}

async function runOnce(config) {
  const slot = getCurrentSlot();
  const pillar = pickPillar(config);
  const runId = `run-${Date.now()}`;
  const outDir = join(ROOT, 'out', runId);
  ensureDir(outDir);

  log(`=== Reel run: slot=${slot}, pillar=${pillar}, id=${runId} ===`);

  let spec, source, queueFile;

  if (flags.spec) {
    log(`Using manual spec: ${flags.spec}`);
    spec = loadJSON(flags.spec.startsWith('/') ? flags.spec : join(ROOT, flags.spec));
    const { valid, errors } = validateSpec(spec);
    if (!valid) throw new Error(`Invalid manual spec: ${errors.join('; ')}`);
    source = 'manual';
  } else {
    const sources = flags.source ? [flags.source] : (config.generation?.order || ['live', 'queue']);

    for (const src of sources) {
      try {
        if (src === 'live') {
          spec = await generateLive(config, pillar);
          source = 'live';
          break;
        } else if (src === 'queue') {
          const item = dequeue();
          if (item) {
            spec = item.spec;
            queueFile = item.path;
            source = 'queue';
            break;
          }
          log('Queue empty');
        }
      } catch (e) {
        if (e instanceof BackendError || e.backend) {
          warn(`Source "${src}" unavailable: ${e.message}`);
          continue;
        }
        throw e;
      }
    }

    if (!spec) {
      throw new Error('No spec available — Claude unavailable and queue empty');
    }
  }

  const maxAttempts = config.maxAttempts || 5;
  let result, reviewResult;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await processSpec(spec, config, outDir);
      reviewResult = await reviewReel(outDir, result.reviewFrames, config);

      if (reviewResult.score >= (config.review?.minScore || 7) || reviewResult.status !== 'reviewed') {
        break;
      }

      if (attempt < maxAttempts) {
        log(`Review failed (attempt ${attempt}/${maxAttempts}), regenerating...`);
        spec = await generateLive(config, pillar);
      }
    } catch (e) {
      if (e instanceof BackendError && attempt < maxAttempts) {
        warn(`Attempt ${attempt} backend error, stopping retries`);
        break;
      }
      if (attempt >= maxAttempts) throw e;
      warn(`Attempt ${attempt} failed: ${e.message}`);
      if (source === 'live' || source === 'queue') {
        log(`Generating fresh theme for attempt ${attempt + 1}...`);
        try {
          spec = await generateLive(config, pillar);
          source = 'live';
        } catch (genErr) {
          warn(`Theme generation failed: ${genErr.message}`);
        }
      }
    }
  }

  if (!result) throw new Error('All attempts failed');

  if (flags['dry-run']) {
    log('DRY RUN — not posting to Instagram');
    log(`Video: ${result.videoPath}`);
    log(`Caption: ${result.caption.slice(0, 100)}...`);
    return { title: spec.title, source, dryRun: true };
  }

  await checkToken();
  const { mediaId, permalink } = await publishReel(result.videoPath, result.caption);

  if (queueFile) markUsed(queueFile);

  const historyEntry = {
    slot,
    pillar,
    title: spec.title,
    chain: spec.tiers.map(t => t.name),
    mood: spec.mood,
    track: result.musicTrack?.id || null,
    source,
    mediaId,
    permalink,
  };
  addPost(historyEntry);

  await notifySuccess({
    title: spec.title,
    permalink,
    source,
    reviewStatus: reviewResult?.status || 'none',
    queueSize: queueSize(),
    lowWater: config.queue?.lowWater || 3,
  });

  return { ...historyEntry, reviewStatus: reviewResult?.status };
}

async function fillQueue(n, config) {
  log(`=== Filling queue with ${n} reels ===`);
  const pillars = config.pillars || ['general'];
  let filled = 0;

  for (let i = 0; i < n; i++) {
    const pillar = pillars[i % pillars.length];
    let queued = false;

    for (let attempt = 1; attempt <= 3 && !queued; attempt++) {
      const runId = `fill-${Date.now()}`;
      const outDir = join(ROOT, 'out', runId);
      ensureDir(outDir);

      try {
        const spec = await generateLive(config, pillar);

        let iconIndex;
        try { iconIndex = await buildIconIndex(); } catch { iconIndex = {}; }

        const result = await processSpec(spec, config, outDir);
        const review = await reviewReel(outDir, result.reviewFrames, config);

        if (review.pass) {
          spec._meta = { source: 'fill-queue', reviewed: true, reviewScore: review.score };
          enqueue(spec, 'fill');
          filled++;
          queued = true;
          log(`Queued ${filled}/${n}: "${spec.title}"`);
        } else {
          warn(`Spec "${spec.title}" failed review (attempt ${attempt}/3), retrying with new theme...`);
        }
      } catch (e) {
        if (e instanceof BackendError) {
          warn('Backend unavailable, stopping fill-queue');
          return;
        }
        warn(`Fill-queue item ${i + 1} attempt ${attempt}/3 failed: ${e.message}`);
      }
    }
  }

  log(`Queue filled: ${filled}/${n} added, total queue size: ${queueSize()}`);
}

async function main() {
  try {
    await acquireLock();
    const config = loadConfig();

    initQueue();
    cleanOldRuns();

    if (flags['fill-queue']) {
      const n = parseInt(flags['fill-queue']) || 2;
      await fillQueue(n, config);
    } else {
      const result = await runOnce(config);
      log('=== Done ===', JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error('FATAL:', e);
    await notifyError(e);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

main();
