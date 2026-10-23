const MAX_MESSAGE_LENGTH = 100;
const SECRET_PATTERNS = [
    /\brnd_[A-Za-z0-9_-]+/gi,
    /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gi,
    /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/gi,
    /\bsk-(?:live-)?[A-Za-z0-9_-]{16,}\b/gi,
    /\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/gi,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    /\bnpm_[A-Za-z0-9]{30,}\b/g,
    /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=?/gi,
    /\b(?:postgres(?:ql)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s]+/gi,
    /\b(password|passwd|passcode|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
];

function redactSecrets(text) {
    return SECRET_PATTERNS.reduce(
        (result, pattern) => result.replace(pattern, '[skjult hemmelighed]'),
        text
    );
}

function sanitizeChatMessage(value) {
    if (typeof value !== 'string') return '';
    return [...redactSecrets(value.trim())].slice(0, MAX_MESSAGE_LENGTH).join('');
}

function normalizeUsername(value) {
    if (typeof value !== 'string') return null;
    const username = value.normalize('NFKC').trim();
    if (!/^[\p{L}\p{N}_.-]{3,18}$/u.test(username)) return null;
    return { username, normalized: username.toLocaleLowerCase('en-US') };
}

function isValidPassword(value) {
    if (typeof value !== 'string') return false;
    const length = Buffer.byteLength(value, 'utf8');
    return length >= 8 && length <= 72;
}

module.exports = {
    MAX_MESSAGE_LENGTH,
    isValidPassword,
    normalizeUsername,
    redactSecrets,
    sanitizeChatMessage
};
