import type { Http } from "../src/drive/http";

/** Node `fetch` adapter for running the Drive layer outside Obsidian. */
export const nodeHttp: Http = async (req) => {
  const res = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    redirect: "manual",
  });
  const arrayBuffer = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key] = value));
  return {
    status: res.status,
    headers,
    arrayBuffer,
    get text() {
      return new TextDecoder().decode(arrayBuffer);
    },
  };
};
