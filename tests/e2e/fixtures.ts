import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";

export type Actor = { context: BrowserContext; page: Page };
type Fixtures = { actor: (identity?: string) => Promise<Actor> };

export const test = base.extend<Fixtures>({
  actor: async ({ browser, baseURL }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide(async (identity = "alex") => {
      const context = await browser.newContext({ baseURL, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      // Authentication is setup; every product operation goes through the UI.
      const session = await context.request.post("/api/local/session", {
        headers: { Origin: baseURL! }, data: { identity }
      });
      expect(session.ok(), `Authenticate ${identity}: ${session.status()}`).toBe(true);
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator(".user-chip__name")).toBeVisible();
      return { context, page };
    });
    await Promise.all(contexts.map((context) => context.close()));
  }
});

export { expect };

export async function createBoard(page: Page, prefix: string, displayName = "Alex Morgan") {
  const title = `${prefix} ${crypto.randomUUID()}`;
  await page.getByRole("button", { name: /Start a retro/ }).click();
  await page.getByLabel("Retro title").fill(title);
  await page.getByLabel("Your display name").fill(displayName);
  await page.getByRole("button", { name: "Create retro" }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.locator(".connection-note--online")).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return { id, title };
}

export async function joinBoard(page: Page, board: { id: string; title: string }, displayName: string) {
  await page.goto(`/retro/${board.id}`);
  await page.getByLabel("Display name", { exact: true }).fill(displayName);
  await page.getByRole("button", { name: "Join this retro" }).click();
  await expect(page.getByRole("heading", { name: board.title, exact: true })).toBeVisible();
  await expect(page.locator(".connection-note--online")).toBeVisible();
}

export async function openBoard(page: Page, board: { id: string; title: string }) {
  await page.goto(`/retro/${board.id}`);
  await expect(page.getByRole("heading", { name: board.title, exact: true })).toBeVisible();
  await expect(page.locator(".connection-note--online")).toBeVisible();
}

export async function addCard(page: Page, column = "went-well") {
  const container = column === "actions"
    ? page.getByRole("dialog", { name: "Action items", exact: true })
    : page.locator(`.board-column--${column}`);
  await container.getByRole("button", { name: column === "actions" ? "Add an action item" : column === "shoutouts" ? "Add a shoutout" : "Add a card" }).click();
  const field = container.locator("textarea").last();
  await expect(field).toBeFocused();
  const id = (await field.getAttribute("id"))!.slice("card-".length);
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return { id, field };
}

export function card(page: Page, id: string) { return page.locator(`.idea-card[data-card-id="${id}"]`); }
export function cardField(page: Page, id: string) { return page.locator(`#card-${id}`); }
export async function saveCard(page: Page, id: string, text: string) {
  const field = cardField(page, id);
  await field.fill(text);
  await field.press("Enter");
  await expect(card(page, id).locator(".save-state")).toHaveText("Saved");
}

export async function boardMenu(page: Page) {
  const menu = page.locator(".board-tools");
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  return menu;
}

export async function assertNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
}
