require('dotenv').config();
const Binance = require('binance-api-node').default;
const { MongoClient } = require('mongodb');
const { RSI, MACD } = require('technicalindicators');
const express = require('express');
const path = require('path');

// Configuración de MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';  // Usa 127.0.0.1 en lugar de localhost (::1 puede causar problemas en IPv6).
const DB_NAME = 'trading_simulator';
const TRANSACTIONS_COLLECTION = 'transactions';
const SIMULATION_STATE_COLLECTION = 'simulation_state';

// Configurar el cliente de Binance
const client = Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// Variables globales para la conexión a MongoDB
let db;
let transactionsCollection;
let simulationStateCollection;

async function connectToMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    transactionsCollection = db.collection(TRANSACTIONS_COLLECTION);
    simulationStateCollection = db.collection(SIMULATION_STATE_COLLECTION);
    console.log('Conectado a MongoDB');
  } catch (err) {
    console.error('Error conectando a MongoDB:', err);
    process.exit(1);
  }
}

async function simulateWithStrategy(symbol, year, month, interval = '15m', initialBTC = 1) {
  await connectToMongo(); // Asegurar conexión a MongoDB

  console.log(`Iniciando simulación para ${symbol}, ${year}-${month}, intervalo: ${interval}, BTC inicial: ${initialBTC}`);

  // Verificar si hay un estado previo guardado
  const lastState = await simulationStateCollection.findOne({ 
    symbol, 
    year, 
    month, 
    interval 
  });

  let startIndex = 0;
  let currentBTC = initialBTC;
  
  if (lastState && !lastState.completed) {
    console.log('Reanudando simulación desde el estado previo...');
    startIndex = lastState.lastProcessedIndex + 1;
    currentBTC = lastState.currentBTC;
    console.log(`Reanudando desde el índice ${startIndex} con ${currentBTC} BTC`);
  }

  const { startTime, endTime } = getMonthTimeRange(year, month);
  const candles = await getHistoricalDataForMonth(symbol, interval, startTime, endTime);
  const closePrices = candles.map(c => parseFloat(c.close));

  const tradingFee = 0.001; // 0.1% comisión de trading
  const rewardRiskRatio = 1.5; // Ratio beneficio/riesgo 1:1.5

  for (let i = Math.max(50, startIndex); i < closePrices.length; i++) {
    // Calcular indicadores
    const rsi = RSI.calculate({ period: 14, values: closePrices.slice(0, i) });
    const macd = MACD.calculate({
      values: closePrices.slice(0, i),
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    });

    const trend = analyzeMarket(rsi, macd);
    const currentClose = closePrices[i];
    const currentCandle = candles[i];

    // Solo operar si al menos 2 indicadores coinciden
    if (trend >= 2) {
      await processTransaction({
        type: 'BUY',
        price: currentClose,
        timestamp: currentCandle.closeTime,
        symbol,
        year,
        month,
        interval,
        btcAmount: currentBTC,
        usdtValue: currentBTC * currentClose
      }, i, currentBTC);
    } else if (trend <= -2) {
      await processTransaction({
        type: 'SELL',
        price: currentClose,
        timestamp: currentCandle.closeTime,
        symbol,
        year,
        month,
        interval,
        btcAmount: currentBTC,
        usdtValue: currentBTC * currentClose
      }, i, currentBTC);
    }

    // Guardar estado cada 100 velas para recuperación
    if (i % 100 === 0) {
      await saveSimulationState(symbol, year, month, interval, i, currentBTC);
    }

    if (i % 1000 === 0) {
      console.log(`Procesado ${((i / closePrices.length) * 100).toFixed(2)}% de los datos...`);
    }
  }

  // Calcular resultados finales
  await calculateResults(symbol, year, month, interval, rewardRiskRatio, tradingFee, initialBTC);
}

async function processTransaction(transaction, currentIndex, currentBTC) {
  try {
    // Insertar transacción en MongoDB
    await transactionsCollection.insertOne(transaction);
    
    console.log(`Transacción registrada: ${transaction.type} a ${transaction.price}`);
    
    // Actualizar estado de la simulación
    await saveSimulationState(
      transaction.symbol,
      transaction.year,
      transaction.month,
      transaction.interval,
      currentIndex,
      currentBTC
    );
  } catch (err) {
    console.error('Error procesando transacción:', err);
  }
}

