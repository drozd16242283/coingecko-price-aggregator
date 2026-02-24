const express = require('express');

const { API_PORT } = require('./config');

const { startPriceFetcherJob, runPriceFetchingCycle, stopPriceFetcherJob } = require('./price-fetcher.job');
const storage = require('./storage');

const { parsePairs } = require('./utils');


const app = express();
app.use(express.json());

const v1 = express.Router();

v1.get('/health', (_req, res) => {
    res.json({ ok: true });
});

v1.post('/jobs/fetch-prices', async (_req, res) => {
    await runPriceFetchingCycle();
    res.json({ triggered: true });
});

v1.get('/prices/latest', async (req, res) => {
    const pairs = parsePairs(req.query.pairs);
    if (pairs.length === 0) {
        return res.status(400).json({ ok: false, error: 'pairs is required, e.g. BTC/USDT,ETH/USDT' });
    }

    const data = await storage.getLatestPrices(pairs);
    if (data.length === 0) {
        return res.status(404).json({ error: 'Price not found for given pairs' });
    }
    return res.json({ data });
});

v1.get('/prices/historical', async (req, res) => {
    const pairs = parsePairs(req.query.pairs);
    const from = Number(req.query.from);
    const to = Number(req.query.to);

    if (pairs.length === 0 || !Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return res.status(400).json({
          error: 'required: pairs, from, to (unix ms)',
        });
    }

    const data = await storage.getHistoricalPrices(pairs, from, to);
    if (data.length === 0) {
        return res.status(404).json({ error: 'Price not found for given pairs with given time range' });
    }
    return res.json({ data });
});

app.use('/api/v1', v1);

let server;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
        stopPriceFetcherJob();

        if (server) {
          await new Promise((resolve) => server.close(resolve));
        }

        await storage.disconnect();
    } catch (err) {
        console.error('[Main] Shutdown error:', err);
        exitCode = 1;
    }

    process.exit(exitCode);
}

async function main() {
    await storage.connect();
    void startPriceFetcherJob();

    server = app.listen(API_PORT, '0.0.0.0', () => {
        console.log(`[Main] API listening on port ${API_PORT}`);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`\n[Main] Received ${signal}, shutting down...`);
        void shutdown(0);
    });
}

main().catch((err) => {
    console.error(`[Main] Startup error: ${err instanceof Error ? err.message : String(err)}`);
    void shutdown(1);
});
