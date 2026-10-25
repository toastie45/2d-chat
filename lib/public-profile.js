const POSTAL_TOWNS = require('./dk-postal-codes.json');

const MAX_REAL_NAME_LENGTH = 80;
const MAX_PROFILE_TEXT_LENGTH = 500;
const MAX_DISCORD_NAME_LENGTH = 64;
const MAX_INTERESTS_LENGTH = 160;
const MAX_STEAM_NAME_LENGTH = 64;
const MAX_FACEBOOK_NAME_LENGTH = 80;
const MIN_BIRTH_YEAR = 1900;
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function getPostalTown(postalCode) {
    return typeof postalCode === 'string' && Object.hasOwn(POSTAL_TOWNS, postalCode) ? POSTAL_TOWNS[postalCode] : null;
}

function normalizeBirthDate(value, now = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    if (year < MIN_BIRTH_YEAR || date.getTime() > now.getTime()) return null;
    return value;
}

function calculateAge(birthDate, now = new Date()) {
    const value = birthDate instanceof Date ? birthDate.toISOString().slice(0, 10) : birthDate;
    if (typeof value !== 'string' || !normalizeBirthDate(value.slice(0, 10), now)) return null;
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    let age = now.getFullYear() - year;
    if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) age -= 1;
    return age;
}

function normalizePublicProfile(value, now = new Date()) {
    if (!value || typeof value !== 'object') return null;
    const fields = ['realName', 'profileText', 'discordName', 'interests', 'steamName', 'facebookName', 'birthDate', 'postalCode'];
    if (fields.some((field) => typeof value[field] !== 'string')) return null;

    const [realName, profileText, discordName, interests, steamName, facebookName, birthDate, postalCode] =
        fields.map((field) => value[field].trim());
    if (
        [...realName].length > MAX_REAL_NAME_LENGTH ||
        [...profileText].length > MAX_PROFILE_TEXT_LENGTH ||
        [...discordName].length > MAX_DISCORD_NAME_LENGTH ||
        [...interests].length > MAX_INTERESTS_LENGTH ||
        [...steamName].length > MAX_STEAM_NAME_LENGTH ||
        [...facebookName].length > MAX_FACEBOOK_NAME_LENGTH
    ) return null;
    if ([realName, profileText, discordName, interests, steamName, facebookName].some((field) => DISALLOWED_CONTROL_CHARACTERS.test(field))) return null;
    if (birthDate && !normalizeBirthDate(birthDate, now)) return null;
    if (postalCode && !getPostalTown(postalCode)) return null;

    return { realName, profileText, discordName, interests, steamName, facebookName, birthDate, postalCode };
}

module.exports = {
    MAX_DISCORD_NAME_LENGTH,
    MAX_FACEBOOK_NAME_LENGTH,
    MAX_INTERESTS_LENGTH,
    MAX_PROFILE_TEXT_LENGTH,
    MAX_REAL_NAME_LENGTH,
    MAX_STEAM_NAME_LENGTH,
    calculateAge,
    getPostalTown,
    normalizePublicProfile
};
