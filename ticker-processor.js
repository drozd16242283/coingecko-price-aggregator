const { MAX_STALENESS_MS } = require('./config');

const TARGET_QUOTE = 'USDT';

const INVALID_DATA_REASON = Object.freeze({
    API_ERROR: 'API_ERROR',
    MISSING_EXCHANGE_DATA: 'MISSING_EXCHANGE_DATA',
    NO_USDT_PAIR: 'NO_USDT_PAIR',
    STALE_PRICE: 'STALE_PRICE',
    NO_VALID_TICKER: 'NO_VALID_TICKER',
});

function buildDataQuality(expectedExchangeCount, contributingExchangeCount, missingExchanges, statusOverride) {
    const reasonCounts = missingExchanges.reduce((acc, m) => {
        acc[m.reason] = (acc[m.reason] || 0) + 1;
        return acc;
    }, {});

    const status =
        statusOverride ||
        (contributingExchangeCount === 0
            ? 'NO_DATA'
            : contributingExchangeCount < expectedExchangeCount
                ? 'PARTIAL'
                : 'OK');

    return {
        expectedExchangeCount,
        contributingExchangeCount,
        status,
        reasons: Object.keys(reasonCounts),
        reasonCounts,
        apiErrorCount: reasonCounts[INVALID_DATA_REASON.API_ERROR] || 0,
    };
}

function isFreshTicker(ticker, nowMs) {
    const price = Number(ticker?.last);
    if (!Number.isFinite(price) || price <= 0) return false;
    if (ticker?.is_anomaly === true) return false;
    if (ticker?.is_stale === true) return false;

    if (!ticker?.last_traded_at) return true;

    const ts = Date.parse(ticker.last_traded_at);
    if (!Number.isFinite(ts)) return false;

    return nowMs - ts <= MAX_STALENESS_MS;
}

/**
    * Handles data-quality issues:
    * - MISSING_EXCHANGE_DATA: exchange has no tickers for coin
    * - NO_USDT_PAIR: exchange has tickers but no USDT pair
    * - API_ERROR: API request for ticker fetch failed (caller passes fetchError)
    * - STALE_PRICE: all USDT tickers are stale (is_stale=true or is_anomaly=true or old timestamp)
    * - NO_VALID_TICKER: fallback when ticker is not fresh and not stale (unknown error)
*/
function processTickersForCoin({ runId, coinId, symbol, name, tickers = [], topExchanges = [], fetchError = null }) {
    const now = Date.now();
    const upperSymbol = String(symbol || '').toUpperCase();

    // Edge case: USDT priced in USDT = SYNTHETIC_PARITY
    if (upperSymbol === 'USDT' || coinId === 'tether') {
        return {
            runId,
            coinId,
            symbol: upperSymbol,
            pair: `${upperSymbol}/${TARGET_QUOTE}`,
            name,
            averagePriceUsdt: 1,
            contributingExchanges: [],
            missingExchanges: [],
            quality: buildDataQuality(topExchanges.length, 0, [], 'SYNTHETIC_PARITY'),
            collectedAt: new Date(),
        };
    }

    if (fetchError) {
        const missingExchanges = topExchanges.map((ex) => ({
            exchangeId: ex.id,
            exchangeName: ex.name,
            reason: INVALID_DATA_REASON.API_ERROR,
            details: { message: fetchError },
        }));

        return {
            runId,
            coinId,
            symbol: upperSymbol,
            pair: `${upperSymbol}/${TARGET_QUOTE}`,
            name,
            averagePriceUsdt: null,
            contributingExchanges: [],
            missingExchanges,
            quality: buildDataQuality(topExchanges.length, 0, missingExchanges),
            collectedAt: new Date(),
        };
    }

    const contributingExchanges = [];
    const missingExchanges = [];

    for (const ex of topExchanges) {
        const exchangeTickers = tickers.filter((t) => t?.market?.identifier === ex.id);

        if (exchangeTickers.length === 0) {
            missingExchanges.push({
                exchangeId: ex.id,
                exchangeName: ex.name,
                reason: INVALID_DATA_REASON.MISSING_EXCHANGE_DATA,
            });
            continue;
        }

        const usdtTickers = exchangeTickers.filter(
            (t) => String(t?.target || '').toUpperCase() === TARGET_QUOTE,
        );

        if (usdtTickers.length === 0) {
            missingExchanges.push({
                exchangeId: ex.id,
                exchangeName: ex.name,
                reason: INVALID_DATA_REASON.NO_USDT_PAIR,
            });
            continue;
        }

        const fresh = usdtTickers.filter((t) => isFreshTicker(t, now));

        if (fresh.length === 0) {
            const hasStale = usdtTickers.some((t) => {
                if (t?.is_stale === true) return true;
                if (!t?.last_traded_at) return false;
                const ts = Date.parse(t.last_traded_at);
                return !Number.isFinite(ts) || now - ts > MAX_STALENESS_MS;
            });

            missingExchanges.push({
                exchangeId: ex.id,
                exchangeName: ex.name,
                reason: hasStale ? INVALID_DATA_REASON.STALE_PRICE : INVALID_DATA_REASON.NO_VALID_TICKER,
            });
            continue;
        }

        fresh.sort((a, b) => Date.parse(b.last_traded_at || 0) - Date.parse(a.last_traded_at || 0));
        const chosen = fresh[0];

        contributingExchanges.push({
            exchangeId: ex.id,
            exchangeName: ex.name,
            priceUsdt: Number(chosen.last),
            lastTradedAt: chosen.last_traded_at || null,
        });
    }

    const avg =
        contributingExchanges.length > 0
            ? contributingExchanges.reduce((sum, x) => sum + x.priceUsdt, 0) / contributingExchanges.length
            : null;

    return {
        runId,
        coinId,
        symbol: upperSymbol,
        pair: `${upperSymbol}/${TARGET_QUOTE}`,
        name,
        averagePriceUsdt: avg,
        contributingExchanges,
        missingExchanges,
        quality: buildDataQuality(topExchanges.length, contributingExchanges.length, missingExchanges),
        collectedAt: new Date(),
    };
}

module.exports = { processTickersForCoin };
