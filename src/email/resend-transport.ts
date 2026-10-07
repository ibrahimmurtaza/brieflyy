import { Resend } from 'resend';

import {
  EmailRefusedError,
  type EmailMessage,
  type EmailSendResult,
  type EmailTransport,
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
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.client.emails.send(params);
    } catch (err) {
      // Deliberately not an EmailRefusedError. A thrown call never reached an
      // answer, so the message may already be on its way — and the caller has to
      // treat that differently from a provider that said no. Only the branch
      // below has actually been refused.
      throw err;
    }
    if (result.error) {
      // The provider answered, and the answer was no: this is the one case where
      // Brieflyy knows the message is not going to arrive.
      throw new EmailRefusedError(`Resend send failed: ${result.error.message}`);
    }
    if (!result.data) {
      // Neither an answer nor a refusal. As unknown as a timeout, and treated as
      // such.
      throw new Error('Resend send returned no data and no error');
    }
    return { id: result.data.id, provider: this.providerName };
  }
}