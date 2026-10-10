import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, log, warn, ensureDir, loadJSON, saveJSON } from './util.js';

const QUEUE_DIR = join(ROOT, 'queue');
const USED_DIR = join(ROOT, 'queue/used');
const REJECTED_DIR = join(ROOT, 'queue/rejected');

export function initQueue() {
  ensureDir('queue');
  ensureDir('queue/used');
  ensureDir('queue/rejected');
  splitArrayFiles();
}

function splitArrayFiles() {
  const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fullPath = join(QUEUE_DIR, f);
    try {
      const data = JSON.parse(readFileSync(fullPath, 'utf8'));
      if (Array.isArray(data)) {
        log(`Splitting array queue file: ${f} (${data.length} specs)`);
        for (let i = 0; i < data.length; i++) {
          const spec = data[i];
          if (!spec._meta) spec._meta = { source: 'batch', reviewed: false };
          const newName = f.replace('.json', `-${i + 1}.json`);
          writeFileSync(join(QUEUE_DIR, newName), JSON.stringify(spec, null, 2));
        }
        unlinkSync(fullPath);
      }
    } catch {}
  }
}

export function listQueue() {
  return readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({
      file: f,
      path: join(QUEUE_DIR, f),
    }));
}

export function queueSize() {
  return listQueue().length;
}

export function dequeue() {
  const items = listQueue();
  if (items.length === 0) return null;

  const item = items[0];
  const spec = JSON.parse(readFileSync(item.path, 'utf8'));
  log(`Dequeued: ${item.file}`);
  return { spec, file: item.file, path: item.path };
}

export function markUsed(filePath) {
  const name = basename(filePath);
  const dest = join(USED_DIR, name);
  try {
    renameSync(filePath, dest);
    log(`Moved to used: ${name}`);
  } catch (e) {
    warn(`Failed to move ${name} to used: ${e.message}`);
  }
}

export function markRejected(filePath, reason) {
  const name = basename(filePath);
  const dest = join(REJECTED_DIR, name);
  try {
    const spec = JSON.parse(readFileSync(filePath, 'utf8'));
    spec._meta = spec._meta || {};
    spec._meta.rejectedReason = reason;
    spec._meta.rejectedAt = new Date().toISOString();
    writeFileSync(dest, JSON.stringify(spec, null, 2));
    unlinkSync(filePath);
    log(`Rejected: ${name} — ${reason}`);
  } catch (e) {
    warn(`Failed to reject ${name}: ${e.message}`);
  }
}

export function enqueue(spec, prefix = 'gen') {
  const ts = Date.now();
  const name = `${prefix}-${ts}.json`;
  spec._meta = spec._meta || {};
  spec._meta.source = spec._meta.source || 'generated';
  spec._meta.enqueuedAt = new Date().toISOString();
  const dest = join(QUEUE_DIR, name);
  writeFileSync(dest, JSON.stringify(spec, null, 2));
  log(`Enqueued: ${name}`);
  return dest;
}
