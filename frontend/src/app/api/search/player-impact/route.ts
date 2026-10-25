import { searchProxy } from '@/lib/search-proxy-server';

export const maxDuration = 60;

export async function GET(request: Request) {
  return searchProxy(request, { kind: 'single', impact: true });
}
