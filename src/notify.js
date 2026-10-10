import { log, warn } from './util.js';

export async function sendAlert(text, extra = {}) {
  const promises = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    promises.push(sendTelegram(text).catch(e => warn('Telegram alert failed:', e.message)));
  }
  if (process.env.ALERT_WEBHOOK_URL) {
    promises.push(sendWebhook(text, extra).catch(e => warn('Webhook alert failed:', e.message)));
  }
  if (promises.length === 0) {
    log('No alert channels configured, message:', text);
  }
  await Promise.allSettled(promises);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function sendWebhook(text, extra = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text, ...extra }),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text()}`);
}

export async function notifySuccess(info) {
  if (process.env.NOTIFY_ON_SUCCESS === 'false') return;
  const parts = [`✅ Reel posted: ${info.title}`];
  if (info.permalink) parts.push(`Link: ${info.permalink}`);
  parts.push(`Source: ${info.source}`);
  if (info.reviewStatus) parts.push(`Review: ${info.reviewStatus}`);
  if (info.queueSize !== undefined && info.lowWater) {
    if (info.queueSize < info.lowWater) {
      parts.push(`⚠️ Queue low: ${info.queueSize} reels remaining (threshold: ${info.lowWater})`);
    }
  }
  await sendAlert(parts.join('\n'));
}

export async function notifyError(error, context = '') {
  const msg = `❌ Reel bot error${context ? ` (${context})` : ''}: ${error.message}`;
  await sendAlert(msg);
}
