// FW-C-169: what the pages show. The Owner picks the page that opens first and which optional panels the
// flow pages carry. Drafts and the flow's controls are not on the list: they always show. Each change saves
// at once; on the live site it is queued and the relay applies it on the machine.
import { useSiteSave, useSiteSettings, waitingWords } from './siteSettings';

const HOMES = [
  { v: 'today', label: 'Your flows' },
  { v: 'flows', label: 'The flow page' },
  { v: 'drafts', label: 'Drafts to check' },
] as const;
const SECTION_LABELS: Record<string, string> = {
  'lead-hunts': 'Lead hunts',
  'reply-helper': 'Reply helper',
  'event-intake': 'Paste events',
  'whats-working': "What's working",
  'paid-ads': 'Paid ads',
};

export function InterfaceSettings({ canChange = true }: { canChange?: boolean }) {
  const { settings, state } = useSiteSettings();
  const { busy, run, status } = useSiteSave('Saved.');
  const off = !canChange || busy;
  return (
    <section className="settings-group" aria-labelledby="iface-h">
      <h2 id="iface-h">
        Interface
        <span className="setting-desc">
          The page that opens first, and the optional panels on a flow page. Drafts and controls always show.
        </span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          {!settings ? (
            <p>{waitingWords(state)}</p>
          ) : (
            <>
              {settings.note && <p className="setting-desc callout-warn">{settings.note}</p>}
              <fieldset className="setting setting-choice">
                <legend className="visually-hidden">Opens first</legend>
                <span className="setting-text" aria-hidden="true">
                  <span className="setting-label">Opens first</span>
                  <span className="setting-desc">Where a visit to FlowWeb starts.</span>
                </span>
                <span className="segmented">
                  {HOMES.map((h) => (
                    <label key={h.v}>
                      <input
                        type="radio"
                        name="iface-home"
                        checked={settings.interface.home === h.v}
                        disabled={off}
                        onChange={() => void run({ interface: { home: h.v } })}
                      />
                      {h.label}
                    </label>
                  ))}
                </span>
              </fieldset>
              {settings.section_names.map((name) => {
                const label = SECTION_LABELS[name] ?? name;
                const on = settings.interface.sections[name] !== false;
                return (
                  <div className="setting" key={name}>
                    <span className="setting-text">
                      <span className="setting-label">{label}</span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={on}
                      aria-label={`Show ${label}`}
                      disabled={off}
                      onClick={() => void run({ interface: { sections: { [name]: !on } } })}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                );
              })}
              {status}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
