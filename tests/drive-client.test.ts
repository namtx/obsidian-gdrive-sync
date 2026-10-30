import { describe, expect, it } from "vitest";
import { DriveClient } from "../src/drive/client";
import type { HttpRequest, HttpResponse } from "../src/drive/http";
import { multipartBody } from "../src/drive/remote";

type Reply = { status: number; body?: string } | Error;

function setup(replies: Reply[]) {
  const requests: HttpRequest[] = [];
  const sleeps: number[] = [];
  let refreshes = 0;
  let token = "t1";
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    const r = replies.shift();
    if (!r) throw new Error("unexpected request");
    if (r instanceof Error) throw r;
    const text = r.body ?? "{}";
    return { status: r.status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
  };
  const client = new DriveClient(
    http,
    {
      accessToken: async () => token,
      refresh: async () => {
        refreshes++;
        token = `t${refreshes + 1}`;
      },
    },
    { sleep: async (ms) => void sleeps.push(ms), random: () => 1, baseDelayMs: 100, maxRetries: 3 },
  );
  return { client, requests, sleeps, refreshes: () => refreshes };
}

describe("DriveClient", () => {
  it("adds the bearer token", async () => {
    const { client, requests } = setup([{ status: 200 }]);
    await client.request({ url: "u" });
    expect(requests[0]!.headers).toEqual({ Authorization: "Bearer t1" });
  });

  it("backs off exponentially on 429 and 5xx, then succeeds", async () => {
    const { client, sleeps } = setup([{ status: 429 }, { status: 503 }, { status: 500 }, { status: 200 }]);
    expect((await client.request({ url: "u" })).status).toBe(200);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("retries 403 rate-limit errors but not other 403s", async () => {
    const rate = setup([{ status: 403, body: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' }, { status: 200 }]);
    expect((await rate.client.request({ url: "u" })).status).toBe(200);

    const denied = setup([{ status: 403, body: '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}' }]);
    expect((await denied.client.request({ url: "u" })).status).toBe(403);
  });

  it("retries network errors and gives up after the limit", async () => {
    const ok = setup([new Error("offline"), { status: 200 }]);
    expect((await ok.client.request({ url: "u" })).status).toBe(200);

    const down = setup([new Error("a"), new Error("b"), new Error("c"), new Error("d")]);
    await expect(down.client.request({ url: "u" })).rejects.toThrow("d");
  });

  it("returns the last retryable response once retries are exhausted", async () => {
    const { client, requests } = setup([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    expect((await client.request({ url: "u" })).status).toBe(503);
    expect(requests).toHaveLength(4);
  });

  it("refreshes the token once on 401", async () => {
    const { client, requests, refreshes } = setup([{ status: 401 }, { status: 200 }]);
    expect((await client.request({ url: "u" })).status).toBe(200);
    expect(refreshes()).toBe(1);
    expect(requests[1]!.headers).toEqual({ Authorization: "Bearer t2" });
  });

  it("does not loop on a persistent 401", async () => {
    const { client } = setup([{ status: 401 }, { status: 401 }]);
    expect((await client.request({ url: "u" })).status).toBe(401);
  });

  it("does not retry client errors", async () => {
    const { client, requests } = setup([{ status: 404 }]);
    expect((await client.request({ url: "u" })).status).toBe(404);
    expect(requests).toHaveLength(1);
  });
});

describe("multipartBody", () => {
  it("frames metadata and binary content", () => {
    const body = new Uint8Array(multipartBody("B", { name: "n" }, new Uint8Array([0, 255])));
    const text = new TextDecoder("latin1").decode(body);
    expect(text).toBe(
      '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"n"}\r\n' +
        "--B\r\nContent-Type: application/octet-stream\r\n\r\n\u0000ÿ\r\n--B--",
    );
  });
});
