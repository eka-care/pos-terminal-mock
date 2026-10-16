#!/usr/bin/env node
/**
 * A stand-in Pine Labs terminal, for people without one.
 *
 *   node server.mjs                                  # listens on http://localhost:8201
 *
 * It answers the three Plutus Cloud calls an integration makes, the way the real UAT API answered
 * them on 2026-09-12 — including the parts that are easy to get wrong and that broke us:
 *   · every reply is HTTP 200; the outcome lives in `ResponseCode`
 *   · a non-numeric `SequenceNumber` is rejected at HTTP 400, before any credential check
 *   · `AllowedPaymentMode` is PIPE-separated known mode codes (`1|10`) — Pine Labs' Cloud
 *     Integration docs give the sample `"1|2"`; commas and unknown codes are refused with
 *     `INVALID PAYMENT MODE RECEIVED` (the UAT terminal refused `1,2,3,4` on 2026-09-12)
 *   · the machine offers ONLY the modes the sale allowed — the page below shows them and offers
 *     just the matching customer actions, so you can SEE the desk's "Pay by" choice land
 *   · the sale's identity is the `PlutusTransactionReferenceID` this service hands back
 *   · re-uploading the same `TransactionNumber` REPLACES the live sale with a new reference
 *   · a sale nobody pays expires on its own after `AutoCancelDurationInMinutes`
 *   · a sale belongs to the MACHINE whose `ClientID` pushed it (one Client ID per machine), so
 *     several machines under one store can be exercised side by side
 *
 * ASSUMPTION, not observed: asking about or cancelling a sale with a DIFFERENT machine's Client ID
 * is answered as if the sale did not exist. Real hardware has only ever been driven with one Client
 * ID; confirm this on two devices before relying on it (see docs/pine-labs.md).
 *
 * Open http://localhost:8201/ to act as the customer: every live sale has buttons to tap a
 * card, decline, or get stuck mid-payment (which is when a cancel must be refused).
 *
 * REFUNDS are their own rows: a `TxnType 3` upload
 * gets its own reference, shows the machine (Client ID) it was sent to and the sale it refunds, and
 * has its own buttons — Approve refund / Decline / Stuck / Expire; a waiting refund can be cancelled.
 * What a REAL terminal answers for a refund has never been observed: this mock answers a refund's
 * status and cancel exactly as it answers a sale's — the assumption the hardware check has to test.
 *
 * It is a DEV TOOL, not a test double: it holds no secrets, accepts any credentials that are
 * present, and must never be pointed at by anything but a local stack.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8201);
/** sales, keyed by the reference we hand out. */
const sales = new Map();
/** Fast expiry so a local run doesn't need patience: 1 "minute" = this many ms. */
const MINUTE_MS = Number(process.env.MOCK_MINUTE_MS ?? 60_000);
let nextRef = 877080;

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (res, body) => json(res, { ResponseCode: 0, ResponseMessage: 'APPROVED', ...body });
const refuse = (res, message) => json(res, { ResponseCode: 1, ResponseMessage: message });

/**
 * Pine Labs payment-mode codes this mock knows (0 = every mode the machine has), with the
 * `PaymentMode` tag a finished sale reports. CARD and UPI SALE are what real sales carried; the
 * others are ASSUMPTIONS — no such sale has been observed on a device. The long tail
 * is generated from the names: a button "Pay by <name>" reporting the name upper-cased.
 */
