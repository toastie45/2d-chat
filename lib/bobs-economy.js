const BOBS_INTERVAL_MS = 6 * 60 * 1000;

function getEarnedBobs(totalOnlineMs) {
    const milliseconds = Number(totalOnlineMs);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
    return Math.floor(milliseconds / BOBS_INTERVAL_MS);
}

module.exports = { BOBS_INTERVAL_MS, getEarnedBobs };