async function saveSimulationState(symbol, year, month, interval, lastProcessedIndex, currentBTC) {
  try {
    await simulationStateCollection.updateOne(
      { symbol, year, month, interval },
      {
        $set: {
          lastProcessedIndex,
          currentBTC,
          lastUpdated: new Date(),
          completed: false
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('Error guardando estado de simulación:', err);
  }
}

async function calculateResults(symbol, year, month, interval, rewardRiskRatio, tradingFee, initialBTC) {
  try {
    // Obtener todas las transacciones para esta simulación
    const transactions = await transactionsCollection.find({
      symbol,
      year,
      month,
      interval
    }).sort({ timestamp: 1 }).toArray();

    let profit = 0;
    let wins = 0;
    let losses = 0;
    let currentBTC = initialBTC;

    for (let i = 0; i < transactions.length - 1; i++) {
      const current = transactions[i];
      const next = transactions[i + 1];

      if ((current.type === 'BUY' && next.type === 'SELL') || (current.type === 'SELL' && next.type === 'BUY')) {
        const priceChange = next.price - current.price;
        const isWin = (current.type === 'BUY' && priceChange > 0) || (current.type === 'SELL' && priceChange < 0);
        const tradeResult = isWin ? Math.abs(priceChange) * rewardRiskRatio : Math.abs(priceChange);

        // Aplicar comisiones (0.1% por operación, 0.2% ida y vuelta)
        const fee = (current.price + next.price) * tradingFee;
        const tradeProfit = isWin ? tradeResult - fee : -tradeResult - fee;

        profit += tradeProfit;
        currentBTC += tradeProfit / next.price; // Actualizar balance de BTC

        if (isWin) wins++;
        else losses++;
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    console.log('\nResultados finales de la simulación:');
    console.log(`Símbolo: ${symbol}`);
    console.log(`Período: ${year}-${month}`);
    console.log(`Intervalo: ${interval}`);
    console.log(`BTC inicial: ${initialBTC}`);
    console.log(`BTC final: ${currentBTC.toFixed(8)}`);
    console.log(`Total operaciones: ${totalTrades}`);
    console.log(`Ganancias: ${wins}`);
    console.log(`Pérdidas: ${losses}`);
    console.log(`Ratio de aciertos: ${winRate.toFixed(2)}%`);
    console.log(`Beneficio/Pérdida total: ${profit.toFixed(2)} USDT`);

    // Marcar simulación como completada
    await simulationStateCollection.updateOne(
      { symbol, year, month, interval },
      {
        $set: {
          finalBTC: currentBTC,
          totalTrades,
          wins,
          losses,
          winRate,
          totalProfit: profit,
          completed: true,
          completedAt: new Date()
        }
      }
    );

  } catch (err) {
    console.error('Error calculando resultados:', err);
  }
}

function analyzeMarket(rsi, macd) {
  let trend = 0;

  // RSI
  if (rsi[rsi.length - 1] < 30) trend += 1; // Sobreventa (señal de compra)
  else if (rsi[rsi.length - 1] > 70) trend -= 1; // Sobrecompra (señal de venta)

  // MACD
  if (macd[macd.length - 1].MACD > macd[macd.length - 1].signal) trend += 1; // Cruce alcista
  else trend -= 1; // Cruce bajista

  return trend;
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

    console.log(`Obtenidas ${candles.length} velas, total: ${data.length}`);
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

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Configurar el servidor
const PORT = 3000;
app.listen(PORT, async () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}  ${process.env.BINANCE_API_KEY}` );
  // Iniciar conexión a MongoDB y luego la simulación
  await connectToMongo();
  simulateWithStrategy('BTCUSDT', 2025, 1, '5m', 0.00104); 
});

/*
// Configurar WebSocket para recibir actualizaciones en tiempo real
const ws = client.ws.candles('BTCUSDT', '5m', async (candle) => {
  const closePrice = parseFloat(candle.close);
  const candles = await client.candles({ symbol: 'BTCUSDT', interval: '5m' });
  const closePrices = candles.map(candle => parseFloat(candle.close));

  const sma = SMA.calculate({ period: 14, values: closePrices });
  const rsi = RSI.calculate({ period: 14, values: closePrices });
  const macd = MACD.calculate({
    values: closePrices,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const bb = BollingerBands.calculate({
    period: 20,
    values: closePrices,
    stdDev: 2,
  });

  const trend = analyzeMarket(sma, rsi, macd, bb);

  console.log('Precio actual:', closePrice);

  const quantity = 0.001; // Ajusta según tus necesidades

  if (trend > 0) {
    console.log('Alcista, comprando...');
    await placeOrderMia('BTCUSDT', 'BUY', quantity);
  } else if (trend < 0) {

  }
});

// Función para analizar el mercado
function analyzeMarket(sma, rsi, macd, bb) {
  let trend = 0;

  // SMA
  if (sma[sma.length - 1] > sma[sma.length - 2]) {
    trend += 1; // Tendencia alcista
  } else {
    trend -= 1; // Tendencia bajista
  }

  // RSI
  if (rsi[rsi.length - 1] < 30) {
    trend += 1; // Sobrevendido (alcista)
  } else if (rsi[rsi.length - 1] > 70) {
    trend -= 1; // Sobrecomprado (bajista)
  }

  // MACD
  const macdLine = macd[macd.length - 1].MACD;
  const signalLine = macd[macd.length - 1].signal;
  if (macdLine > signalLine) {
    trend += 1; // Señal de compra
  } else {
    trend -= 1; // Señal de venta
  }

  // Bollinger Bands
  const upperBand = bb[bb.length - 1].upper;
  const lowerBand = bb[bb.length - 1].lower;
  const closePrice = bb[bb.length - 1].close;
  if (closePrice < lowerBand) {
    trend += 1; // Sobrevendido (alcista)
  } else if (closePrice > upperBand) {
    trend -= 1; // Sobrecomprado (bajista)
  }

  return trend;
}

// Función para validar y calcular el precio de ganancia
function validarProsContras(monto, mercado, tipo) {
  const buy = monto / mercado;
  let ganancia = tipo === 'BUY' ? mercado + 60 : mercado - 60;
  return { ganancia, buy, perdida: mercado - process.env.BINANCE_API_SECRET };
}

// Función para ejecutar órdenes en Binance Spot
async function placeOrderMia(symbol, side, quantity) {
  try {
    console.log('ORDEN', symbol, side, quantity);
    // Calcular el stop loss
    const stopLossPrice = await calcularStopLoss(symbol, '5m');

    const permi = await permissions.find({ status: 0 });

    if (permi.length > 0) {
      const firstPermission = permi[0];
      const amount = firstPermission.amount;

      const market = await client.prices({ symbol: symbol });
      const marketPrice = parseFloat(market[symbol]);
      const result = validarProsContras(amount, marketPrice, side);

      if (side === 'BUY') {
        const documentos = await orders.find({ status: 0 });
        console.log(documentos)
        if (documentos.length == 0) {
          console.log('ES sensato comprar', market);
          const orderManager = new cargadoOrder(marketPrice, result.ganancia, '', result.buy, (amount * 0.04990892) / 100, 'BUY', firstPermission._id, 0, stopLossPrice);
          const savedOrder = await orderManager.save();
          console.log('Orden guardada', savedOrder);
        }

      } else if (side === 'SELL') {
        // Implementar la lógica para vender
        const orderManager = new cargadoOrder(marketPrice, '', result.ganancia, result.buy, (amount * 0.04990892) / 100, 'SELL', firstPermission._id);
        const savedOrder = await orderManager.save();
        console.log('Orden guardada', savedOrder);
      }

    } else {
      console.log('No se encontraron permisos con status 0');
    }

    // Ejecutar la orden en el mercado spot
    //const order = await client.order({ symbol, side, type: 'MARKET', quantity });
    //return order;

  } catch (error) {
    console.error('Error placing order:', error);
  }
}

async function calcularStopLoss(symbol, interval) {
  try {
    const candles = await client.candles({ symbol, interval });
    const closePrices = candles.map(candle => parseFloat(candle.close));

    const { sma, rsi, macd, bb } = await getTechnicalIndicators(closePrices);

    const marketPrice = closePrices[closePrices.length - 1];

    // 1. Stop Loss basado en Bandas de Bollinger
    const bbLowerBand = bb[bb.length - 1].lower;
    const stopLossBB = marketPrice < bbLowerBand ? bbLowerBand : marketPrice * 0.99;

    // 2. Stop Loss basado en RSI
    const rsiValue = rsi[rsi.length - 1];
    const stopLossRSI = rsiValue < 30 ? marketPrice * 0.99 : marketPrice * 0.995;

    // 3. Stop Loss basado en MACD
    const macdLine = macd[macd.length - 1].MACD;
    const signalLine = macd[macd.length - 1].signal;
    const stopLossMACD = macdLine < signalLine ? marketPrice * 0.995 : marketPrice * 0.99;

    // 4. Stop Loss basado en SMA
    const smaValue = sma[sma.length - 1];
    const stopLossSMA = marketPrice < smaValue ? smaValue * 0.995 : marketPrice * 0.99;

    // Combinación de Stop Loss
    // Puedes usar el promedio, la mediana o el valor mínimo. Aquí usamos el mínimo.
    const stopLoss = Math.min(stopLossBB, stopLossRSI, stopLossMACD, stopLossSMA);

    return stopLoss;
  } catch (error) {
    console.error('Error calculando el stop loss:', error);
    throw error;
  }
}

// Función para obtener los indicadores técnicos
async function getTechnicalIndicators(closePrices) {
  const sma = SMA.calculate({ period: 14, values: closePrices });
  const rsi = RSI.calculate({ period: 14, values: closePrices });
  const macd = MACD.calculate({
    values: closePrices,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const bb = BollingerBands.calculate({
    period: 20,
    values: closePrices,
    stdDev: 2,
  });

  return { sma, rsi, macd, bb };
}
*/

