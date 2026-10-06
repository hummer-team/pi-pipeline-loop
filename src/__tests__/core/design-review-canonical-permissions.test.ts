/**
 * 192 Phase 4 (F07/K10): canonical symlink permission boundaries.
 *
 * resolveSymlinkPathStrict must follow PARENT-directory symlinks of
 * not-yet-existing leaves (the F07 probe), and treat broken links / ELOOP /
 * permission problems as hard resolution FAILURES (never "file does not
 * exist" pass-throughs). Guards consume the canonical path, so a lexical
 * match under `linked/…` cannot authorize an out-of-domain write.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSymlinkPathStrict, resolveSymlinkPath } from "../../utils/protect";

describe("192 Phase 4: resolveSymlinkPathStrict (parent-dir coverage)", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-canon-"));
    outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-outside-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("new leaf under a symlinked PARENT resolves to the canonical outside path (F07 probe)", async () => {
    const linked = path.join(root, "linked");
    fs.symlinkSync(outside, linked, "dir");
    const target = path.join(linked, "future.md"); // does not exist yet
    const res = await resolveSymlinkPathStrict(target);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // NOT the lexical root/linked/future.md — the REAL directory wins.
      expect(res.resolved).toBe(path.join(fs.realpathSync(outside), "future.md"));
      expect(res.resolved).not.toBe(path.resolve(target));
    }
  });

  it("chained directory links resolve through the whole chain", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.symlinkSync(outside, a, "dir");
    fs.symlinkSync(a, b, "dir");
    const res = await resolveSymlinkPathStrict(path.join(b, "sub", "deep.md"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved).toBe(path.join(fs.realpathSync(outside), "sub", "deep.md"));
    }
  });

  it("broken link is a resolution FAILURE, not 'nonexistent pass'", async () => {
    const dangling = path.join(root, "dangling.md");
    fs.symlinkSync(path.join(root, "never-exists.md"), dangling, "file");
    // realpath of a dangling link throws ENOENT: must surface as not-ok
    const res = await resolveSymlinkPathStrict(dangling);
    // lstat sees the link itself; realpathSync fails on the missing target
    expect(res.ok).toBe(false);
  });

  it("ELOOP is a resolution FAILURE", async () => {
    const l1 = path.join(root, "l1");
    const l2 = path.join(root, "l2");
    fs.symlinkSync(l2, l1, "dir");
    fs.symlinkSync(l1, l2, "dir");
    const res = await resolveSymlinkPathStrict(path.join(l1, "x.md"));
    expect(res.ok).toBe(false);
  });

  it("existing regular file resolves to its realpath (in-domain stays in-domain)", async () => {
    const real = path.join(root, "real.md");
    fs.writeFileSync(real, "x", "utf-8");
    const res = await resolveSymlinkPathStrict(real);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolved).toBe(fs.realpathSync(real));
  });

  it("legacy wrapper returns canonical for resolvable, lexical for failed", async () => {
    const real = path.join(root, "plain.md");
    fs.writeFileSync(real, "x", "utf-8");
    expect(await resolveSymlinkPath(real)).toBe(fs.realpathSync(real));

    const dangling = path.join(root, "dangling2.md");
    fs.symlinkSync(path.join(root, "missing-target.md"), dangling, "file");
    const wrapped = await resolveSymlinkPath(dangling);
    expect(wrapped).toBe(path.resolve(dangling)); // lexical fallback (compat)
  });
});
