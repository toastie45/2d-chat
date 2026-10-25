const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isValidPassword,
    normalizeUsername,
    redactSecrets,
    sanitizeChatMessage
} = require('../lib/chat-security');
const {
    getTabSessionCookieName,
    isAuthorizedTabSession,
    isValidTabId,
    mapTabSessionCookie,
    renameSessionSetCookie
} = require('../lib/tab-session');
const { hashRegistrationIp, MAX_ACCOUNTS_PER_IP } = require('../lib/account-ip-limit');
const { calculateAge, getPostalTown, normalizePublicProfile } = require('../lib/public-profile');
const { CHAT_BURST_LIMIT, CHAT_BURST_WINDOW_MS, registerChatMessage } = require('../lib/chat-rate-limit');
const { GUESTBOOK_MESSAGE_MAX_LENGTH, normalizeGuestbookMessage } = require('../lib/guestbook');
const { USER_SEARCH_RESULT_LIMIT, getUserSearchPatterns } = require('../lib/user-search');

test('redacts Render and GitHub tokens before a message is stored', () => {
    const message = redactSecrets('Render rnd_exampleToken123456789 GitHub ghp_abcdefghijklmnopqrstuvwxyz');

    assert.equal(message.includes('rnd_'), false);
    assert.equal(message.includes('ghp_'), false);
    assert.equal((message.match(/\[skjult hemmelighed\]/g) || []).length, 2);
});

test('redacts credentials, API keys and connection strings', () => {
    const message = redactSecrets('password=hunter2 api_key=abc123 postgres://user:secret@db.example/chat');

    assert.doesNotMatch(message, /hunter2|abc123|postgres:\/\//);
    assert.equal((message.match(/\[skjult hemmelighed\]/g) || []).length, 3);
});

test('redacts bearer tokens and JWTs', () => {
    const message = redactSecrets('Bearer abcdefghijklmnopqrst eyJabcdefgh.ijklmnopq.rstuvwxyz123');

    assert.doesNotMatch(message, /Bearer|eyJ|abcdefghijklmnopqrst/);
    assert.equal((message.match(/\[skjult hemmelighed\]/g) || []).length, 2);
});

test('sanitizes before enforcing the 100-character message limit', () => {
    const message = sanitizeChatMessage(`Hi rnd_exampleToken123456789 ${'x'.repeat(110)}`);

    assert.equal([...message].length, 100);
    assert.doesNotMatch(message, /rnd_/);
});

test('validates and normalizes account usernames', () => {
    assert.deepEqual(normalizeUsername(' Tést_Name '), {
        username: 'Tést_Name',
        normalized: 'tést_name'
    });
    assert.equal(normalizeUsername('Tommy').normalized, normalizeUsername('tommy').normalized);
    assert.equal(normalizeUsername('ab'), null);
    assert.equal(normalizeUsername('bad name'), null);
});

const EMPTY_PROFILE = {
    realName: '', profileText: '', discordName: '', interests: '',
    steamName: '', facebookName: '', birthDate: '', postalCode: ''
};

test('normalizes optional public profile fields and enforces safe limits', () => {
    assert.deepEqual(normalizePublicProfile({
        realName: '  Ada Lovelace ',
        profileText: '  Hej\nmed dig  ',
        discordName: '  ada#1234 ',
        interests: '  programmering, bøger  ',
        steamName: ' ada_steam ',
        facebookName: ' Ada L ',
        birthDate: '2006-07-08',
        postalCode: ' 7560 '
    }), {
        realName: 'Ada Lovelace',
        profileText: 'Hej\nmed dig',
        discordName: 'ada#1234',
        interests: 'programmering, bøger',
        steamName: 'ada_steam',
        facebookName: 'Ada L',
        birthDate: '2006-07-08',
        postalCode: '7560'
    });
    assert.deepEqual(normalizePublicProfile(EMPTY_PROFILE), EMPTY_PROFILE);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, realName: 'A'.repeat(81) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, profileText: 'A'.repeat(501) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, discordName: 'd'.repeat(65) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, interests: 'i'.repeat(161) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, steamName: 's'.repeat(65) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, facebookName: 'f'.repeat(81) }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, realName: 'Ada\u0000' }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, birthDate: '2006-02-30' }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, birthDate: '1899-12-31' }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, birthDate: '2099-01-01' }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, postalCode: '0000' }), null);
    assert.equal(normalizePublicProfile({ ...EMPTY_PROFILE, postalCode: 'abcd' }), null);
    assert.equal(normalizePublicProfile({ realName: '', profileText: '', discordName: '', interests: '' }), null);
});

test('derives age and town from birth date and postal code', () => {
    const now = new Date(2026, 9, 25);
    assert.equal(calculateAge('2006-07-08', now), 20);
    assert.equal(calculateAge('2006-10-25', now), 20);
    assert.equal(calculateAge('2006-10-26', now), 19);
    assert.equal(calculateAge(null, now), null);
    assert.equal(getPostalTown('7560'), 'Hjerm');
    assert.equal(getPostalTown('8000'), 'Aarhus C');
    assert.equal(getPostalTown('constructor'), null);
});

