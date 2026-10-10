import { loadJSON, saveJSON, fileExists } from './util.js';

const HISTORY_PATH = 'data/history.json';

export function loadHistory() {
  if (!fileExists(HISTORY_PATH)) return [];
  try { return loadJSON(HISTORY_PATH); } catch { return []; }
}

export function saveHistory(history) {
  saveJSON(HISTORY_PATH, history);
}

export function addPost(entry) {
  const history = loadHistory();
  history.push({
    time: new Date().toISOString(),
    ...entry,
  });
  saveHistory(history);
  return history;
}

export function recentTitles(n = 30) {
  return loadHistory().slice(-n).map(h => h.title);
}

export function recentTracks(n = 6) {
  return loadHistory().slice(-n).map(h => h.track).filter(Boolean);
}

export function recentPillars(n = 10) {
  return loadHistory().slice(-n).map(h => h.pillar).filter(Boolean);
}
