import type {
  ChannelInfo,
  ChannelListHydrateDebug,
  ChannelListPayload,
  ChannelType,
  ListChannelsCodeInput,
} from '../contracts.ts';
import {
  buildSlackClientStateUnavailableError,
  installBrowserRuntimeShims,
} from './runtime-shims.ts';

type BrowserPage = any;
type ChannelListSource = ChannelListPayload['source'];
type SortableChannelLike = {
  id?: string | null;
  name?: string | null;
  nameNormalized?: string | null;
};
type UiChannelRecord = {
  isMember: boolean | null;
  isPrivate: boolean;
  key: string | null;
  memberCount: number | null;
  name: string;
  nameNormalized: string;
  purpose: string | null;
  type: ChannelType;
};

function buildChannelSortKey(channel: SortableChannelLike): string {
  return channel.nameNormalized ?? channel.name ?? channel.id ?? '';
}

function sortChannelsByName<T extends SortableChannelLike>(channels: T[]): T[] {
  return channels
    .slice()
    .sort((left, right) =>
      buildChannelSortKey(left).localeCompare(buildChannelSortKey(right)),
    );
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKey(value: unknown): string | null {
  const text = normalizedText(value);
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function inferChannelTypeFromIcon(iconType: string | null): ChannelType {
  if (!iconType) {
    return 'unknown';
  }

  const normalized = iconType.toLowerCase();
  if (normalized.includes('mpim') || normalized.includes('multi')) {
    return 'mpim';
  }
  if (normalized.includes('im') || normalized.includes('dm')) {
    return 'dm';
  }
  if (
    normalized.includes('private') ||
    normalized.includes('group') ||
    normalized.includes('lock')
  ) {
    return 'private_channel';
  }
  if (normalized.includes('channel')) {
    return 'public_channel';
  }
  return 'unknown';
}

export function isChannelLikeEntry(channel: unknown): boolean {
  if (!channel || typeof channel !== 'object') {
    return false;
  }

  const rawChannel = channel as Record<string, unknown>;
  return Boolean(
    rawChannel.is_channel ||
      rawChannel.is_group ||
      rawChannel.is_im ||
      rawChannel.is_mpim ||
      rawChannel.is_private,
  );
}

export function normalizeChannelList(
  channelsState: Record<string, unknown>,
  maxItems: number,
): ChannelInfo[] {
  const classifyChannel = (channel: Record<string, any>): ChannelType => {
    if (channel.is_im) return 'dm';
    if (channel.is_mpim) return 'mpim';
    if (channel.is_group || channel.is_private) return 'private_channel';
    if (channel.is_channel) return 'public_channel';
    return 'unknown';
  };

  return sortChannelsByName(
    Object.values(channelsState)
      .filter(isChannelLikeEntry)
      .map((channel: any) => ({
        id: channel.id ?? null,
        name: channel.name ?? null,
        nameNormalized: channel.name_normalized ?? null,
        type: classifyChannel(channel),
        isArchived: Boolean(channel.is_archived),
        isExtShared: Boolean(channel.is_ext_shared),
        isGeneral: Boolean(channel.is_general),
        isMember: Boolean(channel.is_member),
        isOrgShared: Boolean(channel.is_org_shared),
        isPrivate: Boolean(channel.is_private),
        isReadOnly: Boolean(channel.is_read_only),
        isThreadOnly: Boolean(channel.is_thread_only),
        created: typeof channel.created === 'number' ? channel.created : null,
        updated: typeof channel.updated === 'number' ? channel.updated : null,
        previousNames: Array.isArray(channel.previous_names)
          ? channel.previous_names
          : [],
        purpose:
          typeof channel.purpose?.value === 'string'
            ? channel.purpose.value
            : null,
        topic:
          typeof channel.topic?.value === 'string' ? channel.topic.value : null,
      })),
  ).slice(0, maxItems);
}

function buildChannelKeys(channel: SortableChannelLike): string[] {
  const keys = new Set<string>();
  for (const candidate of [channel.nameNormalized, channel.name, channel.id]) {
    const normalized = normalizeKey(candidate);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return Array.from(keys);
}

export function mergeChannelLists(
  uiChannels: UiChannelRecord[],
  cachePayload: ChannelListPayload,
): ChannelListPayload {
  if (uiChannels.length === 0) {
    return cachePayload;
  }

  const primaryRecords = new Map<string, ChannelInfo>();
  const keyToPrimary = new Map<string, string>();

  const register = (primaryKey: string, channel: ChannelInfo): void => {
    primaryRecords.set(primaryKey, channel);
    for (const key of buildChannelKeys(channel)) {
      if (!keyToPrimary.has(key)) {
        keyToPrimary.set(key, primaryKey);
      }
    }
  };

  for (const channel of cachePayload.channels) {
    const primaryKey =
      buildChannelKeys(channel)[0] ?? `cache:${primaryRecords.size}`;
    register(primaryKey, channel);
  }

  for (const uiChannel of uiChannels) {
    const uiKeys = buildChannelKeys(uiChannel);
    const matchedPrimaryKey = uiKeys
      .map((key) => keyToPrimary.get(key) ?? null)
      .find((key): key is string => key !== null);

    if (matchedPrimaryKey) {
      const existing = primaryRecords.get(matchedPrimaryKey);
      if (!existing) {
        continue;
      }

      const merged: ChannelInfo = {
        ...existing,
        name: existing.name ?? uiChannel.name,
        nameNormalized:
          existing.nameNormalized ?? uiChannel.nameNormalized ?? uiChannel.name,
        type: existing.type === 'unknown' ? uiChannel.type : existing.type,
        isMember: existing.isMember || uiChannel.isMember === true,
        isPrivate: existing.isPrivate || uiChannel.isPrivate,
        purpose: existing.purpose ?? uiChannel.purpose,
        topic: existing.topic ?? null,
      };

      primaryRecords.set(matchedPrimaryKey, merged);
      register(matchedPrimaryKey, merged);
      continue;
    }

    const primaryKey = uiKeys[0] ?? `ui:${primaryRecords.size}`;
    register(primaryKey, {
      id: null,
      name: uiChannel.name,
      nameNormalized: uiChannel.nameNormalized ?? uiChannel.name,
      type: uiChannel.type,
      isArchived: false,
      isExtShared: false,
      isGeneral: false,
      isMember: uiChannel.isMember === true,
      isOrgShared: false,
      isPrivate: uiChannel.isPrivate,
      isReadOnly: false,
      isThreadOnly: false,
      created: null,
      updated: null,
      previousNames: [],
      purpose: uiChannel.purpose,
      topic: null,
    });
  }

  const channels = sortChannelsByName(Array.from(primaryRecords.values()));
  const source: ChannelListSource =
    cachePayload.channels.length > 0
      ? 'reduxPersistence.channels+ui.directories.channels'
      : 'ui.directories.channels';

  return {
    ...cachePayload,
    channels,
    source,
    totalChannelCount: Math.max(
      cachePayload.totalChannelCount,
      uiChannels.length,
      channels.length,
    ),
  };
}

export async function runListChannelsInBrowser(
  page: BrowserPage,
  input: ListChannelsCodeInput,
): Promise<ChannelListPayload> {
  await installBrowserRuntimeShims(page);
  const { hydrate = false, limit, workspaceUrl } = input;
  const sleep = (ms: number) => page.waitForTimeout(ms);
  const isHomeTitle = (title: string): boolean =>
    /(?:^|!\s*)Home - /i.test(title);
  const buildChannelSortKeyInRunner = (channel: SortableChannelLike): string =>
    channel.nameNormalized ?? channel.name ?? channel.id ?? '';
  const sortChannelsByNameInRunner = <T extends SortableChannelLike>(
    channels: T[],
  ): T[] =>
    channels
      .slice()
      .sort((left, right) =>
        buildChannelSortKeyInRunner(left).localeCompare(
          buildChannelSortKeyInRunner(right),
        ),
      );
  const normalizeKeyInRunner = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  };
  const buildChannelKeysInRunner = (channel: SortableChannelLike): string[] => {
    const keys = new Set<string>();
    for (const candidate of [
      channel.nameNormalized,
      channel.name,
      channel.id,
    ]) {
      const normalized = normalizeKeyInRunner(candidate);
      if (normalized) {
        keys.add(normalized);
      }
    }
    return Array.from(keys);
  };
  const mergeChannelListsInRunner = (
    uiChannels: UiChannelRecord[],
    cachePayload: ChannelListPayload,
  ): ChannelListPayload => {
    const primaryRecords = new Map<string, ChannelInfo>();
    const keyToPrimary = new Map<string, string>();

    const register = (primaryKey: string, channel: ChannelInfo): void => {
      primaryRecords.set(primaryKey, channel);
      for (const key of buildChannelKeysInRunner(channel)) {
        if (!keyToPrimary.has(key)) {
          keyToPrimary.set(key, primaryKey);
        }
      }
    };

    for (const channel of cachePayload.channels) {
      const primaryKey =
        buildChannelKeysInRunner(channel)[0] ?? `cache:${primaryRecords.size}`;
      register(primaryKey, channel);
    }

    for (const uiChannel of uiChannels) {
      const uiKeys = buildChannelKeysInRunner(uiChannel);
      const matchedPrimaryKey = uiKeys
        .map((key) => keyToPrimary.get(key) ?? null)
        .find((key): key is string => key !== null);

      if (matchedPrimaryKey) {
        const existing = primaryRecords.get(matchedPrimaryKey);
        if (!existing) {
          continue;
        }

        const merged: ChannelInfo = {
          ...existing,
          name: existing.name ?? uiChannel.name,
          nameNormalized:
            existing.nameNormalized ??
            uiChannel.nameNormalized ??
            uiChannel.name,
          type: existing.type === 'unknown' ? uiChannel.type : existing.type,
          isMember: existing.isMember || uiChannel.isMember === true,
          isPrivate: existing.isPrivate || uiChannel.isPrivate,
          purpose: existing.purpose ?? uiChannel.purpose,
          topic: existing.topic ?? null,
        };

        primaryRecords.set(matchedPrimaryKey, merged);
        register(matchedPrimaryKey, merged);
        continue;
      }

      const primaryKey = uiKeys[0] ?? `ui:${primaryRecords.size}`;
      register(primaryKey, {
        id: null,
        name: uiChannel.name,
        nameNormalized: uiChannel.nameNormalized ?? uiChannel.name,
        type: uiChannel.type,
        isArchived: false,
        isExtShared: false,
        isGeneral: false,
        isMember: uiChannel.isMember === true,
        isOrgShared: false,
        isPrivate: uiChannel.isPrivate,
        isReadOnly: false,
        isThreadOnly: false,
        created: null,
        updated: null,
        previousNames: [],
        purpose: uiChannel.purpose,
        topic: null,
      });
    }

    const channels = sortChannelsByNameInRunner(
      Array.from(primaryRecords.values()),
    );
    return {
      ...cachePayload,
      channels,
      source:
        cachePayload.channels.length > 0
          ? 'reduxPersistence.channels+ui.directories.channels'
          : 'ui.directories.channels',
      totalChannelCount: Math.max(
        cachePayload.totalChannelCount,
        uiChannels.length,
        channels.length,
      ),
    };
  };

  const scrollAllToTop = async (): Promise<void> => {
    await page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('*')).filter(
          (node) =>
            node instanceof HTMLElement &&
            node.scrollHeight > node.clientHeight + 20,
        ) as HTMLElement[];

        for (const node of nodes) {
          node.scrollTop = 0;
        }

        const rootScroller =
          document.scrollingElement ?? document.documentElement;
        rootScroller.scrollTop = 0;
      })
      .catch(() => null);
  };

  const clickHomeBreadcrumb = async (): Promise<boolean> => {
    const locators = [
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('button', { name: /^Home$/i })
        .first(),
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('button', { name: /Home/i })
        .first(),
      page
        .getByRole('toolbar', { name: 'Breadcrumbs' })
        .getByRole('link', { name: /Home/i })
        .first(),
    ];

    for (const locator of locators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.click().catch(() => null);
      await sleep(1800);
      if (isHomeTitle(await page.title())) {
        return true;
      }
    }

    return false;
  };

  const clickDirectoriesEntry = async (): Promise<boolean> => {
    const locators = [
      page.getByRole('treeitem', { name: /^Directories$/i }).first(),
      page.getByRole('button', { name: /^Directories$/i }).first(),
      page.getByRole('tab', { name: /^Directories$/i }).first(),
      page.getByText(/^Directories$/i).first(),
    ];

    for (const locator of locators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.click().catch(() => null);
      await sleep(1500);
      if (/Unified Directory/i.test(await page.title())) {
        return true;
      }
    }

    return false;
  };

  const clickChannelsTab = async (): Promise<boolean> => {
    const locators = [
      page.getByRole('tab', { name: /^Channels$/i }).first(),
      page
        .getByRole('tabpanel', { name: /Channels/i })
        .getByRole('tab', { name: /^Channels$/i })
        .first(),
    ];

    for (const locator of locators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.click().catch(() => null);
      await sleep(1200);
      const opened = await page
        .evaluate(() => {
          const panel = document.querySelector('[role="tabpanel"][aria-label]');
          const channelsPanel = document.querySelector(
            '[role="tabpanel"][aria-label="Channels"]',
          );
          return (
            channelsPanel instanceof HTMLElement ||
            (panel instanceof HTMLElement &&
              /channels/i.test(panel.getAttribute('aria-label') || ''))
          );
        })
        .catch(() => false);
      if (opened) {
        return true;
      }
    }

    return false;
  };

  const openChannelsDirectory = async (): Promise<boolean> => {
    const alreadyOpen = await page
      .evaluate(() => {
        const title = document.title;
        const panel = document.querySelector(
          '[role="tabpanel"][aria-label="Channels"]',
        );
        const list = document.querySelector('[aria-label="Channel results"]');
        return (
          /Unified Directory/i.test(title) &&
          panel instanceof HTMLElement &&
          list instanceof HTMLElement
        );
      })
      .catch(() => false);
    if (alreadyOpen) {
      return true;
    }

    await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    const onHome = isHomeTitle(await page.title());
    const enteredHome = onHome ? true : await clickHomeBreadcrumb();
    if (!enteredHome || !isHomeTitle(await page.title())) {
      return false;
    }

    await scrollAllToTop();
    await sleep(800);

    const openedDirectory = await clickDirectoriesEntry();
    if (!openedDirectory) {
      return false;
    }

    return await clickChannelsTab();
  };

  const collectChannelsFromDirectory = async (): Promise<{
    channels: UiChannelRecord[];
    debug: ChannelListHydrateDebug;
  }> => {
    const debug: ChannelListHydrateDebug = {
      error: null,
      finalSortLabel: null,
      firstObservedPage: null,
      openedDirectory: false,
      pageVisits: [],
      resetToFirstPage: false,
      sortSetToNewest: false,
      stopReason: null,
      uiChannelCount: 0,
    };

    const opened = await openChannelsDirectory();
    debug.openedDirectory = opened;
    if (!opened) {
      debug.stopReason = 'open_channels_directory_failed';
      return {
        channels: [],
        debug,
      };
    }

    const currentSortLabel = async () =>
      await page
        .evaluate(() => {
          return (
            document
              .querySelector('[data-qa="sort-explorer-select"]')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() ?? null
          );
        })
        .catch(() => null);

    const setNewestChannelSort = async (): Promise<boolean> => {
      if (/^Newest channels?$/i.test((await currentSortLabel()) ?? '')) {
        return true;
      }

      const trigger = page.locator('[data-qa="sort-explorer-select"]').first();
      const visible = await trigger.isVisible().catch(() => false);
      if (!visible) {
        return false;
      }

      await trigger.click().catch(() => null);
      await sleep(500);

      const optionLocators = [
        page.getByRole('option', { name: /^Newest channels?$/i }).first(),
        page.getByRole('menuitem', { name: /^Newest channels?$/i }).first(),
        page.getByRole('button', { name: /^Newest channels?$/i }).first(),
        page.getByText(/^Newest channels?$/i).last(),
      ];

      for (const locator of optionLocators) {
        const optionVisible = await locator.isVisible().catch(() => false);
        if (!optionVisible) {
          continue;
        }

        await locator.click().catch(() => null);
        await sleep(1000);
        if (/^Newest channels?$/i.test((await currentSortLabel()) ?? '')) {
          return true;
        }
      }

      return /^Newest channels?$/i.test((await currentSortLabel()) ?? '');
    };

    const readPaginationState = async () =>
      await page
        .evaluate(() => {
          const currentPageButton =
            document.querySelector('[aria-current="page"]') ??
            document.querySelector('[aria-label^="Page "][disabled]') ??
            null;
          const previousPageButton = document.querySelector(
            '[aria-label="Previous page"]',
          );
          const pageOneButton = document.querySelector('[aria-label="Page 1"]');
          return {
            currentPage: currentPageButton
              ? Number.parseInt(
                  currentPageButton.textContent?.trim() ?? '',
                  10,
                ) || null
              : null,
            hasPageOne: pageOneButton instanceof HTMLElement,
            previousDisabled:
              previousPageButton instanceof HTMLButtonElement
                ? previousPageButton.disabled ||
                  previousPageButton.getAttribute('aria-disabled') === 'true'
                : previousPageButton instanceof HTMLElement
                  ? previousPageButton.getAttribute('aria-disabled') === 'true'
                  : true,
          };
        })
        .catch(() => ({
          currentPage: null,
          hasPageOne: false,
          previousDisabled: true,
        }));

    const clickVisiblePaginationButton = async (
      ariaLabel: string,
    ): Promise<boolean> =>
      await page
        .evaluate((label: string) => {
          const candidates = Array.from(
            document.querySelectorAll(`[aria-label="${label}"]`),
          );
          const target = candidates.find((element) => {
            if (!(element instanceof HTMLElement)) {
              return false;
            }
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          });

          if (!(target instanceof HTMLElement)) {
            return false;
          }

          target.scrollIntoView({ block: 'nearest' });
          target.click();
          return true;
        }, ariaLabel)
        .catch(() => false);

    const resetToFirstPage = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const state = await readPaginationState();
        if (state.currentPage === 1) {
          return true;
        }

        if (state.hasPageOne) {
          if (await clickVisiblePaginationButton('Page 1')) {
            await sleep(700);
            continue;
          }
        }

        if (state.previousDisabled) {
          return false;
        }

        if (!(await clickVisiblePaginationButton('Previous page'))) {
          return false;
        }
        await sleep(700);
      }

      return false;
    };

    const collectCurrentPage = async (seen: Map<string, UiChannelRecord>) => {
      const readSnapshot = async (scrollToBottom: boolean) =>
        await page.evaluate(
          ({ shouldScrollToBottom }: { shouldScrollToBottom: boolean }) => {
            const normalizeTextInPage = (value: unknown): string | null => {
              if (typeof value !== 'string') {
                return null;
              }
              const trimmed = value.trim();
              return trimmed.length > 0 ? trimmed : null;
            };

            const normalizeKeyInPage = (value: unknown): string | null => {
              const text = normalizeTextInPage(value);
              if (!text) {
                return null;
              }
              const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
              return normalized.length > 0 ? normalized : null;
            };

            const inferTypeInPage = (iconType: string | null): ChannelType => {
              if (!iconType) {
                return 'unknown';
              }
              const normalized = iconType.toLowerCase();
              if (normalized.includes('mpim') || normalized.includes('multi')) {
                return 'mpim';
              }
              if (normalized.includes('im') || normalized.includes('dm')) {
                return 'dm';
              }
              if (
                normalized.includes('private') ||
                normalized.includes('group') ||
                normalized.includes('lock')
              ) {
                return 'private_channel';
              }
              if (normalized.includes('channel')) {
                return 'public_channel';
              }
              return 'unknown';
            };

            const parseMemberCount = (value: string | null): number | null => {
              if (!value) {
                return null;
              }
              const match = value.replace(/,/g, '').match(/(\d+)\s+members/i);
              return match ? Number(match[1]) : null;
            };

            const panel = document.querySelector(
              '[role="tabpanel"][aria-label="Channels"]',
            );
            const list = document.querySelector(
              '[aria-label="Channel results"]',
            );
            const scrollHost =
              list?.closest('[data-qa="slack_kit_scrollbar"]') ??
              list?.parentElement;
            const nextPageButton = document.querySelector(
              '[aria-label="Next page"]',
            );
            const currentPageButton =
              document.querySelector('[aria-current="page"]') ??
              document.querySelector('[aria-label^="Page "][disabled]') ??
              null;

            const rows = Array.from(
              document.querySelectorAll('[data-qa="channel_search_result"]'),
            )
              .map((row) => {
                if (!(row instanceof HTMLElement)) {
                  return null;
                }

                const name = normalizeTextInPage(
                  row.querySelector('.c-channel_entity__name')?.textContent ??
                    row.querySelector('.c-truncate--break_words')
                      ?.textContent ??
                    null,
                );
                if (!name) {
                  return null;
                }

                const purpose = normalizeTextInPage(
                  row.querySelector('[data-qa="browse_page_channel_purpose"]')
                    ?.textContent ??
                    row.querySelector(
                      '[data-qa="medium_channel_entity_purpose"]',
                    )?.textContent ??
                    null,
                );
                const memberCountText = normalizeTextInPage(
                  row.querySelector(
                    '[data-qa="browse_page_channel_member_count"]',
                  )?.textContent ?? null,
                );
                const joinState = normalizeTextInPage(
                  row
                    .querySelector('[data-qa="join-leave-channel"]')
                    ?.getAttribute('aria-label') ??
                    row.querySelector('[data-qa="join-leave-channel"]')
                      ?.textContent ??
                    row.querySelector(
                      '[data-qa="browse_page_channel_joined_status"]',
                    )?.textContent ??
                    null,
                );
                const iconType = normalizeTextInPage(
                  row
                    .querySelector('[data-inline-channel-type-icon]')
                    ?.getAttribute('data-inline-channel-type-icon') ?? null,
                );
                const type = inferTypeInPage(iconType);

                return {
                  isMember:
                    joinState && /joined|leave/i.test(joinState)
                      ? true
                      : joinState && /join/i.test(joinState)
                        ? false
                        : null,
                  isPrivate: type === 'private_channel',
                  key: normalizeKeyInPage(name),
                  memberCount: parseMemberCount(memberCountText),
                  name,
                  nameNormalized: name,
                  purpose,
                  type,
                };
              })
              .filter(
                (channel): channel is UiChannelRecord => channel !== null,
              );

            const scrollTop =
              scrollHost instanceof HTMLElement ? scrollHost.scrollTop : 0;
            const clientHeight =
              scrollHost instanceof HTMLElement ? scrollHost.clientHeight : 0;
            const scrollHeight =
              scrollHost instanceof HTMLElement ? scrollHost.scrollHeight : 0;

            if (shouldScrollToBottom && scrollHost instanceof HTMLElement) {
              scrollHost.scrollTop = scrollHost.scrollHeight;
            }

            return {
              channels: rows,
              clientHeight,
              currentPage: currentPageButton
                ? Number.parseInt(
                    currentPageButton.textContent?.trim() ?? '',
                    10,
                  ) || null
                : null,
              hasNextPage:
                nextPageButton instanceof HTMLButtonElement
                  ? !nextPageButton.disabled &&
                    nextPageButton.getAttribute('aria-disabled') !== 'true'
                  : nextPageButton instanceof HTMLElement
                    ? nextPageButton.getAttribute('aria-disabled') !== 'true'
                    : false,
              listVisible: list instanceof HTMLElement,
              onChannelsPanel: panel instanceof HTMLElement,
              scrollHeight,
              scrollTop,
            };
          },
          { shouldScrollToBottom: scrollToBottom },
        );

      const mergeSnapshot = (
        snapshot: Awaited<ReturnType<typeof readSnapshot>>,
      ): void => {
        for (const channel of snapshot.channels) {
          if (channel.key && !seen.has(channel.key)) {
            seen.set(channel.key, channel);
          }
        }
      };

      const topSnapshot = await readSnapshot(false);
      if (!topSnapshot.onChannelsPanel || !topSnapshot.listVisible) {
        return {
          currentPage: null,
          hasNextPage: false,
        };
      }
      mergeSnapshot(topSnapshot);

      await page.waitForTimeout(150);
      const bottomSnapshot = await readSnapshot(true);
      await page.waitForTimeout(150);
      const finalSnapshot = await readSnapshot(false);
      mergeSnapshot(bottomSnapshot);
      mergeSnapshot(finalSnapshot);

      const sampleNames = finalSnapshot.channels
        .map((channel: UiChannelRecord) => channel.name)
        .slice(0, 5);

      return {
        currentPage: finalSnapshot.currentPage ?? bottomSnapshot.currentPage,
        hasNextPage: finalSnapshot.hasNextPage || bottomSnapshot.hasNextPage,
        rowsSeen: finalSnapshot.channels.length,
        sampleNames,
      };
    };

    const goToNextPage = async (
      previousPage: number | null,
      previousFirstKey: string | null,
    ): Promise<boolean> => {
      const disabled = await page
        .evaluate(() => {
          const nextPageButton = document.querySelector(
            '[aria-label="Next page"]',
          );
          return nextPageButton instanceof HTMLButtonElement
            ? nextPageButton.disabled ||
                nextPageButton.getAttribute('aria-disabled') === 'true'
            : nextPageButton instanceof HTMLElement
              ? nextPageButton.getAttribute('aria-disabled') === 'true'
              : true;
        })
        .catch(() => true);
      if (disabled) {
        return false;
      }

      if (!(await clickVisiblePaginationButton('Next page'))) {
        return false;
      }

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250);
        const after = await page
          .evaluate(() => {
            const currentPageButton =
              document.querySelector('[aria-current="page"]') ??
              document.querySelector('[aria-label^="Page "][disabled]') ??
              null;
            const firstRow = document.querySelector('.c-channel_entity__name');
            return {
              currentPage: currentPageButton
                ? Number.parseInt(
                    currentPageButton.textContent?.trim() ?? '',
                    10,
                  ) || null
                : null,
              firstKey:
                firstRow?.textContent
                  ?.replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase() ?? null,
            };
          })
          .catch(() => ({
            currentPage: null,
            firstKey: null,
          }));

        if (
          after.currentPage !== previousPage ||
          after.firstKey !== previousFirstKey
        ) {
          return true;
        }
      }

      return false;
    };

    debug.sortSetToNewest = await setNewestChannelSort();
    debug.finalSortLabel = await currentSortLabel();
    debug.resetToFirstPage = await resetToFirstPage();

    const seen = new Map<string, UiChannelRecord>();
    let stagnantPages = 0;
    for (let pageIndex = 0; pageIndex < 400; pageIndex += 1) {
      await page
        .evaluate(() => {
          const list = document.querySelector('[aria-label="Channel results"]');
          const scrollHost =
            list?.closest('[data-qa="slack_kit_scrollbar"]') ??
            list?.parentElement;
          if (scrollHost instanceof HTMLElement) {
            scrollHost.scrollTop = 0;
          }
        })
        .catch(() => null);
      await sleep(200);

      const beforeCount = seen.size;
      const pageState = await collectCurrentPage(seen);
      if (debug.firstObservedPage === null) {
        debug.firstObservedPage = pageState.currentPage;
      }
      debug.pageVisits.push({
        currentPage: pageState.currentPage,
        nextPageAvailable: pageState.hasNextPage,
        rowsSeen: pageState.rowsSeen,
        sampleNames: pageState.sampleNames,
        uniqueAfterPage: seen.size,
      });
      const firstKey = await page
        .evaluate(() => {
          return (
            document
              .querySelector('.c-channel_entity__name')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim()
              .toLowerCase() ?? null
          );
        })
        .catch(() => null);

      stagnantPages = seen.size === beforeCount ? stagnantPages + 1 : 0;
      if (!pageState.hasNextPage || stagnantPages >= 200) {
        debug.stopReason = !pageState.hasNextPage
          ? 'next_page_unavailable'
          : 'stagnant_pages_limit';
        break;
      }

      const moved = await goToNextPage(pageState.currentPage, firstKey);
      if (!moved) {
        debug.stopReason = 'go_to_next_page_failed';
        break;
      }
    }

    if (!debug.stopReason) {
      debug.stopReason = 'page_limit_reached';
    }
    debug.finalSortLabel = await currentSortLabel();
    const channels = sortChannelsByNameInRunner(Array.from(seen.values()));
    debug.uiChannelCount = channels.length;

    return {
      channels,
      debug,
    };
  };

  let uiResult: {
    channels: UiChannelRecord[];
    debug: ChannelListHydrateDebug;
  } | null = null;
  if (hydrate) {
    uiResult = await collectChannelsFromDirectory().catch((error) => ({
      channels: [] as UiChannelRecord[],
      debug: {
        error: error instanceof Error ? error.message : String(error),
        finalSortLabel: null,
        firstObservedPage: null,
        openedDirectory: false,
        pageVisits: [],
        resetToFirstPage: false,
        sortSetToNewest: false,
        stopReason: 'collect_channels_failed',
        uiChannelCount: 0,
      },
    }));
  }

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const payload = await page
    .evaluate(
      async ({
        maxItems,
        workspaceUrlForTeam,
      }: {
        maxItems: number;
        workspaceUrlForTeam: string;
      }) => {
      const isChannelLikeEntryInPage = (channel: unknown): boolean => {
        if (!channel || typeof channel !== 'object') {
          return false;
        }

        const rawChannel = channel as Record<string, unknown>;
        return Boolean(
          rawChannel.is_channel ||
            rawChannel.is_group ||
            rawChannel.is_im ||
            rawChannel.is_mpim ||
            rawChannel.is_private,
        );
      };

      const normalizeChannelListInPage = (
        channelsState: Record<string, unknown>,
        currentMaxItems: number,
      ) => {
        const classifyChannel = (channel: Record<string, any>): ChannelType => {
          if (channel.is_im) return 'dm';
          if (channel.is_mpim) return 'mpim';
          if (channel.is_group || channel.is_private) return 'private_channel';
          if (channel.is_channel) return 'public_channel';
          return 'unknown';
        };

        return Object.values(channelsState)
          .filter(isChannelLikeEntryInPage)
          .map((channel: any) => ({
            id: channel.id ?? null,
            name: channel.name ?? null,
            nameNormalized: channel.name_normalized ?? null,
            type: classifyChannel(channel),
            isArchived: Boolean(channel.is_archived),
            isExtShared: Boolean(channel.is_ext_shared),
            isGeneral: Boolean(channel.is_general),
            isMember: Boolean(channel.is_member),
            isOrgShared: Boolean(channel.is_org_shared),
            isPrivate: Boolean(channel.is_private),
            isReadOnly: Boolean(channel.is_read_only),
            isThreadOnly: Boolean(channel.is_thread_only),
            created:
              typeof channel.created === 'number' ? channel.created : null,
            updated:
              typeof channel.updated === 'number' ? channel.updated : null,
            previousNames: Array.isArray(channel.previous_names)
              ? channel.previous_names
              : [],
            purpose:
              typeof channel.purpose?.value === 'string'
                ? channel.purpose.value
                : null,
            topic:
              typeof channel.topic?.value === 'string'
                ? channel.topic.value
                : null,
          }))
          .sort((left, right) => {
            const leftKey = left.nameNormalized ?? left.name ?? left.id ?? '';
            const rightKey =
              right.nameNormalized ?? right.name ?? right.id ?? '';
            return leftKey.localeCompare(rightKey);
          })
          .slice(0, currentMaxItems);
      };

      const openDb = (dbName: string) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(dbName);
          request.onerror = () =>
            reject(request.error?.message || 'open failed');
          request.onsuccess = () => resolve(request.result);
        });

      const getValue = (db: IDBDatabase, storeName: string, key: IDBValidKey) =>
        new Promise<any>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const request = store.get(key);
          tx.onerror = () => reject(tx.error?.message || 'tx failed');
          tx.oncomplete = () => resolve(request.result);
        });

      const getAllKeys = (db: IDBDatabase, storeName: string) =>
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const request = store.getAllKeys();
          tx.onerror = () => reject(tx.error?.message || 'tx failed');
          tx.oncomplete = () =>
            resolve(Array.isArray(request.result) ? request.result : []);
        });

      const parseTeamIdFromUrl = (url: string) => {
        const match = url.match(/\/client\/([^/]+)/);
        return match ? match[1] : null;
      };

      const db = await openDb('reduxPersistence');

      try {
        const keys = await getAllKeys(db, 'reduxPersistenceStore');
        const teamId = parseTeamIdFromUrl(workspaceUrlForTeam);
        const stateKey =
          keys.find(
            (key) =>
              typeof key === 'string' &&
              teamId &&
              key.startsWith(`persist:slack-client-${teamId}-`),
          ) ??
          keys.find(
            (key) =>
              typeof key === 'string' &&
              key.startsWith('persist:slack-client-'),
          ) ??
          null;

        if (!stateKey) {
          throw new Error(
            'Could not find reduxPersistence key for Slack client state.',
          );
        }

        const state = await getValue(db, 'reduxPersistenceStore', stateKey);
        const channelsState =
          state?.channels && typeof state.channels === 'object'
            ? state.channels
            : {};
        const normalizedChannels = normalizeChannelListInPage(
          channelsState,
          maxItems,
        );
        const totalChannelCount = Object.values(channelsState).filter(
          isChannelLikeEntryInPage,
        ).length;

        return {
          mode: 'list-channels' as const,
          channels: normalizedChannels,
          listUrl: location.href,
          pageTitle: document.title,
          source: 'reduxPersistence.channels' as const,
          stateKey,
          totalChannelCount,
        };
      } finally {
        db.close();
      }
      },
      { maxItems: limit, workspaceUrlForTeam: workspaceUrl },
    )
    .catch((error: unknown) => {
      throw buildSlackClientStateUnavailableError({
        action: 'slack.list-channels',
        cause: error,
        workspaceUrl,
      });
    });

  if (!hydrate || !uiResult || uiResult.channels.length === 0) {
    return uiResult?.debug
      ? {
          ...payload,
          hydrateDebug: uiResult.debug,
        }
      : payload;
  }

  const mergedPayload = mergeChannelListsInRunner(uiResult.channels, payload);

  return {
    hydrateDebug: uiResult.debug,
    ...mergedPayload,
    channels: mergedPayload.channels.slice(0, limit),
  };
}
