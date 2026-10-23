const CHAT_BURST_LIMIT = 8;
const CHAT_BURST_WINDOW_MS = 10_000;

function registerChatMessage(timestamps, now = Date.now()) {
    const recentTimestamps = Array.isArray(timestamps)
        ? timestamps.filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp > now - CHAT_BURST_WINDOW_MS)
        : [];
    if (recentTimestamps.length >= CHAT_BURST_LIMIT) {
        return { allowed: false, timestamps: recentTimestamps };
    }
    recentTimestamps.push(now);
    return { allowed: true, timestamps: recentTimestamps };
}

module.exports = {
    CHAT_BURST_LIMIT,
    CHAT_BURST_WINDOW_MS,
    registerChatMessage
};
