import { searchProxy } from '@/lib/search-proxy-server';

export const maxDuration = 60;

export async function POST(request: Request) {
  return searchProxy(request, { kind: 'sgm', impact: true });
}
