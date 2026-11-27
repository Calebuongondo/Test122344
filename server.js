const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ENV = (process.env.DARAJA_ENV || "sandbox").toLowerCase();
const BASE = ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
const transactions = new Map();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
function timestamp() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0") +
    String(d.getHours()).padStart(2,"0") + String(d.getMinutes()).padStart(2,"0") + String(d.getSeconds()).padStart(2,"0");
}
function normalizePhone(input) {
  let p = String(input || "").replace(/[\s()+-]/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("+")) p = p.slice(1);
  if (!/^2547\d{8}$/.test(p)) throw new Error("Enter a valid Kenyan Safaricom number (07..., 01..., or 254...).");
  return p;
}
async function getToken() {
  const key = required("DARAJA_CONSUMER_KEY");
  const secret = required("DARAJA_CONSUMER_SECRET");
  const auth = Buffer.from(key + ":" + secret).toString("base64");
  const res = await fetch(BASE + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + auth }
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.errorMessage || "Could not authenticate with Daraja.");
  return data.access_token;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/pay", async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 150000) {
      return res.status(400).json({ error: "Amount must be a whole number from KES 1 to KES 150,000." });
    }
    const phone = normalizePhone(req.body.phone);
    const shortcode = required("DARAJA_SHORTCODE");
    const passkey = required("DARAJA_PASSKEY");
    const callback = required("DARAJA_CALLBACK_URL");
    if (!callback.startsWith("https://")) throw new Error("Callback URL must use HTTPS.");
    const ts = timestamp();
    const password = Buffer.from(shortcode + passkey + ts).toString("base64");
    const token = await getToken();
    const response = await fetch(BASE + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: ts,
        TransactionType: process.env.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callback,
        AccountReference: "Checkout",
        TransactionDesc: "Checkout payment"
      })
    });
    const data = await response.json();
    if (!response.ok || data.ResponseCode !== "0" || !data.CheckoutRequestID) {
      return res.status(400).json({ error: data.errorMessage || data.ResponseDescription || data.ResponseDesc || "STK Push request failed." });
    }
    transactions.set(data.CheckoutRequestID, {
      checkoutRequestId: data.CheckoutRequestID,
      merchantRequestId: data.MerchantRequestID || null,
      phone, amount, status: "pending", createdAt: Date.now()
    });
    return res.json({ checkoutRequestId: data.CheckoutRequestID, message: data.CustomerMessage || "STK Push sent. Check your phone and enter your M-Pesa PIN." });
  } catch (err) {
    console.error("Payment initiation error:", err.message);
    return res.status(500).json({ error: err.message || "Unable to initiate payment." });
  }
});

app.post("/api/callback", (req, res) => {
  // Acknowledge quickly; callback result is matched by CheckoutRequestID.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) return;
    const payment = transactions.get(cb.CheckoutRequestID);
    if (!payment) return;
    payment.resultCode = cb.ResultCode;
    payment.resultDescription = cb.ResultDesc || "";
    if (Number(cb.ResultCode) === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const value = (name) => items.find(x => x.Name === name)?.Value;
      payment.status = "paid";
      payment.receipt = value("MpesaReceiptNumber") || null;
      payment.amountPaid = value("Amount") || payment.amount;
      payment.transactionDate = value("TransactionDate") || null;
      payment.paidPhone = value("PhoneNumber") || payment.phone;
    } else {
      payment.status = "failed";
    }
  } catch (err) {
    console.error("Callback parse error:", err.message);
  }
});

app.get("/api/payment/:id", (req, res) => {
  const payment = transactions.get(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment reference not found." });
  res.json({ status: payment.status, receipt: payment.receipt || null, resultDescription: payment.resultDescription || null });
});

app.listen(PORT, () => console.log(`Checkout listening on port ${PORT} (${ENV})`));