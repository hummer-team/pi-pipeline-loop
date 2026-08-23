import { describe, it, expect } from "bun:test";
import { isDestructiveCommand, getDestructiveReason, DESTRUCTIVE_COMMAND_PATTERNS } from "../../utils/destructive-command";

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
