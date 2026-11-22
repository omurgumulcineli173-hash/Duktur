import { DurableObject } from 'cloudflare:workers';
import { createCore } from './core.js';
import { FILES } from './web.js';

// Tüm forum verisi tek bir Durable Object içinde tutulur (SQLite tabanlı).
export class Forum extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.core = createCore(state.storage, env.SITE_NAME || 'DUKTUR');
    state.blockConcurrencyWhile(() => this.core.init());
  }
  fetch(request) { return this.core.handle(request); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return env.FORUM.get(env.FORUM.idFromName('main')).fetch(request);
    }
    const f = FILES[url.pathname === '/' ? '/index.html' : url.pathname];
    if (!f) return new Response('Not found', { status: 404 });
    return new Response(f.body, {
      headers: {
        'Content-Type': f.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      },
    });
  },
};
