import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadJSON(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

export function saveJSON(rel, data) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

export function ensureDir(rel) {
  const p = rel.startsWith('/') ? rel : join(ROOT, rel);
  mkdirSync(p, { recursive: true });
  return p;
}

export function fileExists(rel) {
  const p = rel.startsWith('/') ? rel : join(ROOT, rel);
  return existsSync(p);
}

export function loadConfig() {
  return loadJSON('config.json');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function pickRandom(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function timestamp() {
  return new Date().toISOString();
}

export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export class BackendError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BackendError';
    this.backend = true;
    if (cause) this.cause = cause;
  }
}

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${new Date().toISOString().slice(11, 19)}] WARN:`, ...args);
}

export function extractJSON(text) {
  const trimmed = text.trim();
  let depth = 0;
  let start = -1;
  const opener = trimmed.indexOf('{') < trimmed.indexOf('[') || trimmed.indexOf('[') === -1 ? '{' : '[';
  const closer = opener === '{' ? '}' : ']';
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === opener && depth === 0 && start === -1) { start = i; depth++; }
    else if (c === opener) depth++;
    else if (c === closer) { depth--; if (depth === 0 && start !== -1) { return JSON.parse(trimmed.slice(start, i + 1)); } }
    else if (c === '"') {
      i++;
      while (i < trimmed.length && trimmed[i] !== '"') { if (trimmed[i] === '\\') i++; i++; }
    }
  }
  throw new Error('No valid JSON found in response');
}
