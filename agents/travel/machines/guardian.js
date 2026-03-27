function buildAdvisories(intent, weatherResult) {
  const advisories = [];

  if (!intent.travelDates.from || !intent.travelDates.to) {
    advisories.push('Travel dates were not fully specified; fallback date window was used.');
  }

  if (weatherResult.riskLevel === 'high') {
    advisories.push('Weather risk is high. Consider flexible cancellation options.');
  } else if (weatherResult.riskLevel === 'medium') {
    advisories.push('Weather has moderate risk. Pack for mixed conditions.');
  }

  if (intent.groupSize >= 6) {
    advisories.push('Large group detected. Pre-book transfers and room blocks.');
  }

  return advisories;
}

function evaluateBudget(intent, flights, hotelEstimateInr) {
  const perPersonFlight = flights.length
    ? Math.min(...flights.map((item) => item.estimatedFareInr))
    : 0;

  const totalEstimate = (perPersonFlight * intent.groupSize * 2) + hotelEstimateInr;
  const overBudget = totalEstimate > intent.budgetInr;

  return {
    totalEstimateInr: totalEstimate,
    perPersonFlightInr: perPersonFlight,
    hotelEstimateInr,
    budgetInr: intent.budgetInr,
    overBudget,
    deltaInr: intent.budgetInr - totalEstimate
  };
}

function checkSafetyAndBudget(intent, sentinelResult, weatherResult, config) {
  const hotelEstimateInr = config.default_hotel_estimate_inr || 12000;
  const budget = evaluateBudget(intent, sentinelResult.flights || [], hotelEstimateInr);

  const advisories = buildAdvisories(intent, weatherResult);
  if (budget.overBudget) {
    advisories.push('Planned itinerary is over budget. Downgrade stay or adjust dates.');
  }

  const riskScore =
    (weatherResult.riskLevel === 'high' ? 60 : weatherResult.riskLevel === 'medium' ? 30 : 10) +
    (budget.overBudget ? 30 : 0);

  return {
    advisories,
    budget,
    riskScore,
    safeToProceed: riskScore < 75
  };
}

module.exports = { checkSafetyAndBudget };
