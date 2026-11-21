// Starts a static host on loopback, over https as the zone answers, under the host name the
// browser uses. The handler learns its own origin only once the port is bound, which matters when
// the port is picked by the system (tests) and for `Host` defaults.

import { type Listening, listen } from "@fin/server/testing/node-http";
import { selfSignedIdentity, type TlsIdentity } from "../http/certificate.ts";
import { createStaticHost, requestLine, type StaticHost, type StaticHostOptions } from "./host.ts";

export interface StartStaticHostOptions extends StaticHostOptions {
  readonly port?: number;
  /**
   * The host name the browser uses (default 127.0.0.1): localhost or a name under `.localhost`,
   * such as `console.localhost` (`appHostName`), so each app keeps its own cookie jar. The server
   * binds 127.0.0.1 whatever the name.
   */
  readonly name?: string;
  /**
   * https with this identity; by default a fresh self-signed one for the name, localhost and
   * 127.0.0.1. `false` serves plain http, for a test of the routing alone, never a journey: WebKit
   * drops a `Secure` cookie on http.
   */
  readonly tls?: TlsIdentity | false;
  readonly onError?: (error: unknown) => void;
}

export interface RunningStaticHost extends Listening {
  readonly host: StaticHost;
}

export async function startStaticHost(options: StartStaticHostOptions): Promise<RunningStaticHost> {
  const host = createStaticHost(options);
  const name = options.name ?? "127.0.0.1";
  const tls =
    options.tls === false
      ? undefined
      : (options.tls ?? selfSignedIdentity([...new Set([name, "localhost", "127.0.0.1"])]));
  const now = options.now ?? Date.now;
  let origin = "";
  const listening = await listen((request) => host.handle(request, origin), {
    host: "127.0.0.1",
    name,
    ...(tls === undefined ? {} : { tls }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    onMisdirected: ({ method }) => {
      const at = now();
      options.log?.(requestLine(options.app, method, "misdirected", 421, at, at));
    },
  });
  origin = listening.origin;
  return { ...listening, host };
}
