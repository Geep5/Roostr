package core

// Raw DEFLATE (RFC 1951) for pack buckets (pack.odin). Any inflater reads
// it (core:compress/zlib, miniz_oxide, zlib, DecompressionStream
// "deflate-raw"); the compressor is our own so every engine writes the same
// bytes for the same input: roostr-engine's src/deflate.rs is the same
// algorithm, pinned by testdata/record_vectors/pack.json. Changing anything
// here (constants, tie-breaks, block split) changes pack bytes; change both.
//
// - LZ77, greedy: at each position the longest match among the newest
//   DEFLATE_MAX_CHAIN earlier positions with the same 3-byte hash (the
//   nearest wins a tie) within 32 KiB; a match of 3+ bytes is taken, else a
//   literal. Every position covered is inserted into the hash chains.
// - Blocks of DEFLATE_BLOCK_TOKENS tokens, each with dynamic Huffman codes;
//   an empty input is one block holding only end-of-block.
// - Code lengths: Huffman by the two-queue method over symbols sorted by
//   (frequency, symbol), a leaf winning ties against an internal node; when
//   the longest code exceeds the limit (15, or 7 for the code-length code)
//   every non-zero frequency becomes (f + 1) / 2 and the tree is rebuilt.
//   An alphabet with fewer than two used symbols gets the lowest unused ones
//   at frequency 1, so every code is complete.
// - Code lengths are run-length coded with 16 (repeat previous, 3-6), 17
//   (zeros, 3-10) and 18 (zeros, 11-138) over the literal and distance
//   lengths as one sequence; HLIT/HDIST/HCLEN as short as allowed.

DEFLATE_WINDOW :: 32768
DEFLATE_MIN_MATCH :: 3
DEFLATE_MAX_MATCH :: 258
DEFLATE_MAX_CHAIN :: 64
DEFLATE_HASH_BITS :: 15
DEFLATE_BLOCK_TOKENS :: 16384

@(private = "file")
LENGTH_BASE := [29]u16{3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258}
@(private = "file")
LENGTH_EXTRA := [29]u8{0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0}
@(private = "file")
DIST_BASE := [30]u16{1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577}
@(private = "file")
DIST_EXTRA := [30]u8{0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13}
@(private = "file")
CODE_LENGTH_ORDER := [19]u8{16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15}

/** A literal (`dist` 0, `value` the byte) or a match (`value` its length). */
@(private = "file")
Deflate_Token :: struct {
	value: u16,
	dist:  u16,
}

@(private = "file")
Bit_Writer :: struct {
	out: [dynamic]byte,
	acc: u64,
	n:   uint,
}

@(private = "file")
bits_put :: proc(w: ^Bit_Writer, value: u64, count: uint) {
	w.acc |= value << w.n
	w.n += count
	for w.n >= 8 {
		append(&w.out, byte(w.acc))
		w.acc >>= 8
		w.n -= 8
	}
}

@(private = "file")
deflate_hash :: proc(data: []byte, i: int) -> u32 {
	v := u32(data[i]) << 16 | u32(data[i + 1]) << 8 | u32(data[i + 2])
	return (v * 2654435761) >> (32 - DEFLATE_HASH_BITS)
}

@(private = "file")
length_code :: proc(length: int) -> int {
	code := 0
	for code + 1 < len(LENGTH_BASE) && int(LENGTH_BASE[code + 1]) <= length do code += 1
	return code
}

@(private = "file")
dist_code :: proc(dist: int) -> int {
	code := 0
	for code + 1 < len(DIST_BASE) && int(DIST_BASE[code + 1]) <= dist do code += 1
	return code
}

@(private = "file")
deflate_tokens :: proc(data: []byte, allocator := context.temp_allocator) -> [dynamic]Deflate_Token {
	tokens := make([dynamic]Deflate_Token, 0, len(data) / 4 + 16, allocator)
	n := len(data)
	head := make([]i32, 1 << DEFLATE_HASH_BITS, context.temp_allocator)
	for &h in head do h = -1
	prev := make([]i32, n, context.temp_allocator)
	insert :: proc(data: []byte, head, prev: []i32, i: int) {
		h := deflate_hash(data, i)
		prev[i] = head[h]
		head[h] = i32(i)
	}
	i := 0
	for i < n {
		best_len, best_dist := 0, 0
		if i + DEFLATE_MIN_MATCH <= n {
			max_len := min(DEFLATE_MAX_MATCH, n - i)
			cand := int(head[deflate_hash(data, i)])
			for chain := 0; cand >= 0 && i - cand <= DEFLATE_WINDOW && chain < DEFLATE_MAX_CHAIN; chain += 1 {
				// A candidate that differs at best_len cannot beat it.
				if data[cand + best_len] == data[i + best_len] {
					l := 0
					for l < max_len && data[cand + l] == data[i + l] do l += 1
					if l > best_len {
						best_len, best_dist = l, i - cand
						if l == max_len do break
					}
				}
				cand = int(prev[cand])
			}
			insert(data, head, prev, i)
		}
		if best_len >= DEFLATE_MIN_MATCH {
			append(&tokens, Deflate_Token{value = u16(best_len), dist = u16(best_dist)})
			for j in i + 1 ..< i + best_len {
				if j + DEFLATE_MIN_MATCH <= n do insert(data, head, prev, j)
			}
			i += best_len
		} else {
			append(&tokens, Deflate_Token{value = u16(data[i])})
			i += 1
		}
	}
	return tokens
}

