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

module.exports = { isAuthorizedTabSession, isValidTabId };
