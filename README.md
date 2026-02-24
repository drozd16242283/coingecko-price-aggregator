# Coingecko Price Aggregator Task

## Setup
**Install dependencies using**
```
npm install
```

**Optional: set a CoinGecko demo API key for better rate limits**
```
export COINGECKO_API_KEY=your_key_here

export MONGO_URI=mongodb://localhost:27017

export MONGO_DB=crypto_prices

export PORT=3000
```

## Run project

**Start MongoDB with docker**
```
docker run -d --name mongo -p 27017:27017 mongo:7
```

**Start server**
```
npm run start
```

## Run tests

```
npm run test
```