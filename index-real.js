require('dotenv').config();
const Binance = require('binance-api-node').default;
const MongoClient = require('mongodb').MongoClient;
const {  SMA, RSI, MACD, BollingerBands, ADX, HeikinAshi, PSAR } = require('technicalindicators');
const { orders, permissions } = require('./database/mongo');
const cargadoOrder = require('./database/classes/orders');
const express = require('express');
const path = require('path');

// Configurar el cliente de Binance
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});


async function simulateWithStrategy(symbol, year, month, interval = '15m', initialBTC = 1) {
    console.log(`Starting simulation for ${symbol}, ${year}-${month}, interval: ${interval}, initial BTC: ${initialBTC}`);
  
    const { startTime, endTime } = getMonthTimeRange(year, month);
    const candles = await getHistoricalDataForMonth(symbol, interval, startTime, endTime);
    const closePrices = candles.map(c => parseFloat(c.close));
    const highPrices = candles.map(c => parseFloat(c.high));
    const lowPrices = candles.map(c => parseFloat(c.low));
  
    const simulationResults = [];
    const tradingFee = 0.001; // 0.1% trading fee
    const rewardRiskRatio = 1.5; // 1:1.5 profit-to-risk ratio
    let currentBTC = initialBTC;
  
    for (let i = 50; i < closePrices.length; i++) {
      // Calculate indicators
      const rsi = RSI.calculate({ period: 14, values: closePrices.slice(0, i) });
      const macd = MACD.calculate({
        values: closePrices.slice(0, i),
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      });
  
      const trend = analyzeMarket(rsi, macd);
      const currentClose = closePrices[i];
  
      // Only trade if at least 2 indicators align
      if (trend >= 2) {
        await executeTrade('BUY', symbol, currentBTC, currentClose);
        simulationResults.push({ type: 'BUY', price: currentClose, timestamp: candles[i].closeTime });
      } else if (trend <= -2) {
        await executeTrade('SELL', symbol, currentBTC, currentClose);
        simulationResults.push({ type: 'SELL', price: currentClose, timestamp: candles[i].closeTime });
      }
  
      if (i % 1000 === 0) {
        console.log(`Processed ${((i / closePrices.length) * 100).toFixed(2)}% of data...`);
      }
    }
  
    calculateResults(simulationResults, rewardRiskRatio, tradingFee, currentBTC);
  }
  
  function analyzeMarket(rsi, macd) {
    let trend = 0;
  
    // RSI
    if (rsi[rsi.length - 1] < 30) trend += 1; // Oversold (buy signal)
    else if (rsi[rsi.length - 1] > 70) trend -= 1; // Overbought (sell signal)
  
    // MACD
    if (macd[macd.length - 1].MACD > macd[macd.length - 1].signal) trend += 1; // Bullish crossover
    else trend -= 1; // Bearish crossover
  
    return trend;
  }
  
  function calculateResults(simulationResults, rewardRiskRatio, tradingFee, initialBTC) {
    let profit = 0;
    let wins = 0;
    let losses = 0;
    let currentBTC = initialBTC;
  
    for (let i = 0; i < simulationResults.length - 1; i++) {
      const current = simulationResults[i];
      const next = simulationResults[i + 1];
  
      if ((current.type === 'BUY' && next.type === 'SELL') || (current.type === 'SELL' && next.type === 'BUY')) {
        const priceChange = next.price - current.price;
        const isWin = (current.type === 'BUY' && priceChange > 0) || (current.type === 'SELL' && priceChange < 0);
        const tradeResult = isWin ? Math.abs(priceChange) * rewardRiskRatio : Math.abs(priceChange);
  
        // Apply trading fee (0.1% per trade, so 0.2% round-trip)
        const fee = (current.price + next.price) * tradingFee;
        const tradeProfit = isWin ? tradeResult - fee : -tradeResult - fee;
  
        profit += tradeProfit;
        currentBTC += tradeProfit / next.price; // Update BTC balance
  
        if (isWin) wins++;
        else losses++;
      }
    }
  
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
    console.log('Simulation Results:');
    console.log(`Initial BTC: ${initialBTC}`);
    console.log(`Final BTC: ${currentBTC.toFixed(8)}`);
    console.log(`Total Trades: ${totalTrades}`);
    console.log(`Wins: ${wins}`);
    console.log(`Losses: ${losses}`);
    console.log(`Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`Total Profit/Loss: ${profit.toFixed(2)} USDT`);
  }
  
  async function executeTrade(type, symbol, amount, price) {
    try {
      if (type === 'BUY') {
        const order = await client.order({
          symbol,
          side: 'BUY',
          type: 'MARKET',
          quantity: amount,
        });
        console.log(`Executed BUY order at ${price}, details:`, order);
      } else if (type === 'SELL') {
        const order = await client.order({
          symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: amount,
        });
        console.log(`Executed SELL order at ${price}, details:`, order);
      }
    } catch (error) {
      console.error(`Error executing ${type} order for ${symbol}:`, error);
    }
  }
  
  async function getHistoricalDataForMonth(symbol, interval, startTime, endTime) {
    let data = [];
    let start = startTime;
  
    while (start < endTime) {
      const candles = await client.candles({
        symbol,
        interval,
        startTime: start,
        endTime: endTime,
        limit: 1000,
      });
  
      if (candles.length === 0) break;
  
      data = data.concat(candles);
      start = candles[candles.length - 1].closeTime + 1;
  
      console.log(`Fetched ${candles.length} candles, total: ${data.length}`);
    }
  
    return data;
  }
  
  function getMonthTimeRange(year, month) {
    const start = new Date(year, month - 1, 1).getTime();
    const end = new Date(year, month, 0, 23, 59, 59).getTime();
    return { startTime: start, endTime: end };
  }
  
  
  const app = express();
  
  // Servir archivos estáticos desde la carpeta 'public'
  app.use(express.static(path.join(__dirname, 'public')));
  
  // Ruta principal (opcional, ya que index.html será servido automáticamente)
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  
  // Configurar el servidor
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    simulateWithStrategy('BTCUSDT', 2024, 8, '5m', 0.0104); // Simula con 0.5 BTC
  });
  