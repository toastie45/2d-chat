const MAX_REAL_NAME_LENGTH = 80;
const MAX_PROFILE_TEXT_LENGTH = 500;
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function normalizePublicProfile(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.realName !== 'string' || typeof value.profileText !== 'string') return null;

    const realName = value.realName.trim();
    const profileText = value.profileText.trim();
    if ([...realName].length > MAX_REAL_NAME_LENGTH || [...profileText].length > MAX_PROFILE_TEXT_LENGTH) return null;
    if (DISALLOWED_CONTROL_CHARACTERS.test(realName) || DISALLOWED_CONTROL_CHARACTERS.test(profileText)) return null;

    return { realName, profileText };
}

module.exports = {
    MAX_PROFILE_TEXT_LENGTH,
    MAX_REAL_NAME_LENGTH,
    normalizePublicProfile
};
