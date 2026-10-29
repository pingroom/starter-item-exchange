# PingRoom item exchange

Collect one strict item ranking from each of two to five people through PingRoom, then export a local allocation proposal using top-trading cycles. Each person declares ownership of exactly one item. The result assigns every item once; participants may keep their own items. The starter never transfers items, updates ownership records, or deploys anything.

[Expense settlement](https://github.com/pingroom/starter-expense-settlement) calculates balances from shared receipts. This starter allocates individually owned items from complete preference lists; it has no money, quantities, or split costs.

## Try it offline

Use Node.js 22 or 24 on macOS or Linux with private persistent storage. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned SDK with an in-memory mock transport. It covers a swap where one person keeps their item, everyone keeping their items, and an Unknown ranking that withholds the proposal. Tests and demo need no credentials or network access after installation. Live phone delivery is not tested.

## Declare the exchange

```sh
cp examples/exchange.json exchange.json
cp config.example.json config.json
```

Edit these copies before starting. `exchange.json` contains `exchangeId`, `title`, and `items`. Every item has a unique `id`, `label`, and `ownerKey`. `config.json` maps each owner to a participant's `key`, exact lowercase user UUID (`id`), and `label`. Include two to five unique owners and UUIDs, one item per owner, and no participants outside that set.

The example has Alex's notebook (`book`), Blair's pen (`pen`), and Casey's tray (`tray`). Ownership is a declaration supplied by the organizer; the starter does not verify ownership, availability, identity from a name, or permission to transfer. Arrange any actual exchange separately with the people involved.

Keep item contents, ownership, labels, participant mapping, room and robot credential fixed throughout the session. Reordering the item or participant arrays is harmless; changing their contents fails validation. Owner keys determine collection order; item IDs determine prompt order.

## Connect the participants

Install [PingRoom](https://pingroom.io/i), sign in, and use a **standard private room** containing every participant:

```sh
npm run connect
npm run inspect
```

Open the pairing URL, approve the connection, and grant that room. `inspect` lists member UUIDs and lookup names. Verify each person in the app, then set their exact UUID in `config.json`. Example UUIDs are fixtures and must be replaced. To target other people, the connecting account must have the room's owner/admin permission, or the room must allow everyone to trigger Questions. The robot needs Question send/read and room access. All participants must remain members; code checks the entire roster before each send.

```sh
npm run validate
```

Validation checks both files locally, without credentials or requests. Pairing saves ignored `.pingroom/credentials.json`; a saved pairing link is reused while valid and an existing connection is never overwritten. Resolve or revoke an uncertain/expired robot in Connected Agents before archiving its pairing file for another setup.

For an **existing** robot credential, optionally copy `.env.example` to `.env`, uncomment and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials. Either shell variable selects the entire shell pair without borrowing from `.env`; blank or partial pairs fail. This starter does not read another CLI's credential store.

## Collect rankings and export

```sh
npm start          # Send the next ranking request, or read its existing Question once.
# The named person answers in PingRoom; run again:
npm start
npm run status     # Replay saved evidence offline.
npm run report     # Also save private .exchange/report.json.
```

Each person receives one targeted text Question listing all item IDs and labels, plus the item they declared as their own. They rank **every item ID exactly once**, best to worst, comma separated with no spaces or ties. For example, `pen,book,tray` means pen first, book second, tray third. They can type exactly `Unknown` when unable to provide a full ranking.

PingRoom trims submitted text. Code validates the returned normalized text, not original keystrokes. Foreign IDs, duplicates, omissions, case changes, internal spaces and ties are rejected; code does not infer a ranking. Requests omit button options and use text input with a 60-character limit. Five maximum-length IDs need 44 characters.

**A ranking is not authorization to transfer an item. Room history remains visible to room members, so rankings are not confidential.** The report records attributed answers, not independent verification of preferences or property rights.

A session sends at most five Questions, one at a time, each with a 15-minute lifetime. Repeated runs read a pending Question without sending another. Unknown, invalid, expired and cancelled outcomes remain recorded; other participants can continue, but no allocation is available unless every ranking is valid and known. Terminal Questions are never automatically replaced. No scheduler is installed.

The JSON report includes:

- `rankings`: owner, declared item, outcome, normalized text, parsed ranking, Question/attempt IDs, responder, asking registration and timestamps.
- `unknownOwnerKeys`: participants who explicitly answered Unknown.
- `proposal`: `null` until every ranking is known; then `allocations` and a reproducible `rounds` trace.
- `transfersExecuted`: always `false`.

Each allocation names the recipient (`ownerKey`), item (`itemId`), original owner (`fromOwnerKey`), original item (`ownItemId`), and whether the recipient keeps their own item (`keepsOwn`). Consume the validated report and require a non-null proposal.

## How allocation works

For each round, every remaining owner points to the original owner of their highest-ranked remaining item. Code finds all disjoint cycles, assigns each cycle member their chosen item, then removes those owners and their original items. It repeats until all items are assigned. A one-person cycle keeps that person's own item.

Each round records remaining owners, pointers, cycles and assignments. Owner keys sort lexically; each cycle starts with its smallest key and follows its pointers, and cycles sort by that first key. This makes the trace independent of JSON array order.

For example, Alex ranks `pen,book,tray`, Blair ranks `book,pen,tray`, and Casey ranks `tray,book,pen`. Alex and Blair form a two-person cycle; Casey forms a self cycle. The proposal gives Alex the pen, Blair the notebook and Casey the tray. No ownership record is changed.

| Collection exit code | Meaning |
| --- | --- |
| `0` | Complete allocation proposal |
| `1` | Configuration, transport or evidence validation failure |
| `2` | Newly observed invalid/expired/cancelled answer, or final incomplete rankings |
| `3` | Pending, ready for another participant, or interrupted |
| `4` | Creation is uncertain; recover the original Question |

Unknown can leave the session `ready` while others remain. Local `status` and `report` exit `0` when readable; check the JSON `status` and `proposal`.

## Recover uncertain creation

Intent is saved durably before each POST. If the creation response is lost, later sends stop at `create_unknown`:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` searches a bounded recent list for matching candidates. An empty result does not prove creation failed. Inspect the original Question in PingRoom if needed, then supply its exact ID. Recovery verifies the request, target, room, correlation data, text configuration, asking registration and timing without resending. Failed reads preserve previous evidence; keep state while creation is uncertain.

Before a new session, resolve outstanding Questions and securely archive the entire `.exchange/` directory. Then prepare a new manifest and participant mapping. Restore original files and credentials to resume an existing session.

Private state writes use file sync, atomic rename and directory sync. Locks exclude concurrent commands. After a crash, inspect `.exchange/.lock/owner.json` or `.pingroom/.lock/owner.json`, confirm the process stopped, then remove only that stale lock. Restore corrupt state from backup. Use one local machine/process; local persistence and server idempotency do not promise distributed exactly-once execution.

## Adapt and verify

`src/engine.js` exports `step` for one durable collection action and `localReport` for offline evidence replay. `src/model.js` owns input validation, response attribution, ranking parsing and allocation. `allocate` calculates a proposal without verifying evidence. Keep these deterministic rules in application code. Implement transfers separately, with the required authorization.

IDs and owner keys start with a lowercase letter and use lowercase letters, digits, `_` or `-`: maximum 8 characters; `exchangeId` allows 40. Labels allow 30 printable ASCII characters, title 60, without surrounding spaces. Inputs/config are limited to 16 KiB, saved state/reports to 1 MiB, HTTP responses to 512 KiB. Requests use the official API origin, refuse redirects and have a five-second deadline through body consumption.

Credentials, local inputs, evidence and reports are ignored by Git. Saved files use `0600` and directories `0700`; protect backups and participant identifiers. Paths resolve from this project directory. Anyone with write access to saved files can alter evidence. Offline reports do not check current membership or item availability.

Tests cover all 216 strict ranking profiles for three owners against an independent cycle oracle, uniqueness/conservation, own-item rank bounds, order invariance, multi-round cycles, self keeps, maximum input bounds, Unknown/malformed answers, all-participant preflight, attribution, uncertain creation, disk failures, clocks, pairing, transport limits and real CLI invocations. GitHub Actions runs tests and demo on Node.js 22/24.

The [official SDK](https://github.com/pingroom/sdk) is pinned to `0.7.1` with a lockfile and a 14-day npm minimum release age. MIT licensed; see [LICENSE](LICENSE).
