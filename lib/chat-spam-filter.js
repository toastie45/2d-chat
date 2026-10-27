const SPAM_HISTORY_WINDOW_MS = 3 * 60 * 1000;
const SPAM_HISTORY_LIMIT = 8;
const MIN_REPEAT_COMPARISON_LENGTH = 3;
const MIN_NEAR_REPEAT_LENGTH = 14;
const NEAR_REPEAT_SIMILARITY = 0.92;

function normalizeForSpamComparison(message) {
    return String(message || '')
        .normalize('NFKC')
        .toLocaleLowerCase('da-DK')
        .replace(/[\p{P}\s]+/gu, '');
}

function hasExcessiveCharacterRun(message) {
    let previous = '';
    let runLength = 0;
    for (const character of String(message || '').normalize('NFKC').toLocaleLowerCase('da-DK')) {
        if (/\s/u.test(character)) continue;
        runLength = character === previous ? runLength + 1 : 1;
        previous = character;
        if (runLength >= 10) return true;
    }
    return false;
}

function hasRepeatedWordPattern(message) {
    const words = String(message || '').toLocaleLowerCase('da-DK').match(/[\p{L}\p{N}]+/gu) || [];
    if (words.length < 6) return false;
    return new Set(words).size <= Math.max(2, Math.floor(words.length * 0.25));
}

function similarity(first, second) {
    if (!first || !second) return 0;
    if (first === second) return 1;
    const maxLength = Math.max(first.length, second.length);
    if (Math.abs(first.length - second.length) / maxLength > 1 - NEAR_REPEAT_SIMILARITY) return 0;

    let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
    for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
        const currentRow = [firstIndex];
        for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
            currentRow[secondIndex] = Math.min(
                currentRow[secondIndex - 1] + 1,
                previousRow[secondIndex] + 1,
                previousRow[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
            );
        }
        previousRow = currentRow;
    }
    return 1 - previousRow[second.length] / maxLength;
}

function analyzeProgressionMessage(message, recentMessages = [], now = Date.now()) {
    if (Array.from(String(message || '').trim()).length < 3) {
        return { countsForProgression: false, reason: 'too-short' };
    }
    const normalized = normalizeForSpamComparison(message);
    const characters = Array.from(normalized);
    if (hasExcessiveCharacterRun(message)) return { countsForProgression: false, reason: 'character-spam' };
    if (hasRepeatedWordPattern(message)) return { countsForProgression: false, reason: 'repeated-words' };
    if (characters.length === 0) return { countsForProgression: false, reason: 'symbol-spam' };

    const relevantHistory = Array.isArray(recentMessages)
        ? recentMessages.filter((entry) => {
            const createdAt = entry.createdAt instanceof Date
                ? entry.createdAt.getTime()
                : typeof entry.createdAt === 'number'
                    ? entry.createdAt
                    : new Date(entry.createdAt).getTime();
            return Number.isFinite(createdAt) && createdAt >= now - SPAM_HISTORY_WINDOW_MS;
        }).slice(0, SPAM_HISTORY_LIMIT)
        : [];

    if (characters.length >= MIN_REPEAT_COMPARISON_LENGTH) {
        for (const entry of relevantHistory) {
            const previous = normalizeForSpamComparison(entry.message);
            if (Array.from(previous).length < MIN_REPEAT_COMPARISON_LENGTH) continue;
            if (normalized === previous) return { countsForProgression: false, reason: 'repeated-message' };
            if (
                characters.length >= MIN_NEAR_REPEAT_LENGTH &&
                Array.from(previous).length >= MIN_NEAR_REPEAT_LENGTH &&
                similarity(normalized, previous) >= NEAR_REPEAT_SIMILARITY
            ) {
                return { countsForProgression: false, reason: 'near-duplicate-message' };
            }
        }
    }

    return { countsForProgression: true, reason: null };
}

module.exports = {
    analyzeProgressionMessage,
    SPAM_HISTORY_LIMIT,
    SPAM_HISTORY_WINDOW_MS
};
