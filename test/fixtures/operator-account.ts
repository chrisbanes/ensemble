import type { Locator, Page } from "playwright";

/** Opens the desktop sidebar account menu by pointer and returns the menu. */
export async function openAccountMenu(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Operator account", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}

/** Signs out through the desktop sidebar account menu. */
export async function signOutFromSidebar(page: Page) {
  const menu = await openAccountMenu(page);
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
}
