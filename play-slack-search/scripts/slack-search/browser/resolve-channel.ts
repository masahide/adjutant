import type {
  ResolveChannelCodeInput,
  ResolveChannelsPayload,
} from '../contracts.ts';
import {
  buildSlackClientStateUnavailableError,
  installBrowserRuntimeShims,
} from './runtime-shims.ts';

type BrowserPage = any;

export async function runResolveChannelInBrowser(
  page: BrowserPage,
  input: ResolveChannelCodeInput,
): Promise<ResolveChannelsPayload> {
  await installBrowserRuntimeShims(page);
  const searchDialogTimeoutMs = 5_000;
  const searchResultsTimeoutMs = 2_500;

  const normalizeRequestedIds = (channelIds: string[]): string[] => {
    const uniqueIds = new Set<string>();

    for (const channelId of channelIds) {
      const normalized = channelId.trim();
      if (normalized.length > 0) {
        uniqueIds.add(normalized);
      }
    }

    return [...uniqueIds];
  };

  const lookupChannelsFromCache = async () => {
    return await page
      .evaluate(
        async ({
          channelIdsForLookup,
          workspaceUrlForTeam,
        }: {
          channelIdsForLookup: string[];
          workspaceUrlForTeam: string;
        }) => {
        const normalizedText = (value: unknown): string | null => {
          if (typeof value !== 'string') {
            return null;
          }
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        };

        const parseTeamIdFromUrlInPage = (url: string) => {
          const match = url.match(/\/client\/([^/]+)/);
          return match ? match[1] : null;
        };

        const openDb = (dbName: string) =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName);
            request.onerror = () =>
              reject(request.error?.message || 'open failed');
            request.onsuccess = () => resolve(request.result);
          });

        const getValue = (
          db: IDBDatabase,
          storeName: string,
          key: IDBValidKey,
        ) =>
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

        const db = await openDb('reduxPersistence');

        try {
          const keys = await getAllKeys(db, 'reduxPersistenceStore');
          const teamId = parseTeamIdFromUrlInPage(workspaceUrlForTeam);
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
            return {
              channels: [],
              stateKey: null,
            };
          }

          const state = await getValue(db, 'reduxPersistenceStore', stateKey);
          const channelsState =
            state?.channels && typeof state.channels === 'object'
              ? (state.channels as Record<string, any>)
              : {};

          return {
            channels: channelIdsForLookup
              .map((channelIdForLookup) => {
                const channel = channelsState[channelIdForLookup];
                const channelName = normalizedText(
                  channel?.name_normalized ?? channel?.name ?? null,
                );

                if (!channelName) {
                  return null;
                }

                return {
                  channelId: channelIdForLookup,
                  channelName,
                  resolved: true,
                  source: 'reduxPersistence.channels' as const,
                  stateKey,
                };
              })
              .filter(Boolean),
            stateKey,
          };
        } finally {
          db.close();
        }
        },
        {
          channelIdsForLookup: requestedIds,
          workspaceUrlForTeam: input.workspaceUrl,
        },
      )
      .catch((error: unknown) => {
        throw buildSlackClientStateUnavailableError({
          action: 'slack.resolve-channel-id',
          cause: error,
          workspaceUrl: input.workspaceUrl,
        });
      });
  };

  const openSearchDialog = async (): Promise<boolean> => {
    const searchDialog = page.getByRole('dialog', { name: 'Search' });
    if (await searchDialog.isVisible().catch(() => false)) {
      return true;
    }

    const searchButton = page
      .locator('button')
      .filter({ hasText: /^Search\b/ })
      .first();

    await searchButton
      .click({ timeout: searchDialogTimeoutMs })
      .catch(() => null);
    await searchDialog
      .waitFor({ state: 'visible', timeout: searchDialogTimeoutMs })
      .catch(() => null);

    return await searchDialog.isVisible().catch(() => false);
  };

  const closeSearchDialog = async (): Promise<void> => {
    const searchDialog = page.getByRole('dialog', { name: 'Search' });
    if (!(await searchDialog.isVisible().catch(() => false))) {
      return;
    }

    await page.keyboard.press('Escape').catch(() => null);
    await searchDialog
      .waitFor({ state: 'hidden', timeout: 2_000 })
      .catch(() => null);
  };

  const resolveChannelFromSearchSuggestion = async (channelId: string) => {
    const queryInput = page.getByRole('combobox', { name: 'Query' });
    await queryInput.click().catch(() => null);
    await queryInput.fill(channelId).catch(() => null);

    await page
      .waitForFunction(
        (channelIdForLookup: string) => {
          return [
            ...document.querySelectorAll<HTMLElement>('[role="option"]'),
          ].some((option) => {
            const optionText = option.textContent ?? '';
            return (
              option.dataset.id === channelIdForLookup ||
              optionText.includes(channelIdForLookup)
            );
          });
        },
        channelId,
        { timeout: searchResultsTimeoutMs },
      )
      .catch(() => null);

    const match = await page.evaluate((channelIdForLookup: string) => {
      const normalizeChannelName = (value: string | null): string | null => {
        if (!value) {
          return null;
        }

        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return null;
        }

        return trimmed.replace(/\s+\(has a draft message\)$/u, '');
      };

      const deriveNameFromOption = (option: HTMLElement): string | null => {
        const aria = normalizeChannelName(option.getAttribute('aria-label'));
        if (aria && !aria.startsWith('Search for:')) {
          return aria;
        }

        const text = normalizeChannelName(option.textContent);
        if (!text) {
          return null;
        }

        return text.replace(/Enter$/u, '').trim();
      };

      const channelOption = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find(
        (option) =>
          option.dataset.type === 'channel' &&
          option.dataset.id === channelIdForLookup,
      );

      if (!channelOption) {
        return null;
      }

      return {
        channelId: channelIdForLookup,
        channelName: deriveNameFromOption(channelOption),
        resolved: true,
        source: 'search.suggestion' as const,
        stateKey: null,
      };
    }, channelId);

    await queryInput.fill('').catch(() => null);

    if (match?.channelName) {
      return match;
    }

    return {
      channelId,
      channelName: null,
      resolved: false,
      source: 'unresolved' as const,
      stateKey: null,
    };
  };

  const requestedIds = normalizeRequestedIds(input.channelIds);

  await page.goto(input.workspaceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);

  const cacheLookup = await lookupChannelsFromCache();
  const resolvedById = new Map<string, (typeof cacheLookup.channels)[number]>(
    cacheLookup.channels.map(
      (channel: (typeof cacheLookup.channels)[number]) => [
        channel.channelId,
        channel,
      ],
    ),
  );
  const unresolvedIds = requestedIds.filter((channelId) => {
    const resolved = resolvedById.get(channelId);
    return !resolved?.resolved;
  });

  if (unresolvedIds.length > 0 && (await openSearchDialog())) {
    for (const channelId of unresolvedIds) {
      const resolved = await resolveChannelFromSearchSuggestion(channelId);
      resolvedById.set(channelId, resolved);
    }

    await closeSearchDialog();
  }

  return {
    channels: requestedIds.map(
      (channelId) =>
        resolvedById.get(channelId) ?? {
          channelId,
          channelName: null,
          resolved: false,
          source: 'unresolved' as const,
          stateKey: null,
        },
    ),
    listUrl: page.url(),
    mode: 'resolve-channels',
    pageTitle: await page.title(),
  };
}
