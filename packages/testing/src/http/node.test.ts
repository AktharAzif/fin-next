import { afterEach, describe, expect, it } from "vitest";
import { selfSignedIdentity } from "./certificate.ts";
import {
  forward,
  type Handler,
  hostMatches,
  isLoopbackName,
  type Listening,
  type ListenOptions,
  listen,
} from "./node.ts";

const open: Listening[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function serve(handler: Handler, options: ListenOptions = {}): Promise<Listening> {
  const server = await listen(handler, options);
  open.push(server);
  return server;
}

const ok: Handler = async (request) => new Response(`ok ${request.method}`);

/** A GET with exactly this `Host`, sent to the server's bound address. */
function getWithHost(server: Listening, host: string, ca?: string) {
  return forward(
    server.loopbackOrigin,
    { method: "GET", target: "/", headers: [["Host", host]], body: null },
    ca === undefined ? {} : { ca },
  );
}

describe("names", () => {
  it("knows the names a browser resolves to loopback by itself", () => {
    for (const name of [
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "console.localhost",
      "a.b.localhost",
    ]) {
      expect(isLoopbackName(name)).toBe(true);
    }
    for (const name of [
      "example.com",
      "localhost.example.com",
      "evil-localhost",
      ".localhost",
      "-a.localhost",
    ]) {
      expect(isLoopbackName(name)).toBe(false);
    }
  });

  it("matches a Host to the server's own name or a loopback name, with its port", () => {
    const self = { name: "console.localhost", port: 4101, secure: true };
    expect(hostMatches("console.localhost:4101", self)).toBe(true);
    expect(hostMatches("Console.LocalHost:4101", self)).toBe(true);
    expect(hostMatches("127.0.0.1:4101", self)).toBe(true);
    expect(hostMatches("localhost:4101", self)).toBe(true);
    expect(hostMatches("[::1]:4101", self)).toBe(true);
    expect(hostMatches("admin.localhost:4101", self)).toBe(false);
    expect(hostMatches("console.localhost:4102", self)).toBe(false);
    expect(hostMatches("console.localhost", self)).toBe(false);
    expect(hostMatches("attacker.example:4101", self)).toBe(false);
    expect(hostMatches(undefined, self)).toBe(false);
    expect(hostMatches("console.localhost", { ...self, port: 443 })).toBe(true);
    expect(hostMatches("console.localhost", { ...self, port: 80, secure: false })).toBe(true);
  });

  it("listens on loopback only, under a loopback name", async () => {
    await expect(listen(ok, { host: "0.0.0.0" })).rejects.toThrow("loopback only");
    await expect(listen(ok, { name: "console.example.com" })).rejects.toThrow(".localhost");
  });
});

describe("the Host check", () => {
  it("answers its own name and loopback names, and 421 for any other Host", async () => {
    const seen: string[] = [];
    const refused: string[] = [];
    const server = await serve(
      async (request) => {
        seen.push(request.method);
        return new Response("ok");
      },
      { name: "sink.localhost", onMisdirected: ({ method }) => refused.push(method) },
    );
    expect(server.origin).toBe(`http://sink.localhost:${server.port}`);
    expect(server.loopbackOrigin).toBe(`http://127.0.0.1:${server.port}`);
    for (const host of [server.authority, `127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      expect((await getWithHost(server, host)).status).toBe(200);
    }
    for (const host of [`attacker.example:${server.port}`, `127.0.0.1:${server.port + 1}`, ""]) {
      const response = await getWithHost(server, host);
      expect(response.status).toBe(421);
      expect(await response.text()).toContain("Misdirected");
    }
    expect(seen).toHaveLength(3);
    expect(refused).toEqual(["GET", "GET", "GET"]);
  });

  it("answers any Host only when told to (a stand-in of a server behind a proxy)", async () => {
    const server = await serve(ok, { anyHost: true });
    expect((await getWithHost(server, "console.example.test")).status).toBe(200);
  });
});

describe("https", () => {
  it("serves over TLS under its name, trusted through its own certificate", async () => {
    const tls = selfSignedIdentity(["console.localhost", "127.0.0.1"]);
    const server = await serve(ok, { name: "console.localhost", tls });
    expect(server.origin).toBe(`https://console.localhost:${server.port}`);
    expect(server.loopbackOrigin).toBe(`https://127.0.0.1:${server.port}`);
    expect(server.certificate).toBe(tls.cert);
    const response = await getWithHost(server, server.authority, tls.cert);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok GET");
    await expect(getWithHost(server, server.authority)).rejects.toThrow();
    const other = selfSignedIdentity(["127.0.0.1"]).cert;
    await expect(getWithHost(server, server.authority, other)).rejects.toThrow();
  });
});

describe("forward's timeout", () => {
  it("gives up when no answer headers come in time", async () => {
    const server = await serve(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    await expect(
      forward(
        server.loopbackOrigin,
        { method: "GET", target: "/", headers: [["Host", server.authority]], body: null },
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("did not answer");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("lets a body stream past the wait once the headers have come", async () => {
    // The rest of the body is sent only once the client has the headers and the first part and the
    // connection has then stood idle for longer than the wait, which a timer still running would
    // have ended. Events order the steps, not timers racing each other: the one timer left is the
    // idle time, and a timer never fires early. The wait is the test's one bound on the machine:
    // the headers must come within it, and a loaded machine took over 100 ms, so it is a second.
    const waitMs = 1000;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await serve(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("first "));
          await released;
          controller.enqueue(encoder.encode("second"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });
    const response = await forward(
      server.loopbackOrigin,
      { method: "GET", target: "/", headers: [["Host", server.authority]], body: null },
      { timeoutMs: waitMs },
    );
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (until: (text: string) => boolean) => {
      while (!until(text)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await readUntil((seen) => seen.length >= "first ".length);
    expect(text).toBe("first ");
    await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
    release();
    await readUntil(() => false);
    expect(text).toBe("first second");
  });

  it("refuses an upstream that is not http or https", async () => {
    await expect(
      forward("ftp://127.0.0.1/", { method: "GET", target: "/", headers: [], body: null }),
    ).rejects.toThrow("http or https");
  });
});
