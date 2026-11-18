import { api } from '../api/client';
import { useLive } from '../api/live';
import { useResource } from '../api/resource';
import { stateOf } from '../flows/drafts';

/** The flows whose drafts land in the Inbox. FW-C-113: the email approval queue (S9) sits under the DMs. */
export const INBOX_FLOWS = ['neighborhood-activation', 'email-queue'] as const;

/** The heading each flow's drafts panel carries in the Inbox. */
export const INBOX_TITLES: Record<(typeof INBOX_FLOWS)[number], string> = {
  'neighborhood-activation': 'Drafts',
  'email-queue': 'Emails for Email Studio',
};

/**
 * FW-C-156: every flow whose drafts land in the Inbox, with its heading: the fixed two, then each copy of
 * the base flow that is not archived (a profile flow such as Coaches and Guides), under its own name.
 */
export function useInboxFlows(): { key: string; title: string }[] {
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const copies = (sup.data?.flows ?? [])
    .filter((f) => f.copy_of === INBOX_FLOWS[0] && !f.archived)
    .map((f) => ({ key: f.key, title: `Drafts: ${f.name}` }));
  return [...INBOX_FLOWS.map((key) => ({ key: key as string, title: INBOX_TITLES[key] })), ...copies];
}

/** Drafts ready to check and send: no blanks left, not sent, not handled. Null until fwd answers. */
export function useReadyMessages(): number | null {
  const keys = useInboxFlows()
    .map((f) => f.key)
    .join(',');
  const res = useResource(`inbox-ready:${keys}`, async () => {
    // A flow this fwd does not serve (an older build, a copy just removed) counts as no drafts, so one
    // missing flow never hides the rest.
    const got = await Promise.all(keys.split(',').map((f) => api.flowDrafts(f).catch(() => null)));
    const lists = got.filter((l) => l !== null);
    if (lists.length === 0) throw new Error('no flow answered with its drafts');
    return {
      data_as_of: lists[0]?.data_as_of ?? new Date().toISOString(),
      ready: lists.reduce((n, l) => n + l.drafts.filter((d) => stateOf(d) === 'Ready').length, 0),
    };
  }, ['runs', 'status']);
  return res.data ? res.data.ready : null;
}

/** Everything waiting on the Owner: open decisions plus ready messages. Null when neither is known. */
export function useWaiting(): { decisions: number | null; messages: number | null; total: number | null } {
  const { status, connection } = useLive();
  const messages = useReadyMessages();
  const decisions = status && connection !== 'down' ? status.cards_open : null;
  const total = decisions === null && messages === null ? null : (decisions ?? 0) + (messages ?? 0);
  return { decisions, messages, total };
}
