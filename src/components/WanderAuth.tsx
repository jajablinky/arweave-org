import { useEffect, useRef } from "react";
import { WanderConnect } from "@wanderapp/connect";

export default function WanderAuth() {
  const wanderRef = useRef<any>(null);

  useEffect(() => {
    const wander = new (WanderConnect as any)({
      clientId: "FREE_TRIAL",
      ui: { launcher: false },
      showLauncher: false,
      button: true,
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

    const handleWalletLoaded = () => {
      try {
        const w = (window as any).arweaveWallet;
        console.log("[Wander] arweaveWalletLoaded", {
          hasWallet: Boolean(w),
          keys: w ? Object.keys(w) : [],
        });
      } catch {}
    };
    window.addEventListener("arweaveWalletLoaded", handleWalletLoaded);

    // Full connect+permission+upload pipeline exposed for Astro to call
    (window as any).__wanderConnectAndUpload = async () => {
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
        try {
          console.log("subscribing.. flow");
          const wallet: any = (window as any).arweaveWallet;
          const ev: any = wallet?.events;
          const subscribe = ev?.subscribe?.bind(ev) || ev?.on?.bind(ev);
          if (typeof subscribe === "function") {
            subscribe("connect", (p: any) =>
              console.log("[Wander] event: connect", p)
            );
            subscribe("disconnect", (p: any) =>
              console.log("[Wander] event: disconnect", p)
            );
            subscribe("activeAddress", (p: any) =>
              console.log("[Wander] event: activeAddress", p)
            );
            subscribe("permissions", (p: any) =>
              console.log("[Wander] event: permissions", p)
            );
          }
        } catch {}

        // Show a helpful hint if no progress within 15s (common deploy blockers)
        let __progress = false;
        await new Promise((resolve, reject) => {
          if ((window as any).arweaveWallet) return resolve(null);
          const handler = () => {
            window.removeEventListener("arweaveWalletLoaded", handler as any);
            resolve(null);
          };
          window.addEventListener("arweaveWalletLoaded", handler as any, {
            once: true,
          });
          setTimeout(() => {
            window.removeEventListener("arweaveWalletLoaded", handler as any);
            reject(new Error("Timeout waiting for wallet"));
          }, 30000);
        });

        // After load, print wallet info, permissions, and initial address (deploy visibility)
        try {
          const wallet: any = (window as any).arweaveWallet;
          console.log("[Wander] wallet info", {
            name: wallet?.walletName,
            version: wallet?.walletVersion,
          });
          try {
            const perms = (await wallet?.getPermissions?.()) || [];
            console.log("[Wander] current permissions", perms);
          } catch (permsErr) {
            console.warn("[Wander] could not read permissions", permsErr);
          }
          try {
            const addr0 = await wallet?.getActiveAddress?.();
            console.log("[Wander] initial active address", {
              addr: addr0 || null,
            });
          } catch (addrErr) {
            console.warn("[Wander] initial getActiveAddress failed", addrErr);
          }
        } catch {}

        // Ensure an active address exists before requesting permissions
        const waitForActiveAddress = async (timeoutMs = 90000) =>
          new Promise<string>((resolve, reject) => {
            const start = Date.now();
            let attempts = 0;
            const tick = async () => {
              try {
                const addr = await (
                  window as any
                ).arweaveWallet?.getActiveAddress?.();
                attempts += 1;
                if (addr && typeof addr === "string") {
                  console.log("[Wander] active address ready", {
                    addr,
                    attempts,
                  });
                  __progress = true;
                  return resolve(addr);
                }
              } catch {
                // ignore
              }
              if (attempts % 5 === 0) {
                console.log("[Wander] still waiting for active address", {
                  attempts,
                  waitedMs: Date.now() - start,
                });
              }
              if (Date.now() - start > timeoutMs) {
                console.warn("[Wander] waitForActiveAddress timeout", {
                  attempts,
                  waitedMs: Date.now() - start,
                });
                return reject(
                  new Error("Wallet is initializing. Please try again shortly.")
                );
              }
              setTimeout(tick, 750);
            };
            tick();
          });

        setTimeout(() => {
          try {
            if (!__progress && statusEl) {
              statusEl.textContent =
                "Still connecting… If nothing appears, allow pop-ups, enable third‑party cookies, and approve in the wallet UI.";
            }
          } catch {}
        }, 15000);

        if (statusEl) statusEl.textContent = "Setting up wallet...";
        await waitForActiveAddress();

        // Request permissions per docs
        try {
          console.log("[Wander] requesting permissions...");
          const required = [
            "ACCESS_ADDRESS",
            "ACCESS_PUBLIC_KEY",
            "SIGN_TRANSACTION",
            "DISPATCH",
          ];
          const existing =
            (await (window as any).arweaveWallet.getPermissions?.()) || [];
          const need = required.filter((p: string) => !existing.includes(p));
          console.log("[Wander] permissions", { existing, need });
          if (need.length > 0) {
            await (window as any).arweaveWallet.connect(need as any, {
              name: "Arweave.org Uploader",
            });
          } else {
          }
          console.log("[Wander] perms ok");
        } catch (permErr) {
          console.error("[Wander] perm error", permErr);
          throw permErr;
        }

        // Close modal early so user returns to page
        // Try to close the Wander widget/panel as well
        try {
          wanderRef.current?.close?.();
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

        const { default: Arweave } = await import("arweave");
        const arweave = Arweave.init({});
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
        let dispatched = false;
        try {
          if ((window as any).arweaveWallet?.dispatch) {
            if (statusEl) statusEl.textContent = "Dispatching...";
            const res = await (window as any).arweaveWallet.dispatch(tx);
            console.log("[Wander] dispatch result", res);
            if (res && res.id) {
              (tx as any).id = res.id;
              dispatched = true;
            }
          }
        } catch (dErr) {
          // ignore
        }

        if (!dispatched) {
          if (statusEl) statusEl.textContent = "Uploading...";
          // Try chunked uploader then fallback
          try {
            let uploader = await arweave.transactions.getUploader(tx);
            while (!uploader.isComplete) {
              await uploader.uploadChunk();
              const pct = Math.round(uploader.pctComplete * 100) / 100;
              if (statusEl) statusEl.textContent = `Uploading... ${pct}%`;
              if (pct % 10 === 0) {
                console.log("[Wander] upload progress", { pct });
              }
            }
            console.log("[Wander] chunked upload complete");
          } catch (err) {
            console.warn(
              "[Wander] chunked upload failed; falling back to POST",
              err
            );
            const res = await arweave.transactions.post(tx);
            console.log("[Wander] POST upload status", res?.status);
            if (!res?.status || res.status < 200 || res.status >= 300) {
              throw new Error("POST upload failed");
            }
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
          // Ensure widget is closed at the end too
          wanderRef.current?.close?.();
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
      delete (window as any).__wanderConnectAndUpload;
      window.removeEventListener("arweaveWalletLoaded", handleWalletLoaded);
    };
  }, []);

  return null;
}
