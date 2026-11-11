// FW-C-120: Settings, "Link to Frequency". Hosted only. An owner or admin links their business to one Frequency
// Space (the house is Frequency itself), and gets the link's secret once, to paste into Frequency. After that
// they can pause, resume, get a new secret or unlink. The secret never comes back from a read.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui-kit/Button';
import { Copy } from '../ui-kit/honest';
import { when } from '../ui-kit/time';
import {
  type AccountSummary,
  chosenAccount,
  createFrequencyLink,
  type FrequencyLink,
  listAccounts,
  listFrequencyLinks,
  rotateFrequencyLink,
  setFrequencyLinkStatus,
} from './auth';

const SPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS: Record<FrequencyLink['status'], string> = {
  active: 'On',
  paused: 'Paused',
  revoked: 'Unlinked',
};

type Shown = { id: string; secret: string; house: boolean };

function Secret({ shown, onDone }: { shown: Shown; onDone: () => void }) {
  return (
    <div className="callout callout-ok stack" role="status" aria-label="New link secret">
      <p>
        Copy these into Frequency now. The secret is shown once; if it is lost, make a new one.
        {shown.house
          ? ' In the Frequency project on Vercel they go in FLOWWEB_HOUSE_LINK_ID and FLOWWEB_HOUSE_LINK_SECRET.'
          : ' Paste them into this Space’s FlowWeb settings in Frequency.'}
      </p>
      <div className="row">
        <code>{shown.id}</code>
        <Copy text={shown.id} label="link id" />
      </div>
      <div className="row">
        <code>{shown.secret}</code>
        <Copy text={shown.secret} label="link secret" />
      </div>
      <Button variant="quiet" onClick={onDone}>
        I copied them
      </Button>
    </div>
  );
}

function NewLink({ account, onMade }: { account: AccountSummary; onMade: (s: Shown) => void }) {
  const [space, setSpace] = useState('');
  const [house, setHouse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await createFrequencyLink(account.id, space.trim(), house);
      onMade({ id: r.id, secret: r.secret, house });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const id = space.trim();
  return (
    <form className="stack" aria-label="Link to a Frequency Space" onSubmit={(e) => e.preventDefault()}>
      <label className="stack">
        <span className="field-label">Frequency Space id</span>
        <input type="text" maxLength={64} value={space} onChange={(e) => setSpace(e.target.value)} />
      </label>
      <label className="row">
        <input type="checkbox" checked={house} onChange={(e) => setHouse(e.target.checked)} />
        <span>This is the house (Frequency itself)</span>
      </label>
      <Button
        onClick={() => void make()}
        disabledReason={busy ? 'Linking…' : !SPACE_RE.test(id) ? 'Type the Space id from Frequency.' : null}
      >
        Link to Frequency
      </Button>
      {error && (
        <p className="callout callout-warn" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Linked({
  link,
  admin,
  reload,
  onShown,
}: {
  link: FrequencyLink;
  admin: boolean;
  reload: () => void;
  onShown: (s: Shown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const paused = link.status === 'paused';
  return (
    <div className="stack">
      <p>
        Linked to Space <strong>{link.space_id}</strong>
        {link.house ? ' (the house)' : ''}. <span className="status">{STATUS[link.status]}</span>
      </p>
      <p className="small muted">
        {link.last_event_at
          ? `Last heard from Frequency ${when(link.last_event_at)}.`
          : 'Nothing heard from Frequency yet.'}
      </p>
      {admin ? (
        <div className="row">
          <Button
            variant="quiet"
            disabledReason={busy ? 'Working…' : null}
            onClick={() =>
              void act(async () => {
                await setFrequencyLinkStatus(link.id, paused ? 'active' : 'paused');
                reload();
              })
            }
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            variant="quiet"
            disabledReason={busy ? 'Working…' : null}
            onClick={() =>
              void act(async () => {
                if (!window.confirm('Make a new secret? The old one stops working right away.')) return;
                const r = await rotateFrequencyLink(link.id);
                onShown({ id: link.id, secret: r.secret, house: link.house });
                reload();
              })
            }
          >
            Make a new secret
          </Button>
          <Button
            variant="quiet"
            disabledReason={busy ? 'Working…' : null}
            onClick={() =>
              void act(async () => {
                if (!window.confirm(`Unlink Space ${link.space_id}? Frequency stops sending events here.`))
                  return;
                await setFrequencyLinkStatus(link.id, 'revoked');
                reload();
              })
            }
          >
            Unlink
          </Button>
        </div>
      ) : (
        <p className="small muted">Only an owner or admin can change the link.</p>
      )}
      {error && (
        <p className="callout callout-warn" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Settings, "Link to Frequency". Hosted only. */
export function FrequencyLinkPanel() {
  const [account, setAccount] = useState<AccountSummary | null | undefined>(undefined);
  const [links, setLinks] = useState<FrequencyLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  const load = useCallback(async () => {
    try {
      const [accs, ls] = await Promise.all([listAccounts(), listFrequencyLinks()]);
      setAccount(accs.find((a) => a.id === chosenAccount()) ?? accs[0] ?? null);
      setLinks(ls);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const admin = account?.role === 'owner' || account?.role === 'admin';
  const link = account
    ? links?.find((l) => l.account_id === account.id && l.status !== 'revoked')
    : undefined;

  return (
    <section className="settings-group" aria-labelledby="freq-link-h">
      <h2 id="freq-link-h">
        Link to Frequency
        <span className="setting-desc">
          Connect this business to its Frequency Space, so Frequency can tell FlowWeb when something happens
          there.
        </span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel stack">
          {error && (
            <p className="callout callout-warn" role="alert">
              {error}
            </p>
          )}
          {!error && (account === undefined || links === null) && <p className="small muted">Loading…</p>}
          {account === null && <p className="muted">Make a business under People first.</p>}
          {shown && <Secret shown={shown} onDone={() => setShown(null)} />}
          {account && links && link && (
            <Linked link={link} admin={admin} reload={() => void load()} onShown={setShown} />
          )}
          {account &&
            links &&
            !link &&
            !shown &&
            (admin ? (
              <NewLink
                account={account}
                onMade={(s) => {
                  setShown(s);
                  void load();
                }}
              />
            ) : (
              <p className="muted">Not linked yet. An owner or admin can link it.</p>
            ))}
        </div>
      </div>
    </section>
  );
}
