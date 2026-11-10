import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { AdsFigures, AdsFlow, AdsNextMove } from '../api/types';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { age, usd } from '../ui-kit/time';

const MOVE: Record<AdsNextMove['kind'], StatusSpec> = {
  waiting_for_data: { word: 'Waiting for a report', tone: 'neutral', icon: 'clock' },
  learning: { word: 'Learning', tone: 'active', icon: 'running' },
  check_tracking: { word: 'Needs you: check tracking', tone: 'attention', icon: 'waiting' },
  over_target: { word: 'Needs you: above target', tone: 'attention', icon: 'waiting' },
  on_target: { word: 'On target', tone: 'ok', icon: 'done' },
};

const num = (n: number) => n.toLocaleString('en-US');

/** FW-C-058: where the numbers come from, and whether the last automatic pull worked. */
function PullLine({ pull }: { pull: AdsFlow['pull'] }) {
  if (!pull) return null;
  const last = pull.last;
  if (!last)
    return <p className="small">Pulling from Google Analytics every {pull.every_hours} h. No pull yet.</p>;
  if (last.ok)
    return (
      <p className="small">
        Pulled from Google Analytics {age(last.at)} ({last.days ?? 0} days). Next pull within{' '}
        {pull.every_hours} h.
      </p>
    );
  return (
    <p className="small" role="status">
      <strong>The Google Analytics pull failed {age(last.at)}.</strong> {last.error}
    </p>
  );
}
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const money = (n: number | null) => (n === null ? 'n/a' : usd(n));

function Figures({ f, label }: { f: AdsFigures; label: string }) {
  return (
    <dl className="facts" aria-label={label}>
      <dt>Spent</dt>
      <dd>{usd(f.spend_usd)}</dd>
      <dt>Clicks</dt>
      <dd>
        {num(f.clicks)} of {num(f.impressions)} views ({pct(f.ctr)}), {money(f.cost_per_click_usd)} each
      </dd>
      <dt>Subscriptions</dt>
      <dd>{num(f.subscriptions)}</dd>
      <dt>Cost per subscription</dt>
      <dd>{money(f.cost_per_subscription_usd)}</dd>
    </dl>
  );
}

/** FW-C-048: one ad campaign, read only. The flow never changes the campaign; you do, in Google Ads. */
export function PaidAdsPanel() {
  const res = useResource('flow:paid-ads', () => api.adsFlow(), ['runs']);
  return (
    <section className="panel" aria-labelledby="ads-head">
      <div className="panel-head">
        <h2 id="ads-head">{res.data?.name ?? 'Paid ads'}</h2>
        {res.data && <StatusLabel spec={MOVE[res.data.next_move.kind]} />}
      </div>
      <ResourceView res={res} what="the paid ads flow">
        {(a: AdsFlow) => (
          <div className="stack">
            <p>{a.next_move.why}</p>
            <PullLine pull={a.pull} />
            <p className="muted small">
              {a.campaign.platform} campaign “{a.campaign.name}”, goal: {a.campaign.goal}. Target{' '}
              {usd(a.target_cost_per_subscription_usd)} per subscription
              {a.target_is_placeholder ? ' (a guess until you set it)' : ''}.{' '}
              {a.first_day ? `Data ${a.first_day} to ${a.last_day}.` : ''} <AsOf res={res} />
            </p>
            {a.totals.days > 0 && (
              <>
                <Figures f={a.totals} label="Campaign so far" />
                <details className="fold">
                  <summary>
                    <span className="fold-label">Last 7 days</span>
                    <span className="fold-hint">{usd(a.last_7_days.spend_usd)} spent</span>
                  </summary>
                  <div className="fold-body">
                    <Figures f={a.last_7_days} label="Last 7 days" />
                  </div>
                </details>
              </>
            )}
            <details className="fold">
              <summary>
                <span className="fold-label">Add the latest numbers</span>
                <span className="fold-hint">
                  {a.pull ? 'by hand, if you need to' : 'a report CSV from Google Ads'}
                </span>
              </summary>
              <div className="fold-body">
                <p className="small">{a.source.how}</p>
              </div>
            </details>
          </div>
        )}
      </ResourceView>
    </section>
  );
}
