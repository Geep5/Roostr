// The popup: every Roostr login this Chrome looks after, and what each needs.

const out = document.getElementById("out");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node[key] = value;
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

const STATES = {
  connected: () => el("span", { className: "state ok", textContent: "✓ Connected" }),
  waiting: () => el("span", { className: "state wait", textContent: "Checking the new login…" }),
  sent: () => el("span", { className: "state wait", textContent: "Sent, being checked" }),
  other_account: (login) => el("span", { className: "state", textContent: `Chrome is signed in to another ${login.name} account` }),
  sign_in: (login) =>
    el("button", {
      textContent: `Sign in to ${login.host.replace(/^www\./, "")}`,
      onclick: () => chrome.tabs.create({ url: login.loginUrl }),
    }),
};

function render(result) {
  out.className = "";
  out.replaceChildren();
  if (result.error) {
    const fix = result.unreachable
      ? el("div", {}, "Connect it to Roostr: in the glonOdin folder run ", el("code", { textContent: `./glon-odin pass install ${chrome.runtime.id}` }), ", then reload Roostr Pass.")
      : el("div", { textContent: result.error });
    out.append(el("div", { className: "problem", textContent: "Roostr isn't reachable on this computer." }), fix);
    return;
  }
  if (result.logins.length === 0) {
    out.append(el("div", { className: "empty", textContent: "No browser logins in your Roostr spaces." }));
    return;
  }
  for (const login of result.logins) {
    const sub = login.account || login.host;
    out.append(
      el(
        "div",
        { className: "login" },
        el("div", {}, el("div", { className: "name", textContent: login.name }), el("div", { className: "sub", textContent: sub })),
        (STATES[login.state] ?? STATES.connected)(login),
      ),
    );
  }
}

chrome.runtime.sendMessage({ type: "pass" }).then(render, (err) => render({ error: String(err?.message ?? err), logins: [] }));
