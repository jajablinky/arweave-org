import { useEffect, useRef } from "react";
import { WanderConnect } from "@wanderapp/connect";

// Helper types
type GatewayConfig = {
  host: string;
  port?: number;
  protocol?: "http" | "https";
};

// Required wallet permissions for this flow
const REQUIRED_PERMS = [
  "ACCESS_ADDRESS",
  "ACCESS_PUBLIC_KEY",
  "SIGN_TRANSACTION",
  "DISPATCH",
];

// Small logging helpers for consistency
const log = console.log.bind(console);
const warn = console.warn.bind(console);
const error = console.error.bind(console);

// Access injected wallet safely
function getWallet(): any {
  return (window as any).arweaveWallet;
}

// Wait until the wallet API is present on window
async function waitForWalletLoaded(timeoutMs = 30000): Promise<void> {
  if (getWallet()) return;
  await new Promise((resolve, reject) => {
    const handler = () => {
      window.removeEventListener("arweaveWalletLoaded", handler as any);
      resolve(null as any);
    };
    window.addEventListener("arweaveWalletLoaded", handler as any, {
      once: true,
    });
    setTimeout(() => {
      window.removeEventListener("arweaveWalletLoaded", handler as any);
      reject(new Error("Timeout waiting for wallet"));
    }, timeoutMs);
  });
}

// Subscribe to common wallet events if available
function subscribeWalletEvents(): void {
  try {
    const wallet = getWallet();
    const ev: any = wallet?.events;
    const subscribe = ev?.subscribe?.bind(ev) || ev?.on?.bind(ev);
    if (typeof subscribe === "function") {
      const maybeResumeUpload = () => {
        try {
          const hasFile = Boolean(
            (window as any).__selectedFile || (window as any).__fileOk
          );
          const inProgress = Boolean((window as any).__uploadInProgress);
          const wantsResume = (window as any).__resumePending !== false;
          if (hasFile && !inProgress && wantsResume) {
            (window as any).__wanderConnectAndUpload?.();
          }
        } catch {}
      };
      subscribe("connect", (p: any) => {
        log("[Wander] event: connect", p);
        try {
          (window as any).__closeWanderWidget?.();
        } catch {}
        maybeResumeUpload();
      });
      subscribe("disconnect", (p: any) => log("[Wander] event: disconnect", p));
      subscribe("activeAddress", (p: any) => {
        log("[Wander] event: activeAddress", p);
        maybeResumeUpload();
      });
      subscribe("permissions", (p: any) => {
        log("[Wander] event: permissions", p);
        try {
          (window as any).__closeWanderWidget?.();
        } catch {}
        maybeResumeUpload();
      });
    }
  } catch {}
}

// Request required permissions if not already granted
async function ensurePermissions(required: string[]): Promise<void> {
  const wallet = getWallet();
  const existing = (await wallet?.getPermissions?.()) || [];
  const need = required.filter((p) => !existing.includes(p));
  log("[Wander] permissions", { existing, need });
  if (need.length > 0) {
    await wallet.connect(need as any, { name: "Arweave.org Uploader" });
  }
}

// Request permissions (idempotent). Returns true if prompt not needed or granted.
async function requestPermissionsIfNeeded(
  statusEl?: HTMLElement | null
): Promise<boolean> {
  try {
    const wallet = getWallet();
    if (!wallet) return false;
    const existing = (await wallet?.getPermissions?.()) || [];
    const need = REQUIRED_PERMS.filter((p) => !existing.includes(p));
    if (need.length === 0) return true;
    if (statusEl) statusEl.textContent = "Requesting permissions...";
    log("[Wander] requesting permissions", { existing, need });
    await wallet.connect(need as any, { name: "Arweave.org Uploader" });
    return true;
  } catch (permErr) {
    error("[Wander] perm error", permErr);
    throw permErr as any;
  }
}

