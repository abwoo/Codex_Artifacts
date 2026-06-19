# Decision Table

## Options

| Option | Strength | Tradeoff | Fit |
| --- | --- | --- | --- |
| Small local tool | Fast to ship | Local-only sharing | Best for MVP |
| Plugin integration | Smooth workflow | More surface area | Good second step |
| Hosted private links | Most like cloud artifacts | Requires auth and hosting | Later |

## Recommendation

Start with the local tool, keep the artifact format portable, and avoid coupling the MVP to a backend.

## Acceptance Signals

- A reviewer can understand the current project state from one page.
- The artifact can be regenerated without manual editing.
- Snapshots preserve the historical trail.
