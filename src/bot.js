import { getDiscordClient } from './discord-client.js';
import { getUsers, addUser, getUser, updateUserTrophies, getUserTrophies, getPSNCredentials, savePSNCredentials } from './storage.js';
import { authenticatePSN, configurePSN, isPSNConfigured, getPSNTrophies, getNewTrophies } from './psn-tracker.js';
import { initializeSteam, getSteamAchievements, getNewAchievements } from './steam-tracker.js';
import cron from 'node-cron';

const NOTIFICATION_CHANNEL = process.env.DISCORD_CHANNEL_ID || null;
const CHECK_INTERVAL = '*/30 * * * *';
const OWNER_ID = process.env.OWNER_DISCORD_ID || null;
// Daily NPSSO expiry check, 15:00 UTC
const EXPIRY_CHECK = '0 15 * * *';
const EXPIRY_REMINDER_DAYS = [7, 3, 1, 0];
// Sony's ssocookie page gives ~60 days when expires_in isn't pasted along with the code
const DEFAULT_NPSSO_LIFETIME = 60 * 24 * 60 * 60;
const SSOCOOKIE_URL = 'https://ca.account.sony.com/api/v1/ssocookie';
// Only platinums and achievements earned by at most this % of players are posted
const RARE_THRESHOLD = parseFloat(process.env.RARE_THRESHOLD || '5');

function isNotable(item) {
  if (item.trophyType === 'platinum') return true;
  return Number.isFinite(item.earnedRate) && item.earnedRate <= RARE_THRESHOLD;
}

function formatRate(rate) {
  return Number.isFinite(rate) ? `${rate}% of players` : 'Unknown';
}

let client = null;
let psnAuthAlerted = false;

// A code renewed via !npsso (data/psn.json) takes priority over .env
function getNpsso() {
  return getPSNCredentials().npsso || process.env.PSN_NPSSO || null;
}

function getNpssoExpiry() {
  const credentials = getPSNCredentials();
  const expiry = credentials.npsso ? credentials.expiresAt : process.env.PSN_NPSSO_EXPIRES;
  const date = expiry ? new Date(expiry) : null;
  return date && !isNaN(date) ? date : null;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

async function notifyOwner(text) {
  console.log(`Owner alert: ${text.split('\n')[0]}`);
  if (!OWNER_ID) {
    console.warn('OWNER_DISCORD_ID not set, cannot DM the alert');
    return;
  }
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send(text);
  } catch (error) {
    console.error('Failed to DM owner:', error.message);
  }
}

async function alertPSNAuthFailure(error) {
  if (psnAuthAlerted) return;
  psnAuthAlerted = true;
  await notifyOwner(
    `❌ **PSN sign-in failed.** Trophy tracking for PSN is paused.\n` +
    `Reason: ${error.message}\n\n` +
    `To fix: sign in at playstation.com with the bot's PSN account, open ${SSOCOOKIE_URL}, ` +
    `copy everything shown, and send it to me here as \`!npsso <paste>\`.`
  );
}

async function checkNpssoExpiry() {
  const expiry = getNpssoExpiry();
  if (!expiry || !isPSNConfigured()) return;

  const daysLeft = Math.floor((expiry - Date.now()) / 86_400_000);
  if (daysLeft >= 0 && !EXPIRY_REMINDER_DAYS.includes(daysLeft)) return;

  // At most one reminder per day, even across restarts
  const credentials = getPSNCredentials();
  const today = formatDate(new Date());
  if (credentials.lastReminder === today) return;
  savePSNCredentials({ ...credentials, lastReminder: today });

  const when = daysLeft > 1 ? `in **${daysLeft} days**` : daysLeft === 1 ? '**tomorrow**' : daysLeft === 0 ? '**today**' : 'and has **expired**';
  await notifyOwner(
    `⏰ The PSN NPSSO expires ${when} (${formatDate(expiry)}).\n` +
    `Renew: sign in at playstation.com with the bot's PSN account, open ${SSOCOOKIE_URL}, ` +
    `copy everything shown, and send it to me here as \`!npsso <paste>\`.`
  );
}

