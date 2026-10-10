import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackendError, extractJSON, log } from './util.js';

const BACKEND = process.env.CLAUDE_BACKEND || 'claude-code';

export async function askClaude(systemPrompt, userPrompt, opts = {}) {
  if (BACKEND === 'api') return askAPI(systemPrompt, userPrompt, opts);
  return askClaudeCode(systemPrompt, userPrompt, opts);
}

async function askClaudeCode(systemPrompt, userPrompt, opts = {}) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const model = process.env.CLAUDE_CODE_MODEL || 'sonnet';
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--model', model,
  ];

  if (opts.tools) {
    args.push('--tools', opts.tools);
    args.push('--allowedTools', opts.tools);
  } else {
    args.push('--tools', '');
  }

  args.push('--system-prompt', systemPrompt);

  if (opts.cwd) args.push('--cwd', opts.cwd);

  log(`Claude Code: spawning (model=${model}, tools=${opts.tools || 'none'})`);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout || 120_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.stdin.write(userPrompt);
    proc.stdin.end();

    proc.on('error', err => {
      reject(new BackendError(`Claude Code binary not found: ${err.message}`, err));
    });

    proc.on('close', code => {
      if (code !== 0) {
        const msg = stderr || stdout || `exit code ${code}`;
        if (/usage.limit|rate.limit|auth|token|oauth|unauthorized/i.test(msg)) {
          return reject(new BackendError(`Claude Code auth/limit error: ${msg}`));
        }
        return reject(new BackendError(`Claude Code failed (exit ${code}): ${msg}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          if (/usage.limit|rate.limit/i.test(parsed.result)) {
            return reject(new BackendError(`Claude usage limit: ${parsed.result}`));
          }
          return reject(new Error(`Claude returned error: ${parsed.result}`));
        }
        const result = parsed.result || '';
        resolve(result);
      } catch (e) {
        resolve(stdout);
      }
    });
  });
}

async function askAPI(systemPrompt, userPrompt, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new BackendError('ANTHROPIC_API_KEY not set for api backend');

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
  const messages = [];

  if (opts.images && opts.images.length > 0) {
    const content = [];
    for (const img of opts.images) {
      const data = readFileSync(img);
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') }
      });
    }
    content.push({ type: 'text', text: userPrompt });
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: userPrompt });
  }

  const body = {
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  };

  log(`API backend: ${model}`);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt + 1) * 1000;
          log(`API ${res.status}, retry in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new BackendError(`API error ${res.status} after ${maxRetries} retries`);
      }

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new BackendError(`API auth error: ${text}`);
        }
        throw new Error(`API error ${res.status}: ${text}`);
      }

      const data = await res.json();
      const textBlock = data.content?.find(b => b.type === 'text');
      return textBlock?.text || '';
    } catch (e) {
      if (e instanceof BackendError) throw e;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        log(`API fetch error, retry in ${delay}ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new BackendError(`API request failed: ${e.message}`, e);
    }
  }
}

export async function generateSpec(themePrompt, userMsg) {
  const raw = await askClaude(themePrompt, userMsg);
  return extractJSON(raw);
}

export async function pickSounds(pickPrompt, userMsg) {
  const raw = await askClaude(pickPrompt, userMsg);
  return extractJSON(raw);
}

export async function reviewFrames(framesDir, frameFiles) {
  const systemPrompt = `You are a quality reviewer for short vertical video reels (1080x1920). You will examine 4 key frames from a physics simulation reel. Return ONLY a JSON object with these fields:
- "score": integer 1-10 (10 = perfect)
- "pass": boolean
- "issues": array of strings describing problems found

Check for:
1. Text readability (must be clear on a phone)
2. Icons that appear as empty boxes or are missing
3. Icons that don't visually match their tier name
4. Items escaping outside the container
5. Final reveal frame: is the final form clearly visible and centered?
6. Punchline text: is it readable and funny?
7. Progress bar: is it visible and correct?
8. Anything that looks broken, inappropriate, or low quality
9. Overall visual appeal and entertainment value

Score >= 7 = pass. Be strict but fair.`;

  const userMsg = `Review these 4 frames from a merge-evolution reel. Frame 1 is early (items falling, hook text visible). Frame 2 is mid (merges happening). Frame 3 is near the end (slow motion before final merge). Frame 4 is the reveal (final form shown with punchline).

Please Read each frame file and evaluate them.

Files: ${frameFiles.join(', ')}`;

  if (BACKEND === 'api') {
    const images = frameFiles.map(f => join(framesDir, f));
    const raw = await askAPI(systemPrompt, userMsg, { images });
    return extractJSON(raw);
  }

  const raw = await askClaudeCode(systemPrompt, userMsg, {
    tools: 'Read',
    cwd: framesDir,
  });
  return extractJSON(raw);
}
