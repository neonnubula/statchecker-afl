import { searchProxy } from '@/lib/search-proxy-server';

export async function GET(request: Request) {
  return searchProxy(request, { kind: 'single', detail: false });
}
