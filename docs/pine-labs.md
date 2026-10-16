# Pine Labs — Plutus Smart, Cloud API

What the API is, what it answers, and what it actually does on a device. Written while building a
billing integration against a UAT terminal; the behaviours marked **observed** were seen on real
hardware on 2026-09-12, not read in a guide.

The mock in this repo implements everything on this page, so you can develop the whole flow before
you have a machine — [`../README.md`](../README.md).

## The shape

Three calls, all `POST {host}/API/CloudBasedIntegration/V1/<call>`, JSON in and JSON out. A refund
re-uses the upload.

| Call | Key request fields |
| --- | --- |
| `UploadBilledTransaction` | `TransactionNumber` (yours), `SequenceNumber` (**numeric**), `Amount` in **paise**, `AllowedPaymentMode` (pipe-separated), `AutoCancelDurationInMinutes`, `ClientID` (the machine) |
| `GetCloudBasedTxnStatus` | `PlutusTransactionReferenceID` |
| `CancelTransaction` | `PlutusTransactionReferenceID` + `Amount` (paise, as a string) |
| refund | `UploadBilledTransaction` with `TxnType 3` + `OriginalPlutusTransactionReferenceID` + `TransactionLogId` |

## The eight things that cost us time

**1. Every reply is HTTP 200.** *(observed)* The outcome is `ResponseCode` in the body. Code that
branches on the HTTP status treats a rejected sale as a pushed one.

**2. Except one: a non-numeric `SequenceNumber` is HTTP 400** *(observed)* — returned *before*
authentication. We sent a uuid, and every sale was rejected without ever reaching the machine. Use
a numeric sequence that is stable across processes and never reused.

**3. The sale's identity is the `PlutusTransactionReferenceID` the upload returns** *(observed)* —
not your `TransactionNumber`. Store it: status, cancel, refund and reconciliation are all keyed on
it. Discarding it means none of those can ever work.

**4. `AllowedPaymentMode` is PIPE-separated.** *(observed)* The Cloud Integration spec's sample is
`"1|2"`. A comma list is refused with `INVALID PAYMENT MODE RECEIVED`, and so is an unknown code.

**5. Re-uploading the same `TransactionNumber` REPLACES the live sale** *(observed)* with a new
reference and kills the old one. So a blind retry orphans the sale you are tracking — **a retry
must be a fresh transaction**, never a second push of the same one.

**6. An untouched sale stays live forever unless you say otherwise.** Send
`AutoCancelDurationInMinutes` (we use `2`). Without it an abandoned amount sits on the machine and
the next customer can pay it.

**7. `CancelTransaction` really cancels — and sometimes refuses.** *(observed)* A sale the customer
is already paying answers `CANNOT CANCEL AS TRANSACTION IS IN PROGRESS`. Treat that as "still
live", not as a cancellation: telling the operator it was cancelled while the card is being tapped
is how you double-collect.

**8. A pending sale reads as failed on more than one adapter.** Polling the provider while the
customer is still tapping will false-decline a card that is about to go through. Either wait for
the capture to be reported, or poll gently and treat anything unrecognised as *pending*.

## Response codes

Codes are reused across outcomes, so match the **message** for everything but the first two.

| Code / message | Means |
| --- | --- |
| `0` | approved — captured (sale) / voided (cancel) |
| `1001 TXN UPLOADED` | on the terminal, waiting for the customer — in progress |
| `INVALID TRANSACTION NUMBER` | the auto-cancel window elapsed, nobody paid |
| `INVALID PLUTUS TXN REF ID` | cancelled, replaced by a re-upload, or never existed |
| `TRANSACTION NOT FOUND` | cancel found nothing left to withdraw |
| `CANNOT CANCEL AS TRANSACTION IS IN PROGRESS` | the customer is mid-payment |
| `INVALID MERCHANT` / `INVALID INPUT` / `INVALID PAYMENT MODE` / `INVALID STORE` | a credential or shape problem — never a payment outcome |

**Anything unrecognised should stay `pending`.** A sale you cannot read is not a decline, and the
auto-cancel window resolves it either way.

## Payment modes

`AllowedPaymentMode` names the modes the machine may offer for **one** sale. **No API reports which
modes a terminal supports** — the merchant configures that with Pine Labs — so your app has to let
the business say which ones it wants.

| | |
| --- | --- |
| common | `1` Card · `10` UPI · `11` UPI QR · `2` Cash · `4` Wallets · `20` Bank EMI · `0` all modes on the machine |
| others | `3` Points · `6` Brand EMI · `7` Sodexo · `8` PhonePe · `9` Paytm UPI · `12` Airtel Payments Bank · `19` Paper POS · `21` Amazon Pay · `22` Instant discount sale · `23` Cardless Bank EMI · `24` Cardless Brand EMI · `25` Twid Pay · `26` HDFC Flexipay · `27` Pre-auth · `28` Pre-auth completion · `29` Gifticon · `30` magicpin · `35` NBFC product sale · `37` myEMI · `39` ePayLater · `40` NTB · `42` Zomato Pay · `43` QC Redeem · `44` STELLR POR · `45` STELLR POSA · `47` Swiggy |

Source: Plutus Cloud Integration spec v1.36/1.37 and the live docs page.

- **`0` (all modes) is sent alone** — `"0"`, never `0|1`.
- **Not every code is a plain payment.** `27` pre-auth only *holds* money; `28` completes one; `22`
  lets the machine change the amount; `6`/`35` need a product code and scheme; `19` needs a
  `PaperPOSID`; `44`/`45` issue or activate gift cards. If you book an approved one as an ordinary
  capture you will book money that was never taken. None of these were verified on a device.
- **Cash taken on the machine never reaches the card settlement.** If you book it as a card payment,
  the drawer and the bank will disagree at day close.

## Not verified ⚠

Stated plainly, because an assumption dressed as a fact is worse than a gap:

- **Refunds.** The upload (`TxnType 3`) is implemented and pushed, but what a terminal answers for a
  refund's *status* or *cancel* has never been observed. The mock answers as it does for a sale.
- **Cross-machine lookups.** Asking about a sale with a *different* machine's `ClientID` is
  answered, by the mock, as if the sale did not exist. Real hardware has only ever been driven with
  one Client ID.

Confirmed either way on a real device? A PR correcting this page is the most useful thing you could
send.
