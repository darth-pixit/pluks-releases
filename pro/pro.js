// Pluks Pro checkout page.
//
// Flow: pick a currency (by locale, switchable) → POST /orders on the license
// server (which sets the amount) → Razorpay Checkout → POST /verify → show the
// key. When the page was opened from the app (?claim=…), the same claim is
// attached to the order so the app picks the license up by itself.
(function () {
  "use strict";

  // License server (server/pro) URL — paste the Cloud Run function URL here
  // after deploying it. Empty = checkout not open yet (the page says so).
  // Tests inject window.PLUKS_PRO_API instead.
  var DEFAULT_PRO_API = "";
  var PRO_API = (window.PLUKS_PRO_API || DEFAULT_PRO_API).replace(/\/+$/, "");
  var CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";
  var FALLBACK_PRICES = { USD: "$9", INR: "₹799" };
  var CLAIM_RX = /^[A-Za-z0-9_-]{16,64}$/;
  var EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var claim = CLAIM_RX.test(params.get("claim") || "") ? params.get("claim") : null;
  var prices = null;

  function indianVisitor() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return true;
    } catch (e) { /* old browser */ }
    return /-IN$/i.test(navigator.language || "");
  }

  var currency = indianVisitor() ? "INR" : "USD";

  function renderCurrency() {
    var buttons = document.querySelectorAll(".cur-toggle button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].dataset.cur === currency));
    }
    var display = prices && prices[currency] ? prices[currency].display : FALLBACK_PRICES[currency];
    $("buy-amount").textContent = display;
  }

  function showError(msg) {
    var el = $("buy-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function api(path, body) {
    return fetch(PRO_API + path, body === undefined ? { credentials: "omit" } : {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var e = new Error(j && j.error || "http_" + r.status); e.code = j && j.error; throw e; }
        return j;
      });
    });
  }

  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve(window.Razorpay);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = CHECKOUT_JS;
      s.onload = function () { window.Razorpay ? resolve(window.Razorpay) : reject(new Error("no_checkout")); };
      s.onerror = function () { reject(new Error("no_checkout")); };
      document.head.appendChild(s);
    });
  }

  function showSuccess(result) {
    $("buy-form-wrap").hidden = true;
    $("buy-success").hidden = false;
    $("success-email").textContent = result.email || "";
    $("license-box").textContent = result.license;
    $("success-app").hidden = !claim;
    $("buy-success").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function setBusy(busy) {
    $("buy-btn").disabled = busy;
    $("buy-btn").textContent = busy ? "Opening checkout…" : "Buy Pluks Pro";
  }

  function buy(email) {
    if (!PRO_API) {
      showError("Checkout isn't open yet — email parth.dixit@alumni.iitd.ac.in and you'll get a key by hand.");
      return;
    }
    setBusy(true);
    showError("");
    var order;
    api("/orders", { currency: currency, email: email, claim: claim })
      .then(function (o) { order = o; return loadCheckout(); })
      .then(function (Razorpay) {
        var rz = new Razorpay({
          key: order.key_id,
          amount: order.amount,
          currency: order.currency,
          order_id: order.order_id,
          name: order.name,
          description: order.description,
          prefill: { email: order.email },
          notes: { product: "pluks_pro_lifetime" },
          theme: { color: "#FC4C02" },
          modal: { ondismiss: function () { setBusy(false); } },
          handler: function (resp) {
            $("buy-btn").textContent = "Confirming payment…";
            api("/verify", resp)
              .then(showSuccess)
              .catch(function () {
                setBusy(false);
                showError("Payment received, but confirming it failed. Your key will arrive by email within minutes — or use Resend below.");
              });
          },
        });
        rz.on && rz.on("payment.failed", function () {
          setBusy(false);
          showError("The payment didn't go through. You haven't been charged — try again or use another method.");
        });
        rz.open();
      })
      .catch(function (e) {
        setBusy(false);
        showError(
          e && e.code === "bad_email" ? "That email doesn't look right." :
          e && e.message === "no_checkout" ? "Couldn't load the payment window. Check your connection or ad blocker and retry." :
          "Checkout is unavailable right now. Please try again in a minute."
        );
      });
  }

  // ── Wire up ────────────────────────────────────────────────────────────
  var toggles = document.querySelectorAll(".cur-toggle button");
  for (var i = 0; i < toggles.length; i++) {
    toggles[i].addEventListener("click", function (ev) {
      currency = ev.currentTarget.dataset.cur;
      renderCurrency();
    });
  }

  $("buy-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = $("buy-email").value.trim();
    if (!EMAIL_RX.test(email)) { showError("Enter the email your license should go to."); return; }
    buy(email);
  });

  $("copy-btn").addEventListener("click", function () {
    var text = $("license-box").textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { $("copy-btn").textContent = "Copied ✓"; })
      .catch(function () {
        var r = document.createRange();
        r.selectNodeContents($("license-box"));
        var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
  });

  $("resend-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = $("resend-email").value.trim();
    if (!EMAIL_RX.test(email) || !PRO_API) { $("resend-done").hidden = false; return; }
    api("/resend", { email: email }).catch(function () {}).then(function () { $("resend-done").hidden = false; });
  });

  $("buy-from-app").hidden = !claim;
  renderCurrency();
  if (PRO_API) {
    api("/price").then(function (p) { prices = p.prices; renderCurrency(); }).catch(function () {});
  }
})();