const MODES = {
  0: { name: 'All modes' },
  1: { name: 'Card', action: 'card', label: 'Tap card', tag: 'CARD' },
  2: { name: 'Cash', action: 'cash', label: 'Pay cash', tag: 'CASH' },
  4: { name: 'Wallets', action: 'wallet', label: 'Pay by wallet', tag: 'WALLET' },
  10: { name: 'UPI', action: 'upi', label: 'Pay by UPI', tag: 'UPI SALE' },
  11: { name: 'UPI QR', action: 'upiqr', label: 'Scan UPI QR', tag: 'UPI BHARAT QR' },
  20: { name: 'Bank EMI', action: 'emi', label: 'Bank EMI', tag: 'BANK EMI' },
};
for (const [code, name] of Object.entries({
  3: 'Points',
  6: 'Brand EMI',
  7: 'Sodexo',
  8: 'PhonePe',
  9: 'Paytm UPI',
  12: 'Airtel Bank',
  19: 'Paper POS',
  21: 'Amazon Pay',
  22: 'Instant discount',
  23: 'Cardless Bank EMI',
  24: 'Cardless Brand EMI',
  25: 'Twid Pay',
  26: 'HDFC Flexipay',
  27: 'Pre-auth',
  28: 'Pre-auth completion',
  29: 'Gifticon',
  30: 'magicpin',
  35: 'NBFC product sale',
  37: 'myEMI',
  39: 'ePayLater',
  40: 'NTB',
  42: 'Zomato Pay',
  43: 'QC Redeem',
  44: 'STELLR POR',
  45: 'STELLR POSA',
  47: 'Swiggy',
})) {
  MODES[code] = { name, action: `m${code}`, label: `Pay by ${name}`, tag: name.toUpperCase() };
}
/** The customer actions a sale's allowed modes permit (`0` permits every one). */
const actionsFor = (modes) =>
  Object.entries(MODES)
    .filter(([code, m]) => m.action && (modes.includes('0') || modes.includes(code)))
    .map(([, m]) => m);

/** Expire a sale nobody paid, exactly as Plutus does when the auto-cancel window elapses. */
function withExpiry(sale) {
  if (sale.state === 'pending' && Date.now() > sale.expiresAt) sale.state = 'expired';
  return sale;
}

/**
 * Numeric, as Plutus means it: a number, or a string of digits — its own docs send `Amount` as a
 * string (`"Amount": "100"`). A uuid is not numeric, and that is the rejection we observed.
 * Returns the value as a number, or `null` when it is not numeric at all.
 */
function asNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function upload(body, res) {
  // Shape first: Plutus rejects a non-numeric sequence number before it authenticates — the UAT
  // terminal answered HTTP 400 for a uuid. A digits-only string is accepted here: whether the real
  // API takes one was never observed, and a mock should not invent a rejection.
  if (asNumeric(body.SequenceNumber) == null) {
    return json(res, { error: 'SequenceNumber must be a number' }, 400);
  }
  if (!body.MerchantID || !body.SecurityToken || !body.ClientID || !body.StoreID) {
    return refuse(res, 'INVALID MERCHANT');
  }
  // PIPE-separated known codes (`1|10`), as Pine Labs documents. A comma list (what a caller may send
  // before, and what the UAT terminal refused as `1,2,3,4`) or an unknown code is refused.
  // A refund (TxnType 3) carries no modes — it goes back to the card of the sale.
  const isRefund = body.TxnType === 3;
  const raw = String(body.AllowedPaymentMode ?? '').trim();
  const modes = isRefund ? [] : raw.split('|').map((m) => m.trim());
  if (!isRefund && (!raw || raw.includes(',') || modes.some((m) => !(m in MODES)))) {
    return refuse(res, 'INVALID PAYMENT MODE RECEIVED');
  }
  // Paise, and Plutus' own sample sends it as a string — take either, refuse what is not a sum.
  const amountPaise = asNumeric(body.Amount);
  if (amountPaise == null || !Number.isInteger(amountPaise) || amountPaise <= 0) {
    return refuse(res, 'INVALID INPUT');
  }

  // A repeat of the same merchant reference REPLACES the live sale — the old one dies.
  for (const [ref, sale] of sales) {
    if (sale.transactionNumber === body.TransactionNumber && sale.state === 'pending') {
      sales.delete(ref);
    }
  }

  const reference = String((nextRef += 1));
  const minutes = Number(body.AutoCancelDurationInMinutes ?? 5);
  sales.set(reference, {
    reference,
    transactionNumber: body.TransactionNumber,
    machine: String(body.ClientID),
    sequenceNumber: body.SequenceNumber,
    amountPaise,
    isRefund,
    modes,
    refundOf: body.TxnType === 3 ? String(body.OriginalPlutusTransactionReferenceID ?? '') : null,
    state: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + minutes * MINUTE_MS,
  });
  return ok(res, { PlutusTransactionReferenceID: Number(reference) });
}

