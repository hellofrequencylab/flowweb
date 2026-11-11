import { type FormEvent, type ReactNode, useId, useState } from 'react';
import {
  authMethods,
  sendLink,
  sendPasswordReset,
  setPassword,
  signInWithGoogle,
  signInWithPassword,
  signUp,
} from '../hosted/auth';
import { Icon, type IconName } from '../ui-kit/Icon';
import { Logo } from '../ui-kit/Logo';
import './home.css';

/**
 * The public face of flowweb.app for a signed-out visitor (FW-C-081), in the Signal look: a short
 * scroll story (hero, one flow moving, what the motion means, three steps, your people) around the
 * account card. The auth calls live in hosted/auth.ts; this page only asks. Every animation here
 * stops under reduced motion and calm mode (base.css), and the page reads the same when still.
 */
export function HomePage({
  notice,
  recovery = false,
  invite = false,
  onSignedIn,
}: {
  notice?: string | null;
  recovery?: boolean;
  /** The visitor arrived on an invite link; it is kept until they sign in (FW-C-082). */
  invite?: boolean;
  onSignedIn?: () => void;
}) {
  return (
    <div className="home">
      <Streams />
      <header className="home-top">
        <Logo size={30} />
        <nav className="home-nav" aria-label="On this page">
          <a href="#home-how">How it works</a>
          <a href="#home-people">Your people</a>
        </nav>
        <a className="btn btn-primary" href="#account">
          Get started
        </a>
      </header>

      <main className="home-hero">
        <div className="home-pitch">
          <p className="overline home-eyebrow">
            <span className="home-live" aria-hidden="true" /> Drafts only. You sign off.
          </p>
          <h1>
            Busywork, <span className="script">flowing.</span>
          </h1>
          <p className="home-lede">
            FlowWeb finds the leads and writes the first drafts. Nothing goes out until you say so.
          </p>
          {invite && (
            <p className="callout home-invite">
              You were invited to join a FlowWeb account. Sign in or create an account to accept.
            </p>
          )}
        </div>
        <AccountCard notice={notice} recovery={recovery} onSignedIn={onSignedIn} />
      </main>

      <Lane />

      <section className="home-band" aria-labelledby="home-motion">
        <p className="overline">Read it at a glance</p>
        <h2 id="home-motion">Motion means something.</h2>
        <ul className="home-states">
          <State kind="run" name="Running" text="Energy moves while a flow works." />
          <State kind="wait" name="Waiting on you" text="Gold is the only colour that asks." />
          <State kind="stop" name="Stopped" text="One switch halts everything." />
        </ul>
      </section>

      <section className="home-band" aria-labelledby="home-how">
        <p className="overline">How it works</p>
        <h2 id="home-how">Three steps. One of them is yours.</h2>
        <ol className="home-steps">
          <Step n="01" title="Pick a flow">
            Lead hunts, follow-ups, a morning digest.
          </Step>
          <Step n="02" title="It does the legwork">
            AI on your own Mac. Your keys never leave it.
          </Step>
          <Step n="03" title="You sign off" mine>
            Edit, rewrite or reject. You send from your inbox.
          </Step>
        </ol>
      </section>

      <section className="home-band" aria-labelledby="home-people">
        <p className="overline">Bring your people</p>
        <h2 id="home-people">Help, or just watch.</h2>
        <ul className="home-roles">
          <Role icon="verified" name="Owner" text="Decides who is in" />
          <Role icon="settings" name="Admin" text="Sets up flows" />
          <Role icon="pencil" name="Helper" text="Edits drafts" />
          <Role icon="console" name="Viewer" text="Follows along" />
        </ul>
      </section>

      <section className="home-end" aria-labelledby="home-end">
        <h2 id="home-end">
          Let it <span className="script">flow.</span>
        </h2>
        <a className="btn btn-primary btn-big" href="#account">
          Get started
        </a>
      </section>

      <footer className="home-foot">
        <Logo size={22} />
        <p>Drafts only. FlowWeb never sends on its own.</p>
        <nav className="home-foot-links" aria-label="Legal">
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
        </nav>
      </footer>
    </div>
  );
}