// Poll until active address appears
async function waitForActiveAddress(timeoutMs = 90000): Promise<string> {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start <= timeoutMs) {
    try {
      const addr = await getWallet()?.getActiveAddress?.();
      attempts += 1;
      if (addr && typeof addr === "string") {
        log("[Wander] active address ready", { addr, attempts });
        return addr;
      }
    } catch {}
    if (attempts % 5 === 0) {
      log("[Wander] still waiting for active address", {
        attempts,
        waitedMs: Date.now() - start,
      });
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  warn("[Wander] waitForActiveAddress timeout", {
    attempts,
    waitedMs: Date.now() - start,
  });
  throw new Error("Wallet is initializing. Please try again shortly.");
}

// Resolve gateway to use (wallet config preferred, fallback to arweave.net)
async function resolveGateway(): Promise<GatewayConfig> {
  let host = "arweave.net";
  let port: number | undefined = 443;
  let protocol: "http" | "https" | undefined = "https";
  try {
    const cfg = (await getWallet()?.getArweaveConfig?.()) || {};
    if (
      typeof cfg?.host === "string" &&
      cfg.host &&
      !/vercel\.app$/i.test(cfg.host)
    )
      host = cfg.host;
    if (typeof cfg?.port === "number") port = cfg.port;
    if (cfg?.protocol === "http" || cfg?.protocol === "https")
      protocol = cfg.protocol;
  } catch {}
  log("[Wander] arweave config", { host, port, protocol });
  return { host, port, protocol };
}

// Initialize arweave instance
async function initArweave(gw: GatewayConfig): Promise<any> {
  const { default: Arweave } = await import("arweave");
  return Arweave.init({ host: gw.host, port: gw.port, protocol: gw.protocol });
}

// Sign transaction with whichever API is available
async function signTransaction(arweave: any, tx: any): Promise<void> {
  try {
    if (arweave?.transactions?.sign) {
      log("[Wander] signing via arweave-js transactions.sign");
      await arweave.transactions.sign(tx);
      return;
    }
    if (getWallet()?.sign) {
      log("[Wander] signing via injected wallet sign");
      await getWallet().sign(tx);
      return;
    }
    throw new Error("No signing method available");
  } catch (e) {
    error("[Wander] sign error", e);
    throw e;
  }
}

// Try dispatch via wallet (sponsored) and return true if dispatched
async function tryDispatch(
  tx: any,
  statusEl?: HTMLElement | null
): Promise<boolean> {
  try {
    if (getWallet()?.dispatch) {
      if (statusEl) statusEl.textContent = "Dispatching...";
      const res = await getWallet().dispatch(tx);
      log("[Wander] dispatch result", res);
      if (res && res.id) {
        tx.id = res.id;
        return true;
      }
    }
  } catch (e) {
    warn("[Wander] dispatch failed, will fallback to direct upload", e);
  }
  return false;
}

// Upload via chunked uploader then POST fallback to the resolved gateway
async function uploadToGateway(
  arweave: any,
  gw: GatewayConfig,
  tx: any,
  statusEl?: HTMLElement | null
): Promise<void> {
  try {
    let uploader = await arweave.transactions.getUploader(tx);
    while (!uploader.isComplete) {
      await uploader.uploadChunk();
      const pct = Math.round(uploader.pctComplete * 100) / 100;
      if (statusEl) statusEl.textContent = `Uploading... ${pct}%`;
      if (pct % 10 === 0) log("[Wander] upload progress", { pct });
    }
    log("[Wander] chunked upload complete");
    return;
  } catch (err) {
    warn("[Wander] chunked upload failed; falling back to POST", err);
  }
  const url = `${gw.protocol}://${gw.host}:${gw.port}/tx`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tx),
    mode: "cors",
  });
  log("[Wander] POST upload status", res.status);
  if (!res.ok) throw new Error("POST upload failed");
}