/** Length-limited Huffman code lengths for `freq` (see the file comment). */
@(private = "file")
huffman_lengths :: proc(freq: []u32, limit: int, lengths: []u8) {
	f := make([]u64, len(freq), context.temp_allocator)
	used := 0
	for x, s in freq {
		f[s] = u64(x)
		if x > 0 do used += 1
	}
	for s := 0; used < 2 && s < len(f); s += 1 {
		if f[s] == 0 {
			f[s] = 1
			used += 1
		}
	}
	leaves := make([dynamic]int, 0, len(f), context.temp_allocator)
	weight := make([dynamic]u64, 0, 2 * len(f), context.temp_allocator)
	parent := make([dynamic]int, 0, 2 * len(f), context.temp_allocator)
	depth := make([dynamic]int, 0, 2 * len(f), context.temp_allocator)
	for {
		clear(&leaves)
		for x, s in f do if x > 0 do append(&leaves, s)
		// Insertion sort by (frequency, symbol): alphabets are at most 286 symbols.
		for a in 1 ..< len(leaves) {
			for b := a; b > 0; b -= 1 {
				x, y := leaves[b - 1], leaves[b]
				if f[x] < f[y] || (f[x] == f[y] && x < y) do break
				leaves[b - 1], leaves[b] = y, x
			}
		}
		n := len(leaves)
		clear(&weight)
		clear(&parent)
		for s in leaves {
			append(&weight, f[s])
			append(&parent, -1)
		}
		next_leaf, next_inner := 0, n
		pick :: proc(weight: []u64, n: int, next_leaf, next_inner: ^int) -> int {
			if next_leaf^ < n && (next_inner^ >= len(weight) || weight[next_leaf^] <= weight[next_inner^]) {
				next_leaf^ += 1
				return next_leaf^ - 1
			}
			next_inner^ += 1
			return next_inner^ - 1
		}
		for _ in 0 ..< n - 1 {
			a := pick(weight[:], n, &next_leaf, &next_inner)
			b := pick(weight[:], n, &next_leaf, &next_inner)
			append(&weight, weight[a] + weight[b])
			append(&parent, -1)
			parent[a] = len(weight) - 1
			parent[b] = len(weight) - 1
		}
		resize(&depth, len(weight))
		depth[len(weight) - 1] = 0
		longest := 0
		for k := len(weight) - 2; k >= 0; k -= 1 {
			depth[k] = depth[parent[k]] + 1
			if k < n do longest = max(longest, depth[k])
		}
		if longest <= limit {
			for &l in lengths do l = 0
			for s, k in leaves do lengths[s] = u8(depth[k])
			return
		}
		for &x in f do if x > 0 do x = (x + 1) / 2
	}
}

/** Canonical codes (RFC 1951 3.2.2), bit-reversed for LSB-first output. */
@(private = "file")
huffman_codes :: proc(lengths: []u8, codes: []u16) {
	count: [16]int
	for l in lengths do if l > 0 do count[l] += 1
	next: [16]int
	code := 0
	for bits in 1 ..< 16 {
		code = (code + count[bits - 1]) << 1
		next[bits] = code
	}
	for l, s in lengths {
		if l == 0 do continue
		c := next[l]
		next[l] += 1
		rev := 0
		for _ in 0 ..< int(l) {
			rev = rev << 1 | (c & 1)
			c >>= 1
		}
		codes[s] = u16(rev)
	}
}

/** One run-length coded code length: `symbol` 0-18 plus its extra bits. */
@(private = "file")
Length_Run :: struct {
	symbol: u8,
	extra:  u8,
}