/** Energy streams behind the hero: thin lines with a bright pulse running along each. Decoration only. */
function Streams() {
  const paths = [
    'M-40 120 C 240 60, 420 220, 720 140 S 1180 40, 1480 120',
    'M-40 200 C 260 150, 460 300, 760 220 S 1200 120, 1480 210',
    'M-40 290 C 300 250, 500 360, 800 300 S 1220 210, 1480 300',
  ];
  return (
    <svg className="home-streams" viewBox="0 0 1440 420" preserveAspectRatio="none" aria-hidden="true">
      {paths.map((d, i) => (
        <g key={d} className={`home-stream s${i + 1}`}>
          <path d={d} className="home-stream-line" />
          <path d={d} className="home-stream-pulse" pathLength={100} />
        </g>
      ))}
    </svg>
  );
}

/** One example flow on a track. A spark runs Find to Draft, holds gold at you, then runs on to Send. */
function Lane() {
  const stops: { label: string; mine?: boolean }[] = [
    { label: 'Find' },
    { label: 'Draft' },
    { label: 'You', mine: true },
    { label: 'Send' },
  ];
  return (
    <figure className="home-lane" aria-label="An example flow: find, draft, you sign off, then send.">
      <figcaption className="overline">Example flow</figcaption>
      <div className="home-track">
        <span className="home-track-fill" aria-hidden="true" />
        <span className="home-spark" aria-hidden="true" />
        {stops.map((s) => (
          <span key={s.label} className={`home-stop${s.mine ? ' is-mine' : ''}`}>
            <span className="home-stop-dot" aria-hidden="true" />
            <span className="home-stop-label">{s.label}</span>
          </span>
        ))}
      </div>
    </figure>
  );
}

function State({ kind, name, text }: { kind: 'run' | 'wait' | 'stop'; name: string; text: string }) {
  return (
    <li className={`home-state is-${kind}`}>
      <span className="home-state-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <strong>{name}</strong>
      <span>{text}</span>
    </li>
  );
}

