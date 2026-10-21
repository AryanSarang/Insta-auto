import { clamp } from './util.js';

const SHAPES = ['jar', 'glass', 'bowl', 'box'];
const MOODS = ['light', 'dark', 'rock', 'romantic', 'loud', 'meme', 'bouncy', 'retro'];
const GRAVITIES = ['low', 'normal', 'high'];
const STYLES = ['pop', 'boing', 'squeak', 'voice', 'impact', 'magic', 'cartoon', 'fanfare'];

function isHex(s) { return /^#[0-9a-fA-F]{6}$/.test(s); }
function isEmoji(s) { return /\p{Emoji}/u.test(s); }

export function validateSpec(spec) {
  const errors = [];
  const push = msg => errors.push(msg);

  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec is not an object'], spec };

  if (typeof spec.title !== 'string' || !spec.title.trim()) push('missing title');
  if (typeof spec.hook !== 'string' || !spec.hook.trim()) push('missing hook');
  if (spec.hook && spec.hook.length > 60) spec.hook = spec.hook.slice(0, 57) + '...';

  if (!Array.isArray(spec.tiers) || spec.tiers.length < 5 || spec.tiers.length > 8) {
    push(`tiers must have 5-8 entries, got ${spec.tiers?.length}`);
  } else {
    for (const [i, t] of spec.tiers.entries()) {
      if (typeof t.name !== 'string' || !t.name.trim()) push(`tier ${i} missing name`);
      if (typeof t.icon !== 'string' || !isEmoji(t.icon)) push(`tier ${i} icon not emoji`);
      if (t.accessory !== undefined && typeof t.accessory !== 'string') push(`tier ${i} bad accessory`);
    }
  }

  if (!spec.sounds || typeof spec.sounds !== 'object') {
    push('missing sounds');
  } else {
    if (spec.sounds.bounce && typeof spec.sounds.bounce === 'object') {
      if (typeof spec.sounds.bounce.query !== 'string' || !spec.sounds.bounce.query.trim()) {
        spec.sounds.bounce = { query: 'soft pop short', style: 'pop' };
      }
      if (!STYLES.includes(spec.sounds.bounce.style)) spec.sounds.bounce.style = 'pop';
    } else {
      spec.sounds.bounce = { query: 'soft pop short', style: 'pop' };
    }
    const expectedMerge = (spec.tiers?.length || 0) - 1;
    if (!Array.isArray(spec.sounds.merge) || spec.sounds.merge.length !== expectedMerge) {
      push(`sounds.merge must have ${expectedMerge} entries, got ${spec.sounds?.merge?.length}`);
    } else {
      for (const [i, s] of spec.sounds.merge.entries()) {
        if (typeof s.query !== 'string' || !s.query.trim()) push(`merge sound ${i} missing query`);
        if (!STYLES.includes(s.style)) s.style = 'pop';
      }
    }
    if (!spec.sounds.final || typeof spec.sounds.final.query !== 'string') push('missing sounds.final');
  }

  if (!spec.container || typeof spec.container !== 'object') {
    push('missing container');
  } else {
    if (!SHAPES.includes(spec.container.shape)) spec.container.shape = 'jar';
    if (!isHex(spec.container.color)) spec.container.color = '#8B4513';
  }

  if (!spec.palette || typeof spec.palette !== 'object') {
    spec.palette = { bg: '#1a1a2e', text: '#ffffff', accent: '#e94560' };
  } else {
    if (!isHex(spec.palette.bg)) spec.palette.bg = '#1a1a2e';
    if (!isHex(spec.palette.text)) spec.palette.text = '#ffffff';
    if (!isHex(spec.palette.accent)) spec.palette.accent = '#e94560';
  }

  if (!spec.physics || typeof spec.physics !== 'object') {
    spec.physics = { bounciness: 0.7, gravity: 'normal' };
  } else {
    spec.physics.bounciness = clamp(Number(spec.physics.bounciness) || 0.7, 0.5, 0.9);
    if (!GRAVITIES.includes(spec.physics.gravity)) spec.physics.gravity = 'normal';
  }

  if (typeof spec.finalText !== 'string' || !spec.finalText.trim()) push('missing finalText');
  if (spec.finalText && spec.finalText.length > 70) spec.finalText = spec.finalText.slice(0, 67) + '...';

  if (!MOODS.includes(spec.mood)) spec.mood = 'light';

  if (typeof spec.caption !== 'string' || !spec.caption.trim()) push('missing caption');

  if (!Array.isArray(spec.hashtags)) spec.hashtags = [];
  spec.hashtags = spec.hashtags.filter(h => typeof h === 'string' && h.startsWith('#')).slice(0, 30);

  if (typeof spec.seed !== 'number' || !Number.isInteger(spec.seed)) {
    spec.seed = Math.floor(Math.random() * 2147483647);
  }

  return { valid: errors.length === 0, errors, spec };
}

export function clampSpec(spec) {
  const result = validateSpec(spec);
  return result.spec;
}