test('allows eight rapid chat messages and blocks the ninth within ten seconds', () => {
    let timestamps = [];
    for (let index = 0; index < CHAT_BURST_LIMIT; index++) {
        const result = registerChatMessage(timestamps, 1000 + index);
        assert.equal(result.allowed, true);
        timestamps = result.timestamps;
    }

    assert.equal(registerChatMessage(timestamps, 1008).allowed, false);
    assert.equal(registerChatMessage(timestamps, 1000 + CHAT_BURST_WINDOW_MS).allowed, true);
});

test('matches mentions as whole usernames without marking other recipients', () => {
    const isMentioned = (text, username) => {
        const escapedName = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
            `(^|[^\\p{L}\\p{N}_-])${escapedName}(?=$|[^\\p{L}\\p{N}_-])`,
            'iu'
        ).test(text);
    };

    assert.equal(isMentioned('Tommy kom lige med et æble.', 'Tommy'), true);
    assert.equal(isMentioned('Tommy2 kom lige med et æble.', 'Tommy'), false);
    assert.equal(isMentioned('Tommy kom lige med et æble.', 'Nico'), false);
});

test('normalizes guestbook messages and enforces safe length and characters', () => {
    assert.equal(normalizeGuestbookMessage('  Hej Tommy!  '), 'Hej Tommy!');
    assert.equal(normalizeGuestbookMessage(''), null);
    assert.equal(normalizeGuestbookMessage('x'.repeat(GUESTBOOK_MESSAGE_MAX_LENGTH + 1)), null);
    assert.equal(normalizeGuestbookMessage('Hej\u0000'), null);
    assert.equal(normalizeGuestbookMessage(123), null);
});

test('accepts passwords only from 8 to 72 UTF-8 bytes', () => {
    assert.equal(isValidPassword('12345678'), true);
    assert.equal(isValidPassword('short'), false);
    assert.equal(isValidPassword('é'.repeat(37)), false);
});

test('binds an authenticated session to its browser tab', () => {
    const tabId = '9bba85cc-775a-4a64-9cbd-e399354ee53f';
    const session = { user: { id: '1' }, tabId };

    assert.equal(isValidTabId(tabId), true);
    assert.equal(isAuthorizedTabSession(session, tabId), true);
    assert.equal(isAuthorizedTabSession(session, '83a4fd62-6a39-4ec0-9845-1a0ecad19e52'), false);
    assert.equal(isAuthorizedTabSession(session, null), false);
    assert.equal(isAuthorizedTabSession({ tabId }, tabId), false);
});

test('rejects malformed browser tab identifiers', () => {
    assert.equal(isValidTabId(''), false);
    assert.equal(isValidTabId('not-a-uuid'), false);
    assert.equal(isValidTabId('9bba85cc-775a-4a64-9cbd-e399354ee53z'), false);
});

test('isolates authentication cookies per browser tab', () => {
    const firstTabId = '9bba85cc-775a-4a64-9cbd-e399354ee53f';
    const secondTabId = '83a4fd62-6a39-4ec0-9845-1a0ecad19e52';
    const firstCookieName = getTabSessionCookieName(firstTabId);
    const secondCookieName = getTabSessionCookieName(secondTabId);
    const cookies = `${firstCookieName}=first-session; ${secondCookieName}=second-session; chat.sid=stale-shared-session`;

    assert.notEqual(firstCookieName, secondCookieName);
    assert.equal(mapTabSessionCookie(cookies, firstTabId), 'chat.sid=first-session');
    assert.equal(mapTabSessionCookie(cookies, secondTabId), 'chat.sid=second-session');
    assert.equal(mapTabSessionCookie('chat.sid=stale-shared-session', firstTabId), '');
    assert.equal(
        renameSessionSetCookie('chat.sid=new-session; Path=/; HttpOnly', firstTabId),
        `${firstCookieName}=new-session; Path=/; HttpOnly`
    );
});

test('hashes registration IPs without storing their raw address', () => {
    const address = '192.0.2.10';
    const secret = 'test-session-secret';
    const hash = hashRegistrationIp(address, secret);

    assert.equal(hash, hashRegistrationIp(address, secret));
    assert.notEqual(hash, hashRegistrationIp(address, 'different-secret'));
    assert.notEqual(hash, hashRegistrationIp('192.0.2.11', secret));
    assert.equal(hash.includes(address), false);
    assert.equal(MAX_ACCOUNTS_PER_IP, 2);
});

test('requires a usable IP and secret to create an IP hash', () => {
    assert.throws(() => hashRegistrationIp('', 'secret'), TypeError);
    assert.throws(() => hashRegistrationIp('192.0.2.10', ''), TypeError);
});

test('builds escaped username search patterns', () => {
    assert.deepEqual(getUserSearchPatterns('  BoD '), { query: 'bod', contains: '%bod%', prefix: 'bod%' });
    assert.deepEqual(getUserSearchPatterns('a_b%c\\'), {
        query: 'a_b%c\\',
        contains: '%a\\_b\\%c\\\\%',
        prefix: 'a\\_b\\%c\\\\%'
    });
    assert.equal(getUserSearchPatterns('ＢＯＤ').query, 'bod');
    assert.equal(getUserSearchPatterns('   '), null);
    assert.equal(getUserSearchPatterns('x'.repeat(19)), null);
    assert.equal(getUserSearchPatterns(42), null);
    assert.equal(USER_SEARCH_RESULT_LIMIT, 20);
});
