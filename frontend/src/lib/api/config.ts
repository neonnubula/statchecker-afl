/**
 * API Configuration
 *
 * The browser calls a few public read-only backend routes directly (player
 * search and fixtures). Research requests go through this app's /api proxy.
 */

/** Get the API base URL; set NEXT_PUBLIC_API_BASE_URL when you deploy. */
export const getApiBaseUrl = (): string =>
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

/**
 * API base URL for use in fetch requests
 */
export const API_BASE_URL = getApiBaseUrl();
