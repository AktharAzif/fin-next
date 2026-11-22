// The few Cloudflare calls an assets-only upload needs (SP-26), with fetch and nothing else. Error
// messages carry the method, the path template, the status and Cloudflare's error codes; never a
// header, a body, a token or an upload token.

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class CloudflareCallError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CloudflareCallError";
    this.status = status;
  }
}

interface Envelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

export interface StaticClient {
  get<T>(path: string): Promise<T>;
  /** A write with the API token. */
  send<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T>;
  /** An assets upload, authorised by the upload session's own token. */
  uploadBucket<T>(path: string, uploadToken: string, form: FormData): Promise<T>;
}

export const API = "https://api.cloudflare.com/client/v4";

/** Paths are written with `<id>` in place of IDs, so a message names the endpoint, not the account. */
function template(path: string): string {
  return path.replace(/\/accounts\/[^/]+/, "/accounts/<account>").split("?")[0] ?? path;
}

export function cloudflareClient(token: string, fetchFn: FetchFn, base = API): StaticClient {
  const call = async <T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string | FormData,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers,
        redirect: "error",
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new CloudflareCallError(`cloudflare ${method} ${template(path)}: network error`, 0);
    }
    const text = await response.text();
    let envelope: Envelope<T> | undefined;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    if (response.status >= 300 || envelope === undefined || envelope.success === false) {
      const codes = (envelope?.errors ?? [])
        .map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim())
        .join("; ")
        .slice(0, 300);
      throw new CloudflareCallError(
        `cloudflare ${method} ${template(path)} answered ${response.status}${codes === "" ? "" : `: ${codes}`}`,
        response.status,
      );
    }
    return envelope.result;
  };
  const auth = { authorization: `Bearer ${token}` };
  return {
    get: (path) => call("GET", path, auth),
    send: (method, path, body) => {
      if (body instanceof FormData) return call(method, path, auth, body);
      return call(
        method,
        path,
        { ...auth, "content-type": "application/json" },
        JSON.stringify(body),
      );
    },
    uploadBucket: (path, uploadToken, form) =>
      call("POST", path, { authorization: `Bearer ${uploadToken}` }, form),
  };
}
