/**
 * @module request-bash-permission
 * Tool that lets the model request temporary bash command permissions from
 * the user.  When the user approves, the command prefix is added to the
 * session-level tempAllowedBash list.
 */

import type { Tool } from "../types";

export function createRequestBashPermission(): Tool {
  return {
    name: "request_bash_permission",
    description:
      "Request permission to execute a bash command not in the current allowlist. " +
      "Call this AFTER the user has approved the command in chat. " +
      "The approved prefix will be added to a session-level temporary whitelist.",
    parameters: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "The bash command prefix to allow (e.g. 'pip install')",
        },
      },
      required: ["prefix"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const prefix = args.prefix as string;
      if (!prefix || typeof prefix !== "string") {
        return { success: false, error: 'Missing required parameter "prefix"' };
      }

      const meta = ctx?.session?.getMeta?.();
      if (!meta) {
        return { success: false, error: "No session metadata available" };
      }

      const tempList: string[] = meta.tempAllowedBash || [];
      if (!tempList.includes(prefix)) {
        tempList.push(prefix);
      }

      ctx.session.updateMeta({ ...meta, tempAllowedBash: tempList });
      return {
        success: true,
        message: `Bash prefix "${prefix}" has been temporarily allowed for this session.`,
      };
    },
  };
}
