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

function parseDateOnly(dateText) {
  if (!dateText || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const [y, m, d] = dateText.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isoFromDateAndTime(dateUtc, sourceIso, defaultHour, defaultMinute) {
  if (!(dateUtc instanceof Date)) return sourceIso || null;

  const parsed = sourceIso ? new Date(sourceIso) : null;
  const useParsed = parsed instanceof Date && !Number.isNaN(parsed.getTime());
  const hour = useParsed ? parsed.getUTCHours() : defaultHour;
  const minute = useParsed ? parsed.getUTCMinutes() : defaultMinute;

  const merged = new Date(Date.UTC(
    dateUtc.getUTCFullYear(),
    dateUtc.getUTCMonth(),
    dateUtc.getUTCDate(),
    hour,
    minute,
    0,
    0
  ));

  return merged.toISOString();
}

function alignFlightToIntentDates(intent, departureIso, arrivalIso) {
  const startDate = parseDateOnly(intent && intent.travelDates && intent.travelDates.from);
  if (!startDate) {
    return { departureTime: departureIso || null, arrivalTime: arrivalIso || null };
  }

  const alignedDeparture = isoFromDateAndTime(startDate, departureIso, 9, 0);
  let alignedArrival = isoFromDateAndTime(startDate, arrivalIso, 10, 30);

  const dep = alignedDeparture ? new Date(alignedDeparture) : null;
  const arr = alignedArrival ? new Date(alignedArrival) : null;
  if (dep && arr && !Number.isNaN(dep.getTime()) && !Number.isNaN(arr.getTime()) && arr <= dep) {
    alignedArrival = new Date(dep.getTime() + (90 * 60 * 1000)).toISOString();
  }

  return { departureTime: alignedDeparture, arrivalTime: alignedArrival };
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
    const aligned = alignFlightToIntentDates(
      intent,
      flight.departure && flight.departure.scheduled || null,
      flight.arrival && flight.arrival.scheduled || null
    );

    return {
      airline: (flight.airline && flight.airline.name) || 'Unknown Airline',
      flightCode: `${flight.flight && flight.flight.iata || ''}`.trim() || 'N/A',
      departureTime: aligned.departureTime,
      arrivalTime: aligned.arrivalTime,
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
