const cron = require('node-cron');

const { TOP_COINS_COUNT, TOP_EXCHANGES_COUNT} = require('./config');
const { sleep } = require('./utils');

const { getTopExchanges, getTopCoins, getCoinTickers } = require('./coingeko.client');
const { processTickersForCoin } = require('./ticker-processor');
const { storeSnapshots, storeSnapshotError } = require('./storage');

let running = false;
let task = null;

async function runPriceFetchingCycle() {
    if (running) {
        console.warn('[PriceFetcherJob] Previous cycle still running, skipping');
        return;
    }
    running = true;
    try {
        await fetchCryptoPrices();
    } catch (err) {
        console.error('[PriceFetcherJob] Unhandled error:', err);
    } finally {
        running = false;
    }
}

// Run cron job every 30 sec to fetch prices
async function startPriceFetcherJob() {
    await runPriceFetchingCycle();

    task = cron.schedule('*/30 * * * * *', runPriceFetchingCycle, { timezone: 'UTC' });
    return task;
}

function stopPriceFetcherJob() {
    if (task) {
        task.stop();
        if (typeof task.destroy === 'function') task.destroy();
        task = null;
    }
}

async function fetchCryptoPrices() {
    const runId = new Date().toISOString();
    const startedAt = Date.now();

    console.log(`[PriceFetcherJob] Starting fetching crypto price job at ${runId}`);

    let topExchanges = [];
    let topCoins = [];
    try {
        [topExchanges, topCoins] = await Promise.all([getTopExchanges(), getTopCoins()]);
        console.log(`[PriceFetcherJob] Top ${TOP_COINS_COUNT} coins: ${topCoins.map((c) => c.symbol.toUpperCase()).join(', ')}`);
        console.log(`[PriceFetcherJob] Top ${TOP_EXCHANGES_COUNT} exchanges: ${topExchanges.map((e) => e.name).join(', ')}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await storeSnapshotError({
            runId,
            stage: 'BOOTSTRAP',
            message: `Failed to fetch top exchanges/coins: ${message}`,
        });
        return;
    }

    const exchangeIds = topExchanges.map((e) => e.id).join(',');
    const snapshots = [];

    for (const coin of topCoins) {
        try {
            await sleep(500); // Throttle ticker requests to reduce 429

            const rawCoinTickers = await getCoinTickers(coin.id, exchangeIds);

            snapshots.push(
                processTickersForCoin({
                    runId,
                    coinId: coin.id,
                    symbol: coin.symbol,
                    name: coin.name,
                    tickers: rawCoinTickers,
                    topExchanges
                }),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            await storeSnapshotError({
                runId,
                stage: 'FETCH_TICKERS',
                coinId: coin.id,
                symbol: coin.symbol,
                endpoint: `/coins/${coin.id}/tickers`,
                message,
            });

            // still store a NO_DATA snapshot for this coin (for time-series data consistency)
            snapshots.push(
                processTickersForCoin({
                    runId,
                    coinId: coin.id,
                    symbol: coin.symbol,
                    name: coin.name,
                    topExchanges,
                    fetchError: message,
                }),
            );
        }
    }

    const { insertedCount, rejectedCount } = await storeSnapshots(snapshots, runId);

    console.log(
        `[PriceFetcherJob] Run ${runId} done in ${Date.now() - startedAt}ms. Inserted=${insertedCount}, Rejected=${rejectedCount}`,
    );

}

// Expose runPriceFetchingCycle method for on-demand execution
module.exports = { startPriceFetcherJob, stopPriceFetcherJob, runPriceFetchingCycle };