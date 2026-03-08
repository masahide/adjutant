import type { SearchCodeInput, SearchPayload } from '../contracts.ts';

type BrowserPage = any;

export async function runSlackSearchInBrowser(
  page: BrowserPage,
  input: SearchCodeInput,
): Promise<SearchPayload> {
  const { limit, query, workspaceUrl } = input;
  const sleep = (ms: number) => page.waitForTimeout(ms);
  const bodyText = async () =>
    await page
      .locator('body')
      .innerText()
      .catch(() => '');

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const queryBox = page.getByRole('combobox', { name: 'Query' });
  const hasVisibleQueryBox = await queryBox.isVisible().catch(() => false);
  const searchTrigger = page
    .locator('button')
    .filter({ hasText: /^(Search|Search:)/ })
    .first();

  if (!hasVisibleQueryBox && !(await searchTrigger.count())) {
    const text = await bodyText();
    throw new Error(
      `Slack workspace is not ready for search. url=${page.url()} title=${await page.title()} body=${text.slice(0, 200)}`,
    );
  }

  if (!hasVisibleQueryBox) {
    await searchTrigger.click();
    await queryBox.waitFor({ state: 'visible', timeout: 10000 });
  }

  await queryBox.fill('');
  await queryBox.fill(query);
  await queryBox.press('Enter');

  await page.waitForURL(/\/search/, { timeout: 20000 }).catch(() => null);
  await page
    .waitForFunction(
      () => {
        return (
          Boolean(document.querySelector('[data-qa="search_result"]')) ||
          /\b\d+ results?\b/i.test(document.body.innerText) ||
          /No results/i.test(document.body.innerText)
        );
      },
      { timeout: 20000 },
    )
    .catch(() => null);
  await sleep(1500);

  const sortButton = page
    .locator('button')
    .filter({ hasText: /^Sort:/ })
    .first();
  await sortButton
    .waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => null);

  let sortLabel = 'Unavailable';
  if (await sortButton.isVisible().catch(() => false)) {
    sortLabel = ((await sortButton.textContent()) ?? '').trim();
    if (!/Newest/i.test(sortLabel)) {
      await sortButton.click();
      const newestOption = page.getByRole('option', { name: 'Newest' });
      await newestOption.waitFor({ state: 'visible', timeout: 10000 });
      await newestOption.click();
      await sleep(1000);
      sortLabel = ((await sortButton.textContent()) ?? '').trim();
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await page.locator('[data-qa="search_result"]').count();
    if (before >= limit) {
      break;
    }
    await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await sleep(500);
    const after = await page.locator('[data-qa="search_result"]').count();
    if (after <= before) {
      break;
    }
  }

  await page.evaluate(() => {
    document.querySelectorAll('[data-qa="search_expand"]').forEach((node) => {
      if (node instanceof HTMLElement) {
        node.click();
      }
    });
  });
  await sleep(500);

  const pageText = await bodyText();
  const resultCountText = pageText.match(/\b\d+ results?\b/i)?.[0] ?? null;
  const noResults = /No results/i.test(pageText);

  const results = await page.evaluate((maxItems: number) => {
    const textOf = (element: Element, selector: string) => {
      const node = element.querySelector(selector);
      if (!node) {
        return null;
      }
      const raw =
        node instanceof HTMLElement ? node.innerText : node.textContent;
      const normalized = (raw ?? '').replace(/\s+/g, ' ').trim();
      return normalized || null;
    };

    const items = Array.from(
      document.querySelectorAll('[data-qa="search_result"]'),
    ).slice(0, maxItems);

    return items.map((element, index) => {
      const timestamp = element.querySelector('a.c-timestamp');
      const messageUrl =
        timestamp instanceof HTMLAnchorElement ? timestamp.href : null;
      const messageText =
        textOf(element, '[data-qa="message-text"]')?.replace(
          /\s*\.\.\.\s*Show more\s*$/i,
          '',
        ) ?? null;
      const links = Array.from(element.querySelectorAll('a[href]'))
        .map((node) => (node instanceof HTMLAnchorElement ? node.href : null))
        .filter((href) => Boolean(href))
        .filter((href) => href !== messageUrl);

      return {
        index: index + 1,
        sender: textOf(element, '[data-qa="message_sender_name"]'),
        location: textOf(element, '[data-qa="search_result_channel_name"]'),
        channelName: textOf(element, '[data-qa="inline_channel_entity__name"]'),
        timestampLabel: timestamp?.getAttribute('aria-label') ?? null,
        slackTs: timestamp?.getAttribute('data-ts') ?? null,
        messageUrl,
        text: messageText,
        links: Array.from(new Set(links)),
      };
    });
  }, limit);

  return {
    mode: 'search' as const,
    noResults,
    pageTitle: await page.title(),
    resultCountText,
    results,
    searchUrl: page.url(),
    sortLabel,
  };
}
