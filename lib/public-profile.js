const MAX_REAL_NAME_LENGTH = 80;
const MAX_PROFILE_TEXT_LENGTH = 500;
const MAX_DISCORD_NAME_LENGTH = 64;
const MAX_INTERESTS_LENGTH = 160;
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function normalizePublicProfile(value) {
    if (!value || typeof value !== 'object') return null;
    if (
        typeof value.realName !== 'string' ||
        typeof value.profileText !== 'string' ||
        typeof value.discordName !== 'string' ||
        typeof value.interests !== 'string'
    ) return null;

    const realName = value.realName.trim();
    const profileText = value.profileText.trim();
    const discordName = value.discordName.trim();
    const interests = value.interests.trim();
    if (
        [...realName].length > MAX_REAL_NAME_LENGTH ||
        [...profileText].length > MAX_PROFILE_TEXT_LENGTH ||
        [...discordName].length > MAX_DISCORD_NAME_LENGTH ||
        [...interests].length > MAX_INTERESTS_LENGTH
    ) return null;
    if ([realName, profileText, discordName, interests].some((field) => DISALLOWED_CONTROL_CHARACTERS.test(field))) return null;

    return { realName, profileText, discordName, interests };
}

module.exports = {
    MAX_DISCORD_NAME_LENGTH,
    MAX_INTERESTS_LENGTH,
    MAX_PROFILE_TEXT_LENGTH,
    MAX_REAL_NAME_LENGTH,
    normalizePublicProfile
};
