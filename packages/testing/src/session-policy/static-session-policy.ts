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
  readonly agentContext?:
    | Readonly<Record<string, string>>
    | ((event: IncomingEvent) => Readonly<Record<string, string>>);
}

export class StaticSessionPolicy implements SessionPolicy {
  readonly channelKind: ChannelKind;
  private readonly idleTimeout: number;
  private readonly endKinds: ReadonlySet<string>;
  private readonly resolver: (event: IncomingEvent) => ChannelNativeRef;
  private readonly contextFn?: (event: IncomingEvent) => Readonly<Record<string, string>>;

  constructor(options: StaticSessionPolicyOptions) {
    this.channelKind = options.channelKind;
    this.idleTimeout = options.idleTimeoutMinutes ?? 30;
    this.endKinds = new Set(options.endOnKinds ?? ['channel_close']);
    this.resolver = options.resolveNativeRef ?? ((e) => e.channelNativeRef);
    if (options.agentContext !== undefined) {
      const ctx = options.agentContext;
      this.contextFn = typeof ctx === 'function' ? ctx : () => ctx;
    }
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

  toAgentContext(event: IncomingEvent): Readonly<Record<string, string>> {
    return this.contextFn ? this.contextFn(event) : {};
  }
}
