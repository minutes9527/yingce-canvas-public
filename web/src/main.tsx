import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import { installChunkRecovery } from "@/lib/chunk-recovery";
import { bootstrapAppearance } from "@/services/appearance-bootstrap";
import { runLocalRuntimeBootstrap } from "@/services/local-runtime-bootstrap";
import { isIsolatedPrevisRepro } from "@/lib/dev-repro";

installChunkRecovery();

runLocalRuntimeBootstrap(
    {
        get href() {
            return window.location.href;
        },
        replaceUrl(url) {
            window.history.replaceState(window.history.state, "", url);
        },
        removeStorageItem(key) {
            window.localStorage.removeItem(key);
        },
    },
    () => {
        // The public film entry checks its availability independently of workspace bootstrap.
        if (/^\/welcome\/?$/.test(window.location.pathname)) {
            void bootstrapAppearance().catch(() => undefined);
            void import("./welcome-application");
        } else {
            // The backend-free DEV lab must not make requests before AppProviders isolates it.
            const appearanceReady = isIsolatedPrevisRepro(import.meta.env.DEV, window.location.pathname) ? Promise.resolve() : bootstrapAppearance();
            void import("./application");
            void appearanceReady.catch(() => undefined);
        }
    },
);
