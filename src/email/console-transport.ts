import type {
  EmailMessage,
  EmailSendResult,
  EmailTransport,
} from './transport.js';

export interface ConsoleEmailTransportOptions {
  logger?: (line: string) => void;
}

export class ConsoleEmailTransport implements EmailTransport {
  readonly providerName = 'console';
  private readonly outbox: EmailMessage[] = [];
  private readonly logger: (line: string) => void;

  constructor(opts: ConsoleEmailTransportOptions = {}) {
    this.logger = opts.logger ?? ((line) => console.log(line));
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.outbox.push(message);
    this.logger(
      `[email:console] to=${message.to} subject=${JSON.stringify(message.subject)}`,
    );
    this.logger(message.text);
    return {
      id: `console-${this.outbox.length}`,
      provider: this.providerName,
    };
  }

  /** Test helper: inspect what was sent. */
  snapshot(): readonly EmailMessage[] {
    return [...this.outbox];
  }
}