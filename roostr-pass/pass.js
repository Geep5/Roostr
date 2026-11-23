// Roostr Pass: what the extension does, kept apart from Chrome's events so
// background.js and the popup share it.
//
// Roostr (this computer's harness, through `glon-odin` as Chrome's native
// host) lists every browser login of the person's spaces and whether it needs
// a fresh one (harness/src/pass.ts). For each that does:
// - signed in to its site here: its cookies go to Roostr once - never the
//   same cookies twice, so a login that failed is not sent again;
// - not signed in (or only with cookies Roostr already found dead): the
//   badge asks the person to sign in; the sign-in's cookie change sends it.
// Nothing is sent for a login that needs nothing.

export const HOST = "space.roostr.pass";

/** Ask this computer's Roostr; an answer with `error` when it can't be reached. */
export async function ask(message) {
  try {
    return await chrome.runtime.sendNativeMessage(HOST, message);
  } catch (err) {
    return { error: String(err?.message ?? err), unreachable: true };
  }
}

/** The site a login's cookies live on: its signed-in cookie's host, without www. */
export function siteOf(login) {
  return login.host.replace(/^www\./, "");
}

const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict" };

/** A Chrome cookie as Roostr stores one (the shape Chrome's DevTools gives). */
export function roostrCookie(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.session || c.expirationDate === undefined ? -1 : Math.floor(c.expirationDate),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  };
  const sameSite = SAME_SITE[c.sameSite];
  if (sameSite) out.sameSite = sameSite;
  return out;
}

/** Whether `cookies` hold a live signed-in cookie for `login`. */
export function signedIn(login, cookies, now = Date.now() / 1000) {
  return cookies.some((c) => c.name === login.cookie && (c.expires <= 0 || c.expires > now));
}

async function fingerprint(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signed-in cookie's value, hashed: what "the same cookies" means. */
async function loginPrint(login, cookies) {
  const cookie = cookies.find((c) => c.name === login.cookie);
  return cookie ? fingerprint(`${login.id}:${cookie.value}`) : "";
}

/**
 * One pass over Roostr's logins: send what can be sent, and say for each
 * what the person sees. Returns { error?, logins: [{...login, state}] } with
 * state one of: connected, waiting, sent, sign_in, other_account.
 */
export async function runPass() {
  const watch = await ask({ type: "watch" });
  if (!watch || watch.error) return { error: watch?.error ?? "no answer", unreachable: !!watch?.unreachable, logins: [] };
  const { sent = {} } = await chrome.storage.local.get("sent");
  const out = [];
  for (const login of watch.logins ?? []) {
    if (!login.needs) {
      out.push({ ...login, state: login.waiting ? "waiting" : "connected" });
      continue;
    }
    const cookies = (await chrome.cookies.getAll({ domain: siteOf(login) })).map(roostrCookie);
    if (!signedIn(login, cookies)) {
      out.push({ ...login, state: "sign_in" });
      continue;
    }
    const print = await loginPrint(login, cookies);
    // Sent before and still signed out: these cookies are dead too.
    if (sent[login.id] === print) {
      out.push({ ...login, state: "sign_in" });
      continue;
    }
    const answer = await ask({ type: "cookies", id: login.id, cookies });
    const status = answer?.status;
    if (status === "saved") {
      sent[login.id] = print;
      out.push({ ...login, state: "sent" });
    } else if (status === "waiting" || status === "fine") {
      out.push({ ...login, state: status === "waiting" ? "waiting" : "connected" });
    } else if (status === "other_account") {
      out.push({ ...login, state: "other_account" });
    } else {
      // same, signed_out, or an error: only a new sign-in helps.
      if (status === "same") sent[login.id] = print;
      out.push({ ...login, state: "sign_in", ...(answer?.error ? { problem: answer.error } : {}) });
    }
  }
  await chrome.storage.local.set({ sent });
  return { logins: out };
}

/** How many logins wait on the person. */
export function waitingOnYou(result) {
  return result.logins.filter((l) => l.state === "sign_in" || l.state === "other_account").length;
}
