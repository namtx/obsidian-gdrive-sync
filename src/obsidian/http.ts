import { requestUrl } from "obsidian";
import type { Http } from "../drive/http";

/** `requestUrl` bypasses CORS and works on desktop and mobile. */
export const obsidianHttp: Http = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return {
    status: res.status,
    headers: res.headers,
    // Accessing `text` on a binary body can throw; only decode when asked.
    get text() {
      return res.text;
    },
    get arrayBuffer() {
      return res.arrayBuffer;
    },
  };
};
