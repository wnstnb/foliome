require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;
let dashboardBot;

function getBot() {
  if (!bot && BOT_TOKEN) {
    bot = new TelegramBot(BOT_TOKEN, { polling: false });
  }
  return bot;
}

/**
 * Get bot instance for sending dashboard web_app buttons.
 * Uses DASHBOARD_BOT_TOKEN if set (for setups where the Mini App bot differs
 * from the notification bot), otherwise falls back to TELEGRAM_BOT_TOKEN.
 * The dashboard-server validates initData against this same token.
 */
function getDashboardBot() {
  const dashToken = process.env.DASHBOARD_BOT_TOKEN;
  if (!dashToken || dashToken === BOT_TOKEN) return getBot();
  if (!dashboardBot) {
    dashboardBot = new TelegramBot(dashToken, { polling: false });
  }
  return dashboardBot;
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

/**
 * Send a message with an inline keyboard button that opens the dashboard
 * as a Telegram Mini App. Uses web_app button type so Telegram passes
 * initData for authentication — a plain URL link won't work.
 *
 * @param {string} chatId - Target chat (falls back to TELEGRAM_CHAT_ID)
 * @param {string} text - Message text shown above the button
 * @param {string} url - Dashboard tunnel URL (e.g., https://xxx.trycloudflare.com)
 * @param {string} [buttonText='Open Dashboard'] - Label on the inline button
 */
async function sendDashboard(chatId, text, url, buttonText = 'Open Dashboard') {
  const b = getDashboardBot();
  const target = chatId || CHAT_ID;
  if (!b || !target) {
    console.log('[telegram] Bot not configured, would send dashboard button:', text);
    return null;
  }
  return b.sendMessage(target, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: buttonText,
        web_app: { url }
      }]]
    }
  });
}

/**
 * Set the bot's menu button to open the dashboard as a Mini App.
 * The button appears next to the text input in Telegram — always accessible.
 * Uses the Telegram Bot API setChatMenuButton method directly.
 *
 * @param {string} chatId - Target chat (falls back to TELEGRAM_CHAT_ID)
 * @param {string} url - Dashboard tunnel URL (e.g., https://xxx.trycloudflare.com)
 * @param {string} [buttonText='Dashboard'] - Label on the menu button
 */
async function setMenuButton(chatId, url, buttonText = 'Dashboard') {
  const dashToken = process.env.DASHBOARD_BOT_TOKEN || BOT_TOKEN;
  const target = chatId || CHAT_ID;
  if (!dashToken || !target) {
    console.log('[telegram] Bot not configured, cannot set menu button');
    return null;
  }
  const payload = {
    chat_id: target,
    menu_button: {
      type: 'web_app',
      text: buttonText,
      web_app: { url }
    }
  };
  const resp = await fetch(`https://api.telegram.org/bot${dashToken}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await resp.json();
  if (!result.ok) {
    throw new Error(result.description || 'setChatMenuButton failed');
  }
  return result;
}

module.exports = { sendMessage, sendPhoto, waitForReply, sendDashboard, setMenuButton, getBot };

// CLI: node scripts/telegram-notify.js --dashboard <chatId> "<text>" <url> [buttonText]
//      node scripts/telegram-notify.js --menu-button <chatId> <url> [buttonText]
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--dashboard' && args.length >= 4) {
    const [, chatId, text, url, btnText] = args;
    sendDashboard(chatId, text, url, btnText || undefined)
      .then(msg => {
        if (msg) console.log('[telegram] Dashboard button sent, message_id:', msg.message_id);
        process.exit(0);
      })
      .catch(err => {
        console.error('[telegram] Failed to send dashboard:', err.message);
        process.exit(1);
      });
  } else if (args[0] === '--dashboard') {
    console.error('Usage: node scripts/telegram-notify.js --dashboard <chatId> "<text>" <url> [buttonText]');
    process.exit(1);
  } else if (args[0] === '--menu-button' && args.length >= 3) {
    const [, chatId, url, btnText] = args;
    setMenuButton(chatId, url, btnText || undefined)
      .then(result => {
        if (result) console.log('[telegram] Menu button set to:', url);
        process.exit(0);
      })
      .catch(err => {
        console.error('[telegram] Failed to set menu button:', err.message);
        process.exit(1);
      });
  } else if (args[0] === '--menu-button') {
    console.error('Usage: node scripts/telegram-notify.js --menu-button <chatId> <url> [buttonText]');
    process.exit(1);
  }
}
