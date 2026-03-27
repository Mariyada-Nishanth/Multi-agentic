function makeTradeoffNotes(guardianResult, optimizerResult, weatherResult) {
  const notes = [];

  if (guardianResult.budget.overBudget) {
    notes.push('Cost pressure detected: down-ranked premium options.');
  } else {
    notes.push('Budget is within limits: comfort options allowed.');
  }

  if (weatherResult.riskLevel === 'high') {
    notes.push('High weather risk: prioritized resilient schedules and backup options.');
  } else {
    notes.push('Weather risk acceptable: prioritized value and timing.');
  }

  if (!optimizerResult.topFlight) {
    notes.push('No live flight candidates found: switched to placeholder recommendations.');
  }

  return notes;
}

function buildFallbackItinerary(intent, config) {
  return {
    destination: intent.destination,
    dates: intent.travelDates,
    flight: {
      airline: 'Fallback Air',
      flightCode: `${intent.originIata}-${intent.destinationIata || 'NA'}-SIM`,
      departureTime: null,
      arrivalTime: null,
      status: 'simulated',
      estimatedFareInr: config.assumed_base_fare_inr || 7000
    },
    hotel: {
      name: `${intent.destination} Comfort Suites`,
      nightlyInr: Math.round((config.default_hotel_estimate_inr || 12000) / 2),
      comfort: 75
    }
  };
}

function negotiatePlan(intent, optimizerResult, guardianResult, weatherResult, config) {
  const selected = optimizerResult.topFlight && optimizerResult.topHotel
    ? {
        destination: intent.destination,
        dates: intent.travelDates,
        flight: optimizerResult.topFlight,
        hotel: optimizerResult.topHotel
      }
    : buildFallbackItinerary(intent, config);

  const finalEstimateInr =
    ((selected.flight && selected.flight.estimatedFareInr) || 0) * intent.groupSize * 2 +
    (((selected.hotel && selected.hotel.nightlyInr) || 0) * (config.default_nights || 4));

  return {
    selected,
    finalEstimateInr,
    advisories: guardianResult.advisories,
    tradeoffNotes: makeTradeoffNotes(guardianResult, optimizerResult, weatherResult),
    safeToProceed: guardianResult.safeToProceed
  };
}

function completeAndShare(plan, intent) {
  return {
    booking: {
      mode: 'mock',
      bookingId: `TRAVEL-${Date.now()}`,
      status: 'auto-booked-simulated'
    },
    sharePayload: {
      title: `Travel plan ready for ${intent.destination}`,
      summary: [
        `Destination: ${intent.destination}`,
        `Dates: ${intent.travelDates.from || 'TBD'} to ${intent.travelDates.to || 'TBD'}`,
        `Estimated total: INR ${plan.finalEstimateInr}`,
        `Safety: ${plan.safeToProceed ? 'Clear to proceed' : 'Review advisories first'}`
      ].join('\n')
    }
  };
}

module.exports = { negotiatePlan, completeAndShare };
