export const RUNTIME_VERSION = '0.0.0' as const;

export type {
  BuildChannelsDeps,
  BuildChannelsResult,
  ComposeArgs,
  RuntimeHandles,
} from './compose.js';
export { compose } from './compose.js';
export * from './config/index.js';
