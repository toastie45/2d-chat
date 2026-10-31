const test = require('node:test');
const assert = require('node:assert/strict');
const { BOBS_INTERVAL_MS, getEarnedBobs } = require('../lib/bobs-economy');

test('online time awards exactly ten Bobs per hour', () => {
    assert.equal(getEarnedBobs(0), 0);
    assert.equal(getEarnedBobs(BOBS_INTERVAL_MS - 1), 0);
    assert.equal(getEarnedBobs(BOBS_INTERVAL_MS), 1);
    assert.equal(getEarnedBobs(60 * 60 * 1000), 10);
    assert.equal(getEarnedBobs(2500 * 60 * 60 * 1000), 25000);
});

test('invalid online time never creates currency', () => {
    for (const value of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(getEarnedBobs(value), 0);
    }
});
