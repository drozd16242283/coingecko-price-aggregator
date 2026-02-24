# Project Architecture Overview

I used a FP approach with CommonJS modules system. Each file has its own responsibility and boundaries so the data processing flow is directional and scalable.

**Scheduler Job** - `price-fetcher.job`
- Runs on cron (every 30 sec)
- Prevents overlapping runs with `running` lock
- Exposes method for on-demand processing trigger

**Coingecko Client** - `coingeko.client`
- Has an API client based on `fetch` with retries and exponential backoff to reduce 429 errors (rate limit)
- Exposes methods to fetch top coins, top exchanges and ticker based on coin id

**Data Processing Pipeline** - `ticker-processor`
- Computes price snapshot based on raw ticker data (with avg prices in USDT from exchanges)
- Validates ticker quality and builds data quality data for each snapshot
- Handle edge cases (API errors, missing data, stale prices, USDT parity, invalid ticker)

**Storage Layer** - `storage`
- Exposes queries API (fetch by pairs and historical data)
- Stores snapshots to `price_snapshots` collection
- Stores ingestion error into separate collection with TTL (for analytics and monitoring)
- Handle partial insert and corrupted ticker data

**API Layer / Entrypoint** - `index`
- Handles connect/disconnect to DB
- Starts price fetching job
- Graceful shutdown
- Exposes HTTP endpoints (latest prices by pairs and historical prices)

## Flow schema

Main Entrypoint (starts server and fetching job) -> Scheduler (start fetching prices from CG API) -> Data Processing Pipeline (generates snapshot) -> Storage (validate + write bulk)

## Problems I faced during implementation
### Rate limits without API key
The first thing was rate limits, even though it has 30 req/min, I faced with 429 on fetching last tickers (after fetching top coins, exchanges). Guess it also limits by traffic size.
I solve it by creating demo api key to increase rate limit. 
But also would be good to have caching layer to cache top coins and top exchanges for ~12 hours, it would also reduce rate limit by not fetching top coins/exchanges on every run.

Better to run it with API key for smoth processing.

# Answers

## Q1 — MongoDB Schema Design
As per requirements I designed a schema to store only minimal necessary data related to prices, ticker, data quality and exchange metadata.
I used time-series snapshot model with one collection for actual snapshots and one collection for ingestion errors.

One document per pair - computed prices and quality data, no raw tickets

### The Collection structure for snapshots:

```
runId                   Date        - Identifier of snapshot
coinId                  string      - CoinGecko ID (e.g. "bitcoin")
symbol                  string      - Uppercase symbol (e.g. "BTC")
pair                    string      - Trading pair for better querying (e.g. "BTC/USDT")
name                    string      - Coin name (e.g. "Bitcoin")
averagePriceUsdt        number      - Avg price across top exchanges
contributingExchanges   [Object]    - Exchange metadata (exchangeId, exchangeName, priceUsdt, lastTradedAt)
missingExchanges        [Object]    - Missing Exchanges (exchangeId, exchangeName, reason)
quality                 [Object]    - Data quality (expectedExchangeCount, contributingExchangeCount, status, reasons, apiErrorCount)
collectedAt             Date        - Snapshot date
```

### Indexes:
price_snapshots Collection indexes
```
{ pair: 1, collectedAt: -1 } - Used by queries to fetch price by pairs and historical prices by pairs
{ collectedAt: -1 } - To query snapshots by time range regardless of pairs
```

ingestion_errors Collection indexes
```
{ timestamp: 1 } - With TTL to delete ingestion errors data after TTL (30 days)
{ runId: 1 } - For easier tracing/debugging ingestion errors
```

### Trade offs:
- Single snapshot collection per document - simple writes but queries may need aggregation
- Exchange data duplication
- Storing NO_DATA snapshot - for time-series snapshots continuity, but customer may need to filter averagePriceUsdt !== null to get latest valid price


## Q2 — Scheduling Approach
For scheduling I decided to use cron-job approach since it's better fits into time-series queries with interval. I picked this approach with node-cron lib because it's more predictable and stable approach compared to setInterval and it's easier to maintain and to scale.

To run it across multiple instances we need to ensure that only 1 instance is fetching and processing/writing at given time. To avoid double processing of same data, avoid spending API credits and potential race conditions on writing DB.

For multi-instances and scalability I would add following:
- Redis-based Mutex to lock processing for one instance at the time to avoid double processing
- OR leader-election mechanism for selecting a leader - instance that process job and write to DB. As a result one instance process & write to DB, other instances read from it - flexible scalability for each part and gives high availability
- A persistent job queue to store jobs and delegate processing to separate Worker to not block event loop on main server
- Separate migration to create indexes on MongoDB to avoid race conditions (now indexes creating on connection)


## Q3 — Data Quality & Edge Cases
I was highly focused on error handling and data quality since it's crucial to build data pipeline that handles possible edge cases and silently store errors to not interrupt processing for other coins.
I spent a lot of time on figuring out most optimal data pipeline flow to handle most errors and building data for analysis (quality property in schema)

I Covered possible Edge cases in data processing pipeline to build snapshot with all necessary data that contains price data as well as data quality for monitoring and analytics.
And in Storage Layer before saving into DB I validating snapshot to ensure that data is not corrupted + handling bulk insert error cases since MongoDB could partially write data