export async function startBot() {
  console.log('Starting Achievement Tracker Bot...');

  const npsso = getNpsso();
  let psnStartupError = null;
  if (npsso) {
    configurePSN(npsso);
    try {
      await authenticatePSN(npsso);
      console.log('PSN authentication successful');
    } catch (error) {
      psnStartupError = error;
      console.error('PSN authentication failed:', error.message);
    }
  }

  if (process.env.STEAM_API_KEY) {
    initializeSteam(process.env.STEAM_API_KEY);
    console.log('Steam API initialized');
  }

  console.log('Connecting to Discord...');
  client = await getDiscordClient();
  console.log('Discord client created, waiting for ready event...');
  
  const onReady = () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Bot is ready!');
    
    cron.schedule(CHECK_INTERVAL, () => {
      checkAllUserAchievements();
    });
    cron.schedule(EXPIRY_CHECK, () => {
      checkNpssoExpiry();
    }, { timezone: 'UTC' });

    console.log(`Scheduled achievement checks every 30 minutes`);
    const expiry = getNpssoExpiry();
    console.log(`NPSSO expiry: ${expiry ? formatDate(expiry) : 'unknown'}, owner alerts ${OWNER_ID ? 'on' : 'off (OWNER_DISCORD_ID not set)'}`);
    if (psnStartupError) {
      alertPSNAuthFailure(psnStartupError);
    }
    checkNpssoExpiry();
  };
  // login() can resolve after 'ready' has already fired
  if (client.isReady()) onReady(); else client.once('clientReady', onReady);

  client.on('error', (error) => {
    console.error('Discord client error:', error);
  });

  client.on('warn', (warning) => {
    console.warn('Discord client warning:', warning);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    
    if (content.startsWith('!register')) {
      await handleRegister(message);
    } else if (content === '!check') {
      await handleCheck(message);
    } else if (content === '!mystats') {
      await handleMyStats(message);
    } else if (content === '!help') {
      await handleHelp(message);
    } else if (content.startsWith('!setchannel')) {
      await handleSetChannel(message);
    } else if (content.startsWith('!npsso')) {
      await handleNpsso(message);
    }
  });

  return client;
}

async function handleRegister(message) {
  const parts = message.content.split(' ');
  
  if (parts.length < 2) {
    await message.reply('Usage: `!register psn:YourPSNID` or `!register steam:YourSteamID64` or both separated by space');
    return;
  }

  let psnId = null;
  let steamId = null;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('psn:')) {
      psnId = part.substring(4);
    } else if (part.startsWith('steam:')) {
      steamId = part.substring(6);
    }
  }

  if (!psnId && !steamId) {
    await message.reply('Please specify at least one account: `psn:YourPSNID` or `steam:YourSteamID64`');
    return;
  }

  addUser(message.author.id, psnId, steamId);
  
  let response = `Registered ${message.author.username}:\n`;
  if (psnId) response += `- PSN: ${psnId}\n`;
  if (steamId) response += `- Steam: ${steamId}\n`;
  response += '\nYour achievements will be tracked automatically!';
  
  await message.reply(response);

  await checkUserAchievements(message.author.id, message.channel);
}

