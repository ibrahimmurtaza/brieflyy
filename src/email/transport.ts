export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly from?: string;
  /**
   * Message headers, for the things a body cannot carry.
   *
   * Here for one reason: RFC 8058. A mail client that supports one-click
   * unsubscribe never shows the reader a link — it renders a button and POSTs
   * itself — and the URL it POSTs to has to come from `List-Unsubscribe`. With
   * nowhere to put a header, a brief could carry a working unsubscribe link in
   * its body and still be un-unsubscribable in every client that offers the
   * feature, which is the whole point of the feature.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EmailSendResult {
  readonly id: string;
  readonly provider: string;
}

/**
 * The provider was asked, and answered no.
 *
 * Its own type because "no" and "we never found out" are different facts with
 * opposite consequences, and a caller that cannot tell them apart has to treat
 * both the same way. This one means Brieflyy watched a message be declined, so
 * nothing reached the User; a thrown network error, a timeout, a 5xx means the
 * message may be in an inbox and must not be treated as though it never left.
 *
 * A transport raises it only where the provider itself said no — a validation
 * error, an unrouteable address, a suppression — never for an exception.
 */
export class EmailRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailRefusedError';
  }
}

export interface EmailTransport {
  readonly providerName: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}