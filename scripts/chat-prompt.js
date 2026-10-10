#!/usr/bin/env node
import 'dotenv/config';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig, ensureDir } from '../src/util.js';
import { recentTitles } from '../src/history.js';

const N = parseInt(process.argv[2]) || 5;
const config = loadConfig();
const pillars = config.pillars || ['general'];

const themeTemplate = readFileSync(join(ROOT, 'prompts/theme.md'), 'utf8');
const titles = recentTitles(30);

const filledPrompt = themeTemplate
  .replace('{{niche}}', config.account?.niche || 'EDIT ME')
  .replace('{{audience}}', config.account?.audience || 'EDIT ME')
  .replace('{{voice}}', config.account?.voice || 'EDIT ME')
  .replace('{{language}}', config.account?.language || 'English')
  .replace('{{cta}}', config.account?.cta || 'EDIT ME')
  .replace('{{pillar}}', pillars.map((p, i) => `${i + 1}. ${p}`).join('\n'))
  .replace('{{recentTitles}}', titles.length ? titles.join(', ') : '(none yet)')
  .replace('{{queuedTitles}}', '(generating batch)');

const output = `# Batch Theme Generation Prompt

Copy everything below this line into a normal Claude chat (claude.ai).
Save the JSON array output as a .json file and upload it to your repo's queue/ folder.

---

${filledPrompt}

---

## Your task

Create ${N} DIFFERENT theme specs as a JSON array. Rotate through these pillars:
${pillars.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Each spec must be completely different in theme, container, palette, mood, and humour.
Return ONLY a JSON array of ${N} spec objects — no markdown, no explanation.

Example structure:
[
  { "title": "...", "hook": "...", "tiers": [...], ... },
  { "title": "...", "hook": "...", "tiers": [...], ... }
]
`;

ensureDir('out');
const outPath = join(ROOT, 'out/chat-batch-prompt.md');
writeFileSync(outPath, output);
console.log(`Prompt written to: ${outPath}`);
console.log(`\nCopy its contents into claude.ai, save the JSON array response as a .json file,`);
console.log(`and drop it into the queue/ folder of your repo.`);