@(private = "file")
run_length_code :: proc(lengths: []u8) -> [dynamic]Length_Run {
	out := make([dynamic]Length_Run, context.temp_allocator)
	i := 0
	for i < len(lengths) {
		v := lengths[i]
		run := 1
		for i + run < len(lengths) && lengths[i + run] == v do run += 1
		i += run
		if v == 0 {
			for run >= 11 {
				r := min(run, 138)
				append(&out, Length_Run{18, u8(r - 11)})
				run -= r
			}
			if run >= 3 {
				append(&out, Length_Run{17, u8(run - 3)})
				run = 0
			}
		} else {
			append(&out, Length_Run{v, 0})
			run -= 1
			for run >= 3 {
				r := min(run, 6)
				append(&out, Length_Run{16, u8(r - 3)})
				run -= r
			}
		}
		for ; run > 0; run -= 1 do append(&out, Length_Run{v, 0})
	}
	return out
}

@(private = "file")
deflate_block :: proc(w: ^Bit_Writer, tokens: []Deflate_Token, final: bool) {
	lit_freq: [286]u32
	dist_freq: [30]u32
	for t in tokens {
		if t.dist == 0 {
			lit_freq[t.value] += 1
		} else {
			lit_freq[257 + length_code(int(t.value))] += 1
			dist_freq[dist_code(int(t.dist))] += 1
		}
	}
	lit_freq[256] += 1
	lit_len: [286]u8
	dist_len: [30]u8
	huffman_lengths(lit_freq[:], 15, lit_len[:])
	huffman_lengths(dist_freq[:], 15, dist_len[:])
	n_lit := 257
	for s in 257 ..< 286 do if lit_len[s] > 0 do n_lit = s + 1
	n_dist := 1
	for s in 1 ..< 30 do if dist_len[s] > 0 do n_dist = s + 1

	all := make([]u8, n_lit + n_dist, context.temp_allocator)
	copy(all, lit_len[:n_lit])
	copy(all[n_lit:], dist_len[:n_dist])
	runs := run_length_code(all)
	cl_freq: [19]u32
	for r in runs do cl_freq[r.symbol] += 1
	cl_len: [19]u8
	huffman_lengths(cl_freq[:], 7, cl_len[:])
	n_cl := 4
	for k in 4 ..< 19 do if cl_len[CODE_LENGTH_ORDER[k]] > 0 do n_cl = k + 1

	lit_codes: [286]u16
	dist_codes: [30]u16
	cl_codes: [19]u16
	huffman_codes(lit_len[:], lit_codes[:])
	huffman_codes(dist_len[:], dist_codes[:])
	huffman_codes(cl_len[:], cl_codes[:])

	bits_put(w, final ? 1 : 0, 1)
	bits_put(w, 2, 2)
	bits_put(w, u64(n_lit - 257), 5)
	bits_put(w, u64(n_dist - 1), 5)
	bits_put(w, u64(n_cl - 4), 4)
	for k in 0 ..< n_cl do bits_put(w, u64(cl_len[CODE_LENGTH_ORDER[k]]), 3)
	for r in runs {
		bits_put(w, u64(cl_codes[r.symbol]), uint(cl_len[r.symbol]))
		switch r.symbol {
		case 16: bits_put(w, u64(r.extra), 2)
		case 17: bits_put(w, u64(r.extra), 3)
		case 18: bits_put(w, u64(r.extra), 7)
		}
	}
	for t in tokens {
		if t.dist == 0 {
			bits_put(w, u64(lit_codes[t.value]), uint(lit_len[t.value]))
			continue
		}
		lc := length_code(int(t.value))
		bits_put(w, u64(lit_codes[257 + lc]), uint(lit_len[257 + lc]))
		bits_put(w, u64(int(t.value) - int(LENGTH_BASE[lc])), uint(LENGTH_EXTRA[lc]))
		dc := dist_code(int(t.dist))
		bits_put(w, u64(dist_codes[dc]), uint(dist_len[dc]))
		bits_put(w, u64(int(t.dist) - int(DIST_BASE[dc])), uint(DIST_EXTRA[dc]))
	}
	bits_put(w, u64(lit_codes[256]), uint(lit_len[256]))
}

/** `data` as one raw DEFLATE stream (no zlib header), byte-identical in every engine. */
deflate_compress :: proc(data: []byte, allocator := context.allocator) -> []byte {
	tokens := deflate_tokens(data)
	w := Bit_Writer{out = make([dynamic]byte, 0, len(data) / 2 + 64, allocator)}
	if len(tokens) == 0 do deflate_block(&w, nil, true)
	for start := 0; start < len(tokens); start += DEFLATE_BLOCK_TOKENS {
		end := min(start + DEFLATE_BLOCK_TOKENS, len(tokens))
		deflate_block(&w, tokens[start:end], end == len(tokens))
	}
	if w.n > 0 do append(&w.out, byte(w.acc))
	return w.out[:]
}
