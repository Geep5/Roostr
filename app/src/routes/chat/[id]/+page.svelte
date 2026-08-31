<script lang="ts">
	/**
	 * Full-screen mobile discussion (Anytype's chat page): header with
	 * back + object name + comment count, messages filling the screen,
	 * composer pinned to the keyboard. The shell tracks visualViewport
	 * height so the composer rides directly above the software keyboard
	 * (100dvh does not follow the iOS keyboard; the viewport does).
	 */
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchObject } from "$lib/api";
	import { onObjectEvent } from "$lib/data.svelte";
	import Discussion from "$lib/components/Discussion.svelte";
	import { objectIcon } from "$lib/icons";

	let object = $state<ObjectJSON>();

	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		object = undefined;
		void fetchObject(id).then((o) => {
			if (page.params.id === id) object = o;
		});
	});

	async function refresh() {
		if (!object) return;
		object = await fetchObject(object.id);
	}

	onMount(() =>
		onObjectEvent((objectId) => {
			if (object && objectId === object.id) void refresh();
		}),
	);

	const prefix = $derived(page.url.pathname.startsWith("/app") ? "/app" : "");
	const comments = $derived.by(() => {
		if (!object) return 0;
		const byId = new Map(object.blocks.map((b) => [b.id, b]));
		const root = byId.get("__discussion__");
		if (!root) return 0;
		return root.childrenIds.filter((cid) => byId.get(cid)?.content.custom?.contentType === "chat").length;
	});

	let shell = $state<HTMLDivElement>();
	onMount(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const fit = () => {
			if (shell) shell.style.height = `${vv.height}px`;
			window.scrollTo(0, 0);
		};
		fit();
		vv.addEventListener("resize", fit);
		vv.addEventListener("scroll", fit);
		return () => {
			vv.removeEventListener("resize", fit);
			vv.removeEventListener("scroll", fit);
		};
	});
</script>

<div class="chat-shell" bind:this={shell}>
	{#if object}
		<header>
			<a class="back" href="{prefix}/object/{object.id}" aria-label="Back">‹</a>
			<div class="head-text">
				<div class="head-name"><span class="head-icon">{objectIcon(object.fields["iconEmoji"]?.stringValue, object.typeKey)}</span> {fieldStr(object.fields, "name") || "Untitled"}</div>
				<div class="head-sub">{comments} comment{comments === 1 ? "" : "s"}</div>
			</div>
			<span class="head-spacer"></span>
		</header>
		<div class="chat-body">
			<Discussion {object} full pagemode onchanged={refresh} />
		</div>
	{/if}
</div>

<style>
	.chat-shell {
		position: fixed;
		inset: 0;
		z-index: 50;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		overflow: hidden;
	}
	header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 10px 12px 8px;
	}
	.back {
		flex: none;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--panel);
		color: var(--fg);
		font-size: 22px;
		line-height: 1;
		text-decoration: none;
	}
	.head-text {
		flex: 1;
		min-width: 0;
		text-align: center;
	}
	.head-name {
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.head-icon {
		font-size: 15px;
	}
	.head-sub {
		font-size: 12px;
		color: var(--muted);
	}
	.head-spacer {
		flex: none;
		width: 40px;
	}
	.chat-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 0 12px calc(8px + env(safe-area-inset-bottom));
	}
</style>
