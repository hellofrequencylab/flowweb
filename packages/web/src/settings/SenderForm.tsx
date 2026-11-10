// FW-C-095: the email sender's settings, edited from Settings. On the live site the change is queued and the
// relay applies it on the machine (kind connection.email); on the machine fwd writes it at once. There is no
// password field: each mailbox's app password stays in that machine's keychain.
import { useId, useState } from 'react';
import { api } from '../api/client';
import type { SenderValues } from '../api/types';
import { Button } from '../ui-kit/Button';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const START: SenderValues = {
  mailboxes: [{ key: 'personal', address: '', name: '' }],
  postal: '',
  daily_cap: 15,
  per_pass: 1,
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
};

function Num({
  label,
  value,
  min,
  max,
  set,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  set: (n: number) => void;
}) {
  return (
    <label className="stack">
      <span className="field-label">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
}

export function SenderForm({
  values,
  canChange,
  reload,
}: {
  values: SenderValues | null;
  canChange: boolean;
  reload: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<SenderValues>(values && values.mailboxes.length > 0 ? values : START);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const put = (patch: Partial<SenderValues>) => setV((x) => ({ ...x, ...patch }));
  const box = (i: number, patch: Partial<SenderValues['mailboxes'][number]>) =>
    put({ mailboxes: v.mailboxes.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  if (!canChange)
    return values ? (
      <p className="small">
        Sends from {values.mailboxes.map((m) => m.address).join(', ')}. Postal address:{' '}
        <span>{values.postal}</span>
      </p>
    ) : null;

  const save = async () => {
    setBusy('Saving.');
    setNote(null);
    let queued = false;
    try {
      await api.saveSenderSettings(v, () => {
        queued = true;
        setBusy('Saving. Waiting for your machine to apply it.');
      });
      setNote({ ok: true, text: 'Sender settings saved. The sender uses them on its next pass.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      reload();
      if (queued) window.setTimeout(reload, 8000);
    }
  };

  return (
    <>
      <Button
        className="btn-small"
        variant="quiet"
        aria-expanded={open}
        aria-controls={`${id}-form`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Close' : 'Edit'}
      </Button>
      {open && (
        <form
          id={`${id}-form`}
          className="stack sender-form"
          aria-label="Email sender settings"
          onSubmit={(e) => e.preventDefault()}
        >
          {v.mailboxes.map((m, i) => (
            <div key={m.key} className="row">
              <label className="stack">
                <span className="field-label">Address</span>
                <input type="email" value={m.address} onChange={(e) => box(i, { address: e.target.value })} />
              </label>
              <label className="stack">
                <span className="field-label">Name</span>
                <input
                  type="text"
                  maxLength={100}
                  value={m.name}
                  onChange={(e) => box(i, { name: e.target.value })}
                />
              </label>
            </div>
          ))}
          <label className="stack">
            <span className="field-label">Postal address</span>
            <input
              type="text"
              maxLength={300}
              value={v.postal}
              onChange={(e) => put({ postal: e.target.value })}
            />
          </label>
          <span className="small muted">Every message carries it, as the law asks.</span>
          <div className="row">
            <Num label="Daily cap" value={v.daily_cap} min={1} max={40} set={(n) => put({ daily_cap: n })} />
            <Num label="Per pass" value={v.per_pass} min={1} max={5} set={(n) => put({ per_pass: n })} />
            <Num
              label="Start hour"
              value={v.hours.start}
              min={0}
              max={23}
              set={(n) => put({ hours: { ...v.hours, start: n } })}
            />
            <Num
              label="End hour"
              value={v.hours.end}
              min={1}
              max={24}
              set={(n) => put({ hours: { ...v.hours, end: n } })}
            />
          </div>
          <fieldset className="row">
            <legend className="field-label">Days</legend>
            {DAYS.map((d, n) => (
              <label key={d} className="row">
                <input
                  type="checkbox"
                  checked={v.hours.days.includes(n)}
                  onChange={(e) =>
                    put({
                      hours: {
                        ...v.hours,
                        days: e.target.checked
                          ? [...v.hours.days, n].sort((a, b) => a - b)
                          : v.hours.days.filter((x) => x !== n),
                      },
                    })
                  }
                />
                {d}
              </label>
            ))}
          </fieldset>
          <Button
            onClick={() => void save()}
            disabledReason={busy ?? (v.postal.trim() ? null : 'Add a postal address first.')}
          >
            Save
          </Button>
          {busy && (
            <p className="small muted" role="status">
              {busy}
            </p>
          )}
          {note && (
            <p className={`callout ${note.ok ? 'callout-ok' : 'callout-warn'}`} role="status">
              {note.text}
            </p>
          )}
        </form>
      )}
    </>
  );
}
