const TAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidTabId(tabId) {
    return typeof tabId === 'string' && TAB_ID_PATTERN.test(tabId);
}

function isAuthorizedTabSession(session, tabId) {
    return Boolean(
        session &&
        session.user &&
        isValidTabId(tabId) &&
        session.tabId === tabId
    );
}

function getTabSessionCookieName(tabId) {
    return isValidTabId(tabId) ? `chat.tab.${tabId}` : null;
}

function mapTabSessionCookie(cookieHeader, tabId, sessionCookieName = 'chat.sid') {
    const tabCookieName = getTabSessionCookieName(tabId);
    if (!tabCookieName) return cookieHeader || '';

    const cookies = String(cookieHeader || '').split(';').map((cookie) => cookie.trim()).filter(Boolean);
    const tabCookie = cookies.find((cookie) => cookie.startsWith(`${tabCookieName}=`));
    const remainingCookies = cookies.filter((cookie) =>
        !cookie.startsWith(`${sessionCookieName}=`) &&
        !cookie.startsWith('chat.tab.')
    );
    if (tabCookie) {
        remainingCookies.push(`${sessionCookieName}=${tabCookie.slice(tabCookieName.length + 1)}`);
    }
    return remainingCookies.join('; ');
}

function renameSessionSetCookie(value, tabId, sessionCookieName = 'chat.sid') {
    const tabCookieName = getTabSessionCookieName(tabId);
    if (!tabCookieName) return value;
    const rename = (cookie) => typeof cookie === 'string' && cookie.startsWith(`${sessionCookieName}=`)
        ? `${tabCookieName}=${cookie.slice(sessionCookieName.length + 1)}`
        : cookie;
    return Array.isArray(value) ? value.map(rename) : rename(value);
}

module.exports = {
    getTabSessionCookieName,
    isAuthorizedTabSession,
    isValidTabId,
    mapTabSessionCookie,
    renameSessionSetCookie
};
