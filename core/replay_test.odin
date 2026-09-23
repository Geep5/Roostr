#+build !js
package core

import "core:encoding/base64"
import "core:encoding/json"
import "core:slice"
import "core:testing"

@(test)
replay_legacy_fixture_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	fixtures_value, parse_err := json.parse(#load("replay_fixtures.json"), parse_integers = true)
	testing.expect(t, parse_err == nil, "replay fixtures must parse")
	if parse_err != nil do return
	fixtures, fixtures_ok := fixtures_value.(json.Array)
	testing.expect(t, fixtures_ok)
	if !fixtures_ok do return
	for fixture in fixtures {
		name := json_str(fixture, "name")
		expected, _ := json_field(fixture, "expected")
		wire_changes, _ := json_field(fixture, "changes")
		payload := jobj()
		payload["changes"] = wire_changes
		actual, err := replay_dispatch(json.Object(payload))
		testing.expect(t, err == "", name)
		if err != "" do continue
		testing.expect(t, string(marshal(actual)) == string(marshal(expected)), name)

		// Exercise the native entry point using the same decoded models, twice:
		// layout width normalization must not modify source snapshot fields.
		items := wire_changes.(json.Array)
		changes := make([]Change, len(items))
		for item, i in items {
			change, ok := change_from_json(item)
			testing.expect(t, ok, name)
			changes[i] = change
		}
		for repeat in 0..<2 {
			state, ok := compute_state(changes)
			native: json.Value
			if ok do native = object_to_json_value(&state)
			testing.expect(t, string(marshal(native)) == string(marshal(expected)), name)
		}

		// Input order is not replay order. Reversing the transport batch must
		// preserve FIFO Kahn ordering and timestamp-selected snapshots.
		reversed := make([dynamic]json.Value)
		for i := len(items) - 1; i >= 0; i -= 1 do append(&reversed, items[i])
		payload["changes"] = json.Array(reversed)
		actual, err = replay_dispatch(json.Object(payload))
		testing.expect(t, err == "", name)
		testing.expect(t, string(marshal(actual)) == string(marshal(expected)), name)
	}
}

@(test)
replay_rejects_invalid_boundary_inputs :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	for wire in ([]string{
		`null`,
		`{}`,
		`{"changes":{}}`,
		`{"changes":[null]}`,
		`{"changes":[{"id":"01","objectId":"a","parentIds":["01"],"ops":[],"timestamp":1,"author":""}]}`,
		`{"changes":[{"id":"01","objectId":"a","parentIds":[],"ops":[],"timestamp":1,"author":"","snapshot":{"blocks":[{"id":"a","childrenIds":["b"]},{"id":"b","childrenIds":["a"]}]}}]}`,
	}) {
		payload, parse_err := json.parse(wire)
		testing.expect(t, parse_err == nil)
		_, err := replay_dispatch(payload)
		testing.expect(t, err != "", wire)
	}
}

// A checkpoint built from any ancestry-closed prefix, replayed with the
// remaining tail, must reproduce the full replay: state, heads, and the
// JSON boundary. Legacy in-DAG snapshots are excluded: a checkpoint seeds
// the state, so a later Change.snapshot in the tail is replayed as ops.
@(test)
replay_checkpoint_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	fixtures_value, parse_err := json.parse(#load("replay_fixtures.json"), parse_integers = true)
	testing.expect(t, parse_err == nil, "replay fixtures must parse")
	if parse_err != nil do return
	fixtures := fixtures_value.(json.Array)
	covered_fixtures := 0
	continued_prefixes := 0
	for fixture in fixtures {
		name := json_str(fixture, "name")
		items := json_array(fixture, "changes")
		changes := make([]Change, len(items))
		legacy := false
		for item, i in items {
			change, ok := change_from_json(item)
			testing.expect(t, ok, name)
			legacy ||= change.has_snapshot
			changes[i] = change
		}
		if legacy || len(changes) < 2 do continue
		covered_fixtures += 1
		full, full_ok := compute_state(changes)
		if !full_ok do continue
		expected := string(marshal(object_to_json_value(&full)))

		sorted := topo_sort(changes)
		for k in 1 ..< len(sorted) {
			prefix := make([]Change, k)
			for c, i in sorted[:k] do prefix[i] = c^
			tail := make([]Change, len(sorted) - k)
			for c, i in sorted[k:] do tail[i] = c^
			// Transport order is not replay order.
			slice.reverse(tail)

			partial, pok := compute_state(prefix)
			testing.expect(t, pok, name)
			cp := checkpoint_build(&partial, prefix, 1)
			bytes := encode_checkpoint(cp)
			decoded, dok := decode_checkpoint(bytes)
			testing.expect(t, dok, name)
			testing.expect(t, len(decoded.covered_ids) == k, name)

			// Without the covered originals the tail either provably continues
			// the covered run (same state and heads as full history) or is held
			// back (the checkpoint's own state) - never a merge no full replay
			// would produce. The full-history replay always matches.
			continues := checkpoint_tail_continues(tail, &decoded)
			if continues do continued_prefixes += 1
			expected_partial := expected
			expected_heads := string(marshal(heads_json(full.heads)))
			if !continues {
				alone, _ := compute_state(nil, checkpoint = &decoded)
				expected_partial = string(marshal(object_to_json_value(&alone)))
				expected_heads = string(marshal(heads_json(alone.heads)))
			}
			resumed, rok := compute_state(tail, checkpoint = &decoded)
			testing.expect(t, rok, name)
			testing.expectf(t, string(marshal(object_to_json_value(&resumed))) == expected_partial, "%s: prefix %d state", name, k)
			testing.expectf(t, string(marshal(heads_json(resumed.heads))) == expected_heads, "%s: prefix %d heads", name, k)

			// Covered changes handed back alongside the tail are skipped, not replayed twice.
			resumed_all, aok := compute_state(changes, checkpoint = &decoded)
			testing.expect(t, aok, name)
			testing.expectf(t, string(marshal(object_to_json_value(&resumed_all))) == expected, "%s: prefix %d with covered", name, k)

			// Same result through the JSON boundary the browser uses.
			payload := jobj()
			tail_json := make([dynamic]json.Value)
			for c in tail do append(&tail_json, change_to_json(c, ordered = true))
			payload["changes"] = json.Array(tail_json)
			payload["checkpoint"] = json.String(base64.encode(bytes))
			actual, err := replay_dispatch(json.Object(payload))
			testing.expectf(t, err == "", "%s: prefix %d dispatch %s", name, k, err)
			testing.expectf(t, string(marshal(actual)) == expected_partial, "%s: prefix %d dispatch state", name, k)
		}
	}
	testing.expect(t, covered_fixtures > 0, "fixtures without legacy snapshots must exist")
	testing.expect(t, continued_prefixes > 0, "ordinary prefixes continue exactly")
}

