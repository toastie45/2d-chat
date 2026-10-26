(function exposeLevelProgression(root) {
    const LEVEL_REQUIREMENTS = [
        [15 * 60_000, 5], [60 * 60_000, 25], [3 * 60 * 60_000, 75], [7 * 60 * 60_000, 175],
        [14 * 60 * 60_000, 300], [25 * 60 * 60_000, 500], [40 * 60 * 60_000, 800],
        [60 * 60 * 60_000, 1200], [90 * 60 * 60_000, 1800], [130 * 60 * 60_000, 2600],
        [180 * 60 * 60_000, 3600], [250 * 60 * 60_000, 5000], [350 * 60 * 60_000, 7000],
        [500 * 60 * 60_000, 10000], [750 * 60 * 60_000, 15000], [1000 * 60 * 60_000, 20000],
        [1350 * 60 * 60_000, 27000], [1750 * 60 * 60_000, 35000], [2100 * 60 * 60_000, 42000],
        [2500 * 60 * 60_000, 50000]
    ];

    function getUserLevel(totalOnlineMs, acceptedChatMessages) {
        let level = 0;
        for (let index = 0; index < LEVEL_REQUIREMENTS.length; index += 1) {
            const [timeRequired, messagesRequired] = LEVEL_REQUIREMENTS[index];
            if (totalOnlineMs < timeRequired || acceptedChatMessages < messagesRequired) break;
            level = index + 1;
        }
        return Math.max(1, level);
    }

    const progression = { LEVEL_REQUIREMENTS, getUserLevel };
    if (typeof module !== 'undefined' && module.exports) module.exports = progression;
    if (root) root.ChatLevelProgression = progression;
}(typeof globalThis === 'undefined' ? this : globalThis));
