const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, previewFrames, hasDistinctFrames } = require('../public/room-spritesheet');

const settings = { columns: 2, rows: 2, frames: 4, fps: 3 };

test('room spritesheets require multiple frames and an exact, valid grid', () => {
    assert.equal(validate(settings, 3072, 2048), '');
    assert.notEqual(validate({ ...settings, frames: 1 }), '');
    assert.notEqual(validate({ ...settings, frames: 5 }), '');
    assert.notEqual(validate({ ...settings, fps: 0 }), '');
    assert.notEqual(validate({ ...settings, rows: 3 }, 3072, 2048), '');
    assert.notEqual(validate({ ...settings, columns: 1.5 }), '');
});

test('preview visits each frame in row order, then loops without sliding', () => {
    assert.deepEqual(previewFrames(settings).map((frame) => frame.transform), [
        'translate(0%, 0%)', 'translate(-50%, 0%)',
        'translate(0%, -50%)', 'translate(-50%, -50%)', 'translate(0%, 0%)'
    ]);
    assert.ok(previewFrames(settings).every((frame) => frame.easing === 'steps(1, end)'));
    const vertical = previewFrames({ columns: 1, rows: 16, frames: 16 });
    assert.equal(vertical[15].transform, 'translate(0%, -93.75%)');
    assert.equal(vertical[16].transform, 'translate(0%, 0%)');
});

test('identical frames are rejected while a visible change is detected', () => {
    const image = { naturalWidth: 3072, naturalHeight: 2048 };
    let currentFrame = 0;
    let different = false;
    const positions = [];
    const context = {
        clearRect() {},
        drawImage(_image, x, y, width, height) {
            currentFrame = x / width + y / height * settings.columns;
            positions.push([x, y]);
        },
        getImageData() { return { data: new Uint8ClampedArray([different && currentFrame === 3 ? 120 : 100, 0, 0, 255]) }; }
    };
    const createCanvas = () => ({ getContext: () => context });
    assert.equal(hasDistinctFrames(image, settings, createCanvas), false);
    assert.deepEqual(positions, [[0, 0], [1536, 0], [0, 1024], [1536, 1024]]);
    different = true;
    assert.equal(hasDistinctFrames(image, settings, createCanvas), true);
});
