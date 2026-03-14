import type {
  ListUsersCodeInput,
  UserListHydrateDebug,
  UserListPayload,
} from '../contracts.ts';

type BrowserPage = any;
type UserListSource = UserListPayload['source'];
type SortableUserLike = {
  displayName?: string | null;
  displayNameNormalized?: string | null;
  id?: string | null;
  name?: string | null;
  realName?: string | null;
};
type UiMemberRecord = {
  displayName: string | null;
  key: string | null;
  name: string | null;
  raw: string;
  realName: string | null;
  title: string | null;
};

function buildUserSortKey(user: SortableUserLike): string {
  return (
    user.displayNameNormalized ??
    user.displayName ??
    user.realName ??
    user.name ??
    user.id ??
    ''
  );
}

function sortUsersByName<T extends SortableUserLike>(users: T[]): T[] {
  return users
    .slice()
    .sort((left, right) =>
      buildUserSortKey(left).localeCompare(buildUserSortKey(right)),
    );
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickBoolean(...values: unknown[]): boolean {
  return values.some(Boolean);
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return null;
}

function pickText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizedText(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function mergeUserRecord(
  left: Record<string, any> | null,
  right: Record<string, any> | null,
  fallbackId: string,
  teamId: string | null,
) {
  const profileLeft =
    left?.profile && typeof left.profile === 'object' ? left.profile : {};
  const profileRight =
    right?.profile && typeof right.profile === 'object' ? right.profile : {};

  const id = pickText(left?.id, right?.id, fallbackId);
  if (!id) {
    return null;
  }

  return {
    id,
    teamId: pickText(left?.team_id, right?.team_id, teamId),
    name: pickText(left?.name, right?.name),
    realName: pickText(
      left?.real_name,
      right?.real_name,
      profileLeft.real_name,
      profileRight.real_name,
    ),
    displayName: pickText(profileLeft.display_name, profileRight.display_name),
    displayNameNormalized: pickText(
      profileLeft.display_name_normalized,
      profileRight.display_name_normalized,
    ),
    title: pickText(profileLeft.title, profileRight.title),
    email: pickText(profileLeft.email, profileRight.email),
    tz: pickText(left?.tz, right?.tz),
    updated: pickNumber(left?.updated, right?.updated),
    isAdmin: pickBoolean(left?.is_admin, right?.is_admin),
    isAppUser: pickBoolean(left?.is_app_user, right?.is_app_user),
    isBot: pickBoolean(left?.is_bot, right?.is_bot),
    isDeleted: pickBoolean(left?.deleted, right?.deleted),
    isOwner: pickBoolean(left?.is_owner, right?.is_owner),
    isPrimaryOwner: pickBoolean(
      left?.is_primary_owner,
      right?.is_primary_owner,
    ),
    isRestricted: pickBoolean(left?.is_restricted, right?.is_restricted),
    isStranger: pickBoolean(left?.is_stranger, right?.is_stranger),
    isUltraRestricted: pickBoolean(
      left?.is_ultra_restricted,
      right?.is_ultra_restricted,
    ),
  };
}

export function mergeUserStates(
  membersState: unknown,
  usersState: unknown,
  teamId: string | null,
) {
  const members =
    membersState && typeof membersState === 'object'
      ? (membersState as Record<string, unknown>)
      : {};
  const users =
    usersState && typeof usersState === 'object'
      ? (usersState as Record<string, unknown>)
      : {};

  const allKeys = new Set<string>([
    ...Object.keys(members),
    ...Object.keys(users),
  ]);

  const mergedUsers = Array.from(allKeys)
    .map((entryKey) => {
      const left =
        members[entryKey] && typeof members[entryKey] === 'object'
          ? (members[entryKey] as Record<string, any>)
          : null;
      const right =
        users[entryKey] && typeof users[entryKey] === 'object'
          ? (users[entryKey] as Record<string, any>)
          : null;

      return mergeUserRecord(left, right, entryKey, teamId);
    })
    .filter((user): user is NonNullable<typeof user> => user !== null)
    .sort((left, right) => {
      return buildUserSortKey(left).localeCompare(buildUserSortKey(right));
    });

  const memberCount = Object.keys(members).length;
  const userCount = Object.keys(users).length;
  const source: UserListSource =
    memberCount > 0 && userCount > 0
      ? 'reduxPersistence.members+users'
      : memberCount > 0
        ? 'reduxPersistence.members'
        : 'reduxPersistence.users';

  return {
    source,
    users: mergedUsers,
  };
}

export async function runListUsersInBrowser(
  page: BrowserPage,
  input: ListUsersCodeInput,
): Promise<UserListPayload> {
  const { hydrate = false, limit, workspaceUrl } = input;
  const buildUserSortKeyInBrowserRunner = (user: SortableUserLike): string => {
    return (
      user.displayNameNormalized ??
      user.displayName ??
      user.realName ??
      user.name ??
      user.id ??
      ''
    );
  };

  const sortUsersByNameInBrowserRunner = <T extends SortableUserLike>(
    users: T[],
  ): T[] => {
    return users.slice().sort((left, right) => {
      return buildUserSortKeyInBrowserRunner(left).localeCompare(
        buildUserSortKeyInBrowserRunner(right),
      );
    });
  };

  const parseTeamIdFromUrl = (url: string) => {
    const match = url.match(/\/client\/([^/]+)/);
    return match ? match[1] : null;
  };

  const normalizeKey = (value: string | null | undefined): string | null => {
    if (!value) {
      return null;
    }
    const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
    return normalized.length > 0 ? normalized : null;
  };

  const parseUiMemberLine = (raw: string) => {
    const lines = raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0 || lines[0] === 'Add people') {
      return null;
    }

    const displayName = lines[0] ?? null;
    const secondary = lines[1] ?? null;
    const secondaryParts = secondary ? secondary.split(/\s+/) : [];
    const lastSecondaryPart =
      secondaryParts.length > 0
        ? secondaryParts[secondaryParts.length - 1]
        : null;
    const looksLikeUsername =
      lastSecondaryPart !== null &&
      /^[a-z0-9._-]+$/i.test(lastSecondaryPart) &&
      secondaryParts.length >= 2;
    const name = looksLikeUsername ? lastSecondaryPart : null;
    const realName = looksLikeUsername
      ? secondaryParts.slice(0, -1).join(' ')
      : secondary;
    const title = lines.length > 2 ? lines.slice(2).join(' / ') : null;

    return {
      displayName,
      key: normalizeKey(raw),
      name,
      raw,
      realName,
      title,
    };
  };

  const collectUsersFromMemberPanel = async () => {
    const debug: UserListHydrateDebug = {
      clickedMemberButton: false,
      error: null,
      finalUiUserCount: 0,
      firstPassDeclaredCount: null,
      firstPassUiUserCount: 0,
      memberPanelOpened: false,
      openAttempts: 0,
      secondPassDeclaredCount: null,
      secondPassRan: false,
      secondPassUiUserCount: null,
    };

    const clickMemberButton = async () => {
      return await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('button,a,[role=button],[role=link]'),
        );
        const target = candidates.find(
          (element) =>
            /view all \d[\d,]* members/i.test(
              `${element.getAttribute('aria-label') || ''} ${
                element.textContent || ''
              }`,
            ) ||
            (/^\d[\d,]*$/.test((element.textContent || '').trim()) &&
              (
                (element.closest('[role=toolbar]') as HTMLElement | null)
                  ?.textContent ||
                element.parentElement?.textContent ||
                ''
              ).includes('Members')),
        );
        if (!(target instanceof HTMLElement)) {
          return false;
        }
        target.click();
        return true;
      });
    };

    const openMemberPanel = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        debug.openAttempts = attempt + 1;
        await page
          .goto(workspaceUrl, { waitUntil: 'domcontentloaded' })
          .catch(() => null);
        await page.waitForTimeout(2000);

        const clicked = await clickMemberButton().catch(() => false);
        debug.clickedMemberButton = debug.clickedMemberButton || clicked;
        if (!clicked) {
          continue;
        }

        await page.waitForTimeout(1000);
        const opened = await page
          .evaluate(() => {
            const dialog = document.querySelector(
              '[role=dialog][aria-label*="Details"]',
            );
            if (!(dialog instanceof HTMLElement)) {
              return false;
            }

            return Boolean(
              dialog.querySelector('[role=tab][aria-selected="true"]') &&
                (dialog.querySelector('[role=list][aria-label*="Members"]') ??
                  dialog.querySelector('[role=list]')),
            );
          })
          .catch(() => false);

        if (opened) {
          debug.memberPanelOpened = true;
          return true;
        }
      }

      return false;
    };

    const opened = await openMemberPanel();
    if (!opened) {
      return {
        count: null as number | null,
        debug,
        users: [] as UiMemberRecord[],
      };
    }

    const resetMemberPanelScroll = async () => {
      await page
        .evaluate(() => {
          const dialog = document.querySelector(
            '[role=dialog][aria-label*="Details"]',
          );
          if (!(dialog instanceof HTMLElement)) {
            return;
          }

          const memberList = dialog.querySelector(
            '[role=list][aria-label*="Members"]',
          );
          let scrollTarget: HTMLElement | null = null;
          let current =
            memberList instanceof HTMLElement ? memberList.parentElement : null;

          while (current && current !== dialog) {
            if (current.scrollHeight > current.clientHeight + 50) {
              scrollTarget = current;
              break;
            }
            current = current.parentElement;
          }

          if (!scrollTarget) {
            const fallbackTarget = Array.from(dialog.querySelectorAll('*'))
              .filter(
                (element) =>
                  element instanceof HTMLElement &&
                  element.clientHeight > 100 &&
                  element.scrollHeight > element.clientHeight + 50,
              )
              .sort((left, right) => {
                const leftHeight =
                  left instanceof HTMLElement ? left.scrollHeight : 0;
                const rightHeight =
                  right instanceof HTMLElement ? right.scrollHeight : 0;
                return rightHeight - leftHeight;
              })[0] as HTMLElement | undefined;
            scrollTarget = fallbackTarget ?? null;
          }

          if (scrollTarget) {
            scrollTarget.scrollTop = 0;
          }
        })
        .catch(() => null);
    };

    const scanMemberPanel = async (
      options: {
        maxAttempts: number;
        scrollRatio: number;
        stagnantLimit: number;
        waitMs: number;
      },
      seed = new Map<string, UiMemberRecord>(),
    ) => {
      const seen = new Map(seed);
      let declaredCount: number | null = null;
      let stagnantPasses = 0;

      for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
        const seenBefore = seen.size;
        const state = await page.evaluate(
          ({ scrollRatio }: { scrollRatio: number }) => {
            const dialog = document.querySelector(
              '[role=dialog][aria-label*="Details"]',
            );
            if (!(dialog instanceof HTMLElement)) {
              return {
                countLabel: null,
                items: [],
                moved: false,
              };
            }

            const tab = Array.from(
              dialog.querySelectorAll('[role=tab],button,a'),
            ).find((element) =>
              /Members/.test(
                (element.textContent || '').replace(/\s+/g, ' ').trim(),
              ),
            );
            const countLabel = tab
              ? (tab.textContent || '').replace(/\s+/g, ' ').trim()
              : null;
            const memberList =
              dialog.querySelector('[role=list][aria-label*="Members"]') ??
              dialog.querySelector('[role=list]');
            const listItems = Array.from(
              (memberList ?? dialog).querySelectorAll('[role=listitem]'),
            );
            const items = listItems
              .map((element) =>
                element instanceof HTMLElement
                  ? element.innerText
                  : element.textContent,
              )
              .map((text) => (text || '').trim())
              .filter(Boolean);
            let scrollTarget: Element | null = null;
            let current =
              memberList instanceof HTMLElement
                ? memberList.parentElement
                : null;

            while (current && current !== dialog) {
              if (current.scrollHeight > current.clientHeight + 50) {
                scrollTarget = current;
                break;
              }
              current = current.parentElement;
            }

            if (!scrollTarget) {
              const fallbackTarget = Array.from(dialog.querySelectorAll('*'))
                .filter(
                  (element) =>
                    element instanceof HTMLElement &&
                    element.clientHeight > 100 &&
                    element.scrollHeight > element.clientHeight + 50,
                )
                .sort((left, right) => {
                  const leftHeight =
                    left instanceof HTMLElement ? left.scrollHeight : 0;
                  const rightHeight =
                    right instanceof HTMLElement ? right.scrollHeight : 0;
                  return rightHeight - leftHeight;
                })[0];
              scrollTarget = fallbackTarget ?? null;
            }

            let moved = false;
            if (scrollTarget instanceof HTMLElement) {
              const next = Math.min(
                scrollTarget.scrollTop +
                  Math.max(80, scrollTarget.clientHeight * scrollRatio),
                scrollTarget.scrollHeight,
              );
              moved = next > scrollTarget.scrollTop + 4;
              scrollTarget.scrollTop = next;
            }

            return {
              countLabel,
              items,
              moved,
            };
          },
          { scrollRatio: options.scrollRatio },
        );

        if (declaredCount === null && state.countLabel) {
          const parsed = Number.parseInt(
            state.countLabel.replace(/[^\d]/g, ''),
            10,
          );
          if (Number.isFinite(parsed) && parsed > 0) {
            declaredCount = parsed;
          }
        }

        for (const rawItem of state.items) {
          const parsed = parseUiMemberLine(rawItem);
          if (!parsed) {
            continue;
          }
          const seenKey = parsed.key ?? normalizeKey(parsed.raw);
          if (!seenKey || seen.has(seenKey)) {
            continue;
          }
          seen.set(seenKey, parsed);
        }

        if (declaredCount !== null && seen.size >= declaredCount) {
          break;
        }

        stagnantPasses = seen.size === seenBefore ? stagnantPasses + 1 : 0;

        if (!state.moved || stagnantPasses >= options.stagnantLimit) {
          break;
        }

        await page.waitForTimeout(options.waitMs);
      }

      return {
        count: declaredCount,
        seen,
      };
    };

    await page.waitForTimeout(1000);
    await resetMemberPanelScroll();
    await page.waitForTimeout(250);

    const firstPass = await scanMemberPanel({
      maxAttempts: 2000,
      scrollRatio: 0.45,
      stagnantLimit: 25,
      waitMs: 60,
    });
    debug.firstPassDeclaredCount = firstPass.count;
    debug.firstPassUiUserCount = firstPass.seen.size;

    let finalCount = firstPass.count;
    let finalSeen = firstPass.seen;

    if (finalCount !== null && finalSeen.size < finalCount) {
      debug.secondPassRan = true;
      await resetMemberPanelScroll();
      await page.waitForTimeout(250);

      const secondPass = await scanMemberPanel(
        {
          maxAttempts: 4000,
          scrollRatio: 0.2,
          stagnantLimit: 60,
          waitMs: 80,
        },
        finalSeen,
      );

      debug.secondPassDeclaredCount = secondPass.count;
      debug.secondPassUiUserCount = secondPass.seen.size;
      finalCount = secondPass.count ?? finalCount;
      finalSeen = secondPass.seen;
    }

    debug.finalUiUserCount = finalSeen.size;

    return {
      count: finalCount,
      debug,
      users: sortUsersByNameInBrowserRunner(Array.from(finalSeen.values())),
    };
  };

  const buildCacheKeys = (user: UserListPayload['users'][number]) => {
    const keys = new Set<string>();
    const candidates = [
      user.name,
      user.realName,
      user.displayName,
      [user.displayName, user.realName, user.name].filter(Boolean).join(' | '),
    ];
    for (const candidate of candidates) {
      const normalized = normalizeKey(candidate);
      if (normalized) {
        keys.add(normalized);
      }
    }
    return keys;
  };

  const mergeUiUsersIntoCacheUsers = (
    uiUsers: Awaited<ReturnType<typeof collectUsersFromMemberPanel>>['users'],
    cachePayload: UserListPayload,
  ): UserListPayload => {
    if (uiUsers.length === 0) {
      return cachePayload;
    }

    const cacheByKey = new Map<string, UserListPayload['users'][number]>();
    for (const cacheUser of cachePayload.users) {
      for (const key of buildCacheKeys(cacheUser)) {
        if (!cacheByKey.has(key)) {
          cacheByKey.set(key, cacheUser);
        }
      }
    }

    const mergedUsers = sortUsersByNameInBrowserRunner(
      uiUsers.map((uiUser) => {
        const cacheUser = uiUser.key ? cacheByKey.get(uiUser.key) : null;
        if (cacheUser) {
          return {
            ...cacheUser,
            displayName: cacheUser.displayName ?? uiUser.displayName,
            name: cacheUser.name ?? uiUser.name,
            realName: cacheUser.realName ?? uiUser.realName,
            title: cacheUser.title ?? uiUser.title,
          };
        }

        return {
          id: null,
          teamId: parseTeamIdFromUrl(workspaceUrl),
          name: uiUser.name,
          realName: uiUser.realName,
          displayName: uiUser.displayName,
          displayNameNormalized: uiUser.displayName,
          title: uiUser.title,
          email: null,
          tz: null,
          updated: null,
          isAdmin: false,
          isAppUser: false,
          isBot: false,
          isDeleted: false,
          isOwner: false,
          isPrimaryOwner: false,
          isRestricted: false,
          isStranger: false,
          isUltraRestricted: false,
        };
      }),
    );

    const source: UserListSource =
      cachePayload.source === 'reduxPersistence.members'
        ? 'reduxPersistence.members+ui.member-panel'
        : cachePayload.source === 'reduxPersistence.users'
          ? 'reduxPersistence.users+ui.member-panel'
          : cachePayload.source === 'reduxPersistence.members+users'
            ? 'reduxPersistence.members+users+ui.member-panel'
            : 'ui.member-panel';

    return {
      ...cachePayload,
      source,
      totalUserCount: Math.max(cachePayload.totalUserCount, mergedUsers.length),
      users: mergedUsers,
    };
  };

  let uiUsers: Awaited<ReturnType<typeof collectUsersFromMemberPanel>> | null =
    null;
  if (hydrate) {
    uiUsers = await collectUsersFromMemberPanel().catch((error) => ({
      count: null,
      debug: {
        clickedMemberButton: false,
        error: error instanceof Error ? error.message : String(error),
        finalUiUserCount: 0,
        firstPassDeclaredCount: null,
        firstPassUiUserCount: 0,
        memberPanelOpened: false,
        openAttempts: 0,
        secondPassDeclaredCount: null,
        secondPassRan: false,
        secondPassUiUserCount: null,
      },
      users: [] as UiMemberRecord[],
    }));
  }

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const payload = await page.evaluate(
    async ({
      maxItems,
      workspaceUrlForTeam,
    }: {
      maxItems: number;
      workspaceUrlForTeam: string;
    }) => {
      const normalizedTextInPage = (value: unknown): string | null => {
        if (typeof value !== 'string') {
          return null;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      };

      const pickBooleanInPage = (...values: unknown[]): boolean =>
        values.some(Boolean);

      const pickNumberInPage = (...values: unknown[]): number | null => {
        for (const value of values) {
          if (typeof value === 'number') {
            return value;
          }
        }
        return null;
      };

      const pickTextInPage = (...values: unknown[]): string | null => {
        for (const value of values) {
          const normalized = normalizedTextInPage(value);
          if (normalized) {
            return normalized;
          }
        }
        return null;
      };

      const mergeUserRecordInPage = (
        left: Record<string, any> | null,
        right: Record<string, any> | null,
        fallbackId: string,
        teamId: string | null,
      ) => {
        const profileLeft =
          left?.profile && typeof left.profile === 'object' ? left.profile : {};
        const profileRight =
          right?.profile && typeof right.profile === 'object'
            ? right.profile
            : {};

        const id = pickTextInPage(left?.id, right?.id, fallbackId);
        if (!id) {
          return null;
        }

        return {
          id,
          teamId: pickTextInPage(left?.team_id, right?.team_id, teamId),
          name: pickTextInPage(left?.name, right?.name),
          realName: pickTextInPage(
            left?.real_name,
            right?.real_name,
            profileLeft.real_name,
            profileRight.real_name,
          ),
          displayName: pickTextInPage(
            profileLeft.display_name,
            profileRight.display_name,
          ),
          displayNameNormalized: pickTextInPage(
            profileLeft.display_name_normalized,
            profileRight.display_name_normalized,
          ),
          title: pickTextInPage(profileLeft.title, profileRight.title),
          email: pickTextInPage(profileLeft.email, profileRight.email),
          tz: pickTextInPage(left?.tz, right?.tz),
          updated: pickNumberInPage(left?.updated, right?.updated),
          isAdmin: pickBooleanInPage(left?.is_admin, right?.is_admin),
          isAppUser: pickBooleanInPage(left?.is_app_user, right?.is_app_user),
          isBot: pickBooleanInPage(left?.is_bot, right?.is_bot),
          isDeleted: pickBooleanInPage(left?.deleted, right?.deleted),
          isOwner: pickBooleanInPage(left?.is_owner, right?.is_owner),
          isPrimaryOwner: pickBooleanInPage(
            left?.is_primary_owner,
            right?.is_primary_owner,
          ),
          isRestricted: pickBooleanInPage(
            left?.is_restricted,
            right?.is_restricted,
          ),
          isStranger: pickBooleanInPage(left?.is_stranger, right?.is_stranger),
          isUltraRestricted: pickBooleanInPage(
            left?.is_ultra_restricted,
            right?.is_ultra_restricted,
          ),
        };
      };

      const mergeUserStatesInPage = (
        membersState: unknown,
        usersState: unknown,
        teamId: string | null,
      ) => {
        const members =
          membersState && typeof membersState === 'object'
            ? (membersState as Record<string, unknown>)
            : {};
        const users =
          usersState && typeof usersState === 'object'
            ? (usersState as Record<string, unknown>)
            : {};

        const allKeys = new Set<string>([
          ...Object.keys(members),
          ...Object.keys(users),
        ]);

        const mergedUsers = Array.from(allKeys)
          .map((entryKey) => {
            const left =
              members[entryKey] && typeof members[entryKey] === 'object'
                ? (members[entryKey] as Record<string, any>)
                : null;
            const right =
              users[entryKey] && typeof users[entryKey] === 'object'
                ? (users[entryKey] as Record<string, any>)
                : null;

            return mergeUserRecordInPage(left, right, entryKey, teamId);
          })
          .filter((user): user is NonNullable<typeof user> => user !== null)
          .sort((left, right) => {
            const leftKey =
              left.displayNameNormalized ??
              left.displayName ??
              left.realName ??
              left.name ??
              left.id;
            const rightKey =
              right.displayNameNormalized ??
              right.displayName ??
              right.realName ??
              right.name ??
              right.id;
            return leftKey.localeCompare(rightKey);
          });

        const memberCount = Object.keys(members).length;
        const userCount = Object.keys(users).length;
        const source: UserListSource =
          memberCount > 0 && userCount > 0
            ? 'reduxPersistence.members+users'
            : memberCount > 0
              ? 'reduxPersistence.members'
              : 'reduxPersistence.users';

        return {
          source,
          users: mergedUsers,
        };
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
          throw new Error(
            'Could not find reduxPersistence key for Slack client state.',
          );
        }

        const state = await getValue(db, 'reduxPersistenceStore', stateKey);
        const merged = mergeUserStatesInPage(
          state?.members,
          state?.users,
          teamId,
        );

        return {
          mode: 'list-users' as const,
          users: merged.users.slice(0, maxItems),
          listUrl: location.href,
          pageTitle: document.title,
          source: merged.source,
          stateKey,
          totalUserCount: merged.users.length,
        };
      } finally {
        db.close();
      }
    },
    { maxItems: limit, workspaceUrlForTeam: workspaceUrl },
  );

  if (!hydrate || !uiUsers || uiUsers.users.length === 0) {
    return uiUsers?.debug
      ? {
          ...payload,
          hydrateDebug: uiUsers.debug,
        }
      : payload;
  }

  const mergedPayload = mergeUiUsersIntoCacheUsers(uiUsers.users, payload);

  return {
    hydrateDebug: uiUsers.debug,
    ...mergedPayload,
    totalUserCount: uiUsers.count ?? mergedPayload.totalUserCount,
    users: mergedPayload.users.slice(0, limit),
  };
}
