import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isChannelLikeEntry,
  mergeChannelLists,
  normalizeChannelList,
} from '../scripts/slack-search/browser/list-channels.ts';
import { mergeUserStates } from '../scripts/slack-search/browser/list-users.ts';

test('normalizeChannelList は DM と MPIM を含めて整形する', () => {
  const channels = normalizeChannelList(
    {
      C123: { id: 'C123', name: 'general', is_channel: true },
      G123: { id: 'G123', name: 'private-room', is_group: true },
      D123: { id: 'D123', is_im: true },
      M123: { id: 'M123', is_mpim: true },
      X123: { id: 'X123' },
    },
    Number.MAX_SAFE_INTEGER,
  );

  assert.equal(isChannelLikeEntry({ is_im: true }), true);
  assert.equal(isChannelLikeEntry({ id: 'X123' }), false);
  assert.deepEqual(
    channels.map((channel) => [channel.id, channel.type]),
    [
      ['D123', 'dm'],
      ['C123', 'public_channel'],
      ['M123', 'mpim'],
      ['G123', 'private_channel'],
    ],
  );
});

test('mergeChannelLists は Directories の UI 結果を cache と併合する', () => {
  const merged = mergeChannelLists(
    [
      {
        isMember: true,
        isPrivate: false,
        key: 'general',
        memberCount: 100,
        name: 'general',
        nameNormalized: 'general',
        purpose: 'workspace default',
        type: 'public_channel',
      },
      {
        isMember: false,
        isPrivate: false,
        key: 'new-channel',
        memberCount: 3,
        name: 'new-channel',
        nameNormalized: 'new-channel',
        purpose: 'from ui only',
        type: 'public_channel',
      },
    ],
    {
      mode: 'list-channels',
      channels: [
        {
          id: 'C123',
          name: 'general',
          nameNormalized: 'general',
          type: 'public_channel',
          isArchived: false,
          isExtShared: false,
          isGeneral: true,
          isMember: false,
          isOrgShared: false,
          isPrivate: false,
          isReadOnly: false,
          isThreadOnly: false,
          created: null,
          updated: null,
          previousNames: [],
          purpose: null,
          topic: null,
        },
      ],
      listUrl: 'https://example.slack.com/client/T123',
      pageTitle: 'Slack',
      source: 'reduxPersistence.channels',
      stateKey: 'persist:slack-client-T123-1',
      totalChannelCount: 1,
    },
  );

  assert.equal(
    merged.source,
    'reduxPersistence.channels+ui.directories.channels',
  );
  assert.equal(merged.totalChannelCount, 2);
  assert.equal(merged.channels.length, 2);
  assert.deepEqual(
    merged.channels.map((channel) => [
      channel.name,
      channel.isMember,
      channel.purpose,
    ]),
    [
      ['general', true, 'workspace default'],
      ['new-channel', false, 'from ui only'],
    ],
  );
});

test('mergeUserStates は members と users を併合して補完する', () => {
  const merged = mergeUserStates(
    {
      U123: {
        id: 'U123',
        name: 'alice',
        profile: { display_name: 'Alice', title: 'SRE' },
      },
    },
    {
      U123: {
        id: 'U123',
        real_name: 'Alice Smith',
        profile: { email: 'alice@example.com' },
      },
      U999: {
        id: 'U999',
        name: 'bob',
      },
    },
    'T123',
  );

  assert.equal(merged.source, 'reduxPersistence.members+users');
  assert.equal(merged.users.length, 2);
  assert.deepEqual(merged.users[0], {
    id: 'U123',
    teamId: 'T123',
    name: 'alice',
    realName: 'Alice Smith',
    displayName: 'Alice',
    displayNameNormalized: null,
    title: 'SRE',
    email: 'alice@example.com',
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
  });
  assert.equal(merged.users[1]?.id, 'U999');
});
