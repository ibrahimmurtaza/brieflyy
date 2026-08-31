export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly from?: string;
}

export interface EmailSendResult {
  readonly id: string;
  readonly provider: string;
}

export interface EmailTransport {
  readonly providerName: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}