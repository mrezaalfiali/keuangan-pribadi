"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function subscribeStandalone(callback: () => void) {
  const mql = window.matchMedia("(display-mode: standalone)");
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getStandaloneSnapshot() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function getStandaloneServerSnapshot() {
  return false;
}

export function PwaInstallPrompt() {
  const isStandalone = useSyncExternalStore(
    subscribeStandalone,
    getStandaloneSnapshot,
    getStandaloneServerSnapshot
  );

  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    if (isStandalone) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [isStandalone]);

  if (isStandalone || isInstalled || isDismissed || !deferredPrompt) {
    return null;
  }

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setIsInstalled(true);
    }
    setDeferredPrompt(null);
  };

  return (
    <aside
      aria-label="Install Aplikasi Nexora"
      className="fixed bottom-20 right-4 z-50 flex max-w-sm items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3.5 shadow-2xl backdrop-blur-md sm:bottom-6 sm:right-6"
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink/10 text-ink">
        <Download size={20} className="animate-bounce" />
      </div>
      <div className="flex-1 text-xs">
        <p className="font-semibold text-ink">Install Aplikasi Nexora</p>
        <p className="text-muted">Akses instan dari layar utama &amp; tanpa browser bar.</p>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleInstallClick}
          className="rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-bg1 transition-opacity hover:opacity-90"
        >
          Install
        </button>
        <button
          type="button"
          onClick={() => setIsDismissed(true)}
          className="rounded-lg p-1.5 text-muted hover:text-ink"
          aria-label="Tutup"
        >
          <X size={16} />
        </button>
      </div>
    </aside>
  );
}