heads_json :: proc(heads: [dynamic]string) -> json.Value {
	out := make([dynamic]json.Value)
	for h in heads do append(&out, json.String(h))
	return json.Array(out)
}

// Two devices fork after the checkpoint: the checkpoint-only device must see
// both branches as tail and report both heads, exactly like a full-history one.
@(test)
replay_checkpoint_concurrent_branches :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	changes_json, perr := json.parse(`[
		{"id":"0101","objectId":"o","parentIds":[],"ops":[{"objectCreate":{"typeKey":"page"}}],"timestamp":1,"author":"a"},
		{"id":"0202","objectId":"o","parentIds":["0101"],"ops":[{"fieldSet":{"key":"base","value":{"intValue":1}}}],"timestamp":2,"author":"a"},
		{"id":"0303","objectId":"o","parentIds":["0202"],"ops":[{"fieldSet":{"key":"left","value":{"intValue":3}}}],"timestamp":3,"author":"a"},
		{"id":"0404","objectId":"o","parentIds":["0202"],"ops":[{"fieldSet":{"key":"right","value":{"intValue":4}}}],"timestamp":4,"author":"b"}
	]`, parse_integers = true)
	testing.expect(t, perr == nil)
	items := changes_json.(json.Array)
	changes := make([]Change, len(items))
	for item, i in items do changes[i], _ = change_from_json(item)

	full, _ := compute_state(changes)
	prefix, _ := compute_state(changes[:2])
	cp := checkpoint_build(&prefix, changes[:2], 1)
	// A device that only ever saw the checkpoint and the two forks.
	resumed, ok := compute_state(changes[2:], checkpoint = &cp)
	testing.expect(t, ok)
	testing.expect(t, string(marshal(object_to_json_value(&resumed))) == string(marshal(object_to_json_value(&full))))
	testing.expect(t, len(resumed.heads) == 2 && resumed.heads[0] == "0303" && resumed.heads[1] == "0404", "both forks are heads")
	// A device that saw only one fork keeps the checkpoint head out: 0303 built on it.
	one, _ := compute_state(changes[2:3], checkpoint = &cp)
	testing.expect(t, len(one.heads) == 1 && one.heads[0] == "0303")
	// No tail at all: the checkpoint's heads are the heads.
	none, nok := compute_state(nil, checkpoint = &cp)
	testing.expect(t, nok && len(none.heads) == 1 && none.heads[0] == "0202")

	// Store rule: a superset wins regardless of created_at; a subset never does.
	older_bigger := checkpoint_build(&full, changes, 0)
	testing.expect(t, checkpoint_supersedes(&older_bigger, "00", &cp, "ff"))
	testing.expect(t, !checkpoint_supersedes(&cp, "ff", &older_bigger, "00"))
	// Two devices checkpoint different forks: neither contains the other, so
	// neither displaces the other - a bigger covered set is not a newer one.
	left_state, _ := compute_state(changes[:3])
	left := checkpoint_build(&left_state, changes[:3], 3)
	right_changes := []Change{changes[0], changes[1], changes[3]}
	right_state, _ := compute_state(right_changes)
	right := checkpoint_build(&right_state, right_changes, 3)
	testing.expect(t, !checkpoint_supersedes(&left, "ff", &right, "00"), "incomparable forks never supersede")
	testing.expect(t, !checkpoint_supersedes(&right, "ff", &left, "00"), "incomparable forks never supersede")
	testing.expect(t, checkpoint_supersedes(&older_bigger, "00", &left, "ff") && checkpoint_supersedes(&older_bigger, "00", &right, "ff"), "the merge covers both")
	// Replay under the other fork's checkpoint: the closed history this
	// replica holds is real; the checkpoint is another branch and is ignored.
	held, hok := compute_state(changes[:3], checkpoint = &right)
	testing.expect(t, hok)
	testing.expect(t, string(marshal(object_to_json_value(&held))) == string(marshal(object_to_json_value(&left_state))), "held closed history wins over an unrelated checkpoint")
	// Missing a parent, the same replica cannot stand on its own: the checkpoint stands alone.
	orphaned, ook := compute_state(changes[2:3], checkpoint = &right)
	testing.expect(t, ook && string(marshal(object_to_json_value(&orphaned))) == string(marshal(object_to_json_value(&right_state))))
}

