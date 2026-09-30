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

export interface EmailTransport {
  readonly providerName: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}