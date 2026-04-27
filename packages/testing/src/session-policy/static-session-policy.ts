import type {
  ChannelKind,
  ChannelNativeRef,
  IncomingEvent,
  SessionLifecycleEvent,
  SessionPolicy,
} from '@agentry/core';

export interface StaticSessionPolicyOptions {
  readonly channelKind: ChannelKind;
  readonly idleTimeoutMinutes?: number;
  readonly endOnKinds?: readonly string[];
  readonly resolveNativeRef?: (event: IncomingEvent) => ChannelNativeRef;
}

export class StaticSessionPolicy implements SessionPolicy {
  readonly channelKind: ChannelKind;
  private readonly idleTimeout: number;
  private readonly endKinds: ReadonlySet<string>;
  private readonly resolver: (event: IncomingEvent) => ChannelNativeRef;

  constructor(options: StaticSessionPolicyOptions) {
    this.channelKind = options.channelKind;
    this.idleTimeout = options.idleTimeoutMinutes ?? 30;
    this.endKinds = new Set(options.endOnKinds ?? ['channel_close']);
    this.resolver = options.resolveNativeRef ?? ((e) => e.channelNativeRef);
  }

  computeNativeRef(event: IncomingEvent): ChannelNativeRef {
    return this.resolver(event);
  }

  idleTimeoutMinutes(): number {
    return this.idleTimeout;
  }

  shouldEndOn(event: SessionLifecycleEvent): boolean {
    return this.endKinds.has(event.kind);
  }
}
