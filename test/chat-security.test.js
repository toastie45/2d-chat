const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isValidPassword,
    normalizeUsername,
    redactSecrets,
    sanitizeChatMessage
} = require('../lib/chat-security');

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
