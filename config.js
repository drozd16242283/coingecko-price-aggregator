// Coingecko API
const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const TOP_COINS_COUNT = 5;
const TOP_EXCHANGES_COUNT = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5_000;
const CG_API_KEY = process.env.COINGECKO_API_KEY;

// Data processing
const MAX_STALENESS_MS = 60 * 60 * 1000; // 1 hour

// DB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB || 'crypto_prices';
const COLLECTION_PRICES = 'price_snapshots';
const COLLECTION_ERRORS = 'ingestion_errors';
const ERROR_COLLECTION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const API_PORT = Number(process.env.API_PORT || 3000);

module.exports = {
    COINGECKO_BASE_URL,
    TOP_COINS_COUNT,
    TOP_EXCHANGES_COUNT,
    REQUEST_TIMEOUT_MS,
    MAX_RETRIES,
    BASE_RETRY_DELAY_MS,
    CG_API_KEY,

    MAX_STALENESS_MS,

    MONGODB_URI,
    MONGODB_DB_NAME,
    COLLECTION_PRICES,
    COLLECTION_ERRORS,
    ERROR_COLLECTION_TTL_SECONDS,

    API_PORT,
};
