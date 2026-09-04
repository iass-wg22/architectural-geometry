/* ========================================================================== */
/* AUTOMATIC RETRY POLICY                                                     */
/* ========================================================================== */

// A delivery is attempted immediately when the suggestion is submitted.
// These delays apply only after that first attempt has failed.
//
// Attempt 1 failed -> retry after 1 minute.
// Attempt 2 failed -> retry after 5 minutes.
// Attempt 3 failed -> retry after 30 minutes.
// Attempt 4 failed -> retry after 2 hours.
// Attempt 5 failed -> stop automatic retries and request human attention.
export const automaticRetryDelaysMilliseconds = Object.freeze([
  1 * 60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
]);

export const maximumAutomaticDeliveryAttempts =
  automaticRetryDelaysMilliseconds.length + 1;

/* ========================================================================== */
/* VALIDATION UTILITIES                                                       */
/* ========================================================================== */

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function parseRequiredDate(value, fieldName) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `The retry policy ${fieldName} is missing or invalid.`,
    );
  }

  return date;
}

function normalizeAttemptCount(value) {
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

/* ========================================================================== */
/* ATTEMPT COUNT                                                              */
/* ========================================================================== */

/**
 * Determine how many GitHub delivery attempts have already occurred.
 *
 * New records contain an explicit attemptCount. Older records can be inferred
 * from their attempts array or, as a final fallback, from the presence of a
 * completed delivery status and timestamp.
 */
export function getDeliveryAttemptCount(delivery) {
  if (!isPlainObject(delivery)) {
    return 0;
  }

  const explicitAttemptCount = normalizeAttemptCount(
    delivery.attemptCount,
  );

  if (explicitAttemptCount !== null) {
    return explicitAttemptCount;
  }

  if (Array.isArray(delivery.attempts)) {
    return delivery.attempts.length;
  }

  const deliveryStatus = String(
    delivery.status ?? "",
  ).toLowerCase();

  const hasRecordedAttempt =
    typeof delivery.attemptedAt === "string" &&
    delivery.attemptedAt.trim();

  if (
    hasRecordedAttempt ||
    deliveryStatus === "failed" ||
    deliveryStatus === "delivered"
  ) {
    return 1;
  }

  return 0;
}

/* ========================================================================== */
/* SCHEDULE CALCULATION                                                       */
/* ========================================================================== */

/**
 * Return the delay that follows the given failed attempt.
 *
 * A null value means that the automatic retry budget is exhausted.
 */
export function getAutomaticRetryDelayMilliseconds(
  attemptCount,
) {
  const normalizedAttemptCount = normalizeAttemptCount(
    attemptCount,
  );

  if (
    normalizedAttemptCount === null ||
    normalizedAttemptCount < 1
  ) {
    throw new Error(
      "The retry attempt count must be a positive integer.",
    );
  }

  if (
    normalizedAttemptCount >=
    maximumAutomaticDeliveryAttempts
  ) {
    return null;
  }

  return automaticRetryDelaysMilliseconds[
    normalizedAttemptCount - 1
  ];
}

/**
 * Calculate the next retry date from the last attempted delivery.
 *
 * A null value indicates that no further automatic attempt is allowed.
 */
export function calculateNextAutomaticRetryAt(delivery) {
  if (!isPlainObject(delivery)) {
    throw new Error(
      "The retry policy requires delivery information.",
    );
  }

  const attemptCount = getDeliveryAttemptCount(delivery);
  const delayMilliseconds =
    getAutomaticRetryDelayMilliseconds(attemptCount);

  if (delayMilliseconds === null) {
    return null;
  }

  const attemptedAt = parseRequiredDate(
    delivery.attemptedAt,
    "attemptedAt date",
  );

  return new Date(
    attemptedAt.getTime() + delayMilliseconds,
  ).toISOString();
}

/**
 * Add deterministic automatic-retry metadata to a failed delivery.
 *
 * The input object is never modified. The returned object is a new value that
 * can later be persisted by the storage or retry service.
 */
export function applyAutomaticRetrySchedule(delivery) {
  if (!isPlainObject(delivery)) {
    throw new Error(
      "The retry policy requires delivery information.",
    );
  }

  if (delivery.status !== "failed") {
    throw new Error(
      `Automatic retry scheduling requires delivery status "failed", received "${delivery.status}".`,
    );
  }

  const attemptCount = getDeliveryAttemptCount(delivery);
  const nextRetryAt = calculateNextAutomaticRetryAt(
    delivery,
  );

  if (nextRetryAt === null) {
    return {
      ...delivery,
      status: "needs-attention",
      attemptCount,
      nextRetryAt: null,
    };
  }

  return {
    ...delivery,
    status: "failed",
    attemptCount,
    nextRetryAt,
  };
}

/* ========================================================================== */
/* RETRY DECISION                                                             */
/* ========================================================================== */

/**
 * Decide what the automatic worker should do with one stored record.
 *
 * Possible decisions:
 * - ignore: the record is not a failed delivery;
 * - wait: the next retry date has not arrived;
 * - retry-now: the record is due for another attempt;
 * - needs-attention: the automatic attempt budget is exhausted.
 */
export function evaluateAutomaticRetry(
  storedRecord,
  now = new Date(),
) {
  if (!isPlainObject(storedRecord)) {
    throw new Error(
      "The retry policy requires a stored suggestion record.",
    );
  }

  const currentDate = parseRequiredDate(
    now,
    "current date",
  );

  const delivery = storedRecord.delivery;

  if (!isPlainObject(delivery)) {
    return {
      decision: "ignore",
      reason: "missing-delivery-information",
      attemptCount: 0,
      nextRetryAt: null,
    };
  }

  if (delivery.status === "needs-attention") {
    return {
      decision: "needs-attention",
      reason: "automatic-attempt-budget-exhausted",
      attemptCount: getDeliveryAttemptCount(delivery),
      nextRetryAt: null,
    };
  }

  if (delivery.status !== "failed") {
    return {
      decision: "ignore",
      reason: `delivery-status-${delivery.status ?? "missing"}`,
      attemptCount: getDeliveryAttemptCount(delivery),
      nextRetryAt: null,
    };
  }

  const scheduledDelivery = applyAutomaticRetrySchedule(
    delivery,
  );

  if (scheduledDelivery.status === "needs-attention") {
    return {
      decision: "needs-attention",
      reason: "automatic-attempt-budget-exhausted",
      attemptCount: scheduledDelivery.attemptCount,
      nextRetryAt: null,
    };
  }

  const nextRetryDate = parseRequiredDate(
    scheduledDelivery.nextRetryAt,
    "nextRetryAt date",
  );

  if (currentDate.getTime() < nextRetryDate.getTime()) {
    return {
      decision: "wait",
      reason: "retry-not-due-yet",
      attemptCount: scheduledDelivery.attemptCount,
      nextRetryAt: scheduledDelivery.nextRetryAt,
    };
  }

  return {
    decision: "retry-now",
    reason: "retry-date-reached",
    attemptCount: scheduledDelivery.attemptCount,
    nextRetryAt: scheduledDelivery.nextRetryAt,
  };
}