// Kahn order is not stable under extension: a concurrent change with a
// smaller id that arrives AFTER the checkpoint sorts before covered changes in
// a full replay. A full-history peer detects this (checkpoint_is_prefix) and
// replays from genesis; a peer without the covered originals cannot prove the
// order (checkpoint_tail_continues) and shows the checkpoint state alone
// rather than a merge no full replay would produce.
@(test)
replay_checkpoint_detects_late_concurrent_change :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	changes_json, perr := json.parse(`[
		{"id":"0101","objectId":"o","parentIds":[],"ops":[{"objectCreate":{"typeKey":"page"}}],"timestamp":1,"author":"a"},
		{"id":"0909","objectId":"o","parentIds":["0101"],"ops":[{"fieldSet":{"key":"winner","value":{"stringValue":"covered"}}}],"timestamp":2,"author":"a"},
		{"id":"0505","objectId":"o","parentIds":["0101"],"ops":[{"fieldSet":{"key":"winner","value":{"stringValue":"late"}}}],"timestamp":3,"author":"b"}
	]`, parse_integers = true)
	testing.expect(t, perr == nil)
	items := changes_json.(json.Array)
	changes := make([]Change, len(items))
	for item, i in items do changes[i], _ = change_from_json(item)

	before, _ := compute_state(changes[:2])
	cp := checkpoint_build(&before, changes[:2], 1)
	testing.expect(t, checkpoint_is_prefix(changes[:2], &cp))
	// 0505 < 0909 lexicographically: the full replay applies it first, so
	// "covered" wins there; the tail does not continue the covered run.
	testing.expect(t, !checkpoint_is_prefix(changes, &cp), "late smaller id breaks the prefix")
	testing.expect(t, !checkpoint_tail_continues(changes[2:], &cp), "a smaller concurrent id cannot continue the run")
	full, _ := compute_state(changes)
	resumed, _ := compute_state(changes[2:], checkpoint = &cp)
	full_winner, _ := fields_get(full.fields, "winner")
	resumed_winner, _ := fields_get(resumed.fields, "winner")
	testing.expect(t, full_winner.str == "covered" && resumed_winner.str == "covered", "the checkpoint stands alone instead of a wrong merge")
	testing.expect(t, len(resumed.heads) == 1 && resumed.heads[0] == "0909", "the unapplied tail is not a head yet")
	// A full-history peer holding the same checkpoint replays from genesis.
	with_cp, _ := compute_state(changes, checkpoint = &cp)
	with_winner, _ := fields_get(with_cp.fields, "winner")
	testing.expect(t, with_winner.str == "covered" && len(with_cp.heads) == 2)
	// The next checkpoint, built from full history, heals a checkpoint-only peer.
	next := checkpoint_build(&full, changes, 2)
	healed, _ := compute_state(nil, checkpoint = &next)
	healed_winner, _ := fields_get(healed.fields, "winner")
	testing.expect(t, healed_winner.str == "covered")
	testing.expect(t, checkpoint_supersedes(&next, "00", &cp, "ff"))
	// A tail that builds on the checkpoint's head does continue it.
	after_json, _ := json.parse(`[{"id":"0303","objectId":"o","parentIds":["0909"],"ops":[{"fieldSet":{"key":"winner","value":{"stringValue":"after"}}}],"timestamp":4,"author":"a"}]`, parse_integers = true)
	after, _ := change_from_json(after_json.(json.Array)[0])
	testing.expect(t, checkpoint_tail_continues([]Change{after}, &cp))
	extended, _ := compute_state([]Change{after}, checkpoint = &cp)
	extended_winner, _ := fields_get(extended.fields, "winner")
	testing.expect(t, extended_winner.str == "after" && len(extended.heads) == 1 && extended.heads[0] == "0303")
}
