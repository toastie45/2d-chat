function normalizeRoomLevel(value = 1) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 20 ? level : null;
}

function publicRoomAccessError(policy, isAdmin, level = 1) {
    if (!policy) return 'Rummet findes ikke.';
    if (isAdmin) return '';
    if (policy.is_hidden) return 'Rummet findes ikke.';
    if (policy.is_locked) return 'Rummet er låst for deltagere lige nu.';
    if (level < (Number(policy.required_level) || 1)) return `Du skal være level ${policy.required_level} for at gå ind i rummet.`;
    return '';
}

function parsePrisonRoomNumber(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:\/tr\s+)?([1-9]\d{0,18})$/i.exec(value.trim());
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    return match[1];
}

module.exports = { normalizeRoomLevel, publicRoomAccessError, parsePrisonRoomNumber };
