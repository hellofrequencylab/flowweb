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

/** Drafts ready to check and send: no blanks left, not sent, not handled. Null until fwd answers. */
export function useReadyMessages(): number | null {
  const res = useResource('inbox-ready', async () => {
    const lists = await Promise.all(INBOX_FLOWS.map((f) => api.flowDrafts(f)));
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
