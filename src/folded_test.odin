package glon

// The folded-id index (src/folded.odin): torn-record tolerance and the
// one-time migration from the archive of full change bytes. Import and
// rebase through the index are covered in bases_test. Runs inside
// store_durability_contract: the store is one global.

import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:testing"

@(private = "file")
fake_id :: proc(fill: byte) -> (raw: [32]byte, hex: string) {
	for &b in raw do b = fill
	return raw, strings.repeat(fmt.tprintf("%02x", fill), 32, context.temp_allocator)
}

@(private = "file")
file_size :: proc(path: string) -> i64 {
	info, err := os.stat(path, context.temp_allocator)
	return err == nil ? info.size : -1
}

@(private = "file")
put :: proc(t: ^testing.T, path: string, data: string) {
	testing.expectf(t, os.write_entire_file(path, transmute([]byte)data) == nil, "write %s", path)
}

@(private = "file")
put_in :: proc(t: ^testing.T, dir: string, name: string, data: string) {
	path, _ := filepath.join({dir, name}, context.temp_allocator)
	put(t, path, data)
}

folded_contract :: proc(t: ^testing.T) {
	tmp, _ := os.temp_directory(context.temp_allocator)
	root := fmt.aprintf("%s/glon-folded-%d", tmp, unix_ms())
	os.make_directory(root)
	defer os.remove_all(root)
	store_init(root)
	store_invalidate()

	folded_torn_record(t)
	folded_migration(t)
}

/** A crash mid-append leaves a partial record: reads ignore it, the next append cuts it off. */
@(private = "file")
folded_torn_record :: proc(t: ^testing.T) {
	OBJ :: "obj-torn"
	a, _ := fake_id(0xa1)
	b, _ := fake_id(0xb2)
	c, _ := fake_id(0xc3)
	_, ok := folded_add(OBJ, []Folded_Record{{id = a}})
	testing.expect(t, ok, "first append")
	path := folded_path(OBJ)
	testing.expect_value(t, file_size(path), i64(FOLDED_RECORD_SIZE))

	// Tear a second record after 40 bytes (b's id plus 8 bytes of zeros).
	f, err := os.open(path, {.Write, .Append})
	testing.expect(t, err == nil, "open for tearing")
	torn := transmute([FOLDED_RECORD_SIZE]byte)Folded_Record{id = b}
	os.write(f, torn[:40])
	os.close(f)
	folded_reset() // as after a restart
	got, _ := folded_lookup(OBJ, a)
	testing.expect(t, got, "the whole record reads")
	got, _ = folded_lookup(OBJ, b)
	testing.expect(t, !got, "the torn one does not")

	added, aok := folded_add(OBJ, []Folded_Record{{id = c}, {id = a}})
	testing.expect(t, aok && added == 1, "append past a torn tail; a held id is not repeated")
	testing.expect_value(t, file_size(path), i64(2 * FOLDED_RECORD_SIZE))
	folded_reset()
	for id, i in ([][32]byte{a, c}) {
		got, _ = folded_lookup(OBJ, id)
		testing.expectf(t, got, "record %d survives the torn tail", i)
	}
	got, _ = folded_lookup(OBJ, b)
	testing.expect(t, !got, "the torn record is gone for good")
}

/**
 * archive/<obj>/ folds into the index once: ids that left changes/ and the
 * .rebased mappings; hard links of held changes are not folded. Re-running
 * (crash before the delete) adds nothing; the archive is gone.
 */
@(private = "file")
folded_migration :: proc(t: ^testing.T) {
	OBJ :: "obj-arch"
	gone, gone_hex := fake_id(0x11) // pruned: archive only
	held, held_hex := fake_id(0x22) // still in changes/: a hard link in the archive
	orphan, orphan_hex := fake_id(0x33)
	rebased, rebased_hex := fake_id(0x44)
	parked, parked_hex := fake_id(0x55) // quarantined, awaiting a good copy

	archive := data_dir("archive", OBJ)
	os.make_directory(data_dir("archive", ""))
	os.make_directory(archive)
	put_in(t, archive, strings.concatenate({gone_hex, ".pb"}, context.temp_allocator), "gone-bytes")
	put_in(t, archive, strings.concatenate({held_hex, ".pb"}, context.temp_allocator), "held-bytes")
	put_in(t, archive, strings.concatenate({orphan_hex, ".pb"}, context.temp_allocator), "orphan")
	put_in(t, archive, strings.concatenate({orphan_hex, ".rebased"}, context.temp_allocator), rebased_hex)
	put_in(t, archive, strings.concatenate({parked_hex, ".pb"}, context.temp_allocator), "parked")
	put_in(t, archive, "notes.txt", "junk")
	put_in(t, data_dir("archive", ""), ".DS_Store", "finder")
	os.make_directory(data_dir("changes", ""))
	os.make_directory(data_dir("changes", OBJ))
	put(t, change_file(OBJ, held_hex, ".pb"), "held-bytes")
	quarantine, _ := filepath.join({g_store.root, ".quarantine", OBJ}, context.temp_allocator)
	os.make_directory_all(quarantine)
	put_in(t, quarantine, strings.concatenate({parked_hex, ".pb"}, context.temp_allocator), "parked")

	objects, ids, freed := migrate_archive()
	testing.expect_value(t, objects, 1)
	testing.expect_value(t, ids, 2)
	testing.expect_value(t, freed, i64(len("gone-bytes") + len("orphan") + len(rebased_hex)))
	testing.expect(t, !os.exists(data_dir("archive", "")), "archive/ deleted")
	testing.expect_value(t, file_size(folded_path(OBJ)), i64(2 * FOLDED_RECORD_SIZE))

	folded_reset() // read back from disk
	got, to := folded_lookup(OBJ, gone)
	testing.expect(t, got && to == [32]byte{}, "a pruned id is folded")
	got, to = folded_lookup(OBJ, orphan)
	testing.expect(t, got && to == rebased, "a rebased orphan keeps its mapping")
	got, _ = folded_lookup(OBJ, held)
	testing.expect(t, !got, "a held change's link is not folded")
	got, _ = folded_lookup(OBJ, parked)
	testing.expect(t, !got, "a quarantined change can still be healed")
	testing.expect(t, os.exists(change_file(OBJ, held_hex, ".pb")), "changes/ untouched")

	// Resumed after a crash before the delete: the same names fold to nothing new.
	os.make_directory(data_dir("archive", ""))
	os.make_directory(archive)
	put_in(t, archive, strings.concatenate({gone_hex, ".pb"}, context.temp_allocator), "gone-bytes")
	put_in(t, archive, strings.concatenate({orphan_hex, ".rebased"}, context.temp_allocator), rebased_hex)
	objects, ids, _ = migrate_archive()
	testing.expect_value(t, objects, 1)
	testing.expect_value(t, ids, 0)
	testing.expect_value(t, file_size(folded_path(OBJ)), i64(2 * FOLDED_RECORD_SIZE))
	testing.expect(t, !os.exists(data_dir("archive", "")), "archive/ deleted again")

	// Nothing left: a no-op.
	objects, ids, freed = migrate_archive()
	testing.expect(t, objects == 0 && ids == 0 && freed == 0, "no archive, nothing to do")
}
