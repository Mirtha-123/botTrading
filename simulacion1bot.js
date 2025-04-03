

async function simulateHistoricalMonth(symbol, year, month) {
    const { startTime, endTime } = getMonthTimeRange(year, month);
    console.log(`Obteniendo datos históricos para ${symbol}, ${year}-${month}...`);
    
    const candles = await getHistoricalDataForMonth(symbol, '5m', startTime, endTime);
    console.log(`Datos históricos obtenidos: ${candles.length} velas.`);
  
    const closePrices = candles.map(c => parseFloat(c.close));
    const simulationResults = [];
    const totalSteps = closePrices.length - 20; // Número total de iteraciones
  
    for (let i = 20; i < closePrices.length; i++) { // Asegurar suficientes datos para los indicadores
      const progress = ((i - 20) / totalSteps) * 100;
      if (i % Math.ceil(totalSteps / 10) === 0) {
        console.log(`Progreso: ${progress.toFixed(1)}% (${i - 20} de ${totalSteps} pasos completados)`);
      }
  
      try {
        const sma = SMA.calculate({ period: 14, values: closePrices.slice(0, i) });
        const rsi = RSI.calculate({ period: 14, values: closePrices.slice(0, i) });
        const macd = MACD.calculate({
          values: closePrices.slice(0, i),
          fastPeriod: 12,
          slowPeriod: 26,
          signalPeriod: 9,
          SimpleMAOscillator: false,
          SimpleMASignal: false,
        });
        const bb = BollingerBands.calculate({
          period: 20,
          values: closePrices.slice(0, i),
          stdDev: 2,
        });
  
        if (
          sma.length < 2 ||
          rsi.length < 1 ||
          macd.length < 1 ||
          bb.length < 1
        ) {
          console.log(`Datos insuficientes en la iteración ${i}. Saltando...`);
          continue;
        }
  
        const trend = analyzeMarket(sma, rsi, macd, bb);
        const currentClose = closePrices[i];
  
        if (trend > 0) {
          simulationResults.push({ type: 'BUY', price: currentClose, timestamp: candles[i].closeTime });
        } else if (trend < 0) {
          simulationResults.push({ type: 'SELL', price: currentClose, timestamp: candles[i].closeTime });
        }
      } catch (error) {
        console.error(`Error en la iteración ${i}:`, error.message);
      }
    }
  
    calculateResults(simulationResults);
  }
  
  // Función para obtener el rango de tiempo de un mes
  function getMonthTimeRange(year, month) {
    const start = new Date(year, month - 1, 1).getTime();
    const end = new Date(year, month, 0, 23, 59, 59).getTime();
    return { startTime: start, endTime: end };
  }
  
  // Función para obtener datos históricos de Binance
  async function getHistoricalDataForMonth(symbol, interval, startTime, endTime) {
    let data = [];
    let start = startTime;
  
    while (start < endTime) {
      console.log(`Solicitando datos desde ${new Date(start).toISOString()}...`);
      const candles = await client.candles({
        symbol,
        interval,
        startTime: start,
        endTime: endTime,
        limit: 1000, // Límite máximo por solicitud
      });
  
      if (candles.length === 0) break;
  
      data = data.concat(candles);
      start = candles[candles.length - 1].closeTime + 1; // Avanza al siguiente intervalo
    }
  
    console.log(`Datos totales obtenidos: ${data.length}`);
    return data;
  }
  
  // Función para analizar la tendencia del mercado
  function analyzeMarket(sma, rsi, macd, bb) {
    let trend = 0;
  
    // SMA
    if (sma[sma.length - 1] > sma[sma.length - 2]) {
      trend += 1;
    } else {
      trend -= 1;
    }
  
    // RSI
    if (rsi[rsi.length - 1] < 30) {
      trend += 1;
    } else if (rsi[rsi.length - 1] > 70) {
      trend -= 1;
    }
  
    // MACD
    const macdLine = macd[macd.length - 1].MACD;
    const signalLine = macd[macd.length - 1].signal;
    if (macdLine > signalLine) {
      trend += 1;
    } else {
      trend -= 1;
    }
  
    // Bollinger Bands
    const upperBand = bb[bb.length - 1].upper;
    const lowerBand = bb[bb.length - 1].lower;
    const closePrice = bb[bb.length - 1].close;
    if (closePrice < lowerBand) {
      trend += 1;
    } else if (closePrice > upperBand) {
      trend -= 1;
    }
  
    return trend;
  }
  
  // Calcular ganancias y pérdidas
  function calculateResults(simulationResults) {
    let profit = 0;
    let wins = 0;
    let losses = 0;
  
    for (let i = 0; i < simulationResults.length - 1; i++) {
      const current = simulationResults[i];
      const next = simulationResults[i + 1];
  
      if (current.type === 'BUY' && next.type === 'SELL') {
        const result = next.price - current.price;
        profit += result;
        if (result > 0) {
          wins++;
        } else {
          losses++;
        }
      }
    }
  
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  
    console.log('Resultados de la simulación:');
    console.log(`Total Trades: ${totalTrades}`);
    console.log(`Wins: ${wins}`);
    console.log(`Losses: ${losses}`);
    console.log(`Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`Total Profit/Loss: ${profit.toFixed(2)} USDT`);
  }