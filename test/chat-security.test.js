const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isValidPassword,
    normalizeUsername,
    redactSecrets,
    sanitizeChatMessage
} = require('../lib/chat-security');
const { isAuthorizedTabSession, isValidTabId } = require('../lib/tab-session');
const { hashRegistrationIp, MAX_ACCOUNTS_PER_IP } = require('../lib/account-ip-limit');

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
    assert.equal(normalizeUsername('ab'), null);
    assert.equal(normalizeUsername('bad name'), null);
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
