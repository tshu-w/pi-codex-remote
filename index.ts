import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";
import { control, start } from "./src/daemon.mjs";
import { createLiveSessionRegistry } from "./src/live-sessions.mjs";
import { registerRevertCommand } from "./src/revert-command.mjs";

export default function codexRemote(pi: ExtensionAPI) {
  registerRevertCommand(pi);
  const liveSessions = createLiveSessionRegistry();
  pi.on("session_start", (_event, ctx) => {
    liveSessions.register({
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
  pi.on("session_shutdown", (event) => {
    liveSessions.shutdown(event.reason);
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "rpc" || process.env.PI_CODEX_REMOTE_RPC !== "1" || !event.images?.length) return;
    for (const image of event.images) {
      const decoded = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, ctx.model?.inputLimits?.images?.resize).catch(() => null);
      if (!decoded) {
        ctx.ui.notify("Pi Remote rejected image: it could not be decoded within the selected model's image limits.", "error");
        return { action: "handled" };
      }
    }
  });

  pi.registerCommand("codex-remote", {
    description: "Connect ChatGPT to Pi: start, pair, status, stop",
    getArgumentCompletions: (prefix) => {
      const actions = ["start", "pair", "status", "stop"].filter(action => action.startsWith(prefix));
      return actions.length > 0 ? actions.map(action => ({ value: action, label: action })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["start", "pair", "status", "stop"].includes(action)) {
        ctx.ui.notify("Usage: /codex-remote start|pair|status|stop", "error");
        return;
      }
      if (ctx.mode !== "tui" && (action === "start" || action === "pair")) {
        ctx.ui.notify("Enable and pair Codex Remote from a Pi terminal. Remote tasks use Pi's local execution permissions, not Codex sandboxing.", "error");
        return;
      }
      try {
        if (action === "pair") {
          await start();
          const pairing = await control("pair");
          const qr = await QRCode.toString(pairing.url, { type: "terminal", small: true });
          ctx.ui.setWidget("codex-remote-pair", [
            "Codex Remote · scan with your phone",
            ...qr.trimEnd().split("\n"),
            `Manual code: ${pairing.manualCode || "unavailable"}`,
            `Expires: ${pairing.expiresAt}`,
            "Remote tasks run with Pi's local permissions. No Codex sandbox is applied.",
          ]);
          return;
        }
        if (action === "stop") {
          await control("stop");
          ctx.ui.setWidget("codex-remote-pair", undefined);
          ctx.ui.notify("Codex Remote stopping", "info");
          return;
        }
        const status = action === "start" ? await start() : await control("status");
        ctx.ui.notify(`Codex Remote: ${status.status}${status.error ? ` · ${status.error}` : ""}\nLog: ${status.log}`, status.error ? "warning" : "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || "")
          ? "Codex Remote is stopped. Run /codex-remote start."
          : message, "error");
      }
    },
  });
}
