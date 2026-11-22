// The one lean layout every Fin email uses (spec 08 §4.1; ARCHITECTURE §9.6; [EM-05]): Fin's own
// words, no image, no tracking, at most one link, typed values only in labelled boxes in the body,
// escaped. Each message has a plain-text part and an HTML part with the same words.
import type { Content, LinkOrigins, RenderContext, Template } from "./classes.ts";

export interface Rendered {
  readonly subject: string;
  readonly preview: string;
  readonly heading: string;
  readonly text: string;
  readonly html: string;
}

export class RenderError extends Error {
  /** `invalid_params` (the row can never be sent) or `link_origin_missing` (configuration). */
  readonly code: "invalid_params" | "link_origin_missing" | "bad_content";
  constructor(code: RenderError["code"], message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

/** Escapes text for an HTML text node or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`=]/gu, (c) => HTML_ESCAPES[c] ?? c);
}

// A fixed string (subject, heading, preview, paragraph, label) never holds markup or a line break.
const FIXED_TEXT = /^[^\r\n<>]{1,400}$/u;

function checkFixed(where: string, value: string): void {
  if (!FIXED_TEXT.test(value)) throw new RenderError("bad_content", `${where} is not plain text`);
}

/** Flattens a typed value onto one line, so it cannot fake a paragraph or a link in the text part. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function linkHref(content: Content, origins: LinkOrigins): string | undefined {
  const link = content.link;
  if (link === undefined) return undefined;
  const origin = origins[link.host];
  if (origin === undefined) {
    throw new RenderError("link_origin_missing", `no origin is configured for ${link.host}`);
  }
  if (!link.path.startsWith("/") || link.path.startsWith("//")) {
    throw new RenderError("bad_content", "a link path starts with one slash");
  }
  return `${origin}${link.path}`;
}

const FOOTER = "This is an automatic message from Fin. Replies to it are not read.";

/** Validates the row's params against the template and renders both parts. */
export function renderTemplate(
  template: Template,
  params: unknown,
  context: RenderContext,
  origins: LinkOrigins,
): Rendered {
  const parsed = template.params.safeParse(params);
  if (!parsed.success) {
    // The issue paths name fields only, never their values.
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(",");
    throw new RenderError("invalid_params", `params refused for ${template.id}: ${fields}`);
  }
  const content = template.render(parsed.data, context);
  return layout(template, content, origins);
}

export function layout(template: Template, content: Content, origins: LinkOrigins): Rendered {
  checkFixed("subject", content.subject);
  checkFixed("heading", content.heading);
  checkFixed("preview", content.preview);
  for (const p of content.paragraphs) checkFixed("paragraph", p);
  for (const f of content.footer ?? []) checkFixed("footer", f);
  for (const b of content.boxes ?? []) checkFixed("box label", b.label);
  if (content.code !== undefined && template.class !== "code") {
    throw new RenderError("bad_content", "only code templates show a code");
  }
  if (content.link !== undefined) checkFixed("link label", content.link.label);
  const href = linkHref(content, origins);

  const text: string[] = [content.heading, ""];
  for (const p of content.paragraphs) text.push(p, "");
  if (content.code !== undefined) text.push(`Your code: ${content.code}`, "");
  for (const b of content.boxes ?? []) text.push(`${b.label}: ${oneLine(b.value)}`);
  if ((content.boxes ?? []).length > 0) text.push("");
  if (href !== undefined && content.link !== undefined)
    text.push(`${content.link.label}: ${href}`, "");
  for (const f of content.footer ?? []) text.push(f, "");
  text.push("Fin", FOOTER);

  const font = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;";
  const html: string[] = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(content.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#ffffff;color:#111111;${font}">`,
    `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(content.preview)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 16px">',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">',
    `<tr><td style="padding:0 0 16px;font-size:20px;font-weight:600;${font}">${escapeHtml(content.heading)}</td></tr>`,
  ];
  for (const p of content.paragraphs) {
    html.push(
      `<tr><td style="padding:0 0 12px;font-size:15px;line-height:22px;${font}">${escapeHtml(p)}</td></tr>`,
    );
  }
  if (content.code !== undefined) {
    html.push(
      `<tr><td style="padding:4px 0 16px;${font}"><div style="font-size:13px;color:#555555">Your code</div>`,
      `<div style="font-size:28px;font-weight:600;letter-spacing:4px;font-family:Menlo,Consolas,monospace">${escapeHtml(content.code)}</div></td></tr>`,
    );
  }
  for (const b of content.boxes ?? []) {
    html.push(
      `<tr><td style="padding:0 0 8px;${font}"><div style="border:1px solid #dddddd;border-radius:6px;padding:8px 12px">`,
      `<div style="font-size:12px;color:#555555">${escapeHtml(b.label)}</div>`,
      `<div style="font-size:15px">${escapeHtml(oneLine(b.value))}</div></div></td></tr>`,
    );
  }
  if (href !== undefined && content.link !== undefined) {
    html.push(
      `<tr><td style="padding:12px 0 16px;${font}"><a href="${escapeHtml(href)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:15px">${escapeHtml(content.link.label)}</a></td></tr>`,
    );
  }
  for (const f of content.footer ?? []) {
    html.push(
      `<tr><td style="padding:0 0 12px;font-size:14px;line-height:20px;color:#333333;${font}">${escapeHtml(f)}</td></tr>`,
    );
  }
  html.push(
    `<tr><td style="padding:16px 0 0;font-size:12px;color:#666666;${font}">Fin<br>${escapeHtml(FOOTER)}</td></tr>`,
    "</table></td></tr></table></body></html>",
  );

  return {
    subject: content.subject,
    preview: content.preview,
    heading: content.heading,
    text: text.join("\n"),
    html: html.join("\n"),
  };
}
