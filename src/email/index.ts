import { ResendEmailTransport } from './resend-transport.js';
import { ConsoleEmailTransport } from './console-transport.js';
import type { EmailTransport } from './transport.js';

export interface CreateEmailTransportOptions {
  driver: 'console' | 'resend';
  defaultFrom: string;
  resendApiKey?: string | undefined;
}

export function createEmailTransport(
  opts: CreateEmailTransportOptions,
): EmailTransport {
  switch (opts.driver) {
    case 'console':
      return new ConsoleEmailTransport();
    case 'resend': {
      if (!opts.resendApiKey) {
        throw new Error(
          'EMAIL_TRANSPORT=resend requires RESEND_API_KEY to be set',
        );
      }
      return new ResendEmailTransport({
        apiKey: opts.resendApiKey,
        defaultFrom: opts.defaultFrom,
      });
    }
  }
}

export { ConsoleEmailTransport } from './console-transport.js';
export { ResendEmailTransport } from './resend-transport.js';
export type { EmailTransport, EmailMessage, EmailSendResult } from './transport.js';