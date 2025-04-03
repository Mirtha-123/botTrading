require('dotenv').config();
const Binance = require('binance-api-node').default;
const { MongoClient } = require('mongodb');
const { RSI, MACD } = require('technicalindicators');
const express = require('express');
const path = require('path');

// Configuración
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';  // Usa 127.0.0.1 en lugar de localhost (::1 puede causar problemas en IPv6).
const DB_NAME = 'trading_bot';
const TRANSACTIONS_COLLECTION = 'real_transactions';
const BOT_STATE_COLLECTION = 'bot_state';

// Configurar cliente de Binance para trading real
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// Variables globales
let db;
let transactionsCollection;
let botStateCollection;
let symbol = 'BTCUSDT';
let interval = '5m';
let position = null; // { type: 'LONG'|'SHORT', entryPrice, entryTime, amount }
let candleHistory = [];
let rsiPeriod = 14;
let macdConfig = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };

// Conectar a MongoDB
async function connectToMongo() {
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  transactionsCollection = db.collection(TRANSACTIONS_COLLECTION);
  botStateCollection = db.collection(BOT_STATE_COLLECTION);
  console.log('Conectado a MongoDB');
}

// Iniciar el bot de trading
async function startTradingBot() {
  await connectToMongo();
  await loadPreviousState();
  
  console.log(`Iniciando bot de trading para ${symbol} en intervalo ${interval}`);
  
  // Obtener velas históricas para calcular indicadores iniciales
  const initialCandles = await client.candles({ symbol, interval, limit: 100 });
  candleHistory = initialCandles.map(c => ({
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
    time: c.closeTime,
    isFinal: true
  }));
  
  // Iniciar WebSocket para velas en tiempo real
  const ws = client.ws.candles(symbol, interval, candle => {
    processNewCandle(candle);
  });
  
  // Manejar cierre limpio
  process.on('SIGINT', async () => {
    console.log('Deteniendo bot...');
    ws();
    await saveCurrentState();
    process.exit();
  });
}

// Procesar nueva vela
async function processNewCandle(candle) {
  const newCandle = {
    open: parseFloat(candle.open),
    high: parseFloat(candle.high),
    low: parseFloat(candle.low),
    close: parseFloat(candle.close),
    volume: parseFloat(candle.volume),
    time: candle.closeTime,
    isFinal: candle.isFinal
  };
  
  // Actualizar historial de velas
  if (newCandle.isFinal) {
    candleHistory.push(newCandle);
    if (candleHistory.length > 100) {
      candleHistory.shift(); // Mantener un máximo de 100 velas
    }
    
    // Calcular indicadores
    const closes = candleHistory.map(c => c.close);
    const rsi = RSI.calculate({ period: rsiPeriod, values: closes });
    const macd = MACD.calculate({ values: closes, ...macdConfig });
    
    // Analizar mercado
    const trend = analyzeMarket(rsi, macd);
    
    // Tomar decisiones de trading
    if (trend >= 2 && (!position || position.type !== 'LONG')) {
      await openLongPosition(newCandle.close);
    } else if (trend <= -2 && (!position || position.type !== 'SHORT')) {
      await openShortPosition(newCandle.close);
    }
    
    // Guardar estado periódicamente
    await saveCurrentState();
  }
}

// Abrir posición larga (COMPRA)
async function openLongPosition(currentPrice) {
  if (position) {
    await closePosition(currentPrice);
  }
  
  try {
    // Obtener balance disponible
    const accountInfo = await client.accountInfo();
    const usdtBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'USDT').free);
    
    // Calcular cantidad a comprar (usemos solo el 90% del balance para margen)
    const amountToBuy = (usdtBalance * 0.9) / currentPrice;
    
    // Crear orden real
    const order = await client.order({
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: amountToBuy.toFixed(6),
    });
    
    console.log(`Orden de COMPRA ejecutada: ${amountToBuy} ${symbol} a ${currentPrice}`);
    
    // Actualizar posición
    position = {
      type: 'LONG',
      entryPrice: currentPrice,
      entryTime: new Date(),
      amount: amountToBuy
    };
    
    // Registrar transacción
    await recordTransaction({
      type: 'BUY',
      price: currentPrice,
      amount: amountToBuy,
      usdtValue: amountToBuy * currentPrice,
      orderId: order.orderId,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error al abrir posición larga:', error);
  }
}

