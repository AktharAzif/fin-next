// An in-memory Better Stack with the recorded JSON:API shapes of its Telemetry, Errors and Uptime
// APIs: lists as { data, pagination }, items as { data: { id, type, attributes } }. It checks the
// bearer token per product, keeps what was sent, and adds what Better Stack adds (team_name,
// tokens, ingest hosts, heartbeat URLs), with values built at run time.

type Attrs = Record<string, unknown>;
interface Item {
  id: string;
  attributes: Attrs;
}

export interface FakeOptions {
  telemetryToken: string;
  uptimeToken: string;
  team?: string;
}

export interface Request {
  method: string;
  host: string;
  path: string;
  body: unknown;
}

const COLLECTIONS = [
  "sources",
  "explorations",
  "alerts",
  "applications",
  "urgencies",
  "policies",
  "monitors",
  "heartbeats",
] as const;

export class FakeBetterStack {
  readonly requests: Request[] = [];
  readonly store = new Map<string, Item[]>();
  #next = 100;
  readonly #options: FakeOptions;

  constructor(options: FakeOptions) {
    this.#options = options;
    for (const c of COLLECTIONS) this.store.set(c, []);
  }

  items(collection: string): Item[] {
    let list = this.store.get(collection);
    if (list === undefined) {
      list = [];
      this.store.set(collection, list);
    }
    return list;
  }

  /** Adds an object as if someone had made it in Better Stack's UI. */
  seed(collection: string, attributes: Attrs): Item {
    const item = {
      id: String(this.#next++),
      attributes: { team_name: this.#options.team ?? "fin-staging", ...attributes },
    };
    this.items(collection).push(item);
    return item;
  }

  #extras(collection: string, id: string): Attrs {
    const host = ["s", id, ".eu-nbg-2.example.com"].join("");
    if (collection === "sources" || collection === "applications") {
      return {
        token: ["tok", collection, id].join("-"),
        ingesting_host: host,
        table_name: `t_${id}`,
      };
    }
    if (collection === "heartbeats") return { url: `https://heartbeat.example.com/beat/${id}` };
    return {};
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    this.requests.push({ method, host: url.hostname, path: url.pathname, body });
    const token = new Headers(init?.headers).get("authorization");
    const want =
      url.hostname === "incidents.betterstack.com"
        ? this.#options.uptimeToken
        : this.#options.telemetryToken;
    if (token !== `Bearer ${want}`) return json({ errors: "Invalid authentication" }, 401);
    const parts = url.pathname.split("/").filter(Boolean); // api, vN, collection, ...
    let collection = parts[2] ?? "";
    let id = parts[3];
    let parentKey: string | undefined;
    if (collection === "sources" && parts[4] === "metrics") {
      collection = `metrics:${parts[3]}`;
      id = parts[5];
    } else if (collection === "explorations" && parts[4] === "alerts") {
      parentKey = parts[3];
      collection = "alerts";
      id = undefined;
    }
    const list = this.items(collection);
    if (method === "GET" && id === undefined) {
      return json({
        data: list.map((i) => ({ id: i.id, type: collection, attributes: i.attributes })),
        pagination: { next: null },
      });
    }
    if (method === "GET") {
      const item = list.find((i) => i.id === id);
      return item === undefined
        ? json({ errors: "Not found" }, 404)
        : json({ data: { id: item.id, attributes: item.attributes } });
    }
    if (method === "POST") {
      const newId = String(this.#next++);
      const attributes: Attrs = {
        ...(body as Attrs),
        team_name: this.#options.team ?? "fin-staging",
        ...this.#extras(collection, newId),
        ...(parentKey === undefined ? {} : { exploration_id: Number(parentKey) }),
      };
      if (collection === "alerts") {
        const target = (body as Attrs).escalation_target as Attrs;
        attributes.escalation_target = { ...target, policy_name: "staging-quiet" };
      }
      list.push({ id: newId, attributes });
      return json({ data: { id: newId, attributes } }, 201);
    }
    const item = list.find((i) => i.id === id);
    if (item === undefined) return json({ errors: "Not found" }, 404);
    if (method === "PATCH") {
      Object.assign(item.attributes, body as Attrs);
      return json({ data: { id: item.id, attributes: item.attributes } });
    }
    if (method === "DELETE") {
      list.splice(list.indexOf(item), 1);
      return new Response(null, { status: 204 });
    }
    return json({ errors: "Method not allowed" }, 405);
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
