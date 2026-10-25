/**
 * Analytics is switched off in the open-source build. These no-op functions
 * keep the same interface so you can plug in your own provider if you want.
 */
export function analyticsRequestId() {
  try { return crypto.randomUUID(); } catch { return undefined; }
}

export function analyticsEnabled() { return false; }

export function setAnalyticsOptOut(_disabled) {}

/** Tells the server proxy not to record anything for this request. */
export function analyticsHeaders(_requestId) {
  return { 'x-analytics-opt-out': '1' };
}

export function trackEvent(_eventName, _fields = {}) {}

export function startResearch(_feature, _product = 'afl') {
  return {
    requestId: analyticsRequestId(),
    headers: analyticsHeaders(),
    viewed(_count, _cached = false) {},
    failed(_status) {},
  };
}
