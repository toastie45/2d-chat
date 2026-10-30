(function (root) {
    'use strict';

    function validate(settings, width, height) {
        const { columns, rows, frames, fps } = settings;
        if (![columns, rows, frames, fps].every(Number.isInteger)
            || columns < 1 || columns > 16 || rows < 1 || rows > 256
            || frames < 2 || frames > 256 || fps < 1 || fps > 24) {
            return 'Et spritesheet skal have mindst 2 frames. Brug hele tal og FPS mellem 1 og 24.';
        }
        if (frames > columns * rows) return 'Der er flere frames end felter i gitteret.';
        if (width && height && (width % columns !== 0 || height % rows !== 0)) {
            return 'Billedets mål skal kunne deles præcist med kolonner og rækker.';
        }
        return '';
    }

    // Compare small versions of the actual frames, rather than guessing a grid from the filename.
    function hasDistinctFrames(image, settings, createCanvas = () => document.createElement('canvas')) {
        const canvas = createCanvas();
        canvas.width = 48;
        canvas.height = 32;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const width = image.naturalWidth / settings.columns;
        const height = image.naturalHeight / settings.rows;
        let first;
        for (let frame = 0; frame < settings.frames; frame++) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, (frame % settings.columns) * width,
                Math.floor(frame / settings.columns) * height, width, height,
                0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            if (!first) first = new Uint8ClampedArray(pixels);
            else if (pixels.some((value, index) => Math.abs(value - first[index]) > 6)) return true;
        }
        return false;
    }

    function previewFrames(settings) {
        return Array.from({ length: settings.frames + 1 }, (_, index) => {
            const frame = index % settings.frames;
            return {
                offset: index / settings.frames,
                transform: `translate(${-100 * (frame % settings.columns) / settings.columns}%, ${-100 * Math.floor(frame / settings.columns) / settings.rows}%)`,
                easing: 'steps(1, end)'
            };
        });
    }

    let catalogPromise;
    function loadCatalog() {
        if (!catalogPromise) {
            catalogPromise = fetch('/room-backgrounds.json', { cache: 'no-cache' })
                .then(async (response) => {
                    if (!response.ok) throw new Error('Baggrundslisten kunne ikke hentes.');
                    const catalog = await response.json();
                    if (!Array.isArray(catalog.backgrounds)) throw new Error('Baggrundslisten er ugyldig.');
                    for (const background of catalog.backgrounds) {
                        if (typeof background.id !== 'string' || typeof background.name !== 'string'
                            || typeof background.url !== 'string' || !background.url.startsWith('/images/')
                            || validate(background.animation || {})) throw new Error('En baggrund har ugyldige indstillinger.');
                        if (background.overlay && (typeof background.overlay.url !== 'string'
                            || !background.overlay.url.startsWith('/images/')
                            || validate(background.overlay.animation || {}))) throw new Error('Overlayets indstillinger er ugyldige.');
                    }
                    return catalog.backgrounds;
                }).catch((error) => {
                    catalogPromise = null;
                    throw error;
                });
        }
        return catalogPromise;
    }

    const api = { validate, hasDistinctFrames, previewFrames, loadCatalog };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.RoomSpritesheet = api;
})(typeof window === 'undefined' ? globalThis : window);
