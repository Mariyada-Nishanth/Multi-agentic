function extractBudget(text, fallbackBudgetInr) {
  const underMatch = text.match(/(?:under|below|within)\s*(?:rs\.?|inr)?\s*(\d{3,7})/i);
  if (underMatch) return Number(underMatch[1]);

  const budgetMatch = text.match(/budget\s*(?:is|=|:)?\s*(?:rs\.?|inr)?\s*(\d{3,7})/i);
  if (budgetMatch) return Number(budgetMatch[1]);

  return fallbackBudgetInr;
}

function extractGroupSize(text, fallbackGroupSize) {
  const forMatch = text.match(/for\s*(\d{1,2})\s*(?:people|persons|travellers|travelers)?/i);
  if (forMatch) return Number(forMatch[1]);

  const groupMatch = text.match(/group\s*(?:of)?\s*(\d{1,2})/i);
  if (groupMatch) return Number(groupMatch[1]);

  return fallbackGroupSize;
}

function extractDestination(text, fallbackDestination) {
  const planTripMatch = text.match(/plan\s+([a-z\s]+?)\s+trip/i);
  if (planTripMatch) {
    return planTripMatch[1].trim().replace(/\s+/g, ' ');
  }

  const toMatch = text.match(/trip\s+to\s+([a-z\s]+)/i);
  if (toMatch) {
    return toMatch[1].trim().replace(/\s+/g, ' ');
  }

  return fallbackDestination;
}

function extractDates(text) {
  const now = new Date();
  if (/next\s+month/i.test(text)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 9));
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      confidence: 'high'
    };
  }

  if (/this\s+weekend/i.test(text)) {
    const day = now.getUTCDay();
    const toSaturday = (6 - day + 7) % 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + toSaturday));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + toSaturday + 2));
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      confidence: 'medium'
    };
  }

  return {
    from: null,
    to: null,
    confidence: 'low'
  };
}

function extractPreferences(text, defaults) {
  const picks = new Set(defaults || []);
  const preferenceMap = [
    ['beach', ['beach', 'coast', 'sea']],
    ['adventure', ['adventure', 'trek', 'hike', 'sport']],
    ['luxury', ['luxury', 'premium', 'resort']],
    ['budget', ['budget', 'cheap', 'affordable']],
    ['family', ['family', 'kids', 'children']],
    ['nightlife', ['nightlife', 'party', 'club']]
  ];

  for (const [tag, words] of preferenceMap) {
    if (words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text))) {
      picks.add(tag);
    }
  }

  return Array.from(picks);
}

function interpretIntent(messageText, defaults) {
  const text = (messageText || '').trim();
  const destination = extractDestination(text, defaults.default_destination || 'goa');
  const budgetInr = extractBudget(text, defaults.default_budget_inr || 35000);
  const groupSize = extractGroupSize(text, defaults.default_group_size || 2);
  const travelDates = extractDates(text);
  const preferences = extractPreferences(text, defaults.default_preferences || ['budget']);

  return {
    rawText: text,
    destination,
    originIata: defaults.origin_iata || 'BLR',
    destinationIata: (defaults.city_iata_map || {})[destination.toLowerCase()] || null,
    budgetInr,
    groupSize,
    travelDates,
    preferences
  };
}

module.exports = { interpretIntent };
