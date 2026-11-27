import { createRoot, type Root } from "react-dom/client";
import { AppProvider } from "@/app/AppContext";
import { AppShell } from "@/app/AppShell";
import { ToastProvider } from "@/components/ui/toast";
import type { DesktopGateway } from "@/shared/library";

export async function startApp(
  container: HTMLElement,
  desktop: DesktopGateway,
): Promise<() => void> {
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const reactRoot: Root = createRoot(container);
  reactRoot.render(
    <ToastProvider position="top-center">
      <AppProvider desktop={desktop} onReady={() => resolveReady?.()}>
        <AppShell />
      </AppProvider>
    </ToastProvider>,
  );

  await ready;
  return () => {
    reactRoot.unmount();
  };
}
