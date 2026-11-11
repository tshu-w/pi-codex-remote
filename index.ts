import { keyHint, resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import QRCode from "qrcode";
import { codeVersion, control, paths, setEnabled, start } from "./src/daemon.mjs";
import { createLiveSessionRegistry } from "./src/live-sessions.mjs";
import { registerRevertCommand } from "./src/revert-command.mjs";

// The code this Pi loaded; a daemon running other code is asked to retire.
const version = codeVersion().then(value => ({ value }), error => ({ error }));

export default function codexRemote(pi: ExtensionAPI) {
  registerRevertCommand(pi);
  const liveSessions = createLiveSessionRegistry();
  pi.on("model_select", (_event, ctx) => {
    const p = paths();
    if (!existsSync(p.enabled) || !existsSync(p.socket)) return;
    void control("settingsChanged", p, { sessionId: ctx.sessionManager.getSessionId() }).catch(() => {});
  });
  pi.on("session_start", (_event, ctx) => {
    liveSessions.register({
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (ctx.mode === "rpc" && process.env.PI_CODEX_REMOTE_RPC === "1") {
      ctx.ui.setStatus("codex-remote-model-scope", JSON.stringify(ctx.scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id }))));
    } else if (existsSync(paths().enabled)) {
      // An enabled daemon that is down starts again; when it runs, this is one status request.
      void (async () => {
        const loaded = await version;
        if ("error" in loaded) throw loaded.error;
        const status = await start({ auto: true });
        if (status?.version && status.version !== loaded.value) await control("retire", undefined, { version: loaded.value });
      })().catch((error: Error) => {
        if (ctx.mode === "tui") ctx.ui.notify(`Codex Remote did not start: ${error.message}`, "warning");
      });
    }
  });
  pi.on("session_shutdown", (event) => {
    liveSessions.shutdown(event.reason);
  });

  pi.on("input", async (event, ctx) => {
    // Codex Remote's input arrives over RPC, from its own Pi or a pi-agents host, so it is not told apart from other RPC clients.
    if (event.source !== "rpc" || !event.images?.length || pi.getSettings().images?.autoResize === false) return;
    for (const image of event.images) {
      const decoded = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, ctx.model?.inputLimits?.images?.resize).catch(() => null);
      if (!decoded) {
        ctx.ui.notify("Codex Remote rejected image: it could not be decoded within the selected model's image limits.", "error");
        return { action: "handled" };
      }
    }
  });

  pi.registerCommand("codex-remote", {
    description: "Connect ChatGPT to Pi: start, pair, status, stop",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "start", label: "start", description: "Start the background daemon" },
        { value: "pair", label: "pair", description: "Pair a device" },
        { value: "status", label: "status", description: "Show daemon and connection status" },
        { value: "stop", label: "stop", description: "Stop the background daemon" },
      ].filter(item => item.value.startsWith(prefix.trim()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["start", "pair", "status", "stop"].includes(action)) {
        ctx.ui.notify("Usage: /codex-remote start|pair|status|stop", "error");
        return;
      }
      if (ctx.mode !== "tui" && (action === "start" || action === "pair")) {
        ctx.ui.notify("Enable and pair Codex Remote from a Pi terminal.", "error");
        return;
      }
      let loader: Loader | undefined;
      if (ctx.mode === "tui") {
        const message = action === "status" ? "Checking Codex Remote status…"
          : action === "stop" ? "Stopping Codex Remote…" : "Starting Codex Remote…";
        ctx.ui.setWidget("codex-remote-progress", (tui, theme) => {
          loader = new Loader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), message);
          return Object.assign(loader, { dispose: () => loader?.stop() });
        });
      }
      try {
        if (action !== "status") await setEnabled(action !== "stop");
        if (action === "pair") {
          await start();
          loader?.setMessage("Preparing pairing code…");
          const pairing = await control("pair");
          const qr = await QRCode.toString(pairing.url, { type: "terminal", small: true });
          ctx.ui.setWidget("codex-remote-progress", undefined);
          // The code closes when the phone uses it or it expires, or on Esc or Enter.
          const outcome = await ctx.ui.custom<"paired" | "expired" | undefined>((_tui, _theme, keybindings, done) => {
            const poll = setInterval(() => {
              void control("pairStatus", undefined, { pairingCode: pairing.pairingCode }).then(({ claimed }) => { if (claimed) done("paired"); }, () => {});
            }, 2000);
            const expiry = setTimeout(() => done("expired"), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
            const lines = [
              "Codex Remote · scan to pair",
              ...qr.trimEnd().split("\n"),
              `Manual code: ${pairing.manualCode || "unavailable"}`,
              `Expires: ${new Date(pairing.expiresAt).toLocaleString(undefined, { timeZoneName: "short" })}`,
              "Codex Remote tasks use Pi's local permissions, without Codex sandboxing.",
              `(${keyHint("tui.select.cancel", "to close")})`,
            ];
            return {
              render: (width: number) => lines.map(line => truncateToWidth(` ${line}`, width)),
              invalidate() {},
              handleInput(data: string) {
                if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) done(undefined);
              },
              dispose() { clearInterval(poll); clearTimeout(expiry); },
            };
          });
          if (outcome === "paired") ctx.ui.notify("Codex Remote paired", "info");
          else if (outcome === "expired") ctx.ui.notify("Pairing code expired. Run /codex-remote pair for a new one.", "warning");
          return;
        }
        if (action === "stop") {
          await control("stop");
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
      } finally {
        if (ctx.mode === "tui") ctx.ui.setWidget("codex-remote-progress", undefined);
      }
    },
  });
}
