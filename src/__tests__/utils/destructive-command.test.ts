import { describe, it, expect } from "bun:test";
import { isDestructiveCommand, getDestructiveReason, DESTRUCTIVE_COMMAND_PATTERNS, isSystemPath } from "../../utils/destructive-command";

describe("isDestructiveCommand", () => {
  describe("pattern matching tier", () => {
    it("detects rm -rf / as destructive", () => {
      expect(isDestructiveCommand("rm -rf /")).toBe(true);
      expect(isDestructiveCommand("rm -rf / ")).toBe(true);
    });

    it("detects rm -rf ~ as destructive", () => {
      expect(isDestructiveCommand("rm -rf ~")).toBe(true);
      expect(isDestructiveCommand("rm -rf $HOME")).toBe(true);
    });

    it("detects rm -rf with root glob patterns as destructive", () => {
      // Root glob: rm -rf /*
      expect(isDestructiveCommand("rm -rf /*")).toBe(true);
      // /tmp/* targets /tmp which is a system path, caught by Tier 2 path heuristic
      expect(isDestructiveCommand("rm -rf /tmp/*")).toBe(true);
      // Hidden file glob: rm -rf /.*
      expect(isDestructiveCommand("rm -rf /.*")).toBe(true);
      // Combined flags in various forms
      expect(isDestructiveCommand("rm -fr /*")).toBe(true);
      // Separate -r and -f flags targeting /* is also caught by Tier 2 path heuristic
      expect(isDestructiveCommand("rm -r -f /*")).toBe(true);
    });

    it("detects rm -rf with -- separator targeting root as destructive", () => {
      expect(isDestructiveCommand("rm -rf -- /")).toBe(true);
      expect(isDestructiveCommand("rm -rf -- / ")).toBe(true);
      expect(isDestructiveCommand("rm -- -rf /")).toBe(false); // Flags after --
    });

    it("detects rm -rf with GNU --no-preserve-root as destructive", () => {
      expect(isDestructiveCommand("rm -rf --no-preserve-root /")).toBe(true);
      expect(isDestructiveCommand("rm -rf --no-preserve-root / ")).toBe(true);
      expect(isDestructiveCommand("rm -r --no-preserve-root /")).toBe(true);
      // Even without -rf, targeting / with rm is caught by path heuristic
      expect(isDestructiveCommand("rm --no-preserve-root /")).toBe(true);
    });

    it("detects rm with variable expansion targeting root as destructive", () => {
      expect(isDestructiveCommand("rm -rf ${HOME}")).toBe(true);
      expect(isDestructiveCommand("rm -rf ${HOME}/")).toBe(true);
      expect(isDestructiveCommand("rm -rf ${USER}/*")).toBe(true);
      expect(isDestructiveCommand("rm -rf $HOME")).toBe(true);
    });

    it("detects chmod/chown with glob patterns on root as destructive", () => {
      expect(isDestructiveCommand("chmod -R 777 /*")).toBe(true);
      expect(isDestructiveCommand("chmod -R 755 /.*")).toBe(true);
      expect(isDestructiveCommand("chown -R root:root /*")).toBe(true);
      expect(isDestructiveCommand("chown -R nobody /.*")).toBe(true);
      // Non-root paths should not match
      expect(isDestructiveCommand("chmod -R 777 ./src/*")).toBe(false);
    });

    it("detects sudo as destructive", () => {
      expect(isDestructiveCommand("sudo apt install foo")).toBe(true);
      expect(isDestructiveCommand("sudo rm file.txt")).toBe(true);
    });

    it("detects mkfs as destructive", () => {
      expect(isDestructiveCommand("mkfs.ext4 /dev/sda1")).toBe(true);
    });

    it("detects dd to device as destructive", () => {
      expect(isDestructiveCommand("dd if=image.iso of=/dev/sda")).toBe(true);
    });

    it("detects shutdown/reboot as destructive", () => {
      expect(isDestructiveCommand("shutdown -h now")).toBe(true);
      expect(isDestructiveCommand("reboot")).toBe(true);
    });

    it("detects dangerous chmod/chown on system dirs", () => {
      expect(isDestructiveCommand("chmod -R 777 /")).toBe(true);
      expect(isDestructiveCommand("chown -R root /etc")).toBe(true);
      expect(isDestructiveCommand("chmod -R 755 .git")).toBe(true);
    });

    it("detects writes to /dev/sd* as destructive", () => {
      expect(isDestructiveCommand("echo data > /dev/sda")).toBe(true);
    });
  });

  describe("path heuristic tier", () => {
    it("detects rm targeting /etc as destructive", () => {
      expect(isDestructiveCommand("rm /etc/passwd")).toBe(true);
    });

    it("detects rm targeting /usr as destructive", () => {
      expect(isDestructiveCommand("rm -r /usr/local/bin")).toBe(true);
    });

    it("detects mv targeting /var as destructive", () => {
      expect(isDestructiveCommand("mv file.txt /var/log/")).toBe(true);
    });

    it("does NOT flag rm targeting project-local paths", () => {
      expect(isDestructiveCommand("rm src/old-file.ts")).toBe(false);
      expect(isDestructiveCommand("rm -rf node_modules")).toBe(false);
      expect(isDestructiveCommand("rm docs/old.md")).toBe(false);
    });

    it("does NOT flag safe commands", () => {
      expect(isDestructiveCommand("ls -la")).toBe(false);
      expect(isDestructiveCommand("cat file.txt")).toBe(false);
      expect(isDestructiveCommand("echo hello")).toBe(false);
      expect(isDestructiveCommand("date +%Y-%m-%d")).toBe(false);
      expect(isDestructiveCommand("git status")).toBe(false);
      expect(isDestructiveCommand("npm test")).toBe(false);
    });
  });
});

