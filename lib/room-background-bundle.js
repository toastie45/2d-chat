const { cells } = require('../public/grid-layout');
const cellKeys = new Set(cells.map(({ col, row }) => `${col}:${row}`));

function prepareRoomBackgroundBundle({ overlay, openCells = [], closedCells = [], clearOverlay = false } = {}) {
    if (typeof clearOverlay !== 'boolean' || (clearOverlay && overlay !== undefined)) throw new Error('Ugyldigt valg af overlay.');
    if (![openCells, closedCells].every((list) => Array.isArray(list) && list.length <= 16 && list.every((key) => cellKeys.has(key)))
        || openCells.some((key) => closedCells.includes(key))) {
        throw new Error('Ugyldige felter til baggrunden.');
    }
    const bundle = { image: null, mimeType: null, transform: clearOverlay
        ? { x: 0, y: 0, rotation: 0, scale: 1, animation: { columns: 1, rows: 1, frames: 1, fps: 8 } } : null,
        replaceOverlay: clearOverlay || overlay !== undefined,
        layout: Object.fromEntries([...closedCells.map((key) => [key, 'closed']), ...openCells.map((key) => [key, 'open'])]) };
    if (overlay === undefined) return bundle;
    if (!overlay || !(overlay.image instanceof Uint8Array)) throw new Error('Ugyldigt pult-overlay.');
    const image = Buffer.from(overlay.image);
    const png = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp = image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
    if ((!png && !webp) || image.length > 850_000) throw new Error('Overlayet skal være PNG/WebP under 850 KB.');
    const animation = overlay.animation || { columns: 1, rows: 1, frames: 1, fps: 8 };
    const { columns, rows, frames, fps } = animation;
    if (![columns, rows, frames, fps].every(Number.isInteger) || columns < 1 || columns > 16
        || rows < 1 || rows > 256 || frames < 1 || frames > 256 || frames > columns * rows || fps < 1 || fps > 24) {
        throw new Error('Overlayets frame-indstillinger er ugyldige.');
    }
    return { ...bundle, image, mimeType: png ? 'image/png' : 'image/webp',
        transform: { x: 0, y: 0, rotation: 0, scale: 1, animation: { columns, rows, frames, fps } } };
}

module.exports = { prepareRoomBackgroundBundle };
