package glon

// The change-stream frames of `live_publish` and `signal_publish`
// (core/live.odin, core/signal.odin): what local SSE subscribers and the sync
// daemon read. Pure: no store, no sockets.

import "core:encoding/json"
import "core:strings"
import "core:testing"

@(private = "file")
params :: proc(event: string, extra: string = "") -> json.Value {
	body := strings.concatenate({`{"event":`, event, extra, `}`}, context.temp_allocator)
	parsed, _ := json.parse(transmute([]byte)body, parse_integers = true, allocator = context.temp_allocator)
	return parsed
}

@(private = "file")
LIVE :: `{"v":1,"run":"r","agent":"a","object":"o","thread":"t","seq":0,"kind":"step","text":"x","ts":1}`
@(private = "file")
OFFER :: `{"v":1,"type":"offer","from":"m","to":"d","session":"s","role":"host","sdp":"v=0","ts":1,"junk":2}`

@(test)
ephemeral_frames_carry_live_and_signals :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	frame, err := ephemeral_frame("live_publish", params(LIVE))
	testing.expect(t, err == "", err)
	testing.expect_value(t, frame, `data: {"live":{"agent":"a","kind":"step","object":"o","run":"r","seq":0,"text":"x","thread":"t","ts":1,"v":1},"origin":"local","type":"live"}` + "\n\n")
	direct, _ := ephemeral_frame("live_publish", params(LIVE, `,"relay":false`))
	testing.expect(t, strings.contains(direct, `"relay":false`), "a live event sent directly is kept off the relays")

	signal, signal_err := ephemeral_frame("signal_publish", params(OFFER))
	testing.expect(t, signal_err == "", signal_err)
	testing.expect_value(t, signal, `data: {"origin":"local","signal":{"candidate":"","from":"m","mid":"","role":"host","sdp":"v=0","session":"s","to":"d","ts":1,"type":"offer","v":1},"type":"signal"}` + "\n\n")
	relayed, _ := ephemeral_frame("signal_publish", params(OFFER, `,"origin":"relay","space":"space-1"`))
	testing.expect(t, strings.contains(relayed, `"origin":"relay"`) && strings.contains(relayed, `"space":"space-1"`), "a relayed signal names its space")

	_, bad := ephemeral_frame("signal_publish", params(LIVE))
	testing.expect(t, bad != "", "a live event is no signal")
	_, wrong := ephemeral_frame("chat_post", params(LIVE))
	testing.expect(t, wrong != "", "only the ephemeral actions make frames")
}