describe("isSystemPath", () => {
  it("identifies root directory as system path", () => {
    expect(isSystemPath("/")).toBe(true);
    expect(isSystemPath("/*")).toBe(true);
    expect(isSystemPath("/.*")).toBe(true);
  });

  it("identifies standard system directories as system paths", () => {
    expect(isSystemPath("/etc")).toBe(true);
    expect(isSystemPath("/etc/passwd")).toBe(true);
    expect(isSystemPath("/usr")).toBe(true);
    expect(isSystemPath("/usr/bin")).toBe(true);
    expect(isSystemPath("/var")).toBe(true);
    expect(isSystemPath("/bin")).toBe(true);
    expect(isSystemPath("/sbin")).toBe(true);
    expect(isSystemPath("/lib")).toBe(true);
    expect(isSystemPath("/boot")).toBe(true);
    expect(isSystemPath("/proc")).toBe(true);
    expect(isSystemPath("/sys")).toBe(true);
    expect(isSystemPath("/dev")).toBe(true);
    expect(isSystemPath("/tmp")).toBe(true);
    expect(isSystemPath("/home")).toBe(true);
    expect(isSystemPath("/root")).toBe(true);
  });

  it("identifies relative escape paths as system paths", () => {
    expect(isSystemPath("../outside")).toBe(true);
    // Arbitrary absolute paths are NOT system paths unless they match known system dirs
    expect(isSystemPath("/some/absolute")).toBe(false);
    // But root-level absolute paths starting with / are system paths
    expect(isSystemPath("/etc/passwd")).toBe(true);
    expect(isSystemPath("/")).toBe(true);
  });

  it("does NOT flag project-local paths", () => {
    expect(isSystemPath("src")).toBe(false);
    expect(isSystemPath("src/file.ts")).toBe(false);
    expect(isSystemPath("./local")).toBe(false);
    expect(isSystemPath("docs/readme.md")).toBe(false);
  });
});

describe("getDestructiveReason", () => {
  it("returns specific message for sudo", () => {
    expect(getDestructiveReason("sudo apt install")).toContain("sudo");
  });

  it("returns specific message for rm -rf on root/home", () => {
    expect(getDestructiveReason("rm -rf /")).toContain("recursively removes");
  });

  it("returns specific message for mkfs/dd", () => {
    expect(getDestructiveReason("mkfs.ext4 /dev/sda1")).toContain("format");
  });

  it("returns specific message for shutdown/reboot", () => {
    expect(getDestructiveReason("shutdown -h now")).toContain("shuts down");
  });

  it("returns system path message for path-based detection", () => {
    expect(getDestructiveReason("rm /etc/passwd")).toContain("/etc/passwd");
  });

  it("returns generic message for pattern match", () => {
    expect(getDestructiveReason(":(){ :|:& };:")).toContain("destructive pattern");
  });
});

describe("DESTRUCTIVE_COMMAND_PATTERNS", () => {
  it("contains at least 10 patterns", () => {
    expect(DESTRUCTIVE_COMMAND_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it("all patterns are valid RegExp", () => {
    for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
