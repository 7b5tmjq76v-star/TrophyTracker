import {
  exchangeNpssoForCode,
  exchangeCodeForAccessToken,
  exchangeRefreshTokenForAuthTokens,
  getProfileFromUserName,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
  getTitleTrophies
} from 'psn-api';

let npssoToken = null;
let authorizationCache = null;
let accessExpiresAt = 0;
let refreshExpiresAt = 0;
const accountIds = {};

// psn-api returns some API errors (rate limits, bad tokens) as { error } instead of throwing
async function psnCall(promise) {
  const result = await promise;
  if (result?.error) {
    throw new Error(`PSN API error ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function storeAuthorization(authorization) {
  authorizationCache = authorization;
  accessExpiresAt = Date.now() + authorization.expiresIn * 1000;
  refreshExpiresAt = Date.now() + authorization.refreshTokenExpiresIn * 1000;
  return authorization;
}

// Only switches to the new NPSSO once it has signed in successfully
export async function authenticatePSN(npsso) {
  try {
    const accessCode = await exchangeNpssoForCode(npsso);
    const authorization = await exchangeCodeForAccessToken(accessCode);
    npssoToken = npsso;
    return storeAuthorization(authorization);
  } catch (error) {
    console.error('PSN Authentication failed:', error.message);
    throw error;
  }
}

// Sets the NPSSO without signing in, so checks keep retrying if the first sign-in fails
export function configurePSN(npsso) {
  npssoToken = npsso;
}

export function isPSNConfigured() {
  return Boolean(npssoToken);
}

// Access tokens last ~1 hour; refresh them (or fall back to the NPSSO) before each check
async function getAuth() {
  if (!npssoToken) {
    throw new Error('PSN not configured. Please set NPSSO token.');
  }
  if (authorizationCache && Date.now() < accessExpiresAt - 60_000) {
    return { accessToken: authorizationCache.accessToken };
  }
  if (authorizationCache && Date.now() < refreshExpiresAt - 60_000) {
    try {
      storeAuthorization(await exchangeRefreshTokenForAuthTokens(authorizationCache.refreshToken));
      return { accessToken: authorizationCache.accessToken };
    } catch (error) {
      console.error('PSN token refresh failed, retrying with NPSSO:', error.message);
    }
  }
  try {
    await authenticatePSN(npssoToken);
  } catch (error) {
    const authError = new Error(`PSN sign-in failed, NPSSO expired or invalid: ${error.message}`);
    authError.authFailed = true;
    throw authError;
  }
  return { accessToken: authorizationCache.accessToken };
}

// The trophy API wants the numeric account ID, not the online ID users register with
async function getAccountId(auth, psnId) {
  if (!accountIds[psnId]) {
    const { profile } = await psnCall(getProfileFromUserName(auth, psnId));
    if (!profile?.accountId) {
      throw new Error(`PSN user ${psnId} not found`);
    }
    accountIds[psnId] = profile.accountId;
  }
  return accountIds[psnId];
}

// Returns trophies only for titles that changed since the last check, plus a
// `_titles` map of title -> lastUpdatedDateTime used to detect those changes
export async function getPSNTrophies(psnId, previous = {}) {
  try {
    const auth = await getAuth();
    const accountId = await getAccountId(auth, psnId);
    const { trophyTitles } = await psnCall(getUserTitles(auth, accountId, { limit: 800 }));

    if (!Array.isArray(trophyTitles)) {
      throw new Error(`no trophy list returned for ${psnId} (are their trophies public?)`);
    }

    const knownTitles = previous._titles || {};
    const titles = { ...knownTitles };
    const trophyMap = {};

    for (const title of trophyTitles) {
      if (!title.npCommunicationId) continue;

      const gameId = title.npCommunicationId;
      const gameName = title.trophyTitleName;
      if (knownTitles[gameId] === title.lastUpdatedDateTime) continue;

      try {
        const options = { npServiceName: title.npServiceName };
        const earned = await psnCall(getUserTrophiesEarnedForTitle(auth, accountId, gameId, 'all', options));
        const details = await psnCall(getTitleTrophies(auth, gameId, 'all', options));
        const detailById = Object.fromEntries((details.trophies || []).map(t => [t.trophyId, t]));

        (earned.trophies || []).forEach(trophy => {
          if (trophy.earned) {
            const detail = detailById[trophy.trophyId] || {};
            trophyMap[`${gameId}_${trophy.trophyId}`] = {
              gameId,
              gameName,
              trophyName: detail.trophyName || `Trophy #${trophy.trophyId}`,
              trophyDetail: detail.trophyDetail,
              trophyIconUrl: detail.trophyIconUrl,
              trophyType: trophy.trophyType,
              earnedRate: parseFloat(trophy.trophyEarnedRate),
              earnedDateTime: trophy.earnedDateTime,
              trophyId: trophy.trophyId
            };
          }
        });
        titles[gameId] = title.lastUpdatedDateTime;
      } catch (err) {
        // Rate limits and auth errors would hit every remaining title; abort without
        // saving so the next check retries cleanly
        if (/too many|rate|429|token|unauthori/i.test(err.message)) {
          throw err;
        }
        console.error(`Failed to fetch trophies for ${gameName}:`, err.message);
      }
    }

    trophyMap._titles = titles;
    return trophyMap;
  } catch (error) {
    console.error('Failed to fetch PSN trophies:', error.message);
    throw error;
  }
}

export function getNewTrophies(oldTrophies, newTrophies) {
  const newAchievements = [];

  for (const [trophyId, trophy] of Object.entries(newTrophies)) {
    if (trophyId.startsWith('_')) continue;
    if (!oldTrophies[trophyId]) {
      newAchievements.push(trophy);
    }
  }

  return newAchievements;
}
