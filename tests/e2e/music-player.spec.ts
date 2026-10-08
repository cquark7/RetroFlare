import type { Page } from "@playwright/test";
import { test, expect, createBoard, joinBoard, assertNoOverflow } from "./fixtures";

function audio(page: Page) { return page.locator('audio[data-focus-music="true"]'); }
async function expectPlaying(page: Page) {
  await expect(page.getByRole("button", { name: "Pause personal music" })).toBeVisible();
  await expect.poll(() => audio(page).evaluate((element) => {
    const media = element as HTMLAudioElement;
    return !media.paused && media.currentTime > 0 && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  })).toBe(true);
}

test("real music playback is opt-in, private, remembers preferences, and stops on leave and close", async ({ actor }) => {
  const alex = await actor("user-09");
  const { page } = alex;
  const first = await createBoard(page, "Personal music");
  const sam = await actor("sam");
  await joinBoard(sam.page, first, "Sam Patel");
  const mood = page.getByLabel("Music mood");
  const volume = page.getByRole("slider", { name: "Music volume" });
  await expect(mood).toHaveValue("lofi");
  await expect(volume).toHaveValue("0.2");
  expect(await audio(page).evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertNoOverflow(page);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mood.selectOption("ambient");
  await volume.focus();
  await volume.press("ArrowRight");
  await expect(volume).toHaveValue("0.25");
  await expect.poll(() => audio(page).evaluate((element) => (element as HTMLAudioElement).volume)).toBe(0.25);
  await page.getByRole("button", { name: "Play personal music" }).click();
  await expectPlaying(page);
  await mood.selectOption("piano");
  await expect(audio(page)).toHaveAttribute("src", "/music/piano-drifting.mp3");
  await expectPlaying(page);
  await expect(sam.page.getByLabel("Music mood")).toHaveValue("lofi");
  await expect(sam.page.getByRole("button", { name: "Play personal music" })).toBeVisible();
  expect(await audio(sam.page).evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: first.title, exact: true })).toBeVisible();
  await expect(mood).toHaveValue("piano");
  await expect(volume).toHaveValue("0.25");
  await expect(page.getByRole("button", { name: "Play personal music" })).toBeVisible();
  expect(await audio(page).evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true);
  await page.getByRole("button", { name: "Play personal music" }).click();
  await expectPlaying(page);
  const leavingAudio = await audio(page).elementHandle();
  await page.getByRole("button", { name: /All retros/ }).click();
  await expect(page.getByRole("button", { name: /Start a retro/ })).toBeVisible();
  expect(await leavingAudio!.evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true);
  expect(await leavingAudio!.getAttribute("src")).toBeNull();
  await leavingAudio!.dispose();

  await createBoard(page, "Music close");
  await expect(mood).toHaveValue("piano");
  await expect(volume).toHaveValue("0.25");
  await page.getByRole("button", { name: "Play personal music" }).click();
  await expectPlaying(page);
  const closingAudio = await audio(page).elementHandle();
  await page.getByRole("button", { name: "Finish retro" }).click();
  await page.getByRole("button", { name: "Prepare to finish" }).click();
  await expect(page.locator(".board-heading .status-tag")).toHaveText("Completed");
  await expect(page.getByRole("group", { name: "Personal background music" })).toHaveCount(0);
  expect(await closingAudio!.evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true);
  expect(await closingAudio!.getAttribute("src")).toBeNull();
  await closingAudio!.dispose();
});

test("a failed music asset shows recovery controls and another mood can play", async ({ actor }) => {
  const alex = await actor("user-10");
  await alex.context.route("**/music/lofi-shimmer.mp3", (route) => route.fulfill({ status: 404 }));
  await createBoard(alex.page, "Music recovery");
  await alex.page.getByRole("button", { name: "Play personal music" }).click();
  await expect(alex.page.locator(".focus-music__error")).toBeVisible();
  await expect(alex.page.getByRole("button", { name: "Play personal music" })).toBeVisible();
  await alex.page.getByLabel("Music mood").selectOption("ambient");
  await alex.page.getByRole("button", { name: "Play personal music" }).click();
  await expectPlaying(alex.page);
  await expect(alex.page.locator(".focus-music__error")).toHaveCount(0);
});

test("previously saved display name and music preferences remain available", async ({ actor }) => {
  const { page } = await actor("user-11");
  await page.evaluate(async () => {
    const response = await fetch("/api/me");
    const { data } = await response.json() as { data: { actorId: string } };
    localStorage.setItem(`siq-retro:name:${data.actorId}`, "Previously saved name");
    localStorage.setItem(`siq-retro:music:${data.actorId}`, JSON.stringify({ mood: "ambient", volume: 0.4 }));
  });
  await page.reload();
  await page.getByRole("button", { name: /Start a retro/ }).click();
  await expect(page.getByLabel("Your display name")).toHaveValue("Previously saved name");
  await page.getByLabel("Retro title").fill(`Legacy preferences ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Create retro" }).click();
  await expect(page.locator(".connection-note--online")).toBeVisible();
  await expect(page.getByLabel("Music mood")).toHaveValue("ambient");
  await expect(page.getByRole("slider", { name: "Music volume" })).toHaveValue("0.4");
  await page.getByLabel("Music mood").selectOption("piano");
  await page.reload();
  await expect(page.getByLabel("Music mood")).toHaveValue("piano");
});
