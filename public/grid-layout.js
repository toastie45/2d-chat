(function exposeGridLayout(root, createGridLayout) {
    const layout = createGridLayout();
    if (typeof module === 'object' && module.exports) {
        module.exports = layout;
    } else {
        root.ChatGridLayout = layout;
    }
})(globalThis, function createGridLayout() {
    const cellSize = 90;
    const width = 540;
    const height = 360;
    const columns = Math.floor(width / cellSize);
    const rows = Math.floor(height / cellSize);
    const left = (width - columns * cellSize) / 2;
    const top = (height - rows * cellSize) / 2;
    const cells = [];

    function coordinateForCenter(x, y) {
        const offsetX = x - (width / 2 - cellSize / 2);
        const offsetY = y - top - cellSize / 2;
        return {
            col: Math.round((offsetX + offsetY) / cellSize),
            row: Math.round((offsetY - offsetX) / cellSize)
        };
    }

    function positionFor(col, row) {
        return {
            x: width / 2 - cellSize / 2 + (col - row) * cellSize / 2,
            y: top + cellSize / 2 + (col + row) * cellSize / 2
        };
    }

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
            const x = left + cellSize / 2 + col * cellSize;
            const y = top + cellSize / 2 + row * cellSize;
            const coordinate = coordinateForCenter(x, y);
            cells.push({ ...coordinate, ...positionFor(coordinate.col, coordinate.row), kind: 'primary' });
        }
    }

    for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < columns - 1; col++) {
            const x = left + cellSize + col * cellSize;
            const y = top + cellSize + row * cellSize;
            const coordinate = coordinateForCenter(x, y);
            cells.push({ ...coordinate, ...positionFor(coordinate.col, coordinate.row), kind: 'intermediate' });
        }
    }

    return Object.freeze({
        width,
        height,
        cellSize,
        columns,
        rows,
        left,
        top,
        positionFor,
        cells: Object.freeze(cells.map((cell) => Object.freeze(cell)))
    });
});