// Abrir posición corta (VENTA)
async function openShortPosition(currentPrice) {
  if (position) {
    await closePosition(currentPrice);
  }
  
  try {
    // Obtener balance disponible
    const accountInfo = await client.accountInfo();
    const btcBalance = parseFloat(accountInfo.balances.find(b => b.asset === 'BTC').free);
    
    // Calcular cantidad a vender (usemos solo el 90% del balance para margen)
    const amountToSell = btcBalance * 0.9;
    
    // Crear orden real
    const order = await client.order({
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: amountToSell.toFixed(6),
    });
    
    console.log(`Orden de VENTA ejecutada: ${amountToSell} ${symbol} a ${currentPrice}`);
    
    // Actualizar posición
    position = {
      type: 'SHORT',
      entryPrice: currentPrice,
      entryTime: new Date(),
      amount: amountToSell
    };
    
    // Registrar transacción
    await recordTransaction({
      type: 'SELL',
      price: currentPrice,
      amount: amountToSell,
      usdtValue: amountToSell * currentPrice,
      orderId: order.orderId,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error al abrir posición corta:', error);
  }
}

// Cerrar posición actual
async function closePosition(currentPrice) {
  if (!position) return;
  
  try {
    let order;
    
    if (position.type === 'LONG') {
      // Vender para cerrar posición larga
      order = await client.order({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: position.amount.toFixed(6),
      });
    } else {
      // Comprar para cerrar posición corta
      order = await client.order({
        symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: position.amount.toFixed(6),
      });
    }
    
    const profit = position.type === 'LONG' 
      ? (currentPrice - position.entryPrice) * position.amount
      : (position.entryPrice - currentPrice) * position.amount;
    
    console.log(`Posición ${position.type} cerrada. Beneficio: ${profit.toFixed(2)} USDT`);
    
    // Registrar transacción de cierre
    await recordTransaction({
      type: position.type === 'LONG' ? 'SELL' : 'BUY',
      price: currentPrice,
      amount: position.amount,
      usdtValue: position.amount * currentPrice,
      orderId: order.orderId,
      profit,
      timestamp: new Date(),
      isClosing: true
    });
    
    position = null;
    
  } catch (error) {
    console.error('Error al cerrar posición:', error);
  }
}

// Registrar transacción en MongoDB
async function recordTransaction(tx) {
  try {
    await transactionsCollection.insertOne({
      symbol,
      interval,
      ...tx
    });
    console.log(`Transacción registrada: ${tx.type} ${tx.amount} ${symbol} a ${tx.price}`);
  } catch (error) {
    console.error('Error registrando transacción:', error);
  }
}

// Guardar estado actual del bot
async function saveCurrentState() {
  try {
    await botStateCollection.updateOne(
      { botId: 'main' },
      {
        $set: {
          position,
          candleHistory,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error guardando estado del bot:', error);
  }
}

// Cargar estado previo
async function loadPreviousState() {
  try {
    const state = await botStateCollection.findOne({ botId: 'main' });
    if (state) {
      position = state.position;
      candleHistory = state.candleHistory || [];
      console.log('Estado previo cargado');
    }
  } catch (error) {
    console.error('Error cargando estado previo:', error);
  }
}

// Analizar mercado (igual que antes)
function analyzeMarket(rsi, macd) {
  let trend = 0;
  if (rsi[rsi.length - 1] < 30) trend += 1;
  else if (rsi[rsi.length - 1] > 70) trend -= 1;
  if (macd[macd.length - 1].MACD > macd[macd.length - 1].signal) trend += 1;
  else trend -= 1;
  return trend;
}

// Configurar servidor Express (solo para monitoreo)
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Interfaz de monitoreo en http://localhost:${PORT}`);
  startTradingBot();
});