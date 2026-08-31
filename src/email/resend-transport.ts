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
    } = {
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    };
    if (message.html !== undefined) {
      params.html = message.html;
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