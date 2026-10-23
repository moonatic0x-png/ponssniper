const $ = (id) => document.getElementById(id);

function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function short(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - Number(ts)) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function bagLabel(p) {
  if (p.bag_mark_usd != null) return fmtUsd(p.bag_mark_usd);
  if (p.tokens) {
    try {
      const d = p.decimals ?? 18;
      const whole = Number(BigInt(p.tokens)) / 10 ** d;
      return whole.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " tok";
    } catch {
      return short(String(p.tokens));
    }
  }
  return "—";
}

async function refresh() {
  const r = await fetch("/api/state");
  const s = await r.json();
  if (s.readOnly) {
    $("mode").textContent = "READ";
    $("mode").style.color = "#6a9ecf";
  } else {
    $("mode").textContent = s.live ? "LIVE" : "DRY";
    $("mode").style.color = s.live ? "#c45c5c" : "#6fbf7a";
  }
  const ww = $("walletWrap");
  if (s.wallet) {
    ww.classList.remove("hidden");
    $("wallet").textContent = s.wallet;
    $("wallet").title = s.wallet;
  } else {
    ww.classList.add("hidden");
  }

  const snap = s.snapshot;
  $("totalUsd").textContent = snap ? fmtUsd(snap.total_usd) : "—";
  $("claimsUsd").textContent = fmtUsd(s.claims_total_usd);
  $("snapAt").textContent = snap ? ago(snap.created_at) + " ago" : "—";

  $("actions").innerHTML = (s.actions || [])
    .map(
      (a) =>
        `<tr>
          <td class="mono">${ago(a.created_at)}</td>
          <td>${a.kind}</td>
          <td class="mono">${short(a.token)}</td>
          <td>${(a.detail || "").slice(0, 64)}</td>
          <td class="mono">${a.latency_ms != null ? Number(a.latency_ms).toFixed(0) : ""}</td>
        </tr>`,
    )
    .join("");

  $("posBody").innerHTML = (s.positions || [])
    .map(
      (p) =>
        `<tr>
          <td>${p.symbol || short(p.token)}</td>
          <td class="mono">${p.entry_epoch ?? "—"}</td>
          <td class="mono">${p.current_epoch ?? "—"}</td>
          <td class="${p.published ? "yes" : "no"}">${p.published ? "yes" : "no"}</td>
          <td class="${p.payout ? "yes" : "no"}">${p.payout ? "yes" : "no"}</td>
          <td class="mono">${fmtUsd(p.claim_usd)} (${p.claim_count})</td>
          <td class="mono">${bagLabel(p)}</td>
          <td class="mono">${fmtUsd(p.cost_usd)}</td>
          <td class="${p.status === "dry" ? "dry" : ""}">${p.status}</td>
        </tr>`,
    )
    .join("");

  $("potBody").innerHTML = (s.held_pools || [])
    .map(
      (p) =>
        `<tr>
          <td>${p.symbol || short(p.token)}</td>
          <td class="mono">${fmtUsd(p.pot_usd)}</td>
          <td class="mono">${p.holder_count ?? "—"}</td>
          <td>${p.phase || "—"}</td>
          <td class="mono">${ago(p.refreshed_at)}</td>
        </tr>`,
    )
    .join("");
}

refresh();
setInterval(refresh, 4000);
