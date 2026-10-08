import type { BrowserContext } from "@playwright/test";
import { test, expect, createBoard, joinBoard, assertNoOverflow } from "./fixtures";
import { ApiSuccessSchema, GetRetroDataSchema } from "../../src/shared/api";
import { LIMITS } from "../../src/shared/constants";

async function mockGiphy(context: BrowserContext, onStickerSearch?: () => void): Promise<void> {
  await context.route("https://api.giphy.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("/stickers/search")) onStickerSearch?.();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(pathname.includes("pingback")
        ? { data: {}, meta: { status: 200, msg: "OK", response_id: "giphy-e2e" } }
        : gifResponse)
    });
  });
  await context.route("https://media.giphy.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/gif",
    body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
  }));
}

const gifResponse = {
  data: [{
    id: "giphy-test-celebrate",
    title: "A celebration",
    url: "https://giphy.com/gifs/giphy-test-celebrate",
    type: "gif",
    is_sticker: false,
    images: {
      fixed_height: {
        height: "200",
        width: "200",
        size: "100",
        url: "https://media.giphy.com/media/giphy-test-celebrate/200.gif",
        webp: "https://media.giphy.com/media/giphy-test-celebrate/200.webp"
      },
      fixed_width: {
        height: "200",
        width: "200",
        size: "100",
        url: "https://media.giphy.com/media/giphy-test-celebrate/200.gif",
        webp: "https://media.giphy.com/media/giphy-test-celebrate/200.webp"
      },
      original: {
        height: "200",
        width: "200",
        size: "100",
        url: "https://media.giphy.com/media/giphy-test-celebrate/giphy.gif",
        webp: "https://media.giphy.com/media/giphy-test-celebrate/giphy.webp"
      }
    }
  }],
  pagination: { total_count: 1, count: 1, offset: 0 },
  meta: { status: 200, msg: "OK", response_id: "giphy-e2e" }
};

test("a selected GIPHY result renders for connected peers, expires, and is never saved", async ({ actor }) => {
  const alex = await actor("user-11");
  const sam = await actor("sam");
  const { context, page } = alex;
  const collaborator = sam.page;
  let stickerSearchRequested = false;
  await mockGiphy(context, () => { stickerSearchRequested = true; });
  await mockGiphy(sam.context);

  const board = await createBoard(page, "GIPHY share");
  await joinBoard(collaborator, board, "Sam Patel");
  const readBoard = async () => {
    const response = await context.request.get(`/api/retros/${board.id}`);
    expect(response.ok()).toBe(true);
    return ApiSuccessSchema(GetRetroDataSchema).parse(await response.json()).data.retro;
  };
  const before = await readBoard();

  await page.getByRole("button", { name: "Send a GIF or sticker" }).click();
  await expect(page.getByRole("dialog", { name: "Pick a GIF or sticker" })).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertNoOverflow(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Search GIFs and stickers").fill("celebrate");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const result = page.locator('.giphy-picker__result[data-giphy-id="giphy-test-celebrate"]');
  await expect(result).toBeVisible();
  await result.click();

  await expect(page.getByRole("dialog", { name: "Pick a GIF or sticker" })).toBeHidden();
  await expect(page.locator(".giphy-share-float")).toHaveCount(1);
  await expect(collaborator.locator(".giphy-share-float")).toHaveCount(1);
  await expect.poll(() => page.locator(".giphy-share-float").evaluate((element) => getComputedStyle(element).bottom)).toBe("16px");
  await expect.poll(() => collaborator.locator(".giphy-share-float img").evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await collaborator.locator(".giphy-share-float").getAttribute("data-giphy-share-id"))
    .toBe(await page.locator(".giphy-share-float").getAttribute("data-giphy-share-id"));
  await expect(page.locator(".giphy-share-float img")).toHaveAttribute(
    "src",
    "https://media.giphy.com/media/giphy-test-celebrate/200.gif"
  );

  await page.getByRole("button", { name: "Send a GIF or sticker" }).click();
  await page.getByRole("tab", { name: "Stickers" }).click();
  await page.getByLabel("Search GIFs and stickers").fill("thanks");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(result).toBeVisible();
  expect(stickerSearchRequested).toBe(true);
  await result.click();
  await expect(collaborator.locator(".giphy-share-float")).toHaveCount(2);
  expect(await readBoard()).toEqual(before);

  await expect(page.locator(".board-heading .status-tag")).toHaveText("In progress");
  await Promise.all([page, collaborator].map((peer) => expect(peer.locator(".giphy-share-float"))
    .toHaveCount(0, { timeout: LIMITS.giphyShareLifetimeMs + 2_000 })));
  await page.reload();
  await expect(page.locator(".connection-note--online")).toBeVisible();
  await expect(page.locator(".giphy-share-float")).toHaveCount(0);
});
