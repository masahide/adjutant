import type {
  ChannelListPayload,
  ListChannelsCodeInput,
} from '../contracts.ts';

type BrowserPage = any;

export async function runListChannelsInBrowser(
  page: BrowserPage,
  input: ListChannelsCodeInput,
): Promise<ChannelListPayload> {
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

    const classifyChannel = (channel: any) => {
      if (channel?.is_im) return 'dm';
      if (channel?.is_mpim) return 'mpim';
      if (channel?.is_group || channel?.is_private) return 'private_channel';
      if (channel?.is_channel) return 'public_channel';
      return 'unknown';
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
      const channelsState =
        state?.channels && typeof state.channels === 'object'
          ? state.channels
          : {};
      const channels = Object.values(channelsState)
        .filter(
          (channel: any) =>
            channel &&
            typeof channel === 'object' &&
            (channel.is_channel || channel.is_group),
        )
        .sort((left: any, right: any) => {
          const leftName = (left.name_normalized || left.name || '').toString();
          const rightName = (
            right.name_normalized ||
            right.name ||
            ''
          ).toString();
          return leftName.localeCompare(rightName);
        });

      return {
        mode: 'list-channels' as const,
        channels: channels.slice(0, maxItems).map((channel: any) => ({
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
            typeof channel.topic?.value === 'string'
              ? channel.topic.value
              : null,
        })),
        listUrl: location.href,
        pageTitle: document.title,
        source: 'reduxPersistence.channels' as const,
        stateKey,
        totalChannelCount: channels.length,
      };
    } finally {
      db.close();
    }
  }, limit);

  return payload;
}
