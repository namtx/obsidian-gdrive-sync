export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** Never throws on HTTP error statuses; callers inspect `status`. */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    context: string,
  ) {
    super(`${context}: HTTP ${status} ${body.slice(0, 300)}`);
  }
}
