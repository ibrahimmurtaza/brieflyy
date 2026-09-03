import { partsInTz } from '../domain/timezone.js';

export interface WelcomeEmailInput {
  readonly firstBriefAt: Date;
  readonly timezone: string;
  readonly hour: number;
  readonly minute: number;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function renderWelcomeEmail(input: WelcomeEmailInput): {
  subject: string;
  text: string;
} {
  const parts = partsInTz(input.firstBriefAt, input.timezone);
  const when = `${parts.weekday}, ${parts.day} ${MONTH_NAMES[parts.month - 1] ?? ''} ${parts.year} at ${pad2(input.hour)}:${pad2(input.minute)} (${input.timezone})`;
  const subject = 'Welcome to Brieflyy';
  const text = [
    'Welcome to Brieflyy.',
    '',
    `Your first brief will arrive ${when}.`,
    'You can change the delivery time any time from your account settings.',
    '',
    "If you didn't sign up for Brieflyy, you can ignore this email.",
  ].join('\n');
  return { subject, text };
}