Data Processing pipeline handles following issues:
- MISSING_EXCHANGE_DATA: exchange has no tickers for coin
- NO_USDT_PAIR: exchange has tickers but no USDT pair
- API_ERROR: API request for ticker fetch failed
- STALE_PRICE: all USDT tickers are stale (is_stale=true or is_anomaly=true or old timestamp)
- NO_VALID_TICKER: fallback when ticker is not fresh and not stale (unknown error)

## Q4 — Hyperswarm RPC - Optional
Didn't have a time to implement it, but i worked with gRPC before so kind of have the idea on how it supposed to work.
I implemented HTTP API with following endpoints:

API for trigger fetch prices job on-demand
```
api/v1/jobs/fetch-prices
```

API for fetching last price data by pairs (pass pairs as query params)

```
api/v1/prices/latest?pairs=BTC/USDT,ETH/USDT
```

API for fetching historical price data by pairs and data range (pass pairs and data-range as query params)

```
api/v1/prices/historical?pairs=BTC/USDT,ETH/USDT&from=1771951382325&to=1771951382325
```

Response example:

```
{
    "data": [
        {
            "runId": "2026-02-24T14:27:30.008Z",
            "coinId": "bitcoin",
            "symbol": "BTC",
            "pair": "BTC/USDT",
            "name": "Bitcoin",
            "averagePriceUsdt": 62959.84,
            "contributingExchanges": [
                {
                    "exchangeId": "binance",
                    "exchangeName": "Binance",
                    "priceUsdt": 62953.38,
                    "lastTradedAt": "2026-02-24T14:26:34+00:00"
                },
                {
                    "exchangeId": "bybit_spot",
                    "exchangeName": "Bybit",
                    "priceUsdt": 62967.8,
                    "lastTradedAt": "2026-02-24T14:26:07+00:00"
                },
                {
                    "exchangeId": "gdax",
                    "exchangeName": "Coinbase Exchange",
                    "priceUsdt": 62958.34,
                    "lastTradedAt": "2026-02-24T14:25:40+00:00"
                }
            ],
            "missingExchanges": [],
            "quality": {
                "expectedExchangeCount": 3,
                "contributingExchangeCount": 3,
                "status": "OK",
                "reasons": [],
                "reasonCounts": {},
                "apiErrorCount": 0
            },
            "collectedAt": "2026-02-24T14:27:30.616Z"
        },
        {
            "runId": "2026-02-24T14:27:30.008Z",
            "coinId": "ethereum",
            "symbol": "ETH",
            "pair": "ETH/USDT",
            "name": "Ethereum",
            "averagePriceUsdt": 1814.2733333333333,
            "contributingExchanges": [
                {
                    "exchangeId": "binance",
                    "exchangeName": "Binance",
                    "priceUsdt": 1814.32,
                    "lastTradedAt": "2026-02-24T14:26:03+00:00"
                },
                {
                    "exchangeId": "bybit_spot",
                    "exchangeName": "Bybit",
                    "priceUsdt": 1814.58,
                    "lastTradedAt": "2026-02-24T14:26:09+00:00"
                },
                {
                    "exchangeId": "gdax",
                    "exchangeName": "Coinbase Exchange",
                    "priceUsdt": 1813.92,
                    "lastTradedAt": "2026-02-24T14:26:39+00:00"
                }
            ],
            "missingExchanges": [],
            "quality": {
                "expectedExchangeCount": 3,
                "contributingExchangeCount": 3,
                "status": "OK",
                "reasons": [],
                "reasonCounts": {},
                "apiErrorCount": 0
            },
            "collectedAt": "2026-02-24T14:27:31.143Z"
        }
    ]
}
```

## Q5 — Testing Strategy
The strategy to have one full e2e test with real API and data processing flow:
- Test trigger processing flow using API
- Waits for processing cycle
- Fetch price and historical prices using API

And for handling edge cases i would create couple unit tests that mocks Coingecko API and return not valid data, so i can check how logic handles it,
Test cases:
- Full e2e flow with isolared DB
- all tickers stale → snapshot stored with NO_DATA status
- all tickers anomalous → snapshot stored with NO_DATA status
- all prices zero/null/negative → snapshot stored with NO_DATA status
- all timestamps > 1 hour old → treated as stale
- no USDT pairs available → missing with NO_USDT_PAIR reason


Unfortunately didn't manage to complete the actual tests

## Q6 — Production Readiness
For production i would add:

### Observability:
- Metrics for success and failed fetching cycles (for Alerting and Monitoring)
- Better Logging system with debug logs to trace error (include runId for traceability)
- Dashboard and alert systems for errors

### Scailing
- Persisted Caching Layer for caching latest prices (for example for last 6-12 hours) and have faster access on read-side.
For Writing i would use Write Back strategy to update cache first and then write to DB once in a while (to optimize write side by batching and scheduled writes)
For Reading i would use cache aside strategy to update cache with missing items
- Job queue and Worker to offload main thread
- instance based Mutex(redis-based) for HS support

### Security
- Auth system for API
- .env managing


## Q7 — Dependencies & Tooling
- `node-cron` - for Scheduling jobs (described in Scheduling section)
- `express` - For exposing HTTP API. Chose it because it simple to setup and use. Good alternative is fastify.
