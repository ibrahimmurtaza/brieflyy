export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpClient {
  get(url: string): Promise<HttpResponse>;
}