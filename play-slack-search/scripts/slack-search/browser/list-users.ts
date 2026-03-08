import type { ListUsersCodeInput, UserListPayload } from '../contracts.ts';

type BrowserPage = any;

export async function runListUsersInBrowser(
  page: BrowserPage,
  input: ListUsersCodeInput,
): Promise<UserListPayload> {
  const { limit, workspaceUrl } = input;

  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const payload = await page.evaluate(async (maxItems: number) => {
    const openDb = (dbName: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error?.message || 'open failed');
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

    const normalizedText = (value: unknown) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const db = await openDb('reduxPersistence');

    try {
      const keys = await getAllKeys(db, 'reduxPersistenceStore');
      const teamId = parseTeamIdFromUrl(location.href);
      const stateKey =
        keys.find(
          (key) =>
            typeof key === 'string' &&
            teamId &&
            key.startsWith(`persist:slack-client-${teamId}-`),
        ) ??
        keys.find(
          (key) =>
            typeof key === 'string' && key.startsWith('persist:slack-client-'),
        ) ??
        null;

      if (!stateKey) {
        throw new Error(
          'Could not find reduxPersistence key for Slack client state.',
        );
      }

      const state = await getValue(db, 'reduxPersistenceStore', stateKey);
      const userStateCandidates = [
        {
          source: 'reduxPersistence.members' as const,
          value: state?.members,
        },
        {
          source: 'reduxPersistence.users' as const,
          value: state?.users,
        },
      ]
        .map((candidate) => {
          const value =
            candidate.value && typeof candidate.value === 'object'
              ? candidate.value
              : null;
          return {
            source: candidate.source,
            value,
            entryCount: value ? Object.keys(value).length : 0,
          };
        })
        .sort((left, right) => right.entryCount - left.entryCount);

      const selectedUserState = userStateCandidates.find(
        (candidate) => candidate.value !== null,
      ) ?? {
        source: 'reduxPersistence.members' as const,
        value: null,
        entryCount: 0,
      };
      const users = Object.entries(selectedUserState.value ?? {})
        .map(([entryKey, rawUser]) => {
          if (!rawUser || typeof rawUser !== 'object') {
            return null;
          }

          const user = rawUser as Record<string, any>;
          const profile =
            user.profile && typeof user.profile === 'object'
              ? user.profile
              : {};
          const id = normalizedText(user.id) ?? normalizedText(entryKey);

          if (!id) {
            return null;
          }

          return {
            id,
            teamId: normalizedText(user.team_id) ?? teamId,
            name: normalizedText(user.name),
            realName:
              normalizedText(user.real_name) ??
              normalizedText(profile.real_name),
            displayName: normalizedText(profile.display_name),
            displayNameNormalized: normalizedText(
              profile.display_name_normalized,
            ),
            title: normalizedText(profile.title),
            email: normalizedText(profile.email),
            tz: normalizedText(user.tz),
            updated: typeof user.updated === 'number' ? user.updated : null,
            isAdmin: Boolean(user.is_admin),
            isAppUser: Boolean(user.is_app_user),
            isBot: Boolean(user.is_bot),
            isDeleted: Boolean(user.deleted),
            isOwner: Boolean(user.is_owner),
            isPrimaryOwner: Boolean(user.is_primary_owner),
            isRestricted: Boolean(user.is_restricted),
            isStranger: Boolean(user.is_stranger),
            isUltraRestricted: Boolean(user.is_ultra_restricted),
          };
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

      return {
        mode: 'list-users' as const,
        users: users.slice(0, maxItems),
        listUrl: location.href,
        pageTitle: document.title,
        source: selectedUserState.source,
        stateKey,
        totalUserCount: users.length,
      };
    } finally {
      db.close();
    }
  }, limit);

  return payload;
}
