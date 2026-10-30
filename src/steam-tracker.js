const API = 'https://api.steampowered.com';

let apiKey = null;

export function initializeSteam(key) {
  apiKey = key;
}

async function steamGet(path, params) {
  const query = new URLSearchParams({ key: apiKey, ...params });
  const response = await fetch(`${API}/${path}?${query}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.playerstats?.error || response.statusText;
    const error = new Error(`Steam ${path} returned ${response.status}: ${reason}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// Returns achievements only for games played since the last check, plus a
// `_games` map of appid -> last played time used to detect those changes
export async function getSteamAchievements(steamId, previous = {}) {
  if (!apiKey) {
    throw new Error('Steam API not initialized. Please set STEAM_API_KEY.');
  }

  try {
    const { response } = await steamGet('IPlayerService/GetOwnedGames/v1/', {
      steamid: steamId,
      include_appinfo: 1,
      include_played_free_games: 1
    });
    if (!response?.games) {
      throw new Error(`no game list returned for ${steamId} (is their game details privacy set to Public?)`);
    }

    const knownGames = previous._games || {};
    const games = { ...knownGames };
    const achievementMap = {};

    for (const game of response.games) {
      const lastPlayed = game.rtime_last_played;
      if (!lastPlayed || knownGames[game.appid] === lastPlayed) continue;
      if (!game.has_community_visible_stats) {
        games[game.appid] = lastPlayed;
        continue;
      }

      try {
        const { playerstats } = await steamGet('ISteamUserStats/GetPlayerAchievements/v1/', {
          steamid: steamId,
          appid: game.appid,
          l: 'english'
        });
        const unlocked = (playerstats.achievements || []).filter(a => a.achieved === 1);

        let icons = {};
        let percents = {};
        if (unlocked.length > 0) {
          const schema = await steamGet('ISteamUserStats/GetSchemaForGame/v2/', { appid: game.appid })
            .catch(() => ({}));
          const defs = schema.game?.availableGameStats?.achievements || [];
          icons = Object.fromEntries(defs.map(d => [d.name, d.icon]));

          const global = await steamGet('ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', { gameid: game.appid })
            .catch(() => ({}));
          const rates = global.achievementpercentages?.achievements || [];
          percents = Object.fromEntries(rates.map(r => [r.name, parseFloat(r.percent)]));
        }

        unlocked.forEach(achievement => {
          achievementMap[`${game.appid}_${achievement.apiname}`] = {
            gameId: game.appid,
            gameName: game.name,
            achievementName: achievement.name || achievement.apiname,
            achievementDescription: achievement.description || 'No description',
            achievementIconUrl: icons[achievement.apiname],
            earnedRate: percents[achievement.apiname],
            unlockTime: achievement.unlocktime,
            apiName: achievement.apiname
          };
        });
        games[game.appid] = lastPlayed;
      } catch (err) {
        // 403 means the profile's game details are private; no game will work
        if (err.status === 429) {
          throw new Error('Steam rate limit reached, will retry next check');
        }
        if (err.status === 403) {
          throw new Error(`achievements for ${steamId} are private (set Steam privacy "Game details" to Public)`);
        }
        // 400 means the game has no achievements
        if (err.status === 400) {
          games[game.appid] = lastPlayed;
          continue;
        }
        console.error(`Failed to fetch achievements for ${game.name}:`, err.message);
      }
    }

    achievementMap._games = games;
    return achievementMap;
  } catch (error) {
    console.error('Failed to fetch Steam achievements:', error.message);
    throw error;
  }
}

export function getNewAchievements(oldAchievements, newAchievements) {
  const newItems = [];

  for (const [achievementId, achievement] of Object.entries(newAchievements)) {
    if (achievementId.startsWith('_')) continue;
    if (!oldAchievements[achievementId]) {
      newItems.push(achievement);
    }
  }

  return newItems;
}
