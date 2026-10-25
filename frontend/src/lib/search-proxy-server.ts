import 'server-only';
import { getApiBaseUrl } from '@/lib/api/config';
import { consumeRateLimit, consumeDetailRateLimit } from '@/lib/rate-limit';
import { createSearchProxy } from './search-proxy.js';

// No accounts in the open-source build: every visitor shares one local
// identity. Add your own auth here if you deploy this publicly.
const LOCAL_USER = 'local-user';

export const searchProxy = createSearchProxy({
  auth: async () => ({ userId: LOCAL_USER }),
  authorize: async () => true,
  planForUser: async () => 'free',
  consumeRateLimit,
  consumeDetailRateLimit,
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  getBaseUrl: getApiBaseUrl,
  getSecret: () => process.env.INTERNAL_API_SECRET,
});
