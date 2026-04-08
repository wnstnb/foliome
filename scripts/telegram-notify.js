require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;

function getBot() {
  if (!bot && BOT_TOKEN) {
    bot = new TelegramBot(BOT_TOKEN, { polling: false });
  }
  return bot;
}

async function sendMessage(text) {
  const b = getBot();
  if (!b || !CHAT_ID) {
    console.log('[telegram] Bot not configured, would send:', text);
    return null;
  }
  return b.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}

async function sendPhoto(buffer, caption) {
  const b = getBot();
  if (!b || !CHAT_ID) {
    console.log('[telegram] Bot not configured, would send photo:', caption);
    return null;
  }
  return b.sendPhoto(CHAT_ID, buffer, { caption, parse_mode: 'Markdown' });
}

/**
 * Send a prompt and wait for a reply from the configured chat.
 * Creates a temporary polling bot to receive the reply, then stops polling.
 * Used by the sync engine for SMS MFA code entry.
 */
function waitForReply(prompt, timeoutMs = 300000) {
  return new Promise(async (resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      console.log('[telegram] Bot not configured, cannot wait for reply');
      resolve(null);
      return;
    }

    await sendMessage(prompt);

    // Create a separate polling bot instance for receiving the reply
    const pollingBot = new TelegramBot(BOT_TOKEN, { polling: true });

    const timeout = setTimeout(() => {
      pollingBot.removeListener('message', handler);
      pollingBot.stopPolling();
      resolve(null);
    }, timeoutMs);

    function handler(msg) {
      if (String(msg.chat.id) === String(CHAT_ID) && msg.text) {
        clearTimeout(timeout);
        pollingBot.removeListener('message', handler);
        pollingBot.stopPolling();
        resolve(msg.text.trim());
      }
    }

    pollingBot.on('message', handler);

    pollingBot.on('polling_error', () => {
      // Ignore polling errors silently
    });
  });
}

module.exports = { sendMessage, sendPhoto, waitForReply, getBot };
