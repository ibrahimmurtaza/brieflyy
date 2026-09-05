import type { HttpClient, HttpResponse } from './http-client.js';

export const systemHttpClient: HttpClient = {
  async get(url: string): Promise<HttpResponse> {
    const res = await fetch(url);
    return {
      status: res.status,
      body: await res.text(),
    };
  },
};