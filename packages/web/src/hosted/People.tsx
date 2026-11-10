import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Copy } from '../ui-kit/honest';
import {
  type AccountSummary,
  cancelInvite,
  chooseAccount,
  chosenAccount,
  createAccount,
  type Invite,
  listAccounts,
  listMembers,
  type Member,
  makeInvite,
  removeMember,
  setMemberRole,
  signedInUserId,
} from './auth';
import { can, grantable, ROLE_HELP, ROLE_NAME, type Role } from './roles';

const WHOLE = '';

/** Hosted mode: who shares this business, in what role, and how to invite someone (FW-C-088). */
export function PeoplePanel() {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [current, setCurrent] = useState<string | null>(chosenAccount());
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const list = await listAccounts();
      setAccounts(list);
      // A business this login has left (or was removed from) is forgotten.
      if (chosenAccount() && !list.some((a) => a.id === chosenAccount())) {
        chooseAccount(null);
        setCurrent(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const account = accounts?.find((a) => a.id === current) ?? accounts?.[0] ?? null;

  return (
    <section className="panel" aria-labelledby="people-h">
      <h2 id="people-h">People</h2>
      <p className="small muted">
        Share this business with people who help out or just keep an eye on things. Each person signs in with
        their own login.
      </p>
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      {accounts === null && !error && <p className="small muted">Loading…</p>}
      {accounts && accounts.length === 0 && <NewBusiness onMade={loadAccounts} />}
      {accounts && accounts.length > 1 && account && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Business</span>
          <select
            value={account.id}
            onChange={(e) => {
              chooseAccount(e.target.value);
              setCurrent(e.target.value);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({ROLE_NAME[a.role]})
              </option>
            ))}
          </select>
        </label>
      )}
      {account && <Business key={account.id} account={account} onLeft={loadAccounts} />}
    </section>
  );
}

function NewBusiness({ onMade }: { onMade: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await createAccount(name.trim());
          onMade();
        } catch (x) {
          setError(x instanceof Error ? x.message : String(x));
        }
      }}
    >
      <p>You are not in a business yet. Make one, or open an invite link someone sent you.</p>
      <label className="stack" style={{ gap: 4 }}>
        <span className="small">Business name</span>
        <input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className="btn">
        Make business
      </button>
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Business({ account, onLeft }: { account: AccountSummary; onLeft: () => void }) {
  const [people, setPeople] = useState<{ members: Member[]; invites: Invite[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = signedInUserId();
  const manage = can(account.role, 'members');

  const load = useCallback(async () => {
    try {
      setPeople(await listMembers(account.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [account.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  };

  const label = (m: { email: string | null }) => m.email ?? 'someone';

  return (
    <div className="stack">
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      {people && (
        <ul aria-label="Members" className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {people.members.map((m) => {
            const self = m.user_id === me;
            const editable = manage && !self && (account.role === 'owner' || m.role !== 'owner');
            return (
              <li key={m.user_id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{label(m)}</strong>
                  {self && <span className="small muted"> (you)</span>}
                  {m.flows && <span className="small muted"> · only {m.flows.join(', ')}</span>}
                </span>
                {editable ? (
                  <span className="row">
                    <select
                      aria-label={`Role for ${label(m)}`}
                      value={m.role}
                      onChange={(e) =>
                        act(() => setMemberRole(account.id, m.user_id, e.target.value as Role, m.flows))
                      }
                    >
                      {grantable(account.role).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_NAME[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      aria-label={`Remove ${label(m)}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${label(m)} from ${account.name}?`))
                          void act(() => removeMember(account.id, m.user_id));
                      }}
                    >
                      Remove
                    </button>
                  </span>
                ) : (
                  <span className="status status-neutral">{ROLE_NAME[m.role]}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {manage && people && people.invites.length > 0 && (
        <>
          <h3 className="small">Open invites</h3>
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {people.invites.map((i) => (
              <li key={i.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  {i.email ?? 'Anyone with the link'}{' '}
                  <span className="small muted">
                    · {ROLE_NAME[i.role]}
                    {i.flows ? ` · only ${i.flows.join(', ')}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet"
                  aria-label={`Cancel invite for ${i.email ?? 'anyone with the link'}`}
                  onClick={() => act(() => cancelInvite(account.id, i.id))}
                >
                  Cancel invite
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {manage && <InviteForm account={account} onMade={load} />}

      {me &&
        !(account.role === 'owner' && people?.members.filter((m) => m.role === 'owner').length === 1) && (
          <p>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={async () => {
                if (!window.confirm(`Leave ${account.name}? You will need a new invite to come back.`))
                  return;
                try {
                  await removeMember(account.id, me);
                  chooseAccount(null);
                  onLeft();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Leave {account.name}
            </button>
          </p>
        )}
    </div>
  );
}

function InviteForm({ account, onMade }: { account: AccountSummary; onMade: () => void }) {
  const roles = grantable(account.role).filter((r) => r !== 'owner');
  const [role, setRole] = useState<Role>('viewer');
  const [email, setEmail] = useState('');
  const [flow, setFlow] = useState(WHOLE);
  const [flows, setFlows] = useState<{ key: string; name: string }[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .supervisor()
      .then((s) => setFlows(s.flows.map((f) => ({ key: f.key, name: f.name }))))
      .catch(() => setFlows([]));
  }, []);

  const wholeOnly = role === 'admin';

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setLink(null);
        try {
          const r = await makeInvite(account.id, {
            role,
            email: email.trim() ? email.trim().toLowerCase() : null,
            flows: wholeOnly || flow === WHOLE ? null : [flow],
          });
          setLink(r.url);
          setEmail('');
          onMade();
        } catch (x) {
          setError(x instanceof Error ? x.message : String(x));
        }
      }}
    >
      <h3 className="small">Invite someone</h3>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Invite as</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_NAME[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Email (optional)</span>
          <input
            type="email"
            autoComplete="off"
            value={email}
            placeholder="Anyone with the link"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="small">Access</span>
          <select
            value={wholeOnly ? WHOLE : flow}
            disabled={wholeOnly}
            onChange={(e) => setFlow(e.target.value)}
          >
            <option value={WHOLE}>Whole business</option>
            {flows.map((f) => (
              <option key={f.key} value={f.key}>
                Only {f.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Make invite link
        </button>
      </div>
      <p className="small muted">{ROLE_HELP[role]}</p>
      {link && (
        <p className="row">
          <code style={{ overflowWrap: 'anywhere' }}>{link}</code>
          <Copy text={link} label="Copy link" />
        </p>
      )}
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
