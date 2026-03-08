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
  limit: number | null;
  listChannels: boolean;
  listUsers: boolean;
  output?: string;
  profile: string;
  query: string;
  session: string;
  workspaceUrl: string;
}

export interface SearchCodeInput {
  limit: number;
  query: string;
  workspaceUrl: string;
}

export interface ListChannelsCodeInput {
  limit: number;
  workspaceUrl: string;
}

export interface ListUsersCodeInput {
  limit: number;
  workspaceUrl: string;
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
  listUrl: string;
  pageTitle: string;
  source: 'reduxPersistence.channels';
  stateKey: string | null;
  totalChannelCount: number;
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

export interface UserListPayload {
  mode: 'list-users';
  users: UserInfo[];
  listUrl: string;
  pageTitle: string;
  source: 'reduxPersistence.members' | 'reduxPersistence.users';
  stateKey: string | null;
  totalUserCount: number;
}

export interface OutputMetadata {
  generatedAt: string;
  profile: string;
  session: string;
  workspaceUrl: string;
}

export type PayloadBody = SearchPayload | ChannelListPayload | UserListPayload;

export type OutputPayload =
  | (SearchPayload & OutputMetadata & { query: string })
  | (ChannelListPayload & OutputMetadata & { query: null })
  | (UserListPayload & OutputMetadata & { query: null });
