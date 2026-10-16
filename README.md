# pos-terminal-mock

**A stand-in card machine, for developers who do not have one.**

Integrating an Indian POS terminal means writing code against hardware you probably cannot keep on
your desk — and against API docs that do not always match what the device does. This is a local
server that answers the terminal's cloud API the way the real one answered it, so you can build the
whole flow before you ever hold a machine.

```sh
npx github:eka-care/pos-terminal-mock       # or clone, then: node server.mjs
# ▸ mock Pine Labs terminal on http://localhost:8201
```

Point your integration's provider host at `http://localhost:8201` — **that is the only change.**
Then open <http://localhost:8201/> and you are the customer at the counter: every live sale has
buttons to **tap a card**, **pay by UPI**, **decline**, **get stuck mid-payment** (which is when a
cancel must be refused) and **let it expire**.

No dependencies. One file. Node 20+.

## Why this exists

A terminal integration is hard to test for reasons that have nothing to do with your code:

- **The sale resolves later, and maybe elsewhere.** The machine does not call you back. You learn
  what happened by asking — and the thing you must handle is a sale whose asker went away.
- **The failures are the interesting part.** A declined card, a customer who walks off mid-payment,
  a sale nobody completes, a cancel that arrives too late. You cannot produce those on demand with
  real hardware, and you certainly cannot produce them in CI.
- **The docs and the device disagree.** Several behaviours below are not in any published guide. We
  found them with a physical terminal on a UAT account, and they are the ones that broke us.

So this mock is written to be **wrong in the same ways the real thing is**.

## Providers

| Provider | Status | Contract |
| --- | --- | --- |
| **Pine Labs** (Plutus Smart, Cloud API) | ✅ implemented | [docs/pine-labs.md](docs/pine-labs.md) |
| Razorpay POS | 🔜 coming soon | [docs/razorpay.md](docs/razorpay.md) |
| Paytm EDC | 🔜 coming soon | [docs/paytm.md](docs/paytm.md) |

Each page documents **the upstream API itself**, not just this mock — the endpoints, the fields that
matter, and the behaviour we observed on real hardware. If you are integrating one of these
terminals, those pages are worth reading even if you never run the server.

## What it implements (Pine Labs)

Three calls, each `POST /API/CloudBasedIntegration/V1/<call>` — the real Plutus Cloud paths, so
pointing your provider host at this server is the only change you make:

| Call | What it does |
| --- | --- |
| `UploadBilledTransaction` | pushes an amount to the machine; answers with the sale's reference |
| `GetCloudBasedTxnStatus` | asks how a sale ended |
| `CancelTransaction` | withdraws a sale that has not been paid |

A refund is the same upload with `TxnType 3`, and gets its own row and its own buttons.

## The behaviours that bite

These are the ones worth knowing before you write a line of integration code. All were observed on
a Pine Labs UAT terminal; the mock reproduces each.

- **Every reply is HTTP 200.** The outcome lives in `ResponseCode`. If you branch on the HTTP
  status you will treat a decline as a success.
- **A non-numeric `SequenceNumber` is rejected with HTTP 400** — *before* any credential check. The
  one case where the status code does carry the answer.
- **`AllowedPaymentMode` is PIPE-separated** (`1|10`). Pine Labs' own sample shows `"1|2"`; a comma
  list is refused with `INVALID PAYMENT MODE RECEIVED`, and so is an unknown code.
- **The sale's identity is the `PlutusTransactionReferenceID` the API hands back** — not the
  `TransactionNumber` you sent.
- **Re-uploading the same `TransactionNumber` REPLACES the live sale** with a new reference. The old
  one is gone; if you were holding it, you are now watching a sale that cannot resolve.
- **A sale nobody pays expires on its own** after `AutoCancelDurationInMinutes`.
- **A sale belongs to the machine whose `ClientID` pushed it** — one Client ID per machine — so a
  store with several terminals is several conversations.
- **A pending sale reads as failed** on more than one adapter. Polling the provider while the
  customer is still tapping will false-decline a card that is about to go through.
- **`Amount` is in paise**, and Plutus' own sample sends it as a *string* (`"Amount": "100"`). This
  mock takes a string or a number; a rupee amount sent as paise is a 100× error nobody catches in
  review.

### Stated as assumptions, because they are

We will not dress up a guess as a fact. These are how the mock behaves, and **nobody has seen real
hardware do them**:

- what a terminal answers for a **refund's** status or cancel (the mock answers as it does for a
  sale);
- what happens when you ask about a sale using a **different machine's Client ID** (the mock answers
  as if the sale does not exist).

If you confirm either on a real device, a PR correcting this README is the most useful thing you
could send.

## Driving it from tests

The control page is for a human. For an automated test, drive the same transitions over HTTP:

```sh
# the sale's reference comes back from your UploadBilledTransaction call
curl -s -X POST http://localhost:8201/act -d 'ref=877081&do=card'      # tap a card
curl -s -X POST http://localhost:8201/act -d 'ref=877081&do=upi'       # pay by UPI
curl -s -X POST http://localhost:8201/act -d 'ref=877081&do=decline'   # declined
curl -s -X POST http://localhost:8201/act -d 'ref=877081&do=busy'      # stuck mid-payment
curl -s -X POST http://localhost:8201/act -d 'ref=877081&do=expire'    # nobody paid
```

`MOCK_MINUTE_MS` shortens the auto-cancel minute, so an expiry test need not wait two real ones.

```sh
PORT=9000 MOCK_MINUTE_MS=200 node server.mjs
```

## What it is not

**It is a development tool, not a test double for the provider's security.** It holds no secrets and
accepts any credentials that are present. Never point anything but a local stack at it, and never
run it anywhere a real integration could reach it by accident.

## Contributing

The most valuable contribution is **an observed behaviour** — something a real terminal did that
this mock gets wrong, or one of the assumptions above confirmed or disproved. Open an issue with
what you sent and what came back.

MIT. Built at [Eka Care](https://www.eka.care) for the billing platform, and open-sourced because
every team integrating these terminals is solving the same problem.
