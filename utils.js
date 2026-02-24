function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePairs(raw) {
    if (!raw) return [];
    return String(raw)
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

module.exports = {
    sleep,
    isFiniteNumber,
    parsePairs,
};
