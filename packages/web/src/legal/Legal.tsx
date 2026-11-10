import { type ReactNode, useEffect } from 'react';
import { Logo } from '../ui-kit/Logo';
import './legal.css';

/**
 * The Terms of Service and Privacy Policy at flowweb.app/terms and /privacy (FW-C-090). They open for
 * anyone, signed in or not, because Google's sign-in screen and new members both link here.
 */
export type LegalRoute = 'terms' | 'privacy';

/** Which page an address shows: /terms or /privacy (a trailing slash is fine), otherwise null. */
export function legalRouteOf(path: string): LegalRoute | null {
  const p = path.replace(/\/+$/, '');
  if (p === '/terms') return 'terms';
  if (p === '/privacy') return 'privacy';
  return null;
}

const UPDATED = 'November 10, 2026';
const CONTACT = 'hello@frequencylocal.com';
const Mail = () => <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;

/** A section is plain paragraphs, a plain list, or JSX where it needs links or bold. */
type Section = { h: string; p?: string[]; ul?: string[]; body?: ReactNode };

const TERMS: Section[] = [
  {
    h: 'Who we are',
    p: [
      'FlowWeb is run by Frequency Labs Holdings ("we" or "us"). These terms cover flowweb.app and the FlowWeb app on your own computer. By creating an account or signing in, you agree to them. If you don\'t agree, please don\'t use FlowWeb.',
    ],
  },
  {
    h: 'Your account',
    p: [
      'You can sign in with email and password, an emailed link, or Google. Keep your sign-in safe and tell us if you think someone else has used it. You need to be at least 16 to use FlowWeb.',
      'Each business on FlowWeb has an owner, who decides who joins and what role they get (Owner, Admin, Helper or Viewer). If you invite people, you are responsible for what they do in your business account.',
    ],
  },
  {
    h: 'FlowWeb writes drafts. You send them.',
    p: [
      'Flows find leads and write draft messages for you to review. FlowWeb does not send email or messages on its own. When you send a draft, you send it from your own inbox, under your own name, and it is your message.',
      'That means you are responsible for what you send: that it is honest, that you are allowed to contact the person, that it gives them an easy way to opt out, and that it follows the law where you and they are (for example CAN-SPAM in the US) and the rules of the email service you use.',
    ],
  },
  {
    h: 'Using FlowWeb fairly',
    ul: [
      'No spam, harassment, scams or anything illegal.',
      "Don't try to get into accounts or data that aren't yours, or break or overload the service.",
      'Respect the terms of the sites a flow reads and of the AI providers you connect.',
      "Don't use FlowWeb to collect sensitive personal information about people.",
    ],
  },
  {
    h: 'AI and your own computer',
    p: [
      "FlowWeb's AI work runs on your own computer, using AI accounts you connect there. You pay for those accounts and follow their terms. AI can be wrong, so read every draft before you send it. You decide what goes out.",
    ],
  },
  {
    h: 'Your content',
    body: (
      <p>
        What you put into FlowWeb, and the drafts it writes for you, belong to you. You give us permission to
        store and process it only so we can run FlowWeb for you. How we handle data is in the{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
    ),
  },
  {
    h: 'No guarantees',
    p: [
      "FlowWeb is new and provided as is. We work to keep it running and correct, but we can't promise it will always be available, error free, or bring in any particular result. To the extent the law allows, we are not liable for indirect or lost-profit losses, and our total liability is limited to what you paid us in the 12 months before the claim (or $50 if you paid nothing).",
    ],
  },
  {
    h: 'Stopping',
    p: [
      'You can stop using FlowWeb at any time and ask us to delete your account. We may suspend or close an account that breaks these terms or puts others at risk, and we will tell you why when we can.',
    ],
  },
  {
    h: 'Changes and the law',
    p: [
      'We may update these terms as FlowWeb grows. When we make a big change we will say so on the site or by email before it applies. These terms are governed by the laws of the State of California.',
    ],
  },
  {
    h: 'Questions',
    body: (
      <p>
        Write to <Mail />.
      </p>
    ),
  },
];

const PRIVACY: Section[] = [
  {
    h: 'The short version',
    ul: [
      'We keep what we need to sign you in and run your flows, and nothing more.',
      "Each business's flows, leads and drafts stay in that business account, seen only by its members.",
      'FlowWeb writes drafts. It never sends email or messages for you.',
      "We don't sell your data and we don't show ads.",
      'Ask us any time and we will delete your data.',
    ],
  },
  {
    h: 'What we collect',
    body: (
      <ul>
        <li>
          <strong>Your account:</strong> your email address, your name if you give it, and your password,
          which is stored scrambled (hashed) so nobody can read it, us included.
        </li>
        <li>
          <strong>Your business account:</strong> its name, its members and their roles, the flows you set up,
          their settings and schedules, the leads they find, the drafts they write, and a log of each step.
        </li>
        <li>
          <strong>Leads:</strong> flows look for businesses and event organizers on public web pages and keep
          the public contact details they find there (such as a name, a business email and the page it came
          from).
        </li>
        <li>
          <strong>Basic technical data:</strong> the sign-in session your browser keeps, and standard server
          logs (such as time and errors) that our hosting keeps for security.
        </li>
      </ul>
    ),
  },
  {
    h: 'Signing in with Google',
    body: (
      <>
        <p>
          If you choose Continue with Google, Google shares your name, email address and profile picture with
          FlowWeb. We use your name and email to create and show your account, and nothing else. We don't ask
          for and can't see your Gmail, Drive, Calendar or contacts.
        </p>
        <p>
          FlowWeb's use of information received from Google APIs adheres to the{' '}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We don't sell it, use it for ads, or share it except to
          run FlowWeb.
        </p>
      </>
    ),
  },
  {
    h: 'Where your data lives',
    body: (
      <ul>
        <li>
          <strong>Sign-in</strong> runs on Supabase. FlowWeb shares its sign-in system with another Frequency
          product, so the same email may already have a login there.
        </li>
        <li>
          <strong>Business data</strong> is stored per business account in our Supabase database. Access rules
          in the database let only that business's members read it, and only as far as their role allows.
        </li>
        <li>
          <strong>The site</strong> is served by Vercel.
        </li>
        <li>
          <strong>AI work</strong> runs on the business owner's own computer, using AI accounts they connect
          there (such as Anthropic or OpenAI). Text a flow sends for drafting goes to that provider under its
          terms. Our servers never hold those AI keys.
        </li>
        <li>
          <strong>Frequency:</strong> if a business connects its Frequency account, leads it chooses are
          copied to its Frequency CRM.
        </li>
      </ul>
    ),
  },
  {
    h: 'Drafts only',
    p: [
      'FlowWeb never sends email or messages on its own. It writes drafts that you review, edit and send yourself from your own inbox.',
    ],
  },
  {
    h: 'Who we share with',
    p: [
      'Only the services above that run FlowWeb for us, and only what each needs. We may also share data if the law requires it. We never sell personal information or use it for advertising.',
    ],
  },
  {
    h: 'Cookies',
    p: [
      "Your browser keeps your sign-in session and a few settings (like light or dark mode) so the site works. We don't use advertising or cross-site tracking cookies.",
    ],
  },
  {
    h: 'Keeping and deleting data',
    body: (
      <>
        <p>
          We keep your data while your account or business account is open. Email <Mail /> to see, fix, export
          or delete your data, or to close your account, and we will do it within 30 days. When an owner
          deletes a business account, its flows, leads and drafts are deleted with it. Backups clear on their
          own schedule after that.
        </p>
        <p>
          If a FlowWeb flow found your public contact details and you would like them removed, write to us and
          we will delete them and keep them out of future searches.
        </p>
      </>
    ),
  },
  {
    h: 'Children',
    p: ["FlowWeb is not for anyone under 16, and we don't knowingly collect their data."],
  },
  {
    h: 'Changes',
    p: [
      'If we change how we handle data, we will update this page and its date, and tell you before a big change applies.',
    ],
  },
  {
    h: 'Contact',
    body: (
      <p>
        Frequency Labs Holdings runs FlowWeb. Questions or requests: <Mail />.
      </p>
    ),
  },
];

const PAGES: Record<LegalRoute, { title: string; lede: string; sections: Section[] }> = {
  terms: {
    title: 'Terms of Service',
    lede: 'The rules for using FlowWeb, in plain words.',
    sections: TERMS,
  },
  privacy: {
    title: 'Privacy Policy',
    lede: 'What FlowWeb keeps, why, and how to get it deleted.',
    sections: PRIVACY,
  },
};

export function LegalPage({ page }: { page: LegalRoute }) {
  const { title, lede, sections } = PAGES[page];
  const other =
    page === 'terms'
      ? { href: '/privacy', label: 'Privacy Policy' }
      : { href: '/terms', label: 'Terms of Service' };

  useEffect(() => {
    document.title = `${title} · FlowWeb`;
  }, [title]);

  return (
    <div className="legal">
      <header className="legal-top">
        <a href="/" aria-label="FlowWeb home">
          <Logo size={28} />
        </a>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="legal-lede">{lede}</p>
        <p className="legal-date">Last updated {UPDATED}</p>
        {sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p?.map((t) => (
              <p key={t}>{t}</p>
            ))}
            {s.ul && (
              <ul>
                {s.ul.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            {s.body}
          </section>
        ))}
      </main>
      <footer className="legal-foot">
        <a href="/">Back to FlowWeb</a>
        <a href={other.href}>{other.label}</a>
      </footer>
    </div>
  );
}