/** The sale a follow-up call names — only if it is asked about on the machine it lives on. */
function saleOnMachine(body) {
  const sale = sales.get(String(body.PlutusTransactionReferenceID));
  const machine = String(body.ClientId ?? body.ClientID ?? '');
  return sale && sale.machine === machine ? sale : undefined;
}

function status(body, res) {
  if (!body.MerchantID || !body.SecurityToken) return refuse(res, 'INVALID MERCHANT');
  if (!body.StoreId && !body.StoreID) return refuse(res, 'INVALID INPUT');
  const sale = saleOnMachine(body);
  if (!sale) return refuse(res, 'INVALID PLUTUS TXN REF ID');

  switch (withExpiry(sale).state) {
    case 'pending':
    case 'in_progress':
      return json(res, {
        ResponseCode: 1001,
        ResponseMessage: 'TXN UPLOADED',
        PlutusTransactionReferenceID: Number(sale.reference),
        TransactionData: null,
      });
    case 'expired':
      return refuse(res, 'INVALID TRANSACTION NUMBER');
    case 'declined':
      return json(res, { ResponseCode: 2, ResponseMessage: 'TXN DECLINED BY ISSUER' });
    case 'approved':
      return json(res, {
        ResponseCode: 0,
        ResponseMessage: 'TXN APPROVED',
        PlutusTransactionReferenceID: Number(sale.reference),
        TransactionData: approvedTags(sale),
      });
    default:
      return refuse(res, 'INVALID PLUTUS TXN REF ID');
  }
}

/**
 * The tag list a finished sale carries — same names, order and quirks as the real one.
 *
 * The CARD tags below are copied from a real approved card sale. The UPI variant is an
 * ASSUMPTION: a UPI capture has not yet been observed on a device, so this mock simply omits
 * the card-specific tags rather than inventing plausible ones. If a UPI sale turns out to
 * carry its own tags (a VPA, a UPI reference), correct this from the real response.
 */
