const USER_SEARCH_MAX_LENGTH = 18;
const USER_SEARCH_RESULT_LIMIT = 20;

function normalizeUserSearchQuery(value) {
    if (typeof value !== 'string') return null;
    const query = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (!query || [...query].length > USER_SEARCH_MAX_LENGTH) return null;
    return query;
}

function getUserSearchPatterns(value) {
    const query = normalizeUserSearchQuery(value);
    if (!query) return null;
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    return { query, contains: `%${escaped}%`, prefix: `${escaped}%` };
}

module.exports = { USER_SEARCH_RESULT_LIMIT, getUserSearchPatterns, normalizeUserSearchQuery };
