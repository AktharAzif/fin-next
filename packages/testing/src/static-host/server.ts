// Starts a static host on loopback. The handler learns its own origin only once the port is
// bound, which matters when the port is picked by the system (tests) and for `Host` defaults.
import { type Listening, listen } from "../http/node.ts";
import { createStaticHost, type StaticHost, type StaticHostOptions } from "./host.ts";

export interface StartStaticHostOptions extends StaticHostOptions {
  readonly port?: number;
  /** 127.0.0.1 (the default) or localhost. */
  readonly hostname?: "127.0.0.1" | "localhost";
  readonly onError?: (error: unknown) => void;
}

export interface RunningStaticHost extends Listening {
  readonly host: StaticHost;
}

export async function startStaticHost(options: StartStaticHostOptions): Promise<RunningStaticHost> {
  const host = createStaticHost(options);
  let origin = "";
  const listening = await listen((request) => host.handle(request, origin), {
    host: options.hostname ?? "127.0.0.1",
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  origin = listening.origin;
  return { ...listening, host };
}
