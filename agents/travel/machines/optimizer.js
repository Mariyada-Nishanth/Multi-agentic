function rankFlight(flight, preferenceWeights) {
  const fareWeight = preferenceWeights.fare || 0.6;
  const statusWeight = preferenceWeights.status || 0.2;
  const timeWeight = preferenceWeights.time || 0.2;

  const fareScore = Math.max(0, 100 - Math.round((flight.estimatedFareInr || 0) / 150));
  const statusScore = /active|scheduled/i.test(flight.status || '') ? 90 : 60;

  const hour = Number((flight.departureTime || '').slice(11, 13)) || 11;
  const timeScore = hour >= 7 && hour <= 20 ? 85 : 65;

  const score =
    (fareScore * fareWeight) +
    (statusScore * statusWeight) +
    (timeScore * timeWeight);

  return {
    ...flight,
    score: Number(score.toFixed(2))
  };
}

function getHotelOptions(intent, config) {
  const base = config.default_hotel_estimate_inr || 12000;
  const options = [
    {
      name: `${intent.destination} Value Stay`,
      nightlyInr: Math.round(base / 3),
      comfort: 55
    },
    {
      name: `${intent.destination} Comfort Suites`,
      nightlyInr: Math.round(base / 2),
      comfort: 75
    },
    {
      name: `${intent.destination} Premium Resort`,
      nightlyInr: Math.round(base / 1.3),
      comfort: 92
    }
  ];

  if (intent.preferences.includes('budget')) {
    return options.sort((a, b) => a.nightlyInr - b.nightlyInr);
  }
  if (intent.preferences.includes('luxury')) {
    return options.sort((a, b) => b.comfort - a.comfort);
  }
  return options;
}

function pickBestValue(intent, sentinelResult, config) {
  const preferenceWeights = config.optimizer_weights || {
    fare: 0.6,
    status: 0.2,
    time: 0.2
  };

  const rankedFlights = (sentinelResult.flights || [])
    .map((flight) => rankFlight(flight, preferenceWeights))
    .sort((a, b) => b.score - a.score);

  const hotels = getHotelOptions(intent, config);

  return {
    rankedFlights,
    hotels,
    topFlight: rankedFlights[0] || null,
    topHotel: hotels[0] || null
  };
}

module.exports = { pickBestValue };
