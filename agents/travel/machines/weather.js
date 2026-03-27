const https = require('https');

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function summarizeForecast(list) {
  const buckets = {
    rainSlots: 0,
    harshSlots: 0,
    averageTemp: 0
  };

  if (!Array.isArray(list) || !list.length) {
    return {
      summary: 'No forecast data',
      riskLevel: 'unknown',
      avgTempC: null,
      rainChance: 0
    };
  }

  for (const item of list) {
    const main = item.weather && item.weather[0] && item.weather[0].main || '';
    const temp = item.main && item.main.temp || 0;
    if (/rain|storm|thunder/i.test(main)) buckets.rainSlots += 1;
    if (temp >= 36 || temp <= 10 || /storm/i.test(main)) buckets.harshSlots += 1;
    buckets.averageTemp += temp;
  }

  const avgTempC = Number((buckets.averageTemp / list.length).toFixed(1));
  const rainChance = Number(((buckets.rainSlots / list.length) * 100).toFixed(1));

  let riskLevel = 'low';
  if (buckets.harshSlots >= 3 || rainChance >= 45) riskLevel = 'high';
  else if (buckets.harshSlots >= 1 || rainChance >= 20) riskLevel = 'medium';

  return {
    summary: `Avg ${avgTempC}C, rain chance ${rainChance}%`,
    riskLevel,
    avgTempC,
    rainChance
  };
}

async function checkForecast(intent, config) {
  if (!config.openweather_api_key) {
    throw new Error('Missing openweather_api_key in travel config');
  }

  const params = new URLSearchParams({
    q: intent.destination,
    appid: config.openweather_api_key,
    units: 'metric'
  });

  const url = `https://api.openweathermap.org/data/2.5/forecast?${params.toString()}`;
  const payload = await requestJson(url);
  const points = Array.isArray(payload.list) ? payload.list.slice(0, 12) : [];

  return {
    source: 'openweather',
    city: payload.city && payload.city.name || intent.destination,
    ...summarizeForecast(points)
  };
}

module.exports = { checkForecast };