function Step({
  n,
  title,
  mine,
  children,
}: {
  n: string;
  title: string;
  mine?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`home-step${mine ? ' is-mine' : ''}`}>
      <span className="home-step-n" aria-hidden="true">
        {n}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Role({ icon, name, text }: { icon: IconName; name: string; text: string }) {
  return (
    <li className="home-role">
      <Icon name={icon} size={18} />
      <strong>{name}</strong>
      <span>{text}</span>
    </li>
  );
}

type Mode = 'signin' | 'signup' | 'forgot' | 'recovery';
type Sent = { what: 'link' | 'confirm' | 'reset'; to: string } | { what: 'saved' };

const SENT_TEXT = {
  link: 'We sent a sign-in link to',
  confirm: 'Confirm your new account with the link we sent to',
  reset: 'We sent a link to choose a new password to',
} as const;

function AccountCard({
  notice,
  recovery,
  onSignedIn,
}: {
  notice?: string | null;
  recovery: boolean;
  onSignedIn?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(recovery ? 'recovery' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const id = useId();

  const go = (next: Mode) => {
    setMode(next);
    setError(null);
    setPw('');
  };

  /** Runs one auth call, showing its own sentence if it fails. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try that again.');
    } finally {
      setBusy(false);
    }
  };
  const needEmail = () => {
    if (email.trim()) return true;
    setError('Type your email first.');
    return false;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (mode === 'signin')
      void run(async () => {
        await signInWithPassword(to, password);
        onSignedIn?.();
      });
    else if (mode === 'signup')
      void run(async () => {
        const { needsConfirm } = await signUp(to, password);
        if (needsConfirm) setSent({ what: 'confirm', to });
        else onSignedIn?.();
      });
    else if (mode === 'forgot')
      void run(async () => {
        await sendPasswordReset(to);
        setSent({ what: 'reset', to });
      });
    else
      void run(async () => {
        await setPassword(password);
        setSent({ what: 'saved' });
      });
  };

  const emailLink = () => {
    if (!needEmail()) return;
    const to = email.trim();
    void run(async () => {
      await sendLink(to);
      setSent({ what: 'link', to });
    });
  };

  const title =
    mode === 'recovery'
      ? 'Choose a new password'
      : mode === 'forgot'
        ? 'Reset your password'
        : mode === 'signup'
          ? 'Create your account'
          : 'Welcome back';

  return (
    <section className="home-card" id="account" aria-labelledby={`${id}-title`}>
      {(mode === 'signin' || mode === 'signup') && !sent && (
        <div className="home-tabs" role="tablist" aria-label="Account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className="home-tab"
            onClick={() => go('signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className="home-tab"
            onClick={() => go('signup')}
          >
            Create account
          </button>
        </div>
      )}
      <h2 id={`${id}-title`} className="home-card-title">
        {sent ? (sent.what === 'saved' ? 'Password saved' : 'Check your email') : title}
      </h2>
      {notice && !sent && <p className="callout callout-warn">{notice}</p>}

      {sent ? (
        <div className="home-sent" role="status">
          {sent.what === 'saved' ? (
            <>
              <p>Your new password is set and you are signed in.</p>
              <button type="button" className="btn btn-primary btn-big" onClick={() => onSignedIn?.()}>
                Open FlowWeb
              </button>
            </>
          ) : (
            <>
              <p>
                {SENT_TEXT[sent.what]} <strong>{sent.to}</strong>. It works once and expires after an hour.
              </p>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setSent(null);
                  go('signin');
                }}
              >
                Use a different email
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <form className="home-form" onSubmit={submit}>
            {mode !== 'recovery' && (
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  className="home-input"
                  type="email"
                  name="email"
                  autoComplete={mode === 'signup' ? 'email' : 'username'}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
            {mode !== 'forgot' && (
              <PasswordField
                value={password}
                onChange={setPw}
                fresh={mode !== 'signin'}
                label={mode === 'signin' ? 'Password' : 'New password'}
              />
            )}
            {error && (
              <p className="callout callout-fail" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-big" type="submit" disabled={busy}>
              {busy ? 'One moment' : SUBMIT[mode]}
            </button>
          </form>

          {mode === 'signin' && (
            <button type="button" className="btn btn-quiet home-forgot" onClick={() => go('forgot')}>
              Forgot password?
            </button>
          )}
          {mode === 'forgot' && (
            <button type="button" className="btn btn-quiet home-forgot" onClick={() => go('signin')}>
              Back to sign in
            </button>
          )}

          {(mode === 'signin' || mode === 'signup') && (
            <>
              <p className="home-or">
                <span>or</span>
              </p>
              <div className="home-alt">
                {authMethods.google && (
                  <button
                    type="button"
                    className="btn home-alt-btn"
                    disabled={busy}
                    onClick={() => void run(async () => signInWithGoogle())}
                  >
                    <GoogleMark />
                    Continue with Google
                  </button>
                )}
                {authMethods.link && (
                  <button type="button" className="btn home-alt-btn" disabled={busy} onClick={emailLink}>
                    <Icon name="mail" size={18} />
                    Email me a sign-in link
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {(mode === 'signin' || mode === 'signup') && !sent && (
        <p className="home-legal">
          By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.
        </p>
      )}
    </section>
  );
}

const SUBMIT: Record<Mode, string> = {
  signin: 'Sign in',
  signup: 'Create account',
  forgot: 'Send reset link',
  recovery: 'Save password',
};

function PasswordField({
  value,
  onChange,
  fresh,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  fresh: boolean;
  label: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="home-pw">
        <input
          id={id}
          className="home-input"
          type={shown ? 'text' : 'password'}
          name={fresh ? 'new-password' : 'password'}
          autoComplete={fresh ? 'new-password' : 'current-password'}
          minLength={fresh ? 8 : undefined}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={fresh ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="home-pw-toggle"
          aria-label="Show password"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {fresh && (
        <span id={`${id}-hint`} className="home-hint">
          At least 8 characters. Your password manager can make one.
        </span>
      )}
    </div>
  );
}

/** Google's own mark, in Google's colours (brand tokens, not theme colours). */
function GoogleMark() {
  return (
    <svg
      className="home-google"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="g-blue"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        className="g-green"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        className="g-yellow"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        className="g-red"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