function approvedTags(sale) {
  const rupees = (sale.amountPaise / 100).toFixed(2);
  const when = new Date(sale.paidAt ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const isCard = sale.paymentMode === 'CARD' || sale.paymentMode === 'BANK EMI';
  const cardTags = isCard
    ? [
        { Tag: 'Card Number', Value: '************1634' },
        { Tag: 'Expiry Date', Value: 'XXXX' },
        { Tag: 'Card Type', Value: 'VISA' },
        {
          Tag: 'Txn Details',
          Value: JSON.stringify({
            TxnInfo: {
              BatchId: '21',
              ClientId: sale.machine,
              Roc: '45',
              TxnID: sale.reference,
              TxnType: 'SALE',
            },
            CardInfo: {
              AccountType: 'CREDIT',
              CardCategory: 'CONSUMER',
              CardEntryMode: 'CARD_CLESSCHIP',
              IsDomestic: 'true',
              IssuerId: '5',
              IssuerName: 'AXIS BANK LIMITED',
              Scheme: 'VISA',
            },
          }),
        },
      ]
    : [];
  return [
    { Tag: 'TID', Value: `${sale.machine}0` },
    { Tag: 'MID', Value: '' },
    { Tag: 'PaymentMode', Value: sale.paymentMode ?? 'CARD' },
    { Tag: 'Amount', Value: rupees },
    { Tag: 'AmountInPaisa', Value: String(sale.amountPaise) },
    { Tag: 'OriginalAmount', Value: String(sale.amountPaise) },
    { Tag: 'FinalAmount', Value: String(sale.amountPaise) },
    { Tag: 'BatchNumber', Value: '000021' },
    { Tag: 'RRN', Value: `5256${String(sale.reference).padStart(8, '0')}` },
    { Tag: 'ApprovalCode', Value: '074522' },
    { Tag: 'Invoice Number', Value: String(sale.sequenceNumber).padStart(6, '0') },
    ...cardTags,
    { Tag: 'Acquirer Id', Value: '10' },
    { Tag: 'Acquirer Name', Value: 'ICICI' },
    {
      Tag: 'Transaction Date',
      Value: `${pad(when.getDate())}${pad(when.getMonth() + 1)}${when.getFullYear()}`,
    },
    {
      Tag: 'Transaction Time',
      Value: `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`,
    },
    { Tag: 'TransactionLogId', Value: `55${sale.reference}` },
    { Tag: 'Currency Type', Value: 'INR' },
  ];
}

function cancel(body, res) {
  const sale = saleOnMachine(body);
  if (!sale) return refuse(res, 'TRANSACTION NOT FOUND');
  if (withExpiry(sale).state === 'in_progress') {
    return refuse(res, 'CANNOT CANCEL AS TRANSACTION IS IN PROGRESS');
  }
  if (sale.state !== 'pending') return refuse(res, 'TRANSACTION NOT FOUND');
  sales.delete(sale.reference);
  return ok(res, {});
}

/** The "terminal": whoever opens this page is the customer standing at the counter. */
function controlPage(res) {
  const rows = [...sales.values()].map(withExpiry).sort((a, b) => b.createdAt - a.createdAt);
  const list = rows.length
    ? rows
        .map(
          (s) => `<tr>
        <td><code>${s.reference}</code></td>
        <td><code>${s.machine}</code></td>
        <td>₹${(s.amountPaise / 100).toFixed(2)}${s.isRefund ? ` <em>(refund of ${s.refundOf})</em>` : ''}</td>
        <td>${s.isRefund ? '—' : s.modes.map((m) => MODES[m].name).join(' · ')}</td>
        <td>${s.state.replace('_', ' ')}${s.paymentMode ? ` <em>(${s.paymentMode})</em>` : ''}</td>
        <td>
          <form method="POST" action="/act"><input type=hidden name=ref value="${s.reference}">
            ${
              s.isRefund
                ? `<button name=do value="approve">Approve refund</button>
            <button name=do value="decline">Decline</button>
            <button name=do value="busy">Stuck</button>
            <button name=do value="expire">Expire</button>`
                : `${actionsFor(s.modes)
                    .map((m) => `<button name=do value="${m.action}">${m.label}</button>`)
                    .join('\n            ')}
            <button name=do value="decline">Decline</button>
            <button name=do value="busy">Stuck mid-payment</button>
            <button name=do value="expire">Let it expire</button>`
            }
          </form>
        </td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan=6><em>No sale on the terminal. Push one from your app.</em></td></tr>';

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>Terminal (mock)</title>
<meta http-equiv=refresh content=3>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}button{margin-right:.25rem}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:3px}</style>
<h1>Pine Labs terminal <small>(mock)</small></h1>
<p>Stands in for the card machine. Push a sale from your app, then act as the customer here.</p>
<p>The machine offers only the modes your app allowed for the sale (<code>AllowedPaymentMode</code>) — so
only those customer actions appear.</p>
<table><tr><th>Reference<th>Machine (Client ID)<th>Amount<th>Offers<th>State<th>Act as the customer</tr>${list}</table>`);
}

function act(body, res) {
  const sale = sales.get(String(body.get('ref')));
  if (sale) {
    const action = body.get('do');
    // A refund's approval (the card is credited back).
    if (action === 'approve')
      Object.assign(sale, { state: 'approved', paidAt: Date.now(), paymentMode: 'CARD' });
    // The customer pays by a mode — only one the sale allowed (a hand-made POST can't sneak past).
    const mode = sale.isRefund ? null : actionsFor(sale.modes).find((m) => m.action === action);
    if (mode) Object.assign(sale, { state: 'approved', paidAt: Date.now(), paymentMode: mode.tag });
    if (action === 'decline') sale.state = 'declined';
    if (action === 'busy') sale.state = 'in_progress';
    if (action === 'expire') sale.state = 'expired';
  }
  res.writeHead(303, { location: '/' });
  res.end();
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') return controlPage(res);
    if (req.method === 'POST' && path === '/act') return act(new URLSearchParams(raw), res);

    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, { error: 'malformed body' }, 400);
    }
    const call = path.toLowerCase();
    if (call.endsWith('/uploadbilledtransaction')) return upload(body, res);
    if (call.endsWith('/getcloudbasedtxnstatus')) return status(body, res);
    if (call.endsWith('/canceltransaction')) return cancel(body, res);
    return json(res, { error: `no such Plutus call: ${path}` }, 404);
  });
}).listen(PORT, () => {
  console.log(
    `▸ mock Pine Labs terminal on http://localhost:${PORT} — open it to act as the customer`,
  );
});
