const GUESTBOOK_MESSAGE_MAX_LENGTH = 300;
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function normalizeGuestbookMessage(value) {
    if (typeof value !== 'string') return null;
    const message = value.trim();
    if (
        !message ||
        [...message].length > GUESTBOOK_MESSAGE_MAX_LENGTH ||
        DISALLOWED_CONTROL_CHARACTERS.test(message)
    ) return null;
    return message;
}

module.exports = { GUESTBOOK_MESSAGE_MAX_LENGTH, normalizeGuestbookMessage };
