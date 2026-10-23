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
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function bagLabel(p) {
  if (p.bag_mark_usd != null) return fmtUsd(p.bag_mark_usd);
  // Quote mark without USD (rare) — prefer over raw token count.
  if (p.bag_mark_quote != null && p.bag_mark_quote !== "0") {
    try {
      const q = Number(BigInt(p.bag_mark_quote)) / 1e18;
      const sym = p.pair_symbol || "quote";
      if (Number.isFinite(q) && q > 0) {
        return (
          q.toLocaleString(undefined, { maximumFractionDigits: 6 }) + " " + sym
        );
      }
    } catch {
      /* fall through */
    }
  }
  if (p.tokens) {
    try {
      const d = p.decimals ?? 18;
      const whole = Number(BigInt(p.tokens)) / 10 ** d;
      return (
        whole.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " tok"
      );
    } catch {
      return short(String(p.tokens));
    }
  }
  return "—";
}

function shareLabel(p) {
  const after = p.share_after_cutoff_pct;
  const raw = p.share_pct;
  if (after == null && raw == null) return { text: "—", title: "" };
  const fmt = (n) =>
    Number(n).toLocaleString(undefined, {
      maximumFractionDigits: Number(n) < 1 ? 3 : 2,
    }) + "%";
  const text = after != null ? fmt(after) : fmt(raw);
  const title =
    raw != null && after != null
      ? `raw ${fmt(raw)} → after 1.5% cutoff ${fmt(after)}`
      : raw != null
        ? `raw ${fmt(raw)}`
        : `after cutoff ${fmt(after)}`;
  return { text, title };
}

function linkCell(p) {
  const bits = [];
  if (p.pons_url) {
    bits.push(
      `<a class="ext" href="${esc(p.pons_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Pons</a>`,
    );
  }
  if (p.explorer_token_url) {
    bits.push(
      `<a class="ext" href="${esc(p.explorer_token_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Token</a>`,
    );
  }
  if (p.explorer_buy_url) {
    bits.push(
      `<a class="ext" href="${esc(p.explorer_buy_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Buy</a>`,
    );
  }
  if (p.explorer_claim_url) {
    bits.push(
      `<a class="ext" href="${esc(p.explorer_claim_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Claim</a>`,
    );
  }
  return bits.length ? bits.join(" · ") : "—";
}

function rowOpen(url) {
  if (!url) return "";
  return `class="row-link" tabindex="0" data-href="${esc(url)}" title="Open on Pons"`;
}

function bindRowClicks(tbody) {
  if (!tbody || tbody._bound) return;
  tbody._bound = true;
  tbody.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-href]");
    if (!tr?.dataset.href) return;
    window.open(tr.dataset.href, "_blank", "noopener");
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-href]");
    if (!tr?.dataset.href) return;
    e.preventDefault();
    window.open(tr.dataset.href, "_blank", "noopener");
  });
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
  // Prefer pot heartbeat (near-real-time) over slower networth snapshot age.
  const liveAt = Number(s.heartbeat) || snap?.created_at;
  $("snapAt").textContent = liveAt ? ago(liveAt) + " ago" : "—";

  $("actions").innerHTML = (s.actions || [])
    .map(
      (a) =>
        `<tr>
          <td class="mono">${ago(a.created_at)}</td>
          <td>${esc(a.kind)}</td>
          <td class="mono" title="${esc(a.token || "")}">${short(a.token)}</td>
          <td title="${esc(a.detail || "")}">${esc((a.detail || "").slice(0, 72))}</td>
          <td class="mono">${a.latency_ms != null ? Number(a.latency_ms).toFixed(0) : ""}</td>
        </tr>`,
    )
    .join("");

  $("posBody").innerHTML = (s.positions || [])
    .map((p) => {
      const epoch =
        p.entry_epoch != null || p.current_epoch != null
          ? `${p.entry_epoch ?? "—"}→${p.current_epoch ?? "—"}`
          : "—";
      const name = p.symbol || short(p.token);
      const share = shareLabel(p);
      return `<tr ${rowOpen(p.pons_url)}>
          <td title="${esc(p.token)}"><span class="tok">${esc(name)}</span></td>
          <td>${esc(p.pair_symbol || short(p.pair) || "ETH")}</td>
          <td>${esc(p.strategy || "snipe")}</td>
          <td class="mono">${bagLabel(p)}</td>
          <td class="mono">${fmtUsd(p.pot_usd)}</td>
          <td class="mono" title="${esc(share.title)}">${esc(share.text)}</td>
          <td class="mono">${p.holder_count ?? "—"}</td>
          <td class="mono">${epoch}</td>
          <td class="${p.published ? "yes" : "no"}">${p.published ? "yes" : "no"}</td>
          <td class="${p.payout ? "yes" : "no"}">${p.payout ? "yes" : "no"}</td>
          <td class="mono" title="${p.claim_at ? "last " + ago(p.claim_at) + " ago" : ""}">${fmtUsd(p.claim_usd)}${p.claim_count ? ` (${p.claim_count})` : ""}</td>
          <td class="mono">${fmtUsd(p.cost_usd)}</td>
          <td>${esc(p.phase || "—")}</td>
          <td class="${p.status === "dry" ? "dry" : ""}">${esc(p.status)}</td>
          <td class="links">${linkCell(p)}</td>
        </tr>`;
    })
    .join("");

  $("potBody").innerHTML = (s.held_pools || [])
    .map(
      (p) =>
        `<tr ${rowOpen(p.pons_url)}>
          <td title="${esc(p.token)}"><span class="tok">${esc(p.symbol || short(p.token))}</span></td>
          <td class="mono">${fmtUsd(p.pot_usd)}</td>
          <td class="mono">${p.holder_count ?? "—"}</td>
          <td>${esc(p.phase || "—")}</td>
          <td class="mono">${ago(p.refreshed_at)}</td>
          <td class="links">${linkCell(p)}</td>
        </tr>`,
    )
    .join("");

  bindRowClicks($("posBody"));
  bindRowClicks($("potBody"));
}

refresh();
setInterval(refresh, 2000);
