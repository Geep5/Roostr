import { expect, test } from "bun:test";
import { readerOrder, type Inbox } from "./gmail-push";

const inbox = (mailbox: string): Inbox => ({ id: mailbox, mailbox, topic: "t", subscription: "s", watchExpires: 0 });

test("the subscription is read with the sign-in that last worked first, then every other mailbox once", () => {
	const inboxes = [inbox("grant@x.com"), inbox("support@x.com"), inbox("grant@x.com")];
	expect(readerOrder(inboxes)).toEqual(["grant@x.com", "support@x.com"]);
	expect(readerOrder(inboxes, "support@x.com")).toEqual(["support@x.com", "grant@x.com"]);
	// A reader no longer served here is not tried.
	expect(readerOrder(inboxes, "gone@x.com")).toEqual(["grant@x.com", "support@x.com"]);
});
