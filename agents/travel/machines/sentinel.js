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

function estimateFareInr(flight, baseFareInr, volatilityFactor) {
  const depHour = Number((flight.departure && flight.departure.scheduled || '').slice(11, 13)) || 10;
  const multiplier = depHour < 8 || depHour > 21 ? 1.08 : 1.0;
  const randomizer = 0.92 + (Math.abs((flight.flight && flight.flight.number || '').length - 4) * 0.03);
  return Math.round(baseFareInr * multiplier * randomizer * volatilityFactor);
}

async function scanFlights(intent, config) {
  if (!config.aviationstack_api_key) {
    throw new Error('Missing aviationstack_api_key in travel config');
  }
  if (!intent.destinationIata) {
    throw new Error(`No destination IATA mapping configured for ${intent.destination}`);
  }

  const params = new URLSearchParams({
    access_key: config.aviationstack_api_key,
    dep_iata: intent.originIata,
    arr_iata: intent.destinationIata,
    limit: String(config.flight_result_limit || 8)
  });

  const url = `https://api.aviationstack.com/v1/flights?${params.toString()}`;
  const payload = await requestJson(url);

  const rows = Array.isArray(payload.data) ? payload.data : [];
  const unique = [];
  const seen = new Set();

  for (const row of rows) {
    const key = `${row.airline && row.airline.iata || ''}-${row.flight && row.flight.number || ''}-${row.departure && row.departure.scheduled || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const selected = unique.slice(0, config.flight_result_limit || 8).map((flight) => {
    const fareInr = estimateFareInr(
      flight,
      config.assumed_base_fare_inr || 7000,
      config.price_volatility_factor || 1
    );

    return {
      airline: (flight.airline && flight.airline.name) || 'Unknown Airline',
      flightCode: `${flight.flight && flight.flight.iata || ''}`.trim() || 'N/A',
      departureTime: flight.departure && flight.departure.scheduled || null,
      arrivalTime: flight.arrival && flight.arrival.scheduled || null,
      status: flight.flight_status || 'unknown',
      estimatedFareInr: fareInr
    };
  });

  return {
    source: 'aviationstack',
    route: `${intent.originIata}-${intent.destinationIata}`,
    flights: selected
  };
}

module.exports = { scanFlights };
