# Razorpay POS — coming soon

Not yet implemented in the mock.

If you are integrating Razorpay's POS terminals and want this, **say so in an issue** — and if you
have observed behaviour (what the device does, as against what the docs say), that is exactly what
makes a mock worth using. The Pine Labs page is the shape we would follow:
[`pine-labs.md`](pine-labs.md).

What we would need to answer faithfully:

- the sale / status / cancel calls and their request shapes
- how an outcome is reported — HTTP status, a body code, or both
- what identifies a sale afterwards, and whether a re-push replaces a live one
- whether a pending sale is distinguishable from a failed one
- how a refund is pushed and confirmed