export default function WanderAuth() {
  const wanderRef = useRef<any>(null);

  useEffect(() => {
    const wander = new (WanderConnect as any)({
      clientId: "FREE_TRIAL",
      ui: { launcher: false },
      showLauncher: false,
      button: false,
    });
    wanderRef.current = wander;
    try {
      console.log("[Wander] init", {
        href: typeof window !== "undefined" ? window.location?.href : "n/a",
        ua: typeof navigator !== "undefined" ? navigator.userAgent : "n/a",
      });
    } catch {}

    // Expose opener on window for imperative usage
    (window as any).__wanderOpen = async () => {
      console.log("[Wander] connect requested");
      try {
        if (typeof wander.connect === "function") {
          console.log("[Wander] calling wander.connect()");
          await wander.connect();
        } else if (typeof wander.open === "function") {
          // Fallback only
          console.log("[Wander] calling wander.open() fallback");
          wander.open();
        }
      } catch (err) {
        console.error("[Wander] connect/open error", err);
      }
    };

    // Provide a global closer so event listeners can close the widget
    (window as any).__closeWanderWidget = () => {
      try {
        wanderRef.current?.close?.();
      } catch {}
      try {
        wanderRef.current?.destroy?.();
      } catch {}
    };

    const handleWalletLoaded = () => {
      try {
        const w = (window as any).arweaveWallet;
        console.log("[Wander] arweaveWalletLoaded", {
          hasWallet: Boolean(w),
          keys: w ? Object.keys(w) : [],
        });
        // If user initiated an upload and wallet just injected, immediately re-request permissions
        // to avoid needing a second click on some deployments.
        if ((window as any).__selectedFile || (window as any).__fileOk) {
          // Fire and forget; __wanderConnectAndUpload will also request perms, but this reduces race conditions.
          requestPermissionsIfNeeded().catch(() => {});
        }
      } catch {}
    };
    window.addEventListener("arweaveWalletLoaded", handleWalletLoaded);

    // Full connect+permission+upload pipeline exposed for Astro to call
    (window as any).__wanderConnectAndUpload = async () => {
      if ((window as any).__uploadInProgress) {
        return;
      }
      (window as any).__uploadInProgress = true;
      const statusEl = document.getElementById(
        "status-el"
      ) as HTMLElement | null;
      const spinnerEl = document.getElementById(
        "upload-spinner"
      ) as HTMLElement | null;
      const checkEl = document.getElementById(
        "uploaded-check"
      ) as HTMLElement | null;
      const storeIconEl = document.getElementById(
        "store-icon"
      ) as HTMLElement | null;
      try {
        console.log("[Wander] flow start");
        try {
          console.log("[Wander] env", {
            href: window.location?.href,
            origin: window.location?.origin,
            hostname: window.location?.hostname,
            userAgent: navigator.userAgent,
            hasWallet: Boolean((window as any).arweaveWallet),
          });
        } catch {}
        if (statusEl) statusEl.textContent = "Connecting...";
        spinnerEl?.classList.remove("hidden");
        storeIconEl?.classList.add("hidden");
        checkEl?.classList.add("hidden");
        console.log("before wallet connecting", (window as any).arweaveWallet);
        // Prefer direct connect over opening UI to reduce popup/cookie issues on deploy
        try {
          if (!(window as any).arweaveWallet && wanderRef.current?.connect) {
            console.log("[Wander] calling wander.connect() (no wallet yet)");
            await wanderRef.current.connect();
          }
        } catch (connErr) {
          console.warn("[Wander] wander.connect failed", connErr);
        }
        // Subscribe to wallet events for extra visibility (if available)
        subscribeWalletEvents();

        // Show a helpful hint if no progress within 15s (common deploy blockers)
        let __progress = false;
        await waitForWalletLoaded();

        // After load, print wallet info, permissions, and initial address (deploy visibility)
        try {
          const wallet: any = getWallet();
          log("[Wander] wallet info", {
            name: wallet?.walletName,
            version: wallet?.walletVersion,
          });
          try {
            const perms = (await wallet?.getPermissions?.()) || [];
            log("[Wander] current permissions", perms);
          } catch (permsErr) {
            warn("[Wander] could not read permissions", permsErr);
          }
          try {
            const addr0 = await wallet?.getActiveAddress?.();
            log("[Wander] initial active address", { addr: addr0 || null });
          } catch (addrErr) {
            warn("[Wander] initial getActiveAddress failed", addrErr);
          }
        } catch {}

        // Ensure an active address exists before requesting permissions
        const waitForActive = async () => {
          const addr = await waitForActiveAddress();
          __progress = true;
          return addr;
        };

        setTimeout(() => {
          try {
            if (!__progress && statusEl) {
              statusEl.textContent =
                "Still connecting… If nothing appears, allow pop-ups, enable third‑party cookies, and approve in the wallet UI.";
            }
          } catch {}
        }, 15000);

        // Request permissions first (do NOT call getActiveAddress before permission)
        await requestPermissionsIfNeeded(statusEl);

        // Now ensure an active address exists (should succeed post-permission)
        if (statusEl) statusEl.textContent = "Setting up wallet...";
        await waitForActive();

        // Close modal early so user returns to page
        // Try to close the Wander widget/panel as well
        try {
          (window as any).__closeWanderWidget?.();
        } catch {}
        const earlyModal = document.getElementById("wallet-modal");
        if (earlyModal) {
          earlyModal.classList.remove("flex");
          earlyModal.classList.add("hidden");
        }

        const file: File | undefined = (window as any).__selectedFile;
        if (!file) throw new Error("No file selected");
        console.log("[Wander] using file", {
          name: file?.name,
          size: file?.size,
          type: file?.type,
        });

        const gw = await resolveGateway();
        const arweave = await initArweave(gw);
        const data = new Uint8Array(await file.arrayBuffer());
        let tx = await arweave.createTransaction({ data });
        if (file.type) {
          tx.addTag("Content-Type", file.type);
        }
        try {
          if ((arweave as any).transactions?.sign) {
            console.log("[Wander] signing via arweave-js transactions.sign");
            await (arweave as any).transactions.sign(tx);
          } else if ((window as any).arweaveWallet?.sign) {
            console.log("[Wander] signing via injected wallet sign");
            await (window as any).arweaveWallet.sign(tx);
          } else {
            throw new Error("No signing method available");
          }
        } catch (signErr) {
          console.error("[Wander] sign error", signErr);
          throw signErr;
        }

        // Some wallets may not populate tx.id; derive from signature if needed
        try {
          if (!tx.id && (tx as any).signature) {
            const sigB = arweave.utils.b64UrlToBuffer((tx as any).signature);
            const hash = await arweave.crypto.hash(sigB);
            const derivedId = arweave.utils.bufferTob64Url(hash);
            (tx as any).id = derivedId;
          }
        } catch (deriveErr) {
          // ignore
        }

        const isSigned =
          Boolean((tx as any).signature) &&
          typeof tx.id === "string" &&
          tx.id.length > 0;
        if (!isSigned) {
          throw new Error("Transaction is not signed");
        }
        console.log("[Wander] tx signed", {
          id: (tx as any).id,
          dataSize: (tx as any).data_size,
        });

        // Prefer wallet.dispatch for sponsored FREE_TRIAL flows
        const dispatched = await tryDispatch(tx, statusEl);

        if (!dispatched) {
          if (statusEl) statusEl.textContent = "Uploading...";
          // Try chunked uploader then fallback
          try {
            let uploader = await arweave.transactions.getUploader(tx);
            while (!uploader.isComplete) {
              await uploader.uploadChunk();
              const pct = Math.round(uploader.pctComplete * 100) / 100;
              if (statusEl) statusEl.textContent = `Uploading... ${pct}%`;
              if (pct % 10 === 0) log("[Wander] upload progress", { pct });
            }
            log("[Wander] chunked upload complete");
          } catch (err) {
            warn("[Wander] chunked upload failed; falling back to POST", err);
            await uploadToGateway(arweave, gw, tx, statusEl);
          }
        }

        const txId = tx.id;
        const linkEl = document.getElementById("view-link");
        const addrEl = document.getElementById("address-el");
        linkEl?.setAttribute("href", `https://arweave.net/${txId}`);
        if (addrEl) addrEl.textContent = txId;
        if (statusEl) statusEl.textContent = "File Uploaded";
        spinnerEl?.classList.add("hidden");
        storeIconEl?.classList.remove("hidden");
        checkEl?.classList.remove("hidden");

        // notify page that tx succeeded so it can enable Step 2
        try {
          (window as any).__onTxSuccess?.();
        } catch {}

        // Close modal
        const modal = document.getElementById("wallet-modal");
        if (modal) {
          modal.classList.remove("flex");
          modal.classList.add("hidden");
        }
        try {
          (window as any).__closeWanderWidget?.();
        } catch {}
        console.log("[Wander] uploaded", txId);
      } catch (e: any) {
        try {
          console.error("[Wander] failed", {
            name: e?.name,
            message: e?.message,
            stack: e?.stack,
            cause: e?.cause,
          });
        } catch {
          console.error("[Wander] failed", e);
        }
        if (statusEl) statusEl.textContent = e?.message || "Upload failed";
        spinnerEl?.classList.add("hidden");
        storeIconEl?.classList.remove("hidden");
        checkEl?.classList.add("hidden");
        const msg = String(e?.message || e || "");
        if (/No wallets added/i.test(msg)) {
          (window as any).__resumePending = true;
          if (statusEl) statusEl.textContent = "Finalizing wallet setup…";
        } else {
          (window as any).__resumePending = false;
        }
      } finally {
        (window as any).__uploadInProgress = false;
      }
    };

    // Global diagnostic handlers (no-op if already set)
    try {
      if (!(window as any).__wanderGlobalErrHandlers) {
        window.addEventListener("error", (ev) => {
          console.error(
            "[Global] window.onerror",
            ev?.error || ev?.message || ev
          );
        });
        window.addEventListener("unhandledrejection", (ev: any) => {
          console.error("[Global] unhandledrejection", ev?.reason || ev);
        });
        (window as any).__wanderGlobalErrHandlers = true;
      }
    } catch {}

    return () => {
      try {
        wander?.destroy?.();
      } catch {}
      wanderRef.current = null;
      delete (window as any).__wanderOpen;
      delete (window as any).__closeWanderWidget;
      delete (window as any).__wanderConnectAndUpload;
      window.removeEventListener("arweaveWalletLoaded", handleWalletLoaded);
    };
  }, []);

  return null;
}
