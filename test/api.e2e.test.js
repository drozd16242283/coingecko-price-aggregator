const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const request = require('supertest');

const { sleep } = require('../utils');

let proc;
const BASE = 'http://127.0.0.1:3107';

async function waitHealth(timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await request(BASE).get('/api/v1/health');
            if (res.status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Server did not start');
}

test.before(async () => {
    proc = spawn('node', ['index.js'], {
        env: {
            ...process.env,
            PORT: '3107',
            MONGO_DB: 'crypto_prices_test',
        },
        stdio: 'inherit',
    });
    await waitHealth();
});

test.after(async () => {
    if (proc) proc.kill('SIGTERM');
});

test('e2e: trigger fetch and read latest', async () => {
    await request(BASE).post('/api/v1/jobs/fetch-prices').expect(200);
    await sleep(1000);
    const res = await request(BASE).get('/api/v1/prices/latest?pairs=BTC-USDT').expect(200);
    assert.ok(Array.isArray(res.body.data));
});