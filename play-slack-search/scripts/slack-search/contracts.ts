export const DEFAULT_SEARCH_LIMIT = 50;
export const DEFAULT_SESSION = 'auto';
export const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

export type SessionStatus = 'open' | 'closed' | 'unknown';

export interface SessionInfo {
  name: string;
  rawUserDataDir: string | null;
  status: SessionStatus;
}

export interface Options {
  close: boolean;
  hydrate: boolean;
  login: boolean;
  limit: number | null;
  listChannels: boolean;
  listUsers: boolean;
  output?: string;
  profile: string;
  query: string;
  resolveChannelIds: string[];
  session: string;
  workspaceUrl: string;
}

export interface SearchCodeInput {
  limit: number;
  query: string;
  workspaceUrl: string;
}

export interface ListChannelsCodeInput {
  hydrate?: boolean;
  limit: number;
  workspaceUrl: string;
}

export interface ListUsersCodeInput {
  hydrate?: boolean;
  limit: number;
  workspaceUrl: string;
}

export interface ResolveChannelCodeInput {
  channelIds: string[];
  workspaceUrl: string;
}

export interface HydrateCodeInput {
  target: 'channels' | 'users';
  workspaceUrl: string;
}

export interface HydratePayload {
  mode: 'hydrate';
  finalUrl: string;
  openedView: boolean;
  pageTitle: string;
  scrollPasses: number;
  target: 'channels' | 'users';
}

export interface ExtractedResult {
  index: number;
  sender: string | null;
  location: string | null;
  channelName: string | null;
  timestampLabel: string | null;
  slackTs: string | null;
  messageUrl: string | null;
  text: string | null;
  links: string[];
}

export interface SearchPayload {
  mode: 'search';
  noResults: boolean;
  pageTitle: string;
  resultCountText: string | null;
  results: ExtractedResult[];
  searchUrl: string;
  sortLabel: string;
}

export interface ResolvedChannelInfo {
  channelId: string;
  channelName: string | null;
  resolved: boolean;
  source: 'reduxPersistence.channels' | 'search.suggestion' | 'unresolved';
  stateKey: string | null;
}

export interface ResolveChannelsPayload {
  channels: ResolvedChannelInfo[];
  listUrl: string;
  mode: 'resolve-channels';
  pageTitle: string;
}

export interface LoginPayload {
  completed: true;
  instructions: string;
  mode: 'login';
}

export type ChannelType =
  | 'public_channel'
  | 'private_channel'
  | 'dm'
  | 'mpim'
  | 'unknown';

export interface ChannelInfo {
  id: string | null;
  name: string | null;
  nameNormalized: string | null;
  type: ChannelType;
  isArchived: boolean;
  isExtShared: boolean;
  isGeneral: boolean;
  isMember: boolean;
  isOrgShared: boolean;
  isPrivate: boolean;
  isReadOnly: boolean;
  isThreadOnly: boolean;
  created: number | null;
  updated: number | null;
  previousNames: string[];
  purpose: string | null;
  topic: string | null;
}

export interface ChannelListPayload {
  mode: 'list-channels';
  channels: ChannelInfo[];
  hydrateDebug?: ChannelListHydrateDebug;
  listUrl: string;
  pageTitle: string;
  source:
    | 'reduxPersistence.channels'
    | 'ui.directories.channels'
    | 'reduxPersistence.channels+ui.directories.channels';
  stateKey: string | null;
  totalChannelCount: number;
}

export interface ChannelListHydratePageDebug {
  currentPage: number | null;
  nextPageAvailable: boolean;
  rowsSeen: number;
  sampleNames: string[];
  uniqueAfterPage: number;
}

export interface ChannelListHydrateDebug {
  error: string | null;
  finalSortLabel: string | null;
  firstObservedPage: number | null;
  openedDirectory: boolean;
  pageVisits: ChannelListHydratePageDebug[];
  resetToFirstPage: boolean;
  sortSetToNewest: boolean;
  stopReason: string | null;
  uiChannelCount: number;
}

export interface UserInfo {
  id: string | null;
  teamId: string | null;
  name: string | null;
  realName: string | null;
  displayName: string | null;
  displayNameNormalized: string | null;
  title: string | null;
  email: string | null;
  tz: string | null;
  updated: number | null;
  isAdmin: boolean;
  isAppUser: boolean;
  isBot: boolean;
  isDeleted: boolean;
  isOwner: boolean;
  isPrimaryOwner: boolean;
  isRestricted: boolean;
  isStranger: boolean;
  isUltraRestricted: boolean;
}

export interface UserListHydrateDebug {
  clickedMemberButton: boolean;
  error: string | null;
  finalUiUserCount: number;
  firstPassDeclaredCount: number | null;
  firstPassUiUserCount: number;
  memberPanelOpened: boolean;
  openAttempts: number;
  secondPassDeclaredCount: number | null;
  secondPassRan: boolean;
  secondPassUiUserCount: number | null;
}

export interface UserListPayload {
  mode: 'list-users';
  users: UserInfo[];
  hydrateDebug?: UserListHydrateDebug;
  listUrl: string;
  pageTitle: string;
  source:
    | 'reduxPersistence.members'
    | 'reduxPersistence.users'
    | 'reduxPersistence.members+users'
    | 'ui.member-panel'
    | 'reduxPersistence.members+ui.member-panel'
    | 'reduxPersistence.users+ui.member-panel'
    | 'reduxPersistence.members+users+ui.member-panel';
  stateKey: string | null;
  totalUserCount: number;
}

export interface OutputMetadata {
  debug?: {
    sessionMessages: string[];
  };
  generatedAt: string;
  profile: string;
  session: string;
  workspaceUrl: string;
}

export type PayloadBody =
  | LoginPayload
  | SearchPayload
  | ChannelListPayload
  | UserListPayload
  | ResolveChannelsPayload;

export type OutputPayload =
  | (LoginPayload & OutputMetadata & { query: null })
  | (SearchPayload & OutputMetadata & { query: string })
  | (ChannelListPayload & OutputMetadata & { query: null })
  | (UserListPayload & OutputMetadata & { query: null })
  | (ResolveChannelsPayload & OutputMetadata & { query: null });
