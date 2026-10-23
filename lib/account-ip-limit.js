const crypto = require('crypto');

const MAX_ACCOUNTS_PER_IP = 2;

function hashRegistrationIp(address, secret) {
    if (typeof address !== 'string' || !address.trim()) {
        throw new TypeError('A client IP address is required.');
    }
    if (typeof secret !== 'string' || !secret) {
        throw new TypeError('A secret is required to hash the client IP address.');
    }
    return crypto.createHmac('sha256', secret).update(address.trim()).digest('hex');
}

module.exports = { hashRegistrationIp, MAX_ACCOUNTS_PER_IP };
