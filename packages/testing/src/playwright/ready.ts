// FW-C16: the app sets `data-ready` on <body> once the first route has resolved; journeys wait
// for it instead of for network idleness or a fixed delay.
import type { Page, Response } from "@playwright/test";

export const READY_SELECTOR = "body[data-ready]";

export async function waitForReady(page: Page, options: { timeout?: number } = {}): Promise<void> {
  await page.locator(READY_SELECTOR).waitFor({
    state: "attached",
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}

/** Opens a path and waits for the app to be ready. Returns the document's response. */
export async function gotoReady(
  page: Page,
  url: string,
  options: { timeout?: number } = {},
): Promise<Response | null> {
  const response = await page.goto(url);
  await waitForReady(page, options);
  return response;
}
