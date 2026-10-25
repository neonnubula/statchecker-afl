import { searchProxy } from '@/lib/search-proxy-server';

export async function POST(request: Request) {
  return searchProxy(request, { kind: 'sgm', detail: false });
}
