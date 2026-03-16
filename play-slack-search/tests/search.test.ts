import assert from 'node:assert/strict';
import test from 'node:test';

import { runSlackSearchInBrowser } from '../scripts/slack-search/browser/search.ts';

class FakeLocator {
  public visible = false;
  public clicked = 0;
  public fills: string[] = [];
  public presses: string[] = [];
  public textContentValue: string | null = null;
  public countValue = 0;
  private readonly onClick?: () => void;

  constructor(onClick?: () => void) {
    this.onClick = onClick;
  }

  first() {
    return this;
  }

  filter(_options: unknown) {
    return this;
  }

  async waitFor(_options: unknown) {
    if (!this.visible) {
      throw new Error('not visible');
    }
  }

  async isVisible() {
    return this.visible;
  }

  async count() {
    return this.countValue;
  }

  async click() {
    this.clicked += 1;
    this.onClick?.();
  }

  async fill(value: string) {
    this.fills.push(value);
  }

  async press(key: string) {
    this.presses.push(key);
  }

  async textContent() {
    return this.textContentValue;
  }

  async innerText() {
    return this.textContentValue ?? '';
  }
}

test('runSlackSearchInBrowser は top_nav_search を優先し Nothing turned up を noResults 扱いする', async () => {
  const queryBox = new FakeLocator();
  const topNavSearch = new FakeLocator(() => {
    queryBox.visible = true;
  });
  topNavSearch.countValue = 1;

  const genericSearchButton = new FakeLocator();
  genericSearchButton.countValue = 1;

  const sortButton = new FakeLocator();
  sortButton.visible = true;
  sortButton.countValue = 1;
  sortButton.textContentValue = 'Sort: Newest';

  const body = new FakeLocator();
  body.textContentValue = 'Nothing turned up';

  const searchResults = new FakeLocator();
  searchResults.countValue = 0;

  const page = {
    gotoCalls: [] as string[],
    async goto(url: string) {
      this.gotoCalls.push(url);
    },
    async waitForTimeout(_ms: number) {},
    locator(selector: string) {
      if (selector === 'body') {
        return body;
      }
      if (selector === 'button[data-qa="top_nav_search"]') {
        return topNavSearch;
      }
      if (selector === 'button') {
        return {
          filter: ({ hasText }: { hasText: RegExp }) => {
            if (String(hasText) === '/^Sort:/') {
              return sortButton;
            }
            return genericSearchButton;
          },
        };
      }
      if (selector === '[data-qa="search_result"]') {
        return searchResults;
      }
      return queryBox;
    },
    async title() {
      return 'Search - Slack';
    },
    url() {
      return 'https://app.slack.com/client/T123/search';
    },
    async waitForURL() {},
    async waitForFunction() {},
    async evaluate<T>(_fn: (...args: any[]) => T, ...args: any[]) {
      if (args.length === 1 && typeof args[0] === 'number') {
        return [] as unknown as T;
      }
      return undefined as T;
    },
  };

  const result = await runSlackSearchInBrowser(page, {
    limit: 5,
    query: 'from:@やまさき within:7 days',
    workspaceUrl: 'https://example.slack.com',
  });

  assert.deepEqual(page.gotoCalls, ['https://example.slack.com']);
  assert.equal(topNavSearch.clicked, 1);
  assert.equal(genericSearchButton.clicked, 0);
  assert.deepEqual(queryBox.fills, ['', 'from:@やまさき within:7 days']);
  assert.deepEqual(queryBox.presses, ['Enter']);
  assert.equal(result.noResults, true);
  assert.equal(result.results.length, 0);
});

test('runSlackSearchInBrowser は検索 dialog に残ったとき suggestion click で確定を試みる', async () => {
  const queryBox = new FakeLocator();
  queryBox.visible = true;

  const dialog = new FakeLocator();
  dialog.visible = true;

  const suggestion = new FakeLocator(() => {
    dialog.visible = false;
  });
  suggestion.visible = true;
  suggestion.countValue = 1;

  const sortButton = new FakeLocator();
  sortButton.visible = true;
  sortButton.countValue = 1;
  sortButton.textContentValue = 'Sort: Newest';

  const body = new FakeLocator();
  body.textContentValue = '1 result';

  const searchResults = new FakeLocator();
  searchResults.countValue = 1;

  let currentUrl = 'https://app.slack.com/client/T123/C1';
  const page = {
    async goto(_url: string) {},
    async waitForTimeout(_ms: number) {},
    locator(selector: string) {
      if (selector === 'body') {
        return body;
      }
      if (selector === '[role="dialog"]') {
        return dialog;
      }
      if (
        selector ===
        '[role="dialog"] [role="option"], [role="dialog"] [role="listitem"], [role="dialog"] button'
      ) {
        return suggestion;
      }
      if (selector === 'button[data-qa="top_nav_search"]') {
        const trigger = new FakeLocator();
        trigger.countValue = 0;
        return trigger;
      }
      if (selector === 'button') {
        return {
          filter: ({ hasText }: { hasText: RegExp }) => {
            if (String(hasText) === '/^Sort:/') {
              return sortButton;
            }
            const empty = new FakeLocator();
            empty.countValue = 0;
            return empty;
          },
        };
      }
      if (selector === '[data-qa="search_result"]') {
        return searchResults;
      }
      return queryBox;
    },
    async title() {
      return 'Search - Slack';
    },
    url() {
      return currentUrl;
    },
    async waitForURL() {
      if (dialog.visible) {
        throw new Error('still in dialog');
      }
      currentUrl = 'https://app.slack.com/client/T123/search';
    },
    async waitForFunction() {},
    async evaluate<T>(_fn: (...args: any[]) => T, ...args: any[]) {
      if (args.length === 1 && typeof args[0] === 'number') {
        return [
          {
            index: 1,
            sender: 'masahide',
            location: '#general',
            channelName: 'general',
            timestampLabel: 'today',
            slackTs: '1.0',
            messageUrl: 'https://example.slack.com/archives/C1/p1',
            text: 'hello',
            links: [],
          },
        ] as unknown as T;
      }
      return undefined as T;
    },
  };

  const result = await runSlackSearchInBrowser(page, {
    limit: 1,
    query: 'from:@masahide',
    workspaceUrl: 'https://example.slack.com',
  });

  assert.deepEqual(queryBox.presses, ['Enter']);
  assert.equal(suggestion.clicked, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.searchUrl, 'https://app.slack.com/client/T123/search');
});
