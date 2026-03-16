import type { SearchCodeInput, SearchPayload } from '../contracts.ts';

type BrowserPage = any;

export async function runSlackSearchInBrowser(
  page: BrowserPage,
  input: SearchCodeInput,
): Promise<SearchPayload> {
  const { limit, query, workspaceUrl } = input;
  const searchInputSelector = [
    '[role="dialog"] [role="combobox"]',
    '[role="dialog"] input[aria-label]',
    '[role="dialog"] input[type="text"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    'input[aria-label*="Query"]',
    'input[aria-label*="Search"]',
    'input[aria-label*="検索"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="検索"]',
    'input[type="search"]',
    'input[type="text"]',
  ].join(', ');
  const noResultsPattern = /No results|Nothing turned up/i;
  const sleep = (ms: number) => page.waitForTimeout(ms);
  const waitForSearchRoute = async (timeout: number) =>
    await page
      .waitForURL(/\/search/, { timeout })
      .then(() => true)
      .catch(() => false);
  const bodyText = async () =>
    await page
      .locator('body')
      .innerText()
      .catch(() => '');
  const locateSearchInput = () => page.locator(searchInputSelector).first();
  const locateSearchDialog = () => page.locator('[role="dialog"]').first();
  const locateSearchSuggestion = () =>
    page
      .locator(
        [
          '[role="dialog"] [role="option"]',
          '[role="dialog"] [role="listitem"]',
          '[role="dialog"] button',
        ].join(', '),
      )
      .first();
  const locateSearchTrigger = async () => {
    const topNavSearch = page
      .locator('button[data-qa="top_nav_search"]')
      .first();
    if ((await topNavSearch.count().catch(() => 0)) > 0) {
      return topNavSearch;
    }
    return page
      .locator('button')
      .filter({ hasText: /^(Search|Search:)/ })
      .first();
  };
  const waitForSearchInput = async () => {
    const searchInput = locateSearchInput();
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    return searchInput;
  };

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  const hasVisibleQueryBox = await locateSearchInput()
    .isVisible()
    .catch(() => false);
  const searchTrigger = await locateSearchTrigger();

  if (!hasVisibleQueryBox && !(await searchTrigger.count())) {
    const text = await bodyText();
    throw new Error(
      `Slack workspace is not ready for search. url=${page.url()} title=${await page.title()} body=${text.slice(0, 200)}`,
    );
  }

  if (!hasVisibleQueryBox) {
    await searchTrigger.click();
  }

  const queryBox = await waitForSearchInput();
  await queryBox.fill('');
  await queryBox.fill(query);
  await queryBox.press('Enter');

  let navigatedToSearch = await waitForSearchRoute(3000);
  if (!navigatedToSearch) {
    const searchDialog = locateSearchDialog();
    const dialogVisible = await searchDialog.isVisible().catch(() => false);
    if (dialogVisible) {
      const suggestion = locateSearchSuggestion();
      if ((await suggestion.count().catch(() => 0)) > 0) {
        await suggestion.click().catch(() => null);
        navigatedToSearch = await waitForSearchRoute(3000);
      }
      if (!navigatedToSearch) {
        await queryBox.press('ArrowDown').catch(() => null);
        await queryBox.press('Enter').catch(() => null);
      }
    }
  }

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
  const noResults = noResultsPattern.test(pageText);

  const results = await page.evaluate((maxItems: number) => {
    const items = Array.from(
      document.querySelectorAll('[data-qa="search_result"]'),
    ).slice(0, maxItems);

    return items.map((element, index) => {
      const senderNode = element.querySelector(
        '[data-qa="message_sender_name"]',
      );
      const locationNode = element.querySelector(
        '[data-qa="search_result_channel_name"]',
      );
      const channelNameNode = element.querySelector(
        '[data-qa="inline_channel_entity__name"]',
      );
      const messageNode = element.querySelector('[data-qa="message-text"]');
      const timestamp = element.querySelector('a.c-timestamp');
      const messageUrl =
        timestamp instanceof HTMLAnchorElement ? timestamp.href : null;
      const senderRaw =
        senderNode instanceof HTMLElement
          ? senderNode.innerText
          : senderNode?.textContent;
      const locationRaw =
        locationNode instanceof HTMLElement
          ? locationNode.innerText
          : locationNode?.textContent;
      const channelNameRaw =
        channelNameNode instanceof HTMLElement
          ? channelNameNode.innerText
          : channelNameNode?.textContent;
      const messageRaw =
        messageNode instanceof HTMLElement
          ? messageNode.innerText
          : messageNode?.textContent;
      const sender = (senderRaw ?? '').replace(/\s+/g, ' ').trim() || null;
      const location = (locationRaw ?? '').replace(/\s+/g, ' ').trim() || null;
      const channelName =
        (channelNameRaw ?? '').replace(/\s+/g, ' ').trim() || null;
      const messageText =
        ((messageRaw ?? '').replace(/\s+/g, ' ').trim() || null)?.replace(
          /\s*\.\.\.\s*Show more\s*$/i,
          '',
        ) ?? null;
      const links = Array.from(element.querySelectorAll('a[href]'))
        .map((node) => (node instanceof HTMLAnchorElement ? node.href : null))
        .filter((href) => Boolean(href))
        .filter((href) => href !== messageUrl);

      return {
        index: index + 1,
        sender,
        location,
        channelName,
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
