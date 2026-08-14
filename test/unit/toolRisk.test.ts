import { describe, expect, it } from "vitest";
import { classifyToolRisk } from "../../src/permissions/toolRisk.js";

describe("classifyToolRisk", () => {
  it("distinguishes writes, ordinary commands, and destructive commands", () => {
    expect(classifyToolRisk("edit", { file_path: "/workspace/a.ts" })).toBe(
      "write",
    );
    expect(classifyToolRisk("run_shell_command", { command: "npm test" })).toBe(
      "command",
    );
    expect(
      classifyToolRisk("run_shell_command", { command: "git reset --hard" }),
    ).toBe("dangerous");
    expect(
      classifyToolRisk("run_shell_command", {
        command: "Remove-Item C:\\work -Recurse",
      }),
    ).toBe("dangerous");
  });
});
