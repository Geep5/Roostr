import { fetchObject, mutate, setField, str, sv, type AgentEndpoint, type AgentMessage, type MailboxEntry, type ObjectJSON } from "./api";
import { serverOf } from "./machine";

/** A reply addresses the original group, not just the last speaker. */
export function replyRecipients(message: AgentMessage, responder: AgentEndpoint): AgentEndpoint[] {
	const recipients: AgentEndpoint[] = [];
	const indexes = new Map<string, number>();
	for (const endpoint of [message.sender, ...message.recipients]) {
		if (!endpoint.objectId || endpoint.objectId === responder.objectId) continue;
		const index = indexes.get(endpoint.objectId);
		if (index !== undefined) {
			// A human can send from an object and address that object's own
			// agent. Keep its agent endpoint when replying to the group.
			if (!recipients[index].agentId && endpoint.agentId) recipients[index] = { ...endpoint };
			continue;
		}
		indexes.set(endpoint.objectId, recipients.length);
		recipients.push({ ...endpoint });
	}
	return recipients;
}

/** Commit the canonical sender copy; delivery is independently restartable. */
export async function sendMessage(message: AgentMessage): Promise<{ id: string; exchangeId: string; threadId: string }> {
	return await mutate("message_send", { object_id: message.sender.objectId, message }) as {
		id: string; exchangeId: string; threadId: string;
	};
}

const entryOf = (object: ObjectJSON, messageId: string): MailboxEntry | undefined =>
	object.mailbox?.find((entry) => entry.message.id === messageId);

const needsDelivery = (entry: MailboxEntry, recipientId: string): boolean =>
	entry.outgoing && !entry.message.historical &&
	entry.message.recipients.some((recipient) => recipient.objectId === recipientId) &&
	!entry.deliveries.some((delivery) => delivery.recipient.objectId === recipientId && delivery.status === "delivered");

/** The DAG is the queue. A failed request never removes the sender copy. */
export async function deliverOutbox(object: ObjectJSON): Promise<void> {
	const current = await fetchObject(object.id);
	for (const candidate of current.mailbox ?? []) {
		if (!candidate.outgoing || candidate.message.historical) continue;
		for (const recipient of candidate.message.recipients) {
			// A second pump or an earlier ambiguous response may already have
			// delivered this copy. Never decide from the caller's old snapshot.
			const latest = entryOf(await fetchObject(object.id), candidate.message.id);
			if (!latest || !needsDelivery(latest, recipient.objectId)) continue;
			// A recipient nothing serves never processes its inbox: fail the
			// delivery now, with the reason, instead of letting it sit. Only a
			// definitive empty resolution fails - an unreachable resolver
			// delivers normally, because unsure is not unserved.
			const resolved = await serverOf(recipient.objectId).catch(() => null);
			if (resolved !== null && resolved.machineId === "") {
				await mutate("message_delivery_error", {
					object_id: object.id,
					message_id: latest.message.id,
					recipient_object_id: recipient.objectId,
					error: "no machine serves this object",
				});
				continue;
			}
			try {
				await mutate("message_deliver", {
					sender_object_id: object.id,
					message_id: latest.message.id,
					recipient_object_id: recipient.objectId,
				});
			} catch (error) {
				// A lost HTTP response can follow a successful commit. The core
				// also guards this write so a racing success cannot regress.
				const after = entryOf(await fetchObject(object.id), latest.message.id);
				if (!after || !needsDelivery(after, recipient.objectId)) continue;
				await mutate("message_delivery_error", {
					object_id: object.id,
					message_id: latest.message.id,
					recipient_object_id: recipient.objectId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

export async function claimMessage(objectId: string, messageId: string, owner: string): Promise<boolean> {
	const result = await mutate("message_processing", { object_id: objectId, message_id: messageId, status: "processing", owner });
	return result.claimed === true;
}

export async function finishMessage(objectId: string, messageId: string, owner: string, error?: string): Promise<void> {
	await mutate("message_processing", {
		object_id: objectId,
		message_id: messageId,
		status: error === undefined ? "processed" : "failed",
		owner,
		error: error ?? "",
	});
}

export function pendingInbox(object: ObjectJSON, agentId: string): MailboxEntry[] {
	return (object.mailbox ?? []).filter((entry) =>
		entry.incoming && !entry.message.historical && !entry.message.operation &&
		entry.processing.status === "pending" &&
		entry.message.recipients.some((recipient) => recipient.objectId === object.id && recipient.agentId === agentId),
	).sort((a, b) => a.message.sentAt - b.message.sentAt ||
		(a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0));
}

/** Never replay an interrupted side effect without an explicit retry. */
export async function recoverInbox(object: ObjectJSON, owner: string): Promise<void> {
	const current = await fetchObject(object.id);
	for (const candidate of current.mailbox ?? []) {
		if (!candidate.incoming || candidate.message.historical || candidate.processing.status !== "processing" ||
			candidate.processing.owner === owner) continue;
		const latest = entryOf(await fetchObject(object.id), candidate.message.id);
		if (!latest || latest.message.historical || latest.processing.status !== "processing" ||
			latest.processing.owner === owner) continue;
		const interruption = "Interrupted by a harness restart; retry explicitly before running again.";
		try {
			await finishMessage(object.id, latest.message.id, latest.processing.owner, interruption);
		} catch (error) {
			// A completion or ownership change between read and write is not
			// an interruption. Other errors must remain visible to the pump.
			const after = entryOf(await fetchObject(object.id), latest.message.id);
			if (after?.processing.status === "processing" && after.processing.owner === latest.processing.owner) throw error;
		}
		// Surface interrupted agent work without replacing an unrelated human
		// or scheduler error. Human-only inboxes have no agent turn to flag.
		if (!latest.message.operation && latest.message.recipients.some((recipient) =>
			recipient.objectId === object.id && recipient.agentId)) {
			const after = await fetchObject(object.id);
			const receipt = entryOf(after, latest.message.id)?.processing;
			const prefix = `Message ${latest.message.id}: `;
			const existing = str(after.fields, "error");
			if (receipt?.status === "failed" && receipt.owner === latest.processing.owner &&
				receipt.error === interruption && (!existing || existing.startsWith(prefix))) {
				await setField(object.id, "error", sv(`${prefix}${interruption}`));
			}
		}
	}
}
