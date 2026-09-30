import { Resend } from 'resend';

import type {
  EmailMessage,
  EmailSendResult,
  EmailTransport,
} from './transport.js';

export interface ResendTransportOptions {
  apiKey: string;
  defaultFrom: string;
}

export class ResendEmailTransport implements EmailTransport {
  readonly providerName = 'resend';
  private readonly client: Resend;
  private readonly defaultFrom: string;

  constructor({ apiKey, defaultFrom }: ResendTransportOptions) {
    this.client = new Resend(apiKey);
    this.defaultFrom = defaultFrom;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const from = message.from ?? this.defaultFrom;
    const params: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
      headers?: Record<string, string>;
    } = {
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    };
    if (message.html !== undefined) {
      params.html = message.html;
    }
    // Carried rather than dropped: `List-Unsubscribe` is the only way a client
    // learns it may render a one-click unsubscribe control, so a transport that
    // silently dropped it would leave a brief that looks unsubscribeable and is
    // not.
    if (message.headers !== undefined) {
      params.headers = { ...message.headers };
    }
    const result = await this.client.emails.send(params);
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message}`);
    }
    if (!result.data) {
      throw new Error('Resend send returned no data and no error');
    }
    return { id: result.data.id, provider: this.providerName };
  }
}