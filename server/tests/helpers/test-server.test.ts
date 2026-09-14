import { describe, expect, it } from "vitest";
import request from "supertest";
import { startTestServer } from "./test-server.js";

const server = startTestServer((app) => {
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/echo", (req, res) => {
    res.json(req.body);
  });
});

describe("startTestServer", () => {
  it("binds to the IPv4 loopback address, not the dual-stack [::] wildcard", () => {
    // Regression guard for the intermittent 404/503 failures in the route
    // suites on macOS. supertest's own `app.listen(0)` binds `[::]:0`; the
    // BSD port picker only checks for conflicts within the same address
    // family, so it can hand back a port another process already holds on
    // 127.0.0.1. The client then connects to 127.0.0.1:<port> and the kernel
    // routes it to the more-specific foreign listener — the Express app
    // never sees the request. Binding 127.0.0.1 explicitly makes the picker
    // check the right family, so the port is guaranteed to be ours.
    expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  });

  it("serves the mounted routes through supertest", async () => {
    const res = await request(server).get("/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("parses JSON bodies like the production middleware stack", async () => {
    const res = await request(server).post("/echo").send({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: "world" });
  });
});
