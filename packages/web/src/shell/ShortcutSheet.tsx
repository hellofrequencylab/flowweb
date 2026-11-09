import { focusOnMount } from '../ui-kit/focus';
import { Dialog } from './KillSwitch';

const ROWS: [string, string][] = [
  ['j / k', 'Next / previous card'],
  ['Enter', 'Open the selected card'],
  ['a', 'Approve (when unlocked)'],
  ['d', 'Deny'],
  ['e', 'Show or hide evidence'],
  ['s', 'Snooze'],
  ['1 – 4', 'Choose an option'],
  ['Esc', 'Close'],
  ['g then h', 'Go to Dawn Log'],
  ['g then t', "Go to Captain's Table"],
  ['g then l', 'Go to the ledger'],
  ['g then r', 'Go to Runs'],
  ['g then s', 'Go to Spend'],
  ['m', 'Calm mode on or off'],
  ['?', 'This list'],
  ['Ctrl/Cmd + Shift + .', 'Open the kill switch'],
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose}>
      <h2>Keyboard shortcuts</h2>
      <table className="data">
        <tbody>
          {ROWS.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd className="mono">{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Single-key shortcuts can be turned off in Settings.</p>
      <button type="button" className="btn" onClick={onClose} ref={focusOnMount}>
        Close
      </button>
    </Dialog>
  );
}
