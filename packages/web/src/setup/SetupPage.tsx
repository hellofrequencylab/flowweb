import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Setup, SetupStep } from '../api/types';
import { HOSTED } from '../hosted/auth';
import { Link } from '../shell/router';
import { AsOf, Copy, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';

/** A fix that is a command gets a copy button; anything else is an instruction in words. */
const isCommand = (fix: string) => /^(pnpm|FW_[A-Z_]+=)/.test(fix);

function Fix({ fix }: { fix: string }) {
  if (!isCommand(fix)) return <p className="small">{fix}</p>;
  const parts = fix.split(/, then /);
  return (
    <div className="stack">
      {parts.map((p) => (
        <div key={p} className="row">
          <code className="output">{p}</code>
          <Copy text={p} label="command" />
        </div>
      ))}
    </div>
  );
}

function Step({ s, n, next }: { s: SetupStep; n: number; next: boolean }) {
  return (
    <li className="panel stack" aria-current={next ? 'step' : undefined}>
      <div className="row">
        <Icon
          name={s.done ? 'done' : s.required ? 'open' : 'dot'}
          size={18}
          label={s.done ? 'Done' : 'Not done'}
        />
        <strong>
          {n}. {s.title}
        </strong>
        {next && <span className="status status-warn">Next</span>}
        {!s.required && !s.done && <span className="status status-neutral">Optional</span>}
      </div>
      <p className="small muted">{s.detail}</p>
      {!s.done && s.fix && <Fix fix={s.fix} />}
    </li>
  );
}

export function progressOf(d: Setup): { done: number; total: number } {
  const req = d.steps.filter((s) => s.required);
  return { done: req.filter((s) => s.done).length, total: req.length };
}

/** FW-C-038: the same six steps as `pnpm fw setup`, each read from real state on the machine. */
export function SetupPage() {
  const res = useResource('setup', () => api.setup(), ['runs', 'cards', 'rows']);
  return (
    <>
      <PageHead
        title="Get started"
        lede={
          HOSTED
            ? 'What your machine last reported. Each step ticks only when it is really true there.'
            : 'Each step ticks only when it is really true on this machine, never from a click.'
        }
      />
      <p className="page-meta">
        <AsOf res={res} />
      </p>
      <ResourceView res={res} what="setup">
        {(d) => {
          const p = progressOf(d);
          return (
            <div className="stack">
              <p>
                {d.ready
                  ? 'Everything required is done.'
                  : `${p.done} of ${p.total} required steps done. Run pnpm fw setup in a terminal for the same list; it asks for the project and its brief in plain words.`}
              </p>
              <ol className="stack" style={{ listStyle: 'none', padding: 0 }}>
                {d.steps.map((s, i) => (
                  <Step key={s.id} s={s} n={i + 1} next={s.id === d.next} />
                ))}
              </ol>
              {d.ready && (
                <p>
                  Next, watch your flows on <Link to="/flows">Flows</Link>.
                </p>
              )}
            </div>
          );
        }}
      </ResourceView>
    </>
  );
}

/** On the Console until setup is done: how far along, and a link to the next step. Silent otherwise. */
export function SetupNudge() {
  const res = useResource('setup', () => api.setup(), ['runs', 'cards', 'rows']);
  const d = res.data;
  if (!d || d.ready) return null;
  const p = progressOf(d);
  const next = d.steps.find((s) => s.id === d.next);
  return (
    <div className="callout callout-row" role="status" style={{ marginBottom: 'var(--space-6)' }}>
      <span>
        Setup: {p.done} of {p.total} done.{next ? ` Next: ${next.title}.` : ''}
      </span>
      <Link to="/setup" className="btn btn-quiet">
        Continue setup
      </Link>
    </div>
  );
}
