const { MongoClient } = require('mongodb');

const {
    MONGODB_DB_NAME,
    MONGODB_URI,
    COLLECTION_PRICES,
    COLLECTION_ERRORS,
    ERROR_COLLECTION_TTL_SECONDS,
} = require('./config');

const { isFiniteNumber } = require('./utils');

let client = null;
let db = null;

async function connect() {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB_NAME);

    const snapshots = db.collection(COLLECTION_PRICES);
    await snapshots.createIndex({ pair: 1, collectedAt: -1 }); // For latestPrices query by pair
    await snapshots.createIndex({ collectedAt: -1 }); // To query snapshots by time range regardless of pair

    const errors = db.collection(COLLECTION_ERRORS);
    await errors.createIndex({ timestamp: 1 }, { expireAfterSeconds: ERROR_COLLECTION_TTL_SECONDS });
    await errors.createIndex({ runId: 1, stage: 1 }); // To filter and navigate by errors for investigation

    return db;
}

async function disconnect() {
    if (client) {
        await client.close();
        client = null;
        db = null;
    }
}

function validateSnapshot(doc) {
    const errors = [];

    if (!doc || typeof doc !== 'object') errors.push('NOT_OBJECT');
    if (!doc?.coinId) errors.push('MISSING_COIN_ID');
    if (!doc?.symbol) errors.push('MISSING_SYMBOL');
    if (!(doc?.collectedAt instanceof Date)) errors.push('INVALID_COLLECTED_AT');
    if (doc?.averagePriceUsdt !== null && doc?.averagePriceUsdt !== undefined && !isFiniteNumber(doc.averagePriceUsdt)) {
        errors.push('INVALID_AVERAGE_PRICE_USDT');
    }
    if (!Array.isArray(doc?.contributingExchanges)) errors.push('INVALID_CONTRIBUTING_EXCHANGES');
    if (!Array.isArray(doc?.missingExchanges)) errors.push('INVALID_MISSING_EXCHANGES');
    if (!doc?.quality || typeof doc.quality !== 'object') errors.push('MISSING_QUALITY');

    return errors;
}

async function storeSnapshotError({
    runId = null,
    stage = 'UNKNOWN',
    coinId = null,
    symbol = null,
    endpoint = null,
    httpStatus = null,
    message = '',
    details = null,
}) {
    if (!db) throw new Error('MongoDB not connected');

    await db.collection(COLLECTION_ERRORS).insertOne({
        runId,
        stage,
        coinId,
        symbol: symbol ? String(symbol).toUpperCase() : null,
        endpoint,
        httpStatus,
        message: String(message).slice(0, 2000),
        details,
        timestamp: new Date(),
    });
}

async function storeSnapshots(snapshots, runId = null) {
    if (!db) throw new Error('MongoDB not connected');
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return { insertedCount: 0, rejectedCount: 0 };
    }

    const valid = [];
    const validationErrors = [];

    for (const snap of snapshots) {
        const errs = validateSnapshot(snap);
        if (errs.length === 0) {
            valid.push(snap);
        } else {
            validationErrors.push({ snap, errs });
        }
    }

    let insertedCount = 0;
    let rejectedCount = validationErrors.length;

    if (valid.length > 0) {
        try {
            const res = await db.collection(COLLECTION_PRICES).insertMany(valid, { ordered: false });
            insertedCount = res.insertedCount;
        } catch (err) {
            // Handling Partial insert edge case
            const isBulk = err && (err.name === 'MongoBulkWriteError' || err.code != null);
            if (!isBulk) {
                throw err;
            }

            insertedCount =
                err.insertedCount ??
                err.result?.insertedCount ??
                err.result?.nInserted ??
                0;

            const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [];
            rejectedCount += writeErrors.length;

            await storeSnapshotError({
                runId,
                stage: 'SNAPSHOT_INSERT',
                message: err.message || 'Bulk insert error',
                details: {
                    attempted: valid.length,
                    insertedCount,
                    failedCount: writeErrors.length,
                    codes: writeErrors.map((e) => e.code),
                },
            });
        }
    }

    if (validationErrors.length > 0) {
        await db.collection(COLLECTION_ERRORS).insertMany(
            validationErrors.map(({ snap, errs }) => ({
                runId,
                stage: 'SNAPSHOT_VALIDATION',
                coinId: snap?.coinId ?? null,
                symbol: snap?.symbol ?? null,
                message: 'Invalid snapshot',
                details: { errors: errs },
                timestamp: new Date(),
            })),
            { ordered: false },
        );
    }

    return { insertedCount, rejectedCount };
}

async function getLatestPrices(pairs = []) {
    if (!db) throw new Error('MongoDB not connected');

    if (pairs.length === 0) return [];

    return db.collection(COLLECTION_PRICES).aggregate([
        { $match: { pair: { $in: pairs } } },
        { $sort: { pair: 1, collectedAt: -1 } },
        { $group: { _id: '$pair', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        { $project: { _id: 0 } },
    ]).toArray();
}

async function getHistoricalPrices(pairs = [], from, to) {
    if (!db) throw new Error('MongoDB not connected');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
        throw new Error('Invalid time range');
    }

    if (pairs.length === 0) return [];

    return db.collection(COLLECTION_PRICES)
        .find({
            pair: { $in: pairs },
            collectedAt: { $gte: new Date(from), $lte: new Date(to) },
        })
        .project({ _id: 0 })
        .sort({ symbol: 1, collectedAt: 1 })
        .toArray();
}

module.exports = {
    connect,
    disconnect,
    storeSnapshots,
    storeSnapshotError,
    getLatestPrices,
    getHistoricalPrices,
};