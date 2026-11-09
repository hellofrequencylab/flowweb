# ledger/rows: row definitions (Tier 0)

One file per ledger row: `<ID>.json`, valid against `packages/contracts/json-schema/ledger-row.json`. A row file holds the **definition** (title, priority, lane, size, owner, probe, dependencies) and never its status. Status lives only in the ledger database.

- `pnpm fw ledger sync` inserts new rows. It refuses to change the probe of a row that already exists in the database and records the attempt as a tamper event.
- Rows are written by the Owner, or accepted by the Owner from a decision card (for example scan findings). Agents do not add or edit row files.
- A probe measures a consequence, not an activity, and must fail today. `fw ledger sync` runs it once against the base branch and refuses a row whose probe already passes.
- Closing a row is `pnpm fw ledger close <ID>`, which runs the probe on the merged artifact. Never edit a row file to mark it done.
- To change a probe: park the row (`fw ledger park <ID> --reason ...`) and add a new row that supersedes it.
