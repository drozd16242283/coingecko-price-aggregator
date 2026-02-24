const {
    COINGECKO_BASE_URL,
    REQUEST_TIMEOUT_MS,
    MAX_RETRIES,
    BASE_RETRY_DELAY_MS,
    TOP_COINS_COUNT,
    TOP_EXCHANGES_COUNT,
    CG_API_KEY,
} = require('./config');

const { sleep } = require('./utils');

async function fetchJson(path, params = {}, attempt = 1) {
    const url = new URL(`${COINGECKO_BASE_URL}${path}`);

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, value);
        }
    }

    // Add demo API key if available to increase rate limit
    if (CG_API_KEY) {
        url.searchParams.set('x_cg_demo_api_key', CG_API_KEY);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url.toString(), {
            headers: { 'Accept': 'application/json' },
            signal: ac.signal,
        });

        if (response.status === 429 && attempt < MAX_RETRIES) {
            const waitMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            await sleep(waitMs);
            return fetchJson(path, params, attempt + 1);
        }

        if (!response.ok) {
            throw new Error(`Failed to request ${path}`);
        }

        return await response.json();
    } catch (err) {
        if (attempt < MAX_RETRIES) {
            // Exponential backoff
            const waitMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            await sleep(waitMs);
            return fetchJson(path, params, attempt + 1);
        }
        console.error(`[CoinGecko] Failed to request ${path} after ${attempt} retries`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function getTopExchanges(count = TOP_EXCHANGES_COUNT) {
    console.log('[CoinGecko] Fetching Top Exchanges');
    const exchanges = await fetchJson('/exchanges', {
        per_page: count,
        page: 1,
    });

    if (!exchanges.length) {
        return [];
    }

    return exchanges
        .filter((x) => x && x.id)
        .map((x) => ({
            id: x.id,
            name: x.name,
            trustScore: x.trust_score ?? null,
            trustScoreRank: x.trust_score_rank ?? null,
        }));
}

async function getTopCoins(count = TOP_COINS_COUNT) {
    console.log('[CoinGecko] Fetching Top Cryptocurrencies by market cap');

    const coins = await fetchJson('/coins/markets', {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: count,
        page: 1,
        sparkline: false,
    });

    if (!coins.length) {
        return [];
    }

    return coins.map((c) => ({
        id: c.id,
        symbol: (c.symbol || '').toUpperCase(),
        name: c.name,
        marketCap: c.market_cap,
        marketCapRank: c.market_cap_rank ?? null,
    }));
}

async function getCoinTickers(coinId, exchangeIds) {
    console.log(`[CoinGecko] Fetching tickers data for cryptocurrency: ${coinId}`);

    const tickerResponse = await fetchJson(`/coins/${coinId}/tickers`, {
        exchange_ids: exchangeIds,
        include_exchange_logo: false,
        page: 1,
        order: 'trust_score_desc',
    });

    if (!tickerResponse || !tickerResponse.tickers) {
        return [];
    }

    return tickerResponse.tickers.filter(
        (t) => t.target === 'USDT' || t.target_coin_id === 'tether'
    );
}

module.exports = {
    getTopExchanges,
    getTopCoins,
    getCoinTickers,
};