async function handleNpsso(message) {
  const input = message.content.slice('!npsso'.length).trim();
  const code = input.match(/[A-Za-z0-9]{64}/)?.[0];

  if (message.guild) {
    await message.reply(code
      ? '⚠️ **Never post an NPSSO in a server channel**, anyone here can see it. Delete your message, ' +
        'then on the bot\'s PSN account use Account Management → Security → Sign out of all devices to kill that code. ' +
        'Then DM me `!npsso <new code>`.'
      : 'This command only works in a DM with me.');
    return;
  }
  if (!OWNER_ID || message.author.id !== OWNER_ID) {
    await message.reply('Only the bot owner can manage the PSN sign-in.');
    return;
  }

  if (!input) {
    const expiry = getNpssoExpiry();
    const source = getPSNCredentials().npsso ? 'set via !npsso' : '.env';
    const daysLeft = expiry ? Math.floor((expiry - Date.now()) / 86_400_000) : null;
    await message.reply(
      `**PSN sign-in:** ${isPSNConfigured() ? `configured (${source})` : 'not configured'}\n` +
      `**Expires:** ${expiry ? `${formatDate(expiry)} (${daysLeft} days left)` : 'unknown'}\n\n` +
      `To renew: sign in at playstation.com with the bot's PSN account, open ${SSOCOOKIE_URL}, ` +
      `copy everything shown, and send \`!npsso <paste>\`.`
    );
    return;
  }
  if (!code) {
    await message.reply(`That doesn't contain a 64-character NPSSO. Copy everything shown at ${SSOCOOKIE_URL} and send \`!npsso <paste>\`.`);
    return;
  }

  const pastedLifetime = parseInt(input.match(/expires_in"?\s*:\s*(\d+)/)?.[1], 10);
  const lifetime = pastedLifetime > 0 ? pastedLifetime : DEFAULT_NPSSO_LIFETIME;

  try {
    await authenticatePSN(code);
  } catch (error) {
    await message.reply(`❌ Sony rejected that code (${error.message}). Nothing was changed. Get a fresh one from ${SSOCOOKIE_URL}.`);
    return;
  }

  const expiresAt = new Date(Date.now() + lifetime * 1000);
  savePSNCredentials({ npsso: code, expiresAt: expiresAt.toISOString(), updatedAt: new Date().toISOString() });
  psnAuthAlerted = false;
  console.log(`NPSSO renewed via Discord, expires ${formatDate(expiresAt)}`);
  await message.reply(
    `✅ **PSN sign-in renewed.** New code works and is saved.\n` +
    `Expires: **${formatDate(expiresAt)}**${pastedLifetime > 0 ? '' : ' (estimated, paste the full ssocookie text next time for the exact date)'}.\n` +
    `I'll remind you 7, 3 and 1 day(s) before. You can delete your message with the code now.`
  );
}

async function handleCheck(message) {
  const reply = await message.reply('Checking for new achievements across all registered users...');
  const result = await checkAllUserAchievements();

  if (!result) {
    await reply.edit('A check is already running, results will be posted when it finishes.');
    return;
  }
  let summary = `✅ Check complete: ${result.users} user(s) checked, ` +
    (result.posted > 0 ? `${result.posted} new achievement(s) posted.` : 'nothing new.');
  if (result.failed.length > 0) {
    summary += `\n⚠️ Failed: ${result.failed.join(', ')} (see bot logs)`;
  }
  await reply.edit(summary);
}

async function handleMyStats(message) {
  const user = getUser(message.author.id);
  
  if (!user) {
    await message.reply('You are not registered! Use `!register psn:YourPSNID steam:YourSteamID64` to register.');
    return;
  }

  let stats = `**Stats for ${message.author.username}:**\n\n`;
  
  if (user.psnId) {
    const psnTrophies = getUserTrophies(message.author.id, 'psn');
    const trophyCount = countTracked(psnTrophies);
    stats += `🎮 PSN (${user.psnId}): ${trophyCount} trophies tracked\n`;
  }
  
  if (user.steamId) {
    const steamAchievements = getUserTrophies(message.author.id, 'steam');
    const achievementCount = countTracked(steamAchievements);
    stats += `🎮 Steam (${user.steamId}): ${achievementCount} achievements tracked\n`;
  }

  await message.reply(stats);
}

async function handleHelp(message) {
  const helpText = `
**Achievement Tracker Bot Commands:**

\`!register psn:YourPSNID steam:YourSteamID64\` - Register your gaming accounts
\`!mystats\` - View your tracked achievements
\`!check\` - Manually trigger achievement check for all users
\`!setchannel\` - Set current channel for notifications (Admin only)
\`!help\` - Show this help message

**How it works:**
- Register your PSN and/or Steam accounts
- The bot checks for new achievements every 30 minutes
- When you earn a new trophy or achievement, it's posted to the notification channel!
  `;
  
  await message.reply(helpText);
}

async function handleSetChannel(message) {
  if (!message.member.permissions.has('Administrator')) {
    await message.reply('Only administrators can set the notification channel.');
    return;
  }

  process.env.DISCORD_CHANNEL_ID = message.channel.id;
  await message.reply(`✅ Notification channel set to ${message.channel.name}`);
}

let checkInProgress = false;

async function checkAllUserAchievements() {
  // A first sync can take minutes; overlapping runs would post the same trophies twice
  if (checkInProgress) {
    console.log('Achievement check already running, skipping');
    return null;
  }
  checkInProgress = true;
  try {
    const users = getUsers();
    const notificationChannel = NOTIFICATION_CHANNEL ? await client.channels.fetch(NOTIFICATION_CHANNEL) : null;

    const result = { users: 0, posted: 0, failed: [] };
    for (const [discordId, userData] of Object.entries(users)) {
      await checkUserAchievements(discordId, notificationChannel, result);
      result.users++;
    }
    return result;
  } finally {
    checkInProgress = false;
  }
}

// Cache entries other than trophies (lastChecked, _titles)
function countTracked(cache) {
  return Object.keys(cache).filter(key => key !== 'lastChecked' && !key.startsWith('_')).length;
}

async function checkUserAchievements(discordId, channel, result = { posted: 0, failed: [] }) {
  const user = getUser(discordId);
  if (!user) return;

  if (user.psnId && isPSNConfigured()) {
    try {
      const oldTrophies = getUserTrophies(discordId, 'psn');
      const newTrophyData = await getPSNTrophies(user.psnId, oldTrophies);
      const newTrophies = getNewTrophies(oldTrophies, newTrophyData);
      // The first sync only records existing trophies
      const isFirstSync = !oldTrophies.lastChecked;
      if (isFirstSync) {
        console.log(`Initial PSN sync for ${user.psnId}: ${newTrophies.length} trophies recorded`);
      }

      if (newTrophies.length > 0 && channel && !isFirstSync) {
        for (const trophy of newTrophies.filter(isNotable)) {
          const embed = {
            color: 0xFFD700,
            title: '🏆 New PSN Trophy!',
            fields: [
              { name: 'Player', value: `<@${discordId}>`, inline: true },
              { name: 'Game', value: trophy.gameName, inline: true },
              { name: 'Trophy', value: trophy.trophyName, inline: false },
              { name: 'Description', value: trophy.trophyDetail || 'No description', inline: false },
              { name: 'Type', value: trophy.trophyType, inline: true },
              { name: 'Rarity', value: formatRate(trophy.earnedRate), inline: true },
              { name: 'Earned', value: new Date(trophy.earnedDateTime).toLocaleString(), inline: true }
            ],
            thumbnail: trophy.trophyIconUrl ? { url: trophy.trophyIconUrl } : undefined,
            timestamp: new Date(trophy.earnedDateTime)
          };
          
          await channel.send({ embeds: [embed] });
          result.posted++;
        }
      }

      updateUserTrophies(discordId, 'psn', newTrophyData);
      psnAuthAlerted = false;
    } catch (error) {
      if (error.authFailed) {
        await alertPSNAuthFailure(error);
      }
      console.error(`Failed to check PSN trophies for ${user.psnId}:`, error.message);
      result.failed.push(`PSN ${user.psnId}`);
    }
  }

  if (user.steamId && process.env.STEAM_API_KEY) {
    try {
      const oldAchievements = getUserTrophies(discordId, 'steam');
      const newAchievementData = await getSteamAchievements(user.steamId, oldAchievements);
      const newAchievements = getNewAchievements(oldAchievements, newAchievementData);
      const isFirstSync = !oldAchievements.lastChecked;
      if (isFirstSync) {
        console.log(`Initial Steam sync for ${user.steamId}: ${newAchievements.length} achievements recorded`);
      }

      if (newAchievements.length > 0 && channel && !isFirstSync) {
        for (const achievement of newAchievements.filter(isNotable)) {
          const embed = {
            color: 0x1B2838,
            title: '🎮 New Steam Achievement!',
            fields: [
              { name: 'Player', value: `<@${discordId}>`, inline: true },
              { name: 'Game', value: achievement.gameName, inline: true },
              { name: 'Achievement', value: achievement.achievementName, inline: false },
              { name: 'Description', value: achievement.achievementDescription, inline: false },
              { name: 'Rarity', value: formatRate(achievement.earnedRate), inline: true },
              { name: 'Unlocked', value: new Date(achievement.unlockTime * 1000).toLocaleString(), inline: true }
            ],
            thumbnail: achievement.achievementIconUrl ? { url: achievement.achievementIconUrl } : undefined,
            timestamp: new Date(achievement.unlockTime * 1000)
          };
          
          await channel.send({ embeds: [embed] });
          result.posted++;
        }
      }

      updateUserTrophies(discordId, 'steam', newAchievementData);
    } catch (error) {
      console.error(`Failed to check Steam achievements for ${user.steamId}:`, error.message);
      result.failed.push(`Steam ${user.steamId}`);
    }
  }
}
